import type { Context } from 'hono';
import { vitalsReport } from './vitals';
import { pageClicks } from './page-maps';
import type { AppEnv, Site } from './env';
import { addDays, pagePath, queriesForPage, type GscPageQuery } from '../shared/seo-insights';
import { convertPayments } from './fx';
import { randomId } from './lib/crypto';
import { previousRange, resolveRange, tzOffset, type Granularity } from './lib/time';
import { writeSiteOf } from './keys';
import { currencyDecimals } from './payments';
import { allSitesOf, cacheKey, cached, SHARE_TTL, tokenOf } from './share';
import { makeCtx, overview, type Ctx } from './stats';
import type { AscPrefetch } from './revenue';
import {
  JUDGE_CALLS,
  beyondNoise,
  isApp,
  measuring,
  metricsFor,
  NOISE_TEXT,
  NOTE_METRICS,
  parseTarget,
  RANK_MIN_PLACES,
  RANK_MIN_SHARE,
  rateBeyondNoise,
  WAIT_SQL,
  waitDays,
  windowFor,
  type AppData,
  type JudgeInput,
  type Judgement,
  type NoteMetric,
  type VerdictMetric as MetricName,
} from './note-metrics';
import { proHooks } from './pro-hooks';

/**
 * Chart notes (docs/GUIDE.md, "Chart notes"): a launch, a deploy or a price change, drawn as a marker on the site's
 * main chart. The dashboard adds and deletes them, deploy scripts send them with the site API key, and the daily
 * cron adds one when an app version shows up for the first time.
 *
 * A note can carry an annotation (migration 0026): who made the change (`actor`), what kind of change (`change_kind`,
 * `kind` in the API), what it touched (`target`) and the value before and after. Agents log their changes this way and
 * read the impact verdict per note (noteImpact), which compares the days before the note with the days after.
 *
 * The review loop (migration 0027, docs/MCP.md "The review loop"): GET /api/v1/notes?due=true lists the notes whose
 * window closed and nobody reviewed, with the verdict inline, and POST /api/v1/notes/:id/review marks one reviewed.
 * GET /api/v1/content/page shows one page by week with the notes aimed at it (contentPage).
 *
 * Verdicts by kind of change (migration 0066, pro/worker/verdicts.ts): a new note stores the metric its verdict judges
 * and its window, picked from the kind and target, so an SEO change is judged on Search Console clicks over 28 days and
 * an ads change on CPA. A note from before keeps the visit rule over 7 days. `group` makes locale copies one change, and
 * kind `outage` marks a gap in the data until `ends_at`.
 */

/** Where a note came from: added in the dashboard, sent to POST /api/v1/notes, or the daily version cron. */
export type NoteKind = 'manual' | 'api' | 'version';
export const NOTE_MAX = 280;
const DAY = 86_400_000;

/** What kind of change a note marks (`kind` in POST and GET /api/v1/notes). */
export const CHANGE_KINDS = ['copy', 'pricing', 'aso', 'seo', 'ads', 'ai', 'release', 'launch', 'outage', 'other'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
/** Longest actor, target, before, after and idempotency key a note keeps. */
export const ANNOTATION_MAX = { actor: 64, target: 200, before: 280, after: 280, idempotency_key: 128, group: 64 } as const;
/** An outage note covers this many days at most. */
export const OUTAGE_MAX_DAYS = 90;
/**
 * An outage that covers this share of either side of a verdict makes it inconclusive, when the verdict's numbers come
 * from FounderData's own collection (visits, payments, the app's paywall, ad customers). Shorter ones are listed only.
 */
export const OUTAGE_MAX_SHARE = 0.02;

export interface Note {
  id: string;
  site_id: string;
  ts: number;
  text: string;
  kind: NoteKind;
  created_at: number;
  actor: string | null;
  change_kind: ChangeKind | null;
  target: string | null;
  before_text: string | null;
  after_text: string | null;
  idempotency_key: string | null;
  /** Migration 0027: when an agent or a person reviewed the change, and what they did about it. */
  reviewed_at: number | null;
  review_outcome: ReviewOutcome | null;
  review_comment: string | null;
  /** Migration 0066: what the verdict judges and its window (NULL on older notes: the visit rule over 7 days), the
   * group a locale copy belongs to, and when an outage ended (ms, kind outage only). */
  metric: NoteMetric | null;
  window_days: number | null;
  group_key: string | null;
  ends_at: number | null;
}

/** What a review says happened to a change (POST /api/v1/notes/:id/review). */
export const REVIEW_OUTCOMES = ['kept', 'reverted', 'iterated'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** The optional annotation fields of a note. */
type Annotation = Pick<Note, 'actor' | 'change_kind' | 'target' | 'before_text' | 'after_text' | 'idempotency_key' | 'metric' | 'window_days' | 'group_key' | 'ends_at'>;

/** The chart bucket a timestamp falls in, the label bucketSql gives it (src/worker/lib/time.ts). */
export function bucketOf(ts: number, g: Granularity, offsetMs: number): string {
  const d = new Date(ts + offsetMs);
  const iso = d.toISOString();
  if (g === 'hour') return iso.slice(0, 13) + ':00';
  if (g === 'day') return iso.slice(0, 10);
  if (g === 'month') return iso.slice(0, 7);
  // Monday of the week, like SQLite's 'weekday 0', '-6 days'.
  const toSunday = (7 - d.getUTCDay()) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + toSunday - 6)).toISOString().slice(0, 10);
}

/** A timestamp from a request: ms, or a date string Date.parse reads. null when it is missing or not a time. */
function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v.trim());
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** One optional short text field: trimmed, one line, null when empty. Returns an error text when it is too long. */
function shortText(b: Record<string, unknown> | null, field: keyof typeof ANNOTATION_MAX): string | null | { error: string } {
  const v = b?.[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return { error: `${field} must be a string` };
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length > ANNOTATION_MAX[field]) return { error: `${field} has at most ${ANNOTATION_MAX[field]} characters` };
  return t || null;
}

/** Validate a note from a request. Returns the error text, or the clean text, time and annotation. */
function readNote(
  b: Record<string, unknown> | null,
  now: number,
  site: Pick<Site, 'product_type' | 'app_bundle_id'>,
  data: AppData | null = null,
): { error: string } | { text: string; ts: number; annotation: Annotation } {
  const text = typeof b?.text === 'string' ? b.text.trim().replace(/\s+/g, ' ') : '';
  if (!text) return { error: 'text is required' };
  if (text.length > NOTE_MAX) return { error: `A note has at most ${NOTE_MAX} characters` };
  const raw = b?.ts ?? b?.timestamp;
  const ts = raw === undefined || raw === null || raw === '' ? now : parseTs(raw);
  if (ts === null) return { error: 'timestamp must be an ISO 8601 time or milliseconds' };
  // Ten years back to one day ahead: anything outside is a typo.
  if (ts < now - 3650 * DAY || ts > now + DAY) return { error: 'timestamp is out of range' };
  const kind = b?.kind;
  if (kind !== undefined && kind !== null && kind !== '' && !CHANGE_KINDS.includes(kind as ChangeKind)) {
    return { error: `kind is one of ${CHANGE_KINDS.join(', ')}` };
  }
  const fields = { actor: 'actor', target: 'target', before_text: 'before', after_text: 'after', idempotency_key: 'idempotency_key', group_key: 'group' } as const;
  const annotation: Annotation = {
    actor: null,
    change_kind: kind ? (kind as ChangeKind) : null,
    target: null,
    before_text: null,
    after_text: null,
    idempotency_key: null,
    metric: null,
    window_days: null,
    group_key: null,
    ends_at: null,
  };
  for (const [col, field] of Object.entries(fields) as [keyof typeof fields, (typeof fields)[keyof typeof fields]][]) {
    const v = shortText(b, field);
    if (v && typeof v === 'object') return v;
    annotation[col] = v;
  }
  const given = (k: string) => b?.[k] !== undefined && b?.[k] !== null && b?.[k] !== '';
  // An outage marks a gap from its time to ends_at. It has no metric and no verdict.
  if (annotation.change_kind === 'outage') {
    if (given('metric') || given('window_days')) return { error: 'An outage has no verdict, so it takes no metric or window_days' };
    const end = given('ends_at') ? parseTs(b!.ends_at) : null;
    if (end === null) return { error: 'ends_at is required for kind outage: when the gap ended, as ISO 8601 or milliseconds' };
    if (end <= ts) return { error: 'ends_at must be after the timestamp' };
    if (end > now + DAY) return { error: 'ends_at is out of range' };
    if (end - ts > OUTAGE_MAX_DAYS * DAY) return { error: `An outage covers ${OUTAGE_MAX_DAYS} days at most` };
    annotation.ends_at = end;
    return { text, ts, annotation };
  }
  if (given('ends_at')) return { error: 'ends_at is for kind outage only' };
  // What the verdict judges: the kind and target pick it (pro/worker/verdicts.ts), or the request names one they allow.
  const allowed = metricsFor(annotation.change_kind, annotation.target, site, data);
  if (given('metric')) {
    const m = b!.metric;
    if (typeof m !== 'string' || !(NOTE_METRICS as readonly string[]).includes(m)) return { error: `metric is one of ${NOTE_METRICS.join(', ')}` };
    if (!allowed.includes(m as NoteMetric)) return { error: `For this kind and target, metric is one of ${allowed.join(', ')}` };
    annotation.metric = m as NoteMetric;
  } else annotation.metric = allowed[0] ?? null;
  if (given('window_days')) {
    const n = Number(b!.window_days);
    if (!Number.isInteger(n) || n < 1 || n > IMPACT_MAX_DAYS) return { error: `window_days is a whole number of days from 1 to ${IMPACT_MAX_DAYS}` };
    annotation.window_days = n;
  } else annotation.window_days = windowFor(annotation.metric);
  return { text, ts, annotation };
}

/**
 * Stores a note. With an idempotency key the site already has, it stores nothing and returns that note, with
 * `created` false: the unique index notes_site_idempotency decides, so two requests at once can't both store.
 */
