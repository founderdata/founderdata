// Runs public/js/script.js in a VM with a minimal fake browser: a cookie jar, fetch, sendBeacon, storage.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const CODE = fs.readFileSync(path.resolve(__dirname, '../public/js/script.js'), 'utf8');
// What the build serves (vite.config.ts minifyTracker): the same file, minified by esbuild.
const MINIFIED = transformSync(CODE, { minify: true, legalComments: 'inline', target: 'es2017' }).code;
const SERVER_IDS = { vid: '0123456789abcdef0123456789abcdef', sid: 'fedcba9876543210fedcba9876543210' };
const att = (vid: string, sid: string, site = 'site123') => ({
  rt_visitor_id: vid,
  rt_session_id: sid,
  rt_site_id: site,
  ml_visitor_id: vid,
  ml_session_id: sid,
  ml_site_id: site,
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  attrs?: Record<string, string>;
  cookies?: Record<string, string>;
  href?: string;
  queue?: unknown[][];
  links?: { href: string }[];
  storage?: Record<string, string>;
  legacyQueue?: boolean;
  /** Queue the calls on this global instead (founderdata, or minilytics with legacyQueue). */
  queueGlobal?: string;
  /** A browser with PerformanceObserver: these entry types are supported, and `entries` are buffered already. */
  perf?: { types: string[]; entries?: Record<string, unknown[]>; navigation?: Record<string, number> };
  code?: string;
  /** The page loads in a background tab. */
  hidden?: boolean;
  /** The tracker config a pageview's answer carries (docs/API.md, "Tracker config"). */
  cfg?: unknown;
}

/** A fake element for click capture: a tag, its visible text and attributes, inside [data-fd-mask] or not. */
interface FakeEl {
  tagName: string;
  innerText: string;
  type?: string;
  form?: unknown;
  href?: string;
  masked?: boolean;
  attrs?: Record<string, string>;
  /** Child elements after the text, as the label walker reads them. */
  kids?: any[];
  isContentEditable?: boolean;
}
function el(tag: string, text = '', more: Partial<FakeEl> = {}) {
  const e: any = { nodeType: 1, tagName: tag.toUpperCase(), innerText: text, textContent: text, attributes: [], ...more };
  // The children as DOM nodes: the text first, then the child elements, each linked to the next.
  const nodes = [...(text ? [{ nodeType: 3, data: text }] : []), ...(more.kids ?? [])];
  nodes.forEach((n, i) => (n.nextSibling = nodes[i + 1] ?? null));
  e.firstChild = nodes[0] ?? null;
  e.getAttribute = (n: string) => e.attrs?.[n] ?? null;
  e.matches = (sel: string) => (sel.includes('data-fd-mask') && e.masked) || (sel.includes('[hidden]') && e.attrs?.hidden !== undefined);
  e.closest = (sel: string) => {
    if (sel.includes('data-fd-mask')) return e.masked ? {} : null;
    if (sel.includes('button')) return /^(A|BUTTON|INPUT)$/.test(e.tagName) || e.attrs?.role === 'button' ? e : null;
    if (sel === 'a[href]') return e.tagName === 'A' ? e : null;
    return null;
  };
  return e;
}

function load(o: Opts = {}) {
  const attrs: Record<string, string> = { 'data-website-id': 'site123', ...o.attrs };
  const jar = new Map(Object.entries(o.cookies ?? {}));
  const cookieWrites: string[] = [];
  const storageWrites: string[] = [];
  const requests: any[] = [];
  const beacons: any[] = [];
  const scripts: any[] = [];
  const listeners: { type: string; fn: (e: unknown) => void }[] = [];
  const document = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(str: string) {
      cookieWrites.push(str);
      const [nv, ...rest] = str.split(';');
      const i = nv.indexOf('=');
      const name = nv.slice(0, i).trim();
      const maxAge = rest.map((a) => a.trim()).find((a) => a.startsWith('max-age='));
      if (maxAge && Number(maxAge.slice(8)) <= 0) jar.delete(name);
      else jar.set(name, nv.slice(i + 1));
    },
    currentScript: {
      src: 'https://stats.example/js/script.js',
      getAttribute: (n: string) => attrs[n] ?? null,
      hasAttribute: (n: string) => n in attrs,
    },
    referrer: 'https://www.google.com/',
    visibilityState: o.hidden ? 'hidden' : 'visible',
    readyState: 'complete',
    documentElement: {},
    head: { appendChild: (s: unknown) => scripts.push(s) },
    createElement: (tag: string) => ({ tagName: tag.toUpperCase() }),
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.push({ type, fn }),
    querySelectorAll: () => o.links ?? [],
  };
  const store = new Map(Object.entries(o.storage ?? {}));
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => (storageWrites.push(k), store.set(k, v)),
    removeItem: (k: string) => (storageWrites.push(k), store.delete(k)),
  };
  const window: any = {
    location: new URL(o.href ?? 'https://example.com/pricing'),
    navigator: {
      webdriver: false,
      sendBeacon: (_u: string, blob: Blob) => {
        beacons.push(blob.text().then(JSON.parse));
        return true;
      },
    },
    screen: { width: 1440 },
    history: { pushState() {}, replaceState() {} },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.push({ type: `window:${type}`, fn }),
    crypto: globalThis.crypto,
  };
  if (o.queue)
    window[o.queueGlobal ?? (o.legacyQueue ? 'minilytics' : 'founderdata')] = Object.assign(() => {}, { q: o.queue });
  // A fake PerformanceObserver: observe() delivers the buffered entries, emit() delivers new ones.
  const observers: { type: string; cb: (l: { getEntries: () => unknown[] }) => void }[] = [];
  if (o.perf) {
    const perf = o.perf;
    window.PerformanceObserver = class {
      static supportedEntryTypes = perf.types;
      constructor(private cb: (l: { getEntries: () => unknown[] }) => void) {}
      observe(opts: { type: string; buffered?: boolean }) {
        observers.push({ type: opts.type, cb: this.cb });
        const buffered = perf.entries?.[opts.type] ?? [];
        if (opts.buffered && buffered.length) this.cb({ getEntries: () => buffered });
      }
    };
    window.performance = { getEntriesByType: (t: string) => (t === 'navigation' ? [perf.navigation ?? {}] : []), now: () => 60_000 };
  }
  const urls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    urls.push(url);
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const cfg = body.t === 'pageview' && o.cfg ? { cfg: o.cfg } : {};
    if (body.vid) return Object.keys(cfg).length ? Response.json(cfg, { status: 202 }) : new Response(null, { status: 202 });
    return Response.json({ ...SERVER_IDS, ...cfg }, { status: 202 });
  };
  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    fetch,
    screen: window.screen,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    Blob,
    Response,
    setTimeout,
    setInterval: () => 0,
  });
  vm.runInContext(o.code ?? CODE, ctx);
  const ml = window.founderdata as ((...a: unknown[]) => void) & { attribution: () => Record<string, string> };
  /** Clicks an element that carries the given attributes (not a link). */
  const click = (attributes: Record<string, string>) => {
    const el = {
      attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
      getAttribute: (n: string) => attributes[n] ?? null,
      closest: (sel: string) => (sel.includes('goal') && Object.keys(attributes).some((k) => /^data-(rt|ml)-goal$/.test(k)) ? el : null),
    };
    for (const l of listeners) if (l.type === 'click') l.fn({ target: el });
  };
  const emit = (type: string, ...entries: unknown[]) => {
    for (const ob of observers) if (ob.type === type) ob.cb({ getEntries: () => entries });
  };
  /** The tab goes to the background, as on a tab switch or before the page unloads. */
  const hide = () => {
    document.visibilityState = 'hidden';
    for (const l of listeners) if (l.type === 'visibilitychange') l.fn({});
  };
  const show = () => {
    document.visibilityState = 'visible';
    for (const l of listeners) if (l.type === 'visibilitychange') l.fn({});
  };
  /** Clicks a fake element (el()), as the browser's click event. */
  const press = (target: unknown) => {
    for (const l of listeners) if (l.type === 'click') l.fn({ type: 'click', target });
  };
  /** Fires a window event: error or unhandledrejection. */
  const fire = (type: string, e: unknown) => {
    for (const l of listeners) if (l.type === `window:${type}`) l.fn(e);
  };
  return { ml, window, store, jar, cookieWrites, storageWrites, requests, urls, beacons, scripts, click, press, fire, emit, hide, show };
}

