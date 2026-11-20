import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Device, Env, Role } from './env';
import { hmacHex, passwordsMatch, signToken, verifyToken } from './lib/crypto';
import { hashPassword, passwordIterations, storedIterations, verifyDummy, verifyPassword } from './lib/password';
import { rawDb } from './lib/d1-trace';

export const AUTH_COOKIE = 'rt_auth';
export const AUTH_DAYS = 30;
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;
/** One teammate account locks after this many wrong passwords in an hour, from any address. */
const MAX_ACCOUNT_FAILURES = 20;
const ACCOUNT_WINDOW_MS = 60 * 60_000;
/** A device's last_seen_at is written at most this often. */
export const SEEN_EVERY_MS = 10 * 60_000;

type Secrets = Pick<Env, 'SESSION_SECRET' | 'ADMIN_PASSWORD' | 'VIEWER_PASSWORD'>;
interface Keys {
  cookie: string;
  device: string;
  /** Signs the viewer login's cookie; null when VIEWER_PASSWORD is not set. */
  viewer: string | null;
}

/**
 * Keys bound to the passwords. All derive from SESSION_SECRET and one password, so changing ADMIN_PASSWORD signs out
 * every admin browser (the cookie no longer verifies) and every phone (its token hash no longer matches), and changing
 * VIEWER_PASSWORD signs out every viewer browser. Nothing new is stored: the cookie carries its own signature, and a
 * device row's token_hash starts with `device`.
 */
const keyCache = new Map<string, Promise<Keys>>();
export function credentialKeys(env: Secrets): Promise<Keys> {
  const id = `${env.SESSION_SECRET}\0${env.ADMIN_PASSWORD}\0${env.VIEWER_PASSWORD ?? ''}`;
  let keys = keyCache.get(id);
  if (!keys) {
    keys = (async () => ({
      cookie: await hmacHex(env.SESSION_SECRET, `cookie|${env.ADMIN_PASSWORD}`),
      // 16 hex characters: enough to tell the current password's devices apart, too short to help forge anything.
      device: (await hmacHex(env.SESSION_SECRET, `device|${env.ADMIN_PASSWORD}`)).slice(0, 16),
      viewer: env.VIEWER_PASSWORD ? await hmacHex(env.SESSION_SECRET, `viewer|${env.VIEWER_PASSWORD}`) : null,
    }))();
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(id, keys);
  }
  return keys;
}

/** The dashboard cookie value for a role: `<role>.<expiry ms>`, signed with that role's key. */
export async function sessionCookie(env: Secrets, role: 'admin' | 'viewer', expires: number): Promise<string> {
  const keys = await credentialKeys(env);
  return signToken(role === 'admin' ? keys.cookie : keys.viewer!, `${role}.${expires}`);
}

/** The role of the browser's cookie: admin, viewer, or null when it is missing, expired or signed with an old password. */
export async function sessionRole(c: Context<AppEnv>): Promise<'admin' | 'viewer' | null> {
  if (!c.env.SESSION_SECRET || !c.env.ADMIN_PASSWORD) return null;
  const cookie = getCookie(c, AUTH_COOKIE);
  if (!cookie) return null;
  if (cookie.startsWith('m.')) return memberSessionRole(c, cookie);
  const keys = await credentialKeys(c.env);
  for (const role of ['admin', 'viewer'] as const) {
    const key = role === 'admin' ? keys.cookie : keys.viewer;
    const value = key ? await verifyToken(key, cookie) : null;
    const [name, expires] = value?.split('.') ?? [];
    if (name === role && Number(expires) > Date.now()) return role;
  }
  return null;
}

// ---------- teammates (pro/worker/team.ts)

/** Signs teammate cookies. It derives from SESSION_SECRET alone, so changing ADMIN_PASSWORD leaves teammates signed in. */
const memberKey = (env: Pick<Env, 'SESSION_SECRET'>) => hmacHex(env.SESSION_SECRET, 'member-session');

