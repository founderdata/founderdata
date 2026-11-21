// Core Web Vitals from real visitors (docs/GUIDE.md "Page speed", docs/API.md "GET /api/v1/vitals").
//
// The tracker measures LCP, INP, CLS, TTFB and FCP with the browser's PerformanceObserver and sends them once per page
// load, in the engaged-time ping it already sends when the page is hidden (collect.ts). A stored beacon is 1 row in
// `vitals` (migration 0036), with no visitor or session id. `sites.vitals_sample` keeps that share of beacons, 100% by
// default, so a small site gets every sample and a busy one can trade samples for rows.
//
// The read side runs the percentile in D1 (window functions), not in the Worker: the Worker only maps a few dozen
// result rows, so a site with many beacons stays inside the free plan's 10 ms of CPU.
import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { normalizePath } from './collect';
import { mapCutoffSql } from './page-maps';

export const METRICS = ['lcp', 'inp', 'cls', 'ttfb', 'fcp'] as const;
export type Metric = (typeof METRICS)[number];

/**
 * Google's thresholds (web.dev/articles/vitals): good at or below `good`, poor above `poor`, needs improvement between.
 * A page passes a metric when its 75th percentile is good.
 */
export const THRESHOLDS: Record<Metric, { good: number; poor: number; unit: 'ms' | 'score' }> = {
  lcp: { good: 2500, poor: 4000, unit: 'ms' },
  inp: { good: 200, poor: 500, unit: 'ms' },
  cls: { good: 0.1, poor: 0.25, unit: 'score' },
  ttfb: { good: 800, poor: 1800, unit: 'ms' },
  fcp: { good: 1800, poor: 3000, unit: 'ms' },
};

/** Below this many samples in a group, a metric answers p75 null with the count: a percentile of a handful is noise. */
export const MIN_SAMPLE = 20;
/** Days of vitals kept, and the longest window a read may ask for (retention.ts deletes older rows). */
export const VITALS_DAYS = 90;
export const DEFAULT_DAYS = 28;
const DAY = 86_400_000;

/** The largest value each metric may have; anything above is a broken measurement and is dropped. */
const MAX: Record<Metric, number> = { lcp: 120_000, inp: 60_000, cls: 50, ttfb: 120_000, fcp: 120_000 };
/** Payload keys: the tracker sends one letter per metric to keep the beacon small. */
const KEYS: Record<string, Metric> = { l: 'lcp', i: 'inp', c: 'cls', t: 'ttfb', f: 'fcp' };

/** The five metrics, plus the deepest scroll of the page load in percent (`v.s`, round 7, migration 0090). */
export type Measured = Record<Metric, number | null> & { scroll?: number | null };

/**
 * The metrics in a ping's `v`, checked and rounded, or null when it holds none. `v.s`, the deepest scroll in percent
 * (0 to 100), rides along as `scroll`; alone it keeps no row.
 */
export function parseVitals(v: unknown): Measured | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = (v as Record<string, unknown>).s;
  const out: Measured = { lcp: null, inp: null, cls: null, ttfb: null, fcp: null };
  if (typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 100) out.scroll = Math.round(s);
  let any = false;
  for (const [k, m] of Object.entries(KEYS)) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > MAX[m]) continue;
    out[m] = m === 'cls' ? Math.round(x * 10_000) / 10_000 : Math.round(x);
    any = true;
  }
  return any ? out : null;
}

