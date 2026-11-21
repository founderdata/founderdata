// Measures D1 rows written per write path of core (Pro's paths: pro/test/cost.test.ts) (workerd's SQLite, which counts like D1: table row + one per index
// entry touched). The numbers back the free-plan table in docs/GUIDE.md; if one changes, update the guide.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { setTrustedRootForTests } from '../src/worker/lib/apple-jws';
import { forgetSite } from '../src/worker/env';
import { importStep } from '../src/worker/stripe-import';
import { runDailyAlerts, runWeeklyReport } from '../src/worker/digest';
import { mobileSummary } from '../src/worker/summary';
import { makeChain, signJws } from './helpers/apple-chain';
import { recordTick } from '../src/worker/setup-checklist';
import { refreshTrackingSince } from '../src/worker/sources';
import { dfs, dfsFetch } from './helpers/dataforseo';
import { startWorker, type TestWorker } from './helpers/worker';
import { isPro } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const BUNDLE = 'com.example.app';
const SECRET = 'whsec_cost_test_secret';
const RC_SECRET = 'rc_cost_test_secret_0123456789';
const measured: [string, number][] = [];

describe('free-plan cost: D1 rows written per write path', () => {
  let w: TestWorker;
  let site: any;
  const rows = async (label: string, fn: () => Promise<unknown>) => {
    w.takeRowsWritten();
    await fn();
    await w.flush();
    const n = w.takeRowsWritten();
    measured.push([label, n]);
    return n;
  };
  const web = (payload: Record<string, unknown>) =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.30' },
      body: JSON.stringify({ w: site.id, u: 'https://example.org/pricing', ...payload }),
    });
  const app = (vid: string, events: unknown[]) =>
    w.fetch('/api/app/events', {
      method: 'POST',
      body: JSON.stringify({ w: site.id, vid, ctx: { bundle_id: BUNDLE, app_version: '1.0', os_version: '26.0' }, events }),
    });
  const stripe = (type: string, object: Record<string, unknown>, later = 0) => {
    const body = JSON.stringify({ id: `evt_${Math.random()}`, type, created: Math.floor(Date.now() / 1000) + later, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    return w.fetch(`/api/webhooks/stripe/${site.id}`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}` },
      body,
    });
  };

  beforeAll(async () => {
    // The daily cap's counter writes 2 rows per 200 rows (measured on its own below), not inside the other numbers.
    resetBudgetForTests(Infinity);
    w = await startWorker();
    site = await w.createSite({ domain: 'example.org', app_bundle_id: BUNDLE, stripe_webhook_secret: SECRET, revenuecat_auth: RC_SECRET, currency: 'EUR' });
  });
  afterAll(async () => {
    setTrustedRootForTests(null);
    await w.dispose();
    console.log('\nD1 rows written per write path\n' + measured.map(([l, n]) => `  ${String(n).padStart(4)}  ${l}`).join('\n'));
  });

  it('web tracker', async () => {
    expect(await rows('web: first pageview of a new visitor (cookieless)', () => web({ t: 'pageview', r: 'https://www.google.com/' }))).toBe(11);
    // Build D (migration 0065): the ad click id, the browser language, the datacenter flag and the first touch are columns
    // on the session, event and visitor rows the visit writes anyway, so a Google Ads landing costs the same 11 rows.
    expect(
      await rows('web: first pageview of a new visitor from a Google Ads click (gclid, Accept-Language)', () =>
        w.fetch('/api/event', {
          method: 'POST',
          headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.31', 'accept-language': 'de-DE,de;q=0.9' },
          body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://example.org/pricing?gclid=Cj0KCQiA-cost_test', r: 'https://www.google.com/' }),
        }),
      ),
    ).toBe(11);
    expect(await rows('web: next pageview, same visit', () => web({ t: 'pageview', u: 'https://example.org/features', r: '' }))).toBe(5);
    // An ad click id on a later page of a direct visit: the session takes the click (1 row more). On the visitor's first
    // visit the first touch moves to the ad as well (1 more); a returning visitor's first touch stays.
    const tracked = (vid: string, sid: string, u: string) =>
      w.fetch('/api/event', { method: 'POST', headers: { 'user-agent': UA }, body: JSON.stringify({ w: site.id, t: 'pageview', vid, sid, u, r: '' }) });
    await tracked('costclickvid01', 'costclicksid01', 'https://example.org/');
    expect(await rows("web: next pageview carrying an ad click id (direct visit upgraded, the visitor's first visit)", () =>
      tracked('costclickvid01', 'costclicksid01', 'https://example.org/pricing?msclkid=0f1e2d3c4b5a6978'),
    )).toBe(7);
    await w.db.prepare("UPDATE visitors SET first_seen = first_seen - 86400000 WHERE site_id = ? AND id = 'costclickvid01'").bind(site.id).run();
    await tracked('costclickvid01', 'costclicksid02', 'https://example.org/');
    expect(await rows('web: next pageview carrying an ad click id (direct visit upgraded, returning visitor)', () =>
      tracked('costclickvid01', 'costclicksid02', 'https://example.org/pricing?gclid=Cj0KCQiA-cost_return'),
    )).toBe(6);
    // A Meta ad click (fbclid and ad_id) on a later page of a direct first visit costs the same.
    await tracked('costclickvid03', 'costclicksid03', 'https://example.org/');
    expect(await rows("web: next pageview carrying a Meta ad click (direct visit upgraded, the visitor's first visit)", () =>
      tracked('costclickvid03', 'costclicksid03', 'https://example.org/pricing?fbclid=IwAR0cost&ad_id=120200000000009'),
    )).toBe(7);
    expect(await rows('web: goal', () => web({ t: 'goal', n: 'signup_click' }))).toBe(5);
    expect(await rows('web: outbound click', () => web({ t: 'outbound', n: 'https://example.com/' }))).toBe(5);
    expect(await rows('web: engaged-time ping', () => web({ t: 'ping', d: 30_000 }))).toBe(1);
    // The ping sent when the page is hidden carries the load's Core Web Vitals: 1 row in vitals, no index (migration 0036).
    expect(await rows('web: engaged-time ping with Core Web Vitals (page hidden)', () => web({ t: 'ping', d: 30_000, v: { l: 1200, c: 0.01, t: 200, f: 600, p: '/pricing' } }))).toBe(2);
    // The visitor row, and its entry in visitors_email (migration 0064), which joins one person's daily ids for credit.
    expect(await rows('web: identify, first email', () => web({ t: 'identify', p: { email: 'a@example.com' } }))).toBe(2);
    expect(await rows('web: identify again with the same fields (every page of a signed-in user)', () => web({ t: 'identify', p: { email: 'a@example.com' } }))).toBe(0);
    // A change rewrites the row and both identity entries: 3.
    expect(await rows('web: identify adds a user id (row, visitors_user and visitors_email)', () => web({ t: 'identify', p: { email: 'a@example.com', user_id: 'u_cost_1' } }))).toBe(3);
    // Traits (migration 0072) are a column of the same row. A call that changes only traits sets that column alone, so the
    // identity indexes are not rewritten: 1. The same traits again: 0. With an identity change they ride on its update.
    expect(await rows('web: identify with new traits only', () => web({ t: 'identify', p: { email: 'a@example.com', user_id: 'u_cost_1', plan: 'pro' } }))).toBe(1);
    expect(await rows('web: identify with the same traits again', () => web({ t: 'identify', p: { email: 'a@example.com', user_id: 'u_cost_1', plan: 'pro' } }))).toBe(0);
    const fresh = await rows('web: identify, first email of a new visitor', () => web({ t: 'identify', vid: 'costtraitvid01', sid: 'costtraitsid01', p: { email: 't1@example.com' } }));
    expect(await rows('web: identify, first email of a new visitor, with traits', () => web({ t: 'identify', vid: 'costtraitvid02', sid: 'costtraitsid02', p: { email: 't2@example.com', plan: 'pro' } }))).toBe(fresh);
    // Page activity of a recorded visit (Record visits on): 1 events row on the ping it rides on, none when the page had none.
    // Like any event, the row writes 4: itself, its 2 index entries and the id counter.
    forgetSite(site.id);
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { record_visits: 1 } });
    forgetSite(site.id);
    const act = { p: '/pricing', s: Date.now(), c: [{ t: 900, l: 'Buy', k: 'button', n: 3, r: 1 }], e: [{ t: 1000, m: 'TypeError: x', s: 'app.js:1' }] };
    expect(await rows('web: ping with the page activity of a recorded visit', () => web({ t: 'ping', d: 30_000, a: act }))).toBe(5);
    expect(await rows('web: ping of a recorded visit, page without clicks or errors', () => web({ t: 'ping', d: 30_000, a: { p: '/pricing', c: [] } }))).toBe(1);
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { record_visits: 0 } });
    forgetSite(site.id);
  });

  it('app events (one request per batch)', async () => {
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    const screens = (n: number) => Array.from({ length: n }, (_, i) => ({ t: 'screen', sid, n: `Screen${i}` }));
    expect(await rows('app: new install, session_start only', () => app(vid, [{ t: 'session_start', sid }]))).toBe(7);
    expect(await rows('app: batch of 1 screen, same session', () => app(vid, screens(1)))).toBe(5);
    expect(await rows('app: batch of 10 screens, same session', () => app(vid, screens(10)))).toBe(32);
    expect(await rows('app: batch of 50 screens, same session', () => app(vid, screens(50)))).toBe(152);
    expect(await rows('app: batch of 1 ping', () => app(vid, [{ t: 'ping', sid, d: 30_000 }]))).toBe(1);
    const sid2 = crypto.randomUUID();
    const typical = [
      { t: 'session_start', sid: sid2, src: { utm_source: 'tiktok' } },
      ...screens(8).map((e) => ({ ...e, sid: sid2 })),
      { t: 'goal', sid: sid2, n: 'export_tapped' },
      { t: 'goal', sid: sid2, n: 'paywall_shown' },
      { t: 'ping', sid: sid2, d: 120_000 },
    ];
    expect(await rows('app: typical session in one batch, known install (start, 8 screens, 2 goals, ping)', () => app(vid, typical))).toBe(36);
  });

  it('app install from Apple Search Ads', async () => {
    // Apple's answer arrives after the batch is stored: the session becomes Paid / Apple Search Ads (1 row) and the
    // visitor's first touch follows (1 row).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ attribution: true, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432 })) as typeof fetch;
    try {
      const vid = crypto.randomUUID(), sid = crypto.randomUUID();
      expect(await rows('app: new install, session_start with an Apple Search Ads token (attributed)', () =>
        app(vid, [{ t: 'session_start', sid, src: { ads_token: 'aaa.bbb.ccc' } }]),
      )).toBe(9);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('app relaunches without consent (grouped by the daily key)', async () => {
    const device = { 'cf-connecting-ip': '198.51.100.40', 'user-agent': 'Shipkit/57 CFNetwork/3826 Darwin/25.0' };
    const launch = (vid: string, events: unknown[]) =>
      w.fetch('/api/app/events', {
        method: 'POST',
        headers: device,
        body: JSON.stringify({ w: site.id, vid, ctx: { bundle_id: BUNDLE, app_version: '1.0', os_version: '26.0', device: 'iPhone17,1' }, events }),
      });
    const first = crypto.randomUUID();
    const t0 = Date.now() - 2 * 3_600_000;
    await launch(first, [{ t: 'session_start', sid: crypto.randomUUID(), ts: t0 }]);
    expect(await rows('app: relaunch within 30 minutes, session_start only (continues the session)', () =>
      launch(crypto.randomUUID(), [{ t: 'session_start', sid: crypto.randomUUID(), ts: t0 + 60_000 }]),
    )).toBe(3);
    expect(await rows('app: relaunch after 30 minutes, session_start only (new session, same visitor)', () =>
      launch(crypto.randomUUID(), [{ t: 'session_start', sid: crypto.randomUUID(), ts: t0 + 3_600_000 }]),
    )).toBe(5);
  });

  it('app analytics (FounderDataKit API v2)', async () => {
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    const sp = { user_state: 'new', onboarding_variant: 'short', exp_paywall_copy: 'b' };
    expect(await rows('app: new install, session_start with 3 session properties', () => app(vid, [{ t: 'session_start', sid, sp }]))).toBe(7);
    expect(await rows('app: session_props alone (properties changed later)', () => app(vid, [{ t: 'session_props', sid, p: { ...sp, build_channel: 'testflight' } }]))).toBe(1);
    expect(await rows('app: session_props with 1 screen in one batch', () => app(vid, [{ t: 'session_props', sid, p: sp }, { t: 'screen', sid, n: 'Paywall' }]))).toBe(5);
    expect(await rows('app: onboarding step goal (onboardingStep), same session', () => app(vid, [{ t: 'goal', sid, n: 'onboarding_name', p: { step: 'name', index: '2' } }]))).toBe(5);
    const kept = crypto.randomUUID(), keptSid = crypto.randomUUID();
    const consent = (events: unknown[]) =>
      w.fetch('/api/app/events', {
        method: 'POST',
        body: JSON.stringify({ w: site.id, vid: kept, ctx: { bundle_id: BUNDLE, app_version: '1.0', os_version: '26.0', consent: true }, events }),
      });
    expect(await rows('app: consented install, first session_start', () => consent([{ t: 'session_start', sid: keptSid }]))).toBe(6);
    expect(await rows('app: consented install, batch of 1 screen', () => consent([{ t: 'screen', sid: keptSid, n: 'Home' }]))).toBe(5);
  });

  it('payments', async () => {
    // A payment credited to a visitor also writes its entry in payments_visitor (migration 0063): 1 row more than before.
    const chain = await makeChain();
    setTrustedRootForTests(chain.root.der);
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    await app(vid, [{ t: 'session_start', sid }]);
    const tx = { transactionId: '3000000001', originalTransactionId: '3000000001', bundleId: BUNDLE, price: 4990, currency: 'EUR', environment: 'Production', purchaseDate: Date.now(), signedDate: Date.now() };
    expect(await rows('App Store purchase from the app', async () => app(vid, [{ t: 'purchase', sid, jws: await signJws(tx, chain) }]))).toBe(6);
    expect(await rows('same purchase again: only the session\'s last-seen time', async () => app(vid, [{ t: 'purchase', sid, jws: await signJws(tx, chain) }]))).toBe(1);
    const trial = { ...tx, transactionId: '3000000002', originalTransactionId: '3000000002', price: 0, offerType: 1, offerDiscountType: 'FREE_TRIAL' };
    expect(await rows('App Store free trial from the app (trial_start signal, no payment)', async () => app(vid, [{ t: 'purchase', sid, jws: await signJws(trial, chain) }]))).toBe(3);
    expect(await rows('same free trial again: only the session\'s last-seen time', async () => app(vid, [{ t: 'purchase', sid, jws: await signJws(trial, chain) }]))).toBe(1);
    const pi = 'pi_cost_1';
    const cs = { mode: 'payment', payment_status: 'paid', amount_total: 2900, currency: 'eur', payment_intent: pi, metadata: { ml_visitor_id: vid } };
    expect(await rows('Stripe payment (checkout.session.completed)', () => stripe('checkout.session.completed', cs))).toBe(5);
    expect(await rows('Stripe duplicate (payment_intent.succeeded)', () => stripe('payment_intent.succeeded', { id: pi, amount_received: 2900, currency: 'eur' }))).toBe(0);
    expect(await rows('Stripe refund (charge.refunded)', () => stripe('charge.refunded', { id: 'ch_cost', payment_intent: pi, amount_refunded: 2900, currency: 'eur' }))).toBe(7);
    // A payment that gives its visitor an email: the visitor row and its entry in visitors_email (migration 0064), once.
    const vid2 = crypto.randomUUID();
    await app(vid2, [{ t: 'session_start', sid: crypto.randomUUID() }]);
    const withEmail = (id: string) => stripe('checkout.session.completed', { ...cs, payment_intent: id, metadata: { ml_visitor_id: vid2 }, customer_details: { email: 'buyer@example.com' } });
    expect(await rows('Stripe payment with an email new to the visitor', () => withEmail('pi_cost_email_1'))).toBe(7);
    expect(await rows('Stripe payment with an email the visitor already has', () => withEmail('pi_cost_email_2'))).toBe(5);
  });

  it('Dodo webhook', async () => {
    // A subscription payment also writes the subscription's row (src/worker/dodo.ts): 1 row more than a one-time payment.
    const raw = Buffer.from('dodo-cost-test-secret-0123456789');
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { dodo_webhook_secret: `whsec_${raw.toString('base64')}` } });
    forgetSite(site.id);
    const vid = crypto.randomUUID();
    await app(vid, [{ t: 'session_start', sid: crypto.randomUUID() }]);
    let n = 0;
    const dodo = (type: string, data: Record<string, unknown>) => {
      const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
      const id = `msg_cost_${++n}`;
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', raw).update(`${id}.${ts}.${body}`).digest('base64');
      return w.fetch(`/api/webhooks/dodo/${site.id}`, { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body });
    };
    const created = new Date().toISOString(); // a retry carries the same body
    const payment = (id: string, over: Record<string, unknown> = {}) => ({
      payment_id: id, total_amount: 1900, currency: 'EUR', created_at: created, metadata: { rt_visitor_id: vid },
      customer: { customer_id: 'cus_dodo_cost' }, product_cart: [{ product_id: 'pdt_cost', quantity: 1 }], ...over,
    });
    expect(await rows('Dodo one-time payment', () => dodo('payment.succeeded', payment('pay_cost_1')))).toBe(5);
    expect(await rows('Dodo subscription payment: the payment and the subscription row', () => dodo('payment.succeeded', payment('pay_cost_2', { subscription_id: 'sub_cost_dodo' })))).toBe(6);
    expect(await rows('Dodo payment, repeat delivery', () => dodo('payment.succeeded', payment('pay_cost_2', { subscription_id: 'sub_cost_dodo' })))).toBe(0);
    const subscription = {
      subscription_id: 'sub_cost_dodo', status: 'active', product_id: 'pdt_cost', recurring_pre_tax_amount: 1900, currency: 'EUR',
      payment_frequency_interval: 'Month', payment_frequency_count: 1, created_at: new Date().toISOString(),
      previous_billing_date: new Date().toISOString(), next_billing_date: new Date(Date.now() + 30 * 86_400_000).toISOString(), customer: { customer_id: 'cus_dodo_cost' },
    };
    expect(await rows('Dodo subscription.active / renewed / plan_changed', () => dodo('subscription.renewed', subscription))).toBe(1);
    // A paying subscription that is canceled also writes its alert inbox row (alert-events.ts, migration 0069): 1 more.
    expect(await rows('Dodo subscription.cancelled, expired or on_hold: signal, subscription row and inbox row', () => dodo('subscription.cancelled', { ...subscription, status: 'cancelled' }))).toBe(4);
  });

  it('subscription state (subscriptions table, 1 row per change)', async () => {
    const chain = await makeChain();
    setTrustedRootForTests(chain.root.der);
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    await app(vid, [{ t: 'session_start', sid }]);
    const now = Date.now();
    const sub = {
      id: 'sub_cost_1', customer: 'cus_cost_1', status: 'trialing', start_date: Math.floor(now / 1000), trial_start: Math.floor(now / 1000),
      trial_end: Math.floor(now / 1000) + 7 * 86_400, metadata: { rt_visitor_id: vid },
      items: { data: [{ quantity: 1, price: { currency: 'eur', unit_amount: 1900, recurring: { interval: 'month' } } }] },
    };
    expect(await rows('Stripe subscription (customer.subscription.created)', () => stripe('customer.subscription.created', sub))).toBe(2);
    expect(await rows('Stripe subscription repeat delivery', () => stripe('customer.subscription.created', sub))).toBe(0);
    const inv = { id: 'in_cost_1', subscription: 'sub_cost_1', customer: 'cus_cost_1', amount_paid: 1900, currency: 'eur', billing_reason: 'subscription_cycle', payment_intent: 'pi_cost_sub', metadata: { rt_visitor_id: vid } };
    // 7 for the payment and its invoice id in stripe_objects, as before, 1 for the subscription, and 1 for the payment's
    // entry in payments_visitor (migration 0063).
    expect(await rows('Stripe subscription payment (invoice.paid): payment, invoice link and subscription', () => stripe('invoice.paid', inv))).toBe(9);
    // A minute after the paid invoice, so the subscription is past due: its row, and the failed payment's alert inbox
    // row (alert-events.ts). In the same second as the payment it would not count as past due.
    expect(await rows('Stripe failed payment of a paying subscription (invoice.payment_failed), with its inbox row', () => stripe('invoice.payment_failed', { ...inv, id: 'in_cost_2' }, 60))).toBe(2);
    // The cancellation of a paying subscription adds its alert inbox row (alert-events.ts): 1 more.
    expect(await rows('Stripe cancel or end (customer.subscription.updated / deleted), with its inbox row', () => stripe('customer.subscription.deleted', { ...sub, status: 'canceled', ended_at: Math.floor(now / 1000) + 120 }, 120))).toBe(2);

    const base = { bundleId: BUNDLE, productId: 'pro_yearly', currency: 'EUR', environment: 'Production', type: 'Auto-Renewable Subscription', signedDate: now };
    const trial = { ...base, transactionId: '3100000001', originalTransactionId: '3100000001', purchaseDate: now, expiresDate: now + 7 * 86_400_000, price: 0, offerType: 1, offerDiscountType: 'FREE_TRIAL' };
    expect(await rows('App Store free trial of a subscription from the app (signal and subscription)', async () => app(vid, [{ t: 'purchase', sid, jws: await signJws(trial, chain) }]))).toBe(5);
    const paid = { ...base, transactionId: '3100000002', originalTransactionId: '3100000001', purchaseDate: now + 1000, expiresDate: now + 366 * 86_400_000, price: 49990 };
    expect(await rows('App Store subscription payment from the app (payment and subscription)', async () => app(vid, [{ t: 'purchase', sid, jws: await signJws(paid, chain) }]))).toBe(7);
    // Signed after the purchase above (purchaseDate now + 1000): an older event can't undo newer state.
    const notice = async (type: string, subtype: string) => {
      const payload = { notificationType: type, subtype, notificationUUID: crypto.randomUUID(), version: '2.0', signedDate: now + 2000, data: { bundleId: BUNDLE, environment: 'Production', signedTransactionInfo: await signJws(paid, chain) } };
      return w.fetch(`/api/webhooks/apple/${site.id}`, { method: 'POST', json: { signedPayload: await signJws(payload, chain) } });
    };
    expect(await rows('App Store auto-renew off, failed renewal or expiry (notification), with its inbox row', () => notice('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED'))).toBe(2);
  });

  it('daily write cap counter', async () => {
    resetBudgetForTests(200);
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    await app(vid, [{ t: 'session_start', sid }]);
    await w.flush();
    w.takeRowsWritten();
    const screens = Array.from({ length: 50 }, (_, i) => ({ t: 'screen', sid, n: `Screen${i}` }));
    // 152 rows per batch. Every second batch crosses 200 and adds the tally to site_usage: 2 rows more, the site's
    // row and the row `*` that the shared pool of the automatic cap counts in.
    expect(await rows('daily cap counter: batch under 200 rows, counted in memory only', () => app(vid, screens))).toBe(152);
    expect(await rows('daily cap counter: batch that crosses 200 rows, first add of the day (insert)', () => app(vid, screens))).toBe(154);
    expect(await rows('daily cap counter: next batch under 200 rows', () => app(vid, screens))).toBe(152);
    expect(await rows('daily cap counter: next batch that crosses 200 rows (update)', () => app(vid, screens))).toBe(154);
    resetBudgetForTests(Infinity);
  });

  it('RevenueCat webhook', async () => {
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    await app(vid, [{ t: 'session_start', sid }]);
    // A retry of an event carries the same times.
    const t = Date.now();
    const rc = (type: string, over: Record<string, unknown> = {}) =>
      w.fetch(`/api/webhooks/revenuecat/${site.id}`, {
        method: 'POST',
        headers: { authorization: RC_SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({
          event: {
            id: crypto.randomUUID(), type, store: 'APP_STORE', environment: 'PRODUCTION', period_type: 'NORMAL', product_id: 'pro_monthly',
            transaction_id: '5000000001', original_transaction_id: '5000000001', price_in_purchased_currency: 9.99, currency: 'EUR',
            purchased_at_ms: t, expiration_at_ms: t + 30 * 86_400_000, event_timestamp_ms: t,
            subscriber_attributes: { founderDataVisitorId: { value: vid } }, ...over,
          },
        }),
      });
    // Each event of a subscription also updates its row in subscriptions: 1 more row.
    expect(await rows('RevenueCat purchase (INITIAL_PURCHASE)', () => rc('INITIAL_PURCHASE'))).toBe(6);
    expect(await rows('RevenueCat repeat of a purchase already stored (SDK or retry)', () => rc('INITIAL_PURCHASE'))).toBe(0);
    expect(await rows('RevenueCat trial start (stored as a signal, not revenue)', () => rc('INITIAL_PURCHASE', { period_type: 'TRIAL', transaction_id: '5000000002', original_transaction_id: '5000000002', price_in_purchased_currency: 0 }))).toBe(4);
    expect(await rows('RevenueCat cancellation, expiration or billing issue (signal, subscription and inbox row)', () => rc('CANCELLATION', { cancel_reason: 'UNSUBSCRIBE' }))).toBe(4);
    expect(await rows('RevenueCat refund (CANCELLATION, CUSTOMER_SUPPORT)', () => rc('CANCELLATION', { cancel_reason: 'CUSTOMER_SUPPORT', price_in_purchased_currency: -9.99 }))).toBe(4);
  });

  it('Lemon Squeezy, Polar, Paddle, Gumroad, other revenue and the Stripe import', async () => {
    const LS = 'ls_cost_test_secret';
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { lemonsqueezy_secret: LS } });
    forgetSite(site.id);
    const vid = crypto.randomUUID(), sid = crypto.randomUUID();
    await app(vid, [{ t: 'session_start', sid }]);
    const ls = (event: string, data: Record<string, unknown>) => {
      const body = JSON.stringify({ meta: { event_name: event, custom_data: { rt_visitor_id: vid } }, data });
      return w.fetch(`/api/webhooks/lemonsqueezy/${site.id}`, { method: 'POST', headers: { 'x-signature': createHmac('sha256', LS).update(body).digest('hex') }, body });
    };
    const order = (over: Record<string, unknown> = {}) => ({ type: 'orders', id: '7001', attributes: { status: 'paid', total: 2900, currency: 'EUR', customer_id: 5, created_at: new Date().toISOString(), ...over } });
    // Polar, Paddle and Gumroad store a payment, a refund and a subscription event the same way.
    expect(await rows('Lemon Squeezy (Polar, Paddle, Gumroad) payment', () => ls('order_created', order()))).toBe(5);
    expect(await rows('Lemon Squeezy payment, repeat delivery', () => ls('order_created', order()))).toBe(0);
    expect(await rows('Lemon Squeezy (Polar, Paddle, Gumroad) refund', () => ls('order_refunded', order({ refunded: true, refunded_amount: 2900 })))).toBe(4);
    const sub = { type: 'subscriptions', id: '8001', attributes: { status: 'cancelled', cancelled: true, customer_id: 5, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } };
    expect(await rows('Lemon Squeezy (Polar, Paddle, Gumroad) cancellation: signal, subscription row and inbox row', () => ls('subscription_cancelled', sub))).toBe(4);

    const income = () =>
      w.fetch('/api/v1/payments', { method: 'POST', json: { transaction_id: 'ads-2026-10', amount: 120, currency: 'EUR', kind: 'income' }, headers: { authorization: `Bearer ${site.api_key}` } });
    expect(await rows('Other revenue (POST /api/v1/payments, kind income)', income)).toBe(4);

    // The Stripe import: 2 new charges in one step, 7 rows each (the payment, and its charge id in stripe_objects),
    // plus 1 for the progress row.
    const charge = (id: string) => ({ id, livemode: true, status: 'succeeded', paid: true, captured: true, amount: 1000, amount_refunded: 0, currency: 'eur', created: Math.floor(Date.now() / 1000) - 86_400, payment_intent: `pi_${id}`, metadata: {} });
    await w.env.DB.prepare("INSERT INTO stripe_imports (site_id, stripe_key, status, since, started_at, updated_at) VALUES (?, 'rk_live_cost_test_key', 'running', ?, ?, ?)")
      .bind(site.id, Date.now() - 30 * 86_400_000, Date.now(), Date.now())
      .run();
    const stripeApi = (async () => Response.json({ data: [charge('ch_imp_1'), charge('ch_imp_2')], has_more: false })) as unknown as typeof fetch;
    expect(await rows('Stripe import: a step with 2 new charges', () => importStep(w.env.DB, site, stripeApi))).toBe(15);
  });

  it('chart notes and their review', async () => {
    const note = (body: Record<string, unknown>) =>
      w.fetch('/api/v1/notes', { method: 'POST', json: body, headers: { cookie: '', authorization: `Bearer ${site.api_key}` } });
    expect(await rows('note from an agent, no idempotency key', () => note({ text: 'Deployed v2.3' }))).toBe(3);
    let id = '';
    expect(
      await rows('note from an agent, with an idempotency key', async () => {
        id = (await (await note({ text: 'Raised Pro to $24', target: '/pricing', idempotency_key: 'cost-1' })).json<any>()).id;
      }),
    ).toBe(4);
    const review = () =>
      w.fetch(`/api/v1/notes/${id}/review`, { method: 'POST', json: { outcome: 'kept' }, headers: { cookie: '', authorization: `Bearer ${site.api_key}` } });
    expect(await rows('note review', review)).toBe(1);
    expect(await rows('note review, sent again', review)).toBe(0);
  });

  it('scoped API keys and their usage', async () => {
    // A key is one row (src/worker/keys.ts). Usage is counted in memory and written at most once a minute per key and
    // isolate, as one UPDATE of the key's row, whatever the number of calls.
    let key = '';
    expect(
      await rows('API key: create', async () => {
        key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'cost', scopes: ['read', 'notes:write'], sites: [site.id] } })).body.key;
      }),
    ).toBe(1);
    const read = () => w.fetch('/api/v1/definitions', { headers: { cookie: '', authorization: `Bearer ${key}` } });
    expect(await rows('API key: first call in a minute (usage)', read)).toBe(1);
    expect(await rows('API key: 10 more calls in the same minute', async () => {
      for (let i = 0; i < 10; i++) await read();
    })).toBe(0);
    const note = () => w.fetch('/api/v1/notes', { method: 'POST', json: { text: 'Scoped' }, headers: { cookie: '', authorization: `Bearer ${key}` } });
    expect(await rows('note from an agent with a scoped key, usage already written this minute', note)).toBe(3);
    // Pushing an SEO part is FounderData Pro's (pro/worker/seo.ts).
    if (!isPro) return;
    // A key with seo:write pushes a part for the rows the login push costs: 2 for a new part (the row and its key), 1 to
    // replace it. A new key's first call in a minute adds its usage row; later calls that minute add nothing.
    let pusher = '';
    await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'seo-push', scopes: ['seo:write'], sites: [site.id] } }).then((r) => (pusher = r.body.key));
    const push = () =>
      w.fetch(`/api/sites/${site.id}/seo/meta`, { method: 'PUT', body: '{"name":"Cost"}', headers: { cookie: '', authorization: `Bearer ${pusher}`, 'content-type': 'application/json' } });
    expect(await rows('SEO part pushed with a seo:write key, new part and the key\'s first call in a minute', push)).toBe(3);
    expect(await rows('SEO part replaced with the key in the same minute', push)).toBe(1);
    expect(await rows('SEO part replaced with the admin login', () => w.admin(`/api/sites/${site.id}/seo/meta`, { method: 'PUT', json: { name: 'Cost' } }))).toBe(1);
  });

  it('primary goal', async () => {
    // The site row's two goal columns in one UPDATE (src/worker/primary-goal.ts). Counting it writes nothing.
    const put = (json: unknown) => w.admin(`/api/sites/${site.id}/goal`, { method: 'PUT', json });
    expect(await rows('primary goal: set', () => put({ name: 'signup', label: 'Signups' }))).toBe(1);
    expect(await rows('home with a primary goal', () => w.admin('/api/home'))).toBe(0);
    expect(await rows('primary goal: clear', () => put({ name: null }))).toBe(1);
  });

  it('tracking start: the nightly scan of first web and app visits', async () => {
    // The 03:17 cron keeps each site's first web and first app visit in one cron_state row. It writes the row when a
    // first is found, when the scan read SCAN_LIMIT sessions, or when its stored point is THROUGH_STEP_DAYS old: at
    // most 1 a site a night, about 1 a week for a site whose other platform never sends, and none once both are known
    // (or the web is, without an app). Reading tracking_since or sources (whoami, get_definitions, get_portfolio)
    // writes nothing.
    const T = Date.now();
    const D = 86_400_000;
    // Settle the sites the other cases made, so every count below is this case's own sites.
    await refreshTrackingSince(w.db, T);
    expect(await rows('tracking start: nightly scan, nothing new on any site', () => refreshTrackingSince(w.db, T))).toBe(0);
    const scan = await w.createSite({ domain: 'scan.example.org', app_bundle_id: 'com.example.scan' });
    const appOnly = await w.createSite({ domain: 'app-only.example.org', app_bundle_id: 'com.example.apponly' });
    const at = (site: any, id: string, ms: number, app = false) =>
      w.db
        .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, hostname, source, channel) VALUES (?, ?, ?, ?, ?, ?, 'x', 'Direct')`)
        .bind(site.id, id, `v-${id}`, ms, ms, app ? `ios:${site.app_bundle_id}` : site.domain)
        .run();
    await at(scan, 'scan-web', T - 3 * D);
    await at(appOnly, 'app-only-1', T - 3 * D, true);
    expect(await rows('tracking start: nightly scan, the first visit of 2 new sites', () => refreshTrackingSince(w.db, T))).toBe(2);
    expect(await rows('tracking start: nightly scan, no new visit', () => refreshTrackingSince(w.db, T + 1000))).toBe(0);
    await at(scan, 'scan-app', T - D, true);
    await at(appOnly, 'app-only-2', T - 2 * D, true);
    // The first app visit of scan is found: 1. The app-only site found nothing new and moved less than a week: 0.
    expect(await rows('tracking start: nightly scan, the first app visit found', () => refreshTrackingSince(w.db, T + 2000))).toBe(1);
    const done = await w.db.prepare("SELECT value FROM cron_state WHERE key = 'since:' || ?").bind(scan.id).first<{ value: string }>();
    expect(JSON.parse(done!.value)).toMatchObject({ web: T - 3 * D, app: T - D });
    // Scan is done. The app-only site never gets a web visit: its row moves once a week of sessions passed.
    await at(scan, 'scan-later', T - D / 2);
    await at(appOnly, 'app-only-3', T + 3 * D, true);
    expect(await rows('tracking start: nightly scan, an app-only site 6 days on', () => refreshTrackingSince(w.db, T + 3 * D))).toBe(0);
    await at(appOnly, 'app-only-4', T + 5 * D, true);
    expect(await rows('tracking start: nightly scan, an app-only site a week on', () => refreshTrackingSince(w.db, T + 5 * D))).toBe(1);
    expect(await rows('tracking start: nightly scan, an app-only site the night after', () => refreshTrackingSince(w.db, T + 5 * D + 1000))).toBe(0);
    expect(await rows('tracking start: reading get_portfolio with tracking_since and sources', () => w.admin('/api/v1/portfolio'))).toBe(0);
  });

  it('history import', async () => {
    // One row per stored day-row (no secondary index), plus 1 for the day's import counter (src/worker/imports.ts).
    const day = '2026-01-0';
    let id = '';
    expect(await rows('import: start', async () => (id = (await w.admin(`/api/sites/${site.id}/imports`, { method: 'POST', json: { source: 'plausible', from: `${day}1`, to: `${day}9`, files: [] } })).body.id))).toBe(3);
    const chunk = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'page', day: `${day}${i + 1}`, data: { '/': [1, 1] } }));
    expect(await rows('import: chunk of 5 day-rows', () => w.admin(`/api/sites/${site.id}/imports/${id}/rows`, { method: 'POST', json: { rows: chunk(5) } }))).toBe(6);
    expect(await rows('import: the same chunk again', () => w.admin(`/api/sites/${site.id}/imports/${id}/rows`, { method: 'POST', json: { rows: chunk(5) } }))).toBe(6);
    expect(await rows('import: finish', () => w.admin(`/api/sites/${site.id}/imports/${id}/finish`, { method: 'POST' }))).toBe(1);
    expect(await rows('import: delete with 5 day-rows', () => w.admin(`/api/sites/${site.id}/imports/${id}`, { method: 'DELETE' }))).toBe(6);
  });
});

