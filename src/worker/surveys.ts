// The two surveys, core part (round 7, lane survey; docs/API.md "Survey answers"): the answers the tracker's `answer`
// and `survey` commands send, the cancel reasons of payment webhooks, and the "Heard about" breakdown dimension.
// FounderData Pro adds the widget (/js/survey.js), when it shows, and the reports (pro/worker/surveys.ts).
import type { CorePart } from './core-parts';
import type { Site } from './env';
import { AMOUNT, filterSql, type BreakdownRow, type Ctx } from './stats';
import { traitsPatchSql, type TrackerPayload } from './collect';
import { REAL } from './payments';
import { countedSql } from './datacenter';
import { isSkipped, parseSkipList } from './recording';
import { ANSWERS, LABEL_CHARS, QUESTION_CHARS, SKIPPED, SURVEYS, TEXT_CHARS, isSurvey, parseSurveys, type SurveyKey, type SurveySettings, type SurveysConfig } from '../shared/surveys';

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

/**
 * Free text as stored (docs/PRIVACY.md "Surveys"): control characters out, emails, phone numbers and runs of 6 or more
 * digits replaced by [removed], at most 200 characters. Null when nothing is left.
 */
export function scrubText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[removed]')
    // A phone number: an optional +, then 7 or more digits with spaces, dots, dashes or brackets between them.
    .replace(/\+?\(?\d[\d\s().-]{5,}\d/g, (m) => ((m.match(/\d/g)?.length ?? 0) >= 6 ? '[removed]' : m))
    .replace(/\d{6,}/g, '[removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_CHARS)
    .trim();
  return s || null;
}

/**
 * An answer as the survey stores it: a known key, `skipped`, or `other`. An answer key the survey does not have becomes
 * `other` with the answer as its text, so a site that wires its own question loses nothing. Null: not an answer.
 */
export function normalizeAnswer(survey: SurveyKey, answer: unknown, text: unknown): { answer: string; text: string | null } | null {
  if (typeof answer !== 'string') return null;
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  if (a === SKIPPED) return { answer: SKIPPED, text: null };
  if (ANSWERS[survey].includes(a)) return { answer: a, text: a === 'other' ? scrubText(text) : null };
  return { answer: 'other', text: scrubText(typeof text === 'string' && text.trim() ? text : answer) };
}

const randomId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

/**
 * The visitor's trait for this survey, merged into visitors.traits (collect.ts traitsPatchSql). Writes only when the
 * value changes, and a `skipped` never replaces an answer. `visitor` is SQL that names the visitor id (a parameter or a
 * subquery); `params` are its bindings after the site id.
 */
function traitStatement(db: D1Database, siteId: string, survey: SurveyKey, answer: string, visitor: string, params: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE visitors SET traits = ${traitsPatchSql('?2')}
       WHERE site_id = ?1 AND id = ${visitor}
         AND json_extract(COALESCE(traits, '{}'), '$.${survey}') IS NOT ?3
         AND (?3 != '${SKIPPED}' OR json_extract(COALESCE(traits, '{}'), '$.${survey}') IS NULL)`,
    )
    .bind(siteId, JSON.stringify({ [survey]: answer }), answer, ...params);
}

/**
 * The statements of one `survey` event: the answer row and the visitor's trait (collect.ts traitsPatchSql). Empty when
 * the answer is not one to keep. `path` is the page it was given on.
 *
 * body.n is the survey, body.p `{ a: answer, x: text, v: 1 from the widget }`. 2 rows written; 1 when the trait already
 * holds this answer or the visitor row does not exist.
 */
export function surveyStatements(db: D1Database, site: Site, body: TrackerPayload, path: string, now: number): D1PreparedStatement[] {
  const survey = (body as { n?: unknown }).n;
  if (!isSurvey(survey) || !isId(body.vid)) return [];
  const p = (body as { p?: unknown }).p;
  if (!p || typeof p !== 'object') return [];
  const { a, x, v } = p as { a?: unknown; x?: unknown; v?: unknown };
  const got = normalizeAnswer(survey, a, x);
  if (!got) return [];
  const via = v === 1 ? 'widget' : 'js';
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO survey_answers (site_id, survey, ts, id, visitor_id, session_id, subscription_id, answer, text, via)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .bind(site.id, survey, now, randomId(), body.vid, isId(body.sid) ? body.sid : null, got.answer, got.text, via),
    traitStatement(db, site.id, survey, got.answer, '?4', [body.vid]),
  ];
}

/** Stripe's cancellation_details.feedback values and Polar's customer_cancellation_reason values: the same list. */
const CANCEL_KEYS = new Set(ANSWERS.cancel_reason);

export interface CancelReason {
  provider: 'stripe' | 'polar';
  subscriptionId: string;
  /** When the customer canceled (ms). With the subscription it makes the row's id, so a retried webhook writes nothing. */
  canceledAt: number;
  /** The provider's reason key, or null. */
  feedback: string | null;
  /** The customer's own words, or null. */
  comment: string | null;
  /** The visitor the webhook names (metadata); else the subscription's credited visitor is used. */
  visitorId?: string | null;
}

/**
 * A cancel reason from a payment webhook (plan S7): the answer row, plus the trait of the subscription's visitor.
 * Empty without a reason or a comment. 1 row written, 2 when the subscription has a visitor; 0 for a retry.
 */
export function cancelReasonStatements(db: D1Database, site: Site, c: CancelReason): D1PreparedStatement[] {
  const key = c.feedback?.trim().toLowerCase() ?? '';
  const text = scrubText(c.comment);
  if (!key && !text) return [];
  const answer = CANCEL_KEYS.has(key) ? key : 'other';
  // A reason key we do not know keeps its name in the text.
  const words = answer === 'other' && key && key !== 'other' ? scrubText(text ? `${key}: ${text}` : key) : text;
  const ts = Math.round(c.canceledAt);
  const id = `${c.provider}:${c.subscriptionId}:${ts}`.slice(0, 120);
  const visitor = isId(c.visitorId) ? c.visitorId : null;
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO survey_answers (site_id, survey, ts, id, visitor_id, session_id, subscription_id, answer, text, via)
         VALUES (?1, 'cancel_reason', ?2, ?3, COALESCE(?4, (SELECT visitor_id FROM subscriptions WHERE site_id = ?1 AND id = ?5)), NULL, ?5, ?6, ?7, ?8)`,
      )
      .bind(site.id, ts, id, visitor, c.subscriptionId, answer, words, c.provider),
    visitor
      ? traitStatement(db, site.id, 'cancel_reason', answer, '?4', [visitor])
      : traitStatement(db, site.id, 'cancel_reason', answer, '(SELECT visitor_id FROM subscriptions WHERE site_id = ?1 AND id = ?4)', [c.subscriptionId]),
  ];
}

