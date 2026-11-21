// Round 7, lane errors, core part (plan 5.5): the fingerprint that groups an error's variants into one issue, the scrub
// of personal data, the errors rows a ping writes (0, 1 per distinct error, at most 5), errors without recording,
// retention, erase, export and the tracker's stack frames (`k`).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetBudgetForTests } from '../src/worker/budget';
import { forgetSite } from '../src/worker/env';
import { cleanMessage, ERRORS_DAYS, errorsConfig, fileKey, fingerprint, normalizeMessage, pageErrors, parseFrames, scrub } from '../src/worker/errors';
import { pruneOldData } from '../src/worker/retention';
import { startWorker, type TestWorker } from './helpers/worker';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const DAY = 86_400_000;

describe('errors: fingerprint', () => {
  const frame = 'https://shop.example/assets/index-B3kZ9a1x.js:120:14 handleCheckout';
  it('groups variants that differ in numbers, ids, URLs and quoted text', () => {
    const a = fingerprint("TypeError: Cannot read properties of undefined (reading 'priceId') for plan 42", null, frame);
    const b = fingerprint("Uncaught TypeError: Cannot read properties of undefined (reading 'planId') for plan 7", null, frame);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(b).toBe(a);
    expect(fingerprint('Failed to load https://cdn.example/a.png?x=1 (id 3f9a2b1c4d)', 'https://shop.example/app.js:3', null)).toBe(
      fingerprint('Failed to load https://cdn.example/b.png (id 99aa00bb11)', 'https://shop.example/app.js:9', null),
    );
    expect(normalizeMessage('User 550e8400-e29b-41d4-a716-446655440000 at 0xdeadbeef1 took 12.5 ms "x"')).toBe('User <id> at <id> took <n> ms <str>');
  });

  it('keeps one issue across deploys that rename the bundle, and splits different functions and files', () => {
    const m = 'TypeError: x is undefined';
    expect(fingerprint(m, null, frame)).toBe(fingerprint(m, null, 'https://shop.example/assets/index-Q9w8E7r6.js:131:2 handleCheckout'));
    expect(fingerprint(m, null, frame)).not.toBe(fingerprint(m, null, 'https://shop.example/assets/index-B3kZ9a1x.js:120:14 renderCart'));
    expect(fingerprint(m, 'https://shop.example/a.js:1', null)).not.toBe(fingerprint(m, 'https://shop.example/b.js:1', null));
    expect(fingerprint('Script error.', null, null)).toBe(fingerprint('Script error.', '', null));
    expect(fileKey('https://shop.example/static/js/main.3f9a2b1c.chunk.js?v=2:4')).toBe('/static/js/main.chunk.js');
    expect(fileKey('https://shop.example/js/react-dom.production.min.js')).toBe('/js/react-dom.production.min.js');
  });

  it('parses at most 3 frames and drops their queries', () => {
    expect(parseFrames('https://a.example/x.js?v=3:10:5 load\nhttps://a.example/y.js:2:1\nnot a frame\nz.js:1:1 a\nw.js:9:9 b')).toEqual([
      { file: 'https://a.example/x.js', line: 10, col: 5, fn: 'load' },
      { file: 'https://a.example/y.js', line: 2, col: 1, fn: null },
      { file: 'z.js', line: 1, col: 1, fn: 'a' },
    ]);
    expect(parseFrames(42)).toEqual([]);
  });
});

describe('errors: scrub', () => {
  it('removes emails, phone numbers and runs of 6 or more digits, keeps line numbers and short numbers', () => {
    expect(scrub('No account for anna@example.com')).toBe('No account for [removed]');
    expect(scrub('Call +1 (415) 555-0134 now')).toBe('Call [removed] now');
    expect(scrub('Order 12345678 failed after 1500 ms at 12:5')).toBe('Order [removed] failed after 1500 ms at 12:5');
    expect(cleanMessage('Uncaught (in promise) Error:   card\n4242424242424242 declined')).toBe('Error: card [removed] declined');
    expect(cleanMessage('x'.repeat(300))).toHaveLength(200);
  });

  it('places each error at the page start plus its offset, and groups repeats', () => {
    const now = Date.now();
    const page = pageErrors(
      {
        p: '/checkout/?step=2',
        s: now - 5000,
        e: [
          { t: 1000, m: 'TypeError: a is 1', s: 'https://a.example/app.js?v=1:3' },
          { t: 2000, m: 'TypeError: a is 2', s: 'https://a.example/app.js:3' },
          { t: 3000, m: 'RangeError: too deep', s: '' },
          { t: 9e9, m: 'Late', s: '' },
          { m: '' },
        ],
      },
      now,
    );
    expect(page.path).toBe('/checkout');
    expect(page.errors.map((e) => [e.message, e.source, e.n, e.ts])).toEqual([
      ['TypeError: a is 1', 'https://a.example/app.js:3', 2, now - 4000],
      ['RangeError: too deep', null, 1, now - 2000],
      ['Late', null, 1, now],
    ]);
  });

  it('turns on with Catch JavaScript errors or Record visits', () => {
    expect(errorsConfig({ errors_on: 0, record_visits: 0 } as any)).toBeUndefined();
    expect(errorsConfig({ errors_on: 1 } as any)).toBe(1);
    expect(errorsConfig({ record_visits: 1 } as any)).toBe(1);
  });
});

