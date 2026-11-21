// Alerts, the weekly report and chart notes (src/worker/alerts.ts, src/worker/notes.ts): channel CRUD, one send per
// channel for a payment, the write cap alert, the daily and weekly crons, and notes from the dashboard and the API.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requestsFor, splitText, type ChannelRow } from '../src/worker/alerts';
import { buildDigest, dailyItems, digestMessage, runDailyAlerts } from '../src/worker/digest';
import { resetBudgetForTests } from '../src/worker/budget';
import worker from '../src/worker/index';
import { bucketOf } from '../src/worker/notes';
import { startWorker, type TestWorker } from './helpers/worker';
import { describePro, proModule } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const SLACK = 'https://hooks.slack.com/services/T000/B000/secretpart1234';
const DISCORD = 'https://discord.com/api/webhooks/1/secretpart5678';
const HOOK = 'https://hooks.example.com/founderdata';
const TG_TOKEN = '123456789:AAEexampleexampleexampleexample12';
const DAY = 86_400_000;
/** A Monday, 07:00 UTC, when the alerts cron runs. */
const MONDAY = Date.parse('2026-11-02T07:00:00Z');

interface Sent {
  url: string;
  body: any;
  headers: Headers;
}
let sent: Sent[] = [];
let failNext = 0;
const prevFetch = globalThis.fetch;
const CHANNEL_HOSTS = /^https:\/\/(hooks\.slack\.com|discord\.com|api\.telegram\.org|hooks\.example\.com|api\.resend\.com)\//;

// Every channel API answers here; nothing leaves the machine.
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!CHANNEL_HOSTS.test(url)) return prevFetch(input, init);
    sent.push({ url, body: JSON.parse(String(init?.body ?? '{}')), headers: new Headers(init?.headers) });
    if (failNext > 0) {
      failNext--;
      return new Response('no_service', { status: 404 });
    }
    return url.includes('discord') ? new Response(null, { status: 204 }) : Response.json({ ok: true });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = prevFetch;
});
beforeEach(() => {
  sent = [];
  failNext = 0;
});

const to = (host: string) => sent.filter((s) => s.url.includes(host));

