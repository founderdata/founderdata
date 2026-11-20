import { Hono, type Context, type Next } from 'hono';
import { countedAllSql } from './datacenter';
import { deleteCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { handleAppEvents } from './app';
import { configureBudget, forgetAppRejected, noteAppRejected, noteWebhookRefused, refusedWebhooks, usageOf, usageSummary } from './budget';
import { handleAppleWebhook } from './appstore';
import { handleEvent } from './collect';
import { forgetSite, getSite, type AppEnv, type Site } from './env';
import { convertBefore, convertPayments, reconvertSite } from './fx';
import { home, homePulse, paymentsConnected, sitesWithPayments } from './home';
import { liveRoute } from './live';
import { alertWebhookRefused, rememberEnv, takeLater } from './alerts';
import { alerts } from './alerts-api';
import { ALERTS_CRON, retryWeeklyReport, runDailyAlerts, runWeeklyReport } from './digest';
import { ASC_CRON, planFor, type Plan } from './cron';
import type { ProJob } from './pro-hooks';
import { SubrequestBudget } from './subrequests';
import { batchingDb, newTrace, traceDb } from './lib/d1-trace';
import { ascPrefetch, ascPrefetchSpan } from './revenue';
import { RESEND_WEBHOOK_PATH } from './webhook-paths';
import { importRow } from './imports';
import { createNote, deleteNote, handleNoteApi, listNotes, noteImpactRoute, overviewOutages, reviewNoteRoute } from './notes';
import { AUTH_COOKIE, AUTH_DAYS, checkLogin, checkMemberLogin, crossOriginWrite, hasTeam, requireAuth, revokeStaleDevices, sessionCookie, sessionRole, startMemberSession } from './auth';
import { pro } from './edition';
import { installPro, proHooks } from './pro-hooks';
import { handleFavicon } from './favicon';
import { randomId } from './lib/crypto';
import { deleteIncome, handleDeletePaymentApi, handleGoalApi, handlePaymentApi, listIncome, rematchPayments } from './payments';
import { handleDodoWebhook } from './dodo';
import { pruneClickIds, pruneOldData, retentionOf } from './retention';
import { dataLocation } from './location';
import { handleRevenueCatWebhook } from './revenuecat';
import { handleStripeWebhook } from './stripe';
import { handleGumroadPing } from './gumroad';
import { handleLemonSqueezyWebhook } from './lemonsqueezy';
import { handlePaddleWebhook } from './paddle';
import { handlePolarWebhook } from './polar';
import { maskProviderSecrets, patchProviderSettings, PROVIDER_FIELDS } from './providers';
import { commissionOf, patchCommission } from './commission';
import { recordTick, registerSetupRoutes } from './setup-checklist';
import { registerStripeImportRoutes, stopIdleImports } from './stripe-import';
import { registerImportRoutes } from './imports';
import { attributionCoverage, breakdown, customers, funnel, makeCtx, overview, pageOf, revenueByProvider, visitorProfile, visitors, type FunnelStep } from './stats';
import { erasePerson, eraseVisitor } from './erase';
import { exportBreakdown, exportTable } from './export';
import { refreshTrackingSince } from './sources';
import { readKeyAnySite, registerShareRoutes } from './share';
import { registerAgentRoutes } from './agent-api';
import { keyOrLogin, registerKeyRoutes } from './keys';
import { registerMcpRoutes } from './mcp';
import { keepErasures, registerPrivacyRoutes } from './privacy';
import { dashboardLinks } from './dashboard-url';
import { registerPrimaryGoal } from './primary-goal';
import { registerProductType, typeOnCreate } from './product-type';
import { NO_MAIL_HANDLER } from './mail-reject';
import { settings } from './reporting';
import { patchRecording, recordingColumns } from './recording';

// Core modules read Pro through proHooks() (pro-hooks.ts); this is where the build's edition is installed.
installPro(pro);

const app = new Hono<AppEnv>();

// ---------- public: tracking, webhooks, server-side API

// A payment in another currency than its site's is converted to the site's currency once it is stored.
const convertAfter = async (c: Context<AppEnv>, next: Next) => {
  await next();
  // Resend's email events carry no payment.
  if (c.req.path === RESEND_WEBHOOK_PATH) return;
  c.executionCtx.waitUntil(convertPayments(c.env.DB).catch(() => 0));
};
app.use('/api/webhooks/*', convertAfter);
app.use('/api/v1/payments', convertAfter);

// The write cap alert (budget.ts) gets only the database; this lets it find the email settings. No I/O.
const keepEnv = async (c: Context<AppEnv>, next: Next) => {
  rememberEnv(c.env);
  await next();
};
app.use('/api/event', keepEnv);
app.use('/api/app/events', keepEnv);
// "Payment failed" and "Subscription canceled" alerts start while a webhook records the event (subscriptions.ts) and
// finish after the response.
const alertsAfter = async (c: Context<AppEnv>, next: Next) => {
  rememberEnv(c.env);
  await next();
  const p = takeLater(c.env.DB);
  if (p) c.executionCtx.waitUntil(p);
};
app.use('/api/webhooks/*', alertsAfter);
app.use('/api/app/events', alertsAfter);
// The write pool's size and per-site share come from Worker vars (budget.ts, WRITE_POOL_ROWS). No I/O.
app.use('/api/*', async (c, next) => {
  configureBudget(c.env);
  await next();
});
// How long a read took on the server, in the Server-Timing header the browser's network panel shows (docs/GUIDE.md,
// "Server timing"). `total` is the time from the first middleware to the answer; the Worker's clock moves only across
// I/O, so it is the time spent waiting on D1 (and the rate API, when one is called). `d1` is the number of D1 round trips
// the request made one after another, which is what that time follows when the Worker is far from the database, and its
// description says how many calls there were in all (lib/d1-trace.ts). `sql` is D1's own time for the statements and the
// rows they read, so `total` minus `sql` is mostly network. GET only; nothing stored.
const timed = async (c: Context<AppEnv>, next: Next) => {
  if (c.req.method !== 'GET') return next();
  const start = Date.now();
  const trace = newTrace();
  const placement = c.req.header('cf-placement');
  c.env = { ...c.env, DB: batchingDb(traceDb(c.env.DB, trace)) };
  await next();
  try {
    c.res.headers.set(
      'server-timing',
      `total;dur=${Date.now() - start};desc="Worker and D1", d1;dur=${trace.depth};desc="D1 round trips in sequence, ${trace.calls} calls"` +
        `, sql;dur=${Math.round(trace.sqlMs * 10) / 10};desc="${trace.rowsRead} rows read"` +
        // Where Smart Placement ran this request, when it is on (docs/GUIDE.md, "Run the Worker next to its database").
        (placement ? `, placement;desc="${placement.replace(/[^\w-]/g, '')}"` : ''),
    );
  } catch {
    // A response with immutable headers keeps them.
  }
};
app.use('/api/*', timed);
// A read answer the dashboard shows says where: X-Dashboard-Url and a dashboard_url field (dashboard-url.ts). No I/O.
app.use('/api/v1/*', dashboardLinks);
app.use('/api/event', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], maxAge: 86400 }));
app.post('/api/event', handleEvent);
// An app batch for a site without a bundle id gets a 403 (app.ts). Note it, at most every 10 minutes, so the
// dashboard can show a banner. Hono keeps the body the handler read.
app.use('/api/app/events', async (c, next) => {
  await next();
  if (c.res.status !== 403) return;
  const id = await c.req.json<{ w?: unknown }>().then((b) => b?.w, () => undefined);
  if (typeof id !== 'string') return;
  const site = await getSite(c.env.DB, id);
  if (site && !site.app_bundle_id) c.executionCtx.waitUntil(noteAppRejected(c.env.DB, site.id, Date.now()));
});
app.post('/api/app/events', handleAppEvents);
// A webhook delivery refused for a bad signature or token (401) is counted per site and provider, at most one write
// every 10 minutes per instance, and alerts once a day (budget.ts noteWebhookRefused, docs/GUIDE.md).
const WEBHOOK_PROVIDERS: Record<string, string> = {
  dodo: 'dodo', apple: 'app_store', stripe: 'stripe', revenuecat: 'revenuecat', lemonsqueezy: 'lemonsqueezy', polar: 'polar', paddle: 'paddle', gumroad: 'gumroad',
};
app.use('/api/webhooks/*', async (c, next) => {
  await next();
  if (c.res.status !== 401) return;
  const [, , , name, siteId] = c.req.path.split('/');
  const provider = WEBHOOK_PROVIDERS[name];
  const site = provider && siteId ? await getSite(c.env.DB, siteId) : null;
  if (!site) return;
  const now = Date.now();
  c.executionCtx.waitUntil(
    noteWebhookRefused(c.env.DB, site.id, provider, now).then((first) => (first ? alertWebhookRefused(c.env, site, provider, first, now) : 0)),
  );
});
app.post('/api/webhooks/dodo/:siteId', handleDodoWebhook);
app.post('/api/webhooks/apple/:siteId', handleAppleWebhook);
app.post('/api/webhooks/stripe/:siteId', handleStripeWebhook);
app.post('/api/webhooks/revenuecat/:siteId', handleRevenueCatWebhook);
// Lemon Squeezy, Polar, Paddle and Gumroad (src/worker/providers.ts; Gumroad's URL carries its secret).
app.post('/api/webhooks/lemonsqueezy/:siteId', handleLemonSqueezyWebhook);
app.post('/api/webhooks/polar/:siteId', handlePolarWebhook);
app.post('/api/webhooks/paddle/:siteId', handlePaddleWebhook);
app.post('/api/webhooks/gumroad/:siteId/:token', handleGumroadPing);
app.post('/api/v1/payments', handlePaymentApi);
app.delete('/api/v1/payments/:transaction_id', handleDeletePaymentApi);
app.post('/api/v1/goals', handleGoalApi);
app.post('/api/v1/notes', handleNoteApi);