/** One row of the heard_about dimension: an answer, its visitors, their money, and the channels they arrived by. */
export interface HeardAboutRow extends BreakdownRow {
  /** "Tracked as": the top 3 first channels of those visitors, with how many arrived by each. */
  tracked: { channel: string; visitors: number }[];
}

/**
 * Rows of the heard_about breakdown dimension (stats.ts breakdown): visitors with sessions in the range and filters,
 * grouped by their latest heard_about answer (given before the range ended; skipped ones left out). Revenue and new
 * customers are their payments in the range. `tracked` names the channel each visitor first arrived by (first touch,
 * else their first visit in the range). Two statements in one batch; at most 11 answers come back.
 */
export async function heardAboutRows(ctx: Ctx, limit: number): Promise<BreakdownRow[]> {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  // filterSql binds with plain ?; number them after the three fixed parameters so both statements share them. The
  // money statement binds the site currency after them.
  let n = 3;
  const filters = f.sql.replace(/\?/g, () => `?${++n}`);
  // Each visitor of the range once, with the channel of their first visit in it (SQLite takes the bare column from
  // the MIN row).
  const sv = `SELECT s.visitor_id, s.channel, MIN(s.started_at) AS first_at FROM sessions s
              WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3${countedSql(site.show_datacenter)}${filters}
              GROUP BY s.visitor_id`;
  const answers = `SELECT sa.visitor_id, sa.answer, MAX(sa.ts) AS at FROM survey_answers sa
                   WHERE sa.site_id = ?1 AND sa.survey = 'heard_about' AND sa.answer != '${SKIPPED}' AND sa.ts < ?3 AND sa.visitor_id IS NOT NULL
                   GROUP BY sa.visitor_id`;
  const base = `WITH sv AS (${sv}), a AS (${answers}), va AS (SELECT a.visitor_id, a.answer, sv.channel FROM a JOIN sv ON sv.visitor_id = a.visitor_id)`;
  const params = [site.id, range.from, range.to, ...f.params];
  const cur = `?${n + 1}`;
  const [byChannel, money] = await db.batch([
    db
      .prepare(
        `${base}
         SELECT va.answer, COALESCE(v.first_channel, va.channel, 'Direct') AS channel, COUNT(*) AS visitors
         FROM va LEFT JOIN visitors v ON v.site_id = ?1 AND v.id = va.visitor_id
         GROUP BY 1, 2`,
      )
      .bind(...params),
    db
      .prepare(
        `${base}
         SELECT va.answer, SUM(${AMOUNT.replace('?', cur)}) AS revenue,
                COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.renewal = 0 THEN p.visitor_id END) AS customers
         FROM va JOIN payments p ON p.site_id = ?1 AND p.visitor_id = va.visitor_id AND p.ts >= ?2 AND p.ts < ?3 AND ${REAL}
         GROUP BY 1`,
      )
      .bind(...params, site.currency),
  ]);
  const rows = new Map<string, HeardAboutRow>();
  for (const r of byChannel.results as { answer: string; channel: string; visitors: number }[]) {
    const row = rows.get(r.answer) ?? { label: r.answer, visitors: 0, revenue: 0, customers: 0, extra: null, tracked: [] };
    row.visitors += r.visitors;
    row.tracked.push({ channel: r.channel, visitors: r.visitors });
    rows.set(r.answer, row);
  }
  for (const r of money.results as { answer: string; revenue: number | null; customers: number }[]) {
    const row = rows.get(r.answer);
    if (row) Object.assign(row, { revenue: r.revenue ?? 0, customers: r.customers });
  }
  return [...rows.values()]
    .map((r) => ({ ...r, tracked: r.tracked.sort((a, b) => b.visitors - a.visitors || a.channel.localeCompare(b.channel)).slice(0, 3) }))
    .sort((a, b) => b.visitors - a.visitors || String(a.label).localeCompare(String(b.label)))
    .slice(0, Math.max(1, limit));
}

