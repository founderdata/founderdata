export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Dashboard login password (set with `wrangler secret put ADMIN_PASSWORD`). */
  ADMIN_PASSWORD: string;
  /** Optional: PBKDF2 rounds for teammate passwords, 10000 to 100000, 30000 when unset (docs/GUIDE.md, "Team"). 100000 needs Workers Paid. */
  PASSWORD_ITERATIONS?: string;
  /** Random string used to sign the login cookie (`wrangler secret put SESSION_SECRET`). */
  SESSION_SECRET: string;
  /** App Store Connect sales import (docs/GUIDE.md, "App Store sales"). All four set turns it on. Use a key with the Sales and Reports role only. */
  ASC_KEY_P8?: string;
  ASC_KEY_ID?: string;
  ASC_ISSUER_ID?: string;
  ASC_VENDOR_NUMBER?: string;
  /** Optional: a Stripe restricted key (rk_live_...) with Subscriptions read only, for the MRR check that agents run (docs/GUIDE.md, "Check MRR against Stripe"). The dashboard check also takes a key pasted for one run. */
  STRIPE_RESTRICTED_KEY?: string;
  /** Site ids (comma separated) whose Stripe account STRIPE_RESTRICTED_KEY belongs to. Unset: the key serves a deployment with one site. A site can have its own secret instead, STRIPE_RESTRICTED_KEY_<SITE ID in capitals> (stripe-check.ts siteKeyName). */
  STRIPE_RESTRICTED_KEY_SITES?: string;
  /** Apple Search Ads import (docs/GUIDE.md, "Apple Search Ads"). The first four turn it on; use an API user with the API Read Only role. */
  ASA_CLIENT_ID?: string;
  ASA_TEAM_ID?: string;
  ASA_KEY_ID?: string;
  /** The private-key.pem the API user's public key was made from. */
  ASA_PRIVATE_KEY?: string;
  /** Optional: import only this ad account. Without it, every ad account the API user has a role on. */
  ASA_AD_ACCOUNT_ID?: string;
  /**
   * Meta ads (docs/GUIDE.md, "Meta ads"): a system user access token with ads_read on the ad accounts the sites name, for
   * the spend import (pro/worker/meta.ts). The Conversions API (pro/worker/meta-capi.ts) sends with it too, so the system
   * user also needs the site's dataset. Unset: no calls to Meta.
   */
  META_ACCESS_TOKEN?: string;
  /** Optional: the Meta app's secret. Set, every call carries appsecret_proof, which the app can then require. */
  META_APP_SECRET?: string;
  /** APNs auth key, the contents of the .p8 file (`wrangler secret put APNS_KEY_P8`). Push is off without all three. */
  APNS_KEY_P8?: string;
  /** Key id of the APNs auth key. */
  APNS_KEY_ID?: string;
  /** Apple developer team id. */
  APNS_TEAM_ID?: string;
  /**
   * DataForSEO API login and password for Google rank tracking and keyword research (docs/SEO.md, "Keyword research and rank tracking").
   * Both set turns it on. The API password is not the account password: DataForSEO shows it under API access.
   */
  DATAFORSEO_LOGIN?: string;
  DATAFORSEO_PASSWORD?: string;
  /** Rank results one hourly run collects, 6 when unset. Each is a JSON parse; the free plan's 10 ms of CPU fits 6. Workers Paid can set more. */
  RANK_COLLECT_PER_RUN?: string;
  /**
   * Bearer token of the owner's X developer app, for "Which post paid" (docs/GUIDE.md): it reads the public posts of the
   * handle set per site. Unset: no calls to X, and posts can still be added by hand. X bills $0.005 a post read.
   */
  X_BEARER_TOKEN?: string;
  /**
   * OAuth client of the owner's own Google Cloud project, for "Connect Google" in the SEO tab (docs/SEO.md). Both set
   * turns it on. Type Web application, redirect URI https://<your host>/api/seo/google/callback.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Rows one Search Console response holds in the cron sync, 1500 when unset, at most 25,000. Each response is a JSON parse; Workers Paid can raise it. */
  GSC_REQUEST_ROWS?: string;
  /** Page and query pairs the cron sync keeps per window for gsc_page_queries, 1500 when unset, at most 5000. */
  GSC_PAGE_QUERY_ROWS?: string;
  /**
   * Rows the cron sync pulls per window for gsc_page_totals and gsc_query_totals, 1500 when unset. At most 5 responses
   * of GSC_REQUEST_ROWS rows (7,500 at the default 1,500), so the step fits a run's subrequests; higher is cut to that.
   */
  GSC_TOTALS_ROWS?: string;
  /** Resend API key for email alerts (docs/GUIDE.md, "Alerts and weekly report"). Without it, email goes through EMAIL, or is off. */
  RESEND_API_KEY?: string;
  /**
   * Signing secret of the Resend webhook that sends email events (docs/GUIDE.md, "Email (Resend)"), whsec_...
   * With several Resend accounts, their secrets separated by spaces or commas. Unset: POST /api/webhooks/resend answers 400.
   */
  RESEND_WEBHOOK_SECRET?: string;
  /**
   * Keys of the engines the AI visibility runner asks (docs/AI-VISIBILITY.md), set with `wrangler secret put`. An engine
   * runs for a site when the site turns it on and its key is set here. Each is optional.
   */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /**
   * Perplexity API key for the Perplexity engine (docs/AI-VISIBILITY.md, "Perplexity"). Optional: with DataForSEO set up the engine
   * runs through it and needs no key; this key is the way to run it without DataForSEO.
   */
  PERPLEXITY_API_KEY?: string;
  /** Checks one hourly AI visibility run starts across all sites, 1 to 50; 12 when unset. Lower it if runs hit the CPU limit of the free plan. */
  AI_CHECKS_PER_RUN?: string;
  /**
   * Cloudflare `send_email` binding, set in wrangler.local.jsonc (`npm run setup -- --mail` adds it). Without Email Sending
   * on the domain it sends to verified destination addresses only. FounderData Pro's mail sends through it too.
   */
  EMAIL?: SendEmail;
  /** R2 bucket for mail bodies, raw inbound messages and attachments (FounderData Pro mail, `npm run setup -- --mail`). */
  MAIL_BUCKET?: R2Bucket;
  /** Queue for Cloudflare's sending events, inbound parse jobs and webhook deliveries (FounderData Pro mail). */
  MAIL_QUEUE?: Queue;
  /**
   * R2 bucket for recorded visits (FounderData Pro, `npm run setup -- --replay`), in the database's jurisdiction. Chunks
   * are r/<site id>/<session id>/<n>; a lifecycle rule deletes them after 90 days. Without it no visit is recorded.
   */
  REPLAY_BUCKET?: R2Bucket;
  /**
   * Cloudflare API token and account id for mail (FounderData Pro): domain status, DNS records, the suppression list and the
   * delivery analytics. Optional: sending and receiving work without them.
   */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Sender of alert emails, like `FounderData <alerts@example.com>`: on a domain verified in Resend, or with Email Routing on. */
  ALERT_EMAIL_FROM?: string;
  /** Rows a day the sites on the automatic write cap share; 80,000 when unset (src/worker/budget.ts). */
  WRITE_POOL_ROWS?: string;
  /** With more than one site, the share of the pool one automatic site may use; 0.5 when unset. */
  WRITE_SITE_MAX_SHARE?: string;
  /** Rows a day that history imports may write across all sites; 20,000 when unset (src/worker/imports.ts). */
  IMPORT_DAILY_ROWS?: string;
  /** "1" when the event endpoint is proxied through the site's own domain: the visitor IP comes from X-Forwarded-For (src/worker/identity.ts). */
  TRUST_FORWARDED_FOR?: string;
  /** Optional read-only dashboard login (docs/GUIDE.md, "Viewer login"). Off when unset. */
  VIEWER_PASSWORD?: string;
  /** "1": the viewer login sees names, emails and user ids. Default: hidden. */
  VIEWER_PII?: string;
  /** "0": phones signed in to the iPhone app see no names, emails or user ids. Default: they see them. */
  PHONE_PII?: string;
  /** Optional key for the daily visitor id salt; without it the salt derives from SESSION_SECRET (src/worker/identity.ts). */
  VISITOR_SALT_SECRET?: string;
  /** Months of visit data to keep, default 24 (src/worker/retention.ts). */
  RETENTION_MONTHS?: string;
  /** Months after which names, emails and user ids are cleared from payments and visitors. Unset: kept. */
  PII_RETENTION_MONTHS?: string;
  /** "eu" or "fedramp": the D1 database's jurisdiction, which `npm run setup -- --jurisdiction` writes into wrangler.local.jsonc. Unset: not pinned (src/worker/location.ts). */
  DATA_JURISDICTION?: string;
  /** The deployed version (wrangler.jsonc `version_metadata`). GET /api/v1/whoami and MCP whoami show its id. */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

