// Android apps (docs/APP-API.md section 9): ingest, the platform split, settings, Google Play purchase checks, the
// RTDN webhook and the service account helper. Google is a mock: nothing leaves the machine.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHostSql, hasApp, isAppFilter, isAppHost, platformLabelSql, platformOf, webHostSql } from '../src/shared/platform';
import { playAmount } from '../src/worker/googleplay';
import {
  GOOGLE_CERTS_URL,
  GOOGLE_TOKEN_URL,
  GoogleAuthError,
  googleAccessToken,
  parseServiceAccount,
  resetGoogleAuthForTests,
  resetGoogleCertsForTests,
  signAssertion,
  TOKEN_CACHE_MS,
  verifyGoogleOidc,
} from '../src/worker/lib/google-auth';
import { checklist } from '../src/worker/setup-checklist';
import { startWorker, type TestWorker } from './helpers/worker';

const PKG = 'com.example.shipkit';
const PUSH = 'pubsub-push@example-project.iam.gserviceaccount.com';
const PUBLISHER = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/`;

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pem = (der: ArrayBuffer) => `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;

async function rsaKey() {
  return (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

/** A JWT signed with `key`, as Google signs a Pub/Sub push token. */
async function jwt(key: CryptoKey, claims: Record<string, unknown>, kid = 'test-kid') {
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

let saKeys: CryptoKeyPair;
let googleKeys: CryptoKeyPair;
let SA_JSON: string;
let jwks: unknown;

beforeAll(async () => {
  saKeys = await rsaKey();
  googleKeys = await rsaKey();
  SA_JSON = JSON.stringify({ type: 'service_account', client_email: 'founderdata@example-project.iam.gserviceaccount.com', private_key: pem(await crypto.subtle.exportKey('pkcs8', saKeys.privateKey)) });
  const pub = (await crypto.subtle.exportKey('jwk', googleKeys.publicKey)) as JsonWebKey;
  jwks = { keys: [{ kid: 'test-kid', kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n, e: pub.e }] };
});

/**
 * Google's APIs as a test sets them: `resources` maps a publisher path to its JSON answer. Every URL asked is in
 * `calls`. Other URLs (the rate API) go to the fetch the helper installed.
 */
function mockGoogle(resources: Record<string, unknown>) {
  const calls: string[] = [];
  const prev = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === GOOGLE_TOKEN_URL) {
      calls.push(url);
      return Response.json({ access_token: 'test-access-token', expires_in: 3599 });
    }
    if (url === GOOGLE_CERTS_URL) {
      calls.push(url);
      return Response.json(jwks);
    }
    if (url.startsWith(PUBLISHER)) {
      calls.push(url);
      const path = decodeURIComponent(url.slice(PUBLISHER.length));
      if (new Headers(init?.headers).get('authorization') !== 'Bearer test-access-token') return new Response('unauthorized', { status: 401 });
      return path in resources ? Response.json(resources[path]) : new Response('not found', { status: 404 });
    }
    if (url.includes('googleapis.com')) throw new Error(`unexpected Google call ${url}`);
    return prev(input, init);
  });
  return calls;
}

const money = (units: string, nanos: number, currencyCode = 'EUR') => ({ currencyCode, units, nanos });
const order = (orderId: string, token: string, total = money('9', 990_000_000), extra: Record<string, unknown> = {}) => ({
  orderId,
  purchaseToken: token,
  state: 'PROCESSED',
  createTime: new Date(Date.now() - 60_000).toISOString(),
  total,
  lineItems: [{ productId: 'pro_monthly' }],
  ...extra,
});
const subscription = (orderId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'androidpublisher#subscriptionPurchaseV2',
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  startTime: new Date(Date.now() - 120_000).toISOString(),
  lineItems: [
    { productId: 'pro_monthly', latestSuccessfulOrderId: orderId, expiryTime: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } },
  ],
  ...extra,
});

