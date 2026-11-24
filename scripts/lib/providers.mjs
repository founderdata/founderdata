// Every value `npm run connect` can store, in one list. Each provider names its fields:
// - name: the Worker secret (`wrangler secret put NAME`) or the site setting (PATCH /api/sites/:id field).
// - dest: 'worker' or 'site'.
// - kind: 'secret' (a password field), 'text' (an id, shown as typed) or 'file' (a .p8 or .pem key, read from a file).
// - url: the provider page where the person finds the value; where: the clicks on that page.
// - check: the format, as a regex and a description. A failed check names the field and the format, never the value.
// The names come from src/worker/env.ts, the PATCH /api/sites/:id handler and the guides: docs/GUIDE.md "Set up
// integrations", docs/SEO.md, docs/AI-VISIBILITY.md, docs/MAIL.md. Pro providers are marked `pro: true`; core can
// store their secrets, and FounderData Pro reads them.

const PRINTABLE = { re: /^[\x21-\x7e]{6,300}$/, says: 'is 6 to 300 characters without spaces' };
const WHSEC = { re: /^whsec_[\w+/=-]+$/, says: 'starts with whsec_' };
const APPLE_ID10 = { re: /^[A-Z0-9]{10}$/, says: 'is 10 letters and digits, like 2X9R4HXF34' };
const P8 = { pem: 'PRIVATE KEY', says: 'is the whole .p8 file, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----' };
/** Apple's key files are AuthKey_<key id>.p8: the key id comes from the file name. */
const AUTHKEY = /^AuthKey_([A-Z0-9]{10})\.p8$/;