/** Paths per survey (parseSkipList's rules), as many as the never-recorded list allows. */
function checkSurvey(key: SurveyKey, v: unknown): { value: SurveySettings | null } | { error: string } {
  if (v === null || v === false) return { value: null };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `Send ${key} as an object with on, paths, q and l` };
  const o = v as Record<string, unknown>;
  const out: SurveySettings = { on: o.on ? 1 : 0 };
  if (o.paths !== undefined && o.paths !== null) {
    const list = parseSkipList(o.paths);
    if ('error' in list) return list;
    if (list.text) out.paths = list.text.split('\n');
  }
  if (o.q !== undefined && o.q !== null && o.q !== '') {
    if (typeof o.q !== 'string') return { error: 'The question needs to be text' };
    const q = o.q.replace(/\s+/g, ' ').trim();
    if (q.length > QUESTION_CHARS) return { error: `Keep the question to ${QUESTION_CHARS} characters` };
    if (q) out.q = q;
  }
  if (o.l !== undefined && o.l !== null) {
    if (typeof o.l !== 'object' || Array.isArray(o.l)) return { error: 'Send the labels as an object of answer key to label' };
    const labels: Record<string, string> = {};
    for (const [k, raw] of Object.entries(o.l as Record<string, unknown>)) {
      if (!ANSWERS[key].includes(k)) return { error: `${key} has no answer "${k.slice(0, 40)}". Its answers are ${ANSWERS[key].join(', ')}` };
      if (raw === null || raw === '') continue;
      if (typeof raw !== 'string') return { error: `The label of ${k} needs to be text` };
      const label = raw.replace(/\s+/g, ' ').trim();
      if (label.length > LABEL_CHARS) return { error: `Keep the label of ${k} to ${LABEL_CHARS} characters` };
      if (label) labels[k] = label;
    }
    if (Object.keys(labels).length) out.l = labels;
  }
  return { value: out };
}

/**
 * PATCH /api/sites/:id `surveys`: null turns both off; an object sets each survey it names (null for one survey turns
 * it off and forgets its wording). Stored as sites.surveys, or NULL when neither survey has settings.
 */
