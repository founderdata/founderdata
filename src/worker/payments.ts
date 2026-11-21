import type { Context } from 'hono';
import { propsJson } from './lib/props';
import type { AppEnv, Site } from './env';
import { convertPayments } from './fx';
import { writeSiteOf } from './keys';
import { resolveRange } from './lib/time';
import { announce, pusherOf, type Pusher } from './notify';
import { currencyDecimals } from '../shared/currency';
import { isTestProvider, PLAY_TEST_PROVIDER, SANDBOX_PROVIDER, TEST_PROVIDERS, TEST_PROVIDERS_SQL } from '../shared/test-providers';

export { currencyDecimals };

interface PaymentInput {
  id: string;
  provider: string;
  ts: number;
  amount: number; // minor units; negative for refunds
  /** income: revenue that is not a purchase (ads, affiliate, sponsorship). No visitor, no customer, no conversion. */
  kind: 'payment' | 'refund' | 'income';
  currency: string;
  visitorId?: string | null;
  sessionId?: string | null;
  customerId?: string | null;
  email?: string | null;
  name?: string | null;
  subscriptionId?: string | null;
  /** App Store product id or the app's pack id. */
  product?: string | null;
  renewal?: boolean;
  /** How `visitorId` was obtained, when the caller already has one (default: metadata). */
  matchedBy?: MatchedBy;
  /** false = never guess the buyer from checkout-click timing (App Store purchases). */
  timing?: boolean;
}

export type MatchedBy =
  | 'metadata'
  | 'return_page'
  | 'customer'
  | 'email'
  | 'timing'
  | 'app_event'
  | 'app_account_token'
  /** RevenueCat subscriber attribute founderDataVisitorId. */
  | 'subscriber_attribute';

/**
 * Payments that are not revenue: App Store sandbox and Google Play test purchases, kept only so you can test the setup
 * (src/shared/test-providers.ts).
 */
export { isTestProvider, PLAY_TEST_PROVIDER, SANDBOX_PROVIDER, TEST_PROVIDERS, TEST_PROVIDERS_SQL };
/** Test purchases are stored for testing but are never revenue. Lives here so Pro modules can build SQL with it at import time. */
export const REAL = `p.provider NOT IN ${TEST_PROVIDERS_SQL}`;

/** A visit's channel, source and utm_campaign, copied onto a payment (migration 0064) so it outlives the visit. */
export interface SourceSnapshot {
  channel: string | null;
  source: string | null;
  campaign: string | null;
}
export const NO_SNAPSHOT: SourceSnapshot = { channel: null, source: null, campaign: null };

/** The credited visit and its source. */
export interface CreditedVisit extends SourceSnapshot {
  id: string;
}

/** Visitor ids one identity (a user id or an email) joins at most, so a shared test address can't fan out. */
const STITCH_MAX = 50;

/**
 * The visit that gets the credit: the last visit that came from somewhere (last non-direct touch) at `ts`, among every
 * visitor id that is the same person:
 *  - the visitor itself
 *  - the web visitor linked to an app install (visitors.linked_web_vid), so "read the blog, tapped the App Store
 *    link, bought in the app" credits the blog's source
 *  - visitors the site identified with the same user id or email (identify(), or a payment's email). Cookieless
 *    visitor ids change every day, so this is what joins "signed up from a tweet on Monday, paid on Friday".
 *  - visitors identified with the buyer's email, when the payment carries one
 * Only identified visitors are joined: an anonymous visitor's other days stay apart (docs/PRIVACY.md).
 * Binds: ?1 site_id, ?2 ts, ?3 visitor_id, and ?4 the email (or null) unless `email` names another SQL expression,
 * such as the column of the payment an UPDATE links. `cols` picks what it returns.
 */