/** A teammate's cookie value: `m.<id>.<version>.<expiry ms>`, signed. `version` is the row's version at sign-in. */
export async function memberCookie(env: Pick<Env, 'SESSION_SECRET'>, id: string, version: number, expires: number): Promise<string> {
  return signToken(await memberKey(env), `m.${id}.${version}.${expires}`);
}

/**
 * A teammate's cookie is good while its signature holds, it has not expired and the person's row still has the same
 * version. That is the one D1 read a teammate's request costs. Revoking deletes the row and a reset adds 1 to the
 * version, so the next request with an old cookie fails. A role change takes effect at once for the same reason.
 * Owners count as `admin` for every route, viewers as `viewer`.
 */
async function memberSessionRole(c: Context<AppEnv>, cookie: string): Promise<'admin' | 'viewer' | null> {
  const value = await verifyToken(await memberKey(c.env), cookie);
  const [, id, version, expires] = value?.split('.') ?? [];
  if (!id || Number(expires) <= Date.now()) return null;
  const row = await c.env.DB.prepare('SELECT name, role, version FROM team_members WHERE id = ? AND password_hash IS NOT NULL')
    .bind(id)
    .first<{ name: string; role: 'viewer' | 'owner'; version: number }>();
  if (!row || row.version !== Number(version)) return null;
  c.set('member', { id, name: row.name });
  return row.role === 'owner' ? 'admin' : 'viewer';
}

export interface MemberRow {
  id: string;
  name: string;
  email: string | null;
  role: 'viewer' | 'owner';
  password_hash: string | null;
  version: number;
}

/**
 * True for a POST, PUT, PATCH or DELETE that a browser sent from another origin. Browsers set Origin on every
 * cross-origin write and Sec-Fetch-Site on every request; scripts and apps send neither, so they pass.
 */
