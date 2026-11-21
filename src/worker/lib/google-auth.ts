// Google service account access tokens (docs/APP-API.md section 9, "Google service account").
//
// The secret GOOGLE_SERVICE_ACCOUNT_JSON is the service account's JSON key. An RS256 JWT signed with its private key
// (Web Crypto) is exchanged at the token endpoint for an access token, which is cached per isolate for 50 minutes
// (Google issues them for 60). Signing is one RSA operation, about 1 ms; it runs in waitUntil work, never in a request
// that answers a client.

export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Cached tokens are reused for this long. */
export const TOKEN_CACHE_MS = 50 * 60_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  /** The token endpoint the key names; Google's own when absent. */
  token_uri?: string;
}

export class GoogleAuthError extends Error {}

/** Parses the JSON key. Throws GoogleAuthError when it lacks client_email or private_key. */
export function parseServiceAccount(json: string): ServiceAccount {
  let v: Partial<ServiceAccount>;
  try {
    v = JSON.parse(json);
  } catch {
    throw new GoogleAuthError('GOOGLE_SERVICE_ACCOUNT_JSON is not JSON');
  }
  if (!v || typeof v.client_email !== 'string' || typeof v.private_key !== 'string') {
    throw new GoogleAuthError('GOOGLE_SERVICE_ACCOUNT_JSON needs client_email and private_key');
  }
  return { client_email: v.client_email, private_key: v.private_key, token_uri: typeof v.token_uri === 'string' ? v.token_uri : undefined };
}

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));

/** The DER bytes of a PEM block ("-----BEGIN PRIVATE KEY-----", PKCS #8). */
function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keys = new Map<string, Promise<CryptoKey>>();
function signingKey(pem: string): Promise<CryptoKey> {
  let k = keys.get(pem);
  if (!k) {
    k = crypto.subtle.importKey('pkcs8', pemBody(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    k.catch(() => keys.delete(pem));
    keys.set(pem, k);
  }
  return k;
}

/** The signed assertion for the token exchange (RFC 7523): iss and sub the service account, valid for an hour. */
export async function signAssertion(sa: ServiceAccount, scope: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(
    JSON.stringify({ iss: sa.client_email, sub: sa.client_email, scope, aud: sa.token_uri ?? GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
  );
  const input = `${header}.${claims}`;
  let key: CryptoKey;
  try {
    key = await signingKey(sa.private_key);
  } catch {
    throw new GoogleAuthError('the private_key of GOOGLE_SERVICE_ACCOUNT_JSON is not a PKCS #8 RSA key');
  }
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

const tokens = new Map<string, { token: string; until: number }>();
const inflight = new Map<string, Promise<string>>();

/**
 * An access token for `scope`, from the cache while it is younger than 50 minutes, else from the token endpoint.
 * Throws GoogleAuthError when the key is unusable or Google refuses the exchange.
 */
export async function googleAccessToken(
  json: string,
  scope = ANDROID_PUBLISHER_SCOPE,
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const sa = parseServiceAccount(json);
  const cacheKey = `${sa.client_email}|${scope}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.until > now) return hit.token;
  // Checks that start together share one exchange (and one RSA signature).
  const running = inflight.get(cacheKey);
  if (running) return running;
  const p = exchange(sa, scope, cacheKey, fetchFn, now).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, p);
  return p;
}

async function exchange(sa: ServiceAccount, scope: string, cacheKey: string, fetchFn: typeof fetch, now: number): Promise<string> {
  const assertion = await signAssertion(sa, scope, Math.floor(now / 1000));
  const res = await fetchFn(sa.token_uri ?? GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: unknown; error_description?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== 'string') {
    throw new GoogleAuthError(`token exchange failed (${res.status}${body?.error ? `, ${String(body.error)}` : ''})`);
  }
  tokens.set(cacheKey, { token: body.access_token, until: now + TOKEN_CACHE_MS });
  return body.access_token;
}

/** Tests: forget cached tokens and imported keys. */
export function resetGoogleAuthForTests() {
  tokens.clear();
  inflight.clear();
  keys.clear();
}

// ---------- OIDC tokens of Pub/Sub push subscriptions

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Google's signing keys are cached this long; an unknown kid fetches them again, at most once a minute. */
const CERTS_CACHE_MS = 60 * 60_000;
const CERTS_RETRY_MS = 60_000;

interface Jwk extends JsonWebKey {
  kid?: string;
}
let certs: { keys: Map<string, Promise<CryptoKey>>; at: number } | null = null;

async function loadCerts(fetchFn: typeof fetch, now: number) {
  const res = await fetchFn(GOOGLE_CERTS_URL);
  if (!res.ok) throw new GoogleAuthError(`Google certs answered ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const k of body.keys ?? []) {
    if (!k.kid || k.kty !== 'RSA') continue;
    const { kid, ...jwk } = k;
    keys.set(kid, crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  certs = { keys, at: now };
  return keys;
}

async function certFor(kid: string, fetchFn: typeof fetch, now: number): Promise<CryptoKey | null> {
  let keys = certs && now - certs.at < CERTS_CACHE_MS ? certs.keys : await loadCerts(fetchFn, now);
  if (!keys.has(kid) && certs && now - certs.at >= CERTS_RETRY_MS) keys = await loadCerts(fetchFn, now);
  const k = keys.get(kid);
  return k ? k.catch(() => null) : null;
}

const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export interface OidcClaims {
  iss?: string;
  aud?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  iat?: number;
  sub?: string;
}

/**
 * Checks the OIDC token a Pub/Sub push subscription sends in `Authorization: Bearer`: RS256 with one of Google's keys
 * (fetched from GOOGLE_CERTS_URL and cached), issuer accounts.google.com, `aud` equal to `audience`, a verified `email`
 * equal to `email`, not expired. Throws GoogleAuthError with the reason otherwise.
 */
export async function verifyGoogleOidc(
  token: string,
  expect: { audience: string; email: string },
  fetchFn: typeof fetch = fetch,
  now = Date.now(),
): Promise<OidcClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('not a JWT');
  let header: { alg?: string; kid?: string };
  let claims: OidcClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    throw new GoogleAuthError('unreadable JWT');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new GoogleAuthError('expected an RS256 token with a kid');
  const key = await certFor(header.kid, fetchFn, now);
  if (!key) throw new GoogleAuthError('unknown signing key');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new GoogleAuthError('bad signature');
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) throw new GoogleAuthError('wrong issuer');
  if (claims.aud !== expect.audience) throw new GoogleAuthError('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 60_000) throw new GoogleAuthError('expired');
  if (typeof claims.iat === 'number' && claims.iat * 1000 > now + 300_000) throw new GoogleAuthError('issued in the future');
  if (!claims.email || claims.email.toLowerCase() !== expect.email.toLowerCase() || claims.email_verified !== true) {
    throw new GoogleAuthError('wrong service account');
  }
  return claims;
}

/** Tests: forget Google's cached signing keys. */
export function resetGoogleCertsForTests() {
  certs = null;
}
