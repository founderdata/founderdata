import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// npm run doctor against a fake deployment on 127.0.0.1 and a fake Wrangler: its JSON shape and its exit codes.
const SCRIPT = '../scripts/doctor.mjs';
const ROOT = new URL('..', import.meta.url).pathname;
const PASSWORD = 'correct-horse-battery-staple';
const ID = '3f2b9c1e-8d4a-4f6b-9e2d-1a7c5b8e0f42';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

const step = (id: string, status: string, extra = {}) => ({
  id,
  group: 'deploy',
  site: null,
  title: `Do ${id}`,
  outcome: 'Something useful.',
  status,
  who: 'agent',
  required: true,
  evidence: null,
  next: status === 'done' ? null : `Finish ${id}.`,
  prompt: status === 'done' ? null : `Please finish ${id}.`,
  skill: null,
  url: null,
  command: status === 'done' ? null : 'npm run connect -- stripe --site SITE',
  cost: 'Free',
  ...extra,
});

function setupState(version: string, next: ReturnType<typeof step> | null) {
  const steps = [step('deploy', 'done'), ...(next ? [next] : [])];
  return {
    edition: 'core',
    version,
    origin: 'http://127.0.0.1',
    now: 1,
    progress: { done: 1, total: steps.length, required_done: 1, required_total: steps.length },
    next,
    steps,
    sites: [],
  };
}

/** A fake deployment: login with PASSWORD, and /api/v1/setup answering `setup` (404 when null). */
async function fakeDeployment(setup: object | null) {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, json: object, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(json));
      };
      if (req.url === '/api/auth/me') return send(200, { loggedIn: !!req.headers.cookie });
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        return JSON.parse(body).password === PASSWORD ? send(200, { ok: true }, { 'set-cookie': 'fd_auth=ok; Path=/; HttpOnly' }) : send(401, { error: 'Wrong password' });
      }
      if (req.url?.startsWith('/api/v1/setup')) {
        if (req.headers.cookie !== 'fd_auth=ok') return send(401, { error: 'login' });
        return setup ? send(200, setup) : send(404, { error: 'Not found' });
      }
      send(404, { error: 'Not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => server.close());
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen };
}

