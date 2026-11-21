// Read-only access to one site (migration 0016, docs/API.md):
// - share links: /share/<token> in the dashboard reads /api/share/<token>/*, aggregates only, and an SVG badge
// - read API keys: GET /api/v1/stats/* with Authorization: Bearer rtr_..., and the routes in agent-api.ts
// - all-sites read keys (kind `all`, site_id `*`): the same routes for any site with ?site=<id>, and /api/v1/portfolio
// - the logged-in routes that create, change and revoke them, under /api/sites/:id/share and /api/read-keys
// A token reaches only the GET routes registered here, for its own site. Nothing here writes a row per view.
import type { Context, Hono, Next } from 'hono';
import { requireAuth } from './auth';
import { getSite, type AppEnv, type Site } from './env';
import { convertPayments } from './fx';
import { canRead, coversSite, scopedKeyOf, type ApiKey, type Scope } from './keys';
import { randomId } from './lib/crypto';
import { previousRange, resolveRange, tzOffset } from './lib/time';
import { currencyDecimals } from './payments';
import { dataStarts, noPrevious } from './sources';
import { ATTRIBUTION_DIMS, attributionCoverage, breakdown, coverageOut, FIRST_TOUCH_DIM_NAMES, hasFilters, modelOf, overview, parseFilters, type BreakdownRow, type Ctx, type Filters } from './stats';
import { overviewOutages } from './notes';
import { proHooks } from './pro-hooks';
import { heardAboutAnswer, type HeardAboutAnswer, type HeardAboutRow } from './surveys';
import { parseSurveys } from '../shared/surveys';

export interface ShareToken {
  token: string;
  /** The site, or `*` for an all-sites read key. */
  site_id: string;
  kind: 'link' | 'api' | 'all';
  label: string | null;
  show_revenue: number;
  created_at: number;
  expires_at: number | null;
  /** A scoped API key (keys.ts) read as a token: its scopes, and its sites (null: every site). */
  scopes?: Scope[];
  sites?: string[] | null;
}

/** Tokens per site, both kinds together; also the most all-sites read keys. */
const MAX_TOKENS = 50;
/** The site_id of an all-sites read key. */
export const ALL_SITES = '*';
/**
 * Seconds a share or read API response is reused: in this isolate, and through the Cache API on a custom domain. Also
 * how long an isolate trusts a token it looked up, so a revoked token can keep answering for up to this long.
 */
export const SHARE_TTL = 60;
const BADGE_TTL = 300;
/** Share and read API responses one isolate computes per token per minute; more get 429 until the minute is over. */
export const SHARE_MISSES_PER_MINUTE = 120;

/** What a share link shows. Visitor lists, journeys, referrer URLs, exit links, goals and properties stay private. */
export const SHARE_DIMS = new Set([
  'channel', 'source', 'campaign', 'keyword', 'utm_source', 'utm_medium', 'country', 'region', 'city', 'page', 'entry_page',
  'browser', 'os', 'device', 'platform',
]);
/** Filters a share link accepts: the session columns behind SHARE_DIMS. */
const SHARE_FILTERS = [
  'channel', 'source', 'utm_campaign', 'utm_term', 'utm_source', 'utm_medium', 'country', 'region', 'city', 'page', 'entry_page',
  'browser', 'os', 'device', 'platform',
] as const;

// ---------- token lookup, cached per isolate for a minute

const tokenCache = new Map<string, { tok: ShareToken | null; at: number }>();

async function findToken(db: D1Database, token: string, kinds: ShareToken['kind'][]): Promise<ShareToken | null> {
  if (!/^[\w-]{16,64}$/.test(token)) return null;
  const hit = tokenCache.get(token);
  let tok = hit && Date.now() - hit.at < SHARE_TTL * 1000 ? hit.tok : undefined;
  if (tok === undefined) {
    tok = await db.prepare('SELECT * FROM share_tokens WHERE token = ?').bind(token).first<ShareToken>();
    tokenCache.set(token, { tok, at: Date.now() });
  }
  if (!tok || !kinds.includes(tok.kind) || (tok.expires_at && tok.expires_at <= Date.now())) return null;
  return tok;
}

export function forgetShareToken(token: string) {
  tokenCache.delete(token);
  for (const k of memo.keys()) if (k.includes(`/${token}/`)) memo.delete(k);
}

/** Tests only: drop every cached token and response. */
export function resetShareCachesForTests() {
  tokenCache.clear();
  memo.clear();
  misses.clear();
}

export const tokenOf = (c: Context<AppEnv>) => (c as unknown as Context<{ Variables: { share: ShareToken } }>).get('share');

/** Middleware: a live share link for /api/share/:token/*. Its site is set as `site`. */
export const requireShareToken = async (c: Context<AppEnv>, next: Next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.json({ error: 'Share links are read-only' }, 405);
  const tok = await findToken(c.env.DB, c.req.param('token') ?? '', ['link']);
  const site = tok && (await getSite(c.env.DB, tok.site_id));
  if (!tok || !site) return c.json({ error: 'This share link does not exist or was revoked' }, 404);
  c.set('site', site);
  (c as unknown as Context<{ Variables: { share: ShareToken } }>).set('share', tok);
  await next();
};

