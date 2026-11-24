#!/usr/bin/env node
// The one way a key enters FounderData during an agent-run setup. The value goes from the person to Wrangler or the
// dashboard API, and the agent only learns that it was saved:
//
//   npm run connect -- stripe --site SITE_ID              # opens a paste page on 127.0.0.1 in the browser
//   npm run connect -- stripe --site SITE_ID --stdin      # or type it, hidden, in this terminal (or pipe it in)
//   npm run connect -- app-store-connect --file ~/Downloads/AuthKey_ABC123DEFG.p8 --delete-file
//   npm run connect -- app-store-connect --watch-downloads   # waits for AuthKey_*.p8 in ~/Downloads
//   npm run connect -- generate revenuecat --site SITE_ID # makes the value, saves it, shows it once on the page
//   npm run connect -- list                               # every provider and what it stores where
//
// Worker secrets go in with `wrangler secret put NAME`, the value piped on stdin. Site settings (payment webhook
// secrets) go in with PATCH /api/sites/:id, logged in with the saved admin password. Then it checks the value arrived:
// `wrangler secret list` names the secret, or the site answers the setting as set. stdout gets one line:
// {"ok":true,"provider":"stripe","set":["stripe_webhook_secret"],"verified":true} with --json, a sentence without.
// Exit codes: 0 saved, 2 an input is missing or does not fit, 3 waiting for the person timed out or Wrangler needs a
// login, 4 an error. Each action goes to ~/.config/founderdata/agent-log.jsonl by name. No value is ever printed,
// logged or put in an error message.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendAgentLog,
  configDir,
  dashboardSession,
  Exit,
  EXIT,
  makeWrangler,
  openBrowser,
  parseFlags,
  parseSecretList,
  readPassword,
  resolveUrl,
  shortDir,
  wranglerLogin,
} from './lib/cli.mjs';
import { servePastePage } from './lib/paste-page.mjs';
import { checkValue, describeProviders, findProvider, normalizeValue, PROVIDERS } from './lib/providers.mjs';

export const HELP = `Stores a key or secret in FounderData without showing it to anyone but you.

Usage: npm run connect -- <provider> [flags]
       npm run connect -- generate revenuecat --site <id>
       npm run connect -- list

  --site <id>          The site a payment webhook secret belongs to. Needed when there is more than one site.
  --stdin              Type the value in this terminal (hidden), or pipe it in, instead of the paste page.
  --file <path>        Read the key file (.p8 or .pem) from this path.
  --delete-file        With --file or --watch-downloads: delete the file once the key is stored.
  --watch-downloads    Wait for Apple's AuthKey_*.p8 in ~/Downloads (Apple lets you download it once).
  --secret <NAME>      Store only these of the provider's values (repeat it, or separate names with commas).
  --url <address>      The dashboard address. Default: the one npm run setup saved.
  --no-open            Print the paste page's address instead of opening the browser.
  --json               One JSON object on stdout.

Providers: ${PROVIDERS.map((p) => p.id).join(', ')}, and openai, anthropic, gemini, perplexity for one AI engine key.
Exit codes: 0 saved, 2 an input is missing or wrong, 3 waiting for you timed out or Wrangler needs a login, 4 an error.`;

/** `text` with every value replaced, for Wrangler output shown after a failure. */
const scrub = (text, values) => values.filter((v) => v && v.length >= 4).reduce((t, v) => t.split(v).join('[hidden]'), String(text ?? ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a new file whose name matches `re` in `dir`, with a size that stopped changing. Null after `timeoutMs`. */
export async function waitForDownload(dir, re, { timeoutMs = 600_000, pollMs = 500 } = {}) {
  const list = () => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const before = new Set(list());
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const f of list()) {
      if (!re.test(f) || before.has(f)) continue;
      const path = join(dir, f);
      const size = statSync(path).size;
      await sleep(pollMs);
      if (size > 0 && statSync(path).size === size) return path;
    }
    await sleep(pollMs);
  }
  return null;
}

/** Reads all of a piped stdin. */
async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

/** Asks for a value on the terminal without echoing it. */
async function readHidden(prompt, input, output) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output, terminal: true });
  const write = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (s) => {
    if (s.includes(prompt) && write) write(prompt);
  };
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
    output.write('\n');
  }
}

