import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTrustedRootForTests } from '../src/worker/lib/apple-jws';
import { revenueCatAmount, revenueCatAuthorized, founderDataVisitorId } from '../src/worker/revenuecat';
import { makeChain, signJws, type TestChain } from './helpers/apple-chain';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const BUNDLE = 'com.example.shipkit';
const SECRET = 'rc_test_secret_0123456789';
let w: TestWorker;
let site: any;
let chain: TestChain;
let n = 0;

const uid = () => crypto.randomUUID();
const txId = () => String(4_000_000_000 + ++n);
const payment = (id: string) => w.db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<any>();
const signals = (type?: string) =>
  w.db
    .prepare(`SELECT * FROM subscription_signals WHERE site_id = ?${type ? ' AND type = ?' : ''} ORDER BY ts`)
    .bind(...(type ? [site.id, type] : [site.id]))
    .all<any>()
    .then((r) => r.results);

/** An app session for an install, so payments and signals have a session to be credited to. */
const appSession = async (vid: string, sid: string) => {
  const res = await w.fetch('/api/app/events', {
    method: 'POST',
    body: JSON.stringify({ w: site.id, vid, ctx: { bundle_id: BUNDLE, app_version: '1.0', build: '1', os_version: '26.1' }, events: [{ t: 'session_start', sid, ts: Date.now() - 60_000 }] }),
  });
  expect(res.status).toBe(202);
};

const rcEvent = (type: string, over: Record<string, unknown> = {}) => {
  const tx = txId();
  return {
    id: uid().toUpperCase(),
    type,
    app_user_id: '$RCAnonymousID:abc',
    original_app_user_id: '$RCAnonymousID:abc',
    product_id: 'pro_monthly',
    period_type: 'NORMAL',
    purchased_at_ms: Date.now(),
    event_timestamp_ms: Date.now(),
    environment: 'PRODUCTION',
    store: 'APP_STORE',
    transaction_id: tx,
    original_transaction_id: tx,
    price: 10.85,
    price_in_purchased_currency: 9.99,
    currency: 'EUR',
    subscriber_attributes: {},
    ...over,
  };
};
const attr = (vid: string) => ({ founderDataVisitorId: { value: vid, updated_at_ms: Date.now() } });

