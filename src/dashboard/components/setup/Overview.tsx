import type { ReactNode } from 'react';
import { navigate } from '../../App';
import { isViewer, type Site } from '../../lib/api';
import { isPro } from '../../lib/pro';
import { nextStep, progressOf, stepsOfSite, type SetupState, type Step } from '../../lib/setup';
import { useSetupState } from '../../lib/useSetupState';
import { Progress, StatusMark, WhoChip } from '../onboarding/parts';
import { hasWebsite } from '../../lib/siteKind';
import { SetupChecklist } from '../SetupChecklist';
import { Skeleton, StatusChip, Stagger } from '../ui';
import { SetupIcons } from './icons';
import { SettingsCard, type CardStatus } from './kit';
import { statusFor, useSetup, type SetupData } from './status';

const PROVIDERS: [string, string][] = [
  ['stripe', 'Stripe'],
  ['dodo', 'Dodo Payments'],
  ['lemonsqueezy', 'Lemon Squeezy'],
  ['polar', 'Polar'],
  ['paddle', 'Paddle'],
  ['gumroad', 'Gumroad'],
  ['revenuecat', 'RevenueCat'],
  ['api', 'Server API'],
];

interface Tile {
  id: string;
  title: string;
  icon: ReactNode;
  status: CardStatus | null;
}

/** A setup step's state as a card chip: done only on a real signal (lib/setup.ts). */
export function stepStatus(step: Step): CardStatus {
  const detail = step.evidence ?? step.next ?? undefined;
  switch (step.status) {
    case 'done':
      return { tone: 'ok', label: 'Working', detail };
    case 'waiting':
      return { tone: 'info', label: 'Waiting', detail };
    case 'broken':
      return { tone: 'error', label: 'Broken', detail };
    case 'todo':
      return { tone: 'warn', label: 'Needs setup', detail };
    case 'locked':
      return { tone: 'neutral', label: 'Pro', detail: step.outcome };
    default:
      return { tone: 'neutral', label: 'Off', detail };
  }
}

/**
 * Payments as one tile. With the setup state it is done only once a payment links to a visit: a saved secret is
 * Waiting. Without it (an older Worker), the providers that took a payment, or the one that refuses deliveries.
 */
function paymentsTile(site: Site, d: SetupData, state: SetupState | null): Tile {
  const all = PROVIDERS.map(([id, name]) => ({ id, name, s: statusFor(id, site, d)! }));
  const bad = all.find((p) => p.s.tone === 'error');
  const on = all.filter((p) => p.s.tone === 'ok');
  const waiting = all.filter((p) => p.s.tone === 'info');
  const id = bad?.id ?? on[0]?.id ?? waiting[0]?.id ?? 'payments';
  const pay = state?.steps.find((x) => x.id === `payments:${site.id}`);
  const link = state?.steps.find((x) => x.id === `attribution:${site.id}`);
  if (pay || link) {
    const worst = [pay, link].find((x) => x?.status === 'broken') ?? (pay && pay.status !== 'done' ? pay : link ?? pay)!;
    return { id, title: 'Payments', icon: SetupIcons.payments, status: stepStatus(worst) };
  }
  const status: CardStatus = bad
    ? { tone: 'error', label: 'Refused', detail: `${bad.name}: ${bad.s.detail}` }
    : on.length
      ? { tone: 'ok', label: 'Connected', detail: on.map((p) => p.name).join(', ') }
      : waiting.length
        ? { tone: 'info', label: 'Waiting', detail: `${waiting.map((p) => p.name).join(', ')}, no payment yet` }
        : { tone: 'warn', label: 'Needs setup', detail: 'No provider connected' };
  return { id, title: 'Payments', icon: SetupIcons.payments, status };
}

/** The setup step behind a tile, where there is one. */
function stepFor(tile: string, site: Site, state: SetupState | null): Step | undefined {
  if (!state) return undefined;
  const ids: Record<string, string[]> = {
    tracker: [`tracker:${site.id}`],
    'ios-sdk': [`sdk:${site.id}`],
    'app-store': [`apple:${site.id}`],
    agents: ['agent-key', 'agent-used'],
  };
  const steps = (ids[tile] ?? []).map((i) => state.steps.find((x) => x.id === i)).filter((x): x is Step => !!x);
  // Agents: the key first, then its first use.
  return steps.find((x) => x.status !== 'done' && x.status !== 'off') ?? steps[steps.length - 1];
}

