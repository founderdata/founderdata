// Fills the LOCAL database with 60 days of fake data for three demo sites, so every part of the dashboard has
// something to show:
// - ShipKit (demo0001): a SaaS website paid through Dodo Payments and Stripe, with named customers and renewals, and
//   Stripe subscriptions on monthly and annual plans (an upgrade, cancellations, failed payments).
// - Habitly (demo0002): an iOS app with onboarding, paywalls, App Store trials and purchases on weekly and yearly plans,
//   Apple Search Ads installs, consented installs (retention) and Apple's sales report (App Store tab).
// - Indie Notes (demo0003): a small blog that stopped sending visits 4 days ago, so Home shows a quiet site.
// - Tabsaver (demo0004): a Chrome extension (product type extension): install, active and uninstall events.
// - Indie Weekly (demo0005): a newsletter (product type newsletter): subscribe, unsubscribe and open events.
// ShipKit also gets an SEO snapshot (docs/SEO.md): 60 days of Search Console rows with three decaying pages, keyword
// targets, an SEO plan, a ship log and an AI answer panel, so the SEO tab shows every card.
// Right now: 17 visitors online in 14 countries (plus any the 60 days above leave there), with payments, a trial and a signup in the last hour, so the
// live globe (GET /api/live) has something to show; every visit in a known city carries coarse coordinates.
// The rows look like the ones the Worker writes: src/worker/collect.ts (web), app.ts (app), appstore.ts (App Store
// purchases and trials), stripe.ts and payments.ts (web payments), ascsales.ts (Apple's report), subscriptions.ts
// (one row per subscription, the Subscriptions tab), seo.ts (SEO snapshot parts, stored as text).
// Usage: npm run seed (runs this, then loads .wrangler/seed.sql into the local DB binding)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const DAY = 86_400_000;
const now = Date.now();
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo));
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(rand() * 16).toString(16));
const json = (o) => (o ? JSON.stringify(o) : null);
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
// Subscription details (plans, cancellations, failed payments) draw from their own sequence, so the visits and
// payments above them stay the same as before subscriptions were seeded.
let subSeed = 7;
const subRand = () => ((subSeed = (subSeed * 16807) % 2147483647) - 1) / 2147483646;
const PERIOD = { week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };
const PER_MONTH = { week: 52 / 12, month: 1, year: 1 / 12 };
/** One subscriptions row, its status from its times like statusOf() in src/worker/subscriptions.ts. */
function insertSub(r) {
  const status = r.ended_at
    ? 'expired'
    : r.billing_issue_at && r.billing_issue_at > (r.renewed_at ?? 0)
      ? 'past_due'
      : r.canceled_at
        ? 'canceled'
        : r.paid_at
          ? 'active'
          : 'trialing';
  const mrr = r.amount ? Math.round(r.amount * PER_MONTH[r.interval]) : null;
  insert('subscriptions', {
    site_id: r.site_id, id: r.id, provider: r.provider, customer_id: r.customer_id, visitor_id: r.visitor_id, session_id: r.session_id,
    channel: r.channel ?? null, source: r.source ?? null, source_domain: r.source_domain ?? null, campaign: r.campaign ?? null, product: r.product,
    status, currency: 'USD', amount: r.amount, interval: r.interval, interval_count: 1, mrr, first_mrr: r.paid_at ? (r.first_mrr ?? mrr) : null,
    mrr_changed_at: r.mrr_changed_at ?? null, trial_start: r.trial_start ?? null, trial_end: r.trial_end ?? null, started_at: r.trial_start ?? r.paid_at,
    paid_at: r.paid_at ?? null, renewed_at: r.renewed_at ?? null, expires_at: r.expires_at, canceled_at: r.canceled_at ?? null, ended_at: r.ended_at ?? null,
    billing_issue_at: r.billing_issue_at ?? null, sandbox: 0, updated_at: Math.min(now, r.updated_at ?? now), rev: 1,
  });
}

const out = [];
// Round 7 (plan 5.1): statements that must run after every row is in, such as a site switch on the sites row the
// flush writes (sites.exp_live, sites.surveys, maps_on, errors_on). Each lane's block below pushes into it.
const late = [];
// Rows wait here per table and column list, and leave as multi-row INSERTs of up to ~90 KB (D1 takes 100 KB per
// statement). Some 1,500 statements load in seconds; one statement per row took minutes.
const rowsByTarget = new Map();
/**
 * Coarse coordinates of the demo cities, one decimal like the Worker stores them (collect.ts coarseCoord), so the live
 * globe (GET /api/live) has points. A session in a city not listed keeps lat and lon null, as an old visit would.
 */
const CITY_COORDS = {
  'San Francisco': [37.8, -122.4], 'New York': [40.7, -74], London: [51.5, -0.1], Bengaluru: [13, 77.6], Mumbai: [19.1, 72.9],
  Berlin: [52.5, 13.4], Paris: [48.9, 2.4], Toronto: [43.7, -79.4], Singapore: [1.3, 103.8], Madrid: [40.4, -3.7],
  'São Paulo': [-23.6, -46.6], Amsterdam: [52.4, 4.9], Tokyo: [35.7, 139.7], Sydney: [-33.9, 151.2], Austin: [30.3, -97.7],
  'Mexico City': [19.4, -99.1], Seoul: [37.6, 127], Stockholm: [59.3, 18.1],
};
/** One row; the keys are the column names. */
const insert = (table, row) => {
  if (table === 'sessions' && !('lat' in row)) {
    const at = CITY_COORDS[row.city] ?? [null, null];
    row = { ...row, lat: at[0], lon: at[1] };
  }
  const target = `${table} (${Object.keys(row).join(', ')})`;
  if (!rowsByTarget.has(target)) rowsByTarget.set(target, []);
  rowsByTarget.get(target).push(`(${Object.values(row).map(q).join(', ')})`);
};
function flushInserts() {
  for (const [target, rows] of rowsByTarget) {
    let chunk = [];
    let size = 0;
    const flush = () => chunk.length && out.push(`INSERT INTO ${target} VALUES ${chunk.join(', ')};`);
    for (const r of rows) {
      if (size + r.length > 90_000) {
        flush();
        chunk = [];
        size = 0;
      }
      chunk.push(r);
      size += r.length + 2;
    }
    flush();
  }
}
/** A session's events, as rows of the events table. */
const insertEvents = (siteId, sid, vid, events) => {
  for (const e of events) insert('events', { site_id: siteId, session_id: sid, visitor_id: vid, ts: e.ts, type: e.type, name: e.name ?? null, path: e.path ?? null, props: json(e.props) });
};

const SITE_IDS = ['demo0001', 'demo0002', 'demo0003', 'demo0004', 'demo0005'];
const ids = SITE_IDS.map(q).join(', ');
for (const table of ['events', 'sessions', 'visitors', 'payments', 'payment_claims', 'funnels', 'subscription_signals', 'subscriptions', 'stripe_objects', 'seo_snapshots', 'site_usage', 'asc_sales', 'notes', 'aso_keywords', 'aso_settings', 'aso_snapshots', 'aso_reviews', 'alert_rules', 'replays']) {
  out.push(`DELETE FROM ${table} WHERE site_id IN (${ids});`);
}
out.push(`DELETE FROM sites WHERE id IN (${ids});`);
// Rows without a site id: the demo's rules for all sites and its scoped API keys.
out.push(`DELETE FROM alert_rules WHERE id LIKE 'ar_demo_%';`);
out.push(`DELETE FROM api_keys WHERE id LIKE 'demo_%';`);

const COUNTRIES = [['US', 'California', 'San Francisco'], ['US', 'New York', 'New York'], ['GB', 'England', 'London'], ['IN', 'Karnataka', 'Bengaluru'], ['IN', 'Maharashtra', 'Mumbai'], ['DE', 'Berlin', 'Berlin'], ['FR', 'Île-de-France', 'Paris'], ['CA', 'Ontario', 'Toronto'], ['SG', 'Singapore', 'Singapore'], ['ES', 'Madrid', 'Madrid'], ['BR', 'São Paulo', 'São Paulo'], ['NL', 'North Holland', 'Amsterdam']];
const FIRST = ['Vlad', 'Jordan', 'Ricardo', 'Mia', 'Jack', 'Aisha', 'Lucas', 'Priya', 'Noah', 'Emma', 'Ravi', 'Sofia', 'Liam', 'Chloe', 'Tomás', 'Hana', 'Oliver', 'Zara', 'Mateo', 'Ines'];
const LAST = ['Petrov', 'Lee', 'Alves', 'Schmidt', 'Turner', 'Khan', 'Martin', 'Sharma', 'Kim', 'Rossi', 'Patel', 'Garcia', 'Chen', 'Dubois', 'Novak', 'Okafor'];
const person = () => {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  return { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com` };
};

// ---------- 1. ShipKit: a SaaS website (src/worker/collect.ts writes these rows)

const shipkit = 'demo0001';
const SOURCES = [
  [{ source: 'X', channel: 'Organic Social', referrer: 't.co', domain: 't.co' }, 28],
  [{ source: 'Direct/None', channel: 'Direct', referrer: null, domain: null }, 22],
  [{ source: 'Google', channel: 'Organic Search', referrer: 'www.google.com', domain: 'google.com' }, 14],
  [{ source: 'Indie Hackers', channel: 'Referral', referrer: 'www.indiehackers.com', domain: 'indiehackers.com' }, 9],
  [{ source: 'Reddit', channel: 'Organic Social', referrer: 'www.reddit.com/r/SaaS', domain: 'reddit.com' }, 6],
  [{ source: 'YouTube', channel: 'Organic Social', referrer: 'www.youtube.com', domain: 'youtube.com' }, 4],
  [{ source: 'ChatGPT', channel: 'AI', referrer: 'chatgpt.com', domain: 'chatgpt.com' }, 4],
  [{ source: 'LinkedIn', channel: 'Organic Social', referrer: 'www.linkedin.com', domain: 'linkedin.com' }, 3],
  [{ source: 'Medium', channel: 'Referral', referrer: 'medium.com/@you/how-i-built', domain: 'medium.com' }, 3],
  [{ source: 'Product Hunt', channel: 'Referral', referrer: 'www.producthunt.com', domain: 'producthunt.com' }, 3],
  [{ source: 'Threads', channel: 'Organic Social', referrer: 'www.threads.net', domain: 'threads.net' }, 2],
  [{ source: 'Perplexity', channel: 'AI', referrer: 'www.perplexity.ai', domain: 'perplexity.ai' }, 1],
];
// Google visits land on the blog posts Search Console ranks, the three decaying ones included (SEO snapshot below).
const SEARCH_ENTRIES = ['/blog/seo-for-saas', '/blog/seo-for-saas', '/blog/how-to-get-first-customers', '/blog/how-to-get-first-customers', '/', '/blog/saas-landing-page-checklist', '/blog/stripe-vs-paddle-for-indie-saas', '/blog/nextjs-saas-boilerplate'];
const CAMPAIGNS = { X: ['launch-tweet', 'build-in-public-thread', 'revenue-screenshot'], Medium: ['how-i-built-article'], LinkedIn: ['founder-post'] };
const PAGES = ['/', '/', '/', '/pricing', '/blog/seo-for-saas', '/blog/how-to-get-first-customers', '/features', '/docs', '/changelog', '/about'];
const DEVICES = [[['Chrome', 'Mac OS', 'Desktop'], 40], [['Safari', 'Mac OS', 'Desktop'], 12], [['Mobile Safari', 'iOS', 'Mobile'], 18], [['Chrome', 'Windows', 'Desktop'], 14], [['Chrome', 'Android', 'Mobile'], 8], [['Firefox', 'Linux', 'Desktop'], 4], [['Edge', 'Windows', 'Desktop'], 3], [['Twitter', 'iOS', 'Mobile'], 3]];
// Dodo sells lifetime licenses; Stripe sells the plans: monthly ones renew every 30 days, annual ones cost 10 months.
const LICENSES = [4900, 9900, 9900, 16900, 29900];
const PLANS = [['shipkit_starter_monthly', 1900], ['shipkit_pro_monthly', 4900]];

insert('sites', {
  id: shipkit, name: 'ShipKit', domain: 'shipkit.example.com', timezone: 'UTC', currency: 'USD', api_key: 'rt_demo_key',
  dodo_webhook_secret: 'whsec_demo_dodo', stripe_webhook_secret: 'whsec_demo_stripe', created_at: now - 75 * DAY,
  // Its primary goal is the account signup, so the Content tab can sort entry pages by signups.
  primary_goal: 'signup', primary_goal_label: 'Signups',
});
insert('funnels', { id: 'fun00001', site_id: shipkit, name: 'Landing → Checkout', steps: JSON.stringify([{ type: 'page', value: '/' }, { type: 'page', value: '/pricing' }, { type: 'goal', value: 'checkout_click' }]), created_at: now });

let payN = 0;
let stripeN = 0;
for (let d = 59; d >= 0; d--) {
  const spike = d === 9 ? 3.2 : d === 24 ? 1.8 : 1;
  const growth = 1 - d / 150; // traffic grew about 40% over the two months
  const sessionsToday = Math.round((120 + rand() * 90 + Math.sin(d / 2) * 40) * spike * growth);
  for (let i = 0; i < sessionsToday; i++) {
    const start = now - d * DAY - Math.floor(rand() * DAY);
    if (start > now) continue;
    const src = weighted(SOURCES);
    const s = d === 9 && rand() < 0.6 ? SOURCES[0][0] : src;
    const vid = uuid(), sid = uuid();
    const [country, region, city] = pick(COUNTRIES);
    const [browser, os, device] = weighted(DEVICES);
    const camp = CAMPAIGNS[s.source] && rand() < 0.7 ? pick(CAMPAIGNS[s.source]) : null;
    const entry = s.source === 'Google' ? pick(SEARCH_ENTRIES) : s.source === 'Medium' ? '/blog/how-to-get-first-customers' : pick(PAGES.slice(0, 5));
    const bounce = rand() < 0.62;
    const pages = [entry];
    if (!bounce) for (let k = 0, n = 1 + Math.floor(rand() * 4); k < n; k++) pages.push(pick(PAGES));
    const wantsToBuy = !bounce && rand() < (s.channel === 'Direct' ? 0.05 : s.source === 'X' ? 0.045 : 0.03);
    if (wantsToBuy && !pages.includes('/pricing')) pages.push('/pricing');
    const duration = bounce ? Math.floor(rand() * 25_000) : Math.floor(20_000 + rand() * 300_000);
    let t = start;
    const events = [];
    for (const p of pages) {
      events.push({ ts: t, type: 'pageview', path: p });
      // The pricing page is the website's paywall (docs/APP-EVENTS.md section 5), so the Drop-off view sees it.
      if (p === '/pricing' && !events.some((e) => e.name === 'paywall_view')) events.push({ ts: t + 500, type: 'goal', name: 'paywall_view', path: p, props: { source: 'pricing' } });
      t += Math.floor(duration / pages.length);
    }
    // Signup: flow_start when the form opens, then an account (identify) or a validation error.
    let who = null;
    if (!bounce && rand() < 0.25) {
      events.push({ ts: t, type: 'goal', name: 'signup_click', path: pages.at(-1) }, { ts: t + 300, type: 'goal', name: 'flow_start', path: pages.at(-1), props: { flow: 'signup' } });
      if (chance(0.06)) events.push({ ts: t + 9000, type: 'goal', name: 'email_invalid', path: pages.at(-1), props: { reason: 'typo', step: 'account' } });
      else if (chance(0.55)) {
        who = person();
        events.push({ ts: t + 8000, type: 'goal', name: 'signup', path: pages.at(-1) });
      }
    }
    const plan = wantsToBuy && chance(0.35) ? pick(PLANS) : null;
    if (wantsToBuy) {
      events.push(
        { ts: t + 1000, type: 'goal', name: 'checkout_click', path: '/pricing' },
        { ts: t + 1100, type: 'goal', name: 'purchase_start', path: '/pricing', props: { source: 'pricing', product: plan ? plan[0] : 'shipkit_license' } },
        { ts: t + 2000, type: 'outbound', name: plan ? 'https://checkout.stripe.com/c/pay/cs_live_demo' : 'https://checkout.dodopayments.com/buy/pdt_pro', path: '/pricing' },
      );
    } else if (!bounce && rand() < 0.1) events.push({ ts: t, type: 'outbound', name: pick(['https://github.com/shipkit', 'https://x.com/shipkit', 'https://discord.gg/shipkit']), path: pages.at(-1) });

    const paid = wantsToBuy && rand() < 0.75;
    if (wantsToBuy && !paid && chance(0.4)) events.push({ ts: t + 60_000, type: 'goal', name: 'checkout_error', path: '/pricing', props: { reason: pick(['card_declined', 'card_declined', '3ds_failed']), step: 'payment' } });
    if (paid) who ??= person();
    const goals = events.filter((e) => e.type === 'goal').length;
    const last = Math.min(now, Math.max(...events.map((e) => e.ts)) + 5000);

    insert('visitors', {
      site_id: shipkit, id: vid, first_seen: start - (paid && rand() < 0.5 ? Math.floor(rand() * 10 * DAY) : 0),
      user_id: who ? `usr_${vid.slice(0, 8)}` : null, name: who?.name ?? null, email: who?.email ?? null,
    });
    insert('sessions', {
      site_id: shipkit, id: sid, visitor_id: vid, started_at: start, last_seen_at: last, duration, pageviews: pages.length, goals,
      hostname: 'shipkit.example.com', entry_page: entry, exit_page: pages.at(-1), referrer: s.referrer, referrer_domain: s.domain,
      source: s.source, channel: s.channel, utm_source: camp ? s.source.toLowerCase() : null, utm_medium: camp ? 'social' : null, utm_campaign: camp,
      country, region, city, browser, os, device,
    });
    insertEvents(shipkit, sid, vid, events);
    if (!paid) continue;

    const ts = Math.min(t + 60_000, now - 1000);
    const buyer = { site_id: shipkit, kind: 'payment', currency: 'USD', visitor_id: vid, session_id: sid, email: who.email, name: who.name };
    if (!plan) {
      // Dodo: checkout metadata names the visitor; a few are linked by the return page or the checkout click time instead.
      insert('payments', { ...buyer, id: `pay_demo_${++payN}`, provider: 'dodo', ts, amount: pick(LICENSES), customer_id: `cus_${payN}`, matched_by: weighted([['metadata', 80], ['return_page', 15], ['timing', 5]]) });
      continue;
    }
    // Stripe: a subscription. Its renewals are credited to the session of the first payment.
    const n = ++stripeN;
    const annual = subRand() < 0.25;
    const interval = annual ? 'year' : 'month';
    const product = annual ? plan[0].replace('_monthly', '_annual') : plan[0];
    const sub = { ...buyer, provider: 'stripe', amount: annual ? plan[1] * 10 : plan[1], customer_id: `cus_demo_${n}`, subscription_id: `sub_demo_${n}`, product, matched_by: 'metadata' };
    insert('payments', { ...sub, id: `pi_demo_${n}`, ts, renewal: 0 });
    // A starter plan now and then moves up to pro at its first renewal.
    const upgrade = !annual && plan[1] === 1900 && subRand() < 0.3;
    // Two of them had their latest renewal fail: no payment, past due since.
    const failsAt = !annual && [2, 9].includes(n % 11) ? Math.floor((now - ts) / (30 * DAY)) : 0;
    let renewed = ts, amount = sub.amount, changedAt = null, endedAt = null, failedAt = null;
    for (let m = 1; !annual && ts + m * 30 * DAY < now; m++) {
      if (chance(0.12)) {
        endedAt = ts + m * 30 * DAY; // cancelled: it ran out at the end of the period paid for
        break;
      }
      if (m === failsAt) {
        failedAt = ts + m * 30 * DAY;
        break;
      }
      if (upgrade && m === 1) [amount, changedAt] = [4900, ts + 30 * DAY];
      renewed = ts + m * 30 * DAY;
      insert('payments', { ...sub, id: `pi_demo_${n}_r${m}`, ts: renewed, renewal: 1, amount, product: upgrade && m >= 1 ? 'shipkit_pro_monthly' : product });
    }
    // One refund, a week after the payment (stripe.ts stores it as a negative row).
    if (n === 3) insert('payments', { ...sub, id: 're_demo_1', ts: Math.min(ts + 7 * DAY, now - 1000), amount: -plan[1], kind: 'refund' });
    // Its row in subscriptions: cancelled ones turned auto-renew off some days before the end, and a few running ones
    // will not renew.
    const expires = renewed + PERIOD[interval];
    const canceledAt = endedAt ? endedAt - Math.floor(subRand() * 20 * DAY) : !failedAt && subRand() < 0.1 ? Math.min(now - DAY, renewed + 3 * DAY) : null;
    insertSub({
      site_id: shipkit, id: sub.subscription_id, provider: 'stripe', customer_id: sub.customer_id, visitor_id: vid, session_id: sid,
      channel: s.channel, source: s.source, source_domain: s.domain, campaign: camp, product: upgrade && changedAt ? 'shipkit_pro_monthly' : product,
      amount, interval, first_mrr: Math.round(sub.amount * PER_MONTH[interval]), mrr_changed_at: changedAt, paid_at: ts, renewed_at: renewed,
      expires_at: expires, canceled_at: canceledAt, ended_at: endedAt, billing_issue_at: failedAt, updated_at: endedAt ?? failedAt ?? renewed,
    });
  }
}
// A Dodo payment that no visitor matches: the dashboard shows it as "not linked".
const stray = person();
insert('payments', { id: 'pay_demo_unlinked', site_id: shipkit, provider: 'dodo', ts: now - 2 * DAY, amount: 9900, kind: 'payment', currency: 'USD', customer_id: 'cus_unlinked', email: stray.email, name: stray.name });
// Visits from AI assistants beyond the two in SOURCES, and the buyers some of them sent, so the AI channel has revenue
// and the Content tab's AI card has a row per assistant. Own random sequence: the rows above stay the same.
{
  let s = 23;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const at = (list) => list[Math.floor(r() * list.length)];
  const id = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(r() * 16).toString(16));
  const buyer = () => {
    const name = `${at(FIRST)} ${at(LAST)}`;
    return { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com` };
  };
  const AI = {
    ChatGPT: { referrer: 'chatgpt.com', domain: 'chatgpt.com' },
    Claude: { referrer: 'claude.ai', domain: 'claude.ai' },
    Perplexity: { referrer: 'www.perplexity.ai', domain: 'perplexity.ai' },
    Gemini: { referrer: 'gemini.google.com', domain: 'gemini.google.com' },
    Copilot: { referrer: 'copilot.microsoft.com', domain: 'copilot.microsoft.com' },
  };
  const LANDINGS = ['/blog/how-to-get-first-customers', '/blog/saas-pricing-page-examples', '/', '/pricing', '/vs/launchfast', '/docs/stripe-integration', '/blog/stripe-vs-paddle-for-indie-saas'];
  // [assistant, visits over the 60 days, buyers among them]
  const PLAN = [['Claude', 70, 2], ['Gemini', 34, 1], ['Copilot', 16, 0], ['ChatGPT', 0, 3], ['Perplexity', 0, 1]];
  let n = 0;
  for (const [name, visits, buyers] of PLAN) {
    for (let i = 0; i < Math.max(visits, buyers); i++) {
      const buys = i < buyers;
      // Buyers in the last 28 days, so the default 30-day view shows their revenue.
      const start = buys ? now - (2 + Math.floor(r() * 26)) * DAY - Math.floor(r() * DAY) : now - Math.floor(r() * 59 * DAY) - Math.floor(r() * DAY);
      const vid = id(), sid = id();
      const entry = buys ? at(['/blog/how-to-get-first-customers', '/pricing', '/vs/launchfast']) : at(LANDINGS);
      const pages = buys ? [entry, '/pricing'].filter((p, k, a) => a.indexOf(p) === k) : r() < 0.6 ? [entry] : [entry, at(LANDINGS)];
      const [country, region, city] = at(COUNTRIES);
      const who = buys ? buyer() : null;
      const duration = pages.length === 1 ? Math.floor(r() * 25_000) : 40_000 + Math.floor(r() * 200_000);
      const events = pages.map((p, k) => ({ ts: start + k * Math.floor(duration / pages.length), type: 'pageview', path: p }));
      if (buys) events.push({ ts: start + duration, type: 'goal', name: 'checkout_click', path: '/pricing' });
      insert('visitors', { site_id: shipkit, id: vid, first_seen: start, user_id: who ? `usr_${vid.slice(0, 8)}` : null, name: who?.name ?? null, email: who?.email ?? null });
      insert('sessions', {
        site_id: shipkit, id: sid, visitor_id: vid, started_at: start, last_seen_at: start + duration, duration, pageviews: pages.length, goals: buys ? 1 : 0,
        hostname: 'shipkit.example.com', entry_page: entry, exit_page: pages.at(-1), referrer: AI[name].referrer, referrer_domain: AI[name].domain,
        source: name, channel: 'AI', country, region, city, browser: 'Chrome', os: 'Mac OS', device: 'Desktop',
      });
      insertEvents(shipkit, sid, vid, events);
      if (buys) {
        insert('payments', {
          id: `pay_demo_ai_${++n}`, site_id: shipkit, provider: 'dodo', ts: Math.min(now - 1000, start + duration + 60_000), amount: [9900, 16900, 9900, 29900][n % 4],
          kind: 'payment', currency: 'USD', visitor_id: vid, session_id: sid, customer_id: `cus_ai_${n}`, email: who.email, name: who.name, matched_by: 'metadata',
        });
      }
    }
  }
}
// A few people online right now
for (let i = 0; i < 3; i++) {
  const vid = uuid(), sid = uuid();
  insert('visitors', { site_id: shipkit, id: vid, first_seen: now - 60_000 });
  insert('sessions', {
    site_id: shipkit, id: sid, visitor_id: vid, started_at: now - 90_000, last_seen_at: now - 20_000, duration: 60000, pageviews: 2, goals: 0,
    hostname: 'shipkit.example.com', entry_page: '/', exit_page: '/pricing', referrer_domain: 't.co', source: 'X', channel: 'Organic Social',
    country: 'US', browser: 'Chrome', os: 'Mac OS', device: 'Desktop',
  });
}

