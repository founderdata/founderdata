import { describe, expect, it } from 'vitest';
import * as routes from '../src/dashboard/lib/routes';

// The dashboard's route table (src/dashboard/lib/routes.ts): which page a path shows, and which requests the page
// makes first. App.tsx, navigate(), the hover preloader and the boot step all read it.

describe('dashboard routes', () => {
  const m = (path: string, viewer = false) => routes.matchRoute(path, viewer);

  it('resolves every route the router had', () => {
    expect(m('/')).toEqual({ page: 'home' });
    expect(m('/apps')).toEqual({ page: 'apps' });
    expect(m('/apps/')).toEqual({ page: 'apps' });
    expect(m('/notifications')).toEqual({ page: 'notifications' });
    expect(m('/site/a-1/settings')).toEqual({ page: 'settings', siteId: 'a-1' });
    expect(m('/site/a-1')).toEqual({ page: 'dashboard', siteId: 'a-1', view: 'overview' });
    for (const view of ['plan', 'dropoff', 'people', 'recordings', 'content', 'seo', 'ai', 'subscriptions', 'ads', 'appstore', 'aso', 'app'] as const)
      expect(m(`/site/s1/${view}`)).toEqual({ page: 'dashboard', siteId: 's1', view });
    expect(m('/site/s1/content/page/blog/x')).toMatchObject({ view: 'content' });
    // Recordings: the list, one recording (?t= is the query, not the path), and the old address under People.
    expect(m('/site/s1/recordings/abcdef12-3456')).toEqual({ page: 'dashboard', siteId: 's1', view: 'recordings' });
    expect(m('/site/s1/people/recordings')).toEqual({ page: 'dashboard', siteId: 's1', view: 'recordings' });
    expect(m('/site/s1/recordings/a/b')).toEqual({ page: 'home' });
    expect(m('/site/s1/people/v-1')).toMatchObject({ view: 'people' });
    expect(m('/site/s1/people/p/visitor-1')).toMatchObject({ view: 'people' });
    for (const sub of ['search', 'keywords', 'cannibalization', 'ranks', 'ai', 'plan', 'pages']) expect(m(`/site/s1/seo/${sub}`)).toMatchObject({ view: 'seo' });
    expect(m('/site/s1/seo/other')).toEqual({ page: 'home' });
    expect(m('/live')).toEqual({ page: 'live' });
    expect(m('/dashboards')).toEqual({ page: 'dashboards', id: null });
    expect(m('/dashboards/db_abc123')).toEqual({ page: 'dashboards', id: 'db_abc123' });
    // A viewer reads dashboards too.
    expect(m('/dashboards/db_abc123', true)).toEqual({ page: 'dashboards', id: 'db_abc123' });
    expect(m('/dashboards/a/b')).toEqual({ page: 'home' });
    expect(m('/nowhere')).toEqual({ page: 'home' });
  });

  it('keeps alert channels away from the viewer login', () => {
    expect(m('/notifications', true)).toEqual({ page: 'home' });
    expect(m('/notifications', false)).toEqual({ page: 'notifications' });
  });

  it('knows which paths are app paths', () => {
    expect(routes.isAppPath('/')).toBe(true);
    expect(routes.isAppPath('/site/x/seo')).toBe(true);
    expect(routes.isAppPath('/pricing')).toBe(false);
  });

  it('builds the first requests in the form the components use', () => {
    expect(routes.dataOf(m('/'), '')).toEqual(['/api/home?period=30d', '/api/home/growth?period=30d']);
    expect(routes.dataOf(m('/'), '?period=7d')).toEqual(['/api/home?period=7d', '/api/home/growth?period=7d']);
    expect(routes.dataOf(m('/'), '?period=bogus')).toEqual(['/api/home?period=30d', '/api/home/growth?period=30d']);
    const site = routes.dataOf(m('/site/s1'), '');
    expect(site.slice(0, 2)).toEqual(['/api/sites', '/api/sites/s1/overview?period=30d']);
    expect(site).toContain('/api/sites/s1/breakdown?period=30d&dim=channel');
    expect(site).toContain('/api/sites/s1/email?period=30d');
    expect(routes.dataOf(m('/site/s1'), '?period=custom&from=2026-01-01&to=2026-01-31')[1]).toBe(
      '/api/sites/s1/overview?period=custom&from=2026-01-01&to=2026-01-31',
    );
    expect(routes.dataOf(m('/site/s1/seo'), '')).toContain('/api/sites/s1/seo');
    expect(routes.dataOf(m('/site/s1/paid'), '?period=7d')).toContain('/api/sites/s1/paid?period=7d');
    expect(routes.dataOf(m('/apps'), '')).toEqual([]);
  });
});

// index.html starts the first page's requests before any script runs, and lib/cache.ts picks them up by URL. A URL
// that drifts from the one dataOf builds is simply not used: the page asks again and the head start is lost.
describe('early requests in index.html', () => {
  it('start the same URLs the route table asks for first', async () => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
    const home = routes.dataOf({ page: 'home' }, '');
    expect(home).toEqual(['/api/home?period=30d', '/api/home/growth?period=30d']);
    for (const url of home) expect(html).toContain(`go('${url}')`);
    const site = routes.dataOf({ page: 'dashboard', siteId: 'SITE', view: 'overview' }, '');
    expect(site[0]).toBe('/api/sites');
    expect(site[1]).toBe('/api/sites/SITE/overview?period=30d');
    expect(html).toContain(`go('${site[0]}')`);
    expect(html).toContain(`go('/api/sites/' + site[1] + '/overview?period=30d')`);
  });
});
