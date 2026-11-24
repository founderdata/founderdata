import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../App';
import { WritePoolLine } from '../components/CapBadge';
import { AddSite } from '../components/AddSite';
import { CopySummary } from '../components/CopySummary';
import { WorthALook } from '../components/home/Attention';
import { HomeHeader } from '../components/home/HomeHeader';
import { countLine, FirstRun, HomeError, HomeSkeleton, HowCounted } from '../components/home/HomeStates';
import { ProSlot } from '../components/ProSlot';
import { isPro } from '../lib/pro';
import { MoneyCard, PulseStrip } from '../components/home/MoneyCard';
import { Ranking } from '../components/home/Ranking';
import { PERIODS, PREVIOUS } from '../components/home/shared';
import { SiteCards } from '../components/home/SiteCards';
import { Payments, Sources } from '../components/home/SourcesPayments';
import type { HomeData } from '../components/home/types';
import { VisitorsChart } from '../components/home/VisitorsChart';
import { SetupCard } from '../components/onboarding/SetupCard';
import { LiveCard } from '../components/live/LiveCard';
import { Reveal, Skeleton, StatusChip } from '../components/ui';
import { api, isViewer } from '../lib/api';
import { cardDismissed, dismissCard, getStartedSkipped, homeSetupView } from '../lib/setup';
import { useApi } from '../lib/useApi';
import { useSetupState } from '../lib/useSetupState';
import type { GrowthData } from '../../shared/growth';