// ---------- 2. Habitly: an iOS app (src/worker/app.ts writes the sessions and events, appstore.ts the purchases)

const habitly = 'demo0002';
const BUNDLE = 'com.example.habitly';
const APP_HOST = `ios:${BUNDLE}`;
const PRODUCTS = {
  weekly: { id: 'habitly.pro.weekly', title: 'Habitly Pro Weekly', price: 299, type: 'IAY' },
  yearly: { id: 'habitly.pro.yearly', title: 'Habitly Pro Yearly', price: 3999, type: 'IAY' }, // starts with a 7-day free trial
  lifetime: { id: 'habitly.pro.lifetime', title: 'Habitly Pro Lifetime', price: 7999, type: 'IA1' },
};
// Where installs come from. App Store search and browse send no referrer, so they are Direct. Search Ads installs are
// resolved from the AdServices token (src/worker/adservices.ts): campaign, keyword and ad group ids.
const APP_SOURCES = [
  [{ source: 'Direct/None', channel: 'Direct' }, 52],
  [{ source: 'Apple Search Ads', channel: 'Paid', ads: true }, 24],
  [{ source: 'TikTok', channel: 'Organic Social', utm_source: 'tiktok', utm_medium: 'social', utm_campaign: 'morning-routine' }, 11],
  [{ source: 'Instagram', channel: 'Organic Social', utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'streak-reels' }, 6],
  [{ source: 'Newsletter', channel: 'Email', utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'october-issue' }, 4],
  [{ source: 'Reddit', channel: 'Organic Social', ref: 'reddit' }, 3],
];
const ADS = [
  { campaign: '1874320551', adGroup: '1874350001', keywords: ['1874400101', '1874400102', '1874400103'] }, // brand
  { campaign: '1874320552', adGroup: '1874350002', keywords: ['1874400201', '1874400202'] }, // "habit tracker"
];
const OS = [['iOS 26.1', 46], ['iOS 26.0', 18], ['iOS 18.6', 24], ['iOS 18.5', 8], ['iOS 17.7', 4]];
/** The version a new install gets on day d. 2.4.0 (13 days ago) shortened the reminders step. */
const versionOn = (d) => (d >= 30 ? '2.3.0 (118)' : d >= 13 ? '2.3.1 (121)' : d >= 2 || chance(0.3) ? '2.4.0 (124)' : '2.4.1 (127)');

insert('sites', {
  id: habitly, name: 'Habitly', domain: 'habitly.invalid', timezone: 'UTC', currency: 'USD', api_key: 'rt_demo_key_habitly',
  app_bundle_id: BUNDLE, asc_app_id: '6450000000', asc_sku: 'habitly', created_at: now - 70 * DAY,
});
insert('funnels', { id: 'fun00002', site_id: habitly, name: 'Onboarding → Purchase', steps: JSON.stringify([{ type: 'page', value: '/Onboarding/Welcome' }, { type: 'page', value: '/Onboarding/Paywall' }, { type: 'goal', value: 'purchase_start' }]), created_at: now });

let txN = 0;
const appPayments = []; // also feed Apple's sales report below
const installsByDay = new Map();

/** One app session: its screens and goals as the SDK sends them, written like ingestApp writes them. */
function appSession(install, start, props, build) {
  const sid = uuid();
  const events = [];
  let t = start;
  let screen = null;
  const show = (name) => {
    screen = '/' + name; // screenPath()
    events.push({ ts: t, type: 'pageview', path: screen });
    t += between(2000, 25_000);
  };
  const goal = (name, p) => {
    events.push({ ts: t, type: 'goal', name, path: screen, props: p });
    t += between(300, 4000);
  };
  const result = build({ show, goal, at: () => t, sid }) ?? {};
  const pageviews = events.filter((e) => e.type === 'pageview');
  insert('sessions', {
    site_id: habitly, id: sid, visitor_id: install.vid, started_at: start, last_seen_at: t, duration: t - start, pageviews: pageviews.length,
    goals: events.length - pageviews.length, hostname: APP_HOST, entry_page: pageviews[0]?.path ?? null, exit_page: pageviews.at(-1)?.path ?? null,
    source: install.src.source, channel: install.src.channel, utm_source: install.src.utm_source ?? null, utm_medium: install.src.utm_medium ?? null,
    utm_campaign: install.ad?.campaign ?? install.src.utm_campaign ?? null, utm_term: install.ad?.keyword ?? null, utm_content: install.ad?.adGroup ?? null,
    ref: install.src.ref ?? null, country: install.geo[0], region: install.geo[1], city: install.geo[2], browser: 'App', os: install.os,
    device: install.device, app_version: install.version, props: json(props),
  });
  insertEvents(habitly, sid, install.vid, events);
  return { sid, ...result };
}

/**
 * A verified App Store purchase (appstore.ts recordAppleTransaction). The weekly plan renews every 7 days. A yearly
 * plan after its trial keeps the trial's transaction id as its original one, like StoreKit.
 */
function appStorePurchase(install, sid, ts, product, matchedBy = 'app_event', trial = null) {
  const original = trial?.tx ?? String(2000000700000000 + ++txN);
  const row = {
    site_id: habitly, provider: 'app_store', amount: product.price, kind: 'payment', currency: 'USD', visitor_id: install.vid, session_id: sid,
    matched_by: matchedBy, customer_id: `apple:${original}`, subscription_id: original, product: product.id,
  };
  insert('payments', { ...row, id: `apple_${original}`, ts, renewal: 0 });
  appPayments.push({ ts, product });
  if (product === PRODUCTS.lifetime) return;
  const interval = product === PRODUCTS.weekly ? 'week' : 'year';
  let renewed = ts, endedAt = null;
  for (let m = 1; interval === 'week' && ts + m * 7 * DAY < now; m++) {
    if (subRand() < 0.1) {
      endedAt = ts + m * 7 * DAY; // auto-renew was off: EXPIRED at the end of the week paid for
      break;
    }
    const tx = String(2000000700000000 + ++txN);
    renewed = ts + m * 7 * DAY;
    insert('payments', { ...row, id: `apple_${tx}`, ts: renewed, renewal: 1, matched_by: 'app_account_token' });
    appPayments.push({ ts: renewed, product });
  }
  const canceledAt = endedAt ? endedAt - Math.floor(subRand() * 6 * DAY) : subRand() < (interval === 'year' ? 0.15 : 0.05) ? Math.min(now - 3_600_000, renewed + 2 * DAY) : null;
  insertSub({
    site_id: habitly, id: original, provider: 'app_store', customer_id: `apple:${original}`, visitor_id: install.vid, session_id: trial?.sid ?? sid,
    ...appSource(install), product: product.id, amount: product.price, interval, paid_at: ts, renewed_at: renewed,
    trial_start: trial?.ts ?? null, trial_end: trial ? ts : null, expires_at: renewed + PERIOD[interval], canceled_at: canceledAt, ended_at: endedAt,
    updated_at: endedAt ?? canceledAt ?? renewed,
  });
}

/** The credited visit's source, as subscriptions keep it. */
const appSource = (install) => ({ channel: install.src.channel, source: install.src.source, campaign: install.ad?.campaign ?? install.src.utm_campaign ?? null });

/** The paywall: what the user does after paywall_view. Returns the plan the install ends up on. */
function paywall(install, s, source, variant) {
  s.goal('paywall_view', { source, paywall: variant ?? 'default' });
  const wantsYearly = variant === 'weekly_first' ? chance(0.4) : chance(0.75);
  const product = source === 'onboarding' && chance(0.08) ? PRODUCTS.lifetime : wantsYearly ? PRODUCTS.yearly : PRODUCTS.weekly;
  if (!chance(source === 'onboarding' ? 0.15 : 0.1)) return null;
  s.goal('purchase_start', { source, product: product.id });
  const outcome = weighted([['bought', 62], ['cancelled', 28], ['failed', 6], ['pending', 4]]);
  if (outcome !== 'bought') {
    const reason = outcome === 'failed' ? { reason: pick(['network', 'network', 'store', 'verification']) } : {};
    s.goal(`purchase_${outcome}`, { source, product: product.id, ...reason });
    return null;
  }
  const ts = s.at() + 15_000;
  if (product !== PRODUCTS.yearly) {
    appStorePurchase(install, s.sid, ts, product);
    return { plan: 'pro', until: product === PRODUCTS.lifetime ? Infinity : ts + 7 * DAY };
  }
  // The yearly plan starts with a free trial: a trial_start signal now, the first charge 7 days later (DID_RENEW).
  const tx = String(2000000700000000 + ++txN);
  insert('subscription_signals', { site_id: habitly, id: `apple_trial_${tx}`, provider: 'app_store', ts, type: 'trial_start', visitor_id: install.vid, session_id: s.sid, product: product.id, store: 'APP_STORE', sandbox: 0 });
  const converts = ts + 7 * DAY < now && chance(0.58);
  if (converts) appStorePurchase(install, s.sid, ts + 7 * DAY, product, 'app_account_token', { tx, ts, sid: s.sid });
  else {
    // A trial that did not convert (auto-renew turned off, it expired at its end), or one still running.
    const over = ts + 7 * DAY < now;
    insertSub({
      site_id: habitly, id: tx, provider: 'app_store', customer_id: `apple:${tx}`, visitor_id: install.vid, session_id: s.sid, ...appSource(install),
      product: product.id, amount: product.price, interval: 'year', trial_start: ts, trial_end: ts + 7 * DAY, expires_at: ts + 7 * DAY,
      canceled_at: over || subRand() < 0.35 ? Math.min(now - 60_000, ts + Math.floor(subRand() * 6 * DAY)) : null, ended_at: over ? ts + 7 * DAY : null,
      updated_at: over ? ts + 7 * DAY : ts,
    });
  }
  return { plan: 'trial', until: ts + 7 * DAY, then: converts ? 'pro' : 'free' };
}

/** The first launch: onboarding, its paywall, and the first habit. */
function firstLaunch(install, start, d) {
  const variant = d <= 20 ? (chance(0.5) ? 'annual_first' : 'weekly_first') : null; // the paywall experiment started 20 days ago
  const props = { user_state: 'new', plan: 'free', build_channel: chance(0.01) ? 'testflight' : 'appstore', ...(variant && { exp_paywall: variant }) };
  const newer = install.version.startsWith('2.4');
  return appSession(install, start, props, (s) => {
    // The user leaves during onboarding (flow_exit), so the session has no outcome.
    const exit = (step) => {
      s.goal('flow_exit', { step });
      return {};
    };
    s.show('Onboarding/Welcome');
    s.goal('flow_start');
    s.goal('onboarding_welcome', { index: '1' });
    if (!chance(0.84)) return exit('welcome');
    s.show('Onboarding/Goal');
    s.goal('onboarding_goal', { index: '2' });
    if (!chance(newer ? 0.88 : 0.72)) {
      if (chance(0.35)) {
        s.goal('onboarding_skip', { step: 'goal' });
        s.show('Today');
        return {};
      }
      return exit('goal');
    }
    s.show('Onboarding/Reminders');
    s.goal('onboarding_reminders', { index: '3' });
    s.goal('permission_notifications_prompt');
    s.goal('permission_notifications', { result: chance(0.62) ? 'granted' : 'denied' });
    if (!chance(0.92)) return exit('reminders');
    s.show('Onboarding/Paywall');
    s.goal('onboarding_paywall', { index: '4' });
    const bought = paywall(install, s, 'onboarding', variant);
    if (!bought && !chance(0.9)) return exit('paywall');
    s.goal('onboarding_complete');
    s.show('Today');
    if (chance(0.7)) {
      s.show('Habits/New');
      s.goal('habit_created');
      s.goal('activation', { what: 'first_habit' });
      s.show('Today');
      if (chance(0.6)) s.goal('habit_checked');
    }
    return { completed: true, entitlement: bought };
  });
}

/** A later launch: check off habits, sometimes hit the Stats paywall or open Settings. */
function laterLaunch(install, start) {
  const e = install.entitlement;
  const plan = !e ? 'free' : start < e.until ? e.plan : e.then ?? (e.until === Infinity ? 'pro' : 'free');
  const props = { user_state: 'returning', plan, build_channel: 'appstore' };
  return appSession(install, start, props, (s) => {
    s.show('Today');
    for (let k = between(0, 4); k > 0; k--) s.goal('habit_checked');
    if (chance(0.3)) {
      s.show('Stats');
      if (plan === 'free') {
        const bought = paywall(install, s, 'gate_stats', null);
        if (bought) install.entitlement = bought;
      }
    }
    if (chance(0.15)) {
      s.show('Habits/New');
      s.goal('habit_created');
    }
    if (chance(0.08)) {
      s.show('Settings');
      if (chance(0.15)) {
        s.goal('restore_start', { source: 'settings' });
        if (chance(0.6)) s.goal('restore_success', { source: 'settings' });
      }
    }
  });
}

