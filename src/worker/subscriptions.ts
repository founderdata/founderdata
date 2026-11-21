import { alertSubscription, later } from './alerts';
import type { Site } from './env';
import { convert, ratesFor } from './fx';
import { creditedSession, currencyDecimals, isTestProvider } from './payments';
import { stripeToMinor } from './stripe';

/**
 * Subscription state (migration 0017, docs/GUIDE.md "Subscriptions"). Every provider turns its lifecycle events into a
 * SubEvent, and recordSubscription folds it into the one row per subscription:
 *
 *   Stripe        customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed and the
 *                 subscription Checkout (stripe.ts)
 *   App Store     purchases from FounderDataKit and App Store Server Notifications: SUBSCRIBED, DID_RENEW, EXPIRED,
 *                 DID_CHANGE_RENEWAL_STATUS, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED (appstore.ts)
 *   RevenueCat    INITIAL_PURCHASE, RENEWAL, PRODUCT_CHANGE, CANCELLATION, UNCANCELLATION, EXPIRATION, BILLING_ISSUE
 *                 (revenuecat.ts)
 *
 * Events arrive late and out of order (Stripe promises no order; Apple retries for days). Fields that only grow keep
 * the earliest or latest value whatever the order: the first payment, the trial start, the period end. Fields that
 * describe the current state (price, product, cancel, end) take the newest event's value. A write is one row; an event
 * that changes nothing writes none.
 */

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);

const DAY = 86_400_000;
/** A subscription with no renewal this long after its period ended counts as ended when the period ended. */
export const LAPSE_MS = 30 * DAY;

export type Interval = 'day' | 'week' | 'month' | 'year';
export type Status = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired' | 'incomplete';

export interface Price {
  /** Per period, minor units of `currency`. */
  amount: number;
  currency: string;
  interval: Interval;
  count: number;
  /** Per month, minor units of `currency`. */
  monthly: number;
}

/**
 * What one event says about a subscription. Leave a field out when the event says nothing about it. For canceledAt,
 * endedAt and billingIssueAt, null says "not any more" (auto-renew turned back on, the subscription came back).
 */
export interface SubEvent {
  id: string;
  provider: string;
  /** When the event happened (ms), to order events that arrive out of order. */
  at: number;
  customerId?: string | null;
  visitorId?: string | null;
  sessionId?: string | null;
  product?: string | null;
  price?: Price | null;
  /** The price and product were read from an invoice: they fill an empty row, never replace the subscription's own. */
  weakPrice?: boolean;
  /**
   * The price is what an invoice charged after its discounts (a coupon). It replaces the row's price when newer, even
   * from a weak event: the subscription event may only name the coupon, not its amount.
   */
  paidPrice?: boolean;
  /** The price is the list price of a subscription with a discount FounderData can't read: it only fills an empty row. */
  listPrice?: boolean;
  /**
   * The billing period comes from the gap since the only payment before, and replaces the one the first payment
   * guessed (a Dodo site without subscription events). The gap is one period, so the payment is a renewal, never a
   * lapse; the same amount over the new period corrects the first MRR instead of counting as a change. Comes with
   * paidPrice, so the price replaces the guess.
   */
  periodFix?: boolean;
  /** Who pays, for the alerts only (never stored): the invoice's customer email and name. */
  customerEmail?: string | null;
  customerName?: string | null;
  startedAt?: number | null;
  trialStart?: number | null;
  trialEnd?: number | null;
  /** A payment at this time. */
  paidAt?: number | null;
  expiresAt?: number | null;
  canceledAt?: number | null;
  endedAt?: number | null;
  billingIssueAt?: number | null;
}

export interface SubRow {
  site_id: string;
  id: string;
  provider: string;
  customer_id: string | null;
  visitor_id: string | null;
  session_id: string | null;
  channel: string | null;
  source: string | null;
  source_domain: string | null;
  campaign: string | null;
  product: string | null;
  status: Status;
  currency: string | null;
  amount: number | null;
  interval: Interval | null;
  interval_count: number | null;
  mrr: number | null;
  first_mrr: number | null;
  mrr_changed_at: number | null;
  trial_start: number | null;
  trial_end: number | null;
  started_at: number;
  paid_at: number | null;
  renewed_at: number | null;
  expires_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  billing_issue_at: number | null;
  sandbox: number;
  updated_at: number;
  rev: number;
  /** JSON [[ms, mrr], ...]: price changes before mrr_changed_at, on rows that carry imported history (migration 0046). */
  steps?: string | null;
}

