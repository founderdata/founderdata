// Web experiments and flags, core part (round 7, lane exp; docs/API.md "Experiments in the tracker"). Core stores the
// variant a visit saw as the session property exp_<key> (sessions.props, migration 0006); FounderData Pro's
// experimentDecision hook picks it (pro-hooks.ts). The foundation wrote exposureStatements; lane exp fills the rest.
import type { CorePart } from './core-parts';

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
  let n = 0;
  for (const [key, variant] of Object.entries(exp ?? {})) {
    if (n >= MAX_SESSION_PROPS) break;
    if (!EXPERIMENT_KEY.test(key) || typeof variant !== 'string' || !variant) continue;
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
  for (const [key, variant] of Object.entries(props ?? {})) {
    if (!EXPERIMENT_KEY.test(key) || typeof variant !== 'string' || !variant) continue;
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

/** Lane exp fills this part: the experiments table, its export and the definition. */
export const experimentsPart: CorePart = {
  siteTables: [],
};
