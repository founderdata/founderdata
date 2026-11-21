import type { Context } from 'hono';
import { getSite, type AppEnv, type Site } from './env';
import { appVisitorId } from './identity';
import { JwsError, verifyAppleJws } from './lib/apple-jws';
import { announce, pusherOf, type Pusher } from './notify';
import { creditedSession, currencyDecimals, recordPayment, recordSignal, SANDBOX_PROVIDER } from './payments';
import { appleSubscriptionEvent, recordSubscription, type AppleNotice } from './subscriptions';
import { storeCancelStatement } from './surveys';
import type { StoreReason } from '../shared/surveys';

/** The fields of a StoreKit 2 / App Store Server API JWSTransactionDecodedPayload that we use. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId?: string;
  purchaseDate?: number;
  /** Price in milliunits of `currency`, tax included (9990 = 9.99). */
  price?: number;
  currency?: string;
  environment?: string;
  appAccountToken?: string;
  type?: string;
  revocationDate?: number;
  signedDate?: number;
  /** 1 introductory offer, 2 promotional, 3 offer code, 4 win-back. */
  offerType?: number;
  /** FREE_TRIAL, PAY_AS_YOU_GO or PAY_UP_FRONT (iOS 17.2 and later). */
  offerDiscountType?: string;
  /** Auto-renewable subscriptions: the end of the period this transaction pays for (or of the trial). */
  expiresDate?: number;
  originalPurchaseDate?: number;
}

export type AppleOutcome = 'invalid' | 'recorded' | 'duplicate' | 'free' | 'sandbox_off' | 'wrong_bundle' | 'revoked' | 'no_original';

/** UUIDs with or without dashes, any case, become lowercase with dashes; anything else is left alone. */
export function canonicalId(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) || !/^[0-9a-f-]+$/i.test(id)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const paymentId = (tx: AppleTransaction) => `apple_${tx.transactionId}`;
const customerId = (tx: AppleTransaction) => `apple:${tx.originalTransactionId}`;

function provider(site: Site, tx: AppleTransaction): string | null {
  if (tx.environment === 'Production') return 'app_store';
  return site.accept_sandbox ? SANDBOX_PROVIDER : null;
}

/** Apple prices are milliunits; payments are stored in the currency's minor unit. */
export function appleAmount(price: number, currency: string): number {
  return Math.round((price * 10 ** currencyDecimals(currency)) / 1000);
}

function validTransaction(tx: AppleTransaction): boolean {
  return /^\d{1,32}$/.test(String(tx.transactionId)) && /^\d{1,32}$/.test(String(tx.originalTransactionId));
}

/**
 * Store a verified App Store purchase. `link` is the install that sent it (the app's purchase event);
 * App Store notifications have none and fall back to appAccountToken, then to an earlier payment with the
 * same originalTransactionId.
 */
