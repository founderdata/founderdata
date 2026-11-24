import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

// npm run connect: the value goes to Wrangler's stdin or the site PATCH and never to stdout, stderr or the log.
// Wrangler is a fake that records what it got; the deployment is a fake server on 127.0.0.1.
const SCRIPT = '../scripts/connect.mjs';
const PROVIDERS = '../scripts/lib/providers.mjs';
const PASSWORD = 'correct-horse-battery-staple';
const STRIPE = `whsec_${randomBytes(18).toString('hex')}`;
const PEM = `-----BEGIN PRIVATE KEY-----\n${randomBytes(48).toString('base64')}\n${randomBytes(24).toString('base64')}\n-----END PRIVATE KEY-----`;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

/** A fake deployment with the given sites. PATCH /api/sites/:id stores the body; GET answers secrets as dots. */
async function fakeDeployment(sites: { id: string; name: string; domain: string; [k: string]: unknown }[]) {
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, json: unknown, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(json));
      };
      if (req.url === '/api/auth/login') {
        return JSON.parse(body).password === PASSWORD ? send(200, { ok: true }, { 'set-cookie': 'fd_auth=ok; Path=/' }) : send(401, { error: 'no' });
      }
      if (req.headers.cookie !== 'fd_auth=ok') return send(401, { error: 'login' });
      if (req.url === '/api/sites') return send(200, sites);
      const m = req.url?.match(/^\/api\/sites\/([\w-]+)$/);
      const site = m && sites.find((s) => s.id === m[1]);
      if (!site) return send(404, { error: 'Not found' });
      if (req.method === 'PATCH') {
        const b = JSON.parse(body);
        patches.push({ id: site.id, body: b });
        if (typeof b.stripe_webhook_secret === 'string' && !/^whsec_\w+$/.test(b.stripe_webhook_secret)) return send(400, { error: 'A Stripe signing secret starts with whsec_' });
        Object.assign(site, b);
        if (b.gumroad_new_token) site.gumroad_token = 'tok123';
      }
      const masked = Object.fromEntries(Object.entries(site).map(([k, v]) => [k, /secret|auth/.test(k) && v ? '••••••••' : v]));
      send(200, masked);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, patches };
}

function sandbox(url: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'fd-connect-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'config');
  const downloads = join(root, 'Downloads');
  mkdirSync(configDir);
  mkdirSync(downloads);
  writeFileSync(join(configDir, 'admin-password'), `${PASSWORD}\n`);
  if (url) writeFileSync(join(configDir, 'url'), `${url}\n`);
  return { root, configDir, downloads };
}

function deps(box: ReturnType<typeof sandbox>, { stdin = '', tty = false, typed = [] as string[], loggedIn = true } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const puts: { name: string; input?: string }[] = [];
  const stored = new Set<string>();
  let pageUrl: (url: string) => void = () => {};
  const page = new Promise<string>((r) => (pageUrl = r));
  return {
    d: {
      cwd: box.root,
      env: {},
      configDir: box.configDir,
      downloadsDir: box.downloads,
      wrangler: (args: string[], opts: { input?: string } = {}) => {
        if (args[0] === 'whoami') return loggedIn ? { ok: true, status: 0, out: '{"loggedIn":true,"accounts":[{"id":"a","name":"Acme"}]}' } : { ok: false, status: 1, out: '' };
        if (args[0] === 'secret' && args[1] === 'put') {
          puts.push({ name: args[2], input: opts.input });
          stored.add(args[2]);
          return { ok: true, status: 0, out: `Success! Uploaded secret ${args[2]}` };
        }
        if (args[0] === 'secret' && args[1] === 'list') return { ok: true, status: 0, out: JSON.stringify([...stored].map((name) => ({ name, type: 'secret_text' }))) };
        return { ok: false, status: 1, out: '' };
      },
      fetch,
      stdin: Readable.from([stdin]),
      stdinIsTTY: tty,
      readHidden: async () => typed.shift() ?? '',
      openBrowser: () => false,
      onPageUrl: (u: string) => pageUrl(u),
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
      timeoutMs: 5_000,
      pollMs: 20,
    },
    out,
    err,
    puts,
    page,
    log: () => (existsSync(join(box.configDir, 'agent-log.jsonl')) ? readFileSync(join(box.configDir, 'agent-log.jsonl'), 'utf8') : ''),
  };
}

