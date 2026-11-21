import type { Context } from 'hono';
import { withAsaNames } from './asa-names';
import { withMetaCampaigns } from './meta-campaigns';
import type { AppEnv, Site } from './env';
import { bucketLabels, bucketSql, dayInTz, previousRange, resolveRange, tzOffset, type Range } from './lib/time';
import { currencyDecimals, isTestProvider, REAL } from './payments';
import { proHooks } from './pro-hooks';
import { importFilter, importInfo, importInfoOf, importedSpan, importedTotals, withImported, type ImportInfoRow, type ImportedTotals } from './imports';
import { goalCounts, siteGoal } from './primary-goal';
import { countedSql } from './datacenter';
import { APPLE_PAYMENT, appStoreLayer, appStoreLayerPlan, appleNet, appleSplitColumns, dayBucket, KEPT_CREDIT, noSourceAmount, revenueBasis, type AppStoreLayer, type AscPrefetch, type LayerPlan } from './revenue';
import { appHostSql, hasApp, platformLabelSql, webHostSql } from '../shared/platform';

export { REAL };
/**
 * A payment's amount in the site's currency: payments in another currency count at their converted amount
 * (src/worker/fx.ts), and not at all until they are converted. Binds the site currency.
 */
export const AMOUNT = `CASE WHEN p.currency = ? THEN p.amount ELSE COALESCE(p.amount_conv, 0) END`;

/** App sessions have the hostname ios:<bundle id> or android:<package> (src/shared/platform.ts): iOS, Android or Web. */
const PLATFORM = platformLabelSql('s.hostname');

/** Filters that live on the session row (clicking a row in the dashboard adds one of these). */
const SESSION_FILTERS = [
  'channel',
  'source',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'country',
  'region',
  'city',
  'browser',
  'os',
  'device',
  'entry_page',
  'exit_page',
  'hostname',
  'app_version',
  'language',
  'click_network',
] as const;

/** Every filter key parseFilters keeps, besides `prop:<key>`. */
export const FILTER_KEYS: readonly string[] = [...SESSION_FILTERS, 'page', 'goal', 'platform'];

/** A session property filter: `prop:<key>` (sessions.props, FounderDataKit API v2). */
export const PROP_FILTER = /^prop:([a-z0-9_]{1,40})$/;

export type Filters = Partial<Record<(typeof SESSION_FILTERS)[number] | 'page' | 'goal' | 'platform', string>> & {
  [prop: `prop:${string}`]: string | undefined;
};

export function parseFilters(raw: string | undefined): Filters {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out: Filters = {};
    for (const k of [...SESSION_FILTERS, 'page', 'goal', 'platform'] as const) {
      if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 500);
    }
    let props = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (PROP_FILTER.test(k) && typeof v === 'string' && props++ < 10) out[k as `prop:${string}`] = v.slice(0, 100);
    }
    return out;
  } catch {
    return {};
  }
}

/** Session filters a payment keeps a copy of (payments.channel, source, campaign; migration 0064). */
const KEPT_FILTER: Partial<Record<(typeof SESSION_FILTERS)[number], 'channel' | 'source' | 'campaign'>> = {
  channel: 'channel',
  source: 'source',
  utm_campaign: 'campaign',
};

/**
 * SQL + params restricting sessions `s` by the dashboard filters (not by time). With `keptSource`, `s` is LEFT JOINed
 * to payments `p`: a payment whose visit was deleted matches a channel, source or campaign filter by the copy it kept,
 * and no other filter, since nothing else about the visit is left.
 */
