#!/usr/bin/env node
// Checks a FounderData install from this checkout and says the one next step. Read-only: it changes nothing, writes
// no file and makes no billed call.
//
//   npm run doctor
//   npm run doctor -- --json                 # one JSON object on stdout
//   npm run doctor -- --url https://founderdata.example.com --site SITE_ID
//
// Local checks: Node 20 or later, the dependencies, the Wrangler login and its account, the Wrangler config and its
// database, the saved files in ~/.config/founderdata/ (names only) and the migrations not applied yet. Deployed checks:
// the address answers, the saved admin password logs in (it is never printed), and GET /api/v1/setup, whose steps and
// next step come back as `setup`. A deployment older than that route answers 404: doctor then says to run npm run setup.
//
// JSON: { ok, code, local: { node, dependencies, wrangler, config, saved, migrations }, deployed: { url, source,
// reachable, login, setup_api, version, local_version, up_to_date }, setup: SetupState | null, next: { title, command,
// prompt } | null }. Exit codes: 0 all done, 1 something to do, 2 an input is missing (the address), 3 only the person
// can act (the Cloudflare login), 4 an error (the address does not answer, the password is refused).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  configDir,
  dashboardSession,
  dependenciesInstalled,
  Exit,
  EXIT,
  installedVersion,
  makeWrangler,
  parseFlags,
  readPassword,
  resolveUrl,
  savedFiles,
  shortDir,
  wranglerLogin,
} from './lib/cli.mjs';
import { findDatabase, pendingMigrations, readDatabaseName } from './setup.mjs';

/** What runDoctor uses from the machine. The tests pass fakes. */
export function realDeps(cwd = process.cwd()) {
  return {
    cwd,
    env: process.env,
    configDir: configDir(),
    nodeVersion: process.versions.node,
    wrangler: makeWrangler(cwd),
    fetch,
    stdout: (t) => process.stdout.write(`${t}\n`),
    stderr: (t) => process.stderr.write(`${t}\n`),
  };
}

/** The version in this checkout's package.json. */
const localVersion = (cwd) => {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
};

/** -1, 0 or 1 for two versions like 1.5.0. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** Runs every check and returns the exit code. */
export async function runDoctor(argv, d) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, { values: ['--url', '--site'] }));
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    d.stderr(`✗ ${e.message}`);
    return e.code;
  }
  if (flags['--help']) {
    d.stdout('Checks this install and prints the next step. Read-only.\n\nUsage: npm run doctor -- [--json] [--url <address>] [--site <id>]\n\nExit codes: 0 all done, 1 something to do, 2 an input is missing, 3 only you can act, 4 an error.');
    return EXIT.DONE;
  }
  const json = !!flags['--json'];
  const report = await check(d, flags);
  if (json) d.stdout(JSON.stringify(report));
  else print(report, d.stdout);
  return report.code;
}

