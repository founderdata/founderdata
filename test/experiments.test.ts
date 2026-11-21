// Round 7, lane exp, core part (plan 5.2): the variant assignment, the page rule, exposure on the visit at the free
// plan's cost, and the tracker's flag commands and variant elements.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/worker/index';
import { resetBudgetForTests } from '../src/worker/budget';
import { forgetSite } from '../src/worker/env';
import { installPro, proHooks, type Pro } from '../src/worker/pro-hooks';
import { assign, decide, experimentsPart, fnv1a, parseExpLive, pathMatches } from '../src/worker/experiments';
import { CORE_PARTS } from '../src/worker/core-parts';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const LIVE = '[{"k":"pricing_headline","v":[["control",50],["b",50]],"p":["/pricing"]},{"k":"new_nav","v":[["off",90],["on",10]]}]';

describe('experiments: assignment', () => {
  const ids = Array.from({ length: 20_000 }, (_, i) => `visitor-${i}-${(i * 2654435761) % 1e9}`);

  it('gives one visitor the same variant every time', () => {
    const v = [['control', 50], ['b', 50]] as [string, number][];
    for (const id of ids.slice(0, 200)) expect(assign('pricing_headline', id, v)).toBe(assign('pricing_headline', id, v));
  });

  it('splits 50/50 within 2% over 20,000 visitor ids', () => {
    const v = [['control', 50], ['b', 50]] as [string, number][];
    const b = ids.filter((id) => assign('pricing_headline', id, v) === 'b').length / ids.length;
    expect(Math.abs(b - 0.5)).toBeLessThan(0.02);
  });

  it('honours weights, 3 variants and a flag rollout', () => {
    const three = [['control', 50], ['b', 25], ['c', 25]] as [string, number][];
    const n = { control: 0, b: 0, c: 0 } as Record<string, number>;
    for (const id of ids) n[assign('headline', id, three)]++;
    expect(Math.abs(n.control / ids.length - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(n.b / ids.length - 0.25)).toBeLessThan(0.02);
    expect(Math.abs(n.c / ids.length - 0.25)).toBeLessThan(0.02);
    const on = ids.filter((id) => assign('new_checkout', id, [['off', 90], ['on', 10]]) === 'on').length / ids.length;
    expect(Math.abs(on - 0.1)).toBeLessThan(0.02);
    expect(ids.every((id) => assign('x', id, [['off', 100], ['on', 0]]) === 'off')).toBe(true);
  });

  it('splits two experiments independently of each other', () => {
    const v = [['control', 50], ['b', 50]] as [string, number][];
    const both = ids.filter((id) => assign('one', id, v) === 'b' && assign('two', id, v) === 'b').length / ids.length;
    expect(Math.abs(both - 0.25)).toBeLessThan(0.02);
  });

  it('hashes with FNV-1a', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('matches pages the way never-record pages do', () => {
    expect(pathMatches('/pricing', ['/pricing'])).toBe(true);
    expect(pathMatches('/pricing/annual', ['/pricing'])).toBe(true);
    expect(pathMatches('/pricing?plan=pro', ['/pricing'])).toBe(true);
    expect(pathMatches('/pricing-old', ['/pricing'])).toBe(false);
    expect(pathMatches('/blog/a', ['/pricing', '/blog'])).toBe(true);
    expect(pathMatches('/anything', null)).toBe(true);
    expect(pathMatches('/anything', [])).toBe(true);
    expect(pathMatches('/anything', ['/'])).toBe(true);
  });

  it('reads sites.exp_live and leaves out entries that would break a pageview', () => {
    expect(parseExpLive(null)).toEqual([]);
    expect(parseExpLive('not json')).toEqual([]);
    expect(parseExpLive(LIVE)).toEqual([
      { k: 'pricing_headline', v: [['control', 50], ['b', 50]], p: ['/pricing'] },
      { k: 'new_nav', v: [['off', 90], ['on', 10]] },
    ]);
    const bad = JSON.stringify([
      { k: 'Bad Key', v: [['a', 1], ['b', 1]] },
      { k: 'one_arm', v: [['a', 1]] },
      { k: 'all_zero', v: [['a', 0], ['b', 0]] },
      { k: 'ok', v: [['a', 1], ['b', 1]], p: [3] },
    ]);
    expect(parseExpLive(bad)).toEqual([{ k: 'ok', v: [['a', 1], ['b', 1]] }]);
    const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ k: `e${i}`, v: [['a', 1], ['b', 1]] })));
    expect(parseExpLive(many)).toHaveLength(10);
  });

  it('decides the experiments a page enters', () => {
    const live = parseExpLive(LIVE);
    expect(Object.keys(decide(live, 'v1', '/pricing')!).sort()).toEqual(['new_nav', 'pricing_headline']);
    expect(Object.keys(decide(live, 'v1', '/about')!)).toEqual(['new_nav']);
    expect(decide(parseExpLive('[{"k":"a","v":[["x",1],["y",1]],"p":["/pricing"]}]'), 'v1', '/about')).toBeNull();
  });

  it('is a core part: emptied with the site, exported, explained to agents', () => {
    expect(CORE_PARTS[0]).toBe(experimentsPart);
    expect(experimentsPart.siteTables).toEqual(['experiments']);
    expect(Object.keys(experimentsPart.exports ?? {})).toEqual(['experiments']);
    expect(experimentsPart.definitions?.experiments).toMatch(/00:00 UTC/);
  });
});

