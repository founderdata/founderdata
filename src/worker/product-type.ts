import type { Context, Hono } from 'hono';
import { forgetSite, type AppEnv, type Site } from './env';
import { makeCtx } from './stats';
import { previousRange } from './lib/time';
import { TREND_RULES } from '../shared/trend-rules';
import { hasApp } from '../shared/platform';

/** Below this headline number in the period before, a change is no verdict (home.ts MIN_BASE). */
const MIN_BASE_COUNT = 20;

/**
 * Product types (migration 0034, docs/GUIDE.md "Product types"). A site is a website, an iOS app, a browser extension
 * or a newsletter. An extension and a newsletter lead with their own numbers instead of bounce rate and session time,
 * on the site's Overview, on Home, in GET /api/v1/portfolio and in the weekly report. Both count goal events that the
 * event API (POST /api/event) already takes, so they need no new tracker:
 *
 * - extension: `install` (chrome.runtime.onInstalled), `active` (once a day from the background script) and
 *   `uninstall` (the page chrome.runtime.setUninstallURL opens). Weekly active is the visitors who sent `install` or
 *   `active` in the 7 days up to the end of the period.
 * - newsletter: `subscribe`, `unsubscribe` and `open`, sent by a newsletter tool's webhook through a few lines of
 *   relay code. Subscribers is every `subscribe` minus every `unsubscribe` up to the end of the period.
 *
 * Counts are events, not visitors, except weekly active. One batch of two statements for all typed sites; no query
 * when no site is an extension or a newsletter.
 */

