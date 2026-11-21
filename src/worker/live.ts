// GET /api/live: who is on the sites right now, for the dashboard's globe and the phone (docs/MOBILE-API.md section 9).
//
// One D1 batch, reads only, every statement on an index:
//   sites      every site (a handful of rows)
//   online     sessions started in the last 6 hours (sessions_site_time) that were seen in the last 5 minutes, one row
//              per visitor, with "has paid before" from one probe each into payments_visitor (migration 0063)
//   events     the last 60 minutes of payments (payments_site_time), trials (subscriptions_trial), and goals
//              (events_site_time) that are a sign-up or the site's primary goal, each with its visit's location
//   places     visitors seen in the last placesMinutes (default 24 hours, ?placesMinutes=30 to 1440), by country and
//              city (skipped with ?places=0)
//   recent     the same visitors one by one, newest activity first, at most MAX_VISITORS (skipped with ?places=0)
//   window     what the page shows for that window besides the list: visitors per site, payments per currency, and
//              the newest MAX_EVENTS events (skipped with ?places=0)
// The dashboard polls every 10 to 15 seconds while its tab is visible, so it asks for places less often.
//
// Privacy: the answer carries no stored visitor or session id (each visit gets an HMAC of its session id, cut to 8
// hex characters), no name, email or user id, and coordinates rounded to one decimal, as they are stored.
import { countedAllSql } from './datacenter';
import type { Context } from 'hono';
import type { AppEnv } from './env';
import { TEST_PROVIDERS_SQL } from './payments';
import { isAppHost } from '../shared/platform';

/** "Online" means seen in this many minutes, as on the home page. */
export const LIVE_WINDOW_MINUTES = 5;
/** Only sessions started this recently can be online: bounds the index range, as the home page's online count does. */
const ONLINE_STARTED_MS = 6 * 3_600_000;
export const MAX_VISITORS = 150;
export const MAX_EVENTS = 30;
export const MAX_PLACES = 60;
/** Upper bound on online rows read into memory; the counts are exact up to this many visitors online. */
const ONLINE_ROWS = 5000;
const EVENTS_MS = 60 * 60_000;
/** The places window: 24 hours unless the caller asks for less (?placesMinutes=), never more. */
export const PLACES_MINUTES_MAX = 24 * 60;
const PLACES_MINUTES_MIN = 5;

/** A placesMinutes query value as a whole number of minutes from 5 to 1440, or the 24-hour default. */
export function placesMinutesOf(raw: string | undefined | null): number {
  const n = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(n)) return PLACES_MINUTES_MAX;
  return Math.min(PLACES_MINUTES_MAX, Math.max(PLACES_MINUTES_MIN, n));
}

export type LiveEventKind = 'payment' | 'trial' | 'signup' | 'goal';

export interface LiveVisitor {
  id: string;
  siteId: string;
  platform: 'web' | 'app';
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  page: string | null;
  source: string | null;
  device: 'desktop' | 'mobile' | 'tablet' | null;
  customer: boolean;
  startedAt: number;
  lastSeenAt: number;
}

