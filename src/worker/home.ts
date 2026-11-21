import type { Site } from './env';
import { countedAllSql } from './datacenter';
import { TREND_RULES } from '../shared/trend-rules';
import { bucketLabels, bucketSql, dayInTz, midnight, offsetsIn, previousRange, resolveRange, startOfDay, tzOffset } from './lib/time';
import { convertPayments, PAY_AMOUNT, payCurrency, rateLookup } from './fx';
import { currencyDecimals } from './payments';
import { REAL } from './stats';
import { refusedItems, stoppedItems, stoppedProviders } from './silence';
import { refusedWebhooks } from './budget';
import type { MrrMovement } from './subscriptions';
import type { SiteMrr } from './pro-hooks';
import { type ConvertedProceeds, type MoneyLine, APPLE_PAYMENT, appStoreLayerPlan, ascPrefetch, ascPrefetchSpan, appleNet, appleSplitColumns, dayBucket, KEPT_CHANNEL_SQL, KEPT_CREDIT, KEPT_SOURCE_SQL, noSourceAmount, revenueBasis } from './revenue';
import { asaPrefetch, sinceYesterday } from './since-yesterday';
import { goalCounts, siteGoal } from './primary-goal';
import { COUNTED_SITES, productNumbers, productTrend, productType } from './product-type';
import { pickTimezone, savedTimezone, type TimezoneSource } from './reporting';
import { searchDropText } from './search-drop-text';
import type { SearchDrop } from '../shared/seo-insights';
// Last, so every module this file needs has loaded before Pro's tree (which imports them back) does.
import { proHooks } from './pro-hooks';
import { appHostSql, hasApp, platformSql, webHostSql } from '../shared/platform';

/**
 * The home page: every site side by side for one period, plus totals, a combined chart, where visitors and money
 * came from across all sites, the latest payments and the things worth a look.
 *
 * All sites share one range in the reporting timezone (src/worker/reporting.ts: `?tz=`, else the setting, else the
 * timezone every site shares, else UTC), so the combined chart lines up and web Home, the iPhone and the read API
 * show the same numbers. A site's own dashboard uses the site's timezone; a site in another one says so on its page.
 *
 * Revenue counts in each site's currency, with payments in other currencies converted (src/worker/fx.ts). A payment
 * not converted yet stays in its own currency, and totals add up amounts of the same currency only. App Store sales
 * come from Apple's report on the days it covers and from the payment rows on the others (src/worker/revenue.ts).
 */

/** 'ios', 'android' or 'web' (src/shared/platform.ts), for the feed. */
const PLATFORM = platformSql('s.hostname');
/** 'app' (iOS or Android) or 'web', for the platform tiles. */
const TILE = `(CASE WHEN ${appHostSql('s.hostname')} THEN 'app' ELSE 'web' END)`;
/**
 * Every site, as a condition on the leading column of the (site_id, time) indexes: without it a time range alone
 * walks the whole index, every visit or payment ever stored, to find the period's rows.
 */
const IN_SITES = (alias?: string) => `${alias ? `${alias}.` : ''}site_id IN (SELECT id FROM sites)`;
const HOME_PERIODS = new Set(['today', 'yesterday', '24h', '7d', '30d', '90d', '12m', 'thisquarter', 'lastquarter', 'all']);
/** Below this many visitors in the previous period a change is shown as a count, not a percentage. */
export const MIN_BASE = 20;
/** Next actions Home's "Worth a look" lists at most. */
export const HOME_ACTIONS = 6;

/** The status and weekly thresholds (src/shared/trend-rules.ts), returned as `trendRules`. */
export { TREND_RULES };
const QUIET_HOURS = TREND_RULES.quietHours;

export type Money = Record<string, number>;

interface SiteKpis {
  visitors: number;
  sessions: number;
  bounceRate: number;
  avgDuration: number;
  customers: number;
  /** Subscriptions whose trial started in the period, sandbox left out (the Subscriptions tab's trials started). */
  trials: number;
  /** Purchases: payments, plus units sold on the days Apple's report covers. */
  payments: number;
  revenue: Money;
  /** The App Store part of `revenue`: Apple's report on the days it covers, App Store payment rows on the others. */
  appStoreRevenue: Money;
}

const emptyKpis = (): SiteKpis => ({ visitors: 0, sessions: 0, bounceRate: 0, avgDuration: 0, customers: 0, trials: 0, payments: 0, revenue: {}, appStoreRevenue: {} });

const addMoney = (m: Money, currency: string, amount: number) => {
  m[currency] = (m[currency] ?? 0) + amount;
};

/**
 * `opts.sinceYesterday` false skips the "Since yesterday" block (src/worker/since-yesterday.ts), for callers that
 * do not show it, such as the portfolio. Its Meta ads numbers (`sinceYesterday.meta`) are read only with
 * `q.yesterday=meta`, which the phone's Home sends: the web dashboard does not show the block.
 *
 * `q.compare=sametime` with `period=today` compares today so far with yesterday up to the same time (yesterday's
 * midnight to now minus 24 hours) instead of the same length right before. `q.parts=pulse` answers only the totals
 * and both charts (`series`, `previousSeries`), for the phone's Pulse grid: no sites, sources, payments, "Since
 * yesterday", changes or attention, and none of their statements.
 */
export async function home(db: D1Database, q: Record<string, string | undefined>, now = Date.now(), opts: HomeOptions = {}): Promise<HomeFull> {
  return (await homeData(db, q, now, opts, false)) as HomeFull;
}

/** GET /api/home?parts=pulse: the totals and both charts of `home`, from the same statements (docs/MOBILE-API.md section 7). */
export async function homePulse(db: D1Database, q: Record<string, string | undefined>, now = Date.now(), opts: Pick<HomeOptions, 'convert'> = {}): Promise<HomePulse> {
  return (await homeData(db, q, now, opts, true)) as HomePulse;
}

interface HomeOptions {
  sinceYesterday?: boolean;
  changes?: boolean;
  /** Convert pending payments first (fx.ts convertPayments, with its quiet time), in the first round trip. The route sets it. */
  convert?: boolean;
}
type HomeResult = Awaited<ReturnType<typeof homeData>>;
export type HomeFull = Exclude<HomeResult, { parts: 'pulse' }>;
export type HomePulse = Extract<HomeResult, { parts: 'pulse' }>;