const COLUMNS = [
  'site_id', 'id', 'provider', 'customer_id', 'visitor_id', 'session_id', 'channel', 'source', 'source_domain', 'campaign', 'product',
  'status', 'currency', 'amount', 'interval', 'interval_count', 'mrr', 'first_mrr', 'mrr_changed_at', 'trial_start', 'trial_end',
  'started_at', 'paid_at', 'renewed_at', 'expires_at', 'canceled_at', 'ended_at', 'billing_issue_at', 'sandbox', 'updated_at', 'rev', 'steps',
] as const satisfies readonly (keyof SubRow)[];

// ---------- prices

/** A price per month: a year is 12 months, a week 52/12 of a month, a day 365/12. */
export function monthlyAmount(amount: number, interval: Interval, count = 1): number {
  const n = Math.max(1, count);
  const perMonth = interval === 'year' ? 1 / 12 : interval === 'week' ? 52 / 12 : interval === 'day' ? 365 / 12 : 1;
  return Math.round((amount * perMonth) / n);
}

export function priceOf(amount: number, currency: string, interval: Interval, count = 1): Price {
  return { amount, currency: currency.toUpperCase(), interval, count: Math.max(1, count), monthly: monthlyAmount(amount, interval, count) };
}

/** The length of `count` periods: a month is 30.44 days, a year 365. */
export function periodMs(interval: Interval, count = 1): number {
  const one = interval === 'year' ? 365 * DAY : interval === 'week' ? 7 * DAY : interval === 'day' ? DAY : 30.44 * DAY;
  return Math.round(one * Math.max(1, count));
}

const INTERVALS = new Set<Interval>(['day', 'week', 'month', 'year']);
const asInterval = (v: unknown): Interval | null => (INTERVALS.has(v as Interval) ? (v as Interval) : null);

/**
 * The billing period from its length, for providers that send dates instead of a period (App Store, RevenueCat, an
 * invoice line): 1 week, 1 to 11 months, 1 year. Null below 12 hours, which only App Store sandbox renewals have.
 */
export function intervalFromSpan(ms: number): { interval: Interval; count: number } | null {
  const days = ms / DAY;
  if (!Number.isFinite(days) || days < 0.5) return null;
  if (days < 4) return { interval: 'day', count: Math.max(1, Math.round(days)) };
  if (days <= 24) return { interval: 'week', count: Math.max(1, Math.round(days / 7)) };
  if (days <= 45) return { interval: 'month', count: 1 };
  const months = Math.round(days / 30.44);
  if (months < 12) return { interval: 'month', count: months };
  return { interval: 'year', count: Math.max(1, Math.round(days / 365)) };
}

/** The monthly amount in the site's currency, at the ECB rate of the event's day; undefined when no rate is known. */
async function siteMonthly(db: D1Database, site: Site, price: Price, at: number): Promise<number | undefined> {
  if (price.currency === site.currency) return price.monthly;
  const rates = await ratesFor(db, new Date(Math.min(at, Date.now())).toISOString().slice(0, 10), fetch).catch(() => null);
  const v = rates ? convert(price.monthly, price.currency, site.currency, rates) : null;
  return v ?? undefined;
}

// ---------- folding an event into the row

const minOf = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.min(a, b));
const maxOf = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.max(a, b));

/** The status a row is in, from its times. Stored with every write; the metrics work from the times themselves. */
export function statusOf(r: Pick<SubRow, 'ended_at' | 'billing_issue_at' | 'renewed_at' | 'canceled_at' | 'paid_at' | 'trial_start'>): Status {
  if (r.ended_at != null) return 'expired';
  if (r.billing_issue_at != null && r.billing_issue_at > (r.renewed_at ?? 0)) return 'past_due';
  if (r.canceled_at != null) return 'canceled';
  if (r.paid_at == null) return r.trial_start != null ? 'trialing' : 'incomplete';
  return 'active';
}

/**
 * The row after one event. `mrr` is the event's price per month in the site's currency (undefined: no price, or no
 * exchange rate yet). Exported for tests.
 */
