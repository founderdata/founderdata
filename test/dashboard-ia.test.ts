// Round 6, build I (dashboard information architecture): every section one click away in a grouped row, unconnected
// sections muted with a setup step, Apple Search Ads beside Meta ads, breakdown rows that open the deeper screen, the
// page state in the URL (a filter is a history entry, so Back removes it), dashboard_url on agent answers, and no emoji.
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BREAKDOWN_CARDS, CUSTOMER_TABS, OVERVIEW_TAB_IDS, PLATFORM_CARD } from '../src/shared/dashboard-tabs';
import type { Site } from '../src/dashboard/lib/api';
import { flag } from '../src/dashboard/lib/format';
import { initialsOf, avatarLook } from '../src/dashboard/components/Icons';
import { matchRoute, dataOf } from '../src/dashboard/lib/routes';
import { rowActions } from '../src/dashboard/lib/rowActions';
import { ALL_VIEWS, SECTION_GROUPS, SECTION_LABELS, carriedSearch, sectionPath, sectionState, sectionUrl, viewsFor, type View } from '../src/dashboard/lib/sections';
import { URL_EVENT, closeVisitor, openVisitor, patchSearch, tabFrom, withTab, type UrlWindow } from '../src/dashboard/lib/urlState';
import { applyQuery, nextQuery, queryFromUrl, queryHref, readQuery, searchWithFilter } from '../src/dashboard/lib/useQueryState';
import { dashboardLinks, dashboardUrl, withLink } from '../src/worker/dashboard-url';
import type { AppEnv } from '../src/worker/env';
import { resetKeysForTests } from '../src/worker/keys';
import { resetShareCachesForTests } from '../src/worker/share';
import { startWorker, type TestWorker } from './helpers/worker';
import { itCore, itPro } from './helpers/edition';

const ROOT = path.resolve(__dirname, '..');

const site = (fields: Partial<Site> = {}): Site => ({ id: 's1', name: 'Shop', domain: 'shop.example.com', ...fields }) as Site;
const webOnly = site();
const appOnly = site({ domain: 's1.invalid', app_bundle_id: 'com.example.shop', has_asa: false });
const both = site({ app_bundle_id: 'com.example.shop', has_meta: true, has_asa: true, stripe_webhook_secret: 'whsec_test' } as Partial<Site>);

/**
 * A browser window with a real history stack: pushState adds an entry, replaceState changes the current one and back()
 * steps to the entry before and sends popstate, the way a browser does. Enough for the URL state code.
 */
class FakeWindow extends EventTarget implements UrlWindow {
  entries: { url: URL; state: unknown }[];
  index = 0;
  constructor(start: string) {
    super();
    this.entries = [{ url: new URL(start, 'https://founderdata.example.com'), state: null }];
  }
  get location() {
    return this.entries[this.index].url as unknown as Location;
  }
  readonly history = (() => {
    const w = this;
    return {
      get length() {
        return w.entries.length;
      },
      get state() {
        return w.entries[w.index].state;
      },
      pushState(state: unknown, _: string, url: string) {
        w.entries.splice(w.index + 1);
        w.entries.push({ url: new URL(url, w.location.href), state });
        w.index++;
      },
      replaceState(state: unknown, _: string, url: string) {
        w.entries[w.index] = { url: new URL(url, w.location.href), state };
      },
      back() {
        if (w.index === 0) return;
        w.index--;
        w.dispatchEvent(new Event('popstate'));
      },
    } as unknown as History;
  })();
  get path() {
    return `${this.location.pathname}${this.location.search}`;
  }
}

