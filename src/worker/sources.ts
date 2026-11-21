// Data trust for agents (docs/API.md "Sources and tracking start"): per site, which integrations deliver data, when each
// last did, what failed, and since when each kind of data exists. whoami, get_definitions and get_portfolio answer it,
// so an agent can tell "the import broke" or "tracking started last week" from a real drop.
//
// Reads only, in one D1 batch for every site asked for, from the same tables the setup checklist reads
// (setup-checklist.ts). Each lookup walks an index from one end and stops early, so the cost does not grow with the
// site's history: the newest RECENT_SESSIONS sessions tell the last web and app visit, MIN and MAX on (site_id, ts)
// indexes tell the first and last payment and App Store day.
//
// When one platform is missing from the newest sessions (a small app next to a busy website, or the reverse), one more
// statement looks for its newest session in the quiet window (SESSION_STALE_HOURS), so a minority platform that still
// sends is not called stale.
//
// The first web and the first app session need a scan when one platform started long after the other, so the daily
// 03:17 cron finds them (refreshTrackingSince) and keeps them in one cron_state row per site ('since:<site id>').
// It scans only the sessions after the stored point, at most SCAN_LIMIT per site. It writes the row when a first is
// found, when the scan hit SCAN_LIMIT, or when the stored point is THROUGH_STEP_DAYS old: at most 1 row per site a
// night, about 1 a week for a site whose other platform never sends, and none once both are known (pro/test/cost.test.ts).
import type { Env, Site } from './env';
import { proHooks } from './pro-hooks';
import { TEST_PROVIDERS_SQL } from './payments';
import { refusedWebhooks } from './budget';
import { stoppedProviders } from './silence';
import { dayInTz, midnight } from './lib/time';
import { TREND_RULES } from '../shared/trend-rules';
import { appHostSql, hasApp, isAppHost, webHostSql } from '../shared/platform';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The newest sessions read for the last web and app visit. */
export const RECENT_SESSIONS = 300;
/** Sessions the nightly scan reads per site and run. */
export const SCAN_LIMIT = 50_000;
/** The nightly scan moves its stored point forward after this many days, when nothing else changed. */
export const THROUGH_STEP_DAYS = 7;
/** A web or app source is stale after this long without a session: Home's "no visits" rule. */
export const SESSION_STALE_HOURS = TREND_RULES.quietHours;
/** The Meta import runs every hour at minute 45. */
export const META_STALE_HOURS = 3;
/** Apple's sales report for a day arrives the next day; older than this, the import missed days. */
export const ASC_STALE_DAYS = 4;
/** Search Console data lags 2 to 3 days. */
export const GSC_STALE_DAYS = 5;
/** Rank checks finish once a day. */
export const RANKS_STALE_DAYS = 2;
/** AI checks run every day for the enabled engines. */
export const AI_STALE_DAYS = 3;

/** The sources Pro fills in (Pro.sourceHealth); core reports them as off. */
export const PRO_SOURCES = ['app_store', 'apple_search_ads', 'meta', 'search_console', 'aso', 'dataforseo', 'ai_engines', 'x', 'email'] as const;

