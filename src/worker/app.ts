import type { Context } from 'hono';
import { propsJson } from './lib/props';
import { appClickOf, classify } from '../shared/sources';
import { applyAdsToken } from './adservices';
import { FIRST_TOUCH_FILL_MS } from './first-touch';
import { canonicalId, recordAppleTransaction, type AppleTransaction } from './appstore';
import { overCap, rowsWritten, secondsToReset, spend } from './budget';
import { pusherOf, type Pusher } from './notify';
import { cfGeoOf, coarseCoord, normalizePath, type Geo } from './collect';
import { getSite, type AppEnv, type Site } from './env';
import { appDayKey, clientIp, visitorSecret } from './identity';
import { verifyAppleJws } from './lib/apple-jws';
import { checkPlayPurchasesLater, type PlayCheck } from './googleplay';

/**
 * App events: POST /api/app/events (docs/APP-API.md). A batch from the iOS or Android SDK's offline queue:
 * one install (vid), up to 50 events from one or more sessions.
 *
 * Cost: everything except purchases goes to D1 in one batch. Each screen or goal is one events row;
 * each session in the batch is one sessions row (insert when new, one update otherwise), however many
 * events it has. A launch without a kept install id adds one app_aliases row the first time it is seen
 * (resolveLaunch), and one more when its session continues an earlier launch's session.
 */

export const MAX_BODY = 64 * 1024;
export const MAX_EVENTS = 50;
const PAST_MS = 72 * 3_600_000;
/** A launch without a kept id continues the visitor's last session when it starts within this time of it. */
const SESSION_MS = 30 * 60_000;
const FUTURE_MS = 5 * 60_000;
const MAX_PING_MS = 10 * 60_000;
const TYPES = new Set(['session_start', 'screen', 'goal', 'ping', 'identify', 'purchase', 'session_props']);
const PROP_KEY = /^[a-z0-9_]{1,40}$/;
export const MAX_SESSION_PROPS = 10;

type Obj = Record<string, unknown>;

interface AppEvent {
  t: string;
  sid: string;
  ts?: number;
  n?: unknown;
  p?: unknown;
  d?: unknown;
  jws?: unknown;
  src?: unknown;
  sp?: unknown;
}

export interface AppBatch {
  w: string;
  vid: string;
  ctx?: Obj;
  events: AppEvent[];
}

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const clip = (s: unknown, n = 255): string | null => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null);

export function clampTs(ts: unknown, now: number): number {
  const t = typeof ts === 'number' && Number.isFinite(ts) ? Math.round(ts) : now;
  return Math.min(now + FUTURE_MS, Math.max(now - PAST_MS, t));
}

/**
 * Session properties (docs/APP-API.md section 6) as stored in sessions.props: string values only, keys
 * `[a-z0-9_]{1,40}`, values cut at 100 characters, at most 10 keys. Null when nothing is left.
 */
export function sessionPropsJson(p: unknown): string | null {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj(p))) {
    if (n >= MAX_SESSION_PROPS) break;
    if (!PROP_KEY.test(k) || typeof v !== 'string' || !v.trim()) continue;
    out[k] = v.trim().slice(0, 100);
    n++;
  }
  return n ? JSON.stringify(out) : null;
}

/** "Onboarding/Step2" -> "/Onboarding/Step2", so screens work as pages (entry, exit, funnels). */
export function screenPath(name: string): string {
  return normalizePath('/' + name.replace(/^\/+/, ''));
}

