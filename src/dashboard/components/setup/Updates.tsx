import { useState } from 'react';
import { CHANGELOG_URL, RELEASE_URL, VERSION, type ReleaseEntry } from '../../../shared/product';
import { updatePrompt } from '../../../shared/pro-prompts';
import { isPro } from '../../lib/pro';
import { parseRelease, releaseOf, releasesSince } from '../../lib/updates';
import { PRO_LIST } from '../../lib/proFeatures';
import { Code } from '../Code';
import { ProActions } from '../ProUpsell';
import { SettingsCard } from './kit';

type Check =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'latest'; current: ReleaseEntry | null }
  | { state: 'newer'; version: string; date: string; releases: ReleaseEntry[] }
  | { state: 'error'; message: string };

/**
 * Settings, Updates: this build's version and edition, and a check against the release feed. A newer release lists
 * every release since this build with its changes for this edition. The browser fetches RELEASE_URL on click only. In core, the Pro card next to it reads OFFER_URL while it is on screen (lib/offer.ts). The prompt hands the update to the owner's agent.
 */
export function UpdatesCard() {
  const edition = isPro ? 'pro' : 'core';
  const [check, setCheck] = useState<Check>({ state: 'idle' });

  async function run() {
    setCheck({ state: 'busy' });
    try {
      const res = await fetch(RELEASE_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`The release file answered ${res.status}.`);
      const release = parseRelease(await res.text());
      if (!release) throw new Error('The release file is not valid JSON with a version.');
      const newer = releasesSince(VERSION, release);
      setCheck(newer.length ? { state: 'newer', version: release.version, date: release.date, releases: newer } : { state: 'latest', current: releaseOf(VERSION, release) });
    } catch (e) {
      setCheck({ state: 'error', message: e instanceof TypeError ? 'Could not reach the release file. Check your connection and try again.' : (e as Error).message });
    }
  }

  return (
    <SettingsCard
      id="updates"
      title="Updates"
      desc={`You run FounderData ${isPro ? 'Pro' : 'core'} ${VERSION}. The check reads the latest release from GitHub when you click it.${isPro ? '' : ' The Pro card below also loads the current Pro price from GitHub while it is on screen.'}`}
      actions={
        <button className="btn" onClick={run} disabled={check.state === 'busy'}>
          {check.state === 'busy' ? 'Checking' : 'Check for updates'}
        </button>
      }
    >
      <div className="space-y-4 text-sm">
        <div aria-live="polite">
          {check.state === 'idle' && <p className="text-stone-500">Not checked yet.</p>}
          {check.state === 'latest' && (
            <div>
              <p className="text-stone-600">You run the latest release, {VERSION}.</p>
              {check.current && (
                <div className="mt-3">
                  <ReleaseChanges entry={check.current} title={`What ${VERSION} changed`} />
                </div>
              )}
            </div>
          )}
          {check.state === 'error' && <p className="text-red-700">{check.message}</p>}
          {check.state === 'newer' && (
            <div>
              <p className="font-medium text-ink">
                Version {check.version} is out{check.date ? `, released ${check.date}` : ''}. You run {VERSION}.
              </p>
              <div className="mt-3 space-y-4">
                {check.releases.map((r) => (
                  <ReleaseChanges key={r.version} entry={r} title={r.date ? `${r.version}, ${r.date}` : r.version} />
                ))}
              </div>
            </div>
          )}
          {(check.state === 'latest' || check.state === 'newer') && (
            <p className="mt-3 text-[13px] text-stone-500">
              <a className="underline underline-offset-2" href={CHANGELOG_URL} target="_blank" rel="noreferrer">
                Every release in the changelog
              </a>
            </p>
          )}
        </div>
        <div>
          <p className="mb-2 text-[13px] text-stone-500">Paste this into the agent that manages this deployment. It merges the release and deploys.</p>
          <Code>{updatePrompt(edition, check.state === 'newer' ? check.version : undefined)}</Code>
        </div>
      </div>
    </SettingsCard>
  );
}

/**
 * One release's changes for this edition. Pro shows core and Pro changes under their own labels. Core shows its own
 * changes, then what the same release brought to Pro.
 */
function ReleaseChanges({ entry, title }: { entry: ReleaseEntry; title: string }) {
  const groups: { label: string; items: string[]; muted?: boolean }[] = isPro
    ? [
        { label: 'Core', items: entry.core },
        { label: 'Pro', items: entry.pro },
      ]
    : [
        { label: '', items: entry.core },
        { label: 'In FounderData Pro', items: entry.pro, muted: true },
      ];
  const shown = groups.filter((g) => g.items.length);
  return (
    <div>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {!isPro && !entry.core.length && <p className="mt-1 text-[13px] text-stone-500">No changes to core in this release.</p>}
      {shown.map((g) => (
        <div key={g.label || 'own'} className="mt-1">
          {g.label && <p className="mt-2 text-micro uppercase text-stone-400">{g.label}</p>}
          <ul className={`list-disc space-y-0.5 pl-5 text-[13px] ${g.muted ? 'text-stone-500' : 'text-stone-600'}`}>
            {g.items.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Settings, FounderData Pro: what Pro adds and how to get it. Core builds only. */
export function ProCard() {
  return (
    <SettingsCard
      id="pro"
      title="FounderData Pro"
      desc="One payment covers all your sites and apps and every update, with no renewal. Pro runs on your own Cloudflare account and keeps working without us."
    >
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-stone-600">
        {PRO_LIST.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <ProActions />
    </SettingsCard>
  );
}
