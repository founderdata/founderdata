import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorker, type TestWorker } from './helpers/worker';

// Plain .mjs script; a non-literal path keeps TypeScript from looking for its types.
const SCRIPT = '../scripts/setup-sites.mjs';

const SITES = [
  { name: 'ShipKit', domain: 'shipkit.example.com', currency: 'EUR', timezone: 'Europe/Berlin', app_bundle_id: 'com.example.shipkit' },
  { name: 'Docs', domain: 'docs.example.com', currency: 'USD', timezone: 'America/New_York' },
  { name: 'Blog', domain: 'blog.example.com' },
];

describe('scripts/setup-sites.mjs', () => {
  let w: TestWorker;
  let setupSites: any;
  let readSites: any;
  let applyDefaults: any;
  // Routes the script's fetch calls to the in-process Worker, with the script's own login cookie.
  const fetchVia = (url: string, init: RequestInit) => {
    const u = new URL(url);
    return w.fetch(u.pathname + u.search, { ...init, headers: { cookie: '', ...(init.headers as Record<string, string>) } });
  };
  const run = (dryRun = false) =>
    setupSites({ base: 'https://stats.example/', password: 'test-password', sites: SITES, dryRun, fetch: fetchVia });

  beforeAll(async () => {
    w = await startWorker();
    ({ setupSites, readSites, applyDefaults } = await import(/* @vite-ignore */ SCRIPT));
  });
  afterAll(() => w.dispose());

  it('reads the example sites file', () => {
    const sites = readSites(new URL('../sites.example.json', import.meta.url).pathname);
    expect(sites.length).toBeGreaterThan(0);
    for (const s of sites) expect(typeof s.name === 'string' && typeof (s.domain ?? s.app_bundle_id) === 'string').toBe(true);
  });

  it('a dry run changes nothing', async () => {
    const res = await run(true);
    expect(res.map((r: any) => r.action)).toEqual(Array(3).fill('would create'));
    expect((await w.admin('/api/sites')).body).toEqual([]);
  });

  it('creates the sites with their settings and defaults, and prints their URLs', async () => {
    const res = await run();
    expect(res.map((r: any) => r.action)).toEqual(Array(3).fill('created'));
    const sites = (await w.admin('/api/sites')).body;
    const by = Object.fromEntries(sites.map((s: any) => [s.domain, s]));
    expect(Object.keys(by).sort()).toEqual(['blog.example.com', 'docs.example.com', 'shipkit.example.com']);
    expect(by['shipkit.example.com']).toMatchObject({ currency: 'EUR', timezone: 'Europe/Berlin', app_bundle_id: 'com.example.shipkit' });
    expect(by['docs.example.com']).toMatchObject({ currency: 'USD', timezone: 'America/New_York', app_bundle_id: null, name: 'Docs' });
    expect(by['blog.example.com']).toMatchObject({ currency: 'USD', timezone: 'UTC' });
    const shipkit = res.find((r: any) => r.site.domain === 'shipkit.example.com');
    expect(shipkit.urls).toMatchObject({
      scriptTag: `<script defer data-website-id="${shipkit.site.id}" src="https://stats.example/js/script.js"></script>`,
      stripeWebhook: `https://stats.example/api/webhooks/stripe/${shipkit.site.id}`,
      appleWebhook: `https://stats.example/api/webhooks/apple/${shipkit.site.id}`,
      appEvents: 'https://stats.example/api/app/events',
    });
  });

  it('is idempotent, repairs drift, and never clears a bundle id set by hand', async () => {
    const sites = (await w.admin('/api/sites')).body;
    const docs = sites.find((s: any) => s.domain === 'docs.example.com');
    const shipkit = sites.find((s: any) => s.domain === 'shipkit.example.com');
    await w.admin(`/api/sites/${docs.id}`, { method: 'PATCH', json: { app_bundle_id: 'com.example.docs' } });
    await w.admin(`/api/sites/${shipkit.id}`, { method: 'PATCH', json: { timezone: 'UTC' } });
    const res = await run();
    const action = (d: string) => res.find((r: any) => r.site.domain === d);
    expect(action('shipkit.example.com')).toMatchObject({ action: 'updated', changed: ['timezone'] });
    expect(action('docs.example.com')).toMatchObject({ action: 'unchanged' });
    expect(action('docs.example.com').site.app_bundle_id).toBe('com.example.docs');
    expect((await w.admin('/api/sites')).body).toHaveLength(3);
    expect((await run()).every((r: any) => r.action === 'unchanged')).toBe(true);
  });
  it('takes defaults, bundle_id, secrets and the write cap, and lists what is still missing', async () => {
    const config = {
      defaults: { currency: 'eur', timezone: 'Europe/Berlin', write_cap: 'auto' },
      sites: [
        { name: 'Paid', domain: 'paid.example.com', stripe_webhook_secret: 'whsec_first', write_cap: 5000 },
        { name: 'Habit', bundle_id: 'com.example.habit', revenuecat_auth: 'rc-secret-0123456789abcdef', currency: 'USD' },
        { name: 'Bare', domain: 'bare.example.com', write_cap: 'off' },
      ],
    };
    const sites = applyDefaults(config);
    expect(sites[1]).toMatchObject({ app_bundle_id: 'com.example.habit', currency: 'USD', timezone: 'Europe/Berlin' });
    expect(sites[1].bundle_id).toBeUndefined();
    expect(sites[0].name).toBe('Paid');

    const go = (replaceSecrets = false, list = sites) =>
      setupSites({ base: 'https://stats.example', password: 'test-password', sites: list, replaceSecrets, fetch: fetchVia });
    const res = await go();
    expect(res.map((r: any) => r.action)).toEqual(['created', 'created', 'created']);
    const by = (name: string) => res.find((r: any) => r.site.name === name);
    expect(by('Paid').site).toMatchObject({ currency: 'EUR', timezone: 'Europe/Berlin', write_cap_on: 1, write_cap: 5000, stripe_webhook_secret: '••••••••' });
    expect(by('Habit').site).toMatchObject({ currency: 'USD', app_bundle_id: 'com.example.habit', revenuecat_auth: '••••••••', write_cap: null });
    expect(by('Bare').site).toMatchObject({ write_cap_on: 0 });
    // Secrets set, no payment yet: the URL still has to go into the provider's dashboard.
    expect(by('Paid').missing).toEqual([expect.stringContaining(`Stripe: no event received yet. Add https://stats.example/api/webhooks/stripe/${by('Paid').site.id}`)]);
    expect(by('Habit').missing.join('\n')).toContain('RevenueCat: no event received yet');
    expect(by('Habit').missing.join('\n')).toContain('App Store: no notification yet');
    expect(by('Bare').missing).toEqual([expect.stringContaining('no payment provider')]);
    const row = await w.db.prepare('SELECT stripe_webhook_secret FROM sites WHERE id = ?').bind(by('Paid').site.id).first<any>();
    expect(row.stripe_webhook_secret).toBe('whsec_first');

    // Again: nothing to do, and a secret already set is kept.
    const again = await go();
    expect(again.map((r: any) => r.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(again[0].kept).toEqual(['stripe_webhook_secret']);

    // A rotated secret and a new cap: the cap changes; the secret only with --replace-secrets.
    const rotated = sites.map((s: any) => (s.name === 'Paid' ? { ...s, stripe_webhook_secret: 'whsec_second', write_cap: 'auto' } : s));
    const third = await go(false, rotated);
    expect(third[0]).toMatchObject({ action: 'updated', changed: ['write_cap'], kept: ['stripe_webhook_secret'] });
    expect(third[0].site).toMatchObject({ write_cap_on: 1, write_cap: null });
    const fourth = await go(true, rotated);
    expect(fourth[0]).toMatchObject({ action: 'updated', changed: ['stripe_webhook_secret'] });
    const after = await w.db.prepare('SELECT stripe_webhook_secret FROM sites WHERE id = ?').bind(by('Paid').site.id).first<any>();
    expect(after.stripe_webhook_secret).toBe('whsec_second');
  });

  it('makes the Gumroad ping URL once, prints it, and lists Gumroad until the first sale', async () => {
    const list = [
      { name: 'Zine Pack', domain: 'zine.example.com', gumroad_seller_id: 'seller_abc123' },
      { name: 'Font Kit', domain: 'fonts.example.com', gumroad: true },
    ];
    const go = (dryRun = false) => setupSites({ base: 'https://stats.example', password: 'test-password', sites: list, dryRun, fetch: fetchVia });

    // A dry run says the URL comes with the real run, and does not count as "no payment provider".
    const dry = await go(true);
    expect(dry[0]).toMatchObject({ action: 'would create', changed: expect.arrayContaining(['gumroad_token']) });
    expect(dry[0].missing).toEqual(['Gumroad: no ping URL yet. Run the script without --dry-run to make one']);

    const res = await go();
    for (const r of res) {
      expect(r.action).toBe('created');
      expect(r.site.gumroad_token).toMatch(/^\w{16,}$/);
      expect(r.urls.gumroadPing).toBe(`https://stats.example/api/webhooks/gumroad/${r.site.id}/${r.site.gumroad_token}`);
      expect(r.missing).toEqual([expect.stringContaining(`Gumroad: no sale ping yet. Set ${r.urls.gumroadPing} as the ping URL`)]);
    }
    expect(res[0].site.gumroad_seller_id).toBe('seller_abc123');
    expect(res[1].site.gumroad_seller_id).toBeNull();

    // The URL works: a sale ping is accepted, and the hint goes away. A second run keeps the same token.
    const ping = await w.fetch(new URL(res[0].urls.gumroadPing).pathname, {
      method: 'POST',
      headers: { cookie: '', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ seller_id: 'seller_abc123', sale_id: 'sale_1', price: '500', currency: 'usd', product_name: 'Zine' }).toString(),
    });
    expect(ping.status).toBe(200);
    const again = await go();
    expect(again.map((r: any) => r.action)).toEqual(['unchanged', 'unchanged']);
    expect(again[0].site.gumroad_token).toBe(res[0].site.gumroad_token);
    expect(again[0].missing).toEqual([]);
    expect(again[1].missing).toEqual([expect.stringContaining('Gumroad: no sale ping yet')]);
  });

  it('reports a bad entry and goes on with the others', async () => {
    const res = await setupSites({
      base: 'https://stats.example',
      password: 'test-password',
      sites: [
        { name: 'Broken', domain: 'broken.example.com', stripe_webhook_secret: 'not-a-stripe-secret' },
        { name: 'Fine', domain: 'fine.example.com' },
      ],
      fetch: fetchVia,
    });
    expect(res[0]).toMatchObject({ action: 'failed', error: expect.stringContaining('whsec_') });
    expect(res[1].action).toBe('created');
  });

  it('turns on errors, click maps and surveys, and a second run changes nothing (shared-7)', async () => {
    const entry = {
      name: 'Capture',
      domain: 'capture.example.com',
      errors_on: true,
      maps_on: true,
      map_sample: 25,
      surveys: { heard_about: { on: true, paths: ['/'] } },
    };
    const go = () => setupSites({ base: 'https://stats.example/', password: 'test-password', sites: [entry], fetch: fetchVia });
    const first = await go();
    expect(first[0]).toMatchObject({ action: 'created' });
    expect(first[0].changed).toEqual(expect.arrayContaining(['errors_on', 'maps_on', 'map_sample', 'surveys']));
    const site = (await w.admin('/api/sites')).body.find((x: any) => x.domain === 'capture.example.com');
    expect(site).toMatchObject({ errors_on: 1, maps_on: 1, map_sample: 25 });
    expect(JSON.parse(site.surveys)).toEqual({ heard_about: { on: 1, paths: ['/'] } });
    expect((await go())[0]).toMatchObject({ action: 'unchanged' });
    await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { maps_on: false } });
    expect((await go())[0]).toMatchObject({ action: 'updated', changed: ['maps_on'] });
  });

  it('refuses unknown keys and bad caps in a sites file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-sites-'));
    const file = path.join(dir, 'sites.json');
    try {
      fs.writeFileSync(file, JSON.stringify([{ name: 'A', domain: 'a.example.com', stripe_secret: 'x' }]));
      expect(() => readSites(file)).toThrow(/"stripe_secret" is not a setting/);
      fs.writeFileSync(file, JSON.stringify({ defaults: { write_cap: 'lots' }, sites: [{ name: 'A', domain: 'a.example.com' }] }));
      expect(() => readSites(file)).toThrow(/write_cap/);
      fs.writeFileSync(file, JSON.stringify({ defaults: { currency: 'EUR' }, sites: [{ name: 'A', bundle_id: 'com.example.a' }] }));
      expect(readSites(file)).toEqual([{ name: 'A', currency: 'EUR', app_bundle_id: 'com.example.a' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
