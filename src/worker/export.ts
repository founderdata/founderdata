// CSV export of one site's raw rows (sessions, events, payments, subscriptions) and of any breakdown panel (docs/API.md,
// "CSV export"). Logged-in routes under /api/sites/:id/export/*. A response holds at most `limit` rows, read from D1 in
// chunks of CHUNK; when more remain it ends with a Link: rel="next" header, and the dashboard follows it.
import type { Context } from 'hono';
import { viewerSeesPersonalData } from './auth';
import type { AppEnv } from './env';
import { currencyDecimals } from './payments';
import { LAPSE_MS } from './subscriptions';
import { breakdown, filterSql, hasFilters, makeCtx, type Ctx } from './stats';
import { dayInTz, resolveRange, tzOffset } from './lib/time';
import { partExports } from './core-parts';

/** Rows per D1 query. */
const CHUNK = 1000;
/** Rows per response by default, and at most. Free-plan CPU (10 ms) fits about 5,000 rows of CSV. */
export const EXPORT_LIMIT = 5000;
export const EXPORT_MAX = 50_000;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with = + - @, a tab or a carriage return)
 * gets a leading apostrophe; numbers stay numbers, so a refund's -29.99 is still a number.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n';

const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
/** Minor units to a number in major units: 2999 USD is 29.99, 500 JPY is 500. */
const major = (minor: number | null | undefined, currency: string) =>
  typeof minor === 'number' ? Number((minor / 10 ** currencyDecimals(currency)).toFixed(currencyDecimals(currency))) : null;

/** One exportable table. Round 7's feature modules add theirs through their CorePart (core-parts.ts). */
export interface ExportTable {
  columns: string[];
  /** The query for one chunk after `cursor` (null: from the start), ordered by the cursor columns. */
  chunk: (ctx: Ctx, cursor: Cursor | null, n: number) => D1PreparedStatement;
  /** `hidePerson`: a viewer login without VIEWER_PII, who gets no emails. */
  cells: (row: any, ctx: Ctx, hidePerson: boolean) => unknown[];
  /** The cursor after `row`. */
  cursor: (row: any) => Cursor;
  /** Every row, whatever the period: the file name has no dates. */
  allTime?: boolean;
  /** Columns an API key gets empty (GET /api/v1/export): the person's name and email and the provider's customer id. */
  scrub: string[];
}

/** Keyset cursor: the time and id of the last row sent. */
export type Cursor = { ts: number; id: string };
type Table = ExportTable;

const encodeCursor = (c: Cursor) => `${c.ts}.${c.id}`;
function decodeCursor(raw: string | undefined): Cursor | null {
  const m = raw ? /^(\d{1,16})\.(.{1,200})$/.exec(raw) : null;
  return m ? { ts: Number(m[1]), id: m[2] } : null;
}

const SESSION_COLUMNS = [
  'session_id', 'visitor_id', 'started_at', 'last_seen_at', 'duration_seconds', 'pageviews', 'goals', 'platform', 'hostname',
  'entry_page', 'exit_page', 'referrer', 'referrer_domain', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content', 'ref', 'country', 'region', 'city', 'browser', 'os', 'device', 'app_version',
  // Migration 0065. The export keeps every visit; datacenter = 1 marks the ones the dashboard hides.
  'language', 'click_network', 'datacenter',
];

