import type { Env, Site } from './env';
import { randomId } from './lib/crypto';
import { rawDb } from './lib/d1-trace';
import { formatMoney, lateDate, type PaymentPush } from './notify';
import { messageEvent, recordEvents } from './alert-events';

/**
 * Alerts and the weekly report (docs/GUIDE.md, "Alerts and weekly report"). The deployment owner adds channels in
 * the dashboard: a Slack or Discord incoming webhook, a Telegram bot, any JSON webhook, or email (through Resend, or
 * Cloudflare Email Routing's send_email binding).
 * Each channel switches every alert on or off and covers every site or a chosen few.
 *
 * - Payments, renewals, refunds and trials go out from the same hook that pushes to the iPhone app (notify.ts).
 * - A failed payment or a cancellation of a paying subscription goes out from the write that records it
 *   (subscriptions.ts, alertSubscription).
 * - A site that reaches its daily write cap sends one alert, from the instance that set `capped_at` (budget.ts).
 * - A webhook delivery refused for a bad signature or token alerts at once, once a day per site and provider
 *   (budget.ts, noteWebhookRefused).
 * - The daily cron sends "worth a look" when there is something, "payments stopped arriving" when a provider that
 *   sends payments regularly went quiet (silence.ts), "ASO collector stopped reporting" when an app's last snapshot is
 *   36 hours old (aso.ts), and the weekly report on Mondays. A channel that ticks "Daily numbers" gets yesterday's
 *   numbers every day (numbers-digest.ts).
 * - FounderData Pro mail alerts when a mail domain stops being healthy, when sends fail or when received mail is lost
 *   (pro/worker/mail/health.ts, once an hour at minute 20).
 *
 * Every send runs after the response (`waitUntil`) or in a cron. Sends write nothing to D1. The alert inbox
 * (alert-events.ts) stores 1 row per message and site, without names or emails, also when no channel takes the kind:
 * failed payments, cancellations, refused webhooks and the write cap here, the daily alerts in digest.ts.
 */

export type ChannelKind = 'slack' | 'discord' | 'telegram' | 'webhook' | 'email';
export const CHANNEL_KINDS: ChannelKind[] = ['slack', 'discord', 'telegram', 'webhook', 'email'];
export type AlertKind = 'purchase' | 'renewal' | 'refund' | 'trial' | 'payment_failed' | 'canceled' | 'daily' | 'payments_stopped' | 'webhook_refused' | 'cap' | 'aso_collector' | 'aso_review' | 'mail' | 'weekly' | 'numbers' | 'plan_away';
export const ALERT_KINDS: AlertKind[] = ['purchase', 'renewal', 'refund', 'trial', 'payment_failed', 'canceled', 'daily', 'payments_stopped', 'webhook_refused', 'cap', 'aso_collector', 'aso_review', 'mail', 'weekly', 'numbers', 'plan_away'];
/** What a new channel gets. */
export const DEFAULT_ALERTS: Record<AlertKind, boolean> = {
  purchase: true,
  renewal: false,
  refund: true,
  trial: false,
  payment_failed: true,
  canceled: true,
  daily: true,
  payments_stopped: true,
  webhook_refused: true,
  cap: true,
  // On for channels from before it too: it only fires once someone runs the ASO collector, who wants to know.
  aso_collector: true,
  // On for older channels too: it fires only for an app whose collector posts reviews, and each app can switch it off.
  aso_review: true,
  // On for older channels too: it fires only on a deployment with FounderData Pro mail, when a mail domain breaks,
  // sends fail or received mail is lost (pro/worker/mail/health.ts).
  mail: true,
  weekly: true,
  // Off until a channel ticks it: it sends every day, not only when something happened (numbers-digest.ts).
  numbers: false,
  // On for older channels too: it fires only for a site whose plan has a schedule (FounderData Pro, pro/worker/plan.ts).
  plan_away: true,
};
/** Alerts added after channels existed. A channel stored before them has them off until someone switches them on. */
const OFF_FOR_OLDER_CHANNELS: Partial<Record<AlertKind, boolean>> = { payment_failed: false, canceled: false };
export const MAX_CHANNELS = 20;
const SEND_TIMEOUT_MS = 10_000;
const KIND_NAMES: Record<ChannelKind, string> = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', webhook: 'Webhook', email: 'Email' };
/** Longest text a channel takes in one message; longer texts go out in parts. */
const TEXT_LIMIT: Partial<Record<ChannelKind, number>> = { discord: 1900, telegram: 4000, slack: 35_000 };

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string;
  target: string;
  secret: string | null;
  alerts: string;
  sites: string | null;
  created_at: number;
}

