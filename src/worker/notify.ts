import type { Context } from 'hono';
import { alertPayment } from './alerts';
import type { AppEnv, Env, Site } from './env';
import type { PerEur } from './fx';
import { proHooks } from './pro-hooks';

export type { PerEur };

/**
 * Money events: the text of an alert and the announcement of a recorded payment, refund or trial. Phone pushes
 * (docs/MOBILE-API.md section 3) belong to Pro and run through the `phonePush` hook.
 */

export type PushEventKind = 'purchase' | 'renewal' | 'refund' | 'trial';
/** What a recorded payment, refund or trial tells the push code. `amount` is minor units, sign ignored. */
export interface PaymentPush {
  event: PushEventKind;
  /** Payment id, or the signal id for a trial. */
  id: string;
  provider: string;
  /** App Store sandbox: never pushes. */
  sandbox: boolean;
  amount?: number;
  currency?: string;
  product?: string | null;
  sessionId?: string | null;
  /** When the payment happened. A payment that reaches us more than a day later says its date in the alert. */
  ts?: number;
}

/** How a webhook or API call runs a push after the response. `defer` returns a promise when it must be awaited. */
export interface Pusher {
  env: Env;
  defer: (p: Promise<unknown>) => void | Promise<unknown>;
}

/** The pusher of a request: runs through `executionCtx.waitUntil`, or is awaited where the request has no context. */
export function pusherOf(c: Context<AppEnv>): Pusher {
  let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    // No ExecutionContext on this request.
  }
  return { env: c.env, defer: ctx ? (p) => ctx!.waitUntil(p) : (p) => p };
}

/**
 * Start the push and the channel alerts (src/worker/alerts.ts) for a recorded event. Every provider path calls this
 * once per new payment, refund or trial. A failure never reaches the caller.
 */
export async function announce(push: Pusher | undefined, site: Site, n: PaymentPush) {
  if (!push || n.sandbox) return;
  const jobs: Promise<unknown>[] = [alertPayment(push.env, site, n).catch(() => 0)];
  // Loaded on use: payments.ts imports this file, and edition.ts pulls in the whole Pro tree, which imports payments.ts.
  const pro = proHooks();
  const phone = pro?.phonePush?.(push.env, site, n);
  if (phone) jobs.push(phone.catch(() => undefined));
  await push.defer(Promise.all(jobs));
}

const PROVIDER_LABELS: Record<string, string> = {
  dodo: 'Dodo Payments',
  stripe: 'Stripe',
  app_store: 'App Store',
  google_play: 'Google Play',
  revenuecat: 'RevenueCat',
  api: 'Payments API',
  lemonsqueezy: 'Lemon Squeezy',
  polar: 'Polar',
  paddle: 'Paddle',
  gumroad: 'Gumroad',
};

/** "$4.90", "€12.00", "¥490": the amount in the payment's own currency. */
export function formatMoney(amount: number, currency: string): string {
  try {
    const f = new Intl.NumberFormat('en', { style: 'currency', currency });
    return f.format(amount / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${amount / 100} ${currency}`;
  }
}

const PREFIX: Partial<Record<PushEventKind, string>> = { renewal: 'Renewal', refund: 'Refund', trial: 'Trial' };

/** Payments delivered later than this after they happened name their date: an App Store notification can arrive days late. */
export const LATE_PAYMENT_MS = 24 * 3600_000;

/** `29 Oct` in the site's timezone when the payment arrived more than a day after it happened, else null. */
export function lateDate(n: Pick<PaymentPush, 'ts'>, timezone: string | undefined, now = Date.now()): string | null {
  if (!n.ts || now - n.ts <= LATE_PAYMENT_MS) return null;
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timezone || 'UTC' }).format(n.ts);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(n.ts);
  }
}

/**
 * The alert text: `Site · $4.90` over `Product · from Google`. Renewals, refunds and trials start the body with their
 * name. A payment delivered more than a day late ends the body with `paid 29 Oct`.
 */
export function alertText(siteName: string, n: PaymentPush, source: string | null, timezone?: string, now = Date.now()) {
  const title = n.amount !== undefined && n.currency ? `${siteName} · ${formatMoney(Math.abs(n.amount), n.currency)}` : siteName;
  const late = lateDate(n, timezone, now);
  const body = [PREFIX[n.event], n.product || PROVIDER_LABELS[n.provider] || n.provider, source ? `from ${source}` : null, late ? `paid ${late}` : null]
    .filter(Boolean)
    .join(' · ');
  return { title, body };
}