export const PRODUCT_TYPES = ['website', 'app', 'extension', 'newsletter'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
/** The types with numbers of their own. */
export type CountedType = 'extension' | 'newsletter';

/** SQL: the ids of the sites whose type has numbers of its own. Their sessions are no web visits. */
export const COUNTED_SITES = "SELECT id FROM sites WHERE product_type IN ('extension', 'newsletter')";

export const isProductType = (v: unknown): v is ProductType => typeof v === 'string' && (PRODUCT_TYPES as readonly string[]).includes(v);

/** The site's type: the one picked in Settings, else app for a site with a bundle id, else website. */
export function productType(s: Pick<Site, 'product_type' | 'app_bundle_id' | 'android_package'>): ProductType {
  return isProductType(s.product_type) ? s.product_type : hasApp(s) ? 'app' : 'website';
}

export type MetricKey = 'installs' | 'weekly_active' | 'uninstalls' | 'subscribers' | 'new_subscribers' | 'unsubscribes' | 'opens';

/** The goal names each type counts. */
export const TYPE_EVENTS: Record<CountedType, readonly string[]> = {
  extension: ['install', 'active', 'uninstall'],
  newsletter: ['subscribe', 'unsubscribe', 'open'],
};

/** The tiles per type, in order, and the one that heads the site on Home and in the weekly report. */
export const TYPE_METRICS: Record<CountedType, { headline: MetricKey; metrics: { key: MetricKey; label: string }[] }> = {
  extension: {
    headline: 'weekly_active',
    metrics: [
      { key: 'installs', label: 'Installs' },
      { key: 'weekly_active', label: 'Weekly active' },
      { key: 'uninstalls', label: 'Uninstalls' },
    ],
  },
  newsletter: {
    headline: 'subscribers',
    metrics: [
      { key: 'subscribers', label: 'Subscribers' },
      { key: 'new_subscribers', label: 'New subscribers' },
      { key: 'unsubscribes', label: 'Unsubscribes' },
      { key: 'opens', label: 'Opens' },
    ],
  },
};

export interface ProductMetric {
  key: MetricKey;
  label: string;
  value: number;
  previous: number;
  /** Whole percent against `previous`; null when `previous` is 0. */
  change_pct: number | null;
}

/** A typed site's numbers, as /api/home, the portfolio and the weekly report send them. */
export interface ProductNumbers {
  type: CountedType;
  headline: MetricKey;
  metrics: ProductMetric[];
}

const DAY = 86_400_000;
const pctOf = (value: number, previous: number) => (previous > 0 ? Math.round(((value - previous) / previous) * 100) : null);

/**
 * The numbers of every extension and newsletter in `sites` for the period `range` against `before`. Weekly active
 * counts the 7 days up to the end of the period (or now, when the period runs on) against the 7 days before those.
 */
export async function productNumbers(
  db: D1Database,
  sites: Pick<Site, 'id' | 'product_type' | 'app_bundle_id' | 'android_package'>[],
  range: { from: number; to: number },
  before: { from: number; to: number },
  now = Date.now(),
): Promise<Map<string, ProductNumbers>> {
  const out = new Map<string, ProductNumbers>();
  const typed = sites.map((s) => [s.id, productType(s)] as const).filter((x): x is readonly [string, CountedType] => x[1] === 'extension' || x[1] === 'newsletter');
  if (!typed.length) return out;
  const ids = typed.map(([id]) => id);
  const marks = ids.map(() => '?').join(', ');
  const end = Math.min(range.to, now);
  const names = [...TYPE_EVENTS.extension, ...TYPE_EVENTS.newsletter];
  const [counts, active] = await db.batch([
    // Per site and name: the period, the period before, everything up to the period's end and up to its start.
    // Subscribes and unsubscribes count from the first one; the other names only from the period before.
    db
      .prepare(
        `SELECT e.site_id, e.name,
                SUM(CASE WHEN e.ts >= ?1 THEN 1 ELSE 0 END) AS cur,
                SUM(CASE WHEN e.ts >= ?3 AND e.ts < ?4 THEN 1 ELSE 0 END) AS prev,
                COUNT(*) AS upto,
                SUM(CASE WHEN e.ts < ?1 THEN 1 ELSE 0 END) AS upto_before
         FROM events e
         WHERE e.site_id IN (${ids.map((_, i) => `?${i + 5 + names.length}`).join(', ')}) AND e.ts < ?2 AND e.type = 'goal'
           AND e.name IN (${names.map((_, i) => `?${i + 5}`).join(', ')})
           AND (e.name IN ('subscribe', 'unsubscribe') OR e.ts >= ?3)
         GROUP BY e.site_id, e.name`,
      )
      .bind(range.from, range.to, before.from, before.to, ...names, ...ids),
    // Weekly active: visitors who sent install or active in the last 7 days, and in the 7 before.
    db
      .prepare(
        `SELECT e.site_id, (e.ts >= ?) AS cur, COUNT(DISTINCT e.visitor_id) AS n FROM events e
         WHERE e.site_id IN (${marks}) AND e.ts >= ? AND e.ts < ? AND e.type = 'goal' AND e.name IN ('install', 'active')
         GROUP BY e.site_id, cur`,
      )
      .bind(end - 7 * DAY, ...ids, end - 14 * DAY, end),
  ]);
  const by = new Map<string, Map<string, { cur: number; prev: number; upto: number; upto_before: number }>>();
  for (const r of counts.results as any[]) {
    if (!by.has(r.site_id)) by.set(r.site_id, new Map());
    by.get(r.site_id)!.set(r.name, { cur: Number(r.cur), prev: Number(r.prev), upto: Number(r.upto), upto_before: Number(r.upto_before) });
  }
  const wau = new Map<string, { cur: number; prev: number }>();
  for (const r of active.results as any[]) {
    const e = wau.get(r.site_id) ?? { cur: 0, prev: 0 };
    if (r.cur) e.cur = Number(r.n);
    else e.prev = Number(r.n);
    wau.set(r.site_id, e);
  }
  for (const [id, type] of typed) {
    const n = (name: string) => by.get(id)?.get(name) ?? { cur: 0, prev: 0, upto: 0, upto_before: 0 };
    const values: Record<MetricKey, [number, number]> = {
      installs: [n('install').cur, n('install').prev],
      weekly_active: [wau.get(id)?.cur ?? 0, wau.get(id)?.prev ?? 0],
      uninstalls: [n('uninstall').cur, n('uninstall').prev],
      // Subscribers at the end of the period, and at its start; never below 0 when unsubscribes came from before tracking.
      subscribers: [Math.max(0, n('subscribe').upto - n('unsubscribe').upto), Math.max(0, n('subscribe').upto_before - n('unsubscribe').upto_before)],
      new_subscribers: [n('subscribe').cur, n('subscribe').prev],
      unsubscribes: [n('unsubscribe').cur, n('unsubscribe').prev],
      opens: [n('open').cur, n('open').prev],
    };
    const t = TYPE_METRICS[type];
    out.set(id, {
      type,
      headline: t.headline,
      metrics: t.metrics.map(({ key, label }) => ({ key, label, value: values[key][0], previous: values[key][1], change_pct: pctOf(values[key][0], values[key][1]) })),
    });
  }
  return out;
}

/** The metric a typed site leads with. */
export const headlineOf = (p: ProductNumbers): ProductMetric => p.metrics.find((m) => m.key === p.headline)!;

/**
 * Home's status for an extension or a newsletter without payments: its headline number decides, as revenue does for
 * a site with payments. 10% or more up is growing, 10% or more down is declining, on a base of at least 20. A quiet
 * site stays quiet; a site with payments keeps the revenue verdict.
 */
export function productTrend<T extends { status: string }>(trend: T, r: { payments: boolean; product: ProductNumbers | null }): T {
  if (!r.product || r.payments || trend.status === 'quiet') return trend;
  const h = headlineOf(r.product);
  const status =
    h.previous < MIN_BASE_COUNT ? 'flat' : h.value >= h.previous * (1 + TREND_RULES.revenueShare) ? 'growing' : h.value <= h.previous * (1 - TREND_RULES.revenueShare) ? 'declining' : 'flat';
  return { ...trend, status };
}

// ---------- GET /api/sites/:id/product and PUT /api/sites/:id/type

/** GET /api/sites/:id/product?period=: the Overview's lead tiles. `product` is null for a website or an app. */
async function getProduct(c: Context<AppEnv>) {
  const ctx = makeCtx(c);
  const site = ctx.site;
  const before = previousRange(ctx.range, ctx.period, site.timezone);
  const numbers = await productNumbers(c.env.DB, [site], ctx.range, before);
  return c.json({ type: productType(site), product: numbers.get(site.id) ?? null });
}

/** The type a new site asks for in POST /api/sites: null for automatic, or an error. */
export function typeOnCreate(raw: unknown, bundle: string | null): { type: ProductType | null } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { type: null };
  if (!isProductType(raw)) return { error: `type is one of ${PRODUCT_TYPES.join(', ')}` };
  if (raw === 'app' && !bundle) return { error: 'An app needs its bundle id' };
  return { type: raw === 'website' && !bundle ? null : raw };
}

/** PUT /api/sites/:id/type { type }: one of PRODUCT_TYPES, or null for automatic. Writes 1 row. */
async function putType(c: Context<AppEnv>) {
  const site = c.get('site');
  const b = await c.req.json<{ type?: unknown }>().catch(() => null);
  if (!b || !('type' in b)) return c.json({ error: 'Send { "type": "extension" }, or { "type": null } for automatic' }, 400);
  if (b.type !== null && !isProductType(b.type)) return c.json({ error: `type is one of ${PRODUCT_TYPES.join(', ')}, or null` }, 400);
  if (b.type === 'app' && !hasApp(site)) return c.json({ error: "Add the app's bundle id or package name under General first" }, 400);
  await c.env.DB.prepare('UPDATE sites SET product_type = ? WHERE id = ?').bind(b.type, site.id).run();
  forgetSite(site.id);
  return c.json({ type: productType({ ...site, product_type: b.type as ProductType | null }), product_type: b.type });
}

/** Mounted in index.ts after the login and site middleware of /api/sites/:id/*. */
export function registerProductType(app: Hono<AppEnv>) {
  app.get('/api/sites/:id/product', getProduct);
  app.put('/api/sites/:id/type', putType);
}