export async function handleAppEvents(c: Context<AppEnv>) {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return c.json({ error: 'body is over 64 KB' }, 413);
  let body: AppBatch;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || !isId(body.w) || !isId(body.vid) || !Array.isArray(body.events) || !body.events.length || body.events.length > MAX_EVENTS) {
    return c.json({ error: `expected w, vid and 1 to ${MAX_EVENTS} events` }, 400);
  }
  const site = await getSite(c.env.DB, body.w);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  // Like the domain check for websites: only the site's own app can send data. An Android batch names the package
  // name (docs/APP-API.md section 9), an iOS batch the bundle id.
  const bundle = clip(obj(body.ctx).bundle_id, 255);
  if (isAndroid(obj(body.ctx))) {
    if (!site.android_package || bundle !== site.android_package) {
      return c.json({ error: site.android_package ? `package ${bundle} does not belong to this site` : 'set the Android package name in the site settings first' }, 403);
    }
  } else if (!site.app_bundle_id || bundle !== site.app_bundle_id) {
    return c.json({ error: site.app_bundle_id ? `bundle ${bundle} does not belong to this site` : 'set the app bundle id in the site settings first' }, 403);
  }
  const now = Date.now();
  // Past the site's daily write cap: 429 keeps the batch in the SDK's queue, so it arrives after the reset.
  if (await overCap(c.env.DB, site, now)) {
    return c.json({ error: 'daily write cap reached' }, 429, { 'retry-after': String(secondsToReset(now)) });
  }
  // Apps post directly, never through a proxy, so only CF-Connecting-IP counts (X-Forwarded-For in local dev).
  const dayKey = keepsId(obj(body.ctx))
    ? null
    : await appDayKey(visitorSecret(c.env), site.id, clientIp((n) => c.req.header(n)), c.req.header('user-agent') ?? '', obj(body.ctx), now);
  const push = pusherOf(c);
  const res = await ingestApp(c.env.DB, site, body, cfGeoOf(c), now, (p) => c.executionCtx.waitUntil(p), push, dayKey, (checks) =>
    // The Google checks run after the answer (docs/APP-API.md section 9), one after another: their calls stay out of
    // the request path and share one access token.
    c.executionCtx.waitUntil(checkPlayPurchasesLater(c.env, site, checks, push)),
  );
  c.executionCtx.waitUntil(spend(c.env.DB, site, res.written, now));
  return c.json({ ok: true, rejected: res.rejected }, 202);
}

interface SessionAcc {
  start: number;
  last: number;
  src: Obj | null;
  pageviews: number;
  goals: number;
  duration: number;
  entry: string | null;
  exit: string | null;
  /** undefined: no properties in this batch. null: cleared. */
  props?: string | null;
  /** A session_props event came in, so the UPDATE must run even for a session_start-only batch. */
  propsEvent: boolean;
  /** The session continues one that exists already (resolveLaunch), so the UPDATE must run. */
  continues?: boolean;
}

/**
 * ctx.consent: the SDK keeps this install id on the device, so later launches come back under it.
 * ctx.id "vendor": the id is derived from identifierForVendor, so later launches come back under it too.
 */
const keepsId = (ctx: Obj) => ctx.consent === true || ctx.id === 'vendor';

/** ctx.platform "android": an Android batch (docs/APP-API.md section 9). Anything else is iOS, as before. */
const isAndroid = (ctx: Obj) => ctx.platform === 'android';

/** A Google Play purchase token: 10 to 4096 printable ASCII characters without spaces (it is URL-encoded for Google). */
const PLAY_TOKEN = /^[\x21-\x7e]{10,4096}$/;
/** Play purchases one batch checks with Google, one after another: each check is 2 to 3 Google calls and about 10 D1 calls. */
export const MAX_PLAY_CHECKS = 3;

/**
 * Which visitor and sessions a batch belongs to (docs/APP-API.md section 3). Without a kept install id the SDK makes
 * a new id on every launch, so the launch is matched by `dayKey` (identity.ts, appDayKey) the way a cookieless web
 * visitor is: the first launch with that key on a UTC day becomes the visitor, and later launches point at it in
 * app_aliases. A new SDK session of such a launch continues the visitor's latest session when it starts within
 * 30 minutes of that session's last activity, so a quick relaunch is one session, as on the web.
 *
 * Batches with a kept id (`dayKey` null) only follow an alias: a launch that got consent keeps its visitor.
 * Costs one read round trip, a second when a new session may continue another, and one row per alias written.
 */