/**
 * A scoped key (keys.ts) as a token the read routes understand: one site is kind `api`, more or all sites kind `all`
 * (which names the site with ?site=). It shows revenue with read:revenue. `token` is the key id, which keys the cache.
 */
export function keyAsToken(k: ApiKey): ShareToken {
  const one = k.sites?.length === 1 ? k.sites[0] : null;
  return {
    token: `fdk-${k.id}`,
    site_id: one ?? ALL_SITES,
    kind: one ? 'api' : 'all',
    label: k.name,
    show_revenue: k.scopes.includes('read:revenue') ? 1 : 0,
    created_at: 0,
    expires_at: k.expires_at,
    scopes: k.scopes,
    sites: k.sites,
  };
}

/**
 * The live read key (one site's or all sites') in the request's Authorization header, or null: a read key (rtr_), or a
 * scoped key (fdk_) of any scopes; noReadScope refuses one without read. `count: false` leaves the key's usage alone.
 */
export async function readKeyOf(c: Context<AppEnv>, opts: { count?: boolean } = {}): Promise<ShareToken | null> {
  const key = /^Bearer\s+(rtr_\w+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (key) return findToken(c.env.DB, key, ['api', 'all']);
  const scoped = await scopedKeyOf(c, { count: opts.count });
  return scoped ? keyAsToken(scoped) : null;
}

/** 403 for a scoped key without read, or for a site it does not cover; null when the token may read `siteId`. */
export function noReadScope(c: Context<AppEnv>, tok: ShareToken, siteId?: string): Response | null {
  if (tok.scopes && !canRead(tok.scopes)) {
    return c.json({ error: `This key can't read: it needs the read scope. Its scopes: ${tok.scopes.join(', ')}. Create a key with read in Settings, Agents.` }, 403);
  }
  if (siteId && tok.sites !== undefined && !coversSite({ sites: tok.sites }, siteId)) {
    return c.json({ error: `This key does not cover the site ${siteId}.` }, 403);
  }
  return null;
}

export const setToken = (c: Context<AppEnv>, tok: ShareToken) => (c as unknown as Context<{ Variables: { share: ShareToken } }>).set('share', tok);

/**
 * Middleware: a live read API key (Authorization: Bearer rtr_... or a scoped fdk_... key with read) for the GET routes
 * under /api/v1. A key for more than one site names the site with ?site=<id>.
 */
export const requireReadKey = async (c: Context<AppEnv>, next: Next) => {
  const tok = await readKeyOf(c);
  if (!tok) return c.json({ error: 'Send an API key with the read scope: Authorization: Bearer fdk_... (Settings, Agents)' }, 401);
  let siteId = tok.site_id;
  if (tok.kind === 'all') {
    siteId = c.req.query('site') ?? '';
    if (!siteId) {
      const what = tok.sites ? 'more than one site' : 'all sites';
      return c.json({ error: `This key covers ${what}. Add ?site=<site id>; GET /api/v1/portfolio lists the ids.` }, 400);
    }
  }
  // A scoped key for one site that asks for another gets 403, not its own site's numbers.
  const refused = noReadScope(c, tok, tok.sites && c.req.query('site') ? c.req.query('site') : siteId);
  if (refused) return refused;
  const site = await getSite(c.env.DB, siteId);
  if (!site) {
    if (tok.kind === 'all') return c.json({ error: `No site has the id ${siteId}. GET /api/v1/portfolio lists the ids.` }, 404);
    return c.json({ error: 'Send an API key with the read scope: Authorization: Bearer fdk_... (Settings, Agents)' }, 401);
  }
  c.set('site', site);
  (c as unknown as Context<{ Variables: { share: ShareToken } }>).set('share', tok);
  await next();
};

/** The sites an all-sites request without ?site= covers (readKeyAnySite); undefined when the route reads one site. */
export const allSitesOf = (c: Context<AppEnv>) => (c as unknown as Context<{ Variables: { allSites?: Site[] } }>).get('allSites');

/** Every site a key covers, oldest first: all of them, or its site list. */
export async function sitesOfKey(db: D1Database, tok: Pick<ShareToken, 'sites'>): Promise<Site[]> {
  const { results } = await db.prepare('SELECT * FROM sites ORDER BY created_at').all<Site>();
  return results.filter((s) => !tok.sites || tok.sites.includes(s.id));
}

/**
 * Middleware for list routes that also answer across sites: a key for more than one site without ?site= gets every
 * site it covers (allSitesOf), anything else goes through requireReadKey.
 */
export const readKeyAnySite = async (c: Context<AppEnv>, next: Next) => {
  const tok = await readKeyOf(c);
  if (tok?.kind === 'all' && !c.req.query('site')) {
    const refused = noReadScope(c, tok);
    if (refused) return refused;
    setToken(c, tok);
    (c as unknown as Context<{ Variables: { allSites: Site[] } }>).set('allSites', await sitesOfKey(c.env.DB, tok));
    return next();
  }
  return requireReadKey(c, next);
};

// ---------- query parameters

/** The range and filters of a share or API request. `from` and `to` (YYYY-MM-DD) mean a custom range. */
function readCtx(c: Context<AppEnv>, site: Site, allowedFilters?: readonly string[]): Ctx {
  const q = c.req.query();
  const period = q.from || q.to ? 'custom' : q.period;
  const range = resolveRange({ ...q, period }, site.timezone, site.created_at);
  let filters: Filters = parseFilters(q.filters);
  if (allowedFilters) {
    filters = Object.fromEntries(Object.entries(filters).filter(([k]) => allowedFilters.includes(k))) as Filters;
  }
  return { db: c.env.DB, site, range, filters, offset: tzOffset(site.timezone, range.to), period, model: modelOf(q.model) };
}

/**
 * The cache key of a share or read API response: the token, what it may show and the parameters that change the
 * response, in a fixed order, so other parameters can't skip the cache. Turning revenue off gives new keys at once, so no
 * cached response with revenue answers after the change.
 */
export function cacheKey(c: Context<AppEnv>, route: string, params: string[]): string {
  const url = new URL(c.req.url);
  const tok = tokenOf(c);
  const keep = new URLSearchParams({ rev: String(tok.show_revenue ? 1 : 0), exp: String(tok.expires_at ?? 0) });
  // An all-sites key reads the site in ?site=, so the site is part of the key.
  if (tok.kind === 'all') keep.set('site', url.searchParams.get('site') ?? '');
  for (const p of params) {
    const v = url.searchParams.get(p);
    if (v) keep.set(p, v);
  }
  // A read key's responses live under a path no route serves, so they never mix with a share link's.
  const base = tok.kind === 'link' ? '/api/share' : '/api/v1/cache';
  return `${url.origin}${base}/${tok.token}/${route}?${keep}`;
}

// ---------- response cache: per isolate, plus the Cache API where Cloudflare offers it

const memo = new Map<string, { body: string; type: string; at: number; ttl: number; extra?: Record<string, string> }>();
const misses = new Map<string, { start: number; n: number }>();
const MEMO_MAX = 500;
/** Bigger answers (an SEO snapshot can be several MB) skip the per-isolate copy; the Cache API still keeps them. */
const MEMO_MAX_BYTES = 1_000_000;

function edgeCache(): Cache | null {
  const caches = (globalThis as { caches?: { default?: Cache } }).caches;
  return caches?.default ?? null;
}

/** What `compute` returns: the body, or the body with headers that belong to it (such as X-Next-Offset). */
export type Computed = string | { body: string; headers?: Record<string, string> };

export async function cached(
  c: Context<AppEnv>,
  key: string,
  ttl: number,
  type: string,
  compute: () => Promise<Computed>,
): Promise<Response> {
  // A read key's response answers an Authorization header: no shared cache on the way may keep it.
  const scope = tokenOf(c).kind === 'link' ? 'public' : 'private';
  const headers = { 'content-type': type, 'cache-control': `${scope}, max-age=${ttl}` };
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < hit.ttl * 1000) return new Response(hit.body, { headers: { ...headers, ...hit.extra, 'x-cache': 'hit' } });
  const edge = edgeCache();
  const fromEdge = edge ? await edge.match(key).catch(() => undefined) : undefined;
  if (fromEdge) return fromEdge;

  // A miss reads D1. Cap misses per token, so changing the query on every request can't run up reads.
  const token = tokenOf(c).token;
  const now = Date.now();
  const m = misses.get(token);
  if (m && now - m.start < 60_000) {
    if (++m.n > SHARE_MISSES_PER_MINUTE) {
      const what = tokenOf(c).kind === 'link' ? 'share link' : 'read API key';
      const wait = Math.max(1, Math.ceil((m.start + 60_000 - now) / 1000));
      return c.json({ error: `Too many requests for this ${what}. Try again in ${wait} seconds.` }, 429, { 'retry-after': String(wait) });
    }
  } else misses.set(token, { start: now, n: 1 });

  const out = await compute();
  const { body, headers: extra } = typeof out === 'string' ? { body: out, headers: undefined } : out;
  if (body.length <= MEMO_MAX_BYTES) {
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
    memo.set(key, { body, type, at: now, ttl, extra });
  }
  const res = new Response(body, { headers: { ...headers, ...extra, 'x-cache': 'miss' } });
  if (edge) c.executionCtx.waitUntil(edge.put(key, res.clone()).catch(() => undefined));
  return res;
}

