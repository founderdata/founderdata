import type { Site } from './env';
import { countedAllSql } from './datacenter';
import { narrowRates, PAY_AMOUNT, payCurrency, rateLookup } from './fx';
import { startOfDay, tzOffset } from './lib/time';
import { currencyDecimals, TEST_PROVIDERS_SQL } from './payments';
import { proHooks } from './pro-hooks';
import { reportingTimezone } from './reporting';
import { APPLE_PAYMENT, appStoreLayer, ascPrefetch, appleNet, KEPT_CHANNEL_SQL, KEPT_SOURCE_SQL } from './revenue';
import { asaPrefetch, sinceYesterday } from './since-yesterday';
import { hasApp, webHostSql } from '../shared/platform';

/**
 * GET /api/mobile/summary (docs/MOBILE-API.md section 4): everything the iOS home screen and widgets draw, in one
 * call and under 17 D1 statements (sinceYesterday takes 2 or 3 of them; the widget shows no Meta, so it reads none). Days are in the viewer's timezone; revenue is converted into each site's currency
 * like the home page, and the totals add up amounts of one currency only. The 7 and 30 day windows also add every
 * site into one figure in `currency` (default: the first site's currency), each day's amount at that day's ECB rate. App Store sales follow the revenue definition
 * (src/worker/revenue.ts): Apple's report on the days it covers, App Store payment rows on the others. The
 * "yesterday at the same point" figure compares part of a day, so it counts payment rows only. Each window also has
 * `previous`: as many days before it, its last day up to the same time of day (payment rows only on that day), which is
 * why the statements read SPAN days.
 */

const DAY = 86_400_000;
const REAL = `p.provider NOT IN ${TEST_PROVIDERS_SQL}`;
/** The days the answer shows (`last30`, the 30 day window). */
const DAYS = 30;
/** The days it reads: twice DAYS, for the window before each one (`periods.*.previous`). */
const SPAN = 2 * DAYS;
/** Window lengths in days, ending today. Keys match the dashboard periods. */
const WINDOWS = { '7d': 7, '30d': 30 } as const;
type WindowKey = keyof typeof WINDOWS;
const NEW_CUSTOMER = `p.kind = 'payment' AND p.renewal = 0`;

export interface Money {
  currency: string;
  amount: number;
}

const major = (minor: number, currency: string) => minor / 10 ** currencyDecimals(currency);