export async function recordAppleTransaction(
  db: D1Database,
  site: Site,
  tx: AppleTransaction,
  link: { visitorId?: string | null; sessionId?: string | null } = {},
  push?: Pusher,
): Promise<AppleOutcome> {
  if (!validTransaction(tx)) return 'invalid';
  if (!site.app_bundle_id || tx.bundleId !== site.app_bundle_id) return 'wrong_bundle';
  const prov = provider(site, tx);
  if (!prov) return 'sandbox_off';
  if (tx.revocationDate) return 'revoked';
  const currency = String(tx.currency ?? '').toUpperCase();
  // Free trials and $0 offers are not revenue (the first paid renewal is the conversion). A free trial is kept as
  // a trial_start signal, so the onboarding panels can count trials.
  if (typeof tx.price !== 'number' || tx.price <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    if (tx.offerDiscountType === 'FREE_TRIAL' || (tx.offerType === 1 && !tx.price)) {
      const ts = Number(tx.purchaseDate) || Date.now();
      // Without consent the token is the launch's install id, which may belong to an earlier launch's visitor.
      const token = tx.appAccountToken ? await appVisitorId(db, site.id, canonicalId(String(tx.appAccountToken))) : null;
      const visitorId = link.visitorId ?? token;
      const sessionId = link.sessionId ?? (visitorId ? await creditedSession(db, site, visitorId, ts) : null);
      await recordSignal(db, site, {
        id: `apple_trial_${tx.transactionId}`,
        provider: prov,
        ts,
        type: 'trial_start',
        visitorId,
        sessionId,
        product: tx.productId ? String(tx.productId) : null,
        store: 'APP_STORE',
        sandbox: prov === SANDBOX_PROVIDER,
      }, push);
      const sub = appleSubscriptionEvent(tx, prov, { visitorId, sessionId });
      if (sub) await recordSubscription(db, site, sub);
    }
    return 'free';
  }

  const ts = Number(tx.purchaseDate) || Date.now();
  const id = paymentId(tx);
  const prior = await db
    .prepare("SELECT id FROM payments WHERE site_id = ? AND customer_id = ? AND kind = 'payment' AND id != ? AND ts < ? LIMIT 1")
    .bind(site.id, customerId(tx), id, ts)
    .first<{ id: string }>();
  const token = tx.appAccountToken ? await appVisitorId(db, site.id, canonicalId(String(tx.appAccountToken))) : null;
  const visitorId = link.visitorId ?? token;
  const before = await db.prepare('SELECT 1 FROM payments WHERE id = ?').bind(id).first();

  await recordPayment(
    db,
    site,
    {
      id,
      provider: prov,
      ts,
      amount: appleAmount(tx.price, currency),
      kind: 'payment',
      currency,
      visitorId,
      sessionId: link.sessionId ?? null,
      matchedBy: link.visitorId ? 'app_event' : token ? 'app_account_token' : undefined,
      customerId: customerId(tx),
      subscriptionId: String(tx.originalTransactionId),
      product: tx.productId ? String(tx.productId) : null,
      renewal: !!prior,
      timing: false,
    },
    { fillIn: true, push },
  );
  const sub = appleSubscriptionEvent(tx, prov, { visitorId, sessionId: link.sessionId });
  if (sub) await recordSubscription(db, site, sub);
  return before ? 'duplicate' : 'recorded';
}

/**
 * A notification that changes a subscription without money: auto-renew off or on, a failed renewal, the end. The
 * transaction is the subscription's latest one.
 */
export async function recordAppleSubscriptionNotice(db: D1Database, site: Site, tx: AppleTransaction, notice: AppleNotice): Promise<AppleOutcome | 'subscription'> {
  if (!validTransaction(tx)) return 'invalid';
  if (!site.app_bundle_id || tx.bundleId !== site.app_bundle_id) return 'wrong_bundle';
  const prov = provider(site, tx);
  if (!prov) return 'sandbox_off';
  const sub = appleSubscriptionEvent(tx, prov, {}, notice);
  if (!sub) return 'free';
  await recordSubscription(db, site, sub);
  // Apple's reason for a cancellation, for "Why they cancel" (1 row; none for a retry or for the EXPIRED of a period
  // whose AUTO_RENEW_DISABLED came first).
  const reason = appleCancelReason(notice);
  if (reason && prov !== SANDBOX_PROVIDER) {
    await storeCancelStatement(db, site, {
      via: 'app_store',
      subscriptionId: String(tx.originalTransactionId),
      at: Number(notice.signedDate) || Date.now(),
      expiresAt: Number(tx.expiresDate) || null,
      reason,
      visitorId: null,
      eventId: `${notice.type}:${tx.transactionId}`,
    }).run();
  }
  return 'subscription';
}

/**
 * The cancel reason an App Store Server Notification carries (src/shared/surveys.ts STORE_REASONS): renewal turned off,
 * or the subscription expired for a reason Apple names. Null for every other notification.
 */
export function appleCancelReason(n: Pick<AppleNotice, 'type' | 'subtype'>): StoreReason | null {
  const sub = String(n.subtype ?? '').toUpperCase();
  if (n.type === 'DID_CHANGE_RENEWAL_STATUS') return sub === 'AUTO_RENEW_DISABLED' ? 'unsubscribed' : null;
  if (n.type === 'GRACE_PERIOD_EXPIRED') return 'billing_error';
  if (n.type !== 'EXPIRED') return null;
  return ({ VOLUNTARY: 'unsubscribed', BILLING_RETRY: 'billing_error', PRICE_INCREASE: 'price_increase', PRODUCT_NOT_FOR_SALE: 'developer' } as Record<string, StoreReason>)[sub] ?? 'unknown';
}