export interface AlertMessage {
  // 'threshold': an alert rule crossed its line (pro/worker/alert-rules.ts).
  kind: AlertKind | 'test' | 'threshold';
  title: string;
  /** Plain text under the title, one line each. An empty string is a blank line. */
  lines: string[];
  /** The email body. Without it, the email shows the lines as paragraphs. */
  html?: string;
  /** Extra fields for the JSON webhook. */
  data?: Record<string, unknown>;
}

export interface SendResult {
  ok: boolean;
  /** HTTP status of the channel's API, or 0 when it never answered or was skipped. */
  status: number;
  error?: string;
}

// ---------- env for code that only has the database

const envs = new WeakMap<D1Database, Env>();

/** Remember the request's env, so code that only gets the database (the write cap) can still send email. */
export function rememberEnv(env: Env) {
  if (env?.DB) envs.set(rawDb(env.DB), env);
}

const envFor = (db: D1Database): Env => envs.get(rawDb(db)) ?? ({ DB: db } as Env);

/**
 * How email goes out: through Resend when RESEND_API_KEY is set, else through the Cloudflare Email Routing binding
 * EMAIL (wrangler.local.jsonc), else not at all. Both need ALERT_EMAIL_FROM.
 */
export function emailTransport(env: Partial<Env>): 'resend' | 'cloudflare' | null {
  if (!env.ALERT_EMAIL_FROM) return null;
  if (env.RESEND_API_KEY) return 'resend';
  return typeof env.EMAIL?.send === 'function' ? 'cloudflare' : null;
}

export const emailConfigured = (env: Partial<Env>) => emailTransport(env) !== null;

const EMAIL_OFF = 'Email needs the ALERT_EMAIL_FROM variable and either the RESEND_API_KEY secret or a send_email binding named EMAIL on the Worker';

// ---------- channels

export function parseAlerts(json: string | null | undefined): Record<AlertKind, boolean> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(json ?? '{}') ?? {};
  } catch {
    // Fall back to the defaults.
  }
  const out = { ...DEFAULT_ALERTS, ...OFF_FOR_OLDER_CHANNELS };
  for (const k of ALERT_KINDS) if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean;
  return out;
}

export function parseSites(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** Does the channel want this alert for this site? A deployment-wide alert passes `null`. */
export function wants(ch: ChannelRow, kind: AlertKind, siteId: string | null): boolean {
  if (!parseAlerts(ch.alerts)[kind]) return false;
  const sites = parseSites(ch.sites);
  return !siteId || !sites || sites.includes(siteId);
}

/** What the dashboard sees: URLs and tokens stay hidden, like the sites' webhook secrets. */
export function publicChannel(ch: ChannelRow) {
  let target = ch.target;
  if (ch.kind === 'slack' || ch.kind === 'discord' || ch.kind === 'webhook') {
    let host = '';
    try {
      host = new URL(ch.target).host;
    } catch {
      // Stored before validation existed: show nothing of it.
    }
    target = `${host}/••••${ch.target.slice(-4)}`;
  }
  return {
    id: ch.id,
    kind: ch.kind,
    name: ch.name,
    target,
    secret: ch.secret ? '••••••••' : null,
    alerts: parseAlerts(ch.alerts),
    sites: parseSites(ch.sites),
    created_at: ch.created_at,
  };
}

const isHttpsUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
};

