// Erase one person from a site (docs/GUIDE.md, "Erase one person"). Visits, events, payment claims and subscription
// signals go; the visitor row goes. Payments stay for bookkeeping, with nothing left that points at the person: their
// visitor, session, the visit's source, email, name, customer id and match reason are cleared. Subscriptions stay for MRR the same way,
// without the visitor, visit, customer id and the visit's source.
import type { Context } from 'hono';
import type { AppEnv, Site } from './env';
import { apiKeyOf } from './keys';
import { cleanNote, handlerOf, logErasure } from './privacy';
import { proHooks } from './pro-hooks';
import { partErase, partEraseCustomers } from './core-parts';

/** Visitor ids per batch: each statement binds them all, and D1 allows 100 bound parameters. */
const IDS_PER_BATCH = 50;
/** Visitors one request erases at most; ask again for the rest. */
const MAX_VISITORS = 500;

export interface Erased {
  visitors: number;
  sessions: number;
  events: number;
  claims: number;
  signals: number;
  /** Payments kept, with their link to the person cleared. */
  payments: number;
  /** Subscriptions kept, with their link to the person cleared. */
  subscriptions: number;
  /** More visitors matched than one request erases; call again. */
  more?: boolean;
}

/**
 * Erase these visitors of `site`, and clear `email` from payments that no visitor links. With `userId`, payments and
 * subscriptions that RevenueCat filed under that app user id (`rc:<id>`, revenuecat.ts) lose it too, also without a visitor.
 */