// ---------- login

app.post('/api/auth/login', async (c) => {
  const { password, login } = await c.req.json<{ password?: string; login?: string }>().catch(() => ({ password: undefined, login: undefined }));
  // A name or email means a teammate (team.ts); without one, the shared passwords below.
  if (typeof login === 'string' && login.trim()) {
    const member = await checkMemberLogin(c, login, password);
    if (member instanceof Response) return member;
    await startMemberSession(c, member.id, member.version);
    return c.json({ ok: true, role: member.role === 'owner' ? 'admin' : 'viewer', name: member.name });
  }
  // The admin password, or VIEWER_PASSWORD for a read-only session (auth.ts).
  const role = await checkLogin(c, password);
  if (role instanceof Response) return role;
  const expires = Date.now() + AUTH_DAYS * 86_400_000;
  // Signed with a key bound to the role's password: a new password signs every browser of that role out (auth.ts).
  setCookie(c, AUTH_COOKIE, await sessionCookie(c.env, role, expires), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: AUTH_DAYS * 86_400,
  });
  return c.json({ ok: true, role });
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const role = await sessionRole(c);
  // `team` tells the login screen to ask for a name or email as well.
  // `name` appears for a teammate and `team` only when signed out with a team in place, so the answer for the
  // shared passwords stays as it was.
  const name = c.get('member')?.name;
  return c.json({ loggedIn: !!role, role, ...(name ? { name } : {}), ...(!role && (await hasTeam(c)) ? { team: true } : {}) });
});

