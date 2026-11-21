import { CLICK_NETWORKS, KNOWN_SOURCES } from '../../shared/sources';
import type { Site } from './api';
import { contentPageUrl } from './paths';
import { carriedSearch, sectionUrl, type View } from './sections';
import { hasWebsite } from './siteKind';
import { hasApp } from '../../shared/platform';

/** A breakdown row's way into a deeper screen: the page detail, SEO, AI visibility or an ads section. */
export interface RowAction {
  id: string;
  label: string;
  href: string;
}

const META_SOURCES = new Set(['Facebook', 'Instagram', 'Messenger', 'Audience Network', 'Meta']);
/** Sources of a visit that carried an ad click id (Google Ads, Microsoft Ads, TikTok Ads, ...). */
const CLICK_SOURCES: Set<string> = new Set(CLICK_NETWORKS.map((n) => n.source));
const channelOf = (source: string) => KNOWN_SOURCES.find((s) => s.name === source)?.channel;

/**
 * The deeper screens a breakdown row opens, besides "Filter by this" (the row click). Every link keeps the period and
 * filters in `search`. A section the site has not set up still opens: it shows its setup step.
 *
 * - Page and entry page: the page's detail in Content (a website only).
 * - Channel: Organic Search opens SEO, AI opens AI visibility, Paid opens the Paid overview, Meta ads and Apple Search Ads.
 * - Referrer: a search engine opens SEO, an AI assistant AI visibility, Facebook or Instagram Meta ads (a site with a
 *   Meta ad account), Apple Search Ads its own section, an ad network with a click id (Google Ads) the Paid overview.
 * - Campaign and keyword: an Apple Search Ads id opens that section (keywords in its keyword view). A campaign of the
 *   site's Meta ad account opens Meta ads: the Worker flags those rows with `meta` (src/worker/meta-campaigns.ts), so a
 *   newsletter, Google Ads or affiliate campaign gets no Meta link.
 */
export function rowActions(site: Site, dim: string, row: { label: string | null; name?: string | null; meta?: boolean }, search: string): RowAction[] {
  const l = row.label;
  if (!l) return [];
  const web = hasWebsite(site);
  const app = hasApp(site);
  const out: RowAction[] = [];
  const open = (v: View, label: string, extra = '') => {
    const href = sectionUrl(site.id, v, search);
    out.push({ id: v, label, href: extra ? `${href}${href.includes('?') ? '&' : '?'}${extra}` : href });
  };
  const seo = () => web && open('seo', 'Open SEO');
  const ai = () => web && open('ai', 'Open AI visibility');
  const meta = () => web && open('ads', 'Open Meta ads');
  const asa = (keyword = false) => app && open('asa', 'Open Apple Search Ads', keyword ? 'view=keyword' : '');
  const paid = () => open('paid', 'Open Paid overview');

  switch (dim) {
    case 'page':
    case 'entry_page':
      if (web && l.startsWith('/')) out.push({ id: 'page', label: 'Open page detail', href: contentPageUrl(site.id, l, carriedSearch(search)) });
      break;
    case 'channel':
      if (l === 'Organic Search') seo();
      else if (l === 'AI') ai();
      else if (l === 'Paid') {
        paid();
        meta();
        asa();
      }
      break;
    case 'source': {
      if (l === 'Apple Search Ads') asa();
      else if (CLICK_SOURCES.has(l)) paid();
      else if (META_SOURCES.has(l)) {
        if (site.has_meta) meta();
      } else {
        const ch = channelOf(l);
        if (ch === 'Organic Search') seo();
        else if (ch === 'AI') ai();
      }
      break;
    }
    case 'campaign':
    case 'keyword':
      // An Apple Search Ads id: its name came with the row (the import knows it), or a number that is not a Meta
      // campaign id.
      if (app && row.name) asa(dim === 'keyword');
      else if (dim === 'campaign' && row.meta) meta();
      else if (app && /^\d+$/.test(l)) asa(dim === 'keyword');
      break;
  }
  return out;
}
