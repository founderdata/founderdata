import { useEffect, useRef, useState } from 'react';
import { navigate } from '../../App';
import { buildAiPrompt } from '../../lib/aiPrompt';
import { api, type Site } from '../../lib/api';
import { hasWebsite, swiftSetup } from '../../lib/siteKind';
import { Code } from '../Code';
import { TypeSetup, typeOf, type ProductType } from '../ProductType';
import { InfoTip } from '../InfoTip';
import { LiveDot, Note, Skeleton, Tabs, toast } from '../ui';
import { SetupIcons } from './icons';
import { Integration } from './Integration';
import { CopyButton, Mark, Step, Steps } from './kit';
import { useSetup } from './status';

const GUIDE = 'https://github.com/founderdata/founderdata/blob/main/docs/GUIDE.md';
const REPO = 'https://github.com/founderdata/founderdata';

/** The product the install steps are for: the picked type, else website or app from the domain and bundle id. */
export function installType(site: Site): ProductType {
  const t = typeOf(site);
  return t === 'app' && hasWebsite(site) ? 'website' : t;
}

/** The prompt for a coding agent, with one button. The agent installs everything in the codebase with this site's values. */
export function AiPromptPanel({ site, origin }: { site: Site; origin: string }) {
  const [open, setOpen] = useState(false);
  const prompt = buildAiPrompt(site, origin);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-brand/25 bg-brand-soft/60 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white text-brand-text shadow-card ring-1 ring-inset ring-brand/20" aria-hidden="true">
          {SetupIcons.sparkle}
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
            Let a coding agent install it
            <InfoTip label="What the prompt does" className="text-stone-500">
              It adds the {site.app_bundle_id && !hasWebsite(site) ? 'SDK' : 'script'}, payment attribution, user identification and button goals with this site's id and host, and asks only what it can't find in your code. Payment webhooks still need you: set them in each provider's dashboard.
            </InfoTip>
          </div>
          <p className="mt-0.5 text-[13px] text-stone-500">Paste the prompt into Claude Code, Cursor or Codex, in your project.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className="btn-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide the prompt' : 'Read the prompt'}
          </button>
          <CopyButton value={prompt} label="Copy AI prompt" className="btn-dark" onCopied={() => toast('Prompt copied. Paste it into your coding agent.', 'ok')} />
        </div>
      </div>
      {open && <pre className="code mt-3 max-h-80 whitespace-pre-wrap text-xs">{prompt}</pre>}
    </div>
  );
}

type WebTab = 'html' | 'next' | 'proxy';

/** The script tag for a website, with the Next.js form and the ad blocker proxy. */
export function TrackerSnippet({ site, origin }: { site: Site; origin: string }) {
  const [tab, setTab] = useState<WebTab>('html');
  const tag = `<script defer data-website-id="${site.id}" src="${origin}/js/script.js"></script>`;
  return (
    <div>
      <Tabs
        label="Framework"
        value={tab}
        onChange={setTab}
        className="mb-2"
        items={[
          { value: 'html', label: 'HTML' },
          { value: 'next', label: 'Next.js' },
          { value: 'proxy', label: 'Behind a proxy' },
        ]}
      />
      {tab === 'html' && <Code>{tag}</Code>}
      {tab === 'next' && (
        <Code>{`// app/layout.tsx
import Script from 'next/script';

<head>
  <Script defer data-website-id="${site.id}" src="${origin}/js/script.js" strategy="afterInteractive" />
</head>`}</Code>
      )}
      {tab === 'proxy' && (
        <div className="space-y-2">
          <Code>{`// next.config.js
async rewrites() {
  return [
    { source: '/stats/script.js', destination: '${origin}/js/script.js' },
    { source: '/stats/event', destination: '${origin}/api/event' },
  ];
}

<script defer data-website-id="${site.id}" data-api="/stats/event" src="/stats/script.js"></script>`}</Code>
          <Note
            more={
              <p>
                Behind a rewrite, set the Worker variable <code>TRUST_FORWARDED_FOR</code> to <code>1</code>, or cookieless visitors who come through the proxy merge into one.{' '}
                <a className="underline underline-offset-2" href={`${GUIDE}#accuracy-notes`} target="_blank" rel="noreferrer">
                  Accuracy notes
                </a>
              </p>
            }
          >
            Served from your own domain, the script gets past ad blockers.
          </Note>
        </div>
      )}
    </div>
  );
}

