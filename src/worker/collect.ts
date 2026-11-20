import type { Context } from 'hono';
import { propsJson } from './lib/props';
import { classify, clickIdOf } from '../shared/sources';
import { datacenterOf } from './datacenter';
import { FIRST_TOUCH_FILL_MS, upgradeFirstTouch } from './first-touch';
import { getSite, type AppEnv, type Site } from './env';
import { clientIp, cookielessIds, trustsForwardedFor, visitorSecret } from './identity';
import { isBot, parseUA } from './lib/ua';
import { overCap, rowsWritten, spend } from './budget';
import { creditedVisitSql } from './payments';
import { isSkipped, skipList } from './recording';
import { insertVitals, parseVitals, vitalsPath } from './vitals';
import { proHooks, type RecordConfig } from './pro-hooks';

const TYPES = new Set(['pageview', 'goal', 'outbound', 'ping', 'identify']);
const MAX_PING_MS = 10 * 60_000;

interface Payload {
  w: string;
  t: string;
  u: string;
  r?: string;
  /** Absent in cookieless mode: the server derives both ids and returns them. */
  vid: string;
  sid: string;
  sw?: number;
  n?: string;
  p?: Record<string, unknown>;
  d?: number;
  /** Core Web Vitals, on the ping sent when the page is hidden (vitals.ts). */
  v?: unknown;
  /** Marketing consent: 1 given (founderdata('marketing', true) or data-marketing="on"), 0 withdrawn on this page. */
  m?: number;
  /** The Meta browser id (_fbp cookie), sent only with marketing consent. */
  fbp?: string;
  /** Page activity (clicks, rage clicks, errors) of the page that ended, on its ping. Only for recorded visits. */
  a?: unknown;
}

const clip = (s: unknown, n = 255): string | null =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

/** identify() keys that are columns of the visitor row, not traits. */
const IDENTITY_KEYS = new Set(['user_id', 'id', 'email', 'name']);
export const MAX_TRAITS = 20;

/**
 * The traits of an identify() call as JSON text, or null when it has none: the extra keys next to user_id, email and
 * name. At most 20, keys lowercased and matching [a-z0-9_]{1,40}, values text clipped to 100 characters (numbers and
 * true or false as text). Objects, arrays, null and empty text are left out.
 */
export function traitsOf(p: Record<string, unknown>): string | null {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (n >= MAX_TRAITS) break;
    const key = k.toLowerCase();
    if (IDENTITY_KEYS.has(key) || !/^[a-z0-9_]{1,40}$/.test(key) || key in out) continue;
    const text = typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? String(v) : '';
    if (!text) continue;
    out[key] = text.slice(0, 100);
    n++;
  }
  return n ? JSON.stringify(out) : null;
}

/** Most clicks and errors one page's activity row keeps (docs/API.md, "Page activity"). */
export const MAX_CLICKS = 30;
export const MAX_ERRORS = 5;
const CLICK_KINDS = new Set(['button', 'link', 'submit', 'other']);
const DAY_MS = 86_400_000;

/**
 * The activity a ping carries, checked and trimmed, as the props of an `activity` event row, or null when there is
 * nothing to keep. Shape: { p: path, s: page start (ms), c: clicks [{ t, l, k, r?, n? }], e: errors [{ t, m, s }] },
 * `t` in ms since `s`. Clicks keep the newest 30, errors the newest 5.
 */
