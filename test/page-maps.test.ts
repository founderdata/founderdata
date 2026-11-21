// Click maps and scroll depth, core part (src/worker/page-maps.ts, src/worker/vitals.ts, the tracker's click map
// region): what the ping's map payload may hold, the never-record list, the sample, retention, the scroll read, and
// what the tracker sends.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { forgetSite } from '../src/worker/env';
import { mapConfig, mapStatement, parseMapPayload, skipPattern, MAX_MAP_CLICKS } from '../src/worker/page-maps';
import { parseVitals } from '../src/worker/vitals';
import { pruneOldData } from '../src/worker/retention';
import { isSkipped } from '../src/worker/recording';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const DAY = 86_400_000;

describe('click map payload', () => {
  it('keeps what it may and clips the rest', () => {
    const many = Array.from({ length: 70 }, (_, i) => [i * 10, i * 100, 'a.nav', `Link ${i}`]);
    const m = parseMapPayload({ p: '/pricing/?q=1', w: 1280.4, H: 4200, s: 73.6, c: many }, '/x')!;
    expect(m.path).toBe('/pricing');
    expect([m.width, m.height, m.scroll]).toEqual([1280, 4200, 74]);
    expect(m.clicks).toHaveLength(MAX_MAP_CLICKS);
    expect(m.clicks[3]).toEqual([30, 300, 'a.nav', 'Link 3']);
  });

  it('drops clicks out of range, broken hints and long labels', () => {
    const m = parseMapPayload(
      {
        p: '/',
        s: 40,
        c: [
          [1001, 10, 'a', 'x'], // x past 1000
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
    expect(mapStatement(db, site, h, '/pricing', 'Desktop', 1, () => 0.29)).not.toBeNull();
    expect(mapStatement(db, site, h, '/pricing', 'Desktop', 1, () => 0.31)).toBeNull();
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
    await ping({ h: { p: '/pricing', w: 1280, H: 3000, s: 60, c: [[500, 200, 'a.cta', 'Start']] } });
    await ping({ h: { p: '/', w: 390, H: 5000, s: 20, c: [] } }, PHONE, '/blog');
    await ping({ h: { p: '/account/billing', w: 1280, H: 900, s: 100, c: [[10, 10, 'button', 'Cancel']] } });
    const got = await maps();
    expect(got.map((r) => [r.path, r.device, r.width, r.height, r.scroll, r.clicks])).toEqual([
      ['/pricing', 'Desktop', 1280, 3000, 60, '[[500,200,"a.cta","Start"]]'],
      ['/', 'Mobile', 390, 5000, 20, null],
    ]);
    expect(Object.keys(got[0]).sort()).toEqual(['clicks', 'device', 'height', 'id', 'path', 'scroll', 'site_id', 'ts', 'width']);
  });

  it('stores the scroll of a page load on its page speed row and reads it per path', async () => {
    for (let i = 0; i < 12; i++) await ping({ v: { l: 1000, p: '/docs', s: i < 9 ? 90 : 20 } });
    for (let i = 0; i < 3; i++) await ping({ v: { l: 1000, p: '/rare', s: 50 } });
    const r = await w.fetch('/api/v1/vitals', { headers: { authorization: `Bearer ${key}` } });
    const body = await r.json<any>();
    const docs = body.pages.find((p: any) => p.path === '/docs');
    expect(docs.scroll).toEqual({ samples: 12, median: 90, reached_25: 0.75, reached_50: 0.75, reached_75: 0.75, reached_100: 0 });
    // Below 10 samples the numbers are null, with the count.
    expect(body.pages.find((p: any) => p.path === '/rare').scroll).toMatchObject({ samples: 3, median: null, reached_50: null });
    expect(body.scroll.samples).toBe(15);
    const one = await (await w.fetch('/api/v1/vitals?path=/docs', { headers: { authorization: `Bearer ${key}` } })).json<any>();
    expect(one.scroll.median).toBe(90);
  });

  it('adds scroll and the 10 most clicked elements to the content page answer', async () => {
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
    expect(body.scroll).toMatchObject({ samples: 12, median: 90 });
    expect(body.clicks).toEqual({
      days: 28,
      views: 12,
      elements: [
        { element: 'a.cta', label: 'Start', clicks: 18, views: 9, share: 0.75 },
        { element: 'a.nav', label: 'Pricing', clicks: 3, views: 3, share: 0.25 },
      ],
    });
    // A page with neither answers null for both.
    const none = await (await w.fetch('/api/v1/content/page?path=/nothing-here', { headers: { authorization: `Bearer ${key}` } })).json<any>();
    expect([none.scroll, none.clicks]).toEqual([null, null]);
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

function fakeEl(tag: string, text: string, cls?: string, masked = false) {
  const e: any = { nodeType: 1, tagName: tag.toUpperCase(), classList: cls ? [cls] : [], id: '', attributes: [] };
  e.firstChild = { nodeType: 3, data: text, nextSibling: null };
  e.getAttribute = () => null;
  e.matches = () => false;
  e.closest = (sel: string) => (sel.includes('data-fd-mask') ? (masked ? {} : null) : sel.includes('button') ? e : null);
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

  it('sends the page map once, with masked labels left out, and the next page its own after a single-page move', async () => {
    const t = browser({ cfg: { m: { s: 100 } } });
    await tick();
    t.click(fakeEl('button', ' Start  free ', 'cta'), 640, 380);
    t.click(fakeEl('a', 'jane@example.com', 'email', true), 100, 1200);
    t.scrollTo(1400); // the screen bottom at 2400 of 4000 px
    t.hide();
    t.show();
    t.hide(); // a second hide sends no second map
    const sent = (await Promise.all(t.beacons)).filter((b) => b.h);
    expect(sent).toHaveLength(1);
    expect(sent[0].h).toEqual({ p: '/pricing', w: 1000, H: 4000, s: 60, c: [[640, 380, 'button.cta', 'Start free'], [100, 1200, 'a.email', '']] });

    await t.navigate('/signup');
    t.click(fakeEl('button', 'Create account'), 500, 100);
    t.hide();
    const all = [...t.requests, ...(await Promise.all(t.beacons))].filter((b) => b.h);
    expect(all.map((b) => b.h.p)).toEqual(['/pricing', '/signup']);
    expect(all[1].h.c).toEqual([[500, 100, 'button', 'Create account']]);
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
