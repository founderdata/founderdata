import type { Context } from 'hono';
import { getSite, type AppEnv, type Site } from './env';
import { verifyStripeSignature } from './lib/crypto';
import { announce, pusherOf, type Pusher } from './notify';
import { convertPayments } from './fx';
import { creditedVisitSql, currencyDecimals, recordPayment } from './payments';
import { cancelReasonStatements } from './surveys';
import { recordSubscription, stripeInvoiceEvent, stripeInvoiceProduct, stripeSubscriptionEvent, subscriptionElsewhere } from './subscriptions';

/**
 * Stripe webhook: POST /api/webhooks/stripe/:siteId, signed with the site's endpoint secret.
 *
 *   checkout.session.completed, checkout.session.async_payment_succeeded (SEPA and other delayed methods)
 *                               Checkout payments (mode=payment). For subscriptions, links the
 *                               subscription to the visitor; the payment itself comes with invoice.paid.
 *   invoice.paid                subscription and invoice payments, first and renewals
 *   invoice_payment.paid        API 2025-03-31 and later: which PaymentIntent paid which invoice
 *   payment_intent.succeeded    payments made without Checkout or an invoice
 *   charge.succeeded            payments made with the old Charges API (no PaymentIntent)
 *   charge.refunded             refunds: the charge's amount_refunded
 *   refund.created/.updated/.failed   each refund, so a failed or canceled refund comes back off
 *   charge.dispute.*            disputes: a lost dispute subtracts like a refund, a won one does not
 *   customer.subscription.created/.updated/.deleted, invoice.payment_failed
 *                               subscription state for MRR, trials and churn (subscriptions.ts); invoice.paid and the
 *                               subscription Checkout feed it too
 *
 * One payment arrives through several of these (Checkout, its PaymentIntent, the invoice). Every Stripe id an event
 * carries is linked to the payment in stripe_objects, so the payment is stored once, keyed by its PaymentIntent (else
 * its charge, invoice or Checkout Session), and a repeat can only fill in a missing visitor. When two stored rows turn
 * out to be one payment, they are merged.
 * Visitor ids come from metadata rt_visitor_id / rt_session_id (what founderdata.attribution() returns),
 * or from client_reference_id "rtv_<visitor id>" that the tracker adds to Payment Links. The minilytics
 * names (ml_* metadata, "mlv_" references) are still accepted.
 * Which site gets a payment when several share one Stripe account: see ownerOf.
 */

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** Stripe fields that hold either an id or the expanded object. */
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);
const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

const ZERO_DECIMAL = new Set('BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF UGX VND VUV XAF XOF XPF'.split(' '));
const THREE_DECIMAL = new Set('BHD JOD KWD OMR TND'.split(' '));

/** Stripe amounts are in Stripe's minor unit; convert to ours (which follows ISO 4217, e.g. ISK has none). */
export function stripeToMinor(amount: number, currency: string): number {
  const c = currency.toUpperCase();
  const stripeDecimals = ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
  return Math.round(amount * 10 ** (currencyDecimals(c) - stripeDecimals));
}

export function visitorIds(metadata: unknown, clientReferenceId?: unknown) {
  const m = obj(metadata);
  const ref = str(clientReferenceId);
  const fromRef = (ref?.startsWith('rtv_') || ref?.startsWith('mlv_')) && isId(ref.slice(4)) ? ref.slice(4) : null;
  const visitorId = [m.rt_visitor_id, m.ml_visitor_id].find(isId);
  const sessionId = [m.rt_session_id, m.ml_session_id].find(isId);
  return {
    visitorId: visitorId ?? fromRef,
    sessionId: sessionId ?? null,
    siteId: str(m.rt_site_id) ?? str(m.ml_site_id),
  };
}

/** Invoice -> PaymentIntent across API versions (2025-03-31 moved it to invoice.payments). */
function invoicePaymentIntent(inv: Obj): string | null {
  return idOf(inv.payment_intent) ?? idOf(obj(obj(obj(inv.payments).data?.[0]).payment).payment_intent);
}
const invoiceSubscription = (inv: Obj) => idOf(inv.subscription) ?? idOf(obj(obj(inv.parent).subscription_details).subscription);
/**
 * The product of a payment without an invoice: metadata.product (or product_name) that your checkout code sets, else
 * the first line item when the event carries them expanded.
 */
