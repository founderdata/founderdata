// The product itself, not a deployment (docs/PRO.md): which edition this build is, its version, and where updates and
// FounderData Pro come from. A self-hoster never edits this file; deployment data goes in the gitignored files that
// AGENTS.md lists.
import pkg from '../../package.json';

/** The version this build was made from (package.json). Core and Pro share version numbers. */
export const VERSION: string = pkg.version;

/** The public core repository. Updates to core are merged from here. */
export const CORE_REPO = 'https://github.com/founderdata/founderdata';

/** The private FounderData Pro repository. A buyer's GitHub account gets read access when they buy. */
export const PRO_REPO = 'https://github.com/founderdata/founderdata-pro';

/** Polar's customer portal for FounderData Pro. A buyer connects their GitHub account here to get the invitation. */
export const PRO_PORTAL = 'https://polar.sh/founderdataapp/portal';

/**
 * The release feed, as JSON (release.json at the repository root): the latest version, date and notes, plus `releases`,
 * every release newest first with its core and Pro changes. The Updates card in Settings reads it in the browser.
 */
export const RELEASE_URL = 'https://raw.githubusercontent.com/founderdata/founderdata/main/release.json';

/** Every release with its changes, made from release.json by scripts/release.mjs. */
export const CHANGELOG_URL = `${CORE_REPO}/blob/main/CHANGELOG.md`;

/** The Polar checkout for the lifetime license. When it is empty, the Pro card links to PRO_PAGE instead. */
export const PRO_CHECKOUT_URL = 'https://buy.polar.sh/polar_cl_VXmKrwlw4IIWM6GhohnTzJZN5nMhtpjbcy7I63PRvbm';

/**
 * The price after launch, in minor units, VAT included. The checkout takes euros and dollars at this number. During
 * launch a capped Polar discount on PRO_CHECKOUT_URL lowers it step by step, and Polar enforces each cap.
 */
export const PRO_REGULAR = 9999;

/** The price after launch, in both currencies the checkout takes. */
export const PRO_PRICE = '€99.99 or $99.99';

/**
 * The live launch offer, as JSON (src/shared/offer.ts): the price after launch, the launch steps and how many
 * licenses sold. A Pro card reads it in the browser while it is on screen; without it, the card shows the price after
 * launch. OFFER_PAGE is the same file on GitHub, for people who want to see how it is counted.
 */
export const OFFER_URL = 'https://raw.githubusercontent.com/founderdata/founderdata/offer/offer.json';
export const OFFER_PAGE = 'https://github.com/founderdata/founderdata/blob/offer/offer.json';

/** What Pro adds and costs, in the core README. */
export const PRO_PAGE = `${CORE_REPO}#founderdata-pro`;

/** One release in release.json. `core` lists what changed for every deployment, `pro` what changed in Pro only. */
export interface ReleaseEntry {
  version: string;
  date: string;
  core: string[];
  pro: string[];
}

export interface Release {
  version: string;
  date: string;
  /** The latest release in one paragraph. Dashboards before 1.5.0 show only this. */
  notes?: string;
  /** Every release, newest first. Missing from feeds before 1.5.0. */
  releases?: ReleaseEntry[];
}

/** -1, 0 or 1 for two dotted versions such as 1.4.0 and 1.10.2. A part that is not a number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
