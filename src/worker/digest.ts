import type { Env, Site } from './env';
import { countedAllSql } from './datacenter';
import { allChannels, broadcast, deliver, fmtInt, parseAlerts, parseSites, wants, type AlertKind, type AlertMessage, type ChannelRow } from './alerts';
import { messageEvent, perSiteEvents, recordEvents, type NewEvent } from './alert-events';
import type { Context } from 'hono';
import type { AppEnv } from './env';
import { attention, home, MIN_BASE, weekWindow, type AttentionItem, type Money } from './home';
import { KEPT_CREDIT, KEPT_SOURCE_SQL, type RevenueBasis } from './revenue';
import { midnight } from './lib/time';
import { currencyDecimals } from './payments';
import { convertPayments } from './fx';
import { cacheKey, cached, noReadScope, readKeyOf, setToken, SHARE_TTL } from './share';
import { deviceFromBearer, sessionRole } from './auth';
import { addVersionNotes } from './notes';
import { formatMoney } from './notify';
import { REAL } from './stats';
import { alertToday, stoppedProviders, stoppedText, type StoppedProvider } from './silence';
import { batchingDb } from './lib/d1-trace';
import type { SiteGoal } from './primary-goal';
import { headlineOf, type ProductNumbers, type ProductType } from './product-type';
import { reportingTimezone } from './reporting';
// Last, so every module this file needs has loaded before Pro's tree (which imports them back) does.
import { proHooks } from './pro-hooks';
import { appHostSql, hasApp, webHostSql } from '../shared/platform';

/**
 * The scheduled alerts (docs/GUIDE.md, "Alerts and weekly report"): "worth a look" every day when there is
 * something, the weekly report on Mondays, and notes for new app versions. Apart from alerts.ts, because these read
 * the home page's numbers, and the payment path must not load the stats code while it loads itself.
 */

/** The alerts cron in wrangler.jsonc: daily alerts, app version notes and, on Mondays, the weekly report. */
export const ALERTS_CRON = '0 7 * * *';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- worth a look, daily

const utcMidnight = (t: number) => Math.floor(t / DAY) * DAY;

type AttentionRow = Parameters<typeof attention>[0][number];
const kpis = (visitors: number): AttentionRow['current'] => ({
  visitors,
  sessions: 0,
  bounceRate: 0,
  avgDuration: 0,
  customers: 0,
  trials: 0,
  payments: 0,
  revenue: {},
  appStoreRevenue: {},
});

/**
 * The home page's "worth a look" for the daily alert: sites that went quiet, and visitors yesterday against the same
 * weekday a week before, so a normal weekend dip stays out. A quiet site is reported on its first quiet day and
 * then once a week. Sales have their own alerts, so first sales stay out.
 */
export async function dailyItems(db: D1Database, now: number): Promise<AttentionItem[]> {
  const end = utcMidnight(now);
  const yStart = end - DAY;
  const wStart = yStart - 7 * DAY;
  const [sites, counts, last] = await db.batch([
    db.prepare('SELECT * FROM sites ORDER BY created_at'),
    db
      .prepare(
        `SELECT site_id, COUNT(DISTINCT CASE WHEN started_at >= ?1 THEN visitor_id END) AS cur,
                COUNT(DISTINCT CASE WHEN started_at < ?2 THEN visitor_id END) AS prev
         FROM sessions WHERE site_id IN (SELECT id FROM sites) AND started_at >= ?3 AND started_at < ?4
           AND (started_at >= ?1 OR started_at < ?2)${countedAllSql('sessions')} GROUP BY site_id`,
      )
      .bind(yStart, wStart + DAY, wStart, end),
    db
      .prepare(
        `SELECT st.id AS site_id, (SELECT MAX(started_at) FROM sessions WHERE site_id = st.id) AS last,
                EXISTS (SELECT 1 FROM sessions w WHERE w.site_id = st.id AND w.started_at > ?
                          AND ${webHostSql('w.hostname')}) AS web
         FROM sites st`,
      )
      .bind(now - 90 * DAY),
  ]);
  const count = new Map((counts.results as any[]).map((r) => [r.site_id as string, r]));
  const seen = new Map((last.results as any[]).map((r) => [r.site_id as string, r]));
  const rows: AttentionRow[] = (sites.results as unknown as Site[]).map((s) => ({
    id: s.id,
    name: s.name,
    domain: s.domain,
    createdAt: s.created_at,
    kind: hasApp(s) ? (seen.get(s.id)?.web ? 'both' : 'app') : 'web',
    lastSeen: seen.get(s.id)?.last ?? null,
    current: kpis(count.get(s.id)?.cur ?? 0),
    previous: kpis(count.get(s.id)?.prev ?? 0),
  }));
  const lastSeen = new Map(rows.map((r) => [r.id, r.lastSeen]));
  return attention(rows, now).filter((a) => {
    if (a.kind === 'traffic_up' || a.kind === 'traffic_down') return true;
    if (a.kind !== 'quiet') return false;
    const days = Math.floor((now - (lastSeen.get(a.siteId) ?? now)) / HOUR / 24);
    return days === 1 || days % 7 === 0;
  });
}

export function dailyMessage(items: AttentionItem[]): AlertMessage {
  const traffic = items.some((a) => a.kind === 'traffic_up' || a.kind === 'traffic_down');
  return {
    kind: 'daily',
    title: 'Worth a look',
    lines: [...items.map((a) => a.text), ...(traffic ? ['', 'Visitor numbers compare yesterday (UTC) with the same day a week before.'] : [])],
    data: { items: items.map((a) => ({ site_id: a.siteId, kind: a.kind, text: a.text })) },
  };
}

// ---------- payments stopped arriving, daily

