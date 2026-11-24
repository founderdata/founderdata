import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// npm run setup as an agent runs it: --dry-run, --json, the region gate, the login gate and the exit codes. Wrangler,
// the build and the deploy are fakes, so nothing here touches a Cloudflare account.
const SCRIPT = '../scripts/setup.mjs';
const ROOT = new URL('..', import.meta.url).pathname;
const ID = '3f2b9c1e-8d4a-4f6b-9e2d-1a7c5b8e0f42';
// Built from parts so this file holds no workers.dev host (test/open-source.test.ts).
const HOST = ['https://founderdata', 'acme-example', 'workers', 'dev'].join('.');
/** Wrangler commands that change an account. A dry run must call none of them. */
const MUTATING = [/^d1 create/, /^d1 migrations apply/, /^deploy/, /^secret put/, /^login/, /^r2 bucket create/, /^r2 bucket lifecycle add/, /^queues create/];

type Call = { args: string[]; input?: string };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository copy with the config, two migrations and an installed Wrangler, and an empty config folder. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'fd-setup-'));
  dirs.push(root);
  const cwd = join(root, 'repo');
  mkdirSync(join(cwd, 'migrations'), { recursive: true });
  mkdirSync(join(cwd, 'node_modules', 'wrangler'), { recursive: true });
  writeFileSync(join(cwd, 'node_modules', 'wrangler', 'package.json'), '{"version":"4.164.0"}');
  copyFileSync(join(ROOT, 'wrangler.jsonc'), join(cwd, 'wrangler.jsonc'));
  writeFileSync(join(cwd, 'migrations', '0001_init.sql'), '');
  writeFileSync(join(cwd, 'migrations', '0002_more.sql'), '');
  return { cwd, configDir: join(root, 'config') };
}

interface FakeOpts {
  loggedIn?: boolean;
  databases?: { uuid: string; name: string; jurisdiction?: string }[];
  pending?: string;
  deployOut?: string;
  deployOk?: boolean;
  tty?: boolean;
  answers?: string[];
  env?: Record<string, string>;
}

function deps(box: { cwd: string; configDir: string }, o: FakeOpts = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  let built = 0;
  let deployed = 0;
  let dbs = [...(o.databases ?? [])];
  const wrangler = (args: string[], opts: { input?: string } = {}) => {
    calls.push({ args, input: opts.input });
    const cmd = args.join(' ');
    if (cmd.startsWith('whoami')) {
      return o.loggedIn === false
        ? { ok: false, status: 1, out: '{"loggedIn":false}' }
        : { ok: true, status: 0, out: JSON.stringify({ loggedIn: true, accounts: [{ id: 'acc1', name: 'Acme' }] }) };
    }
    if (cmd.startsWith('d1 list')) return { ok: true, status: 0, out: JSON.stringify(dbs) };
    if (cmd.startsWith('d1 create')) {
      dbs.push({ uuid: ID, name: args[2], ...(args[4] ? { jurisdiction: args[4] } : {}) });
      return { ok: true, status: 0, out: 'created' };
    }
    if (cmd.startsWith('d1 migrations list')) return { ok: true, status: 0, out: o.pending ?? '✅ No migrations to apply!' };
    if (cmd.startsWith('login')) return { ok: true, status: 0, out: '' };
    return { ok: true, status: 0, out: '' };
  };
  return {
    d: {
      cwd: box.cwd,
      env: o.env ?? {},
      configDir: box.configDir,
      isTTY: !!o.tty,
      wrangler,
      build: () => {
        built++;
        return true;
      },
      deploy: async () => {
        deployed++;
        return { ok: o.deployOk ?? true, out: o.deployOut ?? `Deployed founderdata\n  ${HOST}\n` };
      },
      ask: async (q: string) => {
        asked.push(q);
        return o.answers?.shift() ?? '';
      },
      fetch: (() => {
        throw new Error('no network in this test');
      }) as unknown as typeof fetch,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
    },
    calls,
    out,
    err,
    asked,
    counts: () => ({ built, deployed }),
  };
}

const json = (out: string[]) => JSON.parse(out[out.length - 1]);
const mutating = (calls: Call[]) => calls.map((c) => c.args.join(' ')).filter((c) => MUTATING.some((re) => re.test(c)));

