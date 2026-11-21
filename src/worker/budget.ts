import { capReached } from './alerts';
import type { Site } from './env';
import { utcDay } from './identity';

/**
 * Daily write cap (docs/GUIDE.md, "Daily write cap"). The tracker and app endpoints are public: anyone who reads a
 * site id from a script tag can send events. Without a ceiling, a script that does that could use up the free plan's
 * rows for the day, or run up a Workers Paid bill. With the cap on (the default), events past it are dropped until
 * 00:00 UTC, when Cloudflare's daily limits reset too.
 *
 * A site's cap is either its own number of rows, or automatic. Automatic sites share one pool: 80,000 rows a day
 * across every site, so a busy site can use what quiet sites leave. The pool counts the rows of all sites, those with
 * their own number and those with the cap off included, because they all come out of the same free plan. With more
 * than one site, an automatic site may use at most half the pool, so a flood of fake events on one site leaves the
 * others at least 40,000 rows. The Worker vars WRITE_POOL_ROWS and WRITE_SITE_MAX_SHARE change both numbers for the
 * whole deployment, for one on Workers Paid (`configureBudget`).
 *
 * Counting costs almost nothing: each Worker instance keeps a tally in memory and adds it to `site_usage` every
 * few hundred rows (two rows written: the site's and the pool's, site_id `*`). An instance reads the stored totals
 * once a day and gets the new totals back with every add, so a cap can overshoot by at most one unflushed tally per
 * running instance.
 */

/** Cloudflare's free plan: D1 rows written a day, across all sites. */
export const FREE_PLAN_ROWS = 100_000;
/** The share of the free plan that sites on the automatic cap share. */
export const AUTO_SHARE = 0.8;
/** Rows a day the automatic sites share: 80,000. */
export const POOL_ROWS = FREE_PLAN_ROWS * AUTO_SHARE;
/** The site_usage row that holds the total of all sites. Site ids are lowercase letters and digits. */
export const POOL_ID = '*';
/** site_usage rows `app403:<site id>`: the last time an app batch was refused because the site has no bundle id. */
const REJECTED_PREFIX = 'app403:';
/**
 * site_usage rows `hook401:<site id>:<provider>`: webhook deliveries refused for a bad signature or token. `day` is the
 * UTC day of the last refusal, `rows` the refusals counted that day, `capped_at` the time of the last one.
 */
const HOOK_PREFIX = 'hook401:';
/** With more than one site, the share of the pool one automatic site may use. */
export const SITE_MAX_SHARE = 0.5;
let FLUSH_ROWS = 200;
let poolRows = POOL_ROWS;
let siteShare = SITE_MAX_SHARE;
/** The pool size a test set; it wins over the Worker vars. */
let testPool: number | null = null;
let sitesCache: { n: number; at: number } | null = null;

async function siteCount(db: D1Database): Promise<number> {
  if (sitesCache && Date.now() - sitesCache.at < 60_000) return sitesCache.n;
  const row = await db.prepare('SELECT COUNT(*) AS n FROM sites').first<{ n: number }>();
  sitesCache = { n: Math.max(1, row?.n ?? 1), at: Date.now() };
  return sitesCache.n;
}

/** A whole number of rows from a Worker var ("1000000", "1_000_000" or "1,000,000"), else null. */
function parseRows(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[_,\s]/g, '')) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 1e12 ? n : null;
}

/** A share above 0 and at most 1 ("0.5"), else null. */
function parseShare(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return n > 0 && n <= 1 ? n : null;
}

/**
 * Read the pool size and the share one automatic site may use from the Worker vars `WRITE_POOL_ROWS` (default
 * 80,000) and `WRITE_SITE_MAX_SHARE` (default 0.5). A missing or invalid value keeps the default. No I/O, so it runs
 * on every request (src/worker/index.ts).
 */
