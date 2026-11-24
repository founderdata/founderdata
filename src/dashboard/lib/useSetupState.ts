import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { startPolling, type SetupState } from './setup';
import { isFixtureName, setupFixture, type FixtureName } from './setupFixture';

/**
 * The setup state from GET /api/v1/setup, for Get started, the Home card and Settings, Overview.
 *
 * `?setup=<fixture>` (nosite, fresh, half, multi, done) shows a sample state instead, in any build: the demo and the
 * screenshots use it. A dev server whose Worker does not answer the route yet (404) falls back to the `half` sample;
 * a deployed dashboard never does, and shows no onboarding until the route answers.
 */

const DEV = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;

/** The sample the URL asks for, if any. */
export function fixtureFromUrl(search = typeof window === 'undefined' ? '' : window.location.search): FixtureName | null {
  const name = new URLSearchParams(search).get('setup');
  return isFixtureName(name) ? name : null;
}

// The last answer, so a page that opens after another one draws at once and refreshes behind it.
let last: SetupState | null = null;
let lastSample = false;

/** This deployment's sites, to lend a sample their ids and names. A failure leaves the sample's own. */
const realSites = () =>
  api<{ id: string; name: string; domain: string }[]>('/api/sites').then(
    (all) => all.map((s) => ({ id: s.id, name: s.name || s.domain })),
    () => [],
  );

export async function loadSetup(): Promise<{ state: SetupState | null; sample: boolean }> {
  const origin = window.location.origin;
  const named = fixtureFromUrl();
  if (named) return { state: setupFixture(named, origin, Date.now(), named === 'nosite' ? [] : await realSites()), sample: true };
  try {
    return { state: await api<SetupState>('/api/v1/setup'), sample: false };
  } catch (e) {
    if (DEV && e instanceof ApiError && e.status === 404) return { state: setupFixture('half', origin, Date.now(), await realSites()), sample: true };
    // 403 (a teammate), 404 (an older Worker): no onboarding. Anything else is an error the caller may show.
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return { state: null, sample: false };
    throw e;
  }
}

export interface SetupAnswer {
  state: SetupState | null;
  /** True once the first answer (or a final no) arrived. */
  ready: boolean;
  error: string | null;
  /** The state is a sample, not this deployment's. */
  sample: boolean;
  reload: () => void;
}

/**
 * Reads the state once, or every `pollMs` while the tab is visible (Get started passes 5000). A hidden tab stops
 * polling; coming back reads at once.
 */
export function useSetupState({ enabled = true, pollMs = 0 }: { enabled?: boolean; pollMs?: number } = {}): SetupAnswer {
  const [state, setState] = useState<SetupState | null>(last);
  const [ready, setReady] = useState(!!last);
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState(lastSample);
  const [n, setN] = useState(0);
  const alive = useRef(true);

  const fetchOnce = useCallback(async () => {
    try {
      const r = await loadSetup();
      if (!alive.current) return;
      last = r.state;
      lastSample = r.sample;
      setState(r.state);
      setSample(r.sample);
      setError(null);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setReady(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setReady(true);
      return;
    }
    if (pollMs > 0) {
      const p = startPolling(fetchOnce, pollMs);
      return () => {
        alive.current = false;
        p.stop();
      };
    }
    void fetchOnce();
    return () => {
      alive.current = false;
    };
  }, [enabled, pollMs, n, fetchOnce]);

  return { state: enabled ? state : null, ready, error, sample, reload: useCallback(() => setN((x) => x + 1), []) };
}