/** REFUND / REVOKE: a negative row for the transaction, linked like the original payment. */
export async function recordAppleRefund(db: D1Database, site: Site, tx: AppleTransaction, ts: number, push?: Pusher): Promise<AppleOutcome> {
  if (!validTransaction(tx)) return 'invalid';
  if (!site.app_bundle_id || tx.bundleId !== site.app_bundle_id) return 'wrong_bundle';
  const original = await db
    .prepare('SELECT * FROM payments WHERE id = ? AND site_id = ?')
    .bind(paymentId(tx), site.id)
    .first<{
      provider: string; amount: number; currency: string; visitor_id: string | null; session_id: string | null; customer_id: string | null; product: string | null;
      channel: string | null; source: string | null; campaign: string | null;
    }>();
  // Only a payment we counted can be taken back out.
  if (!original) return 'no_original';
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, subscription_id, channel, source, campaign)
       VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `apple_refund_${tx.transactionId}`,
      site.id,
      original.provider,
      ts,
      -Math.abs(original.amount),
      original.currency,
      original.visitor_id,
      original.session_id,
      original.customer_id,
      String(tx.originalTransactionId),
      original.channel,
      original.source,
      original.campaign,
    )
    .run();
  if (!res.meta.changes) return 'duplicate';
  await announce(push, site, {
    event: 'refund',
    id: `apple_refund_${tx.transactionId}`,
    provider: original.provider,
    sandbox: original.provider === SANDBOX_PROVIDER,
    amount: original.amount,
    currency: original.currency,
    product: original.product,
    sessionId: original.session_id,
  });
  return 'recorded';
}

interface Notification {
  notificationType?: string;
  subtype?: string;
  signedDate?: number;
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string; status?: number };
}

const PAYMENT_TYPES = new Set(['SUBSCRIBED', 'DID_RENEW', 'ONE_TIME_CHARGE']);
const REFUND_TYPES = new Set(['REFUND', 'REVOKE']);
/** Subscription changes without money (src/worker/subscriptions.ts). */
const SUBSCRIPTION_TYPES = new Set(['DID_CHANGE_RENEWAL_STATUS', 'DID_FAIL_TO_RENEW', 'GRACE_PERIOD_EXPIRED', 'EXPIRED']);

/**
 * App Store Server Notifications V2: POST /api/webhooks/apple/:siteId with { "signedPayload": "..." }.
 * Point App Store Connect at this URL, or forward the raw body from a backend that already owns it.
 * Anything verified but not handled answers 200 so Apple stops retrying.
 */
export async function handleAppleWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.app_bundle_id) return c.json({ error: 'set the app bundle id in the site settings first' }, 400);

  const body = await c.req.json<{ signedPayload?: unknown }>().catch(() => null);
  if (!body || typeof body.signedPayload !== 'string') return c.json({ error: 'expected { "signedPayload": "..." }' }, 400);

  let n: Notification;
  try {
    n = await verifyAppleJws<Notification>(body.signedPayload);
  } catch (e) {
    return c.json({ error: 'invalid signature', detail: e instanceof JwsError ? e.message : 'unverifiable' }, 401);
  }
  const data = n.data ?? {};
  if (data.bundleId !== site.app_bundle_id) {
    return c.json({ error: `notification is for ${data.bundleId}, this site expects ${site.app_bundle_id}` }, 400);
  }
  if (data.environment !== 'Production' && !site.accept_sandbox) return c.json({ ok: true, ignored: 'sandbox' });

  const type = n.notificationType ?? '';
  if (!PAYMENT_TYPES.has(type) && !REFUND_TYPES.has(type) && !SUBSCRIPTION_TYPES.has(type)) return c.json({ ok: true, ignored: type || 'unknown' });
  if (!data.signedTransactionInfo) return c.json({ ok: true, ignored: 'no transaction' });

  let tx: AppleTransaction;
  try {
    tx = await verifyAppleJws<AppleTransaction>(data.signedTransactionInfo);
  } catch (e) {
    return c.json({ error: 'invalid transaction signature', detail: e instanceof JwsError ? e.message : 'unverifiable' }, 401);
  }
  const outcome = REFUND_TYPES.has(type)
    ? await recordAppleRefund(c.env.DB, site, tx, Number(tx.revocationDate) || Number(n.signedDate) || Date.now(), pusherOf(c))
    : SUBSCRIPTION_TYPES.has(type)
      ? await recordAppleSubscriptionNotice(c.env.DB, site, tx, { type, subtype: n.subtype, signedDate: n.signedDate, status: data.status })
      : await recordAppleTransaction(c.env.DB, site, tx, {}, pusherOf(c));
  return c.json({ ok: true, result: outcome });
}
