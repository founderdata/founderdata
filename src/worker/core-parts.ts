// The parts round 7's core features plug into the Worker's shared places: site deletion, the nightly retention job,
// erasing a person, the CSV export, PATCH /api/sites/:id and get_definitions. Each feature module exports one part;
// with every part empty the Worker behaves as before.
//
// A feature module imports only the CorePart type from here, never CORE_PARTS, so loading this file never runs in
// the middle of a feature module's own load.
import type { Site } from './env';
import type { ExportTable } from './export';
import { experimentsPart } from './experiments';
import { surveysPart } from './surveys';
import { pageMapsPart } from './page-maps';
import { errorsPart } from './errors';

export interface CorePart {
  /** Tables with a site_id column that the site's deletion empties (index.ts DELETE /api/sites/:id). */
  siteTables: string[];
  /** Statements the nightly retention job runs (retention.ts), given the visit cutoff. */
  retention?(db: D1Database, cutoff: number, now: number): D1PreparedStatement[];
  /** Statements that erase these visitors' rows (erase.ts), one chunk of ids at a time. */
  erase?(db: D1Database, siteId: string, visitorIds: string[]): D1PreparedStatement[];
  /**
   * Statements that erase rows tied to these payment customer ids (erase.ts, an erase by email or user id), run while
   * the subscriptions still carry them: rows of a buyer who was never seen as a visitor.
   */
  eraseCustomers?(db: D1Database, siteId: string, customerIds: string[]): D1PreparedStatement[];
  /** PATCH /api/sites/:id: check the body's fields onto `next`; the error to answer, or null. */
  patch?(b: Record<string, unknown>, next: Site): string | null;
  /** The [column, value] pairs that PATCH writes after patch(). */
  columns?(b: Record<string, unknown>, site: Site, next: Site): [string, unknown][];
  /** CSV export tables (export.ts TABLES). */
  exports?: Record<string, ExportTable>;
  /** get_definitions entries (agent-api.ts DEFINITIONS). */
  definitions?: Record<string, string>;
}

/** In lane order: experiments, surveys, click maps, errors. */
export const CORE_PARTS: CorePart[] = [experimentsPart, surveysPart, pageMapsPart, errorsPart];

/** Every part's site tables. */
export const partSiteTables = (): string[] => CORE_PARTS.flatMap((p) => p.siteTables);

/** Every part's retention statements. */
export const partRetention = (db: D1Database, cutoff: number, now: number): D1PreparedStatement[] =>
  CORE_PARTS.flatMap((p) => p.retention?.(db, cutoff, now) ?? []);

/** Every part's erase statements for one chunk of visitor ids. */
export const partErase = (db: D1Database, siteId: string, visitorIds: string[]): D1PreparedStatement[] =>
  CORE_PARTS.flatMap((p) => p.erase?.(db, siteId, visitorIds) ?? []);

/** Every part's erase statements for one chunk of payment customer ids. */
export const partEraseCustomers = (db: D1Database, siteId: string, customerIds: string[]): D1PreparedStatement[] =>
  CORE_PARTS.flatMap((p) => p.eraseCustomers?.(db, siteId, customerIds) ?? []);

/** Runs every part's PATCH check; the first error, or null. */
export function partPatch(b: Record<string, unknown>, next: Site): string | null {
  for (const p of CORE_PARTS) {
    const err = p.patch?.(b, next);
    if (err) return err;
  }
  return null;
}

/** Every part's PATCH columns. */
export const partColumns = (b: Record<string, unknown>, site: Site, next: Site): [string, unknown][] =>
  CORE_PARTS.flatMap((p) => p.columns?.(b, site, next) ?? []);

/** Every part's export tables. */
export const partExports = (): Record<string, ExportTable> => Object.assign({}, ...CORE_PARTS.map((p) => p.exports ?? {}));

/** Every part's get_definitions entries. */
export const partDefinitions = (): Record<string, string> => Object.assign({}, ...CORE_PARTS.map((p) => p.definitions ?? {}));