describe('tracker: cookieless by default', () => {
  it('sets no cookies and no storage, and lets the server derive the ids', async () => {
    const t = load();
    expect(t.requests[0]).toMatchObject({ w: 'site123', t: 'pageview', u: 'https://example.com/pricing' });
    expect(t.requests[0].vid).toBeUndefined();
    expect(t.ml.attribution()).toEqual({});
    await tick();
    expect(t.ml.attribution()).toEqual(att(SERVER_IDS.vid, SERVER_IDS.sid));
    // Later events reuse the ids from memory, so beacons work again.
    t.ml('goal', 'signup_click');
    expect(await t.beacons[0]).toMatchObject({ t: 'goal', vid: SERVER_IDS.vid, sid: SERVER_IDS.sid });
    expect(t.cookieWrites).toEqual([]);
    expect(t.storageWrites).toEqual([]);
  });

  it('removes ids left in cookies by an older version', () => {
    const t = load({ cookies: { rt_vid: 'old-visitor-id', rt_sid: 'old-session-id', ml_vid: 'older-visitor', other: 'keep' } });
    expect([...t.jar.keys()]).toEqual(['other']);
    expect(t.requests[0].vid).toBeUndefined();
  });

  it('tags checkout links once the ids are known, leaving the site\'s own client_reference_id alone', async () => {
    const links = [
      { href: 'https://checkout.dodopayments.com/buy/pdt_1?quantity=1' },
      { href: 'https://buy.stripe.com/test_abc' },
      { href: 'https://buy.stripe.com/test_def?client_reference_id=user_42' },
      { href: 'https://buy.stripe.com/test_ghi?client_reference_id=mlv_stale-visitor' },
    ];
    load({ links });
    await tick(80);
    expect(links[0].href).toContain(`metadata_rt_visitor_id=${SERVER_IDS.vid}`);
    expect(links[0].href).toContain(`metadata_rt_session_id=${SERVER_IDS.sid}`);
    expect(links[1].href).toBe(`https://buy.stripe.com/test_abc?client_reference_id=rtv_${SERVER_IDS.vid}`);
    expect(links[2].href).toBe('https://buy.stripe.com/test_def?client_reference_id=user_42');
    expect(links[3].href).toBe(`https://buy.stripe.com/test_ghi?client_reference_id=rtv_${SERVER_IDS.vid}`);
  });
});

