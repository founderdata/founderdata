// The two surveys, core part (round 7, lane survey; docs/API.md "Survey answers"): answers from the tracker, cancel
// reasons from Stripe and Polar webhooks, the heard_about breakdown, the surveys setting, erase, export and retention.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { resetKeysForTests } from '../src/worker/keys';
import { pruneOldData } from '../src/worker/retention';
import { normalizeAnswer, scrubText } from '../src/worker/surveys';
import { startWorker, type TestWorker } from './helpers/worker';
import { isPro } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const STRIPE_SECRET = 'whsec_survey_test_secret';
const POLAR_SECRET = 'polar_whs_survey_0123456789';

describe('surveys: text and answers', () => {
  it('removes emails, phone numbers and long digit runs, and keeps 200 characters', () => {
    expect(scrubText('mail me at ann@example.com or +1 (555) 123-4567, order 12345678')).toBe('mail me at [removed] or [removed], order [removed]');
    expect(scrubText('version 2 of 3 in 2026')).toBe('version 2 of 3 in 2026');
    expect(scrubText('x'.repeat(300))).toHaveLength(200);
    expect(scrubText('   ')).toBeNull();
    expect(scrubText(42)).toBeNull();
  });

  it('keeps known keys, turns an unknown answer into other with its words, and refuses an empty one', () => {
    expect(normalizeAnswer('heard_about', 'Podcast', 'ignored')).toEqual({ answer: 'podcast', text: null });
    expect(normalizeAnswer('heard_about', 'other', 'Hacker News')).toEqual({ answer: 'other', text: 'Hacker News' });
    expect(normalizeAnswer('heard_about', 'hacker_news', null)).toEqual({ answer: 'other', text: 'hacker_news' });
    expect(normalizeAnswer('cancel_reason', 'skipped', 'x')).toEqual({ answer: 'skipped', text: null });
    // A cancel reason keeps the customer's words with any key; heard_about keeps text for other only.
    expect(normalizeAnswer('cancel_reason', 'too_expensive', 'Too pricey at 99 a year')).toEqual({ answer: 'too_expensive', text: 'Too pricey at 99 a year' });
    expect(normalizeAnswer('cancel_reason', 'unused', null)).toEqual({ answer: 'unused', text: null });
    expect(normalizeAnswer('heard_about', '', null)).toBeNull();
    expect(normalizeAnswer('heard_about', 3, null)).toBeNull();
  });
});