export function creditedVisitSql(cols = 'id, channel, source, utm_campaign AS campaign', email = '?4') {
  return `SELECT ${cols} FROM sessions
          WHERE site_id = ?1 AND started_at <= ?2 AND visitor_id IN (
            SELECT ?3
            UNION SELECT linked_web_vid FROM visitors WHERE site_id = ?1 AND id = ?3 AND linked_web_vid IS NOT NULL
            UNION SELECT * FROM (SELECT o.id FROM visitors me JOIN visitors o ON o.site_id = me.site_id AND o.user_id = me.user_id
                                 WHERE me.site_id = ?1 AND me.id = ?3 AND me.user_id IS NOT NULL AND o.user_id IS NOT NULL LIMIT ${STITCH_MAX})
            UNION SELECT * FROM (SELECT o.id FROM visitors me JOIN visitors o ON o.site_id = me.site_id AND o.email = me.email
                                 WHERE me.site_id = ?1 AND me.id = ?3 AND me.email IS NOT NULL AND o.email IS NOT NULL LIMIT ${STITCH_MAX})
            UNION SELECT * FROM (SELECT id FROM visitors WHERE site_id = ?1 AND email = ${email} AND email IS NOT NULL LIMIT ${STITCH_MAX}))
          ORDER BY (channel != 'Direct') DESC, started_at DESC LIMIT 1`;
}

/** The visit a payment or subscription signal of this visitor at `ts` is credited to, with its source (see attribute()). */
export async function creditedVisit(db: D1Database, site: Site, visitorId: string, ts: number, email?: string | null): Promise<CreditedVisit | null> {
  return db
    .prepare(creditedVisitSql())
    .bind(site.id, ts + 60_000, visitorId, email?.toLowerCase() || null)
    .first<CreditedVisit>();
}

/** The session id of creditedVisit(). */
export async function creditedSession(db: D1Database, site: Site, visitorId: string, ts: number, email?: string | null): Promise<string | null> {
  return (await creditedVisit(db, site, visitorId, ts, email))?.id ?? null;
}

export interface SignalInput {
  id: string;
  provider: string;
  ts: number;
  type: 'trial_start' | 'cancellation' | 'expiration' | 'billing_issue' | 'product_change';
  visitorId: string | null;
  sessionId: string | null;
  product?: string | null;
  store?: string | null;
  reason?: string | null;
  sandbox?: boolean;
}

/**
 * Store a subscription signal (not money) once per id. A repeat delivery fills in the visitor and session when
 * the stored row has none yet (a notification that came before the app's own event); otherwise it writes nothing.
 */
export async function recordSignal(db: D1Database, site: Site, g: SignalInput, push?: Pusher) {
  // A trial pushes once, when its row is new: the same App Store trial arrives through RevenueCat, the SDK and Apple.
  const isNew =
    !!push && g.type === 'trial_start' && !g.sandbox && !(await db.prepare('SELECT 1 FROM subscription_signals WHERE site_id = ? AND id = ?').bind(site.id, g.id.slice(0, 120)).first());
  await db
    .prepare(
      `INSERT INTO subscription_signals (site_id, id, provider, ts, type, visitor_id, session_id, product, store, reason, sandbox)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, id) DO UPDATE SET visitor_id = excluded.visitor_id, session_id = excluded.session_id
       WHERE subscription_signals.visitor_id IS NULL AND excluded.visitor_id IS NOT NULL`,
    )
    .bind(
      site.id,
      g.id.slice(0, 120),
      g.provider,
      g.ts,
      g.type,
      g.visitorId,
      g.sessionId,
      g.product?.slice(0, 200) ?? null,
      g.store?.slice(0, 40) ?? null,
      g.reason?.slice(0, 60) ?? null,
      g.sandbox ? 1 : 0,
    )
    .run();
  if (isNew) {
    await announce(push, site, { event: 'trial', id: g.id.slice(0, 120), provider: g.provider, sandbox: false, product: g.product, sessionId: g.sessionId });
  }
}

/**
 * Work out which visitor paid and which visit gets the credit, trying the most reliable signal first:
 *  1. metadata   rt_visitor_id (or the older ml_visitor_id) passed to the checkout
 *  2. return_page  the visitor landed on your return URL with ?payment_id=<this payment>
 *  3. customer   the same customer paid before (renewals)
 *  4. email      the email matches a visitor you identify()'d
 *  5. timing     exactly one visitor clicked a Dodo checkout link (or a checkout goal) shortly before the payment
 * Credit goes to the last non-direct visit of that person (creditedVisit). A renewal or repeat purchase keeps the
 * visit of the customer's first payment: the source that acquired the customer keeps the revenue it brings later.
 */