// FounderData Pro's routes that need no login: the Resend webhook, team invites, AI crawler hits (pro-hooks.ts).
pro?.publicRoutes?.(app);

// ---------- dashboard API (login required)

app.use('/api/sites', requireAuth);
// A scoped key with seo:write or aso:write may push the SEO snapshot and the ASO data here; the rest needs the login
// (keys.ts keyOrLogin, KEY_ROUTES).
app.use('/api/sites/*', keyOrLogin);
app.use('/api/home', requireAuth);
app.use('/api/live', requireAuth);
app.use('/api/usage', requireAuth);
app.use('/api/setup', requireAuth);
app.use('/api/setup/*', requireAuth);
app.use('/api/favicon/*', requireAuth);
// FounderData Pro's mail in the dashboard: the owner only (auth.ts refuses viewers, viewer teammates and phones), and a
// write must come from the dashboard's own page. The Resend-compatible /api/mail/* takes an API key instead (keys.ts
// accountKeyOf).
const sameOriginWrites = async (c: Context<AppEnv>, next: Next) => {
  if (crossOriginWrite(c)) return c.json({ error: 'Mail changes must come from the dashboard.' }, 403);
  await next();
};
app.use('/api/mail-admin', requireAuth, sameOriginWrites);
app.use('/api/mail-admin/*', requireAuth, sameOriginWrites);

const loadSite = async (c: Context<AppEnv>, next: Next) => {
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(c.req.param('id')).first<Site>();
  if (!site) return c.json({ error: 'site not found' }, 404);
  c.set('site', site);
  await next();
};
// A site's overview, the first call of a site's dashboard: start the reads that need only the site id together with
// loadSite's, so they share its round trip. Conversion of pending payments (with its quiet time, fx.ts), Apple's report
// rows over a span that covers the period in any timezone (revenue.ts ascPrefetch), and the import row.
const overviewPrefetch = async (c: Context<AppEnv>, next: Next) => {
  if (c.req.method === 'GET') {
    const db = c.env.DB;
    const id = c.req.param('id')!;
    const span = ascPrefetchSpan(c.req.query('period') ?? '30d', Date.now());
    const pre = {
      converting: convertPayments(db, fetch, { reads: true }).catch(() => 0),
      asc: ascPrefetch(db, span.from, span.to, [id]).catch(() => null),
      importRow: importRow(db, id),
    };
    // A 404 from loadSite leaves them unread; their errors must not go unhandled.
    pre.importRow.catch(() => undefined);
    c.set('prefetch', pre);
  }
  await next();
};
app.use('/api/sites/:id/overview', overviewPrefetch);
app.use('/api/sites/:id', loadSite);
app.use('/api/sites/:id/*', loadSite);

// /api/home and the overview convert in their own first round trip instead (home.ts opts.convert, overviewPrefetch).

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
const APP_STORE_ID = /^\d{5,12}$/;

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const publicSite = (s: Site) => ({
  ...s,
  dodo_webhook_secret: s.dodo_webhook_secret ? '••••••••' : null,
  stripe_webhook_secret: s.stripe_webhook_secret ? '••••••••' : null,
  revenuecat_auth: s.revenuecat_auth ? '••••••••' : null,
  ...maskProviderSecrets(s),
});

app.get('/api/sites', async (c) => {
  const now = Date.now();
  // One round trip: the batch and the two summaries run at the same time.
  const [[sites, stats, subs, meta, spent], usage, paid] = await Promise.all([
    c.env.DB.batch([
      c.env.DB.prepare('SELECT * FROM sites ORDER BY created_at'),
      c.env.DB.prepare(
        `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors,
                COUNT(DISTINCT CASE WHEN last_seen_at > ? THEN visitor_id END) AS online
         FROM sessions WHERE started_at > ?${countedAllSql('sessions')} GROUP BY site_id`,
      ).bind(now - 5 * 60_000, now - 86_400_000),
      // Per site, a seek on the subscriptions primary key (site_id, id) that stops at the first live row, instead
      // of a scan of every subscription.
      c.env.DB.prepare('SELECT st.id AS site_id FROM sites st WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.site_id = st.id AND s.sandbox = 0)'),
      // Sites with a Meta ad account: the Meta ads section is not muted.
      c.env.DB.prepare('SELECT site_id FROM meta_settings WHERE ad_account_id IS NOT NULL'),
      // Sites with spend sent from another channel (ad_spend): the Paid overview is not muted. A seek per site.
      c.env.DB.prepare('SELECT st.id AS site_id FROM sites st WHERE EXISTS (SELECT 1 FROM ad_spend a WHERE a.site_id = st.id)'),
    ]),
    usageSummary(c.env.DB, now),
    sitesWithPayments(c.env.DB),
  ]);
  const withSubs = new Set((subs.results as { site_id: string }[]).map((r) => r.site_id));
  const withMeta = new Set((meta.results as { site_id: string }[]).map((r) => r.site_id));
  const withSpend = new Set((spent.results as { site_id: string }[]).map((r) => r.site_id));
  const asa = !!pro?.asaConfigured?.(c.env);
  const by = new Map((stats.results as any[]).map((r) => [r.site_id, r]));
  return c.json(
    (sites.results as unknown as Site[]).map((s) => ({
      ...publicSite(s),
      visitors24h: by.get(s.id)?.visitors ?? 0,
      online: by.get(s.id)?.online ?? 0,
      // The site has subscription rows, so the dashboard shows its Subscriptions tab.
      has_subscriptions: withSubs.has(s.id),
      // The site names a Meta ad account (meta_settings); without one the Meta ads section is muted.
      has_meta: withMeta.has(s.id),
      // An app on a deployment with the ASA_* secrets; without them the Apple Search Ads section is muted. No I/O.
      has_asa: !!s.app_bundle_id && asa,
      // Spend sent through POST /api/v1/spend or a CSV; with Meta or Apple Search Ads, the Paid overview is not muted.
      has_spend: withSpend.has(s.id),
      // False: no payment provider set up and no payment ever; the dashboard hides revenue (home.ts paymentsConnected).
      payments_connected: paymentsConnected(s, paid.has(s.id)),
      // Today's cap was reached at this time (ms); events after it were dropped.
      // For a site on the automatic cap, the time the shared pool ran out.
      capped_at: usage.cappedAt(s),
      // An app batch was refused in the last 24 hours because the site has no bundle id (ms), else null.
      app_rejected_at: s.app_bundle_id ? null : (usage.appRejectedAt.get(s.id) ?? null),
    })),
  );
});

