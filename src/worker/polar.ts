import type { Context } from 'hono';
import { getSite, type AppEnv, type Site } from './env';
import { verifyStandardWebhook } from './lib/crypto';
import { pusherOf, type Pusher } from './notify';
import { metaIds, minor, obj, providerSignal, providerSubscription, recordProviderPayment, setRefund, str, time } from './providers';
import { priceOf, type Interval, type SubEvent } from './subscriptions';
import { cancelReasonStatements } from './surveys';

/**
 * Polar webhook: POST /api/webhooks/polar/:siteId, signed the Standard Webhooks way (webhook-id, webhook-timestamp,
 * webhook-signature), with either of Polar's two keys (verifyPolarSignature). Orders read total_amount, which every API
 * version sends; 2027-01 drops amount.
 *
 *   order.paid             a paid order: one-time purchases, the first subscription payment and renewals
 *                          (billing_reason subscription_cycle)
 *   order.refunded         the order's refunded_amount, full or partial
 *   subscription.created   a trial (status trialing) is stored as a trial signal
 *   subscription.canceled  a cancellation
 *   subscription.revoked   an expiration: the subscription ended
 *   subscription.past_due  a billing issue
 *   subscription.*         every subscription event, and each paid order of a subscription, also updates the
 *                          subscription's row in the subscriptions table (MRR)
 *
 * Visitor ids come from the order's metadata, copied from the checkout: rt_visitor_id / rt_session_id from your
 * checkout code, or reference_id "rtv_<visitor id>" that the tracker adds to checkout links. Polar's sandbox is a
 * separate server with its own webhooks; connect only the production organization.
 */

export const POLAR_PROVIDER = 'polar';
const orderId = (id: string) => `polar_order_${id}`;

/**
 * Polar signs two ways, by when the endpoint's secret was made. A secret from 8 September 2026 on signs the Standard
 * Webhooks way: the key is the base64 after `whsec_`. An older secret, or one you typed, signs with the UTF-8 bytes of
 * the whole secret. Like Polar's SDK, this accepts either.
 */
export async function verifyPolarSignature(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now()) {
  const legacy = btoa(String.fromCharCode(...new TextEncoder().encode(secret)));
  if (await verifyStandardWebhook(legacy, headers, body, now)) return true;
  return secret.startsWith('whsec_') && verifyStandardWebhook(secret, headers, body, now);
}

export async function handlePolarWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.polar_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);
  const body = await c.req.text();
  const headers = {
    id: c.req.header('webhook-id') ?? null,
    timestamp: c.req.header('webhook-timestamp') ?? null,
    signature: c.req.header('webhook-signature') ?? null,
  };
  if (!(await verifyPolarSignature(site.polar_secret, headers, body))) return c.json({ error: 'invalid signature' }, 401);
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = await handlePolarEvent(c.env.DB, site, event, headers.id!, pusherOf(c));
  // Every other event is acknowledged so Polar doesn't retry it.
  return c.json({ ok: true, result });
}