/** http:// to this machine, for a webhook listener while the Worker runs under `wrangler dev`. */
const isLocalHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
};

export function cleanAlerts(v: unknown, base: Record<AlertKind, boolean>): Record<AlertKind, boolean> {
  const out = { ...base };
  if (v && typeof v === 'object') for (const k of ALERT_KINDS) if (typeof (v as any)[k] === 'boolean') out[k] = (v as any)[k];
  return out;
}

export function cleanSites(v: unknown): string[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,40}$/.test(x)))].slice(0, 200);
}

/**
 * Check a new channel. Returns the error text or the row to store. `local`: the dashboard runs on localhost
 * (`wrangler dev`), so a webhook may also be http://localhost or http://127.0.0.1.
 */
export function readChannel(b: Record<string, unknown> | null, env: Partial<Env>, now: number, local = false): { error: string } | ChannelRow {
  const kind = b?.kind as ChannelKind;
  if (!CHANNEL_KINDS.includes(kind)) return { error: 'Pick Slack, Discord, Telegram, Webhook or Email' };
  const target = typeof b?.target === 'string' ? b.target.trim() : '';
  let secret: string | null = null;
  if (kind === 'webhook') {
    const ok = isHttpsUrl(target) || (local && isLocalHttpUrl(target));
    if (!ok || target.length > 500) {
      return {
        error: local
          ? 'Enter the webhook URL, starting with https://, or http://localhost or http://127.0.0.1 for a listener on this machine'
          : 'Enter the webhook URL, starting with https://. Plain http:// works only for localhost while the Worker runs under wrangler dev',
      };
    }
  } else if (kind === 'slack' || kind === 'discord') {
    if (!isHttpsUrl(target) || target.length > 500) return { error: 'Enter the webhook URL, starting with https://' };
  } else if (kind === 'telegram') {
    secret = typeof b?.secret === 'string' ? b.secret.trim() : '';
    if (!/^\d{5,15}:[\w-]{20,60}$/.test(secret)) return { error: 'Enter the bot token from BotFather, like 123456789:AAE...' };
    if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{4,40})$/.test(target)) return { error: 'Enter the chat id, like 123456789 or -1001234567890' };
  } else {
    if (!emailConfigured(env)) return { error: EMAIL_OFF };
    if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(target) || target.length > 200) return { error: 'Enter an email address' };
  }
  const name = (typeof b?.name === 'string' && b.name.trim() ? b.name.trim() : KIND_NAMES[kind]).slice(0, 60);
  const sites = cleanSites(b?.sites);
  return {
    id: randomId(8),
    kind,
    name,
    target,
    secret,
    alerts: JSON.stringify(cleanAlerts(b?.alerts, DEFAULT_ALERTS)),
    sites: sites ? JSON.stringify(sites) : null,
    created_at: now,
  };
}

export async function allChannels(db: D1Database): Promise<ChannelRow[]> {
  return (await db.prepare('SELECT * FROM alert_channels ORDER BY created_at').all<ChannelRow>()).results;
}

// ---------- sending

const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The message as plain text: the title, then the lines. */
export const plainText = (m: AlertMessage) => [m.title, ...m.lines].join('\n');

/** Split text into parts of at most `limit` characters, at line breaks where it can. */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length <= limit) {
      cur = next;
      continue;
    }
    if (cur) parts.push(cur);
    cur = line;
    while (cur.length > limit) {
      parts.push(cur.slice(0, limit));
      cur = cur.slice(limit);
    }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [''];
}