export function filterSql(f: Filters, keptSource = false): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const k of SESSION_FILTERS) {
    const v = f[k];
    if (v === undefined) continue;
    const kept = keptSource ? KEPT_FILTER[k] : undefined;
    const col = kept ? `(CASE WHEN s.id IS NULL THEN p.${kept} ELSE s.${k} END)` : `s.${k}`;
    if (v === '') parts.push(`${col} IS NULL`);
    else {
      parts.push(`${col} = ?`);
      params.push(v);
    }
    if (keptSource && !kept) parts.push('s.id IS NOT NULL');
  }
  for (const [k, v] of Object.entries(f)) {
    const key = PROP_FILTER.exec(k)?.[1];
    if (!key || v === undefined) continue;
    params.push('$.' + key);
    if (v === '') parts.push(`json_extract(s.props, ?) IS NULL`);
    else {
      parts.push(`json_extract(s.props, ?) = ?`);
      params.push(v);
    }
  }
  if (f.platform === 'App') {
    // Either app: iOS or Android.
    parts.push(appHostSql('s.hostname'));
  } else if (f.platform) {
    parts.push(`${PLATFORM} = ?`);
    params.push(f.platform);
  }
  if (f.page) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'pageview' AND fe.path = ?)`);
    params.push(f.page);
  }
  if (f.goal) {
    parts.push(`EXISTS (SELECT 1 FROM events fe WHERE fe.site_id = s.site_id AND fe.session_id = s.id AND fe.type = 'goal' AND fe.name = ?)`);
    params.push(f.goal);
  }
  // Property and platform filters need the visit too (page and goal filters already do: their EXISTS finds no event).
  if (keptSource && (f.platform || Object.keys(f).some((k) => PROP_FILTER.test(k)))) parts.push('s.id IS NOT NULL');
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

export const hasFilters = (f: Filters) => Object.keys(f).length > 0;

export interface Ctx {
  db: D1Database;
  site: Site;
  range: Range;
  filters: Filters;
  offset: number;
  /** The dashboard period the range came from, for the comparison period. */
  period?: string;
  /** Leave imported history out (src/worker/imports.ts): for numbers that sit next to native revenue and customers. */
  skipImported?: boolean;
  /** Apple's report rows read ahead (revenue.ts ascPrefetch); the layer then reads no report of its own. */
  ascPrefetch?: AscPrefetch | null;
  /** The site's import row read ahead (imports.ts importRow), so the overview does not wait for it. */
  importRow?: Promise<ImportInfoRow | null> | null;
  /** Payments being converted before this read (fx.ts convertPayments); the revenue reads wait for it. */
  converting?: Promise<unknown> | null;
  /**
   * Attribution model of the source breakdowns (FIRST_TOUCH_DIMS): `last` (the default) credits the visit before the
   * payment, `first` the visitor's first visit (visitors.first_*, migration 0065).
   */
  model?: 'first' | 'last';
}

/** The model a request asks for: `first`, or `last` for anything else. */
export const modelOf = (raw: string | undefined): 'first' | 'last' => (raw === 'first' ? 'first' : 'last');

export function makeCtx(c: Context<AppEnv>): Ctx {
  const site = c.get('site');
  const q = c.req.query();
  const current = resolveRange(q, site.timezone, site.created_at);
  // compare=previous answers for the period the Overview compares with, so a panel can show its own change.
  const range = q.compare === 'previous' ? { ...previousRange(current, q.period, site.timezone), granularity: current.granularity } : current;
  return { db: c.env.DB, site, range, filters: parseFilters(q.filters), offset: tzOffset(site.timezone, range.to), period: q.period, model: modelOf(q.model) };
}

/** Sessions `s` of the site in the range that match the filters. Visits from hosting networks stay out unless the site shows them. */
export function sessionsWhere(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  const f = filterSql(ctx.filters);
  return {
    sql: `s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${countedSql(ctx.site.show_datacenter)}${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

/**
 * Payments in the period; with filters, only those credited to a matching visit. A payment whose visit was deleted
 * still matches a channel, source or campaign filter by the copy it kept (filterSql keptSource): `s` is then NULL.
 */
function paymentsFrom(ctx: Ctx, from = ctx.range.from, to = ctx.range.to) {
  if (!hasFilters(ctx.filters)) {
    return { sql: `payments p WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND ${REAL}`, params: [ctx.site.id, from, to] };
  }
  const f = filterSql(ctx.filters, true);
  return {
    sql: `payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
          WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND ${REAL} AND ${KEPT_CREDIT}${f.sql}`,
    params: [ctx.site.id, from, to, ...f.params],
  };
}

const KPI_SQL = (where: string) => `
  SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
         COALESCE(SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END), 0) AS bounces,
         COALESCE(AVG(s.duration), 0) AS avg_duration
  FROM sessions s WHERE ${where}`;

/** `reported` (src/worker/revenue.ts) marks App Store payment rows that Apple's report replaces: no revenue, no purchase. */
const REVENUE_SQL = (from: string, reported = '0') => `
  SELECT COALESCE(SUM(CASE WHEN ${reported} THEN 0 ELSE ${AMOUNT} END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN ${APPLE_PAYMENT} AND NOT ${reported} THEN ${AMOUNT} ELSE 0 END), 0) AS apple,
         COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS customers,
         COALESCE(SUM(CASE WHEN p.kind = 'payment' AND NOT ${reported} THEN 1 ELSE 0 END), 0) AS payments
  FROM ${from}`;

/**
 * Apple's report for the site over the given windows (src/worker/revenue.ts). With a filter, revenue is what payments
 * credited to matching visits brought in, so the report (which has no visits) stays out and this returns null.
 */
async function siteLayer(ctx: Ctx, windows: { from: number; to: number }[]): Promise<AppStoreLayer | null> {
  if (hasFilters(ctx.filters) || !ctx.site.asc_app_id) return null;
  return appStoreLayer(ctx.db, [ctx.site], ctx.site.timezone, windows, { prefetch: ctx.ascPrefetch });
}

/** The layer as a plan (revenue.ts appStoreLayerPlan): `reported` without waiting for the rate lookup. */
async function siteLayerPlan(ctx: Ctx, windows: { from: number; to: number }[]): Promise<LayerPlan | null> {
  if (hasFilters(ctx.filters) || !ctx.site.asc_app_id) return null;
  return appStoreLayerPlan(ctx.db, [ctx.site], ctx.site.timezone, windows, { prefetch: ctx.ascPrefetch });
}

interface KpiRow {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  avg_duration: number;
}
interface RevRow {
  revenue: number;
  /** App Store payment rows on the days Apple's report does not cover. */
  apple?: number;
  customers: number;
  payments: number;
}

/**
 * Consented installs (visitors.persistent, docs/APP-API.md section 3) with an app session in the window that matches
 * the filters: `installs` all of them, `new_installs` those first seen in the window. Without consent the server knows a
 * device for one day only (app.ts, resolveLaunch), so those visitors cannot count as installs. Binds the window twice, then the session params.
 */
const INSTALLS_SQL = (where: string) => `
  SELECT COUNT(DISTINCT CASE WHEN v.first_seen >= ? AND v.first_seen < ? THEN v.id END) AS new_installs, COUNT(DISTINCT v.id) AS installs
  FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id
  WHERE ${where} AND ${appHostSql('s.hostname')} AND v.persistent = 1`;

interface InstallsRow {
  new_installs: number;
  installs: number;
}

function kpis(k: KpiRow, r: RevRow, apple?: { net: number; units: number }, inst?: InstallsRow) {
  if (apple) r = { ...r, revenue: r.revenue + apple.net, payments: r.payments + apple.units };
  return {
    // Sites with an app only: consented installs first seen in the range, and all consented installs in it.
    ...(inst ? { newInstalls: Number(inst.new_installs ?? 0), consentedInstalls: Number(inst.installs ?? 0) } : {}),
    visitors: k.visitors,
    sessions: k.sessions,
    pageviews: k.pageviews,
    bounceRate: k.sessions ? k.bounces / k.sessions : 0,
    avgDuration: Math.round(k.avg_duration),
    revenue: r.revenue,
    payments: r.payments,
    customers: r.customers,
    conversionRate: k.visitors ? r.customers / k.visitors : 0,
    revenuePerVisitor: k.visitors ? r.revenue / k.visitors : 0,
  };
}

/** Native numbers plus imported days. Only the traffic numbers change; conversion and revenue per visitor stay native. */
function withImp<T extends { visitors: number; sessions: number; pageviews: number; bounceRate: number; avgDuration: number }>(cur: T, k: KpiRow, t: ImportedTotals | null): T {
  if (!t || !t.days.length) return cur;
  const sessions = k.sessions + t.sessions;
  // Days from a source with no bounce or duration data (DataFast) stay out of those two rates.
  const rated = k.sessions + t.rateSessions;
  return {
    ...cur,
    visitors: k.visitors + t.visitors,
    sessions,
    pageviews: k.pageviews + t.pageviews,
    bounceRate: rated ? (k.bounces + t.bounces) / rated : 0,
    avgDuration: rated ? Math.round((k.avg_duration * k.sessions + t.duration) / rated) : 0,
  };
}

/** Top numbers + chart. */
export async function overview(ctx: Ctx) {
  const { db, range, site } = ctx;
  const before = previousRange(range, ctx.period, site.timezone);
  const cur = sessionsWhere(ctx);
  const prev = sessionsWhere(ctx, before.from, before.to);
  const curPay = paymentsFrom(ctx);
  const prevPay = paymentsFrom(ctx, before.from, before.to);
  const sb = bucketSql('s.started_at', range.granularity, ctx.offset);
  const pb = bucketSql('p.ts', range.granularity, ctx.offset);
  const now = Date.now();
  // The primary goal (src/worker/primary-goal.ts), the same count as Home's site row; no query without one.
  const goal =
    site.primary_goal && !hasFilters(ctx.filters)
      ? goalCounts(db, [site], range, before).then((m) => siteGoal(site, m.get(site.id)?.cur ?? 0, m.get(site.id)?.prev ?? 0))
      : Promise.resolve(null);
  // Imported history (src/worker/imports.ts): days before the first native visit, never with a filter on.
  // A filter on one dimension is answered from that panel's imported label (importFilter); any other filter shows no imported day.
  // Started before the App Store layer below, which it does not need.
  const impFilter = importFilter(ctx.filters);
  const impInfo =
    (hasFilters(ctx.filters) && !impFilter) || ctx.skipImported
      ? Promise.resolve(null)
      : ctx.importRow
        ? ctx.importRow.then((row) => importInfoOf(row, site))
        : importInfo(db, site);
  // The imported totals start as soon as the import info is in: with importRow at the same time as the batch below.
  const impTotals = impInfo.then((imp) => {
    const impCur = imp ? importedSpan(imp, site, range) : null;
    const impPrev = imp ? importedSpan(imp, site, before) : null;
    return Promise.all([
      impCur ? importedTotals(db, site, impCur, impFilter) : Promise.resolve(null),
      impPrev ? importedTotals(db, site, impPrev, impFilter) : Promise.resolve(null),
    ]);
  });
  // The App Store layer's report days give `rep` at once with ascPrefetch; its amounts may still wait on rates.
  const plan = await siteLayerPlan(ctx, [range, before]);
  const rep = plan?.reported ?? '0';
  const layerP = plan ? plan.layer() : Promise.resolve(null);
  // Payments the route is converting must be in before the revenue reads (index.ts overviewPrefetch).
  if (ctx.converting) await ctx.converting;

  // New installs only for a site with an app, so a website's overview reads its sessions no more often than before.
  const installs = hasApp(site)
    ? [
        db.prepare(INSTALLS_SQL(cur.sql)).bind(range.from, range.to, ...cur.params),
        db.prepare(INSTALLS_SQL(prev.sql)).bind(before.from, before.to, ...prev.params),
      ]
    : [];
  const [[k1, k0, r1, r0, online, ts, tr, web, i1, i0], imp, [iCur, iPrev], layer] = await Promise.all([db.batch([
    db.prepare(KPI_SQL(cur.sql)).bind(...cur.params),
    db.prepare(KPI_SQL(prev.sql)).bind(...prev.params),
    db.prepare(REVENUE_SQL(curPay.sql, rep)).bind(site.currency, site.currency, ...curPay.params),
    db.prepare(REVENUE_SQL(prevPay.sql, rep)).bind(site.currency, site.currency, ...prevPay.params),
    db
      .prepare(`SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND last_seen_at > ?${countedSql(site.show_datacenter, 'sessions')}`)
      .bind(site.id, now - 6 * 3_600_000, now - 5 * 60_000),
    db
      .prepare(
        `SELECT ${sb} AS b, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews
         FROM sessions s WHERE ${cur.sql} GROUP BY b`,
      )
      .bind(...cur.params),
    db
      .prepare(
        `SELECT ${pb} AS b, SUM(CASE WHEN ${rep} THEN 0 ELSE ${AMOUNT} END) AS revenue,
                SUM(CASE WHEN p.kind = 'payment' AND NOT ${rep} THEN 1 ELSE 0 END) AS payments
         FROM ${curPay.sql} GROUP BY b`,
      )
      .bind(site.currency, ...curPay.params),
    // Whether the site sent a web visit in the last 90 days, whatever the filters (the home page asks the same), and
    // when its last visit or app session started, for the "Quiet since" line.
    db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM sessions WHERE site_id = ? AND started_at > ?
                          AND ${webHostSql('hostname')}) AS web,
                (SELECT MAX(started_at) FROM sessions WHERE site_id = ?) AS last`,
      )
      .bind(site.id, now - 90 * 86_400_000, site.id),
    ...installs,
  ]), impInfo, impTotals, layerP]);
  const impCur = imp ? importedSpan(imp, site, range) : null;
  const impPrev = imp ? importedSpan(imp, site, before) : null;

  const visitorsBy = new Map((ts.results as any[]).map((r) => [r.b, r]));
  const revenueBy = new Map((tr.results as any[]).map((r) => [r.b, { revenue: Number(r.revenue ?? 0), payments: Number(r.payments ?? 0) }]));
  // Apple's report, day by day, into the chart's buckets. Amounts without an ECB rate stay out, like payments.
  for (const [day, a] of layer?.byDay(site.id, 0) ?? []) {
    const b = dayBucket(day, range.granularity);
    const e = revenueBy.get(b) ?? { revenue: 0, payments: 0 };
    e.revenue += appleNet(a);
    e.payments += a.units;
    revenueBy.set(b, e);
  }
  const labels = bucketLabels(range, ctx.offset);
  // Imported days by chart bucket; a bucket that holds one is marked `imported`.
  const importedBy = new Map<string, { visitors: number; pageviews: number }>();
  for (const d of iCur?.days ?? []) {
    const b = dayBucket(d.day, range.granularity);
    const e = importedBy.get(b) ?? { visitors: 0, pageviews: 0 };
    e.visitors += d.visitors;
    e.pageviews += d.pageviews;
    importedBy.set(b, e);
  }
  // Imported revenue (DataFast) by chart bucket. It never joins `revenue`; the chart's "Include imported history" adds the two.
  const importedRevBy = new Map<string, number>();
  for (const d of iCur?.revenueDays ?? []) {
    const b = dayBucket(d.day, range.granularity);
    importedRevBy.set(b, (importedRevBy.get(b) ?? 0) + d.revenue);
  }
  // The seam: the first day with native data, when the range has imported days before it and reaches it.
  const seamDay = iCur?.days.length && imp?.firstNative && imp.firstNative > iCur.days[iCur.days.length - 1].day && imp.firstNative <= dayInTz(range.to - 1, site.timezone) ? imp.firstNative : null;
  const series = labels.map((b) => ({
    bucket: b,
    visitors: (visitorsBy.get(b)?.visitors ?? 0) + (importedBy.get(b)?.visitors ?? 0),
    pageviews: (visitorsBy.get(b)?.pageviews ?? 0) + (importedBy.get(b)?.pageviews ?? 0),
    revenue: revenueBy.get(b)?.revenue ?? 0,
    payments: revenueBy.get(b)?.payments ?? 0,
    ...(importedBy.has(b) ? { imported: true } : {}),
    ...(importedRevBy.get(b) ? { imported_revenue: importedRevBy.get(b)! } : {}),
  }));
  const apple = (w: number) => {
    if (!layer) return undefined;
    const t = layer.total(site.id, w);
    return { net: appleNet(t), units: t.units };
  };

  const webRow = web.results[0] as { web: number; last: number | null } | undefined;
  const hasWeb = !!webRow?.web;
  // `appStoreRevenue`: the App Store part of the revenue, Apple's report on the days it covers and App Store payment
  // rows on the others.
  const withApple = (k: KpiRow, r: RevRow, w: number, inst?: InstallsRow) => ({
    ...kpis(k, r, apple(w), inst),
    appStoreRevenue: (apple(w)?.net ?? 0) + Number(r.apple ?? 0),
  });
  const current = withImp(withApple(k1.results[0] as KpiRow, r1.results[0] as RevRow, 0, i1?.results[0] as InstallsRow | undefined), k1.results[0] as KpiRow, iCur);
  const last = webRow?.last ?? null;
  return {
    range,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    /** web, app (a bundle id and no web visit in 90 days) or both, like the home page. */
    kind: (hasApp(site) ? (hasWeb ? 'both' : 'app') : 'web') as 'web' | 'app' | 'both',
    current,
    previous: withImp(withApple(k0.results[0] as KpiRow, r0.results[0] as RevRow, 1, i0?.results[0] as InstallsRow | undefined), k0.results[0] as KpiRow, iPrev),
    /**
     * Imported days (src/worker/imports.ts) that are in `current` and in the chart: the first and last day and how
     * many, or null. They add to visitors, sessions, pageviews, bounce rate and duration only. Revenue, customers,
     * conversion rate and revenue per visitor stay native; imported revenue is `imported.revenue` and, per bucket,
     * `series[].imported_revenue`.
     */
    imported: iCur?.days.length
      ? {
          from: iCur.days[0].day,
          to: iCur.days[iCur.days.length - 1].day,
          days: iCur.days.length,
          // Revenue the other tool reported for these days (DataFast), never added to the revenue above.
          ...(iCur.revenue || iCur.payments ? { revenue: iCur.revenue, payments: iCur.payments } : {}),
          // The first day with native data, and the chart bucket that holds it: where "Include imported history" draws the seam. Null when the range ends before it.
          native_from: seamDay,
          seam_bucket: seamDay ? dayBucket(seamDay, range.granularity) : null,
        }
      : null,
    /** What `current.revenue` adds up, as `basis` on Home and GET /api/v1/portfolio (revenueBasis in revenue.ts). */
    basis: revenueBasis({ revenue: { [site.currency]: current.revenue }, appStoreRevenue: { [site.currency]: current.appStoreRevenue } }),
    online: (online.results[0] as { n: number }).n,
    /** When the last visit or app session started, whatever the period and filters; null before the first one. */
    lastVisitAt: last === null ? null : Number(last),
    /** The primary goal over the period against the one before, as on Home; null without one or with a filter on. */
    goal: await goal,
    series,
  };
}

/** Session dimensions, keyed by the name the dashboard asks for. */
export const SESSION_DIMS: Record<string, string> = {
  channel: 's.channel',
  source: 's.source',
  campaign: 's.utm_campaign',
  keyword: 's.utm_term',
  utm_source: 's.utm_source',
  utm_medium: 's.utm_medium',
  utm_content: 's.utm_content',
  ref: 's.ref',
  country: 's.country',
  region: 's.region',
  city: 's.city',
  browser: 's.browser',
  os: 's.os',
  device: 's.device',
  entry_page: 's.entry_page',
  exit_page: 's.exit_page',
  hostname: 's.hostname',
  referrer: 's.referrer',
  platform: PLATFORM,
  app_version: 's.app_version',
  language: 's.language',
  click_network: 's.click_network',
  referrer_domain: 's.referrer_domain',
};

/** Breakdown dimensions a payment keeps a copy of (payments.channel, source, campaign), for when its visit is gone. */
export const KEPT_SOURCE: Record<string, 'channel' | 'source' | 'campaign'> = { channel: 'channel', source: 'source', campaign: 'campaign' };

/**
 * Source dimensions that also answer by first touch (Ctx.model `first`): the visitor's first visit, from the visitor
 * row. A visitor first seen before migration 0065 has no first touch; the visit itself stands in.
 */
export const FIRST_TOUCH_DIMS: Record<string, string> = {
  channel: 'COALESCE(v.first_channel, s.channel)',
  source: 'COALESCE(v.first_source, s.source)',
  campaign: 'CASE WHEN v.first_channel IS NOT NULL THEN v.first_campaign ELSE s.utm_campaign END',
  referrer_domain: 'CASE WHEN v.first_channel IS NOT NULL THEN v.first_referrer ELSE s.referrer_domain END',
  entry_page: 'COALESCE(v.first_entry_page, s.entry_page)',
};
export const FIRST_TOUCH_DIM_NAMES = Object.keys(FIRST_TOUCH_DIMS);

/**
 * "Customers" means new customers everywhere (overview, breakdowns, the home page): distinct visitors with a payment
 * in the period that is not a renewal. The overview and the session breakdowns count a payment with no visitor as
 * its own customer. Renewals add revenue, never customers. This is the page and goal breakdowns' version, which
 * joins payments by visitor.
 */
const NEW_CUSTOMERS = `COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN p.visitor_id END)`;

export interface BreakdownRow {
  label: string | null;
  /** The Apple Search Ads name of a campaign, keyword or ad group id (src/worker/asa-names.ts); `label` stays the id. */
  name?: string | null;
  /** A campaign of the site's Meta ad account, by name or id (src/worker/meta-campaigns.ts): the row menu opens Meta ads. */
  meta?: boolean;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  icon?: string | null;
  extra?: string | null;
  /** The App Store row: revenue from Apple's report that no attributed payment explains. Not a value to filter by. */
  appStore?: boolean;
  /** The "No source" row: Stripe and other payments (not App Store) with no linked visit. Not a value to filter by. */
  noVisit?: boolean;
  /** Revenue and payments an import (DataFast) reports for this source over the imported days. Not part of `revenue`. */
  importedRevenue?: number;
  importedPayments?: number;
  /** The `x_post` dimension (pro/worker/x-posts.ts): the post, and how its visits were matched. `unmatched` is the "X, no matching post" row. */
  x?: {
    text: string | null;
    url: string | null;
    posted_at: string | null;
    exact: number;
    probable: number;
    /** Customers and revenue split the same way as the visits: by t.co code (exact) or by landing page (probable). */
    exact_customers: number;
    probable_customers: number;
    exact_revenue: number;
    probable_revenue: number;
    goals: number;
    manual: boolean;
    unmatched?: boolean;
    /** Visits from X the report read, and whether the 20,000-visit cap cut older ones (and the payments of their sessions). */
    visits_considered?: number;
    truncated?: boolean;
  };
}

/**
 * Panels that say where revenue came from get two more rows, so they add up to the Revenue tile: "No source" for
 * payments with no linked visit, and "App Store, no source" for App Store revenue no linked payment explains.
 */
export const ATTRIBUTION_DIMS = new Set(['channel', 'source', 'campaign', 'keyword', 'utm_source', 'utm_medium', 'utm_content', 'ref', 'referrer', 'referrer_domain', 'click_network']);
export const APP_STORE_NO_SOURCE = 'App Store, no source';
export const NO_SOURCE = 'No source';

/**
 * Revenue no visit explains, in the site currency, without filters (0 with them):
 * - `payments`: payments that are not App Store sales and have no linked visit (Stripe, Dodo, the payments API,
 *   RevenueCat outside the App Store), or, with `keptSource`, no source kept from a visit that was deleted
 * - `appStore`: App Store revenue in the range that no attributed payment explains (src/worker/revenue.ts,
 *   noSourceAmount); 0 for a site without an app in App Store Connect, or when payments explain it all.
 */
export async function unlinkedRevenue(ctx: Ctx, keptSource = false): Promise<{ payments: number; customers: number; appStore: number }> {
  if (hasFilters(ctx.filters)) return { payments: 0, customers: 0, appStore: 0 };
  const layer = await siteLayer(ctx, [ctx.range]);
  const rep = layer?.reported ?? '0';
  // With `keptSource` (channel, source, campaign), a payment whose visit was deleted counts under the source it kept.
  const none = keptSource ? `NOT ${KEPT_CREDIT}` : 's.id IS NULL';
  const row = await ctx.db
    .prepare(
      `SELECT ${appleSplitColumns(`(${APPLE_PAYMENT} AND ${rep})`, `CASE WHEN ${APPLE_PAYMENT} THEN ${AMOUNT} ELSE 0 END`, keptSource ? KEPT_CREDIT : undefined)},
              COALESCE(SUM(CASE WHEN NOT ${APPLE_PAYMENT} AND ${none} THEN ${AMOUNT} ELSE 0 END), 0) AS other,
              COUNT(DISTINCT CASE WHEN NOT ${APPLE_PAYMENT} AND ${none} AND p.kind = 'payment' AND p.renewal = 0
                                  THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS other_customers
       FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND ${REAL}`,
    )
    .bind(ctx.site.currency, ctx.site.currency, ctx.site.currency, ctx.site.id, ctx.range.from, ctx.range.to)
    .first<{ unreported: number; attributed: number; other: number; other_customers: number }>();
  const report = layer ? appleNet(layer.total(ctx.site.id, 0)) : 0;
  return {
    payments: Number(row?.other ?? 0),
    customers: Number(row?.other_customers ?? 0),
    appStore: noSourceAmount(report, Number(row?.unreported ?? 0), Number(row?.attributed ?? 0)),
  };
}

/** One provider's line of attributionCoverage(). Amounts in the site currency, minor units. */
export interface ProviderCoverage {
  provider: string;
  payments: number;
  linked: number;
  amount: number;
  linkedAmount: number;
  /** Why the others are not linked, each payment counted once, in this order. */
  notLinked: {
    /** Paid before the site's first stored visit: imported history, or before the script or SDK was installed. */
    beforeTracking: number;
    /** Renewals: they link through the first payment of the same customer, which is not linked either. */
    renewals: number;
    /** The payment has the buyer's email, but no visitor was identify()'d with it. */
    withEmail: number;
    /** Nothing to link with: no visitor ids in the checkout metadata (or the app's purchase token). */
    noIds: number;
  };
}

/**
 * The agent form of attributionCoverage (docs/API.md "Attribution coverage"): how much of the revenue a source can
 * explain, in minor units of the site currency. `appStoreNoSource` is the "App Store, no source" row's revenue, which
 * has no payment rows. Exported for get_breakdown and get_portfolio.
 */
export function coverageOut(cov: { payments: number; linked: number; amount: number; linkedAmount: number; providers: ProviderCoverage[] }, appStoreNoSource = 0) {
  const sum = (k: keyof ProviderCoverage['notLinked']) => cov.providers.reduce((t, p) => t + p.notLinked[k], 0);
  const base = cov.amount + appStoreNoSource;
  return {
    payments: cov.payments,
    linked_payments: cov.linked,
    linked_share: cov.payments ? Number((cov.linked / cov.payments).toFixed(4)) : null,
    amount: cov.amount,
    linked_amount: cov.linkedAmount,
    app_store_no_source: appStoreNoSource,
    attributed_share: base ? Number((cov.linkedAmount / base).toFixed(4)) : null,
    not_linked: { before_tracking: sum('beforeTracking'), renewals: sum('renewals'), with_email: sum('withEmail'), no_ids: sum('noIds') },
  };
}

/**
 * How many payments in the range are linked to a visit, in total and per provider: the line under the overview's
 * tiles and each provider's status in Settings. Payments only (no refunds, other revenue or sandbox purchases), whole
 * site, whatever the filters. Linked means credited to a stored session, the same rule as the "No source" row.
 * Revenue from Apple's sales report has no payment rows, so it is not in here.
 */
export async function attributionCoverage(ctx: Ctx) {
  const { db, site, range } = ctx;
  const rows = await db
    .prepare(
      `SELECT p.provider, COUNT(*) AS payments, SUM(s.id IS NOT NULL) AS linked,
              COALESCE(SUM(${AMOUNT}), 0) AS amount,
              COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN ${AMOUNT} ELSE 0 END), 0) AS linked_amount,
              SUM(s.id IS NULL AND p.ts < ft.t) AS before_tracking,
              SUM(s.id IS NULL AND p.ts >= ft.t AND p.renewal = 1) AS renewals,
              SUM(s.id IS NULL AND p.ts >= ft.t AND p.renewal = 0 AND p.email IS NOT NULL) AS with_email
       FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         CROSS JOIN (SELECT COALESCE(MIN(started_at), 9e15) AS t FROM sessions WHERE site_id = ?) ft
       WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND p.kind = 'payment' AND ${REAL}
       GROUP BY p.provider ORDER BY payments DESC, p.provider`,
    )
    .bind(site.currency, site.currency, site.id, site.id, range.from, range.to)
    .all<{ provider: string; payments: number; linked: number; amount: number; linked_amount: number; before_tracking: number; renewals: number; with_email: number }>();
  const providers: ProviderCoverage[] = rows.results.map((r) => {
    const n = (v: unknown) => Number(v ?? 0);
    const notLinked = n(r.payments) - n(r.linked);
    const before = n(r.before_tracking), renewals = n(r.renewals), withEmail = n(r.with_email);
    return {
      provider: r.provider,
      payments: n(r.payments),
      linked: n(r.linked),
      amount: n(r.amount),
      linkedAmount: n(r.linked_amount),
      notLinked: { beforeTracking: before, renewals, withEmail, noIds: notLinked - before - renewals - withEmail },
    };
  });
  const sum = (k: 'payments' | 'linked' | 'amount' | 'linkedAmount') => providers.reduce((t, p) => t + p[k], 0);
  return {
    from: range.from,
    to: range.to,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
    payments: sum('payments'),
    linked: sum('linked'),
    amount: sum('amount'),
    linkedAmount: sum('linkedAmount'),
    providers,
  };
}

/** attributionCoverage for many sites in one statement (get_portfolio), each amount in its own site's currency. */
export async function coverageBySite(db: D1Database, siteIds: string[], from: number, to: number) {
  const out = new Map<string, { payments: number; linked: number; amount: number; linkedAmount: number; providers: ProviderCoverage[] }>();
  if (!siteIds.length) return out;
  const amount = `CASE WHEN p.currency = ft.currency THEN p.amount ELSE COALESCE(p.amount_conv, 0) END`;
  const { results } = await db
    .prepare(
      `WITH ft AS (SELECT st.id AS site_id, st.currency, COALESCE((SELECT started_at FROM sessions WHERE site_id = st.id ORDER BY started_at LIMIT 1), 9e15) AS t
                  FROM sites st WHERE st.id IN (SELECT value FROM json_each(?1)))
       SELECT p.site_id, p.provider, SUM(p.kind = 'payment') AS payments, SUM(p.kind = 'payment' AND s.id IS NOT NULL) AS linked,
              COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN ${amount} END), 0) AS amount,
              COALESCE(SUM(CASE WHEN p.kind = 'payment' AND s.id IS NOT NULL THEN ${amount} END), 0) AS linked_amount,
              SUM(p.kind = 'payment' AND s.id IS NULL AND p.ts < ft.t) AS before_tracking,
              SUM(p.kind = 'payment' AND s.id IS NULL AND p.ts >= ft.t AND p.renewal = 1) AS renewals,
              SUM(p.kind = 'payment' AND s.id IS NULL AND p.ts >= ft.t AND p.renewal = 0 AND p.email IS NOT NULL) AS with_email
       FROM payments p JOIN ft ON ft.site_id = p.site_id LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.site_id IN (SELECT value FROM json_each(?1)) AND p.ts >= ?2 AND p.ts < ?3 AND ${REAL}
       GROUP BY p.site_id, p.provider`,
    )
    .bind(JSON.stringify(siteIds), from, to)
    .all<Record<string, number | string>>();
  for (const r of results) {
    const n = (v: unknown) => Number(v ?? 0);
    const id = String(r.site_id);
    const cur = out.get(id) ?? { payments: 0, linked: 0, amount: 0, linkedAmount: 0, providers: [] };
    const payments = n(r.payments), linked = n(r.linked);
    const before = n(r.before_tracking), renewals = n(r.renewals), withEmail = n(r.with_email);
    cur.providers.push({
      provider: String(r.provider),
      payments,
      linked,
      amount: n(r.amount),
      linkedAmount: n(r.linked_amount),
      notLinked: { beforeTracking: before, renewals, withEmail, noIds: payments - linked - before - renewals - withEmail },
    });
    cur.payments += payments;
    cur.linked += linked;
    cur.amount += n(r.amount);
    cur.linkedAmount += n(r.linked_amount);
    out.set(id, cur);
  }
  return out;
}

/** One dashboard panel: native rows, plus imported days before the first native visit when no filter is on. */
export async function breakdown(ctx: Ctx, dim: string, limit = 100): Promise<BreakdownRow[]> {
  const rows = await nativeBreakdown(ctx, dim, limit);
  const only = importFilter(ctx.filters);
  if (hasFilters(ctx.filters) && !only) return rows;
  return withImported(ctx.db, ctx.site, ctx.range, dim, rows, Math.max(1, Math.min(500, limit)), only);
}

export async function nativeBreakdown(ctx: Ctx, dim: string, limit = 100): Promise<BreakdownRow[]> {
  const { db } = ctx;
  const lim = Math.max(1, Math.min(500, limit));

  if (SESSION_DIMS[dim]) {
    // First touch reads the visitor row of each visit, and of each paying visit.
    const first = ctx.model === 'first' && !!FIRST_TOUCH_DIMS[dim];
    const col = first ? FIRST_TOUCH_DIMS[dim] : SESSION_DIMS[dim];
    const vJoin = first ? ' LEFT JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id' : '';
    // App versions only exist for app sessions; web sessions would all show up as one empty row.
    const only = dim === 'app_version' ? ' AND s.app_version IS NOT NULL' : '';
    const w = sessionsWhere(ctx);
    const pay = paymentsFrom(ctx);
    // A payment keeps its visit's channel, source and campaign (migration 0064): after the visit is deleted
    // (RETENTION_MONTHS) its revenue stays under that source instead of moving to "No source".
    const kept = KEPT_SOURCE[dim];
    // Payments need the session columns even without filters. With filters, a payment whose visit was deleted is in
    // `pay` only by a kept channel, source or campaign; a dimension it kept no copy of leaves it out.
    const payJoin = hasFilters(ctx.filters)
      ? kept
        ? pay
        : { sql: `${pay.sql} AND s.id IS NOT NULL`, params: pay.params }
      : kept
        ? {
            sql: `payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
                  WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND ${REAL} AND (s.id IS NOT NULL OR p.channel IS NOT NULL)`,
            params: pay.params,
          }
        : {
            sql: `payments p JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND ${REAL}`,
            params: pay.params,
          };
    if (vJoin) payJoin.sql = payJoin.sql.replace(/\s+WHERE /, `${vJoin} WHERE `);
    // A payment whose visit was deleted keeps only its last-touch copy, which stands in for first touch too.
    const payCol = kept ? `CASE WHEN s.id IS NULL THEN p.${kept} ELSE ${col} END` : col;
    const extraCol =
      dim === 'source'
        ? first
          ? `MAX(${FIRST_TOUCH_DIMS.referrer_domain})`
          : 'MAX(s.referrer_domain)'
        : dim === 'region' || dim === 'city'
          ? 'MAX(s.country)'
          : 'NULL';
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT ${col} AS label, COUNT(DISTINCT s.visitor_id) AS visitors, SUM(s.pageviews) AS pageviews, ${extraCol} AS extra
           FROM sessions s${vJoin} WHERE ${w.sql}${only} GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...w.params),
      db
        .prepare(
          `SELECT ${payCol} AS label, SUM(${AMOUNT}) AS revenue,
                  COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS customers
           FROM ${payJoin.sql}${only} GROUP BY label`,
        )
        .bind(ctx.site.currency, ...payJoin.params),
    ]);
    const rows = merge(v.results as any[], r.results as any[], lim);
    if (ATTRIBUTION_DIMS.has(dim) && !hasFilters(ctx.filters)) {
      const rest = await unlinkedRevenue(ctx, !!kept);
      if (rest.payments) rows.push({ label: NO_SOURCE, visitors: 0, revenue: rest.payments, customers: rest.customers, extra: null, noVisit: true });
      if (rest.appStore) rows.push({ label: APP_STORE_NO_SOURCE, visitors: 0, revenue: rest.appStore, customers: 0, extra: null, appStore: true });
    }
    // Names for Apple Search Ads ids and a flag for Meta campaigns, side by side: each is one read or none.
    await Promise.all([withAsaNames(db, dim, rows), withMetaCampaigns(db, ctx.site.id, dim, rows)]);
    return rows;
  }

  // Which post paid is Pro's (x-posts.ts); without it the dimension has no rows.
  if (dim === 'x_post') return (await proHooks()?.xPostRows?.(ctx, lim)) ?? [];

  if (dim === 'page') {
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = 'pageview' AND e.ts >= ? AND e.ts < ?${countedSql(ctx.site.show_datacenter, 'e')}${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.path AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      // Revenue from customers who viewed the page during the period.
      db
        .prepare(
          `SELECT pv.label, SUM(${AMOUNT}) AS revenue, ${NEW_CUSTOMERS} AS customers
           FROM (SELECT DISTINCT e.path AS label, e.visitor_id ${base}) pv
           JOIN payments p ON p.site_id = ? AND p.visitor_id = pv.visitor_id AND p.ts >= ? AND p.ts < ? AND ${REAL}
           GROUP BY pv.label`,
        )
        .bind(ctx.site.currency, ...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return merge(v.results as any[], r.results as any[], lim);
  }

  if (dim === 'exit_link' || dim === 'goal') {
    const type = dim === 'goal' ? 'goal' : 'outbound';
    const f = filterSql(ctx.filters);
    const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
    const params = [ctx.site.id, type, ctx.range.from, ctx.range.to, ...f.params];
    const base = `FROM events e ${join} WHERE e.site_id = ? AND e.type = ? AND e.ts >= ? AND e.ts < ?${countedSql(ctx.site.show_datacenter, 'e')}${f.sql}`;
    const [v, r] = await db.batch([
      db
        .prepare(
          `SELECT e.name AS label, COUNT(DISTINCT e.visitor_id) AS visitors, COUNT(*) AS pageviews ${base}
           GROUP BY label ORDER BY visitors DESC LIMIT ${lim}`,
        )
        .bind(...params),
      db
        .prepare(
          `SELECT g.label, SUM(${AMOUNT}) AS revenue, ${NEW_CUSTOMERS} AS customers
           FROM (SELECT DISTINCT e.name AS label, e.visitor_id ${base}) g
           JOIN payments p ON p.site_id = ? AND p.visitor_id = g.visitor_id AND p.ts >= ? AND p.ts < ? AND ${REAL}
           GROUP BY g.label`,
        )
        .bind(ctx.site.currency, ...params, ctx.site.id, ctx.range.from, ctx.range.to),
    ]);
    return merge(v.results as any[], r.results as any[], lim);
  }

  throw new Error(`unknown dimension ${dim}`);
}

function merge(visits: any[], revenue: any[], limit: number): BreakdownRow[] {
  const rev = new Map(revenue.map((r) => [r.label, r]));
  const rows: BreakdownRow[] = visits.map((v) => ({
    label: v.label,
    visitors: v.visitors,
    pageviews: v.pageviews ?? undefined,
    revenue: rev.get(v.label)?.revenue ?? 0,
    customers: rev.get(v.label)?.customers ?? 0,
    extra: v.extra ?? null,
  }));
  // Sources that made money but had no visits in this period (paid later) still show up, unless the visit list was
  // cut at the limit: then a missing label may just rank lower, and a row with 0 visitors would be wrong.
  if (visits.length >= limit) return rows;
  const seen = new Set(visits.map((v) => v.label));
  for (const r of revenue) if (!seen.has(r.label)) rows.push({ label: r.label, visitors: 0, revenue: r.revenue, customers: r.customers });
  return rows;
}

/** A page of a list: rows from `offset`, at most `limit` (1 to 1000, default 200). */
export interface Page {
  offset: number;
  limit: number;
}

export function pageOf(q: { offset?: string; limit?: string }): Page {
  const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(q.limit) || 200)));
  return { offset, limit };
}

/** One row past the page says whether another page exists; `next` is its offset, or null. */
function paged<T>(rows: T[], page: Page): { rows: T[]; next: number | null } {
  return { rows: rows.slice(0, page.limit), next: rows.length > page.limit ? page.offset + page.limit : null };
}

export const CUSTOMER_KINDS = ['payment', 'refund', 'all'] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

/**
 * Customers in the period, with where they came from (the "Journey" tab). `kind` picks payments (the default), refunds
 * (negative amounts) or both.
 */
export async function customers(ctx: Ctx, page: Page = { offset: 0, limit: 200 }, kind: CustomerKind = 'payment') {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN' : 'LEFT JOIN';
  const kinds = kind === 'all' ? '' : ` AND p.kind = '${kind}'`;
  const res = await db
    .prepare(
      `SELECT p.id, p.ts, p.kind, p.amount, p.amount_conv, p.currency, p.provider, p.product, p.subscription_id, p.renewal, p.matched_by, p.email AS pay_email, p.name AS pay_name, p.visitor_id, p.session_id,
              v.first_seen, v.name, v.email, v.user_id,
              COALESCE(s.source, p.source) AS source, COALESCE(s.channel, p.channel) AS channel, s.referrer_domain,
              COALESCE(s.utm_campaign, p.campaign) AS utm_campaign, s.ref, s.country, s.city, s.device, s.os, s.browser, s.entry_page,
              (SELECT COUNT(*) FROM sessions s2 WHERE s2.site_id = p.site_id AND s2.visitor_id = p.visitor_id AND s2.started_at <= p.ts) AS visits
       FROM payments p
       LEFT JOIN visitors v ON v.site_id = p.site_id AND v.id = p.visitor_id
       ${join} sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.site_id = ?${kinds} AND p.ts >= ? AND p.ts < ?${f.sql}
       ORDER BY p.ts DESC, p.id LIMIT ${page.limit + 1} OFFSET ${page.offset}`,
    )
    .bind(site.id, range.from, range.to, ...f.params)
    .all();
  return paged(res.results, page);
}

/** Recent visitors in the period (the "Users" tab). */
export async function visitors(ctx: Ctx, page: Page = { offset: 0, limit: 200 }) {
  const w = sessionsWhere(ctx);
  const res = await ctx.db
    .prepare(
      `SELECT t.*, v.name, v.email, v.user_id, v.first_seen,
              (SELECT COALESCE(SUM(${AMOUNT}), 0) FROM payments p WHERE p.site_id = t.site_id AND p.visitor_id = t.visitor_id AND ${REAL}) AS spent
       FROM (
         SELECT s.site_id, s.visitor_id, MAX(s.last_seen_at) AS last_seen, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
                SUM(s.duration) AS duration, s.source, s.referrer_domain, s.country, s.city, s.device, s.os, s.browser
         FROM sessions s WHERE ${w.sql} GROUP BY s.visitor_id ORDER BY last_seen DESC, s.visitor_id
         LIMIT ${page.limit + 1} OFFSET ${page.offset}
       ) t LEFT JOIN visitors v ON v.site_id = t.site_id AND v.id = t.visitor_id
       ORDER BY t.last_seen DESC, t.visitor_id`,
    )
    .bind(ctx.site.currency, ...w.params)
    .all();
  return paged(res.results, page);
}

export interface ProviderRevenue {
  provider: string;
  currency: string;
  gross: number;
  refunds: number;
  net: number;
  payments: number;
  decimals: number;
  /** In the revenue totals: not a sandbox purchase, and in the site's currency or converted to it. */
  counted: boolean;
  /** Net in the site's currency (converted), or null when this currency is not converted yet. */
  netConverted: number | null;
}

/**
 * Revenue per payment provider (stripe, app_store, dodo, api, revenuecat, google_play, app_store_sandbox, google_play_test) and currency. The
 * App Store line follows the revenue definition (src/worker/revenue.ts): Apple's report on the days it covers, App
 * Store payment rows (RevenueCat App Store purchases included) on the others. With a filter it is payments only.
 */
export async function revenueByProvider(ctx: Ctx): Promise<ProviderRevenue[]> {
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id' : '';
  const layer = await siteLayer(ctx, [ctx.range]);
  const rep = layer?.reported ?? '0';
  const res = await ctx.db
    .prepare(
      `SELECT CASE WHEN ${APPLE_PAYMENT} THEN 'app_store' ELSE p.provider END AS provider, p.currency,
              COALESCE(SUM(CASE WHEN p.kind != 'refund' THEN p.amount ELSE 0 END), 0) AS gross,
              COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN p.amount ELSE 0 END), 0) AS refunds,
              COALESCE(SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END), 0) AS payments,
              SUM(${AMOUNT}) AS converted,
              SUM(CASE WHEN p.currency != ? AND p.amount_conv IS NULL THEN 1 ELSE 0 END) AS pending
       FROM payments p ${join}
       WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ? AND NOT ${rep}${f.sql}
       GROUP BY 1, p.currency ORDER BY gross DESC`,
    )
    .bind(ctx.site.currency, ctx.site.currency, ctx.site.id, ctx.range.from, ctx.range.to, ...f.params)
    .all<Omit<ProviderRevenue, 'net' | 'decimals' | 'counted' | 'netConverted'> & { converted: number; pending: number }>();
  const lines: ProviderRevenue[] = res.results.map(({ converted, pending, ...r }) => ({
    ...r,
    net: r.gross + r.refunds,
    decimals: currencyDecimals(r.currency),
    counted: !isTestProvider(r.provider) && !pending,
    netConverted: pending ? null : converted,
  }));
  if (layer) {
    const t = layer.total(ctx.site.id, 0);
    const cur = ctx.site.currency;
    if (t.gross || t.refunds || t.units) {
      // Apple's report is in the site currency already; App Store payment rows in other currencies keep their lines.
      const line = lines.find((l) => l.provider === 'app_store' && l.currency === cur);
      if (line) {
        line.gross += t.gross;
        line.refunds += t.refunds;
        line.net += appleNet(t);
        line.payments += t.units;
        if (line.netConverted !== null) line.netConverted += appleNet(t);
      } else {
        lines.push({ provider: 'app_store', currency: cur, gross: t.gross, refunds: t.refunds, net: appleNet(t), payments: t.units, decimals: currencyDecimals(cur), counted: true, netConverted: appleNet(t) });
      }
    }
    for (const [cc, v] of Object.entries(t.other)) {
      lines.push({ provider: 'app_store', currency: cc, gross: Math.max(v, 0), refunds: Math.min(v, 0), net: v, payments: 0, decimals: currencyDecimals(cc), counted: false, netConverted: null });
    }
  }
  const shown = (l: ProviderRevenue) => l.netConverted ?? 0;
  return lines.sort((a, b) => shown(b) - shown(a) || b.gross - a.gross);
}

/** Everything one visitor did: visits, pages, clicks, payments. */
/** Visitor ids one user id or email joins at most in a profile, as in payments.ts, so a shared test address can't fan out. */
const PROFILE_STITCH_MAX = 50;

/**
 * One person's profile from any of their visitor ids: the visitor, everyone the site identified with the same user id
 * or email (identify(), the iOS sign-in), and the web visitor an app install links to (linked_web_vid). That is the
 * stitch payments.ts creditedVisitSql uses, so a Mac and an iPhone that signed in as one person show one story and
 * one total. Every read starts from the member ids (CROSS JOIN keeps them the outer loop), so it probes the visitor
 * indexes. The timeline holds pageviews, goals and links out: a recorded page's clicks and errors are FounderData Pro's.
 */
export async function visitorProfile(db: D1Database, site: Site, vid: string) {
  const members = `
    me AS (SELECT id, user_id, email FROM visitors WHERE site_id = ?1 AND id = ?2),
    ids AS (SELECT ?2 AS id
            UNION SELECT * FROM (SELECT o.id FROM me CROSS JOIN visitors o ON o.site_id = ?1 AND o.user_id = me.user_id WHERE me.user_id IS NOT NULL LIMIT ${PROFILE_STITCH_MAX})
            UNION SELECT * FROM (SELECT o.id FROM me CROSS JOIN visitors o ON o.site_id = ?1 AND o.email = me.email WHERE me.email IS NOT NULL LIMIT ${PROFILE_STITCH_MAX})),
    mem AS (SELECT id FROM ids UNION SELECT v.linked_web_vid FROM visitors v WHERE v.site_id = ?1 AND v.id IN (SELECT id FROM ids) AND v.linked_web_vid IS NOT NULL)`;
  const shown = `SELECT s.* FROM mem CROSS JOIN sessions s ON s.site_id = ?1 AND s.visitor_id = mem.id ORDER BY s.started_at DESC LIMIT 100`;
  const [v, m, s, e, p] = await db.batch([
    db.prepare('SELECT * FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid),
    db.prepare(`WITH ${members} SELECT v.id, v.name, v.email, v.user_id FROM mem CROSS JOIN visitors v ON v.site_id = ?1 AND v.id = mem.id ORDER BY v.first_seen`).bind(site.id, vid),
    db.prepare(`WITH ${members} ${shown}`).bind(site.id, vid),
    db
      .prepare(
        `WITH ${members}, shown AS (${shown})
         SELECT e.session_id, e.ts, e.type, e.name, e.path, e.props FROM shown CROSS JOIN events e ON e.site_id = ?1 AND e.session_id = shown.id
         WHERE e.type IN ('pageview', 'goal', 'outbound') ORDER BY e.ts DESC LIMIT 1000`,
      )
      .bind(site.id, vid),
    db.prepare(`WITH ${members} SELECT p.* FROM mem CROSS JOIN payments p ON p.site_id = ?1 AND p.visitor_id = mem.id ORDER BY p.ts DESC`).bind(site.id, vid),
  ]);
  const self = (v.results[0] as Record<string, unknown> | undefined) ?? null;
  const people = m.results as { id: string; name: string | null; email: string | null; user_id: string | null }[];
  // The name, email and user id of the person: this visitor's own, else another device's.
  const pick = (k: 'name' | 'email' | 'user_id') => (self?.[k] as string | null) ?? people.find((x) => x[k])?.[k] ?? null;
  return {
    visitor: self ? { ...self, name: pick('name'), email: pick('email'), user_id: pick('user_id') } : null,
    /** Every visitor id in this profile, oldest first: more than one when identify() joined devices. */
    visitors: people.map((x) => x.id),
    sessions: s.results,
    events: e.results,
    payments: p.results,
    currency: site.currency,
    decimals: currencyDecimals(site.currency),
  };
}

export interface FunnelStep {
  type: 'page' | 'goal';
  value: string; // page paths support * wildcards, e.g. /blog/*
  label?: string;
}

/** Visitors who completed each step, in order, within the period. */
export async function funnel(ctx: Ctx, steps: FunnelStep[]) {
  if (!steps.length) return [];
  const f = filterSql(ctx.filters);
  const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const st of steps) {
    if (st.type === 'goal') {
      conds.push(`(e.type = 'goal' AND e.name = ?)`);
      params.push(st.value);
    } else {
      conds.push(`(e.type = 'pageview' AND e.path GLOB ?)`);
      params.push(st.value);
    }
  }
  const rows = (
    await ctx.db
      .prepare(
        `SELECT e.visitor_id AS v, e.ts, e.type, e.name, e.path FROM events e ${join}
         WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND (${conds.join(' OR ')})${countedSql(ctx.site.show_datacenter, 'e')}${f.sql}
         ORDER BY e.ts LIMIT 100000`,
      )
      .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...params, ...f.params)
      .all<{ v: string; ts: number; type: string; name: string | null; path: string }>()
  ).results;

  const matchers = steps.map((st) => {
    if (st.type === 'goal') return (r: (typeof rows)[0]) => r.type === 'goal' && r.name === st.value;
    const re = new RegExp('^' + st.value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return (r: (typeof rows)[0]) => r.type === 'pageview' && re.test(r.path);
  });
  const progress = new Map<string, number>();
  for (const r of rows) {
    const at = progress.get(r.v) ?? 0;
    if (at < steps.length && matchers[at](r)) progress.set(r.v, at + 1);
  }
  const counts = steps.map(() => 0);
  for (const reached of progress.values()) for (let i = 0; i < reached; i++) counts[i]++;
  return steps.map((st, i) => ({ ...st, visitors: counts[i] }));
}