function checkoutProduct(o: Obj): string | null {
  const m = obj(o.metadata);
  const item = obj(Array.isArray(obj(o.line_items).data) ? obj(o.line_items).data[0] : null);
  const price = obj(item.price);
  return str(m.product) ?? str(m.product_name) ?? str(obj(price.product).name) ?? str(item.description) ?? str(price.nickname) ?? idOf(price.product);
}

const invoiceMetadata = (inv: Obj) => {
  const sub = obj(inv.subscription_details).metadata ?? obj(obj(inv.parent).subscription_details).metadata;
  return { ...obj(inv.metadata), ...obj(sub) };
};

export async function handleStripeWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.stripe_webhook_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);
  const body = await c.req.text();
  if (!(await verifyStripeSignature(body, c.req.header('stripe-signature'), site.stripe_webhook_secret))) {
    return c.json({ error: 'invalid signature' }, 401);
  }
  let event: Obj;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = await handleStripeEvent(c.env.DB, site, event, pusherOf(c));
  // Everything else is acknowledged so Stripe doesn't retry it.
  return c.json({ ok: true, result });
}

export async function handleStripeEvent(db: D1Database, site: Site, event: Obj, push?: Pusher): Promise<string> {
  const o = obj(obj(event.data).object);
  const ts = Number(event.created) ? Number(event.created) * 1000 : Date.now();
  const currency = str(o.currency)?.toUpperCase() ?? null;
  const type = String(event.type ?? '');

  switch (type) {
    // A delayed method (SEPA Direct Debit, Sofort, bank transfer) completes the session unpaid; the payment comes with
    // checkout.session.async_payment_succeeded, which carries the same session and metadata.
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const ids = visitorIds(o.metadata, o.client_reference_id);
      if (ids.siteId && ids.siteId !== site.id) return 'other site';
      const subscription = idOf(o.subscription);
      if (o.mode === 'subscription') {
        if (!subscription || !ids.visitorId) return 'linked';
        if ((await ownerOf(db, site, { visitorId: ids.visitorId, subscriptionId: subscription, url: str(o.success_url) })) === 'elsewhere') return 'other site';
        await linkSubscription(db, site, subscription, ids.visitorId, ts);
        await recordSubscription(db, site, { id: subscription, provider: 'stripe', at: ts, customerId: idOf(o.customer), visitorId: ids.visitorId, sessionId: ids.sessionId });
        return 'linked';
      }
      if (o.payment_status !== 'paid' || !currency || !(Number(o.amount_total) > 0)) return 'not paid';
      const details = obj(o.customer_details);
      return recordStripePayment(db, site, {
        keys: { pi: idOf(o.payment_intent), session: str(o.id), invoice: idOf(o.invoice) },
        amount: Number(o.amount_total),
        currency,
        ts,
        ids,
        customerId: idOf(o.customer),
        email: str(details.email) ?? str(o.customer_email),
        name: str(details.name),
        url: str(o.success_url),
        product: checkoutProduct(o),
      }, push);
    }

    case 'invoice.paid': {
      const amount = Number(o.amount_paid) || 0;
      if (amount <= 0 || !currency) return 'nothing paid';
      const ids = visitorIds(invoiceMetadata(o));
      const subscription = invoiceSubscription(o);
      const reason = str(o.billing_reason);
      const result = await recordStripePayment(db, site, {
        // Before API 2025-03-31 the invoice names its PaymentIntent (or charge); after it, invoice_payment.paid does.
        keys: { invoice: str(o.id), pi: invoicePaymentIntent(o), charge: idOf(o.charge) },
        amount,
        currency,
        ts,
        ids,
        customerId: idOf(o.customer),
        email: str(o.customer_email),
        name: str(o.customer_name),
        subscriptionId: subscription,
        renewal: !!subscription && reason !== 'subscription_create' && reason !== 'manual',
        product: stripeInvoiceProduct(o) ?? str(invoiceMetadata(o).product),
      }, push);
      // The payment went to this site: so does its subscription.
      if (subscription && (result === 'recorded' || result === 'already recorded')) {
        await recordSubscription(db, site, { ...stripeInvoiceEvent(o, subscription, ts, true), visitorId: ids.visitorId, sessionId: ids.sessionId });
      }
      return result;
    }

    case 'invoice.payment_failed': {
      const subscription = invoiceSubscription(o);
      if (!subscription) return 'not a subscription';
      const ids = visitorIds(invoiceMetadata(o));
      const owner = await subscriptionOwner(db, site, subscription, ids, idOf(o.customer));
      if (owner !== 'here') return owner;
      await recordSubscription(db, site, { ...stripeInvoiceEvent(o, subscription, ts, false), visitorId: ids.visitorId, sessionId: ids.sessionId });
      return 'billing issue';
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const ev = stripeSubscriptionEvent(o, ts);
      if (!ev) return 'no subscription';
      const ids = visitorIds(o.metadata);
      const owner = await subscriptionOwner(db, site, ev.id, ids, ev.customerId ?? null);
      if (owner !== 'here') return owner;
      const outcome = await recordSubscription(db, site, { ...ev, visitorId: ids.visitorId, sessionId: ids.sessionId });
      // The cancellation reason the customer picked in the Customer Portal (cancellation_details.feedback and comment):
      // a cancel_reason answer (surveys.ts). Stripe sends it on .updated when the cancel is at the period's end and again
      // on .deleted; both carry the same canceled_at, so the second writes nothing.
      const why = obj(o.cancellation_details);
      const canceledAt = Number(o.canceled_at);
      if (Number.isFinite(canceledAt) && canceledAt > 0) {
        const answer = cancelReasonStatements(db, site, { provider: 'stripe', subscriptionId: ev.id, canceledAt: canceledAt * 1000, feedback: str(why.feedback), comment: str(why.comment), visitorId: ids.visitorId });
        if (answer.length) await db.batch(answer);
      }
      return `subscription ${outcome}`;
    }

    case 'invoice_payment.paid': {
      // API 2025-03-31 and later: the link between an invoice and the PaymentIntent (or charge) that paid it.
      const pay = obj(o.payment);
      return linkObjects(db, site, { invoice: idOf(o.invoice), pi: idOf(pay.payment_intent), charge: idOf(pay.charge) });
    }

    case 'payment_intent.succeeded': {
      // Invoice payments are recorded by invoice.paid. Before API 2025-03-31 the PaymentIntent names its invoice.
      // After it, nothing on the PaymentIntent does: invoice_payment.paid links the two (and merges two rows if both
      // were stored), and Stripe's own invoice descriptions keep endpoints without that event from counting twice.
      if (idOf(o.invoice)) {
        await linkObjects(db, site, { pi: str(o.id), invoice: idOf(o.invoice) });
        return 'invoice payment';
      }
      if (INVOICE_DESCRIPTION.test(str(o.description) ?? '')) return 'invoice payment';
      const amount = Number(o.amount_received) || Number(o.amount) || 0;
      if (amount <= 0 || !currency) return 'nothing paid';
      return recordStripePayment(db, site, {
        keys: { pi: str(o.id), charge: idOf(o.latest_charge) },
        amount,
        currency,
        ts,
        ids: visitorIds(o.metadata),
        customerId: idOf(o.customer),
        email: str(o.receipt_email),
        product: checkoutProduct(o),
      }, push);
    }

    case 'charge.succeeded':
    case 'charge.captured': {
      // Only charges made without a PaymentIntent (the old Charges API); the others arrive as PaymentIntents.
      if (idOf(o.payment_intent)) return 'payment intent';
      if (idOf(o.invoice)) return 'invoice payment';
      if (o.captured === false) return 'not captured';
      if (o.paid === false || (o.status && o.status !== 'succeeded')) return 'not paid';
      const amount = Number(o.amount_captured) || Number(o.amount) || 0;
      if (amount <= 0 || !currency) return 'nothing paid';
      const billing = obj(o.billing_details);
      return recordStripePayment(db, site, {
        keys: { charge: str(o.id) },
        amount,
        currency,
        ts,
        ids: visitorIds(o.metadata),
        customerId: idOf(o.customer),
        email: str(billing.email) ?? str(o.receipt_email),
        name: str(billing.name),
        product: checkoutProduct(o),
      }, push);
    }

    case 'charge.refunded': {
      const charge = str(o.id);
      if (!charge || !currency) return 'no payment';
      // The charge's own row is written below, with its amount_refunded.
      const found = await paymentFor(db, site, { charge, pi: idOf(o.payment_intent), invoice: idOf(o.invoice) }, charge);
      if (typeof found === 'string') return found;
      // Older API versions list the charge's refunds; newer ones send them as refund.* events.
      for (const r of Array.isArray(obj(o.refunds).data) ? (obj(o.refunds).data as unknown[]) : []) {
        const ro = obj(r);
        if (str(ro.id)) await saveRefund(db, site, found.id, charge, ro, ts);
      }
      await db
        .prepare(
          `INSERT INTO stripe_objects (id, site_id, payment_id, amount, at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET amount = excluded.amount, at = excluded.at
           WHERE stripe_objects.amount IS NULL OR stripe_objects.at IS NULL OR excluded.at >= stripe_objects.at`,
        )
        .bind(charge, site.id, found.id, Number(o.amount_refunded) || 0, ts)
        .run();
      return settleRefunds(db, site, found, charge, ts, push);
    }

    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
    case 'charge.refund.updated': {
      const charge = idOf(o.charge);
      const pi = idOf(o.payment_intent);
      const group = charge ?? pi;
      if (!group || !str(o.id)) return 'no payment';
      const found = await paymentFor(db, site, { charge, pi });
      if (typeof found === 'string') return found;
      await saveRefund(db, site, found.id, group, o, ts);
      return settleRefunds(db, site, found, group, ts, push);
    }

    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated':
      return handleDispute(db, site, o, ts, push);
  }
  return 'ignored';
}

