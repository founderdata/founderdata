import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Site } from '../../lib/api';
import { fmtAgo } from '../../lib/format';
import { isPro } from '../../lib/pro';
import { hasWebsite, isAppOnly } from '../../lib/siteKind';
import type { CardStatus } from './kit';
import type { SetupIconName } from './icons';
import { hasApp } from '../../../shared/platform';

/**
 * The map of Settings: its groups, the cards in each, and the state of every integration, read once when the page
 * opens from routes that already exist. Each card's chip and the overview grid read the same answers, so they agree.
 */

export type GroupId = 'overview' | 'site' | 'install' | 'payments' | 'appstore' | 'seo' | 'ads' | 'agents-api' | 'alerts' | 'imports' | 'sharing' | 'privacy' | 'product' | 'danger';

/** A group or card that only FounderData Pro has (`pro`) or only core shows (`core`). The other edition's list leaves it out. */
interface Edition {
  pro?: true;
  core?: true;
}
const inEdition = (x: Edition) => (isPro ? !x.core : !x.pro);

const ALL_GROUPS: (Edition & { id: GroupId; label: string; icon: SetupIconName; desc: string })[] = [
  { id: 'overview', label: 'Overview', icon: 'overview', desc: 'What is connected, what is not, and the next step.' },
  { id: 'install', label: 'Install', icon: 'install', desc: 'The tracker or SDK, and a prompt for your coding agent.' },
  { id: 'site', label: 'Site', icon: 'site', desc: 'Name, domain, timezone, currency and what the site counts as its goal.' },
  { id: 'payments', label: 'Payments', icon: 'payments', desc: 'Connect a provider so each sale is credited to the source that brought it.' },
  { id: 'appstore', label: 'App Store', icon: 'appstore', desc: isPro ? 'Purchases, commission, sandbox purchases and Apple Search Ads.' : 'Purchases, commission and sandbox purchases.' },
  { id: 'seo', label: 'Search and SEO', icon: 'seo', pro: true, desc: 'Search Console queries, clicks and positions, pulled every day.' },
  { id: 'ads', label: 'Ads and social', icon: 'ads', pro: true, desc: 'Ad spend next to the customers it brought, and visits from X posts.' },
  { id: 'agents-api', label: 'Agents and API', icon: 'agents', desc: isPro ? 'Keys for your agents and scripts, the MCP server and the iPhone app.' : 'Keys for your agents and scripts.' },
  { id: 'alerts', label: 'Alerts', icon: 'alerts', pro: true, desc: 'Rules that post to a webhook or your phone when a number crosses a line.' },
  { id: 'imports', label: 'Imports', icon: 'imports', desc: 'Bring in history from before this site used FounderData.' },
  { id: 'sharing', label: 'Sharing and team', icon: 'sharing', desc: 'Read-only links for other people, and logins for your teammates.' },
  { id: 'privacy', label: 'Data and privacy', icon: 'privacy', desc: isPro ? 'Where the data lives, the daily write cap, recorded visits and the erase log.' : 'Where the data lives, the daily write cap and the erase log.' },
  { id: 'product', label: isPro ? 'Updates' : 'Updates and Pro', icon: 'sparkle', desc: isPro ? 'The version you run and the latest release.' : 'The version you run, the latest release and what FounderData Pro adds.' },
  { id: 'danger', label: 'Danger zone', icon: 'danger', desc: 'Delete the site and everything it recorded.' },
];

export const GROUPS = ALL_GROUPS.filter(inEdition);

export interface CardDef extends Edition {
  id: string;
  group: GroupId;
  title: string;
  /** Shown on the overview grid with its state. */
  tile?: boolean;
  applies?: (site: Site) => boolean;
}

const web = (s: Site) => hasWebsite(s);
const app = (s: Site) => hasApp(s);

