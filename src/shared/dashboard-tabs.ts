/**
 * The site Overview's cards and their tabs. The dashboard draws them (src/dashboard/pages/Dashboard.tsx), keeps the open
 * tab of each in ?tab= (src/dashboard/lib/urlState.ts), and the Worker links an agent's answer to the tab that shows
 * the same numbers (src/worker/dashboard-url.ts). Tab ids are unique across the page, so one ?tab= list holds them all.
 */

export interface BreakdownTab {
  label: string;
  /** The breakdown dimension: GET /api/sites/:id/breakdown?dim= and GET /api/v1/stats/breakdown?dim=. */
  dim: string;
  /** The session filter a row click adds. Absent on a tab whose rows are not a filter. */
  filter?: string;
}

/** The four breakdown cards, top left to bottom right. The first tab of each is its default. */
export const BREAKDOWN_CARDS: BreakdownTab[][] = [
  [
    { label: 'Channel', dim: 'channel', filter: 'channel' },
    { label: 'Referrer', dim: 'source', filter: 'source' },
    { label: 'Campaign', dim: 'campaign', filter: 'utm_campaign' },
    { label: 'Keyword', dim: 'keyword', filter: 'utm_term' },
    // The heard_about survey's answers (src/worker/surveys.ts). Not a session column, so a row is no filter.
    { label: 'Heard about', dim: 'heard_about' },
  ],
  [
    { label: 'Page', dim: 'page', filter: 'page' },
    { label: 'Entry page', dim: 'entry_page', filter: 'entry_page' },
    { label: 'Exit link', dim: 'exit_link' },
    { label: 'Hostname', dim: 'hostname', filter: 'hostname' },
  ],
  [
    { label: 'Country', dim: 'country', filter: 'country' },
    { label: 'Region', dim: 'region', filter: 'region' },
    { label: 'City', dim: 'city', filter: 'city' },
  ],
  [
    { label: 'Browser', dim: 'browser', filter: 'browser' },
    { label: 'OS', dim: 'os', filter: 'os' },
    { label: 'Device', dim: 'device', filter: 'device' },
    { label: 'Language', dim: 'language', filter: 'language' },
  ],
];

/** The fifth card, for a site with an app: web against app, and app versions. Shown only where it says something. */
export const PLATFORM_CARD: BreakdownTab[] = [
  { label: 'Platform', dim: 'platform', filter: 'platform' },
  { label: 'App version', dim: 'app_version', filter: 'app_version' },
];

/** The card under the breakdowns: customers (journey) first, then goals, funnels, visitors and changes. */
export const CUSTOMER_TABS = ['journey', 'goal', 'funnel', 'user', 'changes'] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

/** Every tab id the Overview keeps in ?tab=. */
export const OVERVIEW_TAB_IDS: readonly string[] = [...BREAKDOWN_CARDS.flat(), ...PLATFORM_CARD].map((t) => t.dim).concat(CUSTOMER_TABS);