export const SOURCE_IDS = [
  'web',
  'app',
  'payments',
  'app_store',
  'apple_search_ads',
  'meta',
  'search_console',
  'aso',
  'dataforseo',
  'ai_engines',
  'x',
  'email',
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** off: not set up for this site. stale: set up, but no fresh data. error: the last attempt failed. */
export type SourceStatus = 'ok' | 'stale' | 'error' | 'off';

export interface SourceHealth {
  connected: boolean;
  status: SourceStatus;
  /** When the source last delivered data or ran without an error, ISO 8601; null when it never did. */
  last_ok_at: string | null;
  /** The newest day of data, YYYY-MM-DD, for sources that report whole days. */
  through?: string | null;
  /** What failed last, in plain words; null when nothing failed after the last success. */
  last_error: string | null;
  stale: boolean;
  /** One sentence for an agent or the owner. */
  detail: string;
  /** Payments only: each provider with a signing secret, or with payments. */
  providers?: { provider: string; last_ok_at: string | null; last_error: string | null }[];
}

export interface TrackingSince {
  /** First web visit (ISO 8601), or null when none was seen. */
  web: string | null;
  /** First app session. */
  app: string | null;
  /** First day of history imported from another tool (Plausible, DataFast), YYYY-MM-DD in the site timezone. */
  imported: string | null;
  /** First payment that is not a sandbox purchase. */
  payments: string | null;
  /** First day of Apple's sales report for the site's app, YYYY-MM-DD. */
  app_store: string | null;
  /** First day of Search Console data, YYYY-MM-DD. */
  gsc: string | null;
  /** First visit of either kind or the first imported day: where visitor numbers start. */
  visitors: string | null;
  /** First payment or App Store day: where revenue starts. */
  revenue: string | null;
}

export interface SiteTrust {
  tracking_since: TrackingSince;
  sources: Record<SourceId, SourceHealth>;
  /** The payments source for a key without read:revenue (trustForKey). Not sent as it is. */
  paymentsWithoutRevenue: SourceHealth;
}

/** The nightly record of a site's first and last web and app sessions (cron_state 'since:<site id>'). */
interface SinceRecord {
  web: number | null;
  app: number | null;
  web_last: number | null;
  app_last: number | null;
  /** started_at of the newest session scanned. */
  through: number;
}

const iso = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export const dayMs = (day: string | null | undefined) => (day ? Date.parse(`${day}T00:00:00Z`) : null);
const isApp = isAppHost;
const minOf = (...v: (number | null | undefined)[]) => {
  const xs = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return xs.length ? Math.min(...xs) : null;
};
export const maxOf = (...v: (number | null | undefined)[]) => {
  const xs = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return xs.length ? Math.max(...xs) : null;
};
export const ago = (now: number, at: number) => {
  const h = Math.max(0, Math.round((now - at) / HOUR));
  if (h < 1) return 'less than an hour ago';
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
};
export const has = (env: Env, name: string) => !!(env as unknown as Record<string, unknown>)[name];

function parseRecord(json: string | null | undefined): SinceRecord | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<SinceRecord>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { web: n(r.web), app: n(r.app), web_last: n(r.web_last), app_last: n(r.app_last), through: n(r.through) ?? 0 };
  } catch {
    return null;
  }
}

// ---------- the nightly scan

/**
 * The 03:17 cron: for each site whose first web or first app session is not known yet, scan the sessions after the
 * last run (SCAN_LIMIT at most) and keep the first and last of each platform. Two D1 calls: one batch of reads, one
 * batch of upserts that write only a changed row.
 */
