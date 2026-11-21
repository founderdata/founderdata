// The rest of the read API (docs/API.md, "Read"): what the dashboard's logged-in routes answer, for one site, with a
// read key (Authorization: Bearer rtr_...). Each route calls the same function or handler as its /api/sites/:id route,
// so the numbers match the dashboard. Answers go through share.ts's `cached`: 60 s reuse and 120 misses per key a
// minute. Names, emails and user ids are set to null (auth.ts `scrub`), and a key without revenue gets no revenue.
import type { Context, Hono, Next } from 'hono';
import { weeklyRoute } from './digest';
import { scrub } from './auth';
import type { AppEnv, Site } from './env';
import { convertPayments } from './fx';
import { exportForKey, MONEY_TABLES } from './export';
import { PERIODS, previousRange } from './lib/time';
import { goalByEntryPage, goalLabel } from './primary-goal';
import {
  actorStats,
  actorStatsRoute,
  contentPage,
  dueNotesRoute,
  handleNoteReviewApi,
  impactWithoutRevenue,
  listNotesApi,
  noteImpact,
  parseActorQuery,
  parseImpactWindow,
  parseMetric,
} from './notes';
import { currencyDecimals } from './payments';
import { ALL_SITES, allSitesOf, cacheKey, cached, rangeOut, readKeyAnySite, readKeyOf, requireReadKey, SHARE_TTL, tokenOf, type Computed } from './share';
import { CUSTOMER_KINDS, funnel, nativeBreakdown, customers, type CustomerKind, makeCtx, pageOf, type BreakdownRow, type Ctx, type FunnelStep } from './stats';
import { dataLocation } from './location';
import { canRead, LEGACY_SCOPES, SCOPE_TEXT, type Scope } from './keys';
import { compactSources, siteTrust, trustForKey, type SiteTrust } from './sources';
import { vitalsRoute, withPageScroll } from './vitals';
import { proHooks } from './pro-hooks';
import { partDefinitions } from './core-parts';
import { VERSION } from '../shared/product';
import { parseSurveys, SURVEYS } from '../shared/surveys';

/** The range parameters every ranged route takes; `cacheKey` keeps only the parameters a route names. */
export const RANGE = ['period', 'from', 'to', 'filters'];

/** An answer that is not 200, thrown from inside `compute` so nothing is cached. */
export class Refused extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `from` or `to` without `period` means a custom range, as on the other read routes. The dashboard's handlers read
 * `period=custom`, so the request gets it before they run (and before the cache key is made).
 */
/**
 * Every /api/v1 route: a period outside the documented list answers 400 naming the list, instead of the 30-day default
 * (index.ts registers it). `custom` comes with from and to.
 */
export async function checkPeriod(c: Context<AppEnv>, next: Next) {
  const p = c.req.query('period');
  if (p !== undefined && !(PERIODS as readonly string[]).includes(p)) {
    return c.json({ error: `period is one of ${PERIODS.filter((x) => x !== 'custom').join(', ')}, or send from and to as YYYY-MM-DD` }, 400);
  }
  await next();
}

export async function customRange(c: Context<AppEnv>, next: Next) {
  const url = new URL(c.req.url);
  if ((url.searchParams.get('from') || url.searchParams.get('to')) && url.searchParams.get('period') !== 'custom') {
    url.searchParams.set('period', 'custom');
    c.req.raw = new Request(url, c.req.raw);
  }
  await next();
}

/** Every key whose name says revenue, at any depth: what a key without revenue must not see in app answers. */
function withoutRevenue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutRevenue);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !/revenue/i.test(k)).map(([k, x]) => [k, withoutRevenue(x)]));
}

interface RouteOpts {
  /** Query parameters that change the answer. */
  params: string[];
  /** `block`: a key without revenue gets 403. `strip`: it gets the answer without revenue fields. */
  money?: 'block' | 'strip';
  /**
   * Pass the body through as it is: answers with no person or secret in them (SEO, ASO, notes). The route leaves out
   * revenue itself for a key without it.
   */
  raw?: boolean;
}

type Run = (c: Context<AppEnv>) => Promise<Response | unknown>;