export function configureBudget(env: { WRITE_POOL_ROWS?: string | number; WRITE_SITE_MAX_SHARE?: string | number }) {
  poolRows = testPool ?? parseRows(env?.WRITE_POOL_ROWS) ?? POOL_ROWS;
  siteShare = parseShare(env?.WRITE_SITE_MAX_SHARE) ?? SITE_MAX_SHARE;
}

/** The shared pool's size today: 80,000 or WRITE_POOL_ROWS. */
export const poolSize = () => poolRows;

/** The most an automatic site may write today on its own, or null when it is the only site. */
async function siteMax(db: D1Database): Promise<number | null> {
  return (await siteCount(db)) > 1 ? Math.floor(poolRows * siteShare) : null;
}

/** The limit on the site's own row: its own number, or the automatic site's share of the pool. */
async function ownCap(db: D1Database, site: Site): Promise<number | null> {
  if (site.write_cap_on === 0) return null;
  return fixedCap(site) ?? (await siteMax(db));
}

interface Tally {
  day: string;
  /** The stored total when this instance last read or wrote it. */
  known: number;
  /** Rows written here and not yet added to site_usage. */
  pending: number;
  /** site_usage.capped_at is set for `day`. */
  marked: boolean;
  ready: Promise<void>;
}

const tallies = new Map<string, Tally>();
const rejectedNoted = new Map<string, number>();

/** The site's own cap, or null when it is automatic or off. */
function fixedCap(site: Site): number | null {
  return site.write_cap_on !== 0 && site.write_cap && site.write_cap > 0 ? site.write_cap : null;
}

/** Rows the site may write today: its own number, the shared pool for an automatic site, or null when its cap is off. */
export function capOf(site: Site): number | null {
  if (site.write_cap_on === 0) return null;
  return fixedCap(site) ?? poolRows;
}

/** Does the site share the pool (cap on, no number of its own)? */
export function isShared(site: Site): boolean {
  return site.write_cap_on !== 0 && fixedCap(site) === null;
}

function tallyOf(db: D1Database, id: string, day: string): Promise<Tally> {
  let t = tallies.get(id);
  if (!t || t.day !== day) {
    const fresh: Tally = { day, known: 0, pending: 0, marked: false, ready: Promise.resolve() };
    fresh.ready = db
      .prepare('SELECT rows, capped_at FROM site_usage WHERE site_id = ? AND day = ?')
      .bind(id, day)
      .first<{ rows: number; capped_at: number | null }>()
      .then((row) => {
        fresh.known = Math.max(fresh.known, row?.rows ?? 0);
        fresh.marked ||= row?.capped_at != null;
      })
      .catch(() => undefined);
    tallies.set(id, fresh);
    t = fresh;
  }
  const tally = t;
  return tally.ready.then(() => tally);
}

/**
 * Has the site used up today's cap? Ask before writing anything for a public endpoint. A site with its own number
 * checks that; an automatic site checks the shared pool and, with more than one site, its share of it.
 */
export async function overCap(db: D1Database, site: Site, now: number): Promise<boolean> {
  if (site.write_cap_on === 0) return false;
  const day = utcDay(now);
  const own = await ownCap(db, site);
  if (own !== null) {
    const t = await tallyOf(db, site.id, day);
    if (t.known + t.pending >= own) return true;
  }
  if (fixedCap(site) !== null) return false;
  const pool = await tallyOf(db, POOL_ID, day);
  return pool.known + pool.pending >= poolRows;
}

/**
 * Count rows a public endpoint just wrote. Run it with waitUntil: it adds the tally to the site's row and the pool row
 * every FLUSH_ROWS rows (fewer for a small cap), and right away when a cap is reached, so the dashboard can say when.
 * Counted with the cap off too, so turning it on starts from today's real number.
 */