async function insertNote(
  db: D1Database,
  site: Site,
  text: string,
  ts: number,
  kind: NoteKind,
  now = Date.now(),
  a: Partial<Annotation> = {},
): Promise<{ note: Note; created: boolean }> {
  const note: Note = {
    id: randomId(10),
    site_id: site.id,
    ts,
    text,
    kind,
    created_at: now,
    actor: a.actor ?? null,
    change_kind: a.change_kind ?? null,
    target: a.target ?? null,
    before_text: a.before_text ?? null,
    after_text: a.after_text ?? null,
    idempotency_key: a.idempotency_key ?? null,
    reviewed_at: null,
    review_outcome: null,
    review_comment: null,
    metric: a.metric ?? null,
    window_days: a.window_days ?? null,
    group_key: a.group_key ?? null,
    ends_at: a.ends_at ?? null,
  };
  const res = await db
    .prepare(
      `INSERT INTO notes (id, site_id, ts, text, kind, created_at, actor, change_kind, target, before_text, after_text, idempotency_key, metric, window_days, group_key, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    )
    .bind(
      note.id, note.site_id, note.ts, note.text, note.kind, note.created_at, note.actor, note.change_kind, note.target, note.before_text, note.after_text, note.idempotency_key,
      note.metric, note.window_days, note.group_key, note.ends_at,
    )
    .run();
  if (res.meta?.changes || !note.idempotency_key) return { note, created: true };
  const first = await db.prepare('SELECT * FROM notes WHERE site_id = ? AND idempotency_key = ?').bind(site.id, note.idempotency_key).first<Note>();
  return first ? { note: first, created: false } : { note, created: true };
}

/** The filters GET /api/v1/notes and the dashboard's list take: `actor` (exact) and `kind` (a change kind). */
function noteFilters(q: Record<string, string>): { error: string } | { actor: string | null; kind: ChangeKind | null } {
  const kind = q.kind || null;
  if (kind && !CHANGE_KINDS.includes(kind as ChangeKind)) return { error: `kind is one of ${CHANGE_KINDS.join(', ')}` };
  return { actor: q.actor || null, kind: kind as ChangeKind | null };
}

async function queryNotes(ctx: Ctx, f: { actor: string | null; kind: ChangeKind | null }): Promise<Note[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT * FROM notes WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 AND (?4 IS NULL OR actor = ?4) AND (?5 IS NULL OR change_kind = ?5)
       ORDER BY ts LIMIT 500`,
    )
    .bind(ctx.site.id, ctx.range.from, ctx.range.to, f.actor, f.kind)
    .all<Note>();
  return results;
}

/** Days each side of a note covers: the `window` asked for, else the note's own, else 7 (a note from before 0066). */
export const windowOf = (n: Pick<Note, 'window_days'>, days?: number | null) => days ?? n.window_days ?? IMPACT_DEFAULT_DAYS;
/** When a note's verdict is due: its window, plus the days its data comes late (verdicts.ts WAIT_DAYS). */
export const reviewAfterOf = (n: Pick<Note, 'ts' | 'window_days' | 'metric'>, days?: number | null) => n.ts + (windowOf(n, days) + waitDays(n.metric)) * DAY;

/**
 * A note as the read API answers it: `kind` is the kind of change, `origin` says where the note came from. The
 * dashboard's routes keep `kind` for the origin (the iPhone app reads it) and name the change `change_kind`.
 * `review_after` is when the impact window closes; `review` is null until someone reviews the change. `metric` and
 * `window_days` say what the verdict judges over how many days (metric null: the visit rule of a note from before them).
 */
export function apiNote(n: Note, bucket?: string, days?: number | null) {
  return {
    id: n.id,
    ts: n.ts,
    time: new Date(n.ts).toISOString(),
    ...(bucket !== undefined ? { bucket } : {}),
    text: n.text,
    kind: n.change_kind,
    origin: n.kind,
    actor: n.actor,
    target: n.target,
    before: n.before_text,
    after: n.after_text,
    idempotency_key: n.idempotency_key,
    metric: n.metric ?? null,
    window_days: n.change_kind === 'outage' ? null : windowOf(n, days),
    group: n.group_key ?? null,
    ends_at: n.ends_at ? new Date(n.ends_at).toISOString() : null,
    created_at: n.created_at,
    review_after: new Date(reviewAfterOf(n, days)).toISOString(),
    review: n.reviewed_at
      ? { reviewed_at: new Date(n.reviewed_at).toISOString(), outcome: n.review_outcome, comment: n.review_comment }
      : null,
  };
}

/** A note as the dashboard's routes answer it: the columns, with `before` and `after` under their API names. */
const dashboardNote = ({ before_text, after_text, ...n }: Note, bucket?: string) => ({
  ...n,
  before: before_text,
  after: after_text,
  ...(bucket !== undefined ? { bucket } : {}),
});

/** GET /api/sites/:id/notes: the notes in the dashboard's range, each with the chart bucket it belongs to. */
export async function listNotes(c: Context<AppEnv>) {
  const ctx = makeCtx(c);
  const f = noteFilters(c.req.query());
  if ('error' in f) return c.json({ error: f.error }, 400);
  const notes = await queryNotes(ctx, f);
  return c.json(notes.map((n) => dashboardNote(n, bucketOf(n.ts, ctx.range.granularity, ctx.offset))));
}

/** Notes GET /api/v1/notes answers at most, and by default. MCP list_notes asks for NOTES_AGENT_LIMIT. */
export const NOTES_MAX_LIMIT = 500;
export const NOTES_AGENT_LIMIT = 100;

/**
 * A note in short form (?compact=true): what changed, by whom, on what, and `outcome`, the review outcome. The notes of one
 * group (a change copied to several pages) fold into the first, with the others' ids and targets.
 */
function compactNotes(rows: ReturnType<typeof apiNote>[]) {
  const out: Record<string, unknown>[] = [];
  const byGroup = new Map<string, Record<string, unknown> & { group_notes: string[]; group_targets: (string | null)[] }>();
  for (const n of rows) {
    if (n.group) {
      const head = byGroup.get(n.group);
      if (head) {
        head.group_notes.push(n.id);
        head.group_targets.push(n.target);
        continue;
      }
    }
    const row: Record<string, unknown> = { id: n.id, time: n.time, text: n.text, kind: n.kind, actor: n.actor, target: n.target, metric: n.metric, group: n.group, outcome: n.review?.outcome ?? null };
    if (n.group) {
      const head = Object.assign(row, { group_notes: [] as string[], group_targets: [] as (string | null)[] });
      byGroup.set(n.group, head);
    }
    out.push(row);
  }
  return out;
}

/**
 * GET /api/v1/notes with a read key: the same notes, in the read API's shape (apiNote), oldest first. ?limit keeps the
 * newest that many (500 at most and by default); X-Truncated says when older ones were left out. ?compact=true answers
 * the short form, one row per group.
 */
export async function listNotesApi(c: Context<AppEnv>) {
  const ctx = makeCtx(c);
  const q = c.req.query();
  const f = noteFilters(q);
  if ('error' in f) return c.json({ error: f.error }, 400);
  const limit = q.limit === undefined || q.limit === '' ? NOTES_MAX_LIMIT : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > NOTES_MAX_LIMIT) return c.json({ error: `limit is a whole number from 1 to ${NOTES_MAX_LIMIT}` }, 400);
  if (q.compact !== undefined && q.compact !== 'true' && q.compact !== 'false') return c.json({ error: 'compact is true or false' }, 400);
  const { results } = await ctx.db
    .prepare(
      `SELECT * FROM notes WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 AND (?4 IS NULL OR actor = ?4) AND (?5 IS NULL OR change_kind = ?5)
       ORDER BY ts DESC LIMIT ?6`,
    )
    .bind(ctx.site.id, ctx.range.from, ctx.range.to, f.actor, f.kind, limit + 1)
    .all<Note>();
  const truncated = results.length > limit;
  const notes = results.slice(0, limit).reverse();
  const rows = notes.map((n) => apiNote(n, bucketOf(n.ts, ctx.range.granularity, ctx.offset)));
  return Response.json(q.compact === 'true' ? compactNotes(rows) : rows, { headers: truncated ? { 'x-truncated': '1' } : {} });
}

/**
 * What an app site has stored for its own verdicts (note-metrics.ts metricsFor): Apple's download rows and trials. Only
 * with Pro, whose judges read them, and only for an app: one read, the two EXISTS on their site indexes.
 */