for (let d = 59; d >= 0; d--) {
  // About 45 installs a day; the Search Ads campaign ran 5 to 12 days ago.
  const ads = d >= 5 && d <= 12;
  const installs = Math.round((38 + rand() * 18 + Math.sin(d / 3) * 6) * (ads ? 1.5 : 1) * (1.15 - d / 200));
  installsByDay.set(day(now - d * DAY), installs);
  for (let i = 0; i < installs; i++) {
    const start = now - d * DAY - Math.floor(rand() * DAY);
    if (start > now) continue;
    const src = ads && chance(0.35) ? APP_SOURCES[1][0] : weighted(APP_SOURCES);
    const campaign = src.ads ? pick(ADS) : null;
    const install = {
      vid: uuid(),
      src,
      ad: campaign && { campaign: campaign.campaign, adGroup: campaign.adGroup, keyword: pick(campaign.keywords) },
      geo: src.ads ? COUNTRIES[between(0, 2)] : pick(COUNTRIES),
      os: weighted(OS),
      device: chance(0.06) ? 'Tablet' : 'Mobile',
      version: versionOn(d),
      // Consent (FounderData.setConsent(true)): the install id is kept, so later launches come back under it.
      persistent: chance(0.55) ? 1 : 0,
    };
    insert('visitors', { site_id: habitly, id: install.vid, first_seen: start, persistent: install.persistent });
    const first = firstLaunch(install, start, d);
    install.entitlement = first.entitlement ?? null;
    // Later launches. Without consent each launch has a new install id, so it shows up as another visitor.
    for (let k = 1; k <= 30; k++) {
      const p = (first.completed ? 0.4 : 0.1) * (k === 1 ? 1 : k <= 7 ? 0.55 : 0.25);
      const at = start + k * DAY + between(-4, 4) * 3_600_000;
      if (at >= now || !chance(p)) continue;
      let launch = install;
      if (!install.persistent) {
        // The SDK sends the AdServices token on the first launch only, so a new install id's launch is not from the ad.
        launch = { ...install, vid: uuid(), ...(install.ad && { ad: null, src: APP_SOURCES[0][0] }) };
        insert('visitors', { site_id: habitly, id: launch.vid, first_seen: at, persistent: 0 });
      }
      laterLaunch(launch, at);
      if (launch !== install) install.entitlement = launch.entitlement;
    }
  }
}
// Two people in the app right now
for (let i = 0; i < 2; i++) {
  const install = { vid: uuid(), src: APP_SOURCES[0][0], geo: COUNTRIES[2 + i], os: 'iOS 26.1', device: 'Mobile', version: '2.4.1 (127)', persistent: 1 };
  insert('visitors', { site_id: habitly, id: install.vid, first_seen: now - 2 * 60_000, persistent: 1 });
  appSession(install, now - 2 * 60_000, { user_state: 'new', plan: 'free', build_channel: 'appstore' }, (s) => {
    s.show('Onboarding/Welcome');
    s.goal('onboarding_welcome', { index: '1' });
    s.show('Onboarding/Goal');
  });
}

// Apple's Sales and Trends report (pro/worker/ascsales.ts), imported for every day up to 2 days ago (Apple's lag).
// Downloads are a bit above the installs FounderData saw (not everyone opens the app); in-app purchases are the App
// Store payments above plus some from installs the SDK never linked.
const sold = new Map();
for (const p of appPayments) {
  const key = `${day(p.ts)}|${p.product.id}`;
  sold.set(key, (sold.get(key) ?? 0) + 1);
}
for (let d = 59; d >= 2; d--) {
  const date = day(now - d * DAY);
  const rows = [];
  const row = (kind, productType, sku, title, units, price) => {
    if (!units) return;
    rows.push({
      report_date: date, row_key: `${productType}|${sku}|${Math.sign(units)}`, site_id: habitly, apple_id: kind === 'iap' ? null : '6450000000',
      parent_identifier: kind === 'iap' ? 'habitly' : null, sku, title, product_type: productType, kind, units,
      proceeds: Math.round(price * 0.85) / 100, proceeds_currency: 'USD', customer_price: price / 100, customer_currency: 'USD', country: 'US', device: 'iPhone',
    });
  };
  const installs = installsByDay.get(date) ?? 0;
  row('download', '1', 'habitly', 'Habitly', Math.round(installs * (1.08 + rand() * 0.1)), 0);
  row('redownload', '3', 'habitly', 'Habitly', Math.round(installs * 0.08 * rand()), 0);
  if (d === 30 || d === 13 || d === 2) row('update', '7', 'habitly', 'Habitly', between(300, 500), 0);
  for (const product of Object.values(PRODUCTS)) {
    const units = (sold.get(`${date}|${product.id}`) ?? 0) + (chance(0.3) ? 1 : 0);
    row('iap', product.type, product.id, product.title, units, product.price);
  }
  if (d === 20) row('iap', 'IAY', PRODUCTS.yearly.id, PRODUCTS.yearly.title, -1, PRODUCTS.yearly.price); // a refund
  for (const r of rows) insert('asc_sales', r);
  // A table keyed by day for every site, so this replaces instead of deleting first.
  out.push(`INSERT OR REPLACE INTO asc_import_days (report_date, status, rows, imported_at) VALUES (${q(date)}, 'ok', ${rows.length}, ${now - (d - 1) * DAY});`);
}

// ---------- Apple Search Ads import for Habitly (pro/worker/asa.ts): names and Apple's daily numbers for the ADS ids
// above, so the App tab shows spend, CPA and ROAS: 60 days up to yesterday. Apple's installs are about 1.2 times the
// ones FounderData saw: 24% of a day's installs came from the ads, 51% while the push ran (5 to 12 days ago), split evenly
// over the keywords. No rand() here, so the rows after this block stay the same.
{
  const ORG = '40012345';
  const ASA_NAMES = [
    ['app', '6450000000', 'Habitly', BUNDLE],
    ['campaign', ADS[0].campaign, 'Brand, US and UK', '6450000000'],
    ['campaign', ADS[1].campaign, 'Habit tracker, generic', '6450000000'],
    ['adgroup', ADS[0].adGroup, 'Brand exact', ADS[0].campaign],
    ['adgroup', ADS[1].adGroup, 'Category exact', ADS[1].campaign],
    ['keyword', '1874400101', 'habitly', ADS[0].adGroup],
    ['keyword', '1874400102', 'habitly app', ADS[0].adGroup],
    ['keyword', '1874400103', 'habitly habit tracker', ADS[0].adGroup],
    ['keyword', '1874400201', 'habit tracker', ADS[1].adGroup],
    ['keyword', '1874400202', 'daily habit app', ADS[1].adGroup],
  ];
  // The demo's Apple Ads rows have no site_id: clear them by id, so the seed can run again on the same database.
  out.push(`DELETE FROM asa_names WHERE id IN (${ASA_NAMES.map(([, id]) => q(id)).join(', ')});`);
  out.push(`DELETE FROM asa_daily WHERE campaign IN (${ADS.map((a) => q(a.campaign)).join(', ')});`);
  for (const [kind, id, name, parent] of ASA_NAMES) insert('asa_names', { kind, id, name, parent, org: kind === 'app' ? null : ORG });
  // Per campaign: cost per tap in USD, tap-through rate, installs per tap.
  const ECON = { [ADS[0].campaign]: { cpt: 0.42, ttr: 0.14, conv: 0.62 }, [ADS[1].campaign]: { cpt: 1.35, ttr: 0.055, conv: 0.48 } };
  for (let d = 59; d >= 1; d--) {
    const date = day(now - d * DAY);
    const asaInstalls = (installsByDay.get(date) ?? 0) * (d >= 5 && d <= 12 ? 0.35 + 0.65 * 0.24 : 0.24);
    for (const [c, ad] of ADS.entries()) {
      const e = ECON[ad.campaign];
      const camp = { taps: 0, installs: 0, impressions: 0, spend: 0 };
      for (const [k, keyword] of ad.keywords.entries()) {
        const wobble = 0.8 + (((d * 31 + c * 17 + k * 7) % 9) / 20);
        const installs = Math.max(1, Math.round((asaInstalls / ADS.length / ad.keywords.length) * 1.2 * wobble));
        const taps = Math.round(installs / e.conv);
        const impressions = Math.round(taps / e.ttr);
        const spend = Math.round(taps * e.cpt * (0.9 + k * 0.08) * 1e6);
        insert('asa_daily', { day: date, campaign: ad.campaign, keyword, adgroup: ad.adGroup, spend, currency: 'USD', taps, installs, impressions });
        camp.taps += taps;
        camp.installs += installs;
        camp.impressions += impressions;
        camp.spend += spend;
      }
      insert('asa_daily', { day: date, campaign: ad.campaign, keyword: '', adgroup: '', ...camp, currency: 'USD' });
    }
  }
}

// ---------- 3. Indie Notes: a small blog with no revenue that went quiet 4 days ago

const blog = 'demo0003';
const BLOG_SOURCES = [
  [{ source: 'Google', channel: 'Organic Search', referrer: 'www.google.com', domain: 'google.com' }, 50],
  [{ source: 'Direct/None', channel: 'Direct', referrer: null, domain: null }, 20],
  [{ source: 'Hacker News', channel: 'Organic Social', referrer: 'news.ycombinator.com', domain: 'news.ycombinator.com' }, 12],
  [{ source: 'Bing', channel: 'Organic Search', referrer: 'www.bing.com', domain: 'bing.com' }, 6],
  [{ source: 'ChatGPT', channel: 'AI', referrer: 'chatgpt.com', domain: 'chatgpt.com' }, 6],
  [{ source: 'Newsletter', channel: 'Email', referrer: null, domain: null }, 6],
];
const POSTS = ['/', '/posts/pricing-a-side-project', '/posts/my-first-1000-dollars', '/posts/cold-email-that-worked', '/posts/self-hosting-on-a-budget', '/about'];
// Its primary goal is the newsletter signup (migration 0030, docs/GUIDE.md "Primary goal"): Home shows it as "Signups".
insert('sites', { id: blog, name: 'Indie Notes', domain: 'indienotes.example.com', timezone: 'UTC', currency: 'USD', api_key: 'rt_demo_key_blog', created_at: now - 90 * DAY, primary_goal: 'newsletter_signup', primary_goal_label: 'Signups' });
let blogVisits = 0;
for (let d = 59; d >= 4; d--) {
  for (let i = 0, n = between(25, 45); i < n; i++) {
    const start = now - d * DAY - Math.floor(rand() * DAY);
    const s = weighted(BLOG_SOURCES);
    const vid = uuid(), sid = uuid();
    const [country, region, city] = pick(COUNTRIES);
    const [browser, os, device] = weighted(DEVICES);
    const pages = [pick(POSTS.slice(0, 5))];
    if (chance(0.3)) pages.push(pick(POSTS));
    const events = pages.map((p, k) => ({ ts: start + k * 40_000, type: 'pageview', path: p }));
    // Every 20th visit signs up for the newsletter: Home shows it as the site's primary goal. The draw stays, so the
    // random numbers after it are the same as before.
    chance(0.05);
    if (++blogVisits % 20 === 0) events.push({ ts: start + pages.length * 40_000, type: 'goal', name: 'newsletter_signup', path: pages.at(-1) });
    insert('visitors', { site_id: blog, id: vid, first_seen: start });
    insert('sessions', {
      site_id: blog, id: sid, visitor_id: vid, started_at: start, last_seen_at: events.at(-1).ts, duration: events.at(-1).ts - start, pageviews: pages.length,
      goals: events.length - pages.length, hostname: 'indienotes.example.com', entry_page: pages[0], exit_page: pages.at(-1), referrer: s.referrer,
      referrer_domain: s.domain, source: s.source, channel: s.channel, utm_source: s.source === 'Newsletter' ? 'newsletter' : null,
      utm_medium: s.source === 'Newsletter' ? 'email' : null, country, region, city, browser, os, device,
    });
    insertEvents(blog, sid, vid, events);
  }
}

// Chart notes (docs/GUIDE.md "Chart notes"): launches, a price change and a guide rewrite on ShipKit; app versions, an
// onboarding release and new screenshots on Habitly. Some carry annotations the way an agent logs them (actor, kind,
// target, before and after; docs/API.md "POST /api/v1/notes"), and two are already reviewed, so the change list,
// the verdicts and the due list have something to show.
const noteAt = (d, hour) => now - d * DAY - (now % DAY) + hour * 3_600_000;
const NOTES = [
  ['demo0001', 9, 14, 'Launch thread on X', 'manual', { actor: 'founder', change_kind: 'launch' }],
  ['demo0001', 24, 9, 'Posted on Indie Hackers', 'manual', { actor: 'founder', change_kind: 'launch' }],
  ['demo0001', 17, 11, 'Pro plan from $79 to $99', 'api', { actor: 'pricing-agent', change_kind: 'pricing', target: '/pricing', before_text: '$79 a month', after_text: '$99 a month', reviewed_at: noteAt(9, 12), review_outcome: 'kept', review_comment: 'Revenue per visitor held, so the higher price stays.' }],
  [habitly, 30, 8, 'App version 2.3.0 (118)', 'version', { change_kind: 'release' }],
  [habitly, 13, 8, 'App version 2.3.1 (121)', 'version', { change_kind: 'release' }],
  [habitly, 2, 8, 'App version 2.4.0 (124)', 'version', { change_kind: 'release' }],
  ['demo0001', 36, 15, 'Launched on Product Hunt', 'manual', { actor: 'founder', change_kind: 'launch' }],
  ['demo0001', 45, 10, 'Rewrote the "SEO for SaaS" guide', 'manual', { actor: 'seo-agent', change_kind: 'seo', target: '/blog/seo-for-saas', before_text: '1,400 words, 2023 examples', after_text: '2,600 words, 2026 examples' }],
  [habitly, 20, 9, 'Onboarding v2 live', 'api', { actor: 'founder', change_kind: 'release', before_text: '5 onboarding screens', after_text: '3 screens, paywall last' }],
  [habitly, 8, 10, 'New App Store screenshots', 'manual', { actor: 'aso-agent', change_kind: 'aso', target: 'keyword:habit tracker', before_text: 'Feature list screenshots', after_text: 'Streak screenshots with captions' }],
  ['demo0001', 11, 10, 'Refreshed "Stripe vs Paddle" for 2026 fees', 'api', { actor: 'seo-agent', change_kind: 'seo', target: '/blog/stripe-vs-paddle-for-indie-saas', before_text: '2024 fee table', after_text: '2026 fee table, new FAQ' }],
  ['demo0001', 5, 16, 'New hero headline on the home page', 'api', { actor: 'landing-agent', change_kind: 'copy', target: '/', before_text: 'Ship your SaaS faster', after_text: 'Launch a paid SaaS this weekend' }],
  ['demo0001', 3, 9, 'Paused the Reddit ads', 'manual', { actor: 'founder', change_kind: 'ads', before_text: '$20 a day', after_text: 'Paused' }],
  ['demo0001', 2, 11, 'Shorter pricing FAQ, 9 questions to 5', 'api', { actor: 'copy-agent', change_kind: 'copy', target: '/pricing', before_text: '9 questions', after_text: '5 questions' }],
];
NOTES.forEach(([site, d, hour, text, kind, extra], i) => insert('notes', { id: `note_demo_${i + 1}`, site_id: site, ts: noteAt(d, hour), text, kind, created_at: noteAt(d, hour), ...extra }));

// A threshold alert rule on ShipKit (docs/API.md "Alert rules"): it fired 12 days ago, after the Indie Hackers post
// faded (the webhook's first try got a 503), went back over its line since, and got a test send yesterday.
insert('alert_rules', {
  id: 'ar_demo_rpv', site_id: 'demo0001', name: 'Revenue per visitor falls 15% in 7 days', metric: 'revenue_per_visitor', path: null,
  comparison: 'falls_pct', threshold: 15, win: '7d', min_volume: 50, webhook_url: 'https://agent.example.com/hooks/founderdata',
  secret: 'whsec_demo_not_a_real_secret_0000', channels: 0, push: 0, enabled: 1, crossed: '[]',
  deliveries: JSON.stringify([
    { id: 'dlv_demo_test', at: noteAt(1, 16), kind: 'test', to: 'webhook', ok: true, code: 200, attempts: 1 },
    { id: 'dlv_demo_alert', at: noteAt(12, 7), kind: 'alert', to: 'webhook', ok: true, code: 200, attempts: 2 },
  ]),
  created_at: noteAt(20, 9), updated_at: noteAt(1, 16), check_every: '1h', actor: null, change_kind: null,
});
// Round 5 rules (migration 0033): a page entering Decaying pages on ShipKit, and two rules for all sites, one for
// changes whose verdict turns worse and one for a site with no visits for 24 hours. Their dedupe state matches the
// demo, so the hourly cron doesn't fire them again on a fresh seed.
const ruleBase = { secret: null, channels: 0, push: 1, enabled: 1, check_every: '1h', actor: null, change_kind: null, path: null };
insert('alert_rules', {
  ...ruleBase, id: 'ar_demo_decay', site_id: 'demo0001', name: 'A page enters Decaying pages', metric: 'page_decay', comparison: 'falls_pct', threshold: 30,
  win: '28d', min_volume: 10, webhook_url: 'https://agent.example.com/hooks/seo', secret: 'whsec_demo_not_a_real_secret_0001',
  crossed: JSON.stringify(['/blog/seo-for-saas', '/blog/how-to-get-first-customers', '/blog/stripe-vs-paddle-for-indie-saas']),
  deliveries: JSON.stringify([
    { id: 'dlv_demo_decay1', at: noteAt(3, 8), kind: 'alert', to: 'push', ok: true, code: 200, attempts: 1, path: '/blog/stripe-vs-paddle-for-indie-saas', detail: '1 of 1 phone' },
    { id: 'dlv_demo_decay1', at: noteAt(3, 8), kind: 'alert', to: 'webhook', ok: true, code: 200, attempts: 1, path: '/blog/stripe-vs-paddle-for-indie-saas' },
  ]),
  created_at: noteAt(6, 10), updated_at: noteAt(6, 10),
});
insert('alert_rules', {
  ...ruleBase, id: 'ar_demo_worse', site_id: '*', name: 'A change turns worse', metric: 'note_verdict', comparison: 'turns_worse', threshold: 0,
  win: '7d', min_volume: 0, webhook_url: null, crossed: JSON.stringify(['note_demo_1']),
  deliveries: JSON.stringify([{ id: 'dlv_demo_worse', at: noteAt(2, 15), kind: 'alert', to: 'push', ok: true, code: 200, attempts: 1, site_id: 'demo0001', note_id: 'note_demo_1', detail: '1 of 1 phone' }]),
  created_at: noteAt(14, 9), updated_at: noteAt(14, 9),
});
insert('alert_rules', {
  ...ruleBase, id: 'ar_demo_quiet', site_id: '*', name: 'No visits for 24 hours', metric: 'visitors', comparison: 'drops_below', threshold: 1,
  win: '24h', min_volume: 0, webhook_url: null, crossed: JSON.stringify(['demo0003|*']),
  deliveries: JSON.stringify([{ id: 'dlv_demo_quiet', at: noteAt(3, 1), kind: 'alert', to: 'push', ok: true, code: 200, attempts: 1, site_id: 'demo0003', detail: '1 of 1 phone' }]),
  created_at: noteAt(30, 9), updated_at: noteAt(30, 9),
});

// Scoped API keys (docs/API.md "API keys"), one per agent that logs notes above, named after its actor so Settings,
// Agents joins each key with its changes. The secrets are random and thrown away; only their hashes are stored, as
// POST /api/v1/keys does. Usage: calls per hour over the last 24 hours, a last call and a last write.
{
  const HOUR = 3_600_000;
  const hourNow = Math.floor(now / HOUR);
  const hours = (perHour) => JSON.stringify(Array.from({ length: 24 }, (_, slot) => {
    // Slot s holds the hour h with h % 24 === s, the newest such hour up to now.
    const h = hourNow - ((hourNow - slot) % 24 + 24) % 24;
    return [h, perHour(hourNow - h)];
  }));
  const KEYS = [
    ['demo_copy', 'copy-agent', ['read', 'notes:write'], ['demo0001'], 21, 2 * HOUR, 26 * HOUR, (ago) => (ago % 3 === 0 ? 6 : 2)],
    ['demo_pricing', 'pricing-agent', ['read', 'read:revenue', 'notes:write', 'alerts:write'], ['demo0001'], 40, 25 * 60_000, 2 * HOUR, (ago) => (ago < 12 ? 9 : 4)],
    ['demo_seo', 'seo-agent', ['read', 'notes:write'], ['demo0001'], 33, 3 * HOUR, 11 * DAY, (ago) => (ago % 6 === 0 ? 14 : 0)],
    ['demo_landing', 'landing-agent', ['read', 'notes:write'], ['demo0001'], 12, 7 * HOUR, 5 * DAY, (ago) => (ago % 4 === 0 ? 3 : 0)],
    ['demo_aso', 'aso-agent', ['read', 'notes:write'], ['demo0002'], 50, 40 * 60_000, 8 * DAY, (ago) => (ago % 2 === 0 ? 5 : 1)],
  ];
  for (const [id, name, scopes, sites, made, used, wrote, perHour] of KEYS) {
    const secret = `fdk_demo_${createHash('sha256').update(`${id}${now}${Math.random()}`).digest('hex').slice(0, 24)}`;
    insert('api_keys', {
      hash: createHash('sha256').update(secret).digest('hex'), id, name, hint: secret.slice(-4), scopes: JSON.stringify(scopes),
      sites: JSON.stringify(sites), created_at: now - made * DAY, expires_at: null, last_used_at: now - used, last_write_at: now - wrote, hours: hours(perHour),
    });
  }
}