export async function spend(db: D1Database, site: Site, rows: number, now: number): Promise<void> {
  if (!(rows > 0)) return;
  const day = utcDay(now);
  const [t, pool] = await Promise.all([tallyOf(db, site.id, day), tallyOf(db, POOL_ID, day)]);
  t.pending += rows;
  pool.pending += rows;
  const fixed = await ownCap(db, site);
  const markSite = fixed !== null && t.known + t.pending >= fixed && !t.marked;
  const markPool = pool.known + pool.pending >= poolRows && !pool.marked;
  const every = fixed === null ? FLUSH_ROWS : Math.min(FLUSH_ROWS, Math.max(1, Math.floor(fixed / 20)));
  if (t.pending < every && !markSite && !markPool) return;
  const add = t.pending;
  t.pending = 0;
  pool.pending -= add;
  if (markSite) t.marked = true;
  if (markPool) pool.marked = true;
  try {
    const [own, all] = await db.batch<{ rows: number; capped_at: number | null }>([
      db
        .prepare(
          `INSERT INTO site_usage (site_id, day, rows, capped_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (site_id) DO UPDATE SET
             rows = CASE WHEN day = excluded.day THEN rows + excluded.rows ELSE excluded.rows END,
             capped_at = CASE WHEN day = excluded.day THEN COALESCE(capped_at, excluded.capped_at) ELSE excluded.capped_at END,
             day = excluded.day
           RETURNING rows, capped_at`,
        )
        .bind(site.id, day, add, markSite ? now : null),
      // The pool marks itself full in SQL, so whichever instance's add crosses the line records the time.
      db
        .prepare(
          `INSERT INTO site_usage (site_id, day, rows, capped_at) VALUES (?1, ?2, ?3, CASE WHEN ?3 >= ?5 THEN ?4 END)
           ON CONFLICT (site_id) DO UPDATE SET
             rows = CASE WHEN day = excluded.day THEN rows + excluded.rows ELSE excluded.rows END,
             capped_at = CASE WHEN day = excluded.day THEN COALESCE(capped_at, CASE WHEN rows + excluded.rows >= ?5 THEN ?4 END)
                              ELSE excluded.capped_at END,
             day = excluded.day
           RETURNING rows, capped_at`,
        )
        .bind(POOL_ID, day, add, now, poolRows),
    ]);
    const o = own.results[0];
    const a = all.results[0];
    if (o) t.known = Math.max(t.known, o.rows);
    if (a) {
      pool.known = Math.max(pool.known, a.rows);
      pool.marked ||= a.capped_at != null;
    }
    // This add stored today's cap time, so this instance sends the one alert for it (src/worker/alerts.ts).
    if (markSite && o?.capped_at === now) await capReached(db, site, now, fixed!);
    if (a?.capped_at === now) await capReached(db, null, now, poolRows);
  } catch {
    t.pending += add;
    pool.pending += add;
    if (markSite) t.marked = false;
    if (markPool) pool.marked = false;
  }
}

/** Stored rows plus what this instance has not added yet. */
function current(id: string, day: string, stored: number | undefined): number {
  const local = tallies.get(id);
  if (local?.day !== day) return stored ?? 0;
  return Math.max(stored ?? 0, local.known) + local.pending;
}

export interface Usage {
  /** Rows this site wrote today (UTC). */
  rows: number;
  /** The site's own cap, the pool size for an automatic site, or null when the cap is off. */
  cap: number | null;
  /** With more than one site: the most an automatic site may write on its own (half the pool by default), else null. */
  site_max: number | null;
  /** The automatic cap: rows a day that all automatic sites share (80,000, or WRITE_POOL_ROWS). */
  auto: number;
  /** The site is on the automatic cap and shares the pool. */
  shared: boolean;
  /** Rows all sites wrote today, the number the pool is checked against. */
  pool_rows: number;
  /** When today's cap was reached (the pool's time for an automatic site), else null. */
  capped_at: number | null;
  resets_at: number;
}

