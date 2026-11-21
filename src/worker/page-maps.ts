// Click maps, core part (round 7, lane pages; docs/API.md "Click maps and scroll"): the config the pageview answer
// carries as cfg.m, and the page_maps row of the ping. Stubs from the foundation; lane pages fills them.
import type { CorePart } from './core-parts';
import type { Site } from './env';

/** `cfg.m` of the pageview answer: the tracker sends a click map of the page. `s` is the sample percent. */
export interface MapConfig {
  s: number;
}

/** The click map config of a site, or undefined when click maps are off. */
export function mapConfig(site: Site): MapConfig | undefined {
  return undefined;
}

/** The page_maps row of the map payload `h` a ping carries, or null when there is none to keep. */
export function mapStatement(db: D1Database, site: Site, h: unknown, path: string, device: string | null, now: number): D1PreparedStatement | null {
  return null;
}

/** Lane pages fills this part: page_maps, its retention, maps_on and map_sample, and the definitions. */
export const pageMapsPart: CorePart = {
  siteTables: [],
};