export function mergeSubscription(prev: SubRow | null, ev: SubEvent, siteId: string, mrr: number | undefined, sandbox: boolean): SubRow {
  const r: SubRow = prev
    ? { ...prev }
    : {
        site_id: siteId,
        id: ev.id,
        provider: ev.provider,
        customer_id: null,
        visitor_id: null,
        session_id: null,
        channel: null,
        source: null,
        source_domain: null,
        campaign: null,
        product: null,
        status: 'incomplete',
        currency: null,
        amount: null,
        interval: null,
        interval_count: null,
        mrr: null,
        first_mrr: null,
        mrr_changed_at: null,
        trial_start: null,
        trial_end: null,
        started_at: ev.startedAt ?? ev.at,
        paid_at: null,
        renewed_at: null,
        expires_at: null,
        canceled_at: null,
        ended_at: null,
        billing_issue_at: null,
        sandbox: sandbox ? 1 : 0,
        updated_at: 0,
        rev: 0,
        steps: null,
      };
  // Only events that say what the subscription is now order the state. A payment, a failed payment or a visitor link
  // says nothing about it, so it does not stop an older event that does from applying.
  const stateful = (!ev.weakPrice && (!!ev.price || !!ev.product)) || ev.canceledAt !== undefined || ev.endedAt !== undefined;
  const newer = ev.at >= r.updated_at;

  r.customer_id ??= ev.customerId ?? null;
  if (!r.visitor_id && ev.visitorId) {
    r.visitor_id = ev.visitorId;
    r.session_id = null;
  }
  if (ev.product && ((newer && !ev.weakPrice) || !r.product)) r.product = ev.product.slice(0, 200);

  // A payment after the subscription ended, or long after its paid period ran out: it came back (an App Store
  // resubscribe keeps its original transaction id). It counts from its return, as new MRR, and the stretch before
  // drops out of the history.
  const lapsed = !ev.periodFix && r.expires_at != null && r.paid_at != null && ev.paidAt != null && ev.paidAt > r.expires_at + LAPSE_MS;
  if (ev.paidAt != null && ((r.ended_at != null && ev.paidAt > r.ended_at) || lapsed)) {
    Object.assign(r, { paid_at: ev.paidAt, first_mrr: null, mrr_changed_at: null, ended_at: null, canceled_at: null, billing_issue_at: null, steps: null });
  } else {
    r.paid_at = minOf(r.paid_at, ev.paidAt);
  }
  r.renewed_at = maxOf(r.renewed_at, ev.paidAt);

  // Times that only grow.
  r.started_at = minOf(r.started_at, ev.startedAt ?? ev.paidAt ?? ev.trialStart ?? ev.at)!;
  r.trial_start = minOf(r.trial_start, ev.trialStart);
  if (ev.trialEnd != null && (newer || r.trial_end == null)) r.trial_end = ev.trialEnd;
  r.expires_at = maxOf(r.expires_at, ev.expiresAt);
  r.billing_issue_at = maxOf(r.billing_issue_at, ev.billingIssueAt);

  // State that the newest event decides.
  if (newer) {
    if (ev.canceledAt !== undefined) r.canceled_at = ev.canceledAt;
    if (ev.endedAt !== undefined) r.ended_at = ev.endedAt;
  } else if (ev.endedAt != null && r.ended_at == null && (r.renewed_at ?? 0) <= ev.endedAt) {
    // An older "ended" that no later payment contradicts still ends it.
    r.ended_at = ev.endedAt;
  }

  // Price: the newest event's, or any price while the row has none. An invoice's price only fills a gap, unless it
  // carries a discount (paidPrice); a list price next to an unreadable discount only fills a gap too.
  const weak = ev.weakPrice || ev.listPrice;
  const takePrice = ev.price && (weak ? r.amount == null || (!!ev.paidPrice && newer) : newer || r.amount == null);
  if (ev.price && takePrice) {
    // The first payment's price over the period its gap to this one shows: the first MRR was a guess, not a change.
    const fixed = !!ev.periodFix && r.amount === ev.price.amount && r.currency === ev.price.currency && r.mrr_changed_at == null;
    r.currency = ev.price.currency;
    r.amount = ev.price.amount;
    r.interval = ev.price.interval;
    r.interval_count = ev.price.count;
    if (mrr !== undefined && mrr !== r.mrr) {
      // The discounted invoice of the first payment sets the first price: a coupon at signup is not a downgrade.
      const firstInvoice = ev.paidPrice && r.paid_at != null && ev.paidAt != null && Math.abs(ev.paidAt - r.paid_at) < DAY && r.mrr_changed_at == null;
      if (firstInvoice || fixed) r.first_mrr = mrr;
      // A paid subscription that changes price after its first payment: an upgrade or a downgrade.
      else if (r.paid_at != null && r.first_mrr != null && ev.at > r.paid_at) {
        // A row with imported history keeps the change it had as a step, so the history stays whole.
        if (r.steps != null && r.mrr_changed_at != null && r.mrr != null) r.steps = JSON.stringify([...JSON.parse(r.steps), [r.mrr_changed_at, r.mrr]]);
        r.mrr_changed_at = ev.at;
      }
      r.mrr = mrr;
    }
  }
  if (r.paid_at != null && r.first_mrr == null && r.mrr != null) r.first_mrr = r.mrr;
  if (r.mrr_changed_at != null && r.paid_at != null && r.mrr_changed_at < r.paid_at) r.mrr_changed_at = null;

  if (stateful) r.updated_at = Math.max(r.updated_at, ev.at);
  r.status = statusOf(r);
  return r;
}