function emailHtml(m: AlertMessage): string {
  const body = m.html ?? m.lines.filter(Boolean).map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1c1917;max-width:640px">
<h2 style="font-size:17px;margin:0 0 12px">${escapeHtml(m.title)}</h2>${body}
<p style="margin:16px 0 0;color:#a8a29e;font-size:12px">Sent by FounderData. Change what arrives here on the Notifications page of your dashboard.</p></div>`;
}

/** The HTTP requests that deliver a message to a channel, in order. */
export function requestsFor(env: Partial<Env>, ch: ChannelRow, m: AlertMessage): { url: string; init: RequestInit }[] {
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) => ({
    url,
    init: { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
  });
  const limit = TEXT_LIMIT[ch.kind] ?? Infinity;
  switch (ch.kind) {
    case 'slack':
      return splitText(`*${escapeSlack(m.title)}*\n${escapeSlack(m.lines.join('\n'))}`, limit).map((text) => json(ch.target, { text }));
    case 'discord':
      return splitText(`**${m.title}**\n${m.lines.join('\n')}`, limit).map((content) =>
        json(ch.target, { content, allowed_mentions: { parse: [] } }),
      );
    case 'telegram':
      return splitText(plainText(m), limit).map((text) =>
        json(`https://api.telegram.org/bot${ch.secret}/sendMessage`, { chat_id: ch.target, text, disable_web_page_preview: true }),
      );
    case 'webhook':
      return [json(ch.target, { type: m.kind, title: m.title, text: m.lines.join('\n'), lines: m.lines, ...m.data, sent_at: new Date().toISOString() })];
    case 'email':
      return [
        json(
          'https://api.resend.com/emails',
          { from: env.ALERT_EMAIL_FROM, to: [ch.target], subject: m.title, text: plainText(m), html: emailHtml(m) },
          { authorization: `Bearer ${env.RESEND_API_KEY}` },
        ),
      ];
  }
}

// ---------- email through Cloudflare Email Routing

/** Base64 of the text's UTF-8 bytes. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A header value: printable ASCII as it is, anything else as RFC 2047 encoded words of at most 75 characters. */
function headerText(text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (new TextEncoder().encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64Utf8(w)}?=`).join('\r\n ');
}

/** The address in `FounderData <alerts@example.com>`, or the whole value when it is a bare address. */
export const addressOf = (from: string) => (from.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? from).trim();

function fromHeader(from: string): string {
  const addr = addressOf(from);
  const name = from.replace(/<[^>]*>/, '').trim().replace(/^"|"$/g, '');
  if (!name || name === addr) return addr;
  return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}" <${addr}>` : `${headerText(name)} <${addr}>`;
}

/**
 * A complete MIME message (RFC 5322): plain text and HTML as multipart/alternative, both base64 in UTF-8, with the
 * Date and Message-ID headers Email Routing requires. No dependencies.
 */