export function parseActivity(a: unknown): { path: string | null; props: string } | null {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const x = a as { p?: unknown; s?: unknown; c?: unknown; e?: unknown };
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= DAY_MS ? Math.round(v) : null);
  const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const clicks: { t: number; l: string; k: string; r?: 1; n?: number }[] = [];
  for (const c of Array.isArray(x.c) ? x.c.slice(-MAX_CLICKS) : []) {
    const t = ms(c?.t);
    const l = text(c?.l, 40);
    if (t === null || !l) continue;
    const click: (typeof clicks)[number] = { t, l, k: CLICK_KINDS.has(c.k) ? c.k : 'other' };
    const n = Number(c.n);
    if (Number.isInteger(n) && n >= 2) click.n = Math.min(n, 1000);
    if (c.r === 1 && (click.n ?? 0) >= 3) click.r = 1;
    clicks.push(click);
  }
  const errors: { t: number; m: string; s: string }[] = [];
  for (const e of Array.isArray(x.e) ? x.e.slice(-MAX_ERRORS) : []) {
    const t = ms(e?.t);
    const m = text(e?.m, 200);
    if (t === null || !m) continue;
    errors.push({ t, m, s: text(e?.s, 200) });
  }
  if (!clicks.length && !errors.length) return null;
  const s = typeof x.s === 'number' && Number.isInteger(x.s) && x.s > 0 ? x.s : null;
  const path = typeof x.p === 'string' && x.p.startsWith('/') ? normalizePath(x.p.split(/[?#]/)[0]) : null;
  return { path, props: JSON.stringify({ ...(s ? { s } : {}), ...(clicks.length ? { c: clicks } : {}), ...(errors.length ? { e: errors } : {}) }) };
}

/** The _fbp value a payload with marketing consent carries, or null (Meta's format: fb.1.<ms>.<random>). */
export const fbpOf = (body: { m?: number; fbp?: unknown }): string | null =>
  body.m === 1 && typeof body.fbp === 'string' && /^fb\.\d\.\d{10,13}\.\d{1,20}$/.test(body.fbp) ? body.fbp : null;

/**
 * The Meta ad click a landing URL carries (docs/GUIDE.md, "Meta ads"): `fbclid`, which Meta adds to ad and organic link
 * clicks alike, and `ad_id={{ad.id}}` from the ad's URL parameters, which only an ad has. The user agent is kept with a
 * click for the Conversions API, which needs it for website events (pro/worker/meta-capi.ts); other visits keep none.
 */
export function metaClick(q: URLSearchParams): { fbclid: string | null; adId: string | null } {
  const f = q.get('fbclid')?.trim() ?? '';
  const a = q.get('ad_id')?.trim() ?? '';
  return {
    fbclid: /^[\w.-]{10,500}$/.test(f) ? f : null,
    // Meta ids are digits; an unfilled macro ("{{ad.id}}") or anything else is not one.
    adId: /^\d{5,25}$/.test(a) ? a : null,
  };
}

/**
 * The browser's first language from an Accept-Language header: the primary subtag of the tag with the highest weight,
 * lowercase ("de-DE,de;q=0.9,en;q=0.8" is "de"). Null for none, "*" or anything that is not a language subtag.
 */
export function languageOf(header: string | null | undefined): string | null {
  if (!header) return null;
  let best: { tag: string; q: number } | null = null;
  for (const part of header.slice(0, 500).split(',')) {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag.trim().toLowerCase().split('-')[0];
    if (!/^[a-z]{2,3}$/.test(tag)) continue;
    const qp = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    const q = qp ? Number(qp.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { tag, q };
  }
  return best?.tag ?? null;
}

/** What the request itself says about a new visit, apart from the payload: the browser language and the network. */
export interface RequestFacts {
  language: string | null;
  /** 1 = from a hosting network (src/worker/datacenter.ts). */
  datacenter: 0 | 1;
}

export function normalizePath(pathname: string): string {
  let p = pathname || '/';
  try {
    p = decodeURI(p);
  } catch {}
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 500);
}

function stripWww(h: string) {
  return h.replace(/^www\./, '').toLowerCase();
}

/** Is `hostname` the site's domain or one of its subdomains? */
export function belongsTo(hostname: string, domain: string): boolean {
  const h = stripWww(hostname);
  const d = stripWww(domain);
  return h === d || h.endsWith('.' + d);
}

export async function handleEvent(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.body(null, 413);
  let body: Payload;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  if (!body || !isId(body.w) || !TYPES.has(body.t)) return c.body(null, 400);
  const cookieless = body.vid === undefined && body.sid === undefined;
  if (!cookieless && (!isId(body.vid) || !isId(body.sid))) return c.body(null, 400);

  const ua = c.req.header('user-agent') ?? '';
  if (isBot(ua)) return c.body(null, 202);

  const site = await getSite(c.env.DB, body.w);
  if (!site) return c.body(null, 404);

  let url: URL;
  try {
    url = new URL(body.u);
  } catch {
    return c.body(null, 400);
  }
  // Only accept data for the site's own domain, so nobody can pollute your stats from elsewhere.
  if (!belongsTo(url.hostname, site.domain)) return c.body(null, 403);

  const now = Date.now();
  // Past the site's daily write cap: drop the event. 202 like a bot, so the visitor's console stays quiet.
  // A remembered visitor keeps the cookies on a capped day: the answer still says Remember visitors is on.
  if (await overCap(c.env.DB, site, now)) return body.t === 'pageview' && site.remember_visitors ? c.json({ cfg: { rm: 1 } }, 202) : c.body(null, 202);
  if (cookieless) {
    const ids = await cookielessIds(c.env.DB, visitorSecret(c.env), site.id, clientIp((n) => c.req.header(n), trustsForwardedFor(c.env.TRUST_FORWARDED_FOR)), ua, now);
    body.vid = ids.vid;
    body.sid = ids.sid;
  }
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;
  const facts: RequestFacts = { language: languageOf(c.req.header('accept-language')), datacenter: datacenterOf(cf?.asn, (n) => c.req.header(n), trustsForwardedFor(c.env.TRUST_FORWARDED_FOR)) };
  // A pageview asks Pro whether to record this visit while it writes, so the answer costs no extra round trip.
  const [written, cfg] = await Promise.all([
    ingest(c.env.DB, site, body, url, ua, geoOf(c), now, facts),
    body.t === 'pageview' ? trackerConfig(c.env, site, body.sid, now, facts) : null,
  ]);
  c.executionCtx.waitUntil(spend(c.env.DB, site, written, now));
  // The tracker keeps the ids in memory (never in storage) so later events and attribution() use them. `cfg` is there
  // only when the site turned on Record visits or Remember visitors (docs/API.md, "Tracker config").
  if (cookieless) return c.json({ vid: body.vid, sid: body.sid, ...(cfg ? { cfg } : {}) }, 202);
  return cfg ? c.json({ cfg }, 202) : c.body(null, 202);
}

/** What the pageview answer tells the tracker (docs/API.md, "Tracker config"). Absent keys are off. */
export interface TrackerConfig {
  /** Record this visit: load /js/replay.js with these settings (FounderData Pro's recordDecision). */
  rec?: RecordConfig;
  /** Remember visitors: keep the visitor id in first-party cookies, as after founderdata('consent', true). */
  rm?: 1;
}

/**
 * The tracker config of one pageview, or null when every switch is off. A site with Record visits off asks nothing; one
 * with it on asks Pro (a read), and records nothing without Pro or without the REPLAY_BUCKET binding. A visit from a
 * hosting network (datacenter.ts) is never recorded: it is almost always a bot, and Pro is not asked.
 */
export async function trackerConfig(
  env: AppEnv['Bindings'],
  site: Site,
  sid: string,
  now: number,
  facts: Pick<RequestFacts, 'datacenter'> = { datacenter: 0 },
): Promise<TrackerConfig | null> {
  const cfg: TrackerConfig = {};
  if (site.remember_visitors) cfg.rm = 1;
  const decide = site.record_visits && env.REPLAY_BUCKET && !facts.datacenter ? proHooks()?.recordDecision : undefined;
  if (decide) {
    const rec = await Promise.resolve()
      .then(() => decide(env, site, sid, now))
      .catch(() => null);
    // Wait for consent: the tracker holds the recording until the visitor consents to cookies (migration 0075).
    if (rec) cfg.rec = site.record_consent ? { ...rec, c: 1 } : rec;
  }
  return cfg.rm || cfg.rec ? cfg : null;
}

export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  /** Rounded to one decimal (coarseCoord), about 11 km; null when the lookup has none. Read by GET /api/live. */
  lat?: number | null;
  lon?: number | null;
}

/**
 * A latitude or longitude from the IP lookup, rounded to one decimal (about 11 km), so the stored point is never finer
 * than the city name stored beside it (docs/PRIVACY.md). Null for anything that is not a number in range.
 */
export function coarseCoord(v: unknown, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  // 0 rather than -0, so JSON and SQLite agree.
  return Math.round(n * 10) / 10 || 0;
}

/**
 * Visitor location. When the script is proxied through your own domain (to dodge ad blockers),
 * Cloudflare sees the proxy's location, so trust the proxy's geo headers when present (Vercel sets these).
 * Any client can send those headers, so they count only with TRUST_FORWARDED_FOR, like X-Forwarded-For.
 */
export function geoOf(c: Context<AppEnv>): Geo {
  const h = (n: string) => {
    const v = c.req.header(n);
    try {
      return v ? decodeURIComponent(v) : null;
    } catch {
      return v ?? null;
    }
  };
  if (trustsForwardedFor(c.env.TRUST_FORWARDED_FOR) && h('x-vercel-ip-country')) {
    return {
      country: h('x-vercel-ip-country'),
      region: h('x-vercel-ip-country-region'),
      city: h('x-vercel-ip-city'),
      lat: coarseCoord(h('x-vercel-ip-latitude'), 90),
      lon: coarseCoord(h('x-vercel-ip-longitude'), 180),
    };
  }
  return cfGeoOf(c);
}

/** Location from Cloudflare's request.cf only. The app API uses this: apps post directly, never through a proxy. */
export function cfGeoOf(c: Context<AppEnv>): Geo {
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;
  return {
    country: (cf?.country as string) ?? null,
    region: (cf?.region as string) ?? null,
    city: (cf?.city as string) ?? null,
    lat: coarseCoord(cf?.latitude, 90),
    lon: coarseCoord(cf?.longitude, 180),
  };
}

export async function ingest(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  ua: string,
  geo: Geo,
  now: number,
  facts: RequestFacts = { language: null, datacenter: 0 },
): Promise<number> {
  const path = normalizePath(url.pathname);
  const { t, vid, sid } = body;

  if (t === 'ping') {
    const ms = Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(body.d) || 0)));
    const stmts = [
      db.prepare('UPDATE sessions SET duration = duration + ?, last_seen_at = ? WHERE site_id = ? AND id = ?').bind(ms, now, site.id, sid),
      ...consentUpdate(db, site, body, sid, ua),
    ];
    // The ping sent when the page is hidden carries the page load's Core Web Vitals: 1 row more, no visitor id.
    const vitals = parseVitals(body.v);
    const insert = vitals && insertVitals(db, site, vitals, vitalsPath(body.v, path), parseUA(ua, Number(body.sw) || undefined).device, now);
    if (insert) stmts.push(insert);
    // The clicks and errors of the page that ended: 1 row more, only for a site that records visits.
    // A page on the site's never-recorded list keeps its clicks and errors out too, whatever tracker version sent them.
    const act = site.record_visits ? parseActivity(body.a) : null;
    if (act && !isSkipped(act.path ?? path, skipList(site.record_skip))) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props, datacenter)
             SELECT ?1, ?2, visitor_id, ?3, 'activity', NULL, ?4, ?5, datacenter FROM sessions WHERE site_id = ?1 AND id = ?2`,
          )
          .bind(site.id, sid, now, act.path ?? path, act.props),
      );
    }
    return rowsWritten(await db.batch(stmts));
  }

  if (t === 'identify') {
    const p = body.p ?? {};
    // A site that calls identify() on every page writes nothing after the first: the update skips a row it would not
    // change. The first email and the first user id also write their entry in visitors_email / visitors_user (0064).
    // Traits (?6) merge into the stored ones; past 20 keys the call's own traits replace them. They ride on the identity
    // update when that runs. Alone they go in a second update that sets traits only, so the identity indexes are not
    // rewritten: 1 row. After the first update has run, the second finds nothing to change.
    const traits = `CASE WHEN ?6 IS NULL THEN traits
                          WHEN (SELECT COUNT(*) FROM json_each(json_patch(COALESCE(traits, '{}'), ?6))) <= ${MAX_TRAITS} THEN json_patch(COALESCE(traits, '{}'), ?6)
                          ELSE json(?6) END`;
    const args = [clip(p.user_id, 128), clip(p.email, 200)?.toLowerCase() ?? null, clip(p.name, 128), site.id, vid, traitsOf(p)];
    const r = await db.batch([
      db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, vid, now),
      db
        .prepare(
          `UPDATE visitors SET user_id = COALESCE(?1, user_id), email = COALESCE(?2, email), name = COALESCE(?3, name), traits = ${traits}
           WHERE site_id = ?4 AND id = ?5
             AND (COALESCE(?1, user_id) IS NOT user_id OR COALESCE(?2, email) IS NOT email OR COALESCE(?3, name) IS NOT name)`,
        )
        .bind(...args),
      ...(args[5]
        ? [db.prepare(`UPDATE visitors SET traits = ${traits} WHERE site_id = ?4 AND id = ?5 AND (${traits}) IS NOT traits`).bind(...args)]
        : []),
    ]);
    return rowsWritten(r);
  }

  const existing = await db
    .prepare('SELECT datacenter FROM sessions WHERE site_id = ? AND id = ?')
    .bind(site.id, sid)
    .first<{ datacenter: number }>();
  // Events carry the session's datacenter flag, so page and goal panels can hide them without reading sessions.
  const dc = existing ? (existing.datacenter ? 1 : 0) : facts.datacenter;

  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(...newSession(db, site, body, url, path, ua, geo, now, facts));
    // Withdrawn on the first event of a new visit: the visitor's earlier visits lose it too.
    if (body.m === 0) stmts.push(...consentUpdate(db, site, body, sid, ua));
  }

  if (t === 'pageview') {
    if (existing) {
      // An ad click inside a running session (the visitor came back through an ad within 30 minutes): keep the first
      // click id. Matches no row, so writes nothing, when the session has one or the URL carries none.
      // A direct session that an ad click joins becomes a paid Meta visit, so its purchase counts for the ad.
      const click = metaClick(url.searchParams);
      const other = clickIdOf(url.searchParams);
      if (other) {
        // Another network's ad click inside a running session: the same, keeping the first click id. A direct session
        // becomes a paid visit from that network, and so does the visitor's first touch when this is the first visit.
        const paidSource = classify({ referrerDomain: null, clickNetwork: other.network }).source;
        stmts.push(
          db
            .prepare(
              `UPDATE sessions SET click_network = ?1, click_id = ?2, click_at = ?3,
                 source = CASE WHEN channel = 'Direct' THEN ?4 ELSE source END,
                 channel = CASE WHEN channel = 'Direct' THEN 'Paid' ELSE channel END
               WHERE site_id = ?5 AND id = ?6 AND click_id IS NULL AND click_network IS NULL`,
            )
            .bind(other.network, other.id, now, paidSource, site.id, sid),
          upgradeFirstTouch(db, site.id, sid, paidSource, null),
        );
      }
      if (click.fbclid || click.adId) {
        const q = url.searchParams;
        const paid = click.adId ? classify({ referrerDomain: null, utmSource: clip(q.get('utm_source'), 100), utmMedium: clip(q.get('utm_medium'), 100), metaAd: true }).source : null;
        stmts.push(
          db
            .prepare(
              `UPDATE sessions SET fbclid = COALESCE(fbclid, ?1), fbclid_at = COALESCE(fbclid_at, ?2), ad_id = COALESCE(ad_id, ?3),
                 click_ua = COALESCE(click_ua, ?4),
                 source = CASE WHEN channel = 'Direct' AND ?5 IS NOT NULL THEN ?5 ELSE source END,
                 channel = CASE WHEN channel = 'Direct' AND ?5 IS NOT NULL THEN 'Paid' ELSE channel END
               WHERE site_id = ?6 AND id = ?7 AND (fbclid IS NULL OR ad_id IS NULL)`,
            )
            .bind(click.fbclid, click.fbclid ? now : null, click.adId, ua.slice(0, 400) || null, paid, site.id, sid),
        );
        if (paid) stmts.push(upgradeFirstTouch(db, site.id, sid, paid, null));
      }
      stmts.push(...consentUpdate(db, site, body, sid, ua));
      stmts.push(
        db
          .prepare('UPDATE sessions SET pageviews = pageviews + 1, exit_page = ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
          .bind(path, now, site.id, sid),
      );
    }
    stmts.push(insertEvent(db, site.id, sid, vid, now, 'pageview', null, path, null, dc));
    stmts.push(...claimPayment(db, site.id, vid, url, now));
  } else if (t === 'goal') {
    const name = clip(body.n, 64);
    if (!name) return 0;
    const props = propsJson(body.p);
    stmts.push(
      db.prepare('UPDATE sessions SET goals = goals + 1, last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'goal', name, path, props, dc),
    );
    // Consent given on this page reaches the session with the goal itself (a checkout start right after Accept), not
    // only with the ping when the page is left, which a browser may drop on the way to the payment page.
    if (existing) stmts.push(...consentUpdate(db, site, body, sid, ua));
  } else if (t === 'outbound') {
    const target = clip(body.n, 500);
    if (!target) return 0;
    stmts.push(
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE site_id = ? AND id = ?').bind(now, site.id, sid),
      insertEvent(db, site.id, sid, vid, now, 'outbound', target, path, null, dc),
    );
  }
  return stmts.length ? rowsWritten(await db.batch(stmts)) : 0;
}

/**
 * Dodo sends buyers back to your return URL with ?payment_id=pay_... . Seeing that on a pageview tells us
 * exactly which visitor made the payment, even when the checkout had no metadata.
 */
function claimPayment(db: D1Database, siteId: string, vid: string, url: URL, now: number): D1PreparedStatement[] {
  const paymentId = url.searchParams.get('payment_id') ?? url.searchParams.get('subscription_id');
  if (!paymentId || !/^(pay|sub)_[\w-]{4,64}$/.test(paymentId)) return [];
  return [
    db
      .prepare('INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
      .bind(siteId, paymentId, vid, now),
    // The webhook usually arrives first; link that payment now if nothing else already did. Credit goes where the
    // webhook's own match would put it: the visitor's visits, and those of every id identified as the same person.
    db
      .prepare(
        `UPDATE payments SET visitor_id = ?3, matched_by = 'return_page',
           session_id = (${creditedVisitSql('id', 'lower(payments.email)')}),
           (channel, source, campaign) = (${creditedVisitSql('channel, source, utm_campaign', 'lower(payments.email)')})
         WHERE site_id = ?1 AND (id = ?4 OR subscription_id = ?4) AND visitor_id IS NULL`,
      )
      .bind(siteId, now + 60_000, vid, paymentId),
    db
      .prepare(
        `UPDATE visitors SET email = COALESCE(email, (SELECT email FROM payments WHERE site_id = ? AND (id = ? OR subscription_id = ?) LIMIT 1)),
           name = COALESCE(name, (SELECT name FROM payments WHERE site_id = ? AND (id = ? OR subscription_id = ?) LIMIT 1))
         WHERE site_id = ? AND id = ?`,
      )
      .bind(siteId, paymentId, paymentId, siteId, paymentId, paymentId, siteId, vid),
  ];
}

/**
 * Marketing consent given or withdrawn inside a running session. Given: the session may go to Meta, and on a site whose
 * Conversions API sends every purchase it keeps the user agent Meta needs. Withdrawn: it may not, and a user agent kept
 * only for that goes. Matches no row, so writes nothing, when the session already says so.
 */
function consentUpdate(db: D1Database, site: Site, body: Payload, sid: string, ua: string): D1PreparedStatement[] {
  if (body.m === 1) {
    return [
      db
        // The Meta pixel may set _fbp after the event that brought consent: a later event adds it, once.
        .prepare(
          `UPDATE sessions SET consent = 1, click_ua = CASE WHEN ?1 THEN COALESCE(click_ua, ?2) ELSE click_ua END, fbp = COALESCE(fbp, ?3)
           WHERE site_id = ?4 AND id = ?5 AND (consent = 0 OR (fbp IS NULL AND ?3 IS NOT NULL))`,
        )
        .bind(site.keep_ua ? 1 : 0, ua.slice(0, 400) || null, fbpOf(body), site.id, sid),
    ];
  }
  if (body.m === 0) {
    // Withdrawn: every visit of this visitor loses it, not only this one, so an earlier visit cannot carry a purchase to Meta.
    return [
      db
        .prepare(
          `UPDATE sessions SET consent = 0, fbp = NULL, click_ua = CASE WHEN fbclid IS NULL AND ad_id IS NULL THEN NULL ELSE click_ua END
           WHERE site_id = ? AND (id = ? OR visitor_id = ?) AND consent = 1`,
        )
        .bind(site.id, sid, body.vid),
    ];
  }
  return [];
}

function insertEvent(
  db: D1Database,
  siteId: string,
  sid: string,
  vid: string,
  ts: number,
  type: string,
  name: string | null,
  path: string,
  props: string | null,
  datacenter: 0 | 1,
) {
  return db
    .prepare('INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props, datacenter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(siteId, sid, vid, ts, type, name, path, props, datacenter);
}

function newSession(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  path: string,
  ua: string,
  geo: Geo,
  now: number,
  facts: RequestFacts,
): D1PreparedStatement[] {
  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  if (body.r) {
    try {
      const r = new URL(body.r);
      // Navigation between your own pages/subdomains is not a referral.
      if (/^https?:$/.test(r.protocol) && !belongsTo(r.hostname, site.domain)) {
        referrerDomain = stripWww(r.hostname);
        referrer = (r.hostname + normalizePath(r.pathname)).slice(0, 500);
      }
    } catch {
      // android-app://com.google.android.gm and friends
      const m = /^android-app:\/\/([\w.]+)/.exec(body.r);
      if (m) referrerDomain = m[1];
    }
  }
  const q = url.searchParams;
  const utm = {
    source: clip(q.get('utm_source'), 100),
    medium: clip(q.get('utm_medium'), 100),
    campaign: clip(q.get('utm_campaign'), 200),
    term: clip(q.get('utm_term'), 200),
    content: clip(q.get('utm_content'), 200),
  };
  const ref = clip(q.get('ref') ?? q.get('via'), 100);
  const click = metaClick(q);
  const other = clickIdOf(q);
  const { source, channel } = classify({ referrerDomain, utmSource: utm.source, utmMedium: utm.medium, ref, metaAd: !!click.adId, clickNetwork: other?.network });
  const { browser, os, device } = parseUA(ua, Number(body.sw) || undefined);
  const pageviews = body.t === 'pageview' ? 1 : 0;

  return [
    // First touch: the visit that creates the visitor row names it, and later visits leave it alone. A row another path
    // made minutes earlier without one (identify sent beside the first pageview, a payment matched first) gets this
    // visit's; older rows from before migration 0065 stay empty. The common path writes the same 1 row or none.
    db
      .prepare(
        `INSERT INTO visitors (site_id, id, first_seen, first_source, first_channel, first_campaign, first_referrer, first_entry_page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id, id) DO UPDATE SET first_source = excluded.first_source, first_channel = excluded.first_channel,
           first_campaign = excluded.first_campaign, first_referrer = excluded.first_referrer, first_entry_page = excluded.first_entry_page
         WHERE visitors.first_channel IS NULL AND visitors.first_seen >= excluded.first_seen - ${FIRST_TOUCH_FILL_MS}`,
      )
      .bind(site.id, body.vid, now, source, channel, utm.campaign, referrerDomain, path),
    db
      .prepare(
        `INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page,
          referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
          country, region, city, lat, lon, browser, os, device, fbclid, fbclid_at, ad_id, click_ua, consent, fbp,
          click_network, click_id, click_at, language, datacenter)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        site.id,
        body.sid,
        body.vid,
        now,
        now,
        stripWww(url.hostname),
        path,
        path,
        referrer,
        referrerDomain,
        source,
        channel,
        utm.source,
        utm.medium,
        utm.campaign,
        utm.term,
        utm.content,
        ref,
        geo.country,
        geo.region,
        geo.city,
        coarseCoord(geo.lat, 90),
        coarseCoord(geo.lon, 180),
        browser,
        os,
        device,
        click.fbclid,
        click.fbclid ? now : null,
        click.adId,
        click.fbclid || click.adId || (site.keep_ua && body.m === 1) ? ua.slice(0, 400) || null : null,
        body.m === 1 ? 1 : 0,
        fbpOf(body),
        other?.network ?? null,
        other?.id ?? null,
        other ? now : null,
        facts.language,
        facts.datacenter,
      ),
    // Separate statement so concurrent first events (pageview + goal racing) never double count.
    ...(pageviews
      ? [db.prepare('UPDATE sessions SET pageviews = pageviews + 1 WHERE site_id = ? AND id = ?').bind(site.id, body.sid)]
      : []),
  ];
}