const BASE_TABLES: Record<string, Table> = {
  sessions: {
    columns: SESSION_COLUMNS,
    chunk: (ctx, cur, n) => {
      const f = filterSql(ctx.filters);
      const after = cur ? ' AND (s.started_at > ? OR (s.started_at = ? AND s.id > ?))' : '';
      return ctx.db
        .prepare(
          `SELECT s.* FROM sessions s WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ?${f.sql}${after}
           ORDER BY s.started_at, s.id LIMIT ${n}`,
        )
        .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...f.params, ...(cur ? [cur.ts, cur.ts, cur.id] : []));
    },
    cells: (s) => [
      s.id, s.visitor_id, iso(s.started_at), iso(s.last_seen_at), Math.round((s.duration ?? 0) / 1000), s.pageviews, s.goals,
      String(s.hostname ?? '').startsWith('ios:') ? 'iOS' : 'Web', s.hostname, s.entry_page, s.exit_page, s.referrer,
      s.referrer_domain, s.source, s.channel, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_term, s.utm_content, s.ref,
      s.country, s.region, s.city, s.browser, s.os, s.device, s.app_version, s.language, s.click_network, s.datacenter ?? 0,
    ],
    cursor: (s) => ({ ts: s.started_at, id: s.id }),
    scrub: [],
  },

  events: {
    columns: ['event_id', 'time', 'type', 'name', 'path', 'props', 'session_id', 'visitor_id'],
    chunk: (ctx, cur, n) => {
      const f = filterSql(ctx.filters);
      const join = hasFilters(ctx.filters) ? 'JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id' : '';
      const after = cur ? ' AND (e.ts > ? OR (e.ts = ? AND e.id > ?))' : '';
      return ctx.db
        .prepare(
          `SELECT e.id, e.ts, e.type, e.name, e.path, e.props, e.session_id, e.visitor_id FROM events e ${join}
           WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ?${f.sql}${after} ORDER BY e.ts, e.id LIMIT ${n}`,
        )
        .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...f.params, ...(cur ? [cur.ts, cur.ts, Number(cur.id) || 0] : []));
    },
    cells: (e) => [e.id, iso(e.ts), e.type, e.name, e.path, e.props, e.session_id, e.visitor_id],
    cursor: (e) => ({ ts: e.ts, id: String(e.id) }),
    // `name` is the event or goal name, not a person's: it stays.
    scrub: [],
  },

  payments: {
    columns: [
      'payment_id', 'time', 'provider', 'kind', 'renewal', 'amount', 'currency', 'amount_site_currency', 'site_currency', 'product',
      'customer_id', 'subscription_id', 'email', 'name', 'visitor_id', 'session_id', 'matched_by', 'source', 'channel',
      'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'entry_page', 'country',
      'device',
    ],
    chunk: (ctx, cur, n) => {
      const f = filterSql(ctx.filters);
      const join = hasFilters(ctx.filters) ? 'JOIN' : 'LEFT JOIN';
      const after = cur ? ' AND (p.ts > ? OR (p.ts = ? AND p.id > ?))' : '';
      return ctx.db
        .prepare(
          // A payment whose visit was deleted keeps that visit's source, channel and campaign (migration 0064).
          `SELECT p.*, COALESCE(s.source, p.source) AS source, COALESCE(s.channel, p.channel) AS channel, s.referrer_domain, s.utm_source,
                  s.utm_medium, COALESCE(s.utm_campaign, p.campaign) AS utm_campaign, s.utm_term, s.utm_content,
                  s.ref, s.entry_page, s.country, s.device
           FROM payments p ${join} sessions s ON s.site_id = p.site_id AND s.id = p.session_id
           WHERE p.site_id = ? AND p.ts >= ? AND p.ts < ?${f.sql}${after} ORDER BY p.ts, p.id LIMIT ${n}`,
        )
        .bind(ctx.site.id, ctx.range.from, ctx.range.to, ...f.params, ...(cur ? [cur.ts, cur.ts, cur.id] : []));
    },
    cells: (p, ctx) => {
      const site = ctx.site.currency;
      const conv = p.currency === site ? p.amount : p.amount_conv;
      return [
        p.id, iso(p.ts), p.provider, p.kind, p.renewal, major(p.amount, p.currency), p.currency, major(conv, site), site, p.product,
        p.customer_id, p.subscription_id, p.email, p.name, p.visitor_id, p.session_id, p.matched_by, p.source, p.channel,
        p.referrer_domain, p.utm_source, p.utm_medium, p.utm_campaign, p.utm_term, p.utm_content, p.ref, p.entry_page, p.country,
        p.device,
      ];
    },
    cursor: (p) => ({ ts: p.ts, id: p.id }),
    scrub: ['email', 'name', 'customer_id'],
  },

  // Every subscription row of the site (src/worker/subscriptions.ts), whatever the period: the rows behind MRR.
  // Sandbox purchases stay out, as they do of MRR. The email is the latest one a payment of the customer carried.
  subscriptions: {
    allTime: true,
    columns: [
      'subscription_id', 'provider', 'product', 'status', 'mrr', 'first_mrr', 'currency', 'price', 'price_currency', 'interval',
      'interval_count', 'started_at', 'trial_start', 'trial_end', 'first_paid_at', 'last_paid_at', 'paid_until', 'canceled_at',
      'ended_at', 'end_inferred', 'past_due_since', 'customer_id', 'email', 'visitor_id', 'source', 'channel', 'campaign',
      'referrer_domain',
    ],
    chunk: (ctx, cur, n) => {
      // The Subscriptions tab's filters: the credited visit's channel, source and campaign, kept on the row.
      const cols: Record<string, string> = { channel: 'channel', source: 'source', utm_campaign: 'campaign' };
      const f = Object.entries(ctx.filters).filter(([k, v]) => cols[k] && v !== undefined);
      const after = cur ? ' AND (sub.started_at > ? OR (sub.started_at = ? AND sub.id > ?))' : '';
      return ctx.db
        .prepare(
          `SELECT sub.*,
                  (SELECT p.email FROM payments p WHERE p.site_id = sub.site_id AND p.customer_id = sub.customer_id AND p.email IS NOT NULL
                   ORDER BY p.ts DESC LIMIT 1) AS email
           FROM subscriptions sub WHERE sub.site_id = ? AND sub.sandbox = 0${f.map(([k]) => ` AND sub.${cols[k]} IS ?`).join('')}${after}
           ORDER BY sub.started_at, sub.id LIMIT ${n}`,
        )
        .bind(ctx.site.id, ...f.map(([, v]) => v), ...(cur ? [cur.ts, cur.ts, cur.id] : []));
    },
    cells: (r, ctx, hidePerson) => {
      const site = ctx.site.currency;
      // No renewal LAPSE_MS after the paid period: ended when the period did, as the metrics count it.
      const lapsed = r.ended_at == null && r.expires_at != null && r.expires_at < Date.now() - LAPSE_MS;
      const pastDue = r.ended_at == null && r.billing_issue_at != null && r.billing_issue_at > (r.renewed_at ?? 0);
      return [
        r.id, r.provider, r.product, lapsed ? 'expired' : r.status, major(r.mrr, site), major(r.first_mrr, site), site,
        r.currency ? major(r.amount, r.currency) : null, r.currency, r.interval, r.interval_count, iso(r.started_at), iso(r.trial_start),
        iso(r.trial_end), iso(r.paid_at), iso(r.renewed_at), iso(r.expires_at), iso(r.canceled_at), iso(lapsed ? r.expires_at : r.ended_at),
        lapsed ? 1 : 0, pastDue ? iso(r.billing_issue_at) : null, r.customer_id, hidePerson ? null : r.email, r.visitor_id, r.source,
        r.channel, r.campaign, r.source_domain,
      ];
    },
    cursor: (r) => ({ ts: r.started_at, id: r.id }),
    scrub: ['email', 'customer_id'],
  },
};