export function mimeMessage(p: { from: string; to: string; subject: string; text: string; html: string; now?: number; id?: string }): string {
  const boundary = `rt-${p.id ?? randomId(16)}`;
  const domain = addressOf(p.from).split('@')[1] ?? 'localhost';
  const lines = (b64: string) => b64.match(/.{1,76}/g)?.join('\r\n') ?? '';
  return [
    `From: ${fromHeader(p.from)}`,
    `To: ${addressOf(p.to)}`,
    `Subject: ${headerText(p.subject)}`,
    `Date: ${new Date(p.now ?? Date.now()).toUTCString()}`,
    `Message-ID: <${p.id ?? randomId(16)}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    lines(base64Utf8(p.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    lines(base64Utf8(p.html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Send an email through the EMAIL binding. Cloudflare delivers only to verified destination addresses of the account. */
async function sendWithBinding(env: Partial<Env>, to: string, m: AlertMessage): Promise<SendResult> {
  try {
    const from = env.ALERT_EMAIL_FROM!;
    const raw = mimeMessage({ from, to, subject: m.title, text: plainText(m), html: emailHtml(m) });
    const { EmailMessage } = await import('cloudflare:email');
    await env.EMAIL!.send(new EmailMessage(addressOf(from), to, raw));
    return { ok: true, status: 200 };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message || 'Cloudflare did not send the email' };
  }
}

/** Deliver one message to one channel. Never throws. Email is skipped when the Worker has no way to send it. */
export async function deliver(env: Partial<Env>, ch: ChannelRow, m: AlertMessage, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  if (ch.kind === 'email') {
    const via = emailTransport(env);
    if (!via) return { ok: false, status: 0, error: `Email is off. ${EMAIL_OFF}` };
    if (via === 'cloudflare') return sendWithBinding(env, ch.target, m);
  }
  let last: SendResult = { ok: false, status: 0 };
  for (const r of requestsFor(env, ch, m)) {
    try {
      const res = await fetchFn(r.url, { ...r.init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        return { ok: false, status: res.status, error: text || res.statusText || `HTTP ${res.status}` };
      }
      last = { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message || 'The request failed' };
    }
  }
  return last;
}

/**
 * Send to every channel that wants `kind` for `siteId`. `build` makes the message per channel (the weekly report
 * covers the channel's own sites) and may return null to skip it. Returns how many channels got it.
 */
export async function broadcast(
  env: Partial<Env> & { DB: D1Database },
  kind: AlertKind,
  siteId: string | null,
  build: (ch: ChannelRow) => AlertMessage | null | Promise<AlertMessage | null>,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const channels = (await allChannels(env.DB)).filter((ch) => wants(ch, kind, siteId));
  const sent = await Promise.all(
    channels.map(async (ch) => {
      const m = await build(ch);
      if (!m) return false;
      const r = await deliver(env, ch, m, fetchFn);
      if (!r.ok) console.error(`Alert to ${ch.kind} channel "${ch.name}" failed`, r.status, r.error);
      return r.ok;
    }),
  );
  return sent.filter(Boolean).length;
}

// ---------- payments

const PROVIDERS: Record<string, string> = { dodo: 'Dodo Payments', stripe: 'Stripe', app_store: 'App Store', google_play: 'Google Play', revenuecat: 'RevenueCat', api: 'Payments API', lemonsqueezy: 'Lemon Squeezy', polar: 'Polar', paddle: 'Paddle', gumroad: 'Gumroad' };

export function paymentMessage(site: Site, n: PaymentPush, src: { source: string; channel: string } | null): AlertMessage {
  const money = n.amount !== undefined && n.currency ? formatMoney(Math.abs(n.amount), n.currency) : null;
  // The product goes in the title when known: with many products, it is what people scan for.
  const product = n.product?.trim() ? n.product.trim().slice(0, 100) : null;
  const title =
    n.event === 'trial'
      ? `Trial started on ${site.name}${product ? `: ${product}` : ''}`
      : `${{ purchase: 'New payment', renewal: 'Renewal', refund: 'Refund' }[n.event]} on ${site.name}${money ? `: ${money}` : ''}${product ? `${money ? ',' : ':'} ${product}` : ''}`;
  const source = !src ? 'no linked visit' : src.channel === 'Direct' || !src.source ? 'Direct' : `${src.source} (${src.channel})`;
  const provider = PROVIDERS[n.provider] ?? n.provider;
  const late = lateDate(n, site.timezone);
  return {
    kind: n.event,
    title,
    lines: [n.product ? `Product: ${n.product}` : null, `Source: ${source}`, `Provider: ${provider}`, late ? `Paid on ${late}, arrived late` : null].filter((l): l is string => !!l),
    data: {
      site: { id: site.id, name: site.name, domain: site.domain },
      event: n.event,
      id: n.id,
      provider: n.provider,
      amount: n.amount ?? null,
      currency: n.currency ?? null,
      amount_text: money,
      product: n.product ?? null,
      source: src?.source ?? null,
      channel: src?.channel ?? null,
    },
  };
}

/** Alert the channels about a recorded payment, renewal, refund or trial. Reads only; never throws. */
export async function alertPayment(env: Env, site: Site, n: PaymentPush, fetchFn: typeof fetch = fetch): Promise<number> {
  if (n.sandbox) return 0;
  try {
    const kind = n.event as AlertKind;
    const channels = (await allChannels(env.DB)).filter((ch) => wants(ch, kind, site.id));
    if (!channels.length) return 0;
    const src = n.sessionId
      ? await env.DB.prepare('SELECT source, channel FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, n.sessionId).first<{ source: string; channel: string }>()
      : null;
    const m = paymentMessage(site, n, src);
    const sent = await Promise.all(channels.map((ch) => deliver(env, ch, m, fetchFn)));
    return sent.filter((r) => r.ok).length;
  } catch {
    // An alert failure never fails the webhook that recorded the payment.
    return 0;
  }
}

// ---------- subscriptions: payment failed, canceled

/** The fields of a subscription row the alert names (src/worker/subscriptions.ts SubRow). */
export interface SubscriptionAlertRow {
  id: string;
  provider: string;
  product: string | null;
  customer_id: string | null;
  mrr: number | null;
  expires_at: number | null;
  ended_at: number | null;
  channel: string | null;
  source: string | null;
  campaign: string | null;
}

const dayText = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function subscriptionMessage(
  site: Site,
  kind: 'payment_failed' | 'canceled',
  r: SubscriptionAlertRow,
  customer: { email: string | null; name: string | null },
  now = Date.now(),
): AlertMessage {
  const product = r.product?.trim() ? r.product.trim().slice(0, 100) : null;
  const who = customer.name && customer.email ? `${customer.name} <${customer.email}>` : (customer.email ?? customer.name ?? null);
  const mrr = r.mrr ? formatMoney(r.mrr, site.currency) : null;
  const provider = PROVIDERS[r.provider] ?? r.provider;
  const source = !r.source ? 'no linked visit' : r.channel === 'Direct' ? 'Direct' : `${r.source}${r.channel ? ` (${r.channel})` : ''}`;
  const ended = r.ended_at != null && r.ended_at <= now;
  const title =
    kind === 'payment_failed'
      ? `Payment failed on ${site.name}${who || product ? `: ${[who, product].filter(Boolean).join(', ')}` : ''}`
      : `Subscription ${ended ? 'ended' : 'canceled'} on ${site.name}${product ? `: ${product}` : ''}${mrr ? `, ${mrr} MRR` : ''}`;
  const lines = [
    `Customer: ${who ?? (r.customer_id ? `${r.customer_id}, no email known` : 'not known')}`,
    product ? `Product: ${product}` : null,
    mrr ? `${kind === 'payment_failed' ? 'MRR at risk' : 'MRR lost'}: ${mrr} a month` : null,
    kind === 'canceled' && !ended && r.expires_at && r.expires_at > now ? `Paid until ${dayText(r.expires_at)}, then it ends.` : null,
    kind === 'payment_failed' ? `${provider} retries the card. Until a payment goes through, the subscription counts as past due.` : null,
    `Source: ${source}${r.campaign ? `, campaign ${r.campaign}` : ''}`,
    `Provider: ${provider}`,
  ].filter((l): l is string => !!l);
  return {
    kind,
    title,
    lines,
    data: {
      site: { id: site.id, name: site.name, domain: site.domain },
      event: kind === 'canceled' && ended ? 'ended' : kind,
      subscription_id: r.id,
      provider: r.provider,
      product: r.product,
      customer_id: r.customer_id,
      customer_email: customer.email,
      customer_name: customer.name,
      mrr: r.mrr,
      currency: site.currency,
      mrr_text: mrr,
      ends_at: r.ended_at != null ? new Date(r.ended_at).toISOString() : r.expires_at != null ? new Date(r.expires_at).toISOString() : null,
      source: r.source,
      channel: r.channel,
      campaign: r.campaign,
    },
  };
}

/**
 * Alert the channels that a paying subscription's payment failed, or that it was canceled or ended. subscriptions.ts
 * calls it once, from the write that changed the row. The customer's email and name come from the event, else from
 * the latest payment of that customer. Reads only; never throws.
 */
export async function alertSubscription(
  db: D1Database,
  site: Site,
  kind: 'payment_failed' | 'canceled',
  r: SubscriptionAlertRow,
  customer: { email?: string | null; name?: string | null } = {},
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  try {
    const env = envFor(db);
    // The inbox row first, also without a channel: an agent asks for failed renewals there. No customer in it.
    const bare = subscriptionMessage(site, kind, r, { email: null, name: null });
    await recordEvents(db, [messageEvent({ ...bare, lines: bare.lines.filter((l) => !l.startsWith('Customer:')) }, site.id)]);
    const channels = (await allChannels(db)).filter((ch) => wants(ch, kind, site.id));
    if (!channels.length) return 0;
    let email = customer.email ?? null;
    let name = customer.name ?? null;
    if ((!email || !name) && r.customer_id) {
      const p = await db
        .prepare('SELECT email, name FROM payments WHERE site_id = ? AND customer_id = ? AND (email IS NOT NULL OR name IS NOT NULL) ORDER BY ts DESC LIMIT 1')
        .bind(site.id, r.customer_id)
        .first<{ email: string | null; name: string | null }>();
      email ??= p?.email ?? null;
      name ??= p?.name ?? null;
    }
    const m = subscriptionMessage(site, kind, r, { email, name });
    const sent = await Promise.all(channels.map((ch) => deliver(env, ch, m, fetchFn)));
    return sent.filter((x) => x.ok).length;
  } catch {
    return 0;
  }
}

// Alerts started while a webhook records an event, finished after its response: the route's middleware passes them
// to waitUntil (src/worker/index.ts). Elsewhere they run on their own.
const pending = new WeakMap<D1Database, Promise<unknown>[]>();

/** Run `p` after the response of the request that uses this database. */
export function later(db: D1Database, p: Promise<unknown>) {
  const key = rawDb(db);
  if (!pending.has(key)) pending.set(key, []);
  pending.get(key)!.push(p.catch(() => undefined));
}

/** The alerts started since the last call, as one promise, or null. */
export function takeLater(db: D1Database): Promise<unknown> | null {
  const list = pending.get(rawDb(db));
  if (!list?.length) return null;
  pending.delete(rawDb(db));
  return Promise.all(list);
}

export const fmtInt = (n: number) => new Intl.NumberFormat('en').format(n);

// ---------- the daily write cap

/**
 * budget.ts calls this when its add to `site_usage` stored today's cap time: `site` reached its own cap, or with
 * `site` null, all sites together filled the shared pool of the automatic cap. Only the instance whose time was stored
 * calls, so each cap alerts once a day. Never throws.
 */
export async function capReached(db: D1Database, site: Site | null, now: number, cap: number, fetchFn: typeof fetch = fetch): Promise<number> {
  try {
    await recordEvents(db, [messageEvent(capMessage(site, now, cap), site?.id ?? null)], now);
    return await broadcast(envFor(db), 'cap', site?.id ?? null, () => capMessage(site, now, cap), fetchFn);
  } catch {
    return 0;
  }
}

/** The write cap alert: `site` reached its own cap, or with `site` null, the shared pool is full. */
export function capMessage(site: Pick<Site, 'id' | 'name' | 'domain'> | null, now: number, cap: number): AlertMessage {
  const at = new Date(now).toISOString().slice(11, 16);
  return site
    ? {
        kind: 'cap',
        title: `${site.name} reached its daily write cap`,
        lines: [
          `It wrote its cap of ${fmtInt(cap)} rows by ${at} UTC.`,
          'Until 00:00 UTC, its website events are dropped. Its app keeps events on the phone and sends them after the reset.',
          "To raise the cap, open the site's Settings, Daily write cap.",
        ],
        data: { site: { id: site.id, name: site.name, domain: site.domain }, cap, capped_at: now },
      }
    : {
        kind: 'cap',
        title: 'The shared daily write cap is full',
        lines: [
          `All sites together wrote ${fmtInt(cap)} rows by ${at} UTC.`,
          'Until 00:00 UTC, sites on the automatic cap drop website events. Their apps keep events on the phone and send them after the reset.',
          'To keep a busy site apart from the others, give it its own cap in its Settings, Daily write cap.',
        ],
        data: { site: null, cap, capped_at: now },
      };
}

// ---------- webhook deliveries refused for a bad signature

/** What a refused delivery means per provider, and what to check. */
const REFUSED: Record<string, { why: string; check: string }> = {
  stripe: { why: 'a bad signature', check: "Check that the signing secret (whsec_...) in the site's Settings, Payments matches the endpoint in Stripe." },
  dodo: { why: 'a bad signature', check: "Check that the webhook secret in the site's Settings, Payments matches the one in Dodo Payments." },
  lemonsqueezy: { why: 'a bad signature', check: "Check that the signing secret in the site's Settings, Payments matches the webhook in Lemon Squeezy." },
  polar: { why: 'a bad signature', check: "Check that the webhook secret in the site's Settings, Payments matches the one in Polar." },
  paddle: { why: 'a bad signature', check: "Check that the secret key in the site's Settings, Payments matches the notification destination in Paddle." },
  gumroad: { why: 'a wrong token or seller id', check: "Check that the ping URL in Gumroad is the one in the site's Settings, Payments. A new URL turns the old one off." },
  revenuecat: { why: 'a wrong authorization header', check: "Check that the authorization header in RevenueCat matches the one in the site's Settings, Payments." },
  app_store: { why: 'a signature that did not verify', check: 'Check the App Store Server Notifications URL in App Store Connect and the bundle id in Settings.' },
};

/** The provider's name for alerts and Worth a look. */
export const providerName = (provider: string) => PROVIDERS[provider] ?? provider;

/**
 * "Lemon Squeezy: 4 deliveries to ShipKit refused today for a bad signature. Check that ..." `day` is the UTC day the
 * count is for, `today` the current UTC day.
 */
export function refusedText(siteName: string, provider: string, count: number, day: string, today: string): string {
  const r = REFUSED[provider] ?? { why: 'a bad signature', check: "Check the webhook secret in the site's Settings, Payments." };
  const when = day === today ? 'today' : 'yesterday (UTC)';
  const n = count === 1 ? '1 delivery' : `${fmtInt(count)} deliveries`;
  return `${providerName(provider)}: ${n} to ${siteName} refused ${when} for ${r.why}. ${r.check}`;
}

export function refusedMessage(site: Pick<Site, 'id' | 'name' | 'domain'>, provider: string, count: number, now: number): AlertMessage {
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    kind: 'webhook_refused',
    title: `${providerName(provider)} webhooks refused on ${site.name}`,
    lines: [
      refusedText(site.name, provider, count, day, day),
      'A payment sent with a bad signature is not recorded. Most providers retry for a day or more, so fixing the secret now recovers it.',
    ],
    data: { site: { id: site.id, name: site.name, domain: site.domain }, provider, refused: count, at: new Date(now).toISOString() },
  };
}

/** Alert the first refused delivery of the day for a site and provider (budget.ts decides which). Never throws. */
export async function alertWebhookRefused(env: Env, site: Site, provider: string, count: number, now: number, fetchFn: typeof fetch = fetch): Promise<number> {
  try {
    await recordEvents(env.DB, [messageEvent(refusedMessage(site, provider, count, now), site.id)], now);
    return await broadcast(env, 'webhook_refused', site.id, () => refusedMessage(site, provider, count, now), fetchFn);
  } catch {
    return 0;
  }
}