describe('tracker: cookies with consent', () => {
  it('data-cookies="on" keeps the visitor in first-party cookies', () => {
    const t = load({ attrs: { 'data-cookies': 'on' } });
    const vid = t.jar.get('rt_vid')!;
    expect(vid).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.requests[0]).toMatchObject({ vid, sid: t.jar.get('rt_sid') });
    expect(t.ml.attribution()).toEqual(att(vid, t.jar.get('rt_sid')!));
    expect(t.cookieWrites.some((c) => c.startsWith('rt_vid=') && c.includes('domain=example.com') && c.includes('Secure'))).toBe(true);
  });

  it("consent(true) keeps the current ids so the visit continues; consent(false) deletes them", async () => {
    const t = load();
    await tick();
    t.ml('consent', true);
    expect(t.jar.get('rt_vid')).toBe(SERVER_IDS.vid);
    expect(t.jar.get('rt_sid')).toBe(SERVER_IDS.sid);
    expect(t.jar.get('rt_consent')).toBe('1');
    t.ml('goal', 'after_consent');
    expect(await t.beacons[0]).toMatchObject({ vid: SERVER_IDS.vid, sid: SERVER_IDS.sid });

    t.ml('consent', false);
    expect(t.jar.size).toBe(0);
    expect(t.ml.attribution()).toEqual({});
  });

  it('consent given before the first response arrives still keeps the server ids', async () => {
    const t = load();
    t.ml('consent', true);
    expect(t.jar.has('rt_vid')).toBe(false);
    await tick();
    expect(t.jar.get('rt_vid')).toBe(SERVER_IDS.vid);
  });

  it('remembers consent on the next page load', () => {
    const t = load({ cookies: { rt_consent: '1', rt_vid: 'returning-visitor-1', rt_sid: 'session-0000001' } });
    expect(t.requests[0]).toMatchObject({ vid: 'returning-visitor-1', sid: 'session-0000001' });
  });

  it('applies a queued consent call before the first pageview', () => {
    const t = load({ queue: [['consent', true], ['goal', 'queued_goal']] });
    expect(t.requests[0].t).toBe('pageview');
    expect(t.requests[0].vid).toBe(t.jar.get('rt_vid'));
  });
});