/** Core's tables and those of round 7's parts, merged when first asked for, so no module load depends on another's. */
let merged: Record<string, Table> | null = null;
const tables = () => (merged ??= { ...BASE_TABLES, ...partExports() });
/** The names of every exportable table. */
export const exportTables = () => Object.keys(tables());

/** The dashboard's range and filters; `from` or `to` without `period` mean a custom range, as in the read API. */
function exportCtx(c: Context<AppEnv>): Ctx {
  const ctx = makeCtx(c);
  const q = c.req.query();
  if ((q.from || q.to) && !q.period) {
    ctx.range = resolveRange({ ...q, period: 'custom' }, ctx.site.timezone, ctx.site.created_at);
    ctx.offset = tzOffset(ctx.site.timezone, ctx.range.to);
    ctx.period = 'custom';
  }
  return ctx;
}

/** "acme.example-sessions-2026-10-01-to-2026-10-31.csv", or "acme.example-subscriptions-2026-11-02.csv" for all time. */
function filename(ctx: Ctx, what: string, allTime = false) {
  const tz = ctx.site.timezone;
  const name = allTime
    ? `${ctx.site.domain}-${what}-${dayInTz(Date.now(), tz)}`
    : `${ctx.site.domain}-${what}-${dayInTz(ctx.range.from, tz)}-to-${dayInTz(ctx.range.to - 1, tz)}`;
  return name.replace(/[^\w.-]+/g, '_') + '.csv';
}