// ASO for Habitly (docs/ASO.md): 8 keywords in 3 countries, 60 days of snapshots as the collector posts them, two
// competitors, reviews, and popularity as the Apple Ads import stores it. The top 10 is in the last 2 days only.
{
  const APP_ID = '6450000000';
  const RIVALS = [['1000000002', 'Streakly'], ['1000000003', 'Daily Loop']];
  const COUNTRIES_ASO = ['us', 'de', 'gb'];
  const KEYWORDS = [
    ['habit tracker', 34, 62], ['daily habits', 12, 41], ['routine planner', 7, 28], ['streak tracker', 3, 18],
    ['morning routine', 48, 55], ['self care app', 120, 33], ['goal tracker', 61, 47], ['habit builder', 9, 22],
  ];
  const OTHERS = ['Habitica', 'Atoms', 'Productive', 'Fabulous', 'Strides', 'Way of Life', 'Loop', 'Done', 'Everyday', 'HabitKit', 'Tiny Habits', 'Rise'];
  insert('aso_settings', { site_id: habitly, countries: JSON.stringify(COUNTRIES_ASO), competitors: JSON.stringify(RIVALS.map((r) => r[0])), updated_at: now - 60 * DAY });
  KEYWORDS.forEach(([k], i) => insert('aso_keywords', { site_id: habitly, keyword: k, added_at: now - 60 * DAY + i * 1000 }));
  const rankNow = new Map();
  for (let d = 59; d >= 0; d--) {
    const ts = now - d * DAY - (now % DAY) + 6 * 3_600_000;
    for (const [ci, cc] of COUNTRIES_ASO.entries()) {
      const ranks = {};
      const top = {};
      for (const [ki, [k, start, pop]] of KEYWORDS.entries()) {
        const key = `${cc}|${k}`;
        // A slow climb with day-to-day noise of 1 or 2 places; one keyword drops out of the results for a few days.
        const base = rankNow.get(key) ?? Math.round(start * (1 + ci * 0.4));
        const next = Math.max(1, Math.round(base - (chance(0.35) ? 1 : 0) + (rand() * 4 - 2)));
        rankNow.set(key, next);
        const out = k === 'self care app' && cc === 'gb' && d >= 20 && d <= 24;
        ranks[k] = [out ? null : next, 250, Object.fromEntries(RIVALS.map(([id], ri) => [id, Math.max(1, Math.round(next * (0.4 + ri * 0.9)) + between(-2, 3))]))];
        if (d <= 1) {
          const list = [];
          for (let p = 1; p <= 10; p++) {
            if (p === next) list.push([APP_ID, 'Habitly', 'Habit tracker and routines', 2400 + ci * 300, 4.7, '2025-03-14']);
            else {
              const name = OTHERS[(p + ki) % OTHERS.length];
              const strong = pop > 40 ? 3 : 1;
              list.push([String(1100000000 + ((p * 7 + ki) % 97)), name, p % 3 ? `${k[0].toUpperCase()}${k.slice(1)} and reminders` : 'Build better days', Math.round((180_000 * strong) / (p * p) + between(50, 900)), 4.3 + (p % 5) / 10, '2019-05-01']);
            }
          }
          top[k] = list;
        }
      }
      // Rivals: each country has its own count, growth and average, as the App Store does.
      const RIVAL_RATINGS = [[[15_000, 20, 4.5], [4_600, 7, 4.3], [3_700, 5, 4.6]], [[30_000, 18, 4.6], [9_800, 9, 4.7], [6_900, 4, 4.4]]];
      const ratings = [[APP_ID, 'Habitly', 2400 + ci * 300 + (59 - d) * (6 - ci * 2), 4.7, d > 13 ? '2.3.1' : '2.4.0'], ...RIVALS.map(([id, name], ri) => {
        const [base, perDay, avg] = RIVAL_RATINGS[ri][ci];
        return [id, name, base + (59 - d) * perDay, avg, '5.1'];
      })];
      const healthy = !(cc === 'de' && d === 0);
      insert('aso_snapshots', {
        site_id: habitly, country: cc, day: day(ts), collected_at: ts, app_id: APP_ID, ranks: JSON.stringify(ranks), top: JSON.stringify(top),
        ratings: JSON.stringify(ratings), collector: 'aso-collect/1',
        sources: JSON.stringify({
          search: { ok: healthy ? 8 : 5, failed: 0, skipped: healthy ? 0 : 3, status: healthy ? 200 : 429, retryAfter: healthy ? null : 30, paused: false },
          lookup: { ok: 1, failed: 0, skipped: 0, status: 200, retryAfter: null, paused: false },
          reviews: { ok: 1, failed: 0, skipped: 0, status: 200, retryAfter: null, paused: false },
        }),
      });
    }
  }
  const REVIEWS = [
    [5, 'Finally sticking to it', 'The streak view keeps me honest. Day 41 of journaling.'],
    [4, 'Great, one wish', 'Love the reminders. Please add a widget for the lock screen.'],
    [2, 'Sync stopped', 'Since 2.4.0 my iPad doesn’t show today’s habits until I reopen the app.'],
    [5, 'Simple', 'Does one thing well, no clutter.'],
    [3, 'Paywall too early', 'Would like to try more than 3 habits before paying.'],
    [1, 'Lost my streak', 'Changed time zones on a trip and my 90-day streak reset.'],
    [5, 'Best habit app', 'Tried five others, this one stuck.'],
    [4, 'Nice design', 'Clean and calm. Stats could go deeper.'],
  ];
  for (let i = 0; i < 36; i++) {
    const [rating, title, body] = REVIEWS[i % REVIEWS.length];
    insert('aso_reviews', {
      site_id: habitly, country: COUNTRIES_ASO[i % 3], id: String(14700000000 + i), at: now - i * 1.6 * DAY - between(0, 20) * 3_600_000, rating, title, body,
      author: `${pick(FIRST)}${between(10, 99)}`, version: i < 10 ? '2.4.0' : '2.3.1',
    });
  }
  const sunday = now - ((new Date(now).getUTCDay() + 7) % 7) * DAY;
  const week = day(sunday - 7 * DAY);
  for (const cc of COUNTRIES_ASO) for (const [k, , pop] of KEYWORDS) insert('aso_popularity', { keyword: k, country: cc, week, popularity: k === 'habit builder' && cc !== 'us' ? null : Math.max(5, pop - (cc === 'us' ? 0 : 12)), popularity5: k === 'habit builder' && cc !== 'us' ? null : Math.max(1, Math.round(pop / 20)) });
  out.push(`DELETE FROM aso_popularity WHERE keyword IN (${KEYWORDS.map(([k]) => q(k)).join(', ')});`);
}