export async function appDataOf(db: D1Database, site: Site): Promise<AppData | null> {
  if (!proHooks()?.judgeMetric || !isApp(site)) return null;
  const r = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM asc_sales WHERE site_id = ?1 AND kind = 'download') AS downloads,
         EXISTS (SELECT 1 FROM subscriptions WHERE site_id = ?1 AND sandbox = 0 AND trial_start IS NOT NULL) AS trials`,
    )
    .bind(site.id)
    .first<{ downloads: number; trials: number }>()
    .catch(() => null);
  return r ? { downloads: !!r.downloads, trials: !!r.trials } : null;
}

/** POST /api/sites/:id/notes { text, ts?, kind?, actor?, target?, before?, after? } from the dashboard. */
export async function createNote(c: Context<AppEnv>) {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const now = Date.now();
  const n = readNote(b, now, c.get('site'), await appDataOf(c.env.DB, c.get('site')));
  if ('error' in n) return c.json({ error: n.error }, 400);
  const { note } = await insertNote(c.env.DB, c.get('site'), n.text, n.ts, 'manual', now, n.annotation);
  return c.json(dashboardNote(note));
}

/** DELETE /api/sites/:id/notes/:nid */
export async function deleteNote(c: Context<AppEnv>) {
  await c.env.DB.prepare('DELETE FROM notes WHERE id = ? AND site_id = ?').bind(c.req.param('nid'), c.get('site').id).run();
  return c.json({ ok: true });
}

/**
 * POST /api/v1/notes  Authorization: Bearer <site API key, or a key with notes:write>
 * { "text": "Raised Pro to $24", "timestamp": "2026-11-02T09:30:00Z", "kind": "pricing", "actor": "pricing-agent",
 *   "target": "/pricing", "before": "$19", "after": "$24", "idempotency_key": "pricing-2026-11-02" }
 * Only text is required. A known idempotency key returns the note stored first, with "created": false.
 */
export async function handleNoteApi(c: Context<AppEnv>) {
  const auth = await writeSiteOf(c, 'notes:write');
  if ('error' in auth) return c.json({ error: auth.error }, auth.status);
  const site = auth.site;
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const now = Date.now();
  const n = readNote(b, now, site, await appDataOf(c.env.DB, site));
  if ('error' in n) return c.json({ error: n.error }, 400);
  const { note, created } = await insertNote(c.env.DB, site, n.text, n.ts, 'api', now, n.annotation);
  return c.json({ ok: true, id: note.id, ts: note.ts, created, note: apiNote(note) });
}

// ---------- impact: the days before a note against the days after

/** Days each side of a note covers: 7 by default, 1 to 28. */
export const IMPACT_DEFAULT_DAYS = 7;
export const IMPACT_MAX_DAYS = 28;
/**
 * The minimum-data rule (docs/API.md, "The verdict"): each side needs IMPACT_MIN_VISITORS visitors, and both sides
 * together IMPACT_MIN_CUSTOMERS new customers. Below that `enough_data` is false and the verdict is inconclusive.
 */
export const IMPACT_MIN_VISITORS = 100;
export const IMPACT_MIN_CUSTOMERS = 10;
/** The smallest change of the verdict's metric, relative to before, that counts as better or worse. */
export const IMPACT_MIN_LIFT = 0.1;

export type Verdict = 'better' | 'worse' | 'inconclusive';
export type VerdictMetric = MetricName;

/** `?window=` as whole days, null when not given (each note's own window), or an error text. */
export function parseImpactWindow(raw: string | undefined): number | null | { error: string } {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > IMPACT_MAX_DAYS) return { error: `window is a whole number of days from 1 to ${IMPACT_MAX_DAYS}` };
  return n;
}

/**
 * The page a note target names: a path such as `/pricing`, without its query or fragment. Null for an empty target
 * or anything else (`keyword:habit tracker`, a product id), which the impact reads for the whole site.
 */
export function targetPath(target: string | null | undefined): string | null {
  const t = target?.trim();
  if (!t || !t.startsWith('/') || t.startsWith('//')) return null;
  return t.replace(/[?#].*$/, '') || '/';
}

const ratio = (a: number, b: number) => (b ? a / b : 0);
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
/** The change from `before` to `after`: the difference, and the difference over `before` (null when it was 0). */
const delta = (after: number, before: number, digits = (x: number) => x) => ({
  absolute: digits(after - before),
  relative: before ? round4((after - before) / before) : null,
});

const count = (n: number) => n.toLocaleString('en-US');
const percent = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
/** An amount in minor units, fractions allowed, as the currency writes it: 42.3 USD cents is $0.42. */
function money(minor: number, currency: string): string {
  const d = currencyDecimals(currency);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(minor / 10 ** d);
  } catch {
    return `${(minor / 10 ** d).toFixed(d)} ${currency}`;
  }
}

interface SideCounts {
  visitors: number;
  customers: number;
  revenue: number;
}

/**
 * The verdict of a change, the rule docs/API.md ("The verdict") states:
 * 1. The window has not closed (`complete` false): inconclusive.
 * 2. A side has fewer than IMPACT_MIN_VISITORS visitors, or (with revenue) both sides together have fewer than
 *    IMPACT_MIN_CUSTOMERS new customers: inconclusive.
 * 3. The metric is revenue per visitor when either side has revenue, else the conversion rate. A key without revenue
 *    (`currency` null) judges visitors.
 * 4. Up by IMPACT_MIN_LIFT or more over the value before is better, down by as much is worse, less is inconclusive.
 *    From 0 to more is better.
 * 5. A count must also clear the noise rule (beyondNoise): visitors, and the new customers behind a conversion rate
 *    (rateBeyondNoise). Revenue per visitor has no count rule: a price change moves it with the same customers.
 */
export function judge(
  b: SideCounts,
  a: SideCounts,
  o: { complete: boolean; reviewAfter: string; currency: string | null },
): { verdict: Verdict; verdict_metric: VerdictMetric | null; reason: string } {
  const none = (reason: string) => ({ verdict: 'inconclusive' as const, verdict_metric: null, reason });
  if (!o.complete) return none(`The window closes at ${o.reviewAfter.slice(0, 16).replace('T', ' ')} UTC, so there is no verdict yet.`);
  if (b.visitors < IMPACT_MIN_VISITORS || a.visitors < IMPACT_MIN_VISITORS) {
    return none(`${count(b.visitors)} visitors before and ${count(a.visitors)} after, but each side needs ${IMPACT_MIN_VISITORS} for a verdict.`);
  }
  let metric: 'revenue_per_visitor' | 'conversion_rate' | 'visitors' = 'visitors';
  let before = b.visitors;
  let after = a.visitors;
  let show = count;
  if (o.currency !== null) {
    const currency = o.currency;
    if (b.customers + a.customers < IMPACT_MIN_CUSTOMERS) {
      return none(
        `${count(b.customers)} new customers before and ${count(a.customers)} after, but both sides together need ${IMPACT_MIN_CUSTOMERS} for a verdict.`,
      );
    }
    if (b.revenue || a.revenue) {
      metric = 'revenue_per_visitor';
      [before, after] = [ratio(b.revenue, b.visitors), ratio(a.revenue, a.visitors)];
      show = (x) => money(x, currency);
    } else {
      metric = 'conversion_rate';
      [before, after] = [ratio(b.customers, b.visitors), ratio(a.customers, a.visitors)];
      show = (x) => `${(x * 100).toFixed(1)}%`;
    }
  }
  const label = { revenue_per_visitor: 'Revenue per visitor', conversion_rate: 'Conversion', visitors: 'Visitors' }[metric];
  const rel = before ? round4((after - before) / before) : after > 0 ? Infinity : 0;
  const span = `from ${show(before)} to ${show(after)}`;
  const on = metric === 'visitors' ? '' : `, on ${count(b.visitors)} visitors before and ${count(a.visitors)} after`;
  const noise =
    metric === 'visitors' ? !beyondNoise(a.visitors, b.visitors) : metric === 'conversion_rate' ? !rateBeyondNoise(a.customers, a.visitors, b.customers, b.visitors) : false;
  if (rel >= IMPACT_MIN_LIFT || rel <= -IMPACT_MIN_LIFT) {
    const moved = rel > 0 ? `rose ${Number.isFinite(rel) ? `${percent(rel)}, ` : ''}` : `fell ${percent(rel)}, `;
    if (noise) return { verdict: 'inconclusive', verdict_metric: metric, reason: `${label} ${moved}${span}${on}. ${NOISE_TEXT}` };
    return { verdict: rel > 0 ? 'better' : 'worse', verdict_metric: metric, reason: `${label} ${moved}${span}${on}.` };
  }
  return {
    verdict: 'inconclusive',
    verdict_metric: metric,
    reason: `${label} moved ${percent(rel)}, ${span}, less than the ${percent(IMPACT_MIN_LIFT)} a verdict needs.`,
  };
}

// ---------- ASO notes: judged by the keyword's App Store rank (docs/API.md, "The verdict")

/**
 * A country's rank moves enough for a verdict when it changes by ASO_MIN_PLACES places and by ASO_MIN_SHARE of the
 * rank before, whichever is more: 34 to 30 counts, 150 to 146 does not (it needs 15).
 */
export const ASO_MIN_PLACES = RANK_MIN_PLACES;
export const ASO_MIN_SHARE = RANK_MIN_SHARE;
/** Days before a note the rank before may come from. */
export const ASO_LOOKBACK_DAYS = 14;

/**
 * The keyword an ASO note aims at: kind `aso` and target `keyword:<term>`, or `keyword:<term>@<country>` for one
 * country (ISO code, such as de). Null for any other note.
 */
export function keywordTarget(n: Pick<Note, 'change_kind' | 'target'>): { term: string; country: string | null } | null {
  if (n.change_kind !== 'aso') return null;
  const t = parseTarget(n.target);
  return t.type === 'keyword' ? { term: t.term, country: t.country } : null;
}

/** One side of a keyword's rank: the snapshot day, the rank (null: not in the results) and how many results there were. */
interface RankSide {
  day: string;
  rank: number | null;
  results: number;
}

/** A keyword in one country: its rank before and after the note, the places it rose (fell: negative) and the verdict. */
export interface KeywordMove {
  country: string;
  before: RankSide | null;
  after: RankSide | null;
  moved: number | null;
  verdict: Verdict | null;
}

/** A rank to compare: not in the results counts as one place below the last result. */
const placeOf = (s: RankSide) => s.rank ?? s.results + 1;

/**
 * The keyword's rank per country: the last snapshot in the ASO_LOOKBACK_DAYS days before the note, and the last one
 * from the note to `to`. One query; D1 pulls the keyword out of each snapshot (json_extract), so the Worker parses
 * nothing. A country without the keyword on either side gets null there.
 */
async function keywordMoves(db: D1Database, siteId: string, kw: { term: string; country: string | null }, at: number, to: number): Promise<KeywordMove[]> {
  const path = `$."${kw.term}"`;
  const { results } = await db
    .prepare(
      `SELECT country, day, collected_at, json_extract(ranks, ?2) AS rank, json_extract(ranks, ?3) AS results
       FROM aso_snapshots
       WHERE site_id = ?1 AND collected_at >= ?4 AND collected_at <= ?5 AND (?6 IS NULL OR country = ?6) AND json_type(ranks, ?7) = 'array'
       ORDER BY country, collected_at`,
    )
    .bind(siteId, `${path}[0]`, `${path}[1]`, at - ASO_LOOKBACK_DAYS * DAY, to, kw.country, path)
    .all<{ country: string; day: string; collected_at: number; rank: number | null; results: number | null }>();
  const by = new Map<string, { before: RankSide | null; after: RankSide | null }>();
  for (const r of results) {
    const side: RankSide = { day: r.day, rank: typeof r.rank === 'number' ? r.rank : null, results: Number(r.results) || 0 };
    const e = by.get(r.country) ?? { before: null, after: null };
    if (r.collected_at < at) e.before = side;
    else e.after = side;
    by.set(r.country, e);
  }
  return [...by].map(([country, { before, after }]) => {
    if (!before || !after) return { country, before, after, moved: null, verdict: null };
    const moved = placeOf(before) - placeOf(after);
    const need = Math.max(ASO_MIN_PLACES, Math.ceil(ASO_MIN_SHARE * placeOf(before)));
    const verdict: Verdict = before.rank === null && after.rank === null ? 'inconclusive' : moved >= need ? 'better' : moved <= -need ? 'worse' : 'inconclusive';
    return { country, before, after, moved, verdict };
  });
}

const rankText = (s: RankSide | null) => (!s ? 'no snapshot' : s.rank === null ? 'not ranked' : `#${s.rank}`);