/** What runConnect uses from the machine. The tests pass fakes. */
export function realDeps(cwd = process.cwd()) {
  return {
    cwd,
    env: process.env,
    configDir: configDir(),
    downloadsDir: join(homedir(), 'Downloads'),
    wrangler: makeWrangler(cwd),
    fetch,
    stdin: process.stdin,
    stdinIsTTY: !!process.stdin.isTTY,
    readHidden: (prompt) => readHidden(prompt, process.stdin, process.stderr),
    openBrowser,
    stdout: (t) => process.stdout.write(`${t}\n`),
    stderr: (t) => process.stderr.write(`${t}\n`),
    timeoutMs: 600_000,
    pollMs: 500,
  };
}

/** Runs the command and returns its exit code. */
export async function runConnect(argv, d) {
  const json = argv.includes('--json');
  const answer = { ok: false, provider: null };
  const done = (code, extra = {}) => {
    Object.assign(answer, extra, { ok: code === EXIT.DONE });
    if (json) d.stdout(JSON.stringify({ ...answer, ...(code ? { code } : {}) }));
    return code;
  };
  try {
    return await connect(argv, d, answer, done, json);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    d.stderr(`✗ ${e.message}`);
    return done(e.code, { error: e.message, ...e.extra });
  }
}

async function connect(argv, d, answer, done, json) {
  const { flags, positionals } = parseFlags(argv, { values: ['--site', '--file', '--url'], multi: ['--secret'] });
  if (flags['--help'] || flags['-h'] || !positionals.length) {
    if (!positionals.length && !flags['--help']) throw new Exit(EXIT.DECIDE, `Name a provider.\n\n${HELP}`, { need: 'provider' });
    d.stdout(HELP);
    return EXIT.DONE;
  }
  if (positionals[0] === 'list') {
    const list = describeProviders();
    if (json) d.stdout(JSON.stringify({ ok: true, providers: list }));
    else for (const p of list) d.stdout(`${p.id.padEnd(22)} ${p.label}${p.pro ? ' (Pro)' : ''}: ${p.secrets.map((s) => `${s.name}${s.optional ? '?' : ''}`).join(', ')}`);
    return EXIT.DONE;
  }
  const generate = positionals[0] === 'generate';
  const id = generate ? positionals[1] : positionals[0];
  const found = findProvider(id);
  if (!found) throw new Exit(EXIT.DECIDE, `No provider called "${id ?? ''}". Run npm run connect -- list to see them.`, { need: 'provider' });
  const { provider } = found;
  answer.provider = provider.id;
  if (generate && !provider.generate) throw new Exit(EXIT.DECIDE, `${provider.label} has nothing FounderData makes. Run npm run connect -- ${provider.id}.`, { need: 'provider' });

  // Which of the provider's values this run stores.
  const picked = generate ? [provider.generate] : [...(found.only ?? []), ...(flags['--secret'] ?? [])];
  for (const n of picked) {
    if (!provider.fields.some((f) => f.name === n)) throw new Exit(EXIT.DECIDE, `${provider.label} has no value called ${n}. It has ${provider.fields.map((f) => f.name).join(', ')}.`, { need: 'secret' });
  }
  let fields = provider.fields.filter((f) => !picked.length || picked.includes(f.name)).map((f) => (picked.includes(f.name) ? { ...f, optional: false } : f));

  const fileFlag = typeof flags['--file'] === 'string' ? flags['--file'] : null;
  const watch = !!flags['--watch-downloads'];
  if (flags['--delete-file'] && !fileFlag && !watch) throw new Exit(EXIT.DECIDE, '--delete-file goes with --file or --watch-downloads.', { need: 'flags' });
  if (fileFlag && watch) throw new Exit(EXIT.DECIDE, 'Use --file or --watch-downloads, not both.', { need: 'flags' });
  const fileField = fields.find((f) => f.kind === 'file') ?? (fields.length === 1 ? fields[0] : null);
  if ((fileFlag || watch) && !fileField) throw new Exit(EXIT.DECIDE, `${provider.label} has no key file. Pick the value with --secret NAME.`, { need: 'secret' });
  if (watch && !fileField.download) throw new Exit(EXIT.DECIDE, `--watch-downloads waits for Apple's AuthKey_*.p8 files. Use --file for ${fileField.label}.`, { need: 'flags' });

  // Where the values go, checked before the person is asked for anything.
  let site = null;
  let call = null;
  let origin = null;
  if (fields.some((f) => f.dest === 'worker')) {
    if (!wranglerLogin(d.wrangler).loggedIn) {
      throw new Exit(EXIT.HUMAN, 'Not logged in to Cloudflare. Run `npx wrangler login` in a terminal, then run this again.', { need: 'login', command: 'npx wrangler login' });
    }
  }
  if (fields.some((f) => f.dest === 'site')) {
    ({ origin, call, site } = await pickSite(d, flags));
    answer.site = site.id;
  }
  if (provider.siteScopedName && typeof flags['--site'] === 'string') {
    const name = provider.siteScopedName(flags['--site']);
    fields = fields.map((f) => (f.dest === 'worker' && f.name === 'STRIPE_RESTRICTED_KEY' ? { ...f, name } : f));
    answer.site = flags['--site'];
  }

  /** Stores the values (raw, by field name) and checks they arrived. Never throws with a value in the message. */
  const store = async (raw) => {
    const values = {};
    const errors = {};
    for (const f of fields) {
      const v = raw[f.name] ?? '';
      const problem = checkValue(f, v);
      if (problem) errors[f.name] = problem;
      else if (normalizeValue(f, v)) values[f.name] = normalizeValue(f, v);
    }
    if (Object.keys(errors).length) return { ok: false, errors, message: Object.values(errors).join(' ') };
    if (!Object.keys(values).length && (provider.atLeastOne || !fields.every((f) => f.optional))) {
      return { ok: false, message: provider.atLeastOne ? 'Fill in at least one key.' : 'Nothing to save.' };
    }
    if (!Object.keys(values).length && !provider.siteExtra) return { ok: false, message: 'Nothing to save.' };
    const secrets = Object.values(values);
    const set = [];
    for (const f of fields.filter((x) => x.dest === 'worker' && values[x.name])) {
      const res = d.wrangler(['secret', 'put', f.name], { input: values[f.name], capture: true });
      appendAgentLog(d.configDir, { cmd: 'connect', action: `${provider.id}: wrangler secret put ${f.name}`, ok: res.ok });
      if (!res.ok) {
        d.stderr(scrub(res.out, secrets).trim().split('\n').slice(-6).join('\n'));
        return { ok: false, final: true, message: `Wrangler could not store ${f.name}${set.length ? ` (${set.join(', ')} went in)` : ''}. Check the terminal, then run the connect command again.` };
      }
      set.push(f.name);
    }
    const siteFields = fields.filter((x) => x.dest === 'site' && values[x.name]);
    const extra = site && provider.siteExtra ? provider.siteExtra(site) : {};
    if (siteFields.length || Object.keys(extra).length) {
      const body = { ...Object.fromEntries(siteFields.map((f) => [f.name, values[f.name]])), ...extra };
      const res = await call(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      appendAgentLog(d.configDir, { cmd: 'connect', action: `${provider.id}: PATCH /api/sites/${site.id} ${Object.keys(body).join(', ')}`, ok: res.ok });
      if (!res.ok) {
        const msg = scrub((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`, secrets);
        const one = siteFields.length === 1 ? { [siteFields[0].name]: msg } : null;
        return { ok: false, final: res.status !== 400, errors: one, message: `FounderData refused it: ${msg}` };
      }
      set.push(...siteFields.map((f) => f.name), ...Object.keys(extra).map((k) => (k === 'gumroad_new_token' ? 'gumroad_token' : k)));
    }
    // Did it arrive? The Worker lists its secrets by name; the site answers a setting that is set with dots.
    let verified = true;
    if (fields.some((f) => f.dest === 'worker' && values[f.name])) {
      const listed = d.wrangler(['secret', 'list'], { capture: true, stdin: 'ignore' });
      const names = listed.ok ? parseSecretList(listed.out) : [];
      verified = fields.filter((f) => f.dest === 'worker' && values[f.name]).every((f) => names.includes(f.name));
    }
    let reveal = null;
    if (site && (siteFields.length || Object.keys(extra).length)) {
      const res = await call(`/api/sites/${site.id}`);
      const now = res.ok ? await res.json().catch(() => ({})) : {};
      verified = verified && res.ok && siteFields.every((f) => !!now[f.name]);
      if (provider.reveal === 'gumroad-ping' && now.gumroad_token) {
        reveal = {
          label: 'Gumroad ping URL',
          value: `${origin}/api/webhooks/gumroad/${site.id}/${now.gumroad_token}`,
          hint: 'Paste it in Gumroad, Settings, Advanced, Ping. Keep it private: anyone with it can post sales.',
        };
      }
    }
    appendAgentLog(d.configDir, { cmd: 'connect', action: `${provider.id}: verify ${set.join(', ')}`, ok: verified });
    return { ok: true, set, verified, reveal, note: verified ? 'FounderData confirmed it is set.' : 'Saved. FounderData could not confirm it yet.' };
  };

  // generate: FounderData makes the value, stores it, and shows it once on the page.
  if (generate) {
    const value = randomBytes(32).toString('base64url');
    const stored = await store({ [provider.generate]: value });
    if (!stored.ok) throw new Exit(EXIT.ERROR, stored.message, { need: 'retry' });
    const page = await openPage(d, flags, { provider, fields, mode: 'show', shown: value, site, submit: null });
    const extra = { set: stored.set, verified: stored.verified, ...(site ? { site: site.id } : {}) };
    if (page.status !== 'done') {
      throw new Exit(EXIT.HUMAN, `The value is saved, but the page closed before you pressed Done. If it is not in ${provider.label} yet, run npm run connect -- generate ${provider.id} again.`, { need: 'copy', ...extra });
    }
    if (!json) d.stdout(`Saved ${stored.set.join(', ')}${site ? ` for ${site.name || site.id}` : ''} and showed it once on the page.`);
    return done(EXIT.DONE, extra);
  }

  // Values that need no typing: a key file, and the key id in its name.
  const prefilled = {};
  let filePath = null;
  if (fileFlag || watch) {
    if (watch) {
      d.stderr(`Waiting for ${fileField.label} (AuthKey_*.p8) in ${shortDir(d.downloadsDir)}. Download it from ${fileField.url} now. Already downloaded? Use --file with its path.`);
      filePath = await waitForDownload(d.downloadsDir, fileField.download, { timeoutMs: d.timeoutMs, pollMs: d.pollMs });
      if (!filePath) throw new Exit(EXIT.HUMAN, `No AuthKey_*.p8 arrived in ${shortDir(d.downloadsDir)} within ${Math.round(d.timeoutMs / 60000)} minutes.`, { need: 'download' });
    } else filePath = resolve(d.cwd, fileFlag.replace(/^~(?=\/)/, homedir()));
    let text;
    try {
      if (statSync(filePath).size > 64 * 1024) throw new Error('too big');
      text = readFileSync(filePath, 'utf8');
    } catch (e) {
      throw new Exit(EXIT.DECIDE, `Could not read ${basename(filePath)}${e.message === 'too big' ? ': it is too big for a key' : ''}.`, { need: 'file' });
    }
    prefilled[fileField.name] = { value: text, from: `Read from ${basename(filePath)}` };
    for (const f of fields) {
      const m = f.fromFile?.exec(basename(filePath));
      if (m && !prefilled[f.name]) prefilled[f.name] = { value: m[1], from: `${m[1]}, from the file name` };
    }
  }
  const remaining = fields.filter((f) => !prefilled[f.name]);
  const given = Object.fromEntries(Object.entries(prefilled).map(([k, v]) => [k, v.value]));

  let result;
  if (!remaining.length || flags['--stdin']) {
    if (remaining.length) Object.assign(given, await readStdin(d, remaining, provider));
    result = await store(given);
    if (!result.ok) {
      if (result.errors && !result.final) throw new Exit(EXIT.DECIDE, result.message, { need: 'value', fields: Object.keys(result.errors) });
      throw new Exit(EXIT.ERROR, result.message, { need: 'retry' });
    }
  } else {
    const page = await openPage(d, flags, { provider, fields, prefilled, mode: 'paste', site, submit: (values) => store({ ...values, ...given }) });
    if (page.status === 'timeout') throw new Exit(EXIT.HUMAN, 'Nobody saved on the paste page within 10 minutes. Run the command again when the person is ready.', { need: 'paste' });
    if (page.status !== 'saved') throw new Exit(EXIT.ERROR, page.result?.message ?? 'Saving failed.', { need: 'retry' });
    result = page.result;
  }
  if (flags['--delete-file'] && filePath) {
    let deleted = false;
    try {
      unlinkSync(filePath);
      deleted = true;
    } catch {}
    appendAgentLog(d.configDir, { cmd: 'connect', action: `${provider.id}: delete ${basename(filePath)}`, ok: deleted });
    answer.deleted_file = deleted;
  }
  if (!json) {
    d.stdout(`Saved ${result.set.join(', ')}${site ? ` for ${site.name || site.id}` : ''}. ${result.verified ? 'FounderData confirmed it is set.' : 'FounderData could not confirm it yet; npm run doctor shows it later.'}`);
    if (result.reveal && flags['--stdin'] && d.stdinIsTTY) d.stderr(`${result.reveal.label} (keep it private): ${result.reveal.value}`);
  }
  return done(EXIT.DONE, { set: result.set, verified: result.verified });
}

/** Logs in and picks the site: --site, or the only one. Exit 2 with the list when it has to ask. */
async function pickSite(d, flags) {
  const { url } = resolveUrl(flags['--url'], d.configDir, d.env);
  if (!url) throw new Exit(EXIT.DECIDE, 'No dashboard address. Pass --url https://your-founderdata.example.com, or run npm run setup, which saves it.', { need: 'url' });
  const password = readPassword(d.configDir, d.env);
  if (!password) throw new Exit(EXIT.DECIDE, `No saved admin password in ${shortDir(d.configDir)}. Run npm run setup, or set ADMIN_PASSWORD.`, { need: 'password' });
  const call = await dashboardSession(url, password, d.fetch);
  const res = await call('/api/sites');
  if (!res.ok) throw new Exit(EXIT.ERROR, `Could not read the sites (HTTP ${res.status}).`, { need: 'retry' });
  const body = await res.json();
  const sites = (Array.isArray(body) ? body : (body.sites ?? [])).map((s) => ({ ...s }));
  const list = sites.map((s) => ({ id: s.id, name: s.name, domain: s.domain?.endsWith('.invalid') ? null : s.domain }));
  const want = flags['--site'];
  let site = typeof want === 'string' ? sites.find((s) => s.id === want) : sites.length === 1 ? sites[0] : null;
  if (!site && !sites.length) throw new Exit(EXIT.TODO, 'There is no site yet. Add one in the dashboard first.', { need: 'site', sites: [] });
  if (!site) {
    throw new Exit(EXIT.DECIDE, `${typeof want === 'string' ? `No site with the id ${want}.` : 'Which site?'} Pass --site with one of: ${list.map((s) => `${s.id} (${s.name})`).join(', ')}`, { need: 'site', sites: list });
  }
  return { origin: url, call, site };
}

/** Reads the remaining values from stdin: hidden prompts at a terminal, or the piped text (one value per line). */
async function readStdin(d, remaining, provider) {
  const out = {};
  if (d.stdinIsTTY) {
    for (const f of remaining) {
      if (f.kind === 'file') throw new Exit(EXIT.DECIDE, `${f.label} is a file. Use --file <path>.`, { need: 'file' });
      d.stderr(`${provider.label}, ${f.label} (${f.name})${f.optional ? ', optional: press Enter to skip' : ''}. Find it at ${f.url}`);
      out[f.name] = await d.readHidden(`  Paste it here (hidden), then press Enter: `);
    }
    return out;
  }
  const text = await readAll(d.stdin);
  if (remaining.length === 1) return { [remaining[0].name]: text };
  if (remaining.some((f) => f.kind === 'file')) throw new Exit(EXIT.DECIDE, 'A key file goes in with --file <path>. Pipe one value at a time, picked with --secret NAME.', { need: 'file' });
  const lines = text.split(/\r?\n/);
  remaining.forEach((f, i) => (out[f.name] = lines[i] ?? ''));
  return out;
}

/** Starts the paste page, opens it, and waits. */
async function openPage(d, flags, opts) {
  return servePastePage({
    ...opts,
    cwd: d.cwd,
    timeoutMs: d.timeoutMs,
    onUrl: (url) => {
      d.onPageUrl?.(url);
      const opened = !flags['--no-open'] && d.openBrowser(url);
      const what = opts.mode === 'show' ? `the ${opts.provider.label} value` : `the ${opts.provider.label} page`;
      d.stderr(opened ? `Opened ${what} in the browser. If it did not open, go to ${url}` : `Open this address in the browser on this computer: ${url}`);
      d.stderr('It works once and closes after 10 minutes. Waiting...');
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runConnect(process.argv.slice(2), realDeps()).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`✗ ${e.message}`);
      process.exit(EXIT.ERROR);
    },
  );
}