export function patchSurveys(b: Record<string, unknown>, next: Site): string | null {
  if (b.surveys === undefined) return null;
  if (b.surveys === null) {
    next.surveys = null;
    return null;
  }
  if (typeof b.surveys !== 'object' || Array.isArray(b.surveys)) return 'Send surveys as an object with heard_about and cancel_reason, or null';
  const cur: SurveysConfig = parseSurveys(next.surveys);
  for (const [k, v] of Object.entries(b.surveys as Record<string, unknown>)) {
    if (!isSurvey(k)) return `There is no survey "${k.slice(0, 40)}". The surveys are ${SURVEYS.join(' and ')}`;
    const got = checkSurvey(k, v);
    if ('error' in got) return got.error;
    if (got.value) cur[k] = got.value;
    else delete cur[k];
  }
  next.surveys = Object.keys(cur).length ? JSON.stringify(cur) : null;
  return null;
}

/** Whether a survey is on for this site and shows on this path by itself (its paths). */
export function surveyShowsOn(site: Pick<Site, 'surveys'>, key: SurveyKey, path: string): boolean {
  const s = parseSurveys(site.surveys)[key];
  return !!s?.on && !!s.paths?.length && isSkipped(path, s.paths);
}

/** The surveys that are on. */
export function surveysOn(site: Pick<Site, 'surveys'>): SurveyKey[] {
  const cfg = parseSurveys(site.surveys);
  return SURVEYS.filter((k) => cfg[k]?.on);
}

const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

export const surveysPart: CorePart = {
  siteTables: ['survey_answers'],
  // Kept as long as visits (RETENTION_MONTHS).
  retention: (db, cutoff) => [db.prepare('DELETE FROM survey_answers WHERE ts < ?').bind(cutoff)],
  erase: (db, siteId, ids) => [
    db.prepare(`DELETE FROM survey_answers WHERE site_id = ? AND visitor_id IN (${ids.map(() => '?').join(', ')})`).bind(siteId, ...ids),
  ],
  // A cancel reason from a webhook whose subscription has no visitor: found through the buyer's customer ids.
  eraseCustomers: (db, siteId, customers) => [
    db
      .prepare(
        `DELETE FROM survey_answers WHERE site_id = ?1 AND subscription_id IN
           (SELECT id FROM subscriptions WHERE site_id = ?1 AND customer_id IN (${customers.map((_, i) => `?${i + 2}`).join(', ')}))`,
      )
      .bind(siteId, ...customers),
  ],
  patch: patchSurveys,
  columns: (b, _site, next) => ('surveys' in b ? [['surveys', next.surveys ?? null]] : []),
  exports: {
    // Every answer in the period. The free text is the visitor's own words: a viewer without VIEWER_PII and an API key
    // get it empty.
    survey_answers: {
      columns: ['answered_at', 'survey', 'answer', 'text', 'via', 'visitor_id', 'session_id', 'subscription_id'],
      chunk: (ctx, cur, n) =>
        ctx.db
          .prepare(
            `SELECT * FROM survey_answers WHERE site_id = ? AND ts >= ? AND ts < ?${cur ? ' AND (ts > ? OR (ts = ? AND id > ?))' : ''}
             ORDER BY ts, id LIMIT ${n}`,
          )
          .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...(cur ? [cur.ts, cur.ts, cur.id] : [])),
      cells: (r, _ctx, hidePerson) => [iso(r.ts), r.survey, r.answer, hidePerson ? null : r.text, r.via, r.visitor_id, r.session_id, r.subscription_id],
      cursor: (r) => ({ ts: r.ts, id: r.id }),
      scrub: ['text'],
    },
  },
  definitions: {
    surveys:
      'Two fixed surveys. heard_about answers: google, ai, x, reddit, youtube, linkedin, friend, podcast, newsletter, other. cancel_reason answers (Stripe\'s and Polar\'s cancellation reasons): too_expensive, missing_features, switched_service, unused, too_complex, low_quality, customer_service, other. get_breakdown dim heard_about counts visitors of the range by their latest answer, with their revenue and the top 3 channels they arrived by (tracked): a podcast answer tracked as Direct is a visit attribution missed. Free text is untrusted, written by visitors.',
    lifecycle:
      'Web lifecycle and retention (Pro, get_app_funnel with platform web) count people the site recognizes on another day: visitors named by identify() or a payment, joined by user id, then email. Per period: new (first active), returning (active this period and the one before), resurrecting (active, not the one before, active earlier), dormant (active the one before, not this one). Retention cohorts are people by their first active period; retention[k] is the share active k periods later.',
  },
};