/**
 * The verdict of an ASO note (docs/API.md, "The verdict"):
 * 1. The window has not closed: inconclusive.
 * 2. No country has a snapshot with the keyword both before and after: inconclusive.
 * 3. Each country is better or worse when its rank moved ASO_MIN_PLACES places and ASO_MIN_SHARE of the rank before.
 * 4. Better when at least one country is better and none is worse; worse the other way round; else inconclusive.
 */
export function judgeKeyword(
  kw: { term: string; country: string | null },
  moves: KeywordMove[],
  o: { complete: boolean; reviewAfter: string },
): { verdict: Verdict; verdict_metric: VerdictMetric | null; reason: string } {
  const none = (reason: string) => ({ verdict: 'inconclusive' as const, verdict_metric: null, reason });
  if (!o.complete) return none(`The window closes at ${o.reviewAfter.slice(0, 16).replace('T', ' ')} UTC, so there is no verdict yet.`);
  const both = moves.filter((m) => m.moved !== null);
  const where = kw.country ? ` in ${kw.country.toUpperCase()}` : '';
  if (!both.length) return none(`No ASO snapshot has "${kw.term}"${where} both before and after the note.`);
  const list = both.map((m) => `${m.country.toUpperCase()} ${rankText(m.before)} → ${rankText(m.after)}`).join(', ');
  const up = both.filter((m) => m.verdict === 'better').length;
  const down = both.filter((m) => m.verdict === 'worse').length;
  const of = both.length > 1 ? ` in ${up || down} of ${both.length} countries` : '';
  const metric = 'keyword_rank' as const;
  if (up && !down) return { verdict: 'better', verdict_metric: metric, reason: `The rank of "${kw.term}" rose${of}: ${list}.` };
  if (down && !up) return { verdict: 'worse', verdict_metric: metric, reason: `The rank of "${kw.term}" fell${of}: ${list}.` };
  if (up && down) return { verdict: 'inconclusive', verdict_metric: metric, reason: `The rank of "${kw.term}" rose in ${up} and fell in ${down} countries: ${list}.` };
  return {
    verdict: 'inconclusive',
    verdict_metric: metric,
    reason: `The rank of "${kw.term}" moved less than ${ASO_MIN_PLACES} places or ${Math.round(ASO_MIN_SHARE * 100)}% of its rank: ${list}.`,
  };
}

/** The impact of a note by id, or null when the site has no such note. See impactOf. */
export async function noteImpact(db: D1Database, site: Site, noteId: string, days: number | null = null, now = Date.now(), metric: NoteMetric | null = null) {
  const note = await db.prepare('SELECT * FROM notes WHERE id = ? AND site_id = ?').bind(noteId, site.id).first<Note>();
  if (!note) return null;
  if (metric) {
    const allowed = metricsFor(note.change_kind, note.target, site);
    if (!allowed.includes(metric)) return { error: allowed.length ? `For this note, metric is one of ${allowed.join(', ')}` : 'An outage has no verdict, so it takes no metric' };
  }
  return impactOf(db, site, note, days, now, { metric });
}

/** An outage note as the overview and the impact list it: the gap from `from` to `to`. */
export interface Outage {
  id: string;
  from: string;
  to: string;
  text: string;
  target: string | null;
}

/**
 * Outage notes of a site whose gap overlaps ?2 to ?3, oldest first, 20 at most, leaving out the note ?4. Binds ?1 the
 * site, ?2 the start less OUTAGE_MAX_DAYS, ?3 the end and ?4 an id. Reads the notes_site_time index.
 */
const OUTAGES_SQL = `SELECT * FROM notes WHERE site_id = ?1 AND ts >= ?2 - ${OUTAGE_MAX_DAYS * DAY} AND ts < ?3 AND change_kind = 'outage' AND ends_at > ?2 AND id != ?4 ORDER BY ts LIMIT 20`;
type OutageRow = { id: string; ts: number; ends_at: number | null; text: string; target: string | null };
const outageOf = (r: OutageRow): Outage & { start: number; end: number } => ({
  id: r.id,
  from: new Date(r.ts).toISOString(),
  to: new Date(r.ends_at ?? r.ts).toISOString(),
  text: r.text,
  target: r.target,
  start: r.ts,
  end: r.ends_at ?? r.ts,
});

/** Outage notes of a site whose gap overlaps `from` to `to`, oldest first, 20 at most. */
export async function outagesBetween(db: D1Database, siteId: string, from: number, to: number, except: string | null = null): Promise<(Outage & { start: number; end: number })[]> {
  const { results } = await db.prepare(OUTAGES_SQL).bind(siteId, from, to, except ?? '').all<OutageRow>();
  return results.map(outageOf);
}

/**
 * The outage notes that overlap an overview's range or the range it compares with, each with `in`: current, previous
 * or both. The overview answers them as `outages`, so a reader knows which side of a comparison has a gap.
 */
export async function overviewOutages(db: D1Database, site: Pick<Site, 'id' | 'timezone'>, range: { from: number; to: number }, period?: string) {
  const prev = previousRange({ ...range, granularity: 'day' }, period, site.timezone);
  const list = await outagesBetween(db, site.id, Math.min(prev.from, range.from), range.to);
  const hits = (o: { start: number; end: number }, w: { from: number; to: number }) => o.start < w.to && o.end > w.from;
  return list.map(({ start, end, ...o }) => {
    const cur = hits({ start, end }, range);
    const before = hits({ start, end }, prev);
    return { ...o, in: (cur && before ? 'both' : cur ? 'current' : 'previous') as 'current' | 'previous' | 'both' };
  });
}

/** The share of `w` that outages cover, 0 to 1. Overlapping outages count once per moment at most (capped at 1). */
const gapShare = (w: { from: number; to: number }, outages: { start: number; end: number }[]) => {
  const len = w.to - w.from;
  if (len <= 0) return 0;
  const covered = outages.reduce((n, o) => n + Math.max(0, Math.min(o.end, w.to) - Math.max(o.start, w.from)), 0);
  return Math.min(1, covered / len);
};

/**
 * The impact of one note: visitors, new customers, conversion rate, revenue and revenue per visitor in the `days`
 * days after the note (from its time) against the same length right before it, and the verdict. When fewer than
 * `days` days have passed, both sides cover the days that have, so the totals stay comparable, and `complete` is
 * false. `days` null is the note's own window (window_days, 7 for a note from before migration 0066).
 *
 * The verdict judges the note's metric (`opts.metric` overrides it, so an older note can be read by its kind's
 * metric too):
 * - none (a note from before 0066) and visits: the visit rule (judge); an older ASO note with a keyword
 *   target keeps the App Store rank (judgeKeyword).
 * - keyword_rank: the App Store rank.
 * - anything else: pro/worker/verdicts.ts, with its own block (`search`, `keyword`, `ai`, `ads` or `paywall`) and its
 *   entries in `change`. The visit numbers stay as context.
 *
 * Scope: when the note's target is a page path (targetPath), the visit numbers count only the visits that entered on
 * that page and the payments credited to them (`scope` "page"). `overlapping` lists the other notes in the before
 * and after windows, whose changes are in the numbers too; for a page, the notes aimed at another page are left out. `outages`
 * lists the outage notes that overlap either side; one that covers OUTAGE_MAX_SHARE of a side makes a verdict on
 * FounderData's own numbers inconclusive (`data_gap`).
 *
 * Reads: one overview (src/worker/stats.ts, the site's own revenue rules), the notes, and the metric's own queries.
 */
/**
 * The judge of a metric other than the visit rule and the App Store rank (Search Console, Google rank, AI answers, ads,
 * paywall) is Pro's (`judgeMetric` hook). Without it such a note stays inconclusive, with its window and no numbers.
 */
async function judgeSpecial(i: JudgeInput): Promise<Judgement> {
  // Loaded on use: Pro's modules read this file's exports when they load, so it must not import edition.ts itself.
  const pro = proHooks();
  if (pro?.judgeMetric) return pro.judgeMetric(i);
  return {
    scope: 'site',
    verdict: 'inconclusive',
    verdict_metric: i.metric as VerdictMetric,
    reason: `Judging ${i.metric.replace(/_/g, ' ')} needs FounderData Pro.`,
    days_covered: null,
    complete: null,
    enough_data: false,
    thresholds: {},
    change: {},
    detail: {},
    own_data: true,
    money: false,
  };
}