/** Every card, in the order the groups show them. Card ids are the hashes old links use (#write-cap, #stripe). */
const ALL_CARDS: CardDef[] = [
  { id: 'setup-checklist', group: 'overview', title: 'Server setup' },
  { id: 'tracker', group: 'install', title: 'Website tracker', tile: true, applies: web },
  { id: 'ios-sdk', group: 'install', title: 'iOS app SDK', tile: true, applies: app },
  { id: 'link-builder', group: 'install', title: 'Link builder', applies: web },
  { id: 'general', group: 'site', title: 'General' },
  { id: 'product-type', group: 'site', title: 'Product type' },
  { id: 'reporting-timezone', group: 'site', title: 'Reporting timezone' },
  { id: 'primary-goal', group: 'site', title: 'Primary goal' },
  { id: 'stripe', group: 'payments', title: 'Stripe', tile: true },
  { id: 'dodo', group: 'payments', title: 'Dodo Payments', tile: true },
  { id: 'lemonsqueezy', group: 'payments', title: 'Lemon Squeezy', tile: true },
  { id: 'polar', group: 'payments', title: 'Polar', tile: true },
  { id: 'paddle', group: 'payments', title: 'Paddle', tile: true },
  { id: 'gumroad', group: 'payments', title: 'Gumroad', tile: true },
  { id: 'revenuecat', group: 'payments', title: 'RevenueCat', tile: true },
  { id: 'api', group: 'payments', title: 'Other providers (server API)', tile: true },
  { id: 'app-store', group: 'appstore', title: 'App Store purchases', tile: true },
  { id: 'apple-search-ads', group: 'appstore', title: 'Apple Search Ads', pro: true, tile: true, applies: app },
  { id: 'google', group: 'seo', title: 'Google Search Console', pro: true, tile: true, applies: web },
  { id: 'meta-ads', group: 'ads', title: 'Meta ads', pro: true, tile: true, applies: web },
  { id: 'x-posts', group: 'ads', title: 'X posts', pro: true, tile: true, applies: web },
  { id: 'ad-spend', group: 'ads', title: 'Ad spend from other channels', pro: true },
  { id: 'agents', group: 'agents-api', title: 'Agents', tile: true },
  { id: 'iphone-app', group: 'agents-api', title: 'iPhone app', pro: true, tile: true },
  { id: 'devices', group: 'agents-api', title: 'Devices', pro: true },
  { id: 'alert-rules', group: 'alerts', title: 'Alert rules', pro: true, tile: true },
  { id: 'import', group: 'imports', title: 'Import web traffic', applies: web },
  { id: 'import-subscriptions', group: 'imports', title: 'Import subscription history', pro: true },
  { id: 'stripe-import', group: 'imports', title: 'Import past Stripe payments' },
  { id: 'share', group: 'sharing', title: 'Share links', tile: true },
  { id: 'team', group: 'sharing', title: 'Team', tile: true },
  { id: 'data-location', group: 'privacy', title: 'Data location' },
  { id: 'write-cap', group: 'privacy', title: 'Daily write cap' },
  { id: 'datacenter', group: 'privacy', title: 'Datacenter visits', applies: web },
  { id: 'record-visits', group: 'privacy', title: 'Record visits', pro: true, applies: web },
  { id: 'erase-log', group: 'privacy', title: 'Erase log' },
  { id: 'updates', group: 'product', title: 'Updates' },
  { id: 'pro', group: 'product', title: 'FounderData Pro', core: true },
  { id: 'delete-site', group: 'danger', title: 'Delete' },
];

export const CARDS = ALL_CARDS.filter(inEdition);

/** The group a hash opens: a group id, a card id, or the overview. */
export function resolveHash(hash: string): { group: GroupId; card: string | null } {
  const h = hash.replace(/^#/, '');
  if (GROUPS.some((g) => g.id === h)) return { group: h as GroupId, card: null };
  const card = CARDS.find((c) => c.id === h);
  return card ? { group: card.group, card: card.id } : { group: 'overview', card: null };
}

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  error: string | null;
  sites: { site_id: string; property: string; status: string; error: string | null; last_run_at: number | null }[];
}
interface KeyRow {
  id: string;
  name: string;
  sites: string[] | null;
  expired: boolean;
  last_used_at: number | null;
}
interface AsaStatus {
  configured: boolean;
  importedAt: number | null;
  error: string | null;
}
interface XStatus {
  configured: boolean;
  username: string | null;
  enabled: boolean;
  last_polled_at: string | null;
  last_error: string | null;
}
interface MetaReport {
  configured: boolean;
  settings: { adAccountId: string | null; capiLastError: string | null };
}

