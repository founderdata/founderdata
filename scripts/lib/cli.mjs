// What setup, doctor and connect share: exit codes, flags, the saved files in ~/.config/founderdata/, the action log,
// the Wrangler runner and the dashboard login. Every function that touches the machine takes its inputs as arguments,
// so the tests can run the commands against a temporary folder, a fake Wrangler and a local fake server.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Exit codes of setup, doctor and connect. */
export const EXIT = Object.freeze({
  /** Done. */
  DONE: 0,
  /** Something is left to do, and the output says what. */
  TODO: 1,
  /** A decision or an input is missing (a flag, a choice, a site id). */
  DECIDE: 2,
  /** Only the person can do the next step: a browser login, a paste, a dashboard click. */
  HUMAN: 3,
  /** Something failed. */
  ERROR: 4,
});

/** Thrown to end a command with an exit code. `extra` goes into the --json answer. */
export class Exit extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/** Where setup keeps the admin password, the session secret, the dashboard address and the action log. */
export const configDir = (env = process.env) => env.FOUNDERDATA_CONFIG_DIR || join(homedir(), '.config', 'founderdata');

/** `~/.config/founderdata` written the way a person reads it, for messages. */
export const shortDir = (dir) => (dir.startsWith(homedir()) ? `~${dir.slice(homedir().length)}` : dir);

/**
 * Flags of `argv`: `values` names the flags that take a value (`--site x` or `--site=x`), `multi` the ones that may
 * repeat (their values also split on commas). Everything else that starts with `--` is a switch.
 */
export function parseFlags(argv, { values = [], multi = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') {
      if (a !== '--') positionals.push(a);
      continue;
    }
    const [name, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (values.includes(name) || multi.includes(name)) {
      const v = inline ?? argv[i + 1];
      if (inline === undefined) i++;
      if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new Exit(EXIT.DECIDE, `${name} needs a value.`, { need: name });
      if (multi.includes(name)) flags[name] = [...(flags[name] ?? []), ...v.split(',').map((s) => s.trim()).filter(Boolean)];
      else flags[name] = v;
    } else flags[name] = true;
  }
  return { flags, positionals };
}

/** Reads a saved file from the config folder, trimmed; null when it is missing. */
export function readSaved(dir, file) {
  try {
    return readFileSync(join(dir, file), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Writes a file into the config folder (folder 700, file 600). */
export function writeSaved(dir, file, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, file), `${value}\n`, { mode: 0o600 });
  chmodSync(join(dir, file), 0o600);
}

/** The names of the files in the config folder, never their contents. */
export function savedFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/** The admin password: ADMIN_PASSWORD, else the saved file. Null when neither exists. */
export function readPassword(dir, env = process.env) {
  return env.ADMIN_PASSWORD || readSaved(dir, 'admin-password');
}

/** The dashboard address: --url, FOUNDERDATA_URL, then the one setup saved. With where it came from. */
export function resolveUrl(flag, dir, env = process.env) {
  const clean = (u) => String(u).trim().replace(/\/+$/, '');
  if (typeof flag === 'string' && flag) return { url: clean(flag), source: 'flag' };
  if (env.FOUNDERDATA_URL) return { url: clean(env.FOUNDERDATA_URL), source: 'env' };
  const saved = readSaved(dir, 'url');
  return saved ? { url: clean(saved), source: 'saved' } : { url: null, source: null };
}

/**
 * Appends one action to ~/.config/founderdata/agent-log.jsonl: `{ at, cmd, action, ok }`. Callers pass names and
 * ids only, never a secret. A log that cannot be written never stops the command.
 */
export function appendAgentLog(dir, { cmd, action, ok }) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'agent-log.jsonl');
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), cmd, action, ok: !!ok })}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * Runs Wrangler through scripts/wrangler.mjs in `cwd`, so wrangler.local.jsonc wins when it exists.
 * - `capture`: return the output instead of showing it.
 * - `stdin`: 'inherit' (prompts work) or 'ignore' (Wrangler answers its own questions with no).
 * - `input`: text piped to Wrangler's stdin, for `secret put`. The output is captured, never shown.
 * - `toStderr`: show the output on stderr, so a --json answer on stdout stays one object.
 * Returns `{ ok, status, out }`.
 */
export function makeWrangler(cwd) {
  const script = join(cwd, 'scripts', 'wrangler.mjs');
  return (args, { capture = false, stdin = 'inherit', input, toStderr = false } = {}) => {
    const stdio = input !== undefined ? ['pipe', 'pipe', 'pipe'] : capture ? [stdin, 'pipe', 'pipe'] : ['inherit', toStderr ? 2 : 'inherit', 'inherit'];
    const res = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio, input });
    return { ok: res.status === 0, status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };
}

/** `wrangler whoami --json` output as `{ loggedIn, accounts: [{ id, name }] }`. */
export function parseWhoami(out) {
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')));
    const accounts = Array.isArray(j.accounts) ? j.accounts.map((a) => ({ id: String(a.id ?? ''), name: String(a.name ?? '') })) : [];
    return { loggedIn: j.loggedIn !== false && (j.loggedIn === true || accounts.length > 0), accounts };
  } catch {
    return { loggedIn: false, accounts: [] };
  }
}

/** Whether Wrangler is logged in, and to which accounts. Read-only. */
export function wranglerLogin(wrangler) {
  const res = wrangler(['whoami', '--json'], { capture: true, stdin: 'ignore' });
  const who = parseWhoami(res.out);
  return { ...who, loggedIn: res.ok && who.loggedIn };
}

/** The `name` of the secrets in `wrangler secret list` output (JSON by default). */
export function parseSecretList(out) {
  try {
    const list = JSON.parse(out.slice(out.indexOf('[')));
    return Array.isArray(list) ? list.map((s) => String(s?.name ?? '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Logs in to the deployed dashboard with the admin password and returns a `call(path, init)` that sends the cookie.
 * Throws an Exit with a plain message when the login is refused or the address does not answer.
 */
export async function dashboardSession(url, password, f = fetch) {
  let res;
  try {
    res = await f(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Exit(EXIT.ERROR, `${url} did not answer (${e.cause?.code ?? e.name}). Check the address, or run npm run setup.`, { need: 'deployment' });
  }
  if (!res.ok) throw new Exit(EXIT.ERROR, `The saved password did not log in to ${url} (HTTP ${res.status}).`, { need: 'password' });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return (path, init = {}) =>
    f(`${url}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
}

/** Opens a URL in the default browser. Returns false when nothing could open it. */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Whether the repository's dependencies are installed (Wrangler is the one every command needs). */
export function dependenciesInstalled(cwd) {
  return existsSync(join(cwd, 'node_modules', 'wrangler', 'package.json'));
}

/** The version of a package installed in node_modules, or null. */
export function installedVersion(cwd, name) {
  try {
    return JSON.parse(readFileSync(join(cwd, 'node_modules', name, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}