describe('alert channels', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());
  afterEach(async () => {
    for (const ch of (await w.admin('/api/alerts')).body.channels) await w.admin(`/api/alerts/channels/${ch.id}`, { method: 'DELETE' });
  });

  it('needs a login', async () => {
    expect((await w.fetch('/api/alerts', { headers: { cookie: '' } })).status).toBe(401);
    expect((await w.fetch('/api/alerts/channels', { method: 'POST', json: { kind: 'slack', target: SLACK }, headers: { cookie: '' } })).status).toBe(401);
  });

  it('adds, lists with the secret parts hidden, edits and removes a channel', async () => {
    const empty = await w.admin('/api/alerts');
    expect(empty.body).toMatchObject({ channels: [], email: false });

    const created = await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'slack', target: SLACK, name: 'Sales room' } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ kind: 'slack', name: 'Sales room', target: 'hooks.slack.com/••••1234', sites: null });
    expect(created.body.alerts).toMatchObject({ purchase: true, renewal: false, refund: true, trial: false, payment_failed: true, canceled: true, daily: true, payments_stopped: true, cap: true, weekly: true });

    const tg = await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'telegram', target: '-1001234567890', secret: TG_TOKEN } });
    expect(tg.body).toMatchObject({ kind: 'telegram', name: 'Telegram', target: '-1001234567890', secret: '••••••••' });

    const listed = (await w.admin('/api/alerts')).body.channels;
    expect(listed.map((c: any) => c.id)).toEqual([created.body.id, tg.body.id]);
    expect(JSON.stringify(listed)).not.toContain('secretpart');
    expect(JSON.stringify(listed)).not.toContain(TG_TOKEN);

    const patched = await w.admin(`/api/alerts/channels/${created.body.id}`, {
      method: 'PATCH',
      json: { alerts: { renewal: true, weekly: false, bogus: true }, sites: ['abc123'] },
    });
    expect(patched.body.alerts).toMatchObject({ purchase: true, renewal: true, weekly: false });
    expect(patched.body.alerts.bogus).toBeUndefined();
    expect(patched.body.sites).toEqual(['abc123']);
    const back = await w.admin(`/api/alerts/channels/${created.body.id}`, { method: 'PATCH', json: { sites: null } });
    expect(back.body.sites).toBeNull();

    expect((await w.admin(`/api/alerts/channels/${tg.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await w.admin('/api/alerts')).body.channels).toHaveLength(1);
    expect((await w.admin('/api/alerts/channels/nope', { method: 'PATCH', json: {} })).status).toBe(404);
  });

  it('rejects channels it cannot send to', async () => {
    const post = (json: unknown) => w.admin('/api/alerts/channels', { method: 'POST', json });
    expect((await post({ kind: 'pager' })).status).toBe(400);
    expect((await post({ kind: 'slack', target: 'http://hooks.slack.com/x' })).body.error).toMatch(/https/);
    expect((await post({ kind: 'webhook', target: 'not a url' })).status).toBe(400);
    expect((await post({ kind: 'telegram', target: '123', secret: 'short' })).body.error).toMatch(/bot token/);
    expect((await post({ kind: 'telegram', target: 'my chat', secret: TG_TOKEN })).body.error).toMatch(/chat id/);
    // Email stays off until the Worker has a Resend key and a sender.
    expect((await post({ kind: 'email', target: 'me@example.com' })).body.error).toMatch(/RESEND_API_KEY/);
  });

  it('sends a test message and reports what the channel answered', async () => {
    const ch = (await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'slack', target: SLACK, name: 'Ops' } })).body;
    const ok = await w.admin(`/api/alerts/channels/${ch.id}/test`, { method: 'POST' });
    expect(ok.body).toMatchObject({ ok: true, status: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(SLACK);
    expect(sent[0].body.text).toContain('Test from FounderData');

    failNext = 1;
    const bad = await w.admin(`/api/alerts/channels/${ch.id}/test`, { method: 'POST' });
    expect(bad.body).toEqual({ ok: false, status: 404, error: 'no_service' });
  });

  it('sends a payment once to each channel that wants it, and writes nothing more', async () => {
    const site = await w.createSite({ domain: 'alerts-shop.com', name: 'Alert Shop' });
    const other = await w.createSite({ domain: 'alerts-other.com' });
    const add = (json: Record<string, unknown>) => w.admin('/api/alerts/channels', { method: 'POST', json });
    await add({ kind: 'slack', target: SLACK });
    await add({ kind: 'discord', target: DISCORD });
    await add({ kind: 'telegram', target: '42424242', secret: TG_TOKEN, alerts: { purchase: false } });
    await add({ kind: 'webhook', target: HOOK, sites: [other.id] });

    const pay = (json: unknown) =>
      w.fetch('/api/v1/payments', { method: 'POST', json, headers: { authorization: `Bearer ${site.api_key}` } });
    expect((await pay({ transaction_id: 'alert_1', amount: 29, currency: 'USD' })).status).toBe(200);
    await w.flush();

    expect(to('slack')).toHaveLength(1);
    expect(to('discord')).toHaveLength(1);
    expect(to('telegram')).toHaveLength(0);
    expect(to('hooks.example.com')).toHaveLength(0);
    expect(to('slack')[0].body.text).toContain('New payment on Alert Shop: $29.00');
    expect(to('discord')[0].body.content).toContain('Provider: Payments API');
    expect(to('discord')[0].body.allowed_mentions).toEqual({ parse: [] });

    // The same payment again is a repeat delivery: no second alert.
    sent = [];
    await pay({ transaction_id: 'alert_1', amount: 29, currency: 'USD' });
    await w.flush();
    expect(sent).toHaveLength(0);

    // A refund goes to every channel with refunds on: all but the webhook (another site).
    await pay({ transaction_id: 'alert_1', amount: 29, currency: 'USD', refunded: true });
    await w.flush();
    expect(sent.map((s) => new URL(s.url).host).sort()).toEqual(['api.telegram.org', 'discord.com', 'hooks.slack.com']);
    expect(to('telegram')[0].url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    expect(to('telegram')[0].body).toMatchObject({ chat_id: '42424242' });
    expect(to('telegram')[0].body.text).toMatch(/^Refund on Alert Shop: \$29\.00/);

    // The webhook gets the payment as JSON for its own site.
    sent = [];
    await w.fetch('/api/v1/payments', {
      method: 'POST',
      json: { transaction_id: 'alert_2', amount: 12.5, currency: 'EUR' },
      headers: { authorization: `Bearer ${other.api_key}` },
    });
    await w.flush();
    expect(to('hooks.example.com')[0].body).toMatchObject({
      type: 'purchase',
      event: 'purchase',
      amount: 1250,
      currency: 'EUR',
      amount_text: '€12.50',
      site: { id: other.id },
      source: null,
    });
  });

  it('sends email through Resend when the Worker has a key and a sender', async () => {
    const mail = await startWorker({ RESEND_API_KEY: 're_test_key', ALERT_EMAIL_FROM: 'FounderData <alerts@example.com>' });
    try {
      expect((await mail.admin('/api/alerts')).body.email).toBe(true);
      const ch = (await mail.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'email', target: 'me@example.com' } })).body;
      expect(ch.target).toBe('me@example.com');
      expect((await mail.admin(`/api/alerts/channels/${ch.id}/test`, { method: 'POST' })).body.ok).toBe(true);
      expect(sent[0].url).toBe('https://api.resend.com/emails');
      expect(sent[0].headers.get('authorization')).toBe('Bearer re_test_key');
      expect(sent[0].body).toMatchObject({ from: 'FounderData <alerts@example.com>', to: ['me@example.com'], subject: 'Test from FounderData' });
      expect(sent[0].body.html).toContain('<h2');
    } finally {
      await mail.dispose();
    }
  });

  it('alerts once when a site reaches its own write cap', async () => {
    resetBudgetForTests(10);
    const site = await w.createSite({ domain: 'alerts-capped.com', name: 'Capped', write_cap: 30 });
    await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'slack', target: SLACK } });
    for (let i = 0; i < 6; i++) {
      await w.fetch('/api/event', {
        method: 'POST',
        headers: { 'user-agent': UA, 'cf-connecting-ip': `198.51.100.${i + 1}` },
        body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://${site.domain}/` }),
      });
      await w.flush();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toContain('Capped reached its daily write cap');
    expect(sent[0].body.text).toContain('30 rows');
    resetBudgetForTests();
  });
});