/** One message for the providers that stopped sending payments (src/worker/silence.ts). */
const utcText = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function stoppedMessage(list: StoppedProvider[]): AlertMessage {
  return {
    kind: 'payments_stopped',
    title: list.length === 1 ? `Payments stopped arriving on ${list[0].siteName}` : 'Payments stopped arriving',
    lines: list.map(stoppedText),
    data: {
      items: list.map((s) => ({
        site_id: s.siteId,
        site_name: s.siteName,
        provider: s.provider,
        last_payment_at: new Date(s.last).toISOString(),
        days: s.days,
        usual: s.usual,
        text: stoppedText(s),
      })),
    },
  };
}

// ---------- the weekly report

/** What a Pro field adds to a JSON answer when Pro is absent: nothing, typed so the answer keeps an open shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NO_FIELDS: Record<string, any> = {};

export interface DigestSite {
  id: string;
  name: string;
  currency: string;
  /** Web and app visitors together, as on the home page's site cards. The report shows them apart. */
  visitors: number;
  prevVisitors: number;
  /** Visitors of web sessions. */
  webVisitors: number;
  prevWebVisitors: number;
  /** App visitors: visitor ids of app sessions (a device per day without consent, docs/APP-API.md section 3). */
  appVisitors: number;
  prevAppVisitors: number;
  revenue: Money;
  prevRevenue: Money;
  customers: number;
  prevCustomers: number;
  /** MRR at the end of the week and at its start, in the site's currency (minor units); null without subscriptions. */
  mrr: { mrr: number; mrrStart: number; active: number } | null;
  /** Up to 3, most revenue first, in the site's currency (minor units). */
  topSources: { label: string; revenue: number }[];
  /** Up to 3 web pages, most visitors first. */
  topPages: { path: string; visitors: number }[];
  /** Up to 3 app screens, most visitors first. */
  topScreens: { path: string; visitors: number }[];
  /** Up to 3 products by revenue, in the site's currency (minor units); payments without a product stay out. */
  topProducts: { product: string; revenue: number }[];
  /** The primary goal in the week and the week before (src/worker/primary-goal.ts); null when none is picked. */
  goal?: SiteGoal | null;
  /** What `revenue` adds up (revenueBasis in src/worker/revenue.ts); null without revenue. */
  basis?: RevenueBasis | null;
  /** website, app, extension or newsletter, and an extension's or a newsletter's numbers (src/worker/product-type.ts). */
  type?: ProductType;
  product?: ProductNumbers | null;
  /**
   * What Pro adds to the site (the `digest` hook, src/worker/pro-hooks.ts): keywordMoves, pagesLosing, paid, organic,
   * subs and actions. Core copies them into the alert's data and reads them only through the hook.
   */
  [pro: string]: unknown;
}