async function attribute(db: D1Database, site: Site, p: PaymentInput) {
  if (p.kind === 'income') return { visitorId: null, sessionId: null, renewal: false, matchedBy: null, reason: null, snapshot: NO_SNAPSHOT };
  let visitorId = p.visitorId ?? null;
  let matchedBy: MatchedBy | null = visitorId ? (p.matchedBy ?? 'metadata') : null;
  let renewal = !!p.renewal;

  if (!visitorId) {
    const claim = await db
      .prepare('SELECT visitor_id FROM payment_claims WHERE site_id = ? AND payment_id IN (?, ?) ORDER BY ts LIMIT 1')
      .bind(site.id, p.id, p.subscriptionId ?? p.id)
      .first<{ visitor_id: string }>();
    // Stripe leaves a claim when a subscription Checkout carried the visitor in its metadata.
    if (claim) [visitorId, matchedBy] = [claim.visitor_id, p.provider === 'stripe' ? 'metadata' : 'return_page'];
  }

  let first: (SourceSnapshot & { visitor_id: string; session_id: string | null; ts: number }) | null = null;
  if (p.customerId || p.email || p.subscriptionId) {
    first = await db
      .prepare(
        `SELECT visitor_id, session_id, ts, channel, source, campaign FROM payments
         WHERE site_id = ? AND kind = 'payment' AND visitor_id IS NOT NULL AND id != ?
           AND ((customer_id IS NOT NULL AND customer_id = ?) OR (email IS NOT NULL AND email = ?) OR (subscription_id IS NOT NULL AND subscription_id = ?))
         ORDER BY ts ASC LIMIT 1`,
      )
      .bind(site.id, p.id, p.customerId ?? null, p.email ?? null, p.subscriptionId ?? null)
      .first();
    if (first) {
      if (!visitorId) [visitorId, matchedBy] = [first.visitor_id, 'customer'];
      // Same customer paid before: a subscription renewal or repeat purchase.
      if (p.kind === 'payment') renewal = true;
    }
  }
  if (!visitorId && p.email) {
    const v = await db
      .prepare('SELECT id FROM visitors WHERE site_id = ? AND email = ? ORDER BY first_seen DESC LIMIT 1')
      .bind(site.id, p.email)
      .first<{ id: string }>();
    if (v) [visitorId, matchedBy] = [v.id, 'email'];
  }
  let reason: string | null = null;
  if (!visitorId && p.kind === 'payment' && !renewal && p.timing !== false) {
    const t = await matchByTiming(db, site, p);
    if (t.visitorId) [visitorId, matchedBy] = [t.visitorId, 'timing'];
    reason = t.reason;
  }

  let sessionId: string | null = null;
  let snapshot = NO_SNAPSHOT;
  if (first?.session_id && first.ts <= p.ts && p.kind === 'payment') {
    // A renewal is credited where the customer's first payment was (decision: acquisition, not the latest visit).
    sessionId = first.session_id;
    snapshot = { channel: first.channel, source: first.source, campaign: first.campaign };
  } else if (visitorId) {
    const v = await creditedVisit(db, site, visitorId, p.ts, p.email);
    if (v) [sessionId, snapshot] = [v.id, { channel: v.channel, source: v.source, campaign: v.campaign }];
    else sessionId = p.sessionId ?? null;
  }
  return { visitorId, sessionId, renewal, matchedBy, reason, snapshot };
}

const TIMING_WINDOW_MS = 3 * 3_600_000;
const MIN = 60_000;

/**
 * Last resort when nothing identifies the buyer: look at who clicked a Dodo checkout link (or a checkout goal)
 * in the 3 hours before the payment. The strongest sign is coming back to the site right after paying
 * (Dodo redirects buyers to your return page); people who clicked Buy and gave up don't.
 * Only ever picks a visitor when the evidence points to exactly one person.
 */
