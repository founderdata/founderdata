// The two surveys, core part (round 7, lane survey; docs/API.md "Survey answers"): the answers the tracker's `answer`
// and `survey` commands send, the cancel reasons of payment webhooks, and the "Heard about" breakdown dimension.
// Stubs from the foundation; lane survey fills them.
import type { CorePart } from './core-parts';
import type { Site } from './env';
import type { BreakdownRow, Ctx } from './stats';
import type { TrackerPayload } from './collect';

/**
 * The statements of one `survey` event: the answer row and the visitor's trait (collect.ts traitsPatchSql). Empty when
 * the answer is not one to keep. `path` is the page it was given on.
 */
export function surveyStatements(db: D1Database, site: Site, body: TrackerPayload, path: string, now: number): D1PreparedStatement[] {
  return [];
}

/** Rows of the heard_about breakdown dimension (stats.ts breakdown): the answers of the period's visitors. */
export async function heardAboutRows(ctx: Ctx, limit: number): Promise<BreakdownRow[]> {
  return [];
}

/** Lane survey fills this part: survey_answers, its retention, erase and export, sites.surveys and the definition. */
export const surveysPart: CorePart = {
  siteTables: [],
};
