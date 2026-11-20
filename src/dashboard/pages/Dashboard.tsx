import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { GoalsPanel } from '../components/GoalsPanel';
import { OverviewCard } from '../components/OverviewCard';
import { Panel, renderLabel } from '../components/Panel';
import { RevenuePanel } from '../components/RevenuePanel';
import { Toolbar } from '../components/Toolbar';
import { RouteFallback } from '../components/ui/RouteFallback';
import { ProSlot } from '../components/ProSlot';
import { useChartNotes, useNoteImpacts } from '../components/ChartNotes';
import { VisitorModal } from '../components/VisitorModal';
import { isViewer, qs, type Overview, type Site } from '../lib/api';
import { DashContext, useDash, type Dash } from '../lib/context';
import { currencyDecimals, fmtDateTime, fmtMoney } from '../lib/format';
import { Views } from '../lib/pages';
import { useApi } from '../lib/useApi';
import { useQueryState } from '../lib/useQueryState';
import { isAppOnly } from '../lib/siteKind';
import { SiteTimezoneNote } from '../components/ReportingTimezone';
import { sectionState, viewsFor, type SectionSetup, type View } from '../lib/sections';
import { closeVisitor as closeVisitorUrl, openVisitor as openVisitorUrl, useSearchParam } from '../lib/urlState';
import { EmptyIcons, EmptyState } from '../components/ui/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import { BREAKDOWN_CARDS, PLATFORM_CARD, type BreakdownTab } from '../../shared/dashboard-tabs';

/**
 * A session property key as people read it: exp_paywall_copy becomes "Experiment paywall_copy". A copy of
 * propLabel in components/AppSection.tsx: importing that one would pull the whole App section into this chunk.
 */
function propLabel(filterKey: string): string | null {
  const key = /^prop:(.+)$/.exec(filterKey)?.[1];
  if (!key) return null;
  return key.startsWith('exp_') ? `Experiment ${key.slice(4)}` : `Property ${key}`;
}

const FILTER_LABELS: Record<string, { label: string; dim: string }> = {
  channel: { label: 'Channel', dim: 'channel' },
  source: { label: 'Referrer', dim: 'source' },
  utm_campaign: { label: 'Campaign', dim: 'campaign' },
  utm_term: { label: 'Keyword', dim: 'keyword' },
  utm_source: { label: 'UTM source', dim: 'utm_source' },
  utm_medium: { label: 'UTM medium', dim: 'utm_medium' },
  ref: { label: 'Ref', dim: 'ref' },
  country: { label: 'Country', dim: 'country' },
  region: { label: 'Region', dim: 'region' },
  city: { label: 'City', dim: 'city' },
  browser: { label: 'Browser', dim: 'browser' },
  os: { label: 'OS', dim: 'os' },
  device: { label: 'Device', dim: 'device' },
  page: { label: 'Visited page', dim: 'page' },
  entry_page: { label: 'Entry page', dim: 'entry_page' },
  exit_page: { label: 'Exit page', dim: 'exit_page' },
  hostname: { label: 'Hostname', dim: 'hostname' },
  platform: { label: 'Platform', dim: 'platform' },
  app_version: { label: 'App version', dim: 'app_version' },
  language: { label: 'Language', dim: 'language' },
  click_network: { label: 'Ad click', dim: 'click_network' },
  goal: { label: 'Completed goal', dim: 'goal' },
};

/** Overview for the whole site, the website or the app. It sets the platform filter ("Web" or "iOS"). */
function PlatformSwitch({ value, onChange }: { value: string | undefined; onChange: (platform: string | null) => void }) {
  return (
    <Segmented
      size="sm"
      label="Platform"
      options={[
        { label: 'Web and app', value: 'all' },
        { label: 'Web', value: 'Web' },
        { label: 'App', value: 'iOS' },
      ]}
      value={value ?? 'all'}
      onChange={(v) => onChange(v === 'all' ? null : v)}
    />
  );
}

