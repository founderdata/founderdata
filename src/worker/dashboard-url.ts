import type { Context, Next } from 'hono';
import { OVERVIEW_TAB_IDS } from '../shared/dashboard-tabs';
import type { AppEnv } from './env';

/**
 * dashboard_url: every read answer under /api/v1 that a dashboard screen shows says which screen, so an agent's report
 * can link the person to the same numbers. The link keeps the answer's period, custom days and filters, and opens the
 * tab or view that holds the rows (?tab=, ?view=, a sub-path). The dashboard needs a login; the link holds no key.
 */

/** Where an answer lives in the dashboard: a path under /site/:id ('' is the Overview) and the query it adds. */
interface Target {
  path: string;
  params?: Record<string, string>;
}

const overview = (tab?: string): Target => ({ path: '', params: tab ? { tab } : undefined });

/** The request's own values of these parameters, for a screen that reads them from its URL; undefined for none. */
function pick(q: URLSearchParams, keys: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = q.get(k);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** By route, the part after /api/v1/. A route missing here (keys, research, definitions) gets no link. */
function targetOf(route: string, q: URLSearchParams): Target | null {
  if (route.startsWith('app/')) return { path: '/app' };
  if (/^notes\/[^/]+\/impact$/.test(route)) return overview('changes');
  // Recordings (FounderData Pro): the list, the patterns, and one recording's player.
  if (route === 'recordings' || route === 'recordings/patterns') return { path: '/recordings' };
  if (/^recordings\/[\w-]+$/.test(route)) return { path: `/recordings/${route.slice('recordings/'.length)}` };
  // Round 7 (FounderData Pro): error issues, experiments, web retention and lifecycle, paths.
  if (route === 'errors') return { path: '/errors', params: pick(q, ['status']) };
  if (/^errors\/[\w-]+$/.test(route)) return { path: `/errors/${route.slice('errors/'.length)}` };
  if (route === 'experiments') return { path: '/experiments' };
  if (/^experiments\/[\w-]+$/.test(route)) return { path: `/experiments/${route.slice('experiments/'.length)}` };
  if (route === 'web/retention' || route === 'web/lifecycle') return { path: '/people/retention', params: pick(q, ['scope', 'split']) };
  if (route === 'paths') return { path: '/content/paths', params: pick(q, ['seq']) };
  switch (route) {
    case 'stats/overview':
    case 'stats/timeseries':
    case 'email':
      return overview();
    case 'stats/breakdown': {
      const dim = q.get('dim') ?? 'source';
      return overview(OVERVIEW_TAB_IDS.includes(dim) ? dim : undefined);
    }
    case 'customers':
      return overview('journey');
    case 'notes':
    case 'notes/actors':
      return overview('changes');
    case 'content':
    case 'vitals':
      return { path: '/content' };
    case 'content/page': {
      const page = q.get('path');
      return { path: page ? `/content/page${encodeURI(page.startsWith('/') ? page : `/${page}`)}` : '/content' };
    }
    case 'seo':
    case 'seo/decay':
      return { path: '/seo' };
    case 'seo/opportunities':
      return { path: '/seo/keywords' };
    case 'seo/cannibalization':
      return { path: '/seo/cannibalization' };
    case 'seo/audit':
      return { path: '/seo/pages' };
    case 'ranks':
      return { path: '/seo/ranks' };
    case 'ai-answers':
      return { path: '/seo/ai' };
    case 'ai-visibility':
    case 'ai-sentiment':
    case 'ai-crawlers':
      return { path: '/ai' };
    case 'aso':
    case 'aso/keywords':
    case 'aso/reviews':
      return { path: '/aso' };
    case 'appstore':
      return { path: '/appstore' };
    case 'subscriptions':
    case 'cohorts':
      return { path: '/subscriptions' };
    case 'paid':
      return { path: '/paid' };
    case 'meta':
      return { path: '/ads' };
    case 'asa':
    case 'asa/campaigns':
      return { path: '/ads/asa' };
    default:
      return null;
  }
}

/** The answer's own range and filters, in the form the dashboard reads them (src/dashboard/lib/useQueryState.ts). */
function rangeOf(q: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const from = q.get('from');
  const to = q.get('to');
  if (from || to) {
    out.set('period', 'custom');
    if (from) out.set('from', from);
    if (to) out.set('to', to);
  } else if (q.get('period')) out.set('period', q.get('period')!);
  if (q.get('granularity')) out.set('granularity', q.get('granularity')!);
  const filters = q.get('filters');
  if (filters) {
    try {
      const f = JSON.parse(filters);
      if (f && typeof f === 'object' && !Array.isArray(f) && Object.keys(f).length) out.set('filters', JSON.stringify(f));
    } catch {
      // A malformed filter was refused or ignored by the route; the link leaves it out.
    }
  }
  return out;
}

/**
 * The dashboard URL for a read API request, or null when no screen shows it. `siteId` null is an answer across
 * sites (portfolio, weekly), which links to Home.
 */
export function dashboardUrl(requestUrl: string, siteId: string | null): string | null {
  const url = new URL(requestUrl);
  const route = url.pathname.replace(/^\/api\/v1\//, '').replace(/\/$/, '');
  const q = url.searchParams;
  if (route === 'portfolio' || route === 'weekly') {
    if (siteId && route === 'weekly') return `${url.origin}/site/${siteId}`;
    const p = q.get('period');
    return `${url.origin}/${p ? `?period=${encodeURIComponent(p)}` : ''}`;
  }
  if (!siteId) return null;
  const target = targetOf(route, q);
  if (!target) return null;
  const params = rangeOf(q);
  for (const [k, v] of Object.entries(target.params ?? {})) params.set(k, v);
  const s = params.toString();
  return `${url.origin}/site/${encodeURIComponent(siteId)}${target.path}${s ? `?${s}` : ''}`;
}

/** Answers this large keep the link in the header only: rewriting them would cost CPU for one field. */
const MAX_REWRITE_CHARS = 512_000;

/**
 * Middleware for /api/v1/*: a successful GET that a dashboard screen shows gets an X-Dashboard-Url header and, when
 * its body is a JSON object, a dashboard_url field first in it. A JSON array (customers) keeps the header only; the MCP
 * tools copy it into their answer (mcp.ts callTool).
 */
export async function dashboardLinks(c: Context<AppEnv>, next: Next) {
  await next();
  if (c.req.method !== 'GET' || c.res.status !== 200) return;
  if (!(c.res.headers.get('content-type') ?? '').includes('application/json')) return;
  const site = (c.get('site') as { id?: string } | undefined)?.id ?? c.get('linkSite') ?? null;
  const link = dashboardUrl(c.req.url, site);
  if (!link) return;
  // A new answer each time: an edge cache hit has immutable headers. Hono's c.res setter copies the old answer's
  // headers onto the new one unless c.res is cleared first (as auth.ts requireAuth does), which would bring back an
  // old Content-Length.
  const old = c.res;
  const headers = new Headers(old.headers);
  headers.set('x-dashboard-url', link);
  const size = Number(old.headers.get('content-length') ?? 0);
  // The raw SEO snapshot can be several MB: header only. That body and its length stay as they are.
  if (size > MAX_REWRITE_CHARS || HEADER_ONLY.test(new URL(c.req.url).pathname)) {
    c.res = undefined;
    c.res = new Response(old.body, { status: old.status, headers });
    return;
  }
  // The body grows by the field, so the old length goes.
  headers.delete('content-length');
  const text = await old.text();
  c.res = undefined;
  c.res = new Response(withLink(text, link), { status: 200, headers });
}

/** GET /api/v1/seo, the raw snapshot: the link goes in the header only. */
const HEADER_ONLY = /^\/api\/v1\/seo\/?$/;

/** The body with "dashboard_url" as the first field of its top-level object; any other body as it was. */
export function withLink(text: string, link: string): string {
  if (text.length > MAX_REWRITE_CHARS) return text;
  const body = text.trimStart();
  if (!body.startsWith('{')) return text;
  const field = `"dashboard_url":${JSON.stringify(link)}`;
  const rest = body.slice(1).trimStart();
  return rest.startsWith('}') ? `{${field}${rest}` : `{${field},${rest}`;
}
