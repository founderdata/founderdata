// Click maps and scroll depth, core part (src/worker/page-maps.ts, src/worker/vitals.ts, the tracker's click map
// region): what the ping's map payload may hold, the never-record list, the sample, retention, the scroll read, and
// what the tracker sends.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { forgetSite } from '../src/worker/env';
import { cleanLabel, mapConfig, mapStatement, parseMapPayload, skipPattern, MAP_READ_CAP, MAX_MAP_CLICKS } from '../src/worker/page-maps';
import { mapScrollByPath, mapScrollSql, parseVitals, pickScroll, scrollSummary, withPageScroll, SCROLL_SPEED_MIN } from '../src/worker/vitals';
import { pruneOldData } from '../src/worker/retention';
import { isSkipped } from '../src/worker/recording';
import { startWorker, type TestWorker } from './helpers/worker';
import { isPro } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const DAY = 86_400_000;

describe('click map payload', () => {
  it('keeps what it may and clips the rest', () => {
    const many = Array.from({ length: 70 }, (_, i) => [i * 10, i * 100, 'a.nav', `Link ${i}`]);
    const m = parseMapPayload({ p: '/pricing/?q=1', w: 1000.4, H: 4200, s: 73.6, c: many, i: 77, a: 1500 }, '/x')!;
    expect(m.path).toBe('/pricing');
    expect([m.width, m.height, m.scroll, m.id, m.age]).toEqual([1000, 4200, 74, 77, 1500]);
    expect(m.clicks).toHaveLength(MAX_MAP_CLICKS);
    expect(m.clicks[3]).toEqual([30, 300, 'a.nav', 'Link 3']);
  });

  it('turns x in px into thousandths of the viewport width, and keeps no click without a width', () => {
    expect(parseMapPayload({ p: '/', w: 1280, s: 10, c: [[640, 10.4, 'a', 'x'], [1279.6, 0, 'a', 'y']] }, '/')!.clicks).toEqual([
      [500, 10, 'a', 'x'],
      [1000, 0, 'a', 'y'],
    ]);
    expect(parseMapPayload({ p: '/', s: 10, c: [[640, 10, 'a', 'x']] }, '/')!.clicks).toEqual([]);
    expect(parseMapPayload({ p: '/', c: [[640, 10, 'a', 'x']] }, '/')).toBeNull();
    // An id outside 0 to 2^31 - 1 or not whole is none; an age past 7 days or below 0 counts as 0.
    for (const i of [-1, 2 ** 31, 1.5, '7']) expect(parseMapPayload({ p: '/', s: 10, i }, '/')!.id).toBeNull();
    expect(parseMapPayload({ p: '/', s: 10, a: 8 * DAY }, '/')!.age).toBe(0);
  });

  it('scrubs labels as error messages are: emails, phone numbers and runs of 6 or more digits', () => {
    const m = parseMapPayload(
      {
        p: '/account',
        w: 1000,
        c: [
          [10, 10, 'a.me', 'Logged in as anna.mueller@example.de'],
          [10, 10, 'span', 'Anna Müller'],
          [10, 10, 'a', 'Invoice 20261104-9921 for 49 EUR'],
          [10, 10, 'a', 'Call +49 30 1234 5678'],
          [10, 10, 'a', 'Signed in as very.long.name@exam'],
        ],
      },
      '/',
    )!;
    expect(m.clicks.map((c) => c[3])).toEqual([
      'Logged in as [removed]',
      // A name inside a link stays: data-fd-mask keeps it out (PRIVACY.md "Click maps and scroll").
      'Anna Müller',
      'Invoice [removed] for 49 EUR',
      'Call [removed]',
      // The tracker cut the email at 40 characters: a word with an @ goes too.
      'Signed in as [removed]',
    ]);
    // Scrubbed before the cut, so an email that would pass 40 characters cannot leave half of itself.
    expect(cleanLabel('Your account: some.person.with.a.long.name@example.com')).toBe('Your account: [removed]');
    expect(cleanLabel('Plan 2026 costs 49')).toBe('Plan 2026 costs 49');
  });

  it('drops clicks out of range, broken hints and long labels', () => {
    const m = parseMapPayload(
      {
        p: '/',
        w: 1000,
        s: 40,
        c: [
          [1001, 10, 'a', 'x'], // x past the viewport width
          [10, 50_001, 'a', 'x'], // y past 50,000
          [-1, 10, 'a', 'x'],
          'nope',
          [500, 20, 'div[onclick=alert(1)]', 'A label that goes on far longer than forty characters do'],
          [500, 20.6, 'BUTTON.Buy', '  Buy   now '],
        ],
      },
      '/',
    )!;
    expect(m.clicks).toEqual([
      [500, 20, '', 'A label that goes on far longer than for'],
      [500, 21, 'button.buy', 'Buy now'],
    ]);
  });

  it('answers null for nothing to keep, and takes the ping path when p is not a path', () => {
    expect(parseMapPayload(null, '/')).toBeNull();
    expect(parseMapPayload([1], '/')).toBeNull();
    expect(parseMapPayload({ p: '/', c: [] }, '/')).toBeNull();
    expect(parseMapPayload({ p: '/', s: 101 }, '/')).toBeNull();
    expect(parseMapPayload({ p: 'https://evil.example/', s: 10 }, '/blog')!.path).toBe('/blog');
  });

  it('sends a skip pattern that matches the never-record rule', () => {
    const list = ['/account', '/admin/', '/a.b'];
    const re = new RegExp(skipPattern(list)!);
    for (const p of ['/account', '/account/x', '/accounts', '/admin/', '/admin/users', '/admin', '/a.b', '/aXb', '/'])
      expect(re.test(p), p).toBe(isSkipped(p, list));
    expect(skipPattern([])).toBeUndefined();
  });

  it('configures the tracker only when the switch is on', () => {
    const base = { id: 's', domain: 'x.example' } as any;
    expect(mapConfig(base)).toBeUndefined();
    expect(mapConfig({ ...base, maps_on: 1, map_sample: 25 })).toEqual({ s: 25 });
    expect(mapConfig({ ...base, maps_on: 1, record_skip: '/account' })).toEqual({ s: 100, x: '^(?:/account(?:/|$))' });
  });

  it('samples by map_sample and skips the never-record list', () => {
    const db = { prepare: () => ({ bind: (...a: unknown[]) => a }) } as any;
    const site = { id: 's', maps_on: 1, map_sample: 30, record_skip: '/account' } as any;
    const h = { p: '/pricing', s: 50 };
    // The page view's id decides, so every send of one page view gets the same answer.
    expect(mapStatement(db, site, { ...h, i: 129 }, '/pricing', 'Desktop', 1, () => 0.99)).not.toBeNull();
    expect(mapStatement(db, site, { ...h, i: 130 }, '/pricing', 'Desktop', 1, () => 0)).toBeNull();
    // Without one (an older tracker) the server draws the id: 0.1 * 2^31 ends in 64, kept at 70% and not at 30%.
    expect(mapStatement(db, site, h, '/pricing', 'Desktop', 1, () => 0.1)).toBeNull();
    expect(mapStatement(db, { ...site, map_sample: 70 }, h, '/pricing', 'Desktop', 1, () => 0.1)).not.toBeNull();
    expect(mapStatement(db, site, { p: '/account/billing', s: 50 }, '/', 'Desktop', 1, () => 0)).toBeNull();
    expect(mapStatement(db, { ...site, maps_on: 0 }, h, '/pricing', 'Desktop', 1, () => 0)).toBeNull();
  });

  it('reads scroll beside the page speed metrics, and keeps no row for scroll alone', () => {
    expect(parseVitals({ l: 1200, s: 66.4 })).toEqual({ lcp: 1200, inp: null, cls: null, ttfb: null, fcp: null, scroll: 66 });
    expect(parseVitals({ l: 1200, s: 140 })).toEqual({ lcp: 1200, inp: null, cls: null, ttfb: null, fcp: null });
    expect(parseVitals({ s: 50 })).toBeNull();
  });
});

