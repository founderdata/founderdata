import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientIp, cookielessIds, cookielessVisitorId } from '../src/worker/identity';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const NOON = Date.UTC(2026, 9, 25, 12, 0);

describe('cookieless visitor id', () => {
  it('is stable within a UTC day and unrelated the next day', async () => {
    const a = await cookielessVisitorId('secret', 'site1', '203.0.113.7', UA, NOON);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await cookielessVisitorId('secret', 'site1', '203.0.113.7', UA, NOON + 11 * 3_600_000)).toBe(a);
    expect(await cookielessVisitorId('secret', 'site1', '203.0.113.7', UA, NOON + 12 * 3_600_000)).not.toBe(a);
  });
  it('differs per site, IP, browser and secret', async () => {
    const a = await cookielessVisitorId('secret', 'site1', '203.0.113.7', UA, NOON);
    expect(await cookielessVisitorId('secret', 'site2', '203.0.113.7', UA, NOON)).not.toBe(a);
    expect(await cookielessVisitorId('secret', 'site1', '203.0.113.8', UA, NOON)).not.toBe(a);
    expect(await cookielessVisitorId('secret', 'site1', '203.0.113.7', UA + ' Edg/129', NOON)).not.toBe(a);
    expect(await cookielessVisitorId('other', 'site1', '203.0.113.7', UA, NOON)).not.toBe(a);
  });
  it('takes CF-Connecting-IP, X-Forwarded-For only without it or behind a declared proxy', () => {
    const h = (m: Record<string, string>) => (n: string) => m[n];
    const proxied = { 'x-forwarded-for': '198.51.100.4, 203.0.113.21', 'cf-connecting-ip': '203.0.113.21' };
    // A client can write X-Forwarded-For; on Cloudflare it can't write CF-Connecting-IP.
    expect(clientIp(h(proxied))).toBe('203.0.113.21');
    expect(clientIp(h(proxied), true)).toBe('198.51.100.4');
    expect(clientIp(h({ 'cf-connecting-ip': '198.51.100.9' }), true)).toBe('198.51.100.9');
    expect(clientIp(h({ 'x-forwarded-for': '198.51.100.5' }))).toBe('198.51.100.5');
    expect(clientIp(h({}))).toBe('');
  });
});

describe('cookieless events', () => {
  let w: TestWorker;
  let site: any;
  beforeAll(async () => {
    w = await startWorker();
    // Remember visitors off: these cases test the cookieless answer, which a new Pro website would not give.
    site = await w.createSite({ domain: 'example.net', remember_visitors: 0 });
  });
  afterAll(() => w.dispose());

  const event = (payload: Record<string, unknown>, ip = '198.51.100.20', ua = UA) =>
    w.fetch('/api/event', { method: 'POST', headers: { 'user-agent': ua, 'cf-connecting-ip': ip }, body: JSON.stringify({ w: site.id, ...payload }) });

  it('derives ids, returns them, and continues the session on the next page', async () => {
    const r1 = await event({ t: 'pageview', u: 'https://example.net/?ref=launch', r: '' });
    expect(r1.status).toBe(202);
    const ids = (await r1.json()) as { vid: string; sid: string };
    expect(ids.vid).toMatch(/^[0-9a-f]{32}$/);
    const r2 = await event({ t: 'pageview', u: 'https://example.net/pricing', r: 'https://example.net/' });
    expect(await r2.json()).toEqual(ids);
    const s = await w.db.prepare('SELECT * FROM sessions WHERE id = ?').bind(ids.sid).first<any>();
    expect(s).toMatchObject({ visitor_id: ids.vid, pageviews: 2, ref: 'launch', entry_page: '/', exit_page: '/pricing' });
    // Another device behind the same IP is someone else.
    const r3 = await event({ t: 'pageview', u: 'https://example.net/', r: '' }, '198.51.100.20', UA.replace('Macintosh', 'Windows'));
    expect(((await r3.json()) as any).vid).not.toBe(ids.vid);
    // Explicit ids (cookie mode) still work and get an empty 202.
    const r4 = await event({ t: 'pageview', u: 'https://example.net/', vid: 'cookie-visitor-1', sid: 'cookie-session-1' });
    expect(r4.status).toBe(202);
    expect(await r4.text()).toBe('');
    expect((await event({ t: 'pageview', u: 'https://example.net/', vid: 'cookie-visitor-1' })).status).toBe(400);
  });

  it('starts a new session after 30 minutes without activity', async () => {
    const t0 = Date.now();
    const a = await cookielessIds(w.db, 'test-session-secret', site.id, '192.0.2.1', UA, t0);
    await w.db
      .prepare(`INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel) VALUES (?, ?, ?, ?, ?, 'Direct/None', 'Direct')`)
      .bind(site.id, a.sid, a.vid, t0, t0)
      .run();
    expect((await cookielessIds(w.db, 'test-session-secret', site.id, '192.0.2.1', UA, t0 + 29 * 60_000)).sid).toBe(a.sid);
    const later = await cookielessIds(w.db, 'test-session-secret', site.id, '192.0.2.1', UA, t0 + 31 * 60_000);
    expect(later.vid).toBe(a.vid);
    expect(later.sid).not.toBe(a.sid);
  });
});
