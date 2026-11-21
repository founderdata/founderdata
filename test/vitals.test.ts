// Core Web Vitals (src/worker/vitals.ts): stored from the tracker's hide ping, read as p75 and ratings per page and device.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertVitals, MIN_SAMPLE, parseVitals, vitalsReport } from '../src/worker/vitals';
import { pruneOldData } from '../src/worker/retention';
import { forgetSite } from '../src/worker/env';
import { startWorker, type TestWorker } from './helpers/worker';

const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

describe('Core Web Vitals', () => {
  let w: TestWorker;
  let site: any;
  let key = '';
  const ping = (v: unknown, opts: { ua?: string; u?: string; ip?: string } = {}) =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': opts.ua ?? DESKTOP, 'cf-connecting-ip': opts.ip ?? '198.51.100.7', cookie: '' },
      body: JSON.stringify({ w: site.id, t: 'ping', u: opts.u ?? 'https://vitals.example/pricing', d: 400, sw: 1440, v }),
    });
  const read = (q = '') => w.fetch(`/api/v1/vitals${q}`, { headers: { cookie: '', authorization: `Bearer ${key}` } }).then(async (r) => ({ status: r.status, body: await r.json<any>() }));

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'vitals.example' });
    key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'speed', scopes: ['read'], sites: [site.id] } })).body.key;
  });
  afterAll(() => w.dispose());

  it('checks and rounds what the tracker sends, and drops broken values', () => {
    expect(parseVitals({ l: 1650.4, i: 180, c: 0.071234, t: 182.6, f: 412.5, p: '/x' })).toEqual({ lcp: 1650, inp: 180, cls: 0.0712, ttfb: 183, fcp: 413 });
    expect(parseVitals({ l: -1, i: 'slow', c: 99, t: Infinity })).toBeNull();
    expect(parseVitals({ l: 900_000, f: 300 })).toEqual({ lcp: null, inp: null, cls: null, ttfb: null, fcp: 300 });
    expect(parseVitals(null)).toBeNull();
    expect(parseVitals([1, 2])).toBeNull();
  });

  it('stores one row per beacon with the page and device, and no visitor or session id', async () => {
    expect((await ping({ l: 1200, c: 0.02, t: 150, f: 600, p: '/pricing' })).status).toBe(202);
    // After a single-page-app navigation the vitals still belong to the page that loaded.
    expect((await ping({ l: 3000, t: 400, f: 900, p: '/' }, { ua: PHONE, u: 'https://vitals.example/after-navigation' })).status).toBe(202);
    // A ping without vitals stores none.
    await ping(undefined);
    const rows = (await w.db.prepare('SELECT * FROM vitals WHERE site_id = ? ORDER BY path').bind(site.id).all<any>()).results;
    expect(rows.map((r) => [r.path, r.device, r.lcp, r.inp, r.cls, r.ttfb, r.fcp])).toEqual([
      ['/', 'Mobile', 3000, null, null, 400, 900],
      ['/pricing', 'Desktop', 1200, null, 0.02, 150, 600],
    ]);
    // scroll (migration 0090): the deepest scroll of the page load, a number on the same anonymous row.
    expect(Object.keys(rows[0]).sort()).toEqual(['cls', 'device', 'fcp', 'id', 'inp', 'lcp', 'path', 'scroll', 'site_id', 'ts', 'ttfb']);
  });

  it('answers null with the count below the minimum sample, never a made-up p75', async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.min_sample).toBe(MIN_SAMPLE);
    expect(body.overall.page_loads).toBe(2);
    expect(body.overall.lcp).toEqual({ p75: null, samples: 2, good: null, needs_improvement: null, poor: null, rating: null });
    expect(body.overall.inp.samples).toBe(0);
    expect(body.pages.map((p: any) => p.path).sort()).toEqual(['/', '/pricing']);
    expect(body.total_pages).toBe(2);
  });

  it('computes the nearest-rank p75 and the shares by Google\'s thresholds', async () => {
    // 40 loads of /fast on desktop: LCP 100, 200, ... 4000 ms. p75 is the 30th value, 3000 ms.
    const now = Date.now();
    const stmts = Array.from({ length: 40 }, (_, i) =>
      insertVitals(w.db, site, { lcp: (i + 1) * 100, inp: i < 30 ? 80 : 600, cls: 0.05, ttfb: 300, fcp: 900 }, '/fast', 'Desktop', now - i * 1000)!,
    );
    await w.db.batch(stmts);
    const { body } = await read('?path=/fast');
    expect(body.path).toBe('/fast');
    expect(body.pages).toBeUndefined();
    const lcp = body.overall.lcp;
    expect(lcp.p75).toBe(3000);
    expect(lcp.samples).toBe(40);
    // good <= 2500: 25 loads; poor > 4000: none; needs improvement 15.
    expect([lcp.good, lcp.needs_improvement, lcp.poor]).toEqual([0.625, 0.375, 0]);
    expect(lcp.rating).toBe('needs_improvement');
    expect(body.overall.inp).toMatchObject({ p75: 80, good: 0.75, poor: 0.25, rating: 'good' });
    expect(body.overall.cls).toMatchObject({ p75: 0.05, rating: 'good' });
    expect(body.devices).toEqual([expect.objectContaining({ device: 'Desktop', page_loads: 40 })]);
    // The whole site: /fast leads the pages by loads.
    const all = (await read('?limit=1')).body;
    expect(all.pages.map((p: any) => p.path)).toEqual(['/fast']);
    expect(all.total_pages).toBe(3);
  });

  it('shows on the content page detail', async () => {
    const r = await w.fetch(`/api/v1/content/page?path=/fast`, { headers: { cookie: '', authorization: `Bearer ${key}` } });
    const body = await r.json<any>();
    expect(r.status).toBe(200);
    expect(body.vitals).toMatchObject({ days: 28, page_loads: 40, lcp: { p75: 3000 } });
    expect(body.vitals.devices[0].device).toBe('Desktop');
  });

  it('refuses bad parameters', async () => {
    for (const q of ['?days=0', '?days=91', '?days=x', '?path=pricing', '?limit=0']) expect((await read(q)).status, q).toBe(400);
    expect((await w.fetch('/api/v1/vitals', { headers: { cookie: '' } })).status).toBe(401);
    expect((await w.admin(`/api/sites/${site.id}/vitals?days=7`)).status).toBe(200);
  });

  it('keeps the share the site samples, and none at 0', async () => {
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { vitals_sample: 101 } })).status).toBe(400);
    const off = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { vitals_sample: 0 } });
    expect(off.body.vitals_sample).toBe(0);
    forgetSite(site.id);
    const count = async () => (await w.db.prepare('SELECT COUNT(*) AS n FROM vitals WHERE site_id = ?').bind(site.id).first<any>()).n;
    const before = await count();
    expect((await ping({ l: 1000, p: '/off' })).status).toBe(202);
    expect(await count()).toBe(before);
    const half = { ...site, vitals_sample: 50 };
    const m = { lcp: 1, inp: null, cls: null, ttfb: null, fcp: null };
    expect(insertVitals(w.db, half, m, '/', null, 0, () => 0.49)).not.toBeNull();
    expect(insertVitals(w.db, half, m, '/', null, 0, () => 0.5)).toBeNull();
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { vitals_sample: 100 } });
    forgetSite(site.id);
  });

  it('deletes rows past 90 days, and every row with the site', async () => {
    const old = Date.now() - 91 * 86_400_000;
    await insertVitals(w.db, site, { lcp: 1, inp: null, cls: null, ttfb: null, fcp: null }, '/old', null, old)!.run();
    await pruneOldData(w.db);
    expect((await w.db.prepare("SELECT COUNT(*) AS n FROM vitals WHERE path = '/old'").first<any>()).n).toBe(0);
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM vitals WHERE site_id = ?').bind(site.id).first<any>()).n).toBeGreaterThan(0);
    await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' });
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM vitals WHERE site_id = ?').bind(site.id).first<any>()).n).toBe(0);
  });

  it('a site with no beacons gets zero loads and null numbers', async () => {
    const empty = await w.createSite({ domain: 'quiet.example' });
    const r = await vitalsReport(w.db, empty);
    expect(r.overall.page_loads).toBe(0);
    expect(r.overall.lcp.p75).toBeNull();
    expect(r.pages).toEqual([]);
    expect(r.devices).toEqual([]);
  });
});