describe('surveys: ingest, webhooks, breakdown', () => {
  let w: TestWorker;
  let site: any;
  const rows = async (fn: () => Promise<unknown>) => {
    w.takeRowsWritten();
    await fn();
    await w.flush();
    return w.takeRowsWritten();
  };
  const event = (body: Record<string, unknown>, referrer = '') =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.70' },
      body: JSON.stringify({ w: site.id, u: 'https://survey.example/welcome', sw: 1440, r: referrer, ...body }),
    });
  const visit = async (vid: string, referrer = '') => {
    await event({ t: 'pageview', vid, sid: `${vid}-s` }, referrer);
    await w.flush();
  };
  const answer = (vid: string, n: string, a: unknown, x?: unknown, v?: number) => event({ t: 'survey', vid, sid: `${vid}-s`, n, p: { a, x, v } });
  const traits = async (vid: string) => {
    const r = await w.db.prepare('SELECT traits FROM visitors WHERE site_id = ? AND id = ?').bind(site.id, vid).first<{ traits: string | null }>();
    return r?.traits ? JSON.parse(r.traits) : null;
  };
  const answers = (where = '1') => w.db.prepare(`SELECT * FROM survey_answers WHERE site_id = ? AND ${where} ORDER BY ts, id`).bind(site.id).all<any>().then((r) => r.results);
  const stripe = (type: string, object: Record<string, unknown>) => {
    const body = JSON.stringify({ id: `evt_${Math.random()}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
    const t = Math.floor(Date.now() / 1000);
    return w.fetch(`/api/webhooks/stripe/${site.id}`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', STRIPE_SECRET).update(`${t}.${body}`).digest('hex')}` },
      body,
    });
  };
  const polar = (type: string, data: Record<string, unknown>) => {
    const body = JSON.stringify({ type, data });
    const id = `msg_${Math.random().toString(36).slice(2)}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', Buffer.from(POLAR_SECRET, 'utf8')).update(`${id}.${ts}.${body}`).digest('base64');
    return w.fetch(`/api/webhooks/polar/${site.id}`, {
      method: 'POST',
      headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}`, 'content-type': 'application/json' },
      body,
    });
  };

  beforeAll(async () => {
    resetBudgetForTests(Infinity);
    resetKeysForTests();
    w = await startWorker({ VIEWER_PASSWORD: 'viewer-password' });
    site = await w.createSite({ domain: 'survey.example', stripe_webhook_secret: STRIPE_SECRET, polar_secret: POLAR_SECRET, stripe_unpinned: 1 });
  });
  afterAll(() => w.dispose());

  it('stores an answer and its trait: 2 rows; a repeat the same day writes nothing', async () => {
    await visit('svy-anna-0001');
    expect(await rows(() => answer('svy-anna-0001', 'heard_about', 'podcast'))).toBe(2);
    expect(await traits('svy-anna-0001')).toEqual({ heard_about: 'podcast' });
    const [row] = await answers("visitor_id = 'svy-anna-0001'");
    expect(row).toMatchObject({ survey: 'heard_about', answer: 'podcast', text: null, via: 'js', session_id: 'svy-anna-0001-s', subscription_id: null });
    // The id is the visitor and the UTC day, so 30 repeats are still one row.
    expect(row.id).toBe(`svy-anna-0001:${Math.floor(row.ts / 86_400_000)}`);
    for (let i = 0; i < 3; i++) expect(await rows(() => answer('svy-anna-0001', 'heard_about', 'podcast'))).toBe(0);
    expect(await answers("visitor_id = 'svy-anna-0001'")).toHaveLength(1);
  });

  it('replaces the day\'s answer when the visitor changes it, and keeps it when a later widget is dismissed', async () => {
    await visit('svy-fred-0001');
    await answer('svy-fred-0001', 'heard_about', 'google');
    await w.flush();
    // A different answer the same day: the row and the trait change, 1 row each.
    expect(await rows(() => answer('svy-fred-0001', 'heard_about', 'reddit'))).toBe(2);
    expect((await answers("visitor_id = 'svy-fred-0001'")).map((r: any) => r.answer)).toEqual(['reddit']);
    expect(await traits('svy-fred-0001')).toEqual({ heard_about: 'reddit' });
    await w.db.prepare("DELETE FROM survey_answers WHERE visitor_id = 'svy-fred-0001'").run();
    await w.db.prepare("UPDATE visitors SET traits = NULL WHERE id = 'svy-fred-0001'").run();
    expect(await rows(() => answer('svy-anna-0001', 'heard_about', 'skipped', undefined, 1))).toBe(0);
    expect(await traits('svy-anna-0001')).toEqual({ heard_about: 'podcast' });
    expect((await answers("visitor_id = 'svy-anna-0001'")).map((r: any) => r.answer)).toEqual(['podcast']);
    await visit('svy-skip-0001');
    expect(await rows(() => answer('svy-skip-0001', 'heard_about', 'skipped', undefined, 1))).toBe(2);
    expect(await traits('svy-skip-0001')).toEqual({ heard_about: 'skipped' });
    expect((await answers("visitor_id = 'svy-skip-0001'"))[0]).toMatchObject({ answer: 'skipped', via: 'widget' });
  });

  it('scrubs the text of other, and merges the trait into the ones identify() set', async () => {
    await visit('svy-ben-00001');
    await event({ t: 'identify', vid: 'svy-ben-00001', sid: 'svy-ben-00001-s', p: { user_id: 'u-ben', plan: 'pro' } });
    await w.flush();
    await answer('svy-ben-00001', 'heard_about', 'other', 'Call me on +49 151 2345 6789, found you on Hacker News');
    await w.flush();
    expect((await answers("visitor_id = 'svy-ben-00001'"))[0]).toMatchObject({ answer: 'other', text: 'Call me on [removed], found you on Hacker News' });
    expect(await traits('svy-ben-00001')).toEqual({ plan: 'pro', heard_about: 'other' });
  });

  it('keeps the text sent with a known cancel key', async () => {
    await visit('svy-jona-0001');
    await answer('svy-jona-0001', 'cancel_reason', 'too_expensive', 'Too pricey at 99 a year');
    await w.flush();
    expect((await answers("visitor_id = 'svy-jona-0001'"))[0]).toMatchObject({ survey: 'cancel_reason', answer: 'too_expensive', text: 'Too pricey at 99 a year', via: 'js' });
    await w.db.prepare("DELETE FROM survey_answers WHERE visitor_id = 'svy-jona-0001'").run();
  });

  it('refuses an unknown survey, a missing answer and a body without p, writing nothing', async () => {
    for (const body of [
      { n: 'nps', p: { a: 'google' } },
      { n: 'heard_about', p: { a: '' } },
      { n: 'heard_about', p: {} },
      { n: 'heard_about' },
    ]) {
      const n = await rows(async () => expect((await event({ t: 'survey', vid: 'svy-anna-0001', sid: 'svy-anna-0001-s', ...body })).status).toBe(202));
      expect(n).toBe(0);
    }
  });

  it('turns a cancellation reason from Stripe into a cancel answer once, with the trait of the subscription\'s visitor', async () => {
    await visit('svy-carl-0001');
    const canceled = Math.floor(Date.now() / 1000) - 60;
    const sub = {
      id: 'sub_survey_1',
      object: 'subscription',
      customer: 'cus_survey_1',
      status: 'active',
      start_date: canceled - 86400 * 40,
      cancel_at_period_end: true,
      canceled_at: canceled,
      current_period_end: canceled + 86400 * 20,
      currency: 'usd',
      metadata: { rt_visitor_id: 'svy-carl-0001', rt_site_id: site.id },
      items: { data: [{ price: { unit_amount: 2900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }] },
      cancellation_details: { feedback: 'too_expensive', comment: 'Too much for a side project. Mail carl@example.com', reason: 'cancellation_requested' },
    };
    const res = await stripe('customer.subscription.updated', sub);
    expect(res.status).toBe(200);
    await w.flush();
    const got = await answers("survey = 'cancel_reason'");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      id: `stripe:sub_survey_1:${canceled * 1000}`,
      ts: canceled * 1000,
      visitor_id: 'svy-carl-0001',
      subscription_id: 'sub_survey_1',
      answer: 'too_expensive',
      text: 'Too much for a side project. Mail [removed]',
      via: 'stripe',
    });
    expect(await traits('svy-carl-0001')).toEqual({ cancel_reason: 'too_expensive' });
    // The subscription ends: .deleted carries the same reason and time, so nothing more is written.
    const n = await rows(() => stripe('customer.subscription.deleted', { ...sub, status: 'canceled', ended_at: canceled + 86400 * 20 }));
    expect(n).toBeGreaterThan(0);
    expect(await answers("survey = 'cancel_reason'")).toHaveLength(1);
    // No reason and no comment: no answer.
    await stripe('customer.subscription.updated', { ...sub, id: 'sub_survey_2', metadata: { rt_site_id: site.id }, cancellation_details: { feedback: null, comment: null, reason: 'cancellation_requested' } });
    await w.flush();
    expect(await answers("subscription_id = 'sub_survey_2'")).toHaveLength(0);
  });

  it('maps Polar\'s customer cancellation reason, keeps a reason it does not know as other, and ignores a retry', async () => {
    const at = new Date(Date.now() - 30_000).toISOString();
    const sub = (id: string, reason: string | null, comment: string | null) => ({
      id,
      status: 'active',
      cancel_at_period_end: true,
      canceled_at: at,
      created_at: at,
      modified_at: at,
      amount: 1900,
      currency: 'usd',
      recurring_interval: 'month',
      customer_id: 'cus_p_survey',
      customer: { id: 'cus_p_survey', metadata: {} },
      product: { name: 'Plan' },
      metadata: {},
      customer_cancellation_reason: reason,
      customer_cancellation_comment: comment,
    });
    expect((await polar('subscription.canceled', sub('polar_sub_1', 'missing_features', 'No CSV import'))).status).toBe(200);
    expect((await polar('subscription.canceled', sub('polar_sub_1', 'missing_features', 'No CSV import'))).status).toBe(200);
    expect((await polar('subscription.canceled', sub('polar_sub_2', 'went_bankrupt', null))).status).toBe(200);
    await w.flush();
    const got = await answers("via = 'polar'");
    expect(got.map((r: any) => [r.subscription_id, r.answer, r.text])).toEqual(
      expect.arrayContaining([
        ['polar_sub_1', 'missing_features', 'No CSV import'],
        ['polar_sub_2', 'other', 'went_bankrupt'],
      ]),
    );
    expect(got).toHaveLength(2);
  });

  it('answers the heard_about breakdown by visitor, with revenue, tracked channels and the Overview filters', async () => {
    // A visitor from Google who says Google, and one more podcast listener who paid.
    await visit('svy-dora-0001', 'https://www.google.com/');
    await answer('svy-dora-0001', 'heard_about', 'google');
    await visit('svy-emil-0001');
    await answer('svy-emil-0001', 'heard_about', 'podcast');
    await w.flush();
    await w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, renewal) VALUES ('pay_svy_1', ?, 'stripe', ?, 4900, 'payment', ?, 'svy-emil-0001', 0)")
      .bind(site.id, Date.now() - 1000, site.currency)
      .run();
    const all = (await w.admin(`/api/sites/${site.id}/breakdown?dim=heard_about&period=today`)).body as any[];
    const podcast = all.find((r) => r.label === 'podcast');
    expect(podcast).toMatchObject({ visitors: 2, revenue: 4900, customers: 1, tracked: [{ channel: 'Direct', visitors: 2 }] });
    const google = all.find((r) => r.label === 'google');
    expect(google.visitors).toBe(1);
    expect(google.tracked[0].channel).not.toBe('Direct');
    // Skipped answers are no row; other is.
    expect(all.map((r) => r.label).sort()).toEqual(['google', 'other', 'podcast']);
    // The Direct filter (a click on the Channel card's Direct row) keeps the direct visitors only.
    const direct = (await w.admin(`/api/sites/${site.id}/breakdown?dim=heard_about&period=today&filters=${encodeURIComponent(JSON.stringify({ channel: 'Direct' }))}`)).body as any[];
    expect(direct.map((r) => r.label).sort()).toEqual(['other', 'podcast']);
    // A period before any answer: nothing.
    expect((await w.admin(`/api/sites/${site.id}/breakdown?dim=heard_about&period=custom&from=2020-01-01&to=2020-01-31`)).body).toEqual([]);
  });

  it('counts answers given in the period, words rows as the site does, and adds the rest of the channels as Other', async () => {
    // Gus answered three days ago and visits today: today's tab does not count him, as the Surveys card does not.
    await visit('svy-gus-00001');
    await w.db
      .prepare("INSERT INTO survey_answers (site_id, survey, ts, id, visitor_id, answer, via) VALUES (?, 'heard_about', ?, 'svy-gus-old', 'svy-gus-00001', 'youtube', 'js')")
      .bind(site.id, Date.now() - 3 * 86_400_000)
      .run();
    // Five people say X, arriving by five channels: the top 3 by name, the other 2 as Other.
    const from = ['', 'https://www.google.com/', 'https://t.co/abc', 'https://chatgpt.com/', 'https://news.example/?utm_medium=email'];
    for (const [i, r] of from.entries()) {
      await visit(`svy-x-${i}-00001`, r);
      await answer(`svy-x-${i}-00001`, 'heard_about', 'x');
    }
    await w.flush();
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { surveys: { heard_about: { on: 1, l: { podcast: 'Ein Podcast' } } } } });
    const all = (await w.admin(`/api/sites/${site.id}/breakdown?dim=heard_about&period=today`)).body as any[];
    expect(all.find((r) => r.label === 'youtube')).toBeUndefined();
    expect(all.find((r) => r.label === 'podcast')).toMatchObject({ answer: 'podcast', name: 'Ein Podcast' });
    expect(all.find((r) => r.label === 'google')).toMatchObject({ name: 'Google or another search engine' });
    const x = all.find((r) => r.label === 'x');
    expect(x.visitors).toBe(5);
    expect(x.tracked).toHaveLength(4);
    expect(x.tracked[3]).toEqual({ channel: 'Other', visitors: 2 });
    expect(x.tracked.reduce((n: number, t: any) => n + t.visitors, 0)).toBe(5);
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { surveys: null } });
  });

  it('serves the dimension to a read key, not to a share link', async () => {
    const key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'agent', scopes: ['read'], sites: [site.id] } })).body.key;
    const res = await w.fetch('/api/v1/stats/breakdown?dim=heard_about&period=today', { headers: { authorization: `Bearer ${key}`, cookie: '' } });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const rowsOf = Array.isArray(body) ? body : body.rows;
    const podcast = rowsOf.find((r: any) => r.value === 'podcast');
    expect(podcast).toMatchObject({ label: 'A podcast', visitors: 2, tracked: [{ channel: 'Direct', visitors: 2 }] });
    // A read key without read:revenue gets no money.
    expect(podcast.revenue).toBeUndefined();
    // How many answered against the period's visitors; the rows add up to answered.
    expect(body.answered).toBe(rowsOf.reduce((n: number, r: any) => n + r.visitors, 0));
    expect(body.visitors).toBeGreaterThan(body.answered);
    expect(body.answer_share).toBe(Math.round((body.answered / body.visitors) * 1000) / 1000);
    expect(body.next_step).toBeUndefined();
    // An empty answer says whether the survey is on and what to do next.
    const empty = await (await w.fetch('/api/v1/stats/breakdown?dim=heard_about&period=custom&from=2020-01-01&to=2020-01-31', { headers: { authorization: `Bearer ${key}`, cookie: '' } })).json<any>();
    expect(empty).toMatchObject({ rows: [], answered: 0, survey: { on: false, pages: [] } });
    expect(empty.next_step).toMatch(isPro ? /Settings > Surveys: http.*\/settings#surveys$/ : /founderdata\('answer', 'heard_about', key\)/);
    const link = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link', label: 'Public' } })).body;
    expect((await w.fetch(`/api/share/${link.token}/breakdown?dim=heard_about&period=today`, { headers: { cookie: '' } })).status).toBe(400);
  });

  it('exports answers, with the free text left out for an API key and a viewer', async () => {
    const csv = await (await w.fetch(`/api/sites/${site.id}/export/survey_answers.csv?period=today`)).text();
    const [head, ...lines] = csv.trim().split(/\r?\n/);
    expect(head).toBe('answered_at,survey,answer,text,via,visitor_id,session_id,subscription_id');
    expect(lines.some((l) => l.includes('Hacker News'))).toBe(true);
    const key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'export', scopes: ['read', 'read:rows'], sites: [site.id] } })).body.key;
    const viaKey = await w.fetch(`/api/v1/export/survey_answers?period=today`, { headers: { authorization: `Bearer ${key}`, cookie: '' } });
    expect(viaKey.status).toBe(200);
    const keyCsv = await viaKey.text();
    expect(keyCsv).toContain('podcast');
    expect(keyCsv).not.toContain('Hacker News');
    // A read key without read:rows gets no rows.
    const plain = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'plain', scopes: ['read'], sites: [site.id] } })).body.key;
    expect((await w.fetch(`/api/v1/export/survey_answers?period=today`, { headers: { authorization: `Bearer ${plain}`, cookie: '' } })).status).toBe(403);
    const login = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'viewer-password' }, headers: { cookie: '' } });
    const viewer = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const asViewer = await w.fetch(`/api/sites/${site.id}/export/survey_answers.csv?period=today`, { headers: { cookie: viewer } });
    // The viewer login may not export at all; where it may, it gets no free text.
    if (asViewer.status === 200) expect(await asViewer.text()).not.toContain('Hacker News');
    else expect(asViewer.status).toBe(403);
  });

  it('erases a person\'s answers with them', async () => {
    const before = await answers("visitor_id = 'svy-ben-00001'");
    expect(before).toHaveLength(1);
    const r = await w.admin(`/api/sites/${site.id}/visitors/svy-ben-00001`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await answers("visitor_id = 'svy-ben-00001'")).toHaveLength(0);
    expect((await answers("visitor_id = 'svy-anna-0001'")).length).toBeGreaterThan(0);
  });

  it('erases a cancel reason whose subscription has no visitor when the person is erased by email', async () => {
    // Jane subscribed through a payment link (never a tracked visit) and canceled in Stripe's portal with a comment.
    const canceled = Math.floor(Date.now() / 1000) - 30;
    const sub = {
      id: 'sub_survey_jane', object: 'subscription', customer: 'cus_survey_jane', status: 'active', start_date: canceled - 86400 * 40,
      cancel_at_period_end: true, canceled_at: canceled, current_period_end: canceled + 86400 * 20, currency: 'usd', metadata: { rt_site_id: site.id },
      items: { data: [{ price: { unit_amount: 2900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }] },
      cancellation_details: { feedback: 'too_expensive', comment: 'Jane from Acme here, too pricey for our team', reason: 'cancellation_requested' },
    };
    expect((await stripe('customer.subscription.updated', sub)).status).toBe(200);
    await w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, email, customer_id) VALUES ('pay_survey_jane', ?, 'stripe', ?, 2900, 'payment', 'USD', 'jane@acme.example', 'cus_survey_jane')")
      .bind(site.id, (canceled - 86400 * 40) * 1000)
      .run();
    await w.flush();
    expect(await answers("subscription_id = 'sub_survey_jane'")).toEqual([expect.objectContaining({ visitor_id: null, text: 'Jane from Acme here, too pricey for our team' })]);
    const r = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: 'jane@acme.example' } });
    expect(r.status).toBe(200);
    expect(await answers("subscription_id = 'sub_survey_jane'")).toHaveLength(0);
    // Other customers' reasons stay.
    expect(await answers("subscription_id = 'sub_survey_1'")).toHaveLength(1);
  });

  it('drops answers older than the visits the site keeps', async () => {
    await w.db
      .prepare("INSERT INTO survey_answers (site_id, survey, ts, id, visitor_id, answer, via) VALUES (?, 'heard_about', 1000, 'old', 'svy-old', 'google', 'js')")
      .bind(site.id)
      .run();
    await pruneOldData(w.db);
    expect(await answers("id = 'old'")).toHaveLength(0);
    expect((await answers("visitor_id = 'svy-anna-0001'")).length).toBeGreaterThan(0);
  });

  it('saves the surveys setting, checks it, and turns both off with null', async () => {
    const patch = (surveys: unknown) => w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { surveys } });
    const ok = await patch({ heard_about: { on: 1, paths: '/welcome\n/thanks/', q: '  Where did you find us? ', l: { podcast: 'Ein Podcast', google: '' } } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.surveys)).toEqual({ heard_about: { on: 1, paths: ['/welcome', '/thanks'], q: 'Where did you find us?', l: { podcast: 'Ein Podcast' } } });
    // A second PATCH changes one survey and keeps the other.
    const both = await patch({ cancel_reason: { on: true } });
    expect(Object.keys(JSON.parse(both.body.surveys)).sort()).toEqual(['cancel_reason', 'heard_about']);
    for (const [bad, msg] of [
      [{ nps: { on: 1 } }, /no survey "nps"/],
      [{ heard_about: { on: 1, paths: 'welcome' } }, /start with \//],
      [{ heard_about: { on: 1, q: 'x'.repeat(121) } }, /120 characters/],
      [{ heard_about: { on: 1, l: { tiktok: 'TikTok' } } }, /no answer "tiktok"/],
      [{ heard_about: { on: 1, l: { podcast: 'x'.repeat(41) } } }, /40 characters/],
      ['on', /object/],
    ] as const) {
      const r = await patch(bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    const off = await patch({ cancel_reason: null });
    expect(Object.keys(JSON.parse(off.body.surveys))).toEqual(['heard_about']);
    expect((await patch(null)).body.surveys).toBeNull();
  });

  it('empties the table when the site is deleted', async () => {
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await answers()).toHaveLength(0);
  });
});
