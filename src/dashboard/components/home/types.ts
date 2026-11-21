import type { RevenueBasis } from '../BasisChip';
import type { ProductNumbers, ProductType } from '../ProductType';

// The shape of GET /api/home (src/worker/home.ts).

export type Money = Record<string, number>;
/** All proceeds in the site's currency, each day at that day's ECB rate. Amounts without a rate are in notConverted. */
export interface ConvertedProceeds { currency: string; amount: number; notConverted: { currency: string; amount: number }[] }
export interface Kpis {
  visitors: number;
  sessions: number;
  bounceRate: number;
  avgDuration: number;
  customers: number;
  payments: number;
  revenue: Money;
  /** The App Store part of revenue: Apple's report on the days it covers, App Store payments on the others. */
  appStoreRevenue: Money;
}
export type TrendStatus = 'growing' | 'flat' | 'declining' | 'quiet' | 'no_payments';
export interface SiteGoal {
  name: string;
  label: string;
  count: number;
  previous: number;
  change_pct: number | null;
}
export interface SiteRow {
  id: string;
  name: string;
  domain: string;
  currency: string;
  hasApp: boolean;
  bundleId: string | null;
  kind: 'web' | 'app' | 'both';
  createdAt: number;
  lastSeen: number | null;
  online: number;
  appVisitors: number;
  current: Kpis;
  previous: Kpis;
  topSource: { label: string; domain: string | null; visitors: number } | null;
  series: { bucket: string; visitors: number; revenue: number }[];
  /** App Store Connect downloads and proceeds for an app with no sessions in the period (amounts in major units). Its sales are in revenue already. */
  appStore: { from: string; to: string; downloads: number; proceeds: { currency: string; amount: number }[]; proceedsConverted: ConvertedProceeds } | null;
  /** MRR at the end and the start of the period, in the site's currency; null without subscriptions. */
  subscriptions?: { mrr: number; active: number; mrrStart: number } | null;
  /** False: no payment provider set up and no payment ever, so the card shows no revenue (src/worker/home.ts). */
  payments?: boolean;
  /** The verdict against the period before and the revenue change in minor units of the site currency (siteTrend in src/worker/home.ts). */
  trend: { status: TrendStatus; revenueChange: number };
  /** The site's own timezone. Its dashboard counts days in it; Home counts them in the reporting timezone. */
  timezone?: string;
  /** The last 8 full weeks, oldest first: `week` is the Monday, revenue in minor units of the site currency. */
  weekly?: { week: string; visitors: number; revenue: number }[];
  /** Weekly revenue (or visitors) falling 3 weeks in a row or more (fallingWeeks in src/worker/home.ts). */
  falling?: { metric: 'revenue' | 'visitors'; weeks: number; since: string; from: number; to: number } | null;
  /** Weeks in a row the last full weeks fell: revenue when any had some, else visitors (weeksDeclining in src/worker/home.ts). */
  weeksDeclining?: number;
  /** The primary goal in the period and the one before (src/worker/primary-goal.ts); null when none is picked. */
  goal?: SiteGoal | null;
  /** What the site's revenue adds up (revenueBasis in src/worker/revenue.ts); null without revenue. */
  basis?: RevenueBasis | null;
  /** website, app, extension or newsletter, and an extension's or a newsletter's numbers (src/worker/product-type.ts). */
  type?: ProductType;
  product?: ProductNumbers | null;
}
export interface ChangesSummary {
  count: number;
  better: number;
  worse: number;
  inconclusive: number;
  due: number;
  worst: { site_id: string; site_name: string; note_id: string; text: string; kind: string | null; actor?: string | null; change_pct: number | null; reason: string } | null;
}
/** One platform's tile numbers (src/worker/home.ts, platformTotals). */
export interface PlatformKpis {
  visitors: number;
  sessions: number;
  bounceRate: number;
  avgDuration: number;
  customers: number;
  conversionRate: number;
  newInstalls: number;
}
export type PlatformPair = { current: PlatformKpis; previous: PlatformKpis };
export interface HomeData {
  range: { from: number; to: number; granularity: 'hour' | 'day' | 'week' | 'month' };
  /** The timezone the days are counted in: the reporting timezone (Settings, General) unless the URL sent ?tz=. */
  tz: string;
  tzSource?: 'request' | 'setting' | 'sites' | 'default';
  period: string;
  minBase: number;
  sites: SiteRow[];
  totals: {
    current: Kpis;
    previous: Kpis;
    online: number;
    /** What the revenue total adds up across sites; null without revenue. */
    basis?: RevenueBasis | null;
    platforms?: { web: PlatformPair; app: PlatformPair };
    mrr?: Money | null;
    mrrStart?: Money | null;
    mrrSeries?: Money[] | null;
    /** new + expansion - churned = net = mrr - mrrStart, per currency (pro/worker/subscription-metrics.ts). */
    mrrMovement?: { new: Money; expansion: Money; churned: Money; net: Money } | null;
  };
  series: { bucket: string; visitors: number; revenue: Money }[];
  sources: { label: string; domain: string | null; channel: string; visitors: number; sites: number; customers: number; revenue: Money; appStore?: boolean; noVisit?: boolean }[];
  payments: {
    id: string;
    siteId: string;
    siteName: string;
    siteDomain: string;
    provider: string;
    ts: number;
    amount: number;
    currency: string;
    decimals: number;
    /** The amount in the site's currency, when paid in another one and converted. */
    converted: { amount: number; currency: string; decimals: number } | null;
    kind: string;
    renewal: boolean;
    product: string | null;
    visitorId: string | null;
    source: string | null;
    sourceDomain: string | null;
    country: string | null;
    platform: 'web' | 'ios' | 'android' | null;
  }[];
  /** The changes of the last 7 days, whatever the period (pro/worker/changes-summary.ts). */
  changes?: ChangesSummary | null;
  attention: {
    siteId: string;
    kind: 'no_data' | 'apps_no_data' | 'quiet' | 'payments_stopped' | 'webhook_refused' | 'traffic_up' | 'traffic_down' | 'falling' | 'first_sale' | 'search_drop';
    text: string;
    link: 'settings' | 'dashboard' | 'apps' | 'seo';
  }[];
  /** The highest next actions across sites, computed once a day (pro/worker/actions.ts); absent on an older Worker. */
  actions?: NextAction[];
}
/** One next action (pro/worker/actions-store.ts ActionItem). value is minor units of currency. */
export interface NextAction {
  site_id: string;
  kind: 'integration_failing' | 'seo_decay' | 'seo_striking' | 'ad_fatigue' | 'asa_low_roas' | 'failed_renewals' | 'ai_lost_mentions';
  title: string;
  value: number | null;
  currency: string | null;
  value_basis: string | null;
  clicks: number | null;
  link: string;
}
export type Payment = HomeData['payments'][number];