async function homeData(db: D1Database, q: Record<string, string | undefined>, now: number, opts: HomeOptions, pulse: boolean) {
  const period = HOME_PERIODS.has(q.period ?? '') ? q.period! : '30d';
  const compare: 'previous' | 'sametime' = q.compare === 'sametime' && period === 'today' ? 'sametime' : 'previous';
  // Round trip 1: everything that needs neither the sites nor the timezone. The sites and the saved timezone, the
  // payments to convert (only with opts.convert, the route's), Apple's report rows over a span that covers any
  // timezone, the refused webhooks and quiet providers, the sites with payments, and the notes "Worth a look" judges.
  // On a GET route the binding sends these as one batch (lib/d1-trace.ts batchingDb).
  const span = ascPrefetchSpan(period, now, TREND_RULES.weeks);
  const wantsYesterday = !pulse && opts.sinceYesterday !== false;
  const [siteRes, saved, , pre, refusedRows, stoppedRows, paidIds0, asa, proEarly] = await Promise.all([
    db.prepare('SELECT * FROM sites ORDER BY created_at').all<Site>(),
    savedTimezone(db),
    opts.convert ? convertPayments(db, fetch, { reads: true }).catch(() => 0) : null,
    ascPrefetch(db, span.from, span.to),
    pulse ? null : refusedWebhooks(db, now),
    pulse ? null : stoppedProviders(db, now),
    pulse ? null : sitesWithPayments(db),
    wantsYesterday ? asaPrefetch(db, now) : null,
    // Pro's reads (changes, Apple's currencies, search drops, next actions), started in the same batch.
    proHooks()?.home?.start(db, { pulse, changes: opts.changes !== false, now, span }) ?? null,
  ]);
  const sites = siteRes.results;
  // The reporting timezone, or the caller's ?tz= (src/worker/reporting.ts). `reportingTz` is the deployment's either way.
  const zone = pickTimezone(q.tz, saved, sites.map((s) => s.timezone));
  const tz = zone.timezone;
  const reporting = pickTimezone(null, saved, sites.map((s) => s.timezone));
  const tzInfo = { tzSource: zone.source as TimezoneSource, reportingTz: reporting.timezone };
  const firstCreated = sites.length ? Math.min(...sites.map((s) => s.created_at)) : now;
  const range = resolveRange({ period }, tz, firstCreated, now);
  // The comparison period ends at or before range.from; a quarter's can stop short of it (this quarter so far), and
  // so does yesterday up to the same time.
  const before = compare === 'sametime' ? sameTimeYesterday(range.from, tz, now) : previousRange(range, period, tz);
  // Both periods' days in local time, also across a daylight saving change (offsetsIn).
  const offsets = offsetsIn(tz, Math.min(before.from, range.from), range.to);
  const sb = bucketSql('s.started_at', range.granularity, offsets);
  const pb = bucketSql('p.ts', range.granularity, offsets);
  const tb = bucketSql('trial_start', range.granularity, offsets);
  const labels = bucketLabels(range, offsets);
  // The comparison period's buckets, at the same granularity, so point i of both charts lines up.
  const beforeLabels = bucketLabels({ ...before, granularity: range.granularity }, offsets);
  const head = { range, previousRange: before, compare, tz, ...tzInfo, period };

  if (!sites.length) {
    const totals = { current: emptyKpis(), basis: null, previous: emptyKpis(), online: 0 };
    if (pulse) return { ...head, parts: 'pulse' as const, totals, series: [], previousSeries: [] };
    return { ...head, minBase: MIN_BASE, trendRules: TREND_RULES, sites: [], totals, series: [], previousSeries: [], sources: [], appStoreNoSource: {} as Record<string, number>, payments: [], sinceYesterday: null, changes: null as unknown, attention: [], actions: [] as unknown[] };
  }

  // The last full weeks for the ranked panel's sparkline, whatever the period (weekWindow).
  const weeks = weekWindow(now, tz);
  const wOffset = tzOffset(tz, weeks.to);
  // Round trip 2: everything else, started together.
  // Apple's report for the days it covers, in both periods; App Store payment rows on those days stay out. The plans
  // give `reported` from the rows read in round trip 1; their amounts may still wait on the rate lookup.
  // The weeks get a layer of their own: their days may cut a period's partial days, which the period's layer must keep.
  const [plan, weekPlan] = await Promise.all([
    appStoreLayerPlan(db, sites, tz, [range, before], { now, prefetch: pre }),
    pulse ? null : appStoreLayerPlan(db, sites, tz, [weeks], { now, prefetch: pre }),
  ]);
  const layerP = plan.layer();
  const weekLayerP = weekPlan ? weekPlan.layer() : null;
  // Pro's parts: MRR now and at the start of the period and at 12 points through it (the sparkline under the MRR number),
  // the changes of the last 7 days, Apple's downloads and proceeds, search drops and next actions. Core runs without them.
  const offset = tzOffset(tz, range.to);
  const pp = proHooks()?.home?.parts(db, proEarly, { sites, range, tz, offset, now, prefetch: pre });
  const mrrP: Promise<Map<string, SiteMrr>> = pp?.mrr ?? Promise.resolve(new Map());
  const mrrSeriesP = pp?.mrrSeries ?? null;
  const drops = pp?.drops ?? null;
  const rep = plan.reported;
  // The tiles per platform (web and app visitors), next to the totals below. Their visits come from the per-site totals
  // of the batch below (kpi), summed over the sites that are not an extension or a newsletter.
  let giveVisits: (rows: PlatformVisitRow[]) => void = () => undefined;
  const platformVisits = new Promise<PlatformVisitRow[]>((resolve) => (giveVisits = resolve));
  const platforms = platformTotals(db, range, before, { visits: platformVisits });
  // The last 24 hours against the 24 before, and yesterday's Apple Search Ads spend, whatever the period.
  const yesterday = wantsYesterday ? sinceYesterday(db, sites, tz, now, { asa, meta: q.yesterday === 'meta' }) : null;
  // Each site's primary goal in both periods (src/worker/primary-goal.ts); no query when no site has one.
  const goals = pulse ? null : goalCounts(db, sites, range, before);
  // The numbers of extensions and newsletters (src/worker/product-type.ts); no query when no site is one.
  const products = pulse ? null : productNumbers(db, sites, range, before, now);
  // Downloads and proceeds Apple reports, for an app with no sessions in the period (`appStore` below). Pro reads them
  // for every site with an app now, so it needs no third round trip once the sessions are counted.
  const appDays = (ms: number) => new Date(ms + offset).toISOString().slice(0, 10);
  const appReported = pp?.appStore ?? null;
  const changes = pp?.changes ?? null;
  // Both periods in one pass: rows from before.from to range.to, minus any gap between the two periods.
  const both = (col: string) => `${col} >= ? AND ${col} < ? AND (${col} >= ? OR ${col} < ?)`;
  const bothBind = [before.from, range.to, range.from, before.to];

  // The statements Pulse needs: totals, both charts and the online count.
  const core = {
    // Current and previous period in one pass over the sessions.
    kpi: db
      .prepare(
        `SELECT s.site_id, (s.started_at >= ?) AS cur,
                COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions,
                SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END) AS bounces,
                AVG(s.duration) AS avg_duration,
                COUNT(DISTINCT CASE WHEN ${TILE} = 'app' THEN s.visitor_id END) AS app_visitors,
                -- Per platform, for the platform tiles (platformTotals gets them from here instead of a pass of its own).
                COUNT(DISTINCT CASE WHEN ${TILE} = 'web' THEN s.visitor_id END) AS web_visitors,
                SUM(CASE WHEN ${TILE} = 'app' THEN 1 ELSE 0 END) AS app_sessions,
                SUM(CASE WHEN ${TILE} = 'app' AND s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END) AS app_bounces,
                SUM(CASE WHEN ${TILE} = 'app' THEN s.duration ELSE 0 END) AS app_duration,
                SUM(CASE WHEN ${TILE} = 'web' THEN 1 ELSE 0 END) AS web_sessions,
                SUM(CASE WHEN ${TILE} = 'web' AND s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END) AS web_bounces,
                SUM(CASE WHEN ${TILE} = 'web' THEN s.duration ELSE 0 END) AS web_duration
         FROM sessions s WHERE ${IN_SITES('s')} AND ${both('s.started_at')}${countedAllSql('s')} GROUP BY s.site_id, cur`,
      )
      .bind(range.from, ...bothBind),
    // Visitors per bucket in both periods, for `series` and `previousSeries`.
    series: db
      .prepare(
        `SELECT s.site_id, (s.started_at >= ?) AS cur, ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors
         FROM sessions s WHERE ${IN_SITES('s')} AND ${both('s.started_at')}${countedAllSql('s')} GROUP BY s.site_id, cur, b`,
      )
      .bind(range.from, ...bothBind),
    online: db
      .prepare(
        `SELECT site_id, COUNT(DISTINCT visitor_id) AS n FROM sessions
         WHERE ${IN_SITES()} AND started_at > ? AND last_seen_at > ?${countedAllSql('sessions')} GROUP BY site_id`,
      )
      .bind(now - 6 * 3_600_000, now - 5 * 60_000),
    pay: db
      .prepare(
        `SELECT p.site_id, ${payCurrency('st.currency')} AS currency, (p.ts >= ?) AS cur, ${pb} AS b,
                SUM(CASE WHEN ${rep} THEN 0 ELSE ${PAY_AMOUNT} END) AS revenue,
                SUM(CASE WHEN p.kind = 'payment' AND NOT ${rep} THEN 1 ELSE 0 END) AS payments,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS customers,
                SUM(CASE WHEN ${APPLE_PAYMENT} AND NOT ${rep} THEN ${PAY_AMOUNT} ELSE 0 END) AS apple
         FROM payments p JOIN sites st ON st.id = p.site_id
         WHERE ${IN_SITES('p')} AND ${both('p.ts')} AND ${REAL} GROUP BY p.site_id, 2, cur, b`,
      )
      .bind(range.from, ...bothBind),
    // Trials started per site and bucket in both periods, sandbox left out: the "Since yesterday" count over these periods.
    trials: db
      .prepare(
        `SELECT site_id, (trial_start >= ?) AS cur, ${tb} AS b, COUNT(*) AS n
         FROM subscriptions WHERE ${IN_SITES()} AND sandbox = 0 AND ${both('trial_start')} GROUP BY site_id, cur, b`,
      )
      .bind(range.from, ...bothBind),
  };
  const full = pulse ? {} : {
    sources: db
      .prepare(
        `SELECT s.site_id, s.source, MAX(s.referrer_domain) AS domain, MAX(s.channel) AS channel, COUNT(DISTINCT s.visitor_id) AS visitors
         FROM sessions s WHERE ${IN_SITES('s')} AND s.started_at >= ? AND s.started_at < ?${countedAllSql('s')} GROUP BY s.site_id, s.source`,
      )
      .bind(range.from, range.to),
    // A payment whose visit was deleted (RETENTION_MONTHS) counts under the source it kept (migration 0064).
    sourcePay: db
      .prepare(
        `SELECT ${KEPT_SOURCE_SQL} AS source, ${payCurrency('st.currency')} AS currency, SUM(${PAY_AMOUNT}) AS revenue,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS customers,
                MAX(s.referrer_domain) AS domain, MAX(${KEPT_CHANNEL_SQL}) AS channel, COUNT(DISTINCT p.site_id) AS sites
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id JOIN sites st ON st.id = p.site_id
         WHERE ${IN_SITES('p')} AND p.ts >= ? AND p.ts < ? AND ${REAL} AND ${KEPT_CREDIT} GROUP BY 1, 2`,
      )
      .bind(range.from, range.to),
    recent: db
      .prepare(
        `SELECT p.id, p.site_id, p.provider, p.ts, p.amount, p.amount_conv, p.kind, p.currency, p.renewal, p.product, p.visitor_id,
                ${KEPT_SOURCE_SQL} AS source, s.referrer_domain, ${KEPT_CHANNEL_SQL} AS channel, s.country, ${PLATFORM} AS platform
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE ${REAL} ORDER BY p.ts DESC LIMIT 12`,
      ),
    // Last session of any kind, and whether the site sent a web visit in the last 90 days.
    lastSeen: db
      .prepare(
        `SELECT st.id AS site_id, (SELECT MAX(started_at) FROM sessions WHERE site_id = st.id) AS last,
                EXISTS (SELECT 1 FROM sessions w WHERE w.site_id = st.id AND w.started_at > ?
                          AND ${webHostSql('w.hostname')}) AS web
         FROM sites st`,
      )
      .bind(now - 90 * 86_400_000),
    // App Store payment rows in the period: off the report's days, and credited to a visit (for "App Store, no source").
    apple: db
      .prepare(
        `SELECT p.site_id, ${payCurrency('st.currency')} AS currency, ${appleSplitColumns(rep, PAY_AMOUNT, KEPT_CREDIT)}
         FROM payments p JOIN sites st ON st.id = p.site_id LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE ${IN_SITES('p')} AND p.ts >= ? AND p.ts < ? AND ${REAL} AND ${APPLE_PAYMENT} GROUP BY p.site_id, 2`,
      )
      .bind(range.from, range.to),
    // Payments that are not App Store sales, with no linked visit and no source kept (the "No source" row).
    unlinked: db
      .prepare(
        `SELECT p.site_id, ${payCurrency('st.currency')} AS currency, SUM(${PAY_AMOUNT}) AS revenue
         FROM payments p JOIN sites st ON st.id = p.site_id LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE ${IN_SITES('p')} AND p.ts >= ? AND p.ts < ? AND ${REAL} AND NOT ${APPLE_PAYMENT} AND NOT ${KEPT_CREDIT} GROUP BY p.site_id, 2`,
      )
      .bind(range.from, range.to),
    // Visitors and revenue per site and week over the last full weeks, in one statement: no per-site queries.
    week: db
      .prepare(
        `SELECT s.site_id, ${bucketSql('s.started_at', 'week', wOffset)} AS w, NULL AS currency, COUNT(DISTINCT s.visitor_id) AS visitors, 0 AS revenue
         FROM sessions s WHERE ${IN_SITES('s')} AND s.started_at >= ? AND s.started_at < ?${countedAllSql('s')} GROUP BY 1, 2
         UNION ALL
         SELECT p.site_id, ${bucketSql('p.ts', 'week', wOffset)} AS w, ${payCurrency('st.currency')} AS currency, 0 AS visitors,
                SUM(CASE WHEN ${weekPlan!.reported} THEN 0 ELSE ${PAY_AMOUNT} END) AS revenue
         FROM payments p JOIN sites st ON st.id = p.site_id
         WHERE ${IN_SITES('p')} AND p.ts >= ? AND p.ts < ? AND ${REAL} GROUP BY 1, 2, 3`,
      )
      .bind(weeks.from, weeks.to, weeks.from, weeks.to),
  };
  const names = [...Object.keys(core), ...Object.keys(full)];
  const [results, layer, weekLayer, mrr] = await Promise.all([db.batch([...Object.values(core), ...Object.values(full)]), layerP, weekLayerP, mrrP]);
  const mrrSeries = mrr.size ? mrrSeriesP : null;
  const rowsOf = (name: string) => (results[names.indexOf(name)]?.results ?? []) as any[];

  const cur = new Map<string, SiteKpis>();
  const prev = new Map<string, SiteKpis>();
  const appVisitors = new Map<string, number>();
  const get = (m: Map<string, SiteKpis>, id: string) => {
    let k = m.get(id);
    if (!k) m.set(id, (k = emptyKpis()));
    return k;
  };

  // The platform tiles' visits: visitor ids belong to one site, so per-site distinct counts add up across sites.
  const productOnly = new Set(sites.filter((s) => s.product_type === 'extension' || s.product_type === 'newsletter').map((s) => s.id));
  const byPlatform = new Map<string, { cur: number; platform: string; visitors: number; sessions: number; bounces: number; duration: number }>();
  for (const r of rowsOf('kpi')) {
    if (productOnly.has(r.site_id)) continue;
    for (const [platform, p] of [['web', 'web'], ['app', 'app']] as const) {
      const sessions = Number(r[`${p}_sessions`] ?? 0);
      if (!sessions) continue;
      const key = `${r.cur}|${platform}`;
      const e = byPlatform.get(key) ?? { cur: r.cur, platform, visitors: 0, sessions: 0, bounces: 0, duration: 0 };
      e.visitors += Number(r[`${p}_visitors`] ?? 0);
      e.sessions += sessions;
      e.bounces += Number(r[`${p}_bounces`] ?? 0);
      e.duration += Number(r[`${p}_duration`] ?? 0);
      byPlatform.set(key, e);
    }
  }
  giveVisits([...byPlatform.values()].map((e) => ({ cur: e.cur, platform: e.platform, visitors: e.visitors, sessions: e.sessions, bounces: e.bounces, avg_duration: e.duration / e.sessions })));

  for (const r of rowsOf('kpi')) {
    const k = get(r.cur ? cur : prev, r.site_id);
    k.visitors = r.visitors;
    k.sessions = r.sessions;
    k.bounceRate = r.sessions ? r.bounces / r.sessions : 0;
    k.avgDuration = Math.round(r.avg_duration ?? 0);
    if (r.cur) appVisitors.set(r.site_id, r.app_visitors);
  }

  // Per bucket of both periods (index 0 the comparison period, 1 the period): visitors, revenue, customers, trials.
  const points = [new Map<string, SeriesPoint>(), new Map<string, SeriesPoint>()];
  const pointAt = (cur: number, b: string) => {
    const m = points[cur ? 1 : 0];
    let p = m.get(b);
    if (!p) m.set(b, (p = { bucket: b, visitors: 0, revenue: {}, customers: 0, trials: 0 }));
    return p;
  };
  const known = new Set(sites.map((s) => s.id));
  const visitorSeries = new Map<string, Map<string, number>>();
  for (const r of rowsOf('series')) {
    if (!known.has(r.site_id)) continue;
    pointAt(r.cur, r.b).visitors += r.visitors;
    if (!r.cur) continue;
    if (!visitorSeries.has(r.site_id)) visitorSeries.set(r.site_id, new Map());
    visitorSeries.get(r.site_id)!.set(r.b, r.visitors);
  }
  for (const r of rowsOf('trials')) {
    // Visitor ids and subscriptions belong to one site, so per-site counts add up; a deleted site's rows stay out.
    if (!known.has(r.site_id)) continue;
    get(r.cur ? cur : prev, r.site_id).trials += r.n;
    pointAt(r.cur, r.b).trials += r.n;
  }
  const revenueSeries = new Map<string, Map<string, Money>>();
  for (const r of rowsOf('pay')) {
    const k = get(r.cur ? cur : prev, r.site_id);
    addMoney(k.revenue, r.currency, r.revenue);
    if (r.apple) addMoney(k.appStoreRevenue, r.currency, r.apple);
    k.payments += r.payments;
    k.customers += r.customers;
    const pt = pointAt(r.cur, r.b);
    addMoney(pt.revenue, r.currency, r.revenue);
    pt.customers += r.customers;
    if (r.cur) {
      if (!revenueSeries.has(r.site_id)) revenueSeries.set(r.site_id, new Map());
      const bySite = revenueSeries.get(r.site_id)!;
      if (!bySite.has(r.b)) bySite.set(r.b, {});
      addMoney(bySite.get(r.b)!, r.currency, r.revenue);
    }
  }

  // Apple's report on the days it covers, in the site currency (amounts without a rate stay in their own).
  for (const s of sites) {
    [cur, prev].forEach((m, w) => {
      const t = layer.total(s.id, w);
      const k = get(m, s.id);
      for (const [cc, v] of [[s.currency, appleNet(t)] as const, ...Object.entries(t.other)]) {
        if (!v) continue;
        addMoney(k.revenue, cc, v);
        addMoney(k.appStoreRevenue, cc, v);
      }
      k.payments += t.units;
      for (const [day, a] of layer.byDay(s.id, w)) {
        const pt = pointAt(w === 0 ? 1 : 0, dayBucket(day, range.granularity));
        for (const [cc, v] of [[s.currency, appleNet(a)] as const, ...Object.entries(a.other)]) if (v) addMoney(pt.revenue, cc, v);
      }
    });
    for (const [day, t] of layer.byDay(s.id, 0)) {
      if (!revenueSeries.has(s.id)) revenueSeries.set(s.id, new Map());
      const bySite = revenueSeries.get(s.id)!;
      const b = dayBucket(day, range.granularity);
      if (!bySite.has(b)) bySite.set(b, {});
      for (const [cc, v] of [[s.currency, appleNet(t)] as const, ...Object.entries(t.other)]) if (v) addMoney(bySite.get(b)!, cc, v);
    }
  }

  // Per site and week: visitors, and revenue in the site currency (Apple's report on the days it covers).
  const weekly = new Map<string, Map<string, WeekPoint>>();
  const point = (siteId: string, week: string) => {
    let bySite = weekly.get(siteId);
    if (!bySite) weekly.set(siteId, (bySite = new Map()));
    let p = bySite.get(week);
    if (!p) bySite.set(week, (p = { week, visitors: 0, revenue: 0 }));
    return p;
  };
  const currencyOf = new Map(sites.map((s) => [s.id, s.currency]));
  for (const r of rowsOf('week')) {
    if (r.currency === null) point(r.site_id, r.w).visitors = r.visitors;
    else if (r.currency === currencyOf.get(r.site_id)) point(r.site_id, r.w).revenue += Number(r.revenue);
  }
  if (weekLayer) for (const s of sites) for (const [day, t] of weekLayer.byDay(s.id, 0)) point(s.id, dayBucket(day, 'week')).revenue += appleNet(t);

  const sourcesBySite = new Map<string, any[]>();
  for (const r of rowsOf('sources')) {
    if (!sourcesBySite.has(r.site_id)) sourcesBySite.set(r.site_id, []);
    sourcesBySite.get(r.site_id)!.push(r);
  }
  const online = new Map(rowsOf('online').map((r) => [r.site_id, r.n as number]));
  const lastSeen = new Map(rowsOf('lastSeen').map((r) => [r.site_id, r.last as number | null]));
  const hasWeb = new Map(rowsOf('lastSeen').map((r) => [r.site_id, !!r.web]));

  const paidIds = paidIds0 ?? new Set<string>();
  const goalBy = (await goals) ?? new Map();
  const productBy = (await products) ?? new Map();
  const siteRows = sites.map((s) => {
    const c = cur.get(s.id) ?? emptyKpis();
    const p = prev.get(s.id) ?? emptyKpis();
    const top = (sourcesBySite.get(s.id) ?? []).sort((a, b) => b.visitors - a.visitors)[0];
    const vs = visitorSeries.get(s.id);
    const rs = revenueSeries.get(s.id);
    const ws = weeks.labels.map((week) => weekly.get(s.id)?.get(week) ?? { week, visitors: 0, revenue: 0 });
    return {
      id: s.id,
      name: s.name,
      domain: s.domain,
      currency: s.currency,
      /** The site's own timezone: its dashboard counts days in it, so its totals can differ from these (viewer's tz). */
      timezone: s.timezone,
      hasApp: hasApp(s),
      bundleId: s.app_bundle_id,
      // An app with no web visits is an app-only product: its domain is a placeholder, not a website.
      kind: (hasApp(s) ? (hasWeb.get(s.id) ? 'both' : 'app') : 'web') as SiteKind,
      /** website, app, extension or newsletter (src/worker/product-type.ts). */
      type: productType(s),
      /** An extension's or a newsletter's own numbers in the period and the one before; null for the other types. */
      product: productBy.get(s.id) ?? null,
      createdAt: s.created_at,
      lastSeen: lastSeen.get(s.id) ?? null,
      online: online.get(s.id) ?? 0,
      appVisitors: appVisitors.get(s.id) ?? 0,
      /** Downloads and proceeds Apple reports for an app with no sessions in the period. Its sales are in revenue already. */
      appStore: null as AppStoreReported | null,
      current: c,
      previous: p,
      topSource: top ? { label: top.source as string, domain: top.domain as string | null, visitors: top.visitors as number } : null,
      series: labels.map((b) => ({ bucket: b, visitors: vs?.get(b) ?? 0, revenue: rs?.get(b)?.[s.currency] ?? 0 })),
      /** The last TREND_RULES.weeks full weeks, oldest first: `week` is the Monday, revenue in minor units of the site currency. */
      weekly: ws,
      /** Weekly revenue (or visitors, without revenue) falling TREND_RULES.fallingWeeks weeks in a row or more; else null. */
      falling: fallingWeeks(ws),
      /** Weeks in a row the last full weeks fell (weeksDeclining): revenue when any week had some, else visitors. */
      weeksDeclining: weeksDeclining(ws, paymentsConnected(s, paidIds.has(s.id)) ? weeklyMetric(ws) : 'visitors'),
      /** The primary goal in the period and the one before (src/worker/primary-goal.ts); null when none is picked. */
      goal: siteGoal(s, goalBy.get(s.id)?.cur ?? 0, goalBy.get(s.id)?.prev ?? 0),
      /** MRR at the end of the period and at its start, in the site's currency; null without subscription rows. */
      subscriptions: mrr.get(s.id) ?? null,
      /** False: no payment provider set up and no payment ever, so the card shows no revenue (paymentsConnected). */
      payments: paymentsConnected(s, paidIds.has(s.id)),
      /** What the revenue counts (revenueBasis): payments net of refunds, App Store at the customer price, or both. */
      basis: revenueBasis(c),
    };
  });

  // An app with no FounderDataKit sessions in the period shows its App Store downloads and proceeds as well.
  const silent = pulse ? [] : siteRows.filter((r) => r.kind === 'app' && r.current.sessions === 0);
  if (silent.length && appReported) {
    const from = appDays(range.from);
    const to = appDays(range.to - 1);
    const reported = await appReported;
    if (reported.importedDays) {
      for (const r of silent) {
        const t = reported.sites.get(r.id);
        r.appStore = {
          from,
          to,
          downloads: t?.downloads ?? 0,
          proceeds: t?.proceeds ?? [],
          proceedsConverted: t?.proceedsConverted ?? { currency: r.currency, amount: 0, notConverted: [] },
        };
      }
    }
  }

  // The verdict per site for the "Ranked by revenue change" panel (siteTrend). Plain arithmetic on the rows above.
  // An extension or a newsletter without payments is judged on its headline number (productTrend).
  const withTrend = siteRows.map((r) => ({ ...r, trend: productTrend(siteTrend(r, now), r) }));

  // Totals: visitor ids belong to one site, so per-site counts add up.
  const sum = (pick: (r: (typeof siteRows)[0]) => SiteKpis) => {
    const t = emptyKpis();
    let bounces = 0;
    let duration = 0;
    for (const r of siteRows) {
      const k = pick(r);
      t.visitors += k.visitors;
      t.sessions += k.sessions;
      t.customers += k.customers;
      t.trials += k.trials;
      t.payments += k.payments;
      bounces += k.bounceRate * k.sessions;
      duration += k.avgDuration * k.sessions;
      for (const [cc, v] of Object.entries(k.revenue)) addMoney(t.revenue, cc, v);
      for (const [cc, v] of Object.entries(k.appStoreRevenue)) addMoney(t.appStoreRevenue, cc, v);
    }
    t.bounceRate = t.sessions ? bounces / t.sessions : 0;
    t.avgDuration = t.sessions ? Math.round(duration / t.sessions) : 0;
    return t;
  };

  // Every bucket of each period, empty ones included, so both charts have no gaps and point i of one matches the other.
  const chart = (list: string[], cur: number): SeriesPoint[] => list.map((b) => points[cur].get(b) ?? { bucket: b, visitors: 0, revenue: {}, customers: 0, trials: 0 });
  const series = chart(labels, 1);
  const previousSeries = chart(beforeLabels, 0);

  const current = sum((r) => r.current);
  const totals = {
    current,
    /** What the revenue total adds up across sites (revenueBasis). */
    basis: revenueBasis(current),
    previous: sum((r) => r.previous),
    online: siteRows.reduce((n, r) => n + r.online, 0),
    // MRR per currency across the sites with subscriptions, now and at the start of the period, and the movement
    // between the two (new + expansion - churned = net = mrr - mrrStart); null with none.
    ...mrrTotals(siteRows),
    /** MRR at 12 even steps through the period, per currency, oldest first; null without subscriptions. */
    mrrSeries: mrrSeries ? seriesByCurrency(await mrrSeries, siteRows) : null,
    platforms: await platforms,
  };
  if (pulse) return { ...head, parts: 'pulse' as const, totals, series, previousSeries };

  // Where visitors and money came from, across every site.
  const bySource = new Map<string, { label: string; domain: string | null; channel: string; visitors: number; sites: number; customers: number; revenue: Money }>();
  for (const r of rowsOf('sources')) {
    const e = bySource.get(r.source) ?? { label: r.source, domain: r.domain, channel: r.channel, visitors: 0, sites: 0, customers: 0, revenue: {} };
    e.visitors += r.visitors;
    e.sites += 1;
    e.domain ??= r.domain;
    bySource.set(r.source, e);
  }
  for (const r of rowsOf('sourcePay')) {
    // A payment in the period can be credited to a visit before it: that source still gets its revenue.
    let e = bySource.get(r.source);
    if (!e) bySource.set(r.source, (e = { label: r.source, domain: r.domain, channel: r.channel, visitors: 0, sites: r.sites, customers: 0, revenue: {} }));
    addMoney(e.revenue, r.currency, r.revenue);
    e.customers += r.customers;
  }
  // The ten biggest sources, plus every other one that made money, so the revenue column adds up to the tile.
  const bySize = [...bySource.values()].sort((a, b) => b.customers - a.customers || b.visitors - a.visitors);
  const sources: HomeSource[] = bySize.filter((e, i) => i < 10 || Object.values(e.revenue).some((v) => v !== 0));
  const unlinked: Money = {};
  const unlinkedSites = new Set<string>();
  for (const r of rowsOf('unlinked')) {
    if (!Number(r.revenue)) continue;
    addMoney(unlinked, r.currency, Number(r.revenue));
    unlinkedSites.add(r.site_id);
  }
  if (unlinkedSites.size) {
    sources.push({ label: NO_SOURCE, domain: null, channel: 'No linked visit', visitors: 0, sites: unlinkedSites.size, customers: 0, revenue: unlinked, noVisit: true });
  }
  // App Store revenue that no attributed payment explains, so the panel adds up to the revenue tile.
  const appleBy = new Map<string, Map<string, { unreported: number; attributed: number }>>();
  for (const r of rowsOf('apple')) {
    if (!appleBy.has(r.site_id)) appleBy.set(r.site_id, new Map());
    appleBy.get(r.site_id)!.set(r.currency, { unreported: Number(r.unreported), attributed: Number(r.attributed) });
  }
  const noSource: Money = {};
  /** Per site, its "App Store, no source" revenue in the site currency: get_portfolio's attribution coverage. */
  const appStoreNoSource: Record<string, number> = {};
  let noSourceSites = 0;
  for (const s of sites) {
    const report = layer.total(s.id, 0);
    const reportBy: Record<string, number> = { ...report.other, [s.currency]: (report.other[s.currency] ?? 0) + appleNet(report) };
    const pays = appleBy.get(s.id) ?? new Map();
    let any = false;
    for (const cc of new Set([...Object.keys(reportBy), ...pays.keys()])) {
      const v = noSourceAmount(reportBy[cc] ?? 0, pays.get(cc)?.unreported ?? 0, pays.get(cc)?.attributed ?? 0);
      if (v) {
        addMoney(noSource, cc, v);
        if (cc === s.currency) appStoreNoSource[s.id] = v;
        any = true;
      }
    }
    if (any) noSourceSites++;
  }
  if (noSourceSites) {
    sources.push({ label: APP_STORE_NO_SOURCE, domain: null, channel: 'App Store', visitors: 0, sites: noSourceSites, customers: 0, revenue: noSource, appStore: true });
  }

  const siteName = new Map(sites.map((s) => [s.id, s]));
  const payments = rowsOf('recent').map((r) => ({
    id: r.id as string,
    siteId: r.site_id as string,
    siteName: siteName.get(r.site_id)?.name ?? '',
    siteDomain: siteName.get(r.site_id)?.domain ?? '',
    provider: r.provider as string,
    ts: r.ts as number,
    amount: r.amount as number,
    currency: r.currency as string,
    decimals: currencyDecimals(r.currency),
    /** The amount in the site's currency, when it was paid in another one and has been converted. */
    converted:
      r.amount_conv === null ? null : { amount: r.amount_conv as number, currency: siteName.get(r.site_id)!.currency, decimals: currencyDecimals(siteName.get(r.site_id)!.currency) },
    kind: r.kind as string,
    renewal: !!r.renewal,
    product: r.product as string | null,
    visitorId: r.visitor_id as string | null,
    source: r.source as string | null,
    sourceDomain: r.referrer_domain as string | null,
    channel: r.channel as string | null,
    country: r.country as string | null,
    platform: r.source ? (r.platform as 'web' | 'ios' | 'android') : null,
  }));

  return {
    ...head,
    minBase: MIN_BASE,
    trendRules: TREND_RULES,
    sites: withTrend,
    totals,
    series,
    /** The comparison period's buckets, oldest first, the same shape as `series`. */
    previousSeries,
    sources,
    /** Site id to the site's "App Store, no source" revenue, in its own currency; sites without any are left out. */
    appStoreNoSource,
    payments,
    /** The last 24 hours whatever the period, for the phone's Home; null when the caller skipped it. */
    sinceYesterday: yesterday ? await yesterday : null,
    /** The last 7 days of logged changes, whatever the period (summarizeChanges); null when the caller skipped it. */
    changes: changes ? await changes : null,
    // Payment providers that went quiet first (src/worker/silence.ts), then the sites' own items.
    // Refused webhook deliveries (budget.ts) next to them: each is a payment that was not recorded.
    attention: [
      ...refusedItems(refusedRows ?? [], sites, now),
      ...stoppedItems(stoppedRows ?? []),
      ...attention(siteRows, now, drops ?? undefined),
    ],
    /** The highest next actions across sites (pro/worker/actions.ts), for "Worth a look"; empty when the caller skipped them. */
    actions: pp?.actions ?? [],
  };
}