// ---------- what a token without revenue sees

const REVENUE_KPIS = ['revenue', 'appStoreRevenue', 'payments', 'customers', 'conversionRate', 'revenuePerVisitor'] as const;

type OverviewData = Awaited<ReturnType<typeof overview>>;

function withoutRevenue(o: OverviewData) {
  const strip = (k: OverviewData['current']) => {
    const out: Partial<OverviewData['current']> = { ...k };
    for (const f of REVENUE_KPIS) delete out[f];
    return out;
  };
  // Revenue an import reported (DataFast) is revenue too: it goes with the rest.
  const { revenue: _ir, payments: _ip, ...imported } = o.imported ?? ({} as NonNullable<OverviewData['imported']>);
  return {
    ...o,
    imported: o.imported ? imported : null,
    current: strip(o.current),
    previous: strip(o.previous),
    series: o.series.map(({ revenue: _r, payments: _p, imported_revenue: _i, ...rest }) => rest),
  };
}

function rowsFor(rows: BreakdownRow[], showRevenue: boolean) {
  if (showRevenue) return rows;
  return rows.filter((r) => !r.appStore && !r.noVisit).map(({ revenue: _r, customers: _c, importedRevenue: _ir, importedPayments: _ip, ...rest }) => rest);
}

// ---------- share link routes (public)