/** A raw HTTP request, so the test can send any Host header. */
function raw(url: string, { method = 'GET', host, body, headers = {} }: { method?: string; host?: string; body?: string; headers?: Record<string, string> } = {}) {
  const u = new URL(url);
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname, method, headers: { host: host ?? u.host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (url: string, json: unknown) => raw(url, { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } });

describe('npm run connect: formats', () => {
  it('checks each format and never puts the value in the message', async () => {
    const { PROVIDERS: list, checkValue, findProvider } = await import(/* @vite-ignore */ PROVIDERS);
    const field = (p: string, n: string) => list.find((x: { id: string }) => x.id === p).fields.find((f: { name: string }) => f.name === n);
    const stripe = field('stripe', 'stripe_webhook_secret');
    expect(checkValue(stripe, STRIPE)).toBeNull();
    expect(checkValue(stripe, `  ${STRIPE}\n`)).toBeNull();
    const secretKey = `sk_live_${randomBytes(12).toString('hex')}`;
    const msg = checkValue(stripe, secretKey);
    expect(msg).toMatch(/starts with whsec_/);
    expect(msg).not.toContain(secretKey);
    expect(msg).not.toContain(secretKey.slice(0, 12));
    const rk = field('stripe-key', 'STRIPE_RESTRICTED_KEY');
    expect(checkValue(rk, `rk_live_${'a'.repeat(24)}`)).toBeNull();
    expect(checkValue(rk, secretKey)).toMatch(/never the secret key/);
    expect(checkValue(stripe, '••••••••')).toMatch(/dots/);
    expect(checkValue(stripe, '')).toMatch(/empty/);
    const p8 = field('app-store-connect', 'ASC_KEY_P8');
    expect(checkValue(p8, PEM)).toBeNull();
    expect(checkValue(p8, PEM.replace(/\n/g, '\r\n'))).toBeNull();
    expect(checkValue(p8, PEM.split('\n').slice(1).join('\n'))).toMatch(/BEGIN PRIVATE KEY/);
    const keyId = field('app-store-connect', 'ASC_KEY_ID');
    expect(checkValue(keyId, '2X9R4HXF34')).toBeNull();
    expect(checkValue(keyId, 'short')).toMatch(/10 letters/);
    expect(checkValue(field('ai-engines', 'OPENAI_API_KEY'), '')).toBeNull();
    expect(checkValue(field('revenuecat', 'revenuecat_auth'), `Bearer ${'x'.repeat(20)}`)).toBeNull();
    expect(findProvider('openai')).toMatchObject({ provider: { id: 'ai-engines' }, only: ['OPENAI_API_KEY'] });
    expect(findProvider('nope')).toBeNull();
  });

  it('names real secrets from env.ts and the PATCH handler, each with a provider page', async () => {
    const { PROVIDERS: list } = await import(/* @vite-ignore */ PROVIDERS);
    const env = readFileSync(new URL('../src/worker/env.ts', import.meta.url), 'utf8');
    for (const p of list) {
      for (const f of p.fields) {
        expect(f.url, `${p.id} ${f.name}`).toMatch(/^https:\/\//);
        if (f.dest === 'worker') expect(env, f.name).toMatch(new RegExp(`\\b${f.name}\\?:`));
        else expect(env, f.name).toMatch(new RegExp(`\\b${f.name}\\??:`));
      }
    }
  });
});

describe('npm run connect', () => {
  it('--stdin pipes the value to wrangler secret put and prints only the result', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const value = `whsec_${randomBytes(16).toString('hex')}`;
    const f = deps(box, { stdin: `${value}\n` });
    expect(await runConnect(['resend-webhook', '--stdin', '--json'], f.d)).toBe(0);
    expect(f.puts).toEqual([{ name: 'RESEND_WEBHOOK_SECRET', input: value }]);
    expect(f.out).toEqual(['{"ok":true,"provider":"resend-webhook","set":["RESEND_WEBHOOK_SECRET"],"verified":true}']);
    expect([...f.out, ...f.err, f.log()].join('\n')).not.toContain(value);
    expect(f.log()).toContain('resend-webhook: wrangler secret put RESEND_WEBHOOK_SECRET');
  });

  it('--stdin at a terminal reads each value hidden', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const login = 'owner@acme.example';
    const pass = randomBytes(8).toString('hex');
    const f = deps(box, { tty: true, typed: [login, pass] });
    expect(await runConnect(['dataforseo', '--stdin', '--json'], f.d)).toBe(0);
    expect(f.puts).toEqual([
      { name: 'DATAFORSEO_LOGIN', input: login },
      { name: 'DATAFORSEO_PASSWORD', input: pass },
    ]);
    expect([...f.out, ...f.err, f.log()].join('\n')).not.toContain(pass);
  });

  it('a value in the wrong format exits 2 and stores nothing', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const wrong = `sk_${randomBytes(16).toString('hex')}`;
    const f = deps(box, { stdin: wrong });
    expect(await runConnect(['resend-webhook', '--stdin', '--json'], f.d)).toBe(2);
    expect(f.puts).toEqual([]);
    const r = JSON.parse(f.out[0]);
    expect(r).toMatchObject({ ok: false, code: 2, provider: 'resend-webhook', need: 'value' });
    expect([...f.out, ...f.err, f.log()].join('\n')).not.toContain(wrong);
  });

  it('not logged in to Wrangler: exit 3 before asking for anything', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const f = deps(sandbox(), { loggedIn: false, stdin: 'x' });
    expect(await runConnect(['x', '--stdin', '--json'], f.d)).toBe(3);
    expect(JSON.parse(f.out[0])).toMatchObject({ need: 'login', command: 'npx wrangler login' });
  });

  it('--file reads the .p8, takes the key id from its name, and --delete-file removes it', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const file = join(box.root, 'AuthKey_ABCDEFGHIJ.p8');
    writeFileSync(file, `${PEM}\n`);
    const f = deps(box);
    expect(await runConnect(['push', '--file', file, '--delete-file', '--secret', 'APNS_KEY_P8,APNS_KEY_ID', '--json'], f.d)).toBe(0);
    expect(f.puts).toEqual([
      { name: 'APNS_KEY_P8', input: PEM },
      { name: 'APNS_KEY_ID', input: 'ABCDEFGHIJ' },
    ]);
    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(f.out[0])).toMatchObject({ ok: true, set: ['APNS_KEY_P8', 'APNS_KEY_ID'], verified: true, deleted_file: true });
    expect([...f.out, ...f.err, f.log()].join('\n')).not.toContain(PEM.split('\n')[1]);
  });

  it('--watch-downloads picks up a new AuthKey_*.p8 in Downloads', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    writeFileSync(join(box.downloads, 'AuthKey_OLDOLDOLD1.p8'), PEM);
    writeFileSync(join(box.downloads, 'notes.txt'), 'hello');
    const f = deps(box);
    const run = runConnect(['app-store-connect', '--watch-downloads', '--delete-file', '--secret', 'ASC_KEY_P8,ASC_KEY_ID', '--json'], f.d);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(box.downloads, 'AuthKey_2X9R4HXF34.p8'), PEM);
    expect(await run).toBe(0);
    expect(f.puts).toEqual([
      { name: 'ASC_KEY_P8', input: PEM },
      { name: 'ASC_KEY_ID', input: '2X9R4HXF34' },
    ]);
    expect(existsSync(join(box.downloads, 'AuthKey_2X9R4HXF34.p8'))).toBe(false);
    expect(existsSync(join(box.downloads, 'AuthKey_OLDOLDOLD1.p8'))).toBe(true);
    expect(f.err.join('\n')).toContain('Waiting for Key file (.p8) (AuthKey_*.p8)');
  });

  it('the paste page: one-time token, 404 elsewhere, wrong Host refused, CSP, saves once', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment([{ id: 'acme', name: 'Acme', domain: 'acme.example', stripe_webhook_secret: null }]);
    const box = sandbox(dep.url);
    const f = deps(box);
    const run = runConnect(['stripe', '--json'], f.d);
    const url = await f.page;
    const u = new URL(url);
    expect(u.hostname).toBe('127.0.0.1');
    expect(u.pathname.length).toBeGreaterThan(30);

    const page = await raw(url);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Connect <span class="serif">Stripe</span>');
    expect(page.text).toContain('https://dashboard.stripe.com/webhooks');
    expect(String(page.headers['content-security-policy'])).toMatch(/default-src 'none'; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'/);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await raw(`${u.origin}/`)).status).toBe(404);
    expect((await raw(`${u.origin}/${'x'.repeat(32)}`)).status).toBe(404);
    expect((await raw(url, { host: 'evil.example' })).status).toBe(421);
    expect((await raw(url, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await raw(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })).status).toBe(403);

    // A wrong format: a field error without the value, and the page stays open.
    const wrong = `sk_live_${randomBytes(10).toString('hex')}`;
    const bad = await post(url, { values: { stripe_webhook_secret: wrong } });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text).errors.stripe_webhook_secret).toMatch(/starts with whsec_/);
    expect(bad.text).not.toContain(wrong);

    const ok = await post(url, { values: { stripe_webhook_secret: STRIPE } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({ ok: true });
    expect(await run).toBe(0);
    expect(f.out).toEqual(['{"ok":true,"provider":"stripe","site":"acme","set":["stripe_webhook_secret"],"verified":true}']);
    expect(dep.patches).toEqual([{ id: 'acme', body: { stripe_webhook_secret: STRIPE } }]);
    // The server is gone: a second save can't happen.
    await expect(post(url, { values: { stripe_webhook_secret: STRIPE } })).rejects.toThrow();
    expect([...f.out, ...f.err, f.log()].join('\n')).not.toContain(STRIPE);
    expect(f.log()).toContain('stripe: PATCH /api/sites/acme stripe_webhook_secret');
  });

  it('the paste page closes after the time limit with exit 3', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const f = deps(sandbox());
    f.d.timeoutMs = 200;
    expect(await runConnect(['x', '--json'], f.d)).toBe(3);
    expect(JSON.parse(f.out[0])).toMatchObject({ ok: false, need: 'paste' });
    await expect(raw(await f.page)).rejects.toThrow();
    expect(f.puts).toEqual([]);
  });

  it('asks for --site when there are several sites, exit 2 with the list', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment([
      { id: 'acme', name: 'Acme', domain: 'acme.example' },
      { id: 'app1', name: 'Acme app', domain: 'app1.invalid' },
    ]);
    const f = deps(sandbox(dep.url), { stdin: STRIPE });
    expect(await runConnect(['stripe', '--stdin', '--json'], f.d)).toBe(2);
    expect(JSON.parse(f.out[0])).toMatchObject({ need: 'site', sites: [{ id: 'acme', name: 'Acme', domain: 'acme.example' }, { id: 'app1', name: 'Acme app', domain: null }] });
    expect(dep.patches).toEqual([]);
    const g = deps(sandbox(dep.url), { stdin: STRIPE });
    expect(await runConnect(['stripe', '--site', 'app1', '--stdin', '--json'], g.d)).toBe(0);
    expect(dep.patches).toEqual([{ id: 'app1', body: { stripe_webhook_secret: STRIPE } }]);
  });

  it('generate revenuecat stores a new value and shows it once on the page, never on stdout', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment([{ id: 'app1', name: 'Acme app', domain: 'app1.invalid', revenuecat_auth: null }]);
    const f = deps(sandbox(dep.url));
    const run = runConnect(['generate', 'revenuecat', '--json'], f.d);
    const url = await f.page;
    expect(dep.patches).toHaveLength(1);
    const value = String(dep.patches[0].body.revenuecat_auth);
    expect(value).toMatch(/^[\w-]{40,}$/);
    const first = await raw(url);
    expect(first.status).toBe(200);
    expect(first.text).toContain(value);
    // Shown once: a reload gets the used page.
    const again = await raw(url);
    expect(again.status).toBe(410);
    expect(again.text).not.toContain(value);
    expect((await post(url, { done: true })).status).toBe(200);
    expect(await run).toBe(0);
    expect(JSON.parse(f.out[0])).toEqual({ ok: true, provider: 'revenuecat', site: 'app1', set: ['revenuecat_auth'], verified: true });
    expect([...f.out, ...f.err, f.log()].join('\n')).not.toContain(value);
  });

  it('gumroad makes the ping URL token and shows the URL on the page only', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment([{ id: 'acme', name: 'Acme', domain: 'acme.example' }]);
    const f = deps(sandbox(dep.url));
    const run = runConnect(['gumroad', '--json'], f.d);
    const url = await f.page;
    const res = await post(url, { values: { gumroad_seller_id: 'seller_1' } });
    expect(JSON.parse(res.text).reveal.value).toBe(`${dep.url}/api/webhooks/gumroad/acme/tok123`);
    expect(await run).toBe(0);
    expect(dep.patches[0].body).toEqual({ gumroad_seller_id: 'seller_1', gumroad_new_token: true });
    expect(f.out.join('\n')).not.toContain('tok123');
  });

  it('list describes every provider without values', async () => {
    const { runConnect } = await import(/* @vite-ignore */ SCRIPT);
    const f = deps(sandbox());
    expect(await runConnect(['list', '--json'], f.d)).toBe(0);
    const { providers } = JSON.parse(f.out[0]);
    expect(providers.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(['stripe', 'dodo', 'lemonsqueezy', 'polar', 'paddle', 'gumroad', 'revenuecat', 'resend', 'dataforseo', 'google-search-console', 'ai-engines', 'meta-ads', 'x', 'apple-search-ads', 'app-store-connect', 'cloudflare']),
    );
    expect(providers.find((p: { id: string }) => p.id === 'stripe').secrets[0]).toMatchObject({ name: 'stripe_webhook_secret', destination: 'site setting (PATCH /api/sites/:id)' });
    expect(await runConnect(['nope', '--json'], f.d)).toBe(2);
  });
});