describe('npm run setup for agents', () => {
  it('--dry-run lists every action for a new database and changes nothing', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box);
    const code = await runSetup(['--dry-run', '--region', 'eu', '--json'], f.d);
    expect(code).toBe(0);
    const r = json(f.out);
    expect(r).toMatchObject({ ok: true, code: 0, dry_run: true, database: { name: 'founderdata', id: null, region: 'eu' } });
    const actions = r.actions.map((a: { action: string }) => a.action);
    expect(actions).toContain('create the D1 database founderdata in jurisdiction eu');
    expect(actions).toContain('apply 2 D1 migrations');
    expect(actions).toContain('deploy the Worker with the secrets ADMIN_PASSWORD and SESSION_SECRET');
    expect(actions.some((a: string) => a.startsWith('create the admin password'))).toBe(true);
    expect(mutating(f.calls)).toEqual([]);
    expect(f.counts()).toEqual({ built: 0, deployed: 0 });
    // No file: no local config, no config folder, no log.
    expect(existsSync(join(box.cwd, 'wrangler.local.jsonc'))).toBe(false);
    expect(existsSync(box.configDir)).toBe(false);
    // With --json, stdout is one object; the progress went to stderr.
    expect(f.out).toHaveLength(1);
  });

  it('--dry-run on an existing database counts the pending migrations and asks nothing', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box, { databases: [{ uuid: ID, name: 'founderdata' }], pending: 'Migrations to be applied:\n│ 0098_errors_first.sql │\n│ 0099_store_cancel_reasons.sql │' });
    const code = await runSetup(['--dry-run'], f.d);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toContain('would apply 2 D1 migrations');
    expect(f.out.join('\n')).not.toContain('create the D1 database');
    expect(f.asked).toEqual([]);
    expect(mutating(f.calls)).toEqual([]);
  });

  it('--dry-run for a new database without a region lists the actions and exits 2', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box, { tty: true });
    const code = await runSetup(['--dry-run', '--json'], f.d);
    expect(code).toBe(2);
    const r = json(f.out);
    expect(r.need).toBe('region');
    expect(r.actions.map((a: { action: string }) => a.action)).toContain('create the D1 database founderdata in the region you choose (--region eu or --region auto)');
    expect(f.asked).toEqual([]);
    expect(mutating(f.calls)).toEqual([]);
  });

  it('a new database without a terminal exits 2 with the two commands, and creates nothing', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box);
    const code = await runSetup(['--name', 'analytics', '--json'], f.d);
    expect(code).toBe(2);
    const r = json(f.out);
    expect(r).toMatchObject({ ok: false, code: 2, need: 'region' });
    expect(r.choices).toEqual([
      { region: 'eu', command: 'npm run setup -- --region eu --name analytics' },
      { region: 'auto', command: 'npm run setup -- --region auto --name analytics' },
    ]);
    expect(f.err.join('\n')).toContain('npm run setup -- --region eu --name analytics');
    expect(mutating(f.calls)).toEqual([]);
    expect(existsSync(join(box.cwd, 'wrangler.local.jsonc'))).toBe(false);
  });

  it('a new database at a terminal asks where the data lives, then creates it in the EU', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box, { tty: true, answers: ['1'] });
    const code = await runSetup([], f.d);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toContain('Where must the data live? Cloudflare cannot move the database later.');
    expect(f.asked).toHaveLength(1);
    expect(f.calls.map((c) => c.args.join(' '))).toContain('d1 create founderdata --jurisdiction eu');
    expect(readFileSync(join(box.cwd, 'wrangler.local.jsonc'), 'utf8')).toContain('"DATA_JURISDICTION": "eu"');
    expect(readFileSync(join(box.configDir, 'url'), 'utf8').trim()).toBe(HOST);
    // The log names each action and never holds a secret.
    const log = readFileSync(join(box.configDir, 'agent-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.map((l) => l.action)).toEqual(
      expect.arrayContaining(['create D1 database founderdata in jurisdiction eu', 'apply D1 migrations', 'deploy the Worker with secrets ADMIN_PASSWORD, SESSION_SECRET']),
    );
    for (const l of log) expect(Object.keys(l).sort()).toEqual(['action', 'at', 'cmd', 'ok']);
    const password = readFileSync(join(box.configDir, 'admin-password'), 'utf8').trim();
    const session = readFileSync(join(box.configDir, 'session-secret'), 'utf8').trim();
    const everything = [readFileSync(join(box.configDir, 'agent-log.jsonl'), 'utf8'), ...f.out, ...f.err].join('\n');
    expect(everything).not.toContain(password);
    expect(everything).not.toContain(session);
  });

  it('--region auto creates the database without a jurisdiction; --jurisdiction eu still works', async () => {
    const { runSetup, readRegion } = await import(/* @vite-ignore */ SCRIPT);
    expect(readRegion([])).toBeUndefined();
    expect(readRegion(['--region', 'auto'])).toBeNull();
    expect(readRegion(['--region=eu'])).toBe('eu');
    expect(readRegion(['--jurisdiction', 'eu'])).toBe('eu');
    expect(readRegion(['--jurisdiction', 'fedramp'])).toBe('fedramp');
    expect(() => readRegion(['--region', 'us'])).toThrow(/eu or auto/);
    expect(() => readRegion(['--region', 'auto', '--jurisdiction', 'eu'])).toThrow(/disagree/);
    const box = sandbox();
    const f = deps(box);
    expect(await runSetup(['--region', 'auto'], f.d)).toBe(0);
    expect(f.calls.map((c) => c.args.join(' '))).toContain('d1 create founderdata');
  });

  it('an existing database gets no region question, at a terminal or without one', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    for (const tty of [true, false]) {
      const box = sandbox();
      const f = deps(box, { tty, databases: [{ uuid: ID, name: 'founderdata' }] });
      expect(await runSetup(['--json'], f.d)).toBe(0);
      expect(f.asked).toEqual([]);
      expect(f.calls.some((c) => c.args[0] === 'd1' && c.args[1] === 'create')).toBe(false);
      expect(json(f.out)).toMatchObject({ ok: true, url: HOST, database: { name: 'founderdata', id: ID, region: 'auto', created: false } });
      expect(f.counts()).toEqual({ built: 1, deployed: 1 });
    }
  });

  it('not logged in without a terminal exits 3 and never starts the browser login', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box, { loggedIn: false });
    const code = await runSetup(['--json'], f.d);
    expect(code).toBe(3);
    expect(json(f.out)).toMatchObject({ ok: false, code: 3, need: 'login', command: 'npx wrangler login' });
    expect(f.err.join('\n')).toContain('Run `npx wrangler login` in a terminal, then run setup again.');
    expect(f.calls.some((c) => c.args[0] === 'login')).toBe(false);
    // At a terminal it logs in as before.
    const g = deps(sandbox(), { loggedIn: false, tty: true, databases: [{ uuid: ID, name: 'founderdata' }] });
    await runSetup([], g.d);
    expect(g.calls.some((c) => c.args[0] === 'login')).toBe(true);
  });

  it('several Cloudflare accounts without a terminal: exit 2 with the accounts', async () => {
    const { runSetup } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box);
    f.d.wrangler = ((args: string[]) =>
      args[0] === 'whoami'
        ? { ok: true, status: 0, out: JSON.stringify({ loggedIn: true, accounts: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }] }) }
        : { ok: true, status: 0, out: '[]' }) as typeof f.d.wrangler;
    expect(await runSetup(['--json'], f.d)).toBe(2);
    expect(json(f.out)).toMatchObject({ need: 'account', accounts: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }] });
    const g = deps(sandbox(), { env: { CLOUDFLARE_ACCOUNT_ID: 'a' }, databases: [{ uuid: ID, name: 'founderdata' }] });
    expect(await runSetup([], g.d)).toBe(0);
  });

  it('an account without a workers.dev subdomain gets one line on how to fix it, and exit 3', async () => {
    const { runSetup, NO_SUBDOMAIN } = await import(/* @vite-ignore */ SCRIPT);
    const box = sandbox();
    const f = deps(box, {
      databases: [{ uuid: ID, name: 'founderdata' }],
      deployOk: false,
      deployOut: 'X [ERROR] You need to register a workers.dev subdomain before publishing to workers.dev',
    });
    expect(await runSetup(['--json'], f.d)).toBe(3);
    expect(json(f.out)).toMatchObject({ need: 'workers-dev-subdomain', error: NO_SUBDOMAIN });
    expect(NO_SUBDOMAIN.split('\n')).toHaveLength(1);
    expect(existsSync(join(box.configDir, 'url'))).toBe(false);
  });

  it('counts the pending migrations in Wrangler output', async () => {
    const { pendingMigrations } = await import(/* @vite-ignore */ SCRIPT);
    expect(pendingMigrations('✅ No migrations to apply!')).toBe(0);
    expect(pendingMigrations('│ 0098_errors_first.sql │\n│ 0099_store_cancel_reasons.sql │\n0099_store_cancel_reasons.sql')).toBe(2);
  });

  it('pins Wrangler to one exact version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.devDependencies.wrangler).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.scripts.doctor).toBe('node scripts/doctor.mjs');
    expect(pkg.scripts.connect).toBe('node scripts/connect.mjs');
    expect(readdirSync(join(ROOT, 'scripts', 'lib', 'fonts'))).toContain('LICENSE-InstrumentSerif.txt');
  });
});
