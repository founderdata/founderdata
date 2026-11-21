export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    window.dispatchEvent(new Event('ml:logout'));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  // A write makes every cached answer stale (lib/cache.ts); the next mount refetches it.
  if (init?.method && init.method !== 'GET' && !path.startsWith('/api/auth')) window.dispatchEvent(new Event('fd:wrote'));
  return data as T;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  api_key: string;
  dodo_webhook_secret: string | null;
  created_at: number;
  app_bundle_id: string | null;
  /** The app's App Store id, found by the App Store sales import. */
  asc_app_id?: string | null;
  /** The app's App Store id as entered in Settings, for a deployment without the sales import. */
  app_store_id?: string | null;
  /** The goal Home and the Content tab count for this site, and how it reads (migration 0030). */
  primary_goal?: string | null;
  primary_goal_label?: string | null;
  /** website, app, extension or newsletter; null = automatic (migration 0034, components/ProductType.tsx). */
  product_type?: string | null;
  accept_sandbox: number;
  stripe_webhook_secret: string | null;
  /** 1 = record Stripe payments that nothing ties to a site (the default). */
  stripe_unpinned?: number;
  revenuecat_auth: string | null;
  /** 1 = drop tracker and app events once the site wrote its daily cap of rows (the default). */
  write_cap_on?: number;
  /** Rows a day; null = automatic. */
  write_cap?: number | null;
  /** Percent of page loads whose Core Web Vitals are stored (src/worker/vitals.ts); 100 when unset. */
  vitals_sample?: number;
  /** 1 = visits from hosting networks count; 0 hides them (src/worker/datacenter.ts). */
  show_datacenter?: number;
  /** Sessions from hosting networks in the last 30 days, on GET /api/sites/:id. */
  datacenter_visits?: number;
  /** Record visits (FounderData Pro, migration 0072): 1 = on. */
  record_visits?: number;
  /** Percent of visits recorded, 1 to 100. */
  record_sample?: number;
  /** Days a recording is kept: 7, 30 or 90. */
  record_keep_days?: number;
  /** Most visits recorded a day. */
  record_daily_max?: number;
  /** 1 = after 24 hours keep only recorded visits with a goal or a payment. */
  record_only_active?: number;
  /** 1 = record a visit only after the visitor consented to cookies (migration 0075). */
  record_consent?: number;
  /** Pages that are never recorded: path prefixes, one per line; null for none (migration 0076). */
  record_skip?: string | null;
  /** Remember visitors: 1 = the tracker keeps the visitor id in first-party cookies. */
  remember_visitors?: number;
  /** Catch JavaScript errors without recording (migration 0090): 1 = on. */
  errors_on?: number;
  /** Click maps (migration 0090): 1 = on. */
  maps_on?: number;
  /** Percent of page views that send a click map, 1 to 100. */
  map_sample?: number;
  /** The two surveys as JSON (migration 0090); null = both off. */
  surveys?: string | null;
  /** The running experiments as compact JSON (migration 0090); null = none. */
  exp_live?: string | null;
  /** GET and PATCH /api/sites/:id: the REPLAY_BUCKET binding exists (`npm run setup -- --replay`). */
  replay_bucket?: boolean;
  /** GET /api/sites/:id only: today's rows against the cap. */
  usage?: {
    rows: number;
    /** The site's own cap, the shared pool for an automatic site, or null when off. */
    cap: number | null;
    /** Rows a day that all automatic sites share. */
    auto: number;
    /** The site is on the automatic cap. */
    shared?: boolean;
    /** Rows all sites wrote today. */
    pool_rows?: number;
    site_max?: number | null;
    capped_at: number | null;
    resets_at: number;
  };
  /** Signing secrets, masked once set. */
  lemonsqueezy_secret?: string | null;
  polar_secret?: string | null;
  paddle_secret?: string | null;
  /** Gumroad: the seller id pings must name, and the token in the ping URL. */
  gumroad_seller_id?: string | null;
  gumroad_token?: string | null;
  /** Apple's commission in percent (15 or 30) for amounts after Apple's cut, where the sales report has no proceeds. */
  app_commission?: number;
  /** PATCH only: true makes a new Gumroad ping URL. */
  gumroad_new_token?: boolean;
  /** GET /api/sites/:id only: the last payment's time (ms) per provider (stripe, dodo, revenuecat, app_store, api, lemonsqueezy, polar, paddle, gumroad, income). */
  last_payments?: Record<string, number>;
  /** GET /api/sites/:id only: where the deployment stores its data and handles requests (src/worker/location.ts). */
  data_location?: { jurisdiction: 'eu' | 'fedramp' | null; stored: string; processed: string; retention_days?: number; pii_retention_days?: number | null };
  /** GET /api/sites/:id only: webhook deliveries refused for a bad signature in the last 24 hours, per provider. */
  refused_webhooks?: Record<string, { count: number; day: string; at: number }>;
  /** GET /api/sites only: false when no payment provider is set up and no payment was ever recorded. */
  payments_connected?: boolean;
  /** GET /api/sites only: an app batch was refused in the last 24 hours because the site has no bundle id (ms). */
  app_rejected_at?: number | null;
  /** GET /api/sites only: when today's cap was reached (ms), else null. */
  capped_at?: number | null;
  visitors24h?: number;
  online?: number;
  /** GET /api/sites only: the site has subscription rows (the Subscriptions tab). */
  has_subscriptions?: boolean;
  /** The site names a Meta ad account; without one the Meta ads section is muted. */
  has_meta?: boolean;
  /** GET /api/sites only: an app on a deployment with the ASA_* secrets; without them the Apple Search Ads section is muted. */
  has_asa?: boolean;
  /** GET /api/sites only: spend sent from another channel (POST /api/v1/spend or a CSV). With Meta or Apple Search Ads, the Paid overview is not muted. */
  has_spend?: boolean;
}

