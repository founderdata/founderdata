// Web experiments and flags, core part (round 7, lane exp; docs/API.md "Experiments in the tracker"). Core stores the
// variant a visit saw as the session property exp_<key> (sessions.props, migration 0006); FounderData Pro's
// experimentDecision hook picks it (pro-hooks.ts) with the pure functions here: parseExpLive reads sites.exp_live,
// pathMatches says whether a page is in an experiment, assign picks the variant from a hash of the key and visitor id.
import type { CorePart } from './core-parts';
import type { ExportTable } from './export';

/** The session property that holds an experiment's variant: exp_<key>. App experiments use the same name. */
export const EXPERIMENT_PROP = (key: string) => 'exp_' + key;

/** An experiment key: [a-z0-9_]{1,40}. */
export const EXPERIMENT_KEY = /^[a-z0-9_]{1,40}$/;

/** Most properties one session keeps (sessions.props, as the app API caps them). */
export const MAX_SESSION_PROPS = 10;

/**
 * The session properties a new visit starts with: {exp_<key>: variant} for each experiment the pageview entered, at
 * most 10. Null when there is none. Bound in the sessions INSERT, so the exposure costs no row.
 */
export function exposureProps(exp: Record<string, string> | null | undefined): string | null {
  const out: Record<string, string> = {};
  const fixed = exp ? fixedKeys.get(exp) : undefined;
  let n = 0;
  for (const [key, variant] of Object.entries(exp ?? {})) {
    if (n >= MAX_SESSION_PROPS) break;
    if (fixed?.has(key) || !EXPERIMENT_KEY.test(key) || typeof variant !== 'string' || !variant) continue;
    out[EXPERIMENT_PROP(key)] = variant.slice(0, 40);
    n++;
  }
  return n ? JSON.stringify(out) : null;
}

/**
 * The exposure of a running visit that reaches an experiment's pages for the first time: one UPDATE per experiment,
 * which writes 1 row the first time and nothing after (the property is set, or the session has 10 properties).
 */
export function exposureStatements(db: D1Database, siteId: string, sid: string, props: Record<string, string> | null | undefined): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const fixed = props ? fixedKeys.get(props) : undefined;
  for (const [key, variant] of Object.entries(props ?? {})) {
    if (fixed?.has(key) || !EXPERIMENT_KEY.test(key) || typeof variant !== 'string' || !variant) continue;
    const path = '$.' + EXPERIMENT_PROP(key);
    out.push(
      db
        .prepare(
          `UPDATE sessions SET props = json_set(COALESCE(props, '{}'), ?1, ?2)
           WHERE site_id = ?3 AND id = ?4 AND json_extract(COALESCE(props, '{}'), ?1) IS NULL
             AND (props IS NULL OR (SELECT COUNT(*) FROM json_each(props)) < ${MAX_SESSION_PROPS})`,
        )
        .bind(path, variant.slice(0, 40), siteId, sid),
    );
  }
  return out;
}

/** Most experiments that run at once on one site (sites.exp_live). */
export const MAX_RUNNING = 10;

/** Most stopped experiments that keep serving their winner at once (sites.exp_live entries with f: 1). */
export const MAX_FIXED = 10;

/**
 * One entry of sites.exp_live: key, [variant, weight] pairs (control first), page prefixes. A running experiment has 2
 * to 4 variants. An experiment stopped with a winner keeps serving it until it is deleted: `f: 1` and one variant, the
 * winner, so the pages show it and founderdata('flag') answers it, and no visit stores an exposure.
 */
export interface ExpLive {
  k: string;
  v: [string, number][];
  /** Path prefixes; absent = every page. */
  p?: string[];
  /** 1: stopped with a winner. The tracker gets the winner; the visit stores nothing. */
  f?: 1;
}

/**
 * The keys of a decide() answer that come from stopped experiments (f: 1). collect.ts passes the same object to the
 * tracker (cfg.x shows the winner) and to exposureProps and exposureStatements, which leave these keys out, so a
 * finished experiment's results stay as they were at the stop.
 */
