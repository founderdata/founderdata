// JavaScript errors without recording, core part (round 7, lane errors; docs/API.md "Errors", docs/PRIVACY.md
// "Errors"): the config the pageview answer carries as cfg.e, the errors rows of the ping and the fingerprint that
// groups them into issues. Pro reads the rows into issues (pro/worker/errors.ts); the recordings code meets them through
// the same fingerprint.
//
// A site catches errors when it turns on Catch JavaScript errors (sites.errors_on) or records visits, which caught them
// already. The ping of a page view carries its errors in `a.e` (at most 5, each with its stack frames as `k`); each
// distinct error becomes one row with the times it happened as `n`. Pages on the never-record list keep theirs out.
import type { CorePart } from './core-parts';
import type { Site } from './env';
import type { ExportTable } from './export';
import { normalizePath } from './collect';
import { isSkipped, skipList } from './recording';
import { parseUA } from './lib/ua';

/** Days an errors row is kept (docs/PRIVACY.md "Errors"), and the longest period an issue looks back over. */
export const ERRORS_DAYS = 90;
/** Errors of one page view the Worker keeps, as the tracker sends them. */
export const MAX_PAGE_ERRORS = 5;
const DAY = 86_400_000;

/** Whether the site keeps errors at all: Catch JavaScript errors on, or Record visits on (recordings caught them already). */
export function catchesErrors(site: Pick<Site, 'errors_on' | 'record_visits'>): boolean {
  return !!(site.errors_on || site.record_visits);
}

/**
 * `cfg.e` of the pageview answer: 1 when the tracker should catch errors on every visit, else undefined. Catch
 * JavaScript errors turns it on. Record visits turns it on too, except with Wait for consent: then errors leave only
 * with a recording, after consent, as before round 7. A visit from a hosting network gets none (no first sighting, so
 * its errors could never raise a new-error alert).
 */
export function errorsConfig(site: Pick<Site, 'errors_on' | 'record_visits' | 'record_consent'>, datacenter: 0 | 1 = 0): 1 | undefined {
  if (datacenter) return undefined;
  return site.errors_on || (site.record_visits && !site.record_consent) ? 1 : undefined;
}