export async function eraseVisitors(db: D1Database, site: Site, ids: string[], email: string | null = null, userId: string | null = null): Promise<Erased> {
  const out: Erased = { visitors: 0, sessions: 0, events: 0, claims: 0, signals: 0, payments: 0, subscriptions: 0 };
  const unlinkSubs = `UPDATE subscriptions SET visitor_id = NULL, session_id = NULL, customer_id = NULL, channel = NULL, source = NULL,
                        source_domain = NULL, campaign = NULL, rev = rev + 1 WHERE site_id = ?`;
  // The customer ids of this email's payments, read before any UPDATE: the visitor loop below clears them on the
  // payments, and a subscription that only carries the customer id (no visitor) is found through them.
  const customers = email
    ? (
        await db
          .prepare('SELECT DISTINCT customer_id AS id FROM payments WHERE site_id = ? AND lower(email) = ? AND customer_id IS NOT NULL')
          .bind(site.id, email)
          .all<{ id: string }>()
      ).results.map((r) => r.id)
    : [];
  const rcCustomer = userId ? `rc:${userId.slice(0, 128)}` : null;
  if (rcCustomer && !customers.includes(rcCustomer)) customers.push(rcCustomer);
  for (let i = 0; i < ids.length; i += IDS_PER_BATCH) {
    const chunk = ids.slice(i, i + IDS_PER_BATCH);
    const inList = chunk.map(() => '?').join(', ');
    const erasedVisits = `SELECT id FROM sessions WHERE site_id = ? AND visitor_id IN (${inList})`;
    const res = await db.batch([
      // Events by session first: they are indexed by (site_id, session_id), and every event belongs to a session.
      db.prepare(`DELETE FROM events WHERE site_id = ? AND session_id IN (${erasedVisits})`).bind(site.id, site.id, ...chunk),
      db
        .prepare(
          `UPDATE payments SET visitor_id = NULL, session_id = NULL, email = NULL, name = NULL, customer_id = NULL, matched_by = NULL,
             channel = NULL, source = NULL, campaign = NULL
           WHERE site_id = ? AND visitor_id IN (${inList})`,
        )
        .bind(site.id, ...chunk),
      // Another visitor id's payment credited to an erased visit (the same person identified under another id, or the
      // first payment's visit kept by a renewal): it stays that buyer's, without the visit and the source it copied.
      db
        .prepare(`UPDATE payments SET session_id = NULL, channel = NULL, source = NULL, campaign = NULL WHERE site_id = ? AND session_id IN (${erasedVisits})`)
        .bind(site.id, site.id, ...chunk),
      db.prepare(`${unlinkSubs} AND visitor_id IN (${inList})`).bind(site.id, ...chunk),
      db
        .prepare(
          `UPDATE subscriptions SET session_id = NULL, channel = NULL, source = NULL, source_domain = NULL, campaign = NULL, rev = rev + 1
           WHERE site_id = ? AND session_id IN (${erasedVisits})`,
        )
        .bind(site.id, site.id, ...chunk),
      db.prepare(`DELETE FROM sessions WHERE site_id = ? AND visitor_id IN (${inList})`).bind(site.id, ...chunk),
      db.prepare(`DELETE FROM payment_claims WHERE site_id = ? AND visitor_id IN (${inList})`).bind(site.id, ...chunk),
      db.prepare(`DELETE FROM subscription_signals WHERE site_id = ? AND visitor_id IN (${inList})`).bind(site.id, ...chunk),
      // An app install that carried this web visitor in (universal link) stops pointing at it.
      db.prepare(`UPDATE visitors SET linked_web_vid = NULL WHERE site_id = ? AND linked_web_vid IN (${inList})`).bind(site.id, ...chunk),
      db.prepare(`DELETE FROM visitors WHERE site_id = ? AND id IN (${inList})`).bind(site.id, ...chunk),
      // The app launches grouped under this visitor (app.ts, resolveLaunch).
      db.prepare(`DELETE FROM app_aliases WHERE site_id = ? AND visitor_id IN (${inList})`).bind(site.id, ...chunk),
      // Recorded visits' index rows that FounderData Pro's eraseRecordings left, or that remain without Pro. Their R2
      // chunks go with Pro's hook, or with the bucket's 90-day lifecycle rule.
      db.prepare(`DELETE FROM replays WHERE site_id = ? AND visitor_id IN (${inList})`).bind(site.id, ...chunk),
      // Round 7's rows of these visitors (core-parts.ts): survey answers, errors. Last, so the indexes above stay put.
      ...partErase(db, site.id, chunk),
    ]);
    // The erased visitor's own payments and subscriptions are cleared first, so the by-visit updates count only others'.
    out.events += res[0].meta.changes;
    out.payments += res[1].meta.changes + res[2].meta.changes;
    out.subscriptions += res[3].meta.changes + res[4].meta.changes;
    out.sessions += res[5].meta.changes;
    out.claims += res[6].meta.changes;
    out.signals += res[7].meta.changes;
    out.visitors += res[9].meta.changes;
  }
  // Subscriptions of this email's payments, by the customer ids read above.
  for (let i = 0; i < customers.length; i += IDS_PER_BATCH) {
    const chunk = customers.slice(i, i + IDS_PER_BATCH);
    // Round 7's rows of these customers' subscriptions (core-parts.ts: cancel reasons), before the unlink clears the id.
    const res = await db.batch([
      ...partEraseCustomers(db, site.id, chunk),
      db.prepare(`${unlinkSubs} AND customer_id IN (${chunk.map(() => '?').join(', ')})`).bind(site.id, ...chunk),
    ]);
    out.subscriptions += res[res.length - 1].meta.changes;
  }
  if (rcCustomer) {
    // RevenueCat payments of this app user that no visitor links.
    const res = await db
      .prepare('UPDATE payments SET email = NULL, name = NULL, customer_id = NULL, matched_by = NULL WHERE site_id = ? AND customer_id = ?')
      .bind(site.id, rcCustomer)
      .run();
    out.payments += res.meta.changes;
  }
  if (email) {
    // Payments with this email that no visitor links (the buyer was never seen on the site).
    const res = await db
      .prepare('UPDATE payments SET email = NULL, name = NULL, customer_id = NULL, matched_by = NULL WHERE site_id = ? AND lower(email) = ?')
      .bind(site.id, email)
      .run();
    out.payments += res.meta.changes;
  }
  return out;
}

