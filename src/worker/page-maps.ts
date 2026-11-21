// Click maps, core part (round 7, lane pages; docs/API.md "Click maps and scroll", docs/PRIVACY.md "Click maps and
// scroll"). A site that turns click maps on (sites.maps_on, migration 0090) gets cfg.m in the pageview answer; the
// tracker then sends the page's map each time the page is hidden or left with something new (`h`: path, viewport
// width, document height, deepest scroll, at most 50 clicks, the page view's random id and age). One page_maps row per
// page view (migration 0093): a later send of the same page view updates it. Sampled by sites.map_sample, with no
// visitor or session id. Pages on the never-record list (record_skip) get no map.
//
// The reports (the page's element table, click points and scroll bands, the overlay's data, and `clicks` of the
// content page answer) are FounderData Pro's (pro/worker/page-maps.ts).
import type { CorePart } from './core-parts';
import type { Site } from './env';
import { normalizePath } from './collect';
import { isSkipped, skipList } from './recording';

const DAY = 86_400_000;
/** Days a click map row is kept, like vitals (VITALS_DAYS). */
export const MAP_DAYS = 90;
/** Most clicks one page view keeps. The tracker sends at most this many; the server cuts any surplus. */
export const MAX_MAP_CLICKS = 50;
/** Largest click y in px a row keeps: below that the page is longer than any page a person reads. */
export const MAX_Y = 50_000;
/**
 * How far apart two sends of one page view may place its start (the server's clock less the page view's age), and
 * still update one row: covers a send that reached the server late. A later send outside it adds a second row.
 */
export const MAP_MATCH_MS = 5 * 60_000;
/** Oldest page view a map may describe: a tab left open longer starts its row this far back. */
export const MAP_MAX_AGE_MS = 7 * 86_400_000;
/** Longest click label kept. */
export const LABEL_MAX = 40;
/**
 * The CSS hint of a clicked element: a tag name, optionally with .class or #id ("button.buy"). The same pattern as
 * CLICK_HINT in collect.ts, which checks the hint of a rage click.
 */
export const MAP_HINT = /^[a-z][a-z0-9-]{0,20}([#.][\w-]{1,40})?$/i;

/**
 * `cfg.m` of the pageview answer: the tracker sends a click map of the page. `s` is the sample percent (the server
 * samples), `x` a regular expression source that matches the paths of the never-record list (isSkipped's rule), so the
 * tracker sends no map there. The server keeps none there either.
 */
export interface MapConfig {
  s: number;
  x?: string;
}

/** A regular expression source matching what isSkipped matches for these prefixes, or undefined for none. */
export function skipPattern(list: string[]): string | undefined {
  if (!list.length) return undefined;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return '^(?:' + list.map((x) => (x.endsWith('/') ? esc(x) : esc(x) + '(?:/|$)')).join('|') + ')';
}

/** Percent of page views that keep a click map, 1 to 100; 100 when unset. */
export function mapSampleOf(site: Pick<Site, 'map_sample'>): number {
  const n = Number(site.map_sample ?? 100);
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.round(n))) : 100;
}

/** The click map config of a site, or undefined when click maps are off. */
export function mapConfig(site: Site): MapConfig | undefined {
  if (!site.maps_on) return undefined;
  const x = skipPattern(skipList(site.record_skip));
  return x ? { s: mapSampleOf(site), x } : { s: mapSampleOf(site) };
}

/** One click as stored: [x per mille of the viewport width, y px from the top of the document, hint, label]. */
export type MapClick = [number, number, string, string];

export interface MapPayload {
  path: string;
  width: number | null;
  height: number | null;
  scroll: number | null;
  clicks: MapClick[];
  /** The page view's random id from the tracker (0 to 2^31 - 1), null from a tracker that sends none. */
  id: number | null;
  /** The page view's age in ms when the tracker sent this, 0 when it sent none. */
  age: number;
}

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null;
const text = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/**
 * The map payload `h` of a ping, checked and clipped, or null when it holds nothing to keep. Shape from the tracker:
 * { p: path, w: viewport width, H: document height, s: deepest scroll percent, c: [[x, y, hint, label], ...],
 * i: page view id, a: page view age in ms }. A click's x is px from the left of the viewport, turned into thousandths
 * of `w` here; y is px from the top of the document. A click outside the ranges is dropped (all of them without `w`),
 * a hint that is not a tag with an optional class or id becomes '', a label keeps 40 characters. `fallback` is the
 * ping's own path, used when `p` is missing or not a path.
 */