// ---------- 4. ShipKit SEO snapshot (docs/SEO.md): Search Console rows per day, keyword targets, SERP checks, an SEO
// plan, a ship log and an AI answer panel, as an outside job would push them. pro/worker/seo.ts stores each part as
// text in seo_snapshots, so the parts are written the same way (and appended in chunks, because one statement may be
// 100 KB at most). Own random sequence: the rows above stay the same with or without this block.
const seoParts = (() => {
  let s = 11;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const DAYS = 60;
  const dates = Array.from({ length: DAYS }, (_, i) => day(now - (DAYS + 1 - i) * DAY));
  const weekday = dates.map((d) => new Date(d + 'T00:00:00Z').getUTCDay());
  const season = (i) => (weekday[i] === 0 || weekday[i] === 6 ? 0.62 : 1);
  const CTR = [[1, 0.28], [2, 0.15], [3, 0.11], [4, 0.08], [5, 0.06], [6, 0.045], [7, 0.035], [8, 0.03], [9, 0.025], [10, 0.022], [15, 0.01], [20, 0.006], [40, 0.002]];
  // A smooth click-through curve by position, so a rank change moves clicks gradually.
  const curve = (pos) => {
    if (pos <= 1) return CTR[0][1];
    for (let k = 1; k < CTR.length; k++) {
      if (pos <= CTR[k][0]) {
        const [p0, c0] = CTR[k - 1];
        const [p1, c1] = CTR[k];
        return Math.exp(Math.log(c0) + ((Math.log(c1) - Math.log(c0)) * (pos - p0)) / (p1 - p0));
      }
    }
    return 0.002;
  };
  // Impressions a day (before scaling), the share of the curve a row gets, and its average position, from day 0 to day 59.
  // `decay` rows hold steady until day 24, then lose position and impressions.
  const DECAY_FROM = 24;
  const ramp = (i) => Math.max(0, (i - DECAY_FROM) / (DAYS - 1 - DECAY_FROM));
  const imps = (x, i) => (x.decay ? x.imp * (1 - 0.35 * ramp(i)) : x.imp * x.g ** (i / (DAYS - 1)));
  const posAt = (x, i) => (x.decay ? x.p0 + (x.p1 - x.p0) * ramp(i) : x.p0 + ((x.p1 - x.p0) * i) / (DAYS - 1));
  const ctrAt = (x, i) => Math.min(0.7, curve(posAt(x, i)) * (x.mul ?? 1));
  const expectedSum = (list, f) => list.reduce((a, x) => a + dates.reduce((b, _, i) => b + f(x, i) * season(i), 0), 0);
  /** One row per day with impressions: [date, key, clicks, impressions, position]. Stochastic rounding keeps small rows sparse. */
  const rows = (list, scale) => {
    const out = [];
    for (const x of list) {
      for (let i = 0; i < DAYS; i++) {
        const e = imps(x, i) * season(i) * scale;
        const imp = Math.floor(e * (0.8 + 0.4 * r()) + r());
        if (!imp) continue;
        const ex = imp * ctrAt(x, i);
        const clicks = Math.max(0, Math.min(imp, Math.round(ex + (r() - 0.5) * 2 * Math.sqrt(ex) * 0.8)));
        const pos = Math.max(1, +(posAt(x, i) + (r() - 0.5) * (imp < 4 ? 3 : 1.2)).toFixed(1));
        out.push([dates[i], x.key, clicks, imp, pos]);
      }
    }
    return out;
  };

  // key, impressions a day at the start, growth over the 60 days, position at the start and the end, click-through factor.
  const P = (key, imp, g, p0, p1, mul = 1, decay = false) => ({ key, imp, g, p0, p1, mul, decay });
  const PAGES = [
    P('/', 60, 1.6, 3.2, 2.8, 1.6), P('/pricing', 70, 1.5, 6.5, 5.8, 0.28), P('/features', 40, 1.3, 7, 6.5, 0.8), P('/docs', 30, 1.3, 5, 4.5),
    P('/docs/getting-started', 28, 1.5, 6, 5, 0.3), P('/docs/stripe-integration', 24, 1.7, 9, 7), P('/docs/deploy-to-vercel', 22, 1.5, 12, 10),
    P('/changelog', 12, 1.2, 4, 4), P('/about', 8, 1, 5, 5), P('/vs/launchfast', 30, 1.9, 9, 6), P('/templates/saas-starter', 32, 2, 14, 9),
    P('/blog/seo-for-saas', 120, 2.4, 14, 8), P('/blog/how-to-get-first-customers', 110, 2, 9, 6.5), P('/blog/saas-pricing-page-examples', 90, 1.8, 11, 8.5),
    P('/blog/launch-on-product-hunt', 70, 1.4, 7.5, 7), P('/blog/indie-hacker-tech-stack', 60, 1.7, 15, 12), P('/blog/how-to-validate-saas-idea', 55, 1.5, 12, 10),
    P('/blog/saas-metrics-for-founders', 80, 1.3, 9, 8.5, 0.45), P('/blog/mrr-vs-arr', 45, 1.6, 16, 13), P('/blog/churn-rate-benchmarks', 40, 1.8, 18, 12),
    P('/blog/build-in-public', 38, 1.2, 10, 10), P('/blog/how-to-write-a-changelog', 20, 1.3, 13, 12),
    P('/blog/saas-landing-page-checklist', 120, 1, 5.5, 9.5, 1, true), P('/blog/stripe-vs-paddle-for-indie-saas', 100, 1, 4.5, 8, 1, true), P('/blog/nextjs-saas-boilerplate', 90, 1, 6, 9.8, 1, true),
  ];
  const QUERIES = [
    P('shipkit', 60, 1.5, 1.2, 1.1, 2.2), P('shipkit pricing', 25, 1.5, 1.5, 1.3, 1.8), P('shipkit review', 12, 1.6, 3, 2.5, 1.4), P('shipkit vs launchfast', 10, 2, 2.5, 2, 1.5),
    P('shipkit docs', 10, 1.3, 1.8, 1.5, 1.8), P('shipkit alternative', 14, 2, 5, 4), P('launchfast alternative', 12, 1.9, 7, 5),
    P('seo for saas', 60, 2.6, 15, 9), P('saas seo checklist', 30, 2.2, 18, 11), P('seo for saas startups', 25, 2, 14, 8),
    P('how to get first customers for saas', 55, 2, 9, 6.5), P('first 100 customers saas', 30, 1.8, 12, 8), P('how to get first saas customers', 24, 1.9, 10, 7),
    P('saas pricing page examples', 45, 1.8, 11, 8.5), P('pricing page design saas', 26, 1.7, 14, 11), P('how to price a saas', 30, 1.4, 16, 14),
    P('launch on product hunt', 40, 1.4, 8, 7.5), P('product hunt launch checklist', 28, 1.5, 10, 8),
    P('indie hacker tech stack', 30, 1.7, 15, 12), P('best tech stack for saas 2026', 24, 1.9, 19, 14),
    P('how to validate a saas idea', 28, 1.5, 12, 10), P('saas idea validation', 20, 1.6, 15, 12),
    P('saas metrics for founders', 26, 1.3, 9, 8.5, 0.45), P('mrr vs arr', 30, 1.6, 16, 13), P('what is a good churn rate for saas', 24, 1.8, 18, 12), P('saas churn benchmarks', 18, 1.7, 20, 14),
    P('build in public saas', 18, 1.2, 10, 10),
    P('saas landing page checklist', 55, 1, 5.5, 9.5, 1, true), P('saas landing page examples', 30, 1, 7, 11, 1, true), P('stripe vs paddle', 45, 1, 4.5, 8, 2.4, true),
    P('paddle vs stripe for saas', 25, 1, 6, 9.5, 2, true), P('nextjs saas boilerplate', 42, 1, 6, 9.8, 1, true), P('next.js saas starter', 28, 1, 8, 12, 1, true),
    P('stripe vs paddle fees', 20, 1, 3.8, 6.9, 2.4, true), P('paddle fees', 18, 1, 5, 8.6, 2, true), P('stripe or paddle for indie hackers', 12, 1, 4.2, 5.1, 2.2, true),
    P('paddle vs stripe vs lemon squeezy', 14, 1, 7, 11.5, 2, true), P('paddle merchant of record', 14, 1.5, 9.5, 7.2, 2), P('stripe tax vs paddle', 9, 1.2, 11, 10.4, 1.8),
    P('stripe subscription setup', 20, 1.7, 9, 7), P('stripe webhooks for saas', 14, 1.5, 12, 10), P('saas starter template', 24, 2, 14, 9), P('saas boilerplate comparison', 16, 1.8, 16, 11),
    P('deploy saas to vercel', 14, 1.5, 12, 10), P('stripe revenue dashboard', 14, 1.7, 16, 11), P('revenue analytics for indie hackers', 12, 1.6, 17, 13),
    P('how to track saas revenue by source', 12, 2, 18, 10),
  ];
  // About 1,700 clicks over the window, close to the 1,200 organic Google visits Home counts for ShipKit.
  const pageScale = 0.5;
  const pageRows = rows(PAGES, pageScale);
  // Search Console hides rare queries: the listed queries add up to about 70% of the clicks.
  const pageClicks = pageRows.reduce((a, x) => a + x[2], 0);
  const queryScale = (0.7 * pageClicks) / expectedSum(QUERIES, (x, i) => imps(x, i) * ctrAt(x, i));
  const queryRows = rows(QUERIES, queryScale);

  // Per day: the page rows plus the long tail Search Console files under other pages.
  const daily = dates.map((date) => {
    let clicks = 0;
    let impressions = 0;
    let weighted = 0;
    for (const x of pageRows) if (x[0] === date) (clicks += x[2]), (impressions += x[3]), (weighted += x[4] * x[3]);
    const tail = Math.round(impressions * 0.05 * (0.8 + 0.4 * r()));
    clicks += Math.round(tail * 0.012);
    weighted += 17 * tail;
    impressions += tail;
    return [date, clicks, impressions, impressions ? +(weighted / impressions).toFixed(1) : null];
  });

  const gscThrough = dates[DAYS - 1];

  // gsc_page_queries: page and query pairs over the last 28 days and the 28 before (docs/SEO.md). Each query's clicks
  // and impressions are split over the pages it lands on, then cut where a page's queries would pass 85% of its own
  // clicks or impressions, so no pair is larger than its query in gsc_queries or its page in gsc_pages.
  const QUERY_PAGES = {
    shipkit: [['/', 0.8], ['/pricing', 0.1], ['/features', 0.1]], 'shipkit pricing': [['/pricing', 1]], 'shipkit review': [['/', 0.6], ['/vs/launchfast', 0.4]],
    'shipkit vs launchfast': [['/vs/launchfast', 1]], 'shipkit docs': [['/docs', 0.7], ['/docs/getting-started', 0.3]], 'shipkit alternative': [['/vs/launchfast', 1]],
    'launchfast alternative': [['/vs/launchfast', 1]], 'seo for saas': [['/blog/seo-for-saas', 1]], 'saas seo checklist': [['/blog/seo-for-saas', 1]],
    'seo for saas startups': [['/blog/seo-for-saas', 1]], 'how to get first customers for saas': [['/blog/how-to-get-first-customers', 1]],
    'first 100 customers saas': [['/blog/how-to-get-first-customers', 1]], 'how to get first saas customers': [['/blog/how-to-get-first-customers', 1]],
    'saas pricing page examples': [['/blog/saas-pricing-page-examples', 1]], 'pricing page design saas': [['/blog/saas-pricing-page-examples', 1]],
    'how to price a saas': [['/blog/saas-pricing-page-examples', 0.6], ['/pricing', 0.4]], 'launch on product hunt': [['/blog/launch-on-product-hunt', 1]],
    'product hunt launch checklist': [['/blog/launch-on-product-hunt', 1]], 'indie hacker tech stack': [['/blog/indie-hacker-tech-stack', 1]],
    'best tech stack for saas 2026': [['/blog/indie-hacker-tech-stack', 1]], 'how to validate a saas idea': [['/blog/how-to-validate-saas-idea', 1]],
    'saas idea validation': [['/blog/how-to-validate-saas-idea', 1]], 'saas metrics for founders': [['/blog/saas-metrics-for-founders', 1]],
    'mrr vs arr': [['/blog/mrr-vs-arr', 0.8], ['/blog/saas-metrics-for-founders', 0.2]], 'what is a good churn rate for saas': [['/blog/churn-rate-benchmarks', 1]],
    'saas churn benchmarks': [['/blog/churn-rate-benchmarks', 1]], 'build in public saas': [['/blog/build-in-public', 1]],
    'saas landing page checklist': [['/blog/saas-landing-page-checklist', 1]], 'saas landing page examples': [['/blog/saas-landing-page-checklist', 1]],
    'stripe vs paddle': [['/blog/stripe-vs-paddle-for-indie-saas', 1]], 'paddle vs stripe for saas': [['/blog/stripe-vs-paddle-for-indie-saas', 1]],
    'stripe vs paddle fees': [['/blog/stripe-vs-paddle-for-indie-saas', 1]], 'paddle fees': [['/blog/stripe-vs-paddle-for-indie-saas', 1]],
    'stripe or paddle for indie hackers': [['/blog/stripe-vs-paddle-for-indie-saas', 1]], 'paddle vs stripe vs lemon squeezy': [['/blog/stripe-vs-paddle-for-indie-saas', 1]],
    'paddle merchant of record': [['/blog/stripe-vs-paddle-for-indie-saas', 1]], 'stripe tax vs paddle': [['/blog/stripe-vs-paddle-for-indie-saas', 1]],
    'nextjs saas boilerplate': [['/blog/nextjs-saas-boilerplate', 1]], 'next.js saas starter': [['/blog/nextjs-saas-boilerplate', 1]],
    'stripe subscription setup': [['/docs/stripe-integration', 0.7], ['/blog/stripe-vs-paddle-for-indie-saas', 0.3]], 'stripe webhooks for saas': [['/docs/stripe-integration', 1]],
    'saas starter template': [['/templates/saas-starter', 0.7], ['/blog/nextjs-saas-boilerplate', 0.3]], 'saas boilerplate comparison': [['/blog/nextjs-saas-boilerplate', 0.5], ['/vs/launchfast', 0.5]],
    'deploy saas to vercel': [['/docs/deploy-to-vercel', 1]], 'stripe revenue dashboard': [['/', 0.6], ['/features', 0.4]],
    'revenue analytics for indie hackers': [['/', 0.5], ['/features', 0.5]], 'how to track saas revenue by source': [['/features', 0.7], ['/', 0.3]],
  };
  const pqFrom = dates[DAYS - 28];
  const pqPrevFrom = dates[DAYS - 56];
  const sideOf = (d) => (d >= pqFrom ? 0 : d >= pqPrevFrom ? 1 : -1);
  const sums = (rowsIn) => {
    const m = new Map();
    for (const [d, key, clicks, imp, pos] of rowsIn) {
      const side = sideOf(d);
      if (side < 0) continue;
      const e = m.get(key) ?? [{ c: 0, i: 0, w: 0 }, { c: 0, i: 0, w: 0 }];
      e[side].c += clicks;
      e[side].i += imp;
      e[side].w += pos * imp;
      m.set(key, e);
    }
    return m;
  };
  const qSum = sums(queryRows);
  const pSum = sums(pageRows);
  const pairs = [];
  for (const [query, pages] of Object.entries(QUERY_PAGES)) {
    const qs = qSum.get(query);
    if (!qs) continue;
    pages.forEach(([page, share], k) => pairs.push({ page, query, share, k, s: qs }));
  }
  // Per page and window: how far the query shares must shrink to stay under 85% of the page's own numbers.
  const fit = new Map();
  for (const side of [0, 1]) {
    for (const metric of ['c', 'i']) {
      const used = new Map();
      for (const x of pairs) used.set(x.page, (used.get(x.page) ?? 0) + x.s[side][metric] * x.share);
      for (const [page, u] of used) {
        const cap = 0.85 * (pSum.get(page)?.[side][metric] ?? 0);
        fit.set(`${page}|${side}|${metric}`, u > cap ? cap / u : 1);
      }
    }
  }
  const pageQueryRows = pairs
    .map((x) => {
      const cell = (side) => {
        const t = x.s[side];
        const clicks = Math.floor(t.c * x.share * fit.get(`${x.page}|${side}|c`));
        const imp = Math.max(clicks, Math.floor(t.i * x.share * fit.get(`${x.page}|${side}|i`)));
        // A page the query lands on second ranks a little lower than its first page.
        return [clicks, imp, imp ? +(t.w / t.i + x.k * 2.5).toFixed(1) : null];
      };
      return [x.page, x.query, ...cell(0), ...cell(1)];
    })
    .filter((r) => r[3] || r[6])
    .sort((a, b) => b[2] + b[5] - (a[2] + a[5]) || b[3] + b[6] - (a[3] + a[6]) || (a[0] < b[0] ? -1 : 1));
  const pageQueries = { from: pqFrom, to: gscThrough, previousFrom: pqPrevFrom, previousTo: dates[DAYS - 29], rows: pageQueryRows };

  const checked = day(now - 3 * DAY);
  const serp = (selfPosition, o = {}) => ({ date: checked, market: 'us', selfPosition, resultsReturned: 10, aiOverview: false, peopleAlsoAsk: true, video: false, sponsored: false, aiOverviewCitesUs: null, aiOverviewHosts: [], ...o });
  const T = (term, role, market, page, volume, kd, serpCheck, note = null) => ({ term, role, market, note, page, volume: volume === null ? null : { value: volume, kd, source: 'Ahrefs', date: day(now - 9 * DAY) }, serp: serpCheck });
  const targets = [
    T('shipkit', 'brand', 'global', '/', 320, null, serp(1, { peopleAlsoAsk: false })),
    T('shipkit pricing', 'brand', 'us', '/pricing', 90, null, serp(1, { peopleAlsoAsk: false }), 'The title says "Pricing" and nothing else. Test a version with the price range in it.'),
    T('shipkit alternative', 'defend', 'global', '/vs/launchfast', 140, '9', serp(5)),
    T('seo for saas', 'grow', 'us', '/blog/seo-for-saas', 2400, '38', serp(9, { aiOverview: true, aiOverviewCitesUs: false, aiOverviewHosts: ['ahrefs.com', 'semrush.com', 'backlinko.com'] }), 'Moved from page 2 to the bottom of page 1 after the guide was rewritten.'),
    T('how to get first customers for saas', 'grow', 'us', '/blog/how-to-get-first-customers', 1300, '31', serp(7, { aiOverview: true, aiOverviewCitesUs: true, aiOverviewHosts: ['shipkit.example.com', 'indiehackers.com'] })),
    T('saas pricing page examples', 'grow', 'us', '/blog/saas-pricing-page-examples', 1900, '29', serp(8, { video: true })),
    T('launch on product hunt', 'grow', 'us', '/blog/launch-on-product-hunt', 2900, '42', serp(8, { aiOverview: true, aiOverviewCitesUs: false, aiOverviewHosts: ['producthunt.com', 'ycombinator.com'] })),
    T('saas churn benchmarks', 'grow', 'us', '/blog/churn-rate-benchmarks', 590, '24', serp(null)),
    T('stripe vs paddle', 'grow', 'us', '/blog/stripe-vs-paddle-for-indie-saas', 4400, '55', serp(8, { aiOverview: true, aiOverviewCitesUs: false, aiOverviewHosts: ['stripe.com', 'paddle.com', 'reddit.com'] }), 'Lost 3 positions in the last month. Paddle changed its fees and the post still quotes the old ones.'),
    T('saas landing page checklist', 'grow', 'us', '/blog/saas-landing-page-checklist', 1000, '33', serp(9), 'Two newer lists passed it. Add the 2026 examples.'),
    T('nextjs saas boilerplate', 'grow', 'us', '/blog/nextjs-saas-boilerplate', 3600, '47', serp(10, { sponsored: true })),
    T('mrr vs arr', 'grow', 'global', '/blog/mrr-vs-arr', 8100, '51', serp(null, { aiOverview: true, aiOverviewCitesUs: false, aiOverviewHosts: ['stripe.com', 'investopedia.com'] })),
    T('stripe revenue dashboard', 'convert', 'us', '/', 260, '22', serp(null)),
    T('revenue analytics for indie hackers', 'convert', 'global', '/', 70, '12', serp(null)),
    T('saas analytics with revenue attribution', 'convert', 'us', '/features', 110, '18', serp(null), 'No page targets this yet. The comparison page is next.'),
  ];

  const work = [
    ['edit', 'live', 2, '/blog/seo-for-saas', 'Added an FAQ block and a comparison table to the guide.', 'The query "seo for saas" sat at position 9 with 3% click-through. Pages with a table and short answers tend to win the snippet.'],
    ['edit', 'live', 5, '/pricing', 'Rewrote the title and meta description with the price range.', 'Position 6 and 1.3% click-through, under half the usual rate for that rank.'],
    ['new', 'live', 8, '/vs/launchfast', 'Published a comparison page against LaunchFast.', 'The query "launchfast alternative" had 40 impressions a week and no page of ours.'],
    ['edit', 'live', 11, '/blog/stripe-vs-paddle-for-indie-saas', 'Updated the fee table for Paddle and Stripe.', null],
    ['offsite', 'live', 14, null, 'Listed ShipKit on three SaaS directories.', 'Domain Rating is 21 and the top-ranking comparison pages have 30 or more.'],
    ['new', 'live', 17, '/templates/saas-starter', 'Published the starter template page with a live demo link.', null],
    ['release', 'live', 20, null, 'Shipped structured data for articles and FAQs on every blog post.', null],
    ['edit', 'live', 24, '/docs/getting-started', 'Added a 2-minute setup summary to the top of the page.', 'Page one at position 5 and 1.2% click-through. The title did not say what the page does.'],
    ['new', 'draft', 27, '/blog/saas-revenue-attribution', 'Drafted a guide on revenue attribution for SaaS.', 'No page targets "saas analytics with revenue attribution".'],
    ['offsite', 'live', 33, null, 'Answered two questions on Indie Hackers with a link to the churn guide.', null],
  ].map(([kind, status, ago, path, summary, evidence]) => ({ date: day(now - ago * DAY), task: summary.replace(/\.$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40), kind, status, url: path ? `https://shipkit.example.com${path}` : null, summary, evidence }));

  const pkg = (id, title, phase, state, done, total, doneWhen, next, nextKind = next ? 'open' : null) => ({ id, title, phase, state, pct: Math.round((done / total) * 100), done, total, doneWhen, next, nextKind });
  const packages = [
    pkg('TECH-1', 'Crawl and index basics', 'Phase 1: foundations', 'done', 5, 5, 'Sitemap, canonical tags and robots.txt are right and every page is indexed.', null),
    pkg('TECH-2', 'Structured data on articles and FAQs', 'Phase 1: foundations', 'done', 3, 3, 'Article and FAQ schema validate on all blog posts.', null),
    pkg('CONT-1', 'Rewrite the five guides with most impressions', 'Phase 2: content', 'in-progress', 3, 5, 'Each guide has a table, short answers and an FAQ block.', 'Rewrite the churn benchmarks guide.'),
    pkg('CONT-2', 'Refresh decaying posts', 'Phase 2: content', 'in-progress', 1, 3, 'The three posts that lost clicks are back above their earlier position.', 'Update the landing page checklist with 2026 examples.'),
    pkg('CONT-3', 'Comparison pages', 'Phase 2: content', 'in-progress', 1, 3, 'Pages for the three main competitors are live.', 'Draft the comparison against the second competitor.'),
    pkg('LINK-1', 'Directory listings and guest posts', 'Phase 3: authority', 'external', 3, 8, 'Domain Rating reaches 30.', 'Pitch two newsletters on indie SaaS pricing. Needs the founder to send the email.', 'external'),
    pkg('CONV-1', 'Search landing pages that convert', 'Phase 3: authority', 'blocked', 0, 4, 'Organic visitors see a pricing link without scrolling.', 'Needs the new pricing page design first.'),
  ];
  const done = packages.reduce((a, p) => a + p.done, 0);
  const total = packages.reduce((a, p) => a + p.total, 0);

  const aiPanel = {
    date: day(now - 4 * DAY),
    prompts: [
      ['What is a good tool to track SaaS revenue by marketing source?', [['ChatGPT', true, '3', ['Plausible', 'Baremetrics'], ['shipkit.example.com']], ['Perplexity', true, '2', ['Baremetrics'], ['shipkit.example.com', 'baremetrics.com']], ['Gemini', false, null, ['Baremetrics', 'ProfitWell'], ['baremetrics.com']]]],
      ['Best analytics for indie hackers who sell through Stripe', [['ChatGPT', true, '4', ['Plausible', 'Fathom', 'Baremetrics'], []], ['Perplexity', false, null, ['Plausible', 'Fathom'], ['plausible.io']], ['Gemini', false, null, ['Plausible'], []]]],
      ['How do I see which blog post brings paying customers?', [['ChatGPT', true, '1', [], ['shipkit.example.com']], ['Perplexity', true, '3', ['Plausible'], ['shipkit.example.com']], ['Gemini', true, '2', ['Plausible'], []]]],
      ['Alternatives to LaunchFast', [['ChatGPT', true, '5', ['ShipFast', 'Supastarter'], []], ['Perplexity', false, null, ['ShipFast', 'Supastarter'], ['shipfa.st']], ['Gemini', null, null, [], []]]],
      ['How to get the first 100 customers for a SaaS', [['ChatGPT', false, null, ['Indie Hackers', 'Y Combinator'], ['indiehackers.com']], ['Perplexity', true, '4', ['Indie Hackers'], ['shipkit.example.com', 'indiehackers.com']], ['Gemini', false, null, ['Y Combinator'], ['ycombinator.com']]]],
      ['Stripe vs Paddle for a solo founder', [['ChatGPT', false, null, ['Lemon Squeezy', 'Paddle'], ['paddle.com', 'stripe.com']], ['Perplexity', false, null, ['Paddle', 'Stripe'], ['reddit.com']], ['Gemini', false, null, ['Paddle'], []]]],
      ['Which SaaS pricing pages are worth copying?', [['ChatGPT', false, null, ['Linear', 'Notion'], []], ['Perplexity', true, '5', ['Linear'], ['shipkit.example.com']], ['Gemini', null, null, [], []]]],
    ].flatMap(([prompt, answers]) => answers.map(([surface, mentioned, rank, competitors, citedHosts]) => ({ prompt, surface, status: mentioned === null ? 'skipped' : 'ok', mentioned, rank, competitors, citedHosts, errors: 0 }))),
  };

  const meta = {
    version: 1, project: 'shipkit', name: 'ShipKit', domain: 'shipkit.example.com', status: 'growing', generatedAt: new Date(now).toISOString(),
    property: 'sc-domain:shipkit.example.com', gscThrough, portfolioFocus: false, focusWeekday: null,
    lane: { webEdits: true, offsite: true, newPagesPerWeek: 1, notes: 'Edits to blog posts and docs ship straight away. Pricing and home page changes wait for a person. Offsite work is limited to directory listings and answers on forums, no paid links.' },
    plan: { title: 'SEO plan: ShipKit', completion: Math.round((done / total) * 100), summary: `${done} of ${total} tasks done`, packages },
    targets, work, aiPanel,
    serpCompetitors: {
      date: checked, terms: targets.filter((t) => t.serp).length,
      rows: [
        { host: 'ahrefs.com', terms: 5, best: 1, sample: 'seo for saas' }, { host: 'reddit.com', terms: 5, best: 2, sample: 'stripe vs paddle' }, { host: 'stripe.com', terms: 4, best: 1, sample: 'stripe vs paddle' },
        { host: 'indiehackers.com', terms: 4, best: 2, sample: 'how to get first customers for saas' }, { host: 'producthunt.com', terms: 3, best: 1, sample: 'launch on product hunt' },
        { host: 'backlinko.com', terms: 3, best: 3, sample: 'seo for saas' }, { host: 'baremetrics.com', terms: 2, best: 4, sample: 'saas churn benchmarks' },
      ],
    },
    backlinks: { date: day(now - 6 * DAY), domainRating: 21, backlinks: 1480, linkingWebsites: 214 },
  };

  return { meta, gsc_daily: daily, gsc_queries: queryRows, gsc_pages: pageRows, gsc_page_queries: pageQueries };
})();

// ---------- 5. Tabsaver and Indie Weekly: a Chrome extension and a newsletter (src/worker/product-type.ts)
// Both send goal events through POST /api/event (docs/GUIDE.md "Product types"): one session per person and day, as
// the snippets in Settings send them. Their numbers draw from a sequence of their own, so the sites above stay the same.
{
  let pSeed = 1234;
  const prand = () => ((pSeed = (pSeed * 16807) % 2147483647) - 1) / 2147483646;
  const ppick = (arr) => arr[Math.floor(prand() * arr.length)];
  const pid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(prand() * 16).toString(16));
  const ymd = (ts) => day(ts).replaceAll('-', '');
  const PRODUCT_COUNTRIES = COUNTRIES.map(([c]) => c);
  /** One goal event in the person's session of that day: a new session on the day's first event, as collect.ts does. */
  const sessionsSeen = new Map();
  const goal = (siteId, host, path, vid, ts, name, extra = {}) => {
    const sid = `${vid}-${ymd(ts)}`;
    const key = `${siteId}|${sid}`;
    const s = sessionsSeen.get(key);
    if (s) {
      s.goals++;
      s.last_seen_at = Math.max(s.last_seen_at, ts);
    } else {
      sessionsSeen.set(key, {
        site_id: siteId, id: sid, visitor_id: vid, started_at: ts, last_seen_at: ts, duration: 0, pageviews: 0, goals: 1, hostname: host,
        entry_page: path, exit_page: path, referrer: null, referrer_domain: null, source: 'Direct/None', channel: 'Direct',
        country: extra.country ?? ppick(PRODUCT_COUNTRIES), browser: extra.browser ?? 'Chrome', os: extra.os ?? 'Mac OS', device: 'Desktop',
      });
    }
    insert('events', { site_id: siteId, session_id: sid, visitor_id: vid, ts, type: 'goal', name, path, props: null });
  };
  // A time on day d, today's before now: a few sessions end in the last minutes, so Home shows a handful online.
  const at = (d) => now - d * DAY - (now % DAY) + Math.floor(prand() * (d === 0 ? (now % DAY) - 60_000 : DAY));

  // Tabsaver: 500 browsers had it before the 60 days. About 7 install it a day and 0.5% of the installed ones leave a day.
  // A browser sends active on 3 days in 10, so weekly active is most of the installed ones.
  const tab = 'demo0004';
  const tabHost = 'tabsaver.example.com';
  insert('sites', { id: tab, name: 'Tabsaver', domain: tabHost, timezone: 'UTC', currency: 'USD', api_key: 'rt_demo_key_tabsaver', created_at: now - 66 * DAY, product_type: 'extension' });
  const browsers = [];
  const addBrowser = (installedAt, sendInstall) => {
    const b = { vid: pid(), os: ppick(['Mac OS', 'Mac OS', 'Windows', 'Windows', 'Linux']), country: ppick(PRODUCT_COUNTRIES), gone: false };
    insert('visitors', { site_id: tab, id: b.vid, first_seen: installedAt });
    if (sendInstall) goal(tab, tabHost, '/extension', b.vid, installedAt, 'install', b);
    browsers.push(b);
  };
  for (let i = 0; i < 500; i++) addBrowser(now - (61 + Math.floor(prand() * 50)) * DAY, false);
  for (let d = 59; d >= 0; d--) {
    for (let i = 0, n = 5 + Math.floor(prand() * 5) + Math.floor((60 - d) / 25); i < n; i++) addBrowser(at(d), true);
    for (const b of browsers) {
      if (b.gone) continue;
      if (prand() < 0.005) {
        // Chrome opens the uninstall page on the site; its script sends the goal from a new website visitor.
        b.gone = true;
        const vid = pid();
        const ts = at(d);
        insert('visitors', { site_id: tab, id: vid, first_seen: ts });
        goal(tab, tabHost, '/uninstalled', vid, ts, 'uninstall', b);
        continue;
      }
      if (prand() < 0.3) goal(tab, tabHost, '/extension', b.vid, at(d), 'active', b);
    }
  }

  // Indie Weekly: 1,800 subscribers before the 60 days, about 12 new and 3 leaving a day, an issue every Tuesday that
  // 40% open over the next two days.
  const nl = 'demo0005';
  const nlHost = 'indieweekly.example.com';
  insert('sites', { id: nl, name: 'Indie Weekly', domain: nlHost, timezone: 'UTC', currency: 'USD', api_key: 'rt_demo_key_indieweekly', created_at: now - 65 * DAY, product_type: 'newsletter' });
  const readers = [];
  const subscribe = (ts) => {
    const r = { vid: pid(), country: ppick(PRODUCT_COUNTRIES), browser: 'Mail relay', os: 'Server', gone: false };
    insert('visitors', { site_id: nl, id: r.vid, first_seen: ts });
    goal(nl, nlHost, '/', r.vid, ts, 'subscribe', r);
    readers.push(r);
  };
  for (let i = 0; i < 1800; i++) subscribe(now - (61 + Math.floor(prand() * 300)) * DAY);
  for (let d = 59; d >= 0; d--) {
    for (let i = 0, n = 8 + Math.floor(prand() * 9); i < n; i++) subscribe(at(d));
    for (let i = 0, n = Math.floor(prand() * 6); i < n; i++) {
      const r = ppick(readers);
      if (r.gone) continue;
      r.gone = true;
      goal(nl, nlHost, '/', r.vid, at(d), 'unsubscribe', r);
    }
    // Tuesday's issue: opens that day and the day after.
    if (new Date(now - d * DAY).getUTCDay() === 2) {
      for (const r of readers) {
        if (r.gone || prand() >= 0.4) continue;
        const ts = now - d * DAY - (now % DAY) + 7 * 3_600_000 + Math.floor(prand() * 40 * 3_600_000);
        if (ts >= now - 60_000) continue;
        goal(nl, nlHost, '/', r.vid, ts, 'open', r);
      }
    }
  }
  for (const s of sessionsSeen.values()) insert('sessions', s);
}