/**
 * Whether a subscription event is this site's, by the payment rules (ownerOf), after two of its own: a subscription
 * another site already holds stays there, and one this site holds stays here.
 */
async function subscriptionOwner(
  db: D1Database,
  site: Site,
  subscription: string,
  ids: ReturnType<typeof visitorIds>,
  customerId: string | null,
): Promise<'here' | 'other site' | 'not pinned'> {
  if (ids.siteId) return ids.siteId === site.id ? 'here' : 'other site';
  if (await subscriptionElsewhere(db, site, subscription)) return 'other site';
  if (await db.prepare('SELECT 1 FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, subscription).first()) return 'here';
  const owner = await ownerOf(db, site, { visitorId: ids.visitorId, subscriptionId: subscription, customerId });
  if (owner === 'elsewhere') return 'other site';
  return owner || site.stripe_unpinned ? 'here' : 'not pinned';
}

/** Descriptions Stripe gives the PaymentIntent of an invoice. */
const INVOICE_DESCRIPTION = /^(Subscription (creation|update|cycle)|Payment for Invoice)/;

// ---------- one payment, many Stripe ids

/** The Stripe ids one event knows for a payment. */
interface Keys {
  pi?: string | null;
  charge?: string | null;
  invoice?: string | null;
  session?: string | null;
}
const keyList = (k: Keys) => [...new Set([k.pi, k.charge, k.invoice, k.session].filter((x): x is string => !!x))];
/** The id a new payment gets: the PaymentIntent, else the charge, the invoice, the Checkout Session. */
const canonicalId = (k: Keys) => k.pi ?? k.charge ?? k.invoice ?? k.session ?? null;

interface StoredPayment {
  id: string;
  site_id: string;
  ts: number;
  currency: string;
  visitor_id: string | null;
  session_id: string | null;
  matched_by: string | null;
  customer_id: string | null;
  email: string | null;
  name: string | null;
  subscription_id: string | null;
  renewal: number;
  product: string | null;
  channel: string | null;
  source: string | null;
  campaign: string | null;
}

/** Stored Stripe payments any of these ids belong to, on any site. */
async function storedPayments(db: D1Database, keys: string[]): Promise<StoredPayment[]> {
  if (!keys.length) return [];
  const marks = keys.map(() => '?').join(', ');
  const res = await db
    .prepare(
      `SELECT * FROM payments WHERE provider = 'stripe' AND kind = 'payment' AND (id IN (${marks})
         OR id IN (SELECT payment_id FROM stripe_objects WHERE id IN (${marks})))
       ORDER BY ts, id`,
    )
    .bind(...keys, ...keys)
    .all<StoredPayment>();
  return res.results;
}

/**
 * Point these Stripe ids at a payment. An id already pointing at a stored payment keeps it. The payment's own id needs
 * no link (payments.id finds it), so a plain payment costs no extra row.
 */
async function link(db: D1Database, site: Site, paymentId: string, ids: string[]) {
  const keys = ids.filter((k) => k !== paymentId);
  if (!keys.length) return;
  await db.batch(
    keys.map((k) =>
      db
        .prepare(
          `INSERT INTO stripe_objects (id, site_id, payment_id) VALUES (?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET payment_id = excluded.payment_id
           WHERE stripe_objects.payment_id != excluded.payment_id
             AND NOT EXISTS (SELECT 1 FROM payments WHERE id = stripe_objects.payment_id AND kind = 'payment')`,
        )
        .bind(k, site.id, paymentId),
    ),
  );
}

/**
 * Two stored rows turned out to be one payment (an invoice row and its PaymentIntent row, linked by
 * invoice_payment.paid). Keep the first, fill its gaps from the other, delete the other, repoint its ids.
 */
async function merge(db: D1Database, rows: StoredPayment[]): Promise<StoredPayment> {
  const [keep, ...rest] = rows;
  for (const other of rest) {
    const linked = !keep.visitor_id && other.visitor_id;
    const fromInvoice = other.subscription_id && !keep.subscription_id;
    await db.batch([
      db
        .prepare(
          `UPDATE payments SET visitor_id = ?, session_id = ?, matched_by = ?, channel = ?, source = ?, campaign = ?, customer_id = COALESCE(customer_id, ?),
             email = COALESCE(email, ?), name = COALESCE(name, ?), subscription_id = COALESCE(subscription_id, ?),
             renewal = ?, product = COALESCE(product, ?) WHERE id = ?`,
        )
        .bind(
          linked ? other.visitor_id : keep.visitor_id,
          linked ? other.session_id : keep.session_id,
          linked ? other.matched_by : keep.matched_by,
          linked ? other.channel : keep.channel,
          linked ? other.source : keep.source,
          linked ? other.campaign : keep.campaign,
          other.customer_id,
          other.email,
          other.name,
          other.subscription_id,
          fromInvoice ? other.renewal : keep.renewal,
          other.product,
          keep.id,
        ),
      db.prepare('DELETE FROM payments WHERE id = ?').bind(other.id),
      db.prepare('UPDATE stripe_objects SET payment_id = ? WHERE payment_id = ?').bind(keep.id, other.id),
      db.prepare('INSERT OR IGNORE INTO stripe_objects (id, site_id, payment_id) VALUES (?, ?, ?)').bind(other.id, other.site_id, keep.id),
    ]);
    if (linked) {
      Object.assign(keep, { visitor_id: other.visitor_id, session_id: other.session_id, matched_by: other.matched_by, channel: other.channel, source: other.source, campaign: other.campaign });
    }
    keep.subscription_id ??= other.subscription_id;
  }
  return keep;
}

/** The one stored payment these ids belong to: merges duplicates, and says when another site owns it. */
async function resolve(db: D1Database, site: Site, keys: string[]): Promise<StoredPayment | 'other site' | null> {
  const rows = await storedPayments(db, keys);
  if (!rows.length) return null;
  if (rows.some((r) => r.site_id !== site.id)) return 'other site';
  return rows.length > 1 ? merge(db, rows) : rows[0];
}

/** For refunds, disputes and links: the payment this site stored for these ids. */
async function paymentFor(db: D1Database, site: Site, k: Keys, skipLink?: string): Promise<StoredPayment | 'other site' | 'no payment'> {
  const keys = keyList(k);
  const found = await resolve(db, site, keys);
  if (!found) return 'no payment';
  if (typeof found === 'string') return found;
  await link(db, site, found.id, keys.filter((x) => x !== skipLink));
  return found;
}

/** invoice_payment.paid (and the old PaymentIntent.invoice): these ids are one payment, stored or still to come. */
async function linkObjects(db: D1Database, site: Site, k: Keys): Promise<string> {
  const keys = keyList(k);
  if (keys.length < 2) return 'nothing to link';
  const found = await resolve(db, site, keys);
  if (found === 'other site') return found;
  // Not stored yet: the payment will get its usual id, and the ids point at it ahead of time.
  const target = found?.id ?? (await pendingId(db, keys)) ?? canonicalId(k)!;
  await link(db, site, target, keys);
  return found ? 'linked' : 'linked ahead';
}

/** A payment id these Stripe ids were linked to before the payment was stored. */
async function pendingId(db: D1Database, keys: string[]): Promise<string | null> {
  if (!keys.length) return null;
  const row = await db
    .prepare(`SELECT payment_id FROM stripe_objects WHERE id IN (${keys.map(() => '?').join(', ')}) ORDER BY payment_id LIMIT 1`)
    .bind(...keys)
    .first<{ payment_id: string }>();
  return row?.payment_id ?? null;
}

// ---------- which site a payment belongs to

/**
 * Several sites can share one Stripe account, and then every site's endpoint gets every event. A new payment goes to
 * one site, decided by the first of these that applies:
 *  1. metadata rt_site_id (or ml_site_id) names a site (checked before this)
 *  2. the visitor id in the metadata or client_reference_id belongs to a site's visits
 *  3. the subscription already belongs to a site (an earlier payment, or a Checkout that linked it)
 *  4. the Stripe customer already paid on a site
 *  5. the Checkout's success_url is on a site's domain
 * Returns null when nothing ties the payment to a site; then only sites with stripe_unpinned on record it.
 * A payment stored by one site is never stored by another: payments and stripe_objects are keyed by Stripe ids.
 */
async function ownerOf(
  db: D1Database,
  site: Site,
  t: { visitorId?: string | null; subscriptionId?: string | null; customerId?: string | null; url?: string | null },
): Promise<'here' | 'elsewhere' | null> {
  const others = `(SELECT id FROM sites WHERE stripe_webhook_secret IS NOT NULL AND id != ?)`;
  if (t.visitorId) {
    const [here, there] = await db.batch([
      db.prepare('SELECT 1 FROM sessions WHERE site_id = ? AND visitor_id = ? LIMIT 1').bind(site.id, t.visitorId),
      db.prepare(`SELECT 1 FROM sessions WHERE site_id IN ${others} AND visitor_id = ? LIMIT 1`).bind(site.id, t.visitorId),
    ]);
    if (here.results.length) return 'here';
    if (there.results.length) return 'elsewhere';
  }
  const owner = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ site_id: string }>())?.site_id ?? null;
  const decide = (siteId: string | null) => (siteId ? (siteId === site.id ? 'here' : 'elsewhere') : null);
  if (t.subscriptionId) {
    const s = await owner(
      `SELECT site_id FROM payments WHERE provider = 'stripe' AND subscription_id = ?1
       UNION ALL SELECT site_id FROM payment_claims WHERE payment_id = ?1 LIMIT 1`,
      t.subscriptionId,
    );
    if (s) return decide(s);
  }
  if (t.customerId) {
    const s = await owner(`SELECT site_id FROM payments WHERE provider = 'stripe' AND customer_id = ? ORDER BY ts LIMIT 1`, t.customerId);
    if (s) return decide(s);
  }
  const host = hostOf(t.url);
  if (host) {
    const s = await owner(`SELECT id AS site_id FROM sites WHERE lower(domain) IN (?, ?) ORDER BY (id = ?) DESC LIMIT 1`, host, `www.${host}`, site.id);
    if (s) return decide(s);
  }
  return null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

interface StripePaymentInput {
  keys: Keys;
  /** In Stripe's minor unit. */
  amount: number;
  currency: string;
  ts: number;
  ids: ReturnType<typeof visitorIds>;
  customerId: string | null;
  email: string | null;
  name?: string | null;
  subscriptionId?: string | null;
  renewal?: boolean;
  url?: string | null;
  /** What was bought: the invoice line's product, or the Checkout's metadata.product. */
  product?: string | null;
}

/**
 * Store a Stripe payment once, whichever event and API version brings it: the Stripe ids it carries find a payment
 * already stored (a repeat can only fill in the visitor, subscription or customer), else it is new and goes to the
 * site that owns it (ownerOf).
 */
async function recordStripePayment(db: D1Database, site: Site, p: StripePaymentInput, push?: Pusher): Promise<string> {
  if (p.ids.siteId && p.ids.siteId !== site.id) return 'other site';
  const keys = keyList(p.keys);
  const found = await resolve(db, site, keys);
  if (found === 'other site') return found;
  if (!found) {
    const owner = await ownerOf(db, site, { visitorId: p.ids.visitorId, subscriptionId: p.subscriptionId, customerId: p.customerId, url: p.url });
    if (owner === 'elsewhere') return 'other site';
    if (!owner && !p.ids.siteId && !site.stripe_unpinned) return 'not pinned';
  }
  const id = found?.id ?? (await pendingId(db, keys)) ?? canonicalId(p.keys)!;
  const res = await recordPayment(
    db,
    site,
    {
      id,
      provider: 'stripe',
      ts: p.ts,
      amount: stripeToMinor(p.amount, p.currency),
      kind: 'payment',
      currency: p.currency,
      visitorId: p.ids.visitorId,
      sessionId: p.ids.sessionId,
      customerId: p.customerId,
      email: p.email?.toLowerCase() ?? null,
      name: p.name ?? null,
      subscriptionId: p.subscriptionId ?? null,
      renewal: p.renewal,
      product: p.product ?? null,
    },
    { fillIn: true, push },
  );
  const stmts = [];
  if (!res.inserted && (p.subscriptionId || p.customerId || p.email || p.name || p.product)) {
    // The invoice knows the subscription, the product and whether this is a renewal; a PaymentIntent stored first did not.
    stmts.push(
      db
        .prepare(
          `UPDATE payments SET customer_id = COALESCE(customer_id, ?), email = COALESCE(email, ?), name = COALESCE(name, ?),
             renewal = CASE WHEN subscription_id IS NULL AND ? IS NOT NULL THEN ? ELSE renewal END,
             subscription_id = COALESCE(subscription_id, ?), product = COALESCE(product, ?)
           WHERE site_id = ? AND id = ?`,
        )
        .bind(p.customerId, p.email?.toLowerCase() ?? null, p.name ?? null, p.subscriptionId ?? null, p.renewal ? 1 : 0, p.subscriptionId ?? null, p.product?.slice(0, 200) ?? null, site.id, id),
    );
  }
  if (stmts.length) await db.batch(stmts);
  // A Checkout Session id comes only with checkout.session.completed, which also names the PaymentIntent.
  await link(db, site, id, keys.filter((k) => k !== p.keys.session));
  return res.inserted ? 'recorded' : 'already recorded';
}

// ---------- refunds and disputes

const DEAD_REFUND = new Set(['failed', 'canceled']);

/** Store a refund object's state. A failed or canceled refund stays that way, whatever arrives later. */
async function saveRefund(db: D1Database, site: Site, paymentId: string, charge: string, r: Obj, ts: number) {
  await db
    .prepare(
      `INSERT INTO stripe_objects (id, site_id, payment_id, charge, amount, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET amount = excluded.amount, status = excluded.status, at = excluded.at, charge = excluded.charge
       WHERE COALESCE(stripe_objects.status, '') NOT IN ('failed', 'canceled')`,
    )
    .bind(String(r.id), site.id, paymentId, charge, Number(r.amount) || 0, str(r.status) ?? 'succeeded', ts)
    .run();
}

/**
 * The amount refunded on one charge, in Stripe's minor unit, from what FounderData has seen:
 * - refund objects (refund.* events, or the charge's refund list on older API versions): the ones not failed or canceled
 * - the charge's amount_refunded from charge.refunded, for endpoints that do not send refund.* events, less refunds
 *   that failed after that charge.refunded
 * When the refund objects account for amount_refunded, they decide; otherwise the larger of the two counts.
 */
export function refundedOnCharge(
  total: { amount: number; at: number } | null,
  refunds: { amount: number; status: string | null; at: number | null }[],
): number {
  const live = refunds.filter((r) => !DEAD_REFUND.has(r.status ?? '')).reduce((n, r) => n + r.amount, 0);
  if (!total) return live;
  const all = refunds.reduce((n, r) => n + r.amount, 0);
  if (all >= total.amount) return live;
  const failedSince = refunds.filter((r) => DEAD_REFUND.has(r.status ?? '') && (r.at ?? 0) > total.at).reduce((n, r) => n + r.amount, 0);
  return Math.max(live, total.amount - failedSince);
}

/** Write the charge's refund row (stripe_refund_<charge>), one negative row holding what is refunded now; none at 0. */
async function settleRefunds(db: D1Database, site: Site, original: StoredPayment, charge: string, ts: number, push?: Pusher): Promise<string> {
  const [t, r] = await db.batch([
    db.prepare('SELECT amount, at FROM stripe_objects WHERE id = ? AND amount IS NOT NULL').bind(charge),
    db.prepare('SELECT amount, status, at FROM stripe_objects WHERE charge = ? AND id != ?').bind(charge, charge),
  ]);
  const total = (t.results[0] as { amount: number; at: number } | undefined) ?? null;
  const refunded = refundedOnCharge(total, r.results as { amount: number; status: string | null; at: number | null }[]);
  const refundId = `stripe_refund_${charge}`;
  if (refunded <= 0) {
    const del = await db.prepare("DELETE FROM payments WHERE id = ? AND site_id = ? AND kind = 'refund'").bind(refundId, site.id).run();
    return del.meta.changes ? 'refund reversed' : 'nothing refunded';
  }
  const amount = stripeToMinor(refunded, original.currency);
  return writeRefundRow(db, site, original, refundId, amount, ts, push, 'refund recorded');
}

/** Upsert a negative row for a refund or a lost dispute; only a new row pushes. A repeat leaves its time alone. */
async function writeRefundRow(db: D1Database, site: Site, original: StoredPayment, rowId: string, amount: number, ts: number, push: Pusher | undefined, result: string) {
  const seen = await db.prepare('SELECT 1 FROM payments WHERE id = ?').bind(rowId).first();
  await db
    .prepare(
      `INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name, subscription_id, product,
                             channel, source, campaign)
       VALUES (?, ?, 'stripe', ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET amount = excluded.amount, ts = excluded.ts, amount_conv = NULL
       WHERE payments.amount != excluded.amount`,
    )
    .bind(
      rowId,
      site.id,
      ts,
      -Math.abs(amount),
      original.currency,
      original.visitor_id,
      original.session_id,
      original.customer_id,
      original.email,
      original.name,
      original.subscription_id,
      original.product,
      original.channel,
      original.source,
      original.campaign,
    )
    .run();
  if (original.currency !== site.currency) await convertPayments(db, fetch, { rescan: true }).catch(() => 0);
  if (!seen) {
    await announce(push, site, {
      event: 'refund',
      id: rowId,
      provider: 'stripe',
      sandbox: false,
      amount: Math.abs(amount),
      currency: original.currency,
      product: original.product,
      sessionId: original.session_id,
    });
  }
  return result;
}

const CLOSED_DISPUTE = new Set(['won', 'lost', 'warning_closed', 'prevented']);

/**
 * A dispute takes money back only when Stripe closes it as lost: then it subtracts like a refund
 * (stripe_dispute_<id>). Open, won or withdrawn disputes leave revenue alone. Every charge.dispute.* event carries the
 * dispute's status, so any of them sets the row; a closed dispute ignores older events that arrive late.
 */
async function handleDispute(db: D1Database, site: Site, d: Obj, ts: number, push?: Pusher): Promise<string> {
  const id = str(d.id);
  const currency = str(d.currency)?.toUpperCase();
  if (!id || !currency) return 'no payment';
  const found = await paymentFor(db, site, { charge: idOf(d.charge), pi: idOf(d.payment_intent) });
  if (typeof found === 'string') return found;
  const status = str(d.status) ?? 'needs_response';
  const before = await db.prepare('SELECT status FROM stripe_objects WHERE id = ?').bind(id).first<{ status: string | null }>();
  if (before?.status && CLOSED_DISPUTE.has(before.status) && before.status !== status) return 'dispute already closed';
  await db
    .prepare(
      `INSERT INTO stripe_objects (id, site_id, payment_id, charge, amount, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET amount = excluded.amount, status = excluded.status, at = excluded.at`,
    )
    .bind(id, site.id, found.id, idOf(d.charge), Number(d.amount) || 0, status, ts)
    .run();
  const rowId = `stripe_dispute_${id}`;
  if (status === 'lost') {
    return writeRefundRow(db, site, found, rowId, stripeToMinor(Number(d.amount) || 0, found.currency), ts, push, 'dispute lost');
  }
  await db.prepare("DELETE FROM payments WHERE id = ? AND site_id = ? AND kind = 'refund'").bind(rowId, site.id).run();
  return status === 'won' ? 'dispute won' : CLOSED_DISPUTE.has(status) ? 'dispute closed' : 'dispute open';
}

/**
 * Checkout for a subscription knows the visitor; the payment arrives separately as invoice.paid, in either
 * order. Link payments already stored for the subscription, and leave a claim for ones still to come.
 */
async function linkSubscription(db: D1Database, site: Site, subscription: string, visitorId: string, ts: number) {
  await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
      .bind(site.id, subscription, visitorId, ts),
    // Credited like a payment that carried the metadata: the visitor's visits and those identified as the same person.
    db
      .prepare(
        `UPDATE payments SET visitor_id = ?3, matched_by = 'metadata', session_id = (${creditedVisitSql('id', 'lower(payments.email)')}),
           (channel, source, campaign) = (${creditedVisitSql('channel, source, utm_campaign', 'lower(payments.email)')})
         WHERE site_id = ?1 AND subscription_id = ?4 AND (visitor_id IS NULL OR COALESCE(matched_by, '') NOT IN ('metadata', 'app_event'))`,
      )
      .bind(site.id, ts + 60_000, visitorId, subscription),
  ]);
}