/**
 * Personal data out of free text: email addresses, phone numbers, runs of 6 or more digits and runs of 16 or more
 * letters and digits mixed (tokens, keys) become `[removed]`. An error message can quote what someone typed ("No
 * account for anna@example.com") or a token from a URL, so it is scrubbed before storing.
 */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[removed]')
    .replace(/\+?\(?\d[\d ().-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[removed]' : m))
    .replace(/(?<![A-Za-z0-9])(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{16,}(?![A-Za-z0-9])/g, '[removed]')
    .replace(/\d{6,}/g, '[removed]');
}

/** A message on one line, without the "Uncaught " Chrome puts in front, 200 characters. Not scrubbed. */
function oneLine(m: string): string {
  return m.replace(/\s+/g, ' ').trim().replace(/^Uncaught (?:\(in promise\) )?/, '').slice(0, 200);
}

/** A message as stored: one line, without the "Uncaught " Chrome puts in front, 200 characters, scrubbed. */
export function cleanMessage(m: unknown): string {
  if (typeof m !== 'string') return '';
  return scrub(oneLine(m)).slice(0, 200);
}

/** A file without its query or hash: "https://a.example/app.js?v=3:12" is "https://a.example/app.js:12". */
const noQuery = (s: string) => s.replace(/[?#][^:\s)]*/g, '');

export interface Frame {
  file: string;
  line: number;
  col: number;
  fn: string | null;
}

/** Stack frames as the tracker sends them (`k`): up to 3 lines of "file:line:col fn". Anything else is dropped. */
export function parseFrames(k: unknown): Frame[] {
  if (typeof k !== 'string') return [];
  const out: Frame[] = [];
  for (const raw of k.slice(0, 600).split('\n')) {
    const m = /^(\S+?):(\d{1,7}):(\d{1,7})(?: (.{1,80}))?$/.exec(raw.trim());
    if (!m) continue;
    const fn = m[4]?.trim() ? scrub(m[4].trim()).slice(0, 60) : null;
    out.push({ file: noQuery(m[1]).slice(0, 150), line: Number(m[2]), col: Number(m[3]), fn });
    if (out.length === 3) break;
  }
  return out;
}

/** Frames back to the stored text: one per line, 300 characters at most; null for none. */
export function framesText(frames: Frame[]): string | null {
  const text = frames.map((f) => `${f.file}:${f.line}:${f.col}${f.fn ? ` ${f.fn}` : ''}`).join('\n');
  return text ? text.slice(0, 300) : null;
}

/**
 * A script's file the same across deploys: the path without origin and query, and without a build hash such as
 * "index-B3kZ9a1x.js", "index-DkLmNoPq.js" or "main.3f9a2b1c.chunk.js", so one bug keeps one issue when the bundle is
 * rebuilt. A hash is a segment after "-" or "." and before the extension with 6 or more characters and a digit, or 8 or
 * more with upper and lower case letters; "react-dom.production.min.js" keeps every part.
 */
export function fileKey(file: string | null | undefined): string {
  if (!file) return '';
  return noQuery(file)
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '')
    .replace(/[-.](?:(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{6,}|(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{8,})(?=\.)/g, '');
}

/**
 * A message with what changes from one occurrence to the next taken out: URLs and quoted text, then ids (UUIDs, emails,
 * prefixed ids such as "pi_3Nx4k9a2eZvKYlo2", codes such as "ORD-8841-AB", tokens of 6 or more letters and digits
 * mixed), then numbers of any length. It reads the message as sent, before the scrub, so "Order 1234" and
 * "Order 1234567" stay one issue.
 */
export function normalizeMessage(message: string): string {
  const id = '(?<![A-Za-z0-9_-])';
  const end = '(?![A-Za-z0-9_-])';
  return message
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '<url>')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '<str>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<id>')
    .replace(/(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi, '<id>')
    .replace(new RegExp(`${id}[a-z]+_(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{8,}${end}`, 'g'), '<id>')
    .replace(new RegExp(`${id}(?=[A-Za-z0-9-]{6})(?=[A-Za-z-]*\\d)(?=[\\d-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+${end}`, 'g'), '<id>')
    .replace(/(?<![A-Za-z0-9])(?:0x)?(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{6,}(?![A-Za-z0-9])/g, '<id>')
    .replace(/\+?\(?\d[\d ().-]{6,}\d/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '<n>' : m))
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** cyrb53: a fast 53-bit string hash. Not for secrets; it only has to spread fingerprints. */
function hash53(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The issue an error belongs to: 12 hex characters (plan S12). A hash of the normalized message and the top stack
 * frame's file and function, else the source file. "Cannot read 'a' of user 41" and "... of user 42" from the same
 * function share one; the same message from two functions makes two.
 */
export function fingerprint(message: string, source: string | null, stack: string | null): string {
  const top = parseFrames(stack)[0];
  const where = top ? `${fileKey(top.file)} ${top.fn ?? ''}` : fileKey(source);
  return hash53(`${normalizeMessage(oneLine(message))}\n${where.trim()}`).toString(16).padStart(14, '0').slice(-12);
}

/** A random row id: 53 bits, so two errors of one millisecond never share a key. */
const rowId = () => {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  return (a & 0x1fffff) * 4294967296 + b;
};

interface PageError {
  fp: string;
  ts: number;
  message: string;
  source: string | null;
  stack: string | null;
  n: number;
}

/**
 * The page's errors from the ping's activity `a` ({p, s, e: [{t, m, s, k}]}), grouped by fingerprint in the order they
 * happened. `now` bounds the times: an error is placed at the page's start plus its offset, when that is in the last day.
 */
export function pageErrors(a: unknown, now: number): { path: string | null; errors: PageError[] } {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { path: null, errors: [] };
  const x = a as { p?: unknown; s?: unknown; e?: unknown };
  const start = typeof x.s === 'number' && Number.isFinite(x.s) ? x.s : null;
  const byFp = new Map<string, PageError>();
  for (const e of Array.isArray(x.e) ? x.e.slice(-MAX_PAGE_ERRORS) : []) {
    if (!e || typeof e !== 'object') continue;
    const message = cleanMessage(e.m);
    if (!message) continue;
    const source = typeof e.s === 'string' && e.s.trim() ? noQuery(e.s.trim()).slice(0, 200) : null;
    const stack = framesText(parseFrames(e.k));
    // The fingerprint reads the message as sent: the scrub would split "Order 1234" from "Order 1234567".
    const fp = fingerprint(e.m, source, stack);
    const at = start !== null && typeof e.t === 'number' && e.t >= 0 ? start + Math.round(e.t) : NaN;
    const ts = at >= now - DAY && at <= now ? at : now;
    const seen = byFp.get(fp);
    if (seen) seen.n++;
    else byFp.set(fp, { fp, ts, message, source, stack, n: 1 });
  }
  const path = typeof x.p === 'string' && x.p.startsWith('/') ? normalizePath(x.p.split(/[?#]/)[0]) : null;
  return { path, errors: [...byFp.values()] };
}

/**
 * The errors rows of the page activity `a` a ping carries: one per distinct error, at most 5; none when the site does
 * not catch errors or the page is on the never-record list. Each row takes its visitor id from the session, like the
 * activity row, so a ping of a visit the Worker never saw writes nothing.
 */
export function errorStatements(db: D1Database, site: Site, a: unknown, sid: string, path: string, ua: string, now: number): D1PreparedStatement[] {
  if (!catchesErrors(site)) return [];
  const page = pageErrors(a, now);
  if (!page.errors.length) return [];
  const where = page.path ?? path;
  if (isSkipped(where, skipList(site.record_skip))) return [];
  const { device, browser } = parseUA(ua);
  return page.errors.flatMap((e) => [
    db
      .prepare(
        `INSERT INTO errors (site_id, ts, id, fp, session_id, visitor_id, path, message, source, stack, n, device, browser, datacenter)
         SELECT ?1, ?2, ?3, ?4, ?5, visitor_id, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datacenter FROM sessions WHERE site_id = ?1 AND id = ?5`,
      )
      .bind(site.id, e.ts, rowId(), e.fp, sid, where, e.message, e.source, e.stack, e.n, device, browser),
    // The issue's first sighting (migration 0098): 1 row the first time, nothing after. Hosting networks do not set it.
    db
      .prepare(
        `INSERT OR IGNORE INTO error_first (site_id, fp, first_seen)
         SELECT ?1, ?2, ?3 FROM sessions WHERE site_id = ?1 AND id = ?4 AND datacenter = 0`,
      )
      .bind(site.id, e.fp, e.ts, sid),
  ]);
}

/**
 * Whether the page activity of a ping belongs to a recorded visit, so collect.ts stores its `activity` row. The script
 * marks it with `r: 1` once the visit records; clicks only ever go with a recording. A site with Record visits on sends
 * errors for every visit (cfg.e), and those of a visit that is not recorded stay in `errors` only.
 */
export function recordedActivity(a: unknown): boolean {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const x = a as { r?: unknown; c?: unknown };
  return x.r === 1 || (Array.isArray(x.c) && x.c.length > 0);
}

const iso = (ms: number) => new Date(ms).toISOString();

const errorsExport: ExportTable = {
  columns: ['time', 'issue', 'message', 'source', 'stack', 'times', 'path', 'device', 'browser', 'session_id', 'visitor_id'],
  chunk: (ctx, cur, n) => {
    const after = cur ? ' AND (ts > ? OR (ts = ? AND id > ?))' : '';
    return ctx.db
      .prepare(
        `SELECT ts, id, fp, message, source, stack, n, path, device, browser, session_id, visitor_id FROM errors
         WHERE site_id = ? AND ts >= ? AND ts < ?${after} ORDER BY ts, id LIMIT ${n}`,
      )
      .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...(cur ? [cur.ts, cur.ts, Number(cur.id) || 0] : []));
  },
  cells: (r) => [iso(r.ts), r.fp, r.message, r.source, r.stack, r.n, r.path, r.device, r.browser, r.session_id, r.visitor_id],
  cursor: (r) => ({ ts: r.ts, id: String(r.id) }),
  scrub: [],
};

/** errors and error_issues: deletion with the site, 90 days of rows, erase with the person, errors_on, export, definition. */
export const errorsPart: CorePart = {
  siteTables: ['errors', 'error_issues', 'error_first'],
  retention: (db, cutoff, now) => {
    const cut = Math.max(cutoff, now - ERRORS_DAYS * DAY);
    return [
      db.prepare('DELETE FROM errors WHERE ts < ?').bind(cut),
      // An issue's first sighting goes once none of its errors rows is left. The subquery runs once for the table.
      db.prepare('DELETE FROM error_first WHERE first_seen < ? AND (site_id, fp) NOT IN (SELECT site_id, fp FROM errors)').bind(cut),
    ];
  },
  erase: (db, siteId, ids) => [
    db.prepare(`DELETE FROM errors WHERE site_id = ? AND visitor_id IN (${ids.map(() => '?').join(', ')})`).bind(siteId, ...ids),
  ],
  patch: (b, next) => {
    if (b.errors_on !== undefined) next.errors_on = b.errors_on ? 1 : 0;
    return null;
  },
  columns: (b, _site, next) => ('errors_on' in b ? [['errors_on', next.errors_on ?? 0]] : []),
  exports: { errors: errorsExport },
  definitions: {
    errors:
      'JavaScript errors (Pro, get_recordings views errors and error), caught on sites with Catch JavaScript errors or Record visits on. An issue is a fingerprint: the message as sent with URLs, quoted text, ids (UUIDs, emails, prefixed ids, codes, words of 6 or more letters and digits mixed) and numbers taken out, plus the top stack frame\'s file (without its build hash) and function, else the source file. events counts errors (one page view can count several), people distinct visitor ids, sessions distinct visits, customers the people who paid (stitched by user id), mrr their monthly revenue now. status: open, resolved, ignored, or regressed (resolved, then seen again after resolving). An alert_rules new_error rule fires for a new issue and, once per resolve, for a regressed one (regressed true, resolved_at and first_seen in the alert; from is when it came back). new: first seen in the last 24 hours (first_seen is kept while the issue has errors rows). Times are ISO strings. series: events per day of the 14 days (series_days) ending at series_to, whatever the period. kind cross_origin: "Script error.", from a script on another domain. customers_recorded (one issue): paying customers with a recorded visit that hit it. Visits from hosting networks and bots are left out unless the site shows them. Messages keep 200 characters with emails, phone numbers, runs of 6 or more digits and runs of 16 or more letters and digits mixed replaced; frames keep file, line, column and function, at most 3. Kept 90 days.',
  },
};