describe('tracker: revtrail name', () => {
  // Sites installed before the rename to FounderData call window.revtrail for goals and for the
  // checkout attribution ids. Dropping the alias silently turned both off on those sites.
  it('window.revtrail is the same function as window.founderdata', () => {
    const t = load();
    expect(t.window.revtrail).toBe(t.window.founderdata);
    expect(t.window.revtrail.attribution).toBe(t.ml.attribution);
  });

  it('runs calls queued on window.revtrail', () => {
    const t = load({ queueGlobal: 'revtrail', queue: [['consent', true]] });
    expect(t.jar.get('rt_consent')).toBe('1');
  });
});

describe('tracker: minilytics names', () => {
  it('window.minilytics is the same function as window.founderdata', () => {
    const t = load();
    expect(t.window.minilytics).toBe(t.window.founderdata);
    expect(t.window.minilytics.attribution).toBe(t.ml.attribution);
  });

  it('runs calls queued on window.minilytics', () => {
    const t = load({ legacyQueue: true, queue: [['consent', true]] });
    expect(t.jar.get('rt_consent')).toBe('1');
    expect(t.requests[0].vid).toBe(t.jar.get('rt_vid'));
  });

  it('migrates consented ml_* cookies to rt_* once, keeping the visitor and session', () => {
    const t = load({ cookies: { ml_consent: '1', ml_vid: 'returning-visitor-1', ml_sid: 'session-0000001' } });
    expect(t.requests[0]).toMatchObject({ vid: 'returning-visitor-1', sid: 'session-0000001' });
    expect(t.jar.get('rt_vid')).toBe('returning-visitor-1');
    expect(t.jar.get('rt_consent')).toBe('1');
    expect([...t.jar.keys()].some((k) => k.startsWith('ml_'))).toBe(false);
  });

  it('keeps the visitor from an ml_vid cookie when the site sets data-cookies="on"', () => {
    const t = load({ attrs: { 'data-cookies': 'on' }, cookies: { ml_vid: 'returning-visitor-2' } });
    expect(t.requests[0].vid).toBe('returning-visitor-2');
    expect(t.jar.has('ml_vid')).toBe(false);
  });

  it('sends goals from data-rt-goal and the older data-ml-goal, with their properties', async () => {
    const t = load();
    await tick();
    t.click({ 'data-rt-goal': 'signup_click', 'data-rt-goal-plan': 'pro' });
    t.click({ 'data-ml-goal': 'pricing_click', 'data-ml-goal-plan': 'team' });
    expect(await t.beacons[0]).toMatchObject({ t: 'goal', n: 'signup_click', p: { plan: 'pro' } });
    expect(await t.beacons[1]).toMatchObject({ t: 'goal', n: 'pricing_click', p: { plan: 'team' } });
  });

  it('honours ?rt_ignore=true and the older ?ml_ignore=true', () => {
    for (const param of ['rt_ignore', 'ml_ignore']) {
      const t = load({ href: `https://example.com/?${param}=true` });
      expect(t.requests).toEqual([]);
      expect(t.store.get('rt_ignore')).toBe('1');
    }
    const t = load({ storage: { ml_ignore: '1' } });
    expect(t.requests).toEqual([]);
    expect(t.store.has('ml_ignore')).toBe(false);
  });
});