export async function impactOf(
  db: D1Database,
  site: Site,
  note: Note,
  days: number | null = null,
  now = Date.now(),
  opts: { prefetch?: AscPrefetch | null; metric?: NoteMetric | null } = {},
) {
  const metric: NoteMetric | null = note.change_kind === 'outage' ? null : (opts.metric ?? note.metric ?? null);
  // An older note read by another metric takes that metric's window, unless a window was asked for.
  const win = days ?? note.window_days ?? (opts.metric ? windowFor(opts.metric) : IMPACT_DEFAULT_DAYS);
  const path = targetPath(note.target);
  const span = Math.max(0, Math.min(win * DAY, now - note.ts));
  const after = { from: note.ts, to: note.ts + span };
  const before = { from: note.ts - span, to: note.ts };
  const ctx: Ctx = {
    db,
    site,
    range: { ...after, granularity: 'day' },
    filters: path ? { entry_page: path } : {},
    offset: tzOffset(site.timezone, after.to),
    period: 'custom',
    // Imported days carry visitors but no customers or revenue, which would pull the conversion rate down.
    skipImported: true,
    ascPrefetch: opts.prefetch ?? null,
  };
  const reviewAfter = new Date(reviewAfterOf({ ...note, metric }, win)).toISOString();
  const msComplete = span >= win * DAY;
  // The App Store keyword: an older ASO note, or a note whose metric is keyword_rank.
  const t = parseTarget(note.target);
  const kw = metric === null ? keywordTarget(note) : metric === 'keyword_rank' && t.type === 'keyword' ? { term: t.term, country: t.country } : null;
  const special = metric && metric !== 'visits' && metric !== 'keyword_rank' ? metric : null;
  // One read for the notes in both windows (`overlapping`) and the outages on either side. The outages take a day
  // of margin on each side: a judge that reads whole days (ads) reaches past the note's time by up to a day.
  const [o, near, keyword, j] = await Promise.all([
    span ? overview(ctx) : null,
    db
      .prepare(
        `SELECT 'n' AS part, * FROM (SELECT * FROM notes WHERE site_id = ?1 AND ts >= ?5 AND ts < ?6 AND id != ?4 ORDER BY ts LIMIT 50)
         UNION ALL SELECT 'o' AS part, * FROM (${OUTAGES_SQL})`,
      )
      .bind(site.id, note.ts - (win + 1) * DAY, note.ts + (win + 1) * DAY, note.id, note.ts - win * DAY, note.ts + win * DAY)
      .all<Note & { part: 'n' | 'o' }>(),
    kw ? keywordMoves(db, site.id, kw, note.ts, note.ts + span) : null,
    special ? judgeSpecial({ db, site, note, metric: special, win, now, reviewAfter, before, after, complete: msComplete }) : (null as Judgement | null),
  ]);
  const strip = ({ part: _p, ...n }: Note & { part: string }) => n as Note;
  const overlap = near.results.filter((n) => n.part === 'n').map(strip);
  const outages = near.results.filter((n) => n.part === 'o').map(outageOf);
  const side = (w: { from: number; to: number }, k: { visitors: number; customers: number; revenue: number } | undefined) => {
    const visitors = k?.visitors ?? 0;
    const customers = k?.customers ?? 0;
    const revenue = k?.revenue ?? 0;
    return {
      from: new Date(w.from).toISOString(),
      to: new Date(w.to).toISOString(),
      visitors,
      customers,
      conversion_rate: round4(ratio(customers, visitors)),
      revenue,
      revenue_per_visitor: Math.round(ratio(revenue, visitors)),
    };
  };
  const b = side(before, o?.previous);
  const a = side(after, o?.current);
  const complete = j?.complete ?? msComplete;
  const daysCovered = j?.days_covered ?? round4(span / DAY);
  let v: { verdict: Verdict; verdict_metric: VerdictMetric | null; reason: string } = j ?? judge(b, a, { complete, reviewAfter, currency: site.currency });
  // An App Store keyword change is judged by the keyword's rank, not by the site's revenue per visitor.
  if (kw && keyword) v = judgeKeyword(kw, keyword, { complete, reviewAfter });
  if (!complete && !j) v = { ...v, reason: measuring(daysCovered, win, reviewAfter) };
  const ranked = keyword?.filter((k) => k.moved !== null) ?? [];
  // A gap in FounderData's own numbers (an outage note) leaves no fair comparison.
  const ownData = j ? j.own_data : !kw;
  // The windows the numbers come from: the judge's whole days when it read those, else the note's own.
  const gapWin = j?.windows ?? { before, after };
  const gapped = outages.filter((x) => gapShare(gapWin.before, [x]) > 0 || gapShare(gapWin.after, [x]) > 0);
  const share = Math.max(gapShare(gapWin.before, gapped), gapShare(gapWin.after, gapped));
  const dataGap = note.change_kind !== 'outage' && ownData && complete && share >= OUTAGE_MAX_SHARE;
  if (note.change_kind === 'outage') v = { verdict: 'inconclusive', verdict_metric: null, reason: 'An outage marks a gap in the data. It has no verdict.' };
  else if (dataGap) {
    const first = gapped[0];
    v = { verdict: 'inconclusive', verdict_metric: v.verdict_metric, reason: `An outage covers ${percent(share)} of the window, so the numbers have a gap. "${first.text}" ran from ${first.from.slice(0, 16).replace('T', ' ')} to ${first.to.slice(0, 16).replace('T', ' ')} UTC.` };
  }
  const visitScope = kw ? 'keyword' : path ? 'page' : 'site';
  return {
    site_id: site.id,
    timezone: site.timezone,
    currency: site.currency,
    currency_decimals: currencyDecimals(site.currency),
    note: apiNote(note, undefined, win),
    // What the verdict judges: the note's metric (or the one asked for), null for the visit rule of an older note.
    metric,
    scope: (j?.scope ?? visitScope) as 'page' | 'site' | 'keyword' | 'prompt' | 'ads' | 'app',
    page: path,
    // Only for an App Store keyword: the term, the country the target names (null: every tracked country) and each country's rank.
    ...(kw ? { keyword: { term: kw.term, country: kw.country, countries: keyword ?? [] } } : {}),
    ...(j?.detail ?? {}),
    window_days: win,
    days_covered: daysCovered,
    complete,
    review_after: reviewAfter,
    verdict: v.verdict,
    verdict_metric: v.verdict_metric,
    reason: v.reason,
    before: b,
    after: a,
    change: {
      visitors: delta(a.visitors, b.visitors),
      customers: delta(a.customers, b.customers),
      conversion_rate: delta(ratio(a.customers, a.visitors), ratio(b.customers, b.visitors), round4),
      revenue: delta(a.revenue, b.revenue),
      revenue_per_visitor: delta(ratio(a.revenue, a.visitors), ratio(b.revenue, b.visitors), Math.round),
      // Places the keyword rose, the mean over the countries with a rank on both sides (fell: negative).
      // Left out when no country has both sides, so every change entry keeps a number in `absolute`.
      ...(ranked.length ? { keyword_rank: { absolute: Math.round((ranked.reduce((n, k) => n + k.moved!, 0) / ranked.length) * 10) / 10, relative: null } } : {}),
      ...(j?.change ?? {}),
    } as Record<string, { absolute: number; relative: number | null }>,
    enough_data: j
      ? j.enough_data
      : kw
        ? ranked.length > 0
        : b.visitors >= IMPACT_MIN_VISITORS && a.visitors >= IMPACT_MIN_VISITORS && b.customers + a.customers >= IMPACT_MIN_CUSTOMERS,
    thresholds: (j
      ? j.thresholds
      : {
          min_visitors: IMPACT_MIN_VISITORS,
          min_customers: IMPACT_MIN_CUSTOMERS,
          min_lift: IMPACT_MIN_LIFT,
          ...(kw ? { min_places: ASO_MIN_PLACES, min_rank_share: ASO_MIN_SHARE } : {}),
        }) as Record<string, number>,
    outages: gapped.map(({ start: _s, end: _e, ...x }) => x),
    data_gap: dataGap,
    overlapping: overlap
      .filter((n) => !path || targetPath(n.target) === null || targetPath(n.target) === path)
      .map((n) => apiNote(n)),
  };
}

export type NoteImpact = Awaited<ReturnType<typeof impactOf>>;

/**
 * D1 calls one impactOf makes at most, each statement and batch counted once: the overview, the notes around it
 * (overlapping notes and outages), a margin of one, and the metric's own reads (verdicts.ts JUDGE_CALLS; 1 for the App Store rank). The
 * cron asks its subrequest budget for this before it judges a note; a weekly summary caps its verdicts with it.
 */
export const IMPACT_BASE_CALLS = 3;
export function impactCalls(note: Pick<Note, 'metric' | 'change_kind'>, metric: NoteMetric | null = null): number {
  const m = note.change_kind === 'outage' ? null : (metric ?? note.metric);
  return IMPACT_BASE_CALLS + (m && m in JUDGE_CALLS ? JUDGE_CALLS[m as keyof typeof JUDGE_CALLS] : 1);
}

/** change entries that hold money or customers, left out for a key without revenue. */
const MONEY_CHANGE = new Set(['customers', 'conversion_rate', 'revenue', 'revenue_per_visitor', 'ad_spend', 'ad_customers', 'cpa', 'roas']);

/**
 * The impact for a key or link without revenue: visitors only. `enough_data` then looks at visitors alone, and the
 * visit rule judges visitors, so neither says anything about customers. Verdicts on another metric (Search Console,
 * ranks, AI answers, the paywall) stay; a verdict on CPA or ROAS turns inconclusive and its `ads` block is left out.
 */
export function impactWithoutRevenue(i: NoteImpact) {
  const side = ({ from, to, visitors }: NoteImpact['after']) => ({ from, to, visitors });
  const counts = (s: NoteImpact['after']) => ({ visitors: s.visitors, customers: 0, revenue: 0 });
  const visitRule = i.scope !== 'keyword' && (i.metric === null || i.metric === 'visits');
  const keep = !visitRule || i.data_gap || i.note.kind === 'outage';
  // A verdict on money (CPA, ROAS): a key without revenue gets none.
  const money = i.metric === 'cpa' || i.metric === 'roas';
  const { ads: _ads, ...rest } = i as NoteImpact & { ads?: unknown };
  const verdict = money
    ? { verdict: 'inconclusive' as const, verdict_metric: i.verdict_metric, reason: 'This key cannot read money, so it gets no CPA or ROAS verdict.' }
    : keep
      ? { verdict: i.verdict, verdict_metric: i.verdict_metric, reason: i.reason }
      : judge(counts(i.before), counts(i.after), { complete: i.complete, reviewAfter: i.review_after, currency: null });
  if (!keep && !money && !i.complete) verdict.reason = i.reason;
  return {
    ...rest,
    ...verdict,
    before: side(i.before),
    after: side(i.after),
    change: Object.fromEntries(Object.entries(i.change).filter(([k]) => !MONEY_CHANGE.has(k))),
    enough_data: visitRule ? i.before.visitors >= IMPACT_MIN_VISITORS && i.after.visitors >= IMPACT_MIN_VISITORS : money ? false : i.enough_data,
    thresholds: visitRule
      ? { min_visitors: IMPACT_MIN_VISITORS, min_lift: IMPACT_MIN_LIFT }
      : Object.fromEntries(Object.entries(i.thresholds).filter(([k]) => k !== 'min_customers' && k !== 'min_spend')),
  };
}

/**
 * The verdict metric's value before and after, for an alert payload: from the metric's own block (search, keyword,
 * ai, ads, paywall) or from the visit numbers. 0 when the side has none.
 */
