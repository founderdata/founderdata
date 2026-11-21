// Data ownership and sharing: CSV export, list paging, erasing one person, share links and the read API
// (src/worker/export.ts, erase.ts, share.ts; docs/API.md).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureSwitches } from '../src/worker/agent-api';
import { csvCell } from '../src/worker/export';
import { resetShareCachesForTests, SHARE_MISSES_PER_MINUTE } from '../src/worker/share';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';

/** Parse CSV with quoted cells (enough for these tests). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n') row.push(cell), rows.push(row), (row = []), (cell = '');
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

describe('data access', () => {
  let w: TestWorker;
  let site: any;
  const now = Date.now();

  const pageview = async (vid: string, sid: string, path: string, referrer = '') => {
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA },
      body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://${site.domain}${path}`, r: referrer, vid, sid }),
    });
    await w.flush();
  };
  const pay = (id: string, amount: number, vid: string | null, sid: string | null, extra: Record<string, unknown> = {}) =>
    w.db
      .prepare('INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, email, name, customer_id, matched_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, site.id, 'stripe', (extra.ts as number) ?? now, amount, amount < 0 ? 'refund' : 'payment', 'USD', vid, sid, extra.email ?? null, extra.name ?? null, extra.customer ?? null, vid ? 'metadata' : null)
      .run();

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'shop.example.com' });
    await pageview('alice-vid-0001', 'alice-sid-0001', '/pricing', 'https://news.ycombinator.com/item?id=1');
    await pageview('alice-vid-0001', 'alice-sid-0001', '/checkout');
    await pageview('bob-vid-00001', 'bob-sid-00001', '/');
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA },
      body: JSON.stringify({ w: site.id, t: 'identify', u: `https://${site.domain}/`, vid: 'alice-vid-0001', sid: 'alice-sid-0001', p: { email: 'alice@example.com', name: 'Alice', user_id: 'u_alice' } }),
    });
    await w.flush();
    await pay('pi_alice', 2999, 'alice-vid-0001', 'alice-sid-0001', { email: 'alice@example.com', name: 'Alice', customer: 'cus_alice' });
    await pay('pi_formula', 1000, 'bob-vid-00001', 'bob-sid-00001', { email: '=HYPERLINK("http://evil.example")', name: 'Bob, "the builder"' });
    await pay('re_alice', -500, 'alice-vid-0001', 'alice-sid-0001');
  });
  afterAll(() => w.dispose());
  beforeEach(() => resetShareCachesForTests());

  describe('CSV export', () => {
    it('escapes cells and defuses formulas, but keeps negative numbers as numbers', () => {
      expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
      expect(csvCell('+1')).toBe("'+1");
      expect(csvCell('-x')).toBe("'-x");
      expect(csvCell('@me')).toBe("'@me");
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('two\nlines')).toBe('"two\nlines"');
      expect(csvCell(-29.99)).toBe('-29.99');
      expect(csvCell(null)).toBe('');
    });

    it('exports sessions with source, pages, country and device', async () => {
      const res = await w.fetch(`/api/sites/${site.id}/export/sessions.csv?period=today`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="shop.example.com-sessions-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
      const rows = parseCsv(await res.text());
      const head = rows[0];
      expect(head.slice(0, 3)).toEqual(['session_id', 'visitor_id', 'started_at']);
      expect(rows).toHaveLength(3);
      const alice = rows.find((r) => r[0] === 'alice-sid-0001')!;
      const col = (name: string) => alice[head.indexOf(name)];
      expect(col('pageviews')).toBe('2');
      expect(col('entry_page')).toBe('/pricing');
      expect(col('exit_page')).toBe('/checkout');
      expect(col('referrer_domain')).toBe('news.ycombinator.com');
      expect(col('platform')).toBe('Web');
      expect(col('browser')).toBe('Chrome');
    });

    it('exports events and payments, with amounts in major units and attribution', async () => {
      const events = parseCsv(await (await w.fetch(`/api/sites/${site.id}/export/events.csv?period=today`)).text());
      expect(events[0]).toEqual(['event_id', 'time', 'type', 'name', 'path', 'props', 'session_id', 'visitor_id']);
      expect(events.slice(1).map((r) => r[4])).toEqual(['/pricing', '/checkout', '/']);

      const text = await (await w.fetch(`/api/sites/${site.id}/export/payments.csv?period=today`)).text();
      const rows = parseCsv(text);
      const head = rows[0];
      const byId = Object.fromEntries(rows.slice(1).map((r) => [r[0], Object.fromEntries(head.map((h, i) => [h, r[i]]))]));
      expect(byId.pi_alice).toMatchObject({ amount: '29.99', currency: 'USD', email: 'alice@example.com', matched_by: 'metadata', source: 'Hacker News', entry_page: '/pricing' });
      expect(byId.re_alice).toMatchObject({ kind: 'refund', amount: '-5' });
      // The formula is defused and the comma and quotes survive.
      expect(byId.pi_formula.email).toBe(`'=HYPERLINK("http://evil.example")`);
      expect(byId.pi_formula.name).toBe('Bob, "the builder"');
    });

    it('pages through rows with a cursor and a Link header', async () => {
      const first = await w.fetch(`/api/sites/${site.id}/export/events.csv?period=today&limit=2`);
      expect(first.headers.get('x-rows')).toBe('2');
      const link = first.headers.get('link')!;
      expect(link).toMatch(/rel="next"/);
      const next = await w.fetch(link.slice(1, link.indexOf('>')));
      const rest = parseCsv(await next.text());
      // No header row on a continuation, and the third event follows.
      expect(rest).toHaveLength(1);
      expect(rest[0][4]).toBe('/');
      expect(next.headers.get('link')).toBeNull();
    });

    it('finds the next part when the limit ends on a full chunk of 1,000 rows', async () => {
      const big = await w.createSite({ domain: 'big.example.com' });
      await w.db
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
           INSERT INTO events (site_id, session_id, visitor_id, ts, type, path) SELECT ?, 's', 'v', ? + i, 'pageview', '/p' || i FROM n`,
        )
        .bind(big.id, now - 60_000)
        .run();
      const first = await w.fetch(`/api/sites/${big.id}/export/events.csv?period=today&limit=1000`);
      expect(first.headers.get('x-rows')).toBe('1000');
      const link = first.headers.get('link')!;
      expect(link).toMatch(/rel="next"/);
      const rest = parseCsv(await (await w.fetch(link.slice(1, link.indexOf('>')))).text());
      expect(rest.map((r) => r[4])).toEqual(['/p1001']);
      const whole = await w.fetch(`/api/sites/${big.id}/export/events.csv?period=today`);
      expect(whole.headers.get('x-rows')).toBe('1001');
      expect(whole.headers.get('link')).toBeNull();
    });

    it('takes from and to without a period, so a script can export a month at a time', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = parseCsv(await (await w.fetch(`/api/sites/${site.id}/export/sessions.csv?from=${today}&to=${today}`)).text());
      expect(rows).toHaveLength(3);
      const old = parseCsv(await (await w.fetch(`/api/sites/${site.id}/export/sessions.csv?from=2020-01-01&to=2020-01-31`)).text());
      expect(old).toHaveLength(1);
    });

    it('exports a breakdown panel with ?format=csv', async () => {
      const rows = parseCsv(await (await w.fetch(`/api/sites/${site.id}/breakdown?dim=page&period=today&format=csv`)).text());
      expect(rows[0]).toEqual(['value', 'visitors', 'pageviews', 'revenue', 'currency', 'customers', 'conversion_rate', 'revenue_per_visitor', 'note']);
      expect(rows.find((r) => r[0] === '/pricing')?.[3]).toBe('24.99');
      expect((await w.fetch(`/api/sites/${site.id}/breakdown?dim=nope&period=today&format=csv`)).status).toBe(400);
    });

    it('needs a login', async () => {
      const res = await w.fetch(`/api/sites/${site.id}/export/sessions.csv`, { headers: { cookie: 'rt_auth=nope' } });
      expect(res.status).toBe(401);
    });
  });

  describe('paging', () => {
    it('pages the visitor and customer lists and says when more exist', async () => {
      const p1 = await w.fetch(`/api/sites/${site.id}/visitors?period=today&limit=1`);
      expect(p1.headers.get('x-next-offset')).toBe('1');
      const first = await p1.json<any[]>();
      const p2 = await w.fetch(`/api/sites/${site.id}/visitors?period=today&limit=1&offset=1`);
      expect(p2.headers.get('x-next-offset')).toBeNull();
      const second = await p2.json<any[]>();
      expect([...first, ...second].map((r) => r.visitor_id).sort()).toEqual(['alice-vid-0001', 'bob-vid-00001']);

      const c1 = await w.fetch(`/api/sites/${site.id}/customers?period=today&limit=1`);
      expect(c1.headers.get('x-next-offset')).toBe('1');
      expect(await c1.json()).toHaveLength(1);
      const all = await w.fetch(`/api/sites/${site.id}/customers?period=today`);
      expect(all.headers.get('x-next-offset')).toBeNull();
      expect(await all.json()).toHaveLength(2);
    });
  });

  describe('share links', () => {
    const share = (token: string, path = '') => w.fetch(`/api/share/${token}${path}`, { headers: { cookie: '' } });

    it('creates a link that reads aggregates for its site only, then revokes it', async () => {
      const link = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link', label: 'Launch' } })).body;
      expect(link.token).toMatch(/^\w{32}$/);
      expect(link.show_revenue).toBe(true);

      const info = await (await share(link.token)).json<any>();
      expect(info.site).toEqual({ name: 'Test', domain: 'shop.example.com', timezone: 'UTC', currency: 'USD', app: false });
      expect(JSON.stringify(info)).not.toContain(site.api_key);

      const ov = await (await share(link.token, '/overview?period=today')).json<any>();
      expect(ov.current.visitors).toBe(2);
      expect(ov.current.revenue).toBe(2999 + 1000 - 500);

      const pages = await (await share(link.token, '/breakdown?dim=page&period=today')).json<any[]>();
      expect(pages.map((r) => r.label).sort()).toEqual(['/', '/checkout', '/pricing']);

      // Private views and other routes are out of reach.
      expect((await share(link.token, '/breakdown?dim=goal&period=today')).status).toBe(400);
      expect((await share(link.token, '/breakdown?dim=referrer&period=today')).status).toBe(400);
      expect((await share(link.token, '/visitors')).status).toBe(404);
      expect((await share(link.token, '/customers')).status).toBe(404);
      expect((await w.fetch(`/api/share/${link.token}/overview`, { method: 'POST', headers: { cookie: '' } })).status).toBe(405);
      expect((await w.fetch(`/api/sites/${site.id}/visitors`, { headers: { cookie: '', authorization: `Bearer ${link.token}` } })).status).toBe(401);

      // A filter on a private column is dropped, not applied.
      const filtered = await (await share(link.token, `/overview?period=today&filters=${encodeURIComponent(JSON.stringify({ goal: 'x', page: '/pricing' }))}`)).json<any>();
      expect(filtered.current.visitors).toBe(1);

      expect((await w.admin(`/api/sites/${site.id}/share/${link.token}`, { method: 'DELETE' })).status).toBe(200);
      expect((await share(link.token)).status).toBe(404);
      expect((await share(link.token, '/overview?period=today')).status).toBe(404);
    });

    it('hides revenue, payments and customers when the link says so', async () => {
      const link = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link', show_revenue: false } })).body;
      const ov = await (await share(link.token, '/overview?period=today')).json<any>();
      expect(ov.current.visitors).toBe(2);
      for (const k of ['revenue', 'payments', 'customers', 'conversionRate', 'revenuePerVisitor']) expect(ov.current).not.toHaveProperty(k);
      expect(ov.series[0]).not.toHaveProperty('revenue');
      const rows = await (await share(link.token, '/breakdown?dim=channel&period=today')).json<any[]>();
      expect(rows.every((r) => !('revenue' in r) && !('customers' in r))).toBe(true);
      // The badge falls back to visitors.
      const badge = await (await share(link.token, '/badge.svg?metric=revenue')).text();
      expect(badge).toContain('2 visitors in 30 days');
      expect(badge).not.toContain('revenue');
    });

    it('serves a badge and caches responses, so repeat views read D1 once', async () => {
      const link = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link' } })).body;
      w.takeRowsWritten();
      const res = await share(link.token, '/badge.svg?metric=revenue&period=7d');
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      const svg = await res.text();
      expect(svg).toContain('shop.example.com');
      expect(svg).toContain('$35 revenue in 7 days');

      const a = await share(link.token, '/overview?period=today&junk=1');
      const b = await share(link.token, '/overview?period=today&other=2');
      expect(a.headers.get('x-cache')).toBe('miss');
      expect(b.headers.get('x-cache')).toBe('hit');
      expect(w.takeRowsWritten()).toBe(0);
    });

    it('limits uncached reads per link', async () => {
      const link = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link' } })).body;
      let last = 0;
      for (let i = 0; i <= SHARE_MISSES_PER_MINUTE; i++) {
        last = (await share(link.token, `/breakdown?dim=country&period=today&filters=${encodeURIComponent(JSON.stringify({ city: `c${i}` }))}`)).status;
      }
      expect(last).toBe(429);
    });

    it('expires', async () => {
      const link = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link', expires_days: 1 } })).body;
      expect((await share(link.token)).status).toBe(200);
      await w.db.prepare('UPDATE share_tokens SET expires_at = ? WHERE token = ?').bind(Date.now() - 1, link.token).run();
      resetShareCachesForTests();
      expect((await share(link.token)).status).toBe(404);
    });

    it('lists, edits and validates tokens', async () => {
      const list = (await w.admin(`/api/sites/${site.id}/share`)).body;
      expect(list.length).toBeGreaterThan(0);
      const t = list[0];
      const patched = (await w.admin(`/api/sites/${site.id}/share/${t.token}`, { method: 'PATCH', json: { show_revenue: false, label: 'Press' } })).body;
      expect(patched).toMatchObject({ show_revenue: false, label: 'Press' });
      expect((await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'admin' } })).status).toBe(400);
      expect((await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link', expires_days: -1 } })).status).toBe(400);
    });
  });

  describe('read API', () => {
    const get = (path: string, key: string) => w.fetch(path, { headers: { cookie: '', authorization: `Bearer ${key}` } });

    it('answers 400 naming the list for a period outside it, on every /api/v1 route (shared-9)', async () => {
      const key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', label: 'Periods' } })).body.token;
      for (const p of ['1d', 'banana']) {
        for (const route of ['/api/v1/stats/overview', '/api/v1/stats/breakdown?dim=page&x=1']) {
          const res = await get(`${route}${route.includes('?') ? '&' : '?'}period=${p}`, key);
          expect(res.status).toBe(400);
          expect((await res.json<any>()).error).toMatch(/^period is one of today, yesterday, 24h, 48h, 7d, 30d, 90d, 12m, thisquarter, lastquarter, all/);
        }
      }
      expect((await get('/api/v1/stats/overview?period=7d', key)).status).toBe(200);
      expect((await get('/api/v1/stats/overview?from=2026-01-01&to=2026-01-02', key)).status).toBe(200);
    });

    it('reads overview, breakdown and timeseries with a read key, money in minor units', async () => {
      const key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', label: 'Grafana' } })).body.token;
      expect(key).toMatch(/^rtr_\w{32}$/);

      const ov = await (await get('/api/v1/stats/overview?period=today', key)).json<any>();
      expect(ov).toMatchObject({ site_id: site.id, currency: 'USD', currency_decimals: 2, visitors: 2, revenue: 3499, customers: 2 });
      // The site's first visit was today, so yesterday has nothing to compare with.
      expect(ov.previous).toBeNull();
      expect(ov.previous_reason).toMatch(/Visits are recorded since/);

      const bd = await (await get('/api/v1/stats/breakdown?dim=page&period=today', key)).json<any>();
      expect(bd.dim).toBe('page');
      expect(bd.rows.find((r: any) => r.value === '/pricing')).toMatchObject({ visitors: 1, revenue: 2499 });

      const ts = await (await get('/api/v1/stats/timeseries?period=7d&granularity=day', key)).json<any>();
      expect(ts.granularity).toBe('day');
      expect(ts.points).toHaveLength(7);
      expect(ts.points.at(-1)).toMatchObject({ visitors: 2, revenue: 3499 });

      expect((await get('/api/v1/stats/breakdown?dim=nope', key)).status).toBe(400);
    });

    it('refuses the write key, a share link and no key; the read key cannot write', async () => {
      const link = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'link' } })).body.token;
      const key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api' } })).body.token;
      expect((await get('/api/v1/stats/overview', site.api_key)).status).toBe(401);
      expect((await get('/api/v1/stats/overview', link)).status).toBe(401);
      expect((await w.fetch('/api/v1/stats/overview', { headers: { cookie: '' } })).status).toBe(401);
      const write = await w.fetch('/api/v1/payments', {
        method: 'POST',
        headers: { cookie: '', authorization: `Bearer ${key}` },
        json: { transaction_id: 'x', amount: 1 },
      });
      expect(write.status).toBe(401);
      expect((await get(`/api/sites/${site.id}/overview`, key)).status).toBe(401);
    });

    it('leaves revenue out for a key without revenue', async () => {
      const key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', show_revenue: false } })).body.token;
      const ov = await (await get('/api/v1/stats/overview?period=today', key)).json<any>();
      expect(ov.visitors).toBe(2);
      expect(ov).not.toHaveProperty('revenue');
    });
  });

  describe('erase one person', () => {
    it('erases a visitor, keeps their payments for bookkeeping with the links cleared', async () => {
      const other = await w.createSite({ domain: 'erase.example.com' });
      const s = site;
      site = other;
      await pageview('carol-vid-0001', 'carol-sid-0001', '/');
      await pageview('dave-vid-00001', 'dave-sid-00001', '/');
      await pay('pi_carol', 1500, 'carol-vid-0001', 'carol-sid-0001', { email: 'carol@example.com', name: 'Carol', customer: 'cus_carol' });
      await w.db.prepare('INSERT INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)').bind(site.id, 'pay_x', 'carol-vid-0001', now).run();
      await w.db
        .prepare("INSERT INTO subscription_signals (site_id, id, provider, ts, type, visitor_id, session_id) VALUES (?, 'sig_1', 'revenuecat', ?, 'trial_started', ?, ?)")
        .bind(site.id, now, 'carol-vid-0001', 'carol-sid-0001')
        .run();
      site = s;

      const res = await w.admin(`/api/sites/${other.id}/visitors/carol-vid-0001`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, visitors: 1, sessions: 1, events: 1, claims: 1, signals: 1, payments: 1 });

      const count = async (sql: string) => (await w.db.prepare(sql).bind(other.id).first<{ n: number }>())!.n;
      expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE site_id = ? AND visitor_id = 'carol-vid-0001'")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND visitor_id = 'carol-vid-0001'")).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM sessions WHERE site_id = ?')).toBe(1);
      const p = await w.db.prepare("SELECT * FROM payments WHERE id = 'pi_carol'").first<any>();
      expect(p).toMatchObject({ amount: 1500, visitor_id: null, session_id: null, email: null, name: null, customer_id: null });

      expect((await w.admin(`/api/sites/${other.id}/visitors/carol-vid-0001`, { method: 'DELETE' })).status).toBe(404);
    });

    it('erases by email or user id, including payments that no visit links', async () => {
      await pay('pi_alice_unlinked', 900, null, null, { email: 'Alice@Example.com', name: 'Alice' });
      const res = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: 'ALICE@example.com' } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ visitors: 1, sessions: 1, events: 2 });
      const left = (await w.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE site_id = ? AND (lower(email) = 'alice@example.com' OR visitor_id = 'alice-vid-0001')").bind(site.id).first<{ n: number }>())!.n;
      expect(left).toBe(0);
      const kept = (await w.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE id IN ('pi_alice', 're_alice', 'pi_alice_unlinked')").first<{ n: number }>())!.n;
      expect(kept).toBe(3);

      const byUser = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { user_id: 'u_nobody' } });
      expect(byUser.body).toMatchObject({ visitors: 0 });
      expect((await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: {} })).status).toBe(400);
    });
  });
});

describe('whoami switches (shared-8)', () => {
  it('reports each Pro capture switch with its settings section; a recorded visit catches errors', () => {
    const base = { id: 'abc', record_visits: 1, errors_on: 0, maps_on: 0, surveys: '{"heard_about":{"on":1}}' } as any;
    const sw = captureSwitches(base, 'https://founderdata.example.com');
    expect(sw).toEqual({
      recordings: { on: true, settings_url: 'https://founderdata.example.com/site/abc/settings#record-visits' },
      errors: { on: true, settings_url: 'https://founderdata.example.com/site/abc/settings#catch-errors' },
      click_maps: { on: false, settings_url: 'https://founderdata.example.com/site/abc/settings#click-maps' },
      surveys: { on: true, settings_url: 'https://founderdata.example.com/site/abc/settings#surveys' },
    });
    const off = captureSwitches({ ...base, record_visits: 0, surveys: null }, 'https://x.example');
    expect([off.recordings.on, off.errors.on, off.click_maps.on, off.surveys.on]).toEqual([false, false, false, false]);
  });
});