describe('section row', () => {
  it('puts every section in exactly one group, in the order Agent, Analytics, Organic, Paid, Revenue', () => {
    expect(SECTION_GROUPS.map((g) => g.label)).toEqual(['Agent', 'Analytics', 'Organic', 'Paid', 'Revenue']);
    // The agent's plan has a group of its own, first in the row; a site still opens on the Overview.
    expect(SECTION_GROUPS[0].views).toEqual(['plan']);
    expect(matchRoute('/site/s1', false)).toEqual({ page: 'dashboard', siteId: 's1', view: 'overview' });
    const all = SECTION_GROUPS.flatMap((g) => g.views);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(Object.keys(SECTION_LABELS).sort());
    expect(ALL_VIEWS).toEqual(all);
    expect(SECTION_GROUPS.find((g) => g.id === 'paid')!.views).toEqual(['paid', 'ads', 'asa']);
    expect(SECTION_GROUPS.find((g) => g.id === 'organic')!.views).toEqual(['seo', 'ai', 'aso']);
    // Recordings sit in Analytics right after People (pro/docs/recordings-agents-plan.md, R6); Errors after Recordings and
    // Experiments before App (round 7, plan section 3).
    expect(SECTION_GROUPS.find((g) => g.id === 'analytics')!.views).toEqual(['overview', 'people', 'recordings', 'errors', 'content', 'dropoff', 'experiments', 'app']);
  });

  it('links each section to a path that opens it, Apple Search Ads at /ads/asa next to Meta ads at /ads', () => {
    for (const v of ALL_VIEWS) expect(matchRoute(sectionPath('s1', v), false), v).toEqual({ page: 'dashboard', siteId: 's1', view: v });
    expect(sectionPath('s1', 'asa')).toBe('/site/s1/ads/asa');
    expect(sectionPath('s1', 'ads')).toBe('/site/s1/ads');
    expect(sectionPath('s1', 'paid')).toBe('/site/s1/paid');
    expect(sectionPath('s1', 'overview')).toBe('/site/s1');
  });

  itPro('keeps every section one click away on every kind of site: none is hidden, the ones not set up are muted', () => {
    for (const s of [webOnly, appOnly, both]) {
      // The row draws ALL_VIEWS for every site; sectionState only decides how each looks and what it opens.
      for (const v of ALL_VIEWS) expect(typeof sectionState(s, v).muted).toBe('boolean');
    }
    // A website without Meta, an app or subscriptions: those sections are muted, not gone.
    const muted = (s: Site) => ALL_VIEWS.filter((v) => sectionState(s, v).muted);
    expect(muted(webOnly)).toEqual(['app', 'aso', 'paid', 'ads', 'asa', 'subscriptions', 'appstore']);
    expect(muted(appOnly)).toEqual(['recordings', 'errors', 'content', 'seo', 'ai', 'paid', 'ads', 'asa']);
    expect(muted(both)).toEqual([]);
    // Apple Search Ads without the deployment's ASA_* secrets is muted but opens its own setup steps.
    expect(sectionState({ ...both, has_asa: false }, 'asa')).toEqual({ muted: true, setup: null });
    expect(sectionState({ ...both, has_meta: false }, 'ads')).toEqual({ muted: true, setup: null });
    // The Paid overview opens for any channel with spend: Meta, Apple Search Ads or rows sent from another channel.
    expect(sectionState({ ...webOnly, has_spend: true }, 'paid')).toEqual({ muted: false, setup: null });
    expect(sectionState({ ...both, has_meta: false }, 'paid')).toEqual({ muted: false, setup: null });
  });

  itPro('shows a setup step instead of a section the site cannot use, pointing at its Settings card', () => {
    expect(sectionState(webOnly, 'app').setup).toMatchObject({ title: 'This section needs an iOS app', settings: 'general' });
    expect(sectionState(appOnly, 'seo').setup).toMatchObject({ title: 'This section needs a website', settings: 'general' });
    expect(sectionState(webOnly, 'subscriptions').setup).toMatchObject({ settings: 'payments' });
    expect(sectionState(webOnly, 'overview')).toEqual({ muted: false, setup: null });
    expect(viewsFor(webOnly)).toEqual(['plan', 'overview', 'people', 'recordings', 'errors', 'content', 'dropoff', 'experiments', 'seo', 'ai', 'paid', 'ads']);
    // Experiments list the app's experiments too, so an app-only site has the section; Errors need a website.
    expect(viewsFor(appOnly)).toEqual(['plan', 'overview', 'people', 'dropoff', 'experiments', 'app', 'aso', 'paid', 'asa', 'subscriptions', 'appstore']);
    expect(sectionState(appOnly, 'errors').setup).toMatchObject({ title: 'This section needs a website' });
    // The plan needs neither a website nor an app.
    expect(sectionState(appOnly, 'plan')).toEqual({ muted: false, setup: null });
    expect(sectionState(webOnly, 'plan')).toEqual({ muted: false, setup: null });
  });

  it('carries the period and filters to another section, not the section\'s own tab, view or visitor', () => {
    const search = '?period=7d&filters=%7B%22country%22%3A%22DE%22%7D&tab=source&view=keyword&visitor=v1';
    expect(carriedSearch(search)).toBe('?period=7d&filters=%7B%22country%22%3A%22DE%22%7D');
    // The filters of Recordings and the second a recording opens at stay on Recordings too.
    expect(carriedSearch('?period=7d&page=%2Fpricing&exit=%2Fpricing&signal=dead&outcome=none&device=mobile&sort=newest&t=27')).toBe('?period=7d');
    // Round 7: the filters of Errors and Recordings, the click map device, a Paths sequence, the retention scope and split.
    expect(
      carriedSearch('?period=7d&issue=a1b2c3d4e5f6&exp=pricing%3Ab&status=open&map=mobile&seq=%2F%2C%2Fpricing&scope=known&split=channel&funnel=f1&step=2&channel=Direct&customer=1'),
    ).toBe('?period=7d');
    expect(sectionUrl('s1', 'seo', search)).toBe('/site/s1/seo?period=7d&filters=%7B%22country%22%3A%22DE%22%7D');
    expect(sectionUrl('s1', 'overview', '')).toBe('/site/s1');
  });
});