describe('platform helpers', () => {
  it('tells iOS, Android and web sessions apart', () => {
    expect(isAppHost('ios:com.example.app')).toBe(true);
    expect(isAppHost('android:com.example.app')).toBe(true);
    expect(isAppHost('example.com')).toBe(false);
    expect(isAppHost(null)).toBe(false);
    expect(platformOf('ios:a.b')).toBe('ios');
    expect(platformOf('android:a.b')).toBe('android');
    expect(platformOf('example.com')).toBe('web');
    expect(platformOf(undefined)).toBe('web');
    expect(hasApp({ app_bundle_id: null, android_package: 'a.b' })).toBe(true);
    expect(hasApp({ app_bundle_id: null })).toBe(false);
    expect(['iOS', 'Android', 'App', 'Web'].map(isAppFilter)).toEqual([true, true, true, false]);
  });
  it('builds the SQL for both app prefixes', () => {
    expect(appHostSql('s.hostname')).toBe("(s.hostname LIKE 'ios:%' OR s.hostname LIKE 'android:%')");
    expect(webHostSql()).toBe("(hostname IS NULL OR NOT (hostname LIKE 'ios:%' OR hostname LIKE 'android:%'))");
    expect(platformLabelSql('h')).toContain("THEN 'Android'");
  });
  it('turns Google Money into minor units', () => {
    expect(playAmount(money('9', 990_000_000))).toEqual({ amount: 999, currency: 'EUR' });
    expect(playAmount(money('1200', 0, 'JPY'))).toEqual({ amount: 1200, currency: 'JPY' });
    expect(playAmount(money('0', 0))).toEqual({ amount: 0, currency: 'EUR' });
    expect(playAmount({ units: '1' })).toBeNull();
  });
});

describe('google-auth', () => {
  beforeEach(() => resetGoogleAuthForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('signs an RS256 assertion the public key verifies', async () => {
    const sa = parseServiceAccount(SA_JSON);
    const a = await signAssertion(sa, 'scope-x', 1_700_000_000);
    const [h, c, s] = a.split('.');
    const claims = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims).toMatchObject({ iss: sa.client_email, sub: sa.client_email, scope: 'scope-x', aud: GOOGLE_TOKEN_URL, iat: 1_700_000_000, exp: 1_700_003_600 });
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', saKeys.publicKey, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });

  it('exchanges the assertion and caches the token for 50 minutes', async () => {
    const bodies: string[] = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ access_token: `tok-${bodies.length}` });
    });
    const t0 = 1_800_000_000_000;
    expect(await googleAccessToken(SA_JSON, 'scope-x', f as unknown as typeof fetch, t0)).toBe('tok-1');
    expect(await googleAccessToken(SA_JSON, 'scope-x', f as unknown as typeof fetch, t0 + TOKEN_CACHE_MS - 1)).toBe('tok-1');
    expect(f).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(bodies[0]).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(await googleAccessToken(SA_JSON, 'scope-x', f as unknown as typeof fetch, t0 + TOKEN_CACHE_MS)).toBe('tok-2');
  });

  it('says why a key or an exchange fails', async () => {
    expect(() => parseServiceAccount('nope')).toThrow(GoogleAuthError);
    expect(() => parseServiceAccount('{"client_email":"a"}')).toThrow(/private_key/);
    const refuse = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
    await expect(googleAccessToken(SA_JSON, 'scope-x', refuse)).rejects.toThrow(/invalid_grant/);
  });

  it('checks Pub/Sub OIDC tokens', async () => {
    resetGoogleCertsForTests();
    const certs = (async () => Response.json(jwks)) as unknown as typeof fetch;
    const now = Date.now();
    const good = { iss: 'https://accounts.google.com', aud: 'https://h.example/api/webhooks/google/x', email: PUSH, email_verified: true, exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000) };
    const expect_ = { audience: good.aud, email: PUSH };
    await expect(verifyGoogleOidc(await jwt(googleKeys.privateKey, good), expect_, certs, now)).resolves.toMatchObject({ email: PUSH });
    await expect(verifyGoogleOidc(await jwt(googleKeys.privateKey, { ...good, aud: 'https://other' }), expect_, certs, now)).rejects.toThrow(/audience/);
    await expect(verifyGoogleOidc(await jwt(googleKeys.privateKey, { ...good, email: 'x@y.z' }), expect_, certs, now)).rejects.toThrow(/service account/);
    await expect(verifyGoogleOidc(await jwt(googleKeys.privateKey, { ...good, iss: 'https://evil' }), expect_, certs, now)).rejects.toThrow(/issuer/);
    await expect(verifyGoogleOidc(await jwt(googleKeys.privateKey, { ...good, exp: Math.floor(now / 1000) - 3600 }), expect_, certs, now)).rejects.toThrow(/expired/);
    await expect(verifyGoogleOidc(await jwt(saKeys.privateKey, good), expect_, certs, now)).rejects.toThrow(/signature/);
  });
});