export interface LiveEvent {
  ts: number;
  siteId: string;
  kind: LiveEventKind;
  label: string | null;
  amount: number | null;
  currency: string | null;
  country: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

export interface LivePlace {
  country: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
  visitors: number;
}

export interface LiveAnswer {
  now: number;
  windowMinutes: number;
  online: number;
  sites: { id: string; name: string; domain: string; online: number }[];
  visitors: LiveVisitor[];
  events: LiveEvent[];
  /** Null when the call asked for none (?places=0). */
  places: LivePlace[] | null;
  /** The window `places` covers, in minutes; null with ?places=0. */
  placesMinutes: number | null;
  /** The visitors seen in that window, one per visitor and site, newest activity first; null with ?places=0. */
  recent: LiveVisitor[] | null;
  /** How many visitors that window had, per visitor and site as `online` counts them; null with ?places=0. */
  recentCount: number | null;
  /** The sites with a visitor in that window, most visitors first; null with ?places=0. */
  recentSites: { id: string; name: string; domain: string; visitors: number }[] | null;
  /** That window's payments per currency, largest first; null with ?places=0. */
  recentRevenue: { currency: string; amount: number; payments: number }[] | null;
  /** That window's events in the shape of `events`, newest first, at most MAX_EVENTS; null with ?places=0. */
  recentEvents: LiveEvent[] | null;
}

/**
 * A goal that counts as a sign-up: its name, lowercased with spaces and hyphens read as underscores, is one of these
 * words (a newsletter's `subscribe` included) or ends in `_signup` or `_sign_up` (newsletter_signup). signup_click and
 * signup_started are steps, not sign-ups.
 */
export const SIGNUP_NAMES = ['signup', 'sign_up', 'signed_up', 'register', 'registered', 'registration', 'create_account', 'account_created', 'subscribe', 'subscribed'];
const NORMALIZED = `replace(replace(lower(e.name), '-', '_'), ' ', '_')`;
const IS_SIGNUP = `(${NORMALIZED} IN (${SIGNUP_NAMES.map((n) => `'${n}'`).join(', ')}) OR ${NORMALIZED} LIKE '%\\_signup' ESCAPE '\\' OR ${NORMALIZED} LIKE '%\\_sign\\_up' ESCAPE '\\')`;

/** One decimal at most, whatever the row holds (older rows and averages included). */
const coord = (v: unknown, max: number): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 10) / 10 || 0 : null;
};
const deviceOf = (d: unknown): LiveVisitor['device'] => {
  const v = String(d ?? '').toLowerCase();
  return v === 'desktop' || v === 'mobile' || v === 'tablet' ? v : null;
};
const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

const ALL_SITES = 'SELECT id FROM sites';
const AT = `s.country, s.city, s.lat, s.lon`;
/** One row per visitor and site: the visit seen last (SQLite's bare columns follow MAX), with what the list shows. */
const VISIT = `s.site_id, s.visitor_id, s.id AS sid, MAX(s.last_seen_at) AS last_seen, s.started_at, s.hostname, s.region, ${AT},
               s.exit_page, s.source, s.device`;
/** "Has paid before" for a visitor row `r`: a real payment, refunds and sandbox purchases left out. */
const CUSTOMER = `EXISTS (SELECT 1 FROM payments p WHERE p.site_id = r.site_id AND p.visitor_id = r.visitor_id AND p.kind = 'payment'
                    AND p.provider NOT IN ${TEST_PROVIDERS_SQL}) AS customer`;

const REAL_PAYMENT = `p.kind = 'payment' AND p.provider NOT IN ${TEST_PROVIDERS_SQL}`;

