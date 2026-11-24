// The setup checklist (docs/GUIDE.md, "Setup checklist"): one row per integration with its live status and the next
// step, so an owner sees what is broken without reading logs. Owner only.
//
// - GET  /api/setup                    the rows. Reads D1 and the Worker's own bindings; it calls nobody.
// - POST /api/setup/test/dataforseo    calls DataForSEO's /appendix/user_data to check the login. We have not verified that it is free.
// - POST /api/setup/test/x             calls X's GET /2/usage/tweets to check the bearer token. We have not verified that it is free.
//
// A test runs on a click only, never when the page loads. Each is rate limited by one cron_state row ('test:<name>'):
// a click claims it with one upsert that writes only when the last claim is older than TEST_GAP_MS, so a second
// click, from any isolate, gets 429 and costs no row. A test that ran writes its outcome into the same row (2 rows).
//
// The cron records a heartbeat per cron expression ('tick:five', 'tick:hourly') with recordTick, at most every 10
// minutes (4 an hour, at minutes 0, 15, 30 and 45 of the */5 cron), so the checklist can say when the cron last ran and whether the old hourly cron is still listed.
//
// Secrets are reported by name and presence only. No value, prefix or length leaves this file.
import type { Context, Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { proHooks } from './pro-hooks';
import { refusedWebhooks } from './budget';

/** Seconds a test button waits before it works again. */
export const TEST_GAP_MS = 15_000;
/** Outbound test calls give up after this long. */
export const TEST_TIMEOUT_MS = 5_000;
/** A heartbeat is written at most this often. */
const HEARTBEAT_EVERY_MS = 10 * 60_000;
/** The tick heartbeat counts as fresh for this long. It is written every 15 minutes, so 35 minutes survives one missed cron run. */
export const TICK_FRESH_MS = 35 * 60_000;
/** The old hourly cron's heartbeat counts as fresh for this long. */
const HOURLY_FRESH_MS = 2 * 60 * 60_000;

export type Status = 'ok' | 'warn' | 'error' | 'off';

export interface Row {
  id: string;
  label: string;
  status: Status;
  detail: string;
  /** What to do next, or null when nothing is left. */
  next: string | null;
  /** The section of the docs that explains the row, as `docs/<file>#<anchor>`. */
  guide: string;
  /** A value the owner pastes somewhere else; the dashboard shows a copy button. */
  copy?: string;
  /** A test the owner can run from this row. */
  test?: string;
  /** Names of the secrets the row covers, and whether each is set. Never values. */
  secrets?: { name: string; set: boolean }[];
  /** The last test click: its outcome and time. */
  last_test?: { ok: boolean; at: number; message: string } | null;
  site?: { id: string; name: string };
}

// ---------- the cron heartbeat

/**
 * Records that a cron invocation ran. One upsert that writes only when the last heartbeat of that cron is older than
 * 10 minutes, so it costs 1 subrequest. At the cron's 15-minute spacing that is 4 rows an hour.
 */
export async function recordTick(db: D1Database, cron: 'five' | 'hourly', now: number) {
  await db
    .prepare(
      `INSERT INTO cron_state (key, value, at) VALUES (?1, '1', ?2)
       ON CONFLICT (key) DO UPDATE SET at = excluded.at WHERE at < excluded.at - ?3`,
    )
    .bind(`tick:${cron}`, now, HEARTBEAT_EVERY_MS)
    .run();
}

const minutesAgo = (now: number, at: number) => Math.max(0, Math.round((now - at) / 60_000));
export const ago = (now: number, at: number) => {
  const m = minutesAgo(now, at);
  if (m < 1) return 'less than a minute ago';
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
};

// ---------- the rows

export type State = Map<string, { value: string; at: number }>;

export const has = (env: Env, name: string) => !!(env as unknown as Record<string, unknown>)[name];
export const secrets = (env: Env, names: string[]) => names.map((name) => ({ name, set: has(env, name) }));

/** A row for an integration that needs all of `names`: off with none set, warn with some, ok with all. */
export function groupRow(env: Env, id: string, label: string, names: string[], ok: string, next: string, guide: string, optional: string[] = []): Row {
  const list = secrets(env, [...names, ...optional]);
  const need = list.filter((s) => names.includes(s.name));
  const missing = need.filter((s) => !s.set).map((s) => s.name);
  if (!missing.length) return { id, label, status: 'ok', detail: ok, next: null, guide, secrets: list };
  if (missing.length === need.length) return { id, label, status: 'off', detail: 'Off. No secret is set.', next, guide, secrets: list };
  return { id, label, status: 'warn', detail: `Missing: ${missing.join(', ')}.`, next: `Set ${missing.join(', ')} with wrangler secret put. ${next}`, guide, secrets: list };
}

export function lastTest(state: State, name: string): Row['last_test'] {
  const r = state.get(`test:${name}`);
  if (!r) return null;
  try {
    const v = JSON.parse(r.value) as { ok?: boolean; message?: string };
    return typeof v.ok === 'boolean' ? { ok: v.ok, at: r.at, message: String(v.message ?? '').slice(0, 200) } : null;
  } catch {
    return null;
  }
}

/** The cron row; GET /api/v1/setup maps it onto its `cron` step (setup-state.ts). */
export function cronRow(state: State, now: number): Row {
  const five = state.get('tick:five');
  const hourly = state.get('tick:hourly');
  const fiveFresh = !!five && now - five.at <= TICK_FRESH_MS;
  const hourlyFresh = !!hourly && now - hourly.at <= HOURLY_FRESH_MS;
  const base = { id: 'cron', label: 'Cron ticks', guide: 'docs/GUIDE.md#setup-checklist' };
  if (fiveFresh && hourlyFresh) {
    return {
      ...base,
      status: 'warn',
      detail: `The */5 cron ran ${ago(now, five!.at)}. The old hourly cron, '0 * * * *', ran ${ago(now, hourly!.at)} too, so both are listed.`,
      next: "Remove '0 * * * *' from triggers.crons in your wrangler config. Then deploy again. The */5 cron already does its work.",
    };
  }
  if (fiveFresh) return { ...base, status: 'ok', detail: `The */5 cron ran ${ago(now, five!.at)}. The old hourly cron is not listed.`, next: null };
  if (five) {
    return {
      ...base,
      status: 'error',
      detail: `The */5 cron last ran ${ago(now, five.at)}. It should run every 5 minutes.`,
      next: 'Open the Worker in the Cloudflare dashboard. Go to Settings, then Triggers. Check that `*/5 * * * *` is listed. If it is not, run npm run setup.',
    };
  }
  if (hourlyFresh) {
    return {
      ...base,
      status: 'warn',
      detail: `Only the old hourly cron ran, ${ago(now, hourly!.at)}. Rank checks and AI checks run once an hour, not every 5 minutes, so first ranks take up to an hour.`,
      next: "Add '*/5 * * * *' to triggers.crons in your wrangler config and remove '0 * * * *'. Then deploy again.",
    };
  }
  return {
    ...base,
    status: 'warn',
    detail: 'No heartbeat yet. It is written at minutes 0, 15, 30 and 45 of each hour.',
    next: 'Check back in 15 minutes. If this stays empty, open Settings, then Triggers of the Worker in the Cloudflare dashboard.',
  };
}

/** The newest payment time per `site|provider` for every secret that is set, in one batch. */
async function lastPayments(db: D1Database, sites: SiteRow[]): Promise<Map<string, number>> {
  const pairs: { key: string; stmt: D1PreparedStatement }[] = [];
  for (const s of sites) {
    for (const p of PROVIDERS) {
      if (s[p.id]) pairs.push({ key: `${s.id}|${p.payments}`, stmt: db.prepare('SELECT ts FROM payments WHERE site_id = ?1 AND provider = ?2 ORDER BY ts DESC LIMIT 1').bind(s.id, p.payments) });
    }
  }
  const out = new Map<string, number>();
  if (!pairs.length) return out;
  const res = await db.batch<{ ts: number }>(pairs.map((p) => p.stmt));
  res.forEach((r, i) => {
    if (r.results[0]) out.set(pairs[i].key, r.results[0].ts);
  });
  return out;
}

interface SiteRow {
  id: string;
  name: string;
  stripe: string | null;
  dodo: string | null;
  lemonsqueezy: string | null;
  polar: string | null;
  paddle: string | null;
  revenuecat: string | null;
}

const PROVIDERS: { id: keyof Omit<SiteRow, 'id' | 'name'>; label: string; payments: string }[] = [
  { id: 'stripe', label: 'Stripe', payments: 'stripe' },
  { id: 'dodo', label: 'Dodo Payments', payments: 'dodo' },
  { id: 'lemonsqueezy', label: 'Lemon Squeezy', payments: 'lemonsqueezy' },
  { id: 'polar', label: 'Polar', payments: 'polar' },
  { id: 'paddle', label: 'Paddle', payments: 'paddle' },
  { id: 'revenuecat', label: 'RevenueCat', payments: 'revenuecat' },
];

/** The rows of the checklist. Reads D1 only. Exported for tests. */
export async function checklist(env: Env, origin: string, now: number): Promise<Row[]> {
  const db = env.DB;
  const [stateRows, sites, refused] = await Promise.all([
    db.prepare("SELECT key, value, at FROM cron_state WHERE key LIKE 'tick:%' OR key LIKE 'test:%'").all<{ key: string; value: string; at: number }>(),
    db
      .prepare(
        `SELECT id, name, stripe_webhook_secret AS stripe, dodo_webhook_secret AS dodo, lemonsqueezy_secret AS lemonsqueezy, polar_secret AS polar,
                paddle_secret AS paddle, revenuecat_auth AS revenuecat FROM sites ORDER BY created_at, id`,
      )
      .all<SiteRow>(),
    refusedWebhooks(db, now),
  ]);
  // The newest payment per site and provider that has a signing secret. Each lookup walks the (site_id, ts) index newest first
  // and stops at the first match, where a GROUP BY over provider would read every payment row on each page load.
  const payments = await lastPayments(db, sites.results);
  const state: State = new Map(stateRows.results.map((r) => [r.key, { value: r.value, at: r.at }]));
  const rows: Row[] = [cronRow(state, now)];

  // The integrations Pro owns: DataForSEO, Google, X, App Store sales, Apple Search Ads, Meta ads, push and AI engines.
  rows.push(...((await proHooks()?.setupRows?.(env, { origin, now, state })) ?? []));

  // Email: Resend, or Cloudflare Email Routing.
  const emailSet = has(env, 'RESEND_API_KEY') || !!env.EMAIL;
  rows.push({
    id: 'email',
    label: 'Email for alerts and the weekly report',
    status: emailSet ? 'ok' : 'off',
    detail: emailSet ? 'A sender is set.' : 'Off. No email alert or weekly report is sent.',
    next: emailSet ? null : 'Set RESEND_API_KEY and ALERT_EMAIL_FROM, or add the EMAIL binding.',
    guide: 'docs/GUIDE.md#alerts-and-weekly-report',
    secrets: secrets(env, ['RESEND_API_KEY']),
  });

  // Payment webhooks per site: the last payment each provider's webhook delivered, and bad-signature refusals.
  const last = payments;
  const bad = new Map(refused.map((r) => [`${r.siteId}|${r.provider}`, r]));
  for (const s of sites.results) {
    const set = PROVIDERS.filter((p) => !!s[p.id]);
    if (!set.length) {
      rows.push({
        id: `webhook:${s.id}`,
        label: `${s.name}, payment webhook`,
        status: 'off',
        detail: 'No payment provider has a signing secret for this site.',
        next: 'Add the webhook URL in your payment provider and paste its signing secret in the site settings.',
        guide: 'docs/GUIDE.md#revenue-attribution-with-stripe',
        site: { id: s.id, name: s.name },
      });
      continue;
    }
    for (const p of set) {
      const at = last.get(`${s.id}|${p.payments}`);
      const refusal = bad.get(`${s.id}|${p.id}`);
      rows.push({
        id: `webhook:${s.id}:${p.id}`,
        label: `${s.name}, ${p.label} webhook`,
        status: refusal ? 'error' : at ? 'ok' : 'warn',
        detail: refusal
          ? `${refusal.count} deliveries failed the signature check in the last 24 hours.${at ? ` Last payment received ${ago(now, at)}.` : ''}`
          : at
            ? `Last payment received ${ago(now, at)}.`
            : 'The signing secret is set. No payment has arrived yet.',
        next: refusal
          ? `The signing secret in the site settings differs from the one in ${p.label}. Copy it again.`
          : at
            ? null
            : `Send a test event from ${p.label}, or make a test purchase.`,
        guide: p.id === 'stripe' ? 'docs/GUIDE.md#revenue-attribution-with-stripe' : p.id === 'dodo' ? 'docs/GUIDE.md#revenue-attribution-with-dodo-payments' : p.id === 'revenuecat' ? 'ios/README.md#using-revenuecat' : 'docs/GUIDE.md#revenue-attribution-with-lemon-squeezy-polar-paddle-and-gumroad',
        site: { id: s.id, name: s.name },
      });
    }
  }
  return rows;
}

// ---------- the tests

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export const withTimeout =
  (f: Fetch): Fetch =>
  (url, init) =>
    f(url, { ...init, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });

/** Claims a test button. False when the last claim is younger than TEST_GAP_MS. One row written when it is granted, none when it is not. */
export const claimTest = (db: D1Database, name: string, now: number) => claimKey(db, `test:${name}`, now);

/** Claims one cron_state row for a rate-limited check (a test button, the install check of setup-state.ts). */
export async function claimKey(db: D1Database, key: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO cron_state (key, value, at) VALUES (?1, '{"ok":false,"message":"The test did not finish."}', ?2)
       ON CONFLICT (key) DO UPDATE SET value = '{"ok":false,"message":"The test did not finish."}', at = excluded.at WHERE at <= excluded.at - ?3`,
    )
    .bind(key, now, TEST_GAP_MS)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

const saveOutcome = (db: D1Database, name: string, ok: boolean, message: string) =>
  db.prepare('UPDATE cron_state SET value = ?1 WHERE key = ?2').bind(JSON.stringify({ ok, message: message.slice(0, 200) }), `test:${name}`).run();


/**
 * A test button spends a call on the owner's account, so a cross-site POST must not reach it. A browser names the page that
 * sent the request: refuse a different Origin, and a Sec-Fetch-Site of cross-site or same-site (a sibling subdomain shares the
 * cookie). Scripts and curl send neither header and pass. Same rule as the team routes (team.ts).
 */
export const sameOriginPost = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    if ((origin && origin !== new URL(c.req.url).origin) || (site && site !== 'same-origin' && site !== 'none')) {
      return c.json({ error: 'Tests must be started from the dashboard.' }, 403);
    }
  }
  await next();
};

export function registerSetupRoutes(app: Hono<AppEnv>) {
  app.use('/api/setup/*', sameOriginPost);
  const owner = (c: Context<AppEnv>) => (c.get('role') === 'admin' ? null : c.json({ error: 'The setup checklist is for owners. Ask an owner.' }, 403));
  app.get('/api/setup', async (c) => {
    const no = owner(c);
    if (no) return no;
    const now = Date.now();
    return c.json({ now, rows: await checklist(c.env, new URL(c.req.url).origin, now) }, 200, { 'cache-control': 'private, no-store' });
  });
  app.post('/api/setup/test/:name', async (c) => {
    const no = owner(c);
    if (no) return no;
    // The test buttons are Pro's (Pro.setupTests); core has none.
    const tests = proHooks()?.setupTests ?? {};
    const name = c.req.param('name') ?? '';
    if (!Object.hasOwn(tests, name)) return c.json({ error: 'unknown test' }, 404);
    const now = Date.now();
    if (!(await claimTest(c.env.DB, name, now))) {
      return c.json({ error: `Wait ${Math.ceil(TEST_GAP_MS / 1000)} seconds between tests.` }, 429, { 'retry-after': String(Math.ceil(TEST_GAP_MS / 1000)) });
    }
    const out = await tests[name](c.env);
    await saveOutcome(c.env.DB, name, out.ok, out.message);
    return c.json({ ...out, at: now }, 200, { 'cache-control': 'private, no-store' });
  });
}
