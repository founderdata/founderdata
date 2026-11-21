import { refusedText } from './alerts';
import type { RefusedWebhook } from './budget';
import type { AttentionItem } from './home';
import { REAL } from './stats';

/**
 * "Payments stopped arriving" (docs/GUIDE.md, "Alerts and weekly report"): a payment provider that used to send a
 * site payments and has sent none for longer than its usual rhythm explains. The usual cause is a webhook that broke:
 * a rotated signing secret, an endpoint deleted in the provider's dashboard, a changed URL.
 *
 * The rule, per site and provider (sandbox purchases left out, refunds and renewals counted, since they prove the
 * webhook works):
 *
 * - `usual`: the payments in the 28 days up to the provider's last one.
 * - With 8 or more (two a week), `need` is the days of silence after which the provider would normally have sent 5
 *   payments, and at least 3: `max(3, ceil(5 × 28 / usual))`. 47 or more payments in 28 days: 3 days. 28 (one a
 *   day): 5 days. 8: 18 days. With payments arriving at random at the usual rate, a gap that long happens by chance
 *   less than 1% of the time. After 60 days without a payment the provider is left out again: it was most likely
 *   switched off on purpose.
 * - With fewer than 8, a small product: when the provider sent at least 2 payments in the 90 days up to its last one,
 *   `need` is twice the longest gap between those payments, and at least 14 days: `max(14, 2 × longest gap)`. A
 *   product that sells every 5 to 10 days waits 20 days; one with a 30-day gap waits 60. It is left out after
 *   `max(60, need + 42)` days, so it gets the first alert and about 6 weekly ones. The payments API's `income` rows
 *   are typed in by hand and stay out of this rule.
 *
 * One read of `payments` (its last 222 days, then the 90 days before each silent provider's last payment), only from
 * the home page and the daily cron. Nothing on the payment path.
 */

const DAY = 86_400_000;
/** Payments in 28 days below which the rate says too little and the gap rule takes over. */
export const MIN_USUAL = 8;
/** The payments a silent stretch would usually hold before it counts as stopped. */
const EXPECTED = 5;
const MIN_DAYS = 3;
const BASE_DAYS = 28;
const GIVE_UP_DAYS = 60;
/** Small products: the days of history the longest gap is read from, the least silence, and the extra weeks. */
const GAP_DAYS = 90;
const MIN_GAP_DAYS = 14;
const SMALL_EXTRA_DAYS = 42;
/** The oldest last payment any rule looks at: a 90-day gap doubled, plus the extra weeks. */
const LOOKBACK_DAYS = 2 * GAP_DAYS + SMALL_EXTRA_DAYS;

const NAMES: Record<string, string> = {
  stripe: 'Stripe',
  dodo: 'Dodo Payments',
  app_store: 'The App Store',
  google_play: 'Google Play',
  revenuecat: 'RevenueCat',
  api: 'The payments API',
  income: 'The payments API (income)',
  lemonsqueezy: 'Lemon Squeezy',
  polar: 'Polar',
  paddle: 'Paddle',
  gumroad: 'Gumroad',
};

const HINTS: Record<string, string> = {
  stripe: "Check the webhook endpoint in Stripe and the signing secret in the site's Settings.",
  app_store: 'Check the App Store Server Notifications URL in App Store Connect.',
  google_play: "Check the Pub/Sub push subscription for the Play topic and the site's push service account in Settings.",
  revenuecat: "Check the webhook in RevenueCat and its authorization header in the site's Settings.",
  api: 'Check the script or service that calls /api/v1/payments.',
  income: 'Check the script or service that calls /api/v1/payments.',
  gumroad: "Check the ping URL in Gumroad's settings.",
};

export interface StoppedProvider {
  siteId: string;
  siteName: string;
  provider: string;
  /** Time of the provider's last payment for the site. */
  last: number;
  /** Payments in the 28 days up to `last`. */
  usual: number;
  /** Days without a payment after which it counts as stopped. */
  need: number;
  /** Whole days since `last`. */
  days: number;
  /** Small products (`usual` below 8): the longest gap in whole days between payments in the 90 days up to `last`. */
  gap?: number;
}

/** Days of silence after which a provider with `usual` payments in 28 days counts as stopped. */
export const daysNeeded = (usual: number) => Math.max(MIN_DAYS, Math.ceil((EXPECTED * BASE_DAYS) / usual));

/** Days of silence after which a small product whose longest recent gap was `gapDays` counts as stopped. */
export const gapDaysNeeded = (gapDays: number) => Math.max(MIN_GAP_DAYS, Math.ceil(2 * gapDays));

