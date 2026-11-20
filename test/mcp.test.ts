// The MCP server (src/worker/mcp.ts, docs/MCP.md) and the OpenAPI spec (public/openapi.json): the handshake in both
// protocol eras, the tool list, that a tool answers what its /api/v1 route answers, auth, and JSON-RPC error shapes.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/worker/index';
import { fit, tools } from '../src/worker/mcp';
import { resetShareCachesForTests } from '../src/worker/share';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const MODERN = '2026-07-28';

describe('MCP server', () => {
  let w: TestWorker;
  let site: any;
  let key: string;
  let hidden: string;
  let n = 0;

  const post = (body: unknown, headers: Record<string, string> = {}, k: string | null = key) =>
    w.fetch('/mcp', {
      method: 'POST',
      headers: {
        cookie: '',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(k ? { authorization: `Bearer ${k}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const rpc = async (method: string, params: unknown = {}, headers: Record<string, string> = {}, k: string | null = key) => {
    const res = await post({ jsonrpc: '2.0', id: ++n, method, params }, headers, k);
    return { status: res.status, body: await res.json<any>() };
  };
  const call = async (name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}, k: string | null = key) => {
    const r = await rpc('tools/call', { name, arguments: args }, headers, k);
    expect(r.status).toBe(200);
    return r.body.result;
  };
  const route = async (p: string, k = key) => (await w.fetch(p, { headers: { cookie: '', authorization: `Bearer ${k}` } })).json<any>();

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'shop.example.com' });
    for (const [vid, page, ref] of [
      ['alice-vid-0001', '/blog/launch', 'https://news.ycombinator.com/item?id=1'],
      ['bob-vid-00001', '/blog/pricing', ''],
      ['carol-vid-0001', '/', ''],
    ]) {
      await w.fetch('/api/event', {
        method: 'POST',
        headers: { 'user-agent': UA },
        body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://shop.example.com${page}`, r: ref, vid, sid: vid.replace('vid', 'sid') }),
      });
    }
    await w.flush();
    await w.db
      .prepare(
        'INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, email, name, matched_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('pi_alice', site.id, 'stripe', Date.now(), 4900, 'payment', 'USD', 'alice-vid-0001', 'alice-sid-0001', 'alice@example.com', 'Alice', 'metadata')
      .run();
    key = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api' } })).body.token;
    hidden = (await w.admin(`/api/sites/${site.id}/share`, { method: 'POST', json: { kind: 'api', show_revenue: false } })).body.token;
  });
  afterAll(() => w?.dispose());
  beforeEach(() => resetShareCachesForTests());

  describe('handshake', () => {
    it('negotiates a legacy version on initialize', async () => {
      for (const v of ['2025-03-26', '2025-06-18', '2025-11-25']) {
        const r = await rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ jsonrpc: '2.0', id: n, result: { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'founderdata' } } });
        expect(r.body.result.instructions).toMatch(/minor units/);
      }
      // A version the server does not know gets the newest legacy one; the client decides.
      expect((await rpc('initialize', { protocolVersion: '2099-01-01', capabilities: {} })).body.result.protocolVersion).toBe('2025-11-25');
    });

    it('answers a notification with 202 and no body, and ping with {}', async () => {
      const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(res.status).toBe(202);
      expect(await res.text()).toBe('');
      expect((await rpc('ping')).body.result).toEqual({});
    });

    it('serves the modern, stateless protocol with its headers', async () => {
      const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} } };
      const h = (method: string, name?: string) => ({ 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) });
      const list = await rpc('tools/list', meta, h('tools/list'));
      expect(list.status).toBe(200);
      expect(list.body.result).toMatchObject({ resultType: 'complete', cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'founderdata' } } });
      expect(list.body.result.ttlMs).toBeGreaterThan(0);
      const discover = await rpc('server/discover', meta, h('server/discover'));
      expect(discover.body.result.supportedVersions).toEqual(expect.arrayContaining([MODERN, '2025-06-18', '2025-03-26']));
      const called = await rpc('tools/call', { name: 'get_overview', arguments: { period: 'today' }, ...meta }, h('tools/call', 'get_overview'));
      expect(called.body.result.resultType).toBe('complete');
      expect(called.body.result.structuredContent.visitors).toBe(3);
      // The base64 sentinel form of Mcp-Name is decoded before the comparison.
      const encoded = `=?base64?${btoa('get_definitions')}?=`;
      expect((await rpc('tools/call', { name: 'get_definitions', ...meta }, h('tools/call', encoded))).status).toBe(200);

      const noMethod = await rpc('tools/list', meta, { 'mcp-protocol-version': MODERN });
      expect(noMethod.status).toBe(400);
      expect(noMethod.body.error.code).toBe(-32020);
      const wrongName = await rpc('tools/call', { name: 'get_overview', ...meta }, h('tools/call', 'get_seo'));
      expect(wrongName.status).toBe(400);
      expect(wrongName.body.error.code).toBe(-32020);
      const old = await rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } }, h('tools/list'));
      expect(old.status).toBe(400);
      expect(old.body.error).toMatchObject({ code: -32022, data: { requested: '1900-01-01' } });
      expect(old.body.error.data.supported).toContain(MODERN);
      const missing = await rpc('resources/list', meta, h('resources/list'));
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe(-32601);
    });
  });

  describe('tools', () => {
    itPro('lists every tool with a description and an input schema', async () => {
      const { tools } = (await rpc('tools/list')).body.result;
      const names = tools.map((t: any) => t.name);
      expect(names).toEqual([
        'whoami', 'get_definitions', 'query', 'dashboards', 'get_overview', 'get_breakdown', 'get_timeseries', 'get_content', 'get_customers', 'get_people', 'get_recordings', 'get_subscriptions',
        'get_apple_search_ads', 'get_meta_ads', 'get_paid', 'get_app_funnel', 'get_app_store_sales', 'get_email', 'get_seo', 'get_aso', 'list_notes', 'get_note_impact',
        'get_weekly_report', 'get_portfolio', 'add_note', 'review_change', 'get_web_vitals', 'alert_rules',
        'list_research', 'add_research', 'get_plan', 'update_plan', 'update_tasks', 'log_session', 'add_plan_review', 'research_keywords', 'get_ai_answers',
        'add_ai_prompts', 'mail',
      ]);
      for (const t of tools) {
        expect(t.description.length, t.name).toBeGreaterThan(80);
        expect(t.inputSchema.type, t.name).toBe('object');
        expect(t.annotations.readOnlyHint, t.name).toBe(!['add_note', 'review_change', 'add_research', 'research_keywords', 'add_ai_prompts', 'alert_rules', 'mail', 'dashboards', 'update_plan', 'update_tasks', 'log_session', 'add_plan_review'].includes(t.name));
        expect(t.outputSchema.type, t.name).toBe('object');
      }
      expect(tools.find((t: any) => t.name === 'get_breakdown').inputSchema.required).toEqual(['dim']);
    });

    it('get_overview answers the same numbers as /api/v1/stats/overview', async () => {
      const result = await call('get_overview', { period: 'today' });
      const direct = await route('/api/v1/stats/overview?period=today');
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(direct);
      expect(JSON.parse(result.content[0].text)).toEqual(direct);
      expect(direct).toMatchObject({ visitors: 3, revenue: 4900, customers: 1 });
      // A custom range and filters reach the route as query parameters.
      const day = new Date().toISOString().slice(0, 10);
      const filtered = await call('get_overview', { from: day, to: day, filters: { entry_page: '/blog/launch' } });
      expect(filtered.structuredContent).toEqual(
        await route(`/api/v1/stats/overview?from=${day}&to=${day}&filters=${encodeURIComponent('{"entry_page":"/blog/launch"}')}`),
      );
    });

    itPro('get_breakdown, get_content and get_customers match their routes', async () => {
      expect((await call('get_breakdown', { dim: 'entry_page', period: 'today' })).structuredContent).toEqual(
        await route('/api/v1/stats/breakdown?dim=entry_page&period=today'),
      );
      const content = (await call('get_content', { prefix: '/blog/', period: 'today' })).structuredContent;
      expect(content.rows.map((r: any) => r.page)).toEqual(['/blog/launch', '/blog/pricing']);
      const customers = (await call('get_customers', { period: 'today' })).structuredContent;
      expect(customers.next_offset).toBeNull();
      expect(customers.rows).toHaveLength(1);
      expect(customers.rows[0]).toMatchObject({ amount: 4900, email: null, name: null });
    });

    itPro('reports a route refusal or a bad argument as a tool error the model can read', async () => {
      const blocked = await call('get_subscriptions', {}, {}, hidden);
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0].text).toMatch(/403.*hides revenue/);
      const bad = await call('get_breakdown', { dim: 'shoe_size' });
      expect(bad).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/dim is one of/) }] });
      expect((await call('get_overview', { from: '2026/01/01' })).isError).toBe(true);
      expect((await call('get_portfolio')).content[0].text).toMatch(/403|404/);
    });

    itPro('an all-sites key reads the portfolio, and one site with the site argument', async () => {
      const all = (await w.admin('/api/read-keys', { method: 'POST', json: { label: 'MCP' } })).body.token as string;
      const portfolio = await call('get_portfolio', { period: '7d' }, {}, all);
      expect(portfolio.isError).toBeUndefined();
      expect(portfolio.structuredContent).toEqual(await route('/api/v1/portfolio?period=7d', all));
      expect(portfolio.structuredContent.sites.map((s: any) => s.id)).toContain(site.id);
      const one = await call('get_overview', { period: 'today', site: site.id }, {}, all);
      expect(one.structuredContent).toMatchObject({ site_id: site.id, visitors: 3 });
      const none = await call('get_overview', { period: 'today' }, {}, all);
      expect(none).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/site argument.*whoami/) }] });
    });

    itPro('add_note needs the API key header; then the note is listed and measurable', async () => {
      const noKey = await call('add_note', { text: 'Raised Pro to $24' });
      expect(noKey.isError).toBe(true);
      expect(noKey.content[0].text).toMatch(/notes:write/);
      const added = await call(
        'add_note',
        { text: 'Raised Pro to $24', kind: 'pricing', actor: 'claude', before: '$19', after: '$24', idempotency_key: 'mcp-test-1' },
        { 'x-founderdata-api-key': site.api_key },
      );
      expect(added.isError).toBeUndefined();
      expect(added.structuredContent).toMatchObject({ ok: true });
      const id = added.structuredContent.id;
      const notes = (await call('list_notes', { period: 'today', actor: 'claude' })).structuredContent.rows;
      expect(notes.map((x: any) => x.id)).toEqual([id]);
      const impact = await call('get_note_impact', { id, window: 7 });
      expect(impact.isError).toBeUndefined();
      expect(impact.structuredContent).toEqual(await route(`/api/v1/notes/${id}/impact?window=7`));
    });

    itPro('get_seo sums a window of the snapshot instead of returning every row', async () => {
      const days = Array.from({ length: 56 }, (_, i) => new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10));
      const last = days[days.length - 1];
      await w.admin(`/api/sites/${site.id}/seo/meta`, { method: 'PUT', json: { domain: 'shop.example.com', gscThrough: last, targets: [{ term: 'analytics' }] } });
      await w.admin(`/api/sites/${site.id}/seo/gsc_daily`, { method: 'PUT', json: days.map((d) => [d, 10, 100, 5]) });
      await w.admin(`/api/sites/${site.id}/seo/gsc_queries`, {
        method: 'PUT',
        json: days.flatMap((d) => [[d, 'analytics', 6, 50, 3], [d, 'founder data', 4, 50, 9]]),
      });
      const s = (await call('get_seo', { days: 7 })).structuredContent;
      expect(s).toMatchObject({ to: last, days: 7, totals: { clicks: 70, impressions: 700, ctr: 0.1, position: 5 }, previous: { clicks: 70 } });
      expect(s.top_queries[0]).toMatchObject({ query: 'analytics', clicks: 42, position: 3, previous_clicks: 42 });
      expect(s.top_queries[1]).toMatchObject({ query: 'founder data', position: 9 });
      const q = (await call('get_seo', { view: 'queries', days: 28, limit: 1 })).structuredContent;
      expect(q).toMatchObject({ total_rows: 2, rows: [{ query: 'analytics', clicks: 168 }] });
      const opp = await call('get_seo', { view: 'opportunities', days: 28 });
      expect(opp.structuredContent).toEqual(await route('/api/v1/seo/opportunities?days=28'));
      expect((await call('get_seo', { view: 'opportunities', days: 30 })).isError).toBe(true);
    });

    it('cuts a large answer and says what is missing', () => {
      const big = { site_id: 'x', rows: Array.from({ length: 5000 }, (_, i) => ({ page: `/p/${i}`, visitors: i })) };
      const { value, text } = fit(big, 10_000, 'Lower the limit.');
      expect(text.length).toBeLessThan(10_000);
      expect((value as any).rows.length).toBeLessThan(5000);
      expect((value as any).trimmed).toMatch(/rows kept \d+ of 5000.*Lower the limit/);
      expect(fit({ a: 1 }).text).toBe('{"a":1}');
    });
  });

  describe('auth and JSON-RPC errors', () => {
    it('answers 401 without a key, with a wrong key and with the write key', async () => {
      for (const k of [null, 'rtr_doesnotexist000000', site.api_key]) {
        const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}, k);
        expect(res.status, String(k)).toBe(401);
        expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
        expect((await res.json<any>()).error.message).toMatch(/rtr_/);
      }
      // A logged-in dashboard cookie is not a key.
      const withCookie = await w.fetch('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(withCookie.status).toBe(401);
    });

    it('uses the JSON-RPC error codes', async () => {
      const unknownTool = await rpc('tools/call', { name: 'drop_tables', arguments: {} });
      expect(unknownTool.body).toMatchObject({ jsonrpc: '2.0', id: n, error: { code: -32602, message: expect.stringMatching(/Unknown tool/) } });
      const unknownMethod = await rpc('resources/list');
      expect(unknownMethod.body).toMatchObject({ id: n, error: { code: -32601 } });
      expect(unknownMethod.body.result).toBeUndefined();

      const parse = await post('{"jsonrpc": "2.0", "id": 1, "method": ');
      expect(parse.status).toBe(400);
      expect(await parse.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
      const invalid = await post({ id: 3, method: 'tools/list' });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ id: 3, error: { code: -32600 } });
      const badVersion = await rpc('tools/list', {}, { 'mcp-protocol-version': '1999-01-01' });
      expect(badVersion.status).toBe(400);

      // A batch (2025-03-26) gets an array of answers; its notifications get none.
      const batch = await post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'nope' }]);
      expect(await batch.json()).toMatchObject([{ id: 'a', result: {} }, { id: 'b', error: { code: -32601 } }]);

      const get = await w.fetch('/mcp', { headers: { cookie: '', authorization: `Bearer ${key}`, accept: 'text/event-stream' } });
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      const foreign = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
    });
  });
});