export function metricValues(i: Pick<NoteImpact, 'verdict_metric' | 'before' | 'after'> & Record<string, unknown>): { before: number; after: number } {
  const m = i.verdict_metric;
  const from = (block: string, field: string) => {
    const b = i[block] as { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null } | undefined;
    return { before: Number(b?.before?.[field] ?? 0) || 0, after: Number(b?.after?.[field] ?? 0) || 0 };
  };
  switch (m) {
    case 'search_clicks':
      return from('search', 'clicks');
    case 'search_position':
      return from('search', 'position');
    case 'google_rank':
      return from('keyword', 'position');
    case 'ai_mention_rate':
      return from('ai', 'mention_rate');
    case 'ai_citation_rate':
      return from('ai', 'citation_rate');
    case 'cpa':
    case 'roas':
      return from('ads', m);
    case 'paywall_conversion':
    case 'trial_rate':
      return from('paywall', m);
    case 'app_downloads':
      return from('downloads', 'downloads');
    case 'trial_to_paid':
      return from('trials', 'trial_to_paid');
    case null:
    case 'keyword_rank':
      return { before: 0, after: 0 };
    default: {
      const v = (s: NoteImpact['after']) => Number((s as unknown as Record<string, number>)[m] ?? 0);
      return { before: v(i.before), after: v(i.after) };
    }
  }
}

/** `?metric=`: one of NOTE_METRICS, or null when not given. */
export function parseMetric(raw: string | undefined): NoteMetric | null | { error: string } {
  if (raw === undefined || raw === '') return null;
  return (NOTE_METRICS as readonly string[]).includes(raw) ? (raw as NoteMetric) : { error: `metric is one of ${NOTE_METRICS.join(', ')}` };
}

/** GET /api/sites/:id/notes/:nid/impact?window=&metric=: the verdict for the dashboard. */
export async function noteImpactRoute(c: Context<AppEnv>) {
  const days = parseImpactWindow(c.req.query('window'));
  if (days !== null && typeof days !== 'number') return c.json({ error: days.error }, 400);
  const metric = parseMetric(c.req.query('metric'));
  if (metric !== null && typeof metric !== 'string') return c.json({ error: metric.error }, 400);
  const out = await noteImpact(c.env.DB, c.get('site'), c.req.param('nid') ?? '', days, Date.now(), metric);
  if (out && 'error' in out) return c.json({ error: out.error }, 400);
  return out ? c.json(out) : c.json({ error: 'This site has no such note' }, 404);
}

/** A note with its impact inline, as the due list and the page detail answer it. */
function noteWithImpact(i: NoteImpact, showRevenue: boolean) {
  // The note is the row itself, and the site fields are the answer's own.
  const { note, site_id: _s, timezone: _t, ...impact } = showRevenue ? i : impactWithoutRevenue(i);
  if (!showRevenue) {
    delete (impact as Partial<typeof impact>).currency;
    delete (impact as Partial<typeof impact>).currency_decimals;
  }
  return { ...note, impact };
}

// ---------- reviews: GET /api/v1/notes?due=true and POST /api/v1/notes/:id/review

/** A note older than this never shows as due: the list is for changes still worth a decision. */
export const DUE_LOOKBACK_DAYS = 90;
export const DUE_DEFAULT_LIMIT = 10;
export const DUE_MAX_LIMIT = 20;
/** Without ?site=, a key for more than one site lists due notes of every site, without impacts: up to this many. */
export const DUE_ALL_MAX_LIMIT = 100;
export const REVIEW_COMMENT_MAX = 280;

/** Notes of one group the due list and the stats look across: the same key within this many ms counts once. */
export const GROUP_SPAN_MS = 30 * DAY;

/**
 * Notes whose impact window has closed and that nobody reviewed, oldest first, from the last DUE_LOOKBACK_DAYS days.
 * The window is `days` when given, else each note's own (window_days, 7 for a note from before migration 0066), plus
 * the days its data comes late (verdicts.ts WAIT_DAYS). Outage notes need no review. A group (several notes with one
 * `group` key, such as locale copies) shows once, as its first note, and leaves once any of its notes is reviewed.
 * One query on the notes_site_time index; the rest is checked on those rows. `f.since` keeps only the notes created at or
 * after that time, plus the ones `f.ids` names (FounderData Pro's plan: the notes its tasks link, and the newer ones);
 * with `f.invert` it keeps the other notes instead.
 */
export async function dueNotes(
  db: D1Database,
  siteId: string,
  f: { actor: string | null; kind: ChangeKind | null; since?: number | null; ids?: string[] | null; invert?: boolean },
  days: number | null,
  limit: number,
  now = Date.now(),
): Promise<Note[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM notes n WHERE n.site_id = ?1 AND n.ts >= ?2 AND n.ts <= ?3 AND n.reviewed_at IS NULL
         AND (n.change_kind IS NULL OR n.change_kind != 'outage')
         AND n.ts + (COALESCE(?7, n.window_days, ?8) + ${WAIT_SQL}) * ${DAY} <= ?9
         AND (?4 IS NULL OR n.actor = ?4) AND (?5 IS NULL OR n.change_kind = ?5)
         AND (?11 IS NULL OR (CASE WHEN n.created_at >= ?11 OR n.id IN (SELECT value FROM json_each(?12)) THEN 1 ELSE 0 END) != ?13)
         AND (n.group_key IS NULL OR NOT EXISTS (
           SELECT 1 FROM notes g WHERE g.site_id = n.site_id AND g.ts >= n.ts - ?10 AND g.ts <= n.ts + ?10 AND g.group_key = n.group_key AND g.id != n.id
             AND (g.reviewed_at IS NOT NULL OR g.ts < n.ts OR (g.ts = n.ts AND g.id < n.id))))
       ORDER BY n.ts LIMIT ?6`,
    )
    .bind(siteId, now - DUE_LOOKBACK_DAYS * DAY, now - DAY, f.actor, f.kind, limit, days, IMPACT_DEFAULT_DAYS, now, GROUP_SPAN_MS, f.since ?? null, JSON.stringify(f.ids ?? []), f.invert ? 1 : 0)
    .all<Note>();
  return results;
}

/** dueNotes for several sites in one query, oldest first, with the same window, outage and group rules. */
export async function dueNotesOf(
  db: D1Database,
  siteIds: string[],
  f: { actor: string | null; kind: ChangeKind | null },
  days: number | null,
  limit: number,
  now = Date.now(),
): Promise<Note[]> {
  if (!siteIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT * FROM notes n WHERE n.site_id IN (SELECT value FROM json_each(?1)) AND n.ts >= ?2 AND n.ts <= ?3 AND n.reviewed_at IS NULL
         AND (n.change_kind IS NULL OR n.change_kind != 'outage')
         AND n.ts + (COALESCE(?7, n.window_days, ?8) + ${WAIT_SQL}) * ${DAY} <= ?9
         AND (?4 IS NULL OR n.actor = ?4) AND (?5 IS NULL OR n.change_kind = ?5)
         AND (n.group_key IS NULL OR NOT EXISTS (
           SELECT 1 FROM notes g WHERE g.site_id = n.site_id AND g.ts >= n.ts - ?10 AND g.ts <= n.ts + ?10 AND g.group_key = n.group_key AND g.id != n.id
             AND (g.reviewed_at IS NOT NULL OR g.ts < n.ts OR (g.ts = n.ts AND g.id < n.id))))
       ORDER BY n.ts, n.id LIMIT ?6`,
    )
    .bind(JSON.stringify(siteIds), now - DUE_LOOKBACK_DAYS * DAY, now - DAY, f.actor, f.kind, limit, days, IMPACT_DEFAULT_DAYS, now, GROUP_SPAN_MS)
    .all<Note>();
  return results;
}

/** The ids of the other notes in each note's group (same key within GROUP_SPAN_MS), for the due list. */
async function groupMembers(db: D1Database, siteId: string, notes: Note[]): Promise<Map<string, string[]>> {
  const grouped = notes.filter((n) => n.group_key);
  const out = new Map<string, string[]>();
  if (!grouped.length) return out;
  const lo = Math.min(...grouped.map((n) => n.ts)) - GROUP_SPAN_MS;
  const hi = Math.max(...grouped.map((n) => n.ts)) + GROUP_SPAN_MS;
  const { results } = await db
    .prepare(`SELECT id, ts, group_key FROM notes WHERE site_id = ? AND ts >= ? AND ts <= ? AND group_key IN (SELECT value FROM json_each(?)) ORDER BY ts LIMIT 500`)
    .bind(siteId, lo, hi, JSON.stringify([...new Set(grouped.map((n) => n.group_key))]))
    .all<{ id: string; ts: number; group_key: string }>();
  for (const n of grouped) {
    out.set(n.id, results.filter((r) => r.group_key === n.group_key && r.id !== n.id && Math.abs(r.ts - n.ts) <= GROUP_SPAN_MS).map((r) => r.id));
  }
  return out;
}

/**
 * GET /api/v1/notes?due=true&actor=&kind=&window=&limit=10 with a read key: the due notes, each with its impact and
 * verdict inline. Without `window`, each note waits for its own window. The list is read fresh on every call, so a
 * review takes its note off at once; the impacts are cached for 60 seconds under the ids they cover, and count against
 * the key's 120 new answers a minute.
 */
export async function dueNotesRoute(c: Context<AppEnv>) {
  const q = c.req.query();
  const f = noteFilters(q);
  if ('error' in f) return c.json({ error: f.error }, 400);
  const days = parseImpactWindow(q.window);
  if (days !== null && typeof days !== 'number') return c.json({ error: days.error }, 400);
  const many = allSitesOf(c);
  const max = many ? DUE_ALL_MAX_LIMIT : DUE_MAX_LIMIT;
  const limit = q.limit === undefined || q.limit === '' ? (many ? DUE_MAX_LIMIT : DUE_DEFAULT_LIMIT) : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) return c.json({ error: `limit is a whole number from 1 to ${max}` }, 400);
  const now = Date.now();
  if (many) {
    // Every site: the due notes with their site, oldest first, and no impact. One impact runs the overview queries
    // twice, too much for many sites in one request; get_note_impact with the site and id gives each verdict.
    const rows = await dueNotesOf(c.env.DB, many.map((s) => s.id), f, days, limit, now);
    return c.json(rows.map((n) => ({ site_id: n.site_id, ...apiNote(n, undefined, days) })), 200, { 'cache-control': 'private, no-store' });
  }
  const site = c.get('site');
  const notes = await dueNotes(c.env.DB, site.id, f, days, limit, now);
  if (!notes.length) return c.json([], 200, { 'cache-control': 'private, no-store' });
  const showRevenue = !!tokenOf(c).show_revenue;
  return cached(c, cacheKey(c, `notes/due/${notes.map((n) => n.id).join(',')}`, ['window']), SHARE_TTL, 'application/json', async () => {
    if (showRevenue) await convertPayments(c.env.DB).catch(() => 0);
    const groups = await groupMembers(c.env.DB, site.id, notes);
    const out = await Promise.all(
      notes.map(async (n) => {
        const row = noteWithImpact(await impactOf(c.env.DB, site, n, days, now), showRevenue);
        // The other notes of the group: the same change, reviewed with this one.
        return n.group_key ? { ...row, group_notes: groups.get(n.id) ?? [] } : row;
      }),
    );
    return JSON.stringify(out);
  });
}