async function matchByTiming(db: D1Database, site: Site, p: PaymentInput): Promise<{ visitorId: string | null; reason: string }> {
  const clicks = await db
    .prepare(
      `SELECT e.visitor_id, MAX(e.ts) AS last_click FROM events e
       WHERE e.site_id = ? AND e.ts BETWEEN ? AND ?
         AND ((e.type = 'outbound' AND (e.name LIKE '%dodopayments.com%' OR e.name LIKE '%checkout.stripe.com%' OR e.name LIKE '%buy.stripe.com%'
                                       OR e.name LIKE '%lemonsqueezy.com/checkout%' OR e.name LIKE '%polar.sh%' OR e.name LIKE '%gumroad.com%'))
              OR (e.type = 'goal' AND (e.name LIKE '%checkout%' OR e.name LIKE '%buy%' OR e.name LIKE '%purchase%')))
         AND NOT EXISTS (SELECT 1 FROM payments o WHERE o.site_id = e.site_id AND o.visitor_id = e.visitor_id
                         AND o.kind = 'payment' AND o.id != ? AND o.ts BETWEEN ? AND ?)
       GROUP BY e.visitor_id ORDER BY last_click DESC LIMIT 50`,
    )
    .bind(site.id, p.ts - TIMING_WINDOW_MS, p.ts + 2 * MIN, p.id, p.ts - TIMING_WINDOW_MS, p.ts + TIMING_WINDOW_MS)
    .all<{ visitor_id: string; last_click: number }>();
  const cands = clicks.results;
  if (!cands.length) return { visitorId: null, reason: 'No one clicked a checkout link in the 3 hours before this payment (was the script installed yet?)' };
  if (cands.length === 1) return { visitorId: cands[0].visitor_id, reason: 'Only checkout click before the payment' };

  // Who came back to the site shortly after the payment, after having clicked checkout?
  const placeholders = cands.map(() => '?').join(',');
  const views = await db
    .prepare(
      `SELECT visitor_id, ts FROM events
       WHERE site_id = ? AND type = 'pageview' AND ts BETWEEN ? AND ? AND visitor_id IN (${placeholders})
       LIMIT 1000`,
    )
    .bind(site.id, p.ts - MIN, p.ts + 30 * MIN, ...cands.map((c) => c.visitor_id))
    .all<{ visitor_id: string; ts: number }>();
  const lastClick = new Map(cands.map((c) => [c.visitor_id, c.last_click]));
  // A pageview after their last checkout click = they came back from the checkout.
  const returned = [...new Set(views.results.filter((v) => v.ts > (lastClick.get(v.visitor_id) ?? Infinity)).map((v) => v.visitor_id))];
  if (returned.length === 1) return { visitorId: returned[0], reason: 'Came back to the site right after paying' };

  // Nobody (or several people) came back: fall back to a single clicker in the 30 minutes before paying.
  const recent = cands.filter((c) => c.last_click >= p.ts - 30 * MIN && c.last_click <= p.ts + MIN);
  if (recent.length === 1) return { visitorId: recent[0].visitor_id, reason: 'Only checkout click in the 30 minutes before the payment' };

  return {
    visitorId: null,
    reason: `${cands.length} people clicked checkout before this payment${returned.length > 1 ? ` and ${returned.length} came back right after` : ''}; too close to call`,
  };
}

/**
 * Store a payment (ignored if its id is already stored). With `fillIn`, a repeat delivery of the same payment
 * (Stripe sends one payment through several events, Apple through the app and a notification) links the
 * stored row when it has no visitor yet, or when this delivery carries checkout metadata and the stored
 * link was only a guess.
 */