export async function refreshTrackingSince(db: D1Database, now = Date.now()) {
  const { results: sites } = await db
    .prepare(
      `SELECT st.id, st.app_bundle_id, st.android_package, c.value AS since FROM sites st LEFT JOIN cron_state c ON c.key = 'since:' || st.id ORDER BY st.created_at`,
    )
    .all<{ id: string; app_bundle_id: string | null; android_package: string | null; since: string | null }>();
  const todo = sites
    .map((s) => ({ ...s, rec: parseRecord(s.since) }))
    // Done: both platforms found, or the web found on a site without an app.
    .filter((s) => !(s.rec && s.rec.web !== null && (s.rec.app !== null || !hasApp(s))));
  if (!todo.length) return { scanned: 0, written: 0 };
  const scans = await db.batch<{ web: number | null; app: number | null; web_last: number | null; app_last: number | null; last: number | null; n: number }>(
    todo.map((s) =>
      db
        .prepare(
          `SELECT MIN(CASE WHEN ${appHostSql('hostname')} THEN NULL ELSE started_at END) AS web, MIN(CASE WHEN ${appHostSql('hostname')} THEN started_at END) AS app,
                  MAX(CASE WHEN ${appHostSql('hostname')} THEN NULL ELSE started_at END) AS web_last, MAX(CASE WHEN ${appHostSql('hostname')} THEN started_at END) AS app_last,
                  MAX(started_at) AS last, COUNT(*) AS n
           FROM (SELECT started_at, hostname FROM sessions WHERE site_id = ?1 AND started_at > ?2 ORDER BY started_at LIMIT ${SCAN_LIMIT})`,
        )
        .bind(s.id, s.rec?.through ?? -1),
    ),
  );
  const writes: D1PreparedStatement[] = [];
  todo.forEach((s, i) => {
    const r = scans[i].results[0];
    if (!r || !Number(r.n)) return;
    const prev = s.rec ?? { web: null, app: null, web_last: null, app_last: null, through: 0 };
    const next: SinceRecord = {
      web: prev.web ?? r.web ?? null,
      app: prev.app ?? r.app ?? null,
      web_last: maxOf(prev.web_last, r.web_last),
      app_last: maxOf(prev.app_last, r.app_last),
      through: maxOf(prev.through, r.last) ?? prev.through,
    };
    // A site with one platform only (an iOS app without a web tracker) never finds the other first. Keep the stored
    // point until a week of sessions passed, so such a site writes about once a week, not every night. The next run
    // reads the same sessions again, which finds the same firsts. A scan that hit the limit always moves on.
    const found = !s.rec || next.web !== prev.web || next.app !== prev.app;
    const step = Number(r.n) >= SCAN_LIMIT || next.through - prev.through >= THROUGH_STEP_DAYS * DAY;
    if (!found && !step) return;
    writes.push(
      db
        .prepare(
          `INSERT INTO cron_state (key, value, at) VALUES (?1, ?2, ?3)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at WHERE cron_state.value IS NOT excluded.value`,
        )
        .bind(`since:${s.id}`, JSON.stringify(next), now),
    );
  });
  if (writes.length) await db.batch(writes);
  return { scanned: todo.length, written: writes.length };
}

// ---------- the reads

export interface EdgeRow {
  id: string;
  first_at: number | null;
  first_host: string | null;
  /** JSON [last app visit, last web visit, oldest started_at, count] of the newest RECENT_SESSIONS sessions. */
  recent: string | null;
  imported_from: string | null;
  first_pay: number | null;
  last_pay: number | null;
  asc_first: string | null;
  asc_last: string | null;
  since: string | null;
  capped_at: number | null;
  email_last: string | null;
  ai_last: string | null;
  ai_checked: number | null;
  aso_last: number | null;
  aso_keywords: number;
  rank_keywords: number;
}

/** One row of the deployment-wide and per-site misc statements in siteTrust's batch (kind says which). */
export interface MiscRow {
  kind: string;
  site_id: string | null;
  a: any;
  b: any;
  c: any;
  d: any;
}

/** What siteTrust hands Pro.sourceHealth for one site: the rows its batch read, and the helpers that build a source's answer. */
export interface SourceProbe {
  env: Env;
  site: Site;
  now: number;
  edge: EdgeRow;
  /** Apple's sales import (deployment-wide) and the Apple Search Ads import. */
  asc: MiscRow | undefined;
  asa: MiscRow | undefined;
  metaRows: any[];
  gscRow: any;
  pushed: any;
  google: { status: string; error: string | null } | undefined;
  /** This site's rows of one kind ('rank', 'loc', 'ai', 'x', 'aso'). */
  miscOf(kind: string): MiscRow[];
  off(detail: string): SourceHealth;
  health(o: { lastOk: number | null; through?: string | null; error?: string | null; errorAt?: number | null; stale: boolean; detail: string }): SourceHealth;
}

/** Results per site id, reused for 60 seconds per isolate: whoami, get_definitions and get_portfolio share them. */
const memo = new Map<string, { at: number; value: Map<string, SiteTrust> }>();
const MEMO_MS = 60_000;