describe('experiments: exposure on the visit', () => {
  let w: TestWorker;
  let site: any;
  let before: ReturnType<typeof proHooks>;
  const event = (body: Record<string, unknown>, p = '/pricing', ip = '198.51.100.70') =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': ip },
      body: JSON.stringify({ w: site.id, u: `https://exp.example${p}`, sw: 1440, t: 'pageview', ...body }),
    });
  const rows = async (fn: () => Promise<unknown>) => {
    w.takeRowsWritten();
    await fn();
    await w.flush();
    return w.takeRowsWritten();
  };
  const props = async (sid: string) => {
    const r = await w.db.prepare('SELECT props FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, sid).first<{ props: string | null }>();
    return r?.props ? JSON.parse(r.props) : null;
  };

  beforeAll(async () => {
    resetBudgetForTests(Infinity);
    before = proHooks();
    w = await startWorker();
    site = await w.createSite({ domain: 'exp.example' });
    // Pro's hook is these core functions over sites.exp_live (pro/worker/experiments.ts decideExperiments).
    installPro({ ...(before ?? {}), experimentDecision: (s, vid, p) => decide(parseExpLive(s.exp_live), vid, p) } as Pro);
    await w.db.prepare('UPDATE sites SET exp_live = ? WHERE id = ?').bind(LIVE.replace(',{"k":"new_nav","v":[["off",90],["on",10]]}', ''), site.id).run();
    forgetSite(site.id);
  });
  afterAll(async () => {
    installPro(before);
    await w.dispose();
  });

  it('writes the variant on a new visit at no extra row, the one assign() picks', async () => {
    const plain = await rows(() => event({ vid: 'expvisitor0001', sid: 'expsession0001' }, '/'));
    let res: Response | null = null;
    const n = await rows(async () => (res = await event({ vid: 'expvisitor0002', sid: 'expsession0002' })));
    expect(n).toBe(plain);
    const want = assign('pricing_headline', 'expvisitor0002', [['control', 50], ['b', 50]]);
    expect(await res!.json()).toEqual({ cfg: { x: { pricing_headline: want } } });
    expect(await props('expsession0002')).toEqual({ exp_pricing_headline: want });
    expect(await props('expsession0001')).toBeNull();
  });

  it('writes 1 row the first time a running visit reaches the page, none after', async () => {
    const plain = await rows(() => event({ vid: 'expvisitor0003', sid: 'expsession0003' }, '/about'));
    const again = await rows(() => event({ vid: 'expvisitor0003', sid: 'expsession0003' }, '/features'));
    const first = await rows(() => event({ vid: 'expvisitor0003', sid: 'expsession0003' }, '/pricing'));
    expect(first).toBe(again + 1);
    const later = await rows(() => event({ vid: 'expvisitor0003', sid: 'expsession0003' }, '/pricing/annual'));
    expect(later).toBe(again);
    expect(plain).toBeGreaterThan(again);
    expect(Object.keys(await props('expsession0003'))).toEqual(['exp_pricing_headline']);
  });

  it('stores nothing for a preview (xp: 1)', async () => {
    const res = await event({ vid: 'expvisitor0004', sid: 'expsession0004', xp: 1 });
    expect(await res.text()).toBe('');
    expect(await props('expsession0004')).toBeNull();
  });

  it('assigns a cookieless visitor from the id the server derives', async () => {
    const res = await event({}, '/pricing', '198.51.100.71');
    const body = (await res.json()) as { vid: string; sid: string; cfg: { x: Record<string, string> } };
    expect(body.cfg.x.pricing_headline).toBe(assign('pricing_headline', body.vid, [['control', 50], ['b', 50]]));
    expect(await props(body.sid)).toEqual({ exp_pricing_headline: body.cfg.x.pricing_headline });
  });

  it('assigns nothing to a visit from a hosting network', async () => {
    const req = new Request('http://localhost/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '3.3.3.3' },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: 'https://exp.example/pricing', vid: 'expvisitor0005', sid: 'expsession0005' }),
    });
    Object.defineProperty(req, 'cf', { value: { asn: 16509 } });
    const res = await app.fetch(req, w.env as any, { waitUntil() {}, passThroughOnException() {}, props: {} } as any);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    const s = await w.db.prepare('SELECT datacenter, props FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, 'expsession0005').first<any>();
    expect(s).toEqual({ datacenter: 1, props: null });
  });

  it('empties the table with the site', async () => {
    const other = await w.createSite({ domain: 'exp-gone.example' });
    await w.db
      .prepare("INSERT INTO experiments (site_id, key, kind, name, variants, status, created_at, updated_at) VALUES (?, 'a', 'flag', 'A', '[]', 'draft', 1, 1)")
      .bind(other.id)
      .run();
    expect((await w.admin(`/api/sites/${other.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE site_id = ?').bind(other.id).first('n')).toBe(0);
  });
});

// ---------- the tracker (public/js/script.js, region experiments) in a VM with a fake page

const CODE = fs.readFileSync(path.resolve(__dirname, '../public/js/script.js'), 'utf8');
const MINIFIED = transformSync(CODE, { minify: true, legalComments: 'inline', target: 'es2017' }).code;

interface Part {
  attrs: Record<string, string>;
  hidden: boolean;
  getAttribute(n: string): string | null;
}
const part = (exp: string, variant: string, hidden = false): Part => {
  const attrs: Record<string, string> = { 'data-fd-exp': exp, 'data-fd-variant': variant };
  return { attrs, hidden, getAttribute: (n) => attrs[n] ?? null };
};

function page(o: { href?: string; cfg?: unknown[]; parts?: Part[]; blocked?: boolean; code?: string; queue?: unknown[][]; webdriver?: boolean } = {}) {
  const requests: any[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const errors: unknown[] = [];
  let answers = 0;
  const parts = o.parts ?? [];
  const document = {
    cookie: '',
    currentScript: {
      src: 'https://stats.example/js/script.js',
      getAttribute: (n: string) => (n === 'data-website-id' ? 'site123' : null),
      hasAttribute: () => false,
    },
    referrer: '',
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: {},
    head: { appendChild() {} },
    createElement: (tag: string) => ({ tagName: tag.toUpperCase() }),
    addEventListener() {},
    querySelectorAll: (sel: string) => (sel === '[data-fd-exp]' ? parts : []),
  };
  const window: any = {
    location: new URL(o.href ?? 'https://example.com/pricing'),
    navigator: { webdriver: !!o.webdriver },
    screen: { width: 1440 },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    crypto: globalThis.crypto,
  };
  if (o.queue) window.founderdata = Object.assign(() => {}, { q: o.queue });
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (o.blocked) return new Promise<Response>(() => {});
    const cfg = body.t === 'pageview' ? o.cfg?.[answers++] : undefined;
    return Response.json({ vid: 'v'.repeat(32), sid: 's'.repeat(32), ...(cfg ? { cfg } : {}) }, { status: 202 });
  };
  const ctx = vm.createContext({
    window,
    document,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch,
    screen: window.screen,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    Blob,
    Response,
    console: { error: (e: unknown) => errors.push(e) },
    setTimeout: (fn: (...a: unknown[]) => void, ms: number, ...a: unknown[]) =>
      ms >= 1000 ? timers.push({ fn: () => fn(...a), ms }) : setTimeout(fn, ms, ...a),
    setInterval: () => 0,
  });
  vm.runInContext(o.code ?? CODE, ctx);
  const fd = window.founderdata as (...a: unknown[]) => any;
  const runTimers = () => timers.splice(0).forEach((t) => t.fn());
  return { fd, requests, parts, runTimers, window, errors };
}
const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

for (const [name, code] of [['source', CODE], ['minified', MINIFIED]] as const) {
  describe(`tracker experiments (${name})`, () => {
    it('shows the assigned variant and hides the others, once the answer arrives', async () => {
      const t = page({ code, cfg: [{ x: { pricing_headline: 'b' } }], parts: [part('pricing_headline', 'control'), part('pricing_headline', 'b', true), part('other', 'b', true)] });
      expect(t.requests[0].xp).toBeUndefined();
      expect(t.fd('flag', 'pricing_headline')).toBeNull();
      await tick();
      expect(t.parts.map((p) => p.hidden)).toEqual([true, false, true]);
      expect(t.fd('flag', 'pricing_headline')).toBe('b');
      expect(t.fd('flag', 'other')).toBeNull();
      expect(t.errors).toEqual([]);
    });

    it('leaves the page as written without an assignment: the control shows', async () => {
      const t = page({ code, parts: [part('pricing_headline', 'control'), part('pricing_headline', 'b', true)] });
      await tick();
      expect(t.parts.map((p) => p.hidden)).toEqual([false, true]);
    });

    it('applies the next answer after a single-page navigation', async () => {
      const t = page({ code, cfg: [{ x: { pricing_headline: 'b' } }, { x: { pricing_headline: 'control' } }], parts: [part('pricing_headline', 'control'), part('pricing_headline', 'b', true)] });
      await tick();
      expect(t.parts.map((p) => p.hidden)).toEqual([true, false]);
      t.window.location = new URL('https://example.com/pricing/annual');
      t.fd('pageview');
      await tick();
      expect(t.parts.map((p) => p.hidden)).toEqual([false, true]);
    });

    it('previews ?fd_exp=key:variant at once, and the pageview says xp: 1 so no exposure is stored', async () => {
      const t = page({ code, href: 'https://example.com/pricing?fd_exp=pricing_headline:b', parts: [part('pricing_headline', 'control'), part('pricing_headline', 'b', true)] });
      expect(t.requests[0].xp).toBe(1);
      expect(t.parts.map((p) => p.hidden)).toEqual([true, false]);
      await tick();
      expect(t.parts.map((p) => p.hidden)).toEqual([true, false]);
      expect(t.fd('flag', 'pricing_headline')).toBe('b');
      const enc = page({ code, href: 'https://example.com/pricing?fd_exp=pricing_headline%3Acontrol' });
      expect(enc.requests[0].xp).toBe(1);
      expect(page({ code, href: 'https://example.com/pricing?fd_exp=Bad' }).requests[0].xp).toBeUndefined();
    });

    it('flags(fn) calls back once with the variants after the answer, at once after it', async () => {
      const t = page({ code, cfg: [{ x: { new_checkout: 'on' } }] });
      const got: unknown[] = [];
      t.fd('flags', (x: unknown) => got.push({ ...(x as object) }));
      expect(got).toEqual([]);
      await tick();
      expect(got).toEqual([{ new_checkout: 'on' }]);
      t.runTimers();
      expect(got).toHaveLength(1);
      t.fd('flags', (x: unknown) => got.push({ ...(x as object) }));
      expect(got).toHaveLength(2);
    });

    it('flags(fn) calls back after 2 s with {} when the answer never comes (blocked)', async () => {
      const t = page({ code, blocked: true });
      const got: unknown[] = [];
      t.fd('flags', (x: unknown) => got.push({ ...(x as object) }));
      await tick();
      expect(got).toEqual([]);
      t.runTimers();
      expect(got).toEqual([{}]);
      expect(t.fd('flag', 'new_checkout')).toBeNull();
    });

    it('after a single-page navigation, flags waits for the new page\'s answer and keeps earlier variants', async () => {
      // The visitor lands on / (outside the experiment), then a client-side link opens /pricing, which enters it.
      const t = page({ code, href: 'https://example.com/', cfg: [{ x: { new_checkout: 'on' } }, { x: { pricing_headline: 'b' } }] });
      await tick();
      t.window.location.href = 'https://example.com/pricing'; // the same location object, as in a browser
      t.window.history.pushState({}, '', '/pricing');
      const got: unknown[] = [];
      t.fd('flags', (x: unknown) => got.push({ ...(x as object) })); // the component mounts before the pageview
      expect(got).toEqual([]);
      expect(t.fd('flag', 'pricing_headline')).toBeNull();
      await tick();
      expect(t.requests.filter((r) => r.t === 'pageview')).toHaveLength(2);
      expect(got).toEqual([{ new_checkout: 'on', pricing_headline: 'b' }]);
      expect(t.fd('flag', 'pricing_headline')).toBe('b');
      expect(t.fd('flag', 'new_checkout')).toBe('on');
    });

    it('a flags callback that throws leaves the rest of the config applied and the other callbacks called', async () => {
      const t = page({ code, cfg: [{ x: { new_checkout: 'on' } }], parts: [part('new_checkout', 'off'), part('new_checkout', 'on', true)] });
      const got: string[] = [];
      const uncaught: unknown[] = [];
      const onErr = (e: unknown) => uncaught.push(e);
      process.on('uncaughtException', onErr);
      try {
        t.fd('flags', (x: Record<string, string>) => (x as any).missing.toUpperCase());
        t.fd('flags', (x: Record<string, string>) => got.push(x.new_checkout));
        await tick();
      } finally {
        process.off('uncaughtException', onErr);
      }
      expect(got).toEqual(['on']);
      expect(t.parts.map((p) => p.hidden)).toEqual([true, false]);
      expect(uncaught).toHaveLength(1); // the site's error still reaches the console
    });

    it('turned off (a test browser, rt_ignore, localhost): flags calls back with {} and flag answers null', async () => {
      const got: unknown[] = [];
      const t = page({ code, webdriver: true, queue: [['flags', (x: unknown) => got.push(x)]] });
      expect(t.requests).toEqual([]);
      t.fd('flags', (x: unknown) => got.push(x));
      expect(t.fd('flag', 'new_checkout')).toBeNull();
      await tick();
      expect(got).toEqual([{}, {}]);
      expect((t.fd as any).attribution()).toEqual({});
    });

    it('runs flags calls queued before the script loaded', async () => {
      const got: unknown[] = [];
      page({ code, cfg: [{ x: { new_checkout: 'off' } }], queue: [['flags', (x: Record<string, string>) => got.push(x.new_checkout)]] });
      expect(got).toEqual([]);
      await tick();
      expect(got).toEqual(['off']);
    });
  });
}