export async function recordPayment(db: D1Database, site: Site, p: PaymentInput, opts: { fillIn?: boolean; push?: Pusher } = {}) {
  const { visitorId, sessionId, renewal, matchedBy, snapshot } = await attribute(db, site, p);
  const stmts = [
    db
      .prepare(
        `INSERT OR IGNORE INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name, renewal, matched_by, subscription_id, product,
                                         channel, source, campaign)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.id,
        site.id,
        p.provider,
        p.ts,
        p.amount,
        p.kind,
        p.currency.toUpperCase(),
        visitorId,
        sessionId,
        p.customerId ?? null,
        p.email ?? null,
        p.name ?? null,
        renewal ? 1 : 0,
        matchedBy,
        p.subscriptionId ?? null,
        p.product?.slice(0, 200) ?? null,
        snapshot.channel,
        snapshot.source,
        snapshot.campaign,
      ),
  ];
  if (opts.fillIn && visitorId) {
    stmts.push(
      db
        .prepare(
          `UPDATE payments SET visitor_id = ?, session_id = ?, matched_by = ?, channel = ?, source = ?, campaign = ?
           WHERE site_id = ? AND id = ? AND (visitor_id IS NULL OR (? IN ('metadata', 'app_event', 'subscriber_attribute') AND COALESCE(matched_by, '') NOT IN ('metadata', 'app_event', 'subscriber_attribute')))`,
        )
        .bind(visitorId, sessionId, matchedBy, snapshot.channel, snapshot.source, snapshot.campaign, site.id, p.id, matchedBy),
    );
  }
  // A payment tells us who an anonymous visitor really is.
  if (visitorId && p.kind === 'payment' && (p.email || p.name)) {
    stmts.push(
      db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, visitorId, p.ts),
      db
        // Only when it adds something: the first email also writes its entry in visitors_email (migration 0064).
        .prepare(
          `UPDATE visitors SET email = COALESCE(email, ?1), name = COALESCE(name, ?2) WHERE site_id = ?3 AND id = ?4
             AND ((email IS NULL AND ?1 IS NOT NULL) OR (name IS NULL AND ?2 IS NOT NULL))`,
        )
        .bind(p.email ?? null, p.name ?? null, site.id, visitorId),
    );
  }
  const results = await db.batch(stmts);
  // Only a row that is really new pushes: a repeat delivery of the same payment is ignored by the INSERT.
  const inserted = !!results[0].meta.changes;
  // Other revenue (ads, affiliate) and its corrections are no purchase: no push, no alert.
  if (inserted && p.kind !== 'income' && p.provider !== 'income') {
    await announce(opts.push, site, {
      event: p.kind === 'refund' ? 'refund' : renewal ? 'renewal' : 'purchase',
      id: p.id,
      provider: p.provider,
      sandbox: isTestProvider(p.provider),
      amount: p.amount,
      currency: p.currency.toUpperCase(),
      product: p.product,
      sessionId,
      ts: p.ts,
    });
  }
  // Paid in another currency than the site's: store the converted amount now, so every panel counts it.
  if (p.currency.toUpperCase() !== site.currency) await convertPayments(db).catch(() => 0);
  return { visitorId, sessionId, inserted };
}

/** Try again to link payments that have no visitor yet (e.g. ones recorded before a fallback existed). */
export async function rematchPayments(db: D1Database, site: Site) {
  const rows = await db
    .prepare("SELECT * FROM payments WHERE site_id = ? AND kind = 'payment' AND visitor_id IS NULL ORDER BY ts LIMIT 500")
    .bind(site.id)
    .all<{ id: string; ts: number; amount: number; currency: string; customer_id: string | null; email: string | null; name: string | null; provider: string; subscription_id: string | null }>();
  let matched = 0;
  const details: { id: string; name: string | null; matched: boolean; reason: string | null }[] = [];
  for (const r of rows.results) {
    const a = await attribute(db, site, {
      id: r.id,
      provider: r.provider,
      ts: r.ts,
      amount: r.amount,
      kind: 'payment',
      currency: r.currency,
      customerId: r.customer_id,
      email: r.email,
      name: r.name,
      subscriptionId: r.subscription_id,
    });
    details.push({ id: r.id, name: r.name, matched: !!a.visitorId, reason: a.reason });
    if (!a.visitorId) continue;
    matched++;
    await db.batch([
      db
        .prepare('UPDATE payments SET visitor_id = ?, session_id = ?, matched_by = ?, renewal = ?, channel = ?, source = ?, campaign = ? WHERE site_id = ? AND id = ?')
        .bind(a.visitorId, a.sessionId, a.matchedBy, a.renewal ? 1 : 0, a.snapshot.channel, a.snapshot.source, a.snapshot.campaign, site.id, r.id),
      db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, a.visitorId, r.ts),
      db
        .prepare('UPDATE visitors SET email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE site_id = ? AND id = ?')
        .bind(r.email, r.name, site.id, a.visitorId),
    ]);
  }
  return { checked: rows.results.length, matched, details };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The site whose API key (rt_...) is in `Authorization: Bearer <key>`, or null. The /api/v1 write routes use keys.ts
 * writeSiteOf, which takes this key and the scoped keys, and checks the scope.
 */
export async function siteFromApiKey(c: Context<AppEnv>): Promise<Site | null> {
  const key = c.req.header('authorization')?.trim().replace(/^Bearer\s+/i, '').trim();
  if (!key) return null;
  return c.env.DB.prepare('SELECT * FROM sites WHERE api_key = ?').bind(key).first<Site>();
}

/**
 * Generic payments API, for any provider without a built-in integration.
 * POST /api/v1/payments  Authorization: Bearer <site API key, or a key with payments:write>
 * { "transaction_id": "...", "amount": 29.99, "currency": "USD", "visitor_id": "<rt_vid cookie>", "email": "..." }
 * visitor_id and session_id may also arrive as rt_visitor_id / rt_session_id, the keys attribution() returns
 * (or the older ml_* keys), so a site can pass that object through unchanged.
 * "kind": "income" (or "other") is revenue that is not a purchase: ads, affiliate commissions, sponsorships. It is
 * stored under the provider "income", with no visitor, and never counts as a customer, a payment or a conversion.
 *
 * Sending a transaction_id again stores nothing new. A refund or an income row sent again with another amount is
 * corrected to it; a payment sent again with another amount, or as another kind, gets 409 (delete it first).
 */
export async function handlePaymentApi(c: Context<AppEnv>) {
  const auth = await writeSiteOf(c, 'payments:write');
  if ('error' in auth) return c.json({ error: auth.error }, auth.status);
  const site = auth.site;
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!b || !str(b.transaction_id) || typeof b.amount !== 'number') {
    return c.json({ error: 'transaction_id (string) and amount (number, e.g. 29.99) are required' }, 400);
  }
  if (b.kind !== undefined && b.kind !== 'payment' && b.kind !== 'income' && b.kind !== 'other') {
    return c.json({ error: 'kind is "payment" (the default) or "income"' }, 400);
  }
  const db = c.env.DB;
  const tx = str(b.transaction_id)!;
  const currency = (str(b.currency) ?? site.currency).toUpperCase();
  const minor = Math.round((b.amount as number) * 10 ** currencyDecimals(currency));
  const refunded = b.refunded === true;
  const id = `${site.id}:${tx}${refunded ? ':refund' : ''}`;
  const [existing, original] = await db.batch<StoredApiPayment>([
    db.prepare('SELECT provider, kind, amount, currency FROM payments WHERE site_id = ? AND id = ?').bind(site.id, id),
    db.prepare('SELECT provider, kind, amount, currency FROM payments WHERE site_id = ? AND id = ?').bind(site.id, `${site.id}:${tx}`),
  ]);
  // A refund of other revenue is other revenue too, whether or not it says "kind": "income".
  const income = b.kind === 'income' || b.kind === 'other' || (refunded && original.results[0]?.provider === 'income');
  const kind = refunded ? 'refund' : income ? 'income' : 'payment';
  const amount = refunded ? -Math.abs(minor) : minor;
  const stored = existing.results[0];
  if (stored && (stored.amount !== amount || stored.currency !== currency || stored.kind !== kind)) {
    const fix = correctApiPayment(stored, { kind, amount, currency, tx, refunded });
    if ('error' in fix) return c.json({ error: fix.error }, 409);
    await db
      .prepare('UPDATE payments SET amount = ?, currency = ?, amount_conv = NULL, product = COALESCE(?, product) WHERE site_id = ? AND id = ?')
      .bind(amount, currency, str(b.product)?.slice(0, 200) ?? null, site.id, id)
      .run();
    if (currency !== site.currency) await convertPayments(db, fetch, { rescan: true }).catch(() => 0);
    return c.json({ ok: true, updated: true, attributed: false, visitor_id: null });
  }
  const res = await recordPayment(db, site, {
    id,
    provider: income ? 'income' : 'api',
    ts: typeof b.timestamp === 'string' ? Date.parse(b.timestamp) || Date.now() : Date.now(),
    amount,
    kind,
    currency,
    visitorId: income ? null : (str(b.visitor_id) ?? str(b.rt_visitor_id) ?? str(b.ml_visitor_id)),
    sessionId: income ? null : (str(b.session_id) ?? str(b.rt_session_id) ?? str(b.ml_session_id)),
    customerId: income ? null : str(b.customer_id),
    email: income ? null : (str(b.email)?.toLowerCase() ?? null),
    name: income ? null : str(b.name),
    product: str(b.product),
    renewal: b.renewal === true,
    timing: income ? false : undefined,
  }, { push: pusherOf(c) });
  return c.json({ ok: true, attributed: !!res.sessionId, visitor_id: res.visitorId });
}

interface StoredApiPayment {
  provider: string;
  kind: string;
  amount: number;
  currency: string;
}

/**
 * A transaction_id sent again with another amount, currency or kind. A refund or other revenue takes the new amount:
 * that is how a wrong number is fixed. A payment keeps its amount, so a retry with a rounding difference can't change
 * revenue: the answer says how to replace it. Exported for tests.
 */
export function correctApiPayment(
  stored: StoredApiPayment,
  next: { kind: string; amount: number; currency: string; tx: string; refunded: boolean },
): { ok: true } | { error: string } {
  const shown = `${stored.amount / 10 ** currencyDecimals(stored.currency)} ${stored.currency}`;
  const kindName = (k: string) => (k === 'income' ? 'other revenue' : k);
  if (stored.kind !== next.kind) {
    return {
      error: `transaction_id ${next.tx} is already stored as ${kindName(stored.kind)} (${shown}). To store it as ${kindName(next.kind)}, delete it first with DELETE /api/v1/payments/${encodeURIComponent(next.tx)}, then send it again.`,
    };
  }
  if (next.kind === 'refund' || next.kind === 'income') return { ok: true };
  return {
    error: `transaction_id ${next.tx} is already stored with ${shown}. A payment sent again keeps its first amount. For a refund, send "refunded": true. To replace it, delete it with DELETE /api/v1/payments/${encodeURIComponent(next.tx)}, then send it again.`,
  };
}

/**
 * DELETE /api/v1/payments/:transaction_id  Authorization: Bearer <site API key, or a key with payments:write>
 * Deletes a payment or other revenue sent through this API, and its refund. `?refunded=true` deletes the refund only.
 * Payments from a provider's webhook can't be deleted here: their ids don't start with the site's.
 */
export async function handleDeletePaymentApi(c: Context<AppEnv>) {
  const auth = await writeSiteOf(c, 'payments:write');
  if ('error' in auth) return c.json({ error: auth.error }, auth.status);
  const site = auth.site;
  const tx = c.req.param('transaction_id') ?? '';
  const refundOnly = c.req.query('refunded') === 'true';
  const res = await deleteApiRows(c.env.DB, site.id, tx, refundOnly, ['api', 'income']);
  if (!res) return c.json({ error: `No ${refundOnly ? 'refund' : 'payment'} with transaction_id ${tx} on this site` }, 404);
  return c.json({ ok: true, deleted: res });
}

/** Delete `<site>:<tx>` and `<site>:<tx>:refund` (or the refund only) of the given providers. Returns the rows deleted. */
async function deleteApiRows(db: D1Database, siteId: string, tx: string, refundOnly: boolean, providers: string[]) {
  if (!tx || tx.length > 500) return 0;
  const ids = refundOnly ? [`${siteId}:${tx}:refund`] : [`${siteId}:${tx}`, `${siteId}:${tx}:refund`];
  const res = await db
    .prepare(`DELETE FROM payments WHERE site_id = ? AND id IN (${ids.map(() => '?').join(', ')}) AND provider IN (${providers.map(() => '?').join(', ')})`)
    .bind(siteId, ...ids, ...providers)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * GET /api/sites/:id/income?period=...: the site's other revenue rows in the period, and their refunds, newest
 * first, at most 200. The Revenue by provider panel lists them under Other revenue, each with Delete.
 */
export async function listIncome(c: Context<AppEnv>) {
  const site = c.get('site');
  const q = c.req.query();
  const range = resolveRange({ ...q, period: q.from || q.to ? 'custom' : q.period }, site.timezone, site.created_at);
  const rows = await c.env.DB.prepare(
    `SELECT id, ts, amount, currency, kind, product FROM payments WHERE site_id = ? AND provider = 'income' AND ts >= ? AND ts < ?
     ORDER BY ts DESC, id LIMIT 200`,
  )
    .bind(site.id, range.from, range.to)
    .all<{ id: string; ts: number; amount: number; currency: string; kind: string; product: string | null }>();
  const prefix = `${site.id}:`;
  return c.json(
    rows.results.map((r) => ({
      ...r,
      transactionId: r.id.startsWith(prefix) ? r.id.slice(prefix.length).replace(/:refund$/, '') : r.id,
      decimals: currencyDecimals(r.currency),
    })),
  );
}

/** DELETE /api/sites/:id/income/:transaction_id: one other revenue row and its refund (`?refunded=true`: the refund only). */
export async function deleteIncome(c: Context<AppEnv>) {
  const site = c.get('site');
  const tx = c.req.param('transaction_id') ?? '';
  const n = await deleteApiRows(c.env.DB, site.id, tx, c.req.query('refunded') === 'true', ['income']);
  if (!n) return c.json({ error: 'Not found. It may have been deleted already.' }, 404);
  return c.json({ ok: true, deleted: n });
}

/**
 * Server-side goals (e.g. "signup" from your backend).
 * POST /api/v1/goals  { "visitor_id": "...", "name": "signup" }, or { "user_id": "...", "name": ... } or
 * { "email": "...", "name": ... } for a person identify() named: the goal joins the latest visit of any visitor id
 * identified with it (cookieless ids change daily, so a backend rarely holds today's).
 */
export async function handleGoalApi(c: Context<AppEnv>) {
  const auth = await writeSiteOf(c, 'payments:write');
  if ('error' in auth) return c.json({ error: auth.error }, auth.status);
  const site = auth.site;
  const db = c.env.DB;
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const vid = str(b?.visitor_id) ?? str(b?.rt_visitor_id) ?? str(b?.ml_visitor_id);
  const userId = str(b?.user_id)?.slice(0, 128) ?? null;
  const email = str(b?.email)?.trim().toLowerCase().slice(0, 200) || null;
  const name = str(b?.name)?.slice(0, 64);
  if ((!vid && !userId && !email) || !name) return c.json({ error: 'name and one of visitor_id, user_id or email are required' }, 400);
  type Visit = { id: string; visitor_id: string; exit_page: string };
  let s: Visit | null = null;
  if (vid) {
    s = await db
      .prepare('SELECT id, visitor_id, exit_page FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 1')
      .bind(site.id, vid)
      .first<Visit>();
  }
  if (!s && (userId || email)) {
    s = await db
      .prepare(
        `SELECT id, visitor_id, exit_page FROM sessions WHERE site_id = ?1 AND visitor_id IN (
           SELECT * FROM (SELECT id FROM visitors WHERE site_id = ?1 AND user_id = ?2 AND user_id IS NOT NULL LIMIT ${STITCH_MAX})
           UNION SELECT * FROM (SELECT id FROM visitors WHERE site_id = ?1 AND email = ?3 AND email IS NOT NULL LIMIT ${STITCH_MAX}))
         ORDER BY started_at DESC LIMIT 1`,
      )
      .bind(site.id, userId, email)
      .first<Visit>();
  }
  if (!s) return c.json({ error: vid ? 'visitor not found' : 'no visitor identified with this user_id or email' }, 404);
  const now = Date.now();
  await db.batch([
    db.prepare('UPDATE sessions SET goals = goals + 1 WHERE site_id = ? AND id = ?').bind(site.id, s.id),
    db.prepare(
      "INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, 'goal', ?, ?, ?)",
    ).bind(site.id, s.id, s.visitor_id, now, name, s.exit_page, propsJson(b?.props)),
  ]);
  return c.json({ ok: true, visitor_id: s.visitor_id });
}