/** GET /api/share/:token: what the share page needs to draw itself. */
async function shareInfo(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const site = c.get('site');
  return c.json(
    {
      site: { name: site.name, domain: site.domain, timezone: site.timezone, currency: site.currency, app: !!site.app_bundle_id },
      label: tok.label,
      showRevenue: !!tok.show_revenue,
      decimals: currencyDecimals(site.currency),
      dims: [...SHARE_DIMS],
    },
    200,
    { 'cache-control': 'no-store' },
  );
}

/**
 * MRR at the end of the range and at its start, and the paying subscriptions, in the site's currency (minor units).
 * Null for a site without subscription rows. Unfiltered: MRR is the whole site's.
 */
export async function siteMrr(db: D1Database, siteId: string, range: { from: number; to: number }, now = Date.now()) {
  // Subscriptions are Pro's (subscription-metrics.ts): core has no MRR.
  return (await proHooks()?.mrrForSite?.(db, siteId, Math.min(range.to, now), range.from, now)) ?? null;
}

async function shareOverview(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const key = cacheKey(c, 'overview', ['period', 'from', 'to', 'granularity', 'filters']);
  return cached(c, key, SHARE_TTL, 'application/json', async () => {
    const ctx = readCtx(c, c.get('site'), SHARE_FILTERS);
    const data = await overview(ctx);
    if (!tok.show_revenue) return JSON.stringify(withoutRevenue(data));
    // The MRR tile: only for a link that shows revenue, and only unfiltered, since MRR does not follow visit filters.
    const mrr = Object.keys(ctx.filters).length ? null : await siteMrr(c.env.DB, ctx.site.id, ctx.range);
    return JSON.stringify({ ...data, mrr });
  });
}

async function shareBreakdown(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const dim = c.req.query('dim') ?? 'source';
  if (!SHARE_DIMS.has(dim)) return c.json({ error: `A share link shows ${[...SHARE_DIMS].join(', ')}` }, 400);
  const key = cacheKey(c, 'breakdown', ['dim', 'model', 'period', 'from', 'to', 'filters']);
  return cached(c, key, SHARE_TTL, 'application/json', async () => {
    const rows = await breakdown(readCtx(c, c.get('site'), SHARE_FILTERS), dim, 100);
    return JSON.stringify(rowsFor(rows, !!tok.show_revenue));
  });
}

const BADGE_PERIODS: Record<string, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '12 months', all: 'all time' };