/** DELETE /api/sites/:id/visitors/:vid (or /api/v1/visitors/:vid with the API key), ?note= for the erase log. */
export async function eraseVisitor(c: Context<AppEnv>) {
  const site = c.get('site');
  const vid = c.req.param('vid') ?? '';
  const known = await c.env.DB.batch([
    c.env.DB.prepare('SELECT 1 FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid),
    c.env.DB.prepare('SELECT 1 FROM sessions WHERE site_id = ? AND visitor_id = ? LIMIT 1').bind(site.id, vid),
    c.env.DB.prepare('SELECT 1 FROM payments WHERE site_id = ? AND visitor_id = ? LIMIT 1').bind(site.id, vid),
  ]);
  if (!known.some((r) => r.results.length)) return c.json({ error: 'visitor not found' }, 404);
  const recordings = await eraseRecordings(c, [vid]);
  const res = { ...(await eraseVisitors(c.env.DB, site, [vid])), ...recordings };
  // The erase log keeps the counts, not the id (src/worker/privacy.ts).
  await logErasure(c.env.DB, site, 'visitor', res, { handler: handlerOf(c), note: cleanNote(c.req.query('note')) });
  return c.json({ ok: true, ...res });
}

/**
 * POST /api/sites/:id/erase (or /api/v1/erase with the API key)  { "email": "..." } or { "user_id": "..." }, and
 * optionally { "note": "..." } for the erase log.
 * Every visitor with that email or user id (set by identify() or a payment), and payments with that email.
 */
export async function erasePerson(c: Context<AppEnv>) {
  const site = c.get('site');
  const b = await c.req.json<{ email?: unknown; user_id?: unknown; note?: unknown }>().catch(() => ({}) as { email?: unknown; user_id?: unknown; note?: unknown });
  const email = typeof b.email === 'string' && b.email.trim() ? b.email.trim().toLowerCase() : null;
  const userId = typeof b.user_id === 'string' && b.user_id.trim() ? b.user_id.trim() : null;
  if (!email && !userId) return c.json({ error: 'Send an email or a user_id' }, 400);
  // FounderData Pro's mail belongs to the deployment, not to this site. Only a caller with authority over mail
  // reaches it, and a refusal (one of the deployment's own addresses, say) comes before anything is erased.
  const pro = proHooks();
  const hasMail = !!email && !!pro?.erasePerson;
  const eraseMail = hasMail && mayEraseMail(c);
  if (eraseMail) {
    const refusal = await pro?.eraseRefusal?.({ env: c.env, email: email! });
    if (refusal) return c.json({ error: refusal.error }, refusal.status);
  }

  const where: string[] = [];
  const params: string[] = [site.id];
  if (email) {
    where.push('lower(email) = ?');
    params.push(email);
  }
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  const visitors = (
    await c.env.DB.prepare(`SELECT id FROM visitors WHERE site_id = ? AND (${where.join(' OR ')}) LIMIT ${MAX_VISITORS + 1}`)
      .bind(...params)
      .all<{ id: string }>()
  ).results.map((r) => r.id);
  // A visitor linked to a payment with this email, but never identify()'d, is the same person.
  if (email) {
    const paid = await c.env.DB.prepare(`SELECT DISTINCT visitor_id AS id FROM payments WHERE site_id = ? AND lower(email) = ? AND visitor_id IS NOT NULL LIMIT ${MAX_VISITORS}`)
      .bind(site.id, email)
      .all<{ id: string }>();
    for (const r of paid.results) if (!visitors.includes(r.id)) visitors.push(r.id);
  }
  const more = visitors.length > MAX_VISITORS;
  // FounderData Pro's recordings of these visitors, before their visits go (pro-hooks.ts eraseRecordings).
  const recordings = await eraseRecordings(c, visitors.slice(0, MAX_VISITORS));
  const erased = { ...(await eraseVisitors(c.env.DB, site, visitors.slice(0, MAX_VISITORS), email, userId)), ...recordings };
  // FounderData Pro's mail: the messages to and from this address, across the deployment (pro-hooks.ts erasePerson).
  const mail = eraseMail ? await pro!.erasePerson!({ env: c.env, email: email! }) : undefined;
  const res = { ...erased, ...mail };
  await logErasure(c.env.DB, site, email && userId ? 'email+user_id' : email ? 'email' : 'user_id', res, { handler: handlerOf(c), note: cleanNote(b.note) });
  // mail_skipped says the same for every address, so a key without mail:write learns nothing about who has mail.
  return c.json({ ok: true, ...res, ...(more ? { more: true } : {}), ...(hasMail && !eraseMail ? { mail_skipped: true } : {}) });
}

/** FounderData Pro deletes the recordings of these visitors (R2 chunks and index rows); counts by name, none without Pro. */
async function eraseRecordings(c: Context<AppEnv>, visitorIds: string[]): Promise<Record<string, number>> {
  const hook = proHooks()?.eraseRecordings;
  if (!hook || !visitorIds.length) return {};
  return hook({ env: c.env, site: c.get('site'), visitorIds });
}

/**
 * Whether this caller may erase a person's mail too: the owner's login, or a scoped key that holds mail:write next to
 * payments:write. A site's own key (rt_) and a key for one site's payments never reach mail, which covers every domain
 * of the deployment.
 */
export function mayEraseMail(c: Context<AppEnv>): boolean {
  if (c.get('role') === 'admin') return true;
  return !!apiKeyOf(c)?.scopes.includes('mail:write');
}
