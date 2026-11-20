import { compareVersions, type Release, type ReleaseEntry } from '../../shared/product';

const SEMVER = /^\d+(\.\d+)*$/;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** One entry of `releases`, or null when it has no valid version. Change lists that are missing or malformed count as empty. */
function parseEntry(v: unknown): ReleaseEntry | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (typeof e.version !== 'string' || !SEMVER.test(e.version)) return null;
  return { version: e.version, date: typeof e.date === 'string' ? e.date : '', core: strings(e.core), pro: strings(e.pro) };
}

/** The answer of RELEASE_URL as a Release, or null when it is not JSON with a version (a 404 page, a proxy's HTML). */
export function parseRelease(text: string): Release | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  if (typeof r.version !== 'string' || !SEMVER.test(r.version)) return null;
  const release: Release = { version: r.version, date: typeof r.date === 'string' ? r.date : '', notes: typeof r.notes === 'string' ? r.notes : undefined };
  if (Array.isArray(r.releases)) {
    release.releases = r.releases
      .map(parseEntry)
      .filter((e): e is ReleaseEntry => e !== null)
      .sort((a, b) => compareVersions(b.version, a.version));
  }
  return release;
}

/** The newer release to offer, or null when this deployment runs the latest one or a later build. */
export function newerRelease(current: string, latest: Release): Release | null {
  return compareVersions(latest.version, current) > 0 ? latest : null;
}

/**
 * Every release after `current`, newest first: what an update to the latest version brings. A feed without `releases`
 * gives one entry made from its notes.
 */
export function releasesSince(current: string, feed: Release): ReleaseEntry[] {
  if (!newerRelease(current, feed)) return [];
  const list = feed.releases?.filter((e) => compareVersions(e.version, current) > 0) ?? [];
  if (list.length) return list;
  return [{ version: feed.version, date: feed.date, core: feed.notes ? [feed.notes] : [], pro: [] }];
}

/** The entry for one version, for "what this version changed" once the deployment is up to date. */
export function releaseOf(version: string, feed: Release): ReleaseEntry | null {
  return feed.releases?.find((e) => compareVersions(e.version, version) === 0) ?? null;
}