app.post('/api/sites', async (c) => {
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const bundle = typeof b.app_bundle_id === 'string' ? b.app_bundle_id.trim() : '';
  if (bundle && !BUNDLE_ID.test(bundle)) return c.json({ error: 'Enter a bundle id like com.example.app' }, 400);
  // An app without a website gets a placeholder domain under .invalid, which no browser can send events from.
  const domain = b.domain?.trim() ? cleanDomain(b.domain) : bundle ? `${bundle.toLowerCase()}.invalid` : '';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return c.json({ error: bundle || b.domain?.trim() ? 'Enter a domain like example.com' : 'Enter a domain like example.com or a bundle id like com.example.app' }, 400);
  }
  const tz = b.timezone && validTimezone(b.timezone) ? b.timezone : 'UTC';
  // website, app, extension or newsletter (src/worker/product-type.ts); none means automatic.
  const typed = typeOnCreate((b as { type?: unknown }).type, bundle || null);
  if ('error' in typed) return c.json({ error: typed.error }, 400);
  const site: Site = {
    id: randomId(8),
    name: (b.name?.trim() || (b.domain?.trim() ? domain : bundle || domain)).slice(0, 100),
    domain,
    timezone: tz,
    currency: (b.currency || 'USD').toUpperCase().slice(0, 3),
    api_key: 'rt_' + randomId(16),
    dodo_webhook_secret: null,
    created_at: Date.now(),
    app_bundle_id: bundle || null,
    accept_sandbox: 0,
    stripe_webhook_secret: null,
    stripe_unpinned: 1,
    revenuecat_auth: null,
    asc_app_id: null,
    asc_sku: null,
    app_store_id: null,
    write_cap_on: 1,
    write_cap: null,
    product_type: typed.type,
  };
  await c.env.DB.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, created_at, app_bundle_id, product_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, null, site.created_at, site.app_bundle_id, site.product_type)
    .run();
  return c.json(publicSite(site));
});

app.get('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const [usage, last, refused, dc] = await Promise.all([
    usageOf(c.env.DB, site, Date.now()),
    // For the status line of each payment provider in Settings.
    c.env.DB.prepare('SELECT provider, MAX(ts) AS ts FROM payments WHERE site_id = ? GROUP BY provider').bind(site.id).all<{ provider: string; ts: number }>(),
    // Deliveries refused for a bad signature in the last 24 hours, per provider (budget.ts).
    refusedWebhooks(c.env.DB, Date.now(), site.id),
    // Visits from hosting networks in the last 30 days, for the Datacenter visits card (src/worker/datacenter.ts).
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE site_id = ? AND started_at > ? AND datacenter = 1')
      .bind(site.id, Date.now() - 30 * 86_400_000)
      .first<{ n: number }>(),
  ]);
  return c.json({
    ...publicSite(site),
    usage,
    datacenter_visits: Number(dc?.n ?? 0),
    last_payments: Object.fromEntries(last.results.map((r) => [r.provider, r.ts])),
    refused_webhooks: Object.fromEntries(refused.map((r) => [r.provider, { count: r.count, day: r.day, at: r.at }])),
    data_location: dataLocation(c.env),
    // The R2 bucket for recorded visits is bound (`npm run setup -- --replay`), for the Record visits card.
    replay_bucket: !!c.env.REPLAY_BUCKET,
  });
});

