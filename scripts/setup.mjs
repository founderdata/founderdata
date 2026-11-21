#!/usr/bin/env node
// One-command install on your Cloudflare account:
//
//   npm install
//   npm run setup                 # or: node scripts/setup.mjs --name my-analytics
//   npm run setup -- --jurisdiction eu    # a new database that stays in the EU (docs/PRIVACY.md)
//   npm run setup -- --mail       # FounderData Pro mail: also the R2 bucket, the queue and their bindings
//   npm run setup -- --replay     # FounderData Pro recordings: also the R2 bucket for recorded visits and its binding
//   npm run setup -- --replay --record all    # ...and turn on Record visits for every site (or --record <site id>)
//   npm run setup -- --replay --record all --consent    # ...recording only visitors who accept the cookie banner
//   npm run setup -- --help       # every flag
//
// 1. Signs in to Cloudflare with Wrangler if needed.
// 2. Creates the D1 database, or finds it when it already exists. wrangler.jsonc names it and holds no id: Wrangler
//    finds the database by name. With --name, the name goes into wrangler.local.jsonc (gitignored). With
//    --jurisdiction eu (or fedramp) a new database is created in that jurisdiction. Cloudflare can't move an existing
//    database, so for one that exists the flag only prints a warning. The jurisdiction of a new database (or of an
//    existing one, when `wrangler d1 list` names it) goes into wrangler.local.jsonc as the DATA_JURISDICTION var, so
//    Settings and /api/v1/definitions can say where the data is stored.
// 3. Creates the admin password and session secret, saved in ~/.config/founderdata/ (mode 600). An existing file is
//    reused, and ADMIN_PASSWORD in the environment wins over both.
// 4. With --mail (FounderData Pro mail, Workers Paid): creates the R2 bucket <database name>-mail, in the EU when the
//    database is, and the queue <database name>-mail, or finds them when they exist. Then it writes the send_email
//    binding EMAIL, the R2 binding MAIL_BUCKET and the queue producer MAIL_QUEUE with its consumer into
//    wrangler.local.jsonc, next to what the file already holds. wrangler.jsonc stays without them: a deploy with an R2
//    or queue binding fails on an account that lacks the bucket or the queue. Once written, later runs keep them.
// 5. With --replay (FounderData Pro recordings): creates the R2 bucket <database name>-replay, in the EU when the
//    database is, or finds it when it exists. It adds a lifecycle rule that deletes every object 90 days after upload,
//    a backstop behind Pro's own retention job, and writes the R2 binding REPLAY_BUCKET into wrangler.local.jsonc. R2
//    works on the free plan; Cloudflare asks for a payment method once to turn it on. After the deploy it prints the
//    next step with each site's Record visits settings link. With --record <site id> or --record all it also turns
//    Record visits on for those sites, after the privacy note and the consent note; for more than one site it asks
//    first, unless --yes. With --consent it turns on Wait for consent in the same step.
// 6. Builds the dashboard, applies the database migrations and deploys the Worker with both secrets.
//
// Running it again is safe: it reuses the database, the secrets, the buckets, the rule and the queue, and deploys the
// current code.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reads `database_name` of the DB binding from wrangler config text. */
export function readDatabaseName(config) {
  return config.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

/** Wrangler config text with the database name replaced, comments and layout kept. */
export function writeDatabaseName(config, name) {
  return config.replace(/("database_name"\s*:\s*)"[^"]*"/, `$1"${name}"`);
}

/** The uuid of the database called `name` in `wrangler d1 list --json` output, or null. */
export function findDatabase(listOutput, name) {
  try {
    return JSON.parse(listOutput.slice(listOutput.indexOf('['))).find((d) => d.name === name)?.uuid ?? null;
  } catch {
    return null;
  }
}

/** The jurisdiction of the database called `name` in `wrangler d1 list --json` output, when Wrangler reports one. */
export function databaseJurisdiction(listOutput, name) {
  try {
    const j = JSON.parse(listOutput.slice(listOutput.indexOf('['))).find((d) => d.name === name)?.jurisdiction;
    return typeof j === 'string' && JURISDICTIONS.includes(j.toLowerCase()) ? j.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Wrangler config text with `"vars": { key: value }` set, comments and layout kept. Replaces the key when it is there,
 * adds it to an existing `vars` object, or adds a `vars` object at the end of the config.
 */
export function writeVar(config, key, value) {
  const quoted = JSON.stringify(value);
  const existing = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  if (existing.test(config)) return config.replace(existing, `$1${quoted}`);
  const vars = /"vars"\s*:\s*\{(\s*\})?/;
  const found = config.match(vars);
  if (found) return config.replace(vars, found[1] ? `"vars": { "${key}": ${quoted} }` : `${found[0]} "${key}": ${quoted},`);
  const end = config.lastIndexOf('}');
  const before = config.slice(0, end).replace(/\s*$/, '');
  const comma = before.endsWith(',') || before.endsWith('{') ? '' : ',';
  return `${before}${comma}\n  // Where the D1 database stores its data (src/worker/location.ts). Written by npm run setup.\n  "vars": { "${key}": ${quoted} }\n${config.slice(end)}`;
}

/**
 * A note for a config whose crons would misbehave. Two cases, both read-only (the file is never rewritten: a deployment's
 * own config is its owner's), null when there is nothing to say:
 * - the hourly cron "0 * * * *" without "*" every 5 minutes: it keeps working and runs the rank and AI checks once an hour
 *   (144 results and 144 AI checks a day on Free, not 1,728 each);
 * - both of them: at minute 0 the hourly jobs (phone pushes, alert rules, the X poll, the Search Console sync and the 07:00
 *   alerts) run in two invocations at once, and the rank and AI work runs twice. Keep only the five-minute cron.
 */
export function staleCronNotice(config) {
  const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
  const hourly = crons.includes('"0 * * * *"');
  const tick = crons.includes('"*/5 * * * *"');
  if (hourly && tick) {
    return 'your config lists both the hourly cron "0 * * * *" and "*/5 * * * *". At minute 0 the hourly jobs (pushes, alert rules, X poll, Search Console sync, 07:00 alerts) would run twice. Remove "0 * * * *" from wrangler.local.jsonc and keep "*/5 * * * *".';
  }
  if (!hourly || tick) return null;
  return 'your config runs the hourly cron "0 * * * *", so DataForSEO and AI checks run 24 times a day. Replace it with "*/5 * * * *" in wrangler.local.jsonc to get 288 runs a day (README, "Rank checks and AI checks, by plan").';
}

/** D1 jurisdictions `wrangler d1 create --jurisdiction` accepts. */
export const JURISDICTIONS = ['eu', 'fedramp'];

/** The value of --jurisdiction in `args` (also --jurisdiction=eu), lowercased; null when absent. Throws on an unknown one. */
export function readJurisdiction(args) {
  const at = args.findIndex((a) => a === '--jurisdiction' || a.startsWith('--jurisdiction='));
  if (at < 0) return null;
  const value = (args[at].includes('=') ? args[at].split('=')[1] : args[at + 1] ?? '').toLowerCase();
  if (!JURISDICTIONS.includes(value)) throw new Error(`--jurisdiction must be one of: ${JURISDICTIONS.join(', ')}`);
  return value;
}

// ---------- mail bindings (--mail), written into JSONC text with comments and layout kept

/**
 * The top-level keys of a JSONC object and where each value sits: { key: { start, end } }, `end` exclusive. Strings,
 * `//` and `/* *\/` comments are skipped, so a bracket inside them does not count.
 */
export function topLevelKeys(text) {
  const keys = {};
  let depth = 0;
  let key = null;
  let pendingKey = null;
  let valueStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i <= 0) break;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && key === null) pendingKey = text.slice(i + 1, j);
      else if (depth === 1 && key !== null && valueStart < 0) valueStart = i;
      if (depth === 1 && key !== null && valueStart === i) {
        keys[key] = { start: i, end: j + 1 };
        key = null;
      }
      i = j;
      continue;
    }
    if (depth === 1 && ch === ':' && pendingKey !== null) {
      key = pendingKey;
      pendingKey = null;
      valueStart = -1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 1 && key !== null && valueStart < 0) valueStart = i;
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 1 && key !== null && valueStart >= 0) {
        keys[key] = { start: valueStart, end: i + 1 };
        key = null;
        valueStart = -1;
      }
      continue;
    }
    if (depth === 1 && key !== null && valueStart < 0 && /[^\s,]/.test(ch)) {
      // A number, true, false or null.
      const m = /^[^\s,}\]]+/.exec(text.slice(i));
      keys[key] = { start: i, end: i + m[0].length };
      key = null;
      i += m[0].length - 1;
    }
  }
  return keys;
}

