import type { ReactNode } from 'react';
import type { Site } from '../../lib/api';
import { isPro } from '../../lib/pro';
import { hasWebsite } from '../../lib/siteKind';
import { SetupChecklist } from '../SetupChecklist';
import { Skeleton, StatusChip, Stagger } from '../ui';
import { SetupIcons } from './icons';
import { SettingsCard, type CardStatus } from './kit';
import { statusFor, useSetup, type SetupData } from './status';
import { hasApp } from '../../../shared/platform';

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

/** Payments as one tile: the providers that are connected, or the one that refuses deliveries. */
function paymentsTile(site: Site, d: SetupData): Tile {
  const all = PROVIDERS.map(([id, name]) => ({ id, name, s: statusFor(id, site, d)! }));
  const bad = all.find((p) => p.s.tone === 'error');
  const on = all.filter((p) => p.s.tone === 'ok');
  const status: CardStatus = bad
    ? { tone: 'error', label: 'Refused', detail: `${bad.name}: ${bad.s.detail}` }
    : on.length
      ? { tone: 'ok', label: 'Connected', detail: on.map((p) => p.name).join(', ') }
      : { tone: 'warn', label: 'Needs setup', detail: 'No provider connected' };
  return { id: bad?.id ?? on[0]?.id ?? 'payments', title: 'Payments', icon: SetupIcons.payments, status };
}

function tilesFor(site: Site, d: SetupData): { label: string; tiles: Tile[] }[] {
  const web = hasWebsite(site);
  const app = hasApp(site);
  const t = (id: string, title: string, icon: ReactNode): Tile => ({ id, title, icon, status: statusFor(id, site, d) });
  return [
    {
      label: 'Tracking and revenue',
      tiles: [
        ...(web ? [t('tracker', 'Website tracker', SetupIcons.install)] : []),
        ...(app ? [t('ios-sdk', 'iOS app SDK', SetupIcons.appstore)] : []),
        paymentsTile(site, d),
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
function nextStep(site: Site, d: SetupData, tiles: Tile[]): { title: string; text: string; href: string; cta: string } | null {
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

export function OverviewGroup({ site }: { site: Site }) {
  const setup = useSetup();
  const d = setup?.data;
  if (!d) return null;
  const groups = tilesFor(site, d);
  const tiles = groups.flatMap((g) => g.tiles);
  const known = tiles.filter((x) => x.status);
  const done = known.filter((x) => x.status!.tone === 'ok').length;
  const next = nextStep(site, d, tiles);
  const loaded = known.length === tiles.length;
  return (
    <div className="space-y-4">
      <section className="card p-5" aria-label="Setup progress">
        <div className="text-micro uppercase text-stone-400">Connected</div>
        {loaded ? (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-stat text-ink">{done}</span>
            <span className="text-stat text-stone-400">of {tiles.length}</span>
          </div>
        ) : (
          <Skeleton className="mt-2 h-7 w-20" />
        )}
        <p className="mt-0.5 text-[13px] text-stone-500">A tracker is required, revenue needs one payment provider, the rest is optional.</p>
        <div className="mt-4 flex gap-1" aria-hidden="true">
          {tiles.map((x) => (
            <span
              key={x.id + x.title}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-slow ${
                !x.status ? 'bg-stone-100' : x.status.tone === 'ok' ? 'bg-emerald-500' : x.status.tone === 'error' ? 'bg-red-500' : x.status.tone === 'warn' ? 'bg-amber-400' : 'bg-stone-200'
              }`}
            />
          ))}
        </div>
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
