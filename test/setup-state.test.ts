// The setup state (src/worker/setup-state.ts, docs/API.md "Setup state"): statuses that a real signal backs, who may
// read it, that no secret value leaves, the install check, and the MCP tool get_setup with core's skills as prompts.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { setTrustedRootForTests } from '../src/worker/lib/apple-jws';
import { mergeSkills } from '../src/worker/mcp';
import { pickNext, readInstall, resetSetupStateForTests, tagIds } from '../src/worker/setup-state';
import { CORE_SKILLS } from '../src/worker/core-skills';
import type { SetupState, Step } from '../src/shared/setup-steps';
import { makeChain, signJws } from './helpers/apple-chain';
import { itCore, itPro } from './helpers/edition';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const STRIPE_SECRET = 'whsec_FAKEsetupSECRET42';
const RC_SECRET = 'rc_FAKE_setup_secret_000111';
const ENV_SECRET = 're_FAKE_ENV_SECRET_99';
const VIEWER = 'viewer-password-setup';
const BUNDLE = 'com.example.setupapp';

describe('setup state', () => {
  let w: TestWorker;
  const as = (key: string | null) => ({ cookie: '', ...(key ? { authorization: `Bearer ${key}` } : {}) });
  const get = async (q = '', headers: Record<string, string> = {}) => {
    const r = await w.fetch(`/api/v1/setup${q}`, { headers });
    return { status: r.status, text: await r.clone().text(), body: (await r.json()) as SetupState & { error?: string } };
  };
  const step = (s: SetupState, id: string) => {
    const found = s.steps.find((x) => x.id === id);
    if (!found) throw new Error(`no step ${id} in ${s.steps.map((x) => x.id).join(', ')}`);
    return found;
  };
  const pageview = (siteId: string, domain: string) =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.40' },
      body: JSON.stringify({ w: siteId, t: 'pageview', u: `https://${domain}/`, r: '' }),
    });
  /** An app without a website: POST /api/sites with a bundle id and no domain. */
  const addApp = async (bundle: string, name: string) => {
    const r = await w.admin('/api/sites', { method: 'POST', json: { name, app_bundle_id: bundle } });
    expect(r.status).toBe(200);
    return r.body;
  };
  const pay = (siteId: string, id: string, visitor: string | null) =>
    w.db
      .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id) VALUES (?, ?, 'stripe', ?, 1900, 'payment', 'USD', ?)")
      .bind(id, siteId, Date.now(), visitor)
      .run();

  beforeAll(async () => {
    resetBudgetForTests(Infinity);
    resetSetupStateForTests();
    w = await startWorker({ VIEWER_PASSWORD: VIEWER, RESEND_API_KEY: ENV_SECRET });
  }, 180_000);
  afterAll(async () => {
    setTrustedRootForTests(null);
    await w?.dispose();
  });

  it('starts with the deployment done and the first site as the next step, and writes no row', async () => {
    w.takeRowsWritten();
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(w.takeRowsWritten()).toBe(0);
    expect(body).toMatchObject({ origin: 'http://localhost', sites: [] });
    expect(step(body, 'deploy')).toMatchObject({ status: 'done', required: true, next: null, prompt: null });
    // No heartbeat yet: the cron is waiting, not done.
    expect(step(body, 'cron').status).toBe('waiting');
    expect(step(body, 'site')).toMatchObject({ status: 'todo', required: true, who: 'agent' });
    expect(body.next?.id).toBe('site');
    expect(body.next?.prompt).toContain('scripts/setup-sites.mjs http://localhost');
    expect(body.progress).toMatchObject({ required_done: 1, required_total: 2 });
    expect(step(body, 'agent-key').status).toBe('todo');
    // Groups come in order: deploy, track, revenue, agent, growth.
    const groups = body.steps.map((s) => s.group);
    expect(groups).toEqual([...groups].sort((a, b) => ['deploy', 'track', 'revenue', 'agent', 'growth'].indexOf(a) - ['deploy', 'track', 'revenue', 'agent', 'growth'].indexOf(b)));
  });

  itCore('lists what Pro adds as locked outcomes, never as the next step', async () => {
    const { body } = await get();
    expect(body.edition).toBe('core');
    const locked = body.steps.filter((s) => s.status === 'locked');
    expect(locked.map((s) => s.id)).toEqual(expect.arrayContaining(['dataforseo', 'ai-engines', 'schedule']));
    for (const s of locked) {
      expect(s).toMatchObject({ pro: true, group: 'growth', required: false });
      expect(s.outcome.length).toBeGreaterThan(20);
    }
    expect(body.progress.total).toBe(body.steps.filter((s) => s.status !== 'locked' && s.status !== 'off').length);
  });

  it('a website: tracker todo until the first visit, then done with when', async () => {
    const site = await w.createSite({ domain: 'tracker-setup.example', name: 'Tracker' });
    let { body } = await get(`?site=${site.id}`);
    expect(body.sites).toEqual([{ id: site.id, name: 'Tracker', kind: 'web', done: 0, total: 3, next: `tracker:${site.id}` }]);
    const tracker = step(body, `tracker:${site.id}`);
    expect(tracker).toMatchObject({ status: 'todo', required: true, who: 'agent', evidence: null, skill: 'skills/founderdata-setup/SKILL.md' });
    expect(tracker.prompt).toContain(`<script defer data-website-id="${site.id}" src="http://localhost/js/script.js"></script>`);
    expect(tracker.prompt).toContain('tracker-setup.example');
    expect(body.next?.id).toBe(`tracker:${site.id}`);
    expect(step(body, `payments:${site.id}`)).toMatchObject({ status: 'todo', required: true, command: null });
    expect(step(body, `attribution:${site.id}`).status).toBe('todo');
    expect(body.steps.some((s) => s.id === `sdk:${site.id}`)).toBe(false);

    expect((await pageview(site.id, 'tracker-setup.example')).status).toBeLessThan(300);
    await w.flush();
    ({ body } = await get(`?site=${site.id}`));
    expect(step(body, `tracker:${site.id}`)).toMatchObject({ status: 'done', next: null, prompt: null });
    expect(step(body, `tracker:${site.id}`).evidence).toMatch(/^Last visit (less than a minute|\d+ minutes?) ago\.$/);
    expect(body.next?.id).toBe(`payments:${site.id}`);
  });

  it('payments: waiting with the secret set, done with a payment, and attribution waits with the unlinked count', async () => {
    const site = await w.createSite({ domain: 'pay-setup.example', stripe_webhook_secret: STRIPE_SECRET });
    let { body } = await get(`?site=${site.id}`);
    expect(step(body, `payments:${site.id}`)).toMatchObject({
      status: 'waiting',
      command: `npm run connect -- stripe --site ${site.id}`,
      skill: 'skills/founderdata-connect/stripe.md',
      url: `/site/${site.id}/settings#stripe`,
    });
    expect(step(body, `payments:${site.id}`).secrets).toContainEqual({ name: 'stripe_webhook_secret', set: true });
    expect(step(body, `payments:${site.id}`).prompt).toContain(`http://localhost/api/webhooks/stripe/${site.id}`);
    expect(step(body, `attribution:${site.id}`)).toMatchObject({ status: 'waiting', evidence: 'No payment has arrived yet.' });

    for (const id of ['pi_setup_1', 'pi_setup_2', 'pi_setup_3']) await pay(site.id, id, null);
    ({ body } = await get(`?site=${site.id}`));
    expect(step(body, `payments:${site.id}`)).toMatchObject({ status: 'done', evidence: expect.stringMatching(/^Last Stripe payment/) });
    expect(step(body, `attribution:${site.id}`)).toMatchObject({
      status: 'waiting',
      evidence: '3 payments, none linked to a visit.',
      next: 'Add the attribution ids at checkout.',
    });
    expect(step(body, `attribution:${site.id}`).prompt).toContain('window.founderdata.attribution()');

    await pay(site.id, 'pi_setup_4', 'visitor-setup-1');
    ({ body } = await get(`?site=${site.id}`));
    expect(step(body, `attribution:${site.id}`)).toMatchObject({ status: 'done', prompt: null });
  });

  it('payments: broken after deliveries fail the signature check, and broken comes first', async () => {
    const site = await w.createSite({ domain: 'broken-setup.example', stripe_webhook_secret: STRIPE_SECRET });
    const body = JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } });
    const t = Math.floor(Date.now() / 1000);
    const bad = await w.fetch(`/api/webhooks/stripe/${site.id}`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_wrong').update(`${t}.${body}`).digest('hex')}` },
      body,
    });
    expect(bad.status).toBe(401);
    await w.flush();
    const state = (await get()).body;
    const s = step(state, `payments:${site.id}`);
    expect(s).toMatchObject({ status: 'broken', evidence: '1 Stripe delivery failed the signature check in the last 24 hours.' });
    expect(s.prompt).toContain(`npm run connect -- stripe --site ${site.id}`);
    expect(state.next?.status).toBe('broken');
  });

  it('an app: SDK and App Store notifications are todo until the first session and the first notification', async () => {
    const site = await addApp(BUNDLE, 'Setup app');
    let { body } = await get(`?site=${site.id}`);
    expect(body.sites[0].kind).toBe('app');
    expect(body.steps.some((s) => s.id === `tracker:${site.id}`)).toBe(false);
    expect(step(body, `sdk:${site.id}`)).toMatchObject({ status: 'todo', required: true });
    expect(step(body, `sdk:${site.id}`).prompt).toContain(`FounderData.configure(siteId: "${site.id}", host: "http://localhost")`);
    expect(step(body, `apple:${site.id}`)).toMatchObject({ status: 'todo', required: true, who: 'browser', url: 'https://appstoreconnect.apple.com/apps' });
    expect(step(body, `apple:${site.id}`).prompt).toContain(`http://localhost/api/webhooks/apple/${site.id}`);
    // An app pays through the App Store, so another provider is optional.
    expect(step(body, `payments:${site.id}`)).toMatchObject({ status: 'off', required: false });

    const chain = await makeChain();
    setTrustedRootForTests(chain.root.der);
    const payload = { notificationType: 'TEST', notificationUUID: crypto.randomUUID(), version: '2.0', signedDate: Date.now(), data: { bundleId: BUNDLE, environment: 'Production' } };
    w.takeRowsWritten();
    const sent = await w.fetch(`/api/webhooks/apple/${site.id}`, { method: 'POST', json: { signedPayload: await signJws(payload, chain) } });
    expect(sent.status).toBe(200);
    // The marker: 1 row the first time, none after.
    expect(w.takeRowsWritten()).toBe(1);
    await w.fetch(`/api/webhooks/apple/${site.id}`, { method: 'POST', json: { signedPayload: await signJws({ ...payload, notificationUUID: crypto.randomUUID() }, chain) } });
    expect(w.takeRowsWritten()).toBe(0);

    const vid = crypto.randomUUID();
    await w.fetch('/api/app/events', {
      method: 'POST',
      body: JSON.stringify({ w: site.id, vid, ctx: { bundle_id: BUNDLE, app_version: '1.0', os_version: '26.0' }, events: [{ t: 'session_start', sid: crypto.randomUUID() }] }),
    });
    await w.flush();
    ({ body } = await get(`?site=${site.id}`));
    expect(step(body, `apple:${site.id}`)).toMatchObject({ status: 'done', evidence: expect.stringMatching(/^First App Store notification/) });
    expect(step(body, `sdk:${site.id}`)).toMatchObject({ status: 'done', evidence: expect.stringMatching(/^Last app session/) });
  });

  describe('who may read it', () => {
    let mine: any;
    let other: any;
    let readKey: string;
    let notesKey: string;

    beforeAll(async () => {
      mine = await w.createSite({ domain: 'key-setup.example', stripe_webhook_secret: STRIPE_SECRET, revenuecat_auth: RC_SECRET, gumroad_new_token: true });
      other = await w.createSite({ domain: 'other-setup.example' });
      readKey = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'setup-agent', scopes: ['read'], sites: [mine.id] } })).body.key;
      notesKey = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'notes-only', scopes: ['notes:write'] } })).body.key;
    });

    it('a read key sees its own sites and the deployment steps, and is in use while it calls', async () => {
      const { status, body } = await get('', as(readKey));
      expect(status).toBe(200);
      expect(body.sites.map((s) => s.id)).toEqual([mine.id]);
      expect(body.steps.filter((s) => s.site).every((s) => s.site!.id === mine.id)).toBe(true);
      expect(step(body, 'deploy').status).toBe('done');
      expect(step(body, 'site').evidence).toBe('1 site this key covers.');
      expect(step(body, 'agent-key').status).toBe('done');
      expect(step(body, 'agent-used')).toMatchObject({ status: 'done', evidence: 'This key is calling now.' });
      expect((await get(`?site=${other.id}`, as(readKey))).status).toBe(403);
      expect((await get(`?site=${mine.id}`, as(readKey))).status).toBe(200);
      expect((await get('?site=nosuchsite', as(null))).status).toBe(401);
      expect((await get('?site=nosuchsite')).status).toBe(404);
    });

    it('refuses a key without read, a viewer and no login', async () => {
      expect((await get('', as(notesKey))).status).toBe(403);
      expect((await get('', as('fdk_00000000000000000000unknown'))).status).toBe(401);
      expect((await get('', as(null))).status).toBe(401);
      const login = await w.fetch('/api/auth/login', { method: 'POST', headers: { cookie: '' }, json: { password: VIEWER } });
      const viewer = (login.headers.get('set-cookie') ?? '').split(';')[0];
      expect(viewer).toMatch(/=/);
      const res = await get('', { cookie: viewer });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/for owners/);
    });

    it('names secrets and says whether each is set, never a value', async () => {
      const row = await w.db.prepare('SELECT api_key, gumroad_token FROM sites WHERE id = ?').bind(mine.id).first<{ api_key: string; gumroad_token: string }>();
      expect(row?.gumroad_token).toBeTruthy();
      const values = [STRIPE_SECRET, RC_SECRET, ENV_SECRET, row!.api_key, row!.gumroad_token, readKey];
      for (const res of [await get(), await get('', as(readKey)), await get(`?site=${mine.id}`)]) {
        expect(res.status).toBe(200);
        for (const v of values) expect(res.text).not.toContain(v);
        // Nor a prefix of one.
        expect(res.text).not.toContain(STRIPE_SECRET.slice(0, 12));
      }
      const { body } = await get(`?site=${mine.id}`);
      expect(step(body, `payments:${mine.id}`).secrets).toEqual(
        expect.arrayContaining([
          { name: 'stripe_webhook_secret', set: true },
          { name: 'revenuecat_auth', set: true },
          { name: 'gumroad_token', set: true },
          { name: 'paddle_secret', set: false },
        ]),
      );
      expect(step(body, 'email').secrets).toEqual([{ name: 'RESEND_API_KEY', set: true }]);
    });

    it('keeps the old checklist route working', async () => {
      const old = await w.admin('/api/setup');
      expect(old.status).toBe(200);
      expect(old.body.rows[0].id).toBe('cron');
    });
  });

  describe('verify-install', () => {
    const real = globalThis.fetch;
    const pages = new Map<string, (init?: RequestInit) => Promise<Response>>();
    const verify = async (site: string, headers: Record<string, string> = {}) => {
      const r = await w.fetch('/api/v1/setup/verify-install', { method: 'POST', headers, json: { site } });
      return { status: r.status, headers: r.headers, body: await r.json<any>() };
    };
    const html = (head: string) => async () => new Response(`<!doctype html><html><head>${head}</head><body>Hi</body></html>`, { headers: { 'content-type': 'text/html' } });

    beforeAll(() => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const page = pages.get(String(input instanceof Request ? input.url : input));
        return page ? page(init) : real(input, init);
      }) as typeof fetch;
    });
    afterAll(() => {
      globalThis.fetch = real;
    });

    it('finds the tag, and the tracker step waits for the first visit', async () => {
      const site = await w.createSite({ domain: 'tag-setup.example' });
      pages.set('https://tag-setup.example/', html(`<script defer data-website-id="${site.id}" src="https://founderdata.example.com/js/script.js"></script>`));
      w.takeRowsWritten();
      const r = await verify(site.id);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, found: 'tag', site: site.id, url: 'https://tag-setup.example/' });
      // The claim and the outcome.
      expect(w.takeRowsWritten()).toBe(2);
      const { body } = await get(`?site=${site.id}`);
      expect(step(body, `tracker:${site.id}`)).toMatchObject({ status: 'waiting', evidence: expect.stringMatching(/found the tag/) });

      const again = await verify(site.id);
      expect(again.status).toBe(429);
      expect(again.headers.get('retry-after')).toBe('15');
    });

    it('says none when the page has no tag, and other-site-id for another site', async () => {
      const none = await w.createSite({ domain: 'none-setup.example' });
      pages.set('https://none-setup.example/', html('<title>No tag</title>'));
      expect((await verify(none.id)).body).toMatchObject({ ok: false, found: 'none', message: expect.stringMatching(/has no tag for this site/) });

      const wrong = await w.createSite({ domain: 'wrong-setup.example' });
      pages.set('https://wrong-setup.example/', html('<script defer data-website-id="abcdefgh12345678" src="/js/script.js"></script>'));
      const r = await verify(wrong.id);
      expect(r.body).toMatchObject({ ok: false, found: 'other-site-id', message: expect.stringContaining('abcdefgh12345678') });
      const { body } = await get(`?site=${wrong.id}`);
      expect(step(body, `tracker:${wrong.id}`)).toMatchObject({ status: 'broken', next: `Set data-website-id to ${wrong.id} in the tag.` });
    });

    it('reports a timeout and an error page plainly', async () => {
      const slow = await w.createSite({ domain: 'slow-setup.example' });
      pages.set('https://slow-setup.example/', async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });
      expect((await verify(slow.id)).body).toMatchObject({ ok: false, found: 'none', message: 'https://slow-setup.example/ did not answer within 5 seconds.' });

      const down = await w.createSite({ domain: 'down-setup.example' });
      pages.set('https://down-setup.example/', async () => new Response('Bad gateway', { status: 502 }));
      expect((await verify(down.id)).body).toMatchObject({ ok: false, found: 'none', message: expect.stringMatching(/answered 502/) });
    });

    it('takes a key with read for its sites, refuses an app without a website and a missing site', async () => {
      const site = await w.createSite({ domain: 'keyverify-setup.example' });
      const outside = await w.createSite({ domain: 'outside-setup.example' });
      pages.set('https://keyverify-setup.example/', html(`<script src="/js/script.js" data-website-id="${site.id}" defer></script>`));
      const key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'verify-agent', scopes: ['read'], sites: [site.id] } })).body.key;
      expect((await verify(site.id, as(key))).body.found).toBe('tag');
      expect((await verify(outside.id, as(key))).status).toBe(403);
      const app = await addApp('com.example.verifyapp', 'Verify app');
      const r = await verify(app.id);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/app without a website/);
      expect((await w.fetch('/api/v1/setup/verify-install', { method: 'POST', json: {} })).status).toBe(400);
      expect((await verify('nosuchsite')).status).toBe(404);
      // A cookie POST from another origin.
      expect((await verify(site.id, { origin: 'https://evil.example' })).status).toBe(403);
    });
  });

  describe('MCP', () => {
    let key: string;
    let n = 0;
    const rpc = async (method: string, params: unknown = {}) => {
      const r = await w.fetch('/mcp', {
        method: 'POST',
        headers: { cookie: '', authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      });
      return (await r.json<any>()).result;
    };

    beforeAll(async () => {
      key = (await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'mcp-setup', scopes: ['read'] } })).body.key;
    });

    it('get_setup is read-only and answers what the route answers', async () => {
      const { tools } = await rpc('tools/list');
      const tool = tools.find((t: any) => t.name === 'get_setup');
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(tool.inputSchema.properties)).toEqual(['site']);
      const result = await rpc('tools/call', { name: 'get_setup', arguments: {} });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.steps.length).toBeGreaterThan(5);
      expect(step(result.structuredContent, 'deploy').status).toBe('done');
      const site = result.structuredContent.sites[0].id;
      const one = await rpc('tools/call', { name: 'get_setup', arguments: { site } });
      expect(one.structuredContent.sites.map((s: any) => s.id)).toEqual([site]);
    });

    it("answers core's skills as prompts", async () => {
      const { prompts } = await rpc('prompts/list');
      expect(prompts.map((p: any) => p.name)).toContain('founderdata-setup');
      const got = await rpc('prompts/get', { name: 'founderdata-setup', arguments: { site: 'SITE_ID' } });
      expect(got.messages[0].content.text).toContain(CORE_SKILLS.find((s) => s.name === 'founderdata-setup')!.body);
      expect(got.messages[0].content.text).toContain('SITE_ID');
    });

    itPro("joins Pro's skills after core's", async () => {
      const { prompts } = await rpc('prompts/list');
      expect(prompts.length).toBeGreaterThan(CORE_SKILLS.length);
    });
  });
});