export function Dashboard({ siteId, view }: { siteId: string; view: View }) {
  const [q, update] = useQueryState();
  const [reloadKey, setReloadKey] = useState(0);
  // The open visitor lives in ?visitor=, so Back closes the profile and a link can open it.
  const visitor = useSearchParam('visitor');
  const openVisitor = useCallback((id: string) => openVisitorUrl(id), []);
  const closeVisitor = () => closeVisitorUrl();
  const { data: sites, outdated: sitesOutdated } = useApi<Site[]>('/api/sites');
  const site = sites?.find((s) => s.id === siteId);
  const { data: overview } = useApi<Overview>(site ? `/api/sites/${siteId}/overview?${qs(q)}` : null, reloadKey);
  // Fresh numbers when you come back to the tab after a minute or more; there is no refresh button.
  useEffect(() => {
    let last = Date.now();
    const on = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 60_000) return;
      last = Date.now();
      setReloadKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // The site's other sections load when the browser is idle, so the section menu opens them without a wait.
  const sections = site ? viewsFor(site).join() : '';
  useEffect(() => {
    if (!sections) return;
    const run = () => {
      for (const v of sections.split(',') as View[]) if (v !== 'overview') Views[v].preload();
    };
    const id = 'requestIdleCallback' in window ? (window as any).requestIdleCallback(run, { timeout: 4000 }) : setTimeout(run, 1500);
    return () => ('cancelIdleCallback' in window ? (window as any).cancelIdleCallback(id) : clearTimeout(id));
  }, [sections]);

  const addFilter = useCallback((key: string, value: string) => update({ filters: { ...q.filters, [key]: value } }), [q.filters, update]);
  const removeFilter = (key: string) => {
    const { [key]: _, ...rest } = q.filters;
    update({ filters: rest });
  };

  const dash: Dash | null = useMemo(() => {
    if (!site) return null;
    const decimals = overview?.decimals ?? 2;
    return {
      site,
      q,
      reloadKey,
      decimals,
      money: (minor, compact) => fmtMoney(minor, site.currency, decimals, compact),
      moneyIn: (minor, currency) =>
        currency === site.currency ? fmtMoney(minor, currency, decimals) : fmtMoney(minor, currency, currencyDecimals(currency)),
      addFilter,
      openVisitor,
    };
  }, [site, q, reloadKey, overview?.decimals, addFilter, openVisitor]);

  // A list from before a write (a site was just added) may not hold this site yet: wait for the fresh one.
  if (sites && !site && !sitesOutdated) {
    return (
      <div className="p-10 text-center">
        Site not found.{' '}
        <button className="underline" onClick={() => navigate('/')}>
          Back to websites
        </button>
      </div>
    );
  }
  // The sites list is not here yet (a cached one makes this a single frame): hold the page's shape.
  if (!dash || !site) return <RouteFallback kind="site" />;
  // An app with no website: a placeholder domain, or no web visit in the last 90 days.
  const appOnly = !!site.app_bundle_id && (isAppOnly(site) || overview?.kind === 'app');
  // Platform splits web from app, so it says something only for a site with both and no platform filter. App versions
  // exist only for app sessions. A website alone gets neither, rather than a card with one "Web" row.
  const platformTabs = PLATFORM_CARD.filter((t) =>
    t.dim === 'platform' ? !!site.app_bundle_id && !appOnly && !q.filters.platform : !!site.app_bundle_id && q.filters.platform !== 'Web',
  );

  const filters = Object.entries(q.filters);
  // A site with a web and an app side switches between them in the Overview's chart header, which also shows the state: no chip for it.
  // An app with no web visits has nothing to switch to.
  const platformSwitch = view === 'overview' && !!site.app_bundle_id && !appOnly;
  const shownFilters = platformSwitch ? filters.filter(([k]) => k !== 'platform') : filters;
  // A section this site cannot use yet (no app, no website, no subscription provider) shows its setup step instead.
  const setup = sectionState(site, view).setup;
  const banner = 'mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200/60 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900';
  return (
    <DashContext.Provider value={dash}>
      <div className="mx-auto max-w-[1240px] px-3 pb-10 pt-4 sm:px-6 sm:pt-6">
        <Toolbar
          site={site}
          sites={sites!}
          q={q}
          update={update}
          overview={overview}
          view={view}
          hidePeriod={!!setup || view === 'plan' || view === 'seo' || view === 'ai' || view === 'aso' || view === 'people' || (view === 'content' && window.location.pathname.includes('/content/page/'))}
        />
        <SiteTimezoneNote site={site} />

        {site.capped_at && (
          <div className={banner}>
            {site.write_cap
              ? `This site hit its daily write cap at ${fmtDateTime(site.capped_at, site.timezone)}.`
              : `Your sites used up the rows they share under the automatic write cap at ${fmtDateTime(site.capped_at, site.timezone)}.`}{' '}
            Until 00:00 UTC, website events are dropped and the app holds its events on the phone, sending them after the reset.{' '}
            <button className="font-medium underline underline-offset-2" onClick={() => navigate(`/site/${site.id}/settings#write-cap`)}>
              Change the cap
            </button>
          </div>
        )}

        {site.app_rejected_at && !site.app_bundle_id && (
          <div className={banner}>
            An iOS app sent events to this site at {fmtDateTime(site.app_rejected_at, site.timezone)}, and the server refused them because the site
            has no bundle id. The app drops refused events.{' '}
            <button className="font-medium underline underline-offset-2" onClick={() => navigate(`/site/${site.id}/settings#general`)}>
              Add the bundle id
            </button>
          </div>
        )}

        {shownFilters.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {shownFilters.map(([k, v]) => (
              <span key={k} className="flex h-8 items-center gap-1.5 rounded-[10px] border border-stone-200/80 bg-white pl-3 pr-1 text-[13px] shadow-card">
                <span className="text-stone-400">{FILTER_LABELS[k]?.label ?? propLabel(k) ?? k}</span>
                <span className="flex items-center gap-1.5 font-medium">{renderLabel(FILTER_LABELS[k]?.dim ?? k, { label: v || null })}</span>
                <button className="flex h-6 w-6 items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-ink" onClick={() => removeFilter(k)} aria-label="Remove filter">
                  ✕
                </button>
              </span>
            ))}
            {shownFilters.length > 1 && (
              <button className="btn-ghost h-8 px-2" onClick={() => update({ filters: {} })}>
                Clear all
              </button>
            )}
          </div>
        )}

        <div className="mt-4">
          {setup ? (
            <SectionSetupState setup={setup} siteId={site.id} />
          ) : view === 'overview' ? (
            <OverviewView
              overview={overview}
              platformTabs={platformTabs}
              controls={platformSwitch ? <PlatformSwitch value={q.filters.platform} onChange={(p) => (p ? addFilter('platform', p) : removeFilter('platform'))} /> : undefined}
            />
          ) : (
            // Each section is its own chunk; the toolbar above stays put while it loads.
            <Suspense fallback={<RouteFallback kind="section" />}>
              {view === 'plan' ? (
                <Views.plan />
              ) : view === 'seo' ? (
                <Views.seo />
              ) : view === 'ai' ? (
                <Views.ai />
              ) : view === 'content' ? (
                <Views.content />
              ) : view === 'app' ? (
                <Views.app overview={overview} />
              ) : view === 'aso' ? (
                <Views.aso />
              ) : view === 'appstore' ? (
                <Views.appstore />
              ) : view === 'subscriptions' ? (
                <Views.subscriptions />
              ) : view === 'paid' ? (
                <Views.paid />
              ) : view === 'ads' ? (
                <Views.ads />
              ) : view === 'asa' ? (
                <Views.asa />
              ) : view === 'people' ? (
                <Views.people />
              ) : view === 'recordings' ? (
                <Views.recordings />
              ) : (
                <Views.dropoff appOnly={appOnly} />
              )}
            </Suspense>
          )}
        </div>

        <p className="mt-10 text-center text-xs text-stone-400">
          {/* The SEO tab mixes two clocks: Search Console counts Pacific days, FounderData the site's timezone. */}
          {view === 'seo' ? `Search Console days: Pacific. FounderData: ${site.timezone}` : `Times in ${site.timezone}`} · {site.currency}
          {site.app_bundle_id ? ', App Store gross' : ''} ·{' '}
          <button className="underline-offset-2 hover:text-ink hover:underline" onClick={() => navigate(`/site/${site.id}/settings`)}>
            Settings and install
          </button>
        </p>
      </div>
      <VisitorModal key={visitor ?? 'none'} visitorId={visitor} onClose={closeVisitor} />
    </DashContext.Provider>
  );
}