/** The page the vitals belong to: `v.p` (the page that loaded, before any single-page-app navigation), else `fallback`. */
export function vitalsPath(v: unknown, fallback: string): string {
  const p = v && typeof v === 'object' ? (v as Record<string, unknown>).p : undefined;
  return typeof p === 'string' && p.startsWith('/') && p.length <= 2000 ? normalizePath(p.split(/[?#]/)[0]) : fallback;
}

/** Percent of beacons a site keeps, 0 to 100 (migration 0036); 100 when unset. */
export function sampleOf(site: Pick<Site, 'vitals_sample'>): number {
  const n = Number(site.vitals_sample ?? 100);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 100;
}

/** The INSERT for one beacon, or null when the site's sample skips it. */
export function insertVitals(
  db: D1Database,
  site: Site,
  m: Measured,
  path: string,
  device: string | null,
  now: number,
  random = Math.random,
): D1PreparedStatement | null {
  const rate = sampleOf(site);
  if (rate <= 0 || (rate < 100 && random() * 100 >= rate)) return null;
  return db
    .prepare('INSERT OR IGNORE INTO vitals (site_id, ts, id, path, device, lcp, inp, cls, ttfb, fcp, scroll) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(site.id, now, Math.floor(random() * 2 ** 31), path, device, m.lcp, m.inp, m.cls, m.ttfb, m.fcp, m.scroll ?? null);
}

// ---------- reading

export interface MetricSummary {
  /** The 75th percentile (nearest rank), or null below MIN_SAMPLE. ms, or the CLS score. */
  p75: number | null;
  /** Page loads that reported this metric. */
  samples: number;
  /** Shares of samples rated good, needs improvement and poor, 0 to 1; null below MIN_SAMPLE. */
  good: number | null;
  needs_improvement: number | null;
  poor: number | null;
  /** The p75's rating, null below MIN_SAMPLE. */
  rating: 'good' | 'needs_improvement' | 'poor' | null;
}

export type GroupSummary = { page_loads: number } & Record<Metric, MetricSummary>;

type Row = { m: string; g: string | null; n: number; p75: number | null; good: number; poor: number };

const rate = (m: Metric, v: number): MetricSummary['rating'] => (v <= THRESHOLDS[m].good ? 'good' : v > THRESHOLDS[m].poor ? 'poor' : 'needs_improvement');
const share = (x: number, n: number) => Math.round((x / n) * 1000) / 1000;

function summary(m: Metric, r: Row | undefined): MetricSummary {
  const n = r?.n ?? 0;
  if (!r || n < MIN_SAMPLE || r.p75 === null) return { p75: null, samples: n, good: null, needs_improvement: null, poor: null, rating: null };
  const p75 = m === 'cls' ? Math.round(r.p75 * 1000) / 1000 : Math.round(r.p75);
  return { p75, samples: n, good: share(r.good, n), needs_improvement: share(n - r.good - r.poor, n), poor: share(r.poor, n), rating: rate(m, r.p75) };
}

/**
 * One statement: every metric's sample count, nearest-rank p75 and good and poor counts per group. `group` is a column
 * of `vitals` or '' for one group. The pseudo-metric `n` counts page loads. The metrics are unpivoted with json_each,
 * not UNION ALL: D1 caps the terms of a compound SELECT below six.
 */
function groupSql(group: 'path' | 'device' | "''", pageFilter: boolean, topPages: boolean): string {
  // json_each has a path column too, so base's columns are named with b.
  const g = group === "''" ? "''" : group === 'device' ? "COALESCE(b.device, 'Unknown')" : 'b.path';
  const cases = (k: 'good' | 'poor') =>
    `CASE m ${METRICS.map((m) => `WHEN '${m}' THEN ${THRESHOLDS[m][k]}`).join(' ')} END`;
  return `WITH base AS (
      SELECT path, device, lcp, inp, cls, ttfb, fcp FROM vitals
      WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3${pageFilter ? ' AND path = ?4' : ''}${
        topPages ? ` AND path IN (SELECT path FROM vitals WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 GROUP BY path ORDER BY COUNT(*) DESC, path LIMIT ?5)` : ''
      }
    ),
    u AS (
      SELECT ms.value AS m, ${g} AS g, CASE ms.value WHEN 'n' THEN 0 ${METRICS.map((m) => `WHEN '${m}' THEN b.${m}`).join(' ')} END AS v
      FROM base AS b, json_each('${JSON.stringify(['n', ...METRICS])}') AS ms
    ),
    r AS (
      SELECT m, g, v, ROW_NUMBER() OVER (PARTITION BY m, g ORDER BY v) AS rn, COUNT(*) OVER (PARTITION BY m, g) AS n
      FROM u WHERE v IS NOT NULL
    )
    SELECT m, g, MAX(n) AS n, MIN(CASE WHEN rn * 4 >= n * 3 THEN v END) AS p75,
      SUM(CASE WHEN m != 'n' AND v <= ${cases('good')} THEN 1 ELSE 0 END) AS good,
      SUM(CASE WHEN m != 'n' AND v > ${cases('poor')} THEN 1 ELSE 0 END) AS poor
    FROM r GROUP BY m, g`;
}

function groups(rows: Row[]): Map<string, GroupSummary> {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.g ?? '';
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const out = new Map<string, GroupSummary>();
  for (const [k, list] of by) {
    const of = (m: string) => list.find((r) => r.m === m);
    out.set(k, { page_loads: of('n')?.n ?? 0, ...(Object.fromEntries(METRICS.map((m) => [m, summary(m, of(m))])) as Record<Metric, MetricSummary>) });
  }
  return out;
}

const empty = (): GroupSummary => ({ page_loads: 0, ...(Object.fromEntries(METRICS.map((m) => [m, summary(m, undefined)])) as Record<Metric, MetricSummary>) });

// ---------- scroll depth (round 7, lane pages)

/** Below this many page loads with a scroll depth, the median and shares answer null with the count. */
export const MIN_SCROLL_SAMPLE = 10;
/**
 * Page speed rows a page needs before its scroll depth comes from them (pickScroll). Below it the click map rows of the
 * page answer when there are more of them: they also cover single-page moves.
 */
export const SCROLL_SPEED_MIN = 30;

/** Where a scroll summary's numbers come from: the page speed rows (`vitals`) or the click map rows (`page_maps`). */
export type ScrollSource = 'page_speed' | 'click_maps';

export interface ScrollSummary {
  /** Page views that reported a scroll depth. */
  samples: number;
  /** The middle scroll depth, percent of the page height (0 to 100); null below MIN_SCROLL_SAMPLE. */
  median_pct: number | null;
  /** Shares of those page views whose screen bottom reached 25, 50, 75 and 100% of the page, 0 to 1. */
  reached_25: number | null;
  reached_50: number | null;
  reached_75: number | null;
  reached_100: number | null;
  /** The rows the numbers come from; null without samples. */
  source: ScrollSource | null;
}

type ScrollRow = { g: string; n: number; median: number | null; r25: number; r50: number; r75: number; r100: number };

/**
 * One statement: the scroll summary of page speed rows per path (or one group), in D1. `pageFilter` binds one path as
 * ?4; `topPages` keeps the ?5 paths with the most rows; `pathList` keeps the paths of the JSON array ?4; `device` binds
 * one device as ?5 (not with topPages).
 */
export function scrollSql(byPath: boolean, pageFilter: boolean, topPages: boolean, pathList = false, device = false): string {
  return `WITH b AS (
      SELECT ${byPath ? 'path' : "''"} AS g, scroll FROM vitals
      WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 AND scroll IS NOT NULL${pageFilter ? ' AND path = ?4' : ''}${
        pathList ? ' AND path IN (SELECT value FROM json_each(?4))' : ''
      }${device ? ' AND device = ?5' : ''}${topPages ? ` AND path IN (SELECT path FROM vitals WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 GROUP BY path ORDER BY COUNT(*) DESC, path LIMIT ?5)` : ''}
    ),
    r AS (SELECT g, scroll, ROW_NUMBER() OVER (PARTITION BY g ORDER BY scroll) AS rn, COUNT(*) OVER (PARTITION BY g) AS n FROM b)
    SELECT g, MAX(n) AS n, MIN(CASE WHEN rn * 2 >= n THEN scroll END) AS median,
      SUM(scroll >= 25) AS r25, SUM(scroll >= 50) AS r50, SUM(scroll >= 75) AS r75, SUM(scroll >= 100) AS r100
    FROM r GROUP BY g`;
}

/** The summary of one scroll row, or the empty summary. */
export function scrollSummary(r: ScrollRow | undefined, source: ScrollSource = 'page_speed'): ScrollSummary {
  const n = Number(r?.n ?? 0);
  if (!r || n < MIN_SCROLL_SAMPLE)
    return { samples: n, median_pct: null, reached_25: null, reached_50: null, reached_75: null, reached_100: null, source: n ? source : null };
  return {
    samples: n,
    median_pct: r.median,
    reached_25: share(r.r25, n),
    reached_50: share(r.r50, n),
    reached_75: share(r.r75, n),
    reached_100: share(r.r100, n),
    source,
  };
}

/**
 * The scroll depth of one page: the page speed rows when they number SCROLL_SPEED_MIN or more, else the click map rows
 * when there are more of those, else what the page speed rows have. The Content list, the page's "Clicks and scroll"
 * card, GET /api/v1/content/page and get_content all pick this way, so they show one number for a page and window.
 */
export function pickScroll(speed: ScrollSummary, maps: ScrollSummary | null | undefined): ScrollSummary {
  if (speed.samples >= SCROLL_SPEED_MIN || !maps || maps.samples <= speed.samples) return speed;
  return maps;
}

/**
 * The scroll summary of click map rows (page_maps) per path of the JSON array ?4, in D1, with each path's mapped page
 * views. Each path reads at most its newest MAP_READ_CAP rows of the window (mapCutoffSql), so a busy page costs the
 * same as one with 2,000 mapped views. ?5 is an optional device.
 */
export function mapScrollSql(device: boolean): string {
  const dev = device ? ' AND m.device = ?5' : '';
  // p is materialized so each path's cutoff runs once, and CROSS JOIN keeps it the outer loop, so each path reads its
  // primary key range from the cutoff on.
  return `WITH q AS (SELECT DISTINCT value AS path FROM json_each(?4)),
    p AS MATERIALIZED (SELECT path, ${mapCutoffSql('q.path')} AS cut FROM q),
    b AS (
      SELECT m.path AS g, m.scroll FROM p CROSS JOIN page_maps m ON m.site_id = ?1 AND m.path = p.path AND m.ts >= p.cut AND m.ts < ?3${dev}
    ),
    r AS (SELECT g, scroll, ROW_NUMBER() OVER (PARTITION BY g ORDER BY scroll IS NULL, scroll) AS rn, COUNT(scroll) OVER (PARTITION BY g) AS n FROM b)
    SELECT g, COUNT(*) AS views, MAX(n) AS n, MIN(CASE WHEN scroll IS NOT NULL AND rn * 2 >= n THEN scroll END) AS median,
      SUM(scroll >= 25) AS r25, SUM(scroll >= 50) AS r50, SUM(scroll >= 75) AS r75, SUM(scroll >= 100) AS r100
    FROM r GROUP BY g`;
}

/** Click map scroll summaries and mapped page views of these paths, keyed by path. Reads only `page_maps`. */
export async function mapScrollByPath(
  db: D1Database,
  siteId: string,
  paths: string[],
  from: number,
  to: number,
  device: string | null = null,
): Promise<Map<string, { views: number; scroll: ScrollSummary }>> {
  if (!paths.length) return new Map();
  const args: unknown[] = [siteId, from, to, JSON.stringify(paths)];
  if (device) args.push(device);
  const { results } = await db
    .prepare(mapScrollSql(!!device))
    .bind(...args)
    .all<ScrollRow & { views: number }>();
  return new Map(results.map((r) => [r.g, { views: Number(r.views), scroll: scrollSummary(r, 'click_maps') }]));
}

/**
 * The scroll depth of one page in [from, to) by pickScroll, optionally of one device. `speed` is the page's page speed
 * summary when the caller already read it (contentPage reads vitals anyway); the click map rows are read only when the
 * page speed rows number fewer than SCROLL_SPEED_MIN.
 */
export async function pageScroll(
  db: D1Database,
  siteId: string,
  path: string,
  from: number,
  to: number,
  opts: { device?: string | null; speed?: ScrollSummary } = {},
): Promise<ScrollSummary> {
  const device = opts.device ?? null;
  const speed =
    opts.speed ??
    scrollSummary(
      (await db
        .prepare(scrollSql(false, true, false, false, !!device))
        .bind(...(device ? [siteId, from, to, path, device] : [siteId, from, to, path]))
        .first<ScrollRow>()) ?? undefined,
    );
  if (speed.samples >= SCROLL_SPEED_MIN) return speed;
  const maps = (await mapScrollByPath(db, siteId, [path], from, to, device)).get(path)?.scroll;
  return pickScroll(speed, maps);
}

/**
 * The scroll depth of many pages by pickScroll, and whether each has a click map in the window, keyed by path: the
 * Content list's Scroll column and map label. Round trip 1 reads the page speed rows of these paths and 1 row per
 * mapped path; round trip 2, only when some mapped path has fewer than SCROLL_SPEED_MIN page speed rows, reads those
 * paths' click map rows (capped per path). Paths without either are left out.
 */
export async function scrollByPathPicked(
  db: D1Database,
  siteId: string,
  paths: string[],
  from: number,
  to: number,
): Promise<Map<string, { scroll: ScrollSummary; mapped: boolean }>> {
  const list = [...new Set(paths)].slice(0, 500);
  const out = new Map<string, { scroll: ScrollSummary; mapped: boolean }>();
  if (!list.length) return out;
  const json = JSON.stringify(list);
  const [speedRes, mappedRes] = await db.batch([
    db.prepare(scrollSql(true, false, false, true)).bind(siteId, from, to, json),
    db
      .prepare(
        'SELECT p.value AS path FROM json_each(?4) p WHERE EXISTS (SELECT 1 FROM page_maps m WHERE m.site_id = ?1 AND m.path = p.value AND m.ts >= ?2 AND m.ts < ?3)',
      )
      .bind(siteId, from, to, json),
  ]);
  const speed = new Map((speedRes.results as ScrollRow[]).map((r) => [r.g, scrollSummary(r)]));
  const mapped = new Set((mappedRes.results as { path: string }[]).map((r) => r.path));
  const short = [...mapped].filter((p) => (speed.get(p)?.samples ?? 0) < SCROLL_SPEED_MIN);
  const maps = await mapScrollByPath(db, siteId, short, from, to);
  for (const p of list) {
    const s = speed.get(p);
    const m = maps.get(p)?.scroll;
    if (!s && !m && !mapped.has(p)) continue;
    out.set(p, { scroll: pickScroll(s ?? scrollSummary(undefined), m), mapped: mapped.has(p) });
  }
  return out;
}

/** Days the Content list's scroll column and map label cover, whatever the period: the click map card's window. */
export const PAGE_SCROLL_DAYS = 28;

/**
 * The Content list with each row's `scroll_median_pct` (pickScroll's median over the last 28 days, null below 10
 * samples or without any) and `has_click_map` (a click map row in those days): GET /api/v1/content, get_content without
 * a path, and the Content tab. 1 or 2 round trips (scrollByPathPicked), whatever the period.
 */
export async function withPageScroll<R extends { page: string }, T extends { rows: R[] }>(
  db: D1Database,
  siteId: string,
  out: T,
  now = Date.now(),
): Promise<Omit<T, 'rows'> & { scroll_days: number; rows: (R & { scroll_median_pct: number | null; has_click_map: boolean })[] }> {
  const by = await scrollByPathPicked(
    db,
    siteId,
    out.rows.map((r) => r.page),
    now - PAGE_SCROLL_DAYS * DAY,
    now,
  );
  return {
    ...out,
    scroll_days: PAGE_SCROLL_DAYS,
    rows: out.rows.map((r) => ({ ...r, scroll_median_pct: by.get(r.page)?.scroll.median_pct ?? null, has_click_map: by.get(r.page)?.mapped ?? false })),
  };
}

export interface VitalsReport {
  site_id: string;
  from: string;
  to: string;
  days: number;
  path: string | null;
  sample_rate: number;
  min_sample: number;
  thresholds: typeof THRESHOLDS;
  overall: GroupSummary;
  /** Scroll depth of the page loads in the window (all pages, or `path`), from page speed rows only. */
  scroll: ScrollSummary;
  devices: ({ device: string } & GroupSummary)[];
  /** Absent when `path` is set. Each page has its scroll depth too. */
  pages?: ({ path: string; scroll: ScrollSummary } & GroupSummary)[];
  total_pages?: number;
}

/** The p75 and the good, needs improvement and poor shares per metric: overall, per device and per page (top `limit`). */
export async function vitalsReport(
  db: D1Database,
  site: Site,
  opts: { days?: number; path?: string | null; limit?: number; now?: number } = {},
): Promise<VitalsReport> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? DEFAULT_DAYS;
  const from = now - days * DAY;
  const path = opts.path ?? null;
  const limit = opts.limit ?? 20;
  const args = path ? [site.id, from, now, path] : [site.id, from, now];
  const stmts = [
    db.prepare(groupSql("''", !!path, false)).bind(...args),
    db.prepare(groupSql('device', !!path, false)).bind(...args),
    db.prepare(scrollSql(false, !!path, false)).bind(...args),
  ];
  if (!path) {
    stmts.push(
      db.prepare(groupSql('path', false, true)).bind(site.id, from, now, null, limit),
      db.prepare('SELECT COUNT(DISTINCT path) AS n FROM vitals WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3').bind(site.id, from, now),
      db.prepare(scrollSql(true, false, true)).bind(site.id, from, now, null, limit),
    );
  }
  const res = await db.batch(stmts);
  const overall = groups(res[0].results as Row[]).get('') ?? empty();
  const devices = [...groups(res[1].results as Row[])].map(([device, g]) => ({ device, ...g })).sort((a, b) => b.page_loads - a.page_loads);
  const out: VitalsReport = {
    site_id: site.id,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    days,
    path,
    sample_rate: sampleOf(site),
    min_sample: MIN_SAMPLE,
    thresholds: THRESHOLDS,
    overall,
    scroll: scrollSummary(res[2].results[0] as ScrollRow | undefined),
    devices,
  };
  if (!path) {
    const scrolls = new Map((res[5].results as ScrollRow[]).map((r) => [r.g, r]));
    out.pages = [...groups(res[3].results as Row[])]
      .map(([p, g]) => ({ path: p, ...g, scroll: scrollSummary(scrolls.get(p)) }))
      .sort((a, b) => b.page_loads - a.page_loads || a.path.localeCompare(b.path));
    out.total_pages = (res[4].results[0] as { n: number } | undefined)?.n ?? 0;
  }
  return out;
}

/** GET /api/v1/vitals and /api/sites/:id/vitals: ?days (1 to 90, default 28), ?path, ?limit (pages, 1 to 100, default 20). */
export async function vitalsRoute(c: Context<AppEnv>) {
  const q = c.req.query();
  const days = q.days === undefined || q.days === '' ? DEFAULT_DAYS : Number(q.days);
  if (!Number.isInteger(days) || days < 1 || days > VITALS_DAYS) return c.json({ error: `days is a whole number from 1 to ${VITALS_DAYS}` }, 400);
  let path: string | null = null;
  if (q.path !== undefined && q.path !== '') {
    if (!q.path.startsWith('/')) return c.json({ error: 'path is a page path that starts with /, such as /pricing' }, 400);
    path = normalizePath(q.path.split(/[?#]/)[0]);
  }
  const limit = q.limit === undefined || q.limit === '' ? 20 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ error: 'limit is a whole number from 1 to 100' }, 400);
  return c.json(await vitalsReport(c.env.DB, c.get('site'), { days, path, limit }));
}