function sandbox({ password = PASSWORD as string | null, url = null as string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fd-doctor-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  mkdirSync(join(cwd, 'node_modules', 'wrangler'), { recursive: true });
  writeFileSync(join(cwd, 'node_modules', 'wrangler', 'package.json'), '{"version":"4.164.0"}');
  writeFileSync(join(cwd, 'package.json'), '{"version":"1.5.0"}');
  copyFileSync(join(ROOT, 'wrangler.jsonc'), join(cwd, 'wrangler.jsonc'));
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  if (password) writeFileSync(join(configDir, 'admin-password'), `${password}\n`);
  if (url) writeFileSync(join(configDir, 'url'), `${url}\n`);
  return { cwd, configDir };
}

function deps(box: { cwd: string; configDir: string }, { loggedIn = true, pending = '✅ No migrations to apply!' } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  return {
    d: {
      cwd: box.cwd,
      env: {},
      configDir: box.configDir,
      nodeVersion: '22.11.0',
      wrangler: (args: string[]) => {
        calls.push(args.join(' '));
        if (args[0] === 'whoami') {
          return loggedIn
            ? { ok: true, status: 0, out: JSON.stringify({ loggedIn: true, accounts: [{ id: 'acc1', name: 'Acme' }] }) }
            : { ok: false, status: 1, out: '{"loggedIn":false}' };
        }
        if (args[0] === 'd1' && args[1] === 'list') return { ok: true, status: 0, out: JSON.stringify([{ uuid: ID, name: 'founderdata' }]) };
        if (args[0] === 'd1' && args[1] === 'migrations') return { ok: true, status: 0, out: pending };
        return { ok: false, status: 1, out: '' };
      },
      fetch,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
    },
    out,
    err,
    calls,
  };
}

describe('npm run doctor', () => {
  it('answers the contract shape and exits 0 when everything is done', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment(setupState('1.5.0', null));
    const box = sandbox({ url: dep.url });
    const f = deps(box);
    expect(await runDoctor(['--json'], f.d)).toBe(0);
    expect(f.out).toHaveLength(1);
    const r = JSON.parse(f.out[0]);
    expect(Object.keys(r)).toEqual(expect.arrayContaining(['ok', 'local', 'deployed', 'setup', 'next']));
    expect(r.ok).toBe(true);
    expect(r.next).toBeNull();
    expect(Object.keys(r.local).sort()).toEqual(['config', 'dependencies', 'migrations', 'node', 'saved', 'wrangler']);
    expect(r.local.saved.files).toEqual(['admin-password', 'url']);
    expect(r.local.config).toMatchObject({ ok: true, file: 'wrangler.jsonc', database_name: 'founderdata', database_id: ID, database_found: true });
    expect(r.deployed).toMatchObject({ url: dep.url, source: 'saved', reachable: true, login: 'ok', setup_api: 'ok', version: '1.5.0', up_to_date: true });
    expect(r.setup.progress).toEqual({ done: 1, total: 1, required_done: 1, required_total: 1 });
    // Read-only: only reads went to Wrangler.
    expect(f.calls).toEqual(['whoami --json', 'd1 list --json', 'd1 migrations list DB --remote']);
    // The password never shows.
    expect([...f.out, ...f.err].join('\n')).not.toContain(PASSWORD);
  });

  it('exits 1 with the setup state\'s next step', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment(setupState('1.5.0', step('payments:acme', 'todo', { site: { id: 'acme', name: 'Acme' } })));
    const f = deps(sandbox({ url: dep.url }));
    expect(await runDoctor(['--json'], f.d)).toBe(1);
    const r = JSON.parse(f.out[0]);
    expect(r.next).toMatchObject({ title: 'Do payments:acme', command: 'npm run connect -- stripe --site SITE', prompt: 'Please finish payments:acme.', step: 'payments:acme' });
    expect(r.setup.steps).toHaveLength(2);
    // The human text says the same next step.
    const g = deps(sandbox({ url: dep.url }));
    expect(await runDoctor([], g.d)).toBe(1);
    expect(g.out.join('\n')).toContain('Next: Do payments:acme');
  });

  it('a deployment without /api/v1/setup (404) says to update it, exit 1', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment(null);
    const f = deps(sandbox({ url: dep.url }));
    expect(await runDoctor(['--json'], f.d)).toBe(1);
    const r = JSON.parse(f.out[0]);
    expect(r.setup).toBeNull();
    expect(r.deployed).toMatchObject({ reachable: true, login: 'ok', setup_api: 'missing' });
    expect(r.next).toMatchObject({ command: 'npm run setup' });
    expect(r.next.title).toMatch(/older than the setup checks/);
  });

  it('a deployment behind this checkout says to update it', async () => {
    const { runDoctor, compareVersions } = await import(/* @vite-ignore */ SCRIPT);
    expect(compareVersions('1.4.9', '1.5.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    const dep = await fakeDeployment(setupState('1.4.0', null));
    const f = deps(sandbox({ url: dep.url }));
    expect(await runDoctor(['--json'], f.d)).toBe(1);
    expect(JSON.parse(f.out[0]).deployed.up_to_date).toBe(false);
  });

  it('pending migrations are something to do', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment(setupState('1.5.0', null));
    const f = deps(sandbox({ url: dep.url }), { pending: '│ 0099_store_cancel_reasons.sql │' });
    expect(await runDoctor(['--json'], f.d)).toBe(1);
    const r = JSON.parse(f.out[0]);
    expect(r.local.migrations).toEqual({ ok: false, pending: 1 });
    expect(r.next.command).toBe('npm run setup');
  });

  it('exits 3 when Wrangler is not logged in', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment(setupState('1.5.0', null));
    const f = deps(sandbox({ url: dep.url }), { loggedIn: false });
    expect(await runDoctor(['--json'], f.d)).toBe(3);
    const r = JSON.parse(f.out[0]);
    expect(r.local.wrangler).toMatchObject({ ok: false, logged_in: false });
    expect(r.next).toMatchObject({ command: 'npx wrangler login' });
    // The deployment is still checked.
    expect(r.deployed.login).toBe('ok');
  });

  it('exits 4 when the saved password is refused or the address does not answer', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment(setupState('1.5.0', null));
    const f = deps(sandbox({ url: dep.url, password: 'wrong-password' }));
    expect(await runDoctor(['--json'], f.d)).toBe(4);
    expect(JSON.parse(f.out[0]).deployed.login).toBe('refused');
    expect(f.out.join('\n')).not.toContain('wrong-password');
    const g = deps(sandbox({ url: 'http://127.0.0.1:9' }));
    expect(await runDoctor(['--json'], g.d)).toBe(4);
    expect(JSON.parse(g.out[0]).deployed.reachable).toBe(false);
  });

  it('exits 2 when the address is unknown, and --url fills it in', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const f = deps(sandbox());
    expect(await runDoctor(['--json'], f.d)).toBe(2);
    expect(JSON.parse(f.out[0]).deployed.url).toBeNull();
    const dep = await fakeDeployment(setupState('1.5.0', null));
    const g = deps(sandbox());
    expect(await runDoctor(['--json', '--url', `${dep.url}/`], g.d)).toBe(0);
    expect(JSON.parse(g.out[0]).deployed).toMatchObject({ url: dep.url, source: 'flag' });
  });

  it('passes --site to /api/v1/setup', async () => {
    const { runDoctor } = await import(/* @vite-ignore */ SCRIPT);
    const dep = await fakeDeployment(setupState('1.5.0', null));
    const f = deps(sandbox({ url: dep.url }));
    await runDoctor(['--json', '--site', 'acme'], f.d);
    expect(dep.seen).toContain('GET /api/v1/setup?site=acme');
  });
});
