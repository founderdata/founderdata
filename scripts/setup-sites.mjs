#!/usr/bin/env node
// Creates or updates the sites listed in a JSON file on a FounderData deployment, matched by domain (or, for an iOS app
// without a website, by app_bundle_id), so it is safe to run again. Sets each site's currency, timezone, bundle id,
// write cap and payment webhook secrets, then prints its id, script tag, webhook URLs and what is still missing.
//
//   node scripts/setup-sites.mjs https://founderdata.example.com --dry-run      # show what it would do
//   node scripts/setup-sites.mjs https://founderdata.example.com                # reads ./sites.json
//   node scripts/setup-sites.mjs https://founderdata.example.com --config path/to/sites.json
//   node scripts/setup-sites.mjs https://founderdata.example.com --replace-secrets   # overwrite secrets already set
//
// The admin password comes from ADMIN_PASSWORD or, when that is unset, from ~/.config/founderdata/admin-password
// (where scripts/setup.mjs saves it). sites.example.json shows the format: either a JSON array of sites, or
// `{ "defaults": { ... }, "sites": [ ... ] }`, where each site takes the defaults it does not set itself. A website has
// a domain, an iOS app has an app_bundle_id (or bundle_id), and a product with both has both. A site without
// app_bundle_id keeps whatever bundle id it has, so one set by hand later is never cleared.
//
// The dashboard API never shows a secret back, so a secret that is already set stays as it is unless you pass
// --replace-secrets (after rotating it in Stripe, say). sites.json holds secrets: it is gitignored, keep it that way.
//
// Gumroad signs nothing, so its ping URL carries a random token. A site with `gumroad_seller_id` (or `"gumroad": true`,
// when the seller id should come from the first sale) gets that token on the first run, and the script prints the
// ping URL to paste into Gumroad. A site that has one keeps it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ name: string, domain?: string, currency?: string, timezone?: string, app_bundle_id?: string | null,
 *   bundle_id?: string, write_cap?: number | 'auto' | 'off' | null, gumroad_seller_id?: string,
 *   stripe_webhook_secret?: string, dodo_webhook_secret?: string, revenuecat_auth?: string,
 *   lemonsqueezy_secret?: string, polar_secret?: string, paddle_secret?: string, gumroad?: boolean,
 *   errors_on?: boolean, maps_on?: boolean, map_sample?: number, surveys?: Record<string, unknown> | null }} SiteSpec
 */

/** Webhook secrets: write-only in the API (it answers with •••• when one is set). */
export const SECRETS = ['stripe_webhook_secret', 'dodo_webhook_secret', 'revenuecat_auth', 'lemonsqueezy_secret', 'polar_secret', 'paddle_secret'];
const SETTINGS = ['name', 'timezone', 'currency', 'app_bundle_id', 'gumroad_seller_id'];
/** Pro's capture switches (docs/GUIDE.md "Setting up several sites at once"): sent as PATCH /api/sites/:id takes them. */
export const CAPTURE = ['errors_on', 'maps_on', 'map_sample', 'surveys'];
const KNOWN = new Set([...SETTINGS, ...SECRETS, ...CAPTURE, 'domain', 'bundle_id', 'write_cap', 'gumroad']);

/** Payment providers: the secret that turns each on, its name and its webhook URL key in urlsFor. */
const PROVIDERS = [
  { key: 'stripe_webhook_secret', name: 'Stripe', url: 'stripeWebhook', where: 'Stripe, Developers, Webhooks, Add endpoint' },
  { key: 'dodo_webhook_secret', name: 'Dodo Payments', url: 'dodoWebhook', where: 'Dodo Payments, Developer, Webhooks' },
  { key: 'revenuecat_auth', name: 'RevenueCat', url: 'revenuecatWebhook', where: 'RevenueCat, Integrations, Webhooks' },
  { key: 'lemonsqueezy_secret', name: 'Lemon Squeezy', url: 'lemonsqueezyWebhook', where: 'Lemon Squeezy, Settings, Webhooks' },
  { key: 'polar_secret', name: 'Polar', url: 'polarWebhook', where: 'Polar, Settings, Webhooks' },
  { key: 'paddle_secret', name: 'Paddle', url: 'paddleWebhook', where: 'Paddle, Developer tools, Notifications' },
];
const PROVIDER_IDS = { stripe_webhook_secret: 'stripe', dodo_webhook_secret: 'dodo', revenuecat_auth: 'revenuecat', lemonsqueezy_secret: 'lemonsqueezy', polar_secret: 'polar', paddle_secret: 'paddle' };