describe('tracker: Core Web Vitals', () => {
  const ALL = ['navigation', 'paint', 'largest-contentful-paint', 'layout-shift', 'event', 'first-input'];

  it('sends them once, on the ping when the page is first hidden, without a request of their own', async () => {
    const t = load({
      perf: {
        types: ALL,
        navigation: { responseStart: 182.4, activationStart: 0 },
        entries: {
          paint: [{ name: 'first-paint', startTime: 300 }, { name: 'first-contentful-paint', startTime: 412.6 }],
          'largest-contentful-paint': [{ startTime: 900 }, { startTime: 1650.2 }],
          'layout-shift': [{ startTime: 1000, value: 0.04, hadRecentInput: false }, { startTime: 1500, value: 0.03, hadRecentInput: false }],
        },
      },
    });
    await tick();
    // A later burst more than 1 s after the first is a new window; a shift right after input never counts.
    t.emit('layout-shift', { startTime: 4000, value: 0.05, hadRecentInput: false }, { startTime: 4100, value: 0.5, hadRecentInput: true });
    // Two events of one interaction count once, at the longest; the slowest interaction is the INP below 50.
    t.emit('event', { interactionId: 7, duration: 120 }, { interactionId: 7, duration: 180 }, { interactionId: 0, duration: 900 });
    t.emit('first-input', { interactionId: 9, duration: 64 });
    const before = t.requests.length;
    t.hide();
    expect(t.requests.length).toBe(before);
    const sent = await Promise.all(t.beacons);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'ping', vid: SERVER_IDS.vid, v: { t: 182, f: 413, l: 1650, c: 0.07, i: 180, p: '/pricing' } });
    // Back and hidden again: engaged time only.
    t.show();
    t.hide();
    expect((await Promise.all(t.beacons)).slice(1).every((b) => b.v === undefined)).toBe(true);
  });

  it('a page loaded in a background tab sends no paint times', async () => {
    const t = load({
      hidden: true,
      perf: { types: ALL, navigation: { responseStart: 90 }, entries: { paint: [{ name: 'first-contentful-paint', startTime: 50 }], 'largest-contentful-paint': [{ startTime: 70 }] } },
    });
    await tick();
    t.show();
    t.hide();
    const [ping] = await Promise.all(t.beacons);
    expect(ping.v).toEqual({ t: 90, c: 0, p: '/pricing' });
  });

  it('sends nothing extra in a browser without PerformanceObserver', async () => {
    const t = load();
    await tick();
    t.hide();
    expect(t.beacons).toHaveLength(0);
    expect(t.requests).toHaveLength(1);
  });

  it('the minified build tracks the same pageview and vitals', async () => {
    expect(MINIFIED.length).toBeLessThan(CODE.length * 0.7);
    expect(MINIFIED.startsWith('/*! FounderData tracker')).toBe(true);
    const t = load({ code: MINIFIED, perf: { types: ALL, navigation: { responseStart: 100 } } });
    expect(t.requests[0]).toMatchObject({ w: 'site123', t: 'pageview', u: 'https://example.com/pricing' });
    await tick();
    t.hide();
    expect((await Promise.all(t.beacons))[0]).toMatchObject({ t: 'ping', v: { t: 100, c: 0, p: '/pricing' } });
  });
});