/** Nothing but the event time moved (a retry, the same purchase from the SDK and a notification): no write. */
const sameRow = (a: SubRow, b: SubRow) => COLUMNS.every((c) => c === 'rev' || c === 'updated_at' || a[c] === b[c]);

/** The credited visit's source, kept on the row so it outlives the visit (old visits are deleted after 24 months). */
async function credit(db: D1Database, site: Site, r: SubRow, ev: SubEvent) {
  // The source copied onto the first linked payment (migration 0064), for when its visit is gone.
  let kept: { channel: string | null; source: string | null; campaign: string | null } | null = null;
  if (!r.visitor_id) {
    // The subscription's payments went through the full matching (metadata, customer, email, app account token).
    const [bySub, byCustomer] = await db.batch([
      db
        .prepare("SELECT visitor_id, session_id, channel, source, campaign FROM payments WHERE site_id = ? AND subscription_id = ? AND kind = 'payment' AND visitor_id IS NOT NULL ORDER BY ts LIMIT 1")
        .bind(site.id, r.id),
      db
        .prepare("SELECT visitor_id, session_id, channel, source, campaign FROM payments WHERE site_id = ? AND customer_id = ? AND kind = 'payment' AND visitor_id IS NOT NULL ORDER BY ts LIMIT 1")
        .bind(site.id, r.customer_id ?? ''),
    ]);
    const hit = (bySub.results[0] ?? byCustomer.results[0]) as
      | { visitor_id: string; session_id: string | null; channel: string | null; source: string | null; campaign: string | null }
      | undefined;
    if (hit) {
      [r.visitor_id, r.session_id] = [hit.visitor_id, hit.session_id];
      if (hit.channel != null) kept = { channel: hit.channel, source: hit.source, campaign: hit.campaign };
    }
  }
  if (r.visitor_id && !r.session_id) {
    // The visit that brought the subscription; a visit after its start only when there is none before.
    r.session_id =
      (await creditedSession(db, site, r.visitor_id, r.started_at)) ?? ev.sessionId ?? (await creditedSession(db, site, r.visitor_id, Math.max(ev.at, Date.now())));
  }
  if (r.session_id && r.channel == null) {
    const s = await db
      .prepare('SELECT channel, source, referrer_domain, utm_campaign FROM sessions WHERE site_id = ? AND id = ?')
      .bind(site.id, r.session_id)
      .first<{ channel: string; source: string; referrer_domain: string | null; utm_campaign: string | null }>();
    if (s) Object.assign(r, { channel: s.channel, source: s.source, source_domain: s.referrer_domain, campaign: s.utm_campaign });
    else if (kept) Object.assign(r, kept);
  }
}

export type SubOutcome = 'created' | 'updated' | 'unchanged';

/** An event older than this raises no alert: a replay, a late retry, or the Stripe history import. */
const ALERT_WINDOW_MS = 3 * DAY;
const pastDue = (r: SubRow) => r.ended_at == null && r.billing_issue_at != null && r.billing_issue_at > (r.renewed_at ?? 0);
const stopping = (r: SubRow) => r.canceled_at != null || r.ended_at != null;

/**
 * The alert a write raises, if any: a paying subscription whose payment failed (it was not past due before), or one
 * that was canceled or ended (it was neither before). A canceled subscription that then ends raises nothing more.
 * Exported for tests.
 */
export function subscriptionAlert(prev: SubRow | null, next: SubRow, ev: SubEvent, now = Date.now()): 'payment_failed' | 'canceled' | null {
  if (next.sandbox || next.paid_at == null || ev.at < now - ALERT_WINDOW_MS) return null;
  if (stopping(next) && !(prev && stopping(prev))) return 'canceled';
  if (pastDue(next) && !(prev && pastDue(prev))) return 'payment_failed';
  return null;
}

/**
 * Fold one event into its subscription's row. Two events of one subscription can arrive at once (Stripe sends
 * customer.subscription.created and invoice.paid together), so the write checks the row's rev and starts over when
 * another event wrote first.
 */
