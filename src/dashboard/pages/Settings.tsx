import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../App';
import { ApiKeysSection } from '../components/ApiKeys';
import { DataLocationCard } from '../components/DataLocation';
import { Favicon } from '../components/Icons';
import { ImportHistory } from '../components/ImportHistory';
import { HomeLink } from '../components/Logo';
import { ProSlot } from '../components/ProSlot';
import { StripeImport } from '../components/PaymentProviders';
import { PrimaryGoalSection } from '../components/PrimaryGoal';
import { ProductTypeSection } from '../components/ProductType';
import { ReportingTimezoneSection } from '../components/ReportingTimezone';
import { ShareSection } from '../components/ShareSection';
import { SupportButton } from '../components/Support';
import { ThemeToggle } from '../components/ThemeToggle';
import { AlertsCard } from '../components/setup/Alerts';
import { AppStoreGroup } from '../components/setup/AppStore';
import { SetupIcons } from '../components/setup/icons';
import { ProCard, UpdatesCard } from '../components/setup/Updates';
import { InstallGroup } from '../components/setup/Install';
import { Integration, OpenCtx } from '../components/setup/Integration';
import { Mark, SettingsCard } from '../components/setup/kit';
import { OverviewGroup } from '../components/setup/Overview';
import { PaymentsGroup } from '../components/setup/Payments';
import { DatacenterCard, DeleteSiteCard, DevicesCard, ErasuresCard, GeneralCard, LinkBuilderCard, TeamCard, WriteCapCard } from '../components/setup/Sections';
import { CARDS, GROUPS, resolveHash, SetupProvider, statusFor, useSetup, type GroupId } from '../components/setup/status';
import { EmptyState, EmptyIcons, SkeletonText, StickyBar, toast } from '../components/ui';
import { api, isViewer, type Site } from '../lib/api';
import { isPro } from '../lib/pro';
import { hasWebsite, isAppOnly } from '../lib/siteKind';

/**
 * A site's settings as a place to navigate: a rail of groups on wide screens and a jump menu on phones, one group at
 * a time, every card reachable by its hash (#payments opens the group, #stripe opens the group and the Stripe card).
 * Old links such as #write-cap and #reporting-timezone land on their card.
 */
