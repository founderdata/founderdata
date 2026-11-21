// JavaScript errors without recording, core part (round 7, lane errors; docs/API.md "Errors"): the config the
// pageview answer carries as cfg.e, the errors rows of the ping and the fingerprint that groups them into issues.
// Stubs from the foundation; lane errors fills them.
import type { CorePart } from './core-parts';
import type { Site } from './env';

/** `cfg.e` of the pageview answer: 1 when the tracker should catch errors on this site, else undefined. */
export function errorsConfig(site: Site): 1 | undefined {
  return undefined;
}

/** The errors rows of the page activity `a` a ping carries: one per distinct error, at most 5. */
export function errorStatements(db: D1Database, site: Site, a: unknown, sid: string, path: string, ua: string, now: number): D1PreparedStatement[] {
  return [];
}

/** The issue an error belongs to: 12 hex characters (plan S12). */
export function fingerprint(message: string, source: string | null, stack: string | null): string {
  return '';
}

/** Lane errors fills this part: errors and error_issues, their retention, erase and export, errors_on, definitions. */
export const errorsPart: CorePart = {
  siteTables: [],
};