export interface Kpis {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgDuration: number;
  revenue: number;
  payments: number;
  customers: number;
  conversionRate: number;
  revenuePerVisitor: number;
  /** Sites with an app: consented installs first seen in the range (docs/APP-API.md section 3). */
  newInstalls?: number;
  /** Sites with an app: consented installs with an app session in the range. */
  consentedInstalls?: number;
}

/** GET /api/sites/:id/coverage: payments linked to a visit, in total and per provider (docs/GUIDE.md). */
export interface ProviderCoverage {
  provider: string;
  payments: number;
  linked: number;
  amount: number;
  linkedAmount: number;
  notLinked: { beforeTracking: number; renewals: number; withEmail: number; noIds: number };
}
export interface Coverage {
  from: number;
  to: number;
  currency: string;
  decimals: number;
  payments: number;
  linked: number;
  amount: number;
  linkedAmount: number;
  providers: ProviderCoverage[];
}

export interface Overview {
  range: { from: number; to: number; granularity: 'hour' | 'day' | 'week' | 'month' };
  currency: string;
  decimals: number;
  /** app: a bundle id and no web visit in the last 90 days; web: no bundle id. */
  kind?: 'web' | 'app' | 'both';
  current: Kpis;
  previous: Kpis;
  online: number;
  /** What current.revenue adds up, as on Home and /api/v1/portfolio; null without revenue. */
  basis?: 'net_of_refunds' | 'app_store_gross' | 'mixed' | null;
  /** When the last visit or app session started; null before the first one. */
  lastVisitAt?: number | null;
  /** The primary goal over the period against the one before; null without one or with a filter on. */
  goal?: { name: string; label: string; count: number; previous: number; change_pct: number | null } | null;
  /** Days imported from another tool that are in the numbers and the chart (src/worker/imports.ts); null when none. */
  imported?: { from: string; to: string; days: number; revenue?: number; payments?: number; native_from?: string | null; seam_bucket?: string | null } | null;
  series: { bucket: string; visitors: number; pageviews: number; revenue: number; payments: number; imported?: boolean; imported_revenue?: number }[];
}

export interface BreakdownRow {
  label: string | null;
  /** The Apple Search Ads name of a campaign, keyword or ad group id; `label` stays the id. */
  name?: string | null;
  /** A campaign of the site's Meta ad account, matched by name or id: its menu opens Meta ads. */
  meta?: boolean;
  visitors: number;
  pageviews?: number;
  revenue: number;
  customers: number;
  extra?: string | null;
  /** The "App Store, no source" row: App Store sales with no linked visit. Not a value to filter by. */
  appStore?: boolean;
  /** The "No source" row: Stripe and other payments with no linked visit. Not a value to filter by. */
  noVisit?: boolean;
  /** Revenue and payments an import (DataFast) reports for this source on the imported days. Not in `revenue`. */
  importedRevenue?: number;
  importedPayments?: number;
}