export function parseMapPayload(h: unknown, fallback: string): MapPayload | null {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  const x = h as { p?: unknown; w?: unknown; H?: unknown; s?: unknown; c?: unknown; i?: unknown; a?: unknown };
  const path = typeof x.p === 'string' && x.p.startsWith('/') && x.p.length <= 2000 ? normalizePath(x.p.split(/[?#]/)[0]) : fallback;
  const width = int(x.w, 1, 20_000);
  const clicks: MapClick[] = [];
  for (const c of width && Array.isArray(x.c) ? x.c.slice(0, MAX_MAP_CLICKS) : []) {
    if (!Array.isArray(c)) continue;
    const px = int(c[0], 0, width!);
    const cy = int(c[1], 0, MAX_Y);
    if (px === null || cy === null) continue;
    const cx = Math.round((px * 1000) / width!);
    const hint = typeof c[2] === 'string' && MAP_HINT.test(c[2]) ? c[2].toLowerCase() : '';
    clicks.push([cx, cy, hint, text(c[3], LABEL_MAX)]);
  }
  const height = int(x.H, 1, 1_000_000);
  const scroll = int(x.s, 0, 100);
  if (!clicks.length && scroll === null) return null;
  const id = typeof x.i === 'number' && Number.isInteger(x.i) && x.i >= 0 && x.i < 2 ** 31 ? x.i : null;
  return { path, width, height, scroll, clicks, id, age: int(x.a, 0, MAP_MAX_AGE_MS) ?? 0 };
}

/**
 * The page_maps row of the map payload `h` a ping carries, or null when there is none to keep: click maps are off,
 * the payload is empty or broken, the page is on the never-record list, or the sample skips this page view. 1 row
 * written either way.
 *
 * The row starts at the page view's start (now less its age `a`) and is keyed by the tracker's id `i`. A later send of
 * the same page view (the visitor came back to the tab and clicked more) finds that row within MAP_MATCH_MS and
 * replaces its size, scroll and clicks, so a page view stays one row and keeps clicks made after a tab switch. The
 * sample is decided by the id, so every send of a page view gets the same answer.
 */
export function mapStatement(
  db: D1Database,
  site: Site,
  h: unknown,
  path: string,
  device: string | null,
  now: number,
  random = Math.random,
): D1PreparedStatement | null {
  if (!site.maps_on || !h) return null;
  const m = parseMapPayload(h, path);
  if (!m || isSkipped(m.path, skipList(site.record_skip))) return null;
  const id = m.id ?? Math.floor(random() * 2 ** 31);
  if (id % 100 >= mapSampleOf(site)) return null;
  // INSERT ... SELECT needs a WHERE before ON CONFLICT (SQLite's parser). The subquery reads the primary key range of
  // this page around the start, so it touches only the rows of a few minutes.
  return db
    .prepare(
      `INSERT INTO page_maps (site_id, path, ts, id, device, width, height, scroll, clicks)
       SELECT ?1, ?2, COALESCE((SELECT ts FROM page_maps WHERE site_id = ?1 AND path = ?2 AND ts BETWEEN ?3 - ${MAP_MATCH_MS} AND ?3 + ${MAP_MATCH_MS} AND id = ?4 LIMIT 1), ?3),
         ?4, ?5, ?6, ?7, ?8, ?9 WHERE 1
       ON CONFLICT (site_id, path, ts, id) DO UPDATE SET width = COALESCE(excluded.width, width), height = COALESCE(excluded.height, height),
         scroll = COALESCE(MAX(scroll, excluded.scroll), excluded.scroll, scroll), clicks = COALESCE(excluded.clicks, clicks)`,
    )
    .bind(site.id, m.path, now - m.age, id, device, m.width, m.height, m.scroll, m.clicks.length ? JSON.stringify(m.clicks) : null);
}

// ---------- the content page's clicks (types only: the report is FounderData Pro's, pro/worker/page-maps.ts, through the
// pageClicks hook in pro-hooks.ts; without Pro, `clicks` of GET /api/v1/content/page is null)

export interface MapElement {
  /** The element's tag with its first class or id, such as a.cta; '' when the tracker sent none that passed. */
  element: string;
  /** Its visible text, 40 characters at most; '' for masked or text-less elements. */
  label: string;
  clicks: number;
  /** Mapped page views with at least one click on it. */
  views: number;
  /** views over all mapped page views of the page, 0 to 1. */
  share: number;
}

/** One page of one site in a window [from, to), optionally one device. */
export type MapWhere = { siteId: string; path: string; from: number; to: number; device?: string | null };

/** `clicks` of GET /api/v1/content/page: the page's mapped page views and its most clicked elements. */
export interface PageClicks {
  views: number;
  elements: MapElement[];
}

/** Copies maps_on and map_sample from a PATCH body onto `next`, or returns the error to answer. */
export function patchMaps(b: Record<string, unknown>, next: Site): string | null {
  if (b.maps_on !== undefined) next.maps_on = b.maps_on ? 1 : 0;
  if (b.map_sample !== undefined) {
    const n = Number(b.map_sample);
    if (!Number.isInteger(n) || n < 1 || n > 100) return 'Enter the share of page views as a whole percent from 1 to 100';
    next.map_sample = n;
  }
  return null;
}

export const pageMapsPart: CorePart = {
  siteTables: ['page_maps'],
  // No visitor id on a row, so erasing a person has nothing to remove here. Kept 90 days, like vitals.
  retention: (db, cutoff, now) => [db.prepare('DELETE FROM page_maps WHERE ts < ?').bind(Math.max(cutoff, now - MAP_DAYS * DAY))],
  patch: patchMaps,
  columns: (b, _site, next) =>
    (['maps_on', 'map_sample'] as const).filter((k) => b[k] !== undefined).map((k): [string, unknown] => [k, next[k] ?? null]),
  definitions: {
    click_maps:
      'Click maps (sites.maps_on, off by default) store one row per sampled page view: the viewport width, the document height, the deepest scroll and up to 50 clicks. A click is x in thousandths of the viewport width, y in px from the top of the page, the element as tag.class, and its visible text (40 characters, masked text left out). No visitor or session id. Kept 90 days. Pages on the never-record list get none. clicks in get_content counts clicks per element over the last 28 days, whatever weeks is; share is the mapped page views with at least one click on the element, divided by all mapped page views.',
    scroll:
      'Scroll depth is how far down the page the bottom of the screen reached, as a percent of the page height. Sites with page speed on store it on the page speed row of each page load; pages reached by a single-page move get it only from click maps. median is the middle value; reached_25 to reached_100 are the shares of page loads that got at least that far.',
  },
};