async function check(d, flags) {
  /** Problems in the order they block each other; the first one is the next step. */
  const issues = [];
  const issue = (code, title, command = null) => issues.push({ code, title, command });

  const major = Number.parseInt(d.nodeVersion, 10);
  const local = {};
  local.node = { ok: major >= 20, version: d.nodeVersion };
  if (!local.node.ok) issue(EXIT.TODO, 'Install Node 20 or later.', null);

  const deps = dependenciesInstalled(d.cwd);
  local.dependencies = { ok: deps, wrangler: deps ? installedVersion(d.cwd, 'wrangler') : null };
  if (!deps) issue(EXIT.TODO, 'Install the dependencies.', 'npm install');

  local.wrangler = { ok: false, logged_in: null, accounts: [] };
  if (deps) {
    const who = wranglerLogin(d.wrangler);
    local.wrangler = { ok: who.loggedIn, logged_in: who.loggedIn, accounts: who.accounts.map((a) => ({ name: a.name, id: a.id })) };
    if (!who.loggedIn) issue(EXIT.HUMAN, 'Log in to Cloudflare in a terminal.', 'npx wrangler login');
  }

  const file = existsSync(join(d.cwd, 'wrangler.local.jsonc')) ? 'wrangler.local.jsonc' : existsSync(join(d.cwd, 'wrangler.jsonc')) ? 'wrangler.jsonc' : null;
  const text = file ? readFileSync(join(d.cwd, file), 'utf8') : '';
  const name = readDatabaseName(text);
  let dbId = text.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  let found = null;
  if (local.wrangler.ok && name) {
    const list = d.wrangler(['d1', 'list', '--json'], { capture: true, stdin: 'ignore' });
    if (list.ok) {
      const id = findDatabase(list.out, name);
      found = !!id;
      dbId = dbId ?? id;
    }
  }
  local.config = { ok: !!file && !!name && found !== false, file, database_name: name, database_id: dbId, database_found: found };
  if (!file) issue(EXIT.ERROR, 'Run this from the FounderData repository root.', null);
  else if (found === false) issue(EXIT.TODO, `The D1 database "${name}" does not exist yet. Deploy FounderData.`, 'npm run setup');

  const files = savedFiles(d.configDir);
  const password = readPassword(d.configDir, d.env);
  local.saved = { ok: !!password, dir: shortDir(d.configDir), files };

  local.migrations = { ok: true, pending: null };
  if (found) {
    const listed = d.wrangler(['d1', 'migrations', 'list', 'DB', '--remote'], { capture: true, stdin: 'ignore' });
    if (listed.ok) {
      const pending = pendingMigrations(listed.out);
      local.migrations = { ok: pending === 0, pending };
      if (pending) issue(EXIT.TODO, `${pending} database migration${pending === 1 ? '' : 's'} not applied yet. Update the deployment.`, 'npm run setup');
    }
  }

  const { url, source } = resolveUrl(flags['--url'], d.configDir, d.env);
  const deployed = { url, source, reachable: null, login: null, setup_api: null, version: null, local_version: localVersion(d.cwd), up_to_date: null };
  let setup = null;
  if (!url) {
    if (password || found) issue(EXIT.DECIDE, 'Pass the dashboard address, or run npm run setup once to save it.', 'npm run doctor -- --url https://your-founderdata.example.com');
    else if (found !== false) issue(EXIT.TODO, 'Deploy FounderData.', 'npm run setup');
  } else {
    try {
      const res = await d.fetch(`${url}/api/auth/me`, { signal: AbortSignal.timeout(10_000) });
      deployed.reachable = res.ok;
    } catch {
      deployed.reachable = false;
    }
    if (!deployed.reachable) issue(EXIT.ERROR, `${url} does not answer. Check the address, or deploy again.`, 'npm run setup');
    else if (!password) {
      deployed.login = 'no password';
      issue(EXIT.DECIDE, `No saved admin password in ${shortDir(d.configDir)}. Set ADMIN_PASSWORD for this run.`, 'ADMIN_PASSWORD=... npm run doctor');
    } else {
      let call = null;
      try {
        call = await dashboardSession(url, password, d.fetch);
        deployed.login = 'ok';
      } catch {
        deployed.login = 'refused';
        issue(EXIT.ERROR, 'The saved admin password does not log in. npm run setup deploys it again.', 'npm run setup');
      }
      if (call) {
        const site = typeof flags['--site'] === 'string' ? `?site=${encodeURIComponent(flags['--site'])}` : '';
        const res = await call(`/api/v1/setup${site}`).catch(() => null);
        if (res?.status === 404) {
          deployed.setup_api = 'missing';
          issue(EXIT.TODO, 'This deployment is older than the setup checks. Update it.', 'npm run setup');
        } else if (!res?.ok) {
          deployed.setup_api = 'error';
          issue(EXIT.ERROR, `GET /api/v1/setup answered ${res ? `HTTP ${res.status}` : 'nothing'}.`, null);
        } else {
          setup = await res.json().catch(() => null);
          deployed.setup_api = setup ? 'ok' : 'error';
          deployed.version = setup?.version ?? null;
          if (deployed.version && deployed.local_version) {
            deployed.up_to_date = compareVersions(deployed.version, deployed.local_version) >= 0;
            if (!deployed.up_to_date) issue(EXIT.TODO, `The deployment runs ${deployed.version}; this checkout has ${deployed.local_version}. Update it.`, 'npm run setup');
          }
        }
      }
    }
  }

  let next = null;
  let code = EXIT.DONE;
  if (issues.length) {
    code = issues[0].code;
    next = { title: issues[0].title, command: issues[0].command, prompt: null };
  } else if (setup?.next) {
    code = EXIT.TODO;
    next = { title: setup.next.title, command: setup.next.command ?? null, prompt: setup.next.prompt ?? null, step: setup.next.id ?? null, who: setup.next.who ?? null };
  }
  return { ok: code === EXIT.DONE, code, local, deployed, setup, next, issues };
}