/** The Swift package and the three lines that start it. */
export function SdkSteps({ site, origin, start = 1 }: { site: Site; origin: string; start?: number }) {
  return (
    <>
      <Step n={start} title="Add the Swift package in Xcode">
        Choose <b>File, Add Package Dependencies</b>, paste the URL below and link <b>FounderDataKit</b> to the app target.
        <div className="mt-2">
          <Code>{REPO}</Code>
        </div>
      </Step>
      <Step n={start + 1} title="Start it when the app launches">
        Call <code>configure</code> in <code>App.init()</code>. App sessions arrive under <code>ios:{site.app_bundle_id ?? 'your.bundle.id'}</code>, so the Platform
        tab can split web, iOS and Android.
        <div className="mt-2">
          <Code>{swiftSetup(site.id, origin)}</Code>
        </div>
        <p className="mt-2 text-[13px] text-stone-500">Screens, onboarding and purchases are in the package's README.</p>
      </Step>
    </>
  );
}

interface LiveAnswer {
  sites: { id: string; online: number }[];
}

/**
 * Waits for the first visit or app session: polls GET /api/live (the live globe's route, built to be polled) every
 * 4 seconds while the tab is visible, and stops once one arrives or after 30 minutes.
 */
export function useFirstData(siteId: string, already: boolean) {
  const [arrived, setArrived] = useState(already);
  const [gaveUp, setGaveUp] = useState(false);
  const started = useRef(Date.now());
  useEffect(() => {
    if (already) setArrived(true);
  }, [already]);
  useEffect(() => {
    if (arrived) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      if (!alive) return;
      if (Date.now() - started.current > 30 * 60_000) return setGaveUp(true);
      if (!document.hidden) {
        try {
          const r = await api<LiveAnswer>('/api/live?places=0');
          if (alive && (r.sites.find((s) => s.id === siteId)?.online ?? 0) > 0) return setArrived(true);
        } catch {
          // A failed poll waits for the next one.
        }
      }
      timer = window.setTimeout(tick, 4000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [siteId, arrived]);
  return { arrived, gaveUp, retry: () => ((started.current = Date.now()), setGaveUp(false)) };
}

/** "Waiting for the first visit", then the moment it arrives. */
export function FirstData({ site, already = false, compact = false }: { site: Site; already?: boolean; compact?: boolean }) {
  const { arrived, gaveUp, retry } = useFirstData(site.id, already);
  const web = hasWebsite(site);
  const type = typeOf(site);
  const thing = type === 'extension' ? 'install event' : type === 'newsletter' ? 'subscriber event' : web ? 'visit' : 'app session';
  const announce = useRef<HTMLDivElement>(null);
  const wasWaiting = useRef(!arrived);
  useEffect(() => {
    if (arrived && wasWaiting.current) toast(`The first ${thing} arrived`, 'ok');
  }, [arrived]);

  if (arrived) {
    return (
      <div ref={announce} role="status" className={`flex flex-wrap items-center gap-3 rounded-2xl bg-emerald-50 ring-1 ring-inset ring-emerald-200/60 ${compact ? 'px-4 py-3' : 'px-4 py-4'}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[#fff] animate-pop-in" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2.5 6.5 2.5 2.5 4.5-6" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">{wasWaiting.current ? `The first ${thing} arrived` : 'Data is arriving'}</div>
          <div className="text-[13px] text-stone-500">Revenue shows once a payment provider is connected.</div>
        </div>
        <button type="button" className="btn-dark" onClick={() => navigate(`/site/${site.id}`)}>
          Open dashboard
        </button>
      </div>
    );
  }
  return (
    <div role="status" className={`flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-stone-300 bg-stone-50/60 ${compact ? 'px-4 py-3' : 'px-4 py-4'}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-inset ring-stone-200" aria-hidden="true">
        <LiveDot on={!gaveUp} size={8} />
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {gaveUp ? `No ${thing} in 30 minutes` : `Waiting for the first ${thing}`}
          {web && type === 'website' && (
            <InfoTip label="About localhost" className="text-stone-400">
              The script skips localhost unless the tag has <code>data-allow-localhost</code>.
            </InfoTip>
          )}
        </div>
        <div className="text-[13px] text-stone-500">
          {web ? (type === 'website' ? `Open ${site.domain} once the script is live.` : 'Open it once with the code in place.') : 'Run the app on a phone or in the Simulator.'}
        </div>
      </div>
      {gaveUp ? (
        <button type="button" className="btn" onClick={retry}>
          Keep waiting
        </button>
      ) : (
        web &&
        type === 'website' && (
          <a className="btn" href={`https://${site.domain}`} target="_blank" rel="noreferrer">
            Open {site.domain}
          </a>
        )
      )}
    </div>
  );
}

/** Settings, Install: the agent prompt, the tracker and SDK cards, the live state, and the link builder. */
export function InstallGroup({ site, origin }: { site: Site; origin: string }) {
  const setup = useSetup();
  const type = installType(site);
  const web = hasWebsite(site);
  const row = setup?.data.row;
  return (
    <div className="space-y-4">
      <AiPromptPanel site={site} origin={origin} />
      {/* Wait for the site's row, so a site that already has data never plays the arrival. */}
      {row ? <FirstData site={site} already={(row.visitors24h ?? 0) > 0} compact /> : <Skeleton className="h-[64px] w-full rounded-2xl" />}
      {web && (
        <Integration
          id="tracker"
          site={site}
          mark={<Mark>{SetupIcons.install}</Mark>}
          title={type === 'website' ? 'Website tracker' : type === 'extension' ? 'Browser extension events' : 'Newsletter events'}
          desc={type === 'website' ? `One script tag in the <head> of every page on ${site.domain}.` : 'Three goal events sent to the event API.'}
        >
          {type === 'website' ? (
            <Steps>
              <Step n={1} title={`Paste this in the <head> of every page on ${site.domain}`}>
                Subdomains count as the same site.
                <div className="mt-2">
                  <TrackerSnippet site={site} origin={origin} />
                </div>
              </Step>
              <Step n={2} title="Track the buttons that matter (optional)">
                A click on any element with <code>data-rt-goal</code> sends a goal. Goals show in the Goals tab and work in funnels and filters.
                <div className="mt-2">
                  <Code>{`<button data-rt-goal="signup_click">Get started</button>
<a href="/pricing" data-rt-goal="pricing_click" data-rt-goal-plan="pro">Pricing</a>

<script>
  window.founderdata('goal', 'signup', { plan: 'pro' });
  // After login: attach a name and email to the visitor
  window.founderdata('identify', { user_id: '123', email: 'jane@example.com', name: 'Jane' });
</script>`}</Code>
                </div>
                <p className="mt-2 text-[13px] text-stone-500">Outbound link clicks are tracked on their own, under Exit link.</p>
              </Step>
              <Step n={3} title="Leave out your own visits">
                Open <code>https://{site.domain}/?rt_ignore=true</code> once in each browser you use.
              </Step>
            </Steps>
          ) : (
            <TypeSetup site={site} type={type} origin={origin} />
          )}
          {type === 'website' && (
            <div className="mt-4 border-t border-stone-200/60 pt-3">
              <Note
                more={
                  <p>
                    A visitor who returns on another day counts as new. To recognise returning visitors, add <code>data-cookies="on"</code> once a visitor has consented, or call{' '}
                    <code>window.founderdata('consent', true)</code> from your consent tool, and <code>false</code> to withdraw.
                  </p>
                }
              >
                The script sets no cookies, so it needs no consent banner.
              </Note>
            </div>
          )}
        </Integration>
      )}
      {site.app_bundle_id ? (
        <Integration id="ios-sdk" site={site} mark={<Mark>{SetupIcons.appstore}</Mark>} title="iOS app SDK" desc="FounderDataKit sends app sessions, screens, goals and App Store purchases.">
          <Steps>
            <SdkSteps site={site} origin={origin} />
            <Step n={3} title="Events go to this endpoint">
              The server accepts them only from <code>{site.app_bundle_id}</code>.
              <div className="mt-2">
                <Code>{`${origin}/api/app/events`}</Code>
              </div>
            </Step>
          </Steps>
        </Integration>
      ) : (
        <p className="px-1 text-[13px] text-stone-500">
          Have an iOS app too? Add its bundle id under{' '}
          <a className="font-medium text-ink underline underline-offset-2" href="#general">
            Site, General
          </a>{' '}
          and its setup shows here.
        </p>
      )}
    </div>
  );
}
