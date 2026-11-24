// The setup state (docs/API.md, "Setup state"): every step of a deployment's setup, each with a status that a real
// signal backs, who acts, and a paste-ready prompt for the coding agent. The dashboard's onboarding, `npm run doctor`
// and the MCP tool get_setup read the same answer.
//
// - GET  /api/v1/setup                  the state. Owner login, or a key with read (its sites only). Reads D1 in one batch, writes nothing.
// - POST /api/v1/setup/verify-install   fetches a site's homepage and looks for its tracker tag. One cron_state row
//                                       ('verify:<site>') rate limits it to one check per 15 seconds and keeps the outcome.
//
// Done means a real signal arrived: a visit for the tracker, an app event for the SDK, a payment for a provider, a payment
// linked to a visit for attribution, an App Store notification for Apple, a call for a key. A secret that is set only
// makes a step `waiting`. Secrets appear as names and booleans: the site query selects `IS NOT NULL`, never a value.
import type { Context, Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { crossOriginWrite, sessionRole } from './auth';
import { refusedWebhooks } from './budget';
import { proHooks } from './pro-hooks';
import { ago, claimKey, cronRow, has, TEST_GAP_MS, TEST_TIMEOUT_MS, type State } from './setup-checklist';
import { ALL_SITES, noReadScope, readKeyOf } from './share';
import { VERSION } from '../shared/product';
import { STEP_GROUPS, type SetupState, type SiteKind, type Step, type StepStatus } from '../shared/setup-steps';

export type { SetupState, Step } from '../shared/setup-steps';

/** Sessions read for a site's newest web and app visit when it has both. */
const RECENT_SESSIONS = 300;
/** Unlinked payments counted at most, for "N payments, none linked to a visit". */
const UNLINKED_MAX = 100;
/** Bytes of a homepage the install check reads. */
const PAGE_MAX = 1_000_000;

const SETUP_SKILL = 'skills/founderdata-setup/SKILL.md';
const CONNECT_SKILL = 'skills/founderdata-connect/SKILL.md';
const connectSkill = (provider: string) => `skills/founderdata-connect/${provider}.md`;
const connect = (provider: string, site: string) => `npm run connect -- ${provider} --site ${site}`;

// ---------- the sites

/** A site as this module reads it: each secret as 1 or 0, never its value. */
export interface SetupSite {
  id: string;
  name: string;
  domain: string;
  app_bundle_id: string | null;
  kind: SiteKind;
  /** Payment providers with a signing secret or token set, in PAY order. */
  providers: string[];
}

interface PayProvider {
  /** The provider id of `npm run connect`, payments.provider and the refused-webhook counter. */
  id: string;
  label: string;
  /** The site setting that holds its secret. */
  field: string;
}

/** Payment providers a site connects with a webhook. App Store notifications are the `apple:<site>` step. */
export const PAY: PayProvider[] = [
  { id: 'stripe', label: 'Stripe', field: 'stripe_webhook_secret' },
  { id: 'dodo', label: 'Dodo Payments', field: 'dodo_webhook_secret' },
  { id: 'lemonsqueezy', label: 'Lemon Squeezy', field: 'lemonsqueezy_secret' },
  { id: 'polar', label: 'Polar', field: 'polar_secret' },
  { id: 'paddle', label: 'Paddle', field: 'paddle_secret' },
  { id: 'gumroad', label: 'Gumroad', field: 'gumroad_token' },
  { id: 'revenuecat', label: 'RevenueCat', field: 'revenuecat_auth' },
];
const label = (id: string) => PAY.find((p) => p.id === id)?.label ?? id;

export const kindOf = (s: { domain: string; app_bundle_id: string | null }): SiteKind =>
  s.domain.endsWith('.invalid') ? 'app' : s.app_bundle_id ? 'both' : 'web';

const SITES_SQL = `SELECT id, name, domain, app_bundle_id, ${PAY.map((p) => `${p.field} IS NOT NULL AS ${p.id}`).join(', ')} FROM sites ORDER BY created_at, id`;

// ---------- the Apple notification marker

const appleNoted = new Set<string>();

/**
 * Called by the App Store webhook (appstore.ts) for every notification that passed the signature and bundle checks,
 * including Apple's TEST notification. Writes one cron_state row ('apple:<site>') the first time per site and nothing
 * after: INSERT OR IGNORE writes no row when it exists, and this isolate skips the statement once it saw the site.
 */
export async function noteAppleNotification(db: D1Database, siteId: string, now: number) {
  if (appleNoted.has(siteId)) return;
  await db.prepare("INSERT OR IGNORE INTO cron_state (key, value, at) VALUES (?1, '1', ?2)").bind(`apple:${siteId}`, now).run();
  appleNoted.add(siteId);
}

/** Tests only. */
export function resetSetupStateForTests() {
  appleNoted.clear();
}

// ---------- reading the signals: one D1 batch

interface SiteSignals {
  /** Newest web and app session. */
  web: number | null;
  app: number | null;
  /** Newest payment per provider id, for the providers set and for the recent payments. */
  paid: Map<string, number>;
  /** A payment linked to a visit, any time. */
  linked: number | null;
  /** Payments not linked to a visit, counted up to UNLINKED_MAX. */
  unlinked: number;
}

interface Signals {
  state: State;
  refused: Map<string, number>;
  keys: { n: number; used: number | null };
  emailChannel: boolean;
  sites: Map<string, SiteSignals>;
}

async function readSignals(db: D1Database, sites: SetupSite[], now: number): Promise<Signals> {
  // cron_state rows by exact key: the cron heartbeats, and per site the install check, the Apple marker and the nightly
  // first-visit record (sources.ts). Each is a primary key seek.
  const keys = ['tick:five', 'tick:hourly', ...sites.flatMap((s) => [`verify:${s.id}`, `apple:${s.id}`, `since:${s.id}`])];
  const stmts: D1PreparedStatement[] = [
    db.prepare('SELECT key, value, at FROM cron_state WHERE key IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(keys)),
    db.prepare('SELECT COUNT(*) AS n, MAX(last_used_at) AS used FROM api_keys'),
    db.prepare("SELECT 1 AS one FROM alert_channels WHERE kind = 'email' LIMIT 1"),
  ];
  const per: { site: string; what: 'visits' | 'recent' | 'paid' | 'linked' | 'unlinked'; provider?: string }[] = [];
  for (const s of sites) {
    // The newest session, or for a site with a website and an app the newest of each among the last 300. The nightly
    // record in cron_state covers an older one.
    const limit = s.kind === 'both' ? RECENT_SESSIONS : 1;
    stmts.push(
      db
        .prepare(
          `SELECT MAX(CASE WHEN hostname LIKE 'ios:%' THEN NULL ELSE started_at END) AS web, MAX(CASE WHEN hostname LIKE 'ios:%' THEN started_at END) AS app
           FROM (SELECT started_at, hostname FROM sessions WHERE site_id = ?1 ORDER BY started_at DESC LIMIT ${limit})`,
        )
        .bind(s.id),
    );
    per.push({ site: s.id, what: 'visits' });
    // The newest payment per provider among the last 200: payments API, App Store and providers without a secret.
    stmts.push(
      db
        .prepare(`SELECT provider, MAX(ts) AS ts FROM (SELECT provider, ts FROM payments WHERE site_id = ?1 AND kind = 'payment' ORDER BY ts DESC LIMIT 200) GROUP BY provider`)
        .bind(s.id),
    );
    per.push({ site: s.id, what: 'recent' });
    // Each provider with a secret: its newest payment, walking the (site_id, ts) index newest first.
    for (const p of s.providers) {
      stmts.push(db.prepare("SELECT ts FROM payments WHERE site_id = ?1 AND provider = ?2 AND kind = 'payment' ORDER BY ts DESC LIMIT 1").bind(s.id, p));
      per.push({ site: s.id, what: 'paid', provider: p });
    }
    // Any payment linked to a visit: one seek on the partial index payments_visitor.
    stmts.push(db.prepare("SELECT ts FROM payments WHERE site_id = ?1 AND visitor_id IS NOT NULL AND kind = 'payment' LIMIT 1").bind(s.id));
    per.push({ site: s.id, what: 'linked' });
    stmts.push(
      db
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM payments WHERE site_id = ?1 AND kind = 'payment' AND visitor_id IS NULL AND provider != 'income' LIMIT ${UNLINKED_MAX})`)
        .bind(s.id),
    );
    per.push({ site: s.id, what: 'unlinked' });
  }
  const [res, refused] = await Promise.all([db.batch<Record<string, unknown>>(stmts), refusedWebhooks(db, now)]);
  const state: State = new Map((res[0].results as { key: string; value: string; at: number }[]).map((r) => [r.key, { value: r.value, at: r.at }]));
  const k = res[1].results[0] as { n: number; used: number | null } | undefined;
  const out: Signals = {
    state,
    refused: new Map(refused.map((r) => [`${r.siteId}|${r.provider}`, r.count])),
    keys: { n: Number(k?.n ?? 0), used: k?.used ?? null },
    emailChannel: res[2].results.length > 0,
    sites: new Map(sites.map((s) => [s.id, { web: null, app: null, paid: new Map(), linked: null, unlinked: 0 }])),
  };
  per.forEach((p, i) => {
    const sig = out.sites.get(p.site)!;
    const rows = res[i + 3].results as Record<string, unknown>[];
    const first = rows[0];
    if (p.what === 'visits') {
      sig.web = (first?.web as number | null) ?? null;
      sig.app = (first?.app as number | null) ?? null;
    } else if (p.what === 'recent') {
      for (const r of rows) sig.paid.set(String(r.provider), Number(r.ts));
    } else if (p.what === 'paid') {
      if (first) sig.paid.set(p.provider!, Math.max(Number(first.ts), sig.paid.get(p.provider!) ?? 0));
    } else if (p.what === 'linked') {
      sig.linked = first ? Number(first.ts) : null;
    } else {
      sig.unlinked = Number(first?.n ?? 0);
    }
  });
  // The nightly record keeps the newest web and app session it saw (sources.ts refreshTrackingSince).
  for (const s of sites) {
    const rec = parseSince(state.get(`since:${s.id}`)?.value);
    const sig = out.sites.get(s.id)!;
    sig.web = maxOf(sig.web, rec?.web_last ?? rec?.web ?? null);
    sig.app = maxOf(sig.app, rec?.app_last ?? rec?.app ?? null);
  }
  return out;
}

const maxOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

function parseSince(v: string | undefined): { web: number | null; app: number | null; web_last?: number | null; app_last?: number | null } | null {
  if (!v) return null;
  try {
    const r = JSON.parse(v);
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

/** The install check's last outcome for a site, from its cron_state row. */
function lastCheck(state: State, siteId: string): { found: string; at: number } | null {
  const r = state.get(`verify:${siteId}`);
  if (!r) return null;
  try {
    const v = JSON.parse(r.value) as { found?: unknown };
    return typeof v.found === 'string' ? { found: v.found, at: r.at } : null;
  } catch {
    return null;
  }
}

// ---------- the steps

interface Ctx {
  env: Env;
  origin: string;
  now: number;
  sig: Signals;
  /** The caller is a scoped key: it is in use right now. */
  callerIsKey: boolean;
}

const base = (s: Partial<Step> & Pick<Step, 'id' | 'group' | 'title' | 'outcome' | 'status' | 'who'>): Step => ({
  site: null,
  required: false,
  evidence: null,
  next: null,
  prompt: null,
  skill: null,
  url: null,
  command: null,
  cost: 'Free',
  ...s,
});

/** A done step carries no prompt or next; there is nothing left to do. */
const finish = (s: Step): Step => (s.status === 'done' ? { ...s, next: null, prompt: null } : s);

const siteRef = (s: SetupSite) => ({ id: s.id, name: s.name });
const settings = (s: SetupSite, anchor: string) => `/site/${s.id}/settings#${anchor}`;
const tagOf = (s: SetupSite, origin: string) => `<script defer data-website-id="${s.id}" src="${origin}/js/script.js"></script>`;

function deploySteps(c: Ctx, sites: SetupSite[]): Step[] {
  const steps: Step[] = [
    base({
      id: 'deploy',
      group: 'deploy',
      title: 'Deploy FounderData',
      outcome: 'Your own FounderData on your Cloudflare account, with its own database.',
      status: 'done',
      who: 'agent',
      required: true,
      evidence: `Version ${VERSION} answers at ${c.origin}.`,
      skill: SETUP_SKILL,
      command: 'npm run setup',
    }),
  ];

  const row = cronRow(c.sig.state, c.now);
  const noBeat = !c.sig.state.get('tick:five') && !c.sig.state.get('tick:hourly');
  const cron: StepStatus = row.status === 'ok' ? 'done' : row.status === 'warn' && noBeat ? 'waiting' : 'broken';
  steps.push(
    finish(
      base({
        id: 'cron',
        group: 'deploy',
        title: 'Check the cron',
        outcome: 'Alerts, the weekly report and every import run on time.',
        status: cron,
        who: 'agent',
        evidence: row.detail,
        next: row.next,
        prompt:
          cron === 'broken'
            ? `The FounderData cron at ${c.origin} needs a fix. ${row.detail} ${row.next ?? ''} Follow ${SETUP_SKILL}. Then call get_setup and check that the step cron is done.`.replace(/\s+/g, ' ').trim()
            : null,
        skill: SETUP_SKILL,
        command: cron === 'broken' ? 'npm run setup' : null,
      }),
    ),
  );

  const sender = has(c.env, 'RESEND_API_KEY') || !!c.env.EMAIL;
  const email: StepStatus = !sender ? 'off' : c.sig.emailChannel ? 'done' : 'todo';
  steps.push(
    finish(
      base({
        id: 'email',
        group: 'deploy',
        title: 'Send alerts by email',
        outcome: 'Payment alerts and the Monday report in your inbox.',
        status: email,
        who: 'you',
        evidence: email === 'done' ? 'A sender is set and an email channel exists.' : sender ? 'A sender is set. No email channel exists yet.' : null,
        next:
          email === 'todo'
            ? 'Add an email channel in Settings, Alerts.'
            : email === 'off'
              ? 'Optional. Connect Resend, or add the EMAIL binding with npm run setup -- --mail.'
              : null,
        prompt:
          email === 'off'
            ? `Set up email alerts for FounderData at ${c.origin}. Follow ${connectSkill('resend')}. Store the Resend API key only with \`npm run connect -- resend\`. Never print, type or log it.`
            : null,
        skill: connectSkill('resend'),
        url: sites[0] ? settings(sites[0], 'alerts') : null,
        command: email === 'off' ? 'npm run connect -- resend' : null,
        secrets: [{ name: 'RESEND_API_KEY', set: has(c.env, 'RESEND_API_KEY') }],
      }),
    ),
  );
  return steps;
}

function siteStep(c: Ctx, sites: SetupSite[], all: boolean): Step {
  const n = sites.length;
  return finish(
    base({
      id: 'site',
      group: 'track',
      title: 'Add your sites and apps',
      outcome: 'One place for each website and app, with its own numbers.',
      status: n ? 'done' : 'todo',
      who: 'agent',
      required: true,
      evidence: n ? `${n} ${n === 1 ? 'site' : 'sites'}${all ? '' : ' this key covers'}.` : null,
      next: n ? null : 'Add the first website or app.',
      prompt: n
        ? null
        : `Add my websites and apps to FounderData at ${c.origin}. Ask me which ones to track, all at once. Follow ${SETUP_SKILL}. Write sites.json from sites.example.json, then run \`node scripts/setup-sites.mjs ${c.origin}\`. It prints each site's id and script tag.`,
      skill: SETUP_SKILL,
      command: n ? null : `node scripts/setup-sites.mjs ${c.origin}`,
    }),
  );
}

function trackerStep(c: Ctx, s: SetupSite): Step {
  const seen = c.sig.sites.get(s.id)!.web;
  const check = lastCheck(c.sig.state, s.id);
  let status: StepStatus = 'todo';
  let evidence: string | null = null;
  let next: string | null = 'Add the tracker tag to every page of the website, then deploy it.';
  if (seen) {
    status = 'done';
    evidence = `Last visit ${ago(c.now, seen)}.`;
  } else if (check?.found === 'tag') {
    status = 'waiting';
    evidence = `The install check found the tag ${ago(c.now, check.at)}. No visit yet.`;
    next = `Open https://${s.domain}/ in a browser. The first visit turns this step done.`;
  } else if (check?.found === 'other-site-id') {
    status = 'broken';
    evidence = `The install check found a tag with another site id ${ago(c.now, check.at)}.`;
    next = `Set data-website-id to ${s.id} in the tag.`;
  } else if (check) {
    evidence = `The install check found no tag ${ago(c.now, check.at)}.`;
  }
  return finish(
    base({
      id: `tracker:${s.id}`,
      group: 'track',
      site: siteRef(s),
      title: 'Install the tracker',
      outcome: 'Every visit with the post, search or ad that brought it.',
      status,
      who: 'agent',
      required: true,
      evidence,
      next,
      prompt: [
        `Install the FounderData tracker on ${s.domain}. Follow ${SETUP_SKILL}.`,
        `Add this tag once to the <head> of every page, including the logged-in app:`,
        tagOf(s, c.origin),
        `In Next.js, use next/script with the same attributes and strategy="afterInteractive".`,
        `If the site sends a Content-Security-Policy, allow ${c.origin} in script-src and connect-src.`,
        `Deploy the change. Then run the install check, POST ${c.origin}/api/v1/setup/verify-install with {"site":"${s.id}"}, and open https://${s.domain}/ once in a browser.`,
        `Call get_setup with site ${s.id}. The step tracker:${s.id} is done after the first visit.`,
      ].join('\n'),
      skill: SETUP_SKILL,
      url: settings(s, 'install'),
    }),
  );
}

function sdkStep(c: Ctx, s: SetupSite): Step {
  const seen = c.sig.sites.get(s.id)!.app;
  return finish(
    base({
      id: `sdk:${s.id}`,
      group: 'track',
      site: siteRef(s),
      title: 'Install the iOS SDK',
      outcome: 'Installs, screens, onboarding and purchases from the app.',
      status: seen ? 'done' : 'todo',
      who: 'agent',
      required: true,
      evidence: seen ? `Last app session ${ago(c.now, seen)}.` : null,
      next: seen ? null : 'Add FounderDataKit to the app and launch it once.',
      prompt: [
        `Install FounderDataKit in the iOS app ${s.app_bundle_id}. Follow ${SETUP_SKILL} and ios/README.md in the FounderData repository.`,
        `Add the Swift package https://github.com/founderdata/founderdata and link FounderDataKit to the app target.`,
        `In App.init(), call FounderData.configure(siteId: "${s.id}", host: "${c.origin}"), then FounderData.observeTransactions().`,
        `On the root view, add .onOpenURL { FounderData.handle(url: $0) }.`,
        `Build and launch the app once. Call get_setup with site ${s.id}. The step sdk:${s.id} is done after the first app session.`,
      ].join('\n'),
      skill: SETUP_SKILL,
      url: settings(s, 'ios-sdk'),
    }),
  );
}

function paymentSteps(c: Ctx, s: SetupSite): Step[] {
  const sig = c.sig.sites.get(s.id)!;
  const set = s.providers;
  const refused = set.filter((p) => c.sig.refused.has(`${s.id}|${p}`));
  const appOnly = s.kind === 'app';
  // An app pays through the App Store (the apple step) unless it uses RevenueCat: then RevenueCat is the required one.
  const required = !appOnly || set.includes('revenuecat');
  const webPay = [...sig.paid.entries()].filter(([p]) => p !== 'app_store' && p !== 'app_store_sandbox' && p !== 'income');
  const newest = webPay.sort((a, b) => b[1] - a[1])[0];
  const main = refused[0] ?? set.find((p) => sig.paid.has(p)) ?? set[0] ?? null;
  const steps: Step[] = [];

  let status: StepStatus;
  let evidence: string | null = null;
  let next: string | null = null;
  let prompt: string | null;
  if (refused.length) {
    const p = refused[0];
    status = 'broken';
    const n = c.sig.refused.get(`${s.id}|${p}`) ?? 0;
    evidence = `${n} ${label(p)} ${n === 1 ? 'delivery' : 'deliveries'} failed the signature check in the last 24 hours.`;
    next = `Save the current ${label(p)} signing secret again.`;
    prompt =
      `${label(p)} deliveries to FounderData for ${s.name} fail the signature check. The secret saved in FounderData differs from the one ${label(p)} shows. ` +
      `Follow ${connectSkill(p)}. Run \`${connect(p, s.id)}\` and let me paste the current secret. Never print, type or log it. ` +
      `Then call get_setup with site ${s.id} and check that payments:${s.id} is no longer broken.`;
  } else if (newest) {
    status = 'done';
    evidence = newest[0] === 'api' ? `Last payment through the payments API ${ago(c.now, newest[1])}.` : `Last ${label(newest[0])} payment ${ago(c.now, newest[1])}.`;
    prompt = null;
  } else if (set.length) {
    const p = set[0];
    status = 'waiting';
    evidence = `${set.map(label).join(', ')} ${set.length === 1 ? 'is' : 'are'} set. No payment has arrived yet.`;
    next = `Send a test event from ${label(p)}, or make a test purchase.`;
    prompt =
      `Check that ${label(p)} sends payments to FounderData for ${s.name}. Follow ${connectSkill(p)}.` +
      (p === 'gumroad' ? '' : ` The webhook URL is ${c.origin}/api/webhooks/${p}/${s.id}.`) +
      ` Send a test event from ${label(p)}, or make a test purchase. Then call get_setup with site ${s.id} and check that payments:${s.id} is done.`;
  } else {
    status = required ? 'todo' : 'off';
    next = required ? 'Connect the payment provider this site uses.' : 'Optional. Connect RevenueCat if the app uses it.';
    prompt =
      `Connect the payment provider of ${s.name} to FounderData. Ask me which one it uses: Stripe, Dodo Payments, Lemon Squeezy, Polar, Paddle, Gumroad or RevenueCat. ` +
      `Then follow skills/founderdata-connect/<provider>.md for that one. Store its secret only with \`npm run connect -- <provider> --site ${s.id}\`. Never print, type or log a secret. ` +
      `Then call get_setup with site ${s.id}. The step payments:${s.id} is done after the first payment.`;
  }
  steps.push(
    finish(
      base({
        id: `payments:${s.id}`,
        group: 'revenue',
        site: siteRef(s),
        title: 'Connect payments',
        outcome: 'Every payment in FounderData the moment it happens.',
        status,
        who: 'browser',
        required,
        evidence,
        next,
        prompt,
        skill: main ? connectSkill(main) : CONNECT_SKILL,
        url: settings(s, main ?? 'payments'),
        command: main ? connect(main, s.id) : null,
        secrets: PAY.map((p) => ({ name: p.field, set: set.includes(p.id) })),
      }),
    ),
  );

  // Attribution: a payment linked to a visit, from any provider, the App Store included.
  const anyPayment = sig.paid.size > 0;
  const appleSet = !!c.sig.state.get(`apple:${s.id}`);
  let aStatus: StepStatus;
  let aEvidence: string | null = null;
  let aNext: string | null = null;
  if (sig.linked) {
    aStatus = 'done';
    const latest = Math.max(sig.linked, ...sig.paid.values());
    aEvidence = `Payments are linked to visits. Latest payment ${ago(c.now, latest)}.`;
  } else if (sig.unlinked > 0) {
    aStatus = 'waiting';
    const n = sig.unlinked >= UNLINKED_MAX ? `${UNLINKED_MAX} or more` : String(sig.unlinked);
    aEvidence = `${n} ${sig.unlinked === 1 ? 'payment' : 'payments'}, none linked to a visit.`;
    aNext = 'Add the attribution ids at checkout.';
  } else if (set.length || anyPayment || appleSet) {
    aStatus = 'waiting';
    aEvidence = 'No payment has arrived yet.';
    aNext = 'Make a test purchase after a visit to the site.';
  } else {
    aStatus = required ? 'todo' : 'off';
    aNext = 'Connect payments first.';
  }
  const provider = main ?? (appOnly ? 'app-store' : null);
  const where = appOnly
    ? `In the app, buy through FounderData.purchase(product, source:), or with RevenueCat call FounderData.trackPurchase as ios/README.md says.`
    : `In the browser, window.founderdata.attribution() returns { rt_visitor_id, rt_session_id, rt_site_id }. Send these ids with the request that starts a checkout, and merge them into the checkout's metadata on the server. Keep every existing key.`;
  steps.push(
    finish(
      base({
        id: `attribution:${s.id}`,
        group: 'revenue',
        site: siteRef(s),
        title: 'Link payments to visits',
        outcome: 'Revenue per source, page and campaign, so you see what makes money.',
        status: aStatus,
        who: 'agent',
        required,
        evidence: aEvidence,
        next: aNext,
        prompt:
          `Pass the FounderData visitor ids into every checkout of ${s.name} in this codebase. ${where} ` +
          `Follow ${provider ? connectSkill(provider) : CONNECT_SKILL} for where they go. ` +
          `Then make a test purchase after a visit and call get_setup with site ${s.id}. The step attribution:${s.id} is done once a payment is linked to a visit.`,
        skill: provider ? connectSkill(provider) : CONNECT_SKILL,
        url: settings(s, 'payments'),
      }),
    ),
  );
  return steps;
}

function appleStep(c: Ctx, s: SetupSite): Step {
  const marker = c.sig.state.get(`apple:${s.id}`);
  const refused = c.sig.refused.get(`${s.id}|app_store`);
  // Required for an app without a website that does not use RevenueCat: the App Store is how it gets paid.
  const required = s.kind === 'app' && !s.providers.includes('revenuecat');
  const status: StepStatus = refused ? 'broken' : marker ? 'done' : required ? 'todo' : 'off';
  const hook = `${c.origin}/api/webhooks/apple/${s.id}`;
  return finish(
    base({
      id: `apple:${s.id}`,
      group: 'revenue',
      site: siteRef(s),
      title: 'Connect App Store notifications',
      outcome: 'Renewals, refunds and cancellations, also when the app is closed.',
      status,
      who: 'browser',
      required,
      evidence: refused
        ? `${refused} App Store ${refused === 1 ? 'notification' : 'notifications'} failed the signature check in the last 24 hours.`
        : marker
          ? `First App Store notification ${ago(c.now, marker.at)}.`
          : null,
      next: refused
        ? 'Check that the notification URL points at this site and that your backend forwards the raw body unchanged.'
        : marker
          ? null
          : required
            ? 'Set the App Store Server Notifications URL in App Store Connect.'
            : 'Optional. Set the App Store Server Notifications URL for renewals that happen while the app is closed.',
      prompt: [
        `Point App Store Server Notifications V2 of ${s.app_bundle_id} at FounderData. Follow ${connectSkill('app-store')}.`,
        `In App Store Connect, open the app, then App Information, then App Store Server Notifications. Set the production URL to:`,
        hook,
        `If a backend already receives the notifications, forward the raw body unchanged to that URL instead.`,
        `Call get_setup with site ${s.id}. The step apple:${s.id} is done after Apple's first notification for the app.`,
      ].join('\n'),
      skill: connectSkill('app-store'),
      url: 'https://appstoreconnect.apple.com/apps',
      command: connect('app-store', s.id),
    }),
  );
}

function agentSteps(c: Ctx, sites: SetupSite[]): Step[] {
  const { n, used } = c.sig.keys;
  const keyStatus: StepStatus = n || c.callerIsKey ? 'done' : 'todo';
  const usedStatus: StepStatus = used || c.callerIsKey ? 'done' : n ? 'waiting' : 'todo';
  const url = sites[0] ? settings(sites[0], 'agents') : null;
  return [
    finish(
      base({
        id: 'agent-key',
        group: 'agent',
        title: 'Give your agent a key',
        outcome: 'Your coding agent reads your numbers and checks each setup step itself.',
        status: keyStatus,
        who: 'agent',
        evidence: n ? `${n} API ${n === 1 ? 'key' : 'keys'}.` : c.callerIsKey ? 'This key is calling now.' : null,
        next: keyStatus === 'done' ? null : 'Create an API key with the read scope in Settings, Agents.',
        prompt:
          `Create a FounderData API key for yourself at ${c.origin} with the scopes read and notes:write. Follow ${SETUP_SKILL}. ` +
          'Keep the key in an environment variable or your MCP config. Never print it in the chat.',
        skill: SETUP_SKILL,
        url,
      }),
    ),
    finish(
      base({
        id: 'agent-used',
        group: 'agent',
        title: 'Connect the MCP server',
        outcome: 'Your agent calls get_setup and the report tools without a browser.',
        status: usedStatus,
        who: 'agent',
        evidence: c.callerIsKey ? 'This key is calling now.' : used ? `A key was used ${ago(c.now, used)}.` : n ? 'No key has been used yet.' : null,
        next: usedStatus === 'done' ? null : 'Add the MCP server to your agent and call get_setup once.',
        prompt:
          `Add the FounderData MCP server at ${c.origin}/mcp to this agent, with the header Authorization: Bearer and the key from your environment. ` +
          `In Claude Code: claude mcp add --transport http founderdata ${c.origin}/mcp --header "Authorization: Bearer $FOUNDERDATA_KEY". ` +
          'Restart the agent so it loads the tools, then call get_setup.',
        skill: SETUP_SKILL,
        url,
      }),
    ),
  ];
}

/** What FounderData Pro adds, as locked steps in core: the outcome each one unlocks. Never the next step. */
function lockedSteps(sites: SetupSite[]): Step[] {
  const lock = (id: string, title: string, outcome: string, site: SetupSite | null = null): Step =>
    base({
      id,
      group: 'growth',
      site: site ? siteRef(site) : null,
      title,
      outcome,
      status: 'locked',
      who: 'agent',
      next: 'Needs FounderData Pro. docs/PRO.md says how to install it.',
      cost: null,
      pro: true,
    });
  const web = sites.filter((s) => s.kind !== 'app');
  const apps = sites.filter((s) => s.kind !== 'web');
  return [
    ...web.map((s) => lock(`google:${s.id}`, 'Connect Google Search Console', 'The Google searches that bring visitors, with clicks and position per page.', s)),
    lock('dataforseo', 'Track keyword ranks', 'Daily Google ranks for the keywords you pick.'),
    lock('ai-engines', 'Check AI answers', 'How often ChatGPT, Claude, Gemini and Perplexity name your product.'),
    ...(apps.length
      ? [
          lock('asc-sales', 'Import App Store sales', "Apple's downloads and proceeds per day."),
          lock('apple-search-ads', 'Import Apple Search Ads', 'Spend, installs and ROAS per campaign and keyword.'),
        ]
      : []),
    ...web.map((s) => lock(`meta:${s.id}`, 'Import Meta ads', 'Spend, CPA and ROAS per ad, next to the customers each ad brought.', s)),
    ...sites.map((s) => lock(`plan:${s.id}`, 'Start a growth plan', 'A plan your agent works through, with each change measured.', s)),
    lock('schedule', 'Run the agent every night', 'Your agent works the plan each night and logs what it changed.'),
  ];
}

// ---------- ordering and the next step

const counts = (s: Step) => s.status !== 'off' && s.status !== 'locked';

/** Broken first, then required todo, required waiting, optional todo, optional waiting. Off and locked never. */
export function pickNext(steps: Step[]): Step | null {
  const rank = (s: Step) =>
    s.status === 'broken' ? 0 : s.required && s.status === 'todo' ? 1 : s.required && s.status === 'waiting' ? 2 : s.status === 'todo' ? 3 : s.status === 'waiting' ? 4 : 9;
  let best: Step | null = null;
  for (const s of steps) if (rank(s) < 9 && (!best || rank(s) < rank(best))) best = s;
  return best;
}

const byGroup = (steps: Step[]) => STEP_GROUPS.flatMap((g) => steps.filter((s) => s.group === g));

/**
 * The setup state for `sites` (every site for the owner; a key's sites; one site with ?site=). `all` says whether the
 * caller sees every site. Exported for tests.
 */
export async function setupState(env: Env, opts: { origin: string; now: number; sites: SetupSite[]; all: boolean; callerIsKey: boolean }): Promise<SetupState> {
  const { origin, now, sites } = opts;
  const sig = await readSignals(env.DB, sites, now);
  const c: Ctx = { env, origin, now, sig, callerIsKey: opts.callerIsKey };
  const pro = proHooks();
  const steps: Step[] = [...deploySteps(c, sites), siteStep(c, sites, opts.all)];
  for (const s of sites) {
    if (s.kind !== 'app') steps.push(trackerStep(c, s));
    if (s.kind !== 'web') steps.push(sdkStep(c, s));
  }
  for (const s of sites) {
    steps.push(...paymentSteps(c, s));
    if (s.kind !== 'web') steps.push(appleStep(c, s));
  }
  steps.push(...agentSteps(c, sites));
  if (pro) steps.push(...((await pro.setupSteps?.(env, { origin, now, sites, state: sig.state })) ?? []));
  else steps.push(...lockedSteps(sites));

  const ordered = byGroup(steps);
  const counted = ordered.filter(counts);
  const required = counted.filter((s) => s.required);
  return {
    edition: pro ? 'pro' : 'core',
    version: VERSION,
    origin,
    now,
    progress: {
      done: counted.filter((s) => s.status === 'done').length,
      total: counted.length,
      required_done: required.filter((s) => s.status === 'done').length,
      required_total: required.length,
    },
    next: pickNext(ordered),
    steps: ordered,
    sites: sites.map((s) => {
      const own = ordered.filter((x) => x.site?.id === s.id);
      const mine = own.filter(counts);
      return { id: s.id, name: s.name, kind: s.kind, done: mine.filter((x) => x.status === 'done').length, total: mine.length, next: pickNext(own)?.id ?? null };
    }),
  };
}

/** Every site, read with each secret as a boolean. */
export async function setupSites(db: D1Database): Promise<SetupSite[]> {
  const { results } = await db.prepare(SITES_SQL).all<Record<string, unknown>>();
  return results.map((r) => {
    const s = { id: String(r.id), name: String(r.name), domain: String(r.domain), app_bundle_id: (r.app_bundle_id as string | null) ?? null };
    return { ...s, kind: kindOf(s), providers: PAY.filter((p) => !!r[p.id]).map((p) => p.id) };
  });
}

// ---------- the install check

export type InstallFound = 'tag' | 'none' | 'other-site-id';

/** The FounderData site ids a page names in data-website-id, as an attribute or in serialized props (Next.js). */
export function tagIds(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/data-website-id\\?["']?\s*[:=]\s*\\?["']?([^"'\\\s>]{1,80})/gi)) out.add(m[1]);
  return [...out];
}

/** Site ids look like randomId(8): 16 lowercase letters and digits. A UUID in data-website-id is another tool's. */
const SITE_ID = /^[0-9a-z]{16}$/;

export function readInstall(html: string, siteId: string): { found: InstallFound; other: string | null } {
  const ids = tagIds(html);
  if (ids.includes(siteId)) return { found: 'tag', other: null };
  const other = ids.find((id) => SITE_ID.test(id)) ?? null;
  return other ? { found: 'other-site-id', other } : { found: 'none', other: null };
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (text.length < max) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  reader.cancel().catch(() => undefined);
  return text.slice(0, max);
}

/** Fetches https://<domain>/ and reads the tag. Never throws: a failure is `none` with a plain message. */
export async function checkInstall(domain: string, siteId: string, f: typeof fetch = fetch): Promise<{ ok: boolean; found: InstallFound; message: string; url: string }> {
  const url = `https://${domain}/`;
  let res: Response;
  try {
    res = await f(url, { redirect: 'follow', headers: { accept: 'text/html', 'user-agent': 'FounderData install check' }, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const message =
      name === 'TimeoutError' || name === 'AbortError'
        ? `${url} did not answer within ${TEST_TIMEOUT_MS / 1000} seconds.`
        : `FounderData could not reach ${url}. Check that the domain is right and the site is live.`;
    return { ok: false, found: 'none', message, url };
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, found: 'none', message: `${url} answered ${res.status}. Check that the site is deployed.`, url };
  }
  const { found, other } = readInstall(await readCapped(res, PAGE_MAX), siteId);
  if (found === 'tag') return { ok: true, found, message: `The tag for this site is on ${url}. The step turns done with the first visit.`, url };
  if (found === 'other-site-id') return { ok: false, found, message: `${url} has a FounderData tag for another site: ${other}. Set data-website-id to ${siteId}.`, url };
  return {
    ok: false,
    found,
    message: `The HTML of ${url} has no tag for this site. A tag that JavaScript adds after the page loads does not show here. Open the site in a browser. The first visit counts too.`,
    url,
  };
}

// ---------- the routes

type Caller = { key: false } | { key: true; sites: string[] | null; scoped: boolean };

/** The owner's login, or a key with read. A viewer gets 403, no login 401. */
async function callerOf(c: Context<AppEnv>): Promise<Caller | Response> {
  if (c.req.header('authorization')) {
    const tok = await readKeyOf(c);
    if (!tok) return c.json({ error: 'Send an API key with the read scope: Authorization: Bearer fdk_... (Settings, Agents)' }, 401);
    const refused = noReadScope(c, tok);
    if (refused) return refused;
    const scoped = tok.scopes !== undefined;
    return { key: true, scoped, sites: scoped ? (tok.sites ?? null) : tok.site_id === ALL_SITES ? null : [tok.site_id] };
  }
  const role = await sessionRole(c);
  if (!role) return c.json({ error: 'Sign in as the owner, or send an API key with the read scope.' }, 401);
  if (role !== 'admin') return c.json({ error: 'The setup state is for owners. Ask an owner, or use an API key with the read scope.' }, 403);
  if (crossOriginWrite(c)) return c.json({ error: 'Install checks must start from the dashboard.' }, 403);
  return { key: false };
}

/** The sites the caller may see, narrowed to ?site= or the body's site. A Response for an unknown or uncovered site. */
async function sitesFor(c: Context<AppEnv>, caller: Caller, siteId: string | undefined): Promise<{ sites: SetupSite[]; all: boolean } | Response> {
  const every = await setupSites(c.env.DB);
  const mine = caller.key && caller.sites ? every.filter((s) => caller.sites!.includes(s.id)) : every;
  if (!siteId) return { sites: mine, all: mine.length === every.length };
  if (caller.key && caller.sites && !caller.sites.includes(siteId)) return c.json({ error: `This key does not cover the site ${siteId}.` }, 403);
  const one = mine.find((s) => s.id === siteId);
  if (!one) return c.json({ error: `No site has the id ${siteId}. GET /api/v1/whoami lists the sites it covers.` }, 404);
  return { sites: [one], all: false };
}

export function registerSetupStateRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/setup', async (c) => {
    const caller = await callerOf(c);
    if (caller instanceof Response) return caller;
    const scope = await sitesFor(c, caller, c.req.query('site') || undefined);
    if (scope instanceof Response) return scope;
    const state = await setupState(c.env, {
      origin: new URL(c.req.url).origin,
      now: Date.now(),
      sites: scope.sites,
      all: scope.all,
      callerIsKey: caller.key && caller.scoped,
    });
    return c.json(state, 200, { 'cache-control': 'private, no-store' });
  });

  app.post('/api/v1/setup/verify-install', async (c) => {
    const caller = await callerOf(c);
    if (caller instanceof Response) return caller;
    const b = await c.req.json<{ site?: unknown }>().catch(() => null);
    const siteId = typeof b?.site === 'string' ? b.site.trim() : '';
    if (!siteId) return c.json({ error: 'Send {"site": "<site id>"}.' }, 400);
    const scope = await sitesFor(c, caller, siteId);
    if (scope instanceof Response) return scope;
    const site = scope.sites[0];
    if (site.kind === 'app') {
      return c.json({ error: `${site.name} is an app without a website, so it has no tracker tag. The step sdk:${site.id} turns done with the app's first session.` }, 400);
    }
    const now = Date.now();
    if (!(await claimKey(c.env.DB, `verify:${site.id}`, now))) {
      const wait = Math.ceil(TEST_GAP_MS / 1000);
      return c.json({ error: `Wait ${wait} seconds between install checks of one site.` }, 429, { 'retry-after': String(wait) });
    }
    const out = await checkInstall(site.domain, site.id);
    await c.env.DB.prepare('UPDATE cron_state SET value = ?1 WHERE key = ?2')
      .bind(JSON.stringify({ ok: out.ok, found: out.found }), `verify:${site.id}`)
      .run();
    return c.json({ ...out, site: site.id, at: now }, 200, { 'cache-control': 'private, no-store' });
  });
}