export async function recordSubscription(db: D1Database, site: Site, ev: SubEvent): Promise<SubOutcome> {
  if (!ev.id) return 'unchanged';
  ev = { ...ev, id: ev.id.slice(0, 120) };
  const sandbox = isTestProvider(ev.provider);
  const mrr = ev.price ? await siteMonthly(db, site, ev.price, ev.at) : undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const prev = await db.prepare('SELECT * FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, ev.id).first<SubRow>();
    const next = mergeSubscription(prev, ev, site.id, mrr, sandbox);
    if (!next.visitor_id || !next.session_id || next.channel == null) await credit(db, site, next, ev);
    if (prev && sameRow(prev, next)) return 'unchanged';
    next.rev = (prev?.rev ?? 0) + 1;
    const values = COLUMNS.map((c) => next[c]);
    // An update sets only the columns that changed (rev always does), so an index on a column it leaves alone
    // (subscriptions_trial on trial_start, migration 0063) costs no extra row written.
    const changed = prev ? COLUMNS.slice(2).filter((c) => c === 'rev' || next[c] !== prev[c]) : [];
    const res = prev
      ? await db
          .prepare(`UPDATE subscriptions SET ${changed.map((c) => `${c} = ?`).join(', ')} WHERE site_id = ? AND id = ? AND rev = ?`)
          .bind(...changed.map((c) => next[c]), site.id, ev.id, prev.rev)
          .run()
      : await db
          .prepare(`INSERT INTO subscriptions (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) ON CONFLICT (site_id, id) DO NOTHING`)
          .bind(...values)
          .run();
    if (res.meta.changes) {
      // Only the write that changed the row alerts, so a retried or doubled event alerts once.
      const kind = subscriptionAlert(prev, next, ev);
      if (kind) later(db, alertSubscription(db, site, kind, next, { email: ev.customerEmail, name: ev.customerName }));
      return prev ? 'updated' : 'created';
    }
  }
  return 'unchanged';
}

/** Another site already holds this subscription (several sites on one Stripe account): it stays there. */
export async function subscriptionElsewhere(db: D1Database, site: Site, id: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM subscriptions WHERE id = ? AND site_id != ? LIMIT 1').bind(id, site.id).first());
}

// ---------- Stripe

const stripeMs = (v: unknown) => {
  const n = num(v);
  return n && n > 0 ? n * 1000 : null;
};

/** A Stripe Price (or the older Plan) times its quantity. */
function stripeItemPrice(price: Obj, quantity: number, fallbackCurrency: string | null): Price | null {
  const unit = num(price.unit_amount) ?? num(price.amount) ?? (num(price.unit_amount_decimal) !== null ? Math.round(num(price.unit_amount_decimal)!) : null);
  const recurring = obj(price.recurring);
  const interval = asInterval(recurring.interval ?? price.interval);
  const currency = (str(price.currency) ?? fallbackCurrency)?.toUpperCase();
  if (unit === null || !interval || !currency) return null;
  const count = num(recurring.interval_count ?? price.interval_count) ?? 1;
  return priceOf(stripeToMinor(unit * Math.max(0, quantity), currency), currency, interval, count);
}

/** Several prices of one subscription as one: the first one's period, the monthly amounts added up. */
function sumPrices(prices: Price[]): Price | null {
  if (!prices.length) return null;
  const [first] = prices;
  const monthly = prices.reduce((n, p) => n + p.monthly, 0);
  const same = prices.every((p) => p.interval === first.interval && p.count === first.count && p.currency === first.currency);
  const amount = same ? prices.reduce((n, p) => n + p.amount, 0) : Math.round(monthly / monthlyAmount(1_000_000, first.interval, first.count) * 1_000_000);
  return { ...first, amount, monthly };
}

/** A coupon that still takes money off at `at`: percent or amount off each period. */
interface Discount {
  percent: number;
  /** Amount off per period, in Stripe's units of `currency`. */
  off: number;
  currency: string | null;
}

/**
 * The discounts on a subscription or one of its items, from `discounts` (ids, or objects when expanded) and the older
 * single `discount`. A coupon that applies once, or whose discount has ended, takes nothing off the recurring price.
 * Null when a discount is known only by its id: its amount is unknown.
 */
function stripeDiscounts(o: Obj, at: number): Discount[] | null {
  const single = o.discount && typeof o.discount === 'object' ? (o.discount as Obj) : null;
  const list: unknown[] = Array.isArray(o.discounts) && o.discounts.length ? o.discounts : single ? [single] : [];
  const out: Discount[] = [];
  for (const d of list) {
    const found = typeof d === 'string' ? (single && single.id === d ? single : null) : obj(d);
    if (!found) return null;
    // API 2025-03-31 moved the coupon under discount.source.
    const coupon = obj(found.coupon ?? obj(found.source).coupon);
    if (!Object.keys(coupon).length) return null;
    const end = stripeMs(found.end);
    if (coupon.duration === 'once' || (end !== null && end <= at)) continue;
    out.push({ percent: num(coupon.percent_off) ?? 0, off: num(coupon.amount_off) ?? 0, currency: str(coupon.currency)?.toUpperCase() ?? null });
  }
  return out;
}