describe('message formats', () => {
  const ch = (kind: ChannelRow['kind'], target: string, secret: string | null = null): ChannelRow => ({
    id: 'c1',
    kind,
    name: kind,
    target,
    secret,
    alerts: '{}',
    sites: null,
    created_at: 0,
  });

  it('splits long texts at line breaks for Discord and Telegram', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `Line ${i} with some text in it`);
    const parts = requestsFor({}, ch('discord', DISCORD), { kind: 'weekly', title: 'Weekly report', lines });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(JSON.parse(String(p.init.body)).content.length).toBeLessThanOrEqual(1900);
    expect(parts.map((p) => JSON.parse(String(p.init.body)).content).join('\n')).toBe(`**Weekly report**\n${lines.join('\n')}`);
    expect(splitText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('escapes Slack control characters', () => {
    const [r] = requestsFor({}, ch('slack', SLACK), { kind: 'test', title: 'A & B', lines: ['<b>'] });
    expect(JSON.parse(String(r.init.body)).text).toBe('*A &amp; B*\n&lt;b&gt;');
  });
});

describe('weekly report, worth a look and version notes', () => {
  let w: TestWorker;
  let shop: any;
  let notes: any;
  let quiet: any;
  let idle: any;
  let n = 0;

  const session = (site: any, vid: string, at: number, source = 'Google', channel = 'Organic Search', version: string | null = null) => {
    const id = `s${++n}`;
    return w.db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel, hostname, app_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(site.id, id, vid, at, at, source, channel, version ? 'ios:com.example.app' : site.domain, version)
      .run()
      .then(() => id);
  };
  const pageview = (site: any, sid: string, vid: string, path: string, at: number) =>
    w.db
      .prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, path) VALUES (?, ?, ?, ?, 'pageview', ?)")
      .bind(site.id, sid, vid, at, path)
      .run();
  const pay = (site: any, id: string, amount: number, at: number, vid: string | null, sid: string | null) =>
    w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES (?, ?, 'stripe', ?, ?, 'payment', 'USD', ?, ?)")
      .bind(id, site.id, at, amount, vid, sid)
      .run();

  beforeAll(async () => {
    w = await startWorker();
    shop = await w.createSite({ domain: 'shipkit-alerts.com', name: 'ShipKit', currency: 'USD' });
    notes = await w.createSite({ domain: 'notes-alerts.com', name: 'Indie Notes', currency: 'EUR' });
    quiet = await w.createSite({ domain: 'quiet-alerts.com', name: 'Quiet Site' });
    idle = await w.createSite({ domain: 'idle-alerts.com', name: 'Idle' });
    const lastWeek = Date.parse('2026-10-26T10:00:00Z');
    const weekBefore = lastWeek - 7 * DAY;
    // ShipKit: 30 visitors last week (20 from Google, 10 from X), 20 the week before.
    for (let i = 1; i <= 30; i++) {
      const vid = `v${i}`;
      const sid = await session(shop, vid, lastWeek + i * 60_000, i <= 20 ? 'Google' : 'X', i <= 20 ? 'Organic Search' : 'Organic Social');
      await pageview(shop, sid, vid, '/', lastWeek + i * 60_000);
      if (i <= 10) await pageview(shop, sid, vid, '/pricing', lastWeek + i * 60_000);
      if (i <= 5) await pageview(shop, sid, vid, '/blog/launch', lastWeek + i * 60_000);
      if (i <= 2) await pageview(shop, sid, vid, '/about', lastWeek + i * 60_000);
      if (i === 1) await pay(shop, 'pi_dg_1', 5000, lastWeek + DAY, vid, sid);
      if (i === 21) await pay(shop, 'pi_dg_2', 3000, lastWeek + DAY, vid, sid);
    }
    await pay(shop, 'pi_dg_3', 1000, lastWeek + 2 * DAY, null, null);
    for (let i = 1; i <= 20; i++) await session(shop, `p${i}`, weekBefore + i * 60_000);
    await pay(shop, 'pi_dg_0', 4000, weekBefore + DAY, null, null);
    // Indie Notes: 3 visitors last week, none before.
    for (let i = 1; i <= 3; i++) await session(notes, `n${i}`, lastWeek + i * 60_000);
    // Quiet Site: its last visit 30 hours before the cron.
    await session(quiet, 'q1', MONDAY - 30 * 3_600_000);
  });
  afterAll(() => w.dispose());

  it('builds last week against the week before, per site and for all sites', async () => {
    const d = await buildDigest(w.db, MONDAY);
    expect(new Date(d.from).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(new Date(d.to).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    const s = d.sites.find((x) => x.id === shop.id)!;
    expect(s).toMatchObject({ visitors: 30, prevVisitors: 20, revenue: { USD: 9000 }, prevRevenue: { USD: 4000 }, customers: 3 });
    expect(s.topSources).toEqual([
      { label: 'Google', revenue: 5000 },
      { label: 'X', revenue: 3000 },
    ]);
    expect(s.topPages.map((p) => p.path)).toEqual(['/', '/pricing', '/blog/launch']);

    const m = digestMessage(d, null);
    expect(m.title).toBe('Weekly report: Oct 26 to Nov 1');
    expect(m.lines).toEqual([
      'Oct 26 to Nov 1 (UTC), compared with the week before.',
      'Revenue is payments net of refunds.',
      '',
      'All sites',
      'Revenue: $90.00, +125% (+$50.00), 3 new customers',
      'Web visitors: 34, +70% (+14)',
      '',
      'ShipKit',
      'Revenue: $90.00, +125% (+$50.00), 3 new customers',
      'Web visitors: 30, +50% (+10)',
      'Top sources by revenue: Google $50.00, X $30.00',
      'Top pages: /, /pricing, /blog/launch',
      '',
      'Indie Notes',
      'Revenue: none',
      'Web visitors: 3, +3',
      '',
      'Quiet Site',
      'Revenue: none',
      'Web visitors: 1, +1',
      '',
      '1 more site had no visits and no revenue in either week.',
    ]);
    expect(m.html).toContain('<table');
    expect(m.html).toContain('ShipKit');

    // A channel for one site gets that site only, without the all-sites line.
    const one = digestMessage(d, [notes.id]);
    expect(one.lines).toEqual(['Oct 26 to Nov 1 (UTC), compared with the week before.', '', 'Indie Notes', 'Revenue: none', 'Web visitors: 3, +3']);
  });

  it('finds a site on its first quiet day, then once a week', async () => {
    const items = await dailyItems(w.db, MONDAY);
    expect(items.map((a) => [a.siteId, a.kind])).toEqual([[quiet.id, 'quiet']]);
    expect(items[0].text).toBe('Quiet Site has had no visits for 30 hours. Check that the tracking script is still on the site.');
    // A day later Quiet Site is not reported again. ShipKit and Indie Notes, last seen on Oct 26, get their weekly reminder.
    const tuesday = await dailyItems(w.db, MONDAY + DAY);
    expect(tuesday.map((a) => a.siteId).sort()).toEqual([shop.id, notes.id].sort());
    expect(tuesday[0].text).toMatch(/has had no visits for 7 days/);
    expect((await dailyItems(w.db, MONDAY + 6 * DAY)).map((a) => a.siteId)).toEqual([quiet.id]);
  });

  it('compares yesterday with the same weekday a week before', async () => {
    const yesterday = MONDAY - 20 * 3_600_000;
    const site = await w.createSite({ domain: 'spike-alerts.com', name: 'Spike' });
    for (let i = 0; i < 50; i++) await session(site, `y${i}`, yesterday + i * 1000);
    for (let i = 0; i < 20; i++) await session(site, `w${i}`, yesterday - 7 * DAY + i * 1000);
    const items = await dailyItems(w.db, MONDAY);
    expect(items.find((a) => a.siteId === site.id)?.text).toBe('Spike: 50 visitors, up from 20.');
    await w.db.prepare('DELETE FROM sessions WHERE site_id = ?').bind(site.id).run();
    await w.db.prepare('DELETE FROM sites WHERE id = ?').bind(site.id).run();
  });

  it('adds a note for an app version on its first day, once', async () => {
    await session(notes, 'a1', MONDAY - 40 * DAY, 'Direct', 'Direct', '1.1');
    await session(notes, 'a1', MONDAY - 20 * 3_600_000, 'Direct', 'Direct', '1.1');
    // 1.2: 5 sessions from 3 installs, enough for a note (src/worker/notes.ts, VERSION_MIN_SESSIONS).
    for (let i = 0; i < 5; i++) await session(notes, `a${2 + (i % 3)}`, MONDAY - 18 * 3_600_000 + i * 60_000, 'Direct', 'Direct', '1.2');
    const first = await runDailyAlerts(w.env, MONDAY);
    expect(first.notes).toBe(1);
    const rows = (await w.db.prepare("SELECT text, kind, ts FROM notes WHERE site_id = ? AND kind = 'version'").bind(notes.id).all()).results;
    expect(rows).toEqual([{ text: 'App version 1.2', kind: 'version', ts: MONDAY - 18 * 3_600_000 }]);
    expect((await runDailyAlerts(w.env, MONDAY)).notes).toBe(0);
    // Back to before: these sessions would make Indie Notes quiet in the cron test.
    await w.db.prepare("DELETE FROM sessions WHERE site_id = ? AND app_version IS NOT NULL").bind(notes.id).run();
  });

  it('the 07:00 cron sends worth a look and, on Mondays, the weekly report', async () => {
    const slack = (await w.admin('/api/alerts/channels', { method: 'POST', json: { kind: 'slack', target: SLACK } })).body;
    const tg = (
      await w.admin('/api/alerts/channels', {
        method: 'POST',
        json: { kind: 'telegram', target: '777', secret: TG_TOKEN, alerts: { daily: false }, sites: [shop.id] },
      })
    ).body;
    const run = async (cron: string, at: number) => {
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({ cron, scheduledTime: at, noRetry() {} } as ScheduledController, w.env, { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
      await Promise.all(pending);
    };

    await run('0 7 * * *', MONDAY);
    expect(to('slack').map((s) => s.body.text.split('\n')[0])).toEqual(['*Worth a look*', '*Weekly report: Oct 26 to Nov 1*']);
    // Telegram has "worth a look" off and covers ShipKit only.
    expect(to('telegram')).toHaveLength(1);
    expect(to('telegram')[0].body.text).toContain('ShipKit\nRevenue: $90.00, +125% (+$50.00), 3 new customers\nWeb visitors: 30, +50% (+10)');
    expect(to('telegram')[0].body.text).not.toContain('Indie Notes');

    // Wednesday: no report. The quiet site is 3 days quiet and the others 8, so nothing is worth a look either.
    sent = [];
    await run('0 7 * * *', MONDAY + 2 * DAY);
    expect(sent).toEqual([]);

    // The other crons send nothing.
    await run('17 3 * * *', MONDAY);
    expect(sent).toEqual([]);

    // "Send last week's report" from the dashboard.
    const res = await w.admin(`/api/alerts/channels/${tg.id}/test`, { method: 'POST', json: { what: 'weekly' } });
    expect(res.body.ok).toBe(true);
    expect(to('telegram')[0].body.text).toMatch(/^Weekly report: /);
    await w.admin(`/api/alerts/channels/${slack.id}`, { method: 'DELETE' });
    await w.admin(`/api/alerts/channels/${tg.id}`, { method: 'DELETE' });
  });
});

describe('chart notes', () => {
  let w: TestWorker;
  let site: any;
  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'notes-chart.com', timezone: 'Europe/Berlin' });
  });
  afterAll(() => w.dispose());

  it('adds, lists in the range with the chart bucket, and deletes a note', async () => {
    const ts = Date.parse('2026-10-20T23:30:00Z');
    w.takeRowsWritten();
    const created = await w.admin(`/api/sites/${site.id}/notes`, { method: 'POST', json: { text: '  Launched   on X ', ts } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ text: 'Launched on X', ts, kind: 'manual' });
    // The row, its primary key and the (site_id, ts) index.
    expect(w.takeRowsWritten()).toBe(3);

    const q = 'period=custom&from=2026-10-01&to=2026-10-31';
    const list = await w.admin(`/api/sites/${site.id}/notes?${q}`);
    // 23:30 UTC is 01:30 the next day in Berlin: the note sits on the 21st.
    expect(list.body).toEqual([expect.objectContaining({ id: created.body.id, bucket: '2026-10-21' })]);
    expect((await w.admin(`/api/sites/${site.id}/notes?period=custom&from=2026-09-01&to=2026-09-30`)).body).toEqual([]);

    expect((await w.admin(`/api/sites/${site.id}/notes/${created.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await w.admin(`/api/sites/${site.id}/notes?${q}`)).body).toEqual([]);
  });

  it('checks the text and the time', async () => {
    const post = (json: unknown) => w.admin(`/api/sites/${site.id}/notes`, { method: 'POST', json });
    expect((await post({ text: ' ' })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(281) })).body.error).toMatch(/280/);
    expect((await post({ text: 'ok', ts: 'yesterday-ish' })).status).toBe(400);
    expect((await post({ text: 'ok', ts: Date.now() + 3 * DAY })).status).toBe(400);
    expect((await w.fetch(`/api/sites/${site.id}/notes?period=7d`, { headers: { cookie: '' } })).status).toBe(401);
  });

  it('takes notes from deploy scripts with the site API key', async () => {
    const api = (json: unknown, key = site.api_key) => w.fetch('/api/v1/notes', { method: 'POST', json, headers: { authorization: `Bearer ${key}` } });
    expect((await api({ text: 'Deployed' }, 'rt_wrong')).status).toBe(401);
    const res = await api({ text: 'Deployed v2.3', timestamp: '2026-10-22T09:30:00Z' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ ok: true, ts: Date.parse('2026-10-22T09:30:00Z') });
    const list = await w.admin(`/api/sites/${site.id}/notes?period=custom&from=2026-10-01&to=2026-10-31&granularity=week`);
    expect(list.body).toEqual([expect.objectContaining({ id: body.id, kind: 'api', text: 'Deployed v2.3', bucket: '2026-10-19' })]);
  });

  it('goes with its site', async () => {
    const gone = await w.createSite({ domain: 'notes-gone.com' });
    await w.admin(`/api/sites/${gone.id}/notes`, { method: 'POST', json: { text: 'Bye' } });
    await w.admin(`/api/sites/${gone.id}`, { method: 'DELETE' });
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE site_id = ?').bind(gone.id).first<{ n: number }>())!.n).toBe(0);
  });

  it('maps a time to the chart bucket of each granularity', () => {
    const t = Date.parse('2026-11-01T22:15:00Z'); // a Sunday
    expect(bucketOf(t, 'hour', 0)).toBe('2026-11-01T22:00');
    expect(bucketOf(t, 'day', 3_600_000)).toBe('2026-11-01');
    expect(bucketOf(t, 'day', 2 * 3_600_000)).toBe('2026-11-02');
    expect(bucketOf(t, 'week', 0)).toBe('2026-10-26');
    expect(bucketOf(t, 'month', 0)).toBe('2026-11');
  });
});

describePro('payment pushes', () => {
  it('skip phones signed in under an earlier password, without revoking them on the payment path', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
    const p8 = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    const w = await startWorker({ APNS_KEY_P8: p8, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456' });
    try {
      const { notifyPayment } = await proModule('worker/phone-push');
      const site = await w.createSite({ domain: 'push-stale.com', name: 'Stale', currency: 'EUR' });
      const login = (await (await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', deviceName: 'Now' }, headers: { cookie: '' } })).json()) as any;
      const fresh = 'a'.repeat(64);
      const stale = 'b'.repeat(64);
      await w.fetch('/api/mobile/push', {
        method: 'PUT',
        json: { token: fresh, environment: 'sandbox', topic: 'app.founderdata.test' },
        headers: { cookie: '', authorization: `Bearer ${login.token}` },
      });
      // A phone from before a password change: its token hash carries the old prefix.
      await w.db
        .prepare("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, apns_token, apns_env, apns_topic) VALUES ('old', 'Old', ?, 0, 0, ?, 'sandbox', 'app.founderdata.test')")
        .bind(`${'f'.repeat(16)}:${'0'.repeat(64)}`, stale)
        .run();
      const urls: string[] = [];
      const fake = (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      w.takeRowsWritten();
      const res = await notifyPayment(w.env, site, { event: 'purchase', id: 'p1', provider: 'api', sandbox: false, amount: 490, currency: 'EUR' }, fake);
      expect(res.alerts).toBe(1);
      expect(urls.filter((u) => u.includes('/3/device/'))).toEqual([`https://api.sandbox.push.apple.com/3/device/${fresh}`]);
      expect((await w.db.prepare("SELECT revoked_at FROM devices WHERE id = 'old'").first<any>()).revoked_at).toBeNull();
    } finally {
      await w.dispose();
    }
  });
});

describe('module load order', () => {
  it('keeps sandbox purchases out of revenue after the alert modules load', async () => {
    const { REAL } = await import('../src/worker/stats');
    expect(REAL).toBe("p.provider NOT IN ('app_store_sandbox', 'google_play_test')");
  });
});