describe('click maps through the Worker', () => {
  let w: TestWorker;
  let site: any;
  let key = '';
  const ping = (body: Record<string, unknown>, ua = UA, page = '/pricing') =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': ua, 'cf-connecting-ip': '198.51.100.61' },
      body: JSON.stringify({ w: site.id, t: 'ping', u: `https://maps.example${page}`, d: 500, sw: 1440, ...body }),
    });
  const pageview = (page = '/pricing') =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.62' },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://maps.example${page}`, sw: 1440 }),
    });
  const maps = async () => (await w.db.prepare('SELECT * FROM page_maps WHERE site_id = ? ORDER BY ts, path').bind(site.id).all<any>()).results;

  beforeAll(async () => {
    resetBudgetForTests(Infinity);
    w = await startWorker();
    site = await w.createSite({ domain: 'maps.example' });
    key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'speed', scopes: ['read'], sites: [site.id] } })).body.key;
  });
  afterAll(() => w.dispose());

  it('stores nothing and sends no cfg.m while click maps are off', async () => {
    const r = await pageview();
    expect((await r.json<any>()).cfg?.m).toBeUndefined();
    await ping({ h: { p: '/pricing', w: 1280, H: 3000, s: 60, c: [[500, 200, 'a.cta', 'Start']] } });
    expect(await maps()).toEqual([]);
  });

  it('turns on with PATCH, checks the sample, and sends cfg.m', async () => {
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { map_sample: 0 } })).status).toBe(400);
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { map_sample: 101 } })).status).toBe(400);
    const r = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { maps_on: true, map_sample: 100, record_skip: '/account' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ maps_on: 1, map_sample: 100 });
    forgetSite(site.id);
    const cfg = (await (await pageview()).json<any>()).cfg;
    expect(cfg.m).toEqual({ s: 100, x: '^(?:/account(?:/|$))' });
  });

  it('stores one row per page view with device, size, scroll and clicks, and no visitor or session id', async () => {
    await ping({ h: { p: '/pricing', w: 1280, H: 3000, s: 60, c: [[640, 200, 'a.cta', 'Start']] } });
    await ping({ h: { p: '/', w: 390, H: 5000, s: 20, c: [] } }, PHONE, '/blog');
    await ping({ h: { p: '/account/billing', w: 1280, H: 900, s: 100, c: [[10, 10, 'button', 'Cancel']] } });
    const got = await maps();
    expect(got.map((r) => [r.path, r.device, r.width, r.height, r.scroll, r.clicks])).toEqual([
      ['/pricing', 'Desktop', 1280, 3000, 60, '[[500,200,"a.cta","Start"]]'],
      ['/', 'Mobile', 390, 5000, 20, null],
    ]);
    expect(Object.keys(got[0]).sort()).toEqual(['clicks', 'device', 'height', 'id', 'path', 'scroll', 'site_id', 'ts', 'width']);
  });

  it('keeps one row per page view: a later send of it replaces the clicks and keeps the deepest scroll', async () => {
    const rows = async () =>
      (await w.db.prepare("SELECT ts, id, scroll, clicks FROM page_maps WHERE site_id = ? AND path = '/upsert'").bind(site.id).all<any>()).results;
    const before = Date.now();
    // The page view began 10 minutes before this send: its row starts then.
    await ping({ h: { p: '/upsert', w: 1000, H: 3000, s: 40, c: [[100, 50, 'a.compare', 'Compare']], i: 4242, a: 600_000 } });
    const [first] = await rows();
    expect(first.ts).toBeGreaterThanOrEqual(before - 600_000);
    expect(first.ts).toBeLessThanOrEqual(Date.now() - 600_000);
    // The visitor came back to the tab and clicked Buy: the same page view (its age grew by the time between the two
    // sends, here 3 s off to stand for a send that reached the server late), one row.
    await ping({
      h: { p: '/upsert', w: 1000, H: 3100, s: 30, c: [[100, 50, 'a.compare', 'Compare'], [800, 900, 'button.buy', 'Buy Pro']], i: 4242, a: 597_000 },
    });
    // A page view with the same id that began 10 minutes after it, outside the 5-minute match: a row of its own.
    await ping({ h: { p: '/upsert', w: 1000, s: 10, i: 4242, a: 0 } });
    const got = await rows();
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ ts: first.ts, id: 4242, scroll: 40, clicks: '[[100,50,"a.compare","Compare"],[800,900,"button.buy","Buy Pro"]]' });
    expect(got[1]).toMatchObject({ id: 4242, scroll: 10, clicks: null });
  });

  it('stores the scroll of a page load on its page speed row and reads it per path', async () => {
    for (let i = 0; i < 12; i++) await ping({ v: { l: 1000, p: '/docs', s: i < 9 ? 90 : 20 } });
    for (let i = 0; i < 3; i++) await ping({ v: { l: 1000, p: '/rare', s: 50 } });
    const r = await w.fetch('/api/v1/vitals', { headers: { authorization: `Bearer ${key}` } });
    const body = await r.json<any>();
    const docs = body.pages.find((p: any) => p.path === '/docs');
    expect(docs.scroll).toEqual({ samples: 12, median_pct: 90, reached_25: 0.75, reached_50: 0.75, reached_75: 0.75, reached_100: 0, source: 'page_speed' });
    // Below 10 samples the numbers are null, with the count.
    expect(body.pages.find((p: any) => p.path === '/rare').scroll).toMatchObject({ samples: 3, median_pct: null, reached_50: null, source: 'page_speed' });
    expect(body.scroll.samples).toBe(15);
    const one = await (await w.fetch('/api/v1/vitals?path=/docs', { headers: { authorization: `Bearer ${key}` } })).json<any>();
    expect(one.scroll).toMatchObject({ median_pct: 90, source: 'page_speed' });
  });

  it('adds scroll to the content page answer, and with Pro the 10 most clicked elements', async () => {
    const now = Date.now();
    const rows: unknown[] = [];
    for (let i = 0; i < 12; i++) rows.push(site.id, '/docs', now - i * 60_000, i + 10, JSON.stringify(i < 9 ? [[500, 300, 'a.cta', 'Start'], [500, 300, 'a.cta', 'Start']] : [[100, 20, 'a.nav', 'Pricing']]));
    await w.db
      .prepare(`INSERT INTO page_maps (site_id, path, ts, id, clicks) VALUES ${Array(12).fill('(?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...rows)
      .run();
    const r = await w.fetch('/api/v1/content/page?path=/docs', { headers: { authorization: `Bearer ${key}` } });
    expect(r.status).toBe(200);
    const body = await r.json<any>();
    // 12 page speed rows and 12 map rows without a scroll: the page speed rows answer, with the window.
    expect(body.scroll).toMatchObject({ days: 28, samples: 12, median_pct: 90, source: 'page_speed' });
    // The click report is Pro's (plan S1, the pageClicks hook): core answers null.
    expect(body.clicks).toEqual(
      isPro
        ? {
            days: 28,
            views: 12,
            sampled: false,
            elements: [
              { element: 'a.cta', label: 'Start', clicks: 18, views: 9, share: 0.75, rage: 0 },
              { element: 'a.nav', label: 'Pricing', clicks: 3, views: 3, share: 0.25, rage: 0 },
            ],
          }
        : null,
    );
    expect(body.click_maps).toBeUndefined();
    // A page with neither answers null for both, and says why: the switch and what to check.
    const none = await (await w.fetch('/api/v1/content/page?path=/nothing-here', { headers: { authorization: `Bearer ${key}` } })).json<any>();
    expect([none.scroll, none.clicks]).toEqual([null, null]);
    expect(none.click_maps).toMatchObject({ on: true });
    expect(none.click_maps.next_step).toContain('/nothing-here');
    expect(none.click_maps.next_step).toContain(isPro ? 'Click maps are on' : 'FounderData Pro');
  });

  it('picks one scroll source for a page: page speed rows from 30, else the click map rows when there are more', async () => {
    const now = Date.now();
    const auth = { headers: { authorization: `Bearer ${key}` } };
    // /spa: 3 page speed rows (a single-page app loads it once) and 20 mapped page views with a scroll.
    for (let i = 0; i < 3; i++) await ping({ v: { l: 1000, p: '/spa', s: 10 } });
    const rows: unknown[] = [];
    for (let i = 0; i < 20; i++) rows.push(site.id, '/spa', now - i * 60_000, 500 + i, i < 15 ? 80 : 30);
    await w.db
      .prepare(`INSERT INTO page_maps (site_id, path, ts, id, scroll) VALUES ${Array(20).fill('(?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...rows)
      .run();
    const spa = await (await w.fetch('/api/v1/content/page?path=/spa', auth)).json<any>();
    expect(spa.scroll).toEqual({ days: 28, samples: 20, median_pct: 80, reached_25: 1, reached_50: 0.75, reached_75: 0.75, reached_100: 0, source: 'click_maps' });
    // get_web_vitals keeps the page speed rows only.
    const speed = await (await w.fetch('/api/v1/vitals?path=/spa', auth)).json<any>();
    expect(speed.scroll).toMatchObject({ samples: 3, median_pct: null, source: 'page_speed' });
    // The rule on its own: 30 page speed rows win over any number of map rows; fewer lose to more map rows only.
    const s = (n: number, source: 'page_speed' | 'click_maps') => ({ ...scrollSummary({ g: '', n, median: 50, r25: n, r50: n, r75: 0, r100: 0 }, source) });
    expect(pickScroll(s(SCROLL_SPEED_MIN, 'page_speed'), s(400, 'click_maps')).source).toBe('page_speed');
    expect(pickScroll(s(29, 'page_speed'), s(400, 'click_maps')).source).toBe('click_maps');
    expect(pickScroll(s(29, 'page_speed'), s(12, 'click_maps')).source).toBe('page_speed');
    expect(pickScroll(s(0, 'page_speed'), null).source).toBeNull();
    // The Content list rows get the same median and the map flag, for any rows with a page.
    const list = await withPageScroll(w.db, site.id, { truncated: false, rows: [{ page: '/spa', visitors: 3 }, { page: '/docs', visitors: 12 }, { page: '/rare', visitors: 3 }, { page: '/nothing', visitors: 1 }] });
    expect(list.scroll_days).toBe(28);
    expect(list.rows.map((r) => [r.page, r.scroll_median_pct, r.has_click_map])).toEqual([
      ['/spa', 80, true],
      ['/docs', 90, true],
      ['/rare', null, false],
      ['/nothing', null, false],
    ]);
    // GET /api/v1/content (get_content without a path) carries the same two fields on each row.
    const v1 = await (await w.fetch('/api/v1/content?period=7d', auth)).json<any>();
    expect(v1.scroll_days).toBe(28);
    expect(v1.rows.find((r: any) => r.page === '/pricing')).toMatchObject({ scroll_median_pct: null, has_click_map: true });
    for (const r of v1.rows) expect(Object.keys(r)).toEqual(expect.arrayContaining(['scroll_median_pct', 'has_click_map']));
  });

  it('reads at most the newest 2,000 click map rows of a page for its scroll', async () => {
    const now = Date.now();
    // 2,100 rows, one a second: the oldest 100 scrolled 10%, the newest 2,000 scrolled 90%.
    await w.db
      .prepare(
        `INSERT INTO page_maps (site_id, path, ts, id, scroll)
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2099)
         SELECT ?1, '/busy', ?2 - (2100 - i) * 1000, i, CASE WHEN i < 100 THEN 10 ELSE 90 END FROM n`,
      )
      .bind(site.id, now)
      .run();
    const got = (await mapScrollByPath(w.db, site.id, ['/busy'], now - 28 * DAY, now + 1000)).get('/busy')!;
    expect(MAP_READ_CAP).toBe(2000);
    expect(got.views).toBe(MAP_READ_CAP);
    expect(got.scroll).toMatchObject({ samples: 2000, median_pct: 90, reached_25: 1, source: 'click_maps' });
    // The rows read do not grow with the window: 4,000 more older rows leave them as they were.
    const read = async () => (await w.db.prepare(mapScrollSql(false)).bind(site.id, now - 28 * DAY, now + 1000, '["/busy"]').all()).meta.rows_read;
    const before = await read();
    await w.db
      .prepare(
        `INSERT INTO page_maps (site_id, path, ts, id, scroll)
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3999)
         SELECT ?1, '/busy', ?2 - 3000000 - i * 1000, 10000 + i, 10 FROM n`,
      )
      .bind(site.id, now)
      .run();
    expect(await read()).toBeLessThanOrEqual(before + 10);
    expect((await mapScrollByPath(w.db, site.id, ['/busy'], now - 28 * DAY, now + 1000)).get('/busy')!.scroll.median_pct).toBe(90);
  });

  it('removes rows after 90 days, and empties them with the site', async () => {
    const now = Date.now();
    await w.db
      .prepare('INSERT INTO page_maps (site_id, path, ts, id, scroll) VALUES (?, ?, ?, 1, 10), (?, ?, ?, 2, 10)')
      .bind(site.id, '/old', now - 91 * DAY, site.id, '/recent', now - 89 * DAY)
      .run();
    await pruneOldData(w.db, now);
    const paths = (await maps()).map((r) => r.path);
    expect(paths).not.toContain('/old');
    expect(paths).toContain('/recent');
    const other = await w.createSite({ domain: 'gone.example' });
    await w.db.prepare('INSERT INTO page_maps (site_id, path, ts, id) VALUES (?, ?, ?, 1)').bind(other.id, '/', now).run();
    expect((await w.admin(`/api/sites/${other.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM page_maps WHERE site_id = ?').bind(other.id).first('n')).toBe(0);
  });

  it('answers the click maps and scroll definitions', async () => {
    const r = await (await w.fetch('/api/v1/definitions', { headers: { authorization: `Bearer ${key}` } })).json<any>();
    expect(r.definitions.click_maps).toMatch(/No visitor or session id/);
    expect(r.definitions.scroll).toMatch(/median/);
  });
});

// ---------- the tracker's click map region, in a small fake browser

const CODE = fs.readFileSync(path.resolve(__dirname, '../public/js/script.js'), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** An element whose own text is `text`. `hidden`: it sits in [data-fd-mask] or in an editable part (contenteditable). */
function fakeEl(tag: string, text: string, cls?: string, hidden = false) {
  const e: any = { nodeType: 1, tagName: tag.toUpperCase(), classList: cls ? [cls] : [], id: '', attributes: [] };
  e.firstChild = { nodeType: 3, data: text, nextSibling: null };
  e.getAttribute = () => null;
  e.matches = () => false;
  // The label check (form fields, contenteditable, masks) matches the element itself when it is a form field.
  e.closest = (sel: string) =>
    sel.includes('contenteditable') ? (hidden || /^(input|textarea|select)$/.test(tag) ? {} : null) : sel.includes('button') ? e : null;
  return e;
}

function browser(o: { href?: string; cfg?: unknown; perf?: boolean } = {}) {
  const requests: any[] = [];
  const beacons: any[] = [];
  const scripts: any[] = [];
  const listeners: { type: string; fn: (e: any) => void }[] = [];
  const doc: any = {
    cookie: '',
    currentScript: { src: 'https://stats.example/js/script.js', getAttribute: (n: string) => (n === 'data-website-id' ? 'site123' : null), hasAttribute: () => false },
    referrer: '',
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: { scrollHeight: 4000 },
    head: { appendChild: (s: unknown) => scripts.push(s) },
    createElement: (tag: string) => ({ tagName: tag.toUpperCase() }),
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.push({ type, fn }),
    querySelectorAll: () => [],
  };
  const hist: any = { pushState() {}, replaceState() {} };
  const win: any = {
    location: new URL(o.href ?? 'https://example.com/pricing'),
    navigator: { webdriver: false, sendBeacon: (_u: string, b: Blob) => (beacons.push(b.text().then(JSON.parse)), true) },
    screen: { width: 1440 },
    history: hist,
    innerWidth: 1000,
    innerHeight: 1000,
    pageYOffset: 0,
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.push({ type: `window:${type}`, fn }),
    crypto: globalThis.crypto,
  };
  if (o.perf) {
    win.PerformanceObserver = class {
      static supportedEntryTypes = ['largest-contentful-paint'];
      constructor(private cb: (l: { getEntries: () => unknown[] }) => void) {}
      observe() {
        this.cb({ getEntries: () => [{ startTime: 1500 }] });
      }
    };
    win.performance = { getEntriesByType: () => [{}], now: () => 1 };
  }
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const cfg = body.t === 'pageview' && o.cfg ? { cfg: o.cfg } : {};
    return Response.json({ vid: 'v'.repeat(32), sid: 's'.repeat(32), ...cfg }, { status: 202 });
  };
  const ctx = vm.createContext({ window: win, screen: win.screen, document: doc, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch, URL, URLSearchParams, Blob, Response, setTimeout, setInterval: () => 0, crypto: globalThis.crypto });
  vm.runInContext(CODE, ctx);
  const fire = (type: string, e: unknown = {}) => {
    for (const l of listeners) if (l.type === type) l.fn(e);
  };
  return {
    win,
    doc,
    requests,
    beacons,
    scripts,
    click: (el: unknown, x: number, y: number) => fire('click', { type: 'click', target: el, clientX: x, pageY: y }),
    scrollTo: (y: number) => {
      win.pageYOffset = y;
      fire('window:scroll');
    },
    hide: () => {
      doc.visibilityState = 'hidden';
      fire('visibilitychange');
    },
    show: () => {
      doc.visibilityState = 'visible';
      fire('visibilitychange');
    },
    navigate: async (p: string) => {
      win.location.href = new URL(p, win.location).href;
      hist.pushState();
      await tick(5);
    },
  };
}

describe('tracker: click maps and scroll', () => {
  it('sends no map without cfg.m', async () => {
    const t = browser();
    await tick();
    t.click(fakeEl('button', 'Buy', 'buy'), 500, 300);
    t.hide();
    const sent = await Promise.all(t.beacons);
    expect(sent.some((b) => b.h)).toBe(false);
  });

  it('sends the page map when hidden, again with what came after, and the next page its own after a single-page move', async () => {
    const t = browser({ cfg: { m: { s: 100 } } });
    await tick();
    t.click(fakeEl('button', ' Start  free ', 'cta'), 640, 380);
    t.click(fakeEl('a', 'jane@example.com', 'email', true), 100, 1200);
    t.scrollTo(1400); // the screen bottom at 2400 of 4000 px
    t.hide();
    t.show();
    t.hide(); // nothing new: no second map
    let sent = (await Promise.all(t.beacons)).filter((b) => b.h);
    expect(sent).toHaveLength(1);
    const { i, a, ...h } = sent[0].h;
    expect(h).toEqual({ p: '/pricing', w: 1000, H: 4000, s: 60, c: [[640, 380, 'button.cta', 'Start free'], [100, 1200, 'a.email', '']] });
    expect(Number.isInteger(i) && i >= 0 && i < 2 ** 31).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    // Back on the tab (a link opened in a new tab, an app switch), the buy click still counts: the same page view's
    // id, every click so far, so the server replaces the row.
    t.show();
    t.click(fakeEl('button', 'Buy Pro', 'buy'), 900, 2000);
    t.hide();
    sent = (await Promise.all(t.beacons)).filter((b) => b.h);
    expect(sent).toHaveLength(2);
    expect(sent[1].h.i).toBe(i);
    expect(sent[1].h.c.map((c: any[]) => c[3])).toEqual(['Start free', '', 'Buy Pro']);
    t.show();

    await t.navigate('/signup');
    t.click(fakeEl('button', 'Create account'), 500, 100);
    t.hide();
    const all = [...t.requests, ...(await Promise.all(t.beacons))].filter((b) => b.h);
    expect(all.map((b) => b.h.p)).toEqual(['/pricing', '/pricing', '/signup']);
    expect(all[2].h.c).toEqual([[500, 100, 'button', 'Create account']]);
    expect(all[2].h.i).not.toBe(i);
  });

  it('keeps the page view through a query-only change', async () => {
    const t = browser({ cfg: { m: { s: 100 } } });
    await tick();
    t.click(fakeEl('button', 'Pro', 'plan'), 10, 10);
    await t.navigate('/pricing?plan=pro'); // a filter written to the query
    t.click(fakeEl('button', 'Buy', 'buy'), 20, 20);
    t.hide();
    const all = [...t.requests, ...(await Promise.all(t.beacons))].filter((b) => b.h);
    expect(new Set(all.map((b) => b.h.i)).size).toBe(1);
    expect(all.at(-1).h.c.map((c: any[]) => c[3])).toEqual(['Pro', 'Buy']);
  });

  it('never labels a click with what was typed: form fields and editable parts give no text', async () => {
    const t = browser({ cfg: { m: { s: 100 } } });
    await tick();
    t.click(fakeEl('p', 'My email is jane@x.com, order 4411', '', true), 10, 10); // a contenteditable comment box
    t.click(fakeEl('textarea', 'Prefilled text'), 20, 20);
    t.click(fakeEl('select', 'Germany'), 30, 30);
    t.hide();
    const h = (await Promise.all(t.beacons)).find((b) => b.h)!.h;
    expect(h.c.map((c: any[]) => [c[2], c[3]])).toEqual([
      ['p', ''],
      ['textarea', ''],
      ['select', ''],
    ]);
  });

  it('sends no map on a page of the never-record list', async () => {
    const t = browser({ href: 'https://example.com/account/billing', cfg: { m: { s: 100, x: '^(?:/account(?:/|$))' } } });
    await tick();
    t.click(fakeEl('button', 'Cancel'), 1, 1);
    t.hide();
    expect((await Promise.all(t.beacons)).some((b) => b.h)).toBe(false);
  });

  it('puts the scroll depth on the page speed beacon, for every site', async () => {
    const t = browser({ perf: true });
    await tick();
    t.scrollTo(3000);
    t.hide();
    const v = (await Promise.all(t.beacons)).find((b) => b.v)!.v;
    expect(v).toMatchObject({ l: 1500, p: '/pricing', s: 100 });
  });

  it('shows the map with #fd-map= and sends nothing', async () => {
    const t = browser({ href: 'https://example.com/pricing#fd-map=abc.123&d=mobile' });
    await tick();
    t.hide();
    expect(t.requests).toEqual([]);
    expect(await Promise.all(t.beacons)).toEqual([]);
    expect(t.scripts.map((s) => s.src)).toEqual(['https://stats.example/js/map.js']);
    expect(t.win.founderdata._map).toEqual({ token: 'abc.123', host: 'https://stats.example', site: 'site123' });
  });
});