export interface SetupData {
  row: (Site & { visitors24h?: number; online?: number }) | null;
  google: GoogleStatus | null;
  keys: KeyRow[] | null;
  devices: { id: string; lastSeenAt: number }[] | null;
  rules: { site_id: string }[] | null;
  team: { status: string }[] | null;
  shares: { kind: string; expires_at: number | null }[] | null;
  asa: AsaStatus | null;
  x: XStatus | null;
  meta: MetaReport | null;
}

const EMPTY: SetupData = { row: null, google: null, keys: null, devices: null, rules: null, team: null, shares: null, asa: null, x: null, meta: null };

/** "2 hours ago", from milliseconds. */
export const agoMs = (ts: number) => (Date.now() - ts < 60_000 ? 'just now' : `${fmtAgo(Math.max(0, Date.now() - ts))} ago`);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A payment provider's state from its secret, its last payment and refused deliveries. */
function providerStatus(site: Site, key: string, configured: boolean): CardStatus {
  const refused = site.refused_webhooks?.[key];
  if (refused) return { tone: 'error', label: 'Refused', detail: `${plural(refused.count, 'delivery', 'deliveries')} refused, bad signature` };
  if (!configured) return { tone: 'neutral', label: 'Not connected' };
  const last = site.last_payments?.[key];
  return { tone: 'ok', label: 'Connected', detail: last ? `Last payment ${agoMs(last)}` : 'Connected, no payment yet' };
}

