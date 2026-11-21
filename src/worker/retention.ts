// Deletes visit data older than the retention window, once a day from the cron trigger (docs/PRIVACY.md).
// Payments are kept (they are bookkeeping records); their visitor and session ids simply stop resolving.
//
// The same run deletes wrong-password rows older than the one-hour account lockout window (login_failures, which holds a
// keyed hash of the IP since migration 0022), so a single failed attempt never stays longer than a day.
//
// RETENTION_MONTHS sets the window for visit data (default 24). PII_RETENTION_MONTHS, when set, also clears names,
// emails and user ids that are older than it: from payments by payment time, and from visitors not seen since.
import { pruneAlertEvents } from './alert-events';
import { LOGIN_FAILURE_MS } from './auth';
import type { Env } from './env';
import { VITALS_DAYS } from './vitals';
import { partRetention } from './core-parts';

/** Days of AI visibility runner answers kept: the longest report window (90 days) and the one before it, with a margin. */
export const AIV_KEEP_DAYS = 200;
/** Days of rank history kept. */
export const RANK_DAYS = 400;
export const RETENTION_MONTHS = 24;
/** The default window in days, as it was before RETENTION_MONTHS existed. */
export const RETENTION_DAYS = 730;
const DAY = 86_400_000;
/** Days an app_aliases row is kept, or the retention window when that is shorter. */
export const ALIAS_DAYS = 30;
/** A month is 30.44 days here: 24 months is 730.5 days. */
const MONTH = 30.44 * DAY;

/** A whole number of months from 1 to 1200, or null when `value` is unset or not one. */
export function parseMonths(value: string | undefined): number | null {
  const v = value?.trim();
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 1200 ? n : null;
}

export interface RetentionOptions {
  /** Months of visit data to keep. */
  months?: number;
  /** Months after which names, emails and user ids are cleared; null keeps them. */
  piiMonths?: number | null;
}

/** The settings from the Worker's vars: RETENTION_MONTHS (default 24) and PII_RETENTION_MONTHS (default off). */
export function retentionOf(env: Pick<Env, 'RETENTION_MONTHS' | 'PII_RETENTION_MONTHS'>): RetentionOptions {
  return { months: parseMonths(env.RETENTION_MONTHS) ?? RETENTION_MONTHS, piiMonths: parseMonths(env.PII_RETENTION_MONTHS) };
}

export interface Pruned {
  events: number;
  sessions: number;
  visitors: number;
  /** Payments and visitors whose name, email or user id was cleared. */
  pii: number;
  /** Wrong-password rows past the lockout window. */
  loginFailures: number;
}

