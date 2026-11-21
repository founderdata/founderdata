// The tracker's survey region (public/js/script.js; docs/API.md "Survey answers"): founderdata('answer', ...) sends a
// survey event, founderdata('survey', key) and cfg.sv load /js/survey.js once, only for a survey that is on.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const CODE = fs.readFileSync(path.resolve(__dirname, '../public/js/script.js'), 'utf8');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A page with the tracker, cookies on (so events go by sendBeacon with ids), and the config each pageview answers. */
function load(cfg: unknown, queue: unknown[][] = []) {
  const requests: any[] = [];
  const beacons: Promise<any>[] = [];
  const scripts: any[] = [];
  const jar = new Map<string, string>();
  const document: any = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(s: string) {
      const [nv] = s.split(';');
      const i = nv.indexOf('=');
      if (/max-age=0/.test(s)) jar.delete(nv.slice(0, i).trim());
      else jar.set(nv.slice(0, i).trim(), nv.slice(i + 1));
    },
    currentScript: {
      src: 'https://stats.example/js/script.js',
      getAttribute: (n: string) => ({ 'data-website-id': 'site123', 'data-cookies': 'on' } as Record<string, string>)[n] ?? null,
      hasAttribute: (n: string) => n === 'data-cookies' || n === 'data-website-id',
    },
    referrer: '',
    visibilityState: 'visible',
    readyState: 'complete',
    documentElement: {},
    head: { appendChild: (s: unknown) => scripts.push(s) },
    createElement: (tag: string) => ({ tagName: tag.toUpperCase() }),
    addEventListener: () => {},
    querySelectorAll: () => [],
  };
  const window: any = {
    location: new URL('https://example.com/welcome'),
    navigator: {
      webdriver: false,
      sendBeacon: (_u: string, blob: Blob) => {
        beacons.push(blob.text().then(JSON.parse));
        return true;
      },
    },
    screen: { width: 1440 },
    history: { pushState() {}, replaceState() {} },
    addEventListener: () => {},
    crypto: globalThis.crypto,
  };
  if (queue.length) window.founderdata = Object.assign(() => {}, { q: queue });
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    return body.t === 'pageview' && cfg ? Response.json({ cfg }, { status: 202 }) : new Response(null, { status: 202 });
  };
  const ctx = vm.createContext({ window, document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch, screen: window.screen, crypto: globalThis.crypto, URL, URLSearchParams, Blob, Response, setTimeout, setInterval: () => 0 });
  vm.runInContext(CODE, ctx);
  return { fd: window.founderdata as any, requests, beacons, scripts };
}

describe('tracker: surveys', () => {
  it('sends an answer as a survey event with the survey, the answer and the text', async () => {
    const t = load(null);
    t.fd('answer', 'heard_about', 'podcast');
    t.fd('answer', 'heard_about', 'other', 'x'.repeat(300));
    t.fd('answer', 'heard_about'); // no answer: nothing is sent
    const sent = await Promise.all(t.beacons);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ t: 'survey', n: 'heard_about', p: { a: 'podcast' } });
    expect(sent[0].p).toEqual({ a: 'podcast' });
    expect(sent[0].vid).toBeTruthy();
    expect(sent[1].p.x).toHaveLength(200);
  });

  it('loads the widget once for the survey the config shows, and hands it what it needs', async () => {
    const t = load({ sv: { on: ['heard_about'], show: 'heard_about' } });
    await tick();
    expect(t.scripts.map((s) => s.src)).toEqual(['https://stats.example/js/survey.js']);
    const sv = t.fd._sv;
    expect(sv).toMatchObject({ k: 'heard_about', host: 'https://stats.example', site: 'site123' });
    // The widget sends through the tracker, marked as the widget's.
    sv.a('heard_about', 'friend', undefined, 1);
    expect((await Promise.all(t.beacons))[0]).toMatchObject({ t: 'survey', n: 'heard_about', p: { a: 'friend', v: 1 } });
    // A second call shows the loaded widget again instead of loading it twice.
    const shown: string[] = [];
    sv.show = (k: string) => shown.push(k);
    t.fd('survey', 'heard_about');
    expect(shown).toEqual(['heard_about']);
    expect(t.scripts).toHaveLength(1);
  });

  it('waits for the config before founderdata(\'survey\'), and loads nothing for a survey that is off', async () => {
    const off = load({ sv: { on: ['heard_about'] } }, [['survey', 'cancel_reason']]);
    await tick();
    expect(off.scripts).toEqual([]);
    const on = load({ sv: { on: ['cancel_reason'] } }, [['survey', 'cancel_reason']]);
    expect(on.scripts).toEqual([]);
    await tick();
    expect(on.scripts).toHaveLength(1);
    expect(on.fd._sv.k).toBe('cancel_reason');
    // No surveys on: no config key, no widget.
    const none = load(null, [['survey', 'heard_about']]);
    await tick();
    expect(none.scripts).toEqual([]);
  });
});