/** Providers that stopped sending payments, per site, longest silence first. */
export async function stoppedProviders(db: D1Database, now: number): Promise<StoppedProvider[]> {
  // The payment times of every provider silent for 3 days or more, over the 90 days up to its last payment.
  const { results } = await db
    .prepare(
      `SELECT l.site_id, st.name, l.provider, l.last, q.ts
       FROM (SELECT p.site_id, p.provider, MAX(p.ts) AS last FROM payments p WHERE p.ts > ?1 AND ${REAL} GROUP BY p.site_id, p.provider) l
       JOIN sites st ON st.id = l.site_id
       JOIN payments q ON q.site_id = l.site_id AND q.provider = l.provider AND q.ts > l.last - ?3 AND q.ts <= l.last
       WHERE l.last <= ?2
       ORDER BY l.site_id, l.provider, q.ts`,
    )
    .bind(now - LOOKBACK_DAYS * DAY, now - MIN_DAYS * DAY, GAP_DAYS * DAY)
    .all<{ site_id: string; name: string; provider: string; last: number; ts: number }>();
  const groups = new Map<string, { siteId: string; siteName: string; provider: string; last: number; times: number[] }>();
  for (const r of results) {
    const key = `${r.site_id} ${r.provider}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { siteId: r.site_id, siteName: r.name, provider: r.provider, last: r.last, times: [] }));
    g.times.push(r.ts);
  }
  const out: StoppedProvider[] = [];
  for (const g of groups.values()) {
    const days = Math.floor((now - g.last) / DAY);
    const usual = g.times.filter((t) => t > g.last - BASE_DAYS * DAY).length;
    if (usual >= MIN_USUAL) {
      const need = daysNeeded(usual);
      if (days >= need && days <= GIVE_UP_DAYS) out.push({ siteId: g.siteId, siteName: g.siteName, provider: g.provider, last: g.last, usual, need, days });
      continue;
    }
    if (g.provider === 'income' || g.times.length < 2) continue;
    let longest = 0;
    for (let i = 1; i < g.times.length; i++) longest = Math.max(longest, g.times[i] - g.times[i - 1]);
    const gap = Math.round(longest / DAY);
    const need = gapDaysNeeded(longest / DAY);
    if (days >= need && days <= Math.max(GIVE_UP_DAYS, need + SMALL_EXTRA_DAYS)) {
      out.push({ siteId: g.siteId, siteName: g.siteName, provider: g.provider, last: g.last, usual, need, days, gap });
    }
  }
  return out.sort((a, b) => b.days - a.days || a.siteName.localeCompare(b.siteName));
}

/**
 * "Stripe has sent ShipKit no payment for 6 days. It sent 31 in the 28 days before. Check ...", or for a small product
 * "Gumroad has sent Zine Pack no payment for 41 days. Its longest gap in the 90 days before was 18 days. Check ..."
 */
export function stoppedText(s: StoppedProvider): string {
  const name = NAMES[s.provider] ?? s.provider;
  const hint = HINTS[s.provider] ?? `Check the webhook in ${name} and its secret in the site's Settings.`;
  const before =
    s.gap === undefined
      ? `It sent ${s.usual} in the 28 days before.`
      : `Its longest gap between payments in the 90 days before was ${s.gap} ${s.gap === 1 ? 'day' : 'days'}.`;
  return `${name} has sent ${s.siteName} no payment for ${s.days} days. ${before} ${hint}`;
}

export function stoppedItems(list: StoppedProvider[]): AttentionItem[] {
  return list.map((s) => ({ siteId: s.siteId, kind: 'payments_stopped', text: stoppedText(s), link: 'settings' }));
}

/** The daily alert goes out on the first day a provider counts as stopped, then once a week while it stays so. */
export const alertToday = (s: StoppedProvider) => s.days === s.need || (s.days - s.need) % 7 === 0;

/**
 * Webhook deliveries refused for a bad signature or token in the last 24 hours (budget.ts, refusedWebhooks), as
 * Worth a look items. Whatever the sales volume: one refused delivery is a payment that was not recorded.
 */
export function refusedItems(list: RefusedWebhook[], sites: { id: string; name: string }[], now: number): AttentionItem[] {
  const name = new Map(sites.map((s) => [s.id, s.name]));
  const today = new Date(now).toISOString().slice(0, 10);
  return list
    .filter((r) => name.has(r.siteId))
    .map((r) => ({ siteId: r.siteId, kind: 'webhook_refused', text: refusedText(name.get(r.siteId)!, r.provider, r.count, r.day, today), link: 'settings' }));
}