describe('Android ingest and Google Play', () => {
  let w: TestWorker;
  let site: any;
  let iosOnly: any;
  const uid = () => crypto.randomUUID();
  const actx = (over: Record<string, unknown> = {}) => ({
    platform: 'android', app_version: '1.4.0', build: '57', os_version: '16', device: 'Pixel 9', form_factor: 'phone', locale: 'en_US', bundle_id: PKG, consent: true, ...over,
  });
  const post = (siteId: string, vid: string, events: unknown[], ctx: Record<string, unknown> = actx()) =>
    w.fetch('/api/app/events', { method: 'POST', body: JSON.stringify({ w: siteId, vid, ctx, events }) });
  const session = (id: string) => w.db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<any>();
  const payment = (id: string) => w.db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<any>();

  beforeAll(async () => {
    w = await startWorker({ GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON });
    site = await w.createSite({ domain: 'shipkit.example.com', app_bundle_id: 'com.example.shipkit.ios', android_package: PKG, google_push_email: PUSH, currency: 'EUR' });
    iosOnly = await w.createSite({ domain: 'ios-only.example.com', app_bundle_id: 'com.example.only', currency: 'EUR' });
  });
  afterAll(() => w.dispose());
  beforeEach(() => {
    resetGoogleAuthForTests();
    resetGoogleCertsForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores and shows the package name and push service account', async () => {
    const got = await w.admin(`/api/sites/${site.id}`);
    expect(got.body).toMatchObject({ android_package: PKG, google_push_email: PUSH });
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { android_package: 'not a package' } })).status).toBe(400);
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { android_package: 'single' } })).status).toBe(400);
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { google_push_email: 'nope' } })).status).toBe(400);
    const patched = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { google_push_email: ` ${PUSH.toUpperCase()} ` } });
    expect(patched.body.google_push_email).toBe(PUSH);
    // A PATCH that leaves the fields out keeps them.
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { name: 'Shipkit' } })).body).toMatchObject({ android_package: PKG, google_push_email: PUSH });
  });

  it('checks the package name of an Android batch', async () => {
    const sid = uid();
    const wrong = await post(site.id, uid(), [{ t: 'session_start', sid }], actx({ bundle_id: 'com.other.app' }));
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as any).error).toMatch(/package com.other.app/);
    // The iOS bundle id is not the Android package.
    expect((await post(site.id, uid(), [{ t: 'session_start', sid }], actx({ bundle_id: 'com.example.shipkit.ios' }))).status).toBe(403);
    const none = await post(iosOnly.id, uid(), [{ t: 'session_start', sid }], actx({ bundle_id: 'com.example.only' }));
    expect(none.status).toBe(403);
    expect(((await none.json()) as any).error).toMatch(/Android package name/);
    await w.flush();
    // The refusal shows its own banner: android_rejected_at, not app_rejected_at.
    const listed = (await w.admin('/api/sites')).body.find((s: any) => s.id === iosOnly.id);
    expect(listed.android_rejected_at).toBeGreaterThan(0);
    expect(listed.app_rejected_at).toBeNull();
  });

  it('stores Android sessions under android:<package> with the Android os and the form factor', async () => {
    const phone = uid(), tablet = uid();
    expect((await post(site.id, uid(), [{ t: 'session_start', sid: phone }, { t: 'screen', sid: phone, n: 'Home' }])).status).toBe(202);
    expect((await post(site.id, uid(), [{ t: 'session_start', sid: tablet }], actx({ form_factor: 'tablet', device: 'Pixel Tablet' }))).status).toBe(202);
    expect(await session(phone)).toMatchObject({ hostname: `android:${PKG}`, os: 'Android 16', device: 'Mobile', browser: 'App', app_version: '1.4.0 (57)' });
    expect((await session(tablet)).device).toBe('Tablet');
    // An iOS batch on the same site is still iOS.
    const ios = uid();
    await post(site.id, uid(), [{ t: 'session_start', sid: ios }], { bundle_id: 'com.example.shipkit.ios', os_version: '26.1', device: 'iPad16,1' });
    expect(await session(ios)).toMatchObject({ hostname: 'ios:com.example.shipkit.ios', os: 'iOS 26.1', device: 'Tablet' });
  });

  it('splits the platform breakdown into iOS, Android and Web and filters on each', async () => {
    const q = (path: string, filters?: Record<string, string>) =>
      w.admin(`/api/sites/${site.id}/${path}${path.includes('?') ? '&' : '?'}period=today${filters ? `&filters=${encodeURIComponent(JSON.stringify(filters))}` : ''}`);
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36' },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://shipkit.example.com/', r: '', vid: 'web-visitor-a', sid: 'web-session-a' }),
    });
    const rows = (await q('breakdown?dim=platform')).body;
    const by = Object.fromEntries(rows.map((r: any) => [r.label, r.visitors]));
    expect(by.Android).toBeGreaterThanOrEqual(2);
    expect(by.iOS).toBeGreaterThanOrEqual(1);
    expect(by.Web).toBe(1);
    const android = (await q('overview', { platform: 'Android' })).body.current.visitors;
    const ios = (await q('overview', { platform: 'iOS' })).body.current.visitors;
    expect(android).toBe(by.Android);
    expect((await q('overview', { platform: 'App' })).body.current.visitors).toBe(android + ios);
  });

  it('skips Play purchases that are malformed or in an iOS batch', async () => {
    const sid = uid();
    const res = await post(site.id, uid(), [
      { t: 'session_start', sid },
      { t: 'purchase', sid, store: 'google_play', token: 'short', product: 'pro', kind: 'subs' },
      { t: 'purchase', sid, store: 'google_play', token: 'a'.repeat(40), product: 'pro', kind: 'other' },
      { t: 'purchase', sid, jws: 'x.y.z' },
    ]);
    expect(((await res.json()) as any).rejected).toBe(3);
    const ios = await post(site.id, uid(), [{ t: 'session_start', sid: uid() }, { t: 'purchase', sid, store: 'google_play', token: 'a'.repeat(40), kind: 'subs' }], {
      bundle_id: 'com.example.shipkit.ios',
    });
    expect(((await ios.json()) as any).rejected).toBe(1);
  });

  it('records a subscription after checking it with Google, outside the request', async () => {
    const token = 'tok_' + uid().replace(/-/g, '');
    const vid = uid(), sid = uid();
    const calls = mockGoogle({ [`purchases/subscriptionsv2/tokens/${token}`]: subscription('GPA.1111-2222-3333-44444'), 'orders/GPA.1111-2222-3333-44444': order('GPA.1111-2222-3333-44444', token) });
    const res = await post(site.id, vid, [{ t: 'session_start', sid }, { t: 'purchase', sid, store: 'google_play', token, product: 'pro_monthly', kind: 'subs', order: 'GPA.1111-2222-3333-44444' }]);
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).rejected).toBe(0);
    await w.flush();
    expect(calls.filter((u) => u.startsWith(PUBLISHER))).toHaveLength(2);
    expect(await payment('gplay_GPA.1111-2222-3333-44444')).toMatchObject({
      provider: 'google_play', amount: 999, currency: 'EUR', kind: 'payment', renewal: 0, customer_id: `gplay:${token}`, subscription_id: token,
      product: 'pro_monthly', visitor_id: vid, session_id: sid, matched_by: 'app_event',
    });
    const sub = await w.db.prepare('SELECT * FROM subscriptions WHERE site_id = ? AND id = ?').bind(site.id, token).first<any>();
    expect(sub).toMatchObject({ provider: 'google_play', customer_id: `gplay:${token}`, status: 'active', amount: 999, interval: 'month' });

    // The renewal: a new order on the same token (RTDN type 2 would run the same check).
    const calls2 = mockGoogle({
      [`purchases/subscriptionsv2/tokens/${token}`]: subscription('GPA.1111-2222-3333-44444..0'),
      'orders/GPA.1111-2222-3333-44444..0': order('GPA.1111-2222-3333-44444..0', token, money('9', 990_000_000), { createTime: new Date().toISOString() }),
    });
    await post(site.id, vid, [{ t: 'purchase', sid, store: 'google_play', token, kind: 'subs' }]);
    await w.flush();
    expect(await payment('gplay_GPA.1111-2222-3333-44444..0')).toMatchObject({ renewal: 1, subscription_id: token });
    // Reported again: stored once, and orders.get is not asked again.
    const before = calls2.length;
    await post(site.id, vid, [{ t: 'purchase', sid, store: 'google_play', token, kind: 'subs' }]);
    await w.flush();
    expect(calls2.slice(before).filter((u) => u.includes('/orders/'))).toHaveLength(0);
    expect((await w.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE id LIKE 'gplay_GPA.1111-2222-3333-44444%'").first<any>()).n).toBe(2);
  });

  it('follows linkedPurchaseToken back to the first token', async () => {
    const t1 = 'tok_first_' + uid().replace(/-/g, ''), t2 = 'tok_mid_' + uid().replace(/-/g, ''), t3 = 'tok_new_' + uid().replace(/-/g, '');
    mockGoogle({
      [`purchases/subscriptionsv2/tokens/${t1}`]: subscription('GPA.5555-0001'),
      'orders/GPA.5555-0001': order('GPA.5555-0001', t1),
      [`purchases/subscriptionsv2/tokens/${t2}`]: subscription('GPA.5555-0002', { linkedPurchaseToken: t1 }),
      [`purchases/subscriptionsv2/tokens/${t3}`]: subscription('GPA.5555-0003', { linkedPurchaseToken: t2 }),
      'orders/GPA.5555-0003': order('GPA.5555-0003', t3, money('19', 990_000_000), { createTime: new Date().toISOString() }),
    });
    const vid = uid(), sid = uid();
    await post(site.id, vid, [{ t: 'session_start', sid }, { t: 'purchase', sid, store: 'google_play', token: t1, kind: 'subs' }]);
    await w.flush();
    await post(site.id, vid, [{ t: 'purchase', sid, store: 'google_play', token: t3, kind: 'subs' }]);
    await w.flush();
    expect(await payment('gplay_GPA.5555-0003')).toMatchObject({ subscription_id: t1, customer_id: `gplay:${t1}`, renewal: 1, amount: 1999 });
  });

  it('records a one-time product and finds the visitor through the obfuscated account id', async () => {
    const vid = uid(), sid = uid(), token = 'tok_inapp_' + uid().replace(/-/g, '');
    await post(site.id, vid, [{ t: 'session_start', sid }]);
    mockGoogle({
      [`purchases/productsv2/tokens/${token}`]: {
        orderId: 'GPA.7777-0001',
        purchaseStateContext: { purchaseState: 'PURCHASED' },
        obfuscatedExternalAccountId: vid.toUpperCase(),
        productLineItem: [{ productId: 'coins_100' }],
        purchaseCompletionTime: new Date().toISOString(),
      },
      'orders/GPA.7777-0001': order('GPA.7777-0001', token, money('1200', 0, 'JPY')),
    });
    // A notification has no install: the obfuscated account id is the install id.
    const { checkPlayPurchase } = await import('../src/worker/googleplay');
    expect(await checkPlayPurchase(w.env, w.db, site, { token, kind: 'inapp' })).toBe('recorded');
    expect(await payment('gplay_GPA.7777-0001')).toMatchObject({ amount: 1200, currency: 'JPY', product: 'coins_100', subscription_id: null, visitor_id: vid, matched_by: 'app_account_token' });
  });

  it('writes nothing for pending purchases, and test purchases only with accept_sandbox', async () => {
    const { checkPlayPurchase } = await import('../src/worker/googleplay');
    const pending = 'tok_pending_' + uid().replace(/-/g, ''), test = 'tok_test_' + uid().replace(/-/g, ''), cancelled = 'tok_canc_' + uid().replace(/-/g, '');
    mockGoogle({
      [`purchases/subscriptionsv2/tokens/${pending}`]: subscription('GPA.8888-0001', { subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }),
      [`purchases/productsv2/tokens/${cancelled}`]: { orderId: 'GPA.8888-0003', purchaseStateContext: { purchaseState: 'CANCELLED' } },
      [`purchases/subscriptionsv2/tokens/${test}`]: subscription('GPA.8888-0002', { testPurchase: {} }),
      'orders/GPA.8888-0002': order('GPA.8888-0002', test),
    });
    expect(await checkPlayPurchase(w.env, w.db, site, { token: pending, kind: 'subs' })).toBe('pending');
    expect(await checkPlayPurchase(w.env, w.db, site, { token: cancelled, kind: 'inapp' })).toBe('not_purchased');
    expect(await checkPlayPurchase(w.env, w.db, site, { token: test, kind: 'subs' })).toBe('sandbox_off');
    expect(await payment('gplay_GPA.8888-0002')).toBeNull();
    const sandbox = { ...site, accept_sandbox: 1 };
    expect(await checkPlayPurchase(w.env, w.db, sandbox, { token: test, kind: 'subs' })).toBe('recorded');
    expect((await payment('gplay_GPA.8888-0002')).provider).toBe('google_play_test');
    // A canceled subscription (auto-renew off) was still paid.
    const off = 'tok_off_' + uid().replace(/-/g, '');
    mockGoogle({
      [`purchases/subscriptionsv2/tokens/${off}`]: subscription('GPA.8888-0004', { subscriptionState: 'SUBSCRIPTION_STATE_CANCELED' }),
      'orders/GPA.8888-0004': order('GPA.8888-0004', off),
    });
    expect(await checkPlayPurchase(w.env, w.db, site, { token: off, kind: 'subs' })).toBe('recorded');
    // An order Google can't find: no row, so a later notification tries again.
    const lost = 'tok_lost_' + uid().replace(/-/g, '');
    mockGoogle({ [`purchases/subscriptionsv2/tokens/${lost}`]: subscription('GPA.8888-0005') });
    expect(await checkPlayPurchase(w.env, w.db, site, { token: lost, kind: 'subs' })).toBe('error');
    expect(await payment('gplay_GPA.8888-0005')).toBeNull();
  });

  it('keeps test purchases out of revenue', async () => {
    const res = await w.admin(`/api/sites/${site.id}/revenue?period=today`);
    const test = res.body.find((r: any) => r.provider === 'google_play_test');
    expect(test).toMatchObject({ counted: false });
    expect(res.body.find((r: any) => r.provider === 'google_play')).toMatchObject({ counted: true });
  });

  describe('RTDN webhook', () => {
    const url = () => `/api/webhooks/google/${site.id}`;
    const claims = () => ({
      iss: 'https://accounts.google.com', aud: `http://localhost${url()}`, email: PUSH, email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000),
    });
    const notify = async (n: Record<string, unknown>, over: Record<string, unknown> = {}, key = googleKeys.privateKey) => {
      const data = btoa(JSON.stringify({ version: '1.0', packageName: PKG, eventTimeMillis: String(Date.now()), ...n }));
      const res = await w.fetch(url(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await jwt(key, { ...claims(), ...over })}` },
        body: JSON.stringify({ message: { data, messageId: '1' }, subscription: 'projects/p/subscriptions/s' }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    it('refuses deliveries without a valid token from the site service account', async () => {
      mockGoogle({});
      expect((await w.fetch(url(), { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await notify({ testNotification: { version: '1.0' } }, { aud: 'https://elsewhere.example/hook' })).status).toBe(401);
      expect((await notify({ testNotification: { version: '1.0' } }, { email: 'other@example.com' })).status).toBe(401);
      expect((await notify({ testNotification: { version: '1.0' } }, {}, saKeys.privateKey)).status).toBe(401);
      expect((await notify({ testNotification: { version: '1.0' } })).body).toEqual({ ok: true, ignored: 'test' });
      expect((await notify({ packageName: 'com.other.app', testNotification: {} })).status).toBe(400);
      const noPkg = await w.fetch(`/api/webhooks/google/${iosOnly.id}`, { method: 'POST', body: '{}' });
      expect(noPkg.status).toBe(400);
    });

    it('checks purchases after the answer and ignores other types', async () => {
      const token = 'tok_rtdn_' + uid().replace(/-/g, '');
      mockGoogle({ [`purchases/subscriptionsv2/tokens/${token}`]: subscription('GPA.9999-0001'), 'orders/GPA.9999-0001': order('GPA.9999-0001', token) });
      expect((await notify({ subscriptionNotification: { version: '1.0', notificationType: 3, purchaseToken: token } })).body).toEqual({ ok: true, ignored: 'subscription_3' });
      expect((await notify({ subscriptionNotification: { version: '1.0', notificationType: 4, purchaseToken: token } })).body).toEqual({ ok: true, result: 'checking' });
      await w.flush();
      expect(await payment('gplay_GPA.9999-0001')).toMatchObject({ provider: 'google_play', amount: 999, visitor_id: null });
    });

    it('writes a refund row for a voided purchase', async () => {
      const voided = (orderId: string, refundType = 1) => ({ voidedPurchaseNotification: { purchaseToken: 'tok', orderId, productType: 1, refundType } });
      mockGoogle({});
      expect((await notify(voided('GPA.0000-never'))).body).toEqual({ ok: true, result: 'no_original' });
      expect((await notify(voided('GPA.9999-0001', 2))).body).toEqual({ ok: true, ignored: 'partial_refund' });
      expect((await notify(voided('GPA.9999-0001'))).body).toEqual({ ok: true, result: 'refund' });
      expect(await payment('gplay_refund_GPA.9999-0001')).toMatchObject({ kind: 'refund', amount: -999, provider: 'google_play' });
      expect((await notify(voided('GPA.9999-0001'))).body).toEqual({ ok: true, result: 'duplicate' });
    });
  });

  it('treats a site with only an Android package as an app', async () => {
    const droid = await w.createSite({ domain: 'droid.example.com', android_package: 'com.example.droid', currency: 'EUR' });
    const sid = uid();
    const res = await post(droid.id, uid(), [{ t: 'session_start', sid }, { t: 'screen', sid, n: 'Home' }], actx({ bundle_id: 'com.example.droid' }));
    expect(res.status).toBe(202);
    const o = (await w.admin(`/api/sites/${droid.id}/overview?period=today`)).body;
    expect(o.kind).toBe('app');
    expect(o.current.newInstalls).toBe(1);
    const listed = (await w.admin('/api/sites')).body.find((s: any) => s.id === droid.id);
    expect(listed.payments_connected).toBe(true);
  });

  it('lists Google Play in the setup checklist', async () => {
    const rows = await checklist(w.env, 'http://localhost', Date.now());
    expect(rows.find((r) => r.id === 'google_play')).toMatchObject({ status: 'ok', secrets: [{ name: 'GOOGLE_SERVICE_ACCOUNT_JSON', set: true }] });
    // The RTDN tests above sent deliveries with bad tokens: the row says so (index.ts counts 401s per provider).
    expect(rows.find((r) => r.id === `webhook:${site.id}:google`)).toMatchObject({ status: 'error', detail: expect.stringMatching(/failed the token check/) });
    const bare = await checklist({ ...w.env, GOOGLE_SERVICE_ACCOUNT_JSON: undefined }, 'http://localhost', Date.now());
    expect(bare.find((r) => r.id === 'google_play')).toMatchObject({ status: 'warn' });
    expect(bare.find((r) => r.id === `webhook:${site.id}:google`)).toBeUndefined();
  });
});