function csvResponse(body: string, name: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** Tables whose rows hold money: an API key needs read:revenue for them. */
export const MONEY_TABLES = new Set(['payments', 'subscriptions']);

/**
 * The CSV of one table for the request's range and filters: `limit` rows at most, from `cursor` on. `hidePerson` is a
 * viewer without VIEWER_PII; `scrub` (an API key) also empties the table's `scrub` columns.
 */
async function exportCsv(c: Context<AppEnv>, name: string, table: Table, opts: { hidePerson: boolean; scrub: boolean }) {
  const ctx = exportCtx(c);
  const limit = Math.max(1, Math.min(EXPORT_MAX, Number(c.req.query('limit')) || EXPORT_LIMIT));
  const rawCursor = c.req.query('cursor');
  let cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return { error: 'Bad cursor. Use the Link header of the previous response.' };
  const blank = opts.scrub ? table.columns.map((col) => table.scrub.includes(col)) : null;

  let out = cursor ? '' : csvRow(table.columns);
  let sent = 0;
  let more = false;
  while (sent < limit) {
    // The last chunk asks for one row past the limit: it tells whether another response is needed.
    const left = limit - sent;
    const want = left <= CHUNK ? left + 1 : CHUNK;
    const rows = (await table.chunk(ctx, cursor, want).all()).results as any[];
    const take = rows.slice(0, limit - sent);
    for (const r of take) {
      const cells = table.cells(r, ctx, opts.hidePerson || opts.scrub);
      out += csvRow(blank ? cells.map((v, i) => (blank[i] ? null : v)) : cells);
    }
    sent += take.length;
    if (take.length) cursor = table.cursor(take[take.length - 1]);
    if (rows.length > take.length) more = true;
    if (rows.length < want || more) break;
  }

  const headers: Record<string, string> = { 'x-rows': String(sent) };
  if (more && cursor) {
    const next = new URL(c.req.url);
    next.searchParams.set('cursor', encodeCursor(cursor));
    headers.link = `<${next.pathname}${next.search}>; rel="next"`;
    headers['x-next-cursor'] = encodeCursor(cursor);
  }
  return { body: out, name: filename(ctx, name, table.allTime), headers };
}

/**
 * GET /api/sites/:id/export/:table.csv (sessions, events, payments or subscriptions), with the dashboard's period and
 * filters. Subscriptions ignore the period.
 * `limit` rows at most (default 5,000, up to 50,000 on Workers Paid); `cursor` continues where the last response
 * stopped and leaves out the header row.
 */
export async function exportTable(c: Context<AppEnv>) {
  const name = c.req.param('table')?.replace(/\.csv$/, '') ?? '';
  const table = tables()[name];
  if (!table) return c.json({ error: `Export one of ${exportTables().join(', ')}` }, 404);
  const hidePerson = c.get('role') === 'viewer' && !viewerSeesPersonalData(c.env);
  const out = await exportCsv(c, name, table, { hidePerson, scrub: false });
  if ('error' in out) return c.json({ error: out.error }, 400);
  return csvResponse(out.body, out.name, out.headers);
}

/**
 * GET /api/v1/export/:table with a key that has read:rows (docs/API.md "Raw rows"): the same CSV as the dashboard's
 * export, with names, emails and customer ids empty. The caller checks the key and its scopes first. Returns the body
 * and headers so the read API can cache it.
 */
export async function exportForKey(c: Context<AppEnv>, name: string) {
  const table = tables()[name];
  if (!table) return { status: 404 as const, error: `Export one of ${exportTables().join(', ')}` };
  const out = await exportCsv(c, name, table, { hidePerson: true, scrub: true });
  if ('error' in out) return { status: 400 as const, error: out.error! };
  return { status: 200 as const, ...out };
}

/** The columns of a breakdown CSV. Money in major units of the site currency. */
export const BREAKDOWN_COLUMNS = ['value', 'visitors', 'pageviews', 'revenue', 'currency', 'customers', 'conversion_rate', 'revenue_per_visitor', 'note'];

/** GET /api/sites/:id/breakdown?dim=...&format=csv: the panel's rows, up to 500. */
export async function exportBreakdown(c: Context<AppEnv>) {
  const ctx = exportCtx(c);
  const dim = c.req.query('dim') ?? 'source';
  const rows = await breakdown(ctx, dim, Number(c.req.query('limit')) || 500);
  const cur = ctx.site.currency;
  let out = csvRow(BREAKDOWN_COLUMNS);
  for (const r of rows) {
    const note = r.appStore ? 'App Store revenue no linked visit explains' : r.noVisit ? 'payments with no linked visit' : null;
    out += csvRow([
      r.label,
      r.visitors,
      r.pageviews ?? null,
      major(r.revenue, cur),
      cur,
      r.customers,
      r.visitors ? Number((r.customers / r.visitors).toFixed(4)) : null,
      r.visitors ? major(Math.round(r.revenue / r.visitors), cur) : null,
      note,
    ]);
  }
  return csvResponse(out, filename(ctx, dim));
}
