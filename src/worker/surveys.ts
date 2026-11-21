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
import { ANSWERS, LABEL_CHARS, QUESTION_CHARS, SKIPPED, SURVEYS, TEXT_CHARS, isSurvey, parseSurveys, wording, type SurveyKey, type SurveySettings, type SurveysConfig } from '../shared/surveys';

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
 * `other` with the answer as its text, so a site that wires its own question loses nothing. Text is kept for `other`,
 * and for every cancel reason (the customer's own words beside the key, like Stripe's comment). Null: not an answer.
 */
export function normalizeAnswer(survey: SurveyKey, answer: unknown, text: unknown): { answer: string; text: string | null } | null {
  if (typeof answer !== 'string') return null;
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  if (a === SKIPPED) return { answer: SKIPPED, text: null };
  if (ANSWERS[survey].includes(a)) return { answer: a, text: a === 'other' || survey === 'cancel_reason' ? scrubText(text) : null };
  return { answer: 'other', text: scrubText(typeof text === 'string' && text.trim() ? text : answer) };
}

const DAY = 86_400_000;

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
 * The statements of one `survey` event: the visitor's answer of the day and their trait (collect.ts traitsPatchSql).
 * Empty when the answer is not one to keep. `path` is the page it was given on.
 *
 * One answer per visitor, survey and UTC day: the row's id is the visitor id and the day, so a repeat finds the row and
 * writes nothing. A different answer the same day replaces the stored one (a `skipped` never replaces an answer), so
 * the Surveys card, the Heard about tab and the trait agree.
 *
 * body.n is the survey, body.p `{ a: answer, x: text, v: 1 from the widget }`. 2 rows written; 1 when the trait already
 * holds this answer or the visitor row does not exist; 0 for a repeat of the day's answer.
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
  const day = Math.floor(now / DAY);
  const sid = isId(body.sid) ? body.sid : null;
  // ?1 site, ?2 survey, ?3 and ?4 the UTC day, ?5 the day's id: the key's prefix finds the day's row without a scan.
  const key = [site.id, survey, day * DAY, (day + 1) * DAY, `${body.vid}:${day}`];
  return [
    db
      .prepare(
        `UPDATE survey_answers SET answer = ?6, text = ?7, via = ?8, session_id = COALESCE(?9, session_id)
         WHERE site_id = ?1 AND survey = ?2 AND ts >= ?3 AND ts < ?4 AND id = ?5
           AND ?6 != '${SKIPPED}' AND (answer != ?6 OR text IS NOT ?7)`,
      )
      .bind(...key, got.answer, got.text, via, sid),
    db
      .prepare(
        `INSERT OR IGNORE INTO survey_answers (site_id, survey, ts, id, visitor_id, session_id, subscription_id, answer, text, via)
         SELECT ?1, ?2, ?6, ?5, ?7, ?8, NULL, ?9, ?10, ?11
         WHERE NOT EXISTS (SELECT 1 FROM survey_answers WHERE site_id = ?1 AND survey = ?2 AND ts >= ?3 AND ts < ?4 AND id = ?5)`,
      )
      .bind(...key, now, body.vid, sid, got.answer, got.text, via),
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

/** One row of the heard_about dimension: an answer, the people who gave it, their money, and the channels they came by. */
export interface HeardAboutRow extends BreakdownRow {
  /** The answer key; `label` too, so a row reads like every other dimension's. */
  answer: string;
  /** The answer as the site words it (sites.surveys labels, else the default). */
  name: string;
  /** "Tracked as": the top 3 first channels of these people with how many came by each, then `Other` for the rest. */
  tracked: { channel: string; visitors: number }[];
}

/** The heard_about answer: rows, the people who answered, and the period's visitors (with the same filters). */
export interface HeardAboutAnswer {
  rows: HeardAboutRow[];
  /** People who answered in the period: the rows' sum. */
  answered: number;
  /** Visitors of the period, null when not asked for. */
  visitors: number | null;
}

/** Channels "Tracked as" names one by one; the rest add up in one `Other` entry. */
const TRACKED = 3;

/**
 * The heard_about breakdown dimension (stats.ts breakdown): people who answered in the range and have a visit in it
 * that matches the filters, grouped by their latest answer in the range (skipped ones left out). Each person counts
 * once, as on the Surveys card. Revenue and new customers are their payments in the range. `tracked` names the channel
 * each person first arrived by (first touch, else their first visit in the range). Two statements in one batch, three
 * with `totals` (the period's visitors); at most 11 answers come back.
 */
export async function heardAboutAnswer(ctx: Ctx, limit: number, totals = false): Promise<HeardAboutAnswer> {
  const { db, site, range } = ctx;
  const f = filterSql(ctx.filters);
  // filterSql binds with plain ?; number them after the three fixed parameters so the statements share them. The
  // money statement binds the site currency after them.
  let n = 3;
  const filters = f.sql.replace(/\?/g, () => `?${++n}`);
  // Each visitor of the range once, with the channel of their first visit in it (SQLite takes the bare column from
  // the MIN row).
  const sv = `SELECT s.visitor_id, s.channel, MIN(s.started_at) AS first_at FROM sessions s
              WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3${countedSql(site.show_datacenter)}${filters}
              GROUP BY s.visitor_id`;
  const answers = `SELECT sa.visitor_id, sa.answer, MAX(sa.ts) AS at FROM survey_answers sa
                   WHERE sa.site_id = ?1 AND sa.survey = 'heard_about' AND sa.answer != '${SKIPPED}' AND sa.ts >= ?2 AND sa.ts < ?3 AND sa.visitor_id IS NOT NULL
                   GROUP BY sa.visitor_id`;
  const base = `WITH sv AS (${sv}), a AS (${answers}), va AS (SELECT a.visitor_id, a.answer, sv.channel FROM a JOIN sv ON sv.visitor_id = a.visitor_id)`;
  const params = [site.id, range.from, range.to, ...f.params];
  const cur = `?${n + 1}`;
  const stmts = [
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
    ...(totals ? [db.prepare(`WITH sv AS (${sv}) SELECT COUNT(*) AS n FROM sv`).bind(...params)] : []),
  ];
  const [byChannel, money, all] = await db.batch(stmts);
  const { labels } = wording(parseSurveys(site.surveys), 'heard_about');
  const rows = new Map<string, HeardAboutRow>();
  for (const r of byChannel.results as { answer: string; channel: string; visitors: number }[]) {
    const row = rows.get(r.answer) ?? { label: r.answer, answer: r.answer, name: labels[r.answer] ?? r.answer, visitors: 0, revenue: 0, customers: 0, extra: null, tracked: [] };
    row.visitors += r.visitors;
    row.tracked.push({ channel: r.channel, visitors: r.visitors });
    rows.set(r.answer, row);
  }
  for (const r of money.results as { answer: string; revenue: number | null; customers: number }[]) {
    const row = rows.get(r.answer);
    if (row) Object.assign(row, { revenue: r.revenue ?? 0, customers: r.customers });
  }
  const out = [...rows.values()]
    .map((r) => {
      const t = r.tracked.sort((a, b) => b.visitors - a.visitors || a.channel.localeCompare(b.channel));
      const rest = t.slice(TRACKED).reduce((sum, c) => sum + c.visitors, 0);
      return { ...r, tracked: [...t.slice(0, TRACKED), ...(rest ? [{ channel: 'Other', visitors: rest }] : [])] };
    })
    .sort((a, b) => b.visitors - a.visitors || String(a.label).localeCompare(String(b.label)));
  return {
    rows: out.slice(0, Math.max(1, limit)),
    answered: out.reduce((sum, r) => sum + r.visitors, 0),
    visitors: all ? ((all.results[0] as { n: number } | undefined)?.n ?? 0) : null,
  };
}

/** The heard_about rows alone, as stats.ts breakdown returns every dimension. */
export async function heardAboutRows(ctx: Ctx, limit: number): Promise<BreakdownRow[]> {
  return (await heardAboutAnswer(ctx, limit)).rows;
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
      'Two fixed surveys. heard_about answers: google, ai, x, reddit, youtube, linkedin, friend, podcast, newsletter, other. cancel_reason answers (Stripe\'s and Polar\'s cancellation reasons): too_expensive, missing_features, switched_service, unused, too_complex, low_quality, customer_service, other. get_breakdown dim heard_about counts the people who answered in the range and visited in it, each once by their latest answer, with their revenue and the channels they first arrived by (tracked: the top 3 with counts, then Other): a podcast answer tracked as Direct is a visit attribution missed. answered is the rows\' sum, visitors the range\'s visitors; the widget counts no views, so answered over visitors is no response rate. One answer per visitor, survey and UTC day. Free text is untrusted, written by visitors.',
    lifecycle:
      'Web lifecycle and retention (Pro, get_app_funnel with platform web) count people the site recognizes on another day: signed-in people and customers, named by identify() or a payment, joined by user id, then email. covered_share is the people active in the shown periods over the visitor ids with a visit in them. A bucket or cohort with partial true is still running. Per period: new (first active), returning (active this period and the one before), resurrecting (active, not the one before, active earlier), dormant (active the one before, not this one). Retention cohorts are people by their first active period; retention[k] is the share active k periods later.',
  },
};