function tilesFor(site: Site, d: SetupData, state: SetupState | null): { label: string; tiles: Tile[] }[] {
  const web = hasWebsite(site);
  const app = !!site.app_bundle_id;
  const t = (id: string, title: string, icon: ReactNode): Tile => {
    const step = stepFor(id, site, state);
    return { id, title, icon, status: step ? stepStatus(step) : statusFor(id, site, d) };
  };
  return [
    {
      label: 'Tracking and revenue',
      tiles: [
        ...(web ? [t('tracker', 'Website tracker', SetupIcons.install)] : []),
        ...(app ? [t('ios-sdk', 'iOS app SDK', SetupIcons.appstore)] : []),
        paymentsTile(site, d, state),
        ...(app ? [t('app-store', 'App Store purchases', SetupIcons.appstore)] : []),
      ],
    },
    {
      label: 'Growth',
      tiles: !isPro ? [] : [
        ...(web ? [t('google', 'Search Console', SetupIcons.seo)] : []),
        ...(web ? [t('meta-ads', 'Meta ads', SetupIcons.ads)] : []),
        ...(web ? [t('x-posts', 'X posts', SetupIcons.ads)] : []),
        ...(app ? [t('apple-search-ads', 'Apple Search Ads', SetupIcons.ads)] : []),
      ],
    },
    {
      label: isPro ? 'Agents and devices' : 'Agents and people',
      tiles: [
        t('agents', 'Agents', SetupIcons.agents),
        ...(isPro ? [t('iphone-app', 'iPhone app', SetupIcons.phone), t('alert-rules', 'Alert rules', SetupIcons.alerts)] : []),
        ...(isPro ? [] : [t('share', 'Share links', SetupIcons.link), t('team', 'Team', SetupIcons.sharing)]),
      ],
    },
    {
      label: 'Sharing',
      tiles: !isPro ? [] : [t('share', 'Share links', SetupIcons.link), t('team', 'Team', SetupIcons.sharing)],
    },
  ].filter((g) => g.tiles.length);
}

/** The one thing to do next: a broken integration first, then the install, payments, an agent, Search Console. */
function legacyNext(site: Site, d: SetupData, tiles: Tile[]): { title: string; text: string; href: string; cta: string } | null {
  const loaded = tiles.every((x) => x.status);
  if (!loaded) return null;
  const broken = tiles.find((x) => x.status?.tone === 'error');
  if (broken) return { title: `Fix ${broken.title}`, text: broken.status!.detail ?? broken.status!.label, href: `#${broken.id}`, cta: 'Open' };
  const install = tiles.find((x) => (x.id === 'tracker' || x.id === 'ios-sdk') && x.status?.tone !== 'ok');
  if (install) return { title: 'Install the tracker', text: 'Paste one tag, or let a coding agent add it.', href: '#install', cta: 'Install' };
  const pay = tiles.find((x) => x.title === 'Payments');
  if (pay && pay.status?.tone !== 'ok') return { title: 'Connect payments', text: 'Each sale then links to the visitor and source behind it.', href: '#payments', cta: 'Connect' };
  if (statusFor('agents', site, d)?.tone !== 'ok') return { title: 'Connect an agent', text: 'Make a key and paste one command into your agent.', href: '#agents', cta: 'New key' };
  if (isPro && hasWebsite(site) && statusFor('google', site, d)?.tone !== 'ok') return { title: 'Connect Search Console', text: 'Queries and positions next to the revenue each page brings.', href: '#google', cta: 'Connect' };
  return null;
}