/** The one-screen setup step of a muted section: what it needs and the Settings card that does it. Viewers get the text only. */
function SectionSetupState({ setup, siteId }: { setup: SectionSetup; siteId: string }) {
  return (
    <div className="card">
      <EmptyState
        icon={EmptyIcons.plug}
        title={setup.title}
        action={
          isViewer() ? undefined : (
            <button className="btn-dark" onClick={() => navigate(`/site/${siteId}/settings#${setup.settings}`)}>
              {setup.action}
            </button>
          )
        }
      >
        {setup.body}
        {isViewer() && ' The owner does this in Settings.'}
      </EmptyState>
    </div>
  );
}

/** The Overview: KPI row and chart, four breakdowns, revenue by provider, the customers, goals and changes, and email. */
function OverviewView({ overview, platformTabs, controls }: { overview: Overview | null; platformTabs: BreakdownTab[]; controls?: ReactNode }) {
  const { site } = useDash();
  // Chart notes (ChartNotes.tsx): markers on the chart and the Changes tab under the breakdowns.
  const notes = useChartNotes();
  const impacts = useNoteImpacts(notes.list);
  const payments = site.payments_connected !== false;
  return (
    <>
      <OverviewCard data={overview} notes={notes} controls={controls} />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* The four breakdown cards (src/shared/dashboard-tabs.ts); each keeps its open tab in ?tab=. */}
        {BREAKDOWN_CARDS.map((tabs) => (
          <Panel key={tabs[0].dim} tabs={tabs} />
        ))}
        {platformTabs.length > 0 && <Panel key={platformTabs.map((t) => t.dim).join()} tabs={platformTabs} />}
        {/* A site with no payments connected has no revenue to break down (home.ts paymentsConnected). Alone in its row, it takes the whole row. */}
        {payments && (
          <div className={platformTabs.length ? 'grid' : 'grid lg:col-span-2'}>
            <RevenuePanel />
          </div>
        )}
      </div>
      <ProSlot name="xPosts" />
      {/* Visits worth watching (FounderData Pro): one small card when a recorded visit scores 40 or more. */}
      <ProSlot name="recordingsCard" />
      <div className="mt-4">
        <GoalsPanel totalVisitors={overview?.current.visitors ?? 0} notes={notes} impacts={impacts} />
      </div>
      {/* Resend delivery numbers (pro/worker/email.ts), or one line that opens the setup steps (none for a viewer). */}
      <ProSlot name="email" />
    </>
  );
}
