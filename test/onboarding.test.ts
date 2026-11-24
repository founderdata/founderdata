import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAiPrompt } from '../src/dashboard/lib/aiPrompt';
import type { Site } from '../src/dashboard/lib/api';
import { matchRoute } from '../src/dashboard/lib/routes';
import {
  byWho,
  cardDismissed,
  DISMISS_MS,
  dismissCard,
  estimate,
  estimateLine,
  getStartedSkipped,
  gridCell,
  homeSetupView,
  isFirstRun,
  nextStep,
  pickNext,
  productDone,
  setupPrompt,
  skipGetStarted,
  startPolling,
  type VisibilitySource,
} from '../src/dashboard/lib/setup';
import { setupFixture } from '../src/dashboard/lib/setupFixture';

const ORIGIN = 'https://founderdata.example.com';
const fx = (n: Parameters<typeof setupFixture>[0]) => setupFixture(n, ORIGIN, 0);

function memoryStore(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}
const broken = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('onboarding: which screen shows', () => {
  const o = { viewer: false, skipped: false, dismissed: false };

  it('opens Get started on the first run: no site, or no tracker or SDK with a first signal', () => {
    expect(isFirstRun(fx('nosite'))).toBe(true);
    expect(isFirstRun(fx('fresh'))).toBe(true);
    expect(isFirstRun(fx('half'))).toBe(false);
    expect(homeSetupView(fx('nosite'), o)).toBe('get-started');
    expect(homeSetupView(fx('fresh'), o)).toBe('get-started');
  });

  it('shows the Home card after a skip, and while required steps are open', () => {
    expect(homeSetupView(fx('fresh'), { ...o, skipped: true })).toBe('card');
    expect(homeSetupView(fx('half'), o)).toBe('card');
    expect(homeSetupView(fx('multi'), o)).toBe('card');
  });

  it('shows nothing once required steps are done, when dismissed, for a viewer, or without the route', () => {
    expect(homeSetupView(fx('done'), o)).toBe('none');
    expect(homeSetupView(fx('half'), { ...o, dismissed: true })).toBe('none');
    expect(homeSetupView(fx('fresh'), { ...o, viewer: true })).toBe('none');
    expect(homeSetupView(null, o)).toBe('none');
  });

  it('routes /get-started for the owner only', () => {
    expect(matchRoute('/get-started', false)).toEqual({ page: 'getStarted' });
    expect(matchRoute('/get-started/', false)).toEqual({ page: 'getStarted' });
    expect(matchRoute('/get-started', true)).toEqual({ page: 'home' });
  });
});

describe('onboarding: the next step', () => {
  it('puts a broken step first', () => {
    expect(nextStep(fx('multi'))?.id).toBe('payments:tools');
  });

  it('takes a required step to do before one that waits for its signal', () => {
    const s = fx('fresh');
    expect(s.steps.find((x) => x.id === 'tracker:SITE_ID')?.status).toBe('waiting');
    expect(nextStep(s)?.id).toBe('payments:SITE_ID');
  });

  it('never picks a locked Pro step, and is null when nothing is left', () => {
    const done = fx('done');
    expect(nextStep(done)?.status ?? null).not.toBe('locked');
    const allDone = done.steps.map((s) => (s.status === 'locked' ? s : { ...s, status: 'done' as const }));
    expect(pickNext(allDone)).toBeNull();
  });

  it('prefers the server\'s pick, and limits to one site when asked', () => {
    const s = fx('multi');
    const serverPick = s.steps.find((x) => x.id === 'email')!;
    expect(nextStep({ ...s, next: serverPick })?.id).toBe('email');
    expect(nextStep(s, 'blog')?.id).toBe('payments:blog');
  });
});

describe('onboarding: time, groups and the grid', () => {
  it('estimates minutes from the open steps and counts the steps that need the person', () => {
    const e = estimate(fx('fresh').steps);
    expect(e.minutes % 5).toBe(0);
    expect(e.minutes).toBeGreaterThan(0);
    // Connect payments (you); the tracker waits, so it does not count.
    expect(e.signIns).toBe(1);
    expect(estimateLine(fx('fresh').steps)).toBe(`About ${e.minutes} minutes. It needs you for one sign-in.`);
  });

  it('groups steps by who acts, leaving out optional and Pro steps', () => {
    const groups = byWho(fx('multi').steps);
    expect(groups.map((g) => g.who)).toEqual(['agent', 'you', 'browser']);
    expect(groups.flatMap((g) => g.steps).some((s) => s.status === 'locked' || s.status === 'off')).toBe(false);
  });

  it('fills each grid cell with its worst status, and counts products fully set up', () => {
    const s = fx('multi');
    expect(gridCell(s.steps, 'tools', 'revenue').status).toBe('broken');
    expect(gridCell(s.steps, 'blog', 'track').status).toBe('waiting');
    expect(gridCell(s.steps, 'acme', 'growth').status).toBe('locked');
    expect(gridCell(s.steps, 'acme', 'agent').status).toBe('done');
    expect(gridCell(s.steps, 'notes', 'revenue').step?.id).toBe('apple:notes');
    expect(s.sites.filter((x) => productDone(s.steps, x.id)).map((x) => x.id)).toEqual(['acme']);
  });
});