/** `text` with `entry` (JSON text) added as the first item of the array that starts at `open` (its `[`). */
function prependToArray(text, open, entry) {
  const close = matchingClose(text, open);
  const empty = !/\S/.test(stripComments(text.slice(open + 1, close)));
  return `${text.slice(0, open + 1)} ${entry}${empty ? ' ' : ','}${text.slice(open + 1)}`;
}

/** The index of the bracket that closes the one at `open`, skipping strings and comments. */
function matchingClose(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') i = text.indexOf('\n', i);
    else if (ch === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) + 1;
    else if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
    if (i < 0) break;
  }
  throw new Error('The wrangler config has an unclosed bracket.');
}

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** `text` with `"key": value` added as the last member of the top-level object. */
function addTopLevel(text, comment, key, value) {
  const end = text.lastIndexOf('}');
  const before = text.slice(0, end).replace(/\s*$/, '');
  const comma = before.endsWith(',') || before.endsWith('{') ? '' : ',';
  return `${before}${comma}\n  // ${comment}\n  "${key}": ${value}\n${text.slice(end)}`;
}

/** The R2 bucket and queue name for a database: `<name>-mail`, in the characters R2 and Queues accept. */
export function mailResourceName(dbName) {
  return `${String(dbName).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58) || 'founderdata'}-mail`;
}