/** An app without a website has a placeholder domain under .invalid (POST /api/sites makes it). */
export const isAppOnly = (site) => typeof site.domain === 'string' && site.domain.endsWith('.invalid');

/** The write_cap of a sites.json entry as PATCH fields: a number of rows, "auto" (or null), or "off". */
export function capFields(cap) {
  if (cap === undefined) return {};
  if (cap === 'off' || cap === false) return { write_cap_on: false };
  if (cap === 'auto' || cap === null) return { write_cap_on: true, write_cap: null };
  return { write_cap_on: true, write_cap: Number(cap) };
}

/** A surveys entry as the server stores it (on as 1 or 0), to compare with the site's. */
const surveysOf = (v) =>
  v === null ? null : Object.fromEntries(Object.entries(v).filter(([, x]) => x).map(([k, x]) => [k, { ...x, on: x.on ? 1 : 0 }]));

/** The capture switches of a sites.json entry that differ from the site's, as PATCH fields. */
export function captureFields(want, site = {}) {
  const out = {};
  for (const k of ['errors_on', 'maps_on']) {
    if (want[k] !== undefined && (want[k] ? 1 : 0) !== (site[k] ?? 0)) out[k] = !!want[k];
  }
  if (want.map_sample !== undefined && Number(want.map_sample) !== (site.map_sample ?? 100)) out.map_sample = Number(want.map_sample);
  if (want.surveys !== undefined) {
    let cur = null;
    try {
      cur = site.surveys ? JSON.parse(site.surveys) : null;
    } catch {}
    if (JSON.stringify(surveysOf(want.surveys)) !== JSON.stringify(cur)) out.surveys = want.surveys;
  }
  return out;
}

const capChanged = (site, cap) => {
  const f = capFields(cap);
  if (!('write_cap_on' in f)) return false;
  if (!f.write_cap_on) return site.write_cap_on !== 0;
  return site.write_cap_on === 0 || (site.write_cap ?? null) !== f.write_cap;
};

/**
 * The site list of a parsed sites file, each site with the defaults it does not set itself, and `bundle_id` read as
 * `app_bundle_id`. Takes an array of sites, or `{ defaults, sites }`.
 */
export function applyDefaults(config) {
  const list = Array.isArray(config) ? config : config?.sites;
  const defaults = Array.isArray(config) ? {} : (config?.defaults ?? {});
  if (!Array.isArray(list)) return list;
  return list.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const { bundle_id, ...rest } = s;
    const merged = { ...defaults, ...rest };
    // A default never gives a site a domain, a name or an app.
    for (const k of ['name', 'domain', 'app_bundle_id']) if (!(k in rest)) delete merged[k];
    if (bundle_id && !merged.app_bundle_id) merged.app_bundle_id = bundle_id;
    return merged;
  });
}

/**
 * @param {{ base: string, password: string, sites: SiteSpec[], dryRun?: boolean, replaceSecrets?: boolean, fetch?: typeof fetch }} opts
 * @returns {Promise<{ site: any, action: 'created' | 'updated' | 'unchanged' | 'would create' | 'would update' | 'failed',
 *   changed: string[], kept: string[], missing: string[], error?: string, urls: ReturnType<typeof urlsFor> }[]>}
 */