export async function handlePolarEvent(db: D1Database, site: Site, event: Record<string, unknown>, messageId: string, push?: Pusher): Promise<string> {
  const o = obj(event.data);
  const type = str(event.type) ?? '';
  const id = str(o.id);
  if (!id) return 'ignored';
  const customer = obj(o.customer);
  const ids = metaIds({ ...obj(customer.metadata), ...obj(o.metadata) }, obj(o.metadata).reference_id);
  const ts = time(o.created_at) ?? Date.now();

  const order = () =>
    recordProviderPayment(db, site, {
      id: orderId(id),
      provider: POLAR_PROVIDER,
      ts,
      amount: minor(o.total_amount ?? o.amount),
      currency: str(o.currency)?.toUpperCase() ?? site.currency,
      meta: ids,
      customerId: str(o.customer_id) ?? str(customer.id),
      email: str(customer.email),
      name: str(customer.name),
      subscriptionId: str(o.subscription_id),
      product: str(obj(o.product).name),
      renewal: o.billing_reason === 'subscription_cycle',
    }, push);

  switch (type) {
    case 'order.paid': {
      if (o.paid === false || (o.status && o.status !== 'paid' && o.status !== 'refunded' && o.status !== 'partially_refunded')) return 'not paid';
      const result = await order();
      const sub = str(o.subscription_id);
      if (sub && result !== 'other site' && minor(o.total_amount ?? o.amount) > 0) {
        await providerSubscription(db, site, { id: sub, provider: POLAR_PROVIDER, at: ts, customerId: str(o.customer_id) ?? str(customer.id), paidAt: ts }, ids);
      }
      return result;
    }

    case 'order.refunded': {
      // The refund carries the whole order: store the order first in case order.paid has not arrived.
      const stored = await order();
      if (stored === 'other site') return stored;
      return setRefund(db, site, { rowId: `polar_refund_${id}`, provider: POLAR_PROVIDER, paymentId: orderId(id), amount: minor(o.refunded_amount), ts: time(o.modified_at) ?? Date.now() }, push);
    }

    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.active':
    case 'subscription.uncanceled':
    case 'subscription.canceled':
    case 'subscription.revoked':
    case 'subscription.past_due': {
      await providerSubscription(db, site, subscriptionEvent(id, o), ids);
      // The reason the customer gave when canceling (customer_cancellation_reason and _comment): a cancel_reason answer
      // (surveys.ts). Polar's reasons are Stripe's keys. Keyed by canceled_at, so .canceled then .revoked write it once.
      const canceledAt = time(o.canceled_at);
      if (canceledAt && (type === 'subscription.canceled' || type === 'subscription.revoked' || type === 'subscription.updated') && !(ids.siteId && ids.siteId !== site.id)) {
        const answer = cancelReasonStatements(db, site, { provider: 'polar', subscriptionId: id, canceledAt, feedback: str(o.customer_cancellation_reason), comment: str(o.customer_cancellation_comment), visitorId: ids.visitorId });
        if (answer.length) await db.batch(answer);
      }
      if (type === 'subscription.updated' || type === 'subscription.active' || type === 'subscription.uncanceled') return 'updated';
      const signal =
        type === 'subscription.created' ? (o.status === 'trialing' ? 'trial_start' : null)
        : type === 'subscription.canceled' ? 'cancellation'
        : type === 'subscription.revoked' ? 'expiration'
        : 'billing_issue';
      if (!signal) return 'ignored';
      return providerSignal(db, site, {
        // A retry of a webhook keeps its webhook-id.
        id: `polar_${messageId}`,
        provider: POLAR_PROVIDER,
        ts: time(o.modified_at) ?? ts,
        type: signal,
        meta: ids,
        subscriptionId: id,
        customerId: str(o.customer_id) ?? str(customer.id),
        product: str(obj(o.product).name),
        reason: str(o.customer_cancellation_reason),
      }, push);
    }
  }
  return 'ignored';
}

const INTERVALS = new Set(['day', 'week', 'month', 'year']);

/** A Polar Subscription object as a subscriptions-table event. */
function subscriptionEvent(id: string, o: Record<string, any>): SubEvent {
  const status = str(o.status) ?? '';
  const at = time(o.modified_at) ?? time(o.created_at) ?? Date.now();
  const startedAt = time(o.started_at) ?? time(o.created_at) ?? at;
  const trialEnd = time(o.trial_end);
  const ended = status === 'incomplete_expired' || (status === 'canceled' && !!time(o.ended_at));
  const paying = status === 'active' || status === 'past_due' || status === 'unpaid' || (status === 'canceled' && !ended);
  const amount = minor(o.amount);
  const interval = INTERVALS.has(o.recurring_interval) ? (o.recurring_interval as Interval) : null;
  return {
    id,
    provider: POLAR_PROVIDER,
    at,
    customerId: str(o.customer_id),
    product: str(obj(o.product).name),
    price: amount > 0 && interval && str(o.currency) ? priceOf(amount, str(o.currency)!, interval, minor(o.recurring_interval_count) || 1) : undefined,
    startedAt,
    trialStart: time(o.trial_start),
    trialEnd,
    paidAt: paying ? (trialEnd ? Math.min(trialEnd, at) : startedAt) : undefined,
    expiresAt: time(o.current_period_end) ?? time(o.ends_at),
    canceledAt: o.cancel_at_period_end === true || status === 'canceled' ? (time(o.canceled_at) ?? at) : null,
    endedAt: ended ? (time(o.ended_at) ?? at) : null,
    billingIssueAt: status === 'past_due' || status === 'unpaid' ? at : undefined,
  };
}