export type Filters = Record<string, string>;

export interface Query {
  period: string;
  from?: string;
  to?: string;
  granularity?: string;
  filters: Filters;
}

export function qs(q: Query, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams();
  p.set('period', q.period);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.granularity) p.set('granularity', q.granularity);
  if (Object.keys(q.filters).length) p.set('filters', JSON.stringify(q.filters));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

/** A page of a list route (customers, visitors): its rows, and the offset of the next page (X-Next-Offset), or null. */
export async function apiPage<T = any>(path: string): Promise<{ rows: T[]; next: number | null }> {
  const res = await fetch(path, { credentials: 'same-origin' });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event('ml:logout'));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  const next = res.headers.get('x-next-offset');
  return { rows: data as T[], next: next === null ? null : Number(next) };
}

/** Alert channels (GET /api/alerts, docs/GUIDE.md "Alerts and weekly report"). */
export type ChannelKind = 'slack' | 'discord' | 'telegram' | 'webhook' | 'email';
export type AlertKind = 'purchase' | 'renewal' | 'refund' | 'trial' | 'payment_failed' | 'canceled' | 'daily' | 'payments_stopped' | 'webhook_refused' | 'cap' | 'aso_collector' | 'aso_review' | 'mail' | 'weekly' | 'numbers' | 'plan_away';

export interface AlertChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  /** Webhook URLs come back as `host/••••last4`; a Telegram chat id and an email address in full. */
  target: string;
  /** '••••••••' when a Telegram bot token is stored. */
  secret: string | null;
  alerts: Record<AlertKind, boolean>;
  /** Site ids the channel covers; null for every site. */
  sites: string[] | null;
  created_at: number;
}

/** A chart note (GET /api/sites/:id/notes), with the chart bucket it falls in. */
export interface ChartNote {
  id: string;
  ts: number;
  text: string;
  kind: 'manual' | 'api' | 'version';
  bucket: string;
  /** The annotation (migration 0026), each null when not sent: who made the change, what kind, where, before and after. */
  actor?: string | null;
  change_kind?: 'copy' | 'pricing' | 'aso' | 'seo' | 'ads' | 'ai' | 'release' | 'launch' | 'outage' | 'other' | null;
  /** Migration 0066: what the verdict judges and over how many days, the group of locale copies, and an outage's end (ms). */
  metric?: string | null;
  window_days?: number | null;
  group_key?: string | null;
  ends_at?: number | null;
  target?: string | null;
  before?: string | null;
  after?: string | null;
}

/** GET /api/sites/:id/notes/:nid/impact (src/worker/notes.ts noteImpact), the fields the notes list shows. */
export interface NoteImpact {
  window_days: number;
  days_covered: number;
  complete: boolean;
  enough_data: boolean;
  before: { visitors: number; customers: number; revenue: number };
  after: { visitors: number; customers: number; revenue: number };
  change: Partial<Record<string, { absolute: number; relative: number | null }>> &
    Record<'visitors' | 'customers' | 'conversion_rate' | 'revenue' | 'revenue_per_visitor', { absolute: number; relative: number | null }>;
  overlapping: { id: string; text: string }[];
}

/** Who signed in (GET /api/auth/me): the owner, or the read-only viewer login (docs/GUIDE.md, "Viewer login"). */
export type Role = 'admin' | 'viewer';
let currentRole: Role = 'admin';
let roleKnown = false;
export const setRole = (role: Role) => {
  // A different role than the one the session started with: nothing cached belongs to this person (lib/cache.ts).
  // The first call only records the role, so answers fetched while /api/auth/me was still running stay.
  const changed = roleKnown && role !== currentRole;
  currentRole = role;
  roleKnown = true;
  if (changed) window.dispatchEvent(new Event('fd:role-changed'));
};
/** The viewer login: the server refuses every change, so the pages hide the controls for it. */
export const isViewer = () => currentRole === 'viewer';

/** One erase request (GET /api/sites/:id/erasures): rows removed or cleared per kind, no identifiers. */
export interface Erasure {
  ts: number;
  method: 'visitor' | 'email' | 'user_id' | 'email+user_id';
  /** The dashboard login or the site's API key; null for requests logged before migration 0022. */
  handled_by: 'admin' | 'api' | null;
  note: string | null;
  counts: Record<string, number>;
}
