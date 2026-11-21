import type { FallbackKind } from '../components/ui/RouteFallback';
import { isViewer, qs } from './api';
import { Pages, Views } from './pages';
import { prefetch } from './cache';
import type { View } from './sections';
import { readQuery } from './useQueryState';
import { tabFrom } from './urlState';
import { BREAKDOWN_CARDS } from '../../shared/dashboard-tabs';

/**
 * The dashboard's routes in one place: which page a path shows, which chunks it needs, which skeleton stands in
 * for it, and which requests it makes first. App.tsx renders from `matchRoute`; navigate() (lib/nav.ts), the hover
 * preloader and the boot step (lib/boot.ts) use the rest, so all of them agree on what a path means.
 */
export type Route =
  | { page: 'home' }
  | { page: 'apps' }
  | { page: 'mail' }
  | { page: 'dashboards'; id: string | null }
  | { page: 'notifications' }
  | { page: 'live' }
  | { page: 'settings'; siteId: string }
  | { page: 'dashboard'; siteId: string; view: View };

// Order matters: the first pattern that fits wins, as in the router this replaced.
const DASHBOARD: [RegExp, View][] = [
  // The agent's growth plan (FounderData Pro). /seo/plan below is the SEO tab's own view, a different page.
  [/^\/site\/([\w-]+)\/plan\/?$/, 'plan'],
  [/^\/site\/([\w-]+)\/dropoff\/?$/, 'dropoff'],
  // Recordings (FounderData Pro): the list, and /recordings/<session id> opens the player. /people/recordings, where the
  // list used to be, opens it too; the section moves the address to /recordings.
  [/^\/site\/([\w-]+)\/(?:people\/)?recordings(?:\/[\w-]+)?\/?$/, 'recordings'],
  // /people, and anything under it (/people/recordings, one person's page): People reads the rest of the path.
  [/^\/site\/([\w-]+)\/people(?:\/[^?#]*)?$/, 'people'],
  // /content/page/<path> is one page's detail, /content/paths the Paths screen (ContentSection reads the rest of the path).
  [/^\/site\/([\w-]+)\/content(?:\/page\/.*|\/paths)?\/?$/, 'content'],
  // Errors (FounderData Pro): the list, and /errors/<fingerprint> is one issue.
  [/^\/site\/([\w-]+)\/errors(?:\/[\w-]+)?\/?$/, 'errors'],
  // Experiments (FounderData Pro): the list, /experiments/new the form, /experiments/<key> one experiment.
  [/^\/site\/([\w-]+)\/experiments(?:\/[\w-]+)?\/?$/, 'experiments'],
  // /seo/keywords, /seo/cannibalization, /seo/ranks, /seo/ai, /seo/plan and /seo/pages are the SEO tab's views
  // (VIEWS in SeoSection, which reads them). A view missing here would open Home instead.
  [/^\/site\/([\w-]+)\/seo(?:\/(?:search|keywords|cannibalization|ranks|ai|plan|pages))?\/?$/, 'seo'],
  [/^\/site\/([\w-]+)\/ai\/?$/, 'ai'],
  [/^\/site\/([\w-]+)\/subscriptions\/?$/, 'subscriptions'],
  // The Paid group: /paid is every channel's spend (the Paid overview), /ads is Meta, /ads/asa is Apple Search Ads.
  [/^\/site\/([\w-]+)\/paid\/?$/, 'paid'],
  // Apple Search Ads sits next to Meta ads in the Paid group: /ads is Meta, /ads/asa is Apple Search Ads.
  [/^\/site\/([\w-]+)\/ads\/asa\/?$/, 'asa'],
  [/^\/site\/([\w-]+)\/ads\/?$/, 'ads'],
  [/^\/site\/([\w-]+)\/appstore\/?$/, 'appstore'],
  [/^\/site\/([\w-]+)\/aso\/?$/, 'aso'],
  [/^\/site\/([\w-]+)\/app\/?$/, 'app'],
  [/^\/site\/([\w-]+)\/?$/, 'overview'],
];

export function matchRoute(path: string, viewer: boolean = isViewer()): Route {
  if (/^\/apps\/?$/.test(path)) return { page: 'apps' };
  // Mail holds other people's addresses and messages: the owner's only, like Notifications.
  if (/^\/mail\/?$/.test(path) && !viewer) return { page: 'mail' };
  // Custom dashboards (FounderData Pro): the list, or one dashboard. A viewer reads them; only an owner changes them.
  const board = /^\/dashboards(?:\/([\w-]+))?\/?$/.exec(path);
  if (board) return { page: 'dashboards', id: board[1] ?? null };
  // The full-screen live view: the globe, who is online and the last hour's payments (pages/Live.tsx).
  if (/^\/live\/?$/.test(path)) return { page: 'live' };
  // Alert channels hold webhook URLs: the owner's only. The viewer login lands on the home page.
  if (/^\/notifications\/?$/.test(path) && !viewer) return { page: 'notifications' };
  const settings = /^\/site\/([\w-]+)\/settings\/?$/.exec(path);
  if (settings) return { page: 'settings', siteId: settings[1] };
  for (const [re, view] of DASHBOARD) {
    const m = re.exec(path);
    if (m) return { page: 'dashboard', siteId: m[1], view };
  }
  return { page: 'home' };
}

/** A path the app has a page for. Anything else (a docs link, /pricing) falls through to Home in matchRoute. */
export const isAppPath = (path: string) => path === '/' || matchRoute(path).page !== 'home';

export function kindOf(route: Route): FallbackKind {
  switch (route.page) {
    case 'home':
      return 'home';
    case 'dashboard':
      return 'site';
    case 'settings':
      return 'settings';
    case 'live':
      return 'plain';
    default:
      return 'list';
  }
}

/** The chunks a route renders from, as the ones that have not arrived yet. */
function chunksOf(route: Route) {
  switch (route.page) {
    case 'home':
      return [Pages.Home];
    case 'apps':
      return [Pages.Apps];
    case 'mail':
      return [Pages.Mail];
    case 'dashboards':
      return [Pages.Dashboards];
    case 'notifications':
      return [Pages.Notifications];
    case 'live':
      return [Pages.Live];
    case 'settings':
      return [Pages.Settings];
    case 'dashboard':
      return route.view === 'overview' ? [Pages.Dashboard] : [Pages.Dashboard, Views[route.view]];
  }
}

/** Load a path's chunks. Returns a promise while any is missing, null when all have arrived. */
export function preloadRoute(path: string): Promise<unknown> | null {
  const missing = chunksOf(matchRoute(path)).filter((c) => !c.loaded());
  return missing.length ? Promise.all(missing.map((c) => c.preload())) : null;
}

// Home reads ?period= against this list (pages/Home.tsx usePeriod); anything else means 30d.
const HOME_PERIODS = ['today', 'yesterday', '24h', '48h', '7d', '30d', '90d', 'thisquarter', 'lastquarter', '12m', 'all'];

/**
 * The requests a route makes first, in the URL form its components use, so a cache hit lands on the same key.
 * A guess that drifts from a component only costs the speed-up, never correctness.
 */
export function dataOf(route: Route, search: string): string[] {
  if (route.page === 'home') {
    const p = new URLSearchParams(search).get('period');
    const period = p && HOME_PERIODS.includes(p) ? p : '30d';
    return [`/api/home?period=${period}`, `/api/home/growth?period=${period}`];
  }
  if (route.page !== 'dashboard') return [];
  const base = `/api/sites/${route.siteId}`;
  const q = readQuery(search);
  const urls = ['/api/sites', `${base}/overview?${qs(q)}`];
  switch (route.view) {
    case 'overview':
      urls.push(`${base}/notes?${qs({ ...q, filters: {} })}`, `${base}/revenue?${qs(q)}`, `${base}/email?${qs(q)}`, `${base}/x`);
      // Each breakdown card's open tab: the first one, or the one ?tab= names.
      for (const card of BREAKDOWN_CARDS) {
        const dims = card.map((t) => t.dim);
        urls.push(`${base}/breakdown?${qs(q, { dim: tabFrom(new URLSearchParams(search).get('tab'), dims) ?? dims[0] })}`);
      }
      if (!Object.keys(q.filters).length) urls.push(`${base}/coverage?${qs(q)}`);
      break;
    case 'seo':
      urls.push(`${base}/seo`);
      break;
    case 'content':
      urls.push(`${base}/content?${qs(q, { limit: 500 })}`, `${base}/seo`);
      break;
    case 'aso':
      urls.push(`${base}/aso`);
      break;
    case 'appstore':
      urls.push(`${base}/appstore?${qs(q)}`);
      break;
    case 'paid':
      urls.push(`${base}/paid?${qs(q)}`);
      break;
  }
  return urls;
}

/**
 * Load a path's chunks and start its first requests: the page just booted, or a link was clicked or touched. A hover
 * or a focus passes `lead` and gets only the requests the page cannot draw without (a site page: the site list and
 * the overview), so sweeping the mouse over a row of site cards starts two requests a card, not ten.
 */
export function warmRoute(path: string, search = '', lead = false) {
  if (!isAppPath(path)) return;
  preloadRoute(path);
  const urls = dataOf(matchRoute(path), search);
  for (const url of lead ? urls.slice(0, 2) : urls) prefetch(url);
}