export function Settings({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [loadError, setLoadError] = useState('');
  const origin = window.location.origin;

  const load = useCallback(() => {
    setLoadError('');
    api<Site>(`/api/sites/${siteId}`).then(setSite, (e) => setLoadError((e as Error).message));
  }, [siteId]);
  useEffect(load, [load]);

  async function save(patch: Partial<Site>, msg = 'Saved') {
    try {
      const s = await api<Site>(`/api/sites/${siteId}`, { method: 'PATCH', json: patch });
      // PATCH answers without the provider status, usage, location and datacenter count; keep the last ones.
      setSite((old) => ({
        ...s,
        last_payments: s.last_payments ?? old?.last_payments,
        refused_webhooks: s.refused_webhooks ?? old?.refused_webhooks,
        usage: s.usage ?? old?.usage,
        data_location: s.data_location ?? old?.data_location,
        datacenter_visits: s.datacenter_visits ?? old?.datacenter_visits,
      }));
      toast(msg, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error', 6000);
    }
  }

  const appOnly = site ? isAppOnly(site) : false;
  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
      <StickyBar>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <HomeLink compact />
            <span className="text-stone-300" aria-hidden="true">
              /
            </span>
            {site ? (
              <button className="btn-ghost min-w-0 gap-2 px-2 font-semibold text-ink" onClick={() => navigate(`/site/${site.id}`)} title="Open the dashboard">
                {appOnly ? <span className="text-stone-500">{SetupIcons.phone}</span> : <Favicon domain={site.domain} size={18} />}
                <span className="truncate">{site.name}</span>
              </button>
            ) : (
              <span className="h-5 w-28 rounded bg-stone-100" />
            )}
            <span className="hidden text-stone-300 sm:inline" aria-hidden="true">
              /
            </span>
            <span className="hidden text-[13px] font-medium text-stone-500 sm:inline">Settings</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {site && (
              <button className="btn hidden sm:inline-flex" onClick={() => navigate(`/site/${site.id}`)}>
                Dashboard
              </button>
            )}
            <ThemeToggle />
            <SupportButton compact />
          </div>
        </div>
      </StickyBar>

      {loadError && (
        <div className="card mt-8">
          <EmptyState icon={EmptyIcons.plug} title="Settings did not load" action={<button className="btn" onClick={load}>Try again</button>}>
            {loadError}
          </EmptyState>
        </div>
      )}
      {!site && !loadError && (
        <div className="mt-8 lg:grid lg:grid-cols-[224px_minmax(0,1fr)] lg:gap-10">
          <div className="hidden space-y-2 lg:block">
            {GROUPS.map((g) => (
              <div key={g.id} className="h-8 rounded-lg bg-stone-100/60" />
            ))}
          </div>
          <div className="card p-5">
            <SkeletonText lines={4} />
          </div>
        </div>
      )}
      {site &&
        (isViewer() ? (
          // The viewer login reads stats only: no keys, secrets or devices (docs/GUIDE.md, "Viewer login").
          <div className="mx-auto mt-8 max-w-3xl space-y-4">
            <SettingsCard id="read-only" title="Read-only login" desc="You signed in with the viewer password, so this page shows no settings, keys or devices. The owner changes them with the admin password." />
            <ErasuresCard site={site} />
          </div>
        ) : (
          <SetupProvider site={site}>
            <SettingsBody site={site} setSite={setSite} save={save} origin={origin} />
          </SetupProvider>
        ))}
    </div>
  );
}

function SettingsBody({ site, setSite, save, origin }: { site: Site; setSite: (s: Site) => void; save: (p: Partial<Site>, m?: string) => Promise<void>; origin: string }) {
  const [route, setRoute] = useState(() => resolveHash(window.location.hash));
  const [open, setOpen] = useState<Set<string>>(() => new Set(route.card ? [route.card] : []));
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const setup = useSetup();

  useEffect(() => {
    const on = () => {
      const r = resolveHash(window.location.hash);
      moved.current = true;
      setRoute(r);
      if (r.card) setOpen((o) => new Set(o).add(r.card!));
    };
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);

  // A card in the hash scrolls into view once its group renders; a group alone starts at the top, with focus on its title.
  useLayoutEffect(() => {
    if (route.card) {
      const id = route.card;
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: 'start' });
        if (moved.current) (document.getElementById(`${id}-toggle`) ?? el).focus({ preventScroll: true });
      }
      // Cards above it may still be loading and grow. Keep the card in place until they settle, unless the person scrolls first.
      let touched = false;
      const stop = () => (touched = true);
      const opts = { passive: true, once: true } as const;
      window.addEventListener('wheel', stop, opts);
      window.addEventListener('touchstart', stop, opts);
      window.addEventListener('keydown', stop, opts);
      const timers = [400, 1000, 2000].map((ms) => window.setTimeout(() => !touched && document.getElementById(id)?.scrollIntoView({ block: 'start' }), ms));
      return () => {
        timers.forEach(clearTimeout);
        window.removeEventListener('wheel', stop);
        window.removeEventListener('touchstart', stop);
        window.removeEventListener('keydown', stop);
      };
    } else if (moved.current) {
      window.scrollTo({ top: 0 });
      heading.current?.focus({ preventScroll: true });
    }
  }, [route]);

  const ctx = useMemo(
    () => ({
      open,
      toggle: (id: string) =>
        setOpen((o) => {
          const n = new Set(o);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        }),
    }),
    [open],
  );

  const group = GROUPS.find((g) => g.id === route.group)!;
  const web = hasWebsite(site);
  // A dot on the rail for a group whose card is broken or waiting on you.
  const flag = (g: GroupId) => {
    if (!setup) return null;
    const tones = CARDS.filter((c) => c.group === g && c.tile && (!c.applies || c.applies(site))).map((c) => statusFor(c.id, site, setup.data)?.tone);
    return tones.includes('error') ? 'error' : tones.includes('warn') && (g === 'install' || g === 'payments') ? 'warn' : null;
  };
  const go = (id: string) => {
    history.pushState(null, '', `#${id}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  return (
    <OpenCtx.Provider value={ctx}>
      <div className="mt-6 lg:grid lg:grid-cols-[224px_minmax(0,1fr)] lg:gap-10">
        <nav className="hidden lg:block" aria-label="Settings">
          <div className="sticky top-20 space-y-0.5">
            <h1 className="mb-3 px-3 text-display text-ink">Settings</h1>
            {GROUPS.map((g) => {
              const active = g.id === route.group;
              const f = flag(g.id);
              return (
                <a
                  key={g.id}
                  href={`#${g.id}`}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-9 items-center gap-2.5 rounded-[10px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-fast ${
                    active ? 'bg-white text-ink shadow-card ring-1 ring-inset ring-stone-200/70' : 'text-stone-500 hover:bg-stone-100 hover:text-ink'
                  } ${g.id === 'danger' ? 'mt-3' : ''}`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${active ? 'text-ink' : 'text-stone-400'}`}>{SetupIcons[g.icon]}</span>
                  <span className="min-w-0 flex-1 truncate">{g.label}</span>
                  {f && (
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${f === 'error' ? 'bg-red-500' : 'bg-amber-500'}`} title={f === 'error' ? 'Something here is broken' : 'Something here needs setup'}>
                      <span className="sr-only">{f === 'error' ? 'Needs a fix' : 'Needs setup'}</span>
                    </span>
                  )}
                </a>
              );
            })}
          </div>
        </nav>

        <main className="min-w-0">
          <div className="lg:hidden">
            <h1 className="text-display text-ink">Settings</h1>
            <label className="sr-only" htmlFor="settings-jump">
              Section
            </label>
            <div className="relative mt-3">
              <select id="settings-jump" className="input appearance-none pr-9 font-medium" value={route.group} onChange={(e) => go(e.target.value)}>
                {GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                    {flag(g.id) === 'error' ? ' (needs a fix)' : flag(g.id) === 'warn' ? ' (needs setup)' : ''}
                  </option>
                ))}
              </select>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-stone-400" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>

          <div className="mb-4 mt-6 lg:mt-1">
            <h2 ref={heading} tabIndex={-1} id={`group-${group.id}`} className="text-[22px] font-semibold leading-7 tracking-tight text-ink outline-none">
              {group.label}
            </h2>
            <p className="mt-1 text-[13px] text-stone-500">{group.desc}</p>
          </div>

          <div key={group.id} className="space-y-4 animate-fade">
            {group.id === 'overview' && <OverviewGroup site={site} />}
            {group.id === 'install' && (
              <>
                <InstallGroup site={site} origin={origin} />
                {web && <LinkBuilderCard domain={site.domain} />}
              </>
            )}
            {group.id === 'site' && (
              <>
                <GeneralCard key={`${site.id}-${site.domain}-${site.app_bundle_id}-${site.app_store_id ?? ''}`} site={site} save={save} />
                <ProductTypeSection site={site} onSaved={(product_type) => setSite({ ...site, product_type })} />
                <ReportingTimezoneSection />
                <PrimaryGoalSection site={site} />
              </>
            )}
            {group.id === 'payments' && <PaymentsGroup site={site} origin={origin} save={save} onKey={(api_key) => setSite({ ...site, api_key })} />}
            {group.id === 'appstore' && <AppStoreGroup site={site} origin={origin} save={save} />}
            {group.id === 'seo' &&
              (web ? (
                <Integration id="google" site={site} mark={<Mark>G</Mark>} title="Google Search Console" desc="Sign in with Google once. The server pulls 16 months of queries, then a new day every day.">
                  <ProSlot name="googleConnect" site={site} bare />
                </Integration>
              ) : (
                <NotForApps what="Search Console" />
              ))}
            {group.id === 'ads' && (
              <>
                {web ? (
                  <>
                    <Integration id="meta-ads" site={site} mark={<Mark>M</Mark>} title="Meta ads" desc="Spend per campaign, ad set and ad next to the customers and revenue those ads brought. Can send purchases back to Meta.">
                      <ProSlot name="metaSettings" site={site} />
                    </Integration>
                    <Integration id="x-posts" site={site} mark={<Mark>X</Mark>} title="X posts" desc="Credit visits and revenue from X to the post that brought them, with your own X credentials.">
                      <ProSlot name="xSettings" siteId={site.id} domain={site.domain} />
                    </Integration>
                  </>
                ) : (
                  <NotForApps what="Meta ads and X posts" />
                )}
                <ProSlot name="adSpend" site={site} />
              </>
            )}
            {group.id === 'capture' &&
              (web ? (
                <>
                  {/* FounderData Pro's cards (round 7): ids catch-errors, click-maps and surveys. Each draws its own card. */}
                  <ProSlot name="catchErrors" site={site} save={save} />
                  <ProSlot name="clickMaps" site={site} save={save} />
                  <ProSlot name="surveys" site={site} save={save} />
                </>
              ) : (
                <NotForApps what="Errors, click maps and surveys" />
              ))}
            {group.id === 'agents-api' && (
              <>
                <ApiKeysSection site={site} />
                {isPro && <ProSlot name="iphoneApp" site={site} origin={origin} />}
                {isPro && <DevicesCard />}
              </>
            )}
            {group.id === 'alerts' && <AlertsCard site={site} />}
            {group.id === 'imports' && (
              <>
                {web && (
                  <SettingsCard id="import" title="Import web traffic" desc="Visits from before this site used FounderData, from Plausible or DataFast. Revenue, customers and visitor journeys stay as they are.">
                    <ImportHistory site={site} />
                  </SettingsCard>
                )}
                {isPro && (
                  <SettingsCard id="import-subscriptions" title="Import subscription history" desc="Past subscriptions from ChartMogul or RevenueCat, then a month-by-month check against the source.">
                    <ProSlot name="subscriptionHistoryImport" site={site} />
                  </SettingsCard>
                )}
                <SettingsCard id="stripe-import" title="Import past Stripe payments" desc="Charges from before the Stripe webhook was connected, read with a restricted key you paste once.">
                  <StripeImport site={site} />
                </SettingsCard>
              </>
            )}
            {group.id === 'sharing' && (
              <>
                <ShareSection site={site} />
                <TeamCard />
              </>
            )}
            {group.id === 'privacy' && (
              <>
                <DataLocationCard site={site} />
                <WriteCapCard site={site} save={save} />
                {web && <DatacenterCard site={site} save={save} />}
                {/* FounderData Pro's Record visits card (id record-visits) and its Remember visitors card (id remember-visitors). */}
                {isPro && web && <ProSlot name="recordVisits" site={site} save={save} />}
                <ErasuresCard site={site} />
              </>
            )}
            {group.id === 'product' && (
              <>
                <UpdatesCard />
                {!isPro && <ProCard />}
              </>
            )}
            {group.id === 'danger' && <DeleteSiteCard site={site} />}
          </div>
        </main>
      </div>
    </OpenCtx.Provider>
  );
}

function NotForApps({ what }: { what: string }) {
  return (
    <div className="card">
      <EmptyState
        icon={EmptyIcons.plug}
        title={`${what} ${what.includes(' and ') ? 'need' : 'needs'} a website`}
        action={
          <a className="btn" href="#general">
            Add a website
          </a>
        }
      >
        This is an iOS app without a domain. Add its website under Site, General.
      </EmptyState>
    </div>
  );
}