export function crossOriginWrite(c: Context<AppEnv>): boolean {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return false;
  const origin = c.req.header('origin');
  const fetchSite = c.req.header('sec-fetch-site');
  return (!!origin && origin !== new URL(c.req.url).origin) || (!!fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none');
}

/** Signed in with the admin password, or as a teammate with the owner role. */
export async function isLoggedIn(c: Context<AppEnv>) {
  return (await sessionRole(c)) === 'admin';
}

/** A phone sees names, emails and user ids unless PHONE_PII is "0", "false", "off" or "no". The owner's app locks itself. */
export function phoneSeesPersonalData(env: Pick<Env, 'PHONE_PII'>): boolean {
  return !/^(0|false|off|no)$/i.test(env.PHONE_PII?.trim() ?? '');
}

/** The viewer login sees names, emails and user ids: VIEWER_PII is "1", "true", "on" or "yes". */
export function viewerSeesPersonalData(env: Pick<Env, 'VIEWER_PII'>): boolean {
  return /^(1|true|on|yes)$/i.test(env.VIEWER_PII?.trim() ?? '');
}

/**
 * Check a password with the shared lockout: an IP is locked out after too many wrong passwords, so a public
 * dashboard can't be brute-forced. Returns the role the password signs in as, or the error response. The viewer
 * password counts only where `viewer` is true (the dashboard login, not the phone login).
 */
export async function checkLogin(c: Context<AppEnv>, password: string | undefined, viewer = true): Promise<Response | 'admin' | 'viewer'> {
  const gate = await loginGate(c);
  if (gate instanceof Response) return gate;
  const role = !password
    ? null
    : passwordsMatch(password, c.env.ADMIN_PASSWORD)
      ? 'admin'
      : viewer && c.env.VIEWER_PASSWORD && passwordsMatch(password, c.env.VIEWER_PASSWORD)
        ? 'viewer'
        : null;
  if (!role) return loginFailed(c, gate, 'Wrong password');
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(gate.ip).run();
  if (role === 'admin') await revokeStaleDevices(c.env);
  return role;
}

/** A name or email folded the same way at invite and at sign-in: NFKC, trimmed, lowercased in JavaScript (SQLite's lower() folds ASCII only). */
export const foldKey = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/**
 * A teammate's sign-in: name or email, plus password, through the lockout. Two counters apply before any hashing: the
 * IP (10 in 15 minutes) and the account (20 in an hour), so rotating addresses does not help. A success clears
 * nothing, so one person's good sign-in never resets the guesses against another. Failures are the only writes
 * besides the last sign-in, which is written here and nowhere else. A hash whose round count differs from the target
 * (PASSWORD_ITERATIONS) is rewritten in the same write.
 */
export async function checkMemberLogin(c: Context<AppEnv>, login: string, password: string | undefined): Promise<Response | MemberRow> {
  const key = foldKey(login);
  const acct = c.env.SESSION_SECRET ? `acct:${(await hmacHex(c.env.SESSION_SECRET, `login-acct|${key}`)).slice(0, 27)}` : '';
  const gate = await loginGate(c, acct);
  if (gate instanceof Response) return gate;
  const iterations = passwordIterations(c.env);
  const member = password
    ? await c.env.DB.prepare('SELECT * FROM team_members WHERE (name_key = ?1 OR email_key = ?1) AND password_hash IS NOT NULL')
        .bind(key)
        .first<MemberRow>()
    : null;
  if (member && password) {
    if (!(await verifyPassword(password, member.password_hash!))) return loginFailed(c, gate, 'Wrong name, email or password', acct);
    const rehash = storedIterations(member.password_hash!) !== iterations ? await hashPassword(password, iterations) : null;
    await c.env.DB.prepare('UPDATE team_members SET last_login_at = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?')
      .bind(Date.now(), rehash, member.id)
      .run();
    return member;
  }
  if (password) await verifyDummy(password, iterations);
  return loginFailed(c, gate, 'Wrong name, email or password', acct);
}

/**
 * The lockout check shared by every sign-in: the IP's key, or the 429 or 500 response. With `acct` (a teammate login)
 * the account counter is checked in the same query.
 */
async function loginGate(c: Context<AppEnv>, acct = ''): Promise<Response | { ip: string; now: number }> {
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (run `npm run setup`, or see README.md).' }, 500);
  }
  const ip = await loginIpKey(c.env.SESSION_SECRET, c.req.header('cf-connecting-ip') ?? 'unknown');
  const now = Date.now();
  const recent = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(ip = ?1 AND ts > ?3), 0) AS ip_n, COALESCE(SUM(ip = ?2), 0) AS acct_n
     FROM login_failures WHERE ip IN (?1, ?2) AND ts > ?4`,
  )
    .bind(ip, acct || ip, now - LOCKOUT_MS, now - ACCOUNT_WINDOW_MS)
    .first<{ ip_n: number; acct_n: number }>();
  if ((recent?.ip_n ?? 0) >= MAX_FAILURES || (acct && (recent?.acct_n ?? 0) >= MAX_ACCOUNT_FAILURES)) {
    return c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  }
  return { ip, now };
}

/** Count a wrong password against the IP (and the account), wait half a second, answer 401. */
async function loginFailed(c: Context<AppEnv>, gate: { ip: string; now: number }, message: string, acct = ''): Promise<Response> {
  const ins = 'INSERT INTO login_failures (ip, ts) VALUES (?, ?)';
  await c.env.DB.batch([
    c.env.DB.prepare(ins).bind(gate.ip, gate.now),
    ...(acct ? [c.env.DB.prepare(ins).bind(acct, gate.now)] : []),
    c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(gate.now - LOGIN_FAILURE_MS),
  ]);
  await new Promise((r) => setTimeout(r, 500));
  return c.json({ error: message }, 401);
}

/**
 * What login_failures stores for an IP: an HMAC of it keyed with SESSION_SECRET, 32 hex characters. Enough to count one
 * IP's wrong passwords; a database export holds no IP. The daily cron deletes rows older than the lockout window.
 */
export async function loginIpKey(secret: string, ip: string): Promise<string> {
  return (await hmacHex(secret, `login-ip|${ipBlock(ip)}`)).slice(0, 32);
}

/** An IPv6 address counts as its /64, so a guesser rotating through one network's addresses shares one counter. */
function ipBlock(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head, tail = ''] = ip.split('::');
  const groups = head.split(':').filter(Boolean);
  if (ip.includes('::')) {
    const rest = tail.split(':').filter(Boolean);
    while (groups.length + rest.length < 8) groups.push('0');
    groups.push(...rest);
  }
  return `${groups.slice(0, 4).join(':').toLowerCase()}::/64`;
}

/** login_failures rows older than this are no use to the lockout; the daily cron deletes them (retention.ts). */
export const LOGIN_FAILURE_MS = ACCOUNT_WINDOW_MS;

/** The admin password only (the phone login). Returns the error response, or null when the password is right. */
export async function checkPassword(c: Context<AppEnv>, password: string | undefined): Promise<Response | null> {
  const res = await checkLogin(c, password, false);
  return res instanceof Response ? res : null;
}

/**
 * Revoke the phones signed in under an earlier password or SESSION_SECRET. Their tokens stopped working the moment
 * the password changed; this also clears their push tokens, so they stop getting payment pushes. Runs on every
 * successful sign-in and in the nightly cron. Writes nothing when no device is stale. A row from before token hashes
 * carried a prefix (a bare SHA-256, no `:`) is never stale: deviceFromBearer moves it to the current prefix on its
 * next request.
 */
export async function revokeStaleDevices(env: Env, now = Date.now()): Promise<number> {
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) return 0;
  const prefix = (await credentialKeys(env)).device;
  const res = await env.DB.prepare(
    `UPDATE devices SET revoked_at = ?, apns_token = NULL, widget_token = NULL, live_start_token = NULL, live_update_token = NULL
     WHERE revoked_at IS NULL AND instr(token_hash, ':') > 0 AND substr(token_hash, 1, ?) != ?`,
  )
    .bind(now, prefix.length + 1, `${prefix}:`)
    .run();
  if (!res.meta.changes) return 0;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM device_site_prefs WHERE device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL)'),
    env.DB.prepare('DELETE FROM device_product_prefs WHERE device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL)'),
    env.DB.prepare('DELETE FROM device_mail_prefs WHERE device_id IN (SELECT id FROM devices WHERE revoked_at IS NOT NULL)'),
  ]);
  return res.meta.changes;
}

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What devices.token_hash stores for a token: `<password-bound prefix>:<SHA-256 of the token>`. */
export async function deviceTokenHash(env: Pick<Env, 'SESSION_SECRET' | 'ADMIN_PASSWORD'>, token: string): Promise<string> {
  return `${(await credentialKeys(env)).device}:${await sha256Hex(token.toLowerCase())}`;
}

/** A new device token: 32 random bytes, hex. */
export function newDeviceToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The signed-in, not revoked device behind `Authorization: Bearer <token>`, or null. A phone signed in before token
 * hashes carried the password-bound prefix has a bare SHA-256 stored; it is accepted once and rewritten with the
 * current prefix, so upgrading the Worker signs no phone out.
 */
export async function deviceFromBearer(c: Context<AppEnv>): Promise<Device | null> {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(c.req.header('authorization') ?? '');
  if (!m || !c.env.SESSION_SECRET || !c.env.ADMIN_PASSWORD) return null;
  const hash = await deviceTokenHash(c.env, m[1]);
  const legacy = await sha256Hex(m[1].toLowerCase());
  const device = await c.env.DB.prepare('SELECT * FROM devices WHERE token_hash IN (?, ?) AND revoked_at IS NULL')
    .bind(hash, legacy)
    .first<Device>();
  if (!device) return null;
  if (device.token_hash === legacy) {
    await c.env.DB.prepare('UPDATE devices SET token_hash = ? WHERE id = ? AND token_hash = ?').bind(hash, device.id, legacy).run();
    device.token_hash = hash;
  }
  const now = Date.now();
  if (now - device.last_seen_at >= SEEN_EVERY_MS) {
    // After the answer, so the phone's read does not wait one more round trip for a write it does not need.
    // On the untraced binding: the answer does not wait for it, so Server-Timing does not count it (lib/d1-trace.ts).
    const seen = rawDb(c.env.DB).prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, device.id).run().catch(() => undefined);
    try {
      c.executionCtx.waitUntil(seen);
    } catch {
      await seen;
    }
    device.last_seen_at = now;
  }
  return device;
}

// ---------- what a viewer or a phone may read

/**
 * Keys a viewer or a phone never sees, wherever they are in a JSON response: the site's write key, webhook signing
 * secrets, push and import tokens, alert targets. The value becomes null.
 */
const SECRET_KEY = /^(api_key|stripe_key|target|token_hash)$|(^|_)(secret|token|auth)$/;
/** Keys that name a person. A phone with PHONE_PII=0, and the viewer without VIEWER_PII, get null for these and `name`. */
const PERSON_KEYS = new Set(['email', 'pay_email', 'pay_name', 'user_id', 'customer_id']);

/** A JSON value with the secrets (and, with `hidePerson`, the names and emails) set to null. */
export function scrub(value: unknown, hidePerson: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v, hidePerson));
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  // A visitor, payment or customer row: its `name` is a person's, not a site's or a goal's.
  const person = hidePerson && Object.keys(obj).some((k) => PERSON_KEYS.has(k));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY.test(k) || (person && (PERSON_KEYS.has(k) || k === 'name'))) out[k] = v == null ? v : null;
    else out[k] = scrub(v, hidePerson);
  }
  return out;
}

/** The dashboard's mail routes (FounderData Pro): every message, address and attachment of the deployment. */
export const MAIL_ADMIN_PATH = /^\/api\/mail-admin(\/|$)/;

/** Why a viewer or a phone may not make this call, or null when it may. Exported for tests. */
export function denied(role: Exclude<Role, 'admin'>, method: string, path: string, env: Env): string | null {
  // Mail holds other people's addresses and message text, which scrub() would not hide: owners only, whatever the
  // method, and a teammate with the viewer role counts as a viewer.
  // A phone reads mail through its own routes, /api/mobile/mail/* (FounderData Pro, docs/MOBILE-API.md section 10).
  if (MAIL_ADMIN_PATH.test(path)) return role === 'device' ? 'Mail on a phone goes through /api/mobile/mail, not the dashboard routes.' : 'Mail is for owners. Ask an owner.';
  const read = method === 'GET' || method === 'HEAD';
  if (!read) {
    // A phone may sign itself out (DELETE /api/mobile/devices/<its id>, checked in mobile.ts), act on its mail (the
    // /api/mobile/mail/* routes: read state, archive, reply), add or delete chart notes, and review a change (kept,
    // reverted, iterated).
    if (role === 'device' && path.startsWith('/api/mobile/')) return null;
    if (role === 'device' && /^\/api\/sites\/[^/]+\/notes(\/[^/]+)?$/.test(path) && (method === 'POST' || method === 'DELETE')) return null;
    if (role === 'device' && method === 'POST' && /^\/api\/sites\/[^/]+\/notes\/[^/]+\/review$/.test(path)) return null;
    return role === 'device'
      ? 'A phone token can only read. Sign in to the dashboard to make changes.'
      : 'This login can only read. Ask an owner to make changes.';
  }
  // Share links and read keys are bearer secrets; alert channels hold webhook URLs and addresses.
  if (/^\/api\/sites\/[^/]+\/share(\/|$)/.test(path) || /^\/api\/alerts(\/|$)/.test(path)) {
    return 'Share links, read keys and alert channels are for owners. Ask an owner.';
  }
  // The setup checklist shows which secrets are set and runs tests on the owner's accounts.
  if (/^\/api\/setup(\/|$)/.test(path)) return 'The setup checklist is for owners. Ask an owner.';
  if (role === 'viewer' && path.startsWith('/api/mobile/')) return 'Devices are for owners. Ask an owner.';
  // Raw exports carry the emails and names of payments and identify() calls. A phone never gets them: a lost phone
  // must not hold the customer list in a file.
  if ((role === 'device' || hidesPersonalData(role, env)) && /^\/api\/sites\/[^/]+\/export\//.test(path)) {
    return role === 'device'
      ? 'Raw exports hold personal data, which a phone token does not get. Download them from the dashboard.'
      : 'Raw exports hold personal data, which this viewer login does not see.';
  }
  return null;
}

/** A phone sees names, emails and user ids unless PHONE_PII is off; the viewer login only with VIEWER_PII on. */
export function hidesPersonalData(role: Role, env: Pick<Env, 'VIEWER_PII' | 'PHONE_PII'>): boolean {
  return (role === 'device' && !phoneSeesPersonalData(env)) || (role === 'viewer' && !viewerSeesPersonalData(env));
}

/**
 * Dashboard cookie (admin or viewer) or a device's bearer token. The owner can do anything. A viewer and a phone only
 * read: every other method gets 403 (a phone may still sign itself out), share tokens, read keys and alert channels
 * get 403, and secrets in every response are set to null. A phone may add, delete and review chart notes and act on its
 * mail through /api/mobile/mail/* (FounderData Pro), gets no raw export,
 * and sees names, emails and user ids unless PHONE_PII is 0; the viewer sees them and exports only with VIEWER_PII on.
 * `role` is set for the handlers.
 */
export const requireAuth = async (c: Context<AppEnv>, next: Next) => {
  let role: Role | null = await sessionRole(c);
  // The cookie is SameSite=Lax, which stops other sites but not a page on a sibling subdomain. A write signed in by
  // cookie must come from the dashboard's own origin. A phone's bearer token is not sent by browsers, so it skips this.
  if (role && crossOriginWrite(c)) return c.json({ error: 'Changes must come from the dashboard.' }, 403);
  if (!role) {
    const device = await deviceFromBearer(c);
    if (!device) return c.json({ error: 'unauthorized' }, 401);
    c.set('device', device);
    role = 'device';
  }
  c.set('role', role);
  if (role === 'admin') return next();
  const why = denied(role, c.req.method, c.req.path, c.env);
  if (why) return c.json({ error: why }, 403);
  await next();
  if (!(c.res.headers.get('content-type') ?? '').includes('application/json')) return;
  const body = await c.res.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return;
  }
  const res = new Response(JSON.stringify(scrub(json, hidesPersonalData(role, c.env))), c.res);
  res.headers.delete('content-length');
  c.res = undefined;
  c.res = res;
};

/** A device's bearer token only: the routes that act on the calling phone. */
export const requireDevice = async (c: Context<AppEnv>, next: Next) => {
  const device = await deviceFromBearer(c);
  if (!device) return c.json({ error: 'unauthorized' }, 401);
  c.set('device', device);
  await next();
};

/** Set the cookie for a person. Used after sign-in and after accepting an invite. */
export async function startMemberSession(c: Context<AppEnv>, id: string, version: number) {
  const expires = Date.now() + AUTH_DAYS * 86_400_000;
  setCookie(c, AUTH_COOKIE, await memberCookie(c.env, id, version, expires), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: AUTH_DAYS * 86_400,
  });
}

/** True when at least one person has set a password, so the login screen asks for a name or email. */
export async function hasTeam(c: Context<AppEnv>): Promise<boolean> {
  return !!(await c.env.DB.prepare('SELECT 1 AS x FROM team_members WHERE password_hash IS NOT NULL LIMIT 1').first());
}
