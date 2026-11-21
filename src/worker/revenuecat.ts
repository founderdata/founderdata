import type { Context } from 'hono';
import { canonicalId } from './appstore';
import { getSite, type AppEnv, type Site } from './env';
import { appVisitorId } from './identity';
import { passwordsMatch } from './lib/crypto';
import { announce, pusherOf, type Pusher } from './notify';
import { creditedSession, currencyDecimals, recordPayment, recordSignal, SANDBOX_PROVIDER, type MatchedBy, type SignalInput } from './payments';
import { recordSubscription, revenueCatSubscriptionEvent } from './subscriptions';
import { storeCancelStatement } from './surveys';
import type { StoreReason } from '../shared/surveys';

/**
 * RevenueCat webhook: POST /api/webhooks/revenuecat/:siteId, authorised by the per-site secret that RevenueCat
 * sends in the Authorization header (set the same value in RevenueCat and in FounderData's Settings).
 *
 *   INITIAL_PURCHASE, RENEWAL,      a payment row, priced from price_in_purchased_currency and currency.
 *   NON_RENEWING_PURCHASE,          A trial start (period_type TRIAL) is a signal, not revenue.
 *   PRODUCT_CHANGE                  PRODUCT_CHANGE is always a signal, and a payment too when it carries a price.
 *   CANCELLATION                    a churn signal; with cancel_reason CUSTOMER_SUPPORT or a negative price it is
 *   REFUND                          a refund: a negative row for the payment it takes back.
 *   EXPIRATION, BILLING_ISSUE       signals.
 *   UNCANCELLATION                  auto-renew back on.
 * Every one of these with an expiration_at_ms also updates the subscription's row (subscriptions.ts). A CANCELLATION or
 * EXPIRATION from the App Store or Google Play also stores the store's reason as a cancel_reason answer (storeReason).
 *
 * App Store transactions use the payment id apple_<transaction_id>, the same id the SDK's JWS and App Store Server
 * Notifications use, so one purchase reported through two of them is stored once. Visitor link: the subscriber
 * attribute founderDataVisitorId, then the earlier payments of the same subscription (customer id).
 */

type Obj = Record<string, any>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export const PROVIDER = 'revenuecat';
const APPLE_STORES = new Set(['APP_STORE', 'MAC_APP_STORE']);
const PAYMENT_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE', 'PRODUCT_CHANGE']);
const SIGNAL_TYPES: Record<string, string> = {
  CANCELLATION: 'cancellation',
  EXPIRATION: 'expiration',
  BILLING_ISSUE: 'billing_issue',
  PRODUCT_CHANGE: 'product_change',
};

export type RevenueCatOutcome =
  | 'recorded'
  | 'duplicate'
  | 'trial'
  | 'signal'
  | 'refund'
  | 'no_original'
  | 'free'
  | 'invalid'
  | 'sandbox_off'
  | 'subscription';

/**
 * The visitor id the app set as the subscriber attribute founderDataVisitorId, as a canonical install id.
 * RevenueCat reserves keys that start with $ for its own attributes, so apps set the plain key; the $ form is
 * read too, in case a client manages to send it.
 */
export function founderDataVisitorId(event: Obj): string | null {
  const attrs = event?.subscriber_attributes ?? {};
  const attr = attrs.founderDataVisitorId ?? attrs.$founderDataVisitorId;
  const raw = str(attr && typeof attr === 'object' ? attr.value : attr);
  if (!raw || !/^[\w-]{8,64}$/.test(raw)) return null;
  return canonicalId(raw);
}

/** RevenueCat prices are decimals in the purchase currency; payments are stored in the currency's minor unit. */
export function revenueCatAmount(price: number, currency: string): number {
  return Math.round(price * 10 ** currencyDecimals(currency));
}

const isApple = (e: Obj) => APPLE_STORES.has(String(e.store ?? '').toUpperCase());
const transactionId = (e: Obj) => str(e.transaction_id);
const originalId = (e: Obj) => str(e.original_transaction_id) ?? str(e.transaction_id);

function paymentId(e: Obj): string | null {
  const tx = transactionId(e);
  if (!tx) return null;
  return isApple(e) ? `apple_${tx}` : `rc_${String(e.store ?? 'store').toLowerCase()}_${tx}`;
}
function refundId(e: Obj): string | null {
  const tx = transactionId(e);
  if (!tx) return null;
  return isApple(e) ? `apple_refund_${tx}` : `rc_refund_${String(e.store ?? 'store').toLowerCase()}_${tx}`;
}
/** Same customer id as the App Store paths for Apple, so renewals and earlier payments match across sources. */
function customerId(e: Obj): string | null {
  const orig = originalId(e);
  if (isApple(e) && orig) return `apple:${orig}`;
  const user = str(e.original_app_user_id) ?? str(e.app_user_id);
  return user ? `rc:${user.slice(0, 128)}` : null;
}

function provider(site: Site, e: Obj): string | null {
  if (String(e.environment ?? 'PRODUCTION').toUpperCase() !== 'SANDBOX') return PROVIDER;
  return site.accept_sandbox ? SANDBOX_PROVIDER : null;
}