export interface Digest {
  /** Monday 00:00 to the next Monday 00:00 in `tz` (the reporting timezone for the Monday report). */
  from: number;
  to: number;
  /** The timezone the days start in; absent means UTC. */
  tz?: string;
  /** The Monday and the Sunday, YYYY-MM-DD in `tz`. */
  fromDay?: string;
  toDay?: string;
  sites: DigestSite[];
  /** Pro's part of the report, copied in by the hook: `changes`, the changes logged in the week and the verdicts that came in. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changes?: any;
}

/** Monday 00:00 UTC of the week `now` falls in. */
export const weekStart = (now: number) => {
  const d = utcMidnight(now);
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
};

/** Sessions of the app: their hostname is `ios:<bundle id>` or `android:<package>`. */
const APP_SESSION = appHostSql('s.hostname');

/**
 * The last full week, Monday to Sunday in `tz` (default: the reporting timezone, src/worker/reporting.ts), against the
 * week before. `weekOf` picks the week: the last full one before the week `weekOf` falls in, in `tz` (default `now`). Revenue, new
 * customers and MRR come from the home page's numbers, so the report matches the dashboard and the last week of Home's
 * weekly sparkline (weekWindow); visitors per platform, sources and pages are one query each.
 */
export async function buildDigest(db: D1Database, now: number, tzParam?: string, weekOf = now): Promise<Digest> {
  const tz = tzParam ?? (await reportingTimezone(db)).timezone;
  const w = weekWindow(weekOf, tz);
  const fromDay = w.labels[w.labels.length - 1];
  const to = w.to;
  const from = midnight(fromDay, tz);
  const toDay = new Date(Date.parse(`${fromDay}T00:00:00Z`) + 6 * DAY).toISOString().slice(0, 10);
  // The home page's '7d' ends at `now` and starts at midnight 6 days before: Monday to Sunday with now just before Monday.
  const h = await home(db, { period: '7d', tz }, to - 1, { sinceYesterday: false, changes: false });
  if (!h.sites.length) return { from, to, tz, fromDay, toDay, sites: [] };
  // Pro's parts (changes and verdicts, keyword moves, pages losing clicks, paid, organic, subscriptions, next actions):
  // started now, so their reads leave in the same batches as the ones below.
  const extra = proHooks()?.digest?.weekly?.({ db, sites: h.sites, from, to, tz, fromDay, toDay });
  const [platforms, sources, pages, products] = await db.batch([
    db
      .prepare(
        `SELECT s.site_id, (s.started_at >= ?1) AS cur, ${APP_SESSION} AS app, COUNT(DISTINCT s.visitor_id) AS visitors
         FROM sessions s WHERE s.site_id IN (SELECT id FROM sites) AND s.started_at >= ?2 AND s.started_at < ?3${countedAllSql('s')}
         GROUP BY s.site_id, cur, app`,
      )
      .bind(from, from - (to - from), to),
    db
      .prepare(
        `SELECT p.site_id, ${KEPT_SOURCE_SQL} AS label,
                SUM(CASE WHEN p.currency = st.currency THEN p.amount ELSE COALESCE(p.amount_conv, 0) END) AS revenue
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id JOIN sites st ON st.id = p.site_id
         WHERE p.ts >= ? AND p.ts < ? AND ${REAL} AND ${KEPT_CREDIT} GROUP BY 1, 2`,
      )
      .bind(from, to),
    // Web pages and app screens apart: a screen is stored as a pageview of the app's session.
    db
      .prepare(
        `SELECT site_id, app, path, visitors FROM (
           SELECT e.site_id, ${APP_SESSION} AS app, e.path, COUNT(DISTINCT e.visitor_id) AS visitors,
                  ROW_NUMBER() OVER (PARTITION BY e.site_id, ${APP_SESSION} ORDER BY COUNT(DISTINCT e.visitor_id) DESC, e.path) AS rn
           FROM events e JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
           WHERE e.site_id IN (SELECT id FROM sites) AND e.ts >= ? AND e.ts < ? AND e.type = 'pageview' AND e.path IS NOT NULL
           GROUP BY e.site_id, app, e.path)
         WHERE rn <= 3 ORDER BY site_id, app, rn`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT p.site_id, p.product,
                SUM(CASE WHEN p.currency = st.currency THEN p.amount ELSE COALESCE(p.amount_conv, 0) END) AS revenue
         FROM payments p JOIN sites st ON st.id = p.site_id
         WHERE p.ts >= ? AND p.ts < ? AND ${REAL} AND p.product IS NOT NULL AND p.product != '' GROUP BY p.site_id, p.product`,
      )
      .bind(from, to),
  ]);
  const visits = new Map<string, { web: number; prevWeb: number; app: number; prevApp: number }>();
  for (const r of platforms.results as any[]) {
    if (!visits.has(r.site_id)) visits.set(r.site_id, { web: 0, prevWeb: 0, app: 0, prevApp: 0 });
    const v = visits.get(r.site_id)!;
    const key = r.app ? (r.cur ? 'app' : 'prevApp') : r.cur ? 'web' : 'prevWeb';
    v[key] += Number(r.visitors);
  }
  const topSources = new Map<string, { label: string; revenue: number }[]>();
  for (const r of sources.results as any[]) {
    if (!(r.revenue > 0)) continue;
    if (!topSources.has(r.site_id)) topSources.set(r.site_id, []);
    topSources.get(r.site_id)!.push({ label: r.label ?? 'Direct', revenue: r.revenue });
  }
  const topProducts = new Map<string, { product: string; revenue: number }[]>();
  for (const r of products.results as any[]) {
    if (!(r.revenue > 0)) continue;
    if (!topProducts.has(r.site_id)) topProducts.set(r.site_id, []);
    topProducts.get(r.site_id)!.push({ product: r.product, revenue: r.revenue });
  }
  const topPages = new Map<string, { path: string; visitors: number }[]>();
  const topScreens = new Map<string, { path: string; visitors: number }[]>();
  for (const r of pages.results as any[]) {
    const m = r.app ? topScreens : topPages;
    if (!m.has(r.site_id)) m.set(r.site_id, []);
    m.get(r.site_id)!.push({ path: r.path, visitors: r.visitors });
  }
  const more = await extra;
  return {
    from,
    to,
    tz,
    fromDay,
    toDay,
    ...more?.report,
    sites: h.sites.map((s) => {
      const v = visits.get(s.id) ?? { web: 0, prevWeb: 0, app: 0, prevApp: 0 };
      return {
        id: s.id,
        name: s.name,
        currency: s.currency,
        visitors: s.current.visitors,
        prevVisitors: s.previous.visitors,
        // An extension's or a newsletter's sessions are no web visits: its own numbers stand in for them.
        webVisitors: s.product ? 0 : v.web,
        prevWebVisitors: s.product ? 0 : v.prevWeb,
        appVisitors: v.app,
        prevAppVisitors: v.prevApp,
        revenue: s.current.revenue,
        prevRevenue: s.previous.revenue,
        customers: s.current.customers,
        prevCustomers: s.previous.customers,
        // MRR at the end of the week and at its start (pro/worker/subscription-metrics.ts mrrBySite, through home()).
        mrr: s.subscriptions ? { mrr: s.subscriptions.mrr, mrrStart: s.subscriptions.mrrStart, active: s.subscriptions.active } : null,
        topSources: (topSources.get(s.id) ?? []).sort((a, b) => b.revenue - a.revenue).slice(0, 3),
        topPages: topPages.get(s.id) ?? [],
        topScreens: topScreens.get(s.id) ?? [],
        topProducts: (topProducts.get(s.id) ?? []).sort((a, b) => b.revenue - a.revenue).slice(0, 3),
        goal: s.goal,
        // What the week's revenue adds up (revenueBasis), for the report's basis line.
        basis: s.basis,
        type: s.type,
        product: s.product,
        ...more?.sites.get(s.id),
      };
    }),
  };
}

const nonZero = (m: Money) => Object.entries(m).filter(([, v]) => v !== 0);

/** "$990.00" or "€120.00 + $40.00"; "none" for none. */
function moneyText(m: Money, first: string): string {
  const list = nonZero(m).sort(([a], [b]) => (a === first ? -1 : b === first ? 1 : a.localeCompare(b)));
  return list.length ? list.map(([cc, v]) => formatMoney(v, cc)).join(' + ') : 'none';
}

const pct = (diff: number, prev: number) => `${diff > 0 ? '+' : '-'}${Math.round((Math.abs(diff) / prev) * 100)}%`;

/**
 * A count's change: "+12% (+81)", or "+5" alone on a small base, "no change". Below MIN_BASE a percentage says
 * little, so only the count shows.
 */
export function changeText(cur: number, prev: number): string {
  if (cur === prev) return 'no change';
  const abs = `${cur > prev ? '+' : '-'}${fmtInt(Math.abs(cur - prev))}`;
  return prev < MIN_BASE ? abs : `${pct(cur - prev, prev)} (${abs})`;
}

/**
 * A money change in the same shape as changeText: "+12% (+$106.00)", or the amount alone when the week before had
 * none. Null when either week has another currency than `currency`: amounts in two currencies don't subtract.
 */
export function moneyChange(cur: Money, prev: Money, currency: string): string | null {
  const cc = new Set([...nonZero(cur), ...nonZero(prev)].map(([c]) => c));
  if (cc.size > 1 || (cc.size === 1 && !cc.has(currency))) return null;
  const now = cur[currency] ?? 0;
  const before = prev[currency] ?? 0;
  const d = now - before;
  if (d === 0) return 'no change';
  const abs = `${d > 0 ? '+' : '-'}${formatMoney(Math.abs(d), currency)}`;
  return before > 0 ? `${pct(d, before)} (${abs})` : abs;
}

function sumMoney(list: Money[]): Money {
  const out: Money = {};
  for (const m of list) for (const [cc, v] of Object.entries(m)) out[cc] = (out[cc] ?? 0) + v;
  return out;
}

/** What the report shows for one site, or for all sites together. MRR is per currency; null when no site has subscriptions. */
interface ReportRow {
  webVisitors: number;
  prevWebVisitors: number;
  appVisitors: number;
  prevAppVisitors: number;
  revenue: Money;
  prevRevenue: Money;
  customers: number;
  mrr: Money | null;
  mrrStart: Money | null;
  subscriptions: number;
}

const rowOf = (s: DigestSite): ReportRow => ({
  webVisitors: s.webVisitors,
  prevWebVisitors: s.prevWebVisitors,
  appVisitors: s.appVisitors,
  prevAppVisitors: s.prevAppVisitors,
  revenue: s.revenue,
  prevRevenue: s.prevRevenue,
  customers: s.customers,
  mrr: s.mrr ? { [s.currency]: s.mrr.mrr } : null,
  mrrStart: s.mrr ? { [s.currency]: s.mrr.mrrStart } : null,
  subscriptions: s.mrr?.active ?? 0,
});

function totalRow(list: DigestSite[]): ReportRow {
  const rows = list.map(rowOf);
  const subs = rows.filter((r) => r.mrr);
  return {
    webVisitors: rows.reduce((n, r) => n + r.webVisitors, 0),
    prevWebVisitors: rows.reduce((n, r) => n + r.prevWebVisitors, 0),
    appVisitors: rows.reduce((n, r) => n + r.appVisitors, 0),
    prevAppVisitors: rows.reduce((n, r) => n + r.prevAppVisitors, 0),
    revenue: sumMoney(rows.map((r) => r.revenue)),
    prevRevenue: sumMoney(rows.map((r) => r.prevRevenue)),
    customers: rows.reduce((n, r) => n + r.customers, 0),
    mrr: subs.length ? sumMoney(subs.map((r) => r.mrr!)) : null,
    mrrStart: subs.length ? sumMoney(subs.map((r) => r.mrrStart!)) : null,
    subscriptions: rows.reduce((n, r) => n + r.subscriptions, 0),
  };
}

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;
export const withChange = (value: string, change: string | null) => (change ? `${value}, ${change}` : value);

/**
 * The lines for one site or the total: revenue first, then web and app apart, never added up, then MRR. Without
 * `showRevenue` (a read key that hides revenue) the revenue and MRR lines stay out.
 */
function reportLines(name: string, r: ReportRow, currency: string, showRevenue = true, goal: SiteGoal | null = null, product: ProductNumbers | null = null): string[] {
  const hasRevenue = nonZero(r.revenue).length || nonZero(r.prevRevenue).length;
  const revenue = withChange(moneyText(r.revenue, currency), hasRevenue ? moneyChange(r.revenue, r.prevRevenue, currency) : null);
  // An extension or a newsletter leads with its own numbers, and skips visitors and an empty revenue line.
  if (product) {
    const lines = productLines(name, product);
    if (showRevenue && hasRevenue) lines.push(`Revenue: ${revenue}${r.customers ? `, ${plural(r.customers, 'new customer', 'new customers')}` : ''}`);
    if (goal) lines.push(goalLine(goal));
    return lines;
  }
  const lines = [name];
  if (showRevenue) lines.push(`Revenue: ${revenue}${r.customers ? `, ${plural(r.customers, 'new customer', 'new customers')}` : ''}`);
  if (r.webVisitors || r.prevWebVisitors || (!r.appVisitors && !r.prevAppVisitors)) {
    lines.push(`Web visitors: ${withChange(fmtInt(r.webVisitors), changeText(r.webVisitors, r.prevWebVisitors))}`);
  }
  if (r.appVisitors || r.prevAppVisitors) lines.push(`App visitors: ${withChange(fmtInt(r.appVisitors), changeText(r.appVisitors, r.prevAppVisitors))}`);
  // The primary goal: "Signups: 41, -12% (-6)".
  if (goal) lines.push(goalLine(goal));
  if (showRevenue && r.mrr && (nonZero(r.mrr).length || nonZero(r.mrrStart!).length)) {
    const mrr = withChange(moneyText(r.mrr, currency), moneyChange(r.mrr, r.mrrStart!, currency));
    lines.push(`MRR: ${mrr}, ${plural(r.subscriptions, 'paying subscription', 'paying subscriptions')}`);
  }
  return lines;
}

/** "Signups: 41, -12% (-6)": the primary goal's visitors in the week against the week before. */
const goalLine = (g: SiteGoal) => `${g.label}: ${withChange(fmtInt(g.count), changeText(g.count, g.previous))}`;

/**
 * An extension's or a newsletter's lines: "Tabsaver: 1,240 weekly active, +4% (+48)", then the type's other numbers,
 * such as "Installs: 86, +12% (+9)".
 */
export function productLines(name: string, p: ProductNumbers): string[] {
  const h = headlineOf(p);
  return [
    `${name}: ${withChange(`${fmtInt(h.value)} ${h.label.toLowerCase()}`, changeText(h.value, h.previous))}`,
    ...p.metrics.filter((m) => m.key !== p.headline).map((m) => `${m.label}: ${withChange(fmtInt(m.value), changeText(m.value, m.previous))}`),
  ];
}

const productList = (s: DigestSite) => s.topProducts.map((x) => `${x.product} ${formatMoney(x.revenue, s.currency)}`).join(', ');

/** The top lists under a site's numbers. Products and sources by revenue only with `showRevenue`. */
function detailLines(s: DigestSite, showRevenue = true): string[] {
  return [
    showRevenue && s.topProducts?.length ? `Top products: ${productList(s)}` : '',
    showRevenue && s.topSources.length ? `Top sources by revenue: ${s.topSources.map((x) => `${x.label} ${formatMoney(x.revenue, s.currency)}`).join(', ')}` : '',
    s.topPages.length ? `Top pages: ${s.topPages.map((p) => p.path).join(', ')}` : '',
    s.topScreens?.length ? `Top screens: ${s.topScreens.map((p) => p.path.replace(/^\//, '')).join(', ')}` : '',
    // Pro: keyword ranks, pages losing clicks, ad spend, Google and AI numbers, subscriptions and the next actions.
    ...(proHooks()?.digest?.siteLines?.(s, showRevenue) ?? []),
  ].filter(Boolean);
}

const dayLabel = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Oct 26 to Nov 1 (UTC)": the week's days in the digest's timezone. */
const weekSpan = (d: Digest) => {
  const days = d.fromDay && d.toDay ? [Date.parse(`${d.fromDay}T00:00:00Z`), Date.parse(`${d.toDay}T00:00:00Z`)] : [d.from, d.to - DAY];
  return `${dayLabel(days[0])} to ${dayLabel(days[1])}`;
};
const tzName = (d: Digest) => d.tz ?? 'UTC';

const activeSite = (s: DigestSite) =>
  s.webVisitors || s.prevWebVisitors || s.appVisitors || s.prevAppVisitors || s.visitors || s.prevVisitors ||
  s.product?.metrics.some((m) => m.value || m.previous) ||
  nonZero(s.revenue).length || nonZero(s.prevRevenue).length || (s.mrr && (s.mrr.mrr || s.mrr.mrrStart));

/**
 * The weekly report for the sites in `siteIds` (null: all). Sites with no visits, no revenue and no MRR in both weeks
 * are left out. Plain text that reads the same in Slack, Discord and Telegram, plus a simple HTML table for email.
 */
/**
 * What the report's revenue adds up, from each site's basis: payments net of refunds, App Store sales at the customer
 * price, or both. Null when no site had revenue.
 */
export function basisLine(bases: (RevenueBasis | null)[]): string | null {
  const net = bases.some((b) => b === 'net_of_refunds' || b === 'mixed');
  const apple = bases.some((b) => b === 'app_store_gross' || b === 'mixed');
  if (net && apple) return "Revenue adds payments net of refunds and App Store sales at the customer price, before Apple's cut.";
  if (apple) return "Revenue is App Store sales at the customer price, before Apple's cut.";
  if (net) return 'Revenue is payments net of refunds.';
  return null;
}

export function digestMessage(d: Digest, siteIds: string[] | null, showRevenue = true): AlertMessage {
  const all = d.sites.filter((s) => !siteIds || siteIds.includes(s.id));
  const active = all
    .filter(activeSite)
    .sort((a, b) => (b.revenue[b.currency] ?? 0) - (a.revenue[a.currency] ?? 0) || b.visitors - a.visitors);
  const span = weekSpan(d);
  const total = totalRow(all);
  const first = all[0]?.currency ?? 'USD';
  const basis = showRevenue ? basisLine(all.map((s) => s.basis ?? null)) : null;
  const lines = [`${span} (${tzName(d)}), compared with the week before.`, ...(basis ? [basis] : []), ''];
  if (all.length > 1) lines.push(...reportLines('All sites', total, first, showRevenue), '');
  // The week's changes and the verdicts that came in (Pro).
  const part = proHooks()?.digest?.reportPart?.(d, siteIds, showRevenue);
  const changeNote = part?.lines ?? null;
  if (changeNote) lines.push(...changeNote, '');
  for (const s of active) lines.push(...reportLines(s.name, rowOf(s), s.currency, showRevenue, s.goal ?? null, s.product ?? null), ...detailLines(s, showRevenue), '');
  const idle = all.length - active.length;
  if (!active.length) lines.push('No visits and no revenue on any site in either week.');
  else if (idle) lines.push(`${idle} more ${idle === 1 ? 'site' : 'sites'} had no visits and no revenue in either week.`);
  while (lines[lines.length - 1] === '') lines.pop();

  // Email: one row per site; the app and MRR columns only when a site has them.
  const anyApp = all.some((s) => s.appVisitors || s.prevAppVisitors);
  const anyMrr = all.some((s) => s.mrr);
  const td = 'padding:6px 10px;border-bottom:1px solid #efedea;vertical-align:top';
  const small = (t: string | null) => (t ? `<br><span style="color:#78716c;font-size:12px">${escapeHtml(t)}</span>` : '');
  const count = (cur: number, prev: number) => `<td style="${td};text-align:right">${fmtInt(cur)}${small(cur || prev ? changeText(cur, prev) : null)}</td>`;
  const row = (name: string, r: ReportRow, currency: string, extra = '') => {
    const rc = nonZero(r.revenue).length || nonZero(r.prevRevenue).length ? moneyChange(r.revenue, r.prevRevenue, currency) : null;
    const mrr = r.mrr
      ? `<td style="${td};text-align:right">${escapeHtml(moneyText(r.mrr, currency))}${small(moneyChange(r.mrr, r.mrrStart!, currency))}</td>`
      : `<td style="${td};text-align:right;color:#a8a29e">-</td>`;
    return `<tr><td style="${td}"><b>${escapeHtml(name)}</b>${extra}</td>
${count(r.webVisitors, r.prevWebVisitors)}${anyApp ? count(r.appVisitors, r.prevAppVisitors) : ''}
<td style="${td};text-align:right">${escapeHtml(moneyText(r.revenue, currency))}${small(rc)}</td>${anyMrr ? mrr : ''}
<td style="${td};text-align:right">${fmtInt(r.customers)}</td></tr>`;
  };
  const detail = (s: DigestSite) =>
    [...(s.product ? productLines(s.name, s.product) : []), ...(s.goal ? [goalLine(s.goal)] : []), ...detailLines(s)].map(small).join('');
  const th = (t: string) => `<th style="padding:6px 10px">${t}</th>`;
  const html = `<p style="margin:0 0 12px;color:#78716c">${escapeHtml(basis ? `${lines[0]} ${basis}` : lines[0])}</p>
${changeNote ? changeNote.map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('') : ''}<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="color:#78716c;font-size:12px;text-align:right">
<th style="text-align:left;padding:6px 10px">Site</th>${th('Web visitors')}${anyApp ? th('App visitors') : ''}${th('Revenue')}${anyMrr ? th('MRR') : ''}${th('New customers')}</tr>
${all.length > 1 ? row('All sites', total, first) : ''}${active.map((s) => row(s.name, rowOf(s), s.currency, detail(s))).join('')}</table>
${idle && active.length ? `<p style="margin:12px 0 0;color:#78716c">${idle} more ${idle === 1 ? 'site' : 'sites'} had no visits and no revenue in either week.</p>` : ''}${
    active.length ? '' : '<p style="margin:12px 0 0">No visits and no revenue on any site in either week.</p>'
  }`;

  const totals = {
    // Web and app visitors together, kept for webhooks written before they were apart.
    visitors: all.reduce((n, s) => n + s.visitors, 0),
    prevVisitors: all.reduce((n, s) => n + s.prevVisitors, 0),
    webVisitors: total.webVisitors,
    prevWebVisitors: total.prevWebVisitors,
    appVisitors: total.appVisitors,
    prevAppVisitors: total.prevAppVisitors,
    revenue: total.revenue,
    prevRevenue: total.prevRevenue,
    customers: total.customers,
    mrr: total.mrr,
    mrrStart: total.mrrStart,
    subscriptions: total.subscriptions,
  };
  return {
    kind: 'weekly',
    title: `Weekly report: ${span}`,
    lines,
    html,
    data: { from: new Date(d.from).toISOString(), to: new Date(d.to).toISOString(), totals, sites: active, ...part?.data },
  };
}

// ---------- GET /api/v1/weekly: the weekly report for an agent (docs/API.md, "Weekly report")

/**
 * The weekly report as JSON: per site the sentences the Monday report sends, plus the numbers behind them, in the read
 * API's snake_case. Money is in minor units of the site currency, the way /api/v1/portfolio counts it; totals add money
 * per currency. `showRevenue` false leaves out revenue, MRR, customers and the lists by revenue, in the numbers and in
 * the sentences.
 */
export function weeklyReport(d: Digest, siteIds: string[] | null, showRevenue: boolean) {
  const msg = digestMessage(d, siteIds, showRevenue);
  const all = d.sites.filter((s) => !siteIds || siteIds.includes(s.id));
  const money = (m: Money, currency: string) => m[currency] ?? 0;
  const sorted = [...all].sort(
    (a, b) =>
      Number(!!activeSite(b)) - Number(!!activeSite(a)) ||
      (showRevenue ? money(b.revenue, b.currency) - money(a.revenue, a.currency) : 0) ||
      b.visitors - a.visitors,
  );
  const total = totalRow(all);
  const first = all[0]?.currency ?? 'USD';
  const sites = sorted.map((s) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visits: Record<string, any> = {
      id: s.id,
      name: s.name,
      currency: s.currency,
      currency_decimals: currencyDecimals(s.currency),
      active: !!activeSite(s),
      lines: [...reportLines(s.name, rowOf(s), s.currency, showRevenue, s.goal ?? null, s.product ?? null), ...detailLines(s, showRevenue)],
      // website, app, extension or newsletter, and an extension's or a newsletter's numbers (src/worker/product-type.ts).
      type: s.type ?? 'website',
      product: s.product ?? null,
      visitors: s.visitors,
      visitors_previous: s.prevVisitors,
      web_visitors: s.webVisitors,
      web_visitors_previous: s.prevWebVisitors,
      // Named before app launches were grouped into visitors; the value is app visitors (docs/API.md).
      app_launches: s.appVisitors,
      app_launches_previous: s.prevAppVisitors,
      top_pages: s.topPages,
      top_screens: s.topScreens,
      // The primary goal against the week before (src/worker/primary-goal.ts); null when none is picked.
      goal: s.goal ?? null,
      // Pro: keyword moves, pages losing clicks, Google and AI numbers, ad spend, subscriptions and next actions.
      ...(proHooks()?.digest?.siteJson?.(s, showRevenue) ?? NO_FIELDS),
    };
    if (!showRevenue) return visits;
    return {
      ...visits,
      revenue: money(s.revenue, s.currency),
      revenue_previous: money(s.prevRevenue, s.currency),
      new_customers: s.customers,
      new_customers_previous: s.prevCustomers,
      mrr: s.mrr?.mrr ?? null,
      mrr_previous: s.mrr?.mrrStart ?? null,
      paying_subscriptions: s.mrr?.active ?? null,
      top_products: s.topProducts,
      top_sources: s.topSources.map((x) => ({ source: x.label, revenue: x.revenue })),
    };
  });
  const totals = {
    sites: all.length,
    lines: reportLines('All sites', total, first, showRevenue),
    visitors: all.reduce((n, s) => n + s.visitors, 0),
    visitors_previous: all.reduce((n, s) => n + s.prevVisitors, 0),
    web_visitors: total.webVisitors,
    web_visitors_previous: total.prevWebVisitors,
    app_launches: total.appVisitors,
    app_launches_previous: total.prevAppVisitors,
    ...(showRevenue
      ? {
          revenue: total.revenue,
          revenue_previous: total.prevRevenue,
          new_customers: total.customers,
          new_customers_previous: all.reduce((n, s) => n + s.prevCustomers, 0),
          mrr: total.mrr,
          mrr_previous: total.mrrStart,
        }
      : {}),
  };
  return {
    timezone: tzName(d),
    first_day: d.fromDay ?? new Date(d.from).toISOString().slice(0, 10),
    last_day: d.toDay ?? new Date(d.to - DAY).toISOString().slice(0, 10),
    from: new Date(d.from).toISOString(),
    to: new Date(d.to).toISOString(),
    previous_from: new Date(d.from - (d.to - d.from)).toISOString(),
    previous_to: new Date(d.from).toISOString(),
    show_revenue: showRevenue,
    title: msg.title,
    text: msg.lines.join('\n'),
    // Pro: the changes logged in the week, the verdicts that came in and the ones due for review.
    ...(proHooks()?.digest?.reportPart?.(d, siteIds, showRevenue)?.data ?? NO_FIELDS),
    sites,
    totals,
  };
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * `GET /api/v1/weekly?site=&tz=`: a one-site read key gets its site; an all-sites key gets every site, or one with
 * ?site=; the dashboard login and the iPhone's token read it too, uncached, like /api/v1/portfolio. Read keys share
 * the 60 s cache.
 */
export async function weeklyRoute(c: Context<AppEnv>) {
  const askedTz = c.req.query('tz');
  if (askedTz && !validTz(askedTz)) return c.json({ error: 'tz must be an IANA timezone, such as Europe/Berlin' }, 400);
  // No ?tz=: the reporting timezone (Settings, General), the same days as Home and /api/v1/portfolio.
  const tz = askedTz || (await reportingTimezone(c.env.DB)).timezone;
  const tok = await readKeyOf(c);
  // The iPhone's bearer token reads it too, for its "Copy weekly summary" (docs/MOBILE-API.md, section 7).
  const phone = !tok && !!c.req.header('authorization') && !!(await deviceFromBearer(c));
  if (!tok && !phone && (c.req.header('authorization') || !(await sessionRole(c)))) {
    return c.json({ error: 'Send an API key with the read scope: Authorization: Bearer fdk_... (Settings, Agents)' }, 401);
  }
  const refused = tok && noReadScope(c, tok, c.req.query('site') || undefined);
  if (refused) return refused;
  let siteIds: string[] | null = tok?.sites ?? null;
  const askedSite = c.req.query('site');
  if (tok?.kind === 'api') siteIds = [tok.site_id];
  else if (askedSite) {
    const found = await c.env.DB.prepare('SELECT 1 FROM sites WHERE id = ?').bind(askedSite).first();
    if (!found) return c.json({ error: `No site has the id ${askedSite}. GET /api/v1/portfolio lists the ids.` }, 404);
    siteIds = [askedSite];
  }
  // One site: the answer's dashboard_url opens that site instead of Home (dashboard-url.ts).
  if (siteIds?.length === 1) c.set('linkSite', siteIds[0]);
  const build = async (showRevenue: boolean) => {
    if (showRevenue) await convertPayments(c.env.DB).catch(() => 0);
    return weeklyReport(await buildDigest(c.env.DB, Date.now(), tz), siteIds, showRevenue);
  };
  if (!tok) return c.json(await build(true), 200, { 'cache-control': 'private, no-store' });
  setToken(c, tok);
  return cached(c, cacheKey(c, 'weekly', ['tz']), SHARE_TTL, 'application/json', async () => JSON.stringify(await build(!!tok.show_revenue)));
}

// ---------- the daily cron

/**
 * The daily alerts at 07:00 UTC (the tick's minute 0, or the old `0 7 * * *` cron): notes for new app versions, "worth a
 * look" when there is something, "Daily numbers", "payments stopped arriving" when a provider went quiet and "ASO
 * collector stopped reporting". Each part runs on its own, so one failure does not stop the others. The checks run
 * also when no channel takes them, so the alert inbox (alert-events.ts) has them for agents: 1 row per site and message.
 * The weekly report has a tick of its own (runWeeklyReport).
 */
export async function runDailyAlerts(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch) {
  const out: { notes: number; daily: number; stopped: number; events: number } & Record<string, number> = { notes: 0, daily: 0, stopped: 0, events: 0 };
  out.notes = await addVersionNotes(env.DB, now).catch((e) => (console.error('Version notes failed', e), 0));
  const channels = await allChannels(env.DB).catch(() => [] as ChannelRow[]);
  const takes = (kind: AlertKind) => channels.some((ch) => parseAlerts(ch.alerts)[kind]);
  const events: NewEvent[] = [];
  try {
    const items = await dailyItems(env.DB, now);
    if (items.length) {
      events.push(...perSiteEvents((ids) => dailyMessage(items.filter((a) => ids.includes(a.siteId))), items));
      if (takes('daily')) {
        out.daily = await broadcast(env, 'daily', null, (ch) => {
          const sites = parseSites(ch.sites);
          const mine = items.filter((a) => !sites || sites.includes(a.siteId));
          return mine.length ? dailyMessage(mine) : null;
        }, fetchFn);
      }
    }
  } catch (e) {
    console.error('Worth a look alert failed', e);
  }
  try {
    const due = (await stoppedProviders(env.DB, now)).filter(alertToday);
    if (due.length) {
      events.push(...perSiteEvents((ids) => stoppedMessage(due.filter((s) => ids.includes(s.siteId))), due));
      if (takes('payments_stopped')) {
        out.stopped = await broadcast(env, 'payments_stopped', null, (ch) => {
          const sites = parseSites(ch.sites);
          const mine = due.filter((s) => !sites || sites.includes(s.siteId));
          return mine.length ? stoppedMessage(mine) : null;
        }, fetchFn);
      }
    }
  } catch (e) {
    console.error('Payments stopped alert failed', e);
  }
  // Pro's daily alerts ("Daily numbers" and "ASO collector stopped reporting"): their counts join `out`, their inbox rows `events`.
  Object.assign(out, await proHooks()?.digest?.daily?.({ env, now, channels, fetchFn, takes, events }));
  out.events = await recordEvents(env.DB, events, now);
  return out;
}

// ---------- the weekly report, Monday 07:05 UTC

/** A channel that refused the report is tried again on a later Monday tick, not sooner. */
const WEEKLY_RETRY_GAP_MS = 30 * 60_000;
/** The marker key in numbers_sent (migration 0069): the weekly report's, apart from the channel's Daily numbers. */
const weeklyKey = (channelId: string) => `weekly:${channelId}`;

/**
 * Monday's weekly report to every channel that takes it: on its own tick (07:05 UTC, cron.ts), so the 07:00 tick's
 * alerts and the report never share 50 subrequests. Each channel is claimed with one INSERT in numbers_sent before the
 * send (2 rows per channel and week: the claim, then sent), so a second trigger never sends it twice. Later Monday
 * ticks try again a channel that refused it, and a channel with no claim at all: the 07:05 run failed
 * before it got that far (a D1 error or the CPU limit while it built the report). The report goes to the alert inbox
 * once a week, one row per site with that site's part, on the run that makes the first claim of the day. Returns the
 * channels reached.
 */
async function sendWeekly(env: Env, now: number, fetchFn: typeof fetch): Promise<number> {
  if (new Date(now).getUTCDay() !== 1) return 0;
  const day = new Date(now).toISOString().slice(0, 10);
  const want = (await allChannels(env.DB)).filter((ch) => wants(ch, 'weekly', null) && !(parseSites(ch.sites)?.length === 0));
  if (!want.length) return 0;
  const marks = new Map(
    (
      await env.DB.prepare("SELECT channel_id, sent, tried_at FROM numbers_sent WHERE day = ? AND channel_id LIKE 'weekly:%'")
        .bind(day)
        .all<{ channel_id: string; sent: number; tried_at: number }>()
    ).results.map((r) => [r.channel_id, r]),
  );
  const todo = want.filter((ch) => {
    const m = marks.get(weeklyKey(ch.id));
    // No claim on a later tick: the 07:05 run stopped before this channel, so this tick sends it.
    return m ? !m.sent && now - m.tried_at >= WEEKLY_RETRY_GAP_MS : true;
  });
  if (!todo.length) return 0;
  // The tick runs Monday 07:05 UTC, which is still Sunday west of UTC-7: half a day later is Monday everywhere, so the
  // report covers the week that just ended in the reporting timezone. Batched like a request's reads: each batch is one
  // of the tick's 50 subrequests.
  const digest = await buildDigest(batchingDb(env.DB), now, undefined, now + 12 * 3_600_000);
  if (!digest.sites.length) return 0;
  let reached = 0;
  // The inbox rows go with the day's first claim: an earlier run that claimed a channel wrote them already.
  let recorded = marks.size > 0;
  for (const ch of todo) {
    const key = weeklyKey(ch.id);
    const claim = marks.has(key)
      ? env.DB.prepare('UPDATE numbers_sent SET tried_at = ?3 WHERE channel_id = ?1 AND day = ?2 AND sent = 0 AND tried_at <= ?4').bind(key, day, now, now - WEEKLY_RETRY_GAP_MS)
      : env.DB.prepare('INSERT OR IGNORE INTO numbers_sent (channel_id, day, sent, tried_at) VALUES (?1, ?2, 0, ?3)').bind(key, day, now);
    if (!(await claim.run()).meta.changes) continue;
    if (!recorded) {
      // One inbox row per site with that site's part of the report, so a key for one site reads its own and no other.
      recorded = true;
      await recordEvents(env.DB, digest.sites.map((site) => messageEvent(digestMessage(digest, [site.id]), site.id)), now);
    }
    const r = await deliver(env, ch, digestMessage(digest, parseSites(ch.sites)), fetchFn);
    if (!r.ok) {
      console.error(`Weekly report to ${ch.kind} channel "${ch.name}" failed`, r.status, r.error);
      continue;
    }
    await env.DB.prepare('UPDATE numbers_sent SET sent = 1 WHERE channel_id = ? AND day = ?').bind(key, day).run();
    reached++;
  }
  return reached;
}

/** Monday 07:05 UTC: the weekly report to each channel that takes it and has not had this week's. */
export function runWeeklyReport(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<number> {
  return sendWeekly(env, now, fetchFn);
}

/** Later Monday ticks: channels whose send failed today, or that no run claimed yet. One read when there is nothing to do. */
export function retryWeeklyReport(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<number> {
  return sendWeekly(env, now, fetchFn);
}