/** One bucket of Home's chart: visitors, revenue per currency (minor units), new customers and trials started. */
export interface SeriesPoint {
  bucket: string;
  visitors: number;
  revenue: Money;
  customers: number;
  trials: number;
}

/**
 * Yesterday from its midnight up to the time it is now, minus 24 hours: what `compare=sametime` holds today against.
 * On a day after a 23-hour day the end can fall before that midnight in the first hour; it never goes below it.
 */
export function sameTimeYesterday(todayStart: number, tz: string, now: number): { from: number; to: number } {
  const from = startOfDay(todayStart - 1, tz);
  return { from, to: Math.min(todayStart, Math.max(from, now - 86_400_000)) };
}

/**
 * Does the site take payments? A provider is set up (a webhook secret, a Gumroad ping URL, an app that can sell in-app
 * purchases), or a payment was ever recorded (the payments API needs no setup). Without either, the dashboard and
 * Home show visitors, pages and goals and no revenue tiles or columns (docs/GUIDE.md, "No payments connected").
 */
export function paymentsConnected(s: Site, hasPayments: boolean): boolean {
  return (
    hasPayments ||
    !!(s.stripe_webhook_secret || s.dodo_webhook_secret || s.revenuecat_auth || hasApp(s) || s.lemonsqueezy_secret || s.polar_secret || s.paddle_secret || s.gumroad_token || s.gumroad_seller_id)
  );
}