app.patch('/api/sites/:id', async (c) => {
  const site = c.get('site');
  const b = await c.req.json<Partial<Site>>().catch(() => ({}) as Partial<Site>);
  const next = { ...site };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 100);
  if (typeof b.domain === 'string') {
    const d = cleanDomain(b.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: 'Enter a domain like example.com' }, 400);
    next.domain = d;
  }
  if (typeof b.timezone === 'string') {
    if (!validTimezone(b.timezone)) return c.json({ error: 'Unknown timezone' }, 400);
    next.timezone = b.timezone;
  }
  if (typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency)) next.currency = b.currency.toUpperCase();
  if (typeof b.dodo_webhook_secret === 'string' && !b.dodo_webhook_secret.includes('•')) {
    next.dodo_webhook_secret = b.dodo_webhook_secret.trim() || null;
  }
  if (typeof b.app_bundle_id === 'string' || b.app_bundle_id === null) {
    const bundle = (b.app_bundle_id ?? '').trim();
    if (bundle && !BUNDLE_ID.test(bundle)) return c.json({ error: 'Enter a bundle id like com.example.app' }, 400);
    next.app_bundle_id = bundle || null;
    // The App Store id belongs to the bundle id; the sales import resolves it again for a new one.
    if (next.app_bundle_id !== site.app_bundle_id) {
      next.asc_app_id = null;
      next.asc_sku = null;
      next.app_store_id = null;
    }
  }
  // The number in the app's App Store link (apps.apple.com/app/id123456789), for Apple Search Ads and ASO.
  if (typeof b.app_store_id === 'string' || b.app_store_id === null) {
    const id = (b.app_store_id ?? '').trim().replace(/^id/i, '');
    if (id && !APP_STORE_ID.test(id)) return c.json({ error: 'Enter the App Store id as digits, like 123456789' }, 400);
    next.app_store_id = id || null;
  }
  if (b.accept_sandbox !== undefined) next.accept_sandbox = b.accept_sandbox ? 1 : 0;
  if (b.stripe_unpinned !== undefined) next.stripe_unpinned = b.stripe_unpinned ? 1 : 0;
  if (typeof b.stripe_webhook_secret === 'string' && !b.stripe_webhook_secret.includes('•')) {
    const secret = b.stripe_webhook_secret.trim();
    if (secret && !/^whsec_\w+$/.test(secret)) return c.json({ error: 'A Stripe signing secret starts with whsec_' }, 400);
    next.stripe_webhook_secret = secret || null;
  }
  if (b.write_cap_on !== undefined) next.write_cap_on = b.write_cap_on ? 1 : 0;
  if (b.show_datacenter !== undefined) next.show_datacenter = b.show_datacenter ? 1 : 0;
  if (b.write_cap !== undefined) {
    // null or 0: back to the automatic cap.
    const cap = b.write_cap === null ? 0 : Number(b.write_cap);
    if (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000_000) return c.json({ error: 'Enter the cap as a whole number of rows, or leave it empty' }, 400);
    next.write_cap = cap || null;
  }
  if (b.vitals_sample !== undefined) {
    // Percent of page loads whose Core Web Vitals are stored (vitals.ts); 0 turns them off.
    const pct = Number(b.vitals_sample);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return c.json({ error: 'Enter the vitals sample as a whole percent from 0 to 100' }, 400);
    next.vitals_sample = pct;
  }
  // Record visits and Remember visitors (migration 0072, docs/GUIDE.md "People and recordings (Pro)").
  const recordError = patchRecording(b as Record<string, unknown>, next);
  if (recordError) return c.json({ error: recordError }, 400);
  if (typeof b.revenuecat_auth === 'string' && !b.revenuecat_auth.includes('•')) {
    const secret = b.revenuecat_auth.trim().replace(/^Bearer\s+/i, '');
    if (secret && !/^[\x21-\x7e]{16,200}$/.test(secret)) {
      return c.json({ error: 'The RevenueCat secret needs 16 to 200 characters without spaces' }, 400);
    }
    next.revenuecat_auth = secret || null;
  }
  const providerError = patchProviderSettings(b as Record<string, unknown>, next);
  if (providerError) return c.json({ error: providerError }, 400);
  const commissionError = patchCommission(b as Record<string, unknown>, next);
  if (commissionError) return c.json({ error: commissionError }, 400);
  // One UPDATE, so the change is all or nothing and writes 1 row. The provider and commission columns are set only
  // when the body has them: the first Gumroad ping may have saved a seller id this isolate has not seen yet.
  const extra: [string, unknown][] = [];
  if (PROVIDER_FIELDS.some((k) => k in b)) {
    extra.push(
      ['lemonsqueezy_secret', next.lemonsqueezy_secret ?? null],
      ['polar_secret', next.polar_secret ?? null],
      ['paddle_secret', next.paddle_secret ?? null],
      ['gumroad_seller_id', next.gumroad_seller_id ?? null],
      ['gumroad_token', next.gumroad_token ?? null],
    );
  }
  if ('app_commission' in b) extra.push(['app_commission', commissionOf(next)]);
  if ('vitals_sample' in b) extra.push(['vitals_sample', next.vitals_sample ?? 100]);
  if ('show_datacenter' in b) extra.push(['show_datacenter', next.show_datacenter ?? 0]);
  extra.push(...recordingColumns(b as Record<string, unknown>, site, next));
  await c.env.DB.prepare(
    `UPDATE sites SET name = ?, domain = ?, timezone = ?, currency = ?, dodo_webhook_secret = ?, app_bundle_id = ?, accept_sandbox = ?,
       stripe_webhook_secret = ?, stripe_unpinned = ?, revenuecat_auth = ?, asc_app_id = ?, asc_sku = ?, app_store_id = ?, write_cap_on = ?, write_cap = ?${extra
         .map(([col]) => `, ${col} = ?`)
         .join('')} WHERE id = ?`,
  )
    .bind(
      next.name,
      next.domain,
      next.timezone,
      next.currency,
      next.dodo_webhook_secret,
      next.app_bundle_id,
      next.accept_sandbox,
      next.stripe_webhook_secret,
      next.stripe_unpinned ?? 1,
      next.revenuecat_auth,
      next.asc_app_id,
      next.asc_sku,
      next.app_store_id ?? null,
      next.write_cap_on ?? 1,
      next.write_cap ?? null,
      ...extra.map(([, v]) => v),
      site.id,
    )
    .run();
  forgetSite(site.id);
  if (next.currency !== site.currency) await reconvertSite(c.env.DB, site.id).catch(() => undefined);
  return c.json({ ...publicSite(next), usage: await usageOf(c.env.DB, next, Date.now()), replay_bucket: !!c.env.REPLAY_BUCKET });
});

app.post('/api/sites/:id/rotate-key', async (c) => {
  const key = 'rt_' + randomId(16);
  await c.env.DB.prepare('UPDATE sites SET api_key = ? WHERE id = ?').bind(key, c.get('site').id).run();
  return c.json({ api_key: key });
});