/** The price after its discounts; null when a discount is in another currency than the price. */
function discounted(price: Price, ds: Discount[]): Price | null {
  let { amount, monthly } = price;
  for (const d of ds) {
    if (d.off) {
      if (d.currency !== price.currency) return null;
      const off = stripeToMinor(d.off, price.currency);
      amount -= off;
      monthly -= monthlyAmount(off, price.interval, price.count);
    }
    if (d.percent) {
      amount = Math.round(amount * (1 - d.percent / 100));
      monthly = Math.round(monthly * (1 - d.percent / 100));
    }
  }
  return { ...price, amount: Math.max(0, amount), monthly: Math.max(0, monthly) };
}

function stripeProduct(price: Obj): string | null {
  return str(obj(price.product).name) ?? str(price.nickname) ?? str(price.lookup_key) ?? idOf(price.product);
}

/** customer.subscription.created / updated / deleted, from the Subscription object. */
export function stripeSubscriptionEvent(o: Obj, at: number): SubEvent | null {
  const id = str(o.id);
  if (!id) return null;
  const status = str(o.status) ?? '';
  const items = Array.isArray(obj(o.items).data) ? (obj(o.items).data as Obj[]) : [];
  const lines = items.length
    ? items.map((it) => ({ price: obj(it.price ?? it.plan), quantity: num(it.quantity) ?? 1, periodEnd: stripeMs(it.current_period_end), item: it }))
    : o.plan
      ? [{ price: obj(o.plan), quantity: num(o.quantity) ?? 1, periodEnd: null, item: {} as Obj }]
      : [];
  const currency = str(o.currency);
  // What the customer pays: each item after its own discounts, the sum after the subscription's. A discount known
  // only by its id leaves the list price, which the next invoice's discounted amount replaces.
  let unknownDiscount = false;
  const itemPrices = lines.map((l) => {
    const p = stripeItemPrice(l.price, l.quantity, currency);
    const ds = stripeDiscounts(l.item, at);
    const after = p && ds ? discounted(p, ds) : null;
    if (p && !after) unknownDiscount = true;
    return after ?? p;
  });
  const list = sumPrices(itemPrices.filter((p): p is Price => !!p));
  const ds = stripeDiscounts(o, at);
  const after = list && ds ? discounted(list, ds) : null;
  if (list && !after) unknownDiscount = true;
  const price = after ?? list;
  const trialStart = stripeMs(o.trial_start);
  const trialEnd = stripeMs(o.trial_end);
  const startedAt = stripeMs(o.start_date) ?? stripeMs(o.created) ?? at;
  const ended = status === 'canceled' || status === 'incomplete_expired' || status === 'paused';
  const paying = status === 'active' || status === 'past_due' || status === 'unpaid';
  const scheduled = o.cancel_at_period_end === true || stripeMs(o.cancel_at) !== null;
  return {
    id,
    provider: 'stripe',
    at,
    customerId: idOf(o.customer),
    product: lines.length ? stripeProduct(lines[0].price) : null,
    price,
    listPrice: unknownDiscount || undefined,
    startedAt,
    trialStart,
    trialEnd,
    // Active means the first payment went through: at the trial's end, or at the start without a trial.
    paidAt: paying ? (trialEnd ? Math.min(trialEnd, at) : startedAt) : undefined,
    expiresAt: stripeMs(o.current_period_end) ?? lines.map((l) => l.periodEnd).find((x) => x !== null) ?? (status === 'trialing' ? trialEnd : null),
    canceledAt: ended || scheduled ? (stripeMs(o.canceled_at) ?? at) : null,
    endedAt: ended ? (stripeMs(o.ended_at) ?? at) : null,
    billingIssueAt: status === 'past_due' || status === 'unpaid' ? at : undefined,
  };
}

/**
 * What an invoice was for, for its payment's product: the first subscription line's product (the same name the
 * subscription gets), else the first line's. Null for an invoice without lines.
 */
export function stripeInvoiceProduct(o: Obj): string | null {
  const all = Array.isArray(obj(o.lines).data) ? (obj(o.lines).data as Obj[]) : [];
  const line = all.find((l) => l.proration !== true && (l.type === 'subscription' || !!l.subscription || !!obj(l.parent).subscription_item_details)) ?? all[0];
  return line ? (stripeProduct(obj(line.price ?? line.plan)) ?? str(line.description)) : null;
}

/**
 * invoice.paid and invoice.payment_failed of a subscription. A paid invoice is a payment and moves the period end;
 * its price (the subscription lines, without prorations) fills a row that no subscription event has priced yet.
 */
