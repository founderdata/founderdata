import type { Hono } from 'hono';
import type { AppEnv, Site } from './env';
import { utcDay } from './identity';
import { randomId } from './lib/crypto';
import { dayInTz } from './lib/time';
import { IMPORT_KINDS, MAX_LABELS, MAX_LABEL_LENGTH, PLAUSIBLE_TABLES, validDay, type ImportKind } from '../shared/plausible-import';
import type { BreakdownRow } from './stats';
import { webHostSql } from '../shared/platform';

/**
 * History imported from another tool (docs/GUIDE.md, "Import from Plausible"). The dashboard reads the CSV files in the
 * browser and sends daily aggregates, so the Worker never parses a CSV:
 *
 *   GET    /api/sites/:id/imports                list, today's allowance, and the site's first native day
 *   POST   /api/sites/:id/imports                { source, from, to, files } starts one; answers { id }
 *   GET    /api/sites/:id/imports/:iid/progress  the `kind|day` keys stored so far, to resume
 *   POST   /api/sites/:id/imports/datafast/get   { key, path, query } forwards one DataFast API read (key not stored)
 *   POST   /api/sites/:id/imports/:iid/rows      { rows: [{ kind, day, data }] } at most 100 rows, 400 KB
 *   POST   /api/sites/:id/imports/:iid/finish    makes the import count in the stats
 *   DELETE /api/sites/:id/imports/:iid           deletes the import and its rows
 *
 * Imported rows live in imported_daily (migration 0038) and never touch sessions, events or payments. A read adds the
 * imported days that come before the site's first native web visit, and nothing else: native data wins on any day it
 * has. Revenue, conversion and visitor journeys stay native. With a dashboard filter on, no imported day counts,
 * because an imported day has no visits to filter.
 *
 * Cost: a stored day-row is 1 D1 row written (no secondary index). The write cap of the tracker (budget.ts) does not
 * see these rows, so an import cannot drop live events. They have an allowance of their own, 20,000 rows a UTC day for
 * the whole deployment (IMPORT_DAILY_ROWS), kept in site_usage under the id `import:*`. That is the 20% of the free
 * plan the tracker's pool leaves free. A chunk past the allowance is refused with 429 and can be sent again after
 * 00:00 UTC.
 */

export const IMPORT_USAGE_ID = 'import:*';
export const IMPORT_DAILY_ROWS = 20_000;
export const MAX_CHUNK_ROWS = 100;
export const MAX_CHUNK_BYTES = 400_000;
const MAX_IMPORTS = 10;
const MAX_DAYS = 3660;
const MAX_MONEY = 1e12;
/** What the DataFast proxy forwards. */
const DATAFAST_PATHS = /^analytics\/(timeseries|metadata|referrers|pages|countries|devices|browsers|operating-systems|campaigns)$/;

const KINDS = new Set<string>(IMPORT_KINDS);
const DAY_MS = 86_400_000;

const dayAdd = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

function allowance(env: { IMPORT_DAILY_ROWS?: string }): number {
  const n = Number(String(env.IMPORT_DAILY_ROWS ?? '').replace(/[_,\s]/g, ''));
  return Number.isInteger(n) && n > 0 ? n : IMPORT_DAILY_ROWS;
}

// ---------- reading

export interface ImportInfo {
  /** First day with native web data (site timezone), or null when the site has none: imported days then all count. */
  firstNative: string | null;
  /** First day with a native payment (site timezone), or null. Imported revenue stops the day before it, so no day counts money twice. */
  firstPaid: string | null;
}

/** A window of imported days. `revenueTo` ends the revenue earlier than `to`: at the day before the first native payment. */
export interface ImportedSpan {
  from: string;
  to: string;
  revenueTo?: string;
}

/** The row importInfo reads; `importRow` reads it by site id alone, so a route can start it before it loads the site. */
export interface ImportInfoRow {
  has: number;
  first: number | null;
  paid: number | null;
}

/** null when the site has no finished import: then no read changes. One indexed lookup. */
export async function importInfo(db: D1Database, site: Pick<Site, 'id' | 'timezone'>): Promise<ImportInfo | null> {
  return importInfoOf(await importRow(db, site.id), site);
}

