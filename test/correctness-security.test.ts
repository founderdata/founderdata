import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanIconDomain, iconHref, MAX_ICON_BYTES } from '../src/worker/favicon';
import { startWorker, type TestWorker } from './helpers/worker';
import { describePro, itPro } from './helpers/edition';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

async function phone(w: TestWorker, ip: string): Promise<string> {
  const res = await w.fetch('/api/mobile/login', {
    method: 'POST',
    json: { password: w.env.ADMIN_PASSWORD, deviceName: 'Test phone' },
    headers: { cookie: '', 'cf-connecting-ip': ip },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}
const bearer = (token: string) => ({ cookie: '', authorization: `Bearer ${token}` });

// ---------- 1. a phone token only reads

describePro('a device token reads the dashboard API and changes nothing', () => {
  let w: TestWorker;
  let site: any;
  let token: string;
  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'readonly-token.com' });
    token = await phone(w, '10.9.0.1');
  });
  afterAll(() => w.dispose());

  it('reads every dashboard route the cookie reads', async () => {
    for (const path of ['/api/home', '/api/apps', '/api/sites', `/api/sites/${site.id}`, `/api/sites/${site.id}/overview`, `/api/sites/${site.id}/breakdown?dim=channel`]) {
      expect((await w.fetch(path, { headers: bearer(token) })).status, path).toBe(200);
    }
  });

  it('gets 403 on every write outside /api/mobile', async () => {
    const writes: [string, string, unknown?][] = [
      ['PATCH', `/api/sites/${site.id}`, { name: 'Taken over' }],
      ['DELETE', `/api/sites/${site.id}`],
      ['POST', `/api/sites/${site.id}/rotate-key`],
      ['POST', '/api/sites', { domain: 'new-from-phone.com' }],
      ['PUT', `/api/sites/${site.id}/seo/meta`, {}],
      ['POST', `/api/sites/${site.id}/funnels`, { name: 'f', steps: [{ type: 'page', value: '/' }, { type: 'page', value: '/a' }] }],
      ['POST', `/api/sites/${site.id}/rematch`],
      ['POST', '/api/appstore/backfill', { from: '2026-10-01', to: '2026-10-02' }],
      // The dashboard's mail routes, whatever the method. A phone's mail actions live under /api/mobile/mail (Pro).
      ['POST', '/api/mail-admin/threads/x/reply', { text: 'x' }],
      ['POST', '/api/mail-admin/send', { to: 'x@example.net', text: 'x' }],
    ];
    for (const [method, path, json] of writes) {
      const res = await w.fetch(path, { method, json, headers: bearer(token) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const row = await w.db.prepare('SELECT name, api_key FROM sites WHERE id = ?').bind(site.id).first<any>();
    expect(row).toEqual({ name: site.name, api_key: site.api_key });
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM sites').first<any>()).n).toBe(1);
  });

  it('keeps every /api/mobile route the iPhone app calls', async () => {
    expect((await w.fetch('/api/mobile/summary', { headers: bearer(token) })).status).toBe(200);
    expect((await w.fetch('/api/mobile/devices', { headers: bearer(token) })).status).toBe(200);
    expect((await w.fetch('/api/mobile/notifications', { headers: bearer(token) })).status).toBe(200);
    const put = await w.fetch('/api/mobile/notifications', { method: 'PUT', json: { events: { refund: true } }, headers: bearer(token) });
    expect(put.status).toBe(200);
    const push = await w.fetch('/api/mobile/push', {
      method: 'PUT',
      json: { token: 'ab'.repeat(32), environment: 'sandbox', topic: 'com.example.founderdata' },
      headers: bearer(token),
    });
    expect(push.status).toBe(200);
  });

  it('leaves the cookie a full admin', async () => {
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: { name: 'Renamed' } })).status).toBe(200);
    expect((await w.admin(`/api/sites/${site.id}/rotate-key`, { method: 'POST' })).status).toBe(200);
  });
});

// ---------- 2. a new password signs everyone out