const eventTs = (e: Obj) => num(e.purchased_at_ms) ?? num(e.event_timestamp_ms) ?? Date.now();

/** The visitor and session a signal belongs to: the attribute, else whoever made the subscription's first payment. */
async function linkSignal(db: D1Database, site: Site, e: Obj, ts: number) {
  const attr = founderDataVisitorId(e);
  let visitorId = attr ? await appVisitorId(db, site.id, attr) : null;
  const customer = customerId(e);
  if (!visitorId && customer) {
    const prev = await db
      .prepare("SELECT visitor_id FROM payments WHERE site_id = ? AND customer_id = ? AND kind = 'payment' AND visitor_id IS NOT NULL ORDER BY ts LIMIT 1")
      .bind(site.id, customer)
      .first<{ visitor_id: string }>();
    visitorId = prev?.visitor_id ?? null;
  }
  const sessionId = visitorId ? await creditedSession(db, site, visitorId, ts) : null;
  return { visitorId, sessionId };
}

/**
 * RevenueCat's cancel_reason and expiration_reason, as the cancel reason keys of a store (src/shared/surveys.ts
 * STORE_REASONS). CUSTOMER_SUPPORT on an EXPIRATION is a refund that ended it. A paused Google Play subscription
 * (SUBSCRIPTION_PAUSED) was not canceled: no reason.
 */
const STORE_REASON: Record<string, StoreReason> = {
  UNSUBSCRIBE: 'unsubscribed',
  BILLING_ERROR: 'billing_error',
  PRICE_INCREASE: 'price_increase',
  DEVELOPER_INITIATED: 'developer',
  CUSTOMER_SUPPORT: 'refunded',
};
export function storeReason(e: Obj): { via: 'app_store' | 'play_store'; reason: StoreReason } | null {
  const store = String(e.store ?? '').toUpperCase();
  const via = APPLE_STORES.has(store) ? 'app_store' : store === 'PLAY_STORE' ? 'play_store' : null;
  if (!via) return null;
  const raw = String(e.cancel_reason ?? e.expiration_reason ?? '').toUpperCase();
  if (raw === 'SUBSCRIPTION_PAUSED') return null;
  return { via, reason: STORE_REASON[raw] ?? 'unknown' };
}

async function storeSignal(db: D1Database, site: Site, e: Obj, type: SignalInput['type'], sandbox: boolean, reason: string | null = null, push?: Pusher) {
  const ts = type === 'trial_start' ? eventTs(e) : (num(e.event_timestamp_ms) ?? eventTs(e));
  const { visitorId, sessionId } = await linkSignal(db, site, e, ts);
  // The store's cancel reason, for "Why they cancel" (1 row; none for a retry or the EXPIRATION of a period whose
  // CANCELLATION came first).
  const why = !sandbox && (type === 'cancellation' || type === 'expiration') ? storeReason(e) : null;
  const sub = originalId(e);
  if (why && sub) {
    await storeCancelStatement(db, site, { ...why, subscriptionId: sub, at: ts, expiresAt: num(e.expiration_at_ms), visitorId, eventId: String(e.id).slice(0, 100) }).run();
  }
  const tx = transactionId(e);
  await recordSignal(db, site, {
    // An App Store trial has the same id whether RevenueCat, the SDK or a notification reports it.
    id: type === 'trial_start' && isApple(e) && tx ? `apple_trial_${tx}` : `rc_${String(e.id).slice(0, 100)}`,
    provider: PROVIDER,
    ts,
    type,
    visitorId,
    sessionId,
    product: str(type === 'product_change' ? (e.new_product_id ?? e.product_id) : e.product_id),
    store: str(e.store),
    reason,
    sandbox,
  }, push);
}

async function recordRefund(db: D1Database, site: Site, e: Obj, push?: Pusher): Promise<RevenueCatOutcome> {
  const pid = paymentId(e), rid = refundId(e);
  if (!pid || !rid) return 'invalid';
  const original = await db
    .prepare('SELECT * FROM payments WHERE id = ? AND site_id = ?')
    .bind(pid, site.id)
    .first<{
      provider: string; amount: number; currency: string; visitor_id: string | null; session_id: string | null; customer_id: string | null; subscription_id: string | null;
      product: string | null; channel: string | null; source: string | null; campaign: string | null;
    }>();
  // Only a payment we counted can be taken back out (same rule as App Store notifications).
  if (!original) return 'no_original';
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, subscription_id, product, channel, source, campaign)
       VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      rid,
      site.id,
      original.provider,
      num(e.event_timestamp_ms) ?? Date.now(),
      -Math.abs(original.amount),
      original.currency,
      original.visitor_id,
      original.session_id,
      original.customer_id,
      original.subscription_id,
      original.product,
      original.channel,
      original.source,
      original.campaign,
    )
    .run();
  if (!res.meta.changes) return 'duplicate';
  await announce(push, site, {
    event: 'refund',
    id: rid,
    provider: original.provider,
    sandbox: original.provider === SANDBOX_PROVIDER,
    amount: original.amount,
    currency: original.currency,
    product: original.product,
    sessionId: original.session_id,
  });
  return 'refund';
}