/** Today's usage for the dashboard. */
export async function usageOf(db: D1Database, site: Site, now: number): Promise<Usage> {
  const day = utcDay(now);
  const { results } = await db
    .prepare('SELECT site_id, rows, capped_at FROM site_usage WHERE site_id IN (?, ?) AND day = ?')
    .bind(site.id, POOL_ID, day)
    .all<{ site_id: string; rows: number; capped_at: number | null }>();
  const own = results.find((r) => r.site_id === site.id);
  const pool = results.find((r) => r.site_id === POOL_ID);
  const shared = isShared(site);
  return {
    rows: current(site.id, day, own?.rows),
    cap: capOf(site),
    site_max: shared ? await siteMax(db) : null,
    auto: poolRows,
    shared,
    pool_rows: current(POOL_ID, day, pool?.rows),
    capped_at: (shared ? (pool?.capped_at ?? own?.capped_at) : own?.capped_at) ?? null,
    resets_at: Date.parse(day) + 86_400_000,
  };
}

/**
 * Today's cap times and refused app batches, for the site list: one read of site_usage. `cappedAt(site)` is when the
 * site's cap (its own, or the pool for an automatic site) was reached today, else null. `appRejectedAt` holds the last
 * time in the past 24 hours an app batch was refused because the site had no bundle id, keyed by site id (iOS) or
 * `<site id>:android` (an Android batch refused because the site has no package name). `pool` is what all sites
 * wrote today against the pool's size, for the line under the home page's cards.
 */
export async function usageSummary(db: D1Database, now: number) {
  const day = utcDay(now);
  const { results } = await db
    .prepare(
      `SELECT site_id, day, rows, capped_at FROM site_usage
       WHERE (day = ?1 AND (capped_at IS NOT NULL OR site_id = '${POOL_ID}'))
          OR (site_id >= '${REJECTED_PREFIX}' AND site_id < '${REJECTED_PREFIX}~' AND capped_at > ?2)`,
    )
    .bind(day, now - 86_400_000)
    .all<{ site_id: string; day: string; rows: number; capped_at: number | null }>();
  const capped = new Map<string, number>();
  const appRejectedAt = new Map<string, number>();
  let poolStored: number | undefined;
  for (const r of results) {
    if (r.site_id.startsWith(REJECTED_PREFIX)) appRejectedAt.set(r.site_id.slice(REJECTED_PREFIX.length), r.capped_at!);
    else if (r.day === day) {
      if (r.site_id === POOL_ID) poolStored = r.rows;
      if (r.capped_at != null) capped.set(r.site_id, r.capped_at);
    }
  }
  return {
    pool: { rows: current(POOL_ID, day, poolStored), size: poolRows, capped_at: capped.get(POOL_ID) ?? null, resets_at: Date.parse(day) + 86_400_000 },
    poolCappedAt: capped.get(POOL_ID) ?? null,
    cappedAt: (site: Site) =>
      site.write_cap_on === 0 ? null : ((isShared(site) ? capped.get(POOL_ID) : undefined) ?? capped.get(site.id) ?? null),
    appRejectedAt,
  };
}

/**
 * Remember that an app batch for a site without a bundle id (or, for Android, without a package name) was refused, so
 * the dashboard can say so. At most one row written per site and platform every 10 minutes per Worker instance,
 * whatever the number of batches.
 */
export async function noteAppRejected(db: D1Database, siteId: string, now: number, platform: 'ios' | 'android' = 'ios'): Promise<void> {
  const key = platform === 'android' ? `${siteId}:android` : siteId;
  if (now - (rejectedNoted.get(key) ?? 0) < 600_000) return;
  rejectedNoted.set(key, now);
  await db
    .prepare(
      `INSERT INTO site_usage (site_id, day, rows, capped_at) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (site_id) DO UPDATE SET rows = rows + 1, day = excluded.day, capped_at = excluded.capped_at`,
    )
    .bind(REJECTED_PREFIX + key, utcDay(now), now)
    .run()
    .catch(() => undefined);
}

/**
 * Deletes a deleted site's refused-app note and refused-webhook counts (its own usage row goes with the other per-site
 * tables).
 */