function print(r, out) {
  const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '·');
  const l = r.local;
  out('FounderData doctor');
  out(`  ${mark(l.node.ok)} Node ${l.node.version}${l.node.ok ? '' : ' (needs 20 or later)'}`);
  out(`  ${mark(l.dependencies.ok)} Dependencies ${l.dependencies.ok ? `installed (wrangler ${l.dependencies.wrangler})` : 'not installed'}`);
  out(`  ${mark(l.wrangler.logged_in)} Cloudflare login${l.wrangler.logged_in ? `: ${l.wrangler.accounts.map((a) => a.name).join(', ') || 'yes'}` : l.wrangler.logged_in === false ? ': not logged in' : ''}`);
  out(`  ${mark(l.config.ok)} Config ${l.config.file ?? 'missing'}${l.config.database_name ? `, database ${l.config.database_name}${l.config.database_found === false ? ' (not created yet)' : ''}` : ''}`);
  out(`  ${mark(l.saved.ok)} Saved in ${l.saved.dir}: ${l.saved.files.join(', ') || 'nothing'}`);
  out(`  ${mark(l.migrations.pending === null ? null : l.migrations.ok)} Migrations: ${l.migrations.pending === null ? 'not checked' : l.migrations.pending ? `${l.migrations.pending} pending` : 'none pending'}`);
  const dpl = r.deployed;
  if (dpl.url) {
    out(`  ${mark(dpl.reachable)} ${dpl.url}${dpl.reachable ? ' answers' : dpl.reachable === false ? ' does not answer' : ''}`);
    if (dpl.login) out(`  ${mark(dpl.login === 'ok')} Login with the saved password${dpl.login === 'ok' ? ' works' : `: ${dpl.login}`}`);
    if (dpl.setup_api) out(`  ${mark(dpl.setup_api === 'ok')} Setup state${dpl.setup_api === 'missing' ? ': this deployment has no /api/v1/setup yet' : ''}${dpl.version ? `, version ${dpl.version}` : ''}`);
  } else out('  · Dashboard address unknown');
  if (r.setup?.progress) {
    const p = r.setup.progress;
    out(`\n  ${p.done} of ${p.total} steps done, ${p.required_done} of ${p.required_total} required.`);
    for (const s of r.setup.steps ?? []) {
      if (s.status === 'off' || s.status === 'locked') continue;
      out(`  ${s.status === 'done' ? '✓' : s.status === 'broken' ? '✗' : '·'} ${s.title}${s.site ? ` (${s.site.name})` : ''}: ${s.status}${s.evidence ? `. ${s.evidence}` : ''}`);
    }
  }
  if (r.next) {
    out(`\nNext: ${r.next.title}`);
    if (r.next.command) out(`  ${r.next.command}`);
    else if (r.next.prompt) out(`  Prompt for your agent: ${r.next.prompt}`);
  } else out('\nEverything is done.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDoctor(process.argv.slice(2), realDeps()).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`✗ ${e.message}`);
      process.exit(EXIT.ERROR);
    },
  );
}
