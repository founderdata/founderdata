import type { Context } from 'hono';
import { takeLater } from './alerts';
import { canonicalId } from './appstore';
import { getSite, type AppEnv, type Env, type Site } from './env';
import { convertPayments } from './fx';
import { appVisitorId } from './identity';
import { ANDROID_PUBLISHER_SCOPE, GoogleAuthError, googleAccessToken, verifyGoogleOidc } from './lib/google-auth';
import { announce, pusherOf, type Pusher } from './notify';
import { creditedSession, currencyDecimals, isTestProvider, PLAY_TEST_PROVIDER, recordPayment, recordSignal, type MatchedBy } from './payments';
import { intervalFromSpan, priceOf, recordSubscription, type SubEvent } from './subscriptions';

/**
 * Google Play purchases (docs/APP-API.md section 9). A purchase token proves nothing by itself, so every purchase is
 * checked with the Android Publisher API before money is stored:
 *
 *   purchase event (app.ts)      the app's batch names the token; the check runs in waitUntil after the 202.
 *   RTDN (handleGoogleWebhook)   Pub/Sub pushes a notification; purchases and renewals run the same check in
 *                                waitUntil, a voided purchase writes its refund row at once (D1 only).
 *
 * The check: subscriptionsv2 or productsv2 for the token, then orders.get for the order's total (the buyer's price with
 * tax, after discounts). Payment id gplay_<orderId>, customer gplay:<first token>, subscription_id the first token.
 * Each check is 2 to 3 subrequests to Google (and one token exchange per 50 minutes), never in a request's path.
 */

export const PLAY_PROVIDER = 'google_play';
export { PLAY_TEST_PROVIDER };
export const PUBLISHER_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
/** linkedPurchaseToken hops followed back to the first token of a subscription. */
const MAX_LINK_HOPS = 3;
/** Subscription notification types that mean money moved (RTDN): RECOVERED, RENEWED, PURCHASED, RESTARTED. */
export const PLAY_PAYMENT_SUBSCRIPTION_TYPES = new Set([1, 2, 4, 7]);
/** One-time product notification type ONE_TIME_PRODUCT_PURCHASED. */
export const PLAY_PAYMENT_ONE_TIME_TYPE = 1;

export interface PlayCheck {
  token: string;
  kind: 'subs' | 'inapp';
  /** The product the app named; Google's answer wins. */
  product?: string | null;
  /** The install and session of the app's purchase event. RTDN has none. */
  visitorId?: string | null;
  sessionId?: string | null;
}

export type PlayOutcome =
  | 'recorded'
  | 'duplicate'
  | 'free'
  | 'pending'
  | 'not_purchased'
  | 'sandbox_off'
  | 'no_order'
  | 'no_service_account'
  | 'no_package'
  | 'error';