describe('onboarding: skip and dismiss', () => {
  it('hides the Home card for 7 days', () => {
    const st = memoryStore();
    expect(cardDismissed(1000, st)).toBe(false);
    dismissCard(1000, st);
    expect(cardDismissed(1000 + DISMISS_MS - 1, st)).toBe(true);
    expect(cardDismissed(1000 + DISMISS_MS, st)).toBe(false);
  });

  it('remembers "I\'ll finish later"', () => {
    const st = memoryStore();
    expect(getStartedSkipped(st)).toBe(false);
    skipGetStarted(5, st);
    expect(getStartedSkipped(st)).toBe(true);
  });

  it('survives blocked storage: nothing throws, and nothing counts as dismissed', () => {
    expect(() => dismissCard(1, broken)).not.toThrow();
    expect(cardDismissed(2, broken)).toBe(false);
    expect(() => skipGetStarted(1, broken)).not.toThrow();
    expect(getStartedSkipped(broken)).toBe(false);
  });
});

describe('onboarding: polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeDoc() {
    const fns = new Set<() => void>();
    const doc: VisibilitySource & { set(hidden: boolean): void } = {
      hidden: false,
      addEventListener: (_t, fn) => void fns.add(fn),
      removeEventListener: (_t, fn) => void fns.delete(fn),
      set(hidden) {
        this.hidden = hidden;
        fns.forEach((f) => f());
      },
    };
    return { doc, listeners: fns };
  }

  it('polls every 5 seconds while visible, stops when hidden, and reads at once when visible again', async () => {
    const { doc } = fakeDoc();
    const tick = vi.fn(async () => undefined);
    const p = startPolling(tick, 5000, doc);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(3);

    doc.set(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(p.active).toBe(false);

    doc.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(5);
    p.stop();
  });

  it('stops for good on stop(), removes its listener, and keeps going after a failed tick', async () => {
    const { doc, listeners } = fakeDoc();
    let n = 0;
    const tick = vi.fn(async () => {
      if (++n === 1) throw new Error('offline');
    });
    const p = startPolling(tick, 5000, doc);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(2);
    p.stop();
    expect(listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('starts nothing in a hidden tab until it shows', async () => {
    const { doc } = fakeDoc();
    doc.hidden = true;
    const tick = vi.fn(async () => undefined);
    const p = startPolling(tick, 5000, doc);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).not.toHaveBeenCalled();
    doc.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    p.stop();
  });
});

describe('onboarding: the prompts', () => {
  it('fills the setup prompt with the address, each site id and the open steps, and routes secrets through connect', () => {
    const p = setupPrompt(fx('multi'));
    expect(p).toContain(ORIGIN);
    for (const id of ['acme', 'notes', 'blog', 'tools']) expect(p).toContain(`site id ${id}`);
    expect(p).toContain('- Connect payments for tools.acme.example (me, ask me when)');
    expect(p).toContain('- Install the tracker for blog.acme.example (you)');
    expect(p).toContain('npm run connect -- <provider>');
    expect(p).not.toMatch(/whsec_|sk_live|rk_live/);
  });

  it('asks the agent to add the first site when there is none', () => {
    expect(setupPrompt(fx('nosite'))).toContain('None yet. Ask me which websites and apps to track');
  });

  const app: Site = {
    id: 'app123',
    name: 'Notes',
    domain: 'app123.invalid',
    timezone: 'UTC',
    currency: 'EUR',
    api_key: 'rt_secret_never',
    dodo_webhook_secret: null,
    created_at: 0,
    app_bundle_id: 'com.example.notes',
    accept_sandbox: 0,
    stripe_webhook_secret: null,
    revenuecat_auth: 'rc_secret_never',
  };

  it('gives an app-only site an app-first prompt: bundle id first, the SDK, no script tag', () => {
    const p = buildAiPrompt(app, ORIGIN);
    expect(p).not.toContain('<script');
    expect(p).not.toContain('.invalid');
    expect(p.indexOf('Bundle id: com.example.notes')).toBeLessThan(p.indexOf('Site id: app123'));
    expect(p).toContain('FounderData.configure(siteId: "app123", host: "https://founderdata.example.com")');
    expect(p).toContain('FounderData.revenueCatAttributes');
    expect(p).toContain(`${ORIGIN}/api/webhooks/apple/app123`);
    expect(p).toContain(`${ORIGIN}/api/webhooks/revenuecat/app123`);
    for (const secret of [app.api_key, app.revenuecat_auth!]) expect(p).not.toContain(secret);
  });

  it('asks for the bundle id when an app-only site has none yet', () => {
    expect(buildAiPrompt({ ...app, app_bundle_id: null }, ORIGIN)).toContain('Bundle id: not set yet');
  });

  it('keeps the web prompt for a site with a website and an app', () => {
    const p = buildAiPrompt({ ...app, domain: 'notes.example.com' }, ORIGIN);
    expect(p).toContain('<script defer data-website-id="app123"');
  });
});