/** Store one RevenueCat event, then its subscription's state. Exported for tests. */
export async function handleRevenueCatEvent(db: D1Database, site: Site, e: Obj, push?: Pusher): Promise<RevenueCatOutcome | { ignored: string }> {
  const result = await storeEvent(db, site, e, push);
  if (result === 'invalid' || result === 'sandbox_off') return result;
  const prov = provider(site, e)!;
  const attr = founderDataVisitorId(e);
  // Without consent the attribute is a launch's install id, which may belong to an earlier launch's visitor.
  const sub = revenueCatSubscriptionEvent(e, prov, attr ? await appVisitorId(db, site.id, attr) : null);
  if (!sub) return result;
  await recordSubscription(db, site, sub);
  return typeof result === 'object' ? 'subscription' : result;
}

async function storeEvent(db: D1Database, site: Site, e: Obj, push?: Pusher): Promise<RevenueCatOutcome | { ignored: string }> {
  const type = String(e.type ?? '').toUpperCase();
  if (!str(e.id)) return 'invalid';
  const prov = provider(site, e);
  if (!prov) return 'sandbox_off';
  const sandbox = prov === SANDBOX_PROVIDER;
  const price = num(e.price_in_purchased_currency);

  const refund = type === 'REFUND' || (type === 'CANCELLATION' && (String(e.cancel_reason ?? '').toUpperCase() === 'CUSTOMER_SUPPORT' || (price !== null && price < 0)));
  if (refund) return recordRefund(db, site, e, push);

  if (PAYMENT_TYPES.has(type)) {
    if (type === 'PRODUCT_CHANGE') await storeSignal(db, site, e, 'product_change', sandbox, null, push);
    if (String(e.period_type ?? '').toUpperCase() === 'TRIAL') {
      if (type === 'INITIAL_PURCHASE') await storeSignal(db, site, e, 'trial_start', sandbox, null, push);
      return 'trial';
    }
    const currency = String(e.currency ?? '').toUpperCase();
    const id = paymentId(e);
    if (!id) return type === 'PRODUCT_CHANGE' ? 'signal' : 'invalid';
    if (price === null || price <= 0 || !/^[A-Z]{3}$/.test(currency)) return type === 'PRODUCT_CHANGE' ? 'signal' : 'free';

    const ts = eventTs(e);
    const customer = customerId(e);
    const prior = customer
      ? await db
          .prepare("SELECT id FROM payments WHERE site_id = ? AND customer_id = ? AND kind = 'payment' AND id != ? AND ts < ? LIMIT 1")
          .bind(site.id, customer, id, ts)
          .first<{ id: string }>()
      : null;
    const attr = founderDataVisitorId(e);
    const visitorId = attr ? await appVisitorId(db, site.id, attr) : null;
    const before = await db.prepare('SELECT 1 FROM payments WHERE id = ?').bind(id).first();
    await recordPayment(
      db,
      site,
      {
        id,
        provider: prov,
        ts,
        amount: revenueCatAmount(price, currency),
        kind: 'payment',
        currency,
        visitorId,
        matchedBy: visitorId ? ('subscriber_attribute' satisfies MatchedBy) : undefined,
        customerId: customer,
        subscriptionId: originalId(e),
        product: str(e.product_id),
        renewal: type === 'RENEWAL' && !e.is_trial_conversion ? true : !!prior,
        timing: false,
      },
      { fillIn: true, push },
    );
    return before ? 'duplicate' : 'recorded';
  }

  const signal = SIGNAL_TYPES[type];
  if (signal) {
    await storeSignal(db, site, e, signal as SignalInput['type'], sandbox, str(e.cancel_reason) ?? str(e.expiration_reason), push);
    return 'signal';
  }
  return { ignored: type || 'unknown' };
}

/** The Authorization header must equal the stored secret, sent as is or as "Bearer <secret>". */
export function revenueCatAuthorized(header: string | undefined | null, secret: string): boolean {
  if (!header) return false;
  const given = header.trim();
  const bare = given.replace(/^Bearer\s+/i, '');
  return passwordsMatch(given, secret) || passwordsMatch(bare, secret);
}

export async function handleRevenueCatWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.revenuecat_auth) return c.json({ error: 'RevenueCat secret not configured for this site' }, 400);
  if (!revenueCatAuthorized(c.req.header('authorization'), site.revenuecat_auth)) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ event?: Obj }>().catch(() => null);
  const event = body?.event;
  if (!event || typeof event !== 'object') return c.json({ error: 'expected { "event": { ... } }' }, 400);
  const result = await handleRevenueCatEvent(c.env.DB, site, event, pusherOf(c));
  if (result === 'invalid') return c.json({ ok: true, ignored: 'invalid' });
  if (typeof result === 'object') return c.json({ ok: true, ...result });
  if (result === 'sandbox_off') return c.json({ ok: true, ignored: 'sandbox' });
  // Every other answer is 200, so RevenueCat stops retrying.
  return c.json({ ok: true, result });
}