/** The next step from the setup state, for this site and the deployment's own steps. */
function NextFromState({ step, site }: { step: Step; site: Site }) {
  // A step that lives on this page opens its card; anything else opens Get started on that step.
  const hash = step.url && /^\/settings(#[\w-]+)$/.exec(step.url)?.[1];
  const here = hash ?? (step.url?.startsWith(`/site/${site.id}/settings#`) ? step.url.slice(step.url.indexOf('#')) : null);
  return (
    <div className="card-inset mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <StatusMark status={step.status} />
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-ink">{step.title}</span>
          <WhoChip who={step.who} />
        </div>
        <div className="truncate text-[13px] text-stone-500" title={step.next ?? step.outcome}>
          {step.next ?? step.outcome}
        </div>
      </div>
      {here ? (
        <a className="btn-dark" href={here}>
          Open
        </a>
      ) : (
        <button type="button" className="btn-dark" onClick={() => navigate(`/get-started?step=${encodeURIComponent(step.id)}`)}>
          Open setup
        </button>
      )}
    </div>
  );
}

export function OverviewGroup({ site }: { site: Site }) {
  const setup = useSetup();
  const answer = useSetupState({ enabled: !isViewer() });
  // A state that does not know this site (a sample, a site added a second ago) leaves the cards to their own checks.
  const state = answer.state?.sites.some((x) => x.id === site.id) ? answer.state : null;
  const d = setup?.data;
  if (!d) return null;
  const groups = tilesFor(site, d, state);
  const tiles = groups.flatMap((g) => g.tiles);
  const known = tiles.filter((x) => x.status);
  // With the setup state, progress counts this site's steps and the deployment's own; done means a real signal.
  const fromState = state ? progressOf(stepsOfSite(state.steps, site.id, true)) : null;
  const stateNext = state ? nextStep(state, site.id) : null;
  const done = fromState ? fromState.done : known.filter((x) => x.status!.tone === 'ok').length;
  const total = fromState ? fromState.total : tiles.length;
  const next = state ? null : legacyNext(site, d, tiles);
  const loaded = !!fromState || known.length === tiles.length;
  return (
    <div className="space-y-4">
      <section className="card p-5" aria-label="Setup progress">
        <div className="text-micro uppercase text-stone-400">{fromState ? 'Setup' : 'Connected'}</div>
        {loaded ? (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-stat text-ink">{done}</span>
            <span className="text-stat text-stone-400">of {total}</span>
          </div>
        ) : (
          <Skeleton className="mt-2 h-7 w-20" />
        )}
        <p className="mt-0.5 text-[13px] text-stone-500">
          {fromState ? 'A step is done when its first real signal arrived: a visit, a linked payment, a key in use.' : 'A tracker is required, revenue needs one payment provider, the rest is optional.'}
        </p>
        {fromState ? (
          <div className="mt-4">
            <Progress done={fromState.done} total={fromState.total} label="Setup steps done" />
          </div>
        ) : (
          <div className="mt-4 flex gap-1" aria-hidden="true">
            {tiles.map((x) => (
              <span
                key={x.id + x.title}
                className={`h-1.5 flex-1 rounded-full transition-colors duration-slow ${
                  !x.status ? 'bg-stone-100' : x.status.tone === 'ok' ? 'bg-emerald-500' : x.status.tone === 'error' ? 'bg-red-500' : x.status.tone === 'warn' ? 'bg-amber-400' : x.status.tone === 'info' ? 'bg-sky-200' : 'bg-stone-200'
                }`}
              />
            ))}
          </div>
        )}
        {stateNext && <NextFromState step={stateNext} site={site} />}
        {next && (
          <div className="card-inset mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-white" aria-hidden="true">
              {SetupIcons.arrow}
            </span>
            <div className="min-w-0 flex-1 basis-60">
              <div className="text-sm font-semibold text-ink">{next.title}</div>
              <div className="truncate text-[13px] text-stone-500" title={next.text}>
                {next.text}
              </div>
            </div>
            <a className="btn-dark" href={next.href}>
              {next.cta}
            </a>
          </div>
        )}
      </section>

      {groups.map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h3 className="mb-2 mt-2 px-1 text-micro uppercase text-stone-400">{g.label}</h3>
          <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {g.tiles.map((x) => (
              <a key={x.id + x.title} href={`#${x.id}`} className="card card-hover group flex min-w-0 flex-col p-4">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-stone-50 text-stone-500 ring-1 ring-inset ring-stone-200/80 transition-colors duration-fast group-hover:text-ink" aria-hidden="true">
                    {x.icon}
                  </span>
                  {x.status ? <StatusChip tone={x.status.tone}>{x.status.label}</StatusChip> : <Skeleton className="h-[22px] w-20 rounded-full" />}
                </span>
                <span className="mt-3 truncate text-sm font-semibold text-ink">{x.title}</span>
                <span className="mt-0.5 block h-5 truncate text-[13px] text-stone-500" title={x.status?.detail}>
                  {x.status ? (x.status.detail ?? ' ') : <Skeleton className="mt-1 h-3.5 w-28" />}
                </span>
              </a>
            ))}
          </Stagger>
        </section>
      ))}

      <SettingsCard
        id="setup-checklist"
        title="Server setup"
        className="mt-2"
        desc="Secrets the server needs for every site, shown by name only."
      >
        <SetupChecklist />
      </SettingsCard>
    </div>
  );
}