export function importInfoOf(row: ImportInfoRow | null, site: Pick<Site, 'timezone'>): ImportInfo | null {
  if (!row?.has) return null;
  return {
    firstNative: row.first == null ? null : dayInTz(Number(row.first), site.timezone),
    firstPaid: row.paid == null ? null : dayInTz(Number(row.paid), site.timezone),
  };
}

/** The statement importRow runs, for a caller that puts it in its own batch (query.ts). */
export function importRowStatement(db: D1Database, siteId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM imports WHERE site_id = ?1 AND status = 'done') AS has,
              (SELECT MIN(started_at) FROM sessions WHERE site_id = ?1 AND ${webHostSql('hostname')}
               AND EXISTS (SELECT 1 FROM imports WHERE site_id = ?1 AND status = 'done')) AS first,
              (SELECT MIN(ts) FROM payments WHERE site_id = ?1 AND EXISTS (SELECT 1 FROM imports WHERE site_id = ?1 AND status = 'done')) AS paid`,
    )
    .bind(siteId);
}

export function importRow(db: D1Database, siteId: string): Promise<ImportInfoRow | null> {
  return importRowStatement(db, siteId).first<ImportInfoRow>();
}

/** The imported days a window [from, to) shows: its days, up to the day before the first native one. */
export function importedSpan(info: ImportInfo, site: Site, win: { from: number; to: number }): ImportedSpan | null {
  const from = dayInTz(win.from, site.timezone);
  let to = dayInTz(win.to - 1, site.timezone);
  if (info.firstNative && dayAdd(info.firstNative, -1) < to) to = dayAdd(info.firstNative, -1);
  if (from > to) return null;
  // Revenue also stops before the first native payment: Stripe history, App Store sales and webhooks can predate the first visit.
  const revenueTo = info.firstPaid && dayAdd(info.firstPaid, -1) < to ? dayAdd(info.firstPaid, -1) : undefined;
  return { from, to, ...(revenueTo ? { revenueTo } : {}) };
}

const DONE = `d.import_id IN (SELECT id FROM imports WHERE site_id = d.site_id AND status = 'done')`;

export interface ImportedTotals {
  visitors: number;
  sessions: number;
  /** Sessions of days whose source reports bounces and duration; DataFast days do not, and stay out of those two rates. */
  rateSessions: number;
  pageviews: number;
  bounces: number;
  /** Total visit seconds. */
  duration: number;
  /** Revenue of the imported days (DataFast), minor units of the site currency, and payments. Shown apart from native revenue. */
  revenue: number;
  payments: number;
  /** Imported revenue per day, for the chart's "Include imported history" line. Only days that have some. */
  revenueDays: { day: string; revenue: number; payments: number }[];
  /** One entry per imported day: the chart's input. */
  days: { day: string; visitors: number; pageviews: number }[];
}

/** An imported kind and label a dashboard filter maps to. Only a filter on one dimension can be answered. */
export interface ImportFilter {
  kind: ImportKind;
  /** The imported label; the empty string is "none" (direct visits on source). */
  label: string;
}

const FILTER_KIND: Record<string, ImportKind> = {
  source: 'source',
  utm_campaign: 'campaign',
  utm_term: 'keyword',
  country: 'country',
  device: 'device',
  browser: 'browser',
  os: 'os',
  entry_page: 'entry_page',
  exit_page: 'exit_page',
  page: 'page',
  goal: 'goal',
};

/**
 * The imported rows that answer a filter. Imported days hold one panel per kind and day, not visits, so a filter on
 * exactly one dimension (source=X, country=DE) is answered from that panel's label: visitors and pageviews, no sessions,
 * bounce rate or duration. Two filters, or a dimension no import holds, get no imported day.
 */
export function importFilter(filters: Record<string, string | undefined>): ImportFilter | null {
  const keys = Object.keys(filters).filter((k) => filters[k] !== undefined);
  if (keys.length !== 1) return null;
  const kind = FILTER_KIND[keys[0]];
  return kind ? { kind, label: filters[keys[0]] as string } : null;
}

export async function importedTotals(db: D1Database, site: Site, span: ImportedSpan, flt: ImportFilter | null = null): Promise<ImportedTotals> {
  const rTo = span.revenueTo ?? span.to;
  const t: ImportedTotals = { visitors: 0, sessions: 0, rateSessions: 0, pageviews: 0, bounces: 0, duration: 0, revenue: 0, payments: 0, revenueDays: [], days: [] };
  if (flt) {
    const res = await db
      .prepare(
        `SELECT d.day, SUM(json_extract(j.value, '$[0]')) AS v, SUM(json_extract(j.value, '$[1]')) AS p
         FROM imported_daily d, json_each(d.data) j
         WHERE d.site_id = ? AND d.kind = ? AND d.day >= ? AND d.day <= ? AND j.key = ? AND ${DONE} GROUP BY d.day ORDER BY d.day`,
      )
      .bind(site.id, flt.kind, span.from, span.to, flt.label)
      .all<{ day: string; v: number; p: number }>();
    for (const r of res.results) {
      t.visitors += r.v ?? 0;
      t.pageviews += r.p ?? 0;
      t.days.push({ day: r.day, visitors: r.v ?? 0, pageviews: r.p ?? 0 });
    }
    if (flt.kind === 'source') {
      const rev = await db
        .prepare(
          `SELECT d.day, SUM(json_extract(j.value, '$[0]')) AS r, SUM(json_extract(j.value, '$[1]')) AS n
           FROM imported_daily d, json_each(d.data) j
           WHERE d.site_id = ? AND d.kind = 'source_revenue' AND d.day >= ? AND d.day <= ? AND j.key = ? AND ${DONE} GROUP BY d.day ORDER BY d.day`,
        )
        .bind(site.id, span.from, rTo, flt.label)
        .all<{ day: string; r: number | null; n: number | null }>();
      addRevenue(t, rev.results);
    }
    return t;
  }
  const [res, rev] = await db.batch([
    db
      .prepare(
        `SELECT d.day, SUM(json_extract(d.data, '$.v')) AS v, SUM(json_extract(d.data, '$.p')) AS p, SUM(json_extract(d.data, '$.s')) AS s,
                SUM(json_extract(d.data, '$.b')) AS b, SUM(json_extract(d.data, '$.d')) AS dur,
                SUM(CASE WHEN json_extract(d.data, '$.n') = 1 THEN 0 ELSE json_extract(d.data, '$.s') END) AS rs
         FROM imported_daily d WHERE d.site_id = ? AND d.kind = 'visitors' AND d.day >= ? AND d.day <= ? AND ${DONE} GROUP BY d.day ORDER BY d.day`,
      )
      .bind(site.id, span.from, span.to),
    db
      .prepare(
        `SELECT d.day, SUM(json_extract(d.data, '$.r')) AS r, SUM(json_extract(d.data, '$.n')) AS n
         FROM imported_daily d WHERE d.site_id = ? AND d.kind = 'revenue' AND d.day >= ? AND d.day <= ? AND ${DONE} GROUP BY d.day ORDER BY d.day`,
      )
      .bind(site.id, span.from, rTo),
  ]);
  for (const r of res.results as { day: string; v: number; p: number; s: number; b: number; dur: number; rs: number }[]) {
    t.visitors += r.v ?? 0;
    t.sessions += r.s ?? 0;
    t.rateSessions += r.rs ?? 0;
    t.pageviews += r.p ?? 0;
    t.bounces += r.b ?? 0;
    t.duration += r.dur ?? 0;
    t.days.push({ day: r.day, visitors: r.v ?? 0, pageviews: r.p ?? 0 });
  }
  addRevenue(t, rev.results as { day: string; r: number | null; n: number | null }[]);
  return t;
}

/** Sum imported revenue rows into the totals and keep the days that have some. */
function addRevenue(t: ImportedTotals, rows: { day: string; r: number | null; n: number | null }[]) {
  for (const r of rows) {
    const revenue = Number(r.r ?? 0);
    const payments = Number(r.n ?? 0);
    t.revenue += revenue;
    t.payments += payments;
    if (revenue || payments) t.revenueDays.push({ day: r.day, revenue, payments });
  }
}

/** Breakdown dimension -> imported kind. */
const DIM_KIND: Record<string, ImportKind> = {
  source: 'source',
  campaign: 'campaign',
  keyword: 'keyword',
  page: 'page',
  entry_page: 'entry_page',
  exit_page: 'exit_page',
  country: 'country',
  device: 'device',
  browser: 'browser',
  os: 'os',
  goal: 'goal',
};

/**
 * Add imported days to a breakdown. Visitors are summed per day, so a visitor who came on two days counts twice.
 * Rows that are not a value to filter by (App Store, no source) stay last and are never cut.
 */
export async function withImported(
  db: D1Database,
  site: Site,
  win: { from: number; to: number },
  dim: string,
  rows: BreakdownRow[],
  limit: number,
  only: ImportFilter | null = null,
): Promise<BreakdownRow[]> {
  const kind = DIM_KIND[dim];
  // A filter on another dimension cannot be answered from this panel: native rows only.
  if (only && only.kind !== kind) return rows;
  if (!kind) return rows;
  const info = await importInfo(db, site);
  const span = info && importedSpan(info, site, win);
  if (!span) return rows;
  const res = await db
    .prepare(
      `SELECT j.key AS label, SUM(json_extract(j.value, '$[0]')) AS visitors, SUM(json_extract(j.value, '$[1]')) AS pageviews
       FROM imported_daily d, json_each(d.data) j
       WHERE d.site_id = ? AND d.kind = ? AND d.day >= ? AND d.day <= ? AND ${DONE}${only ? ' AND j.key = ?' : ''}
       GROUP BY j.key ORDER BY visitors DESC LIMIT ${Math.min(500, limit) * 2}`,
    )
    .bind(site.id, kind, span.from, span.to, ...(only ? [only.label] : []))
    .all<{ label: string; visitors: number; pageviews: number }>();
  if (!res.results.length) return rows;
  // DataFast revenue per source over the imported days, kept apart from native revenue (importedRevenue on the row).
  const importedRev = new Map<string, { revenue: number; payments: number }>();
  if (kind === 'source') {
    const rv = await db
      .prepare(
        `SELECT j.key AS label, SUM(json_extract(j.value, '$[0]')) AS revenue, SUM(json_extract(j.value, '$[1]')) AS payments
         FROM imported_daily d, json_each(d.data) j
         WHERE d.site_id = ? AND d.kind = 'source_revenue' AND d.day >= ? AND d.day <= ? AND ${DONE}${only ? ' AND j.key = ?' : ''} GROUP BY j.key`,
      )
      .bind(site.id, span.from, span.revenueTo ?? span.to, ...(only ? [only.label] : []))
      .all<{ label: string; revenue: number; payments: number }>();
    for (const r of rv.results) importedRev.set(r.label, { revenue: Number(r.revenue ?? 0), payments: Number(r.payments ?? 0) });
  }
  const special = rows.filter((r) => r.appStore || r.noVisit);
  const list = rows.filter((r) => !r.appStore && !r.noVisit);
  const byLabel = new Map(list.map((r) => [r.label, r]));
  for (const res1 of res.results) {
    // An empty label is a visit with no source: native rows call it null.
    const r = { ...res1, label: res1.label === '' ? null : res1.label };
    const ir = importedRev.get(res1.label);
    const own = byLabel.get(r.label);
    if (own) {
      if (ir) {
        own.importedRevenue = (own.importedRevenue ?? 0) + ir.revenue;
        own.importedPayments = (own.importedPayments ?? 0) + ir.payments;
      }
      own.visitors += r.visitors ?? 0;
      if (own.pageviews !== undefined || r.pageviews) own.pageviews = (own.pageviews ?? 0) + (r.pageviews ?? 0);
    } else {
      const row: BreakdownRow = { label: r.label, visitors: r.visitors ?? 0, pageviews: r.pageviews ?? 0, revenue: 0, customers: 0, extra: null, ...(ir ? { importedRevenue: ir.revenue, importedPayments: ir.payments } : {}) };
      byLabel.set(r.label, row);
      list.push(row);
    }
  }
  list.sort((a, b) => b.visitors - a.visitors);
  return [...list.slice(0, limit), ...special];
}

// ---------- writing

interface ImportRow {
  id: string;
  site_id: string;
  source: string;
  status: 'importing' | 'done';
  from_day: string;
  to_day: string;
  rows: number;
  files: string | null;
  created_at: number;
  finished_at: number | null;
}

const publicImport = (r: ImportRow) => ({
  id: r.id,
  source: r.source,
  status: r.status,
  from: r.from_day,
  to: r.to_day,
  rows: r.rows,
  files: r.files ? JSON.parse(r.files) : [],
  created_at: r.created_at,
  finished_at: r.finished_at,
});

const isInt = (n: unknown, max = 1e9): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;

/** The cleaned data of a day-row as JSON, or an error message. Bounds the work a chunk can cost. */
function cleanData(kind: ImportKind, data: unknown): string | { error: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'data must be an object' };
  if (kind === 'visitors') {
    const o = data as Record<string, unknown>;
    // n: 1 marks a source that reports no bounces or visit seconds (DataFast): b and d may then be left out.
    const keys = o.n === 1 ? ['v', 'p', 's'] : ['v', 'p', 's', 'b', 'd'];
    for (const k of keys) if (!isInt(o[k])) return { error: `visitors data needs a whole number in ${k}` };
    return JSON.stringify(o.n === 1 ? { v: o.v, p: o.p, s: o.s, b: 0, d: 0, n: 1 } : { v: o.v, p: o.p, s: o.s, b: o.b, d: o.d });
  }
  if (kind === 'revenue') {
    const o = data as Record<string, unknown>;
    if (!isInt(o.r, MAX_MONEY) || !isInt(o.n)) return { error: 'revenue data needs whole numbers in r (minor units) and n (payments)' };
    return JSON.stringify({ r: o.r, n: o.n });
  }
  const out: Record<string, [number, number]> = {};
  let n = 0;
  for (const [label, val] of Object.entries(data as Record<string, unknown>)) {
    if (++n > MAX_LABELS) return { error: `at most ${MAX_LABELS} labels a day` };
    if (label.length > MAX_LABEL_LENGTH) return { error: 'a label is longer than 300 characters' };
    const max = kind === 'source_revenue' ? MAX_MONEY : 1e9;
    if (!Array.isArray(val) || val.length !== 2 || !isInt(val[0], max) || !isInt(val[1])) {
      return { error: kind === 'source_revenue' ? 'each label maps to [minor units, payments]' : 'each label maps to [visitors, pageviews]' };
    }
    out[label] = [val[0], val[1]];
  }
  return JSON.stringify(out);
}

async function getImport(db: D1Database, siteId: string, id: string) {
  return db.prepare('SELECT * FROM imports WHERE id = ? AND site_id = ?').bind(id, siteId).first<ImportRow>();
}

async function usedToday(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare('SELECT rows FROM site_usage WHERE site_id = ? AND day = ?').bind(IMPORT_USAGE_ID, utcDay(now)).first<{ rows: number }>();
  return r?.rows ?? 0;
}

export function registerImportRoutes(app: Hono<AppEnv>) {
  app.get('/api/sites/:id/imports', async (c) => {
    const site = c.get('site');
    const now = Date.now();
    const [list, first, used] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM imports WHERE site_id = ? ORDER BY from_day').bind(site.id).all<ImportRow>(),
      c.env.DB.prepare(`SELECT MIN(started_at) AS t FROM sessions WHERE site_id = ? AND ${webHostSql('hostname')}`).bind(site.id).first<{ t: number | null }>(),
      usedToday(c.env.DB, now),
    ]);
    const limit = allowance(c.env);
    // An unfinished import reports how many day-rows are stored, so the dashboard can resume it after a reload.
    // Chunks are stored whole, so a stored count that lands on a chunk boundary says where to continue.
    const open = list.results.filter((i) => i.status === 'importing');
    const stored = new Map<string, number>();
    if (open.length) {
      const counts = await c.env.DB.prepare(`SELECT import_id, COUNT(*) AS n FROM imported_daily WHERE site_id = ? AND import_id IN (${open.map(() => '?').join(',')}) GROUP BY import_id`)
        .bind(site.id, ...open.map((i) => i.id))
        .all<{ import_id: string; n: number }>();
      for (const r of counts.results) stored.set(r.import_id, r.n);
    }
    return c.json({
      imports: list.results.map((i) => (i.status === 'importing' ? { ...publicImport(i), stored: stored.get(i.id) ?? 0 } : publicImport(i))),
      // Imported days from this day on are not shown: the site has its own data for them.
      native_from: first?.t == null ? null : dayInTz(first.t, site.timezone),
      allowance: { used, limit, resets_at: Date.parse(utcDay(now)) + DAY_MS },
      max_chunk_rows: MAX_CHUNK_ROWS,
      max_chunk_bytes: MAX_CHUNK_BYTES,
    });
  });

  app.post('/api/sites/:id/imports', async (c) => {
    const site = c.get('site');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    if (b.source !== 'plausible' && b.source !== 'datafast') return c.json({ error: 'source must be plausible or datafast' }, 400);
    if (!validDay(b.from) || !validDay(b.to) || b.from > b.to) return c.json({ error: 'from and to are days as YYYY-MM-DD, from first' }, 400);
    if ((Date.parse(b.to + 'T00:00:00Z') - Date.parse(b.from + 'T00:00:00Z')) / DAY_MS > MAX_DAYS) return c.json({ error: 'An import covers at most 10 years' }, 400);
    const files = Array.isArray(b.files)
      ? b.files.slice(0, 40).map((f: any) => ({
          name: String(f?.name ?? '').slice(0, 120),
          table: PLAUSIBLE_TABLES.includes(f?.table) ? f.table : null,
          rows: isInt(f?.rows, 1e9) ? f.rows : 0,
        }))
      : [];
    const existing = await c.env.DB.prepare('SELECT id, from_day, to_day FROM imports WHERE site_id = ?').bind(site.id).all<ImportRow>();
    if (existing.results.length >= MAX_IMPORTS) return c.json({ error: `A site can have ${MAX_IMPORTS} imports. Delete one first.` }, 400);
    const clash = existing.results.find((i) => i.from_day <= (b.to as string) && i.to_day >= (b.from as string));
    if (clash) return c.json({ error: `These days overlap an import of ${clash.from_day} to ${clash.to_day}. Delete that one first, or import a range that does not overlap it.` }, 409);
    const id = randomId(12);
    await c.env.DB.prepare(
      `INSERT INTO imports (id, site_id, source, status, from_day, to_day, rows, files, created_at) VALUES (?, ?, ?, 'importing', ?, ?, 0, ?, ?)`,
    )
      .bind(id, site.id, b.source, b.from, b.to, JSON.stringify(files), Date.now())
      .run();
    return c.json({ id });
  });

  app.post('/api/sites/:id/imports/:iid/rows', async (c) => {
    const site = c.get('site');
    const imp = await getImport(c.env.DB, site.id, c.req.param('iid'));
    if (!imp) return c.json({ error: 'not found' }, 404);
    if (imp.status !== 'importing') return c.json({ error: 'This import is finished.' }, 409);
    const text = await c.req.text();
    if (text.length > MAX_CHUNK_BYTES) return c.json({ error: `A chunk is at most ${MAX_CHUNK_BYTES / 1000} KB` }, 413);
    let body: { rows?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'The body is not JSON' }, 400);
    }
    if (!Array.isArray(body.rows) || !body.rows.length) return c.json({ error: 'rows must be a list' }, 400);
    if (body.rows.length > MAX_CHUNK_ROWS) return c.json({ error: `At most ${MAX_CHUNK_ROWS} rows in one request` }, 400);
    const stmts: D1PreparedStatement[] = [];
    for (const r of body.rows as { kind?: string; day?: string; data?: unknown }[]) {
      if (!r || !KINDS.has(r.kind as string)) return c.json({ error: 'unknown kind' }, 400);
      if (!validDay(r.day) || r.day < imp.from_day || r.day > imp.to_day) return c.json({ error: `A row is outside the import's days ${imp.from_day} to ${imp.to_day}` }, 400);
      const data = cleanData(r.kind as ImportKind, r.data);
      if (typeof data !== 'string') return c.json({ error: data.error }, 400);
      stmts.push(
        c.env.DB.prepare('INSERT OR REPLACE INTO imported_daily (site_id, kind, day, import_id, data) VALUES (?, ?, ?, ?, ?)').bind(site.id, r.kind, r.day, imp.id, data),
      );
    }
    const now = Date.now();
    const limit = allowance(c.env);
    const used = await usedToday(c.env.DB, now);
    if (used + stmts.length > limit) {
      return c.json(
        { error: `Today's import allowance is ${limit.toLocaleString('en-US')} rows and ${used.toLocaleString('en-US')} are used. Send the rest after 00:00 UTC.`, resets_at: Date.parse(utcDay(now)) + DAY_MS },
        429,
      );
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO site_usage (site_id, day, rows) VALUES (?1, ?2, ?3)
         ON CONFLICT (site_id) DO UPDATE SET rows = CASE WHEN day = excluded.day THEN rows + excluded.rows ELSE excluded.rows END, day = excluded.day`,
      ).bind(IMPORT_USAGE_ID, utcDay(now), body.rows.length),
    );
    await c.env.DB.batch(stmts);
    return c.json({ ok: true, stored: body.rows.length, used_today: used + body.rows.length, limit });
  });

  // The day-rows an import has stored, as `kind|day` keys: a DataFast run that was cut off skips these when it resumes.
  app.get('/api/sites/:id/imports/:iid/progress', async (c) => {
    const site = c.get('site');
    const imp = await getImport(c.env.DB, site.id, c.req.param('iid'));
    if (!imp) return c.json({ error: 'not found' }, 404);
    const res = await c.env.DB.prepare('SELECT kind, day FROM imported_daily WHERE site_id = ? AND import_id = ?').bind(site.id, imp.id).all<{ kind: string; day: string }>();
    return c.json({ keys: res.results.map((r) => `${r.kind}|${r.day}`) });
  });

  // One GET to the DataFast API for the browser when the browser cannot call datafa.st itself (CORS). The key comes in
  // the body, goes out as the Authorization header and is not stored, logged or cached. Only the analytics reads the
  // import needs, one page per request.
  app.post('/api/sites/:id/imports/datafast/get', async (c) => {
    const b = await c.req.json<{ key?: unknown; path?: unknown; query?: unknown }>().catch(() => ({}) as { key?: unknown; path?: unknown; query?: unknown });
    if (typeof b.key !== 'string' || !/^dft?_[\w-]{8,200}$/.test(b.key)) return c.json({ error: 'The key is a DataFast website key (df_...) or account token (dft_...)' }, 400);
    if (typeof b.path !== 'string' || !DATAFAST_PATHS.test(b.path)) return c.json({ error: 'path is not an analytics read the import uses' }, 400);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(b.query && typeof b.query === 'object' ? (b.query as Record<string, unknown>) : {}).slice(0, 12)) {
      if (/^[A-Za-z_]{1,20}$/.test(k) && typeof v === 'string' && v.length <= 100) q.set(k, v);
    }
    let res: Response;
    try {
      res = await fetch(`https://datafa.st/api/v1/${b.path}?${q}`, { headers: { authorization: `Bearer ${b.key}`, accept: 'application/json' } });
    } catch {
      return c.json({ status: 502, retry_after: null, body: { status: 'error', error: { message: 'DataFast could not be reached' } } });
    }
    const body = await res.json().catch(() => null);
    const retry = Number(res.headers.get('retry-after'));
    return c.json({ status: res.status, retry_after: Number.isFinite(retry) && retry > 0 ? retry : null, body }, 200, { 'cache-control': 'no-store' });
  });

  app.post('/api/sites/:id/imports/:iid/finish', async (c) => {
    const site = c.get('site');
    const imp = await getImport(c.env.DB, site.id, c.req.param('iid'));
    if (!imp) return c.json({ error: 'not found' }, 404);
    const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM imported_daily WHERE site_id = ? AND import_id = ?').bind(site.id, imp.id).first<{ n: number }>();
    if (!count?.n) return c.json({ error: 'No rows were stored for this import' }, 400);
    await c.env.DB.prepare(`UPDATE imports SET status = 'done', rows = ?, finished_at = ? WHERE id = ? AND site_id = ?`).bind(count.n, Date.now(), imp.id, site.id).run();
    return c.json(publicImport({ ...imp, status: 'done', rows: count.n, finished_at: Date.now() }));
  });

  app.delete('/api/sites/:id/imports/:iid', async (c) => {
    const site = c.get('site');
    const imp = await getImport(c.env.DB, site.id, c.req.param('iid'));
    if (!imp) return c.json({ error: 'not found' }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM imported_daily WHERE site_id = ? AND import_id = ?').bind(site.id, imp.id),
      c.env.DB.prepare('DELETE FROM imports WHERE id = ? AND site_id = ?').bind(imp.id, site.id),
    ]);
    return c.json({ ok: true });
  });
}