describe('errors: ingest', () => {
  let w: TestWorker;
  let site: any;
  const event = (body: Record<string, unknown>, p = '/checkout') =>
    w.fetch('/api/event', {
      method: 'POST',
      headers: { 'user-agent': UA, 'cf-connecting-ip': '198.51.100.70' },
      body: JSON.stringify({ w: site.id, u: `https://errors.example${p}`, sw: 1440, ...body }),
    });
  const rows = async (fn: () => Promise<unknown>) => {
    w.takeRowsWritten();
    await fn();
    await w.flush();
    return w.takeRowsWritten();
  };
  const set = async (fields: Record<string, unknown>) => {
    const res = await w.admin(`/api/sites/${site.id}`, { method: 'PATCH', json: fields });
    expect(res.status).toBe(200);
    forgetSite(site.id);
  };
  const ping = (sid: string, e: unknown[], p = '/checkout') =>
    event({ t: 'ping', vid: 'errvisitor0001', sid, d: 1000, a: { p, s: Date.now() - 3000, e } });
  const stored = () => w.db.prepare('SELECT * FROM errors WHERE site_id = ? ORDER BY ts, message DESC').bind(site.id).all<any>().then((r) => r.results);
  const ERR = (m: string, k?: string) => ({ t: 100, m, s: 'https://errors.example/app.js?v=9:12', ...(k ? { k } : {}) });

  beforeAll(async () => {
    resetBudgetForTests(Infinity);
    w = await startWorker();
    site = await w.createSite({ domain: 'errors.example' });
    await event({ t: 'pageview', vid: 'errvisitor0001', sid: 'errsession0001' });
    await w.flush();
  });
  afterAll(async () => {
    await w.dispose();
  });

  it('stores nothing and sends no cfg.e while the switch is off', async () => {
    expect(await rows(() => ping('errsession0001', [ERR('TypeError: x')]))).toBe(1);
    expect(await stored()).toEqual([]);
    const res = await event({ t: 'pageview', vid: 'errvisitor0001', sid: 'errsession0001' });
    expect(await res.text()).toBe('');
  });

  it('catches errors without recording: cfg.e, and 1 row per distinct error with its frames', async () => {
    await set({ errors_on: 1 });
    expect((await w.admin(`/api/sites/${site.id}`)).body).toMatchObject({ errors_on: 1, record_visits: 0 });
    const res = await event({ t: 'pageview', vid: 'errvisitor0001', sid: 'errsession0001' });
    expect(((await res.json()) as any).cfg).toEqual({ e: 1 });
    await w.flush();
    // The session update, then 0 rows for a ping without errors.
    expect(await rows(() => ping('errsession0001', []))).toBe(1);
    const k = 'https://errors.example/app.js?v=9:12:7 pay\nhttps://errors.example/app.js:40:1 onClick';
    const written = await rows(() =>
      ping('errsession0001', [ERR("TypeError: Cannot read properties of undefined (reading 'priceId')", k), ERR("TypeError: Cannot read properties of undefined (reading 'planId')", k), ERR('Email anna@example.com taken')]),
    );
    expect(written).toBe(1 + 2);
    const got = await stored();
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({
      session_id: 'errsession0001', visitor_id: 'errvisitor0001', path: '/checkout', n: 2, device: 'Desktop', browser: 'Chrome',
      source: 'https://errors.example/app.js:12', stack: 'https://errors.example/app.js:12:7 pay\nhttps://errors.example/app.js:40:1 onClick',
    });
    expect(got[0].fp).toBe(fingerprint(got[0].message, got[0].source, got[0].stack));
    expect(got[1].message).toBe('Email [removed] taken');
  });

  it('keeps at most 5 rows a page view, skips never-recorded pages and pings of unknown visits', async () => {
    await w.db.prepare('DELETE FROM errors WHERE site_id = ?').bind(site.id).run();
    const many = Array.from({ length: 8 }, (_, i) => ERR(`Error ${'abcdefgh'[i]} broke`));
    expect(await rows(() => ping('errsession0001', many))).toBe(1 + 5);
    await set({ record_skip: '/account' });
    expect(await rows(() => ping('errsession0001', [ERR('Leaky')], '/account/billing'))).toBe(1);
    expect(await rows(() => ping('errnosession99', [ERR('Orphan')]))).toBe(0);
    expect((await stored()).map((r) => r.message)).not.toContain('Leaky');
  });

  it('catches errors on a site that records visits, and keeps the activity row as before', async () => {
    await w.db.prepare('DELETE FROM errors WHERE site_id = ?').bind(site.id).run();
    await set({ errors_on: 0, record_visits: 1, record_skip: '' });
    // The session update, the errors row, and the activity event (4 rows: the row, 2 index entries, the id counter).
    expect(await rows(() => ping('errsession0001', [ERR('TypeError: y')]))).toBe(1 + 1 + 4);
    expect(await stored()).toHaveLength(1);
    const act = await w.db.prepare("SELECT props FROM events WHERE site_id = ? AND type = 'activity'").bind(site.id).first<{ props: string }>();
    expect(JSON.parse(act!.props).e[0].m).toBe('TypeError: y');
  });

  it('exports the rows as CSV', async () => {
    const res = await w.admin<string>(`/api/sites/${site.id}/export/errors?period=7d`);
    expect(res.status).toBe(200);
    const csv = res.body;
    expect(String(csv)).toContain('time,issue,message,source,stack,times,path,device,browser,session_id,visitor_id');
    expect(String(csv)).toContain('TypeError: y');
  });

  it('erases a person\'s errors and drops rows older than 90 days', async () => {
    const now = Date.now();
    await w.db
      .prepare("INSERT INTO errors (site_id, ts, id, fp, message) VALUES (?, ?, 1, 'aaaaaaaaaaaa', 'Old'), (?, ?, 2, 'aaaaaaaaaaaa', 'Kept')")
      .bind(site.id, now - (ERRORS_DAYS + 1) * DAY, site.id, now - (ERRORS_DAYS - 1) * DAY)
      .run();
    await pruneOldData(w.db, now);
    expect((await stored()).map((r) => r.message)).toEqual(['Kept', 'TypeError: y']);
    await w.db.prepare('UPDATE visitors SET email = ? WHERE site_id = ? AND id = ?').bind('erra@example.org', site.id, 'errvisitor0001').run();
    const res = await w.admin(`/api/sites/${site.id}/erase`, { method: 'POST', json: { email: 'erra@example.org' } });
    expect(res.status).toBe(200);
    expect((await stored()).map((r) => r.message)).toEqual(['Kept']);
  });

  it('empties both tables when the site is deleted', async () => {
    await w.db.prepare("INSERT INTO error_issues (site_id, fp, status, changed_at) VALUES (?, 'aaaaaaaaaaaa', 'resolved', 1)").bind(site.id).run();
    expect((await w.admin(`/api/sites/${site.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM errors WHERE site_id = ?').bind(site.id).first('n')).toBe(0);
    expect(await w.db.prepare('SELECT COUNT(*) AS n FROM error_issues WHERE site_id = ?').bind(site.id).first('n')).toBe(0);
  });
});

describe('errors: the tracker sends stack frames as k', () => {
  // The tracker's errors region on its own: stackOf from public/js/script.js, run on the stacks browsers write.
  const code = fs.readFileSync(path.resolve(__dirname, '../public/js/script.js'), 'utf8');
  const region = code.slice(code.indexOf('// ==== region errors'), code.indexOf('// ==== end of region errors'));
  const stackOf = vm.runInNewContext(`${region}; stackOf`) as (e: unknown) => string | undefined;

  it('reads Chrome, Firefox and Safari stacks, keeps 3 frames without queries', () => {
    const chrome = [
      "TypeError: Cannot read properties of undefined (reading 'priceId')",
      '    at handleCheckout (https://shop.example/assets/index-B3kZ9a1x.js?v=2:120:14)',
      '    at https://shop.example/assets/index-B3kZ9a1x.js:88:3',
      '    at HTMLButtonElement.onclick (https://shop.example/node_modules/@acme/ui/button.js:5:9)',
      '    at more (https://shop.example/x.js:1:1)',
    ].join('\n');
    expect(stackOf({ error: { stack: chrome } })).toBe(
      'https://shop.example/assets/index-B3kZ9a1x.js:120:14 handleCheckout\nhttps://shop.example/assets/index-B3kZ9a1x.js:88:3\nhttps://shop.example/node_modules/@acme/ui/button.js:5:9 HTMLButtonElement.onclick',
    );
    expect(stackOf({ reason: { stack: 'pay@https://shop.example/app.js?x=1:12:7\n@https://shop.example/app.js:40:1' } })).toBe(
      'https://shop.example/app.js:12:7 pay\nhttps://shop.example/app.js:40:1',
    );
    expect(stackOf({ error: null })).toBeUndefined();
    expect(stackOf({ reason: 'plain string' })).toBeUndefined();
    expect(stackOf({ error: { stack: `    at f (https://a.example/${'x'.repeat(400)}.js:1:1)` } })).toHaveLength(300);
  });

  it('parses what it sends the same way the Worker does', () => {
    const k = stackOf({ error: { stack: '    at pay (https://shop.example/app.js:12:7)' } });
    expect(parseFrames(k)).toEqual([{ file: 'https://shop.example/app.js', line: 12, col: 7, fn: 'pay' }]);
  });
});