// ---------- Right now: the live globe (GET /api/live)
// 17 visitors online across ShipKit, Habitly and Indie Weekly in 14 countries, seen in the last 4 minutes, with
// three payments, a trial, a signup and a goal in the last hour. Fixed values, no draws from rand(), so every row above
// stays the same. Two of the visitors paid weeks ago, so they show as customers.
{
  const MIN = 60_000;
  const nlSite = 'demo0005';
  const LIVE = [
    // site, country, region, city, page, source, device, started min ago, seen min ago
    [shipkit, 'US', 'Texas', 'Austin', '/pricing', 'Google', 'Desktop', 14, 0.5],
    [shipkit, 'US', 'New York', 'New York', '/blog/seo-for-saas', 'Google', 'Mobile', 6, 1],
    [shipkit, 'GB', 'England', 'London', '/', 'X', 'Desktop', 22, 2],
    [shipkit, 'DE', 'Berlin', 'Berlin', '/features', 'Direct/None', 'Desktop', 9, 0.2],
    [shipkit, 'FR', 'Île-de-France', 'Paris', '/docs', 'Hacker News', 'Desktop', 31, 3],
    [shipkit, 'IN', 'Karnataka', 'Bengaluru', '/pricing', 'Google', 'Mobile', 4, 0.8],
    [shipkit, 'JP', 'Tokyo', 'Tokyo', '/blog/how-to-get-first-customers', 'Google', 'Desktop', 17, 1.5],
    [shipkit, 'AU', 'New South Wales', 'Sydney', '/changelog', 'X', 'Tablet', 11, 3.5],
    [shipkit, 'CA', 'Ontario', 'Toronto', '/pricing', 'Direct/None', 'Desktop', 26, 1.2],
    [shipkit, 'BR', 'São Paulo', 'São Paulo', '/', 'Reddit', 'Mobile', 3, 0.4],
    [habitly, 'US', 'California', 'San Francisco', 'Paywall', 'Apple Search Ads', 'Mobile', 8, 0.3],
    [habitly, 'DE', 'Berlin', 'Berlin', 'Today', 'TikTok', 'Mobile', 12, 2.2],
    [habitly, 'KR', 'Seoul', 'Seoul', 'Streaks', 'Direct/None', 'Mobile', 5, 0.6],
    [habitly, 'MX', 'Mexico City', 'Mexico City', 'Onboarding', 'Instagram', 'Mobile', 2, 0.1],
    [habitly, 'SE', 'Stockholm', 'Stockholm', 'Today', 'Direct/None', 'Tablet', 19, 2.8],
    [nlSite, 'NL', 'North Holland', 'Amsterdam', '/', 'Newsletter', 'Desktop', 7, 1.8],
    [nlSite, 'SG', 'Singapore', 'Singapore', '/archive', 'X', 'Mobile', 15, 3.2],
  ];
  const HOSTS = { [shipkit]: 'shipkit.example.com', [habitly]: APP_HOST, [nlSite]: 'indieweekly.example.com' };
  const CHANNEL = { Google: 'Organic Search', X: 'Organic Social', Reddit: 'Organic Social', TikTok: 'Organic Social', Instagram: 'Organic Social', 'Hacker News': 'Organic Social', Newsletter: 'Email', 'Apple Search Ads': 'Paid', 'Direct/None': 'Direct' };
  const live = LIVE.map(([site, country, region, city, page, source, device, startedMin, seenMin], i) => {
    const app = site === habitly;
    const n = String(i + 1).padStart(2, '0');
    const row = {
      site_id: site, id: `live-sess-${n}`, visitor_id: `live-vis-${n}`, started_at: now - startedMin * MIN, last_seen_at: Math.round(now - seenMin * MIN),
      duration: Math.round((startedMin - seenMin) * MIN), pageviews: 2 + (i % 4), goals: 0, hostname: HOSTS[site], entry_page: app ? 'Onboarding' : '/',
      exit_page: page, referrer: null, referrer_domain: null, source, channel: CHANNEL[source], country, region, city,
      browser: app ? 'App' : device === 'Desktop' ? 'Chrome' : 'Mobile Safari', os: app ? 'iOS 26.1' : device === 'Desktop' ? 'Mac OS' : 'iOS', device,
    };
    insert('visitors', { site_id: site, id: row.visitor_id, first_seen: row.started_at - (i % 5 === 0 ? 20 * DAY : 0) });
    return row;
  });
  // Customers: two visitors who bought weeks ago.
  insert('payments', { id: 'pay_live_old_1', site_id: shipkit, provider: 'dodo', ts: now - 20 * DAY, amount: 9900, kind: 'payment', currency: 'USD', visitor_id: 'live-vis-01', session_id: null, customer_id: 'cus_live_1', matched_by: 'metadata' });
  insert('payments', { id: 'pay_live_old_2', site_id: habitly, provider: 'app_store', ts: now - 34 * DAY, amount: 3999, kind: 'payment', currency: 'USD', visitor_id: 'live-vis-11', session_id: null, customer_id: null, product: 'habitly_pro_yearly', matched_by: 'app_event' });
  // The last hour: payments, a trial, a signup and a goal, each on a visit above so the globe can place it.
  const ev = (i, minAgo, type, name, path) => {
    live[i].goals += type === 'goal' ? 1 : 0;
    insert('events', { site_id: live[i].site_id, session_id: live[i].id, visitor_id: live[i].visitor_id, ts: now - minAgo * MIN, type, name, path, props: null });
  };
  ev(0, 9, 'goal', 'checkout_click', '/pricing');
  insert('payments', { id: 'pay_live_1', site_id: shipkit, provider: 'dodo', ts: now - 8 * MIN, amount: 16900, kind: 'payment', currency: 'USD', visitor_id: 'live-vis-01', session_id: 'live-sess-01', customer_id: 'cus_live_1', product: 'ShipKit Pro license', matched_by: 'metadata' });
  insert('payments', { id: 'pay_live_2', site_id: shipkit, provider: 'stripe', ts: now - 23 * MIN, amount: 4900, kind: 'payment', currency: 'USD', visitor_id: 'live-vis-09', session_id: 'live-sess-09', customer_id: 'cus_live_9', product: 'shipkit_pro_monthly', matched_by: 'metadata' });
  insert('payments', { id: 'pay_live_3', site_id: habitly, provider: 'app_store', ts: now - 41 * MIN, amount: 3999, kind: 'payment', currency: 'USD', visitor_id: 'live-vis-15', session_id: 'live-sess-15', customer_id: null, product: 'habitly_pro_yearly', matched_by: 'app_event' });
  insertSub({
    site_id: habitly, id: 'live-trial-1', provider: 'app_store', customer_id: null, visitor_id: 'live-vis-14', session_id: 'live-sess-14',
    channel: 'Organic Social', source: 'Instagram', product: 'habitly_pro_yearly', amount: 3999, interval: 'year',
    trial_start: now - 2 * MIN, trial_end: now - 2 * MIN + 7 * DAY, expires_at: now - 2 * MIN + 7 * DAY, updated_at: now - 2 * MIN,
  });
  ev(3, 6, 'goal', 'signup', '/features');
  ev(15, 5, 'goal', 'subscribe', '/');
  for (const r of live) insert('sessions', r);
}

// ---------- People and recordings (FounderData Pro's People section, pro/docs/replay-plan.md)
// ShipKit records visits. Five people with a story: Anna signed in on her Mac, her iPhone and ShipKit's iPhone app, hit a
// broken button and paid; Ben signed up from X and saw an error; Kenji came back three times with cookies and never
// signed in; Lea's recorded visit had nothing go wrong; Mia found the iPhone app on the App Store and subscribed there,
// without a web visit. Each recorded visit has an index row (`replays`); the recording itself would be
// in R2, which the seed does not fill. Page activity is the `activity` event the tracker sends (collect.ts parseActivity).
// Each recorded visit also has the digest the recorder would have sent (replays.digest, migration 0082; its format is in
// FounderData Pro's pro/docs/RECORDINGS.md, "The digest"): pages with time and scroll, clicks that changed nothing, form
// fields changed and sent. Together they fill every list of the Recordings page's "What to fix": "Compare plans" on
// /pricing changes nothing, fields left on /settings and /integrations, a quick back from /faq, and ten blog readers who
// stop at the top of /blog/launch-checklist (a shallow page needs 10 recorded visits).
{
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const site = shipkit;
  const web = (vid, sid, start, o) => {
    const pages = o.pages;
    insert('sessions', {
      site_id: site, id: sid, visitor_id: vid, started_at: start, last_seen_at: start + o.minutes * MIN, duration: o.minutes * MIN, pageviews: pages.length,
      goals: (o.goals ?? []).length, hostname: 'shipkit.example.com', entry_page: pages[0], exit_page: pages.at(-1), referrer: o.referrer ?? null,
      referrer_domain: o.domain ?? null, source: o.source ?? 'Direct/None', channel: o.channel ?? 'Direct', country: o.geo[0], region: o.geo[1], city: o.geo[2],
      browser: o.os === 'iOS' ? 'Mobile Safari' : 'Chrome', os: o.os ?? 'Mac OS', device: o.os === 'iOS' ? 'Mobile' : 'Desktop',
    });
    const step = (o.minutes * MIN) / (pages.length + 1);
    // `times`: when each page was shown, in ms from the start; else evenly spread.
    const at = (i) => (o.times ? o.times[Math.min(i, o.times.length - 1)] : Math.round(i * step));
    const next = (i) => (i + 1 < pages.length ? at(i + 1) : o.minutes * MIN);
    insertEvents(site, sid, vid, pages.map((path, i) => ({ ts: start + at(i), type: 'pageview', path })));
    for (const [name, i] of o.goals ?? []) insertEvents(site, sid, vid, [{ ts: start + Math.round(at(i) + 0.6 * (next(i) - at(i))), type: 'goal', name, path: pages[i] }]);
    // Activity times count from the page's start (`s`), as the tracker sends them.
    for (const [i, act] of o.activity ?? []) insertEvents(site, sid, vid, [{ ts: start + Math.round(at(i) + 0.9 * (next(i) - at(i))), type: 'activity', path: pages[i], props: { s: start + at(i), ...act } }]);
    if (!o.recorded) return;
    // The digest: `d[i]` adds sd (scroll %), dc (dead clicks, `t` in ms from the page's start), f (fields), fs, qb.
    const digest = {
      s: start,
      v: o.os === 'iOS' ? [390, 844] : [1440, 900],
      p: pages.map((u, i) => {
        const extra = (o.digest ?? [])[i] ?? {};
        const dc = extra.dc?.map((c) => ({ ...c, t: at(i) + c.t }));
        return { u, a: at(i), g: 0, ms: next(i) - at(i), ...extra, ...(dc ? { dc } : {}) };
      }),
      x: pages.at(-1),
    };
    insert('replays', { site_id: site, session_id: sid, visitor_id: vid, started_at: start, entry_page: pages[0], digest: JSON.stringify(digest) });
  };
  const COMPARE = { l: 'Compare plans', s: 'div.plan-card' };
  const BERLIN = ['DE', 'Berlin', 'Berlin'];
  // Anna: her Mac's visitor id is kept in cookies (Remember visitors), so its visits join; identify() names it and her iPhone.
  insert('visitors', {
    site_id: site, id: 'people-anna-mac', first_seen: now - 21 * DAY, user_id: 'usr_anna', name: 'Anna Weber', email: 'anna.weber@example.com',
    first_source: 'Google', first_channel: 'Organic Search', first_referrer: 'www.google.com', first_entry_page: '/',
    traits: json({ plan: 'Pro', company: 'Acme Labs', seats: '5', role: 'Founder' }),
  });
  insert('visitors', { site_id: site, id: 'people-anna-iphone', first_seen: now - 3 * DAY, user_id: 'usr_anna', name: 'Anna Weber', email: 'anna.weber@example.com' });
  web('people-anna-mac', 'people-anna-s1', now - 21 * DAY, { geo: BERLIN, minutes: 6, source: 'Google', channel: 'Organic Search', referrer: 'www.google.com', domain: 'google.com', pages: ['/', '/blog/launch-checklist', '/pricing'] });
  web('people-anna-mac', 'people-anna-s2', now - 9 * DAY, {
    geo: BERLIN, minutes: 8, pages: ['/pricing', '/signup', '/dashboard'], goals: [['signup', 1]], recorded: true,
    digest: [{ sd: 64, dc: [{ ...COMPARE, n: 2, t: 9000 }] }, { sd: 100, f: ['email', 'company', 'password'], fs: 1 }, { sd: 35 }],
    activity: [[0, { c: [{ t: 4200, l: 'Start free trial', k: 'button' }] }], [1, { c: [{ t: 21000, l: 'Create account', k: 'submit' }] }]],
  });
  web('people-anna-iphone', 'people-anna-s3', now - 3 * DAY, {
    geo: BERLIN, minutes: 5, os: 'iOS', pages: ['/dashboard', '/billing'], recorded: true,
    digest: [{ sd: 40 }, { sd: 72, f: ['card_name'], fs: 1 }],
    activity: [[1, { c: [{ t: 6100, l: 'Pay now', k: 'button', n: 5, r: 1 }, { t: 15400, l: 'Pay now', k: 'button' }], e: [{ t: 6900, m: "TypeError: Cannot read properties of undefined (reading 'card')", s: 'https://shipkit.example.com/assets/billing.js:212' }] }]],
  });
  insert('payments', { id: 'pay_people_anna', site_id: site, provider: 'stripe', ts: now - 3 * DAY + 4 * MIN, amount: 4900, kind: 'payment', currency: 'USD', visitor_id: 'people-anna-iphone', session_id: 'people-anna-s3', customer_id: 'cus_people_anna', email: 'anna.weber@example.com', name: 'Anna Weber', product: 'shipkit_pro_monthly', matched_by: 'metadata', channel: 'Organic Search', source: 'Google' });
  web('people-anna-mac', 'people-anna-s4', now - 2 * HOUR, { geo: BERLIN, minutes: 4, pages: ['/dashboard', '/settings', '/docs/webhooks'], recorded: true, activity: [[1, { c: [{ t: 3000, l: 'Invite teammate', k: 'button' }] }]],
    digest: [{ sd: 30 }, { sd: 55, f: ['teammate_email', 'role'] }, { sd: 18 }] });

  // Anna's iPhone app: the SDK's identify() joins the install to her by user id. App visits are never recorded.
  const app = (vid, sid, start, o) => {
    const screens = o.screens;
    insert('sessions', {
      site_id: site, id: sid, visitor_id: vid, started_at: start, last_seen_at: start + o.minutes * MIN, duration: o.minutes * MIN, pageviews: screens.length,
      goals: 0, hostname: 'ios:com.example.shipkit', entry_page: '/' + screens[0], exit_page: '/' + screens.at(-1), referrer: null, referrer_domain: null,
      source: o.source ?? 'Direct/None', channel: o.channel ?? 'Direct', country: o.geo[0], region: o.geo[1], city: o.geo[2], browser: 'App', os: 'iOS 26.1', device: 'Mobile',
    });
    const step = (o.minutes * MIN) / (screens.length + 1);
    insertEvents(site, sid, vid, screens.map((name, i) => ({ ts: start + Math.round(i * step), type: 'pageview', path: '/' + name })));
  };
  insert('visitors', { site_id: site, id: 'people-anna-app', first_seen: now - 26 * HOUR, user_id: 'usr_anna', name: 'Anna Weber', email: 'anna.weber@example.com', persistent: 1 });
  app('people-anna-app', 'people-anna-s5', now - 26 * HOUR, { geo: BERLIN, minutes: 3, screens: ['Projects', 'Deploys', 'Settings'] });

  // Mia: found the app on the App Store and subscribed in it for $4.99 a month. No web visit, no name.
  const SEOUL = ['KR', 'Seoul', 'Seoul'];
  insert('visitors', { site_id: site, id: 'people-mia-app', first_seen: now - 8 * DAY, first_source: 'App Store', first_channel: 'Organic Search', persistent: 1 });
  app('people-mia-app', 'people-mia-s1', now - 8 * DAY, { geo: SEOUL, minutes: 4, source: 'App Store', channel: 'Organic Search', screens: ['Onboarding', 'Projects', 'Paywall'] });
  insert('payments', { id: 'pay_people_mia', site_id: site, provider: 'app_store', ts: now - 8 * DAY + 3 * MIN, amount: 499, kind: 'payment', currency: 'USD', visitor_id: 'people-mia-app', session_id: 'people-mia-s1', customer_id: null, product: 'shipkit_app_monthly', matched_by: 'app_event' });
  app('people-mia-app', 'people-mia-s2', now - 5 * HOUR, { geo: SEOUL, minutes: 6, screens: ['Projects', 'Deploys'] });

  // Ben: found ShipKit on X, signed up, and saw an error on the next visit.
  insert('visitors', { site_id: site, id: 'people-ben-1', first_seen: now - 6 * DAY, user_id: 'usr_ben', name: 'Ben Okafor', email: 'ben.okafor@example.com', first_source: 'X', first_channel: 'Organic Social', traits: json({ plan: 'Trial', company: 'Okafor Studio' }) });
  web('people-ben-1', 'people-ben-s1', now - 6 * DAY, { geo: ['GB', 'England', 'London'], minutes: 7, source: 'X', channel: 'Organic Social', referrer: 't.co', domain: 't.co', pages: ['/', '/features', '/signup'], goals: [['signup', 2]], recorded: true, activity: [[2, { c: [{ t: 9000, l: 'Create account', k: 'submit' }] }]],
    digest: [{ sd: 80 }, { sd: 22, dc: [{ l: 'Live demo', s: 'img.hero-shot', n: 1, t: 15000 }] }, { sd: 100, f: ['email', 'company'], fs: 1 }] });
  web('people-ben-1', 'people-ben-s2', now - 26 * HOUR, {
    geo: ['GB', 'England', 'London'], minutes: 3, pages: ['/dashboard', '/integrations'], recorded: true,
    digest: [{ sd: 20 }, { sd: 45, f: ['stripe_key'] }],
    activity: [[1, { c: [{ t: 2500, l: 'Connect Stripe', k: 'button' }], e: [{ t: 2700, m: 'Error: Request failed with status 500', s: 'https://shipkit.example.com/assets/app.js:88' }] }]],
  });

  // Kenji: no name, but his visitor id came back on three days (Remember visitors).
  insert('visitors', { site_id: site, id: 'people-kenji-1', first_seen: now - 12 * DAY, first_source: 'Reddit', first_channel: 'Organic Social' });
  web('people-kenji-1', 'people-kenji-s1', now - 12 * DAY, { geo: ['JP', 'Tokyo', 'Tokyo'], minutes: 4, source: 'Reddit', channel: 'Organic Social', referrer: 'www.reddit.com/r/SaaS', domain: 'reddit.com', pages: ['/blog/stripe-webhooks', '/pricing'] });
  web('people-kenji-1', 'people-kenji-s2', now - 5 * DAY, { geo: ['JP', 'Tokyo', 'Tokyo'], minutes: 2, pages: ['/pricing'], recorded: true, activity: [[0, { c: [{ t: 8000, l: 'Monthly', k: 'button', n: 4, r: 1 }, { t: 12000, l: 'Yearly', k: 'button' }] }]],
    digest: [{ sd: 58, dc: [{ ...COMPARE, n: 3, t: 20000 }] }] });
  // Kenji opened the FAQ and went back to pricing 3 seconds later: a quick back.
  web('people-kenji-1', 'people-kenji-s3', now - 50 * MIN, {
    geo: ['JP', 'Tokyo', 'Tokyo'], minutes: 3, pages: ['/pricing', '/faq', '/pricing'], times: [0, 60_000, 63_000], recorded: true,
    digest: [{ sd: 50, dc: [{ ...COMPARE, n: 1, t: 30000 }] }, { sd: 10, qb: 1 }, { sd: 66 }],
  });

  // Lea: one calm recorded visit.
  insert('visitors', { site_id: site, id: 'people-lea-1', first_seen: now - 4 * HOUR });
  web('people-lea-1', 'people-lea-s1', now - 4 * HOUR, { geo: ['ES', 'Madrid', 'Madrid'], minutes: 2, source: 'ChatGPT', channel: 'AI', referrer: 'chatgpt.com', domain: 'chatgpt.com', pages: ['/', '/features'], recorded: true, activity: [[1, { c: [{ t: 5000, l: 'See pricing', k: 'link' }] }]],
    digest: [{ sd: 30 }, { sd: 24 }] });

  // Ten blog readers from Google, each gone from the top of /blog/launch-checklist within a minute or so.
  const READERS = [['US', 'California', 'San Francisco'], ['DE', 'Hamburg', 'Hamburg'], ['FR', 'Ile-de-France', 'Paris'], ['IN', 'Karnataka', 'Bengaluru'], ['BR', 'Sao Paulo', 'Sao Paulo']];
  for (let i = 0; i < 10; i++) {
    const vid = `people-reader-${i}`;
    insert('visitors', { site_id: site, id: vid, first_seen: now - (i + 1) * 7 * HOUR, first_source: 'Google', first_channel: 'Organic Search' });
    web(vid, `people-reader-s${i}`, now - (i + 1) * 7 * HOUR, {
      geo: READERS[i % READERS.length], minutes: 1, source: 'Google', channel: 'Organic Search', referrer: 'www.google.com', domain: 'google.com',
      os: i % 3 ? 'Mac OS' : 'iOS', pages: ['/blog/launch-checklist'], recorded: true, digest: [{ sd: 6 + ((i * 7) % 19) }],
    });
  }
}