/** Payments, trials, sign-ups and primary goals from `since` to `now`, newest first, each with its visit's location. */
function eventsStatement(db: D1Database, since: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT p.ts, p.site_id, 'payment' AS kind, p.product AS label, p.amount, p.currency, ${AT}
         FROM payments p LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.session_id
         WHERE p.site_id IN (${ALL_SITES}) AND p.ts >= ?1 AND p.ts <= ?2 AND ${REAL_PAYMENT}
         UNION ALL
         SELECT sub.trial_start, sub.site_id, 'trial', sub.product, NULL, NULL, ${AT}
         FROM subscriptions sub LEFT JOIN sessions s ON s.site_id = sub.site_id AND s.id = sub.session_id
         WHERE sub.site_id IN (${ALL_SITES}) AND sub.trial_start >= ?1 AND sub.trial_start <= ?2 AND sub.sandbox = 0
         UNION ALL
         SELECT e.ts, e.site_id, CASE WHEN ${IS_SIGNUP} THEN 'signup' ELSE 'goal' END, e.name, NULL, NULL, ${AT}
         FROM events e JOIN sites st ON st.id = e.site_id LEFT JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
         WHERE e.site_id IN (${ALL_SITES}) AND e.ts >= ?1 AND e.ts <= ?2 AND e.type = 'goal' AND (${IS_SIGNUP} OR e.name = st.primary_goal)
       ) ORDER BY ts DESC, kind LIMIT ${MAX_EVENTS}`,
    )
    .bind(since, now);
}

/** The batch, in the order liveData reads it. Exported so tests can check that each statement uses an index. */
export function liveStatements(db: D1Database, now: number, places: boolean, placesMinutes = PLACES_MINUTES_MAX): D1PreparedStatement[] {
  const since = now - EVENTS_MS;
  // A visitor seen in the window may have started up to 6 hours before it (the online rule's bound), never more than
  // 24 hours ago, so the index range on started_at stays as narrow as the window allows.
  const placesMs = placesMinutes * 60_000;
  const placesStarted = now - Math.min(placesMs + ONLINE_STARTED_MS, PLACES_MINUTES_MAX * 60_000);
  return [
    db.prepare('SELECT id, name, domain FROM sites ORDER BY created_at'),
    db
      .prepare(
        `SELECT r.*, ${CUSTOMER} FROM (
           SELECT ${VISIT}
           FROM sessions s
           WHERE s.site_id IN (${ALL_SITES}) AND s.started_at > ?1 AND s.last_seen_at > ?2${countedAllSql('s')}
           GROUP BY s.site_id, s.visitor_id
           ORDER BY last_seen DESC, s.site_id, s.visitor_id
           LIMIT ${ONLINE_ROWS}
         ) r ORDER BY r.last_seen DESC, r.site_id, r.visitor_id`,
      )
      .bind(now - ONLINE_STARTED_MS, now - LIVE_WINDOW_MINUTES * 60_000),
    eventsStatement(db, since, now),
    ...(places
      ? [
          db
            .prepare(
              `SELECT country, city, AVG(lat) AS lat, AVG(lon) AS lon, COUNT(DISTINCT visitor_id) AS visitors
               FROM sessions
               WHERE site_id IN (${ALL_SITES}) AND started_at > ?1 AND last_seen_at > ?2 AND country IS NOT NULL AND country != ''${countedAllSql('sessions')}
               GROUP BY country, city
               ORDER BY visitors DESC, country, city
               LIMIT ${MAX_PLACES}`,
            )
            .bind(placesStarted, now - placesMs),
          // The same visits one by one. The payments probe runs on the kept rows only, not on every visitor of the day.
          db
            .prepare(
              `SELECT r.*, ${CUSTOMER} FROM (
                 SELECT ${VISIT}
                 FROM sessions s
                 WHERE s.site_id IN (${ALL_SITES}) AND s.started_at > ?1 AND s.last_seen_at > ?2${countedAllSql('s')}
                 GROUP BY s.site_id, s.visitor_id
                 ORDER BY last_seen DESC, s.site_id, s.visitor_id
                 LIMIT ${MAX_VISITORS}
               ) r ORDER BY r.last_seen DESC, r.site_id, r.visitor_id`,
            )
            .bind(placesStarted, now - placesMs),
          // Every visitor of the window, counted per site: the list above stops at MAX_VISITORS.
          db
            .prepare(
              `SELECT s.site_id, COUNT(DISTINCT s.visitor_id) AS visitors
               FROM sessions s
               WHERE s.site_id IN (${ALL_SITES}) AND s.started_at > ?1 AND s.last_seen_at > ?2${countedAllSql('s')}
               GROUP BY s.site_id`,
            )
            .bind(placesStarted, now - placesMs),
          db
            .prepare(
              `SELECT p.currency, SUM(p.amount) AS amount, COUNT(*) AS payments
               FROM payments p
               WHERE p.site_id IN (${ALL_SITES}) AND p.ts >= ?1 AND p.ts <= ?2 AND ${REAL_PAYMENT}
               GROUP BY p.currency`,
            )
            .bind(now - placesMs, now),
          eventsStatement(db, now - placesMs, now),
        ]
      : []),
  ];
}

/** The visit's opaque id: HMAC-SHA256 of its session id under a key derived from SESSION_SECRET, 8 hex characters. */
async function visitIds(secret: string, sessionIds: string[]): Promise<string[]> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(`live|${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Promise.all(
    sessionIds.map(async (sid) => {
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(sid)));
      return Array.from(mac.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
    }),
  );
}

