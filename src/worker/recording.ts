// The site settings of Record visits and Remember visitors (migrations 0072, 0075 and 0076, docs/GUIDE.md "People and recordings (Pro)").
// Core stores them and the tracker reads them from the pageview answer (collect.ts trackerConfig). FounderData Pro
// draws the card that changes them and decides which visits to record.
import type { Site } from './env';

/** The columns PATCH /api/sites/:id takes for this feature. */
export const RECORDING_FIELDS = ['record_visits', 'record_sample', 'record_keep_days', 'record_daily_max', 'record_only_active', 'record_consent', 'record_skip', 'remember_visitors'] as const;
export type RecordingField = (typeof RECORDING_FIELDS)[number];

/** Days a recording can be kept. */
export const KEEP_DAYS = [7, 30, 90];
/** The highest "most visits a day" a site can set. */
export const MAX_DAILY = 100_000;
/** Pages that are never recorded: at most this many path prefixes, each up to SKIP_CHARS characters. */
export const MAX_SKIP = 20;
export const SKIP_CHARS = 100;

/**
 * The site's pages that are never recorded, from `record_skip` (one path prefix per line). The tracker and the recorder
 * get them as `cfg.rec.x` (docs/API.md, "Tracker config").
 */
export const skipList = (text: string | null | undefined): string[] => (text ? text.split('\n').filter(Boolean) : []);

/**
 * Whether `path` is one of the site's pages that are never recorded: the same path or one below it, so /dashboard skips
 * /dashboard and /dashboard/x but not /dashboards. The tracker and the recorder use the same rule.
 */
export function isSkipped(path: string | null | undefined, list: string[]): boolean {
  if (!path || !list.length) return false;
  const p = path.split(/[?#]/)[0];
  return list.some((x) => p === x || p.startsWith(x.endsWith('/') ? x : `${x}/`));
}

/**
 * Checks a list of pages that are never recorded: text with one path per line, or an array of paths. Trims each line,
 * drops empty lines, a trailing slash and repeats. Returns the text to store (null for an empty list) or the error.
 */
export function parseSkipList(v: unknown): { text: string | null } | { error: string } {
  if (v === null || v === '') return { text: null };
  const lines = typeof v === 'string' ? v.split(/\r?\n/) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  if (!lines || lines.length > 1000) return { error: 'Enter the pages as paths, one per line, such as /dashboard' };
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const show = line.length > 40 ? `${line.slice(0, 40)}...` : line;
    if (line[0] !== '/') return { error: `"${show}" needs to start with /, such as /dashboard` };
    if (line.length > SKIP_CHARS) return { error: `"${show}" is longer than ${SKIP_CHARS} characters` };
    if (/\s/.test(line)) return { error: `"${show}" has a space in it. Put each page on its own line` };
    if (/[?#]/.test(line)) return { error: `"${show}" has a ? or #. Enter the path only, such as /dashboard` };
    const path = line.replace(/\/+$/, '') || '/';
    if (!out.includes(path)) out.push(path);
  }
  if (out.length > MAX_SKIP) return { error: `Enter at most ${MAX_SKIP} pages` };
  return { text: out.length ? out.join('\n') : null };
}

/**
 * Copies the recording settings in a PATCH body onto `next`, or returns the error to answer. Switches take 0, 1, true or
 * false; the numbers must be whole and in range; `record_skip` follows parseSkipList.
 */
export function patchRecording(b: Record<string, unknown>, next: Site, now = Date.now()): string | null {
  // Turning Record visits on starts the count of visits since then (record_on_at, migration 0082).
  if (b.record_visits !== undefined && b.record_visits && !next.record_visits) next.record_on_at = now;
  for (const k of ['record_visits', 'record_only_active', 'record_consent', 'remember_visitors'] as const) {
    if (b[k] !== undefined) next[k] = b[k] ? 1 : 0;
  }
  if (b.record_sample !== undefined) {
    const n = Number(b.record_sample);
    if (!Number.isInteger(n) || n < 1 || n > 100) return 'Enter the share of visits as a whole percent from 1 to 100';
    next.record_sample = n;
  }
  if (b.record_keep_days !== undefined) {
    const n = Number(b.record_keep_days);
    if (!KEEP_DAYS.includes(n)) return 'Keep recordings for 7, 30 or 90 days';
    next.record_keep_days = n;
  }
  if (b.record_daily_max !== undefined) {
    const n = Number(b.record_daily_max);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY) return `Enter the most visits a day as a whole number from 1 to ${MAX_DAILY.toLocaleString('en-US')}`;
    next.record_daily_max = n;
  }
  if (b.record_skip !== undefined) {
    const skip = parseSkipList(b.record_skip);
    if ('error' in skip) return skip.error;
    next.record_skip = skip.text;
  }
  return null;
}

/**
 * The columns and values an UPDATE of the site row sets after patchRecording: those the body named, plus record_on_at
 * when the switch went on. Core's PATCH /api/sites/:id and Pro's PATCH /api/sites/:id/recording both use it.
 */
export function recordingColumns(b: Record<string, unknown>, site: Site, next: Site): [string, unknown][] {
  const cols: [string, unknown][] = RECORDING_FIELDS.filter((k) => k in b).map((k) => [k, next[k] ?? null]);
  if ((next.record_on_at ?? null) !== (site.record_on_at ?? null)) cols.push(['record_on_at', next.record_on_at ?? null]);
  return cols;
}