export async function setupSites({ base, password, sites, dryRun = false, replaceSecrets = false, fetch: f = fetch }) {
  const origin = base.replace(/\/+$/, '');
  let cookie = '';
  const call = async (path, method = 'GET', json) => {
    const res = await f(origin + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${body.error ?? ''}`.trim());
    return body;
  };

  await call('/api/auth/login', 'POST', { password });
  const existing = await call('/api/sites');
  const results = [];
  for (const raw of applyDefaults(sites)) {
    const want = { ...raw, timezone: raw.timezone ?? 'UTC', currency: String(raw.currency ?? 'USD').toUpperCase() };
    const fields = {};
    for (const k of SETTINGS) if (want[k] !== undefined && want[k] !== null && want[k] !== '') fields[k] = want[k];
    // A website by its domain; an app by its bundle id, which also finds an app that now gets its website.
    let site =
      (want.domain && existing.find((s) => s.domain === want.domain)) ||
      (want.app_bundle_id && existing.find((s) => s.app_bundle_id === want.app_bundle_id && (!want.domain || isAppOnly(s))));
    if (site && want.domain && site.domain !== want.domain) fields.domain = want.domain;
    const secrets = SECRETS.filter((k) => typeof want[k] === 'string' && want[k].trim());
    // Gumroad needs its ping URL's token, which only the server makes (gumroad_new_token).
    const gumroad = !!want.gumroad_seller_id || want.gumroad === true;
    try {
      if (!site) {
        const capture = captureFields(want);
        const changed = [...Object.keys(fields), ...(want.write_cap !== undefined ? ['write_cap'] : []), ...Object.keys(capture), ...secrets, ...(gumroad ? ['gumroad_token'] : [])];
        const body = {
          ...fields,
          ...capFields(want.write_cap),
          ...capture,
          ...Object.fromEntries(secrets.map((k) => [k, want[k]])),
          ...(gumroad ? { gumroad_new_token: true } : {}),
        };
        if (dryRun) {
          const preview = { id: '(new)', domain: want.domain ?? null, ...fields, ...Object.fromEntries(secrets.map((k) => [k, '••••••••'])) };
          results.push({ site: preview, action: 'would create', changed, kept: [], gumroad });
          continue;
        }
        site = await call('/api/sites', 'POST', { domain: want.domain, ...fields });
        site = await call(`/api/sites/${site.id}`, 'PATCH', body);
        existing.push(site);
        results.push({ site, action: 'created', changed, kept: [], gumroad });
        continue;
      }
      const changed = Object.keys(fields).filter((k) => site[k] !== fields[k]);
      if (capChanged(site, want.write_cap)) changed.push('write_cap');
      const capture = captureFields(want, site);
      changed.push(...Object.keys(capture));
      const send = secrets.filter((k) => replaceSecrets || !site[k]);
      const kept = secrets.filter((k) => !send.includes(k));
      changed.push(...send);
      // A ping URL that exists stays: a new token would turn off the one already pasted into Gumroad.
      const newToken = gumroad && !site.gumroad_token;
      if (newToken) changed.push('gumroad_token');
      const body = {
        ...Object.fromEntries(changed.filter((k) => k in fields).map((k) => [k, fields[k]])),
        ...(changed.includes('write_cap') ? capFields(want.write_cap) : {}),
        ...capture,
        ...Object.fromEntries(send.map((k) => [k, want[k]])),
        ...(newToken ? { gumroad_new_token: true } : {}),
      };
      if (!changed.length) results.push({ site, action: 'unchanged', changed, kept, gumroad });
      else if (dryRun) results.push({ site, action: 'would update', changed, kept, gumroad });
      else results.push({ site: await call(`/api/sites/${site.id}`, 'PATCH', body), action: 'updated', changed, kept, gumroad });
    } catch (e) {
      // One bad entry (a mistyped secret) does not stop the others.
      results.push({ site: site ?? { id: '(new)', domain: want.domain ?? null, ...fields }, action: 'failed', changed: [], kept: [], error: e.message, gumroad });
    }
  }
  const out = [];
  for (const r of results) {
    // The time of the last payment per provider, so "missing" can say which webhook has sent nothing yet.
    let last = null;
    if (r.site.id !== '(new)' && r.action !== 'failed') last = (await call(`/api/sites/${r.site.id}`).catch(() => null))?.last_payments ?? null;
    const urls = urlsFor(origin, r.site);
    out.push({ ...r, urls, missing: missingFor(r.site, last, urls, r.gumroad) });
  }
  return out;
}

export function urlsFor(origin, site) {
  return {
    scriptTag: `<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`,
    stripeWebhook: `${origin}/api/webhooks/stripe/${site.id}`,
    appleWebhook: `${origin}/api/webhooks/apple/${site.id}`,
    appEvents: `${origin}/api/app/events`,
    dodoWebhook: `${origin}/api/webhooks/dodo/${site.id}`,
    revenuecatWebhook: `${origin}/api/webhooks/revenuecat/${site.id}`,
    lemonsqueezyWebhook: `${origin}/api/webhooks/lemonsqueezy/${site.id}`,
    polarWebhook: `${origin}/api/webhooks/polar/${site.id}`,
    paddleWebhook: `${origin}/api/webhooks/paddle/${site.id}`,
    gumroadPing: site.gumroad_token ? `${origin}/api/webhooks/gumroad/${site.id}/${site.gumroad_token}` : null,
  };
}

/** The shell loop that subscribes the ping URL to Gumroad's refunds and cancellations too. */
export const gumroadSubscribe = (pingUrl) =>
  `for r in sale refund cancellation subscription_ended; do curl -X PUT https://api.gumroad.com/v2/resource_subscriptions -d access_token=YOUR_TOKEN -d resource_name=$r -d post_url=${pingUrl}; done`;

/**
 * What a site still needs before its revenue shows up, one line each. `last` is GET /api/sites/:id's
 * `last_payments` (null for a site not created yet): a provider with a secret but no payment yet has a webhook
 * URL still to paste. `wantsGumroad`: the sites.json entry turns Gumroad on.
 */
export function missingFor(site, last, urls, wantsGumroad = false) {
  const out = [];
  const on = PROVIDERS.filter((p) => site[p.key]);
  const gumroad = !!(site.gumroad_seller_id || site.gumroad_token || wantsGumroad);
  const app = !!site.app_bundle_id;
  if (!on.length && !gumroad && !app) {
    out.push(`no payment provider: add stripe_webhook_secret (or ${SECRETS.slice(1).join(', ')}, gumroad_seller_id) to its entry, or send payments to /api/v1/payments`);
  }
  if (gumroad && !urls.gumroadPing) out.push('Gumroad: no ping URL yet. Run the script without --dry-run to make one');
  if (last) {
    for (const p of on) {
      if (!last[PROVIDER_IDS[p.key]]) out.push(`${p.name}: no event received yet. Add ${urls[p.url]} in ${p.where}`);
    }
    if (gumroad && !last.gumroad && urls.gumroadPing) {
      out.push(`Gumroad: no sale ping yet. Set ${urls.gumroadPing} as the ping URL in Gumroad, Settings, Advanced, and subscribe it to refunds (see "Gumroad refunds" above)`);
    }
    if (app && !last.app_store && !last.revenuecat) {
      out.push(`App Store: no notification yet. Set ${urls.appleWebhook} as the App Store Server Notifications URL in App Store Connect`);
    }
  }
  return out;
}

/** Reads and checks a sites file: a JSON array of SiteSpec, or `{ "defaults": {...}, "sites": [...] }`. */
export function readSites(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const sites = applyDefaults(config);
  if (!Array.isArray(sites) || !sites.length) throw new Error(`${path} must hold a non-empty JSON array of sites, or { "defaults": {...}, "sites": [...] }.`);
  for (const entry of [...(Array.isArray(config) ? config : config.sites), ...(Array.isArray(config) ? [] : [config.defaults ?? {}])]) {
    for (const k of Object.keys(entry ?? {})) {
      if (!KNOWN.has(k) && !k.startsWith('_')) throw new Error(`${path}: "${k}" is not a setting this script knows. It knows ${[...KNOWN].join(', ')}.`);
    }
  }
  for (const s of sites) {
    if (!s || typeof s.name !== 'string' || (typeof s.domain !== 'string' && typeof s.app_bundle_id !== 'string')) {
      throw new Error(`${path}: every site needs a name, and a domain, an app_bundle_id or both.`);
    }
    const cap = s.write_cap;
    if (cap !== undefined && cap !== null && cap !== 'auto' && cap !== 'off' && cap !== false && !(Number.isInteger(cap) && cap > 0)) {
      throw new Error(`${path}: ${s.name}: write_cap is a whole number of rows, "auto" or "off".`);
    }
    for (const k of ['errors_on', 'maps_on']) {
      if (s[k] !== undefined && typeof s[k] !== 'boolean') throw new Error(`${path}: ${s.name}: ${k} is true or false.`);
    }
    if (s.map_sample !== undefined && !(Number.isInteger(s.map_sample) && s.map_sample >= 1 && s.map_sample <= 100)) {
      throw new Error(`${path}: ${s.name}: map_sample is a whole percent from 1 to 100.`);
    }
    if (s.surveys !== undefined && s.surveys !== null && (typeof s.surveys !== 'object' || Array.isArray(s.surveys))) {
      throw new Error(`${path}: ${s.name}: surveys is an object with heard_about and cancel_reason, each { "on": true, "paths": ["/"] }.`);
    }
  }
  return sites;
}

function readPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    return readFileSync(join(homedir(), '.config/founderdata/admin-password'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const configAt = args.indexOf('--config');
  const configPath = configAt >= 0 ? args[configAt + 1] : 'sites.json';
  const base = args.find((a, i) => !a.startsWith('--') && (configAt < 0 || i !== configAt + 1)) ?? process.env.FOUNDERDATA_URL;
  const password = readPassword();
  if (!base || !password || !configPath) {
    console.error('Usage: node scripts/setup-sites.mjs https://founderdata.example.com [--config sites.json] [--dry-run] [--replace-secrets]');
    console.error('The admin password comes from ADMIN_PASSWORD or ~/.config/founderdata/admin-password.');
    process.exit(1);
  }
  const sites = readSites(configPath);
  const results = await setupSites({ base, password, sites, dryRun: args.includes('--dry-run'), replaceSecrets: args.includes('--replace-secrets') });
  let failed = 0;
  for (const { site, action, changed, kept, missing, error, urls } of results) {
    const web = site.domain && !isAppOnly(site);
    console.log(`\n${site.name} (${web ? site.domain : 'iOS app'}): ${action}${changed.length ? ` [${changed.join(', ')}]` : ''}`);
    if (error) {
      failed++;
      console.log(`  error           ${error}`);
      continue;
    }
    console.log(`  site id         ${site.id}`);
    console.log(`  currency        ${site.currency}, timezone ${site.timezone}`);
    console.log(`  app bundle id   ${site.app_bundle_id ?? '(none)'}`);
    if (site.write_cap_on !== undefined) {
      console.log(`  write cap       ${site.write_cap_on === 0 ? 'off' : site.write_cap ? `${site.write_cap} rows a day` : 'automatic (shared pool)'}`);
    }
    if (web) console.log(`  script tag      ${urls.scriptTag}`);
    console.log(`  Stripe webhook  ${urls.stripeWebhook}`);
    for (const p of PROVIDERS.slice(1)) if (site[p.key]) console.log(`  ${`${p.name} webhook`.padEnd(15)} ${urls[p.url]}`);
    if (urls.gumroadPing) {
      console.log(`  Gumroad ping    ${urls.gumroadPing}`);
      console.log(`  Gumroad refunds ${gumroadSubscribe(urls.gumroadPing)}`);
    }
    if (site.app_bundle_id) {
      console.log(`  Apple webhook   ${urls.appleWebhook}`);
      console.log(`  app events      ${urls.appEvents}`);
    }
    if (kept.length) console.log(`  kept            ${kept.join(', ')} (already set; --replace-secrets overwrites)`);
    for (const m of missing) console.log(`  missing         ${m}`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