export function forgetAppRejected(db: D1Database, siteId: string): D1PreparedStatement {
  return db
    .prepare('DELETE FROM site_usage WHERE site_id = ?1 OR site_id = ?4 OR (site_id >= ?2 AND site_id < ?3)')
    .bind(REJECTED_PREFIX + siteId, `${HOOK_PREFIX}${siteId}:`, `${HOOK_PREFIX}${siteId}:~`, `${REJECTED_PREFIX}${siteId}:android`);
}

// ---------- webhook deliveries refused for a bad signature

/** Refusals counted in this instance and not stored yet, and when this instance last stored, per site and provider. */
const hookNoted = new Map<string, { at: number; pending: number }>();

/**
 * Count a webhook delivery refused for a bad signature or token (a 401 from /api/webhooks/*). The first refusal is
 * stored at once; later ones are added at most once every 10 minutes per site, provider and Worker instance, so a
 * flood of bad deliveries costs at most 6 rows an hour per instance. Refusals still pending when an instance stops are
 * lost, so the stored count is a floor. Returns the stored count for the day when this call stored the first refusal
 * of the day (time to alert), else null. Never throws.
 */
export async function noteWebhookRefused(db: D1Database, siteId: string, provider: string, now: number): Promise<number | null> {
  const key = `${HOOK_PREFIX}${siteId}:${provider}`;
  const noted = hookNoted.get(key) ?? { at: 0, pending: 0 };
  noted.pending++;
  hookNoted.set(key, noted);
  if (now - noted.at < 600_000) return null;
  const add = noted.pending;
  noted.at = now;
  noted.pending = 0;
  try {
    const row = await db
      .prepare(
        `INSERT INTO site_usage (site_id, day, rows, capped_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (site_id) DO UPDATE SET rows = CASE WHEN day = excluded.day THEN rows + excluded.rows ELSE excluded.rows END,
           day = excluded.day, capped_at = excluded.capped_at
         RETURNING rows`,
      )
      .bind(key, utcDay(now), add, now)
      .all<{ rows: number }>()
      .then((r) => r.results[0]);
    // Only the write that started the day's count alerts, so a site and provider alert once a day.
    return row && row.rows === add ? row.rows : null;
  } catch {
    return null;
  }
}

export interface RefusedWebhook {
  siteId: string;
  provider: string;
  /** Refusals counted on `day` (UTC), at least. */
  count: number;
  day: string;
  /** Time of the last refusal. */
  at: number;
}

/** Providers that refused a delivery in the 24 hours before `now`, of one site or all, most recent first. */
export async function refusedWebhooks(db: D1Database, now: number, siteId?: string): Promise<RefusedWebhook[]> {
  const from = siteId ? `${HOOK_PREFIX}${siteId}:` : HOOK_PREFIX;
  const { results } = await db
    .prepare('SELECT site_id, day, rows, capped_at FROM site_usage WHERE site_id >= ? AND site_id < ? AND capped_at > ? ORDER BY capped_at DESC')
    .bind(from, `${from}~`, now - 86_400_000)
    .all<{ site_id: string; day: string; rows: number; capped_at: number }>();
  return results.map((r) => {
    const [site, provider] = r.site_id.slice(HOOK_PREFIX.length).split(':');
    return { siteId: site, provider, count: r.rows, day: r.day, at: r.capped_at };
  });
}

/** Seconds until the caps reset at 00:00 UTC, for Retry-After. */
export function secondsToReset(now: number): number {
  return Math.max(1, Math.ceil((Date.parse(utcDay(now)) + 86_400_000 - now) / 1000));
}

/** Rows written by a D1 batch or run. */
export function rowsWritten(results: { meta?: { rows_written?: number } }[]): number {
  return results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
}

/** Tests: forget every tally, and optionally change how often tallies are added and the pool size. */
export function resetBudgetForTests(flushRows = 200, pool?: number) {
  tallies.clear();
  rejectedNoted.clear();
  hookNoted.clear();
  sitesCache = null;
  FLUSH_ROWS = flushRows;
  testPool = pool ?? null;
  poolRows = pool ?? POOL_ROWS;
  siteShare = SITE_MAX_SHARE;
}