/** Width of `text` in 11px Verdana, near enough for a badge. */
const textWidth = (text: string) => Math.round([...text].reduce((w, ch) => w + (/[ilj.,:'!|]/.test(ch) ? 3.5 : /[mwMW@]/.test(ch) ? 10 : /[A-Z0-9$€£]/.test(ch) ? 7.5 : 6.6), 0));
const xml = (s: string) => s.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function badgeSvg(label: string, value: string, color = '#3f7fd4'): string {
  const lw = textWidth(label) + 12;
  const vw = textWidth(value) + 12;
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${xml(`${label}: ${value}`)}">
<title>${xml(`${label}: ${value}`)}</title>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${xml(label)}</text><text x="${lw + vw / 2}" y="14">${xml(value)}</text>
</g>
</svg>`;
}

/**
 * GET /api/share/:token/badge.svg?metric=visitors|revenue|mrr&period=30d. "1.2k visitors in 30 days", the revenue, or
 * "$9.8k MRR". Revenue and MRR need a link that shows revenue, and MRR a site with subscriptions; otherwise visitors.
 */
async function shareBadge(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const site = c.get('site');
  const period = BADGE_PERIODS[c.req.query('period') ?? ''] ? c.req.query('period')! : '30d';
  const asked = c.req.query('metric');
  const metric = (asked === 'revenue' || asked === 'mrr') && tok.show_revenue ? asked : 'visitors';
  const key = `${new URL(c.req.url).origin}/api/share/${tok.token}/badge.svg?rev=${tok.show_revenue ? 1 : 0}&exp=${tok.expires_at ?? 0}&metric=${metric}&period=${period}`;
  return cached(c, key, BADGE_TTL, 'image/svg+xml; charset=utf-8', async () => {
    const range = resolveRange({ period }, site.timezone, site.created_at);
    const compactMoney = (minor: number) =>
      // minimumFractionDigits is explicit: without it some runtimes keep the currency's cents and print $35.0.
      new Intl.NumberFormat('en', { style: 'currency', currency: site.currency, notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(
        minor / 10 ** currencyDecimals(site.currency),
      );
    if (metric === 'mrr') {
      // MRR now; the period does not change it.
      const m = await siteMrr(c.env.DB, site.id, range);
      if (m) return badgeSvg(site.domain, `${compactMoney(m.mrr)} MRR`, '#c8644a');
    }
    const data = await overview({ db: c.env.DB, site, range, filters: {}, offset: tzOffset(site.timezone, range.to), period });
    const when = period === 'all' ? 'all time' : `in ${BADGE_PERIODS[period]}`;
    if (metric === 'revenue') return badgeSvg(site.domain, `${compactMoney(data.current.revenue)} revenue ${when}`, '#c8644a');
    const n = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(data.current.visitors).toLowerCase();
    return badgeSvg(site.domain, `${n} visitors ${when}`);
  });
}

// ---------- read API (Bearer rtr_...)

const kpisOut = (k: OverviewData['current']) => ({
  visitors: k.visitors,
  sessions: k.sessions,
  pageviews: k.pageviews,
  bounce_rate: Number(k.bounceRate.toFixed(4)),
  avg_duration_seconds: Math.round(k.avgDuration / 1000),
  revenue: k.revenue,
  payments: k.payments,
  customers: k.customers,
  conversion_rate: Number(k.conversionRate.toFixed(4)),
  revenue_per_visitor: Math.round(k.revenuePerVisitor),
});
const MONEY_KPIS = ['revenue', 'payments', 'customers', 'conversion_rate', 'revenue_per_visitor'] as const;

function apiKpis(k: OverviewData['current'], showRevenue: boolean) {
  const out: Partial<ReturnType<typeof kpisOut>> = kpisOut(k);
  if (!showRevenue) for (const f of MONEY_KPIS) delete out[f];
  return out;
}

export const rangeOut = (ctx: Ctx) => ({
  site_id: ctx.site.id,
  timezone: ctx.site.timezone,
  from: new Date(ctx.range.from).toISOString(),
  to: new Date(ctx.range.to).toISOString(),
  currency: ctx.site.currency,
  currency_decimals: currencyDecimals(ctx.site.currency),
});

// Each read API route answers through `cached`, like a share link: the same 60 s reuse and the same misses per key per
// minute, so a script polling with a new query on every call can't run up D1 reads.

async function apiOverview(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const key = cacheKey(c, 'overview', ['period', 'from', 'to', 'filters']);
  return cached(c, key, SHARE_TTL, 'application/json', async () => {
    await convertPayments(c.env.DB).catch(() => 0);
    const ctx = readCtx(c, c.get('site'));
    const [o, starts, outages] = await Promise.all([
      overview(ctx),
      dataStarts(c.env.DB, [ctx.site]),
      overviewOutages(c.env.DB, ctx.site, ctx.range, ctx.period).catch(() => []),
    ]);
    const cmp = comparable(ctx, starts.get(ctx.site.id), !!tok.show_revenue);
    return JSON.stringify({
      ...rangeOut(ctx),
      ...apiKpis(o.current, !!tok.show_revenue),
      online: o.online,
      // null when no number of the period before is comparable; a field is null when its data started inside it.
      previous: cmp.previous(apiKpis(o.previous, !!tok.show_revenue)),
      previous_from: new Date(cmp.before.from).toISOString(),
      previous_reason: cmp.reason,
      data_since: cmp.since,
      // Imported days (history from another tool) inside visitors, sessions, pageviews, bounce_rate and
      // avg_duration_seconds; null when none. Revenue and conversion are native only.
      imported: importedFor(o.imported, !!tok.show_revenue),
      // Outage notes (kind outage) that overlap this range (`in` current) or the one before (previous, or both): the
      // numbers have a gap there, so a change between the two may be the gap.
      outages,
    });
  });
}

const VISITOR_FIELDS = ['visitors', 'sessions', 'pageviews', 'bounce_rate', 'avg_duration_seconds'];
const REVENUE_FIELDS = ['revenue', 'payments', 'customers'];
const BOTH_FIELDS = ['conversion_rate', 'revenue_per_visitor'];

/**
 * Which numbers of the period before can be compared (docs/API.md "Sources and tracking start"): visitor numbers need
 * visits (or imported days) from the first day of the period before, money numbers a payment or App Store day from
 * then. A site with no payment ever compares its zeros. A key without revenue is judged on visitors only.
 */
export function comparable(ctx: Ctx, start: { visitors: number | null; revenue: number | null } | undefined, showRevenue: boolean) {
  const before = previousRange(ctx.range, ctx.period, ctx.site.timezone);
  const why = {
    visitors: noPrevious(start?.visitors ?? null, before.from, 'visitors', ctx.site.timezone),
    revenue: showRevenue ? noPrevious(start?.revenue ?? null, before.from, 'revenue', ctx.site.timezone) : null,
  };
  const reason = [why.visitors, why.revenue].filter(Boolean).join(' ') || null;
  const since = {
    visitors: start?.visitors == null ? null : new Date(start.visitors).toISOString(),
    ...(showRevenue ? { revenue: start?.revenue == null ? null : new Date(start.revenue).toISOString() } : {}),
  };
  return {
    before,
    reason,
    since,
    why,
    previous<T extends Record<string, unknown>>(p: T): T | null {
      // Nothing left to compare: visits started late, and revenue started late too or never existed.
      if (why.visitors && (!showRevenue || why.revenue || start?.revenue == null)) return null;
      const out: Record<string, unknown> = { ...p };
      const drop = [...(why.visitors ? VISITOR_FIELDS : []), ...(why.revenue ? REVENUE_FIELDS : []), ...(why.visitors || why.revenue ? BOTH_FIELDS : [])];
      for (const f of drop) if (f in out) out[f] = null;
      return out as T;
    },
  };
}

/** The overview's `imported` object; the revenue an import reported (DataFast) only goes to a key that shows revenue. */
function importedFor(i: { from: string; to: string; days: number; revenue?: number; payments?: number; native_from?: string | null; seam_bucket?: string | null } | null, showRevenue: boolean) {
  if (!i || showRevenue) return i;
  const { revenue: _r, payments: _p, ...rest } = i;
  return rest;
}

/**
 * The heard_about answer's head: people who answered, the period's visitors, and for an empty answer the survey's
 * switch with the next step. Pro links Settings > Surveys; core links the `answer` call's docs.
 */
function heardAboutOut(c: Context<AppEnv>, site: Site, h: HeardAboutAnswer) {
  const head = { answered: h.answered, visitors: h.visitors, answer_share: h.visitors ? Math.round((h.answered / h.visitors) * 1000) / 1000 : null };
  if (h.rows.length) return head;
  const cfg = parseSurveys(site.surveys).heard_about;
  const survey = { on: !!cfg?.on, pages: cfg?.paths ?? [] };
  const settings = `${new URL(c.req.url).origin}/site/${encodeURIComponent(site.id)}/settings#surveys`;
  const next_step = !proHooks()
    ? `No answers in this period. Send them from your own form with founderdata('answer', 'heard_about', key): ${ANSWER_DOCS}`
    : !survey.on
      ? `The Heard about survey is off for this site. The owner turns it on and adds the pages it shows on in Settings > Surveys: ${settings}`
      : !survey.pages.length
        ? `The survey is on but has no page to show on by itself. Add one in Settings > Surveys (${settings}), or call founderdata('survey', 'heard_about') on a page.`
        : `The survey is on and shows on ${survey.pages.join(', ')}. Nobody answered in this period.`;
  return { ...head, survey, next_step };
}

/** Where the docs explain the tracker's answer call (docs/API.md "Survey answers"). */
const ANSWER_DOCS = 'https://github.com/founderdata/founderdata/blob/main/docs/API.md#survey-answers';

async function apiBreakdown(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const dim = c.req.query('dim') ?? 'source';
  const key = cacheKey(c, 'breakdown', ['dim', 'limit', 'model', 'period', 'from', 'to', 'filters']);
  try {
    return await cached(c, key, SHARE_TTL, 'application/json', async () => {
      const ctx = readCtx(c, c.get('site'));
      // Source dimensions, unfiltered, with revenue: how much of the revenue any row can explain.
      const withCoverage = !!tok.show_revenue && ATTRIBUTION_DIMS.has(dim) && !hasFilters(ctx.filters);
      const limit = Number(c.req.query('limit')) || 100;
      // heard_about (surveys.ts) also says how many people answered against the period's visitors, and why it is empty.
      const heard = dim === 'heard_about' ? await heardAboutAnswer(ctx, limit, true) : null;
      const [rows, cov] = await Promise.all([heard ? heard.rows : breakdown(ctx, dim, limit), withCoverage ? attributionCoverage(ctx) : null]);
      return JSON.stringify({
        ...rangeOut(ctx),
        dim,
        ...(heard ? heardAboutOut(c, ctx.site, heard) : {}),
        ...(cov ? { attribution: coverageOut(cov, rows.find((r) => r.appStore)?.revenue ?? 0) } : {}),
        // Source dimensions say which visit they credit: last (the default) or first (?model=first).
        ...(FIRST_TOUCH_DIM_NAMES.includes(dim) ? { model: ctx.model ?? 'last' } : {}),
        rows: rows
          .filter((r) => tok.show_revenue || (!r.appStore && !r.noVisit))
          .map((r) => ({
            value: r.label,
            visitors: r.visitors,
            ...(r.pageviews !== undefined ? { pageviews: r.pageviews } : {}),
            ...(tok.show_revenue ? { revenue: r.revenue, customers: r.customers } : {}),
            ...(tok.show_revenue && r.importedRevenue ? { imported_revenue: r.importedRevenue, imported_payments: r.importedPayments ?? 0 } : {}),
            ...(r.appStore ? { note: 'app_store_no_source' } : r.noVisit ? { note: 'no_visit' } : {}),
            // heard_about rows (surveys.ts): the answer as the site words it, and the channels those people arrived by.
            ...('tracked' in r ? { label: (r as HeardAboutRow).name, tracked: (r as HeardAboutRow).tracked } : {}),
            // x_post rows (pro/worker/x-posts.ts): the post, and how many of its visits matched exactly or probably.
            ...(r.x ? { post_id: r.x.unmatched ? null : r.label, text: r.x.text, url: r.x.url, posted_at: r.x.posted_at, exact: r.x.exact, probable: r.x.probable, ...(tok.show_revenue ? { exact_customers: r.x.exact_customers, probable_customers: r.x.probable_customers, exact_revenue: r.x.exact_revenue, probable_revenue: r.x.probable_revenue } : {}), goals: r.x.goals, visits_considered: r.x.visits_considered, truncated: r.x.truncated, ...(r.x.unmatched ? { note: 'no_post' } : {}) } : {}),
          })),
      });
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

async function apiTimeseries(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const key = cacheKey(c, 'timeseries', ['period', 'from', 'to', 'granularity', 'filters']);
  return cached(c, key, SHARE_TTL, 'application/json', async () => {
    await convertPayments(c.env.DB).catch(() => 0);
    const ctx = readCtx(c, c.get('site'));
    const o = await overview(ctx);
    return JSON.stringify({
      ...rangeOut(ctx),
      granularity: ctx.range.granularity,
      imported: importedFor(o.imported, !!tok.show_revenue),
      points: o.series.map((p) => ({
        bucket: p.bucket,
        visitors: p.visitors,
        pageviews: p.pageviews,
        ...(p.imported ? { imported: true } : {}),
        ...(tok.show_revenue ? { revenue: p.revenue, payments: p.payments, ...(p.imported_revenue ? { imported_revenue: p.imported_revenue } : {}) } : {}),
      })),
    });
  });
}

// ---------- managing tokens (logged in)

const publicToken = (t: ShareToken) => ({ ...t, show_revenue: !!t.show_revenue });

async function listTokens(c: Context<AppEnv>) {
  const res = await c.env.DB.prepare('SELECT * FROM share_tokens WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all<ShareToken>();
  return c.json(res.results.map(publicToken));
}

/** POST /api/sites/:id/share { kind: "link" | "api", label?, show_revenue?, expires_days? } */
async function createToken(c: Context<AppEnv>) {
  const site = c.get('site');
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const kind = b.kind === 'api' ? 'api' : b.kind === 'link' || b.kind === undefined ? 'link' : null;
  if (!kind) return c.json({ error: 'kind is link or api' }, 400);
  const days = b.expires_days === undefined || b.expires_days === null ? 0 : Number(b.expires_days);
  if (!Number.isInteger(days) || days < 0 || days > 3650) return c.json({ error: 'expires_days is a whole number of days, or empty for never' }, 400);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM share_tokens WHERE site_id = ?').bind(site.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_TOKENS) return c.json({ error: `A site can have ${MAX_TOKENS} links and keys. Revoke one first.` }, 400);
  const now = Date.now();
  const tok: ShareToken = {
    token: kind === 'api' ? `rtr_${randomId(16)}` : randomId(16),
    site_id: site.id,
    kind,
    label: typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 80) : null,
    show_revenue: b.show_revenue === false ? 0 : 1,
    created_at: now,
    expires_at: days ? now + days * 86_400_000 : null,
  };
  await c.env.DB.prepare(
    'INSERT INTO share_tokens (token, site_id, kind, label, show_revenue, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(tok.token, tok.site_id, tok.kind, tok.label, tok.show_revenue, tok.created_at, tok.expires_at, c.get('member')?.id ?? null)
    .run();
  return c.json(publicToken(tok));
}

/** PATCH /api/sites/:id/share/:token { label?, show_revenue? } */
async function updateToken(c: Context<AppEnv>) {
  const site = c.get('site');
  const token = c.req.param('token') ?? '';
  const tok = await c.env.DB.prepare('SELECT * FROM share_tokens WHERE token = ? AND site_id = ?').bind(token, site.id).first<ShareToken>();
  if (!tok) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (typeof b.label === 'string') tok.label = b.label.trim().slice(0, 80) || null;
  if (typeof b.show_revenue === 'boolean') tok.show_revenue = b.show_revenue ? 1 : 0;
  await c.env.DB.prepare('UPDATE share_tokens SET label = ?, show_revenue = ? WHERE token = ?').bind(tok.label, tok.show_revenue, token).run();
  forgetShareToken(token);
  return c.json(publicToken(tok));
}

// ---------- all-sites read keys (logged in as admin): GET, POST /api/read-keys, PATCH, DELETE /api/read-keys/:token

const adminOnly = async (c: Context<AppEnv>, next: Next) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Read keys are for owners. Ask an owner.' }, 403);
  await next();
};

async function listAllSitesKeys(c: Context<AppEnv>) {
  const res = await c.env.DB.prepare('SELECT * FROM share_tokens WHERE site_id = ? AND kind = ? ORDER BY created_at').bind(ALL_SITES, 'all').all<ShareToken>();
  return c.json(res.results.map(publicToken));
}

/** POST /api/read-keys { label?, show_revenue?, expires_days? }: a read key for every site, now and later. */
async function createAllSitesKey(c: Context<AppEnv>) {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const days = b.expires_days === undefined || b.expires_days === null ? 0 : Number(b.expires_days);
  if (!Number.isInteger(days) || days < 0 || days > 3650) return c.json({ error: 'expires_days is a whole number of days, or empty for never' }, 400);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM share_tokens WHERE site_id = ?').bind(ALL_SITES).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_TOKENS) return c.json({ error: `You can have ${MAX_TOKENS} all-sites keys. Revoke one first.` }, 400);
  const now = Date.now();
  const tok: ShareToken = {
    token: `rtr_${randomId(16)}`,
    site_id: ALL_SITES,
    kind: 'all',
    label: typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 80) : null,
    show_revenue: b.show_revenue === false ? 0 : 1,
    created_at: now,
    expires_at: days ? now + days * 86_400_000 : null,
  };
  await c.env.DB.prepare(
    'INSERT INTO share_tokens (token, site_id, kind, label, show_revenue, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(tok.token, tok.site_id, tok.kind, tok.label, tok.show_revenue, tok.created_at, tok.expires_at, c.get('member')?.id ?? null)
    .run();
  return c.json(publicToken(tok));
}

async function updateAllSitesKey(c: Context<AppEnv>) {
  const token = c.req.param('token') ?? '';
  const tok = await c.env.DB.prepare('SELECT * FROM share_tokens WHERE token = ? AND site_id = ?').bind(token, ALL_SITES).first<ShareToken>();
  if (!tok) return c.json({ error: 'not found' }, 404);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (typeof b.label === 'string') tok.label = b.label.trim().slice(0, 80) || null;
  if (typeof b.show_revenue === 'boolean') tok.show_revenue = b.show_revenue ? 1 : 0;
  await c.env.DB.prepare('UPDATE share_tokens SET label = ?, show_revenue = ? WHERE token = ?').bind(tok.label, tok.show_revenue, token).run();
  forgetShareToken(token);
  return c.json(publicToken(tok));
}

async function revokeAllSitesKey(c: Context<AppEnv>) {
  const token = c.req.param('token') ?? '';
  await c.env.DB.prepare('DELETE FROM share_tokens WHERE token = ? AND site_id = ?').bind(token, ALL_SITES).run();
  forgetShareToken(token);
  return c.json({ ok: true });
}

async function revokeToken(c: Context<AppEnv>) {
  const token = c.req.param('token') ?? '';
  await c.env.DB.prepare('DELETE FROM share_tokens WHERE token = ? AND site_id = ?').bind(token, c.get('site').id).run();
  forgetShareToken(token);
  return c.json({ ok: true });
}

/** X-Robots-Tag on every share response, including cached ones and the badge. */
async function noIndex(c: Context<AppEnv>, next: Next) {
  await next();
  try {
    c.res.headers.set('x-robots-tag', 'noindex, nofollow');
  } catch {
    // Immutable headers (a response from the cache): copy it.
    const res = new Response(c.res.body, c.res);
    res.headers.set('x-robots-tag', 'noindex, nofollow');
    c.res = undefined;
    c.res = res;
  }
}

/**
 * Registers every route of this file. Call it after the /api/sites login and loadSite middleware, before the
 * /api/* catch-all.
 */
export function registerShareRoutes(app: Hono<AppEnv>) {
  app.get('/api/sites/:id/share', listTokens);
  app.post('/api/sites/:id/share', createToken);
  app.patch('/api/sites/:id/share/:token', updateToken);
  app.delete('/api/sites/:id/share/:token', revokeToken);
  app.use('/api/read-keys', requireAuth, adminOnly);
  app.use('/api/read-keys/*', requireAuth, adminOnly);
  app.get('/api/read-keys', listAllSitesKeys);
  app.post('/api/read-keys', createAllSitesKey);
  app.patch('/api/read-keys/:token', updateAllSitesKey);
  app.delete('/api/read-keys/:token', revokeAllSitesKey);

  // Share pages and their data are for the people given the link, not for search engines. The page itself
  // (/share/*) is a static file: public/_headers sets the same header on it, and SharePage.tsx adds a robots meta tag.
  app.use('/api/share/*', noIndex);
  app.use('/api/share/:token', requireShareToken);
  app.use('/api/share/:token/*', requireShareToken);
  app.get('/api/share/:token', shareInfo);
  app.get('/api/share/:token/overview', shareOverview);
  app.get('/api/share/:token/breakdown', shareBreakdown);
  app.get('/api/share/:token/badge.svg', shareBadge);

  app.use('/api/v1/stats/*', requireReadKey);
  app.get('/api/v1/stats/overview', apiOverview);
  app.get('/api/v1/stats/breakdown', apiBreakdown);
  app.get('/api/v1/stats/timeseries', apiTimeseries);
}