/** Visitor rows (online or recent) as the answer lists them, each with its opaque visit id. */
async function visitorsOf(secret: string, rows: Record<string, unknown>[]): Promise<LiveVisitor[]> {
  const ids = await visitIds(secret, rows.map((r) => String(r.sid)));
  return rows.map((r, i) => ({
    id: ids[i],
    siteId: String(r.site_id),
    platform: isAppHost(text(r.hostname)) ? 'app' : 'web',
    country: text(r.country),
    region: text(r.region),
    city: text(r.city),
    lat: coord(r.lat, 90),
    lon: coord(r.lon, 180),
    page: text(r.exit_page),
    source: text(r.source),
    device: deviceOf(r.device),
    customer: !!r.customer,
    startedAt: Number(r.started_at),
    lastSeenAt: Number(r.last_seen),
  }));
}

export async function liveData(db: D1Database, secret: string, now = Date.now(), opts: { places?: boolean; placesMinutes?: number } = {}): Promise<LiveAnswer> {
  const places = opts.places !== false;
  const placesMinutes = opts.placesMinutes ?? PLACES_MINUTES_MAX;
  const [siteRes, onlineRes, eventRes, placeRes, recentRes, countRes, revenueRes, windowEventRes] = await db.batch(liveStatements(db, now, places, placesMinutes));
  const online = onlineRes.results as Record<string, unknown>[];
  const perSite = new Map<string, number>();
  for (const r of online) perSite.set(String(r.site_id), (perSite.get(String(r.site_id)) ?? 0) + 1);

  const visitors = await visitorsOf(secret, online.slice(0, MAX_VISITORS));
  const recent = recentRes ? await visitorsOf(secret, recentRes.results as Record<string, unknown>[]) : null;

  const eventsOf = (res: D1Result): LiveEvent[] =>
    (res.results as Record<string, unknown>[]).map((r) => ({
      ts: Number(r.ts),
      siteId: String(r.site_id),
      kind: r.kind as LiveEventKind,
      label: text(r.label),
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      currency: text(r.currency),
      country: text(r.country),
      city: text(r.city),
      lat: coord(r.lat, 90),
      lon: coord(r.lon, 180),
    }));
  const events = eventsOf(eventRes);

  const allSites = siteRes.results as { id: string; name: string; domain: string }[];
  const seen = new Map<string, number>();
  for (const r of (countRes?.results ?? []) as Record<string, unknown>[]) seen.set(String(r.site_id), Number(r.visitors));

  const sites = allSites
    .map((s) => ({ id: s.id, name: s.name, domain: s.domain, online: perSite.get(s.id) ?? 0 }))
    .filter((s) => s.online > 0)
    .sort((a, b) => b.online - a.online);

  return {
    now,
    windowMinutes: LIVE_WINDOW_MINUTES,
    online: online.length,
    sites,
    visitors,
    events,
    places: placeRes
      ? (placeRes.results as Record<string, unknown>[]).map((r) => ({
          country: String(r.country),
          city: text(r.city),
          lat: coord(r.lat, 90),
          lon: coord(r.lon, 180),
          visitors: Number(r.visitors),
        }))
      : null,
    placesMinutes: placeRes ? placesMinutes : null,
    recent,
    recentCount: countRes ? [...seen.values()].reduce((a, b) => a + b, 0) : null,
    recentSites: countRes
      ? allSites
          .map((s) => ({ id: s.id, name: s.name, domain: s.domain, visitors: seen.get(s.id) ?? 0 }))
          .filter((s) => s.visitors > 0)
          .sort((a, b) => b.visitors - a.visitors)
      : null,
    recentRevenue: revenueRes
      ? (revenueRes.results as Record<string, unknown>[])
          .filter((r) => text(r.currency))
          .map((r) => ({ currency: String(r.currency), amount: Number(r.amount ?? 0), payments: Number(r.payments) }))
          .sort((a, b) => b.amount - a.amount)
      : null,
    recentEvents: windowEventRes ? eventsOf(windowEventRes) : null,
  };
}

/**
 * GET /api/live[?places=0][&placesMinutes=60]. Auth is requireAuth's (index.ts): the dashboard login, owner or viewer,
 * or a phone's token.
 */
export async function liveRoute(c: Context<AppEnv>) {
  const places = c.req.query('places') !== '0';
  const placesMinutes = placesMinutesOf(c.req.query('placesMinutes'));
  c.header('cache-control', 'no-store');
  return c.json(await liveData(c.env.DB, c.env.SESSION_SECRET ?? '', Date.now(), { places, placesMinutes }));
}