describe('a write signed in by cookie must come from the dashboard origin', () => {
  let w: TestWorker;
  let site: any;
  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'csrf-check.com' });
  });
  afterAll(() => w.dispose());

  it('refuses a write from a sibling subdomain, even as text/plain', async () => {
    const res = await w.fetch(`/api/sites/${site.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Taken over' }),
      headers: { 'content-type': 'text/plain', origin: 'https://www.csrf-check.com', 'sec-fetch-site': 'same-site' },
    });
    expect(res.status).toBe(403);
    expect((await w.admin(`/api/sites/${site.id}`)).body.name).not.toBe('Taken over');
    const del = await w.fetch(`/api/sites/${site.id}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(del.status).toBe(403);
  });

  it('accepts the same write from the dashboard, and reads from anywhere', async () => {
    const res = await w.fetch(`/api/sites/${site.id}`, {
      method: 'PATCH',
      json: { name: 'Renamed' },
      headers: { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    expect((await w.fetch(`/api/sites/${site.id}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
  });
});

describe('changing ADMIN_PASSWORD signs out every browser and phone', () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker();
  });
  afterAll(() => w.dispose());

  const loginCookie = async () => {
    const res = await w.fetch('/api/auth/login', { method: 'POST', json: { password: w.env.ADMIN_PASSWORD }, headers: { cookie: '' } });
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const me = async (cookie: string) => ((await (await w.fetch('/api/auth/me', { headers: { cookie } })).json()) as any).loggedIn;

  itPro('rejects the old cookie and the old device token, and accepts new ones', async () => {
    const cookie = await loginCookie();
    const token = await phone(w, '10.9.1.1');
    await w.fetch('/api/mobile/push', { method: 'PUT', json: { token: 'cd'.repeat(32), environment: 'sandbox', topic: 'com.example.founderdata' }, headers: bearer(token) });
    expect(await me(cookie)).toBe(true);
    expect((await w.fetch('/api/home', { headers: bearer(token) })).status).toBe(200);

    w.env.ADMIN_PASSWORD = 'a-new-password';
    expect(await me(cookie)).toBe(false);
    expect((await w.fetch('/api/home', { headers: { cookie } })).status).toBe(401);
    expect((await w.fetch('/api/home', { headers: bearer(token) })).status).toBe(401);
    expect((await w.fetch('/api/mobile/summary', { headers: bearer(token) })).status).toBe(401);

    // The old phone still has a row and a push token until the next sign-in revokes it.
    const before = await w.db.prepare('SELECT revoked_at, apns_token FROM devices').first<any>();
    expect(before.revoked_at).toBeNull();
    const fresh = await loginCookie();
    expect(await me(fresh)).toBe(true);
    const after = await w.db.prepare('SELECT revoked_at, apns_token FROM devices ORDER BY created_at LIMIT 1').first<any>();
    expect(after.revoked_at).not.toBeNull();
    expect(after.apns_token).toBeNull();
    const list = (await (await w.fetch('/api/mobile/devices', { headers: { cookie: fresh } })).json()) as any;
    expect(list.devices).toEqual([]);

    const newToken = await phone(w, '10.9.1.2');
    expect((await w.fetch('/api/home', { headers: bearer(newToken) })).status).toBe(200);
  });

  itPro('a new SESSION_SECRET signs everyone out too', async () => {
    const cookie = await loginCookie();
    const token = await phone(w, '10.9.1.3');
    w.env.SESSION_SECRET = 'another-session-secret';
    expect(await me(cookie)).toBe(false);
    expect((await w.fetch('/api/home', { headers: bearer(token) })).status).toBe(401);
  });

  itPro('a wrong password revokes nothing', async () => {
    const token = await phone(w, '10.9.1.4');
    const res = await w.fetch('/api/auth/login', { method: 'POST', json: { password: 'nope' }, headers: { cookie: '', 'cf-connecting-ip': '10.9.1.5' } });
    expect(res.status).toBe(401);
    expect((await w.fetch('/api/home', { headers: bearer(token) })).status).toBe(200);
  });
});

// ---------- 3. the visitor IP comes from Cloudflare

describe('cookieless ids use CF-Connecting-IP, not a client-set X-Forwarded-For', () => {
  const event = (w: TestWorker, site: any, headers: Record<string, string>) =>
    w
      .fetch('/api/event', {
        method: 'POST',
        headers: { 'user-agent': UA, 'cf-connecting-ip': '203.0.113.50', ...headers },
        body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://${site.domain}/` }),
      })
      .then((r) => r.json() as Promise<{ vid: string }>);

  it('ignores X-Forwarded-For by default', async () => {
    const w = await startWorker();
    const site = await w.createSite({ domain: 'xff-default.com' });
    const plain = await event(w, site, {});
    const spoofed = await event(w, site, { 'x-forwarded-for': '198.51.100.77' });
    const spoofed2 = await event(w, site, { 'x-forwarded-for': '198.51.100.78' });
    expect(spoofed.vid).toBe(plain.vid);
    expect(spoofed2.vid).toBe(plain.vid);
    await w.dispose();
  });

  it('uses X-Forwarded-For behind a declared proxy (TRUST_FORWARDED_FOR)', async () => {
    const w = await startWorker({ TRUST_FORWARDED_FOR: '1' });
    const site = await w.createSite({ domain: 'xff-proxy.com' });
    const a = await event(w, site, { 'x-forwarded-for': '198.51.100.77' });
    const b = await event(w, site, { 'x-forwarded-for': '198.51.100.78' });
    expect(a.vid).not.toBe(b.vid);
    await w.dispose();
  });
});

// ---------- 6. one meaning of customers, and the site kind

describe('customers are new customers in every panel', () => {
  let w: TestWorker;
  let site: any;
  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'customers-def.com' });
    for (const [vid, sid] of [
      ['cust-v1-0000000000', 'cust-s1-0000000000'],
      ['cust-v2-0000000000', 'cust-s2-0000000000'],
    ]) {
      await w.fetch('/api/event', {
        method: 'POST',
        headers: { 'user-agent': UA },
        body: JSON.stringify({ w: site.id, t: 'pageview', u: `https://${site.domain}/pricing`, r: 'https://www.google.com/', vid, sid }),
      });
    }
    const pay = (id: string, vid: string, sid: string, renewal: number) =>
      w.db
        .prepare(
          `INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, renewal)
           VALUES (?, ?, 'stripe', ?, 1000, 'payment', 'USD', ?, ?, ?)`,
        )
        .bind(id, site.id, Date.now(), vid, sid, renewal)
        .run();
    await pay('cust_new', 'cust-v1-0000000000', 'cust-s1-0000000000', 0);
    // A renewal: revenue, not a customer.
    await pay('cust_renewal', 'cust-v2-0000000000', 'cust-s2-0000000000', 1);
  });
  afterAll(() => w.dispose());

  it('counts the same customers on the overview, the source panels, the page panel and the home page', async () => {
    const overview = (await w.admin(`/api/sites/${site.id}/overview?period=today`)).body;
    expect(overview.current.customers).toBe(1);
    expect(overview.current.revenue).toBe(2000);
    for (const dim of ['channel', 'source']) {
      const rows = (await w.admin(`/api/sites/${site.id}/breakdown?period=today&dim=${dim}`)).body;
      expect(rows.reduce((n: number, r: any) => n + r.customers, 0), dim).toBe(1);
      expect(rows.reduce((n: number, r: any) => n + r.revenue, 0), dim).toBe(2000);
    }
    const pages = (await w.admin(`/api/sites/${site.id}/breakdown?period=today&dim=page`)).body;
    expect(pages.find((r: any) => r.label === '/pricing').customers).toBe(1);
    const home = (await w.admin('/api/home?period=today')).body;
    expect(home.sources.find((s: any) => s.label === 'Google').customers).toBe(1);
    expect(home.totals.current.customers).toBe(1);
  });

  it('tells web, app-only and web-and-app sites apart on the overview', async () => {
    expect((await w.admin(`/api/sites/${site.id}/overview?period=today`)).body.kind).toBe('web');
    const app = await w.createSite({ domain: 'kind-app.invalid', app_bundle_id: 'com.example.kindapp' });
    expect((await w.admin(`/api/sites/${app.id}/overview?period=today`)).body.kind).toBe('app');
    const both = await w.createSite({ domain: 'kind-both.com', app_bundle_id: 'com.example.kindboth' });
    await w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA },
      body: JSON.stringify({ w: both.id, t: 'pageview', u: 'https://kind-both.com/', vid: 'kind-v-000000000000', sid: 'kind-s-000000000000' }),
    });
    expect((await w.admin(`/api/sites/${both.id}/overview?period=today`)).body.kind).toBe('both');
  });
});