/** @type {Provider[]} */
export const PROVIDERS = [
  {
    id: 'stripe',
    label: 'Stripe',
    pro: false,
    fields: [
      {
        name: 'stripe_webhook_secret',
        label: 'Signing secret',
        dest: 'site',
        kind: 'secret',
        url: 'https://dashboard.stripe.com/webhooks',
        where: 'Developers, Webhooks, your FounderData endpoint, Signing secret, Reveal.',
        check: { re: /^whsec_\w+$/, says: 'starts with whsec_' },
      },
    ],
  },
  {
    id: 'dodo',
    label: 'Dodo Payments',
    pro: false,
    fields: [
      {
        name: 'dodo_webhook_secret',
        label: 'Signing secret',
        dest: 'site',
        kind: 'secret',
        url: 'https://app.dodopayments.com/',
        where: 'Developer, Webhooks, your FounderData endpoint, Signing secret.',
        check: PRINTABLE,
      },
    ],
  },
  {
    id: 'lemonsqueezy',
    label: 'Lemon Squeezy',
    pro: false,
    fields: [
      {
        name: 'lemonsqueezy_secret',
        label: 'Signing secret',
        dest: 'site',
        kind: 'secret',
        url: 'https://app.lemonsqueezy.com/settings/webhooks',
        where: 'Settings, Webhooks, your FounderData webhook. The signing secret is the one you typed there.',
        check: PRINTABLE,
      },
    ],
  },
  {
    id: 'polar',
    label: 'Polar',
    pro: false,
    fields: [
      {
        name: 'polar_secret',
        label: 'Webhook secret',
        dest: 'site',
        kind: 'secret',
        url: 'https://polar.sh/dashboard',
        where: 'Your organization, Settings, Webhooks, your FounderData endpoint, Secret.',
        check: PRINTABLE,
      },
    ],
  },
  {
    id: 'paddle',
    label: 'Paddle',
    pro: false,
    fields: [
      {
        name: 'paddle_secret',
        label: 'Secret key',
        dest: 'site',
        kind: 'secret',
        url: 'https://vendors.paddle.com/',
        where: 'Developer tools, Notifications, your FounderData destination, Secret key.',
        check: PRINTABLE,
      },
    ],
  },
  {
    id: 'gumroad',
    label: 'Gumroad',
    pro: false,
    // Gumroad signs nothing: FounderData makes a random token for the ping URL, shown once after the save.
    siteExtra: (site) => (site.gumroad_token ? {} : { gumroad_new_token: true }),
    reveal: 'gumroad-ping',
    fields: [
      {
        name: 'gumroad_seller_id',
        label: 'Seller id',
        dest: 'site',
        kind: 'text',
        optional: true,
        url: 'https://app.gumroad.com/settings/advanced',
        where: 'Settings, Advanced. Leave it empty and the first sale saves it.',
        check: { re: /^[\w=-]{4,100}$/, says: 'has letters, digits, - and _ only' },
      },
    ],
  },
  {
    id: 'revenuecat',
    label: 'RevenueCat',
    pro: false,
    // `npm run connect -- generate revenuecat` makes the value, stores it and shows it once.
    generate: 'revenuecat_auth',
    fields: [
      {
        name: 'revenuecat_auth',
        label: 'Authorization header',
        dest: 'site',
        kind: 'secret',
        url: 'https://app.revenuecat.com/',
        where: 'Your project, Integrations, Webhooks, your FounderData webhook, Authorization header value.',
        normalize: (v) => v.replace(/^Bearer\s+/i, ''),
        check: { re: /^[\x21-\x7e]{16,200}$/, says: 'is 16 to 200 characters without spaces' },
      },
    ],
  },
  {
    id: 'resend',
    label: 'Resend',
    pro: false,
    fields: [
      {
        name: 'RESEND_API_KEY',
        label: 'API key',
        dest: 'worker',
        kind: 'secret',
        url: 'https://resend.com/api-keys',
        where: 'API Keys, Create API key, permission Sending access.',
        check: { re: /^re_[\w-]{8,}$/, says: 'starts with re_' },
      },
      {
        name: 'ALERT_EMAIL_FROM',
        label: 'Sender',
        dest: 'worker',
        kind: 'text',
        url: 'https://resend.com/domains',
        where: 'An address on a domain verified in Resend, like FounderData <alerts@acme.example>.',
        check: { re: /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}>?$|^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}>$/i, says: 'is an email address, or a name and <address>' },
      },
    ],
  },
  {
    id: 'stripe-key',
    label: 'Stripe MRR check',
    pro: true,
    // With --site the key belongs to that site's Stripe account: STRIPE_RESTRICTED_KEY_<SITE ID> (stripe-check.ts).
    siteScopedName: (siteId) => `STRIPE_RESTRICTED_KEY_${siteId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
    fields: [
      {
        name: 'STRIPE_RESTRICTED_KEY',
        label: 'Restricted key',
        dest: 'worker',
        kind: 'secret',
        url: 'https://dashboard.stripe.com/apikeys',
        where: 'Developers, API keys, Create restricted key. Subscriptions: Read. Everything else: None.',
        check: { re: /^rk_live_\w+$/, says: 'starts with rk_live_ (a restricted live key, never the secret key sk_live_)' },
      },
    ],
  },
  {
    id: 'dataforseo',
    label: 'DataForSEO',
    pro: true,
    fields: [
      {
        name: 'DATAFORSEO_LOGIN',
        label: 'API login',
        dest: 'worker',
        kind: 'text',
        url: 'https://app.dataforseo.com/api-access',
        where: 'API Access. The login is your account email.',
        check: { re: /^\S{3,200}$/, says: 'has no spaces' },
      },
      {
        name: 'DATAFORSEO_PASSWORD',
        label: 'API password',
        dest: 'worker',
        kind: 'secret',
        url: 'https://app.dataforseo.com/api-access',
        where: 'API Access. This is the API password, not your account password.',
        check: PRINTABLE,
      },
    ],
  },
  {
    id: 'google-search-console',
    label: 'Google Search Console',
    pro: true,
    fields: [
      {
        name: 'GOOGLE_CLIENT_ID',
        label: 'Client id',
        dest: 'worker',
        kind: 'text',
        url: 'https://console.cloud.google.com/apis/credentials',
        where: 'APIs and services, Credentials, your OAuth client of type Web application.',
        check: { re: /^[\w-]+\.apps\.googleusercontent\.com$/, says: 'ends with .apps.googleusercontent.com' },
      },
      {
        name: 'GOOGLE_CLIENT_SECRET',
        label: 'Client secret',
        dest: 'worker',
        kind: 'secret',
        url: 'https://console.cloud.google.com/apis/credentials',
        where: 'The same OAuth client, Client secrets.',
        check: PRINTABLE,
      },
    ],
  },
  {
    id: 'ai-engines',
    label: 'AI engines',
    pro: true,
    // Any one of them is enough. Each alias below stores only its own key.
    aliases: { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', perplexity: 'PERPLEXITY_API_KEY' },
    atLeastOne: true,
    fields: [
      {
        name: 'OPENAI_API_KEY',
        label: 'OpenAI API key',
        dest: 'worker',
        kind: 'secret',
        optional: true,
        url: 'https://platform.openai.com/api-keys',
        where: 'API keys, Create new secret key. Set a monthly limit under Limits.',
        check: { re: /^sk-[\w-]{20,}$/, says: 'starts with sk-' },
      },
      {
        name: 'ANTHROPIC_API_KEY',
        label: 'Anthropic API key',
        dest: 'worker',
        kind: 'secret',
        optional: true,
        url: 'https://console.anthropic.com/settings/keys',
        where: 'Settings, API keys, Create key. Set a spend limit under Limits.',
        check: { re: /^sk-ant-[\w-]{20,}$/, says: 'starts with sk-ant-' },
      },
      {
        name: 'GEMINI_API_KEY',
        label: 'Gemini API key',
        dest: 'worker',
        kind: 'secret',
        optional: true,
        url: 'https://aistudio.google.com/apikey',
        where: 'Get API key, Create API key.',
        check: { re: /^AIza[\w-]{30,}$/, says: 'starts with AIza' },
      },
      {
        name: 'PERPLEXITY_API_KEY',
        label: 'Perplexity API key',
        dest: 'worker',
        kind: 'secret',
        optional: true,
        url: 'https://www.perplexity.ai/account/api/keys',
        where: 'API, API keys, Create key. With DataForSEO set up, Perplexity runs without this key.',
        check: { re: /^pplx-[\w-]{20,}$/, says: 'starts with pplx-' },
      },
    ],
  },
  {
    id: 'meta-ads',
    label: 'Meta ads',
    pro: true,
    fields: [
      {
        name: 'META_ACCESS_TOKEN',
        label: 'System user token',
        dest: 'worker',
        kind: 'secret',
        url: 'https://business.facebook.com/settings/system-users',
        where: 'Business settings, Users, System users, your system user, Generate token: expiry Never, permission ads_read.',
        check: { re: /^EA[A-Za-z0-9]{20,}$/, says: 'starts with EA' },
      },
      {
        name: 'META_APP_SECRET',
        label: 'App secret',
        dest: 'worker',
        kind: 'secret',
        optional: true,
        url: 'https://developers.facebook.com/apps/',
        where: 'Your app, App settings, Basic, App secret. Optional: it adds appsecret_proof to every call.',
        check: { re: /^[a-f0-9]{32}$/, says: 'is 32 hex characters' },
      },
    ],
  },
  {
    id: 'x',
    label: 'X',
    pro: true,
    fields: [
      {
        name: 'X_BEARER_TOKEN',
        label: 'Bearer token',
        dest: 'worker',
        kind: 'secret',
        url: 'https://developer.x.com/en/portal/dashboard',
        where: 'Your app, Keys and tokens, Bearer token, Regenerate.',
        check: { re: /^[\x21-\x7e]{30,400}$/, says: 'is one line of 30 or more characters without spaces' },
      },
    ],
  },
  {
    id: 'resend-webhook',
    label: 'Resend email stats',
    pro: true,
    fields: [
      {
        name: 'RESEND_WEBHOOK_SECRET',
        label: 'Webhook signing secret',
        dest: 'worker',
        kind: 'secret',
        url: 'https://resend.com/webhooks',
        where: 'Webhooks, your FounderData webhook, Signing secret.',
        check: WHSEC,
      },
    ],
  },
  {
    id: 'apple-search-ads',
    label: 'Apple Search Ads',
    pro: true,
    fields: [
      {
        name: 'ASA_CLIENT_ID',
        label: 'clientId',
        dest: 'worker',
        kind: 'text',
        url: 'https://ads.apple.com/',
        where: 'Signed in as the API user: Account Settings, API, after you saved the public key.',
        check: { re: /^SEARCHADS\.[\w.-]+$/, says: 'starts with SEARCHADS.' },
      },
      {
        name: 'ASA_TEAM_ID',
        label: 'teamId',
        dest: 'worker',
        kind: 'text',
        url: 'https://ads.apple.com/',
        where: 'Account Settings, API, next to clientId.',
        check: { re: /^SEARCHADS\.[\w.-]+$/, says: 'starts with SEARCHADS.' },
      },
      {
        name: 'ASA_KEY_ID',
        label: 'keyId',
        dest: 'worker',
        kind: 'text',
        url: 'https://ads.apple.com/',
        where: 'Account Settings, API, next to teamId.',
        check: { re: /^[\w-]{6,100}$/, says: 'has letters, digits and - only' },
      },
      {
        name: 'ASA_PRIVATE_KEY',
        label: 'Private key',
        dest: 'worker',
        kind: 'file',
        url: 'https://ads.apple.com/',
        where: 'The private-key.pem you made with openssl. Its public half is the key you uploaded to Apple Ads.',
        accept: '.pem',
        check: { pem: 'EC PRIVATE KEY|PRIVATE KEY', says: 'is the whole private-key.pem, from -----BEGIN to -----END' },
      },
      {
        name: 'ASA_AD_ACCOUNT_ID',
        label: 'Ad account id',
        dest: 'worker',
        kind: 'text',
        optional: true,
        url: 'https://ads.apple.com/',
        where: 'Optional: import this ad account only. Without it, every account the API user can read.',
        check: { re: /^\d{3,20}$/, says: 'is digits only' },
      },
    ],
  },
  {
    id: 'app-store-connect',
    label: 'App Store Connect',
    pro: true,
    fields: [
      {
        name: 'ASC_KEY_P8',
        label: 'Key file (.p8)',
        dest: 'worker',
        kind: 'file',
        url: 'https://appstoreconnect.apple.com/access/integrations/api',
        where: 'Users and Access, Integrations, Team Keys, a key with the Sales and Reports role, Download. Apple lets you download it once.',
        accept: '.p8',
        download: AUTHKEY,
        check: P8,
      },
      {
        name: 'ASC_KEY_ID',
        label: 'Key id',
        dest: 'worker',
        kind: 'text',
        url: 'https://appstoreconnect.apple.com/access/integrations/api',
        where: 'The Key ID column next to the key. The file name AuthKey_<key id>.p8 has it too.',
        fromFile: AUTHKEY,
        check: APPLE_ID10,
      },
      {
        name: 'ASC_ISSUER_ID',
        label: 'Issuer id',
        dest: 'worker',
        kind: 'text',
        url: 'https://appstoreconnect.apple.com/access/integrations/api',
        where: 'Users and Access, Integrations, at the top of Team Keys.',
        check: { re: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, says: 'looks like 69a6de70-03db-47e3-e053-5b8c7c11a4d1' },
      },
      {
        name: 'ASC_VENDOR_NUMBER',
        label: 'Vendor number',
        dest: 'worker',
        kind: 'text',
        url: 'https://appstoreconnect.apple.com/trends/reports',
        where: 'Sales and Trends, Reports, the number next to your name.',
        check: { re: /^\d{5,12}$/, says: 'is digits only' },
      },
    ],
  },
  {
    id: 'push',
    label: 'Apple push',
    pro: true,
    fields: [
      {
        name: 'APNS_KEY_P8',
        label: 'Key file (.p8)',
        dest: 'worker',
        kind: 'file',
        url: 'https://developer.apple.com/account/resources/authkeys/list',
        where: 'Certificates, Identifiers and Profiles, Keys, a key with Apple Push Notifications service, Download. Apple lets you download it once.',
        accept: '.p8',
        download: AUTHKEY,
        check: P8,
      },
      {
        name: 'APNS_KEY_ID',
        label: 'Key id',
        dest: 'worker',
        kind: 'text',
        url: 'https://developer.apple.com/account/resources/authkeys/list',
        where: 'The key\'s Key ID. The file name AuthKey_<key id>.p8 has it too.',
        fromFile: AUTHKEY,
        check: APPLE_ID10,
      },
      {
        name: 'APNS_TEAM_ID',
        label: 'Team id',
        dest: 'worker',
        kind: 'text',
        url: 'https://developer.apple.com/account',
        where: 'Membership details, Team ID.',
        check: APPLE_ID10,
      },
    ],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare mail',
    pro: true,
    fields: [
      {
        name: 'CLOUDFLARE_API_TOKEN',
        label: 'API token',
        dest: 'worker',
        kind: 'secret',
        url: 'https://dash.cloudflare.com/profile/api-tokens',
        where: 'My Profile, API Tokens, Create Token: read the zone and account analytics, edit Email Sending, Email Routing and Queues.',
        check: { re: /^[\w-]{30,200}$/, says: 'is 30 or more letters, digits, - and _' },
      },
      {
        name: 'CLOUDFLARE_ACCOUNT_ID',
        label: 'Account id',
        dest: 'worker',
        kind: 'text',
        url: 'https://dash.cloudflare.com/',
        where: 'Any domain\'s Overview, Account ID in the right column.',
        check: { re: /^[a-f0-9]{32}$/, says: 'is 32 hex characters' },
      },
    ],
  },
];

/**
 * @typedef {{ name: string, label: string, dest: 'worker' | 'site', kind: 'secret' | 'text' | 'file', url: string,
 *   where: string, optional?: boolean, accept?: string, download?: RegExp, fromFile?: RegExp,
 *   normalize?: (v: string) => string, check: { re?: RegExp, pem?: string, says: string } }} Field
 * @typedef {{ id: string, label: string, pro: boolean, fields: Field[], aliases?: Record<string, string>,
 *   atLeastOne?: boolean, generate?: string, reveal?: string, siteExtra?: (site: any) => object,
 *   siteScopedName?: (siteId: string) => string }} Provider
 */

/** The provider for an id or an alias (openai stores OPENAI_API_KEY of ai-engines). Null when unknown. */
export function findProvider(id) {
  const key = String(id ?? '').toLowerCase();
  const direct = PROVIDERS.find((p) => p.id === key);
  if (direct) return { provider: direct, only: null };
  for (const p of PROVIDERS) if (p.aliases?.[key]) return { provider: p, only: [p.aliases[key]] };
  return null;
}

/** The value as it is stored: trimmed, and with the provider's own cleanup (a "Bearer " prefix goes). */
export function normalizeValue(field, value) {
  let v = String(value ?? '');
  v = field.kind === 'file' ? v.replace(/\r\n/g, '\n').trim() : v.trim();
  return field.normalize ? field.normalize(v) : v;
}

/**
 * Checks one value's format. Returns null when it fits, or a message that names the field and the format. The message
 * never holds the value or any part of it.
 */
export function checkValue(field, value) {
  const v = normalizeValue(field, value);
  if (!v) return field.optional ? null : `${field.label} is empty.`;
  if (v.includes('•')) return `${field.label} holds dots from a hidden field. Copy the value itself.`;
  if (field.check.pem) {
    const types = field.check.pem;
    const ok = new RegExp(`^-----BEGIN (${types})-----\\n[A-Za-z0-9+/=\\n]+\\n-----END \\1-----$`).test(v);
    return ok ? null : `${field.label} does not look right. It ${field.check.says}.`;
  }
  return field.check.re.test(v) ? null : `${field.label} does not look right. It ${field.check.says}.`;
}

/** The registry without functions and regexes, for `npm run connect -- list --json` and the skills. */
export function describeProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    pro: p.pro,
    ...(p.aliases ? { aliases: Object.keys(p.aliases) } : {}),
    ...(p.generate ? { generate: true } : {}),
    secrets: p.fields.map((f) => ({
      name: f.name,
      destination: f.dest === 'site' ? 'site setting (PATCH /api/sites/:id)' : 'Worker secret (wrangler secret put)',
      kind: f.kind,
      optional: !!f.optional,
      format: f.check.says,
      url: f.url,
      where: f.where,
    })),
  }));
}