/** A read key route around `run`, which returns a dashboard handler's Response or the value its function returns. */
export function readRoute(name: string, opts: RouteOpts, run: Run) {
  return async (c: Context<AppEnv>) => {
    const showRevenue = !!tokenOf(c).show_revenue;
    if (opts.money === 'block' && !showRevenue) {
      return c.json({ error: `This key hides revenue. /api/v1/${name} needs the read:revenue scope, or a read key that shows revenue.` }, 403);
    }
    try {
      return await cached(c, cacheKey(c, name, opts.params), SHARE_TTL, 'application/json', async (): Promise<Computed> => {
        if (opts.money) await convertPayments(c.env.DB).catch(() => 0);
        const out = await run(c);
        let value: unknown = out;
        let headers: Record<string, string> | undefined;
        if (out instanceof Response) {
          if (out.status !== 200) {
            const err = await out.json<{ error?: string }>().catch(() => ({}) as { error?: string });
            throw new Refused(out.status === 404 ? 404 : 400, err.error ?? `HTTP ${out.status}`);
          }
          const next = out.headers.get('x-next-offset');
          if (next) headers = { 'x-next-offset': next };
          const cut = out.headers.get('x-truncated');
          if (cut) headers = { ...headers, 'x-truncated': cut };
          if (opts.raw) return { body: await out.text(), headers };
          value = await out.json();
        }
        value = scrub(value, true);
        if (opts.money === 'strip' && !showRevenue) value = withoutRevenue(value);
        return { body: JSON.stringify(value), headers };
      });
    } catch (e) {
      if (e instanceof Refused) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };
}

// ---------- GET /api/v1/content: entry pages by revenue, against the period before

/** Entry pages each period reads: the 500 with the most visitors, the most a breakdown returns. */
const CONTENT_ROWS = 500;

const perVisitor = (revenue: number, visitors: number) => (visitors ? Math.round(revenue / visitors) : 0);

export async function content(ctx: Ctx, opts: { prefix?: string | null; limit?: number } = {}) {
  const before = previousRange(ctx.range, ctx.period, ctx.site.timezone);
  const prevCtx: Ctx = { ...ctx, range: { ...ctx.range, ...before } };
  const [now, prev, goalNow, goalPrev] = await Promise.all([
    nativeBreakdown(ctx, 'entry_page', CONTENT_ROWS),
    nativeBreakdown(prevCtx, 'entry_page', CONTENT_ROWS),
    // The primary goal per entry page (src/worker/primary-goal.ts): no query without one.
    goalByEntryPage(ctx),
    goalByEntryPage(ctx, before.from, before.to),
  ]);
  const goal = ctx.site.primary_goal ? { name: ctx.site.primary_goal, label: goalLabel(ctx.site) } : null;
  const goals = (m: Map<string, number>, page: string) => (goal ? { goal: m.get(page) ?? 0 } : {});
  const pages = (rows: BreakdownRow[]) =>
    rows.filter((r) => !r.appStore && !r.noVisit && r.label !== null && (!opts.prefix || r.label.startsWith(opts.prefix)));
  const earlier = new Map(pages(prev).map((r) => [r.label, r]));
  const limit = Math.max(1, Math.min(CONTENT_ROWS, Math.floor(opts.limit || 100)));
  const rows = pages(now)
    .map((r) => {
      const p = earlier.get(r.label);
      return {
        page: r.label as string,
        visitors: r.visitors,
        customers: r.customers,
        revenue: r.revenue,
        revenue_per_visitor: perVisitor(r.revenue, r.visitors),
        ...goals(goalNow, r.label as string),
        previous: {
          visitors: p?.visitors ?? 0,
          customers: p?.customers ?? 0,
          revenue: p?.revenue ?? 0,
          revenue_per_visitor: perVisitor(p?.revenue ?? 0, p?.visitors ?? 0),
          ...goals(goalPrev, r.label as string),
        },
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors || a.page.localeCompare(b.page))
    .slice(0, limit);
  return {
    ...rangeOut(ctx),
    previous_from: new Date(before.from).toISOString(),
    previous_to: new Date(before.to).toISOString(),
    prefix: opts.prefix || null,
    // The site's primary goal; each row's `goal` counts the visitors who reached it in a visit that entered there.
    goal,
    truncated: now.length >= CONTENT_ROWS || prev.length >= CONTENT_ROWS,
    rows,
  };
}

/** A key without revenue: visitors only. */
function contentWithoutRevenue(out: Awaited<ReturnType<typeof content>>) {
  return {
    ...out,
    rows: out.rows
      .map(({ page, visitors, goal, previous }) => ({
        page,
        visitors,
        ...(goal === undefined ? {} : { goal }),
        previous: { visitors: previous.visitors, ...(previous.goal === undefined ? {} : { goal: previous.goal }) },
      }))
      .sort((a, b) => b.visitors - a.visitors || a.page.localeCompare(b.page)),
  };
}

// ---------- GET /api/v1/definitions: what each number means, in the docs' words

/** docs/GUIDE.md ("How revenue is counted", "Subscriptions", "Accuracy notes", "Cookies and consent") and README. */
export const DEFINITIONS = {
  money:
    'Money is an integer in minor units of the currency the answer names: 2999 with currency USD is $29.99. currency_decimals is the number of decimal digits (2 for USD, 0 for JPY).',
  visitors:
    'Unique visitor ids in the range. On an app-only site, and with the App filter, these are app visitors: without consent one device counts once a day, however often the app opens.',
  visitor_id:
    'Without cookies (the default) the visitor id is a hash of the site id, IP address and user agent, salted with a secret that changes every day at 00:00 UTC. A visitor who comes back after midnight UTC counts as new, and two people on one network with the same browser count as one visitor that day. With cookies (after consent) the id lasts 1 year.',
  sessions: 'A visit lasts while the visitor is active at least every 30 minutes.',
  bounce_rate: 'Sessions with at most one pageview and no goal, over all sessions. Web sessions only.',
  paid_channel:
    'A visit is channel Paid when its landing URL carried an ad click id (gclid, gbraid, wbraid, msclkid, ttclid, twclid, li_fat_id, rdt_cid, ScCid or epik), a Meta ad_id, or a paid utm_medium such as cpc. With a click id the source is the network ("Google Ads"), whatever the referrer says, and click_network names it (google_ads). A Google Ads click from google.com is not organic search.',
  first_touch:
    'get_breakdown with model first credits the source, channel, campaign, referrer_domain and entry_page of the visitor\'s first visit instead of the visit the payment came from. First touch reaches back as far as the visitor id does: one day without cookies. Visitors first seen before it was stored count by their own visit.',
  datacenter:
    'Visits from hosting networks (AWS, Google Cloud, Azure, Hetzner and 10 others) are almost always bots. While show_datacenter is false, every visitor and pageview count leaves them out: overview, breakdowns, pages, funnels, Meta ads, note verdicts, the portfolio, the weekly report and alerts. show_datacenter true (Settings, Count datacenter visits) counts them everywhere. Payments always count. The sessions CSV export keeps every visit, with datacenter 1 on these.',
  revenue:
    'Every payment net of refunds: Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, the payments API and RevenueCat, plus App Store revenue. On days imported from Apple\'s sales report, App Store revenue is the report; on other days it is the App Store purchases FounderData recorded. Sandbox purchases never count.',
  currency_conversion:
    'A payment in another currency than the site\'s counts at the ECB reference rate of the payment day. A payment without a rate yet stays out of the totals until it is converted. The converted amount is not what Stripe or Apple paid out.',
  app_store:
    'App Store amounts are gross: what the customer paid, tax included, before Apple\'s commission. money=net on /api/v1/subscriptions gives the amount after Apple\'s cut.',
  customers: 'New customers: buyers with a payment in the range that is not a renewal. Renewals add revenue, not customers. A buyer is the visitor, else the payment provider\'s customer id, else the payment, so two first purchases by one Stripe or App Store customer count once. Other tools use the word with their own window: an experiment arm counts people whose first payment came after they first saw the experiment (app arms count sessions with a purchase); an error issue counts the people it hit who paid at any time, by any visitor id of theirs; web retention with customers keeps people with any payment.',
  paths:
    'Paths (Pro, get_app_funnel report paths) read the page views of each visit, app screens included unless platform says web. With path: the visits that viewed the page, how many entered or left there, and the pages right before and after it. A share is a count over the views of that page, a page repeated in a row counted once. With sequence (1 to 3 pages in order): the visits that viewed them in that order, and per next page its visits, its share, the share that left right after it, and paid, the share whose visitor paid at the start of the visit or later. Rates are rounded to 3 decimals.',
  conversion_rate: 'New customers over visitors.',
  revenue_per_visitor: 'Revenue over visitors, in minor units of the site currency.',
  attribution:
    'A payment is credited to the buyer\'s last visit that came from a real source, so "clicked the launch tweet, came back directly two weeks later and paid" counts for the tweet. That only works when the visits carry the same visitor id: cookies after consent, identify() with the same user id or email, or the iOS app\'s install id. Without them (the default) the id changes every day at 00:00 UTC, so a buyer who comes back on a later day is credited to that day\'s visits only. Payments with no linked visit show as the row "No source"; App Store revenue that no linked payment explains shows as "App Store, no source". With these two rows the source panels add up to the revenue total.',
  attribution_coverage:
    'attribution on get_breakdown (source dimensions, no filter) and get_portfolio: payments and linked_payments count payments in the range and those credited to a stored visit; amount and linked_amount are their sums before refunds; app_store_no_source is App Store revenue with no payment row; attributed_share is linked_amount over amount plus app_store_no_source, 0 to 1. not_linked says why the others have no visit: before_tracking (paid before the first stored visit), renewals, with_email (an email no visitor was identified with) and no_ids. Read a source ranking as covering attributed_share of the revenue, not all of it.',
  mrr:
    'Every paying subscription at its price per month, at the end of the period. A year counts 1/12, a week 52/12, a 3-month plan 1/3. A price in another currency converts at the ECB rate of the day the price was set.',
  churn:
    'Subscriptions paying at the start of the period that ended in it, over those paying at the start. Turning auto-renew off is not churn; the subscription churns when its paid period runs out.',
  trial_to_paid:
    'Trials that started in the period and paid within 3 days of the trial\'s end (30 days from the start when the end is unknown), over the trials that started and are decided.',
  previous_period:
    'Rolling periods compare with the same length right before. This quarter compares with the same days of the quarter before; last quarter with the whole quarter before.',
  tracking_since:
    'When each kind of data starts for a site (whoami, get_definitions, get_portfolio): web and app are the first visits the tracker and the SDK sent, imported the first day imported from another tool, payments the first payment, app_store the first day of Apple\'s sales report, gsc the first Search Console day, visitors and revenue where those totals start. A period before that starts earlier than visitors or revenue is not comparable: get_overview answers the affected fields of previous as null (previous itself when nothing is left) with previous_reason, and get_portfolio sets visitors_previous or revenue_previous to null. A site that never had a payment compares its revenue as 0 against 0.',
  sources:
    'Integration health per site. Each source has connected, status (ok, stale, error or off), last_ok_at (the last data or the last run without an error), through (the newest day of data, for sources that report whole days), last_error (null when nothing failed after the last success), stale and detail. off means not set up. Before you read a drop, check that the sources behind the number are ok: a stale or failing import looks like a drop.',
  roas:
    'ROAS is revenue credited to the ad over its spend: 0.8 means 80% of the spend came back. Both are in the site currency. get_apple_search_ads view campaigns (roas, net_roas) and view summary (roas, netRoas) give ROAS on what the customer paid and after Apple\'s commission; get_meta_ads counts all revenue credited to visits from the ad, renewals and refunds included. window counts revenue up to that many days after the tap or click; 0 is to date.',
  cpa:
    'CPA (cost_per_paid on Apple Search Ads) is spend over the new paying customers credited to the ad, campaign or keyword, in minor units. null when there was no spend or no customer.',
  ad_spend:
    'Spend of every ad channel (get_paid, get_portfolio ad_spend, get_meta_ads blended): Meta and Apple Search Ads from their imports, other channels from POST /api/v1/spend or a CSV. Each channel counts its own days: Meta the ad account\'s, Apple Search Ads UTC, sent rows the day they name. Spend in another currency converts at the ECB rate of its day; a day without a rate is left out with a warning.',
  mer:
    'MER is all revenue paid in the period, from any source, over all ad spend in it: 3 means every 1 of spend came with 3 of revenue. aMER counts only first purchases. Both need no attribution. get_paid gives them net of Apple\'s cut on App Store payments (mer, amer) with the gross figure beside them (mer_gross, amer_gross); web revenue is what the customer paid, VAT included when the provider includes it. get_meta_ads blended.mer is gross.',
  cac:
    'Blended CAC is all ad spend over every new customer in the period, from any source, in minor units. It needs no attribution, so trust it over a channel\'s cpa when get_paid totals.paid_share is under 0.5. low_volume is true under 3 new customers: CAC and ROAS are noise then.',
  payback:
    'get_paid payback_days: days from the first day of the period until the net revenue of the period\'s new customers, counted to now, covered the period\'s ad spend. null until it has; recovered is the share covered so far, 0.6 is 60%. Above 5,000 new customers in the period both are null and payback_truncated is true.',
  hook_rate: 'Meta video ads (get_meta_ads hookRate and holdRate): the hook rate is 3-second plays over the impressions of ad-days with video plays, 0 to 1, so image ads do not lower it. The hold rate is ThruPlays over 3-second plays.',
  gsc_position:
    'Search Console position is Google\'s average position, weighted by impressions: 1 is the top. A day\'s data arrives 2 to 3 days late, so through on get_seo is the last day it covers. Clicks and impressions are Google\'s numbers, not FounderData visits.',
  mention_rate:
    'AI answers (get_ai_answers): mention_rate is the answers that name the product over the answers measured, 0 to 1; citation_rate is the answers that cite the site\'s domain. null when nothing was measured.',
  verdict:
    'get_note_impact compares the window days after a note (7 by default) with the same days before it. It needs 100 visitors on each side and, with revenue, 10 new customers on both sides together; with less the verdict is inconclusive. It judges revenue per visitor when either side has revenue, else the conversion rate, else visitors (a key without revenue). A change of 10% or more is better or worse. An aso note with target keyword:<term> is judged on that keyword\'s App Store rank. verdict_metric and reason name the rule each answer used.',
  timezone: 'Days, buckets and from/to dates are in the site\'s timezone. Timestamps are ISO 8601 in UTC.',
  filters:
    'The filters argument keeps only matching visits, as the dashboard filters them. Keys: channel, source, referrer_domain, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref, country (ISO code), region, city, browser, os, device, entry_page, exit_page, hostname, app_version, language, click_network, platform (Web or iOS), page (a page viewed in the visit), goal (a goal completed in it) and prop:<name> (an app session property). An empty string matches none. Payments count when the visit they are credited to matches.',
  recordings:
    'Recorded visits (Pro, get_recordings). Dead click: a click followed by no page change within 2,500 ms, no scroll or text selection within 100 ms and no navigation or tab change within 1,000 ms; clicks in text fields, on form controls and labels, on the page margins (html, body), with a modifier key, on mailto:, tel:, sms:, download and new-tab links, and clicks that copy to the clipboard are not counted. Rage click: 3 or more clicks on one element, each under 1 s after the one before. Quick back: the visitor left a page of the site less than 5 s after arriving from another page of the site and went back to that page. Abandoned field: a form field the visitor changed on a page where no form was sent; a form counts as sent when the page moves on within 2 s of a click on a button in it. Score, 0 to 100: +30 an error, +25 rage clicks, +20 dead clicks (+30 for 3 or more), +15 an abandoned field, +10 a quick back, +15 paid or signed up, +10 left from a checkout, pricing, signup or goal page without converting, -30 under 5 s. Patterns read the newest 150 recordings of the period (scanned), keep those that pass the filters (matched) and carry a caveat under 30 matched. duration_s is the recorded span when there is a video, else the length of the visit.',
  query:
    'query compiles each metric with the same rules as the panels: its totals equal get_overview for the range and filters, and its day, week and month buckets equal get_timeseries. Visitors are counted per row, so rows split by time or a dimension can add up to more than the total (one visitor on two days counts on both). Split by a visit dimension, a payment counts on the row of the visit it is credited to; payments without one get note no_visit and App Store revenue no payment explains note app_store_no_source, so revenue rows add up to the total. Split by product or provider, Apple\'s report goes to provider app_store with note app_store_report under product. goal:<name> counts the visitors who completed the goal.',
} as const;

/** What a key may do (keys.ts SCOPES); a read key (rtr_...) has read, plus read:revenue when it shows revenue. */
const scopesOf = (tok: { scopes?: Scope[]; show_revenue: number }) => tok.scopes ?? (tok.show_revenue ? LEGACY_SCOPES.readKeyWithRevenue : LEGACY_SCOPES.readKey);

/** One site's settings, tracking start and source health, for whoami, get_definitions and get_portfolio. */
export function siteFacts(site: Site, trust: SiteTrust | undefined, showRevenue: boolean, full: boolean) {
  const t = trust && trustForKey(trust, showRevenue);
  return {
    timezone: site.timezone,
    currency: site.currency,
    currency_decimals: currencyDecimals(site.currency),
    app: !!site.app_bundle_id,
    type: site.product_type ?? null,
    primary_goal: site.primary_goal ?? null,
    // Visits from hosting networks count (definitions.datacenter).
    show_datacenter: site.show_datacenter === 1,
    tracking_since: t?.tracking_since ?? null,
    // The full block for one site; the status of each source and the ones that need a look for a list of sites.
    sources: t ? (full ? t.sources : compactSources(t.sources)) : null,
  };
}

/**
 * GET /api/v1/definitions: what each number means, the site's settings, when its data starts and how each integration
 * is doing. A key for more than one site without ?site= gets the definitions and every site it covers in short form.
 */
async function definitions(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const showRevenue = !!tok.show_revenue;
  const head = { show_revenue: showRevenue, scopes: scopesOf(tok), data_location: dataLocation(c.env) };
  const tail = { definitions: { ...DEFINITIONS, ...partDefinitions() }, docs: 'https://github.com/founderdata/founderdata/blob/main/docs/API.md' };
  const many = allSitesOf(c);
  if (many) {
    const trust = await siteTrust(c.env, many);
    return c.json(
      {
        site_id: null,
        all_sites: true,
        ...head,
        sites: many.map((s) => ({ id: s.id, name: s.name, domain: s.domain, ...siteFacts(s, trust.get(s.id), showRevenue, false) })),
        ...tail,
      },
      200,
      { 'cache-control': 'private, max-age=60' },
    );
  }
  const site = c.get('site');
  const trust = await siteTrust(c.env, [site]);
  return c.json(
    { site_id: site.id, ...siteFacts(site, trust.get(site.id), showRevenue, true), ...head, ...tail },
    200,
    { 'cache-control': 'private, max-age=60' },
  );
}

// ---------- the App Store tab's answer in minor units (Pro's GET /api/v1/appstore uses it; tests too)

/**
 * The App Store tab keeps Apple's amounts in major units (5.98). The read API answers money in minor units, so every
 * `{ currency, amount }` at any depth becomes an integer in the currency's minor units (598). Exported for tests.
 */
export function inMinorUnits<T>(v: T): T {
  if (Array.isArray(v)) return v.map(inMinorUnits) as T;
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = inMinorUnits(x);
  if (typeof o.currency === 'string' && typeof o.amount === 'number') out.amount = Math.round(o.amount * 10 ** currencyDecimals(o.currency));
  return out as T;
}


// ---------- GET /api/v1/whoami: the key itself, for any live key, whatever its scopes

/**
 * The four Pro capture switches of a site, each on or off with the Settings section that turns it on. Recording a visit
 * also catches its errors, so errors is on when either switch is.
 */
export function captureSwitches(s: Site, origin: string) {
  const url = (anchor: string) => `${origin}/site/${s.id}/settings#${anchor}`;
  const surveys = parseSurveys(s.surveys);
  return {
    recordings: { on: s.record_visits === 1, settings_url: url('record-visits') },
    errors: { on: s.errors_on === 1 || s.record_visits === 1, settings_url: url('catch-errors') },
    click_maps: { on: s.maps_on === 1, settings_url: url('click-maps') },
    surveys: { on: SURVEYS.some((k) => surveys[k]?.on === 1), settings_url: url('surveys') },
  };
}

/**
 * Who is calling: the key's name, scopes, the sites it covers with their names, its expiry, and the deployed Worker
 * version when the CF_VERSION_METADATA binding exists. Works for a key without read too (a push-only seo:write key),
 * so an agent can check a key before it writes. Not cached: it is one indexed read of the sites table.
 */
async function whoami(c: Context<AppEnv>) {
  const tok = await readKeyOf(c);
  if (!tok) return c.json({ error: 'Send an API key: Authorization: Bearer fdk_... (Settings, Agents). This one is unknown, expired or revoked.' }, 401);
  const scoped = tok.scopes !== undefined;
  const scopes: string[] = tok.scopes ?? (tok.show_revenue ? LEGACY_SCOPES.readKeyWithRevenue : LEGACY_SCOPES.readKey);
  // null: every site. A read key (rtr_) for one site covers its site_id.
  const ids = scoped ? (tok.sites ?? null) : tok.site_id === ALL_SITES ? null : [tok.site_id];
  const { results } = await c.env.DB.prepare('SELECT * FROM sites ORDER BY created_at').all<Site>();
  const covered = results.filter((s) => !ids || ids.includes(s.id));
  // A key that reads also gets each site's tracking start and source health; a push-only key gets the ids.
  const reads = canRead(scopes);
  const origin = new URL(c.req.url).origin;
  const trust = reads ? await siteTrust(c.env, covered) : null;
  const sites = covered.map((s) => ({
    id: s.id,
    name: s.name,
    domain: s.domain,
    app: !!s.app_bundle_id,
    ...(trust ? (({ timezone: _t, currency: _c, currency_decimals: _d, app: _a, ...rest }) => rest)(siteFacts(s, trust.get(s.id), !!tok.show_revenue, false)) : {}),
    // Pro's capture switches, so an agent can tell "off" from "quiet" (critique shared-8). Core has none of them.
    ...(reads && proHooks() ? { switches: captureSwitches(s, origin) } : {}),
  }));
  const v = c.env.CF_VERSION_METADATA;
  return c.json(
    {
      key: {
        type: scoped ? 'scoped' : 'read_key',
        id: scoped ? tok.token.replace(/^fdk-/, '') : null,
        name: tok.label,
        scopes,
        can: Object.fromEntries(scopes.filter((s): s is Scope => s in SCOPE_TEXT).map((s) => [s, SCOPE_TEXT[s]])),
        all_sites: ids === null,
        expires_at: tok.expires_at ? new Date(tok.expires_at).toISOString() : null,
      },
      sites,
      deployment: {
        // Which edition and which release this Worker is (docs/PRO.md), with the Cloudflare version when the binding exists.
        edition: proHooks() ? 'pro' : 'core',
        version: VERSION,
        ...(v?.id ? { version_id: v.id, version_tag: v.tag || null, deployed_at: v.timestamp || null } : {}),
      },
      docs: 'https://github.com/founderdata/founderdata/blob/main/docs/API.md',
    },
    200,
    { 'cache-control': 'private, no-store' },
  );
}

// ---------- GET /api/v1/notes/:id/impact: the days before a note against the days after (notes.ts noteImpact)

async function impactRoute(c: Context<AppEnv>) {
  const id = c.req.param('id') ?? '';
  const run = async () => {
    const days = parseImpactWindow(c.req.query('window'));
    if (days !== null && typeof days !== 'number') throw new Refused(400, days.error);
    const metric = parseMetric(c.req.query('metric'));
    if (metric !== null && typeof metric !== 'string') throw new Refused(400, metric.error);
    const out = await noteImpact(c.env.DB, c.get('site'), id, days, Date.now(), metric);
    if (!out) throw new Refused(404, 'This site has no such note');
    if ('error' in out) throw new Refused(400, out.error);
    return Response.json(tokenOf(c).show_revenue ? out : impactWithoutRevenue(out));
  };
  // Raw: a note holds no person, and scrub would blank its `target` (the name alert channels use for an address).
  return readRoute(`notes/${encodeURIComponent(id)}/impact`, { params: ['window', 'metric'], money: 'strip', raw: true }, run)(c);
}

// ---------- routes

/** The answer requireReadKey gives a key for more than one site without ?site=, for routes that need one site. */
export function needSite(c: Context<AppEnv>) {
  const what = tokenOf(c).sites ? 'more than one site' : 'all sites';
  return c.json({ error: `This key covers ${what}. Add ?site=<site id>; GET /api/v1/portfolio lists the ids.` }, 400);
}

// ---------- GET /api/v1/export/:table: raw rows as CSV for a key with read:rows (export.ts)

async function exportRoute(c: Context<AppEnv>) {
  const tok = tokenOf(c);
  const name = (c.req.param('table') ?? '').replace(/\.csv$/, '');
  if (!tok.scopes?.includes('read:rows')) {
    return c.json({ error: `Raw rows need the read:rows scope. Its scopes: ${scopesOf(tok).join(', ')}. Create a key with read and read:rows in Settings, Agents.` }, 403);
  }
  if (MONEY_TABLES.has(name) && !tok.show_revenue) {
    return c.json({ error: `This key hides revenue. /api/v1/export/${name} needs the read:revenue scope too.` }, 403);
  }
  try {
    return await cached(c, cacheKey(c, `export/${name}`, [...RANGE, 'limit', 'cursor']), SHARE_TTL, 'text/csv; charset=utf-8', async () => {
      if (MONEY_TABLES.has(name)) await convertPayments(c.env.DB).catch(() => 0);
      const out = await exportForKey(c, name);
      if (out.status !== 200) throw new Refused(out.status, out.error);
      return { body: out.body, headers: { ...out.headers, 'content-disposition': `attachment; filename="${out.name}"` } };
    });
  } catch (e) {
    if (e instanceof Refused) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

/** Registers the routes of this file. Call it with the other /api/v1 routes, before the /api/* catch-all. */
export function registerAgentRoutes(app: Hono<AppEnv>) {
  // The Monday report as JSON (digest.ts weeklyRoute): a one-site key, an all-sites key with or without ?site=, or the login.
  app.get('/api/v1/weekly', weeklyRoute);
  // Any live key, with or without read: the key, its scopes and sites, and the deployed version.
  app.get('/api/v1/whoami', whoami);
  const get = (path: string, handler: (c: Context<AppEnv>) => Promise<Response> | Response) =>
    app.get(`/api/v1/${path}`, requireReadKey, customRange, handler);

  // Raw rows as CSV, names and emails empty: sessions, events, payments, subscriptions (read:rows).
  get('export/:table', exportRoute);
  // An all-sites key may leave out ?site=: every site it covers, in short form.
  app.get('/api/v1/definitions', readKeyAnySite, definitions);
  // ?due=true: the notes whose window closed and nobody reviewed, with the verdict inline (notes.ts dueNotesRoute).
  const notesRoute = readRoute('notes', { params: [...RANGE, 'granularity', 'actor', 'kind', 'limit', 'compact'], raw: true }, (c) => listNotesApi(c));
  // Due notes also answer across sites: an all-sites key without ?site= gets every site's, without impacts.
  app.get('/api/v1/notes', readKeyAnySite, customRange, (c) => {
    if (c.req.query('due') === 'true') return dueNotesRoute(c);
    if (allSitesOf(c)) return needSite(c);
    return notesRoute(c);
  });
  get('notes/:id/impact', impactRoute);
  // Verdicts per actor (notes.ts actorStats); a key without revenue gets verdicts on visitors.
  get(
    'notes/actors',
    readRoute('notes/actors', { params: ['days', 'window'], raw: true }, async (c) => {
      const p = parseActorQuery(c.req.query());
      if ('error' in p) throw new Refused(400, p.error);
      const showRevenue = !!tokenOf(c).show_revenue;
      if (showRevenue) await convertPayments(c.env.DB).catch(() => 0);
      return Response.json(await actorStats(c.env.DB, c.get('site'), { ...p, showRevenue }));
    }),
  );
  app.get('/api/sites/:id/notes/actors', actorStatsRoute);
  // Reviewing a change writes: it takes a key with notes:write or the site API key (rt_...), like POST /api/v1/notes.
  app.post('/api/v1/notes/:id/review', handleNoteReviewApi);
  get(
    'customers',
    readRoute('customers', { params: [...RANGE, 'offset', 'limit', 'kind'], money: 'block' }, async (c) => {
      const kind = c.req.query('kind') || 'payment';
      if (!(CUSTOMER_KINDS as readonly string[]).includes(kind)) throw new Refused(400, `kind is one of ${CUSTOMER_KINDS.join(', ')}`);
      const { rows, next } = await customers(makeCtx(c), pageOf(c.req.query()), kind as CustomerKind);
      return Response.json(rows, { headers: next === null ? {} : { 'x-next-offset': String(next) } });
    }),
  );
  // One page: visits and revenue per week, Google numbers, and the notes aimed at it with their impact.
  get('content/page', readRoute('content/page', { params: ['path', 'weeks'], money: 'strip', raw: true }, (c) => contentPage(c, !!tokenOf(c).show_revenue)));
  app.get('/api/sites/:id/content/page', async (c) => {
    await convertPayments(c.env.DB).catch(() => 0);
    return contentPage(c, true);
  });
  // Core Web Vitals from real visitors (vitals.ts): p75 and ratings overall, per device and per page.
  get('vitals', readRoute('vitals', { params: ['days', 'path', 'limit'], raw: true }, (c) => vitalsRoute(c)));
  app.get('/api/sites/:id/vitals', vitalsRoute);
  get(
    'content',
    readRoute('content', { params: [...RANGE, 'prefix', 'limit'], money: 'strip' }, async (c) => {
      const out = await content(makeCtx(c), { prefix: c.req.query('prefix') || null, limit: Number(c.req.query('limit')) || 100 });
      // Each row gains scroll_median_pct and has_click_map over the last 28 days (vitals.ts withPageScroll).
      return withPageScroll(c.env.DB, c.get('site').id, tokenOf(c).show_revenue ? out : contentWithoutRevenue(out));
    }),
  );
  // A web funnel: a saved one by id, or ad hoc steps, as the Goals tab counts it (stats.ts funnel). Neither: the saved funnels.
  get('funnel', readRoute('funnel', { params: [...RANGE, 'funnel_id', 'steps'], raw: true }, (c) => funnelRoute(c)));
}

/** Funnel steps: 2 to 10 of { type: page | goal, value }, page values may use * (such as /blog/*). */
export function parseSteps(raw: unknown): FunnelStep[] | { error: string } {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      return { error: 'steps is a JSON list such as [{"type":"page","value":"/pricing"},{"type":"goal","value":"signup"}]' };
    }
  }
  if (!Array.isArray(list) || list.length < 2 || list.length > 10) return { error: 'steps is a list of 2 to 10 steps, each {"type":"page" or "goal","value":"..."}' };
  const out: FunnelStep[] = [];
  for (const st of list) {
    const type = st?.type;
    const value = typeof st?.value === 'string' ? st.value.trim().slice(0, 200) : '';
    if ((type !== 'page' && type !== 'goal') || !value) return { error: 'Each step is {"type":"page","value":"/path"} or {"type":"goal","value":"goal name"}' };
    out.push({ type, value, ...(typeof st.label === 'string' ? { label: st.label.slice(0, 100) } : {}) });
  }
  return out;
}

async function funnelRoute(c: Context<AppEnv>) {
  const site = c.get('site');
  const id = c.req.query('funnel_id');
  const raw = c.req.query('steps');
  if (!id && !raw) {
    const { results } = await c.env.DB.prepare('SELECT id, name, steps, created_at FROM funnels WHERE site_id = ? ORDER BY created_at').bind(site.id).all<{ id: string; name: string; steps: string; created_at: number }>();
    return Response.json({ site_id: site.id, funnel: null, steps: [], funnels: results.map((f) => ({ id: f.id, name: f.name, steps: JSON.parse(f.steps) })) });
  }
  let steps: FunnelStep[];
  let saved: { id: string; name: string } | null = null;
  if (id) {
    const f = await c.env.DB.prepare('SELECT id, name, steps FROM funnels WHERE id = ? AND site_id = ?').bind(id, site.id).first<{ id: string; name: string; steps: string }>();
    if (!f) throw new Refused(404, 'This site has no funnel with that id. Call without funnel_id for the list.');
    steps = JSON.parse(f.steps);
    saved = { id: f.id, name: f.name };
  } else {
    const parsed = parseSteps(raw);
    if ('error' in parsed) throw new Refused(400, parsed.error);
    steps = parsed;
  }
  const ctx = makeCtx(c);
  const counted = await funnel(ctx, steps);
  const first = counted[0]?.visitors ?? 0;
  return Response.json({
    ...rangeOut(ctx),
    funnel: saved,
    steps: counted.map((st, i) => ({
      ...st,
      from_previous: i ? (counted[i - 1].visitors ? Number((st.visitors / counted[i - 1].visitors).toFixed(4)) : null) : null,
      from_first: first ? Number((st.visitors / first).toFixed(4)) : null,
    })),
  });
}