// ---------- 8. site icons through the Worker

describe('GET /api/favicon/:domain', () => {
  let w: TestWorker;
  let realFetch: typeof fetch;
  const fetched: string[] = [];
  const store = new Map<string, Response>();
  const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);

  beforeAll(async () => {
    w = await startWorker();
    // After startWorker: the platform proxy replaces globalThis.fetch while it starts.
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      switch (url) {
        case 'https://icon-ok.com/favicon.ico':
          return new Response(ICO, { headers: { 'content-type': 'image/x-icon' } });
        case 'https://link-only.com/':
          return new Response('<html><head><link rel="stylesheet" href="/a.css"><link rel="shortcut icon" href="/static/i.png?v=2"></head>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        case 'https://link-only.com/static/i.png?v=2':
          return new Response(ICO, { headers: { 'content-type': 'image/png' } });
        case 'https://huge-icon.com/favicon.ico':
          return new Response(new Uint8Array(MAX_ICON_BYTES + 1), { headers: { 'content-type': 'image/png' } });
        case 'https://html-icon.com/favicon.ico':
          return new Response('<html>not an icon</html>', { headers: { 'content-type': 'text/html' } });
        default:
          return new Response('not found', { status: 404 });
      }
    }) as typeof fetch;
    (globalThis as any).caches = {
      default: {
        match: async (req: Request) => store.get(req.url)?.clone(),
        put: async (req: Request, res: Response) => void store.set(req.url, res),
      },
    };
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete (globalThis as any).caches;
    await w.dispose();
  });

  it('needs a login', async () => {
    expect((await w.fetch('/api/favicon/icon-ok.com', { headers: { cookie: '' } })).status).toBe(401);
  });

  it("serves the site's /favicon.ico, caches it and writes no D1 row", async () => {
    w.takeRowsWritten();
    const res = await w.fetch('/api/favicon/icon-ok.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/x-icon');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ICO);
    expect(res.headers.get('cache-control')).toBe('private, max-age=604800');
    await w.flush();
    const calls = fetched.length;
    const again = await w.fetch('/api/favicon/icon-ok.com');
    expect(again.status).toBe(200);
    expect(fetched.length).toBe(calls);
    expect(store.get('https://favicon.founderdata.internal/icon-ok.com')?.headers.get('cache-control')).toBe('public, max-age=604800');
    expect(w.takeRowsWritten()).toBe(0);
  });

  it('falls back to the first icon link on the home page', async () => {
    const res = await w.fetch('/api/favicon/link-only.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(fetched).toContain('https://link-only.com/static/i.png?v=2');
  });

  it('answers 404 for no icon, a too large one or a non-image, and caches the miss for a day', async () => {
    for (const d of ['no-icon.com', 'huge-icon.com', 'html-icon.com']) {
      expect((await w.fetch(`/api/favicon/${d}`)).status, d).toBe(404);
    }
    await w.flush();
    expect(store.get('https://favicon.founderdata.internal/no-icon.com')?.headers.get('cache-control')).toBe('public, max-age=86400');
    const calls = fetched.length;
    expect((await w.fetch('/api/favicon/no-icon.com')).status).toBe(404);
    expect(fetched.length).toBe(calls);
  });

  it('refuses anything that is not a public host name, without fetching', async () => {
    const calls = fetched.length;
    for (const d of ['localhost', '127.0.0.1', 'habitly.invalid', 'a..b.com', 'exa mple.com', 'x.internal']) {
      expect((await w.fetch(`/api/favicon/${encodeURIComponent(d)}`)).status, d).toBe(404);
    }
    expect(fetched.length).toBe(calls);
  });

  it('cleans domains and finds icon links', () => {
    expect(cleanIconDomain('Example.COM')).toBe('example.com');
    expect(cleanIconDomain('10.0.0.1')).toBeNull();
    expect(cleanIconDomain('demo.test')).toBeNull();
    expect(iconHref('<link href="/i.svg" rel="icon" type="image/svg+xml">')).toBe('/i.svg');
    expect(iconHref("<link rel='apple-touch-icon' href='/t.png'>")).toBe('/t.png');
    expect(iconHref('<link rel="stylesheet" href="/a.css">')).toBeNull();
  });
});
