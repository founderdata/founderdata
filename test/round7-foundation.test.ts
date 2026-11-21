// Round 7's foundation (plan 5.1): with every new switch off the Worker answers and writes as before, a running
// experiment rides on writes that already happen, and the stubs the lanes fill accept their input and write nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { forgetSite } from '../src/worker/env';
import { installPro, proHooks, type Pro } from '../src/worker/pro-hooks';
import { exposureProps } from '../src/worker/experiments';
import { CORE_PARTS } from '../src/worker/core-parts';
import { BREAKDOWN_DIMS } from '../src/worker/mcp-kit';
import { BREAKDOWN_CARDS } from '../src/shared/dashboard-tabs';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';

describe('round 7 foundation', () => {
  let w: TestWorker;
  let site: any;
  const before = proHooks();
  const asked: { vid: string; path: string }[] = [];
  const event = (body: Record<string, unknown>, ip = '198.51.100.40', path = '/pricing') =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': ip },
      body: JSON.stringify({ w: site.id, u: `https://r7.example${path}`, sw: 1440, ...body }),
    });
  const rows = async (fn: () => Promise<unknown>) => {
    w.takeRowsWritten();
    await fn();
    await w.flush();
    return w.takeRowsWritten();
  };
  const props = async (sid: string) =>
    (await w.db.prepare('SELECT props FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, sid).first<{ props: string | null }>())?.props ?? null;
  const setLive = async (live: string | null) => {
    await w.db.prepare('UPDATE sites SET exp_live = ? WHERE id = ?').bind(live, site.id).run();
    forgetSite(site.id);
  };

  beforeAll(async () => {
    resetBudgetForTests(Infinity);
    w = await startWorker();
    site = await w.createSite({ domain: 'r7.example' });
    const fake: Pro = {
      ...(before ?? {}),
      // A stand-in for lane exp's hook: every page under /pricing enters pricing_headline, arm b.
      experimentDecision: (s, vid, path) => {
        asked.push({ vid, path });
        return path.startsWith('/pricing') ? { pricing_headline: 'b' } : null;
      },
    };
    installPro(fake);
  });
  afterAll(async () => {
    installPro(before);
    await w.dispose();
  });

  it('adds the site switches with every one off', async () => {
    const got = (await w.admin(`/api/sites/${site.id}`)).body;
    expect(got).toMatchObject({ errors_on: 0, maps_on: 0, map_sample: 100, surveys: null, exp_live: null });
    const vitals = await w.db.prepare("SELECT name FROM pragma_table_info('vitals') WHERE name = 'scroll'").first();
    expect(vitals).toEqual({ name: 'scroll' });
  });

  it('answers a pageview without cfg while every switch is off, and asks for no experiment', async () => {
    asked.length = 0;
    const cookie = await event({ t: 'pageview', vid: 'r7visitor00001', sid: 'r7session00001' });
    expect(cookie.status).toBe(202);
    expect(await cookie.text()).toBe('');
    const cookieless = await event({ t: 'pageview' }, '198.51.100.41');
    expect(Object.keys(await cookieless.json()).sort()).toEqual(['sid', 'vid']);
    // No exp_live on the site row: the hook is not asked.
    expect(asked).toEqual([]);
    expect(await props('r7session00001')).toBeNull();
  });

  it('stores a running experiment on a new visit at no extra row, and sends it back as cfg.x', async () => {
    const plain = await rows(() => event({ t: 'pageview', vid: 'r7visitor00002', sid: 'r7session00002' }));
    await setLive('[{"k":"pricing_headline","v":[["control",50],["b",50]],"p":["/pricing"]}]');
    let res: Response | null = null;
    const withExp = await rows(async () => (res = await event({ t: 'pageview', vid: 'r7visitor00003', sid: 'r7session00003' })));
    expect(withExp).toBe(plain);
    expect(await res!.json()).toEqual({ cfg: { x: { pricing_headline: 'b' } } });
    expect(JSON.parse((await props('r7session00003'))!)).toEqual({ exp_pricing_headline: 'b' });
    expect(asked.at(-1)).toEqual({ vid: 'r7visitor00003', path: '/pricing' });
  });

  it('stores it on a running visit once: 1 row the first time it reaches the page, none after', async () => {
    // The visit starts on the home page, outside the experiment.
    await rows(() => event({ t: 'pageview', vid: 'r7visitor00004', sid: 'r7session00004' }, '198.51.100.40', '/'));
    expect(await props('r7session00004')).toBeNull();
    const plain = await rows(() => event({ t: 'pageview', vid: 'r7visitor00004', sid: 'r7session00004' }, '198.51.100.40', '/features'));
    const first = await rows(() => event({ t: 'pageview', vid: 'r7visitor00004', sid: 'r7session00004' }));
    expect(first).toBe(plain + 1);
    expect(JSON.parse((await props('r7session00004'))!)).toEqual({ exp_pricing_headline: 'b' });
    const again = await rows(() => event({ t: 'pageview', vid: 'r7visitor00004', sid: 'r7session00004' }, '198.51.100.40', '/pricing/annual'));
    expect(again).toBe(plain);
  });

  it('stores no exposure for a preview and does not ask for one', async () => {
    asked.length = 0;
    const res = await event({ t: 'pageview', vid: 'r7visitor00005', sid: 'r7session00005', xp: 1 });
    expect(await res.text()).toBe('');
    expect(await props('r7session00005')).toBeNull();
    expect(asked).toEqual([]);
    await setLive(null);
  });

  it('keeps at most 10 session properties for a new visit', () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`e${i}`, 'b']));
    expect(Object.keys(JSON.parse(exposureProps(many)!))).toHaveLength(10);
    expect(exposureProps({ 'bad key': 'b', ok: '' })).toBeNull();
  });

  it('accepts survey answers: the answer and the trait (lane survey, test/surveys.test.ts)', async () => {
    const n = await rows(async () => {
      const r = await event({ t: 'survey', vid: 'r7visitor00001', sid: 'r7session00001', n: 'heard_about', p: { a: 'podcast' } });
      expect(r.status).toBe(202);
      expect(await r.text()).toBe('');
    });
    expect(n).toBe(2);
  });

  it('answers the heard_about breakdown with the answer above, and lists it as a dimension and an Overview tab', async () => {
    const r = await w.admin(`/api/sites/${site.id}/breakdown?dim=heard_about&period=30d`);
    expect(r.status).toBe(200);
    expect(r.body.map((x: { label: string }) => x.label)).toEqual(['podcast']);
    expect(BREAKDOWN_DIMS).toContain('heard_about');
    expect(BREAKDOWN_CARDS[0].at(-1)).toEqual({ label: 'Heard about', dim: 'heard_about' });
  });

  it('has four parts, in lane order, each naming only its own tables', () => {
    expect(CORE_PARTS).toHaveLength(4);
    expect(CORE_PARTS.map((p) => p.siteTables)).toEqual([
      ['experiments'],
      ['survey_answers'],
      ['page_maps'],
      ['errors', 'error_issues', 'error_first'],
    ]);
  });
});
