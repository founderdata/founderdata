import type { Site } from './api';
import { isPro } from './pro';
import { hasWebsite } from './siteKind';

/** A site's pages, in the order the section row shows them. The section row and the command palette list them. */
export const SECTION_LABELS = {
  plan: 'Plan',
  overview: 'Overview',
  people: 'People',
  recordings: 'Recordings',
  content: 'Content',
  dropoff: 'Drop-off',
  app: 'App',
  seo: 'SEO',
  ai: 'AI visibility',
  aso: 'ASO',
  paid: 'Paid overview',
  ads: 'Meta ads',
  asa: 'Apple Search Ads',
  subscriptions: 'Subscriptions',
  appstore: 'App Store',
} as const;
export type View = keyof typeof SECTION_LABELS;

/**
 * What the section row shows. The group label above a tab already says "Paid", so Paid overview, Meta ads and Apple
 * Search Ads read "Overview", "Meta" and "Apple" there; a screen reader and the command palette keep the full name
 * (SECTION_LABELS).
 */
export const SECTION_SHORT_LABELS: Record<View, string> = { ...SECTION_LABELS, paid: 'Overview', ads: 'Meta', asa: 'Apple' };

/** The section row's groups, left to right. Every section sits in exactly one. */
export const SECTION_GROUPS: { id: 'agent' | 'analytics' | 'organic' | 'paid' | 'revenue'; label: string; views: View[] }[] = [
  // The growth plan the owner's AI agent runs for the site. First in the row; a site still opens on the Overview.
  { id: 'agent', label: 'Agent', views: ['plan'] },
  { id: 'analytics', label: 'Analytics', views: ['overview', 'people', 'recordings', 'content', 'dropoff', 'app'] },
  { id: 'organic', label: 'Organic', views: ['seo', 'ai', 'aso'] },
  { id: 'paid', label: 'Paid', views: ['paid', 'ads', 'asa'] },
  { id: 'revenue', label: 'Revenue', views: ['subscriptions', 'appstore'] },
];

/** A provider that sends subscription events is set up, or subscriptions are stored already. */
export const sellsSubscriptions = (s: Site) =>
  !!(s.has_subscriptions || s.stripe_webhook_secret || s.revenuecat_auth || s.app_bundle_id || s.dodo_webhook_secret || s.lemonsqueezy_secret || s.polar_secret || s.paddle_secret);

/** What a section needs before it can show anything, and where in Settings that step is. */
export interface SectionSetup {
  title: string;
  body: string;
  action: string;
  /** A Settings hash (src/dashboard/components/setup/status.tsx CARDS). */
  settings: string;
}

const NEEDS_WEBSITE: SectionSetup = {
  title: 'This section needs a website',
  body: "This site tracks an app only. Add the website's domain in Settings, then install the tracker on it.",
  action: 'Add the domain',
  settings: 'general',
};
const NEEDS_APP: SectionSetup = {
  title: 'This section needs an iOS app',
  body: "Add the app's bundle id in Settings. The section fills once FounderDataKit sends events.",
  action: 'Add the bundle id',
  settings: 'general',
};

/**
 * The step a section is missing for this site, or null when it can show data. A missing website or app shows the
 * setup screen instead of the section. A missing integration (Meta, Apple Search Ads, Search Console) leaves the
 * section to show its own setup state, so `muted` is true there too but `setup` is null.
 */
export function sectionState(site: Site, v: View): { muted: boolean; setup: SectionSetup | null } {
  // Without Pro every section after the Overview is the Pro card, whatever the site has set up.
  if (!isPro && v !== 'overview') return { muted: false, setup: null };
  const web = hasWebsite(site);
  const app = !!site.app_bundle_id;
  switch (v) {
    case 'overview':
    case 'dropoff':
    // People and recordings: web visits and app sessions both make a person's story.
    case 'people':
    // The plan needs no website or app: an agent can make one for any site.
    case 'plan':
      return { muted: false, setup: null };
    case 'content':
    // Recordings are of website visits: the iPhone app is never recorded.
    case 'recordings':
    case 'seo':
    case 'ai':
      return web ? { muted: false, setup: null } : { muted: true, setup: NEEDS_WEBSITE };
    case 'paid':
      // Every channel's spend against every new customer: muted until a channel sends spend. The view shows how.
      return { muted: !site.has_meta && !site.has_asa && !site.has_spend, setup: null };
    case 'ads':
      if (!web) return { muted: true, setup: NEEDS_WEBSITE };
      return { muted: !site.has_meta, setup: null };
    case 'app':
    case 'appstore':
    case 'aso':
      return app ? { muted: false, setup: null } : { muted: true, setup: NEEDS_APP };
    case 'asa':
      if (!app) return { muted: true, setup: NEEDS_APP };
      // has_asa is false when the deployment has no ASA_* secrets; the panel then shows the setup steps.
      return { muted: site.has_asa === false, setup: null };
    case 'subscriptions':
      return sellsSubscriptions(site)
        ? { muted: false, setup: null }
        : {
            muted: true,
            setup: {
              title: 'Connect a provider that sells subscriptions',
              body: 'MRR, churn, trials and retention appear once Stripe, Dodo, Paddle, Polar, Lemon Squeezy, RevenueCat or the App Store sends its first subscription.',
              action: 'Connect payments',
              settings: 'payments',
            },
          };
  }
}

/** Every section, in row order. All of them are one click away; the ones a site cannot use yet are muted. */
export const ALL_VIEWS: View[] = SECTION_GROUPS.flatMap((g) => g.views);

/** The sections that have data to show for this site: the idle preloader and the overview's chunk list use them. */
export function viewsFor(site: Site): View[] {
  return ALL_VIEWS.filter((v) => !sectionState(site, v).setup);
}

/** The path of a section. */
export const sectionPath = (siteId: string, v: View) => `/site/${siteId}${v === 'overview' ? '' : v === 'asa' ? '/ads/asa' : `/${v}`}`;

/**
 * Query parameters that belong to one section (a breakdown tab, a sub-view, an open visitor, the filters of Recordings
 * and the second a recording opens at). They stay behind when
 * you change section, so a tab picked on the Overview does not follow you to SEO.
 */
export const SECTION_PARAMS = ['tab', 'view', 'visitor', 'page', 'exit', 'signal', 'outcome', 'device', 'sort', 't'];

/** The search part a section link keeps: the period and filters, not the section's own state. */
export function carriedSearch(search: string): string {
  const p = new URLSearchParams(search);
  for (const k of SECTION_PARAMS) p.delete(k);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** The URL of a section, keeping the period and filters in the query. */
export const sectionUrl = (siteId: string, v: View, search: string = window.location.search) => `${sectionPath(siteId, v)}${carriedSearch(search)}`;