/** Tests only. */
export function resetTrustCacheForTests() {
  memo.clear();
}

/**
 * Tracking start and source health for `sites`. One D1 batch (12 statements) for any number of sites, plus the
 * refused-webhook and silent-provider reads home.ts makes too.
 */
export async function siteTrust(env: Env, sites: Site[], now = Date.now()): Promise<Map<string, SiteTrust>> {
  if (!sites.length) return new Map();
  const key = sites.map((s) => s.id).sort().join(',');
  const hit = memo.get(key);
  if (hit && now - hit.at < MEMO_MS) return hit.value;
  const db = env.DB;
  const ids = JSON.stringify(sites.map((s) => s.id));
  const today = new Date(now).toISOString().slice(0, 10);
  // recent: the last app and web visit among the newest RECENT_SESSIONS sessions, one index walk of at most that many rows.
  const [edges, meta, gsc, gscPushed, google, ...misc] = await db.batch<any>([
    db
      .prepare(
        `SELECT st.id,
                (SELECT started_at FROM sessions WHERE site_id = st.id ORDER BY started_at LIMIT 1) AS first_at,
                (SELECT hostname FROM sessions WHERE site_id = st.id ORDER BY started_at LIMIT 1) AS first_host,
                (SELECT json_array(MAX(CASE WHEN ${appHostSql('hostname')} THEN started_at END), MAX(CASE WHEN ${webHostSql('hostname')} THEN started_at END), MIN(started_at), COUNT(*))
                 FROM (SELECT started_at, hostname FROM sessions WHERE site_id = st.id ORDER BY started_at DESC LIMIT ${RECENT_SESSIONS})) AS recent,
                (SELECT MIN(from_day) FROM imports WHERE site_id = st.id) AS imported_from,
                (SELECT p.ts FROM payments p WHERE p.site_id = st.id AND p.provider NOT IN ${TEST_PROVIDERS_SQL} ORDER BY p.ts LIMIT 1) AS first_pay,
                (SELECT p.ts FROM payments p WHERE p.site_id = st.id AND p.provider NOT IN ${TEST_PROVIDERS_SQL} ORDER BY p.ts DESC LIMIT 1) AS last_pay,
                (SELECT MIN(report_date) FROM asc_sales WHERE site_id = st.id) AS asc_first,
                (SELECT MAX(report_date) FROM asc_sales WHERE site_id = st.id) AS asc_last,
                (SELECT value FROM cron_state WHERE key = 'since:' || st.id) AS since,
                (SELECT capped_at FROM site_usage WHERE site_id = st.id AND day = ?2) AS capped_at,
                (SELECT MAX(day) FROM email_daily WHERE site_id = st.id) AS email_last,
                (SELECT MAX(day) FROM ai_answers WHERE site_id = st.id) AS ai_last,
                (SELECT MAX(checked_at) FROM ai_answers WHERE site_id = st.id AND day = (SELECT MAX(day) FROM ai_answers WHERE site_id = st.id)) AS ai_checked,
                (SELECT MAX(collected_at) FROM aso_snapshots WHERE site_id = st.id AND collector IS NOT NULL) AS aso_last,
                (SELECT COUNT(*) FROM aso_keywords WHERE site_id = st.id) AS aso_keywords,
                (SELECT COUNT(*) FROM rank_keywords WHERE site_id = st.id) AS rank_keywords
         FROM sites st WHERE st.id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids, today),
    db
      .prepare(
        `SELECT m.site_id, m.ad_account_id, a.imported_at, a.last_day, a.error FROM meta_settings m LEFT JOIN meta_accounts a ON a.id = m.ad_account_id
         WHERE m.site_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids),
    db
      .prepare(`SELECT site_id, status, error, oldest_day, newest_day, last_run_at FROM gsc_sites WHERE site_id IN (SELECT value FROM json_each(?1))`)
      .bind(ids),
    // A pushed Search Console snapshot (scripts/gsc-sync.mjs): its first and last day, read by D1, not the Worker.
    db
      .prepare(
        `SELECT s.site_id, s.pushed_at, (SELECT MIN(j.value ->> 0) FROM json_each(s.json) j) AS first_day, (SELECT MAX(j.value ->> 0) FROM json_each(s.json) j) AS last_day
         FROM seo_snapshots s WHERE s.part = 'gsc_daily' AND s.site_id IN (SELECT value FROM json_each(?1)) AND json_valid(s.json) AND json_type(s.json) = 'array'`,
      )
      .bind(ids),
    db.prepare('SELECT status, error FROM google_auth WHERE id = 1'),
    // Deployment-wide: the Apple Search Ads and App Store sales imports, then per site rank, AI and X settings. Separate
    // statements: D1 caps a compound SELECT at a few terms.
    db.prepare(`SELECT 'asa' AS kind, NULL AS site_id, imported_at AS a, last_day AS b, error AS c, NULL AS d FROM asa_status WHERE id = 1`),
    db.prepare(
      `SELECT 'asc' AS kind, NULL AS site_id, MAX(imported_at) AS a, MAX(report_date) AS b, NULL AS c, NULL AS d FROM asc_import_days WHERE status IN ('ok', 'zero')`,
    ),
    db.prepare(`SELECT 'rank' AS kind, site_id, enabled AS a, done_day AS b, last_error AS c, last_error_at AS d FROM rank_settings WHERE site_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    db.prepare(`SELECT 'loc' AS kind, site_id, NULL AS a, source AS b, message AS c, at AS d FROM location_errors WHERE site_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    db.prepare(`SELECT 'ai' AS kind, site_id, updated_at AS a, engines AS b, errors AS c, NULL AS d FROM ai_settings WHERE site_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    db.prepare(`SELECT 'x' AS kind, site_id, last_polled_at AS a, enabled AS b, last_error AS c, last_error_at AS d FROM x_settings WHERE site_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    db.prepare(`SELECT 'aso' AS kind, site_id, hosted_ranks AS a, hosted_done_day AS b, countries AS c, NULL AS d FROM aso_settings WHERE site_id IN (SELECT value FROM json_each(?1))`).bind(ids),
  ]);
  const [refused, stopped] = await Promise.all([refusedWebhooks(db, now).catch(() => []), stoppedProviders(db, now).catch(() => [])]);

  const bySite = <T extends { site_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.site_id, [...(m.get(r.site_id) ?? []), r]);
    return m;
  };
  const edgeOf = new Map((edges.results as EdgeRow[]).map((r) => [r.id, r]));
  const metaOf = bySite(meta.results as any[]);
  const gscOf = new Map((gsc.results as any[]).map((r) => [r.site_id, r]));
  const pushedOf = new Map((gscPushed.results as any[]).map((r) => [r.site_id, r]));
  const g = (google.results as any[])[0] as { status: string; error: string | null } | undefined;
  const miscRows = misc.flatMap((m) => m.results) as MiscRow[];
  const asa = miscRows.find((r) => r.kind === 'asa');
  const asc = miscRows.find((r) => r.kind === 'asc');
  const miscOf = (kind: string, siteId: string) => miscRows.filter((r) => r.kind === kind && r.site_id === siteId);

  // The last app and web visit. The newest RECENT_SESSIONS sessions answer it, unless a platform is missing from them
  // while they are all newer than the quiet window: then a probe looks for its newest session in the rest of the window.
  const staleMs = SESSION_STALE_HOURS * HOUR;
  const lastSeen = new Map<string, { app: number | null; web: number | null }>();
  const probes: { site: string; app: boolean; stmt: D1PreparedStatement }[] = [];
  for (const site of sites) {
    const e = edgeOf.get(site.id);
    if (!e) continue;
    let recent: (number | null)[] = [];
    try {
      if (e.recent) recent = JSON.parse(e.recent);
    } catch {
      // No sessions.
    }
    const [app = null, web = null, oldest = null, count = 0] = recent;
    lastSeen.set(site.id, { app, web });
    const blind = Number(count) >= RECENT_SESSIONS && oldest !== null && oldest > now - staleMs;
    if (!blind) continue;
    const rec = parseRecord(e.since);
    const firstApp = isApp(e.first_host);
    const wantsApp = app === null && !!(hasApp(site) || rec?.app != null || firstApp);
    const wantsWeb = web === null && (rec?.web != null || (e.first_at !== null && !firstApp));
    for (const [want, isAppProbe] of [
      [wantsApp, true],
      [wantsWeb, false],
    ] as const) {
      if (!want) continue;
      const host = isAppProbe ? `${appHostSql('hostname')}` : `${webHostSql('hostname')}`;
      probes.push({
        site: site.id,
        app: isAppProbe,
        stmt: db
          .prepare(`SELECT started_at FROM sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND ${host} ORDER BY started_at DESC LIMIT 1`)
          .bind(site.id, now - staleMs, oldest),
      });
    }
  }
  if (probes.length) {
    const found = await db.batch<{ started_at: number }>(probes.map((p) => p.stmt));
    probes.forEach((p, i) => {
      const at = found[i].results[0]?.started_at ?? null;
      const seen = lastSeen.get(p.site)!;
      if (at !== null) seen[p.app ? 'app' : 'web'] = at;
    });
  }

  const out = new Map<string, SiteTrust>();
  for (const site of sites) {
    const e = edgeOf.get(site.id);
    if (!e) continue;
    const rec = parseRecord(e.since);
    const firstApp = isApp(e.first_host);
    const webSince = rec?.web ?? (e.first_at !== null && !firstApp ? e.first_at : null);
    const appSince = rec?.app ?? (e.first_at !== null && firstApp ? e.first_at : null);
    const importedMs = e.imported_from ? midnight(e.imported_from, site.timezone) : null;
    const gscRow = gscOf.get(site.id);
    const pushed = pushedOf.get(site.id);
    const gscFirst = gscRow?.oldest_day ?? pushed?.first_day ?? null;
    const tracking: TrackingSince = {
      web: iso(webSince),
      app: iso(appSince),
      imported: e.imported_from,
      payments: iso(e.first_pay),
      app_store: e.asc_first,
      gsc: gscFirst,
      visitors: iso(minOf(e.first_at, importedMs)),
      revenue: iso(minOf(e.first_pay, e.asc_first ? midnight(e.asc_first, site.timezone) : null)),
    };

    const src = {} as Record<SourceId, SourceHealth>;
    const off = (detail: string): SourceHealth => ({ connected: false, status: 'off', last_ok_at: null, last_error: null, stale: false, detail });
    const health = (o: { lastOk: number | null; through?: string | null; error?: string | null; errorAt?: number | null; stale: boolean; detail: string }): SourceHealth => {
      // An error counts when it came after the last success (or there was none).
      const failing = !!o.error && (o.errorAt == null || o.lastOk === null || o.errorAt >= o.lastOk);
      return {
        connected: true,
        status: failing ? 'error' : o.stale ? 'stale' : 'ok',
        last_ok_at: iso(o.lastOk),
        ...(o.through !== undefined ? { through: o.through } : {}),
        last_error: failing ? o.error! : null,
        stale: o.stale,
        detail: o.detail,
      };
    };
    const capNote = e.capped_at ? `The daily write cap was reached at ${new Date(e.capped_at).toISOString().slice(11, 16)} UTC, so later events today were dropped.` : null;

    // Web tracker and app SDK.
    const seen = lastSeen.get(site.id);
    const lastApp = maxOf(seen?.app, rec?.app_last);
    const lastWeb = maxOf(seen?.web, rec?.web_last);
    const sessionSource = (last: number | null, since: number | null, what: string, none: string): SourceHealth => {
      if (last === null && since === null) return off(none);
      const at = last ?? since!;
      const stale = now - at > SESSION_STALE_HOURS * HOUR;
      return health({
        lastOk: at,
        error: capNote,
        errorAt: e.capped_at,
        stale,
        detail: stale ? `No ${what} for ${Math.floor((now - at) / HOUR)} hours. Check that tracking still runs before reading a drop.` : `Last ${what.replace(/s$/, '')} ${ago(now, at)}.`,
      });
    };
    src.web = sessionSource(lastWeb, webSince, 'web visits', 'No web visit received yet. The tracking script is not installed, or nobody visited.');
    src.app =
      hasApp(site) || appSince !== null || lastApp !== null
        ? sessionSource(lastApp, appSince, 'app sessions', 'No app session received yet. The app needs a released build with FounderDataKit.')
        : off('No app is set for this site.');

    // Payments: the webhooks, and the providers that went quiet.
    const secretProviders = (
      [
        ['stripe', site.stripe_webhook_secret],
        ['dodo', site.dodo_webhook_secret],
        ['lemonsqueezy', site.lemonsqueezy_secret],
        ['polar', site.polar_secret],
        ['paddle', site.paddle_secret],
        ['gumroad', site.gumroad_seller_id],
        ['revenuecat', site.revenuecat_auth],
      ] as const
    )
      .filter(([, v]) => !!v)
      .map(([p]) => p as string);
    const refusedHere = refused.filter((r) => r.siteId === site.id);
    const stoppedHere = stopped.filter((s) => s.siteId === site.id);
    if (!secretProviders.length && e.last_pay === null) {
      src.payments = off('No payment provider is connected and no payment arrived.');
    } else {
      const errors = [
        ...refusedHere.map((r) => `${r.count} ${r.provider} deliveries failed the signature check in the last 24 hours.`),
        ...stoppedHere.map((s) => `No ${s.provider} payment for ${s.days} days, where ${s.usual} came in the 28 days before.`),
      ];
      const lastErrorAt = maxOf(...refusedHere.map((r) => r.at), ...stoppedHere.map(() => now));
      const providers = [...new Set([...secretProviders, ...stoppedHere.map((s) => s.provider)])].map((p) => {
        const r = refusedHere.find((x) => x.provider === p);
        const s = stoppedHere.find((x) => x.provider === p);
        return {
          provider: p,
          last_ok_at: s ? iso(s.last) : null,
          last_error: r ? `${r.count} deliveries failed the signature check in the last 24 hours.` : s ? `No payment for ${s.days} days.` : null,
        };
      });
      src.payments = {
        ...health({
          lastOk: e.last_pay,
          error: errors.length ? errors.join(' ') : null,
          errorAt: lastErrorAt,
          stale: stoppedHere.length > 0,
          detail: e.last_pay === null ? 'Connected. No payment has arrived yet.' : `Last payment ${ago(now, e.last_pay)}.`,
        }),
        providers,
      };
    }
    // A key without read:revenue learns whether payments are connected and whether deliveries are refused, not when
    // payments came: no last payment, no provider that went quiet.
    const paymentsWithoutRevenue: SourceHealth =
      src.payments.status === 'off'
        ? src.payments
        : {
            connected: true,
            status: refusedHere.length ? 'error' : 'ok',
            last_ok_at: null,
            last_error: refusedHere.length ? 'Hidden: this key has no read:revenue scope.' : null,
            stale: false,
            detail: 'Connected. Details need the read:revenue scope.',
          };

    // The integrations Pro owns: App Store sales, Apple Search Ads, Meta ads, Search Console, ASO, DataForSEO, AI engines,
    // X posts and email. Pro reads them from what the batch above already returned (pro/worker/sources-pro.ts).
    const proHealth = proHooks()?.sourceHealth?.({
      env,
      site,
      now,
      edge: e,
      asc,
      asa,
      metaRows: metaOf.get(site.id) ?? [],
      gscRow,
      pushed,
      google: g,
      miscOf: (kind: string) => miscOf(kind, site.id),
      off,
      health,
    });
    for (const id of PRO_SOURCES) src[id] = proHealth?.[id] ?? off('Part of FounderData Pro.');

    out.set(site.id, { tracking_since: tracking, sources: src, paymentsWithoutRevenue });
  }
  if (memo.size > 100) memo.clear();
  memo.set(key, { at: now, value: out });
  return out;
}

/**
 * The short form for lists of sites (whoami, get_portfolio, get_definitions without a site): each source's status,
 * and the sources that need a look with their error.
 */
export function compactSources(s: Record<SourceId, SourceHealth>) {
  const status = Object.fromEntries(SOURCE_IDS.map((id) => [id, s[id].status])) as Record<SourceId, SourceStatus>;
  const problems = SOURCE_IDS.filter((id) => s[id].status === 'error' || s[id].status === 'stale').map((id) => ({
    source: id,
    status: s[id].status,
    last_ok_at: s[id].last_ok_at,
    last_error: s[id].last_error,
    detail: s[id].detail,
  }));
  return { status, problems };
}

/**
 * Where a site's visitor and revenue numbers start, in ms: the first stored or imported visit, and the first payment or
 * App Store sales day. One statement for any number of sites, each value an index walk that stops at the first row.
 * get_overview and get_portfolio use it to tell a real "period before" from pre-tracking zeros.
 */
export async function dataStarts(db: D1Database, sites: Site[]): Promise<Map<string, { visitors: number | null; revenue: number | null }>> {
  if (!sites.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT st.id,
              (SELECT started_at FROM sessions WHERE site_id = st.id ORDER BY started_at LIMIT 1) AS first_at,
              (SELECT MIN(from_day) FROM imports WHERE site_id = st.id) AS imported_from,
              (SELECT p.ts FROM payments p WHERE p.site_id = st.id AND p.provider NOT IN ${TEST_PROVIDERS_SQL} ORDER BY p.ts LIMIT 1) AS first_pay,
              (SELECT MIN(report_date) FROM asc_sales WHERE site_id = st.id) AS asc_first
       FROM sites st WHERE st.id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(sites.map((s) => s.id)))
    .all<{ id: string; first_at: number | null; imported_from: string | null; first_pay: number | null; asc_first: string | null }>();
  const tz = new Map(sites.map((s) => [s.id, s.timezone]));
  return new Map(
    results.map((r) => {
      const zone = tz.get(r.id) ?? 'UTC';
      return [
        r.id,
        {
          visitors: minOf(r.first_at, r.imported_from ? midnight(r.imported_from, zone) : null),
          revenue: minOf(r.first_pay, r.asc_first ? midnight(r.asc_first, zone) : null),
        },
      ];
    }),
  );
}

/**
 * Why there is no "period before" to compare with, or null when there is one: the data starts after the period before
 * began, so its zeros mean "not tracked yet", not "nothing happened". `start` is ms, or null when there is no data at
 * all: then both periods are 0 and compare as they are.
 */
export function noPrevious(start: number | null, previousFrom: number, what: 'visitors' | 'revenue', tz = 'UTC'): string | null {
  if (start === null || start <= previousFrom) return null;
  const day = dayInTz(start, tz);
  return what === 'visitors'
    ? `Visits are recorded since ${day}, after the period before began, so there is nothing to compare with.`
    : `Revenue is recorded since ${day}, after the period before began, so there is nothing to compare with.`;
}

/**
 * What a key without read:revenue sees: whether payments are connected and whether they fail, but not when payments
 * came. No provider list, no time of the last payment, no "went quiet" status, and no first payment or sales day, the
 * way get_overview leaves out data_since.revenue for such a key.
 */
export function trustForKey(t: SiteTrust, showRevenue: boolean): SiteTrust {
  if (showRevenue) return t;
  return {
    ...t,
    tracking_since: { ...t.tracking_since, payments: null, revenue: null, app_store: null },
    sources: { ...t.sources, payments: t.paymentsWithoutRevenue },
  };
}