function usePeriod(): [string, (p: string) => void] {
  const read = () => {
    const p = new URLSearchParams(window.location.search).get('period');
    return PERIODS.some((x) => x.value === p) ? p! : '30d';
  };
  const [period, setPeriod] = useState(read);
  useEffect(() => {
    const on = () => setPeriod(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return [
    period,
    (p) => {
      window.history.replaceState(null, '', p === '30d' ? '/' : `/?period=${p}`);
      setPeriod(p);
    },
  ];
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

/**
 * All sites and apps. In Pro, what needs the owner comes first. Then money (revenue and MRR with the live globe beside them, then the four numbers behind the money),
 * then what changed (Worth a look, the agents' changes), then where to look (every site ranked, its card, the sources
 * and the latest payments). A period change keeps the old numbers on screen, dimmed, until the new ones tick in.
 */
export function Home() {
  const [period, setPeriod] = usePeriod();
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);
  // No tz: the server counts days in the reporting timezone, so Home, the iPhone and the read API show the same numbers.
  const res = useApi<HomeData>(`/api/home?period=${period}`, reload) as ReturnType<typeof useApi<HomeData>> & { isRefreshing?: boolean };
  const { data, error, loading } = res;
  // Ad spend, Search Console and AI checks for the Growth row: a request of its own, so it never holds up the rest.
  const growth = useApi<GrowthData>(isPro ? `/api/home/growth?period=${period}` : null, reload);
  const refreshing = res.isRefreshing ?? (loading && !!data);
  const viewer = isViewer();
  const sites = data?.sites;
  const hasApps = !!sites?.some((s) => s.hasApp);
  const hasSites = !!sites?.length;

  // Setup (GET /api/v1/setup): the first run opens Get started full screen, later Home pins the setup card.
  const setup = useSetupState({ enabled: !viewer });
  const [dismissed, setDismissed] = useState(() => cardDismissed());
  const setupView = homeSetupView(setup.state, { viewer, skipped: getStartedSkipped(), dismissed });
  useEffect(() => {
    if (setupView !== 'get-started') return;
    // Replace, so Back from Get started does not land here and bounce again. ?setup= (a sample) comes along.
    const sample = new URLSearchParams(window.location.search).get('setup');
    window.history.replaceState(null, '', `/get-started${sample ? `?setup=${encodeURIComponent(sample)}` : ''}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [setupView]);

  // Without the setup route (an older Worker), a deployment with no sites opens Add site at once, as before.
  useEffect(() => {
    if (data && !data.sites.length && !isViewer() && setup.ready && !setup.state) setAdding(true);
  }, [data, setup.ready, setup.state]);

  // ?demo=1 plays LiveCard's built-in fixture (screenshots, a deployment without traffic yet).
  const liveDemo = useMemo(() => new URLSearchParams(window.location.search).get('demo') === '1', []);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    window.dispatchEvent(new Event('ml:logout'));
  }

  // Data blocks dim while a new period loads; LiveCard does not depend on the period, so it stays bright.
  const dim = `transition-opacity duration-base ${refreshing ? 'opacity-60' : ''}`;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-3 sm:px-6 sm:pt-4">
      <HomeHeader period={period} onPeriod={setPeriod} hasApps={hasApps} viewer={viewer} showPeriod={!data || hasSites} onLogout={logout} />

      <div className="mt-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:mt-8">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-display text-ink">All sites and apps</h1>
          <div className="mt-1 flex min-h-5 items-center text-[13px] text-stone-500">
            {data ? (
              hasSites && (
                <p className="truncate">
                  {countLine(data.sites)}, against {PREVIOUS[period]}
                </p>
              )
            ) : error ? null : (
              <Skeleton className="h-3.5 w-64 max-w-full" />
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {viewer ? (
            <StatusChip tone="neutral" title="The viewer login only reads (docs/GUIDE.md, Viewer login).">
              Read-only login
            </StatusChip>
          ) : null}
          {data && hasSites && (
            <>
              <HowCounted tz={data.tz} sites={data.sites} />
              <CopySummary />
            </>
          )}
          {!viewer && hasSites && (
            <button className="btn-dark h-9 shrink-0 px-3.5" onClick={() => setAdding(true)}>
              <PlusIcon />
              <span className="sm:hidden">Add</span>
              <span className="hidden sm:inline">Add site or app</span>
            </button>
          )}
        </div>
      </div>

      <div className="mt-6">
        {error && data && (
          <div className="mb-4">
            <HomeError inline message={error} onRetry={() => setReload((n) => n + 1)} />
          </div>
        )}

        {setupView === 'card' && setup.state && (
          <Reveal className="mb-4">
            <SetupCard
              state={setup.state}
              sample={setup.sample}
              onDismiss={() => {
                dismissCard();
                setDismissed(true);
              }}
            />
          </Reveal>
        )}

        {!data || (!viewer && !setup.ready) || setupView === 'get-started' ? (
          error ? <HomeError inline={false} message={error} onRetry={() => setReload((n) => n + 1)} /> : <HomeSkeleton />
        ) : !hasSites ? (
          <Reveal>
            <FirstRun viewer={viewer} onAdd={() => setAdding(true)} />
          </Reveal>
        ) : (
          // One grid, so a phone can put LiveCard after the site list (order-*) and a wide screen beside the money.
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12" aria-busy={refreshing || undefined}>
            {/* What waits on the owner, the first three cards (FounderData Pro). It does not depend on the period. */}
            {isPro && !viewer && <ProSlot name="needsYouStrip" className="fd-reveal order-first lg:col-span-12" />}
            <Reveal className="order-1 lg:col-span-6">
              <div className={`h-full ${dim}`}>
                <MoneyCard data={data} />
              </div>
            </Reveal>
            <Reveal delay={60} className="order-5 lg:order-2 lg:col-span-6">
              <LiveCard demo={liveDemo || undefined} />
            </Reveal>
            <Reveal delay={90} className="order-2 lg:order-3 lg:col-span-12">
              <div className={dim}>
                <PulseStrip data={data} />
              </div>
            </Reveal>
            {/* Each site's growth plan, one line each (FounderData Pro). The slot draws nothing when no site has a plan. */}
            {isPro && <ProSlot name="planRow" sites={data.sites} className="fd-reveal order-2 lg:order-3 lg:col-span-12" />}
            {isPro && (
              <Reveal delay={105} className="order-2 lg:order-3 lg:col-span-12">
                <div className={`transition-opacity duration-base ${refreshing || growth.loading ? 'opacity-60' : ''}`}>
                  {/* Spend and revenue of the same period only: while they differ, the row shows its skeleton. */}
                  <ProSlot
                    name="growthRow"
                    sites={data.sites}
                    growth={growth.data && growth.data.period === data.period ? growth.data : null}
                    period={data.period}
                    minBase={data.minBase}
                    error={growth.error}
                    onRetry={() => setReload((n) => n + 1)}
                  />
                </div>
              </Reveal>
            )}
            {(data.attention.length > 0 || data.changes || (data.actions?.length ?? 0) > 0) && (
              <Reveal delay={120} className="order-3 lg:order-4 lg:col-span-12">
                <div className={dim}>
                  <WorthALook items={data.attention} actions={data.actions ?? []} changes={data.changes} sites={data.sites} />
                </div>
              </Reveal>
            )}
            <Reveal delay={150} className="order-4 lg:order-5 lg:col-span-12">
              <div className={dim}>
                <Ranking sites={data.sites} period={period} minBase={data.minBase} tz={data.tz} />
              </div>
            </Reveal>
            <Reveal delay={180} className="order-6 lg:col-span-12">
              <div className={dim}>
                <VisitorsChart series={data.series} granularity={data.range.granularity} />
              </div>
            </Reveal>
            <Reveal delay={210} className="order-7 mt-6 lg:col-span-12">
              <div className={dim}>
                <SiteCards sites={data.sites} period={period} minBase={data.minBase} granularity={data.range.granularity} />
              </div>
            </Reveal>
            <Reveal delay={240} className="order-8 mt-6 flex flex-col lg:col-span-7 [&>div]:flex-1">
              <div className={`flex flex-col [&>section]:flex-1 ${dim}`}>
                <Sources sources={data.sources} />
              </div>
            </Reveal>
            <Reveal delay={270} className="order-9 flex flex-col lg:col-span-5 lg:mt-6 [&>div]:flex-1">
              <div className={`flex flex-col [&>section]:flex-1 ${dim}`}>
                <Payments payments={data.payments} />
              </div>
            </Reveal>
          </div>
        )}
      </div>

      {data && hasSites && (
        // Fine print: days counted in the reporting timezone, and today's rows against the shared write pool.
        <footer className="mt-12 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-stone-200/60 pt-4 text-xs text-stone-400">
          <span>
            Days run on {data.tz} time, the reporting timezone.{' '}
            {!viewer && (
              <button className="underline underline-offset-2 transition-colors duration-fast hover:text-ink" onClick={() => navigate(`/site/${data.sites[0].id}/settings#reporting-timezone`)}>
                Change it
              </button>
            )}
          </span>
          <WritePoolLine className="" />
        </footer>
      )}
      <AddSite open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