async function resolveLaunch(
  db: D1Database,
  siteId: string,
  vid: string,
  sessions: Map<string, SessionAcc>,
  dayKey: string | null,
  now: number,
): Promise<{ visitor: string; sessionOf: Map<string, string>; writes: D1PreparedStatement[] }> {
  const sids = [...sessions.keys()];
  const ids = dayKey ? [vid, dayKey, ...sids] : [vid, ...sids];
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
  const [aliasRows, knownRows, existingRows] = await db.batch([
    db.prepare(`SELECT id, visitor_id, session_id FROM app_aliases WHERE site_id = ? AND id IN (${marks(ids.length)})`).bind(siteId, ...ids),
    db.prepare('SELECT 1 AS known FROM visitors WHERE site_id = ? AND id = ?').bind(siteId, vid),
    db.prepare(`SELECT id FROM sessions WHERE site_id = ? AND id IN (${marks(sids.length)})`).bind(siteId, ...sids),
  ]);
  const alias = new Map((aliasRows.results as { id: string; visitor_id: string; session_id: string | null }[]).map((r) => [r.id, r]));
  const existing = new Set((existingRows.results as { id: string }[]).map((r) => r.id));
  const writes: D1PreparedStatement[] = [];
  const point = (id: string, visitor: string, session: string | null = null) =>
    writes.push(
      db.prepare('INSERT OR IGNORE INTO app_aliases (site_id, id, visitor_id, session_id, ts) VALUES (?, ?, ?, ?, ?)').bind(siteId, id, visitor, session, now),
    );

  let visitor = alias.get(vid)?.visitor_id;
  if (!visitor && dayKey && !knownRows.results.length) {
    visitor = alias.get(dayKey)?.visitor_id;
    if (visitor) point(vid, visitor);
    else point(dayKey, vid);
  }
  const returning = !!visitor;
  visitor ??= vid;

  const sessionOf = new Map<string, string>();
  let latest: { id: string; started_at: number; last_seen_at: number } | null | undefined;
  for (const sid of [...sids].sort((a, b) => sessions.get(a)!.start - sessions.get(b)!.start)) {
    const s = sessions.get(sid)!;
    const to = alias.get(sid)?.session_id;
    if (to) {
      sessionOf.set(sid, to);
      s.continues = true;
      continue;
    }
    sessionOf.set(sid, sid);
    if (existing.has(sid) || !dayKey || !returning) continue;
    if (latest === undefined) {
      latest = await db
        .prepare('SELECT id, started_at, last_seen_at FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 1')
        .bind(siteId, visitor)
        .first<{ id: string; started_at: number; last_seen_at: number }>();
    }
    if (latest && s.start >= latest.started_at && s.start - latest.last_seen_at < SESSION_MS) {
      sessionOf.set(sid, latest.id);
      s.continues = true;
      point(sid, visitor, latest.id);
      latest.last_seen_at = Math.max(latest.last_seen_at, s.last);
    } else {
      latest = { id: sid, started_at: s.start, last_seen_at: s.last };
    }
  }
  return { visitor, sessionOf, writes };
}

/** Two SDK sessions that land in one stored session: `b` started after `a`. */
function mergeSessions(a: SessionAcc, b: SessionAcc): SessionAcc {
  return {
    start: Math.min(a.start, b.start),
    last: Math.max(a.last, b.last),
    src: a.src ?? b.src,
    pageviews: a.pageviews + b.pageviews,
    goals: a.goals + b.goals,
    duration: a.duration + b.duration,
    entry: a.entry ?? b.entry,
    exit: b.exit ?? a.exit,
    props: b.props !== undefined ? b.props : a.props,
    propsEvent: a.propsEvent || b.propsEvent,
    continues: a.continues || b.continues,
  };
}