type Obj = Record<string, any>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** A Money ({ currencyCode, units, nanos }) in the currency's minor unit. `units` is an int64 sent as a string. */
export function playAmount(m: Obj | null | undefined): { amount: number; currency: string } | null {
  const currency = String(m?.currencyCode ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const units = Number(m?.units ?? 0);
  const nanos = Number(m?.nanos ?? 0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
  const d = currencyDecimals(currency);
  // Units and nanos separately, so 9.99 stays 999 and never 998.9999.
  return { amount: Math.round(units * 10 ** d + (nanos * 10 ** d) / 1e9), currency };
}

const paymentId = (orderId: string) => `gplay_${orderId}`;
const refundId = (orderId: string) => `gplay_refund_${orderId}`;

type Get = (path: string) => Promise<Obj | null>;

/** GET on the Android Publisher API for the site's package. Null on any failure. */
function publisher(env: Env, site: Site, fetchFn: typeof fetch): Get {
  return async (path) => {
    const token = await googleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON!, ANDROID_PUBLISHER_SCOPE, fetchFn);
    const res = await fetchFn(`${PUBLISHER_BASE}${encodeURIComponent(site.android_package!)}/${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as Obj | null;
  };
}

/** The first token of a subscription: linkedPurchaseToken followed back, through D1 first and Google after. */
async function firstToken(db: D1Database, site: Site, get: Get, token: string, linked: string | null): Promise<string> {
  let first = token;
  let next = linked;
  for (let hop = 0; next && hop < MAX_LINK_HOPS; hop++) {
    const known = await db.prepare('SELECT 1 FROM payments WHERE site_id = ? AND subscription_id = ? LIMIT 1').bind(site.id, next).first();
    if (known) return next;
    first = next;
    const prev = await get(`purchases/subscriptionsv2/tokens/${encodeURIComponent(next)}`).catch(() => null);
    next = str(prev?.linkedPurchaseToken);
  }
  return first;
}

/** What the purchase resource says, for both kinds. */
interface Purchase {
  state: 'paid' | 'pending' | 'not_purchased';
  orderId: string | null;
  product: string | null;
  test: boolean;
  account: string | null;
  linked: string | null;
  startedAt: number | null;
  expiresAt: number | null;
  autoRenew: boolean | null;
  subState: string | null;
}

function readSubscription(r: Obj): Purchase {
  const items: Obj[] = Array.isArray(r.lineItems) ? r.lineItems : [];
  const line = items.find((li) => str(li?.latestSuccessfulOrderId)) ?? items[0] ?? {};
  const state = String(r.subscriptionState ?? '');
  // A canceled subscription was still paid for its period; only a signup that never paid writes nothing.
  const pending = state === 'SUBSCRIPTION_STATE_PENDING' || state === 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED' || !state || state === 'SUBSCRIPTION_STATE_UNSPECIFIED';
  return {
    state: pending ? 'pending' : 'paid',
    orderId: str(line.latestSuccessfulOrderId),
    product: str(line.productId),
    test: !!r.testPurchase,
    account: str(r.externalAccountIdentifiers?.obfuscatedExternalAccountId),
    linked: str(r.linkedPurchaseToken),
    startedAt: time(r.startTime),
    expiresAt: time(line.expiryTime),
    autoRenew: typeof line.autoRenewingPlan?.autoRenewEnabled === 'boolean' ? line.autoRenewingPlan.autoRenewEnabled : null,
    subState: state,
  };
}

function readProduct(r: Obj): Purchase {
  const ps = String(r.purchaseStateContext?.purchaseState ?? '');
  const items: Obj[] = Array.isArray(r.productLineItem) ? r.productLineItem : [];
  return {
    state: ps === 'PURCHASED' ? 'paid' : ps === 'PENDING' ? 'pending' : 'not_purchased',
    orderId: str(r.orderId),
    product: str(items[0]?.productId),
    test: !!r.testPurchaseContext,
    account: str(r.obfuscatedExternalAccountId),
    linked: null,
    startedAt: time(r.purchaseCompletionTime),
    expiresAt: null,
    autoRenew: null,
    subState: null,
  };
}

/** The visitor of a purchase: the app's install, else the obfuscated account id (the install id) through app_aliases. */
async function visitorOf(db: D1Database, site: Site, check: PlayCheck, p: Purchase): Promise<{ visitorId: string | null; matchedBy?: MatchedBy }> {
  if (check.visitorId) return { visitorId: check.visitorId, matchedBy: 'app_event' };
  if (p.account && /^[\w-]{8,64}$/.test(p.account)) return { visitorId: await appVisitorId(db, site.id, canonicalId(p.account)), matchedBy: 'app_account_token' };
  return { visitorId: null };
}

/**
 * Check one purchase token with Google and store what it paid. Exported for tests; production calls go through
 * checkPlayPurchaseLater, in waitUntil.
 */
export async function checkPlayPurchase(env: Env, db: D1Database, site: Site, check: PlayCheck, push?: Pusher, fetchFn: typeof fetch = fetch): Promise<PlayOutcome> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return 'no_service_account';
  if (!site.android_package) return 'no_package';
  const get = publisher(env, site, fetchFn);
  // The call is made for the site's own package, so a token of another app is not found (the answers name no package).
  const res = await get(`purchases/${check.kind === 'subs' ? 'subscriptionsv2' : 'productsv2'}/tokens/${encodeURIComponent(check.token)}`);
  if (!res) return 'error';
  const p = check.kind === 'subs' ? readSubscription(res) : readProduct(res);
  if (p.state === 'pending') return 'pending';
  if (p.state === 'not_purchased') return 'not_purchased';
  const provider = p.test ? (site.accept_sandbox ? PLAY_TEST_PROVIDER : null) : PLAY_PROVIDER;
  if (!provider) return 'sandbox_off';
  if (!p.orderId) return 'no_order';

  const id = paymentId(p.orderId);
  const first = check.kind === 'subs' ? await firstToken(db, site, get, check.token, p.linked) : check.token;
  const customerId = `gplay:${first}`;
  const product = p.product ?? check.product ?? null;
  const { visitorId, matchedBy } = await visitorOf(db, site, check, p);

  // Stored already (the app's event and a notification both report it): fill in a missing visitor, no Google call.
  const stored = await db.prepare('SELECT ts, amount, currency, renewal FROM payments WHERE id = ? AND site_id = ?').bind(id, site.id).first<{ ts: number; amount: number; currency: string; renewal: number }>();
  if (stored) {
    if (visitorId) {
      await recordPayment(
        db,
        site,
        { id, provider, ts: stored.ts, amount: stored.amount, kind: 'payment', currency: stored.currency, visitorId, sessionId: check.sessionId ?? null, matchedBy, customerId, subscriptionId: check.kind === 'subs' ? first : null, product, renewal: !!stored.renewal, timing: false },
        { fillIn: true, push },
      );
    }
    return 'duplicate';
  }

  // The amount: the order's total. No order, no row; the next notification for the token tries again.
  const order = await get(`orders/${encodeURIComponent(p.orderId)}`).catch(() => null);
  if (!order) return 'error';
  const orderState = String(order.state ?? '');
  if (orderState === 'PENDING' || orderState === 'CANCELED') return 'not_purchased';
  const money = playAmount(order.total);
  if (!money) return 'error';
  const ts = time(order.createTime) ?? p.startedAt ?? Date.now();
  const sessionId = check.sessionId ?? (visitorId ? await creditedSession(db, site, visitorId, ts) : null);

  if (money.amount <= 0) {
    // A free trial or a $0 offer is not revenue. A subscription's free start is a trial_start signal, as for Apple.
    if (check.kind === 'subs') {
      await recordSignal(db, site, { id: `gplay_trial_${p.orderId}`, provider, ts, type: 'trial_start', visitorId, sessionId, product, store: 'PLAY_STORE', sandbox: isTestProvider(provider) }, push);
      await recordSubscription(db, site, subscriptionEvent(provider, first, customerId, { visitorId, sessionId }, product, p, ts, null));
    }
    return 'free';
  }

  const prior =
    check.kind === 'subs'
      ? await db
          .prepare("SELECT 1 FROM payments WHERE site_id = ? AND subscription_id = ? AND kind = 'payment' AND id != ? AND ts < ? LIMIT 1")
          .bind(site.id, first, id, ts)
          .first()
      : null;
  const out = await recordPayment(
    db,
    site,
    {
      id,
      provider,
      ts,
      amount: money.amount,
      kind: 'payment',
      currency: money.currency,
      visitorId,
      sessionId,
      matchedBy,
      customerId,
      subscriptionId: check.kind === 'subs' ? first : null,
      product,
      renewal: !!prior,
      timing: false,
    },
    { fillIn: true, push },
  );
  if (check.kind === 'subs') await recordSubscription(db, site, subscriptionEvent(provider, first, customerId, { visitorId, sessionId }, product, p, ts, money));
  return out.inserted ? 'recorded' : 'duplicate';
}

/** The subscription row's update from a checked Play subscription (subscriptions.ts). */
function subscriptionEvent(
  provider: string,
  first: string,
  customerId: string,
  link: { visitorId: string | null; sessionId: string | null },
  product: string | null,
  p: Purchase,
  ts: number,
  money: { amount: number; currency: string } | null,
): SubEvent {
  const ev: SubEvent = { id: first, provider, at: ts, customerId, visitorId: link.visitorId, sessionId: link.sessionId, product, startedAt: p.startedAt ?? ts, expiresAt: p.expiresAt };
  const span = p.expiresAt && p.expiresAt > ts ? intervalFromSpan(p.expiresAt - ts) : null;
  if (money) {
    ev.paidAt = ts;
    if (span) ev.price = priceOf(money.amount, money.currency, span.interval, span.count);
  } else {
    Object.assign(ev, { trialStart: ts, trialEnd: p.expiresAt });
  }
  if (p.autoRenew !== null) ev.canceledAt = p.autoRenew ? null : ts;
  if (p.subState === 'SUBSCRIPTION_STATE_ON_HOLD' || p.subState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') ev.billingIssueAt = ts;
  else if (p.subState === 'SUBSCRIPTION_STATE_ACTIVE') ev.billingIssueAt = null;
  if (p.subState === 'SUBSCRIPTION_STATE_EXPIRED' && p.expiresAt) ev.endedAt = p.expiresAt;
  return ev;
}

/**
 * The check as waitUntil work: never throws, and converts the payment's currency and sends the alerts it queued
 * itself, since the request's own middleware ran before it.
 */
export async function checkPlayPurchaseLater(env: Env, site: Site, check: PlayCheck, push?: Pusher, fetchFn: typeof fetch = fetch): Promise<PlayOutcome> {
  let out: PlayOutcome = 'error';
  try {
    out = await checkPlayPurchase(env, env.DB, site, check, push, fetchFn);
  } catch (e) {
    if (!(e instanceof GoogleAuthError)) console.error('google play check failed', e);
    else console.error('google play check:', e.message);
  }
  await convertPayments(env.DB).catch(() => 0);
  await takeLater(env.DB);
  return out;
}

/** Several checks of one app batch, one after another, as one waitUntil job. */
export async function checkPlayPurchasesLater(env: Env, site: Site, checks: PlayCheck[], push?: Pusher, fetchFn: typeof fetch = fetch): Promise<PlayOutcome[]> {
  const out: PlayOutcome[] = [];
  for (const check of checks) out.push(await checkPlayPurchaseLater(env, site, check, push, fetchFn));
  return out;
}

/** A voided purchase: a negative row for gplay_<orderId>, linked like that payment. D1 only. */
export async function recordPlayRefund(db: D1Database, site: Site, orderId: string, ts: number, push?: Pusher): Promise<'refund' | 'duplicate' | 'no_original'> {
  const original = await db
    .prepare('SELECT * FROM payments WHERE id = ? AND site_id = ?')
    .bind(paymentId(orderId), site.id)
    .first<{
      provider: string; amount: number; currency: string; visitor_id: string | null; session_id: string | null; customer_id: string | null; subscription_id: string | null;
      product: string | null; channel: string | null; source: string | null; campaign: string | null;
    }>();
  // Only a payment we counted can be taken back out (same rule as App Store notifications).
  if (!original) return 'no_original';
  const rid = refundId(orderId);
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, subscription_id, product, channel, source, campaign)
       VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(rid, site.id, original.provider, ts, -Math.abs(original.amount), original.currency, original.visitor_id, original.session_id, original.customer_id, original.subscription_id, original.product, original.channel, original.source, original.campaign)
    .run();
  if (!res.meta.changes) return 'duplicate';
  await announce(push, site, {
    event: 'refund',
    id: rid,
    provider: original.provider,
    sandbox: isTestProvider(original.provider),
    amount: original.amount,
    currency: original.currency,
    product: original.product,
    sessionId: original.session_id,
  });
  return 'refund';
}

/** Decodes the Pub/Sub envelope's message.data (base64 JSON). Null when it is not one. */
export function decodePubSub(body: unknown): Obj | null {
  const data = (body as Obj | null)?.message?.data;
  if (typeof data !== 'string') return null;
  try {
    const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Real-time developer notifications: POST /api/webhooks/google/:siteId from a Pub/Sub push subscription with an OIDC
 * token (docs/APP-API.md section 9). The token check needs Google's signing keys, cached per isolate; it is the one
 * Google call in the request path, and it is I/O, not CPU. The purchase checks run after the answer.
 */
export async function handleGoogleWebhook(c: Context<AppEnv>, fetchFn: typeof fetch = fetch) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.android_package) return c.json({ error: 'set the Android package name in the site settings first' }, 400);
  if (!site.google_push_email) return c.json({ error: 'set the push service account email in the site settings first' }, 400);

  const auth = c.req.header('authorization') ?? '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth.trim())?.[1];
  if (!bearer) return c.json({ error: 'unauthorized' }, 401);
  const url = new URL(c.req.url);
  try {
    await verifyGoogleOidc(bearer, { audience: `${url.origin}${url.pathname}`, email: site.google_push_email }, fetchFn);
  } catch (e) {
    return c.json({ error: 'unauthorized', detail: e instanceof GoogleAuthError ? e.message : 'unverifiable' }, 401);
  }

  const n = decodePubSub(await c.req.json().catch(() => null));
  if (!n) return c.json({ error: 'expected a Pub/Sub message with base64 JSON data' }, 400);
  if (n.packageName !== site.android_package) {
    return c.json({ error: `notification is for ${String(n.packageName)}, this site expects ${site.android_package}` }, 400);
  }
  if (n.testNotification) return c.json({ ok: true, ignored: 'test' });

  const ts = Number(n.eventTimeMillis) || Date.now();
  const voided = n.voidedPurchaseNotification as Obj | undefined;
  if (voided) {
    const orderId = str(voided.orderId);
    if (!orderId) return c.json({ ok: true, ignored: 'invalid' });
    // A quantity-based partial refund takes back part of the order; its amount is not in the notification.
    if (Number(voided.refundType) === 2) return c.json({ ok: true, ignored: 'partial_refund' });
    return c.json({ ok: true, result: await recordPlayRefund(c.env.DB, site, orderId, ts, pusherOf(c)) });
  }

  let check: PlayCheck | null = null;
  const sub = n.subscriptionNotification as Obj | undefined;
  const one = n.oneTimeProductNotification as Obj | undefined;
  if (sub) {
    const type = Number(sub.notificationType);
    if (!PLAY_PAYMENT_SUBSCRIPTION_TYPES.has(type)) return c.json({ ok: true, ignored: `subscription_${type}` });
    if (typeof sub.purchaseToken === 'string') check = { token: sub.purchaseToken, kind: 'subs' };
  } else if (one) {
    const type = Number(one.notificationType);
    if (type !== PLAY_PAYMENT_ONE_TIME_TYPE) return c.json({ ok: true, ignored: `one_time_${type}` });
    if (typeof one.purchaseToken === 'string') check = { token: one.purchaseToken, kind: 'inapp', product: str(one.sku) };
  } else {
    return c.json({ ok: true, ignored: 'unknown' });
  }
  if (!check) return c.json({ ok: true, ignored: 'invalid' });
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) return c.json({ ok: true, ignored: 'no_service_account' });
  c.executionCtx.waitUntil(checkPlayPurchaseLater(c.env, site, check, pusherOf(c), fetchFn));
  return c.json({ ok: true, result: 'checking' });
}