// ---------- Round 7: experiments (lane exp)
// A lane deletes its own table's demo rows here first (out.push of a DELETE ... WHERE site_id IN (ids)): the table
// does not exist before its lane's migration, so the list at the top cannot name it.
// ShipKit runs pricing_headline on /pricing for the last 21 days: every visit that saw /pricing since then carries
// exp_pricing_headline (sessions.props), the version the Worker would have stored. Extra pricing visitors bring each
// version to about 900; version b sells the bigger licenses, so it leads on revenue per visitor (likely) while signups
// stay level (not_yet). A flag, new_checkout, ran 50 to 30 days ago and stopped with on as the winner; hero_video is a
// draft. sites.exp_live holds the running one (late). Habitly's exp_paywall (above) is the app experiment beside them.
{
  out.push(`DELETE FROM experiments WHERE site_id IN (${ids});`);
  let s = 91;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const hex = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => Math.floor(r() * 16).toString(16));
  const at = (list) => list[Math.floor(r() * list.length)];
  const start = now - 21 * DAY;
  const flagFrom = now - 50 * DAY, flagTo = now - 30 * DAY;
  const row = (key, kind, name, variants, paths, status, started, stopped, winner, created) =>
    insert('experiments', {
      site_id: shipkit, key, kind, name, variants: JSON.stringify(variants), paths, goal: null, status,
      started_at: started, stopped_at: stopped, winner, created_at: created, updated_at: stopped ?? started ?? created,
    });
  row('pricing_headline', 'experiment', 'Pricing headline', [{ key: 'control', weight: 50 }, { key: 'b', weight: 50 }], '/pricing', 'running', start, null, null, start - DAY);
  row('new_checkout', 'flag', 'New checkout', [{ key: 'off', weight: 50 }, { key: 'on', weight: 50 }], '/pricing', 'stopped', flagFrom, flagTo, 'on', flagFrom - DAY);
  row('hero_video', 'experiment', 'Video on the home page', [{ key: 'control', weight: 50 }, { key: 'video', weight: 50 }], '/', 'draft', null, null, null, now - 2 * DAY);

  // Extra visitors on /pricing in the window, alternating versions. b's buyers pick bigger licenses.
  const PRICE = { control: [4900, 9900, 9900, 9900], b: [9900, 16900, 16900, 29900] };
  for (let i = 0; i < 920; i++) {
    const arm = i % 2 ? 'b' : 'control';
    const vid = hex(), sid = hex();
    const t0 = start + Math.floor(r() * (now - start - 3600_000));
    // Own random sequence (r), so the blocks after this one see the same rand() as before.
    const src = at(SOURCES)[0];
    const [country, region, city] = at(COUNTRIES);
    const [browser, os, device] = at(DEVICES)[0];
    const signs = r() < 0.12;
    const buys = r() < 0.06;
    const nm = `${at(FIRST)} ${at(LAST)}`;
    const who = signs || buys ? { name: nm, email: `${nm.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com` } : null;
    const events = [
      { ts: t0, type: 'pageview', path: '/pricing' },
      { ts: t0 + 500, type: 'goal', name: 'paywall_view', path: '/pricing', props: { source: 'pricing' } },
    ];
    if (signs) events.push({ ts: t0 + 40_000, type: 'goal', name: 'signup', path: '/pricing' });
    if (buys) events.push({ ts: t0 + 50_000, type: 'goal', name: 'checkout_click', path: '/pricing' });
    insert('visitors', { site_id: shipkit, id: vid, first_seen: t0, user_id: who ? `usr_${vid.slice(0, 8)}` : null, name: who?.name ?? null, email: who?.email ?? null });
    insert('sessions', {
      site_id: shipkit, id: sid, visitor_id: vid, started_at: t0, last_seen_at: t0 + 60_000, duration: 60_000, pageviews: 1, goals: events.length - 1,
      hostname: 'shipkit.example.com', entry_page: '/pricing', exit_page: '/pricing', referrer: src.referrer, referrer_domain: src.domain,
      source: src.source, channel: src.channel, country, region, city, browser, os, device, props: JSON.stringify({ exp_pricing_headline: arm }),
    });
    insertEvents(shipkit, sid, vid, events);
    if (buys) {
      insert('payments', {
        id: `pay_demo_exp_${i}`, site_id: shipkit, provider: 'dodo', ts: Math.min(now - 1000, t0 + 120_000), amount: at(PRICE[arm]), kind: 'payment',
        currency: 'USD', visitor_id: vid, session_id: sid, customer_id: `cus_exp_${i}`, email: who.email, name: who.name, matched_by: 'metadata',
      });
    }
  }
  // Every other visit that saw /pricing in a run gets its version by the first character of its visitor id, as a hash
  // would split them: the arms then add up to the visitors of /pricing in the window.
  const tag = (key, from, to, variants, chars) =>
    // One line: the loaders split seed.sql into statements by line.
    late.push(
      `UPDATE sessions SET props = json_set(COALESCE(props, '{}'), '$.exp_${key}', CASE WHEN instr('${chars}', substr(visitor_id, 1, 1)) > 0 THEN '${variants[0]}' ELSE '${variants[1]}' END)` +
        ` WHERE site_id = ${q(shipkit)} AND datacenter = 0 AND json_extract(COALESCE(props, '{}'), '$.exp_${key}') IS NULL` +
        ` AND id IN (SELECT session_id FROM events WHERE site_id = ${q(shipkit)} AND type = 'pageview' AND (path = '/pricing' OR path LIKE '/pricing/%') AND ts >= ${from} AND ts < ${to});`,
    );
  tag('pricing_headline', start, now + DAY, ['control', 'b'], '01234567');
  tag('new_checkout', flagFrom, flagTo, ['off', 'on'], '02468ace');
  late.push(`UPDATE sites SET exp_live = ${q(JSON.stringify([{ k: 'pricing_headline', v: [['control', 50], ['b', 50]], p: ['/pricing'] }]))} WHERE id = ${q(shipkit)};`);
}