const deliver = async (event: Record<string, unknown>, auth: string | null = SECRET, siteId = site.id) => {
  const res = await w.fetch(`/api/webhooks/revenuecat/${siteId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) },
    body: JSON.stringify({ api_version: '1.0', event }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  w = await startWorker();
  site = await w.createSite({ domain: 'example.com', app_bundle_id: BUNDLE, currency: 'EUR', revenuecat_auth: SECRET });
  chain = await makeChain();
  setTrustedRootForTests(chain.root.der);
});
afterAll(async () => {
  setTrustedRootForTests(null);
  await w.dispose();
});

describe('helpers', () => {
  it('reads the visitor attribute, converts amounts, checks the secret', () => {
    const vid = uid();
    expect(founderDataVisitorId({ subscriber_attributes: attr(vid.replace(/-/g, '').toUpperCase()) })).toBe(vid);
    expect(founderDataVisitorId({ subscriber_attributes: { $founderDataVisitorId: { value: vid } } })).toBe(vid);
    expect(founderDataVisitorId({ subscriber_attributes: { founderDataVisitorId: { value: 'bad id!' } } })).toBeNull();
    expect(founderDataVisitorId({})).toBeNull();
    expect(revenueCatAmount(9.99, 'EUR')).toBe(999);
    expect(revenueCatAmount(1200, 'JPY')).toBe(1200);
    expect(revenueCatAuthorized(SECRET, SECRET)).toBe(true);
    expect(revenueCatAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(revenueCatAuthorized('Bearer nope', SECRET)).toBe(false);
    expect(revenueCatAuthorized(null, SECRET)).toBe(false);
  });
});

describe('settings', () => {
  it('stores the secret hidden, strips "Bearer", refuses short ones, clears with an empty string', async () => {
    const s = await w.createSite({ domain: 'rc-settings.com' });
    expect(s.revenuecat_auth).toBeNull();
    let r = await w.admin(`/api/sites/${s.id}`, { method: 'PATCH', json: { revenuecat_auth: 'short' } });
    expect(r.status).toBe(400);
    r = await w.admin(`/api/sites/${s.id}`, { method: 'PATCH', json: { revenuecat_auth: `Bearer ${SECRET}` } });
    expect(r.body.revenuecat_auth).toBe('••••••••');
    const row = await w.db.prepare('SELECT revenuecat_auth FROM sites WHERE id = ?').bind(s.id).first<any>();
    expect(row.revenuecat_auth).toBe(SECRET);
    // Saving the masked value back keeps the secret.
    await w.admin(`/api/sites/${s.id}`, { method: 'PATCH', json: { revenuecat_auth: '••••••••', name: 'x' } });
    expect((await w.db.prepare('SELECT revenuecat_auth FROM sites WHERE id = ?').bind(s.id).first<any>()).revenuecat_auth).toBe(SECRET);
    r = await w.admin(`/api/sites/${s.id}`, { method: 'PATCH', json: { revenuecat_auth: '' } });
    expect(r.body.revenuecat_auth).toBeNull();
  });
});

describe('POST /api/webhooks/revenuecat/:siteId', () => {
  it('needs the site, a configured secret and the right Authorization header', async () => {
    expect((await deliver(rcEvent('INITIAL_PURCHASE'), SECRET, 'nope')).status).toBe(404);
    const bare = await w.createSite({ domain: 'no-rc.com' });
    expect((await deliver(rcEvent('INITIAL_PURCHASE'), SECRET, bare.id)).status).toBe(400);
    expect((await deliver(rcEvent('INITIAL_PURCHASE'), 'wrong-secret-0123456789')).status).toBe(401);
    expect((await deliver(rcEvent('INITIAL_PURCHASE'), null)).status).toBe(401);
    const bad = await w.fetch(`/api/webhooks/revenuecat/${site.id}`, { method: 'POST', headers: { authorization: SECRET }, body: '{"nope":1}' });
    expect(bad.status).toBe(400);
    expect((await deliver(rcEvent('TEST'), `Bearer ${SECRET}`)).body).toEqual({ ok: true, ignored: 'TEST' });
  });

  it('INITIAL_PURCHASE: a payment linked through founderDataVisitorId, in the purchase currency', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    const e = rcEvent('INITIAL_PURCHASE', { subscriber_attributes: attr(vid), price_in_purchased_currency: 4.99, currency: 'CHF' });
    expect((await deliver(e)).body).toEqual({ ok: true, result: 'recorded' });
    expect(await payment(`apple_${e.transaction_id}`)).toMatchObject({
      provider: 'revenuecat',
      kind: 'payment',
      amount: 499,
      currency: 'CHF',
      visitor_id: vid,
      session_id: sid,
      matched_by: 'subscriber_attribute',
      customer_id: `apple:${e.original_transaction_id}`,
      product: 'pro_monthly',
      renewal: 0,
    });
    // RevenueCat retries: still one row.
    expect((await deliver(e)).body).toEqual({ ok: true, result: 'duplicate' });
  });

  it('counts a purchase once when the SDK sent the same App Store transaction (either order)', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    const tx = txId();
    const jwsTx = { transactionId: tx, originalTransactionId: tx, bundleId: BUNDLE, productId: 'pro_year', purchaseDate: Date.now(), price: 49990, currency: 'EUR', environment: 'Production', signedDate: Date.now() };
    await w.fetch('/api/app/events', {
      method: 'POST',
      body: JSON.stringify({ w: site.id, vid, ctx: { bundle_id: BUNDLE }, events: [{ t: 'purchase', sid, jws: await signJws(jwsTx, chain) }] }),
    });
    const e = rcEvent('INITIAL_PURCHASE', { transaction_id: tx, original_transaction_id: tx, price_in_purchased_currency: 49.99, product_id: 'pro_year' });
    expect((await deliver(e)).body.result).toBe('duplicate');
    const rows = await w.db.prepare('SELECT * FROM payments WHERE id = ?').bind(`apple_${tx}`).all<any>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ provider: 'app_store', amount: 4999, visitor_id: vid, matched_by: 'app_event' });

    // RevenueCat first, then the SDK: one row, and the app's event links it to the session.
    const vid2 = uid(), sid2 = uid();
    await appSession(vid2, sid2);
    const e2 = rcEvent('INITIAL_PURCHASE');
    await deliver(e2);
    expect((await payment(`apple_${e2.transaction_id}`)).visitor_id).toBeNull();
    const jwsTx2 = { ...jwsTx, transactionId: e2.transaction_id, originalTransactionId: e2.transaction_id, price: 9990 };
    await w.fetch('/api/app/events', {
      method: 'POST',
      body: JSON.stringify({ w: site.id, vid: vid2, ctx: { bundle_id: BUNDLE }, events: [{ t: 'purchase', sid: sid2, jws: await signJws(jwsTx2, chain) }] }),
    });
    expect(await payment(`apple_${e2.transaction_id}`)).toMatchObject({ provider: 'revenuecat', visitor_id: vid2, session_id: sid2, matched_by: 'app_event' });
  });

  it('a trial start is a trial signal, not revenue; the paid conversion is the first payment', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    const trial = rcEvent('INITIAL_PURCHASE', { period_type: 'TRIAL', price: 0, price_in_purchased_currency: 0, subscriber_attributes: attr(vid) });
    expect((await deliver(trial)).body).toEqual({ ok: true, result: 'trial' });
    expect(await payment(`apple_${trial.transaction_id}`)).toBeNull();
    const t = (await signals('trial_start')).find((s: any) => s.id === `apple_trial_${trial.transaction_id}`);
    expect(t).toMatchObject({ provider: 'revenuecat', visitor_id: vid, session_id: sid, product: 'pro_monthly', sandbox: 0 });

    const conversion = rcEvent('RENEWAL', {
      is_trial_conversion: true,
      original_transaction_id: trial.transaction_id,
      subscriber_attributes: attr(vid),
      purchased_at_ms: Date.now() + 1000,
    });
    expect((await deliver(conversion)).body.result).toBe('recorded');
    expect(await payment(`apple_${conversion.transaction_id}`)).toMatchObject({ renewal: 0, visitor_id: vid, amount: 999 });
  });

  it('RENEWAL without the attribute links through the earlier payment and counts as a renewal', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    const first = rcEvent('INITIAL_PURCHASE', { subscriber_attributes: attr(vid) });
    await deliver(first);
    const renew = rcEvent('RENEWAL', { original_transaction_id: first.transaction_id, purchased_at_ms: Date.now() + 5000 });
    expect((await deliver(renew)).body.result).toBe('recorded');
    expect(await payment(`apple_${renew.transaction_id}`)).toMatchObject({ visitor_id: vid, matched_by: 'customer', renewal: 1 });
  });

  it('CANCELLATION is a churn signal; a refund subtracts the payment once', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    const first = rcEvent('INITIAL_PURCHASE', { subscriber_attributes: attr(vid) });
    await deliver(first);
    const cancel = rcEvent('CANCELLATION', { transaction_id: first.transaction_id, original_transaction_id: first.transaction_id, cancel_reason: 'UNSUBSCRIBE' });
    expect((await deliver(cancel)).body).toEqual({ ok: true, result: 'signal' });
    expect((await signals('cancellation')).find((s: any) => s.id === `rc_${cancel.id}`)).toMatchObject({ reason: 'UNSUBSCRIBE', visitor_id: vid });
    expect(await payment(`apple_refund_${first.transaction_id}`)).toBeNull();

    const refund = rcEvent('CANCELLATION', {
      transaction_id: first.transaction_id,
      original_transaction_id: first.transaction_id,
      cancel_reason: 'CUSTOMER_SUPPORT',
      price_in_purchased_currency: -9.99,
    });
    expect((await deliver(refund)).body.result).toBe('refund');
    expect(await payment(`apple_refund_${first.transaction_id}`)).toMatchObject({ kind: 'refund', amount: -999, currency: 'EUR', session_id: sid, provider: 'revenuecat' });
    expect((await deliver({ ...refund, id: uid() })).body.result).toBe('duplicate');
    // A refund for a payment never recorded changes nothing.
    expect((await deliver(rcEvent('REFUND'))).body.result).toBe('no_original');
  });

  it('EXPIRATION, BILLING_ISSUE and PRODUCT_CHANGE are signals; a retried event is stored once', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    const first = rcEvent('INITIAL_PURCHASE', { subscriber_attributes: attr(vid) });
    await deliver(first);
    const link = { transaction_id: first.transaction_id, original_transaction_id: first.transaction_id };
    const exp = rcEvent('EXPIRATION', { ...link, expiration_reason: 'BILLING_ERROR' });
    await deliver(exp);
    await deliver(exp);
    expect((await signals('expiration')).filter((s: any) => s.id === `rc_${exp.id}`)).toHaveLength(1);
    expect((await signals('expiration')).find((s: any) => s.id === `rc_${exp.id}`)).toMatchObject({ reason: 'BILLING_ERROR', visitor_id: vid });
    expect((await deliver(rcEvent('BILLING_ISSUE', link))).body.result).toBe('signal');
    const change = rcEvent('PRODUCT_CHANGE', { ...link, new_product_id: 'pro_year', price_in_purchased_currency: 0 });
    expect((await deliver(change)).body.result).toBe('signal');
    expect((await signals('product_change')).find((s: any) => s.id === `rc_${change.id}`)).toMatchObject({ product: 'pro_year' });
    expect((await deliver(rcEvent('SUBSCRIPTION_PAUSED'))).body).toEqual({ ok: true, ignored: 'SUBSCRIPTION_PAUSED' });
  });

  it('sandbox events: ignored by default, kept apart from revenue when sandbox purchases are on', async () => {
    const e = rcEvent('INITIAL_PURCHASE', { environment: 'SANDBOX' });
    expect((await deliver(e)).body).toEqual({ ok: true, ignored: 'sandbox' });
    expect(await payment(`apple_${e.transaction_id}`)).toBeNull();
    const s = await w.createSite({ domain: 'rc-sandbox.com', app_bundle_id: BUNDLE, revenuecat_auth: SECRET, accept_sandbox: 1 });
    expect((await deliver(e, SECRET, s.id)).body.result).toBe('recorded');
    expect(await payment(`apple_${e.transaction_id}`)).toMatchObject({ provider: 'app_store_sandbox' });
  });

  it('a store cancellation is a cancel_reason answer: the store category, once per period, no trait', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    const first = rcEvent('INITIAL_PURCHASE', { subscriber_attributes: attr(vid) });
    await deliver(first);
    const expires = Date.now() + 20 * 86_400_000;
    const link = { transaction_id: first.transaction_id, original_transaction_id: first.transaction_id, expiration_at_ms: expires };
    const answers = () =>
      w.db.prepare("SELECT * FROM survey_answers WHERE site_id = ? AND survey = 'cancel_reason' AND subscription_id = ?").bind(site.id, first.transaction_id).all<any>().then((r) => r.results);
    const cancel = rcEvent('CANCELLATION', { ...link, cancel_reason: 'UNSUBSCRIBE' });
    await deliver(cancel);
    await deliver(cancel);
    // The EXPIRATION at the period's end is the same cancellation: no second answer.
    await deliver(rcEvent('EXPIRATION', { ...link, expiration_reason: 'UNSUBSCRIBE', event_timestamp_ms: expires }));
    const got = await answers();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ answer: 'unsubscribed', via: 'app_store', text: null, visitor_id: vid, id: `app_store:${first.transaction_id}:${expires}` });
    // Apple's category is not the person's answer, so their trait stays empty and the cancel card may still ask them.
    const v = await w.db.prepare('SELECT traits FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid).first<any>();
    expect(JSON.parse(v?.traits ?? '{}').cancel_reason).toBeUndefined();
  });

  it('maps every store reason; Google Play counts, a pause, sandbox and other stores do not', async () => {
    const { storeReason } = await import('../src/worker/revenuecat');
    const r = (store: string, reason: string, key = 'cancel_reason') => storeReason({ store, [key]: reason });
    expect(r('APP_STORE', 'UNSUBSCRIBE')).toEqual({ via: 'app_store', reason: 'unsubscribed' });
    expect(r('MAC_APP_STORE', 'BILLING_ERROR')).toEqual({ via: 'app_store', reason: 'billing_error' });
    expect(r('APP_STORE', 'PRICE_INCREASE', 'expiration_reason')).toEqual({ via: 'app_store', reason: 'price_increase' });
    expect(r('PLAY_STORE', 'DEVELOPER_INITIATED')).toEqual({ via: 'play_store', reason: 'developer' });
    expect(r('APP_STORE', 'CUSTOMER_SUPPORT', 'expiration_reason')).toEqual({ via: 'app_store', reason: 'refunded' });
    expect(r('APP_STORE', 'UNKNOWN')).toEqual({ via: 'app_store', reason: 'unknown' });
    expect(r('PLAY_STORE', 'SUBSCRIPTION_PAUSED', 'expiration_reason')).toBeNull();
    expect(r('STRIPE', 'UNSUBSCRIBE')).toBeNull();
    expect(r('AMAZON', 'UNSUBSCRIBE')).toBeNull();

    const before = await w.db.prepare("SELECT COUNT(*) AS n FROM survey_answers WHERE site_id = ?").bind(site.id).first<number>('n');
    await deliver(rcEvent('CANCELLATION', { store: 'STRIPE', cancel_reason: 'UNSUBSCRIBE' }));
    await deliver(rcEvent('EXPIRATION', { store: 'PLAY_STORE', expiration_reason: 'SUBSCRIPTION_PAUSED' }));
    // A billing issue warns before the store gives up; it is no cancellation.
    await deliver(rcEvent('BILLING_ISSUE', {}));
    expect(await w.db.prepare("SELECT COUNT(*) AS n FROM survey_answers WHERE site_id = ?").bind(site.id).first<number>('n')).toBe(before);
    await deliver(rcEvent('EXPIRATION', { store: 'PLAY_STORE', expiration_reason: 'BILLING_ERROR', transaction_id: 'GPA.9-1', original_transaction_id: 'GPA.9-1' }));
    expect(await w.db.prepare("SELECT answer, via FROM survey_answers WHERE site_id = ? AND subscription_id = 'GPA.9-1'").bind(site.id).first<any>()).toEqual({ answer: 'billing_error', via: 'play_store' });
  });

  it('App Store Server Notifications name the same categories', async () => {
    const { appleCancelReason } = await import('../src/worker/appstore');
    expect(appleCancelReason({ type: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED' })).toBe('unsubscribed');
    expect(appleCancelReason({ type: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_ENABLED' })).toBeNull();
    expect(appleCancelReason({ type: 'EXPIRED', subtype: 'VOLUNTARY' })).toBe('unsubscribed');
    expect(appleCancelReason({ type: 'EXPIRED', subtype: 'BILLING_RETRY' })).toBe('billing_error');
    expect(appleCancelReason({ type: 'EXPIRED', subtype: 'PRICE_INCREASE' })).toBe('price_increase');
    expect(appleCancelReason({ type: 'EXPIRED', subtype: 'PRODUCT_NOT_FOR_SALE' })).toBe('developer');
    expect(appleCancelReason({ type: 'EXPIRED' })).toBe('unknown');
    expect(appleCancelReason({ type: 'GRACE_PERIOD_EXPIRED' })).toBe('billing_error');
    expect(appleCancelReason({ type: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD' })).toBeNull();
  });

  it('migration 0099 adds the reasons stored before, one per subscription, only where the visitor has a canceled one', async () => {
    const s = await w.createSite({ domain: 'rc-backfill.com', app_bundle_id: BUNDLE, revenuecat_auth: SECRET });
    const t = Date.now() - 10 * 86_400_000;
    const sub = (id: string, vid: string, o: Record<string, unknown>) =>
      w.db
        .prepare('INSERT INTO subscriptions (site_id, id, provider, visitor_id, status, started_at, canceled_at, ended_at, expires_at, sandbox, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)')
        .bind(s.id, id, 'revenuecat', vid, o.status, t - 30 * 86_400_000, o.canceled ?? null, o.ended ?? null, t + 20 * 86_400_000, t)
        .run();
    const sig = (id: string, vid: string | null, type: string, reason: string, ts: number, store = 'APP_STORE', sandbox = 0) =>
      w.db
        .prepare('INSERT INTO subscription_signals (site_id, id, provider, ts, type, visitor_id, store, reason, sandbox) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(s.id, id, 'revenuecat', ts, type, vid, store, reason, sandbox)
        .run();
    await sub('bf_sub_1', 'bf-visitor-0001', { status: 'expired', canceled: t, ended: t + 86_400_000 });
    await sub('bf_sub_2', 'bf-visitor-0002', { status: 'active' });
    await sig('rc_bf1', 'bf-visitor-0001', 'cancellation', 'PRICE_INCREASE', t);
    await sig('rc_bf2', 'bf-visitor-0001', 'expiration', 'PRICE_INCREASE', t + 86_400_000);
    // A visitor whose subscription still renews, a signal without a visitor, a sandbox one: nothing.
    await sig('rc_bf3', 'bf-visitor-0002', 'cancellation', 'UNSUBSCRIBE', t);
    await sig('rc_bf4', null, 'cancellation', 'UNSUBSCRIBE', t);
    await sig('rc_bf5', 'bf-visitor-0001', 'cancellation', 'UNSUBSCRIBE', t - 1000, 'APP_STORE', 1);
    const fs = await import('node:fs');
    const sql = fs.readFileSync(new URL('../migrations/0099_store_cancel_reasons.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
    await w.db.prepare(sql.trim().replace(/;$/, '')).run();
    const got = (await w.db.prepare('SELECT * FROM survey_answers WHERE site_id = ?').bind(s.id).all<any>()).results;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ survey: 'cancel_reason', ts: t, id: 'backfill:bf_sub_1', subscription_id: 'bf_sub_1', answer: 'price_increase', via: 'app_store', text: null });
    // Run again: nothing more.
    await w.db.prepare(sql.trim().replace(/;$/, '')).run();
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM survey_answers WHERE site_id = ?').bind(s.id).first<number>('n'))).toBe(1);
  });

  it('other stores get their own payment ids', async () => {
    const e = rcEvent('NON_RENEWING_PURCHASE', { store: 'PLAY_STORE', transaction_id: 'GPA.1234-5678', original_transaction_id: 'GPA.1234-5678', original_app_user_id: 'user_42' });
    expect((await deliver(e)).body.result).toBe('recorded');
    expect(await payment('rc_play_store_GPA.1234-5678')).toMatchObject({ provider: 'revenuecat', customer_id: 'rc:user_42', amount: 999 });
  });

  itPro('the App paywall panel counts a RevenueCat first purchase', async () => {
    const vid = uid(), sid = uid();
    await appSession(vid, sid);
    await w.fetch('/api/app/events', {
      method: 'POST',
      body: JSON.stringify({ w: site.id, vid, ctx: { bundle_id: BUNDLE }, events: [{ t: 'goal', sid, n: 'paywall_view', p: { source: 'rc_test' } }] }),
    });
    await deliver(rcEvent('INITIAL_PURCHASE', { subscriber_attributes: attr(vid) }));
    const r = await w.admin(`/api/sites/${site.id}/app/paywall?period=24h`);
    expect(r.body.groups.find((g: any) => g.value === 'rc_test')).toMatchObject({ paywallViews: 1, purchases: 1, revenue: 999 });
  });
});

describe('erasing an app user id', () => {
  it('clears the rc: customer id from that user’s payments and subscriptions, also without a visitor', async () => {
    const ev = rcEvent('INITIAL_PURCHASE', { store: 'PLAY_STORE', app_user_id: 'erase-me-42', original_app_user_id: 'erase-me-42' });
    expect((await deliver(ev)).status).toBe(200);
    const before = await w.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE site_id = ? AND customer_id = 'rc:erase-me-42'").bind(site.id).first<{ n: number }>();
    expect(before!.n).toBeGreaterThan(0);
    const res = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { user_id: 'erase-me-42' } });
    expect(res.status).toBe(200);
    expect(res.body.payments).toBeGreaterThan(0);
    for (const table of ['payments', 'subscriptions']) {
      const left = await w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ? AND customer_id = 'rc:erase-me-42'`).bind(site.id).first<{ n: number }>();
      expect(left!.n, table).toBe(0);
    }
  });
});