export function statusFor(id: string, site: Site, d: SetupData): CardStatus | null {
  const row = d.row;
  switch (id) {
    case 'tracker':
    case 'ios-sdk': {
      if (!row) return null;
      if (id === 'ios-sdk' && row.app_rejected_at) return { tone: 'error', label: 'Refused', detail: `Events refused ${agoMs(row.app_rejected_at)}` };
      if (row.capped_at) return { tone: 'warn', label: 'Capped', detail: `Write cap hit ${agoMs(row.capped_at)}` };
      const v = row.visitors24h ?? 0;
      if (v > 0) return { tone: 'ok', label: 'Receiving data', detail: `${plural(v, 'visitor')} in 24 hours${row.online ? `, ${row.online} online` : ''}` };
      return { tone: 'warn', label: 'Needs setup', detail: 'No visits in 24 hours' };
    }
    case 'stripe':
      return providerStatus(site, 'stripe', !!site.stripe_webhook_secret);
    case 'dodo':
      return providerStatus(site, 'dodo', !!site.dodo_webhook_secret);
    case 'lemonsqueezy':
      return providerStatus(site, 'lemonsqueezy', !!site.lemonsqueezy_secret);
    case 'polar':
      return providerStatus(site, 'polar', !!site.polar_secret);
    case 'paddle':
      return providerStatus(site, 'paddle', !!site.paddle_secret);
    case 'gumroad':
      return providerStatus(site, 'gumroad', !!site.gumroad_token);
    case 'revenuecat':
      return providerStatus(site, 'revenuecat', !!site.revenuecat_auth);
    case 'api': {
      const last = site.last_payments?.api;
      return last ? { tone: 'ok', label: 'In use', detail: `Last payment ${agoMs(last)}` } : { tone: 'neutral', label: 'Not used', detail: 'No payment sent yet' };
    }
    case 'app-store': {
      if (!site.app_bundle_id) return { tone: isAppOnly(site) ? 'warn' : 'neutral', label: isAppOnly(site) ? 'Needs setup' : 'Not connected', detail: 'Needs a bundle id' };
      const refused = site.refused_webhooks?.app_store;
      if (refused) return { tone: 'error', label: 'Refused', detail: `${plural(refused.count, 'notification')} refused` };
      const last = site.last_payments?.app_store;
      return { tone: 'ok', label: 'Ready', detail: last ? `Last purchase ${agoMs(last)}` : 'No purchase yet' };
    }
    case 'apple-search-ads': {
      const a = d.asa;
      if (!a) return null;
      if (a.error) return { tone: 'error', label: 'Import failed', detail: a.error };
      if (!a.configured) return { tone: 'neutral', label: 'Not connected', detail: 'Needs ASA_* secrets' };
      return { tone: 'ok', label: 'Connected', detail: a.importedAt ? `Imported ${agoMs(a.importedAt)}` : 'Waiting for the first daily import' };
    }
    case 'google': {
      const g = d.google;
      if (!g) return null;
      const mine = g.sites.find((s) => s.site_id === site.id);
      if (!g.configured) return { tone: 'neutral', label: 'Not connected', detail: 'Needs GOOGLE_* secrets' };
      if (g.error) return { tone: 'error', label: 'Error', detail: g.error };
      if (!g.connected) return { tone: 'neutral', label: 'Not connected', detail: 'Sign in with Google' };
      if (!mine) return { tone: 'warn', label: 'Pick a property', detail: 'Pick this site\'s property' };
      if (mine.error) return { tone: 'error', label: 'Error', detail: mine.error };
      return { tone: 'ok', label: 'Connected', detail: mine.last_run_at ? `${mine.property}, synced ${agoMs(mine.last_run_at)}` : `${mine.property}, first sync pending` };
    }
    case 'meta-ads': {
      const m = d.meta;
      if (!m) return null;
      if (!m.configured) return { tone: 'neutral', label: 'Not connected', detail: 'Needs META_ACCESS_TOKEN' };
      if (!m.settings.adAccountId) return { tone: 'warn', label: 'Needs setup', detail: 'Pick the ad account' };
      if (m.settings.capiLastError) return { tone: 'warn', label: 'Check', detail: m.settings.capiLastError };
      return { tone: 'ok', label: 'Connected', detail: `Ad account ${m.settings.adAccountId}` };
    }
    case 'x-posts': {
      const x = d.x;
      if (!x) return null;
      if (!x.configured) return { tone: 'neutral', label: 'Not connected', detail: 'Needs X credentials' };
      if (!x.username) return { tone: 'neutral', label: 'Not connected', detail: 'Add your X handle' };
      if (x.last_error) return { tone: 'error', label: 'Error', detail: x.last_error };
      return { tone: 'ok', label: 'Connected', detail: x.last_polled_at ? `@${x.username}, read ${agoMs(Date.parse(x.last_polled_at))}` : `@${x.username}, first read pending` };
    }
    case 'agents': {
      if (!d.keys) return null;
      const mine = d.keys.filter((k) => !k.expired && (!k.sites || k.sites.includes(site.id)));
      if (!mine.length) return { tone: 'neutral', label: 'No keys', detail: 'Make a key for your agent' };
      const used = mine.map((k) => k.last_used_at ?? 0).reduce((a, b) => Math.max(a, b), 0);
      return { tone: 'ok', label: plural(mine.length, 'key'), detail: used ? `Last call ${agoMs(used)}` : 'No calls yet' };
    }
    case 'iphone-app':
    case 'devices': {
      if (!d.devices) return null;
      if (!d.devices.length) return { tone: 'neutral', label: 'Not connected', detail: 'Scan a code to sign in' };
      const seen = Math.max(...d.devices.map((x) => x.lastSeenAt));
      return { tone: 'ok', label: plural(d.devices.length, 'phone'), detail: `Last seen ${agoMs(seen)}` };
    }
    case 'alert-rules': {
      if (!d.rules) return null;
      const n = d.rules.filter((r) => r.site_id === site.id || r.site_id === '*').length;
      return n ? { tone: 'ok', label: plural(n, 'rule'), detail: `${plural(n, 'rule')} watch this site` } : { tone: 'neutral', label: 'No rules', detail: 'No rule yet' };
    }
    case 'share': {
      if (!d.shares) return null;
      const n = d.shares.filter((t) => t.kind === 'link' && (!t.expires_at || t.expires_at > Date.now())).length;
      return n ? { tone: 'ok', label: plural(n, 'link'), detail: `${plural(n, 'link')} open` } : { tone: 'neutral', label: 'None', detail: 'No share link yet' };
    }
    case 'team': {
      if (!d.team) return null;
      const n = d.team.filter((m) => m.status !== 'expired').length;
      return n ? { tone: 'ok', label: plural(n, 'person', 'people'), detail: `${plural(n, 'teammate')} besides you` } : { tone: 'neutral', label: 'Just you', detail: 'Invite with a link' };
    }
    case 'write-cap': {
      if (site.write_cap_on === 0) return { tone: 'warn', label: 'Off', detail: 'No daily limit on rows written' };
      if (site.usage?.capped_at) return { tone: 'error', label: 'Reached', detail: `Reached ${agoMs(site.usage.capped_at)}` };
      return { tone: 'ok', label: 'On' };
    }
    case 'datacenter':
      return site.show_datacenter === 1 ? { tone: 'neutral', label: 'Counted' } : { tone: 'ok', label: 'Hidden' };
    case 'data-location': {
      const l = site.data_location;
      if (!l) return null;
      return l.jurisdiction ? { tone: 'ok', label: l.jurisdiction === 'eu' ? 'EU' : 'Pinned' } : { tone: 'neutral', label: 'Not pinned' };
    }
    default:
      return null;
  }
}