export function stripeInvoiceEvent(o: Obj, subscriptionId: string, at: number, paid: boolean): SubEvent {
  const lines = (Array.isArray(obj(o.lines).data) ? (obj(o.lines).data as Obj[]) : []).filter((l) => {
    const parent = obj(obj(l.parent).subscription_item_details);
    return l.proration !== true && parent.proration !== true && (l.type === 'subscription' || !!l.subscription || !!obj(l.parent).subscription_item_details);
  });
  const currency = str(o.currency)?.toUpperCase() ?? null;
  const prices: Price[] = [];
  let periodEnd: number | null = null;
  // Coupons: each line's discount amounts, or, when the lines have none, the invoice's total spread over the lines.
  const sumOff = (list: unknown) => (Array.isArray(list) ? list.reduce((n: number, d) => n + (num(obj(d).amount) ?? 0), 0) : 0);
  const lineOff = lines.map((l) => sumOff(l.discount_amounts));
  const gross = lines.reduce((n, l) => n + (num(l.amount) ?? 0), 0);
  const totalOff = lineOff.some((x) => x > 0) ? 0 : sumOff(o.total_discount_amounts);
  let anyOff = false;
  lines.forEach((l, i) => {
    const period = obj(l.period);
    const start = stripeMs(period.start), end = stripeMs(period.end);
    periodEnd = maxOf(periodEnd, end);
    const listAmount = num(l.amount);
    if (listAmount === null || !currency) return;
    const off = lineOff[i] || (totalOff && gross > 0 ? (totalOff * listAmount) / gross : 0);
    if (off > 0) anyOff = true;
    const amount = Math.max(0, Math.round(listAmount - off));
    const p = obj(l.price ?? l.plan);
    const recurring = obj(p.recurring);
    const known = asInterval(recurring.interval ?? p.interval);
    const span = known ? { interval: known, count: num(recurring.interval_count ?? p.interval_count) ?? 1 } : start && end ? intervalFromSpan(end - start) : null;
    if (span) prices.push(priceOf(stripeToMinor(amount, currency), currency, span.interval, span.count));
  });
  const product = lines.length ? stripeProduct(obj(lines[0].price ?? lines[0].plan)) ?? str(lines[0].description) : null;
  return {
    id: subscriptionId,
    provider: 'stripe',
    at,
    customerId: idOf(o.customer),
    product: paid ? product : undefined,
    price: paid ? sumPrices(prices) : undefined,
    weakPrice: true,
    paidPrice: paid && anyOff ? true : undefined,
    customerEmail: str(o.customer_email)?.toLowerCase() ?? null,
    customerName: str(o.customer_name),
    paidAt: paid ? (stripeMs(obj(o.status_transitions).paid_at) ?? at) : undefined,
    expiresAt: paid ? periodEnd : undefined,
    billingIssueAt: paid ? undefined : at,
  };
}

// ---------- App Store

/** The fields of a JWSTransactionDecodedPayload a subscription needs. */
export interface AppleSubTransaction {
  originalTransactionId: string;
  productId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  price?: number;
  currency?: string;
  type?: string;
  offerType?: number;
  offerDiscountType?: string;
  revocationDate?: number;
}

export interface AppleNotice {
  type: string;
  subtype?: string;
  signedDate?: number;
  /** data.status: 1 active, 2 expired, 3 billing retry, 4 grace period, 5 revoked. */
  status?: number;
}

/** A subscription event from an App Store transaction, and the notification that carried it if any. Null for other products. */
export function appleSubscriptionEvent(tx: AppleSubTransaction, provider: string, link: { visitorId?: string | null; sessionId?: string | null }, notice?: AppleNotice): SubEvent | null {
  if (tx.type !== 'Auto-Renewable Subscription' && typeof tx.expiresDate !== 'number') return null;
  const purchased = num(tx.purchaseDate);
  const expires = num(tx.expiresDate);
  const at = num(notice?.signedDate) ?? purchased ?? Date.now();
  const currency = String(tx.currency ?? '').toUpperCase();
  const trial = tx.offerType === 1 && (tx.offerDiscountType === 'FREE_TRIAL' || !(Number(tx.price) > 0));
  const paid = !trial && Number(tx.price) > 0 && /^[A-Z]{3}$/.test(currency) && !tx.revocationDate;
  const span = purchased && expires ? intervalFromSpan(expires - purchased) : null;
  const ev: SubEvent = {
    id: String(tx.originalTransactionId),
    provider,
    at,
    customerId: `apple:${tx.originalTransactionId}`,
    visitorId: link.visitorId ?? null,
    sessionId: link.sessionId ?? null,
    product: tx.productId ? String(tx.productId) : null,
    startedAt: num(tx.originalPurchaseDate) ?? purchased,
    expiresAt: expires,
  };
  if (trial) Object.assign(ev, { trialStart: purchased, trialEnd: expires });
  // Apple prices are milliunits, tax included.
  if (paid && span) ev.price = priceOf(Math.round((Number(tx.price) * 10 ** currencyDecimals(currency)) / 1000), currency, span.interval, span.count);
  if (paid && purchased) ev.paidAt = purchased;
  if (notice) {
    const signed = num(notice.signedDate) ?? at;
    if (notice.type === 'DID_CHANGE_RENEWAL_STATUS') ev.canceledAt = notice.subtype === 'AUTO_RENEW_DISABLED' ? signed : notice.subtype === 'AUTO_RENEW_ENABLED' ? null : undefined;
    if (notice.type === 'DID_FAIL_TO_RENEW' || notice.type === 'GRACE_PERIOD_EXPIRED' || notice.status === 3 || notice.status === 4) ev.billingIssueAt = signed;
    if (notice.type === 'EXPIRED' || notice.status === 2 || notice.status === 5) ev.endedAt = Math.min(expires ?? signed, signed);
  }
  return ev;
}