/**
 * POST /api/v1/notes/:id/review  Authorization: Bearer <site API key, or a key with notes:write>
 * { "outcome": "kept" | "reverted" | "iterated", "comment": "..." }
 * Marks a note reviewed, once: a second review stores nothing and answers the first with `reviewed_now` false. Any
 * time, also before the window closes. Costs 1 row written (no index covers the review columns).
 */
export async function handleNoteReviewApi(c: Context<AppEnv>) {
  const auth = await writeSiteOf(c, 'notes:write');
  if ('error' in auth) return c.json({ error: auth.error }, auth.status);
  return reviewNote(c, auth.site, c.req.param('id') ?? '');
}

/**
 * POST /api/sites/:id/notes/:nid/review: the same review behind the login, for the dashboard and the iPhone app (a
 * phone token may review, as it may add a note). Same body, answer and single row written as the API route.
 */
export async function reviewNoteRoute(c: Context<AppEnv>) {
  return reviewNote(c, c.get('site'), c.req.param('nid') ?? '');
}

async function reviewNote(c: Context<AppEnv>, site: Site, id: string) {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  const outcome = b?.outcome;
  if (typeof outcome !== 'string' || !REVIEW_OUTCOMES.includes(outcome as ReviewOutcome)) {
    return c.json({ error: `outcome is one of ${REVIEW_OUTCOMES.join(', ')}` }, 400);
  }
  let comment: string | null = null;
  if (b?.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== 'string') return c.json({ error: 'comment must be a string' }, 400);
    comment = b.comment.trim().replace(/\s+/g, ' ') || null;
    if (comment && comment.length > REVIEW_COMMENT_MAX) return c.json({ error: `comment has at most ${REVIEW_COMMENT_MAX} characters` }, 400);
  }
  const db = c.env.DB;
  const [upd, row] = await db.batch([
    db
      .prepare('UPDATE notes SET reviewed_at = ?, review_outcome = ?, review_comment = ? WHERE id = ? AND site_id = ? AND reviewed_at IS NULL')
      .bind(Date.now(), outcome, comment, id, site.id),
    db.prepare('SELECT * FROM notes WHERE id = ? AND site_id = ?').bind(id, site.id),
  ]);
  const note = (row.results as Note[])[0];
  if (!note) return c.json({ error: 'This site has no such note' }, 404);
  return c.json({ ok: true, id: note.id, reviewed_now: !!upd.meta?.changes, note: apiNote(note) });
}

// ---------- GET /api/v1/notes/actors: verdicts per actor, to decide which agent to trust with more

export const ACTOR_DEFAULT_DAYS = 90;
export const ACTOR_MAX_DAYS = 365;
/** Notes the actor stats judge at most, the newest first: each verdict reads one overview. */
export const ACTOR_MAX_NOTES = 50;

export interface ActorStats {
  actor: string;
  changes: number;
  better: number;
  worse: number;
  inconclusive: number;
  /** The window is still open. */
  measuring: number;
  reviewed: number;
  kept: number;
  reverted: number;
  iterated: number;
  last_change: string;
}

/**
 * Per actor, the notes from the last `days` days that name one: how many there are, their verdicts (the same rule as
 * the impact route, with a window of `window` days) and their reviews. Notes without an actor are left out. At most
 * ACTOR_MAX_NOTES notes, the newest; `truncated` says when there were more.
 */
export async function actorStats(db: D1Database, site: Site, o: { days: number; window: number | null; showRevenue: boolean }, now = Date.now()) {
  const { results } = await db
    .prepare('SELECT * FROM notes WHERE site_id = ? AND ts >= ? AND ts <= ? AND actor IS NOT NULL ORDER BY ts DESC LIMIT ?')
    .bind(site.id, now - o.days * DAY, now, ACTOR_MAX_NOTES + 1)
    .all<Note>();
  // A group (locale copies of one change) counts once: its first note stands for it, and a review of any of its notes
  // is the group's review. An outage is no change, so it is left out.
  const firstOf = new Map<string, Note>();
  const reviewOf = new Map<string, Pick<Note, 'reviewed_at' | 'review_outcome'>>();
  const changes = results.filter((n) => n.change_kind !== 'outage');
  for (const n of changes) {
    if (!n.group_key) continue;
    const k = `${n.actor}\n${n.group_key}`;
    firstOf.set(k, n);
    if (n.reviewed_at && (!reviewOf.has(k) || n.reviewed_at < reviewOf.get(k)!.reviewed_at!)) reviewOf.set(k, n);
  }
  const notes = changes.filter((n) => !n.group_key || firstOf.get(`${n.actor}\n${n.group_key}`) === n).slice(0, ACTOR_MAX_NOTES);
  const verdicts: (Verdict | 'measuring')[] = [];
  // Ten at a time, so a long list doesn't open 50 overviews at once.
  for (let i = 0; i < notes.length; i += 10) {
    const part = await Promise.all(
      notes.slice(i, i + 10).map(async (n) => {
        if (reviewAfterOf(n, o.window) > now) return 'measuring' as const;
        const impact = await impactOf(db, site, n, o.window, now);
        return (o.showRevenue ? impact : impactWithoutRevenue(impact)).verdict;
      }),
    );
    verdicts.push(...part);
  }
  const by = new Map<string, ActorStats>();
  notes.forEach((n, i) => {
    const a = n.actor!;
    const row =
      by.get(a) ??
      { actor: a, changes: 0, better: 0, worse: 0, inconclusive: 0, measuring: 0, reviewed: 0, kept: 0, reverted: 0, iterated: 0, last_change: new Date(n.ts).toISOString() };
    row.changes++;
    const v = verdicts[i];
    if (v) row[v]++;
    const review = n.group_key ? (reviewOf.get(`${n.actor}\n${n.group_key}`) ?? n) : n;
    if (review.reviewed_at) {
      row.reviewed++;
      if (review.review_outcome && review.review_outcome in row) row[review.review_outcome]++;
    }
    by.set(a, row);
  });
  return {
    site_id: site.id,
    from: new Date(now - o.days * DAY).toISOString(),
    to: new Date(now).toISOString(),
    days: o.days,
    // null: each note's own window.
    window_days: o.window,
    truncated: results.length > ACTOR_MAX_NOTES,
    actors: [...by.values()].sort((x, y) => y.changes - x.changes || x.actor.localeCompare(y.actor)),
  };
}

/** `?days=` and `?window=` of the actor stats, or an error text. */
export function parseActorQuery(q: Record<string, string>): { days: number; window: number | null } | { error: string } {
  const days = q.days === undefined || q.days === '' ? ACTOR_DEFAULT_DAYS : Number(q.days);
  if (!Number.isInteger(days) || days < 1 || days > ACTOR_MAX_DAYS) return { error: `days is a whole number from 1 to ${ACTOR_MAX_DAYS}` };
  const window = parseImpactWindow(q.window);
  if (window !== null && typeof window !== 'number') return window;
  return { days, window };
}

/** GET /api/sites/:id/notes/actors for the dashboard: with revenue. */
export async function actorStatsRoute(c: Context<AppEnv>) {
  const p = parseActorQuery(c.req.query());
  if ('error' in p) return c.json({ error: p.error }, 400);
  await convertPayments(c.env.DB).catch(() => 0);
  return c.json(await actorStats(c.env.DB, c.get('site'), { ...p, showRevenue: true }));
}

// ---------- GET /api/v1/content/page?path=: one page by week, its Google numbers, and the notes aimed at it

export const PAGE_DEFAULT_WEEKS = 12;
export const PAGE_MAX_WEEKS = 26;
/** Notes the page detail measures at most, the newest first, from the last year. */
export const PAGE_NOTES = 5;
/** Search Console rows the page detail reads at most. */
const PAGE_SEARCH_ROWS = 5000;
/** Queries `search.queries` lists at most, the most clicked first; `total` counts them all. */
export const PAGE_QUERIES_LIMIT = 100;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

/** Notes from the last year whose target is `path`, newest first. */
async function pageNotes(db: D1Database, siteId: string, path: string, now: number): Promise<Note[]> {
  const { results } = await db
    .prepare(`SELECT * FROM notes WHERE site_id = ? AND ts >= ? AND target LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT 50`)
    .bind(siteId, now - 365 * DAY, likeEscape(path) + '%')
    .all<Note>();
  return results.filter((n) => targetPath(n.target) === path).slice(0, PAGE_NOTES);
}

/**
 * The page's Search Console rows from the gsc_pages part since `from`, summed per week (Monday, like the chart).
 * D1 picks the rows (json_each), so the Worker never parses the whole snapshot. Null when the site has no gsc_pages
 * part, or it is not JSON.
 */