const fixedKeys = new WeakMap<object, Set<string>>();

// The cached site row keeps the same exp_live text for 60 s, so each isolate parses it once.
let lastText: string | null = null;
let lastLive: ExpLive[] = [];

/**
 * The entries of sites.exp_live, checked: a valid key, 2 to 4 variants with whole weights that are not all 0 (or, for a
 * stopped one with f: 1, the winner alone), string prefixes. Entries that fail are left out, so a bad row never breaks a
 * pageview. At most MAX_RUNNING running and MAX_FIXED stopped.
 */
export function parseExpLive(text: string | null | undefined): ExpLive[] {
  if (!text) return [];
  if (text === lastText) return lastLive;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const out: ExpLive[] = [];
  let running = 0;
  let fixed = 0;
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object' || typeof e.k !== 'string' || !EXPERIMENT_KEY.test(e.k) || !Array.isArray(e.v)) continue;
    const f = e.f === 1;
    if (f ? fixed >= MAX_FIXED : running >= MAX_RUNNING) continue;
    const v = (e.v as unknown[]).filter(
      (x): x is [string, number] => Array.isArray(x) && typeof x[0] === 'string' && !!x[0] && Number.isInteger(x[1]) && (x[1] as number) >= 0,
    );
    if (v.length !== e.v.length || !v.some((x) => x[1] > 0) || (f ? v.length !== 1 : v.length < 2 || v.length > 4)) continue;
    if (out.some((x) => x.k === e.k)) continue;
    const p = Array.isArray(e.p) ? (e.p as unknown[]).filter((x): x is string => typeof x === 'string' && x[0] === '/') : undefined;
    const entry: ExpLive = p && p.length ? { k: e.k, v, p } : { k: e.k, v };
    if (f) entry.f = 1;
    out.push(entry);
    if (f) fixed++;
    else running++;
  }
  lastText = text;
  lastLive = out;
  return out;
}

/** FNV-1a, 32 bits, over the string's UTF-16 code units. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The variant a visitor gets: FNV-1a of `key:vid` modulo 10,000, placed against the cumulative weights. The same key
 * and visitor id always give the same variant; another key splits the same visitors independently.
 */
export function assign(key: string, vid: string, variants: [string, number][]): string {
  const total = variants.reduce((n, [, w]) => n + Math.max(0, w), 0);
  if (!variants.length || total <= 0) return variants[0]?.[0] ?? '';
  const bucket = (fnv1a(`${key}:${vid}`) % 10_000) / 10_000;
  let cum = 0;
  for (const [name, w] of variants) {
    cum += Math.max(0, w) / total;
    if (bucket < cum) return name;
  }
  return variants[variants.length - 1][0];
}

/**
 * Whether a path is in an experiment: no prefixes means every page, else the path is a prefix or under one followed
 * by / (recording.ts isSkipped: /pricing matches /pricing and /pricing/annual, not /pricing-old). One exception: /
 * is the home page only, with any query or hash, since as a prefix it would cover every page of the site.
 */