// ---------- RevenueCat

const RC_PAID = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION']);
const RC_TYPES = new Set([...RC_PAID, 'CANCELLATION', 'EXPIRATION', 'BILLING_ISSUE']);

/** A subscription event from a RevenueCat webhook event. Null for one-time purchases, refunds and other types. */
export function revenueCatSubscriptionEvent(e: Obj, provider: string, visitorId: string | null): SubEvent | null {
  const type = String(e.type ?? '').toUpperCase();
  const expires = num(e.expiration_at_ms);
  const id = str(e.original_transaction_id) ?? str(e.transaction_id);
  if (expires === null || !id || !RC_TYPES.has(type)) return null;
  const price = num(e.price_in_purchased_currency);
  const reason = String(e.cancel_reason ?? '').toUpperCase();
  // A refund is a CANCELLATION with CUSTOMER_SUPPORT or a negative price; the EXPIRATION that follows ends it.
  if (type === 'CANCELLATION' && (reason === 'CUSTOMER_SUPPORT' || (price !== null && price < 0))) return null;
  const purchased = num(e.purchased_at_ms);
  const at = num(e.event_timestamp_ms) ?? purchased ?? Date.now();
  const store = String(e.store ?? '').toUpperCase();
  const apple = store === 'APP_STORE' || store === 'MAC_APP_STORE';
  const trial = String(e.period_type ?? '').toUpperCase() === 'TRIAL';
  const currency = String(e.currency ?? '').toUpperCase();
  const user = str(e.original_app_user_id) ?? str(e.app_user_id);
  const ev: SubEvent = {
    id,
    provider,
    at,
    // The customer ids revenuecat.ts gives the payments, so credit() finds them.
    customerId: apple ? `apple:${id}` : user ? `rc:${user.slice(0, 128)}` : null,
    visitorId,
    product: str(e.product_id),
    expiresAt: expires,
  };
  if (trial) Object.assign(ev, { trialStart: purchased, trialEnd: expires });
  if (RC_PAID.has(type) && !trial && price !== null && price > 0 && /^[A-Z]{3}$/.test(currency)) {
    const span = purchased ? intervalFromSpan(expires - purchased) : null;
    if (span) ev.price = priceOf(Math.round(price * 10 ** currencyDecimals(currency)), currency, span.interval, span.count);
    if (purchased) ev.paidAt = purchased;
  }
  if (type === 'UNCANCELLATION') ev.canceledAt = null;
  if (type === 'CANCELLATION') ev.canceledAt = at;
  if (type === 'BILLING_ISSUE' || (type === 'CANCELLATION' && reason === 'BILLING_ERROR')) ev.billingIssueAt = at;
  if (type === 'EXPIRATION') ev.endedAt = Math.min(expires, at);
  return ev;
}

/** The billing period of a subscription with one payment: from the product's name, else a month. */
export function intervalFromName(product: string | null): { interval: Interval; count: number } {
  const p = (product ?? '').toLowerCase();
  if (/year|annual|12.?month/.test(p)) return { interval: 'year', count: 1 };
  if (/week/.test(p)) return { interval: 'week', count: 1 };
  if (/quarter|3.?month/.test(p)) return { interval: 'month', count: 3 };
  return { interval: 'month', count: 1 };
}

/**
 * MRR movement over [from, at): `new` from subscriptions first paid in it, `expansion` from price rises, `churned` from
 * subscriptions that ended plus price cuts. The Subscriptions tab's new, expansion, churned and contraction sums, with
 * contraction in `churned`. new + expansion - churned = mrr - mrrStart: `churned` takes any rest, so the three always
 * add up to the change.
 */
export interface MrrMovement {
  new: number;
  expansion: number;
  churned: number;
  net: number;
}
