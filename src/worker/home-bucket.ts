import type { Site } from './env';
import { PAY_AMOUNT, payCurrency } from './fx';
import { bucketLabels, midnight, offsetsIn, resolveRange, tzOffset, type Granularity } from './lib/time';
import { currencyDecimals, REAL } from './payments';
import { pickTimezone, savedTimezone } from './reporting';
import { type AppleAmounts, APPLE_PAYMENT, appleNet, appleSplitColumns, appStoreLayerPlan, dayBucket, emptyApple, KEPT_CHANNEL_SQL, KEPT_CREDIT, KEPT_SOURCE_SQL, noSourceAmount } from './revenue';
import { APP_STORE_NO_SOURCE, HOME_PERIODS, NO_SOURCE, type Money } from './home';

/**
 * One bar of Home's revenue chart, opened: GET /api/home/bucket?period=&bucket=&tz= (docs/GUIDE.md, next to the
 * other dashboard JSON routes). The same period and timezone as GET /api/home, so `revenue` is the bar's height: payments net of refunds,
 * plus Apple's report on the days it covers, with the App Store payment rows of those days left out (src/worker/revenue.ts).
 *
 * The answer splits that revenue by site and by source the way Home's sources panel does, and lists the bucket's
 * payments, newest first, up to LIST_MAX.
 */

const LIST_MAX = 200;
const DAY = 86_400_000;
// The visit's platform; null without a visit row (a payment credited through the source it kept names no platform).
const PLATFORM = `(CASE WHEN s.id IS NULL THEN NULL WHEN s.hostname LIKE 'ios:%' THEN 'ios' ELSE 'web' END)`;
const IN_SITES = (alias: string) => `${alias}.site_id IN (SELECT id FROM sites)`;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const addMoney = (m: Money, currency: string, amount: number) => {
  m[currency] = (m[currency] ?? 0) + amount;
};

/** The instants a bucket label covers in `tz`, or null when the label is not one of `g`'s. */
export function bucketWindow(bucket: string, g: Granularity, tz: string): { from: number; to: number } | null {
  if (g === 'hour') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(bucket)) return null;
    const local = Date.parse(`${bucket}:00Z`);
    if (Number.isNaN(local)) return null;
    const from = local - tzOffset(tz, local - tzOffset(tz, local));
    return { from, to: from + 3_600_000 };
  }
  if (g === 'month') {
    if (!/^\d{4}-\d{2}$/.test(bucket)) return null;
    const [y, m] = bucket.split('-').map(Number);
    const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    return { from: midnight(`${bucket}-01`, tz), to: midnight(next, tz) };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket) || Number.isNaN(Date.parse(`${bucket}T00:00:00Z`))) return null;
  return { from: midnight(bucket, tz), to: midnight(addDays(bucket, g === 'week' ? 7 : 1), tz) };
}

export interface BucketPayment {
  id: string;
  siteId: string;
  siteName: string;
  siteDomain: string;
  provider: string;
  ts: number;
  amount: number;
  currency: string;
  decimals: number;
  converted: { amount: number; currency: string; decimals: number } | null;
  kind: string;
  renewal: boolean;
  product: string | null;
  visitorId: string | null;
  source: string | null;
  sourceDomain: string | null;
  channel: string | null;
  country: string | null;
  platform: 'web' | 'ios' | null;
  /** An App Store payment on a day Apple's report covers: the report counts it, so it is not in `revenue` twice. */
  reported: boolean;
}

export interface BucketSite {
  id: string;
  name: string;
  domain: string;
  revenue: Money;
  /** Payments, plus units from Apple's report. */
  payments: number;
  /** Apple's report on the days of the bucket it covers; null when it covers none. */
  appStoreReport: { units: number; revenue: Money } | null;
}

export interface BucketSource {
  label: string;
  domain: string | null;
  channel: string;
  revenue: Money;
  payments: number;
  appStore?: boolean;
  noVisit?: boolean;
}

export type HomeBucket =
  | { error: string }
  | {
      bucket: string;
      granularity: Granularity;
      tz: string;
      from: number;
      to: number;
      revenue: Money;
      payments: number;
      sites: BucketSite[];
      sources: BucketSource[];
      list: BucketPayment[];
      /** True when the bucket has more payments than `list` holds. */
      more: boolean;
    };