describe('tracker: config from the server', () => {
  const REC = { mask: '[data-fd-mask]', block: '[data-fd-block]', v: '7' };

  it('loads nothing more and sends no activity when the answer has no cfg', async () => {
    const t = load();
    t.press(el('button', 'Buy'));
    await tick();
    t.hide();
    expect(t.scripts).toEqual([]);
    expect((t.ml as any)._rec).toBeUndefined();
    expect((await Promise.all(t.beacons)).every((b) => b.a === undefined)).toBe(true);
  });

  it('rec loads /js/replay.js once and hands it the visit in window.founderdata._rec', async () => {
    const t = load({ cfg: { rec: REC } });
    await tick();
    expect(t.scripts).toHaveLength(1);
    expect(t.scripts[0]).toMatchObject({ async: true, src: 'https://stats.example/js/replay.js?v=7' });
    expect((t.window.founderdata as any)._rec).toEqual({ site: 'site123', sid: SERVER_IDS.sid, host: 'https://stats.example', url: 'https://stats.example/api/rec', cfg: REC });
    t.ml('pageview');
    await tick();
    expect(t.scripts).toHaveLength(1);
  });

  it('reports a recorder that cannot load once, to the upload route, with nothing about the visitor', async () => {
    const t = load({ cfg: { rec: REC } });
    await tick();
    const sent = t.urls.length;
    t.scripts[0].onerror();
    await tick();
    expect(t.urls.slice(sent)).toEqual([`https://stats.example/api/rec/site123?s=${SERVER_IDS.sid}&h=blocked`]);
    expect(t.requests.at(-1)).toBe(1);
  });

  it('sends chunks next to a proxied data-api endpoint', async () => {
    const t = load({ cfg: { rec: REC }, attrs: { 'data-api': 'https://acme.example/fd/api/event', 'data-cookies': 'on' } });
    await tick();
    expect((t.ml as any)._rec).toMatchObject({ url: 'https://acme.example/fd/api/rec', sid: t.jar.get('rt_sid') });
  });

  it('sends the clicks, rage clicks and errors of a recorded page with the ping when it is hidden', async () => {
    const t = load({ cfg: { rec: REC } });
    // Before the answer arrives: kept, in case the server records the visit.
    t.press(el('button', '  Start\n trial  '));
    await tick();
    const buy = el('button', 'Buy', { classList: ['buy', 'big'] } as any);
    for (let i = 0; i < 4; i++) t.press(buy);
    t.press(el('a', 'Pricing', { href: 'https://example.com/pricing' }));
    t.press(el('div', 'Not a control'));
    t.press(el('button', 'Anna Example', { masked: true }));
    t.press(el('input', '', { type: 'submit', form: {}, attrs: { 'aria-label': 'Send' } }));
    // A button with a masked name, an editable part, a field and hidden text in it: only the rest is its label.
    t.press(
      el('button', 'Hello', {
        kids: [el('span', 'Anna Example', { masked: true }), el('span', 'typed', { isContentEditable: true }), el('input', ''), el('span', 'secret', { attrs: { hidden: '' } }), el('b', 'there')],
      }),
    );
    t.fire('error', { message: 'TypeError: x is undefined', filename: 'https://example.com/app.js?v=3', lineno: 12 });
    t.fire('error', { message: 'TypeError: x is undefined', filename: 'https://example.com/app.js?v=3', lineno: 12 });
    t.fire('unhandledrejection', { reason: new Error('fetch failed') });
    t.hide();
    const [ping] = await Promise.all(t.beacons);
    expect(ping).toMatchObject({ t: 'ping', vid: SERVER_IDS.vid });
    expect(ping.a.p).toBe('/pricing');
    expect(typeof ping.a.s).toBe('number');
    // A rage click names its element by tag and first class, never by text.
    expect(ping.a.c[1].s).toBe('button.buy');
    expect(ping.a.c.map((c: any) => [c.l, c.k, c.n, c.r])).toEqual([
      ['Start trial', 'button', undefined, undefined],
      ['Buy', 'button', 4, 1],
      ['Pricing', 'link', undefined, undefined],
      ['button', 'button', undefined, undefined],
      ['Send', 'submit', undefined, undefined],
      ['Hello there', 'button', undefined, undefined],
    ]);
    expect(ping.a.e).toEqual([
      { t: expect.any(Number), m: 'TypeError: x is undefined', s: 'https://example.com/app.js:12' },
      { t: expect.any(Number), m: 'fetch failed', s: '' },
    ]);
    // Sent once: the next hide carries engaged time only.
    t.show();
    t.hide();
    expect((await Promise.all(t.beacons)).slice(1).every((b) => b.a === undefined)).toBe(true);
  });

  it('sends a page\'s activity when a single-page app moves on, with that page\'s path', async () => {
    const t = load({ cfg: { rec: REC } });
    await tick();
    t.press(el('button', 'Next'));
    t.window.location.pathname = '/checkout';
    t.window.history.pushState();
    await tick();
    const ping = t.requests.find((r) => r.t === 'ping');
    expect(ping.a).toMatchObject({ p: '/pricing', c: [{ l: 'Next', k: 'button' }] });
    expect(t.requests.at(-1)).toMatchObject({ t: 'pageview', u: 'https://example.com/checkout' });
  });

  it('rec.x: a page on the list loads no recorder and sends no clicks or errors, also those from before the answer', async () => {
    const t = load({ cfg: { rec: { ...REC, x: ['/dashboard', '/account/'] } }, href: 'https://example.com/dashboard/clients' });
    t.press(el('button', 'Anna Example'));
    await tick();
    t.press(el('button', 'Delete client'));
    t.fire('error', { message: 'TypeError: client 42 is undefined', filename: 'https://example.com/app.js', lineno: 3 });
    t.hide();
    expect(t.scripts).toEqual([]);
    expect(t.requests[0]).toMatchObject({ t: 'pageview', u: 'https://example.com/dashboard/clients' });
    const sent = JSON.stringify([...t.requests, ...(await Promise.all(t.beacons))]);
    expect(sent).not.toMatch(/Anna|Delete client|client 42/);
    const account = load({ cfg: { rec: { ...REC, x: ['/dashboard', '/account/'] } }, href: 'https://example.com/account/' });
    await tick();
    expect(account.scripts).toEqual([]);
  });

  it('rec.x in a single-page app: activity stops on a listed page and comes back on the next one, matched by whole path segments', async () => {
    const t = load({ cfg: { rec: { ...REC, x: ['/dashboard'] } } });
    await tick();
    expect(t.scripts).toHaveLength(1);
    t.press(el('button', 'Open dashboard'));
    const go = async (path: string) => {
      t.window.location.pathname = path;
      t.window.history.pushState();
      await tick();
    };
    // The dashboard throws while it renders, before the tracker has seen the new page.
    t.window.location.pathname = '/dashboard';
    t.fire('error', { message: 'TypeError: client 42 is undefined', filename: 'https://example.com/app.js', lineno: 3 });
    t.window.history.pushState();
    await tick();
    t.press(el('button', 'Delete client'));
    t.fire('unhandledrejection', { reason: new Error('Anna Example not found') });
    await go('/dashboards');
    t.press(el('button', 'Compare'));
    t.hide();
    const pings = [...t.requests, ...(await Promise.all(t.beacons))].filter((r) => r.a);
    expect(pings.map((p) => [p.a.p, p.a.c.map((c: any) => c.l), p.a.e])).toEqual([
      ['/pricing', ['Open dashboard'], undefined],
      ['/dashboards', ['Compare'], undefined],
    ]);
    expect(JSON.stringify(t.requests)).not.toMatch(/Delete client|client 42|Anna/);
    expect(t.requests.filter((r) => r.t === 'pageview').map((r) => r.u)).toEqual([
      'https://example.com/pricing',
      'https://example.com/dashboard',
      'https://example.com/dashboards',
    ]);
  });

  it('drops the oldest clicks to keep the ping under 8 KB', async () => {
    const t = load({ cfg: { rec: REC }, href: `https://example.com/pricing?q=${'x'.repeat(6500)}` });
    await tick();
    for (let i = 0; i < 30; i++) t.press(el('button', `Button number ${i} with a long label`));
    t.hide();
    const [ping] = await Promise.all(t.beacons);
    expect(JSON.stringify(ping).length).toBeLessThanOrEqual(8000);
    expect(ping.a.c.length).toBeLessThan(30);
    expect(ping.a.c.at(-1).l).toBe('Button number 29 with a long label');
  });

  it('rm keeps the visitor in cookies with rt_consent=r, and a later answer without it removes them', async () => {
    const t = load({ cfg: { rm: 1 } });
    await tick();
    expect(t.jar.get('rt_vid')).toBe(SERVER_IDS.vid);
    expect(t.jar.get('rt_sid')).toBe(SERVER_IDS.sid);
    expect(t.jar.get('rt_consent')).toBe('r');
    const next = load({ cookies: Object.fromEntries(t.jar) });
    expect(next.requests[0]).toMatchObject({ vid: SERVER_IDS.vid, sid: SERVER_IDS.sid });
    await tick();
    expect(next.jar.size).toBe(0);
  });

  it('rm leaves real consent alone, and a page that said no stays without cookies', async () => {
    const consented = load({ cfg: {}, cookies: { rt_consent: '1', rt_vid: 'returning-visitor-1', rt_sid: 'session-0000001' } });
    await tick();
    expect(consented.jar.get('rt_consent')).toBe('1');
    const refused = load({ cfg: { rm: 1 }, queue: [['consent', false]] });
    await tick();
    expect(refused.jar.size).toBe(0);
  });

  it('rec.c waits for consent: nothing loads or is sent until founderdata(\'consent\', true), then it records the same visit', async () => {
    const t = load({ cfg: { rec: { ...REC, c: 1 }, rm: 1 } });
    await tick();
    t.press(el('button', 'Buy'));
    // Remember visitors keeps an id, but that is not the visitor's consent.
    expect(t.jar.get('rt_consent')).toBe('r');
    expect(t.scripts).toEqual([]);
    expect((t.ml as any)._rec).toBeUndefined();
    t.ml('consent', true);
    expect(t.scripts).toHaveLength(1);
    expect((t.ml as any)._rec).toMatchObject({ sid: SERVER_IDS.sid, cfg: { c: 1 } });
    t.hide();
    // The click before consent is not sent.
    expect((await Promise.all(t.beacons)).every((b) => b.a === undefined)).toBe(true);
  });

  it('rec.c records at once when the visitor consented before, with data-cookies="on" or the rt_consent cookie', async () => {
    const t = load({ cfg: { rec: { ...REC, c: 1 } }, attrs: { 'data-cookies': 'on' } });
    await tick();
    expect(t.scripts).toHaveLength(1);
    const back = load({ cfg: { rec: { ...REC, c: 1 } }, cookies: { rt_consent: '1', rt_vid: 'returning-visitor-1', rt_sid: 'session-0000001' } });
    await tick();
    expect(back.scripts).toHaveLength(1);
  });

  it('the minified build loads the recorder and sends activity the same way', async () => {
    const t = load({ code: MINIFIED, cfg: { rec: REC } });
    await tick();
    t.press(el('button', 'Buy'));
    t.hide();
    expect(t.scripts[0].src).toBe('https://stats.example/js/replay.js?v=7');
    expect((await Promise.all(t.beacons))[0].a.c[0]).toMatchObject({ l: 'Buy', k: 'button' });
    const skipped = load({ code: MINIFIED, cfg: { rec: { ...REC, x: ['/pricing'] } } });
    await tick();
    skipped.press(el('button', 'Buy'));
    skipped.hide();
    expect(skipped.scripts).toEqual([]);
    expect((await Promise.all(skipped.beacons)).every((b) => b.a === undefined)).toBe(true);
  });
});

describe('tracker: identify()', () => {
  it('sends extra keys as traits next to the user id, email and name', async () => {
    const t = load();
    await tick();
    t.ml('identify', { id: 'u_42', email: 'anna@acme.example', name: 'Anna', plan: 'pro', seats: 3 });
    await tick();
    const call = t.requests.find((r) => r.t === 'identify');
    expect(call.p).toEqual({ user_id: 'u_42', email: 'anna@acme.example', name: 'Anna', plan: 'pro', seats: 3 });
  });
});
