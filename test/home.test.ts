import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attention, fallingWeeks, home, siteTrend, TREND_RULES, weekWindow, type WeekPoint } from '../src/worker/home';
import { startWorker, type TestWorker } from './helpers/worker';

describe('home: every site with totals, sources, payments and alerts', () => {
  let w: TestWorker;
  let shop: any;
  let blog: any;
  let empty: any;
  let appOnly: any;
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
  const view = (site: any, vid: string, sid: string, r = '') =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': ua },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://${site.domain}/`, r, vid, sid }),
    });

  beforeAll(async () => {
    w = await startWorker();
    shop = await w.createSite({ domain: 'shop-home.com', currency: 'EUR' });
    blog = await w.createSite({ domain: 'blog-home.com', currency: 'USD' });
    empty = await w.createSite({ domain: 'empty-home.com' });
    appOnly = await w.createSite({ domain: 'apponly.invalid', app_bundle_id: 'com.example.apponly' });
    await view(shop, 'v1-home-id', 's1-home-id', 'https://www.google.com/');
    await view(shop, 'v2-home-id', 's2-home-id', 'https://www.google.com/');
    await view(shop, 'v3-home-id', 's3-home-id', 'https://x.com/');
    await view(blog, 'b1-home-id', 'bs1-home-id', 'https://www.google.com/');
    const pay = (id: string, site: any, amount: number, currency: string, vid: string | null, sid: string | null, provider = 'stripe') =>
      w.db
        .prepare('INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, site.id, provider, Date.now(), amount, amount < 0 ? 'refund' : 'payment', currency, vid, sid)
        .run();
    await pay('pi_home_1', shop, 4900, 'EUR', 'v1-home-id', 's1-home-id');
    await pay('apple_home_1', shop, 999, 'USD', null, null, 'app_store');
    await pay('pi_home_2', blog, 1500, 'USD', 'b1-home-id', 'bs1-home-id');
    await pay('sandbox_home', blog, 999, 'USD', 'b1-home-id', 'bs1-home-id', 'app_store_sandbox');
  });
  afterAll(() => w.dispose());

  it('needs a login', async () => {
    const res = await w.fetch('/api/home', { headers: { cookie: '' } });
    expect(res.status).toBe(401);
  });

  it('lists every site with its numbers, converted to each site currency', async () => {
    const { status, body } = await w.admin('/api/home?period=today&tz=Europe/Berlin');
    expect(status).toBe(200);
    expect(body.tz).toBe('Europe/Berlin');
    const byDomain = Object.fromEntries(body.sites.map((s: any) => [s.domain, s]));
    expect(byDomain['shop-home.com'].current.visitors).toBe(3);
    // 9.99 USD at 1.25 USD per EUR is 7.99 EUR.
    expect(byDomain['shop-home.com'].current.revenue).toEqual({ EUR: 4900 + 799 });
    expect(byDomain['shop-home.com'].topSource.label).toBe('Google');
    expect(byDomain['blog-home.com'].current.revenue).toEqual({ USD: 1500 });
    expect(byDomain['empty-home.com'].current.visitors).toBe(0);
    expect(body.totals.current.visitors).toBe(4);
    expect(body.totals.current.revenue).toEqual({ EUR: 5699, USD: 1500 });
    expect(body.totals.current.payments).toBe(3);
    // The chart adds up to the totals.
    expect(body.series.reduce((n: number, b: any) => n + b.visitors, 0)).toBe(4);
    expect(body.series.reduce((n: number, b: any) => n + (b.revenue.EUR ?? 0), 0)).toBe(5699);
  });

  it('credits money to the source of the visit across sites', async () => {
    const { body } = await w.admin('/api/home?period=today');
    const google = body.sources.find((s: any) => s.label === 'Google');
    expect(google.visitors).toBe(3);
    expect(google.sites).toBe(2);
    expect(google.revenue).toEqual({ EUR: 4900, USD: 1500 });
    expect(body.sources[0].label).toBe('Google');
  });

  it('lists the latest real payments with their source, without sandbox', async () => {
    const { body } = await w.admin('/api/home?period=today');
    expect(body.payments.map((p: any) => p.id).sort()).toEqual(['apple_home_1', 'pi_home_1', 'pi_home_2']);
    const apple = body.payments.find((p: any) => p.id === 'apple_home_1');
    expect(apple).toMatchObject({ amount: 999, currency: 'USD', converted: { amount: 799, currency: 'EUR', decimals: 2 } });
    expect(body.payments.find((p: any) => p.id === 'pi_home_1').converted).toBeNull();
    const p = body.payments.find((x: any) => x.id === 'pi_home_1');
    expect(p.source).toBe('Google');
    expect(p.siteName).toBe('Test');
    expect(body.payments.find((x: any) => x.id === 'apple_home_1').source).toBeNull();
  });

  it('opens one bar of the revenue chart: its total, by site and source, and its payments', async () => {
    const { body: h } = await w.admin('/api/home?period=7d&tz=Europe/Berlin');
    const bar = h.series.find((b: any) => Object.keys(b.revenue).length);
    expect((await w.fetch(`/api/home/bucket?period=7d&bucket=${bar.bucket}`, { headers: { cookie: '' } })).status).toBe(401);
    const { status, body } = await w.admin(`/api/home/bucket?period=7d&tz=Europe/Berlin&bucket=${bar.bucket}`);
    expect(status).toBe(200);
    // The same number as the bar.
    expect(body.revenue).toEqual(bar.revenue);
    expect(body.payments).toBe(3);
    const sites = Object.fromEntries(body.sites.map((s: any) => [s.id, s.revenue]));
    expect(sites).toEqual({ [shop.id]: { EUR: 5699 }, [blog.id]: { USD: 1500 } });
    const sources = Object.fromEntries(body.sources.map((s: any) => [s.label, s.revenue]));
    expect(sources).toEqual({ Google: { EUR: 4900, USD: 1500 }, 'App Store, no source': { EUR: 799 } });
    expect(body.list.map((p: any) => p.id).sort()).toEqual(['apple_home_1', 'pi_home_1', 'pi_home_2']);
    expect(body.list.find((p: any) => p.id === 'pi_home_1')).toMatchObject({ source: 'Google', reported: false });
    expect(body.more).toBe(false);
  });

  it('refuses a bucket that is not a bar of the period', async () => {
    const { status } = await w.admin('/api/home/bucket?period=7d&bucket=2001-01-01');
    expect(status).toBe(400);
    expect((await w.admin('/api/home/bucket?period=7d&bucket=nope')).status).toBe(400);
  });

  it('flags a site that never got a visit, and first customers', async () => {
    const { body } = await w.admin('/api/home?period=7d');
    expect(body.attention).toContainEqual(expect.objectContaining({ siteId: empty.id, kind: 'no_data' }));
    expect(body.attention).toContainEqual(expect.objectContaining({ siteId: appOnly.id, kind: 'apps_no_data' }));
    expect(body.attention.some((a: any) => a.siteId === appOnly.id && a.kind === 'no_data')).toBe(false);
    const kinds = Object.fromEntries(body.sites.map((x: any) => [x.domain, x.kind]));
    expect(kinds).toMatchObject({ 'shop-home.com': 'web', 'apponly.invalid': 'app' });
    expect(body.attention.filter((a: any) => a.siteId === shop.id).map((a: any) => a.kind)).toEqual(['first_sale']);
  });

  it('gives each site a verdict and its revenue change in the site currency', async () => {
    const { body } = await w.admin('/api/home?period=today');
    const trend = Object.fromEntries(body.sites.map((s: any) => [s.domain, s.trend]));
    // Revenue after none before: growing. Shop's change is in EUR, with the App Store sale converted.
    expect(trend['shop-home.com']).toEqual({ status: 'growing', revenueChange: 4900 + 799 });
    expect(trend['blog-home.com']).toEqual({ status: 'growing', revenueChange: 1500 });
    // Never a visit and no revenue: quiet, whether payments are connected or not.
    expect(trend['empty-home.com'].status).toBe('quiet');
    expect(trend['apponly.invalid'].status).toBe('quiet');
  });

  it('compares a quarter with the quarter before, not with the same number of days before', async () => {
    const q = await w.createSite({ domain: 'quarter-home.com' });
    const at = (id: string, iso: string) =>
      w.db
        .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, ?, ?, ?, ?, 'Direct/None', 'Direct')`)
        .bind(q.id, `qs-${id}`, `qv-${id}`, Date.parse(iso), Date.parse(iso))
        .run();
    await at('q3a', '2026-08-10T12:00:00Z');
    await at('q3b', '2026-09-30T23:00:00Z');
    await at('q2a', '2026-05-10T12:00:00Z');
    // 31 March is in Q1. Q3 has 92 days, so "the 92 days before" would wrongly include it.
    await at('q1', '2026-03-31T12:00:00Z');
    // 1 to 10 July is this quarter's stretch of Q3 when today is 10 October.
    await at('q4', '2026-10-05T12:00:00Z');
    const last = await home(w.db, { period: 'lastquarter', tz: 'UTC' }, Date.parse('2026-10-10T12:00:00Z'));
    expect(last.period).toBe('lastquarter');
    const row = last.sites.find((s) => s.id === q.id)!;
    expect([row.current.visitors, row.previous.visitors]).toEqual([2, 1]);
    const now = await home(w.db, { period: 'thisquarter', tz: 'UTC' }, Date.parse('2026-10-10T12:00:00Z'));
    const nowRow = now.sites.find((s) => s.id === q.id)!;
    // Q3 so far (1 to 10 July 12:00) had nobody; 10 August is outside it.
    expect([nowRow.current.visitors, nowRow.previous.visitors]).toEqual([1, 0]);
  });

  it('returns 8 full weeks per site in one query and flags a site that fell 3 weeks in a row', async () => {
    const f = await w.createSite({ domain: 'falling-home.com' });
    // Wednesday 4 November 2026: the full weeks are 7 September to 1 November.
    const now = Date.parse('2026-11-04T12:00:00Z');
    const perWeek = [0, 0, 0, 0, 80, 60, 45, 30];
    let n = 0;
    for (const [i, count] of perWeek.entries()) {
      for (let j = 0; j < count; j++) {
        const ts = Date.parse('2026-09-07T10:00:00Z') + i * 7 * 86_400_000 + (j % 5) * 86_400_000;
        await w.db
          .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, ?, ?, ?, ?, 'Direct/None', 'Direct')`)
          .bind(f.id, `fs-${n}`, `fv-${n}`, ts, ts)
          .run();
        n++;
      }
    }
    // A visit this week keeps the site out of "quiet", and stays out of the full weeks.
    await w.db
      .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, 'fs-now', 'fv-now', ?, ?, 'Direct/None', 'Direct')`)
      .bind(f.id, now - 3_600_000, now - 3_600_000)
      .run();
    const h = await home(w.db, { period: '7d', tz: 'UTC' }, now);
    const row = h.sites.find((s) => s.id === f.id)!;
    expect(row.weekly.map((x) => x.week)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(row.weekly.map((x) => x.visitors)).toEqual(perWeek);
    expect(row.falling).toEqual({ metric: 'visitors', weeks: 3, since: '2026-10-05', from: 80, to: 30 });
    expect(h.attention).toContainEqual({ siteId: f.id, kind: 'falling', revenue: false, text: 'Test: weekly visitors fell 3 weeks in a row, from 80 to 30.', link: 'dashboard' });
    expect(h.trendRules).toEqual(TREND_RULES);
  });

  it('falls back to UTC and 30 days on bad input', async () => {
    const { status, body } = await w.admin('/api/home?period=nonsense&tz=Not/AZone');
    expect(status).toBe(200);
    expect(body.tz).toBe('UTC');
    expect(body.period).toBe('30d');
  });
});

describe('home: attention rules', () => {
  const now = Date.UTC(2026, 9, 29, 12);
  const k = (visitors: number, customers = 0) => ({ visitors, sessions: visitors, bounceRate: 0, avgDuration: 0, customers, trials: 0, payments: customers, revenue: (customers ? { EUR: 100 } : {}) as Record<string, number>, appStoreRevenue: {} });
  const row = (over: Partial<Parameters<typeof attention>[0][0]>) => ({
    id: 'a',
    name: 'A',
    kind: 'web' as const,
    domain: 'a.com',
    createdAt: now - 90 * 86_400_000,
    lastSeen: now - 60_000,
    current: k(0),
    previous: k(0),
    ...over,
  });

  it('reports a site that went quiet for a day', () => {
    const out = attention([row({ lastSeen: now - 30 * 3_600_000 })], now);
    expect(out[0]).toMatchObject({ kind: 'quiet', text: expect.stringContaining('30 hours') });
  });

  it('reports traffic swings only on a real base', () => {
    expect(attention([row({ current: k(10), previous: k(4) })], now)).toEqual([]);
    expect(attention([row({ current: k(100), previous: k(40) })], now)[0].kind).toBe('traffic_up');
    expect(attention([row({ current: k(15), previous: k(80) })], now)[0].kind).toBe('traffic_down');
  });

  it('folds apps that never sent a session into one line and never asks them for a script', () => {
    const out = attention(
      [row({ id: 'p', name: 'PuzzleBox', kind: 'app', lastSeen: null }), row({ id: 'n', name: 'NoteNest', kind: 'app', lastSeen: null }), row({ id: 'f', name: 'FocusTimer', kind: 'app', lastSeen: null })],
      now,
    );
    expect(out).toEqual([
      expect.objectContaining({ kind: 'apps_no_data', link: 'apps', text: '3 apps have not sent an app session yet: PuzzleBox, NoteNest and FocusTimer. Each needs a released build with FounderDataKit.' }),
    ]);
    expect(attention([row({ kind: 'app', lastSeen: null })], now)[0]).toMatchObject({ kind: 'apps_no_data', link: 'settings' });
  });

  it('talks about app sessions, not visits, for a quiet app', () => {
    expect(attention([row({ kind: 'app', lastSeen: now - 50 * 3_600_000 })], now)[0].text).toBe('A has had no app sessions for 2 days. Check that the app still sends events.');
  });

  it('reports first customers after a period without any', () => {
    expect(attention([row({ current: k(50, 2), previous: k(50) })], now)[0]).toMatchObject({ kind: 'first_sale', text: 'A: 2 new customers, none in the period before.' });
  });
});

describe('home: trend rules', () => {
  const now = Date.UTC(2026, 9, 29, 12);
  const k = (visitors: number, revenue = 0) => ({ visitors, sessions: visitors, bounceRate: 0, avgDuration: 0, customers: 0, trials: 0, payments: 0, revenue: (revenue ? { USD: revenue } : {}) as Record<string, number>, appStoreRevenue: {} });
  const t = (over: Partial<Parameters<typeof siteTrend>[0]>) =>
    siteTrend({ currency: 'USD', kind: 'web', lastSeen: now - 60_000, current: k(100), previous: k(100), payments: true, ...over }, now);

  it('judges revenue with a 10% band', () => {
    expect(t({ current: k(100, 11_000), previous: k(100, 10_000) })).toEqual({ status: 'growing', revenueChange: 1000 });
    expect(t({ current: k(100, 10_500), previous: k(100, 10_000) }).status).toBe('flat');
    expect(t({ current: k(100, 9_000), previous: k(100, 10_000) })).toEqual({ status: 'declining', revenueChange: -1000 });
    expect(t({ current: k(100, 500), previous: k(100) }).status).toBe('growing');
    expect(t({ current: k(100), previous: k(100, 500) }).status).toBe('declining');
  });

  it('falls back to visitors without revenue: 30% from a base of 50', () => {
    expect(t({ current: k(150), previous: k(100) }).status).toBe('growing');
    expect(t({ current: k(50), previous: k(100) }).status).toBe('declining');
    expect(t({ current: k(80), previous: k(100) }).status).toBe('flat');
    expect(t({ current: k(9), previous: k(3) }).status).toBe('flat');
    expect(t({ current: k(10), previous: k(40) }).status).toBe('flat');
  });

  it('calls a site without payments declining when its visitors fell by a third', () => {
    expect(t({ payments: false, current: k(60), previous: k(100) }).status).toBe('declining');
    expect(t({ payments: false, current: k(90), previous: k(100) }).status).toBe('no_payments');
  });

  it('calls a site quiet after 24 hours without data and no revenue, and keeps judging one that still earns', () => {
    expect(t({ lastSeen: now - 30 * 3_600_000, current: k(0), previous: k(100) }).status).toBe('quiet');
    expect(t({ lastSeen: null, current: k(0), previous: k(0) }).status).toBe('quiet');
    expect(t({ kind: 'app', lastSeen: null, current: k(0, 4000), previous: k(0, 2000) }).status).toBe('growing');
  });

  it('says so when no payments are connected', () => {
    expect(t({ payments: false, current: k(150), previous: k(100) })).toEqual({ status: 'no_payments', revenueChange: 0 });
  });
});

describe('home: weekly trend', () => {
  const wk = (values: number[], key: 'visitors' | 'revenue' = 'visitors'): WeekPoint[] =>
    values.map((v, i) => ({ week: `2026-09-${String(7 + i).padStart(2, '0')}`, visitors: key === 'visitors' ? v : 100, revenue: key === 'revenue' ? v : 0 }));

  it('takes the 8 full weeks before this one, Monday to Sunday in the timezone', () => {
    const w = weekWindow(Date.parse('2026-11-04T12:00:00Z'), 'UTC');
    expect(w.labels[0]).toBe('2026-09-07');
    expect(w.labels[7]).toBe('2026-10-26');
    expect([w.from, w.to]).toEqual([Date.parse('2026-09-07T00:00:00Z'), Date.parse('2026-11-02T00:00:00Z')]);
    // Monday 00:30 in Berlin is still Sunday in UTC: the week just ended counts in Berlin.
    expect(weekWindow(Date.parse('2026-11-01T23:30:00Z'), 'Europe/Berlin').labels[7]).toBe('2026-10-26');
  });

  it('flags 3 falling weeks in a row on revenue first, visitors without revenue', () => {
    expect(fallingWeeks(wk([100, 100, 100, 100, 90, 80, 70, 60]))).toMatchObject({ metric: 'visitors', weeks: 4, from: 100, to: 60 });
    expect(fallingWeeks(wk([500, 400, 300, 350, 300, 250, 200, 150], 'revenue'))).toMatchObject({ metric: 'revenue', weeks: 4, from: 350, to: 150 });
    // Two weeks is not a run; a rise in between breaks it.
    expect(fallingWeeks(wk([100, 100, 100, 100, 100, 100, 80, 60]))).toBeNull();
    expect(fallingWeeks(wk([100, 90, 80, 85, 75, 65, 70, 60]))).toBeNull();
    // Small moves and small bases are not a trend.
    expect(fallingWeeks(wk([100, 100, 100, 100, 100, 99, 98, 97]))).toBeNull();
    expect(fallingWeeks(wk([0, 0, 0, 0, 15, 12, 9, 6]))).toBeNull();
  });

  it('adds a "Worth a look" line with the money, and none for a site gone quiet', () => {
    const now = Date.UTC(2026, 10, 4, 12);
    const k = { visitors: 100, sessions: 100, bounceRate: 0, avgDuration: 0, customers: 0, trials: 0, payments: 0, revenue: {}, appStoreRevenue: {} };
    const base = { id: 'a', name: 'A', kind: 'web' as const, domain: 'a.com', createdAt: 0, lastSeen: now - 60_000, current: k, previous: k, currency: 'USD' };
    const falling = { metric: 'revenue' as const, weeks: 3, since: '2026-10-05', from: 124_000, to: 61_000 };
    expect(attention([{ ...base, falling }], now)).toEqual([{ siteId: 'a', kind: 'falling', revenue: true, text: 'A: weekly revenue fell 3 weeks in a row, from $1,240 to $610.', link: 'dashboard' }]);
    expect(attention([{ ...base, falling, lastSeen: now - 50 * 3_600_000 }], now).map((a) => a.kind)).toEqual(['quiet']);
  });
});