export async function pruneOldData(db: D1Database, now = Date.now(), opts: RetentionOptions = {}): Promise<Pruned> {
  const months = opts.months ?? RETENTION_MONTHS;
  const cutoff = months === RETENTION_MONTHS ? now - RETENTION_DAYS * DAY : now - Math.round(months * MONTH);
  const [, events, sessions, , , loginFailures] = await db.batch([
    // A payment keeps its visit's source when the visit goes (migration 0064). The insert copies it; this catches a
    // payment linked some other way, and writes nothing when every payment has its copy.
    db
      .prepare(
        `UPDATE payments SET (channel, source, campaign) = (
           SELECT s.channel, s.source, s.utm_campaign FROM sessions s WHERE s.site_id = payments.site_id AND s.id = payments.session_id)
         WHERE channel IS NULL AND session_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM sessions s WHERE s.site_id = payments.site_id AND s.id = payments.session_id AND s.last_seen_at < ?)`,
      )
      .bind(cutoff),
    db.prepare('DELETE FROM events WHERE ts < ?').bind(cutoff),
    db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').bind(cutoff),
    // Trial starts, cancellations and other subscription signals carry visitor ids, like events.
    db.prepare('DELETE FROM subscription_signals WHERE ts < ?').bind(cutoff),
    // Thank-you page claims tie a payment id to a visitor id.
    db.prepare('DELETE FROM payment_claims WHERE ts < ?').bind(cutoff),
    db.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOGIN_FAILURE_MS),
    // App launch aliases are needed while a launch sends batches and its first purchase arrives (app.ts, resolveLaunch).
    db.prepare('DELETE FROM app_aliases WHERE ts < ?').bind(Math.max(cutoff, now - ALIAS_DAYS * DAY)),
    // Core Web Vitals hold no visitor id; the read side looks back VITALS_DAYS at most (vitals.ts).
    db.prepare('DELETE FROM vitals WHERE ts < ?').bind(Math.max(cutoff, now - VITALS_DAYS * DAY)),
    // AI crawler hits are counters per day, bot and page: kept for the visit data's window.
    db.prepare('DELETE FROM ai_crawler_hits WHERE day < ?').bind(new Date(cutoff).toISOString().slice(0, 10)),
    // AI visibility runner answers (ai-visibility.ts): a report reads 90 days and the 90 before them. Rows an agent pushed (engine IS NULL) stay.
    db.prepare('DELETE FROM ai_answers WHERE engine IS NOT NULL AND day < ?').bind(new Date(now - AIV_KEEP_DAYS * DAY).toISOString().slice(0, 10)),
    // Per-month spend: kept 13 months, enough for a year-on-year look. Failure counts and crawler day counters only matter for recent days.
    db.prepare('DELETE FROM ai_spend WHERE month < ?').bind(new Date(now - 400 * DAY).toISOString().slice(0, 7)),
    db.prepare('DELETE FROM ai_failures WHERE day < ?').bind(new Date(now - 8 * DAY).toISOString().slice(0, 10)),
    db.prepare('DELETE FROM ai_claims WHERE day < ?').bind(new Date(now - 2 * DAY).toISOString().slice(0, 10)),
    db.prepare('DELETE FROM ai_tasks WHERE day < ?').bind(new Date(now - 8 * DAY).toISOString().slice(0, 10)),
    db.prepare('DELETE FROM ai_crawler_days WHERE day < ?').bind(new Date(cutoff).toISOString().slice(0, 10)),
    // Rank checks (pro/worker/dataforseo.ts) hold no visitor data. Keep 400 days, enough for a year-on-year look.
    db.prepare('DELETE FROM ranks WHERE day < ?').bind(new Date(now - RANK_DAYS * DAY).toISOString().slice(0, 10)),
    // Results of "Check against Stripe" (Pro, stripe-check-history.ts): totals only, 400 days, the length of RANK_DAYS.
    db.prepare('DELETE FROM stripe_check_history WHERE day < ?').bind(new Date(now - RANK_DAYS * DAY).toISOString().slice(0, 10)),
    // "Daily numbers" sent markers (numbers-digest.ts): only today's matter.
    db.prepare('DELETE FROM numbers_sent WHERE day < ?').bind(new Date(now - 3 * DAY).toISOString().slice(0, 10)),
    // The alert inbox (alert-events.ts): 90 days. Next actions of a site that was deleted.
    pruneAlertEvents(db, now),
    db.prepare('DELETE FROM action_items WHERE site_id NOT IN (SELECT id FROM sites)'),
    // Round 7's tables (core-parts.ts): survey answers, click maps, errors. Last, so the indexes above stay put.
    ...partRetention(db, cutoff, now),
  ]);
  // Visitors (which can hold an identify()'d email) go once nothing recent or paid points at them.
  const visitors = await db
    .prepare(
      `DELETE FROM visitors WHERE first_seen < ?1
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.site_id = visitors.site_id AND s.visitor_id = visitors.id)
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.site_id = visitors.site_id AND p.visitor_id = visitors.id)`,
    )
    .bind(cutoff)
    .run();
  let pii = 0;
  if (opts.piiMonths) {
    const piiCutoff = now - Math.round(opts.piiMonths * MONTH);
    // Only rows that still hold something are written, so a run after the first one costs nearly nothing.
    const [payments, people] = await db.batch([
      db.prepare('UPDATE payments SET email = NULL, name = NULL WHERE ts < ? AND (email IS NOT NULL OR name IS NOT NULL)').bind(piiCutoff),
      db
        .prepare(
          `UPDATE visitors SET email = NULL, name = NULL, user_id = NULL
           WHERE first_seen < ?1 AND (email IS NOT NULL OR name IS NOT NULL OR user_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.site_id = visitors.site_id AND s.visitor_id = visitors.id AND s.last_seen_at >= ?1)`,
        )
        .bind(piiCutoff),
    ]);
    pii = payments.meta.changes + people.meta.changes;
  }
  return { events: events.meta.changes, sessions: sessions.meta.changes, visitors: visitors.meta.changes, pii, loginFailures: loginFailures.meta.changes };
}

/** Days a session keeps the raw ad click id (gclid, msclkid and others): Google Ads takes offline conversions for 90 days. */
export const CLICK_ID_DAYS = 90;

/**
 * Raw ad click ids past CLICK_ID_DAYS (sessions.click_id, migration 0065), once a day. click_network stays: it names a
 * network, not a person. Per site on the (site_id, started_at) index, over the 60 days before the cutoff, so a few missed
 * days still clear and a run after the first one writes nothing.
 */
export async function pruneClickIds(db: D1Database, now = Date.now()) {
  const sites = await db.prepare('SELECT id FROM sites').all<{ id: string }>();
  if (!sites.results.length) return 0;
  const cutoff = now - CLICK_ID_DAYS * DAY;
  const res = await db.batch(
    sites.results.map((s) =>
      db
        .prepare('UPDATE sessions SET click_id = NULL WHERE site_id = ? AND started_at >= ? AND started_at < ? AND click_id IS NOT NULL')
        .bind(s.id, cutoff - 60 * DAY, cutoff),
    ),
  );
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