/** A phone signed in through the mobile API (migration 0009). */
export interface Device {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  apns_token: string | null;
  apns_env: string | null;
  apns_topic: string | null;
  apns_disabled_at: number | null;
  widget_token: string | null;
  widget_env: string | null;
  widget_topic: string | null;
  widget_disabled_at: number | null;
  last_widget_push_at: number | null;
  /** JSON: { purchase, renewal, refund, trial } booleans. */
  events: string;
  /** The 08:00 "Since yesterday" push and the Monday weekly report push, 1 or 0 (migration 0032). */
  digest_daily: number;
  digest_weekly: number;
  /** Renewals below this push no alert, in major units of renewal_min_currency. NULL: 5 in the first site's currency. */
  renewal_min: number | null;
  renewal_min_currency: string | null;
  /** Live Activity tokens (migration 0062): push-to-start, and the running activity's update token. */
  live_start_token: string | null;
  live_update_token: string | null;
  live_env: string | null;
  live_topic: string | null;
  /** ms of the last Live Activity update push: at most one a minute. */
  live_pushed_at: number | null;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  api_key: string;
  dodo_webhook_secret: string | null;
  created_at: number;
  /** App Store bundle id of the site's iOS app (migration 0004). */
  app_bundle_id: string | null;
  /** 1 = record App Store sandbox purchases, apart from revenue (migration 0004). */
  accept_sandbox: number;
  /** Stripe webhook signing secret, whsec_... (migration 0005). */
  stripe_webhook_secret: string | null;
  /** 1 = record Stripe payments that nothing ties to a site; 0 = only payments tied to this one (migration 0011). */
  stripe_unpinned: number;
  /** RevenueCat webhook Authorization header value (migration 0007). */
  revenuecat_auth: string | null;
  /** The app's id and SKU in App Store Connect, resolved from app_bundle_id by the sales import (migration 0010). */
  asc_app_id: string | null;
  asc_sku: string | null;
  /** The App Store id the owner entered, for a deployment without the sales import (migration 0023). */
  app_store_id?: string | null;
  /** 1 = drop tracker and app events once the site wrote `write_cap` rows today (migration 0013, src/worker/budget.ts). */
  write_cap_on: number;
  /** Rows written a day; null = automatic, 80% of the free plan split across all sites. */
  write_cap: number | null;
  /** Webhook signing secrets of Lemon Squeezy, Polar and Paddle (migration 0018, src/worker/providers.ts). */
  lemonsqueezy_secret?: string | null;
  polar_secret?: string | null;
  paddle_secret?: string | null;
  /** Gumroad: the seller id every ping must name, and the random token in the ping URL (migration 0018). */
  gumroad_seller_id?: string | null;
  gumroad_token?: string | null;
  /** Apple's commission in percent, 15 or 30, for amounts after Apple's cut (migration 0021, src/worker/commission.ts). */
  app_commission?: number;
  /** The goal Home, the portfolio and the weekly report count, and how it reads (migration 0030, src/worker/primary-goal.ts). */
  primary_goal?: string | null;
  primary_goal_label?: string | null;
  /** website, app, extension or newsletter; null = automatic (migration 0034, src/worker/product-type.ts). */
  product_type?: string | null;
  /** Percent of page loads whose Core Web Vitals are stored, 0 to 100 (migration 0036, src/worker/vitals.ts). */
  vitals_sample?: number;
  /** 1 = every session keeps its user agent for 28 days, for the Meta Conversions API in mode `all` (migration 0060). */
  keep_ua?: number;
  /** 1 = visits from hosting networks count like any other; 0 (the default) hides them (migration 0065, src/worker/datacenter.ts). */
  show_datacenter?: number;
  /** Record visits (FounderData Pro, migration 0072): 1 = on. Off by default. */
  record_visits?: number;
  /** Percent of visits recorded, 1 to 100. */
  record_sample?: number;
  /** Days a recording is kept: 7, 30 or 90. */
  record_keep_days?: number;
  /** Most visits recorded a day. */
  record_daily_max?: number;
  /** 1 = after 24 hours keep only recorded visits with a goal or a payment. */
  record_only_active?: number;
  /** 1 = record a visit only after the visitor consented to cookies (migration 0075). */
  record_consent?: number;
  /** Pages that are never recorded: path prefixes, one per line; null for none (migration 0076, recording.ts). */
  record_skip?: string | null;
  /** When Record visits was last turned on (ms), null before (migration 0082, recording.ts patchRecording). */
  record_on_at?: number | null;
  /** The newest reason recordings did not arrive, as JSON (migration 0082). FounderData Pro writes it. */
  record_health?: string | null;
  /** Remember visitors (migration 0072): 1 = the tracker keeps the visitor id in first-party cookies, as with consent. */
  remember_visitors?: number;
}

/** Who is calling the dashboard API (src/worker/auth.ts): the owner, the viewer login or a phone. */
export type Role = 'admin' | 'viewer' | 'device';

/** Reads a route started before it loaded the site (index.ts overviewPrefetch). */
export interface RoutePrefetch {
  converting: Promise<unknown>;
  asc: Promise<import('./revenue').AscPrefetch | null>;
  importRow: Promise<import('./imports').ImportInfoRow | null>;
}

export type AppEnv = { Bindings: Env; Variables: { site: Site; device: Device; role: Role; member?: { id: string; name: string }; prefetch?: RoutePrefetch;
  /** The one site an answer across sites covers (/api/v1/weekly for a one-site key or ?site=), for its dashboard_url. */
  linkSite?: string;
} };

const siteCache = new Map<string, { site: Site | null; at: number }>();

/** Sites change rarely; cache them per isolate so ingestion costs one fewer read per event. */
export async function getSite(db: D1Database, id: string): Promise<Site | null> {
  const hit = siteCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.site;
  const site = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<Site>();
  siteCache.set(id, { site, at: Date.now() });
  return site;
}

export function forgetSite(id: string) {
  siteCache.delete(id);
}