export async function homeBucket(db: D1Database, q: Record<string, string | undefined>, now = Date.now()): Promise<HomeBucket> {
  const period = HOME_PERIODS.has(q.period ?? '') ? q.period! : '30d';
  const [siteRes, saved] = await Promise.all([db.prepare('SELECT * FROM sites ORDER BY created_at').all<Site>(), savedTimezone(db)]);
  const sites = siteRes.results;
  const tz = pickTimezone(q.tz, saved, sites.map((s) => s.timezone)).timezone;
  const firstCreated = sites.length ? Math.min(...sites.map((s) => s.created_at)) : now;
  const range = resolveRange({ period }, tz, firstCreated, now);
  const g = range.granularity;
  const bucket = q.bucket ?? '';
  const win = bucketWindow(bucket, g, tz);
  if (!win || !bucketLabels(range, offsetsIn(tz, range.from, range.to)).includes(bucket)) return { error: `bucket must be one of the ${g} labels of the period` };
  // The bar's instants: the bucket, cut to the period (the first and last bucket can be partial).
  const from = Math.max(win.from, range.from);
  const to = Math.min(win.to, range.to);

  // Apple's report over the whole period, as Home reads it, so a report day lands in the same bar (dayBucket).
  const plan = await appStoreLayerPlan(db, sites, tz, [range], { now });
  const rep = plan.reported;
  const where = `${IN_SITES('p')} AND p.ts >= ? AND p.ts < ? AND ${REAL}`;
  const joinSession = 'LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id';
  const cur = payCurrency('st.currency');
  const [listRes, siteRows, sourceRows, appleRows, unlinkedRows] = await db.batch([
    db
      .prepare(
        `SELECT p.id, p.site_id, p.provider, p.ts, p.amount, p.amount_conv, p.kind, p.currency, p.renewal, p.product, p.visitor_id,
                ${KEPT_SOURCE_SQL} AS source, s.referrer_domain, ${KEPT_CHANNEL_SQL} AS channel, s.country, ${PLATFORM} AS platform,
                (${rep}) AS reported
         FROM payments p ${joinSession} WHERE ${where} ORDER BY p.ts DESC LIMIT ${LIST_MAX + 1}`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT p.site_id, ${cur} AS currency, SUM(CASE WHEN ${rep} THEN 0 ELSE ${PAY_AMOUNT} END) AS revenue,
                SUM(CASE WHEN p.kind = 'payment' AND NOT ${rep} THEN 1 ELSE 0 END) AS payments
         FROM payments p JOIN sites st ON st.id = p.site_id WHERE ${where} GROUP BY 1, 2`,
      )
      .bind(from, to),
    // Revenue per source as Home's panel credits it: a payment goes to its visit's source, or the one it kept.
    db
      .prepare(
        `SELECT ${KEPT_SOURCE_SQL} AS source, ${cur} AS currency, SUM(${PAY_AMOUNT}) AS revenue, COUNT(*) AS payments,
                MAX(s.referrer_domain) AS domain, MAX(${KEPT_CHANNEL_SQL}) AS channel
         FROM payments p ${joinSession} JOIN sites st ON st.id = p.site_id WHERE ${where} AND ${KEPT_CREDIT} GROUP BY 1, 2`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT p.site_id, ${cur} AS currency, ${appleSplitColumns(rep, PAY_AMOUNT, KEPT_CREDIT)}
         FROM payments p JOIN sites st ON st.id = p.site_id ${joinSession} WHERE ${where} AND ${APPLE_PAYMENT} GROUP BY 1, 2`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT p.site_id, ${cur} AS currency, SUM(${PAY_AMOUNT}) AS revenue, COUNT(*) AS payments
         FROM payments p JOIN sites st ON st.id = p.site_id ${joinSession}
         WHERE ${where} AND NOT ${APPLE_PAYMENT} AND NOT ${KEPT_CREDIT} GROUP BY 1, 2`,
      )
      .bind(from, to),
  ]);
  const layer = await plan.layer();

  const byId = new Map(sites.map((s) => [s.id, s]));
  const revenue: Money = {};
  let payments = 0;
  const perSite = new Map<string, BucketSite>();
  const siteOf = (id: string) => {
    let e = perSite.get(id);
    if (!e) {
      const s = byId.get(id)!;
      perSite.set(id, (e = { id, name: s.name, domain: s.domain, revenue: {}, payments: 0, appStoreReport: null }));
    }
    return e;
  };
  for (const r of siteRows.results as any[]) {
    if (!byId.has(r.site_id)) continue;
    const e = siteOf(r.site_id);
    addMoney(e.revenue, r.currency, Number(r.revenue));
    e.payments += Number(r.payments);
  }

  // Apple's report on the bucket's days, per site in the site currency (amounts without a rate in their own).
  const report = new Map<string, Money>();
  for (const s of sites) {
    const t: AppleAmounts = emptyApple();
    let any = false;
    for (const [day, a] of layer.byDay(s.id, 0)) {
      if (dayBucket(day, g) !== bucket) continue;
      any = true;
      t.gross += a.gross;
      t.refunds += a.refunds;
      t.units += a.units;
      for (const [cc, v] of Object.entries(a.other)) t.other[cc] = (t.other[cc] ?? 0) + v;
    }
    if (!any) continue;
    const m: Money = {};
    for (const [cc, v] of [[s.currency, appleNet(t)] as const, ...Object.entries(t.other)]) if (v) addMoney(m, cc, v);
    report.set(s.id, m);
    const e = siteOf(s.id);
    e.appStoreReport = { units: t.units, revenue: m };
    for (const [cc, v] of Object.entries(m)) addMoney(e.revenue, cc, v);
    e.payments += t.units;
  }
  for (const e of perSite.values()) {
    for (const [cc, v] of Object.entries(e.revenue)) addMoney(revenue, cc, v);
    payments += e.payments;
  }

  // Sources, then the rows Home's panel adds so the column sums to the bar: payments with no visit, and App Store
  // revenue no attributed payment explains.
  const bySource = new Map<string, BucketSource>();
  for (const r of sourceRows.results as any[]) {
    let e = bySource.get(r.source);
    if (!e) bySource.set(r.source, (e = { label: r.source, domain: r.domain, channel: r.channel ?? '', revenue: {}, payments: 0 }));
    addMoney(e.revenue, r.currency, Number(r.revenue));
    e.payments += Number(r.payments);
    e.domain ??= r.domain;
  }
  const sources = [...bySource.values()];
  const unlinked: BucketSource = { label: NO_SOURCE, domain: null, channel: 'No linked visit', revenue: {}, payments: 0, noVisit: true };
  for (const r of unlinkedRows.results as any[]) {
    if (!byId.has(r.site_id)) continue;
    addMoney(unlinked.revenue, r.currency, Number(r.revenue));
    unlinked.payments += Number(r.payments);
  }
  if (unlinked.payments) sources.push(unlinked);
  const apple = new Map<string, { unreported: number; attributed: number }>();
  for (const r of appleRows.results as any[]) apple.set(`${r.site_id}|${r.currency}`, { unreported: Number(r.unreported), attributed: Number(r.attributed) });
  const noSource: BucketSource = { label: APP_STORE_NO_SOURCE, domain: null, channel: 'App Store', revenue: {}, payments: 0, appStore: true };
  for (const s of sites) {
    const rep = report.get(s.id) ?? {};
    const ccs = new Set([...Object.keys(rep), ...[...apple.keys()].filter((k) => k.startsWith(`${s.id}|`)).map((k) => k.slice(s.id.length + 1))]);
    for (const cc of ccs) {
      const a = apple.get(`${s.id}|${cc}`);
      const v = noSourceAmount(rep[cc] ?? 0, a?.unreported ?? 0, a?.attributed ?? 0);
      if (v) addMoney(noSource.revenue, cc, v);
    }
  }
  if (Object.keys(noSource.revenue).length) sources.push(noSource);
  const top = (m: Money) => Math.max(0, ...Object.values(m));
  sources.sort((a, b) => top(b.revenue) - top(a.revenue) || b.payments - a.payments);

  const rows = listRes.results as any[];
  const list: BucketPayment[] = rows.slice(0, LIST_MAX).flatMap((r) => {
    const s = byId.get(r.site_id);
    if (!s) return [];
    return [
      {
        id: r.id,
        siteId: r.site_id,
        siteName: s.name,
        siteDomain: s.domain,
        provider: r.provider,
        ts: r.ts,
        amount: r.amount,
        currency: r.currency,
        decimals: currencyDecimals(r.currency),
        converted: r.amount_conv === null ? null : { amount: r.amount_conv, currency: s.currency, decimals: currencyDecimals(s.currency) },
        kind: r.kind,
        renewal: !!r.renewal,
        product: r.product,
        visitorId: r.visitor_id,
        source: r.source,
        sourceDomain: r.referrer_domain,
        channel: r.channel,
        country: r.country,
        platform: r.source ? r.platform : null,
        reported: !!r.reported,
      },
    ];
  });

  return {
    bucket,
    granularity: g,
    tz,
    from,
    to,
    revenue,
    payments,
    sites: [...perSite.values()].sort((a, b) => top(b.revenue) - top(a.revenue)),
    sources,
    list,
    more: rows.length > LIST_MAX,
  };
}