export function pathMatches(path: string, prefixes: string[] | null | undefined): boolean {
  if (!prefixes || !prefixes.length) return true;
  const p = path.split(/[?#]/)[0] || '/';
  return prefixes.some((x) => p === x || (x !== '/' && p.startsWith(x.endsWith('/') ? x : `${x}/`)));
}

/** Whether two experiments' pages overlap: one covers a page of the other (no pages means every page). */
export function pathsOverlap(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (!a?.length || !b?.length) return true;
  return a.some((x) => pathMatches(x, b)) || b.some((x) => pathMatches(x, a));
}

/**
 * The experiments a pageview of `path` enters, {key: variant}; null for none. Pro's hook answers this. A stopped
 * experiment with a winner (f: 1) answers its winner, and its key is marked so the visit stores no exposure.
 */
export function decide(live: ExpLive[], vid: string, path: string): Record<string, string> | null {
  let out: Record<string, string> | null = null;
  let fixed: Set<string> | null = null;
  for (const e of live) {
    if (!pathMatches(path, e.p)) continue;
    (out ??= {})[e.k] = assign(e.k, vid, e.v);
    if (e.f) (fixed ??= new Set()).add(e.k);
  }
  if (out && fixed) fixedKeys.set(out, fixed);
  return out;
}

/** The keys of a decide() answer that only show a stopped experiment's winner. */
export const fixedOf = (x: Record<string, string> | null | undefined): ReadonlySet<string> => (x && fixedKeys.get(x)) || new Set();

const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

/** CSV export: every experiment and flag of the site, whatever the period. */
const experimentsExport: ExportTable = {
  allTime: true,
  columns: ['key', 'kind', 'name', 'status', 'variants', 'pages', 'goal', 'created_at', 'started_at', 'stopped_at', 'winner'],
  chunk: (ctx, cur, n) =>
    ctx.db
      .prepare(
        `SELECT * FROM experiments WHERE site_id = ?${cur ? ' AND (created_at > ? OR (created_at = ? AND key > ?))' : ''}
         ORDER BY created_at, key LIMIT ${n}`,
      )
      .bind(ctx.site.id, ...(cur ? [cur.ts, cur.ts, cur.id] : [])),
  cells: (r) => {
    let variants = r.variants;
    try {
      variants = (JSON.parse(r.variants) as { key: string; weight: number }[]).map((v) => `${v.key}:${v.weight}`).join(' ');
    } catch {}
    return [r.key, r.kind, r.name, r.status, variants, (r.paths ?? '').split('\n').filter(Boolean).join(' '), r.goal, iso(r.created_at), iso(r.started_at), iso(r.stopped_at), r.winner];
  },
  cursor: (r) => ({ ts: r.created_at, id: r.key }),
  scrub: [],
};

/** The experiments table: emptied with the site, exported as CSV, explained to agents. */
export const experimentsPart: CorePart = {
  siteTables: ['experiments'],
  exports: { experiments: experimentsExport },
  definitions: {
    experiments:
      "Web experiments, flags and app experiments in one list (get_app_funnel report experiments). The Worker picks a web visitor's version from a hash of the experiment key and the visitor id at the pageview, and keeps it on the visit as the session property exp_<key>. In paths, / is the home page only, and /pricing also covers /pricing/annual. A web experiment stopped with a winner keeps showing the winner to every visitor until it is deleted, and stores nothing more. App experiments are the exp_<name> property FounderDataKit sets. Their control is the version named control, baseline, default, original, off or a, else the first name in alphabetical order (control_reason). Web arms count people: the user id identify() set, else the visitor id. A person seen in two arms counts in the first, and switched says how many. Without cookies or Remember visitors the visitor id changes at 00:00 UTC, so a person back on another day may land in the other arm, and only identified people can be matched: switched_is_floor is then true, and identified_share is the share of people with a user id. App arms count sessions, so one person counts once per session. conversions is the goal (the site's primary goal when none is set) reached in or after the first visit in the arm, up to the stop. revenue is what a person paid after their first visit in the arm: one-time payments and first subscription payments, renewals and sandbox purchases out, money a user_id stitches in, less refunds from their first counted payment on (also after the stop), never below 0 per person. customers are people whose first payment came after they first saw the experiment; a person who paid before counts as a visitor with no revenue. paid_rate is customers over visitors; revenue_per_visitor and mrr_per_visitor divide by visitors. run_payments counts the payments in the run (total) and those a version got (tied). vs_control compares the conversion rate with a two-proportion test and revenue per visitor with a Welch test; revenue_uplift is the gap as a share of the control's revenue per visitor, revenue_interval its 95% range in minor units. verdict is small_sample until each arm has 100 visitors (app arms: 30 purchases each), revenue_verdict until each arm has 30 customers; while an answer is small_sample its p-value and difference are null. likely means p under 0.05. split_check compares a web experiment's visitors per arm with its weights (chi-square; flags carry none, as their rollout can change while they run). ok false (p under 0.001) means assignment or tracking failed in an arm: do not decide on that result.",
  },
};