// revenueBasis lives in revenue.ts, so the site overview (stats.ts) uses the same rule without importing this file.
export { revenueBasis, type RevenueBasis } from './revenue';

/** The ids of the sites with at least one payment row: one index lookup per site. */
export async function sitesWithPayments(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT st.id FROM sites st WHERE EXISTS (SELECT 1 FROM payments p WHERE p.site_id = st.id)').all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

function seriesByCurrency(bySite: Map<string, number[]>, rows: { id: string; currency: string }[]): Money[] {
  const out: Money[] = Array.from({ length: 12 }, () => ({}));
  for (const r of rows) bySite.get(r.id)?.forEach((v, i) => addMoney(out[i], r.currency, v));
  return out;
}

/** MRR movement per currency: each part of MrrMovement (subscription-metrics.ts) added up across sites. */
type MoneyMovement = Record<keyof MrrMovement, Money>;

function mrrTotals(rows: { currency: string; subscriptions: { mrr: number; mrrStart: number; movement?: MrrMovement } | null }[]): {
  mrr: Money | null;
  mrrStart: Money | null;
  mrrMovement: MoneyMovement | null;
} {
  const withSubs = rows.filter((r) => r.subscriptions);
  if (!withSubs.length) return { mrr: null, mrrStart: null, mrrMovement: null };
  const mrr: Money = {}, mrrStart: Money = {};
  const mrrMovement: MoneyMovement = { new: {}, expansion: {}, churned: {}, net: {} };
  for (const r of withSubs) {
    addMoney(mrr, r.currency, r.subscriptions!.mrr);
    addMoney(mrrStart, r.currency, r.subscriptions!.mrrStart);
    const m = r.subscriptions!.movement;
    if (m) for (const k of ['new', 'expansion', 'churned', 'net'] as const) addMoney(mrrMovement[k], r.currency, m[k]);
  }
  return { mrr, mrrStart, mrrMovement };
}

// ---------- tiles per platform

/** One platform's numbers for the home tiles. On `app`, a visitor without a kept install id is a device on one day. */
export interface PlatformKpis {
  visitors: number;
  sessions: number;
  bounceRate: number;
  avgDuration: number;
  /** New customers whose first payment is credited to a session of this platform. */
  customers: number;
  conversionRate: number;
  /** App only: consented installs first seen in the period (docs/APP-API.md section 3). 0 on web. */
  newInstalls: number;
}

const emptyPlatform = (): PlatformKpis => ({ visitors: 0, sessions: 0, bounceRate: 0, avgDuration: 0, customers: 0, conversionRate: 0, newInstalls: 0 });

/**
 * Web and app visitors apart, across every site, so a bounce rate or a conversion rate never mixes the two.
 * Visitor ids belong to one site, so the counts add up per site, like the totals. A customer counts on the platform
 * of the session its payment is credited to; payments with no linked visit count in neither.
 */
/** One platform's sessions in one period, the visits part of platformTotals. */
export interface PlatformVisitRow {
  cur: number;
  platform: string;
  visitors: number;
  sessions: number;
  bounces: number;
  avg_duration: number | null;
}

/**
 * `visits`: the visits part already counted by the caller (home.ts derives it from its per-site totals, so the sessions
 * are not read a second time). Without it, one more statement reads them.
 */
export async function platformTotals(
  db: D1Database,
  range: { from: number; to: number },
  before: { from: number; to: number },
  opts: { visits?: Promise<PlatformVisitRow[]> } = {},
) {
  // Both periods in one pass, as in the totals: `cur` is 1 for the period, 0 for the one before.
  // An extension's or a newsletter's sessions are no web visits (src/worker/product-type.ts): they stay out.
  const both = (col: string) => `${IN_SITES(col.split('.')[0])} AND ${col} >= ? AND ${col} < ? AND (${col} >= ? OR ${col} < ?) AND s.site_id NOT IN (${COUNTED_SITES})`;
  const bind = [range.from, before.from, range.to, range.from, before.to];
  const visitsSql = db
    .prepare(
      `SELECT (s.started_at >= ?) AS cur, ${TILE} AS platform, COUNT(DISTINCT s.site_id || ' ' || s.visitor_id) AS visitors, COUNT(*) AS sessions,
              SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END) AS bounces, AVG(s.duration) AS avg_duration
       FROM sessions s WHERE ${both('s.started_at')}${countedAllSql('s')} GROUP BY cur, platform`,
    )
    .bind(...bind);
  const [[installs, buyers, read], given] = await Promise.all([
    db.batch([
    db
      .prepare(
        `SELECT (s.started_at >= ?) AS cur, COUNT(DISTINCT v.site_id || ' ' || v.id) AS n
         FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
         WHERE ${both('s.started_at')} AND ${appHostSql('s.hostname')} AND v.persistent = 1
           AND v.first_seen >= (CASE WHEN s.started_at >= ? THEN ? ELSE ? END) AND v.first_seen < (CASE WHEN s.started_at >= ? THEN ? ELSE ? END)
         GROUP BY cur`,
      )
      .bind(...bind, range.from, range.from, before.from, range.from, range.to, before.to),
    db
      .prepare(
        `SELECT (p.ts >= ?) AS cur, ${TILE} AS platform,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN p.site_id || ' ' || COALESCE(p.visitor_id, p.customer_id, p.id) END) AS customers
         FROM payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE ${both('p.ts')} AND ${REAL} GROUP BY cur, platform`,
      )
      .bind(...bind),
    ...(opts.visits ? [] : [visitsSql]),
    ]),
    opts.visits ?? null,
  ]);
  const visits = { results: given ?? ((read?.results ?? []) as unknown as PlatformVisitRow[]) };
  const out = { web: { current: emptyPlatform(), previous: emptyPlatform() }, app: { current: emptyPlatform(), previous: emptyPlatform() } };
  const at = (platform: string, cur: number) => out[platform === 'app' ? 'app' : 'web'][cur ? 'current' : 'previous'];
  for (const r of visits.results as any[]) {
    const k = at(r.platform, r.cur);
    k.visitors = r.visitors;
    k.sessions = r.sessions;
    k.bounceRate = r.sessions ? r.bounces / r.sessions : 0;
    k.avgDuration = Math.round(r.avg_duration ?? 0);
  }
  for (const r of installs.results as any[]) at('app', r.cur).newInstalls = r.n;
  for (const r of buyers.results as any[]) at(r.platform, r.cur).customers = r.customers;
  for (const p of [out.web, out.app]) for (const k of [p.current, p.previous]) k.conversionRate = k.visitors ? k.customers / k.visitors : 0;
  return out;
}

export type SiteKind = 'web' | 'app' | 'both';

export type TrendStatus = 'growing' | 'flat' | 'declining' | 'quiet' | 'no_payments';

/** How much revenue has to move against the period before to count as growing or declining (TREND_RULES). */
export const TREND_SHARE = TREND_RULES.revenueShare;

/**
 * One site's verdict for the period against the period before, for the home page's ranked panel. The numbers are in
 * TREND_RULES.
 *
 * - `quiet`: no visit or app session for 24 hours (the same rule as "Worth a look"), or none ever, and no revenue in
 *   the period. A site that still earns is judged on its money below, even when its tracking stopped.
 * - With revenue in either period, revenue in the site currency decides: `growing` at 10% or more above the period
 *   before (or any revenue after none), `declining` at 10% or more below, `flat` in between.
 * - With no revenue in both periods, visitors decide: 30% or more up or down, on a base of at least 50 visitors
 *   before (fewer is `flat`), so 3 visitors after 1 is not a trend.
 * - `no_payments`: no payment provider and no payment ever (paymentsConnected). Visitors still judge it, but only a
 *   decline replaces the chip: a site losing a third of its visitors is `declining` whether it takes payments or not.
 *
 * `revenueChange` is this period's revenue minus the one before, in minor units of the site currency. The panel sorts
 * on it, so the biggest gain comes first and the biggest loss last.
 */
export function siteTrend(
  r: { currency: string; kind: SiteKind; lastSeen: number | null; current: SiteKpis; previous: SiteKpis; payments: boolean },
  now: number,
): { status: TrendStatus; revenueChange: number } {
  const cur = r.current.revenue[r.currency] ?? 0;
  const prev = r.previous.revenue[r.currency] ?? 0;
  const revenueChange = cur - prev;
  const anyRevenue = Object.values(r.current.revenue).some((v) => v !== 0);
  const silent = r.lastSeen === null || now - r.lastSeen >= QUIET_HOURS * 3_600_000;
  if (silent && !anyRevenue) return { status: 'quiet', revenueChange };
  const judge = (c: number, p: number, share: number, minBase: number): TrendStatus => {
    if (p <= 0) return c > 0 && minBase === 0 ? 'growing' : 'flat';
    if (p < minBase) return 'flat';
    if (c >= p * (1 + share)) return 'growing';
    if (c <= p * (1 - share)) return 'declining';
    return 'flat';
  };
  const byVisitors = judge(r.current.visitors, r.previous.visitors, TREND_RULES.visitorShare, TREND_RULES.visitorBase);
  if (!r.payments) return { status: byVisitors === 'declining' ? 'declining' : 'no_payments', revenueChange };
  if (cur || prev) return { status: judge(cur, prev, TREND_RULES.revenueShare, 0), revenueChange };
  return { status: byVisitors, revenueChange };
}

/** One week of a site's weekly sparkline: `week` is its Monday, revenue in minor units of the site currency. */
export interface WeekPoint {
  week: string;
  visitors: number;
  revenue: number;
}

/**
 * The last TREND_RULES.weeks full weeks before the current one, Monday to Sunday in `tz`: their range and their
 * Monday labels, oldest first. A week that started before the site existed counts 0.
 */
export function weekWindow(now: number, tz: string): { from: number; to: number; labels: string[] } {
  const day = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const today = dayInTz(now, tz);
  const monday = day(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const labels = Array.from({ length: TREND_RULES.weeks }, (_, i) => day(monday, -7 * (TREND_RULES.weeks - i)));
  return { from: midnight(labels[0], tz), to: midnight(monday, tz), labels };
}

/** What the weekly verdicts read: revenue when any of the weeks had revenue, else visitors. */
export const weeklyMetric = (weekly: WeekPoint[]): 'revenue' | 'visitors' => (weekly.some((w) => w.revenue > 0) ? 'revenue' : 'visitors');

/** How many weeks in a row, up to the last full week, ended below the week before. 0 when the last week did not fall. */
export function weeksDeclining(weekly: WeekPoint[], metric: 'revenue' | 'visitors'): number {
  let n = 0;
  for (let i = weekly.length - 1; i > 0 && weekly[i][metric] < weekly[i - 1][metric]; i--) n++;
  return n;
}

/** A run of falling weeks at the end of a site's weekly series (fallingWeeks). */
export interface FallingWeeks {
  /** Revenue when any week had revenue, else visitors. */
  metric: 'revenue' | 'visitors';
  /** How many weeks in a row ended below the week before. */
  weeks: number;
  /** The Monday of the week the fall started from, and its value. */
  since: string;
  from: number;
  /** The last full week's value. */
  to: number;
}

/**
 * Weekly revenue, or visitors on a site without revenue in these weeks, that ended below the week before
 * TREND_RULES.fallingWeeks weeks in a row or more, and fell at least TREND_RULES.fallingShare from where the run
 * started. Visitors need MIN_BASE in that first week. Null otherwise.
 */
export function fallingWeeks(weekly: WeekPoint[]): FallingWeeks | null {
  const metric = weeklyMetric(weekly);
  const v = weekly.map((w) => w[metric]);
  const n = weeksDeclining(weekly, metric);
  if (n < TREND_RULES.fallingWeeks) return null;
  const start = v.length - 1 - n;
  const from = v[start];
  const to = v[v.length - 1];
  if (from <= 0 || (metric === 'visitors' && from < MIN_BASE)) return null;
  if (to > from * (1 - TREND_RULES.fallingShare)) return null;
  return { metric, weeks: n, since: weekly[start].week, from, to };
}

/** The label of the row that holds App Store revenue no attributed payment explains. */
export const APP_STORE_NO_SOURCE = 'App Store, no source';
/** The label of the row that holds payments (not App Store) with no linked visit. */
export const NO_SOURCE = 'No source';

interface HomeSource {
  label: string;
  domain: string | null;
  channel: string;
  visitors: number;
  sites: number;
  customers: number;
  revenue: Money;
  /** The App Store row: revenue from Apple's report with no visit behind it. Not a source to filter by. */
  appStore?: boolean;
  /** The "No source" row: Stripe and other payments with no linked visit. Not a source to filter by. */
  noVisit?: boolean;
}

/** Downloads and proceeds from App Store Connect over day labels `from` to `to`, amounts in major units. */
export interface AppStoreReported {
  from: string;
  to: string;
  downloads: number;
  proceeds: MoneyLine[];
  /** All proceeds in the site's currency at each day's ECB rate; what has no rate stays in notConverted. */
  proceedsConverted: ConvertedProceeds;
}

type SiteRow = {
  id: string;
  name: string;
  kind: SiteKind;
  domain: string;
  createdAt: number;
  lastSeen: number | null;
  current: SiteKpis;
  previous: SiteKpis;
  /** For the weekly item: the site currency and its falling run (fallingWeeks). Rows without them get no such item. */
  currency?: string;
  falling?: FallingWeeks | null;
};

export interface AttentionItem {
  siteId: string;
  kind: 'no_data' | 'apps_no_data' | 'quiet' | 'payments_stopped' | 'webhook_refused' | 'traffic_up' | 'traffic_down' | 'falling' | 'first_sale' | 'search_drop';
  text: string;
  /** seo: the site's SEO tab. */
  link: 'settings' | 'dashboard' | 'apps' | 'seo';
  /** A 'falling' item about revenue; keys that hide revenue skip it. */
  revenue?: boolean;
}

const fmtCount = (n: number) => new Intl.NumberFormat('en').format(n);
/** "$1,240": minor units in whole units of the currency, for "Worth a look" lines. */
function wholeMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 10 ** currencyDecimals(currency));
  } catch {
    return `${fmtCount(Math.round(minor / 100))} ${currency}`;
  }
}