describe('section row on the page', () => {
  // Toolbar is what every site page draws on top (Dashboard.tsx). Rendered to HTML with a stand-in window.
  const render = async (s: Site, view: View) => {
    const { Toolbar } = await import('../src/dashboard/components/Toolbar');
    const g = globalThis as { window?: unknown };
    const before = g.window;
    g.window = Object.assign(new FakeWindow(`${sectionPath(s.id, view)}?period=7d`), { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    try {
      const props = { site: s, sites: [s], q: readQuery('?period=7d'), update: () => {}, overview: undefined, view, hidePeriod: false };
      return renderToStaticMarkup(createElement(Toolbar as any, props));
    } finally {
      g.window = before;
    }
  };
  const nav = (html: string) => html.slice(html.indexOf('<nav aria-label="Sections"'), html.indexOf('</nav>', html.indexOf('<nav aria-label="Sections"')));

  it('draws all 17 sections on every page of every kind of site, the open one marked and the unset ones muted', async () => {
    for (const s of [webOnly, appOnly, both]) {
      for (const view of ALL_VIEWS) {
        const html = nav(await render(s, view));
        const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
        expect(links.map((l) => l[1]), `${s.domain} ${view}`).toEqual(ALL_VIEWS.map((v) => sectionUrl(s.id, v, '?period=7d')));
        expect(links.filter((l) => l[0].includes('aria-current="page"')).map((l) => l[1])).toEqual([sectionUrl(s.id, view, '?period=7d')]);
        const muted = links.filter((l) => l[2].includes('(not set up)')).length;
        expect(muted).toBe(ALL_VIEWS.filter((v) => sectionState(s, v).muted).length);
      }
    }
  });

  it('puts the section row on every site page, whatever the section', () => {
    const toolbar = fs.readFileSync(path.join(ROOT, 'src/dashboard/components/Toolbar.tsx'), 'utf8');
    expect(toolbar).toMatch(/<SectionNav site=\{site\} view=\{view\} \/>\s*<\/StickyBar>/);
    const page = fs.readFileSync(path.join(ROOT, 'src/dashboard/pages/Dashboard.tsx'), 'utf8');
    // The Toolbar is the first thing inside the page, with no condition on the view.
    expect(page).toMatch(/<div className="mx-auto max-w-\[1240px\][^"]*">\s*<Toolbar\b/);
  });
});

describe('page state in the URL', () => {
  const q0 = readQuery('?period=30d&tab=source&visitor=v9');

  it('pushes a history entry for a filter, so Back removes it again', () => {
    const add = queryHref(q0, nextQuery(q0, { filters: { country: 'DE' } }), '?period=30d&tab=source&visitor=v9', '/site/s1');
    expect(add.push).toBe(true);
    expect(readQuery(add.url.slice(add.url.indexOf('?'))).filters).toEqual({ country: 'DE' });
    // Back returns to the URL before, which reads as no filter.
    expect(readQuery('?period=30d&tab=source&visitor=v9').filters).toEqual({});
    const q1 = readQuery(add.url.slice(add.url.indexOf('?')));
    expect(queryHref(q1, nextQuery(q1, { filters: {} }), add.url, '/site/s1').push).toBe(true);
  });

  it('replaces the entry for a period or grouping change, and keeps ?tab=, ?view= and ?visitor=', () => {
    const r = queryHref(q0, nextQuery(q0, { period: '7d' }), '?period=30d&tab=source&visitor=v9', '/site/s1');
    expect(r.push).toBe(false);
    const p = new URLSearchParams(r.url.split('?')[1]);
    expect(p.get('period')).toBe('7d');
    expect(p.get('tab')).toBe('source');
    expect(p.get('visitor')).toBe('v9');
    expect(queryHref(q0, nextQuery(q0, { granularity: 'week' }), '?period=30d', '/site/s1').push).toBe(false);
    // A custom range is dropped when a preset period comes back.
    expect(nextQuery({ ...q0, period: 'custom', from: '2026-01-01', to: '2026-01-31' }, { period: '7d' })).toMatchObject({ from: undefined, to: undefined });
  });

  it('runs a filter through the browser history: a click pushes, Back pops it and the page reads the query again', () => {
    const w = new FakeWindow('/site/s1?period=30d&tab=source');
    const heard: string[] = [];
    w.addEventListener('popstate', () => heard.push('popstate'));
    const q0 = readQuery(w.location.search);
    const q1 = applyQuery(q0, { filters: { channel: 'Organic Search' } }, w);
    expect(w.history.length).toBe(2);
    expect(readQuery(w.location.search).filters).toEqual({ channel: 'Organic Search' });
    expect(new URLSearchParams(w.location.search).get('tab')).toBe('source');
    // A period change on top replaces that entry: one Back still removes the filter.
    const q2 = applyQuery(q1, { period: '7d' }, w);
    expect(w.history.length).toBe(2);
    expect(readQuery(w.location.search)).toMatchObject({ period: '7d', filters: { channel: 'Organic Search' } });
    // A query that did not change keeps its object, so nothing reloads.
    expect(queryFromUrl(q2, w.location.search)).toBe(q2);
    w.history.back();
    expect(heard).toEqual(['popstate']);
    expect(w.path).toBe('/site/s1?period=30d&tab=source');
    const back = queryFromUrl(q2, w.location.search);
    expect(back).toMatchObject({ period: '30d', filters: {} });
    expect(back).not.toBe(q2);
  });

  it('replaces the entry for a period change made on its own', () => {
    const w = new FakeWindow('/site/s1?period=30d');
    applyQuery(readQuery(w.location.search), { period: '7d' }, w);
    applyQuery(readQuery(w.location.search), { granularity: 'week' }, w);
    expect(w.history.length).toBe(1);
    expect(w.path).toBe('/site/s1?period=7d&granularity=week');
  });

  it('opens a visitor as a history entry and closes it with Back', () => {
    const w = new FakeWindow('/site/s1?period=7d');
    let events = 0;
    w.addEventListener(URL_EVENT, () => events++);
    openVisitor('v42', w);
    expect(w.history.length).toBe(2);
    expect(w.path).toBe('/site/s1?period=7d&visitor=v42');
    expect(events).toBe(1);
    // Closing steps back, so a second Back leaves the page instead of opening the profile again.
    closeVisitor(w);
    expect(w.index).toBe(0);
    expect(w.path).toBe('/site/s1?period=7d');
    // The browser's own Back does the same: the entry before has no visitor.
    openVisitor('v43', w);
    w.history.back();
    expect(new URLSearchParams(w.location.search).get('visitor')).toBeNull();
  });

  it('closes a visitor opened from a link by dropping ?visitor= from that entry', () => {
    const w = new FakeWindow('/site/s1?period=7d&visitor=v42');
    closeVisitor(w);
    expect(w.history.length).toBe(1);
    expect(w.path).toBe('/site/s1?period=7d');
  });

  it('adds a filter to a link into another section', () => {
    expect(readQuery(searchWithFilter('?period=7d', 'utm_campaign', '123')).filters).toEqual({ utm_campaign: '123' });
  });

  it('opens the Heard about tab from ?tab=heard_about, also with a period (critique shared-11)', () => {
    // Checked in a browser on the seeded demo: a direct load, a load through the login page and the Settings > Surveys
    // link all open Heard about. These pin the two pieces that decide it: the tab state and the first request.
    const channel = BREAKDOWN_CARDS[0].map((t) => t.dim);
    expect(channel).toContain('heard_about');
    expect(tabFrom('heard_about', channel)).toBe('heard_about');
    const route = matchRoute('/site/demo0001');
    expect(route).toBeTruthy();
    const urls = dataOf(route!, '?tab=heard_about&period=30d');
    expect(urls.some((u) => u.includes('/breakdown?') && u.includes('dim=heard_about') && u.includes('period=30d'))).toBe(true);
  });

  it('keeps one ?tab= list for every card, with each card\'s first tab as no entry', () => {
    const channel = BREAKDOWN_CARDS[0].map((t) => t.dim);
    const pages = BREAKDOWN_CARDS[1].map((t) => t.dim);
    let list = withTab(null, channel, 'source');
    expect(list).toBe('source');
    list = withTab(list, CUSTOMER_TABS, 'changes');
    expect(list).toBe('source,changes');
    expect(tabFrom(list, channel)).toBe('source');
    expect(tabFrom(list, CUSTOMER_TABS)).toBe('changes');
    expect(tabFrom(list, pages)).toBeNull();
    expect(withTab(list, channel, 'channel')).toBe('changes');
    expect(withTab('changes', CUSTOMER_TABS, 'journey')).toBeNull();
    // Tab ids are unique across the Overview, so one list can hold them all.
    expect(new Set(OVERVIEW_TAB_IDS).size).toBe(OVERVIEW_TAB_IDS.length);
    expect(OVERVIEW_TAB_IDS).toEqual(expect.arrayContaining([...PLATFORM_CARD.map((t) => t.dim), 'journey', 'changes']));
  });

  it('sets and clears single parameters without touching the rest', () => {
    expect(patchSearch('/site/s1?period=7d#x', { visitor: 'v1' })).toBe('/site/s1?period=7d&visitor=v1#x');
    expect(patchSearch('/site/s1?period=7d&visitor=v1', { visitor: null })).toBe('/site/s1?period=7d');
  });

  it('starts the open tab\'s breakdown first when the URL names one', () => {
    const urls = dataOf(matchRoute('/site/s1', false), '?tab=source,city');
    expect(urls).toContain('/api/sites/s1/breakdown?period=30d&dim=source');
    expect(urls).toContain('/api/sites/s1/breakdown?period=30d&dim=city');
    expect(urls).toContain('/api/sites/s1/breakdown?period=30d&dim=page');
    expect(urls).not.toContain('/api/sites/s1/breakdown?period=30d&dim=channel');
  });
});

describe('breakdown row actions', () => {
  const search = '?period=7d&tab=channel';
  const acts = (s: Site, dim: string, label: string, name?: string) => rowActions(s, dim, { label, name }, search).map((a) => [a.label, a.href]);

  it('opens a page\'s detail from Page and Entry page', () => {
    expect(acts(webOnly, 'page', '/pricing')).toEqual([['Open page detail', '/site/s1/content/page/pricing?period=7d']]);
    expect(acts(webOnly, 'entry_page', '/blog/a b')).toEqual([['Open page detail', '/site/s1/content/page/blog/a%20b?period=7d']]);
    // An app screen is not a web page.
    expect(acts(appOnly, 'page', '/pricing')).toEqual([]);
  });

  it('opens SEO, AI visibility or the ads sections from a channel', () => {
    expect(acts(both, 'channel', 'Organic Search')).toEqual([['Open SEO', '/site/s1/seo?period=7d']]);
    expect(acts(both, 'channel', 'AI')).toEqual([['Open AI visibility', '/site/s1/ai?period=7d']]);
    expect(acts(both, 'channel', 'Paid')).toEqual([
      ['Open Paid overview', '/site/s1/paid?period=7d'],
      ['Open Meta ads', '/site/s1/ads?period=7d'],
      ['Open Apple Search Ads', '/site/s1/ads/asa?period=7d'],
    ]);
    expect(acts(webOnly, 'channel', 'Paid')).toEqual([
      ['Open Paid overview', '/site/s1/paid?period=7d'],
      ['Open Meta ads', '/site/s1/ads?period=7d'],
    ]);
    expect(acts(both, 'channel', 'Direct')).toEqual([]);
  });

  it('opens SEO, AI visibility, Meta ads or Apple Search Ads from a referrer', () => {
    expect(acts(both, 'source', 'Google')).toEqual([['Open SEO', '/site/s1/seo?period=7d']]);
    expect(acts(both, 'source', 'ChatGPT')).toEqual([['Open AI visibility', '/site/s1/ai?period=7d']]);
    expect(acts(both, 'source', 'Instagram')).toEqual([['Open Meta ads', '/site/s1/ads?period=7d']]);
    // Organic Instagram on a site without a Meta ad account has nothing deeper.
    expect(acts(webOnly, 'source', 'Instagram')).toEqual([]);
    expect(acts(both, 'source', 'Apple Search Ads')).toEqual([['Open Apple Search Ads', '/site/s1/ads/asa?period=7d']]);
    expect(acts(both, 'source', 'Hacker News')).toEqual([]);
    // A visit with an ad click id has the network as its source: it opens the Paid overview, where its spend is.
    expect(acts(webOnly, 'source', 'Google Ads')).toEqual([['Open Paid overview', '/site/s1/paid?period=7d']]);
    expect(acts(appOnly, 'source', 'TikTok Ads')).toEqual([['Open Paid overview', '/site/s1/paid?period=7d']]);
  });

  it('opens Apple Search Ads for its ids and Meta ads for the Meta account\'s campaigns', () => {
    expect(acts(both, 'campaign', '1874400202', 'Brand US')).toEqual([['Open Apple Search Ads', '/site/s1/ads/asa?period=7d']]);
    expect(acts(both, 'keyword', '998877', 'habit tracker')).toEqual([['Open Apple Search Ads', '/site/s1/ads/asa?period=7d&view=keyword']]);
    expect(acts(appOnly, 'campaign', '1874400202')).toEqual([['Open Apple Search Ads', '/site/s1/ads/asa?period=7d']]);
    // Meta ads only for a campaign of the site's Meta ad account: the Worker flags those rows (meta-campaigns.ts).
    const metaRow = (s: Site, label: string, meta?: boolean) => rowActions(s, 'campaign', { label, meta }, search).map((a) => a.label);
    expect(metaRow(both, 'spring_sale', true)).toEqual(['Open Meta ads']);
    expect(metaRow(both, 'newsletter_nov')).toEqual([]);
    expect(metaRow(webOnly, 'spring_sale')).toEqual([]);
    // A number is an Apple Search Ads id unless Meta knows it as one of its campaigns.
    expect(metaRow(both, '120210000000001')).toEqual(['Open Apple Search Ads']);
    expect(metaRow(both, '120210000000001', true)).toEqual(['Open Meta ads']);
  });

  it('offers nothing for a row without a value', () => {
    expect(rowActions(both, 'channel', { label: null }, search)).toEqual([]);
  });
});

describe('no emoji in the UI', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  // Emoji_Presentation covers the faces, animals and objects that render as color pictures, and U+FE0F asks for
  // the picture form of a text symbol. Arrows, check marks and stars in text style stay allowed.
  const EMOJI = /[\p{Emoji_Presentation}\u{FE0F}]|\\u\{1F[0-9A-F]{3}\}|\\uD83[C-E]/iu;

  itPro('has no emoji in the dashboard source or in what the Worker sends it', () => {
    const files = [...walk(path.join(ROOT, 'src/dashboard')), ...walk(path.join(ROOT, 'src/worker'))].filter((f) => /\.(tsx?|css|html)$/.test(f));
    const hits = files.flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (EMOJI.test(line) ? [`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 80)}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  it('draws an unknown country as the globe glyph, not an emoji globe', () => {
    expect(flag('XX')).toBeNull();
    expect(flag(null)).toBeNull();
    // A country is named by its flag: two regional indicator letters, the one emoji-font text left (docs/DESIGN.md).
    expect(flag('de')).toBe('\u{1F1E9}\u{1F1EA}');
  });

  it('gives visitors initials or a stone pattern, the same for the same id', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada@example.com')).toBe('A');
    expect(initialsOf('  ')).toBeNull();
    const a = avatarLook('visitor-1');
    expect(avatarLook('visitor-1')).toEqual(a);
    expect(a.initials).toBeNull();
    expect(a.cells.length).toBeGreaterThan(0);
    expect(a.bg).toMatch(/^rgb\(var\(--stone-\d+\)\)$/);
    expect(JSON.stringify(avatarLook('visitor-2', 'Grace Hopper'))).toContain('"initials":"GH"');
  });

  it('writes the live globe exception into DESIGN.md', () => {
    const design = fs.readFileSync(path.join(ROOT, 'docs/DESIGN.md'), 'utf8');
    expect(design).toContain('The live globe may draw live visitors in brand mint.');
  });
});

describe('dashboard_url', () => {
  it('links each read route to the screen that shows it, with the same days and filters', () => {
    const o = 'https://founderdata.example.com';
    const u = (p: string, id: string | null = 'SITE') => dashboardUrl(`${o}/api/v1/${p}`, id);
    expect(u('stats/overview?period=7d')).toBe(`${o}/site/SITE?period=7d`);
    expect(u('stats/breakdown?dim=source&period=7d&limit=5')).toBe(`${o}/site/SITE?period=7d&tab=source`);
    // Goals have their own tab in the customers card.
    expect(u('stats/breakdown?dim=goal')).toBe(`${o}/site/SITE?tab=goal`);
    expect(u('stats/breakdown?dim=utm_medium')).toBe(`${o}/site/SITE`);
    expect(u('customers?from=2026-11-01&to=2026-11-07')).toBe(`${o}/site/SITE?period=custom&from=2026-11-01&to=2026-11-07&tab=journey`);
    expect(u(`stats/overview?filters=${encodeURIComponent('{"country":"DE"}')}`)).toBe(`${o}/site/SITE?filters=${encodeURIComponent('{"country":"DE"}')}`);
    expect(u('stats/overview?filters=nope')).toBe(`${o}/site/SITE`);
    expect(u('notes?due=true')).toBe(`${o}/site/SITE?tab=changes`);
    expect(u('notes/n1/impact')).toBe(`${o}/site/SITE?tab=changes`);
    expect(u('content/page?path=/pricing')).toBe(`${o}/site/SITE/content/page/pricing`);
    expect(u('meta?period=30d&window=7')).toBe(`${o}/site/SITE/ads?period=30d`);
    expect(u('paid?period=90d')).toBe(`${o}/site/SITE/paid?period=90d`);
    expect(u('asa/campaigns?days=7')).toBe(`${o}/site/SITE/ads/asa`);
    expect(u('seo/opportunities')).toBe(`${o}/site/SITE/seo/keywords`);
    expect(u('ranks')).toBe(`${o}/site/SITE/seo/ranks`);
    expect(u('app/paywall?period=7d')).toBe(`${o}/site/SITE/app?period=7d`);
    expect(u('portfolio?period=7d', null)).toBe(`${o}/?period=7d`);
    expect(u('definitions')).toBeNull();
    expect(u('research')).toBeNull();
    expect(u('stats/overview', null)).toBeNull();
    // Every link opens a dashboard route, not Home by accident.
    for (const p of ['stats/overview', 'customers', 'content', 'content/page?path=/a', 'seo', 'seo/decay', 'seo/audit', 'seo/cannibalization', 'ai-answers', 'ai-visibility', 'aso', 'appstore', 'subscriptions', 'cohorts', 'meta', 'paid', 'asa', 'app/retention', 'vitals', 'email']) {
      const link = new URL(u(p)!);
      expect(matchRoute(link.pathname, false), p).toMatchObject({ page: 'dashboard', siteId: 'SITE' });
    }
  });

  it('links round 7\'s read routes: errors, experiments, web retention and lifecycle, paths', () => {
    const o = 'https://founderdata.example.com';
    const u = (p: string) => dashboardUrl(`${o}/api/v1/${p}`, 'SITE');
    expect(u('errors?status=open&period=7d')).toBe(`${o}/site/SITE/errors?period=7d&status=open`);
    expect(u('errors/a1b2c3d4e5f6')).toBe(`${o}/site/SITE/errors/a1b2c3d4e5f6`);
    expect(u('experiments?platform=web')).toBe(`${o}/site/SITE/experiments`);
    expect(u('experiments/pricing_headline')).toBe(`${o}/site/SITE/experiments/pricing_headline`);
    expect(u('experiments/exp_paywall?platform=app')).toBe(`${o}/site/SITE/experiments/exp_paywall?platform=app`);
    expect(u('errors?page=/checkout&device=mobile')).toBe(`${o}/site/SITE/errors?page=%2Fcheckout&device=mobile`);
    // The Recordings links keep round 7's filters, so an agent's link opens the same visits.
    expect(u('recordings?exp=pricing_headline:b&issue=a1b2c3d4e5f6&limit=5')).toBe(`${o}/site/SITE/recordings?issue=a1b2c3d4e5f6&exp=pricing_headline%3Ab`);
    expect(u('recordings?funnel=f1&step=2&customer=1')).toBe(`${o}/site/SITE/recordings?customer=1&funnel=f1&step=2`);
    expect(u('web/retention?scope=known&split=channel')).toBe(`${o}/site/SITE/people/retention?scope=known&split=channel`);
    expect(u('web/lifecycle?period=90d')).toBe(`${o}/site/SITE/people/retention?period=90d`);
    // app/retention on a site with no app answers web retention (critique 2 int-4), so it links to the web grid.
    expect(dashboardUrl(`${o}/api/v1/app/retention?period=90d&scope=all`, 'SITE', false)).toBe(`${o}/site/SITE/people/retention?period=90d&scope=all`);
    expect(dashboardUrl(`${o}/api/v1/app/retention?period=90d`, 'SITE', true)).toBe(`${o}/site/SITE/app?period=90d`);
    expect(u('paths?seq=/,/pricing')).toBe(`${o}/site/SITE/content/paths?seq=%2F%2C%2Fpricing`);
    expect(matchRoute('/site/SITE/errors', false)).toEqual({ page: 'dashboard', siteId: 'SITE', view: 'errors' });
    expect(matchRoute('/site/SITE/errors/a1b2c3d4e5f6', false)).toEqual({ page: 'dashboard', siteId: 'SITE', view: 'errors' });
    expect(matchRoute('/site/SITE/experiments/new', false)).toEqual({ page: 'dashboard', siteId: 'SITE', view: 'experiments' });
    expect(matchRoute('/site/SITE/content/paths', false)).toEqual({ page: 'dashboard', siteId: 'SITE', view: 'content' });
    expect(matchRoute('/site/SITE/people/retention', false)).toEqual({ page: 'dashboard', siteId: 'SITE', view: 'people' });
  });

  it('puts the field first in a JSON object and leaves arrays alone', () => {
    expect(JSON.parse(withLink('{"a":1}', 'L'))).toEqual({ dashboard_url: 'L', a: 1 });
    expect(withLink('{"a":1}', 'L').startsWith('{"dashboard_url":"L",')).toBe(true);
    expect(JSON.parse(withLink('{}', 'L'))).toEqual({ dashboard_url: 'L' });
    expect(withLink('[1,2]', 'L')).toBe('[1,2]');
  });

  it('sends the rewritten body with its own length, not the length of the answer before', async () => {
    // An edge Cache API hit comes with Content-Length. Hono copies the old answer's headers onto a new c.res unless it
    // is cleared first, which would send the old, shorter length with the longer body.
    const app = new Hono<AppEnv>();
    app.use('/api/v1/*', async (c, next) => {
      c.set('site', { id: 'SITE' } as AppEnv['Variables']['site']);
      await next();
    });
    app.use('/api/v1/*', dashboardLinks);
    const cachedAnswer = (body: string) => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'x-cache': 'hit' } });
    app.get('/api/v1/stats/overview', () => cachedAnswer('{"a":1}'));
    app.get('/api/v1/seo', () => cachedAnswer('{"snapshot":1}'));
    const res = await app.request('https://founderdata.example.com/api/v1/stats/overview?period=7d');
    const text = await res.text();
    expect(text).toBe('{"dashboard_url":"https://founderdata.example.com/site/SITE?period=7d","a":1}');
    const length = res.headers.get('content-length');
    expect(length === null || Number(length) === new TextEncoder().encode(text).length).toBe(true);
    expect(res.headers.get('x-cache')).toBe('hit');
    // A header-only answer keeps its body and the length that goes with it.
    const raw = await app.request('https://founderdata.example.com/api/v1/seo');
    expect(raw.headers.get('x-dashboard-url')).toBe('https://founderdata.example.com/site/SITE/seo');
    expect(raw.headers.get('content-length')).toBe('14');
    expect(await raw.text()).toBe('{"snapshot":1}');
  });

  describe('on the read API and the MCP tools', () => {
    let w: TestWorker;
    let s: any;
    let key = '';
    let n = 0;
    const auth = () => ({ cookie: '', authorization: `Bearer ${key}` });
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const res = await w.fetch('/mcp', {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json<any>()).result;
    };

    beforeAll(async () => {
      resetKeysForTests();
      resetShareCachesForTests();
      w = await startWorker();
      s = await w.createSite({ domain: 'links.example.com' });
      const r = await w.admin('/api/v1/keys', { method: 'POST', json: { name: 'agent', scopes: ['read', 'read:revenue'], sites: [s.id] } });
      key = r.body.key;
      await w.fetch('/api/event', {
        method: 'POST',
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36' },
        body: JSON.stringify({ w: s.id, t: 'pageview', u: 'https://links.example.com/pricing', r: 'https://www.google.com/', vid: 'links-vid-0001', sid: 'links-sid-0001' }),
      });
      await w.flush();
    });
    afterAll(() => w?.dispose());

    it('adds dashboard_url to a REST answer and the X-Dashboard-Url header', async () => {
      const res = await w.fetch('/api/v1/stats/breakdown?dim=source&period=7d', { headers: auth() });
      expect(res.status).toBe(200);
      const link = `http://localhost/site/${s.id}?period=7d&tab=source`;
      expect(res.headers.get('x-dashboard-url')).toBe(link);
      const body = await res.json<any>();
      expect(body.dashboard_url).toBe(link);
      expect(body.rows.map((r: any) => r.value)).toEqual(['Google']);
      // The cached answer gets the link too.
      expect((await (await w.fetch('/api/v1/stats/breakdown?dim=source&period=7d', { headers: auth() })).json<any>()).dashboard_url).toBe(link);
    });

    it('keeps an array answer an array, with the link in the header', async () => {
      const res = await w.fetch('/api/v1/customers?period=7d', { headers: auth() });
      expect(res.headers.get('x-dashboard-url')).toBe(`http://localhost/site/${s.id}?period=7d&tab=journey`);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    it('answers from the edge cache with a body and length that match, on REST and MCP', async () => {
      // The Cloudflare Cache API on a custom domain: a hit comes back with Content-Length, like the real one.
      const store = new Map<string, { body: string; headers: [string, string][] }>();
      const edge = {
        async match(key: string) {
          const hit = store.get(String(key));
          if (!hit) return undefined;
          return new Response(hit.body, { headers: [...hit.headers, ['content-length', String(new TextEncoder().encode(hit.body).length)]] });
        },
        async put(key: string, res: Response) {
          store.set(String(key), { body: await res.text(), headers: [...res.headers] });
        },
      };
      const g = globalThis as { caches?: unknown };
      const before = g.caches;
      g.caches = { default: edge };
      try {
        const path = '/api/v1/stats/breakdown?dim=page&period=90d';
        const link = `http://localhost/site/${s.id}?period=90d&tab=page`;
        await w.fetch(path, { headers: auth() });
        await w.flush();
        expect(store.size).toBeGreaterThan(0);
        // Empty the per-instance copy, so the next answer comes from the edge.
        resetShareCachesForTests();
        const res = await w.fetch(path, { headers: auth() });
        const text = await res.text();
        const length = res.headers.get('content-length');
        expect(length === null || Number(length) === new TextEncoder().encode(text).length).toBe(true);
        const body = JSON.parse(text);
        expect(body.dashboard_url).toBe(link);
        expect(body.rows.map((r: any) => r.value)).toEqual(['/pricing']);
        resetShareCachesForTests();
        const b = await mcp('get_breakdown', { dim: 'page', period: '90d' });
        expect(b.isError).toBeFalsy();
        expect(b.structuredContent.dashboard_url).toBe(link);
        expect(b.structuredContent.rows.map((r: any) => r.value)).toEqual(['/pricing']);
      } finally {
        g.caches = before;
        resetShareCachesForTests();
      }
    });

    it('links a one-site weekly report to that site', async () => {
      const res = await w.fetch('/api/v1/weekly', { headers: auth() });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-dashboard-url')).toBe(`http://localhost/site/${s.id}`);
      expect((await res.json<any>()).dashboard_url).toBe(`http://localhost/site/${s.id}`);
    });

    it('flags the campaigns of the site\'s Meta ad account on the dashboard\'s Campaign breakdown', async () => {
      const now = Date.now();
      await w.db.batch([
        w.db.prepare('INSERT INTO meta_settings (site_id, ad_account_id, updated_at) VALUES (?, ?, ?)').bind(s.id, 'act_1', now),
        w.db.prepare("INSERT INTO meta_objects (kind, id, account_id, name) VALUES ('campaign', '120210000000001', 'act_1', 'Spring Sale')"),
        w.db.prepare("INSERT INTO meta_objects (kind, id, account_id, name) VALUES ('campaign', '120210000000002', 'act_2', 'newsletter_nov')"),
      ]);
      const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
      for (const [i, campaign] of ['Spring Sale', 'newsletter_nov', '120210000000001'].entries()) {
        await w.fetch('/api/event', {
          method: 'POST',
          headers: { 'user-agent': ua },
          body: JSON.stringify({ w: s.id, t: 'pageview', u: `https://links.example.com/?utm_source=facebook&utm_medium=paid_social&utm_campaign=${encodeURIComponent(campaign)}`, vid: `meta-vid-000${i}`, sid: `meta-sid-000${i}` }),
        });
      }
      await w.flush();
      const r = await w.admin(`/api/sites/${s.id}/breakdown?dim=campaign&period=7d`);
      const flags = Object.fromEntries((r.body as any[]).filter((row) => row.label).map((row) => [row.label, !!row.meta]));
      // newsletter_nov is a campaign of another ad account, not this site's.
      expect(flags).toEqual({ 'Spring Sale': true, newsletter_nov: false, '120210000000001': true });
    });

    it('answers get_breakdown and get_customers with dashboard_url', async () => {
      const b = await mcp('get_breakdown', { dim: 'page', period: '7d' });
      expect(b.isError).toBeFalsy();
      expect(b.structuredContent.dashboard_url).toBe(`http://localhost/site/${s.id}?period=7d&tab=page`);
      const c = await mcp('get_customers', { period: '30d' });
      expect(c.isError).toBeFalsy();
      expect(c.structuredContent.dashboard_url).toBe(`http://localhost/site/${s.id}?period=30d&tab=journey`);
      const o = await mcp('get_overview', { from: '2026-11-01', to: '2026-11-07', filters: { country: 'DE' } });
      expect(new URL(o.structuredContent.dashboard_url).searchParams.get('filters')).toBe('{"country":"DE"}');
    });

    it('leaves errors and writes without a link', async () => {
      const bad = await w.fetch('/api/v1/stats/breakdown?dim=nope', { headers: auth() });
      expect(bad.headers.get('x-dashboard-url')).toBeNull();
      const who = await w.fetch('/api/v1/whoami', { headers: auth() });
      expect(who.headers.get('x-dashboard-url')).toBeNull();
    });
  });
});

describe('Needs you route', () => {
  // The page and its nav entry are FounderData Pro's slots (pro/dashboard/index.ts). Core has neither, so the path is Home.
  itCore('opens Home in core, where no Pro slot draws the page', () => {
    expect(matchRoute('/needs-you', false)).toEqual({ page: 'home' });
  });

  itPro('opens the Needs you page for an owner in Pro, and Home for the viewer login', () => {
    expect(matchRoute('/needs-you', false)).toEqual({ page: 'needsYou' });
    expect(matchRoute('/needs-you/', false)).toEqual({ page: 'needsYou' });
    expect(matchRoute('/needs-you', true)).toEqual({ page: 'home' });
  });
});