app.delete('/api/sites/:id', async (c) => {
  const id = c.get('site').id;
  await c.env.DB.batch(
    ['events', 'sessions', 'visitors', 'payments', 'payment_claims', 'stripe_objects', 'funnels', 'subscription_signals', 'subscriptions', 'device_site_prefs', 'device_product_prefs', 'seo_snapshots', 'site_usage', 'share_tokens', 'notes', 'stripe_imports', 'aso_keywords', 'aso_settings', 'aso_snapshots', 'aso_reviews', 'alert_rules', 'app_aliases', 'email_messages', 'email_daily', 'research', 'ai_answers', 'vitals', 'imports', 'imported_daily', 'rank_settings', 'rank_keywords', 'rank_removed', 'aso_rank_tasks', 'ranks', 'dfs_spend', 'ai_prompts', 'ai_settings', 'ai_spend', 'ai_crawler_hits', 'ai_failures', 'ai_claims', 'ai_tasks', 'ai_crawler_days', 'x_settings', 'x_posts', 'gsc_sites', 'stripe_check_history', 'location_errors', 'meta_settings', 'meta_capi_log', 'ad_spend', 'action_items', 'alert_events', 'replays', 'plans', 'plan_versions', 'plan_tasks', 'plan_sessions', 'plan_reviews'].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE site_id = ?`).bind(id),
    ).concat(
      // Subscription history imports: their stored activity pages first, then the imports.
      c.env.DB.prepare('DELETE FROM sub_import_pages WHERE import_id IN (SELECT id FROM sub_imports WHERE site_id = ?)').bind(id),
      c.env.DB.prepare('DELETE FROM sub_imports WHERE site_id = ?').bind(id),
      // Apple's sales rows are not the site's data: they stay, unmatched, and match again if the app comes back.
      c.env.DB.prepare('UPDATE asc_sales SET site_id = NULL WHERE site_id = ?').bind(id),
      // Mail domains belong to the deployment: they stay, without the link to this site's email numbers.
      c.env.DB.prepare('UPDATE mail_domains SET site_id = NULL WHERE site_id = ?').bind(id),
      forgetAppRejected(c.env.DB, id),
      // The erase log stays, with the site's name: it is the proof that requests were answered (privacy.ts).
      keepErasures(c.env.DB, c.get('site')),
      // Alert channels limited to some sites stop naming this one.
      c.env.DB.prepare(
        `UPDATE alert_channels SET sites = (SELECT json_group_array(value) FROM json_each(alert_channels.sites) WHERE value != ?1)
         WHERE sites IS NOT NULL AND json_valid(sites) AND EXISTS (SELECT 1 FROM json_each(alert_channels.sites) WHERE value = ?1)`,
      ).bind(id),
      // The first web and app visit the nightly scan found (src/worker/sources.ts).
      c.env.DB.prepare('DELETE FROM cron_state WHERE key = ?').bind(`since:${id}`),
      c.env.DB.prepare('DELETE FROM sites WHERE id = ?').bind(id),
    ),
  );
  forgetSite(id);
  pro?.forgetSite?.(id);
  return c.json({ ok: true });
});

// ---------- stats

// CSV export, erasing one person, share links and the read API (src/worker/export.ts, erase.ts, share.ts).
app.get('/api/sites/:id/breakdown', async (c, next) => {
  if (c.req.query('format') !== 'csv') return next();
  try {
    return await exportBreakdown(c);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.get('/api/sites/:id/export/:table', exportTable);
app.delete('/api/sites/:id/visitors/:vid', eraseVisitor);
app.post('/api/sites/:id/erase', erasePerson);
registerShareRoutes(app);
// The rest of the read API for agents and scripts (src/worker/agent-api.ts).
registerAgentRoutes(app);
// Scoped API keys: GET, POST /api/v1/keys and DELETE /api/v1/keys/:id, admin login only (src/worker/keys.ts).
registerKeyRoutes(app);
// The MCP server at /mcp, over the same read routes, and /api/v1/openapi.json (src/worker/mcp.ts, docs/MCP.md).
registerMcpRoutes(app);
// The erase log: when a person was erased and how many rows went, no identifiers (src/worker/privacy.ts).
registerPrivacyRoutes(app);

app.get('/api/sites/:id/overview', async (c) => {
  const ctx = makeCtx(c);
  const pre = c.get('prefetch');
  if (pre) {
    ctx.converting = pre.converting;
    ctx.importRow = pre.importRow;
    ctx.ascPrefetch = await pre.asc;
  }
  // Outage notes (kind outage) in either side of the comparison: the chart and the KPIs have a gap there.
  const [o, outages] = await Promise.all([overview(ctx), overviewOutages(c.env.DB, ctx.site, ctx.range, ctx.period).catch(() => [])]);
  return c.json({ ...o, outages });
});

app.get('/api/sites/:id/breakdown', async (c) => {
  try {
    return c.json(await breakdown(makeCtx(c), c.req.query('dim') ?? 'source', Number(c.req.query('limit')) || 100));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get('/api/sites/:id/revenue', async (c) => c.json(await revenueByProvider(makeCtx(c))));
// Other revenue rows, to correct a wrong one (src/worker/payments.ts).
app.get('/api/sites/:id/income', listIncome);
app.delete('/api/sites/:id/income/:transaction_id', deleteIncome);
// How many payments are linked to a visit, per provider (docs/GUIDE.md, "Payments not linked to a visit").
app.get('/api/sites/:id/coverage', async (c) => c.json(await attributionCoverage(makeCtx(c))));
app.post('/api/sites/:id/rematch', async (c) => c.json(await rematchPayments(c.env.DB, c.get('site'))));
// Stripe history import, run in steps by the dashboard (src/worker/stripe-import.ts).
registerStripeImportRoutes(app);
// Web history imported from Plausible: daily aggregates sent in chunks by the dashboard (src/worker/imports.ts).
registerImportRoutes(app);
// The setup checklist and its two test buttons, owner only (src/worker/setup-checklist.ts, docs/GUIDE.md).
registerSetupRoutes(app);
// Lists come in pages (?offset=&limit=, 200 by default); X-Next-Offset is set when another page exists.
app.get('/api/sites/:id/customers', async (c) => {
  const { rows, next } = await customers(makeCtx(c), pageOf(c.req.query()));
  return c.json(rows, 200, next === null ? {} : { 'x-next-offset': String(next) });
});
app.get('/api/sites/:id/visitors', async (c) => {
  const { rows, next } = await visitors(makeCtx(c), pageOf(c.req.query()));
  return c.json(rows, 200, next === null ? {} : { 'x-next-offset': String(next) });
});
app.get('/api/sites/:id/visitors/:vid', async (c) =>
  c.json(await visitorProfile(c.env.DB, c.get('site'), c.req.param('vid'))),
);

// Every site side by side with totals, sources, latest payments and alerts (the home page).
app.get('/api/home', async (c) => {
  const q = c.req.query();
  // Pending payments convert inside home's first round trip, not before it (convertBefore).
  return c.json(q.parts === 'pulse' ? await homePulse(c.env.DB, q, Date.now(), { convert: true }) : await home(c.env.DB, q, Date.now(), { convert: true }));
});

// Who is on the sites right now, for the globe (src/worker/live.ts, docs/MOBILE-API.md section 9). Reads only.
app.get('/api/live', liveRoute);

// Today's daily write cap across sites, for the badges on the home page (docs/GUIDE.md, "Daily write cap").
app.get('/api/usage', async (c) => {
  const now = Date.now();
  const [sites, usage] = await Promise.all([
    c.env.DB.prepare('SELECT id, write_cap_on, write_cap FROM sites').all<Site>(),
    usageSummary(c.env.DB, now),
  ]);
  const capped: Record<string, number> = {};
  for (const s of sites.results) {
    const at = usage.cappedAt(s);
    if (at) capped[s.id] = at;
  }
  // `pool`: rows all sites wrote today against the shared pool, for the line under the home page's cards.
  return c.json({ capped, pool: usage.pool });
});

app.get('/api/sites/:id/funnels', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at').bind(c.get('site').id).all();
  return c.json(res.results.map((f: any) => ({ ...f, steps: JSON.parse(f.steps) })));
});

app.post('/api/sites/:id/funnels', async (c) => {
  const b = await c.req.json<{ name?: string; steps?: FunnelStep[] }>().catch(() => ({}) as { name?: string; steps?: FunnelStep[] });
  const steps = (b.steps ?? [])
    .filter((s) => (s.type === 'page' || s.type === 'goal') && typeof s.value === 'string' && s.value.trim())
    .slice(0, 10)
    .map((s) => ({ type: s.type, value: s.value.trim().slice(0, 200) }));
  if (!b.name?.trim() || steps.length < 2) return c.json({ error: 'A funnel needs a name and at least 2 steps' }, 400);
  const id = randomId(8);
  await c.env.DB.prepare('INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('site').id, b.name.trim().slice(0, 100), JSON.stringify(steps), Date.now())
    .run();
  return c.json({ id, name: b.name.trim(), steps });
});

app.delete('/api/sites/:id/funnels/:fid', async (c) => {
  await c.env.DB.prepare('DELETE FROM funnels WHERE id = ? AND site_id = ?').bind(c.req.param('fid'), c.get('site').id).run();
  return c.json({ ok: true });
});

app.get('/api/sites/:id/funnels/:fid/stats', async (c) => {
  const f = await c.env.DB.prepare('SELECT * FROM funnels WHERE id = ? AND site_id = ?')
    .bind(c.req.param('fid'), c.get('site').id)
    .first<{ steps: string }>();
  if (!f) return c.json({ error: 'funnel not found' }, 404);
  return c.json(await funnel(makeCtx(c), JSON.parse(f.steps)));
});

// ---------- chart notes (src/worker/notes.ts); deploy scripts use POST /api/v1/notes

registerPrimaryGoal(app);
registerProductType(app);
app.get('/api/sites/:id/notes', listNotes);
app.post('/api/sites/:id/notes', createNote);
app.delete('/api/sites/:id/notes/:nid', deleteNote);
app.post('/api/sites/:id/notes/:nid/review', reviewNoteRoute);
app.use('/api/sites/:id/notes/:nid/impact', convertBefore);
app.get('/api/sites/:id/notes/:nid/impact', noteImpactRoute);

// Site icons fetched by the Worker, so the dashboard never asks a third party (src/worker/favicon.ts).
app.get('/api/favicon/:domain', (c) => handleFavicon(c));

// Alert channels, deployment-wide, login required (src/worker/alerts.ts).
app.route('/api/alerts', alerts);
// The reporting timezone Home, the phone's Home and the read API count days in (src/worker/reporting.ts).
app.route('/api/settings', settings);

// FounderData Pro's routes behind login or an API key (pro-hooks.ts). Last, so core's routes win where paths overlap.
pro?.routes?.(app);

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Everything else is the dashboard (static files).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export { app };


/**
 * One tick or hourly invocation: the jobs of `plan`, one after the other, on one subrequest budget. The D1 binding and the
 * fetch the jobs get count every call against it, and a job that cannot pay for its next call stops cleanly (subrequests.ts).
 * A job that throws is logged and the next one still runs. FounderData Pro adds its jobs by phase (pro-hooks.ts ProJob).
 */
export async function runPlan(rawEnv: AppEnv['Bindings'], now: number, plan: Plan, budget = new SubrequestBudget()) {
  const env = budget.env(rawEnv);
  const f = budget.fetch((url: any, init?: any) => fetch(url, init)) as typeof fetch;
  const ctx = { env, now, plan, budget, fetch: f };
  const step = async (name: string, job: () => Promise<unknown>) => {
    try {
      await job();
    } catch (e) {
      console.error(`${name} failed`, e);
    }
  };
  const proPhase = async (phase: ProJob['phase']) => {
    for (const j of pro?.jobs ?? []) if (j.phase === phase && j.when(plan, budget)) await step(j.name, () => j.run(ctx));
  };
  const slot = async () => {
    if (plan.hour) await step('Idle import sweep', () => stopIdleImports(env.DB));
    // 07:00: version notes, "worth a look" and the other daily alerts (src/worker/digest.ts).
    if (plan.daily) await step('Daily alerts', () => runDailyAlerts(env, now, f));
    // Monday 07:05 the weekly report on a tick of its own, later Monday hours a retry for a channel that did not get it.
    if (plan.weekly) await step('Weekly report', () => runWeeklyReport(env, now, f));
    else if (plan.weeklyRetry) await step('Weekly report retry', () => retryWeeklyReport(env, now, f));
    await proPhase('slot');
  };
  // The heartbeat the setup checklist shows (setup-checklist.ts): at minutes 0, 15, 30 and 45 of the tick cron, every run of
  // the old hourly cron. One upsert on the metered binding, before the jobs, so the budget counts it (1 of the 48) and the
  // reserve of 2 stays whole.
  if (!plan.slotFirst || new Date(now).getUTCMinutes() % 15 < plan.tickMinutes) {
    await step('Tick heartbeat', () => recordTick(env.DB, plan.slotFirst ? 'five' : 'hourly', now));
  }
  await slot();
  await proPhase('tick');
  if (plan.slotFirst) {
    await proPhase('feed');
    if (plan.work) await proPhase('work');
  } else {
    if (plan.work) await proPhase('work');
    await proPhase('feed');
  }
}

export default {
  fetch: app.fetch,
  // Inbound mail from Cloudflare Email Routing, one message per recipient. FounderData Pro handles it (pro-hooks.ts);
  // core has nowhere to put it and rejects it, so the sender learns at once instead of thinking it arrived.
  async email(message: ForwardableEmailMessage, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    const hook = proHooks()?.email;
    if (!hook) {
      message.setReject(NO_MAIL_HANDLER);
      return;
    }
    await hook(message, env, ctx);
  },
  // The MAIL_QUEUE consumer (FounderData Pro mail). Without Pro nothing reads these messages: ack them so they do not
  // retry until they expire.
  async queue(batch: MessageBatch<unknown>, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    const hook = proHooks()?.queue;
    if (!hook) {
      batch.ackAll();
      return;
    }
    await hook(batch, env, ctx);
  },
  async scheduled(event: ScheduledController, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    // Three crons: 03:17 trims old visit data and email dedupe rows and imports Apple Search Ads, 10:30 re-imports the last three App Store sales days, and every 5 minutes (TICK_CRON) the tick.
    // Every tick collects and posts DataForSEO rank checks and runs a few AI checks. One tick an hour runs each hourly job,
    // so no invocation passes the 50 subrequests of the Free plan (src/worker/cron.ts has the slots): minute 0 the phone
    // pushes and alert rules (and at 07:00 the alerts), minute 15 the X poll, minute 30 the Search Console sync. A deployment
    // that kept the old hourly cron ('0 * * * *') runs everything once an hour. All jobs of an invocation draw on one
    // SubrequestBudget and run one after the other.
    const plan = planFor(event.cron, event.scheduledTime);
    // FounderData Pro's own crons (the App Store sales import) and its share of the nightly and old daily crons.
    for (const p of pro?.scheduled?.(event.cron, env, event.scheduledTime) ?? []) ctx.waitUntil(p.catch((e) => console.error('Pro cron failed', e)));
    if (plan) {
      ctx.waitUntil(runPlan(env, event.scheduledTime, plan));
      return;
    }
    // The old '0 7 * * *' cron, or a daily cron: 07:00 alerts for a deployment that still lists it.
    if (event.cron === ALERTS_CRON) {
      ctx.waitUntil(stopIdleImports(env.DB).catch(() => 0));
      ctx.waitUntil(runDailyAlerts(env, event.scheduledTime).catch((e) => console.error('Daily alerts failed', e)));
      ctx.waitUntil(runWeeklyReport(env, event.scheduledTime).catch((e) => console.error('Weekly report failed', e)));
      return;
    }
    // The App Store sales cron is FounderData Pro's alone; every other cron is the nightly one (03:17).
    if (event.cron === ASC_CRON) return;
    ctx.waitUntil(stopIdleImports(env.DB).catch(() => 0));
    ctx.waitUntil(pruneOldData(env.DB, Date.now(), retentionOf(env)));
    ctx.waitUntil(revokeStaleDevices(env).catch(() => 0));
    ctx.waitUntil(convertPayments(env.DB).catch(() => 0));
    // Each site's first web and first app visit, for tracking_since (src/worker/sources.ts): at most 1 row a site.
    ctx.waitUntil(refreshTrackingSince(env.DB).catch(() => 0));
    // Google, Microsoft and other ad click ids past 90 days (src/worker/retention.ts).
    ctx.waitUntil(pruneClickIds(env.DB).catch(() => 0));
  },
} satisfies ExportedHandler<AppEnv['Bindings']>;