const list = (names: string[]) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Things worth a look: tracking that stopped, sites that never got a visit, large traffic swings on a real base, and a
 * drop of a site's whole Google traffic (`drops`, pro/worker/search-drop.ts).
 */
export function attention(rows: SiteRow[], now: number, drops?: Map<string, SearchDrop>): AttentionItem[] {
  const out: AttentionItem[] = [];
  // Apps without any session yet are usually waiting for a release with FounderDataKit: one line for all of them.
  const silentApps = rows.filter((r) => r.lastSeen === null && r.kind === 'app');
  if (silentApps.length === 1) {
    const r = silentApps[0];
    out.push({ siteId: r.id, kind: 'apps_no_data', text: `${r.name} has not sent an app session yet. It needs a released build with FounderDataKit.`, link: 'settings' });
  } else if (silentApps.length > 1) {
    out.push({
      siteId: silentApps[0].id,
      kind: 'apps_no_data',
      text: `${silentApps.length} apps have not sent an app session yet: ${list(silentApps.map((r) => r.name))}. Each needs a released build with FounderDataKit.`,
      link: 'apps',
    });
  }
  for (const r of rows) {
    // Search Console does not depend on the tracker, so a site without visits can still show its Google drop.
    const drop = drops?.get(r.id);
    if (drop) out.push({ siteId: r.id, kind: 'search_drop', text: searchDropText(r.name, drop), link: 'seo' });
    if (r.lastSeen === null) {
      if (r.kind === 'web') out.push({ siteId: r.id, kind: 'no_data', text: `${r.name} has not received a visit yet. Check that the script is installed.`, link: 'settings' });
      continue;
    }
    const hours = Math.floor((now - r.lastSeen) / 3_600_000);
    if (hours >= QUIET_HOURS) {
      const since = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
      const what = r.kind === 'app' ? 'app sessions' : 'visits';
      const cause = r.kind === 'app' ? 'Check that the app still sends events.' : 'Check that the tracking script is still on the site.';
      out.push({ siteId: r.id, kind: 'quiet', text: `${r.name} has had no ${what} for ${since}. ${cause}`, link: 'settings' });
      // A swing on a site that stopped sending data says nothing new.
      continue;
    }
    const c = r.current.visitors;
    const p = r.previous.visitors;
    if (p >= MIN_BASE * 2 || c >= MIN_BASE * 2) {
      if (p >= MIN_BASE && c >= p * 2) {
        out.push({ siteId: r.id, kind: 'traffic_up', text: `${r.name}: ${c} visitors, up from ${p}.`, link: 'dashboard' });
      } else if (p >= MIN_BASE * 2 && c <= p / 2) {
        out.push({ siteId: r.id, kind: 'traffic_down', text: `${r.name}: ${c} visitors, down from ${p}.`, link: 'dashboard' });
      }
    }
    const f = r.falling;
    // A halved period already says the visitors fell; the weekly line adds something only for revenue then.
    if (f && !(f.metric === 'visitors' && out.some((a) => a.siteId === r.id && a.kind === 'traffic_down'))) {
      const fmt = (n: number) => (f.metric === 'revenue' ? wholeMoney(n, r.currency ?? 'USD') : fmtCount(n));
      out.push({
        siteId: r.id,
        kind: 'falling',
        revenue: f.metric === 'revenue',
        text: `${r.name}: weekly ${f.metric} fell ${f.weeks} weeks in a row, from ${fmt(f.from)} to ${fmt(f.to)}.`,
        link: 'dashboard',
      });
    }
    if (r.current.customers > 0 && r.previous.customers === 0 && Object.keys(r.previous.revenue).length === 0) {
      const n = r.current.customers;
      out.push({ siteId: r.id, kind: 'first_sale', text: `${r.name}: ${n} new ${n === 1 ? 'customer' : 'customers'}, none in the period before.`, link: 'dashboard' });
    }
  }
  const order = { no_data: 0, apps_no_data: 0, quiet: 1, payments_stopped: 1, webhook_refused: 1, search_drop: 2, traffic_down: 2, falling: 2, traffic_up: 3, first_sale: 4 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

// ---------- GET /api/v1/portfolio: every site in one answer, for an agent (docs/API.md "Portfolio")

/** `weeks_declining` and the number it counted, for the portfolio. */
function declining(weekly: WeekPoint[], showRevenue: boolean) {
  const metric = showRevenue ? weeklyMetric(weekly) : 'visitors';
  return { weeks_declining: weeksDeclining(weekly, metric), weeks_declining_metric: metric };
}

/** Attention kinds that say nothing about money, for a key without revenue. */
const VISITOR_ALERTS = new Set<AttentionItem['kind']>(['no_data', 'apps_no_data', 'quiet', 'traffic_up', 'traffic_down', 'search_drop']);

/**
 * The home page's numbers per site, in the read API's snake_case: revenue and MRR in the site's currency (minor
 * units), new customers, visitors against the period before, the top source, the trend verdict (siteTrend) and the
 * "Worth a look" items of the site. Built on `home`, so the numbers are the home page's. Totals add money per
 * currency. `showRevenue` false leaves out revenue, MRR, customers, the verdict and the money alerts.
 */
export async function portfolio(db: D1Database, q: Record<string, string | undefined>, showRevenue = true, now = Date.now()) {
  const h = await home(db, q, now, { sinceYesterday: false, changes: false });
  const sites = h.sites.map((r) => {
    const alerts = h.attention.filter((a) => a.siteId === r.id && (showRevenue || VISITOR_ALERTS.has(a.kind) || (a.kind === 'falling' && !a.revenue))).map(({ kind, text }) => ({ kind, text }));
    const visitors = {
      id: r.id,
      name: r.name,
      domain: r.domain,
      kind: r.kind,
      // website, app, extension or newsletter, and an extension's or a newsletter's numbers (src/worker/product-type.ts).
      type: r.type,
      product: r.product,
      currency: r.currency,
      currency_decimals: currencyDecimals(r.currency),
      visitors: r.current.visitors,
      visitors_previous: r.previous.visitors,
      top_source: r.topSource?.label ?? null,
      // Weeks in a row the last full weeks fell (weeksDeclining): revenue when any week had some, else visitors. A key
      // without revenue counts visitors.
      ...declining(r.weekly, showRevenue),
      // The primary goal against the period before (src/worker/primary-goal.ts); null when none is picked.
      goal: r.goal,
    };
    if (!showRevenue) return { ...visitors, alerts };
    return {
      ...visitors,
      payments_connected: r.payments,
      revenue: r.current.revenue[r.currency] ?? 0,
      revenue_previous: r.previous.revenue[r.currency] ?? 0,
      // What `revenue` adds up (revenueBasis), and its App Store part at the customer price, before Apple's cut.
      basis: r.basis,
      revenue_app_store: r.current.appStoreRevenue[r.currency] ?? 0,
      mrr: r.subscriptions?.mrr ?? null,
      mrr_previous: r.subscriptions?.mrrStart ?? null,
      new_customers: r.current.customers,
      new_customers_previous: r.previous.customers,
      status: r.trend.status,
      alerts,
    };
  });
  const t = h.totals as { current: SiteKpis; previous: SiteKpis; mrr?: Money | null; mrrStart?: Money | null };
  const totals = {
    sites: sites.length,
    visitors: t.current.visitors,
    visitors_previous: t.previous.visitors,
    ...(showRevenue
      ? {
          revenue: t.current.revenue,
          revenue_previous: t.previous.revenue,
          basis: revenueBasis(t.current),
          revenue_app_store: t.current.appStoreRevenue,
          mrr: t.mrr ?? null,
          mrr_previous: t.mrrStart ?? null,
          new_customers: t.current.customers,
          new_customers_previous: t.previous.customers,
        }
      : {}),
  };
  return {
    timezone: h.tz,
    // 'request' (?tz=), 'setting', 'sites' (all sites share it) or 'default' (UTC): src/worker/reporting.ts.
    timezone_source: h.tzSource,
    period: h.period,
    from: new Date(h.range.from).toISOString(),
    to: new Date(h.range.to).toISOString(),
    // The period before that the *_previous fields cover.
    previous_from: new Date(h.previousRange.from).toISOString(),
    previous_to: new Date(h.previousRange.to).toISOString(),
    show_revenue: showRevenue,
    sites,
    totals,
    /** Internal: each site's "App Store, no source" revenue, for withTrust's attribution coverage. Not in the answer. */
    app_store_no_source: showRevenue ? h.appStoreNoSource : {},
  };
}