const SetupCtx = createContext<{ data: SetupData; reload: () => void } | null>(null);

export function useSetup() {
  return useContext(SetupCtx);
}

/** Reads every status route once (and again on reload), in parallel. A route that fails leaves its card without a chip. */
export function SetupProvider({ site, children }: { site: Site; children: ReactNode }) {
  const [data, setData] = useState<SetupData>(EMPTY);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    let alive = true;
    const put = <K extends keyof SetupData>(k: K) => (v: SetupData[K]) => alive && setData((d) => ({ ...d, [k]: v }));
    const get = <T,>(url: string) => api<T>(url);
    get<(Site & { visitors24h?: number; online?: number })[]>('/api/sites').then((all) => put('row')(all.find((s) => s.id === site.id) ?? null), () => undefined);
    if (isPro) get<GoogleStatus>('/api/seo/google').then(put('google'), () => undefined);
    get<KeyRow[]>('/api/v1/keys').then(put('keys'), () => undefined);
    if (isPro) get<{ devices: { id: string; lastSeenAt: number }[] }>('/api/mobile/devices').then((r) => put('devices')(r.devices), () => undefined);
    if (isPro) get<{ rules: { site_id: string }[] }>('/api/alerts/rules').then((r) => put('rules')(r.rules), () => undefined);
    get<{ members: { status: string }[] }>('/api/team').then((r) => put('team')(r.members), () => undefined);
    get<{ kind: string; expires_at: number | null }[]>(`/api/sites/${site.id}/share`).then(put('shares'), () => undefined);
    if (isPro && app(site)) get<AsaStatus>('/api/asa/status').then(put('asa'), () => undefined);
    if (isPro && web(site)) {
      get<XStatus>(`/api/sites/${site.id}/x`).then(put('x'), () => undefined);
      get<MetaReport>(`/api/sites/${site.id}/meta/settings`).then(put('meta'), () => undefined);
    }
    return () => {
      alive = false;
    };
  }, [site.id, site.app_bundle_id, site.domain, n]);
  return <SetupCtx.Provider value={{ data, reload }}>{children}</SetupCtx.Provider>;
}

/** The chip of one card, from the shared answers. */
export function useCardStatus(id: string, site: Site): CardStatus | null {
  const ctx = useSetup();
  return ctx ? statusFor(id, site, ctx.data) : null;
}