async function pageSearch(db: D1Database, siteId: string, path: string, from: string, weeks: string[]) {
  const like = '%' + likeEscape(path);
  try {
    const [rows, meta] = await db.batch([
      db
        .prepare(
          `SELECT j.value AS r FROM seo_snapshots s, json_each(s.json) j
           WHERE s.site_id = ?1 AND s.part = 'gsc_pages' AND json_extract(j.value, '$[0]') >= ?2
             AND (json_extract(j.value, '$[1]') LIKE ?3 ESCAPE '\\' OR json_extract(j.value, '$[1]') LIKE ?4 ESCAPE '\\')
           LIMIT ?5`,
        )
        .bind(siteId, from, like, like + '?%', PAGE_SEARCH_ROWS),
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM seo_snapshots WHERE site_id = ?1 AND part = 'gsc_pages') AS has_pages,
                  (SELECT CASE WHEN json_valid(json) THEN json_extract(json, '$.gscThrough') END FROM seo_snapshots WHERE site_id = ?1 AND part = 'meta') AS through`,
        )
        .bind(siteId),
    ]);
    const m = meta.results[0] as { has_pages: number; through: string | null } | undefined;
    if (!m?.has_pages) return null;
    const by = new Map(weeks.map((w) => [w, { clicks: 0, impressions: 0, weighted: 0, ranked: 0 }]));
    let last: string | null = null;
    for (const { r } of rows.results as { r: string }[]) {
      const [date, key, clicks, impressions, position] = JSON.parse(r) as [string, string, number, number, number | null];
      if (pagePath(key) !== path) continue;
      if (!last || date > last) last = date;
      const w = by.get(bucketOf(Date.parse(date + 'T00:00:00Z'), 'week', 0));
      if (!w) continue;
      w.clicks += clicks;
      w.impressions += impressions;
      if (position !== null) {
        w.weighted += position * impressions;
        w.ranked += impressions;
      }
    }
    const pos = (x: { weighted: number; ranked: number }) => (x.ranked ? Math.round((x.weighted / x.ranked) * 10) / 10 : null);
    const sum = { clicks: 0, impressions: 0, weighted: 0, ranked: 0 };
    for (const x of by.values()) {
      sum.clicks += x.clicks;
      sum.impressions += x.impressions;
      sum.weighted += x.weighted;
      sum.ranked += x.ranked;
    }
    return {
      through: typeof m.through === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.through) ? m.through : last,
      clicks: sum.clicks,
      impressions: sum.impressions,
      position: pos(sum),
      weekly: [...by].map(([week, x]) => ({ week, clicks: x.clicks, impressions: x.impressions, position: pos(x) })),
      queries: await pageQueries(db, siteId, path),
    };
  } catch {
    return null;
  }
}

/**
 * The queries that showed the page, from the gsc_page_queries part (docs/SEO.md): its two 28-day windows, the most
 * clicked first. D1 picks the page's rows, as above. Null when the site has no such part or it is malformed.
 */
async function pageQueries(db: D1Database, siteId: string, path: string) {
  const like = '%' + likeEscape(path);
  try {
    const [rows, meta] = await db.batch([
      db
        .prepare(
          `SELECT j.value AS r FROM seo_snapshots s, json_each(s.json, '$.rows') j
           WHERE s.site_id = ?1 AND s.part = 'gsc_page_queries'
             AND (json_extract(j.value, '$[0]') LIKE ?2 ESCAPE '\\' OR json_extract(j.value, '$[0]') LIKE ?3 ESCAPE '\\')
           LIMIT ?4`,
        )
        .bind(siteId, like, like + '?%', PAGE_SEARCH_ROWS),
      db
        .prepare(
          `SELECT json_extract(json, '$.from') AS f, json_extract(json, '$.to') AS t, json_extract(json, '$.previousFrom') AS pf,
                  json_extract(json, '$.previousTo') AS pt
           FROM seo_snapshots WHERE site_id = ?1 AND part = 'gsc_page_queries'`,
        )
        .bind(siteId),
    ]);
    const m = meta.results[0] as { f: unknown; t: unknown; pf: unknown; pt: unknown } | undefined;
    if (!m || typeof m.f !== 'string' || typeof m.t !== 'string') return null;
    const list = queriesForPage((rows.results as { r: string }[]).map((x) => JSON.parse(x.r) as GscPageQuery), path);
    const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
    return {
      from: m.f,
      to: m.t,
      previous_from: typeof m.pf === 'string' ? m.pf : null,
      previous_to: typeof m.pt === 'string' ? m.pt : null,
      total: list.length,
      rows: list.slice(0, PAGE_QUERIES_LIMIT).map((q) => ({
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        position: r1(q.position),
        previous_clicks: q.prev.clicks,
        previous_impressions: q.prev.impressions,
        previous_position: r1(q.prev.position),
        // Positive: moved up (a smaller number is a better rank).
        position_change: r1(q.positionChange),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * The page detail for an agent or the Content tab: the visits that entered on `path`, per week, with revenue; the
 * page's Google clicks, impressions and position per week from the SEO snapshot; and the newest notes aimed at the
 * page, each with its impact. Weeks run Monday to Sunday in the site's timezone; the last one is the current week.
 */
export async function contentPage(c: Context<AppEnv>, showRevenue: boolean) {
  const q = c.req.query();
  const path = targetPath(q.path);
  if (!path) return c.json({ error: 'path is a page path that starts with /, such as /blog/launch' }, 400);
  const weeks = q.weeks === undefined || q.weeks === '' ? PAGE_DEFAULT_WEEKS : Number(q.weeks);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > PAGE_MAX_WEEKS) return c.json({ error: `weeks is a whole number from 1 to ${PAGE_MAX_WEEKS}` }, 400);
  const site = c.get('site');
  const db = c.env.DB;
  const now = Date.now();
  const offset = tzOffset(site.timezone, now);
  const today = new Date(now + offset).toISOString().slice(0, 10);
  const from = addDays(bucketOf(now, 'week', offset), -7 * (weeks - 1));
  const range = resolveRange({ period: 'custom', from, to: today, granularity: 'week' }, site.timezone, site.created_at, now);
  const ctx: Ctx = { db, site, range, filters: { entry_page: path }, offset: tzOffset(site.timezone, range.to), period: 'custom', skipImported: true };
  const [o, notes] = await Promise.all([overview(ctx), pageNotes(db, site.id, path, now)]);
  const [search, impacts, speed, clicks] = await Promise.all([
    pageSearch(db, site.id, path, from, o.series.map((s) => s.bucket)),
    Promise.all(notes.map((n) => impactOf(db, site, n, null, now))),
    vitalsReport(db, site, { path, now }),
    // The click map's 10 most clicked elements over the same 28 days as vitals (page-maps.ts); null without rows.
    pageClicks(db, { siteId: site.id, path, from: now - 28 * 86_400_000, to: now }),
  ]);
  const totals = (k: (typeof o)['current']) =>
    showRevenue
      ? { visitors: k.visitors, customers: k.customers, revenue: k.revenue, revenue_per_visitor: Math.round(k.revenuePerVisitor) }
      : { visitors: k.visitors };
  return c.json({
    site_id: site.id,
    timezone: site.timezone,
    ...(showRevenue ? { currency: site.currency, currency_decimals: currencyDecimals(site.currency) } : {}),
    path,
    from,
    to: today,
    weeks,
    ...totals(o.current),
    previous: totals(o.previous),
    weekly: o.series.map((s) =>
      showRevenue
        ? { week: s.bucket, visitors: s.visitors, revenue: s.revenue, revenue_per_visitor: Math.round(ratio(s.revenue, s.visitors)) }
        : { week: s.bucket, visitors: s.visitors },
    ),
    search,
    // Core Web Vitals of loads of this page over the last 28 days (vitals.ts), whatever `weeks` is.
    vitals: { days: speed.days, from: speed.from, to: speed.to, min_sample: speed.min_sample, ...speed.overall, devices: speed.devices },
    // How far visitors scrolled on loads of this page (vitals.scroll), null before any sent one; the click map's elements.
    scroll: speed.scroll.samples ? speed.scroll : null,
    clicks: clicks ? { days: 28, ...clicks } : null,
    notes: impacts.map((i) => noteWithImpact(i, showRevenue)),
  });
}

/** What an app version looks like: 1 to 4 numbers with dots, and an optional build number, e.g. "2.3.1 (45)". */
const VERSION = /^\d+(\.\d+){0,3}( \(\d+\))?$/;
/** A version needs this many sessions, from this many installs, on its first day before it gets a note. */
export const VERSION_MIN_SESSIONS = 5;
export const VERSION_MIN_INSTALLS = 3;
/** Version notes one site gets per day at most, the versions with the most sessions first. */
export const VERSION_NOTES_PER_DAY = 3;

/**
 * The daily cron: a note for each app version that first reported a session in the UTC day before `now`. The app
 * endpoint is public, so a version string alone proves nothing: it must look like a version and have
 * VERSION_MIN_SESSIONS sessions from VERSION_MIN_INSTALLS installs that day, and a site gets VERSION_NOTES_PER_DAY
 * notes at most. A version seen in the 90 days before that day, or with a note already, gets none, so a rerun adds
 * nothing. Runs off the ingest path; it writes only the new notes. Returns how many it added.
 */
export async function addVersionNotes(db: D1Database, now = Date.now()): Promise<number> {
  const dayEnd = Math.floor(now / DAY) * DAY;
  const dayStart = dayEnd - DAY;
  const { results } = await db
    .prepare(
      `SELECT s.site_id, s.app_version AS version, MIN(s.started_at) AS ts, COUNT(*) AS n FROM sessions s
       WHERE s.started_at >= ?1 AND s.started_at < ?2 AND s.app_version IS NOT NULL AND s.app_version != ''
       GROUP BY s.site_id, s.app_version
       HAVING COUNT(*) >= ?4 AND COUNT(DISTINCT s.visitor_id) >= ?5
         AND NOT EXISTS (SELECT 1 FROM sessions p WHERE p.site_id = s.site_id AND p.started_at >= ?3 AND p.started_at < ?1 AND p.app_version = s.app_version)
       ORDER BY s.site_id, n DESC, version`,
    )
    .bind(dayStart, dayEnd, dayStart - 90 * DAY, VERSION_MIN_SESSIONS, VERSION_MIN_INSTALLS)
    .all<{ site_id: string; version: string; ts: number; n: number }>();
  const perSite = new Map<string, number>();
  const picked = results.filter((r) => {
    if (!VERSION.test(r.version)) return false;
    const n = perSite.get(r.site_id) ?? 0;
    if (n >= VERSION_NOTES_PER_DAY) return false;
    perSite.set(r.site_id, n + 1);
    return true;
  });
  if (!picked.length) return 0;
  const stmts = picked.map((r) =>
    db
      .prepare(
        `INSERT INTO notes (id, site_id, ts, text, kind, created_at)
         SELECT ?1, ?2, ?3, ?4, 'version', ?5
         WHERE NOT EXISTS (SELECT 1 FROM notes WHERE site_id = ?2 AND kind = 'version' AND text = ?4)`,
      )
      .bind(randomId(10), r.site_id, r.ts, versionText(r.version), now),
  );
  const out = await db.batch(stmts);
  return out.reduce((n, x) => n + (x.meta?.changes ?? 0), 0);
}

export const versionText = (version: string) => `App version ${version.slice(0, 40)}`;