// Round 7 (plan 5.1): each lane pins its write paths inside its own block, with its own worker and site.
describe('round 7: exp', () => {
  it.todo('experiment exposure: 0 rows on a new visit, 1 on a running one, once');
});

describe('round 7: survey', () => {
  it.todo('survey answer: 2 rows, 1 when the trait did not change; cancel reason from a webhook: 1 or 2');
});

describe('round 7: pages', () => {
  let w: TestWorker;
  let site: any;
  const ping = (extra: Record<string, unknown>) =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.31' },
      body: JSON.stringify({ w: site.id, t: 'ping', u: 'https://maps.example/pricing', d: 500, sw: 1440, ...extra }),
    });
  const rows = async (fn: () => Promise<unknown>) => {
    w.takeRowsWritten();
    await fn();
    await w.flush();
    return w.takeRowsWritten();
  };
  beforeAll(async () => {
    resetBudgetForTests(Infinity);
    w = await startWorker();
    site = await w.createSite({ domain: 'maps.example' });
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { maps_on: true } });
    forgetSite(site.id);
  });
  afterAll(() => w.dispose());

  it('click map: 1 row per page view at the default sample; scroll depth: 0 rows', async () => {
    const speed = await rows(() => ping({ v: { l: 1200, p: '/pricing' } }));
    // Scroll depth is a column of the page speed row: the same rows with it.
    expect(await rows(() => ping({ v: { l: 1200, p: '/pricing', s: 80 } }))).toBe(speed);
    // The click map is one row more, on the ping the tracker sends anyway.
    const map = { p: '/pricing', w: 1280, H: 3000, s: 80, c: Array.from({ length: 50 }, (_, i) => [i * 20, i * 50, 'a.nav', 'Pricing']) };
    expect(await rows(() => ping({ v: { l: 1200, p: '/pricing', s: 80 }, h: map }))).toBe(speed + 1);
    // A page view that is hidden twice with new clicks: its first send adds the row, the next one updates it, 1 each.
    const bare = await rows(() => ping({}));
    const again = { ...map, i: 99, a: 5000 };
    expect(await rows(() => ping({ h: again }))).toBe(bare + 1);
    expect(await rows(() => ping({ h: { ...again, a: 6000, c: [...map.c.slice(0, 49), [1, 1, 'button.buy', 'Buy']] } }))).toBe(bare + 1);
  });
});

describe('round 7: errors', () => {
  it.todo('errors: 1 row per distinct error of a page view, at most 5');
});