// ---------- Round 7: surveys, retention and lifecycle (lane survey)
// ShipKit: 150 people who sign in over 14 weeks, so People > Retention has cohorts and the lifecycle chart has new,
// returning, resurrecting and dormant people; about 60 "How did you hear about us" answers in the last 30 days, a
// third from Direct visitors (a podcast, a friend), 5 with their own words; 15 cancel reasons from Stripe on the
// cancelled subscriptions, 6 with a comment; Anna and Ben carry their answer as a trait. Own random sequence, so the
// rows above stay the same. Late statements are one line each: test/round-trips.test.ts runs the file line by line.
{
  out.push(`DELETE FROM survey_answers WHERE site_id IN (${ids});`);
  let s = 77;
  const r = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const at = (list) => list[Math.floor(r() * list.length)];
  const WEEK = 7 * DAY;
  const ARRIVE = [
    [{ source: 'Google', channel: 'Organic Search', referrer: 'www.google.com', domain: 'google.com' }, 30],
    [{ source: 'X', channel: 'Organic Social', referrer: 't.co', domain: 't.co' }, 25],
    [{ source: 'Direct/None', channel: 'Direct', referrer: null, domain: null }, 25],
    [{ source: 'Indie Hackers', channel: 'Referral', referrer: 'www.indiehackers.com', domain: 'indiehackers.com' }, 10],
    [{ source: 'ChatGPT', channel: 'AI', referrer: 'chatgpt.com', domain: 'chatgpt.com' }, 10],
  ];
  const pickArrive = () => {
    let x = r() * 100;
    for (const [v, w] of ARRIVE) if ((x -= w) <= 0) return v;
    return ARRIVE[0][0];
  };
  const DIRECT = ARRIVE[2][0];
  let payments = 0;
  for (let i = 0; i < 150; i++) {
    // More people joined in recent weeks: the product grew.
    const joined = Math.min(13, Math.floor(14 * (1 - Math.sqrt(r()))));
    const first = pickArrive();
    const who = { name: `${at(FIRST)} ${at(LAST)}` };
    who.email = `${who.name.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@example.com`;
    const user = `usr_life_${i}`;
    // Half keep one visitor id (cookies, Remember visitors); the others get a new id each visit, joined by identify().
    const remember = r() < 0.5;
    const stay = 0.25 + r() * 0.6;
    const geo = at(COUNTRIES);
    let lastWeek = joined;
    for (let wk = joined; wk >= 0; wk--) {
      // Coming back gets less likely the longer someone stayed away; a few return after a gap (resurrecting).
      const gap = lastWeek - wk;
      if (wk !== joined && !(r() < (gap <= 1 ? stay : stay * 0.35))) continue;
      lastWeek = wk;
      const start = now - wk * WEEK - Math.floor(r() * (wk ? WEEK : 3 * DAY)) - 3600_000;
      const vid = remember ? `life-${i}` : `life-${i}-${wk}`;
      const sid = `life-${i}-s${wk}`;
      const src = wk === joined ? first : r() < 0.7 ? DIRECT : first;
      if (!remember || wk === joined) {
        insert('visitors', {
          site_id: shipkit, id: vid, first_seen: start, user_id: user, name: who.name, email: who.email,
          first_source: src.source, first_channel: src.channel, first_referrer: src.referrer, first_entry_page: wk === joined ? '/' : '/login',
        });
      }
      const pages = wk === joined ? ['/', '/pricing', '/signup', '/welcome'] : ['/login', '/dashboard'];
      const duration = 60_000 + Math.floor(r() * 400_000);
      insert('sessions', {
        site_id: shipkit, id: sid, visitor_id: vid, started_at: start, last_seen_at: start + duration, duration, pageviews: pages.length,
        goals: wk === joined ? 1 : 0, hostname: 'shipkit.example.com', entry_page: pages[0], exit_page: pages.at(-1), referrer: src.referrer,
        referrer_domain: src.domain, source: src.source, channel: src.channel, country: geo[0], region: geo[1], city: geo[2],
        browser: 'Chrome', os: 'Mac OS', device: 'Desktop',
      });
      const events = pages.map((p, k) => ({ ts: start + k * Math.floor(duration / pages.length), type: 'pageview', path: p }));
      if (wk === joined) events.push({ ts: start + duration - 1000, type: 'goal', name: 'signup', path: '/signup' });
      insertEvents(shipkit, sid, vid, events);
      // About a quarter buy a license in their first week.
      if (wk === joined && i % 4 === 1) {
        insert('payments', {
          id: `pay_demo_life_${++payments}`, site_id: shipkit, provider: 'dodo', ts: Math.min(now - 1000, start + duration), amount: [4900, 9900, 9900, 16900][i % 4],
          kind: 'payment', currency: 'USD', visitor_id: vid, session_id: sid, customer_id: `cus_life_${i}`, email: who.email, name: who.name, matched_by: 'metadata',
        });
      }
    }
  }

  // Anna and Ben answered the widget on /welcome after they signed up.
  insert('survey_answers', { site_id: shipkit, survey: 'heard_about', ts: now - 9 * DAY + 5 * 60_000, id: 'demo_ha_anna', visitor_id: 'people-anna-mac', session_id: 'people-anna-s2', subscription_id: null, answer: 'friend', text: null, via: 'widget' });
  insert('survey_answers', { site_id: shipkit, survey: 'heard_about', ts: now - 6 * DAY + 6 * 60_000, id: 'demo_ha_ben', visitor_id: 'people-ben-1', session_id: 'people-ben-s1', subscription_id: null, answer: 'podcast', text: null, via: 'widget' });

  const since = now - 30 * DAY;
  // Identified visitors of the last 30 days, oldest visit first, one row each: n numbers them.
  const people = (channel) =>
    `SELECT s.site_id, s.visitor_id, s.id AS sid, MIN(s.started_at) AS started_at, s.channel, s.source, ROW_NUMBER() OVER (ORDER BY MIN(s.started_at), s.visitor_id) AS n FROM sessions s JOIN visitors v ON v.site_id = s.site_id AND v.id = s.visitor_id WHERE s.site_id = ${q(shipkit)} AND s.started_at > ${since} AND v.user_id IS NOT NULL AND v.id NOT LIKE 'people-%' AND s.channel ${channel} GROUP BY s.visitor_id`;
  const OTHER = ['The Indie Hackers forum', 'A Discord server for founders', 'My accountant', 'A conference talk in Berlin', 'Hacker News'];
  const insertAnswers = (rows, answer, text, limit, via) =>
    `INSERT OR IGNORE INTO survey_answers (site_id, survey, ts, id, visitor_id, session_id, subscription_id, answer, text, via) SELECT site_id, 'heard_about', started_at + 240000, 'demo_ha_' || visitor_id, visitor_id, sid, NULL, ${answer}, ${text}, ${via} FROM (${rows}) ORDER BY n LIMIT ${limit};`;
  // 20 Direct visitors: two in three heard it on a podcast, the rest from a friend. Attribution calls them all Direct.
  late.push(insertAnswers(people("= 'Direct'"), "CASE WHEN n % 3 = 0 THEN 'friend' ELSE 'podcast' END", 'NULL', 20, "CASE WHEN n % 4 = 0 THEN 'js' ELSE 'widget' END"));
  // 40 others, mostly naming the channel that brought them; every eighth says something else in their own words.
  const otherText = `CASE n % 40 ${OTHER.map((t, k) => `WHEN ${k * 8} THEN ${q(t)}`).join(' ')} END`;
  late.push(
    insertAnswers(
      people("!= 'Direct'"),
      `CASE WHEN n % 8 = 0 THEN 'other' WHEN source = 'Google' THEN 'google' WHEN source = 'X' THEN 'x' WHEN source = 'Reddit' THEN 'reddit' WHEN source = 'YouTube' THEN 'youtube' WHEN source = 'LinkedIn' THEN 'linkedin' WHEN channel = 'AI' THEN 'ai' WHEN n % 3 = 0 THEN 'newsletter' ELSE 'friend' END`,
      `CASE WHEN n % 8 = 0 THEN ${otherText} END`,
      40,
      "'widget'",
    ),
  );
  // 9 more identified visitors closed the card without answering: skipped, so the card's response rate is not 100%.
  late.push(
    `INSERT OR IGNORE INTO survey_answers (site_id, survey, ts, id, visitor_id, session_id, subscription_id, answer, text, via) SELECT site_id, 'heard_about', started_at + 240000, 'demo_ha_' || visitor_id, visitor_id, sid, NULL, 'skipped', NULL, 'widget' FROM (${people('IS NOT NULL')}) WHERE visitor_id NOT IN (SELECT visitor_id FROM survey_answers WHERE site_id = ${q(shipkit)} AND visitor_id IS NOT NULL) ORDER BY n DESC LIMIT 9;`,
  );
  // 15 cancelled Stripe subscriptions say why, 6 of them in words, as the Customer Portal's cancellation reasons.
  const REASONS = ['too_expensive', 'missing_features', 'unused', 'too_expensive', 'switched_service', 'too_complex', 'unused', 'too_expensive', 'missing_features', 'low_quality', 'unused', 'customer_service', 'too_expensive', 'other', 'switched_service'];
  // Each comment by the reason it goes with (n is the row number in REASONS, from 1).
  const COMMENTS = [[1, 'Fine product, the price is high for a side project.'], [2, 'No team seats yet. We need three logins.'], [3, 'We only need it during launches, not every month.'], [5, 'Moved to a boilerplate my cofounder already knew.'], [6, 'The setup took longer than building it myself.'], [7, 'Paused the project for now.']];
  // The 60 days above cancel only a few; 12 more running monthly plans turn auto-renew off, a few days after a renewal.
  late.push(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = MIN(${now - DAY}, renewed_at + 2 * ${DAY}), updated_at = MIN(${now - DAY}, renewed_at + 2 * ${DAY}) WHERE site_id = ${q(shipkit)} AND id IN (SELECT id FROM subscriptions WHERE site_id = ${q(shipkit)} AND provider = 'stripe' AND interval = 'month' AND canceled_at IS NULL AND ended_at IS NULL AND billing_issue_at IS NULL AND renewed_at IS NOT NULL ORDER BY id LIMIT 12);`,
  );
  const reason = `CASE n ${REASONS.map((x, k) => `WHEN ${k + 1} THEN ${q(x)}`).join(' ')} END`;
  const comment = `CASE n ${COMMENTS.map(([n, x]) => `WHEN ${n} THEN ${q(x)}`).join(' ')} END`;
  late.push(
    `INSERT OR IGNORE INTO survey_answers (site_id, survey, ts, id, visitor_id, session_id, subscription_id, answer, text, via) SELECT site_id, 'cancel_reason', canceled_at, 'stripe:' || id || ':' || canceled_at, visitor_id, NULL, id, ${reason}, ${comment}, 'stripe' FROM (SELECT sub.*, ROW_NUMBER() OVER (ORDER BY sub.canceled_at DESC, sub.id) AS n FROM subscriptions sub WHERE sub.site_id = ${q(shipkit)} AND sub.provider = 'stripe' AND sub.canceled_at IS NOT NULL) WHERE n <= 15;`,
  );
  // Each answer is also the person's trait (visitors.traits), as surveys.ts writes it.
  for (const survey of ['heard_about', 'cancel_reason']) {
    late.push(
      `UPDATE visitors SET traits = json_set(COALESCE(traits, '{}'), '$.${survey}', (SELECT sa.answer FROM survey_answers sa WHERE sa.site_id = visitors.site_id AND sa.survey = '${survey}' AND sa.visitor_id = visitors.id ORDER BY sa.ts DESC LIMIT 1)) WHERE site_id = ${q(shipkit)} AND id IN (SELECT visitor_id FROM survey_answers WHERE site_id = ${q(shipkit)} AND survey = '${survey}' AND visitor_id IS NOT NULL);`,
    );
  }
  // Both surveys on: the widget asks on /welcome after signup, and on the cancel page.
  late.push(`UPDATE sites SET surveys = ${q(JSON.stringify({ heard_about: { on: 1, paths: ['/welcome'] }, cancel_reason: { on: 1, paths: ['/account/cancel'] } }))} WHERE id = ${q(shipkit)};`);
}

// ---------- Round 7: click maps, scroll depth and paths (lane pages)
// ShipKit has click maps on: 400 page views each of / and /pricing and 100 of /features, desktop and mobile, with
// clicks on the main button, the nav and "Compare plans" (the dead click the recordings demo names). Page speed rows
// carry the scroll depth: /blog/seo-for-saas is read to the end, /blog/launch-checklist is left at the top (the
// recordings demo's shallow page). 80 visits walk / > /pricing > /signup, or a part of it, so Paths has a route to
// follow; 6 of them pay. Its own random sequence, so the blocks after it see the same numbers as before.
{
  out.push(`DELETE FROM page_maps WHERE site_id IN (${ids});`);
  out.push(`DELETE FROM vitals WHERE site_id IN (${ids});`);
  let s7 = 7;
  const r = () => ((s7 = (s7 * 16807) % 2147483647) - 1) / 2147483646;
  const around = (mid, spread) => Math.max(0, Math.min(100, Math.round(mid + (r() + r() + r() - 1.5) * spread)));
  // [x per mille of the width, y px, hint, label, share of page views with this click]
  const DESKTOP = {
    '/': [[500, 520, 'a.cta', 'Start free trial', 0.34], [640, 32, 'a.nav', 'Pricing', 0.22], [560, 32, 'a.nav', 'Features', 0.09], [720, 32, 'a.nav', 'Docs', 0.06], [900, 32, 'a.login', 'Log in', 0.08], [500, 1850, 'a.cta', 'Get ShipKit', 0.05], [300, 1240, 'img', '', 0.04]],
    '/pricing': [[500, 760, 'div.plan-card', 'Compare plans', 0.21], [330, 610, 'a.buy', 'Buy Starter', 0.07], [670, 610, 'a.buy', 'Buy Pro', 0.12], [500, 1420, 'summary', 'Can I get a refund?', 0.09], [560, 32, 'a.nav', 'Features', 0.05], [900, 32, 'a.login', 'Log in', 0.04]],
    '/features': [[500, 480, 'a.cta', 'Start free trial', 0.18], [640, 32, 'a.nav', 'Pricing', 0.25], [250, 1100, 'button.tab', 'Payments', 0.11], [500, 1100, 'button.tab', 'Auth', 0.08]],
  };
  const MOBILE = {
    '/': [[500, 610, 'a.cta', 'Start free trial', 0.29], [920, 28, 'button.menu', 'Menu', 0.24], [500, 2900, 'a.cta', 'Get ShipKit', 0.04]],
    '/pricing': [[500, 1320, 'div.plan-card', 'Compare plans', 0.24], [500, 980, 'a.buy', 'Buy Pro', 0.1], [500, 760, 'a.buy', 'Buy Starter', 0.05], [920, 28, 'button.menu', 'Menu', 0.12]],
    '/features': [[500, 560, 'a.cta', 'Start free trial', 0.15], [920, 28, 'button.menu', 'Menu', 0.2]],
  };
  const SCROLL = { '/': 58, '/pricing': 71, '/features': 44 };
  for (const [path, views] of [['/', 400], ['/pricing', 400], ['/features', 100]]) {
    for (let i = 0; i < views; i++) {
      const mobile = r() < 0.38;
      const spots = (mobile ? MOBILE : DESKTOP)[path];
      const clicks = [];
      for (const [x, y, hint, label, p] of spots) {
        // Rage on "Compare plans": a few views click it three times.
        const times = r() < p ? (hint === 'div.plan-card' && r() < 0.3 ? 3 : 1) : 0;
        for (let k = 0; k < times; k++) clicks.push([Math.max(0, Math.min(1000, x + Math.round((r() - 0.5) * 90))), Math.max(0, y + Math.round((r() - 0.5) * 40)), hint, label]);
      }
      insert('page_maps', {
        site_id: shipkit, path, ts: now - Math.floor(r() * 27 * DAY) - 60_000, id: Math.floor(r() * 2 ** 31), device: mobile ? 'Mobile' : 'Desktop',
        width: mobile ? 390 : 1440, height: mobile ? (path === '/' ? 3400 : 2600) : path === '/' ? 2300 : 1900, scroll: around(SCROLL[path], 50),
        clicks: clicks.length ? JSON.stringify(clicks) : null,
      });
    }
  }
  // Page speed rows with scroll depth (vitals.ts): a page load each, no visitor id.
  const SPEED = [['/', 520, 58, 1900], ['/pricing', 410, 71, 2300], ['/features', 160, 44, 2100], ['/blog/seo-for-saas', 240, 88, 2600], ['/blog/launch-checklist', 90, 12, 3100], ['/docs', 120, 63, 1500]];
  for (const [path, n, deep, lcp] of SPEED) {
    for (let i = 0; i < n; i++) {
      const mobile = r() < 0.4;
      insert('vitals', {
        site_id: shipkit, ts: now - Math.floor(r() * 27 * DAY) - 60_000, id: Math.floor(r() * 2 ** 31), path, device: mobile ? 'Mobile' : 'Desktop',
        lcp: Math.round(lcp * (0.5 + r()) * (mobile ? 1.3 : 1)), inp: r() < 0.4 ? Math.round(60 + r() * 260) : null, cls: Math.round(r() * r() * 0.3 * 10_000) / 10_000,
        ttfb: Math.round(120 + r() * 500), fcp: Math.round(lcp * 0.55 * (0.6 + r() * 0.8)), scroll: around(deep, path === '/blog/launch-checklist' ? 16 : 40),
      });
    }
  }
  // Paths: / > /pricing > /signup (> /dashboard), and the visits that leave on the way.
  const ROUTES = [
    [['/', '/pricing', '/signup', '/dashboard'], 22], [['/', '/pricing', '/signup'], 14], [['/', '/pricing'], 18], [['/', '/features', '/pricing', '/signup'], 8],
    [['/', '/pricing', '/features'], 6], [['/', '/pricing', '/pricing', '/signup'], 4], [['/pricing', '/signup'], 8],
  ];
  const GEO = [['US', 'California', 'San Francisco'], ['GB', 'England', 'London'], ['DE', 'Berlin', 'Berlin'], ['IN', 'Karnataka', 'Bengaluru'], ['CA', 'Ontario', 'Toronto']];
  let v = 0;
  let paid = 0;
  for (const [pages, count] of ROUTES) {
    for (let i = 0; i < count; i++) {
      const vid = `paths-v${++v}`;
      const sid = `paths-s${v}`;
      const start = now - Math.floor((1 + r() * 25) * DAY);
      const mobile = r() < 0.35;
      const geo = GEO[v % GEO.length];
      const signup = pages.includes('/signup');
      insert('visitors', { site_id: shipkit, id: vid, first_seen: start });
      insert('sessions', {
        site_id: shipkit, id: sid, visitor_id: vid, started_at: start, last_seen_at: start + pages.length * 70_000, duration: pages.length * 70_000, pageviews: pages.length,
        goals: signup ? 1 : 0, hostname: 'shipkit.example.com', entry_page: pages[0], exit_page: pages.at(-1), referrer: null, referrer_domain: null, source: 'Direct/None',
        channel: 'Direct', country: geo[0], region: geo[1], city: geo[2], browser: mobile ? 'Mobile Safari' : 'Chrome', os: mobile ? 'iOS' : 'Mac OS', device: mobile ? 'Mobile' : 'Desktop',
      });
      insertEvents(shipkit, sid, vid, [
        ...pages.map((path, k) => ({ ts: start + k * 70_000, type: 'pageview', path })),
        ...(signup ? [{ ts: start + pages.indexOf('/signup') * 70_000 + 30_000, type: 'goal', name: 'signup', path: '/signup' }] : []),
      ]);
      if (pages[3] === '/dashboard' && i % 4 === 0 && paid < 6) {
        paid++;
        insert('payments', { id: `pay_demo_paths_${paid}`, site_id: shipkit, provider: 'dodo', ts: Math.min(now - 60_000, start + 3 * DAY), amount: 9900, kind: 'payment', currency: 'USD', customer_id: `cus_paths_${paid}`, visitor_id: vid, session_id: sid, matched_by: 'metadata' });
      }
    }
  }
  late.push(`UPDATE sites SET maps_on = 1 WHERE id = ${q(shipkit)};`);
}

// ---------- Round 7: errors, recording filters and summaries (lane errors)
// ShipKit catches JavaScript errors (src/worker/errors.ts). Four issues: a TypeError on /checkout first seen 6 hours ago
// that hit 4 people, 2 of them paying customers, and one recorded visit (pro/scripts/seed-replays.mjs records it, so
// Watch opens at the error); "ResizeObserver loop..." on every page, ignored; "Script error." from a script on another
// domain; and a failed module load, resolved 3 days ago and back since yesterday. A new_error rule on /checkout sent
// one alert for the TypeError. `fp` is fingerprint(message, source, stack); test/errors.test.ts checks each one.
{
  out.push(`DELETE FROM errors WHERE site_id IN (${ids});`, `DELETE FROM error_issues WHERE site_id IN (${ids});`, `DELETE FROM error_first WHERE site_id IN (${ids});`);
  out.push(`DELETE FROM alert_events WHERE id LIKE 'evt_demo_err%';`);
  const site = shipkit;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const H = 'https://shipkit.example.com';
  const BUNDLE = `${H}/assets/index-B3kZ9a1x.js`;
  const ERRORS = {
    price: {
      fp: '9c48328265cd',
      message: "TypeError: Cannot read properties of undefined (reading 'priceId')",
      source: `${BUNDLE}:120`,
      // A literal \n here, turned into a line break after the flush: the seed file keeps one statement per line.
      stack: `${BUNDLE}:120:14 handleCheckout\\n${BUNDLE}:88:3 HTMLButtonElement.onclick`,
    },
    resize: { fp: '14fe38236d8f', message: 'ResizeObserver loop completed with undelivered notifications', source: null, stack: null },
    script: { fp: 'b7d19db721b1', message: 'Script error.', source: null, stack: null },
    chunk: {
      fp: '11c9286a34fa',
      message: 'TypeError: Failed to fetch dynamically imported module: https://shipkit.example.com/assets/Dashboard-4f2a9c1e.js',
      source: `${BUNDLE}:12`,
      stack: `${BUNDLE}:12:9 loadRoute`,
    },
  };
  let n = 0;
  const err = (key, sid, vid, ts, path, device = 'Desktop', browser = 'Chrome', times = 1) => {
    const e = ERRORS[key];
    insert('errors', {
      site_id: site, ts, id: 900_000 + ++n, fp: e.fp, session_id: sid, visitor_id: vid, path, message: e.message, source: e.source,
      stack: e.stack, n: times, device, browser,
    });
  };
  // The people of the checkout error. Kim and Sam pay (Sam on a second device that shares his user id); Joe and Ivy do
  // not. Ivy's visit is recorded.
  const visit = (vid, sid, start, o) => {
    insert('sessions', {
      site_id: site, id: sid, visitor_id: vid, started_at: start, last_seen_at: start + o.minutes * MIN, duration: o.minutes * MIN, pageviews: o.pages.length,
      goals: 0, hostname: 'shipkit.example.com', entry_page: o.pages[0], exit_page: o.pages.at(-1), referrer: null, referrer_domain: null,
      source: o.source ?? 'Google', channel: o.channel ?? 'Organic Search', country: o.geo[0], region: o.geo[1], city: o.geo[2],
      browser: o.browser ?? 'Chrome', os: o.os ?? 'Mac OS', device: o.device ?? 'Desktop',
    });
    insertEvents(site, sid, vid, o.pages.map((path, i) => ({ ts: start + i * 40_000, type: 'pageview', path })));
  };
  const people = [
    { vid: 'err-kim', name: 'Kim Novak', user: 'usr_kim', mrr: 4900, geo: ['US', 'New York', 'New York'] },
    { vid: 'err-sam', name: 'Sam Patel', user: 'usr_sam', mrr: 1900, geo: ['GB', 'England', 'London'] },
    { vid: 'err-joe', name: null, user: null, mrr: 0, geo: ['CA', 'Ontario', 'Toronto'] },
    { vid: 'err-ivy', name: null, user: null, mrr: 0, geo: ['DE', 'Berlin', 'Berlin'] },
  ];
  people.forEach((p, i) => {
    // A customer was first seen on the visit they paid on, 30 days ago; the others on the visit with the error. So the
    // person page's "found you" date is a visit the timeline shows.
    const start = now - (6 - i) * HOUR;
    const bought = now - 30 * DAY - 12 * MIN;
    insert('visitors', {
      site_id: site, id: p.vid, first_seen: p.mrr ? bought : start, user_id: p.user, name: p.name,
      email: p.name ? `${p.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com` : null,
    });
    if (p.mrr) visit(p.vid, `${p.vid}-s0`, bought, { minutes: 12, pages: ['/', '/pricing', '/checkout'], geo: p.geo });
    const mobile = i === 2;
    visit(p.vid, `${p.vid}-s1`, start, {
      minutes: 3, pages: ['/pricing', '/checkout'], geo: p.geo, ...(mobile ? { device: 'Mobile', os: 'iOS', browser: 'Mobile Safari' } : {}),
    });
    // The error on /checkout, 50 s into the visit; Kim hit it twice.
    err('price', `${p.vid}-s1`, p.vid, start + 50_000, '/checkout', mobile ? 'Mobile' : 'Desktop', mobile ? 'Mobile Safari' : 'Chrome', i === 0 ? 2 : 1);
    if (p.mrr) {
      const paid = now - 30 * DAY;
      insert('payments', {
        id: `pay_demo_err_${i}`, site_id: site, provider: 'stripe', ts: paid, amount: p.mrr, kind: 'payment', currency: 'USD', visitor_id: p.vid, session_id: `${p.vid}-s0`,
        customer_id: `cus_demo_err_${i}`, email: `${p.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`, name: p.name, product: p.mrr === 4900 ? 'shipkit_pro_monthly' : 'shipkit_starter_monthly',
      });
      insertSub({
        id: `sub_demo_err_${i}`, provider: 'stripe', customer_id: `cus_demo_err_${i}`, visitor_id: p.vid, status: 'active', currency: 'USD', amount: p.mrr,
        interval: 'month', interval_count: 1, mrr: p.mrr, first_mrr: p.mrr, paid_at: paid, renewed_at: now - 2 * DAY, expires_at: now + 28 * DAY,
        product: p.mrr === 4900 ? 'shipkit_pro_monthly' : 'shipkit_starter_monthly', site_id: site,
      });
    }
  });
  // Ivy's visit is recorded: the index row with a digest, and the page activity with the error (pro/scripts/seed-replays.mjs
  // rebuilds both around its recording and moves the error to the moment the video shows it).
  {
    const start = now - 3 * HOUR;
    insert('replays', {
      site_id: site, session_id: 'err-ivy-s1', visitor_id: 'err-ivy', started_at: start, entry_page: '/pricing',
      digest: JSON.stringify({ s: start, v: [1440, 900], p: [{ u: '/pricing', a: 0, g: 0, ms: 40_000, sd: 64 }, { u: '/checkout', a: 40_000, g: 0, ms: 140_000, sd: 30, f: ['email'], fs: 1 }], x: '/checkout' }),
    });
    insertEvents(site, 'err-ivy-s1', 'err-ivy', [
      { ts: start + 170_000, type: 'activity', path: '/checkout', props: { s: start + 40_000, c: [{ t: 9000, l: 'Pay $49', k: 'submit' }], e: [{ t: 10_000, m: ERRORS.price.message, s: ERRORS.price.source }] } },
    ]);
  }
  // Sam's second device: the same person, counted once.
  insert('visitors', { site_id: site, id: 'err-sam-phone', first_seen: now - 10 * DAY, user_id: 'usr_sam', name: 'Sam Patel', email: 'sam.patel@example.com' });
  // The other issues hit visitors without a name, each on a visit of its own that was not recorded.
  const GEOS = [['US', 'California', 'San Francisco'], ['FR', 'Île-de-France', 'Paris'], ['IN', 'Karnataka', 'Bengaluru'], ['BR', 'São Paulo', 'São Paulo']];
  let anon = 0;
  const anonErr = (key, ago, path) => {
    const vid = `err-anon-${++anon}`;
    const start = now - ago - 20_000;
    insert('visitors', { site_id: site, id: vid, first_seen: start });
    visit(vid, `${vid}-s1`, start, { minutes: 2, pages: [path], geo: GEOS[anon % GEOS.length], source: 'Direct/None', channel: 'Direct' });
    err(key, `${vid}-s1`, vid, start + 20_000, path);
  };
  // ResizeObserver: on every page for weeks, from browsers' own layout code. The owner ignored it.
  for (let d = 0; d < 12; d++) anonErr('resize', (d + 1) * 31 * HOUR, d % 2 ? '/' : '/blog/launch-checklist');
  // Script error.: a widget from another domain, a few times a day.
  for (let d = 0; d < 6; d++) anonErr('script', (d * 31 + 5) * HOUR, '/pricing');
  // The failed module load: first seen 12 days ago, resolved 3 days ago, back since yesterday.
  for (const ago of [12 * DAY, 11 * DAY, 9 * DAY, 20 * HOUR, 7 * HOUR]) anonErr('chunk', ago, '/dashboard');
  insert('error_issues', { site_id: site, fp: ERRORS.resize.fp, status: 'ignored', changed_at: now - 15 * DAY });
  insert('error_issues', { site_id: site, fp: ERRORS.chunk.fp, status: 'resolved', changed_at: now - 3 * DAY });
  // The new_error rule on /checkout, its dedupe state and the alert it sent for the TypeError (the alert inbox, migration 0069).
  const sent = now - 5 * HOUR - 20 * MIN;
  insert('alert_rules', {
    id: 'ar_demo_errors', site_id: site, name: 'A new error on /checkout', metric: 'new_error', path: '/checkout', comparison: 'rises_above', threshold: 0,
    win: '24h', min_volume: 1, webhook_url: null, secret: null, channels: 1, push: 1, enabled: 1, crossed: JSON.stringify([ERRORS.price.fp]),
    deliveries: JSON.stringify([{ id: 'dlv_demo_err', at: sent, kind: 'alert', to: 'push', ok: true, code: 200, attempts: 1, path: '/checkout', detail: '1 of 1 phone' }]),
    created_at: now - 20 * DAY, updated_at: now - 20 * DAY, check_every: '1h', actor: null, change_kind: null,
  });
  insert('alert_events', {
    ts: sent, id: 'evt_demo_err1', kind: 'threshold', site_id: site, title: 'New error on ShipKit /checkout',
    text: [ERRORS.price.message, `First seen ${new Date(now - 6 * HOUR).toISOString().slice(0, 16).replace('T', ' ')} UTC on /checkout. 1 person so far.`, 'Rule: A new error on /checkout.', '', `An agent reads it with get_recordings, view error, issue ${ERRORS.price.fp}.`].join('\\n'),
    data: JSON.stringify({ type: 'alert.crossed', delivery_id: 'dlv_demo_err', rule_id: 'ar_demo_errors', rule_name: 'A new error on /checkout', metric: 'new_error', path: '/checkout', window: '24h', current: 1, previous: 0, change_pct: null }),
  });
  late.push(`UPDATE sites SET errors_on = 1 WHERE id = ${q(site)};`);
  late.push(`UPDATE errors SET stack = replace(stack, '\\n', char(10)) WHERE site_id = ${q(site)} AND stack LIKE '%\\n%';`);
  // Each issue's first sighting, as the ping writes it (migration 0098): the time of its oldest row.
  late.push(`INSERT OR IGNORE INTO error_first (site_id, fp, first_seen) SELECT site_id, fp, MIN(ts) FROM errors WHERE site_id = ${q(site)} GROUP BY fp;`);
  late.push(`UPDATE alert_events SET text = replace(text, '\\n', char(10)) WHERE id = 'evt_demo_err1';`);
}

flushInserts();
out.push(...late);
// ShipKit records visits (People and recordings). After the flush: the sites row is one of the rows it writes.
out.push(`UPDATE sites SET record_visits = 1, record_on_at = ${now - 30 * DAY} WHERE id = ${q(shipkit)};`);
// The snapshot parts go in after the rows above: each is one row, its text appended in chunks under the statement limit.
for (const [part, value] of Object.entries(seoParts)) {
  const text = JSON.stringify(value);
  const chunks = text.match(/[\s\S]{1,60000}/g);
  out.push(`INSERT INTO seo_snapshots (site_id, part, json, pushed_at) VALUES (${q(shipkit)}, ${q(part)}, ${q(chunks[0])}, ${now});`);
  for (const c of chunks.slice(1)) out.push(`UPDATE seo_snapshots SET json = json || ${q(c)} WHERE site_id = ${q(shipkit)} AND part = ${q(part)};`);
}
mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/seed.sql', out.join('\n'));
console.log(`Wrote .wrangler/seed.sql (${out.length} statements, ${payN + stripeN} web payments, ${txN} App Store transactions)`);