/**
 * Settings of the mail queue's consumer. Batches come soon, so a delivery event moves a status within seconds, and
 * hold 3 messages at most: one received message can be 25 MB, and a batch is parsed in one isolate. The consumer
 * retries a failed message with a growing wait, up to 8 times over about 16 hours (pro/worker/mail/index.ts).
 */
export const MAIL_CONSUMER = { max_batch_size: 3, max_batch_timeout: 2, max_retries: 8 };

/**
 * Wrangler config text with the mail bindings added, comments and layout kept: `send_email` EMAIL, `r2_buckets`
 * MAIL_BUCKET (with its jurisdiction) and `queues` with the MAIL_QUEUE producer and a consumer. A binding that is
 * there already stays as it is, so running it again changes nothing. Returns the text and notes for the person.
 */
export function writeMailBindings(config, { bucket, queue, jurisdiction = null }) {
  let text = config;
  const notes = [];
  const keys = () => topLevelKeys(text);
  const section = (k) => {
    const r = keys()[k];
    return r ? text.slice(r.start, r.end) : null;
  };

  const email = section('send_email');
  if (email === null) {
    text = addTopLevel(text, 'Sending mail (FounderData Pro mail). Written by npm run setup -- --mail.', 'send_email', '[{ "name": "EMAIL" }]');
  } else if (!/"name"\s*:\s*"EMAIL"/.test(email)) {
    text = prependToArray(text, keys().send_email.start, '{ "name": "EMAIL" }');
  } else if (/"(destination_address|allowed_destination_addresses)"/.test(email)) {
    notes.push('the EMAIL binding in wrangler.local.jsonc only sends to fixed addresses. Remove destination_address and allowed_destination_addresses from it, or mail to other people fails.');
  }

  const r2 = `{ "binding": "MAIL_BUCKET", "bucket_name": "${bucket}"${jurisdiction ? `, "jurisdiction": "${jurisdiction}"` : ''} }`;
  const buckets = section('r2_buckets');
  if (buckets === null) {
    text = addTopLevel(text, 'Mail bodies, raw inbound messages and attachments (FounderData Pro mail).', 'r2_buckets', `[${r2}]`);
  } else if (!/"binding"\s*:\s*"MAIL_BUCKET"/.test(buckets)) {
    text = prependToArray(text, keys().r2_buckets.start, r2);
  }

  const producer = `{ "binding": "MAIL_QUEUE", "queue": "${queue}" }`;
  const consumer = `{ "queue": "${queue}", "max_batch_size": ${MAIL_CONSUMER.max_batch_size}, "max_batch_timeout": ${MAIL_CONSUMER.max_batch_timeout}, "max_retries": ${MAIL_CONSUMER.max_retries} }`;
  const queues = section('queues');
  if (queues === null) {
    text = addTopLevel(
      text,
      "Cloudflare's sending events, inbound parse jobs and webhook deliveries (FounderData Pro mail).",
      'queues',
      `{\n    "producers": [${producer}],\n    "consumers": [${consumer}]\n  }`,
    );
  } else {
    // Inside the queues object: add each array, or the entry to an array that lacks it.
    for (const [name, entry, has] of [
      ['producers', producer, /"binding"\s*:\s*"MAIL_QUEUE"/],
      ['consumers', consumer, new RegExp(`"queue"\\s*:\\s*"${queue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)],
    ]) {
      const q = keys().queues;
      const inner = topLevelKeys(text.slice(q.start, q.end));
      const arr = inner[name];
      if (!arr) {
        const close = q.end - 1;
        const before = text.slice(0, close).replace(/\s*$/, '');
        const comma = before.endsWith(',') || before.endsWith('{') ? '' : ',';
        text = `${before}${comma}\n    "${name}": [${entry}]\n  ${text.slice(close)}`;
      } else if (!has.test(text.slice(q.start + arr.start, q.start + arr.end))) {
        text = prependToArray(text, q.start + arr.start, entry);
      }
    }
  }
  return { text, notes };
}

// ---------- recordings bucket (--replay)

/** The value of --record: a site id, "all", or null without the flag. Throws when it has no value. */
export function readRecord(args) {
  const at = args.findIndex((a) => a === '--record' || a.startsWith('--record='));
  if (at < 0) return null;
  const value = args[at].includes('=') ? args[at].split('=')[1] : args[at + 1];
  if (!value || value.startsWith('--')) throw new Error('--record needs a site id or all, such as --record all');
  return value;
}

/** Every flag, for --help. */
export const HELP = `Deploys FounderData to your Cloudflare account, or updates a deployment. Run it again to deploy new code.

Usage: npm run setup -- [flags]

  --name <name>            The D1 database name. Default: founderdata, or the one wrangler.local.jsonc names.
  --jurisdiction <eu|fedramp>
                           Create a new database (and its buckets) in that jurisdiction. Cloudflare can't move one
                           that exists.
  --mail                   FounderData Pro mail: also the R2 bucket, the queue and their bindings. Needs Workers Paid.
  --replay                 FounderData Pro recordings: also the R2 bucket for recorded visits and its binding.
  --record <site id|all>   With --replay: turn on Record visits for one site or for every site.
  --consent                With --record: record only visitors who accept your cookie banner (Wait for consent).
  --yes                    With --record all: turn it on for more than one site without asking.
  --help, -h               This list.

Every run deploys the Worker. docs/GUIDE.md has the details.`;

/** The privacy note printed before Record visits goes on. */
export const RECORD_NOTE =
  'Recordings replay what visitors saw. Typing is always hidden; mark other private parts of your pages with data-fd-mask (text hidden) or data-fd-block (left out).';

/** What recording means for visitors in the EU and the UK, with and without --consent. */
export const consentNote = (consent) =>
  consent
    ? 'Wait for consent goes on too: a visit records only after your cookie banner calls founderdata(\'consent\', true).'
    : 'In the EU and the UK, recording usually needs each visitor\'s consent. Without --consent, every visitor is recorded, whether or not they accepted your cookie banner. Add --consent to record only those who did.';

/** Whether turning recording on for these sites asks first: more than one site, without --yes. */
export const asksFirst = (ids, yes) => ids.length > 1 && !yes;

/** Asks a yes or no question on the terminal. No terminal: no. */
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** The lines that end `setup --replay`: what to do next, with each site's Record visits link. */
export function replayNextStep(url, sites, turnedOn = []) {
  const lines = [];
  if (!url) return ['  Next: open Settings, Record visits, in the dashboard of each site you want to record.'];
  if (!sites.length) return [`  Next: add a site in ${url}, then turn on Record visits in its settings.`];
  lines.push(turnedOn.length ? '  Record visits is on for the sites marked "on". Open a page of the site, then check the card:' : '  Next: turn on Record visits for each site you want to record:');
  for (const s of sites) lines.push(`    ${s.name || s.domain || s.id}${turnedOn.includes(s.id) ? ' (on)' : ''}: ${url}/site/${s.id}/settings#record-visits`);
  return lines;
}

/** Logs in to the deployed dashboard and answers its sites, and a fetch that sends the login cookie. */
async function dashboardLogin(url, password) {
  const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!res.ok) throw new Error(`login answered ${res.status}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const call = (path, init = {}) => fetch(`${url}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const list = await call('/api/sites');
  const sites = list.ok ? await list.json() : [];
  return { call, sites: Array.isArray(sites) ? sites : (sites.sites ?? []) };
}

/** The R2 bucket for recorded visits: `<name>-replay`, in the characters R2 accepts. */
export function replayBucketName(dbName) {
  return `${String(dbName).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'founderdata'}-replay`;
}

/** Days after upload the bucket's lifecycle rule deletes a recording chunk. Pro's retention job deletes sooner. */
export const REPLAY_EXPIRE_DAYS = 90;
/** The id of that lifecycle rule. */
export const REPLAY_RULE = 'founderdata-expire-90-days';

/** Wrangler arguments that add the lifecycle rule to the bucket, without a prompt. */
export function replayLifecycleArgs(bucket, jurisdiction = null) {
  return ['r2', 'bucket', 'lifecycle', 'add', bucket, REPLAY_RULE, '--expire-days', String(REPLAY_EXPIRE_DAYS), '--force', ...(jurisdiction ? ['--jurisdiction', jurisdiction] : [])];
}

/** Whether `wrangler r2 bucket lifecycle list` output names the rule already. */
export function listsLifecycleRule(out, rule = REPLAY_RULE) {
  return new RegExp(`(^|[\\s│|:])${rule}([\\s│|]|$)`, 'm').test(out);
}

/**
 * Wrangler config text with the R2 binding REPLAY_BUCKET added (with its jurisdiction), comments and layout kept. A
 * REPLAY_BUCKET binding that is there already stays as it is, so running it again changes nothing.
 */
export function writeReplayBinding(config, { bucket, jurisdiction = null }) {
  const r2 = `{ "binding": "REPLAY_BUCKET", "bucket_name": "${bucket}"${jurisdiction ? `, "jurisdiction": "${jurisdiction}"` : ''} }`;
  const at = topLevelKeys(config).r2_buckets;
  if (!at) return addTopLevel(config, 'Recorded visits (FounderData Pro recordings). Written by npm run setup -- --replay.', 'r2_buckets', `[${r2}]`);
  if (/"binding"\s*:\s*"REPLAY_BUCKET"/.test(config.slice(at.start, at.end))) return config;
  return prependToArray(config, at.start, r2);
}

/** Whether `wrangler r2 bucket list` output names the bucket. */
export function listsBucket(out, name) {
  return new RegExp(`^name:\\s+${name}\\s*$`, 'm').test(out);
}

/** Whether `wrangler queues list` output names the queue (a table row or plain text). */
export function listsQueue(out, name) {
  return new RegExp(`(^|[\\s│|])${name}([\\s│|]|$)`, 'm').test(out);
}

const CONFIG = 'wrangler.jsonc';
const LOCAL_CONFIG = 'wrangler.local.jsonc';
const SECRETS_DIR = join(homedir(), '.config', 'founderdata');

/** Runs Wrangler through scripts/wrangler.mjs, so wrangler.local.jsonc wins when it exists. */
function wrangler(args, { capture = false, stdin = 'inherit' } = {}) {
  const res = spawnSync(process.execPath, ['scripts/wrangler.mjs', ...args], {
    encoding: 'utf8',
    stdio: capture ? [stdin, 'pipe', 'pipe'] : 'inherit',
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function step(text) {
  console.log(`\n▸ ${text}`);
}

function fail(text) {
  console.error(`\n✗ ${text}`);
  process.exit(1);
}

/** Reads a secret from ~/.config/founderdata/<file>, or creates and saves it. */
function secret(file, make) {
  const path = join(SECRETS_DIR, file);
  if (existsSync(path)) return { value: readFileSync(path, 'utf8').trim(), path, created: false };
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const value = make();
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { value, path, created: true };
}

/** Runs `wrangler deploy`, showing its output and returning it. stdin stays attached so its prompts still work. */
function deploy(secretsFile) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, ['scripts/wrangler.mjs', 'deploy', '--secrets-file', secretsFile], { stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const nameAt = args.indexOf('--name');
  let jurisdiction;
  try {
    jurisdiction = readJurisdiction(args);
  } catch (e) {
    fail(e.message);
  }
  const mail = args.includes('--mail');
  const replay = args.includes('--replay');
  let record = null;
  try {
    record = readRecord(args);
  } catch (e) {
    fail(e.message);
  }
  if (record && !replay) fail('--record goes with --replay: npm run setup -- --replay --record all');
  const consent = args.includes('--consent');
  const yes = args.includes('--yes');
  if (consent && !record) fail('--consent goes with --record: npm run setup -- --replay --record all --consent');
  if (!existsSync(CONFIG)) fail(`Run this from the repository root (no ${CONFIG} here).`);
  if (!existsSync('node_modules')) fail('Run `npm install` first.');

  step('Checking the Cloudflare login');
  const who = wrangler(['whoami'], { capture: true });
  if (!who.ok || /not authenticated/i.test(who.out)) {
    if (!wrangler(['login']).ok) fail('Wrangler login failed. Run `npx wrangler login` and try again.');
  }

  const configFile = existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : CONFIG;
  const configured = readDatabaseName(readFileSync(configFile, 'utf8'));
  const cronNote = staleCronNotice(readFileSync(configFile, 'utf8'));
  if (cronNote) console.log(`  note: ${cronNote}`);
  const name = nameAt >= 0 ? args[nameAt + 1] : configured ?? 'founderdata';
  if (!name) fail('--name needs a database name.');
  if (name !== configured) {
    writeFileSync(LOCAL_CONFIG, writeDatabaseName(readFileSync(configFile, 'utf8'), name));
    console.log(`  database name ${name} written to ${LOCAL_CONFIG} (gitignored)`);
  }

  step(`Finding or creating the D1 database "${name}"`);
  const listed = wrangler(['d1', 'list', '--json'], { capture: true }).out;
  let id = findDatabase(listed, name);
  let pinned = null;
  if (id) {
    console.log(`  using database ${name} (${id})`);
    pinned = databaseJurisdiction(listed, name);
    if (jurisdiction && pinned !== jurisdiction) console.log(`  note: --jurisdiction ${jurisdiction} applies to new databases only; Cloudflare can't move this one`);
  } else {
    // stdin closed: Wrangler then answers no to adding the database to the config, which names it already.
    const created = wrangler(['d1', 'create', name, ...(jurisdiction ? ['--jurisdiction', jurisdiction] : [])], { capture: true, stdin: 'ignore' });
    id = findDatabase(wrangler(['d1', 'list', '--json'], { capture: true }).out, name);
    if (!id) fail(`Could not create or find the D1 database "${name}":\n${created.out}`);
    console.log(`  created database ${name} (${id})${jurisdiction ? ` in jurisdiction ${jurisdiction}` : ''}`);
    pinned = jurisdiction;
  }
  if (pinned) {
    const from = existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : CONFIG;
    const text = readFileSync(from, 'utf8');
    const updated = writeVar(text, 'DATA_JURISDICTION', pinned);
    if (updated !== text || from !== LOCAL_CONFIG) {
      writeFileSync(LOCAL_CONFIG, updated);
      console.log(`  DATA_JURISDICTION=${pinned} written to ${LOCAL_CONFIG} (gitignored)`);
    }
  }

  if (mail) {
    step('Setting up mail: R2 bucket, queue and bindings');
    const resource = mailResourceName(name);
    // R2 takes the same jurisdictions as D1, so the mail stays where the database is.
    const jur = pinned ? ['--jurisdiction', pinned] : [];
    if (listsBucket(wrangler(['r2', 'bucket', 'list', ...jur], { capture: true }).out, resource)) {
      console.log(`  using R2 bucket ${resource}`);
    } else {
      const made = wrangler(['r2', 'bucket', 'create', resource, ...jur], { capture: true, stdin: 'ignore' });
      if (!made.ok && !/already exists/i.test(made.out)) fail(`Could not create the R2 bucket "${resource}". Mail needs R2 on the account:\n${made.out}`);
      console.log(`  created R2 bucket ${resource}${pinned ? ` in jurisdiction ${pinned}` : ''}`);
    }
    if (listsQueue(wrangler(['queues', 'list'], { capture: true }).out, resource)) {
      console.log(`  using queue ${resource}`);
    } else {
      const made = wrangler(['queues', 'create', resource], { capture: true, stdin: 'ignore' });
      if (!made.ok && !/already (exists|taken)/i.test(made.out)) fail(`Could not create the queue "${resource}". Queues need Workers Paid:\n${made.out}`);
      console.log(`  created queue ${resource}`);
    }
    const from = existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : CONFIG;
    const before = readFileSync(from, 'utf8');
    const { text, notes } = writeMailBindings(before, { bucket: resource, queue: resource, jurisdiction: pinned });
    if (text !== before || from !== LOCAL_CONFIG) {
      writeFileSync(LOCAL_CONFIG, text);
      console.log(`  mail bindings written to ${LOCAL_CONFIG} (gitignored)`);
    } else console.log(`  mail bindings already in ${LOCAL_CONFIG}`);
    for (const n of notes) console.log(`  note: ${n}`);
  }

  if (replay) {
    step('Setting up recordings: R2 bucket, lifecycle rule and binding');
    const bucket = replayBucketName(name);
    // R2 takes the same jurisdictions as D1, so recordings stay where the database is.
    const jur = pinned ? ['--jurisdiction', pinned] : [];
    if (listsBucket(wrangler(['r2', 'bucket', 'list', ...jur], { capture: true }).out, bucket)) {
      console.log(`  using R2 bucket ${bucket}`);
    } else {
      const made = wrangler(['r2', 'bucket', 'create', bucket, ...jur], { capture: true, stdin: 'ignore' });
      if (!made.ok && !/already exists/i.test(made.out)) fail(`Could not create the R2 bucket "${bucket}". Turn on R2 in the Cloudflare dashboard, then run this again:\n${made.out}`);
      console.log(`  created R2 bucket ${bucket}${pinned ? ` in jurisdiction ${pinned}` : ''}`);
    }
    if (listsLifecycleRule(wrangler(['r2', 'bucket', 'lifecycle', 'list', bucket, ...jur], { capture: true }).out)) {
      console.log(`  lifecycle rule ${REPLAY_RULE} already on the bucket`);
    } else {
      const rule = wrangler(replayLifecycleArgs(bucket, pinned), { capture: true, stdin: 'ignore' });
      if (!rule.ok) fail(`Could not add the ${REPLAY_EXPIRE_DAYS}-day lifecycle rule to "${bucket}":\n${rule.out}`);
      console.log(`  added lifecycle rule ${REPLAY_RULE}: objects go ${REPLAY_EXPIRE_DAYS} days after upload`);
    }
    const from = existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : CONFIG;
    const before = readFileSync(from, 'utf8');
    const text = writeReplayBinding(before, { bucket, jurisdiction: pinned });
    if (text !== before || from !== LOCAL_CONFIG) {
      writeFileSync(LOCAL_CONFIG, text);
      console.log(`  REPLAY_BUCKET binding written to ${LOCAL_CONFIG} (gitignored)`);
    } else console.log(`  REPLAY_BUCKET binding already in ${LOCAL_CONFIG}`);
  }

  step('Preparing the secrets');
  const password = process.env.ADMIN_PASSWORD
    ? { value: process.env.ADMIN_PASSWORD, path: 'ADMIN_PASSWORD', created: false }
    : secret('admin-password', () => randomBytes(18).toString('base64url'));
  const session = secret('session-secret', () => randomBytes(32).toString('base64url'));
  console.log(`  admin password: ${password.path}${password.created ? ' (new)' : ''}`);
  console.log(`  session secret: ${session.path}${session.created ? ' (new)' : ''}`);

  step('Building the dashboard');
  if (spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }).status !== 0) fail('The build failed.');

  step('Applying the database migrations');
  if (!wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']).ok) fail('The migrations failed.');

  step('Deploying the Worker');
  const dir = mkdtempSync(join(tmpdir(), 'founderdata-'));
  const secretsFile = join(dir, 'secrets.json');
  writeFileSync(secretsFile, JSON.stringify({ ADMIN_PASSWORD: password.value, SESSION_SECRET: session.value }), { mode: 0o600 });
  let result;
  try {
    result = await deploy(secretsFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!result.ok) fail('The deploy failed. If Wrangler printed `fetch failed` or a Cloudflare API error, run `npm run setup` again.');

  const url = result.out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  console.log('\n✓ FounderData is live.');
  if (url) console.log(`  Dashboard: ${url}`);
  console.log(`  Password:  ${password.path === 'ADMIN_PASSWORD' ? 'the ADMIN_PASSWORD you set' : `cat ${password.path}`}`);
  if (!replay) {
    console.log('  Next: log in, add a website and paste its script tag into your site.');
    return;
  }

  // Recordings: the next step with each site's settings link, and with --record the switch itself.
  step('Recording visits');
  let sites = [];
  const turnedOn = [];
  if (url) {
    try {
      const login = await dashboardLogin(url, password.value);
      sites = login.sites;
      if (record) {
        console.log(`  ${RECORD_NOTE}`);
        console.log(`  ${consentNote(consent)}`);
        let ids = (record === 'all' ? sites.map((s) => s.id) : [record]).filter((i) => sites.some((s) => s.id === i));
        if (record !== 'all' && !sites.some((s) => s.id === record)) console.log(`  note: no site with the id ${record}. The sites are listed below.`);
        if (asksFirst(ids, yes) && !(await confirm(`  Turn on Record visits for ${ids.length} sites?`))) {
          console.log('  Record visits stays off. Run it again with --yes, or turn it on in each site\'s settings.');
          ids = [];
        }
        for (const id of ids) {
          const r = await login.call(`/api/sites/${id}/recording`, { method: 'PATCH', body: JSON.stringify({ record_visits: 1, ...(consent ? { record_consent: 1 } : {}) }) });
          if (r.ok) turnedOn.push(id);
          else console.log(`  note: Record visits stayed off for ${id}: ${r.status === 404 ? 'it needs FounderData Pro' : ((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)}`);
        }
      }
    } catch (e) {
      console.log(`  note: could not read the sites (${e.message}). Turn on Record visits in each site's settings.`);
    }
  }
  for (const line of replayNextStep(url, sites, turnedOn)) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e.message));
}