function validTz(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** SQL that turns a ms timestamp into the index (0 oldest, 6 today) of the local day it falls in. */
const dayIndex = (col: string, starts: number[]) =>
  `(CASE ${starts
    .map((s, i) => `WHEN ${col} >= ${s} THEN ${i}`)
    .reverse()
    .join(' ')} END)`;

const addTo = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** Money maps (currency to minor units) as lists in major units, over the same currencies in the same order. */
function moneyLists(a: Map<string, number>, b: Map<string, number>, fallback: string): [Money[], Money[]] {
  const currencies = [...new Set([...a.keys(), ...b.keys()])];
  const today = (k: string) => major(a.get(k) ?? 0, k);
  const before = (k: string) => major(b.get(k) ?? 0, k);
  currencies.sort((x, y) => today(y) - today(x) || before(y) - before(x));
  if (!currencies.length) currencies.push(fallback);
  const list = (m: Map<string, number>) => currencies.map((currency) => ({ currency, amount: major(m.get(currency) ?? 0, currency) }));
  return [list(a), list(b)];
}

/** Every site, on the leading column of the (site_id, time) indexes, so a time range reads only its own rows. */
const IN_SITES = (alias: string) => `${alias}.site_id IN (SELECT id FROM sites)`;

export async function mobileSummary(db: D1Database, tzParam: string | undefined, now = Date.now(), currencyParam?: string) {
  // Round trip 1: what needs no timezone. The sites, the reporting timezone (src/worker/reporting.ts, the days Home
  // counts in) when there is no ?tz=, and Apple's report rows over a span that covers the 60 days in any timezone.
  const [siteRes, zone, pre, asa, paidCurrencies] = await Promise.all([
    db
      .prepare(
        `SELECT st.id, st.name, st.currency, st.app_bundle_id, st.android_package, st.asc_app_id, st.app_store_id,
                (CASE WHEN st.app_bundle_id IS NULL AND st.android_package IS NULL THEN 1 ELSE EXISTS (
                   SELECT 1 FROM sessions w WHERE w.site_id = st.id AND w.started_at > ? AND ${webHostSql('w.hostname')}
                 ) END) AS has_web
         FROM sites st ORDER BY st.created_at`,
      )
      .bind(now - 90 * DAY)
      .all<Pick<Site, 'id' | 'name' | 'currency' | 'app_bundle_id' | 'android_package' | 'asc_app_id' | 'app_store_id'> & { has_web: number }>(),
    tzParam ? null : reportingTimezone(db),
    ascPrefetch(db, new Date(now - (SPAN + 2) * DAY).toISOString().slice(0, 10), new Date(now + 2 * DAY).toISOString().slice(0, 10)),
    asaPrefetch(db, now),
    // Every currency paid in over a span that covers the 60 days in any timezone: the rates below load with them.
    db
      .prepare(`SELECT DISTINCT p.currency AS cc FROM payments p WHERE ${IN_SITES('p')} AND p.ts >= ?`)
      .bind(now - (SPAN + 2) * DAY)
      .all<{ cc: string }>(),
  ]);
  const tz = tzParam ? validTz(tzParam) : zone!.timezone;
  const todayStart = startOfDay(now, tz);
  // The last SPAN local days, oldest first. Walking back from midnight keeps daylight saving shifts right.
  const starts = new Array<number>(SPAN);
  starts[SPAN - 1] = todayStart;
  for (let i = SPAN - 2; i >= 0; i--) starts[i] = startOfDay(starts[i + 1] - 1, tz);
  const labels = starts.map((s) => new Date(s + tzOffset(tz, s)).toISOString().slice(0, 10));
  const T = SPAN - 1;
  const Y = SPAN - 2;
  // Day d up to the time of day it is now, never past its end (a day can be 23 or 25 hours long).
  const samePoint = (d: number) => Math.min(starts[d] + (now - todayStart), starts[d + 1]);
  const ySameEnd = samePoint(Y);
  // The first day of each window, and the window before it: as many days, up to the same time of day on its last.
  const firstOf = (key: WindowKey) => SPAN - WINDOWS[key];
  const prevOf = (key: WindowKey) => ({ first: firstOf(key) - WINDOWS[key], last: T - WINDOWS[key] });
  const w7 = starts[firstOf('7d')];
  const w30 = starts[firstOf('30d')];
  const p7 = prevOf('7d');
  const p30 = prevOf('30d');
  // The days counted only up to the same time: yesterday, and the last day of each window before.
  const partDays = [Y, p7.last, p30.last];
  const partSql = `(${partDays.map(() => '(p.ts >= ? AND p.ts < ?)').join(' OR ')})`;
  const partBind = partDays.flatMap((d) => [starts[d], samePoint(d)]);

  const sites = siteRes.results;

  // Round trip 2: the rest, started together. Apple's newest report day is read here too, not after the numbers, and
  // so are the exchange rates the windows add up in, for every currency the payments or sites can bring.
  const asked = currencyParam?.trim().toUpperCase();
  const totalCurrency = asked && /^[A-Z]{3}$/.test(asked) ? asked : sites[0]?.currency ?? 'USD';
  // Apple's report can add amounts in the buyers' currencies when one has no rate, so those count in too.
  const wideSet = [totalCurrency, ...sites.map((s) => s.currency), ...paidCurrencies.results.map((r) => r.cc), ...new Set(pre.rows.map((r) => r.cc))];
  const ratesP = rateLookup(db, wideSet, labels[0], labels[labels.length - 1], fetch, now, { fill: false });
  ratesP.catch(() => undefined);
  // Apple's sales report is Pro's import (ascsales.ts); without it every site has no report day.
  const appStoreP = proHooks()?.latestAppStoreDay?.(db, sites.map((s) => s.id)) ?? Promise.resolve(new Map<string, null>());
  appStoreP.catch(() => undefined);
  // The phone Home's "Since yesterday" block, for the Since yesterday widget (src/worker/since-yesterday.ts). The widget
  // shows no Meta line, so `meta` stays null and costs no read.
  const yesterday = sinceYesterday(db, sites as unknown as Site[], tz, now, { asa, meta: false });
  const [[sessionRows, payRows, latestSiteRows, latestRows, windowRows], layer] = await Promise.all([
    db.batch([
    // Visitors per day over the days shown; the windows before count distinct visitors in windowRows.
    db
      .prepare(
        `SELECT s.site_id, ${dayIndex('s.started_at', starts.slice(SPAN - DAYS))} + ${SPAN - DAYS} AS d, COUNT(DISTINCT s.visitor_id) AS visitors,
                COUNT(DISTINCT CASE WHEN s.started_at < ? THEN s.visitor_id END) AS same_point
         FROM sessions s WHERE ${IN_SITES('s')} AND s.started_at >= ?${countedAllSql('s')} GROUP BY s.site_id, d`,
      )
      .bind(ySameEnd, starts[SPAN - DAYS]),
    // Revenue per day over SPAN days. same_revenue is the part of a day before the same time of day, on partDays only.
    db
      .prepare(
        `SELECT p.site_id, ${dayIndex('p.ts', starts)} AS d, ${payCurrency('st.currency')} AS cc,
                SUM(${PAY_AMOUNT}) AS revenue,
                SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS purchases,
                SUM(CASE WHEN ${partSql} THEN ${PAY_AMOUNT} ELSE 0 END) AS same_revenue,
                ${APPLE_PAYMENT} AS apple
         FROM payments p JOIN sites st ON st.id = p.site_id
         WHERE ${IN_SITES('p')} AND p.ts >= ? AND ${REAL} GROUP BY p.site_id, d, cc, apple`,
      )
      .bind(...partBind, starts[0]),
    // Each site's newest payment, through the (site_id, ts) index.
    db.prepare(
      `SELECT p.site_id, p.ts, p.amount, p.currency, p.product, p.provider, ${KEPT_SOURCE_SQL} AS source, ${KEPT_CHANNEL_SQL} AS channel
       FROM sites st
       JOIN payments p ON p.id = (SELECT p2.id FROM payments p2 WHERE p2.site_id = st.id AND p2.kind = 'payment'
                                   AND p2.provider NOT IN ${TEST_PROVIDERS_SQL} ORDER BY p2.ts DESC LIMIT 1)
       LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id`,
    ),
    db.prepare(
      `SELECT p.site_id, p.ts, p.amount, p.currency, p.product, p.provider, ${KEPT_SOURCE_SQL} AS source, ${KEPT_CHANNEL_SQL} AS channel
       FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
       WHERE p.kind = 'payment' AND ${REAL} ORDER BY p.ts DESC LIMIT 10`,
    ),
    // Distinct visitors and new customers per site over 7 and 30 days, and over the window before each (p7, p30).
    // Neither adds up from the daily counts.
    db
      .prepare(
        `SELECT s.site_id, 'v' AS k, COUNT(DISTINCT CASE WHEN s.started_at >= ?1 THEN s.visitor_id END) AS n7,
                COUNT(DISTINCT CASE WHEN s.started_at >= ?2 THEN s.visitor_id END) AS n30,
                COUNT(DISTINCT CASE WHEN s.started_at >= ?3 AND s.started_at < ?4 THEN s.visitor_id END) AS p7,
                COUNT(DISTINCT CASE WHEN s.started_at < ?5 THEN s.visitor_id END) AS p30
         FROM sessions s WHERE ${IN_SITES('s')} AND s.started_at >= ?6 AND (s.started_at >= ?2 OR s.started_at < ?5)${countedAllSql('s')} GROUP BY s.site_id
         UNION ALL
         SELECT p.site_id, 'c' AS k,
                COUNT(DISTINCT CASE WHEN p.ts >= ?1 AND ${NEW_CUSTOMER} THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS n7,
                COUNT(DISTINCT CASE WHEN p.ts >= ?2 AND ${NEW_CUSTOMER} THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS n30,
                COUNT(DISTINCT CASE WHEN p.ts >= ?3 AND p.ts < ?4 AND ${NEW_CUSTOMER} THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS p7,
                COUNT(DISTINCT CASE WHEN p.ts < ?5 AND ${NEW_CUSTOMER} THEN COALESCE(p.visitor_id, p.customer_id, p.id) END) AS p30
         FROM payments p WHERE ${IN_SITES('p')} AND p.ts >= ?6 AND (p.ts >= ?2 OR p.ts < ?5) AND ${REAL} GROUP BY p.site_id`,
      )
      .bind(w7, w30, starts[p7.first], samePoint(p7.last), samePoint(p30.last), starts[p30.first]),
    ]),
    // Apple's report over the SPAN days (today is never in it).
    appStoreLayer(db, sites, tz, [{ from: starts[0], to: now }], { now, prefetch: pre }),
  ]);

  type SessionRow = { site_id: string; d: number; visitors: number; same_point: number };
  type PayRow = { site_id: string; d: number; cc: string; revenue: number; purchases: number; same_revenue: number; apple: number };
  type PaymentRow = { site_id: string; ts: number; amount: number; currency: string; product: string | null; provider: string; source: string | null; channel: string | null };
  type WindowRow = { site_id: string; k: 'v' | 'c'; n7: number; n30: number; p7: number; p30: number };

  const visitors = new Map<string, number[]>();
  const sameVisitors = new Map<string, number>();
  for (const r of sessionRows.results as unknown as SessionRow[]) {
    if (!visitors.has(r.site_id)) visitors.set(r.site_id, new Array(SPAN).fill(0));
    visitors.get(r.site_id)![r.d] = r.visitors;
    if (r.d === Y) sameVisitors.set(r.site_id, r.same_point);
  }
  // Revenue by site and day, per currency; the site's own currency is what the site rows show.
  const revenue = new Map<string, Map<string, number>[]>();
  const dayPurchases = new Map<string, number[]>();
  const purchases = new Map<string, number>();
  const todayMoney = new Map<string, number>();
  const sameMoney = new Map<string, number>();
  // The part of each of partDays up to the same time of day, per currency: payment rows only, as the report has no hours.
  const partMoney = new Map<number, Map<string, number>>(partDays.map((d) => [d, new Map()]));
  const reportDays = new Set(layer.days[0]);
  const mapped = new Set(sites.filter((s) => s.asc_app_id).map((s) => s.id));
  const siteDays = (id: string) => {
    if (!revenue.has(id)) revenue.set(id, Array.from({ length: SPAN }, () => new Map()));
    if (!dayPurchases.has(id)) dayPurchases.set(id, new Array(SPAN).fill(0));
    return { money: revenue.get(id)!, count: dayPurchases.get(id)! };
  };
  for (const r of payRows.results as unknown as PayRow[]) {
    if (r.d === Y) addTo(sameMoney, r.cc, r.same_revenue);
    const part = partMoney.get(r.d);
    if (part && r.same_revenue) addTo(part, r.cc, r.same_revenue);
    // An App Store payment row on a day Apple's report covers: the report counts that sale instead.
    if (r.apple && mapped.has(r.site_id) && reportDays.has(labels[r.d])) continue;
    const { money, count } = siteDays(r.site_id);
    addTo(money[r.d], r.cc, r.revenue);
    count[r.d] += r.purchases;
    if (r.d === T) {
      addTo(purchases, r.site_id, r.purchases);
      addTo(todayMoney, r.cc, r.revenue);
    }
  }
  for (const s of sites) {
    for (const [day, a] of layer.byDay(s.id, 0)) {
      const d = labels.indexOf(day);
      if (d < 0) continue;
      const { money, count } = siteDays(s.id);
      if (appleNet(a)) addTo(money[d], s.currency, appleNet(a));
      for (const [cc, v] of Object.entries(a.other)) addTo(money[d], cc, v);
      count[d] += a.units;
    }
  }

  const names = new Map(sites.map((s) => [s.id, s.name]));
  const payment = (r: PaymentRow) => ({
    ts: r.ts,
    amount: major(r.amount, r.currency),
    currency: r.currency,
    product: r.product ?? '',
    provider: r.provider,
    source: r.source && r.channel !== 'Direct' ? r.source : null,
  });
  const latestBySite = new Map((latestSiteRows.results as unknown as PaymentRow[]).map((r) => [r.site_id, r]));

  const [todayRevenue, sameRevenue] = moneyLists(todayMoney, sameMoney, sites[0]?.currency ?? 'USD');
  const siteVisitors = (id: string) => visitors.get(id) ?? new Array(SPAN).fill(0);

  // Per site: [7 days, 30 days, the 7 before, the 30 before].
  const windowCounts = new Map<string, { v: number[]; c: number[] }>();
  for (const r of windowRows.results as unknown as WindowRow[]) {
    const e = windowCounts.get(r.site_id) ?? { v: [0, 0, 0, 0], c: [0, 0, 0, 0] };
    e[r.k] = [r.n7, r.n30, r.p7, r.p30];
    windowCounts.set(r.site_id, e);
  }

  // The currency the windows add every site into (totalCurrency above), and its rate per currency and day label: the
  // currencies with money in the windows, from the rates read ahead (a third round trip only to fill missing days).
  const needed = new Set<string>([totalCurrency]);
  for (const days of [...revenue.values(), [...partMoney.values()]]) for (const day of days) for (const [cc, minor] of day) if (minor) needed.add(cc);
  const perEur = await narrowRates(db, await ratesP, wideSet, needed, labels[0], labels[labels.length - 1], fetch, now);
  const toTotal = (cc: string, day: string) => {
    const from = perEur(cc, day);
    const to = perEur(totalCurrency, day);
    return from === null || to === null ? null : from / to;
  };
  const windows = Object.fromEntries(
    (Object.keys(WINDOWS) as WindowKey[]).map((key) => {
      const first = firstOf(key);
      const at = key === '7d' ? 0 : 1;
      const money = new Map<string, number>();
      const missing = new Map<string, number>();
      const days = labels.slice(first).map((date) => ({ date, visitors: 0, revenueTotal: 0 }));
      const siteWindows = new Map<string, { visitors: number; customers: number; purchases: number; revenue: number }>();
      for (const s of sites) {
        const counts = windowCounts.get(s.id);
        const byDay = revenue.get(s.id);
        let siteRevenue = 0;
        for (let d = first; d < SPAN; d++) {
          days[d - first].visitors += siteVisitors(s.id)[d];
          for (const [cc, minor] of byDay?.[d] ?? []) {
            addTo(money, cc, minor);
            if (cc === s.currency) siteRevenue += minor;
            const rate = toTotal(cc, labels[d]);
            if (rate === null) addTo(missing, cc, minor);
            else days[d - first].revenueTotal += major(minor, cc) / rate;
          }
        }
        siteWindows.set(s.id, {
          visitors: counts?.v[at] ?? 0,
          customers: counts?.c[at] ?? 0,
          purchases: (dayPurchases.get(s.id) ?? []).slice(first).reduce((n, v) => n + v, 0),
          revenue: major(siteRevenue, s.currency),
        });
      }
      const all = [...siteWindows.values()];
      const [windowRevenue] = moneyLists(money, new Map(), sites[0]?.currency ?? 'USD');
      // The window before: whole days, then its last day up to the same time of day, each day at its own rate.
      const before = prevOf(key);
      let beforeTotal = 0;
      const toMajor = (day: number) => (cc: string, minor: number) => {
        const rate = toTotal(cc, labels[day]);
        return rate === null ? 0 : major(minor, cc) / rate;
      };
      for (let d = before.first; d < before.last; d++) {
        for (const s of sites) for (const [cc, minor] of revenue.get(s.id)?.[d] ?? []) beforeTotal += toMajor(d)(cc, minor);
      }
      for (const [cc, minor] of partMoney.get(before.last) ?? []) beforeTotal += toMajor(before.last)(cc, minor);
      return [
        key,
        {
          from: labels[first],
          to: labels[T],
          visitors: all.reduce((n, w) => n + w.visitors, 0),
          customers: all.reduce((n, w) => n + w.customers, 0),
          purchases: all.reduce((n, w) => n + w.purchases, 0),
          revenue: windowRevenue,
          totalCurrency,
          revenueTotal: cents(days.reduce((n, d) => n + d.revenueTotal, 0)),
          notConverted: [...missing].map(([currency, minor]) => ({ currency, amount: major(minor, currency) })),
          days: days.map((d) => ({ ...d, revenueTotal: cents(d.revenueTotal) })),
          previous: {
            from: labels[before.first],
            to: labels[before.last],
            visitors: sites.reduce((n, s) => n + (windowCounts.get(s.id)?.v[at + 2] ?? 0), 0),
            customers: sites.reduce((n, s) => n + (windowCounts.get(s.id)?.c[at + 2] ?? 0), 0),
            revenueTotal: cents(beforeTotal),
          },
          sites: siteWindows,
        },
      ];
    }),
  ) as Record<WindowKey, PeriodBlock & { sites: Map<string, SiteWindow> }>;

  const appStore = await appStoreP;
  return {
    generatedAt: now,
    today: {
      visitors: sites.reduce((n, s) => n + siteVisitors(s.id)[T], 0),
      visitorsYesterdaySamePoint: sites.reduce((n, s) => n + (sameVisitors.get(s.id) ?? 0), 0),
      purchases: [...purchases.values()].reduce((n, v) => n + v, 0),
      revenue: todayRevenue,
      revenueYesterdaySamePoint: sameRevenue,
    },
    sites: sites.map((s) => {
      const v = siteVisitors(s.id);
      const rev = (d: number) => major(revenue.get(s.id)?.[d].get(s.currency) ?? 0, s.currency);
      const latest = latestBySite.get(s.id);
      return {
        id: s.id,
        name: s.name,
        kind: hasApp(s) && !s.has_web ? ('app' as const) : ('web' as const),
        currency: s.currency,
        today: { visitors: v[T], purchases: purchases.get(s.id) ?? 0, revenue: rev(T) },
        last7: labels.slice(SPAN - 7).map((date, i) => ({ date, visitors: v[SPAN - 7 + i], revenue: rev(SPAN - 7 + i) })),
        last30: labels.slice(SPAN - DAYS).map((date, i) => ({ date, visitors: v[SPAN - DAYS + i], revenue: rev(SPAN - DAYS + i) })),
        periods: { '7d': windows['7d'].sites.get(s.id)!, '30d': windows['30d'].sites.get(s.id)! },
        latestPayment: latest ? payment(latest) : null,
        // The latest App Store Connect sales day (docs/MOBILE-API.md section 5).
        appStore: appStore.get(s.id) ?? null,
      };
    }),
    periods: { '7d': withoutSites(windows['7d']), '30d': withoutSites(windows['30d']) },
    sinceYesterday: sites.length ? await yesterday : null,
    latest: (latestRows.results as unknown as PaymentRow[]).map((r) => ({ siteId: r.site_id, siteName: names.get(r.site_id) ?? '', ...payment(r) })),
  };
}

interface SiteWindow {
  visitors: number;
  customers: number;
  purchases: number;
  /** In the site currency. */
  revenue: number;
}

interface PeriodBlock {
  from: string;
  to: string;
  visitors: number;
  customers: number;
  purchases: number;
  revenue: Money[];
  totalCurrency: string;
  revenueTotal: number;
  notConverted: Money[];
  days: { date: string; visitors: number; revenueTotal: number }[];
  /**
   * The window before, as long: its days, then its last day up to the time of day it is now. Visitors and new
   * customers are distinct over it; revenueTotal is in totalCurrency, the last day counting payment rows only.
   */
  previous: { from: string; to: string; visitors: number; customers: number; revenueTotal: number };
}

const cents = (v: number) => Math.round(v * 100) / 100;
const withoutSites = ({ sites: _, ...block }: PeriodBlock & { sites: unknown }): PeriodBlock => block;