export async function ingestApp(
  db: D1Database,
  site: Site,
  body: AppBatch,
  geo: Geo,
  now: number,
  defer: (p: Promise<unknown>) => void,
  push?: Pusher,
  dayKey: string | null = null,
  /** Starts the Google checks of the batch's Play purchases after the answer (googleplay.ts). Without it they are skipped. */
  playCheck?: (checks: PlayCheck[]) => void,
): Promise<{ rejected: number; written: number }> {
  const launchId = canonicalId(body.vid);
  const ctx = obj(body.ctx);
  const version = clip(ctx.app_version, 32);
  const build = clip(ctx.build, 16);
  const appVersion = version ? (build ? `${version} (${build})` : version) : null;
  const osVersion = clip(ctx.os_version, 20);
  const android = isAndroid(ctx);
  // An Android model name says nothing about the size, so the SDK sends ctx.form_factor.
  const device = (android ? ctx.form_factor === 'tablet' : /^iPad/i.test(String(ctx.device ?? ''))) ? 'Tablet' : 'Mobile';
  const host = android ? `android:${site.android_package}` : `ios:${site.app_bundle_id}`;
  const os = android ? (osVersion ? `Android ${osVersion}` : 'Android') : osVersion ? `iOS ${osVersion}` : 'iOS';
  // The app's language from ctx.locale ("en_US" is "en").
  const lang = typeof ctx.locale === 'string' ? ctx.locale.split(/[_-]/)[0].toLowerCase() : '';
  const language = /^[a-z]{2,3}$/.test(lang) ? lang : null;

  let rejected = 0;
  let firstTs = Infinity;
  let linkedWebVid: string | null = null;
  const sessions = new Map<string, SessionAcc>();
  const rows: { s: string; ts: number; t: string; n: string | null; p: string | null; pr: string | null }[] = [];
  const identifies: Obj[] = [];
  const purchases: { sid: string; jws: string }[] = [];
  const plays: { sid: string; token: string; kind: 'subs' | 'inapp'; product: string | null }[] = [];
  const ads: { sid: string; token: string }[] = [];

  for (const raw of body.events) {
    const e = obj(raw) as unknown as AppEvent;
    if (!TYPES.has(e.t) || !isId(e.sid)) {
      rejected++;
      continue;
    }
    const ts = clampTs(e.ts, now);
    firstTs = Math.min(firstTs, ts);
    let s = sessions.get(e.sid);
    if (!s) {
      s = { start: ts, last: ts, src: null, pageviews: 0, goals: 0, duration: 0, entry: null, exit: null, propsEvent: false };
      sessions.set(e.sid, s);
    }
    s.start = Math.min(s.start, ts);
    s.last = Math.max(s.last, ts);

    if (e.t === 'session_start') {
      const src = obj(e.src);
      s.src = src;
      if (typeof src.ads_token === 'string' && src.ads_token.length <= 4096) ads.push({ sid: e.sid, token: src.ads_token });
      // src.ml_vid is the minilytics field name, still accepted.
      const webVid = isId(src.rt_vid) ? src.rt_vid : isId(src.ml_vid) ? src.ml_vid : null;
      if (webVid) linkedWebVid = webVid;
      if (e.sp !== undefined) s.props = sessionPropsJson(e.sp);
    } else if (e.t === 'session_props') {
      // The full set replaces what the session had; {} clears it.
      s.props = sessionPropsJson(e.p);
      s.propsEvent = true;
    } else if (e.t === 'screen') {
      const name = clip(e.n, 300);
      if (!name) {
        rejected++;
        continue;
      }
      const path = screenPath(name);
      s.pageviews++;
      s.entry ??= path;
      s.exit = path;
      rows.push({ s: e.sid, ts, t: 'pageview', n: null, p: path, pr: null });
    } else if (e.t === 'goal') {
      const name = clip(e.n, 64);
      if (!name) {
        rejected++;
        continue;
      }
      s.goals++;
      const props = propsJson(e.p);
      // The goal happened on the screen shown last; without one in this batch, the session's stored exit screen.
      rows.push({ s: e.sid, ts, t: 'goal', n: name, p: s.exit, pr: props });
    } else if (e.t === 'ping') {
      s.duration += Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(e.d) || 0)));
    } else if (e.t === 'identify') {
      identifies.push(obj(e.p));
    } else if (e.t === 'purchase') {
      const raw = e as unknown as Obj;
      if (raw.store === 'google_play') {
        // Only an Android batch can carry a Play purchase; the token and kind must be usable for the Google check.
        if (android && typeof raw.token === 'string' && PLAY_TOKEN.test(raw.token) && (raw.kind === 'subs' || raw.kind === 'inapp')) {
          plays.push({ sid: e.sid, token: raw.token, kind: raw.kind, product: clip(raw.product, 200) });
        } else rejected++;
      } else if (typeof e.jws === 'string' && !android) purchases.push({ sid: e.sid, jws: e.jws });
      else rejected++;
    }
  }
  if (!sessions.size) return { rejected, written: 0 };

  const launch = await resolveLaunch(db, site.id, launchId, sessions, keepsId(ctx) ? null : dayKey, now);
  const vid = launch.visitor;
  const storedSid = (s: string) => launch.sessionOf.get(s) ?? s;
  if ([...launch.sessionOf].some(([from, to]) => from !== to)) {
    const merged = new Map<string, SessionAcc>();
    for (const [from, s] of [...sessions].sort((a, b) => a[1].start - b[1].start)) {
      const prev = merged.get(storedSid(from));
      merged.set(storedSid(from), prev ? mergeSessions(prev, s) : s);
    }
    sessions.clear();
    for (const [k, s] of merged) sessions.set(k, s);
    for (const r of rows) r.s = storedSid(r.s);
    for (const p of purchases) p.sid = storedSid(p.sid);
    for (const p of plays) p.sid = storedSid(p.sid);
    for (const a of ads) a.sid = storedSid(a.sid);
  }

  const persistent = keepsId(ctx) ? 1 : 0;
  // First touch: the batch's earliest session. A visitor row that exists keeps its own, unless another path (a matched
  // payment) made it minutes earlier without one (src/worker/collect.ts newSession).
  const first = [...sessions.values()].sort((a, b) => a.start - b.start)[0];
  const ft = attributionOf(first);
  const stmts: D1PreparedStatement[] = [
    ...launch.writes,
    db
      .prepare(
        `INSERT INTO visitors (site_id, id, first_seen, persistent, first_source, first_channel, first_campaign, first_entry_page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id, id) DO UPDATE SET first_source = excluded.first_source, first_channel = excluded.first_channel,
           first_campaign = excluded.first_campaign, first_entry_page = excluded.first_entry_page
         WHERE visitors.first_channel IS NULL AND visitors.first_seen >= excluded.first_seen - ${FIRST_TOUCH_FILL_MS}`,
      )
      .bind(site.id, vid, firstTs, persistent, ft.source, ft.channel, ft.utm.campaign, first.entry),
  ];
  if (persistent) {
    // Consent given after the install id was first seen. Matches no row (writes nothing) once set.
    stmts.push(db.prepare('UPDATE visitors SET persistent = 1 WHERE site_id = ? AND id = ? AND persistent = 0').bind(site.id, vid));
  }
  if (linkedWebVid) {
    stmts.push(db.prepare('UPDATE visitors SET linked_web_vid = ? WHERE site_id = ? AND id = ?').bind(linkedWebVid, site.id, vid));
  }
  for (const [sid, s] of sessions) stmts.push(insertSession(db, site, vid, sid, s, geo, host, os, device, appVersion, language));
  if (rows.length) {
    // One statement for all events (D1 caps bound parameters per statement, so the rows travel as JSON).
    stmts.push(
      db
        .prepare(
          `INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props)
           SELECT ?, json_extract(j.value, '$.s'), ?, json_extract(j.value, '$.ts'), json_extract(j.value, '$.t'),
                  json_extract(j.value, '$.n'),
                  COALESCE(json_extract(j.value, '$.p'),
                           (SELECT exit_page FROM sessions x WHERE x.site_id = ? AND x.id = json_extract(j.value, '$.s'))),
                  json_extract(j.value, '$.pr')
           FROM json_each(?) j`,
        )
        .bind(site.id, vid, site.id, JSON.stringify(rows)),
    );
  }
  for (const [sid, s] of sessions) {
    // Only session_start: the insert already has it all.
    if (!s.pageviews && !s.goals && !s.duration && s.src && !s.propsEvent && !s.continues) continue;
    stmts.push(
      db
        .prepare(
          `UPDATE sessions SET pageviews = pageviews + ?, goals = goals + ?, duration = duration + ?,
             entry_page = COALESCE(entry_page, ?), exit_page = COALESCE(?, exit_page), last_seen_at = MAX(last_seen_at, ?),
             props = CASE WHEN ? = 1 THEN ? ELSE props END
           WHERE site_id = ? AND id = ?`,
        )
        .bind(s.pageviews, s.goals, s.duration, s.entry, s.exit, s.last, s.props === undefined ? 0 : 1, s.props ?? null, site.id, sid),
    );
  }
  for (const p of identifies) {
    stmts.push(
      db
        .prepare(
          'UPDATE visitors SET user_id = COALESCE(?, user_id), email = COALESCE(?, email), name = COALESCE(?, name) WHERE site_id = ? AND id = ?',
        )
        .bind(clip(p.user_id, 128), clip(p.email, 200)?.toLowerCase() ?? null, clip(p.name, 128), site.id, vid),
    );
  }
  // Counts toward the daily write cap. Purchases (signed by Apple) and Apple Ads lookups below do not.
  const written = rowsWritten(await db.batch(stmts));

  // Purchases after the batch, so the session they are credited to exists.
  for (const p of purchases) {
    try {
      const tx = await verifyAppleJws<AppleTransaction>(p.jws);
      const out = await recordAppleTransaction(db, site, tx, { visitorId: vid, sessionId: p.sid }, push);
      if (out === 'invalid' || out === 'wrong_bundle' || out === 'sandbox_off') rejected++;
    } catch {
      rejected++;
    }
  }
  // Google Play purchases: checked with Google after the answer (googleplay.ts). The payment row comes from that check.
  // One token once, and at most MAX_PLAY_CHECKS a batch: the SDK sends each purchase once, so more is a misbehaving client.
  const checks = [...new Map(plays.map((p) => [p.token, p])).values()].slice(0, MAX_PLAY_CHECKS);
  if (checks.length) playCheck?.(checks.map((p) => ({ token: p.token, kind: p.kind, product: p.product, visitorId: vid, sessionId: p.sid })));
  for (const a of ads) defer(applyAdsToken(db, site.id, a.sid, a.token));
  return { rejected, written };
}