describe('OpenAPI spec', () => {
  const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public/openapi.json'), 'utf8'));

  it('is OpenAPI 3.1 with the scoped key and both older key schemes', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(['apiKey', 'readKey', 'scopedKey']);
  });

  itPro('lists every /api/v1 route the worker mounts', () => {
    const mounted = new Set<string>();
    for (const r of app.routes) {
      if (!r.path.startsWith('/api/v1/') || r.method === 'ALL' || r.path === '/api/v1/openapi.json') continue;
      mounted.add(`${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`);
    }
    expect(mounted.size).toBeGreaterThan(20);
    // The spec also documents a few owner-login dashboard routes (/api/setup); only /api/v1 is the mounted agent API.
    const documented = new Set(Object.entries(spec.paths).filter(([p]) => p.startsWith('/api/v1/')).flatMap(([p, ops]) => Object.keys(ops as object).filter((m) => m !== 'parameters').map((m) => `${m} ${p}`)));
    expect([...mounted].filter((r) => !documented.has(r))).toEqual([]);
    // And nothing documented that is not mounted.
    expect([...documented].filter((r) => !mounted.has(r))).toEqual([]);
  });

  it('documents a response for every operation and every MCP tool route', () => {
    for (const [p, ops] of Object.entries<any>(spec.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        if (m === 'parameters') continue;
        expect(op.responses?.['200'] ?? op.responses?.['202'], `${m} ${p}`).toBeDefined();
        expect(op.operationId, `${m} ${p}`).toBeTruthy();
      }
    }
    // The budget is characters (pro/test/agent-access.test.ts); the count stays under the soft guide: 32 analytics tools
    // (get_recordings the newest), FounderData Pro's mail and dashboards, and the plan's five tools.
    expect(tools().length).toBeLessThanOrEqual(39);
  });
});
