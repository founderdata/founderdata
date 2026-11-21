// An experiment's start or stop (FounderData Pro writes it with actor experiments and target experiment:<key>) gets
// no before and after verdict: both versions run in the days after it (critique 2, exp-4). The impact links the
// experiment instead, for the dashboard, a read key with or without revenue, and the per-actor tally.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPERIMENT_ACTOR, experimentOfNote } from '../src/worker/notes';
import { startWorker, type TestWorker } from './helpers/worker';

const DAY = 86_400_000;

describe('experiment notes carry no verdict', () => {
  let w: TestWorker;
  let site: any;
  let readKey = '';
  let revKey = '';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'exp-notes-core.example', currency: 'USD' });
    const add = async (name: string, json: Record<string, unknown>) => {
      const r = await w.admin(`/api/sites/${site.id}/notes`, { method: 'POST', json: { ts: Date.now() - 10 * DAY, ...json } });
      ids[name] = r.body.id;
    };
    await add('exp', { text: 'Experiment started: Pricing headline', actor: EXPERIMENT_ACTOR, target: 'experiment:pricing_headline' });
    await add('nokey', { text: 'Experiment stopped: Old test. No winner', actor: EXPERIMENT_ACTOR, target: '/pricing' });
    await add('plain', { text: 'New pricing page', actor: 'pricing-agent', target: '/pricing' });
    // Enough visits on both sides that the visit rule would judge the plain note: 150 before, 300 after.
    const visits = (n: number, from: number) =>
      w.db
        .prepare(
          `WITH RECURSIVE k(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM k WHERE k < ${n - 1})
           INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, source, channel)
           SELECT ?1, ?2 || k, ?2 || k, ?3 + k * 60000, ?3 + k * 60000 + 1000, 1, 'exp-notes-core.example', '/pricing', 'Direct/None', 'Direct' FROM k`,
        )
        .bind(site.id, `v${from}_`, from);
    await w.db.batch([visits(150, Date.now() - 15 * DAY), visits(300, Date.now() - 9 * DAY)]);
    readKey = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'r', scopes: ['read'], sites: [site.id] } })).body.key;
    revKey = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'rr', scopes: ['read', 'read:revenue'], sites: [site.id] } })).body.key;
  });
  afterAll(() => w.dispose());

  const v1 = async (path: string, key: string) => (await w.fetch(path, { headers: { authorization: `Bearer ${key}`, cookie: '' } })).json<any>();

  it('tells an experiment note by its actor, and reads the key from its target', () => {
    expect(experimentOfNote({ actor: 'experiments', target: 'experiment:pricing_headline' })).toEqual({ key: 'pricing_headline' });
    expect(experimentOfNote({ actor: 'experiments', target: '/pricing' })).toEqual({ key: null });
    expect(experimentOfNote({ actor: 'pricing-agent', target: 'experiment:pricing_headline' })).toBeNull();
  });

  it('answers verdict null, the reason and the link to the experiment, in the dashboard and for every key', async () => {
    const dash = (await w.admin(`/api/sites/${site.id}/notes/${ids.exp}/impact`)).body;
    expect(dash).toMatchObject({
      verdict: null,
      verdict_metric: null,
      data_gap: false,
      experiment: { key: 'pricing_headline', dashboard_path: `/site/${site.id}/experiments/pricing_headline`, api_path: '/api/v1/experiments/pricing_headline' },
    });
    expect(dash.reason).toMatch(/no before and after verdict/);
    expect(dash.reason).toContain('/api/v1/experiments/pricing_headline');
    // The visit numbers stay as context.
    expect(dash.before.visitors).toBeGreaterThan(0);
    for (const key of [readKey, revKey]) {
      const r = await v1(`/api/v1/notes/${ids.exp}/impact`, key);
      expect(r).toMatchObject({ verdict: null, experiment: { key: 'pricing_headline' } });
    }
    // Without a key in the target the link goes to the list.
    const nokey = (await w.admin(`/api/sites/${site.id}/notes/${ids.nokey}/impact`)).body;
    expect(nokey).toMatchObject({ verdict: null, experiment: { key: null, dashboard_path: `/site/${site.id}/experiments`, api_path: '/api/v1/experiments' } });
  });

  it('still judges every other note', async () => {
    const plain = (await w.admin(`/api/sites/${site.id}/notes/${ids.plain}/impact`)).body;
    // With revenue it needs 10 new customers, so it is inconclusive; a key without revenue judges the visits alone.
    expect(plain.verdict).toBe('inconclusive');
    expect(plain.experiment).toBeUndefined();
    expect((await v1(`/api/v1/notes/${ids.plain}/impact`, readKey)).verdict).toBe('better');
  });

  it('counts experiment notes as changes in no verdict column of the per-actor tally', async () => {
    const body = (await w.admin(`/api/sites/${site.id}/notes/actors?days=30`)).body;
    const exp = (body.actors as any[]).find((r) => r.actor === 'experiments');
    expect(exp).toMatchObject({ changes: 2, better: 0, worse: 0, inconclusive: 0, measuring: 0 });
  });
});