describe('setup state helpers', () => {
  it('reads the tag as an attribute or in serialized props, and ignores another tool\'s UUID', () => {
    expect(tagIds('<script data-website-id="abc" src="/js/script.js">')).toEqual(['abc']);
    expect(tagIds('{"props":{"data-website-id":"a1b2c3d4e5f6g7h8"}}')).toEqual(['a1b2c3d4e5f6g7h8']);
    expect(tagIds('<script data-website-id=a1b2c3d4e5f6g7h8>')).toEqual(['a1b2c3d4e5f6g7h8']);
    expect(readInstall('<script data-website-id="a1b2c3d4e5f6g7h8">', 'a1b2c3d4e5f6g7h8').found).toBe('tag');
    expect(readInstall('<script data-website-id="6b1f2c9e-7a4d-4b8e-9c1f-2d3e4f5a6b7c" src="https://umami.example/script.js">', 'a1b2c3d4e5f6g7h8').found).toBe('none');
  });

  it('picks broken first, then required todo, required waiting, optional todo, and never off or locked', () => {
    const s = (id: string, status: Step['status'], required = false) => ({ id, status, required }) as Step;
    expect(pickNext([s('a', 'off'), s('b', 'locked'), s('c', 'done', true)])).toBeNull();
    expect(pickNext([s('a', 'todo'), s('b', 'waiting', true), s('c', 'todo', true)])!.id).toBe('c');
    expect(pickNext([s('a', 'todo'), s('b', 'waiting', true)])!.id).toBe('b');
    expect(pickNext([s('a', 'waiting'), s('b', 'todo'), s('c', 'broken')])!.id).toBe('c');
  });

  it("lets a Pro skill replace a core skill of the same name", () => {
    const core = [{ name: 'a', body: 'core a' }, { name: 'b', body: 'core b' }];
    expect(mergeSkills(core, [{ name: 'b', body: 'pro b' }, { name: 'c', body: 'pro c' }])).toEqual([
      { name: 'a', body: 'core a' },
      { name: 'b', body: 'pro b' },
      { name: 'c', body: 'pro c' },
    ]);
  });

  it('src/worker/core-skills.ts matches skills/*/SKILL.md (run npm run sync:skills after editing a skill)', async () => {
    // Plain .mjs script; a non-literal path keeps TypeScript from looking for its types.
    const script = '../scripts/sync-core-skills.mjs';
    const { build } = await import(/* @vite-ignore */ script);
    const current = fs.readFileSync(path.resolve(__dirname, '../src/worker/core-skills.ts'), 'utf8');
    expect(current).toBe(build().source);
    expect(CORE_SKILLS.map((s) => s.name)).toContain('founderdata-setup');
  });
});