function insertSession(
  db: D1Database,
  site: Site,
  vid: string,
  sid: string,
  s: SessionAcc,
  geo: Geo,
  host: string,
  os: string,
  device: string,
  appVersion: string | null,
  language: string | null,
) {
  const { utm, ref, source, channel, click } = attributionOf(s);
  return db
    .prepare(
      `INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname,
         source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
         country, region, city, lat, lon, browser, os, device, app_version, props, click_network, click_id, click_at, language)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'App', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      site.id,
      sid,
      vid,
      s.start,
      s.last,
      host,
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
      os,
      device,
      appVersion,
      s.props ?? null,
      click?.network ?? null,
      click?.id ?? null,
      click ? s.start : null,
      language,
    );
}

/** Where an app session came from: the link's UTMs, ref and ad click id (session_start `src`, docs/APP-API.md). */
function attributionOf(s: SessionAcc) {
  const src = s.src ?? {};
  const utm = {
    source: clip(src.utm_source, 100),
    medium: clip(src.utm_medium, 100),
    campaign: clip(src.utm_campaign, 200),
    term: clip(src.utm_term, 200),
    content: clip(src.utm_content, 200),
  };
  const ref = clip(src.ref ?? src.via, 100);
  const click = appClickOf(src.click_network, src.click_id);
  const { source, channel } = classify({ referrerDomain: null, utmSource: utm.source, utmMedium: utm.medium, ref, clickNetwork: click?.network });
  return { utm, ref, source, channel, click };
}
