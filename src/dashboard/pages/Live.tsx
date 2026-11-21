import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../App';
import { Favicon, Flag } from '../components/Icons';
import { HomeLink } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { Segmented } from '../components/ui/Segmented';
import { LiveGlobe } from '../components/live/Globe';
import {
  ACCENT,
  LiveDot,
  LiveStyles,
  TickingNumber,
  eventAmount,
  eventVerb,
  pageLabel,
  paymentTotals,
  placeLabel,
  recentEvents,
  shortAgo,
  siteName,
  sourceLabel,
  useNow,
  usePresence,
} from '../components/live/shared';
import type { LiveData, LiveEvent, LiveSite, LiveVisitor } from '../components/live/types';
import { feedVisitors, windowActivity } from '../components/live/adapter';
import { useLive } from '../components/live/useLive';
import { currencyDecimals, fmtMoney, fmtNumber } from '../lib/format';

/**
 * The time the page covers. `now` shows the visitors online (seen in the last 5 minutes) and the last hour's payments.
 * A longer window shows that window instead: how many visitors it had, on which sites, who they were, what was paid,
 * and a glow on the globe wherever they were.
 */
export type GlobeWindow = 'now' | '30m' | '1h' | '24h';
const WINDOW_MINUTES: Record<GlobeWindow, number | null> = { now: null, '30m': 30, '1h': 60, '24h': 1440 };
const WINDOW_LABEL: Record<GlobeWindow, string> = { now: 'Now', '30m': '30 min', '1h': '1 h', '24h': '24 h' };
const WINDOW_HEADING: Record<GlobeWindow, string> = { now: 'Last hour', '30m': 'Last 30 minutes', '1h': 'Last hour', '24h': 'Last 24 hours' };
const WINDOW_TEXT: Record<GlobeWindow, string> = { now: 'right now', '30m': 'in the last 30 minutes', '1h': 'in the last hour', '24h': 'in the last 24 hours' };
const WINDOW_KEY = 'fd_live_window';

function readWindow(): GlobeWindow {
  try {
    const v = localStorage.getItem(WINDOW_KEY);
    return v && v in WINDOW_MINUTES ? (v as GlobeWindow) : 'now';
  } catch {
    return 'now';
  }
}

/**
 * The live view at /live: who is on your sites right now, on a globe, with the count, the sites, the last hour's
 * payments and a feed of visitors. Made to stay open on a second screen: big type, no scrolling on a desktop, and
 * a fullscreen button. `?demo=1` plays the built-in demo.
 */
export function Live() {
  const [span, setSpan] = useState<GlobeWindow>(readWindow);
  useEffect(() => {
    try {
      localStorage.setItem(WINDOW_KEY, span);
    } catch {}
  }, [span]);
  const live = useLive({ placesMinutes: WINDOW_MINUTES[span] });
  const data = live.data;
  const places = span === 'now' ? NONE : data?.places ?? NONE;
  // The globe draws the events of its window: the online minutes for `now`, at most the hour the server sends.
  const events = useMemo(() => (data ? recentEvents(data.events, data.now, WINDOW_MINUTES[span] ?? data.windowMinutes) : []), [data, span]);
  // Everyone the chosen window lists, and how many it had. The count comes from the server, because the list stops at
  // 150; a visitor who arrived since the server counted is in the list already, so the larger of the two is shown.
  const visitors = useMemo(() => feedVisitors(data, span !== 'now'), [data, span]);
  const count = span === 'now' ? data?.online ?? 0 : Math.max(data?.recentCount ?? 0, visitors.length);
  const [hover, setHover] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The tab title carries the count, so the tab says it even when another one is in front.
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);
  useEffect(() => {
    if (data) document.title = `${data.online} online · FounderData`;
  }, [data?.online]);

  return (
    <div ref={root} className="flex min-h-screen flex-col bg-paper text-ink lg:h-screen lg:min-h-[640px] lg:overflow-hidden">
      <LiveStyles />
      <Header live={live} root={root} span={span} setSpan={setSpan} />
      {live.status === 'unsupported' ? (
        <Notice title="Live view needs a newer server" body="This server has no live endpoint yet. Deploy the latest FounderData, then come back here." demo />
      ) : live.status === 'error' && !data ? (
        <Notice title="Live data did not load" body="The page asks again on its own, less often after each miss." retry={live.refresh} demo />
      ) : (
        <main className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-4 px-4 pb-5 sm:px-6 lg:min-h-0 lg:grid-cols-[minmax(270px,1fr)_minmax(0,2.1fr)_minmax(300px,1.15fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-6 lg:px-8 lg:pb-8 lg:[grid-template-areas:'hero_globe_feed'_'side_globe_feed'] 2xl:gap-8">
          <section className="lg:[grid-area:hero]">
            <Hero data={data} loading={live.status === 'loading'} span={span} visitors={visitors} count={count} />
          </section>
          <section className="relative aspect-square w-full lg:aspect-auto lg:max-h-none lg:min-h-0 lg:[grid-area:globe]">
            <LiveGlobe visitors={data?.visitors ?? []} places={places} events={events} highlightId={hover} onHover={setHover} fill={0.88} />
          </section>
          <section className="flex flex-col gap-4 lg:min-h-0 lg:[grid-area:side]">
            <Sites data={data} span={span} />
            <Activity data={data} span={span} hover={hover} setHover={setHover} />
          </section>
          <section className="flex flex-col lg:min-h-0 lg:[grid-area:feed]">
            <Feed data={data} span={span} visitors={visitors} count={count} hover={hover} setHover={setHover} />
          </section>
        </main>
      )}
    </div>
  );
}

const NONE: LiveData['places'] = [];

function Header({ live, root, span, setSpan }: { live: ReturnType<typeof useLive>; root: React.RefObject<HTMLDivElement>; span: GlobeWindow; setSpan: (w: GlobeWindow) => void }) {
  const now = useNow(1000);
  const [full, setFull] = useState(false);
  const canFull = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.current?.requestFullscreen().catch(() => {});
  };

  let status: React.ReactNode;
  if (live.demo) status = 'Demo data, not your sites';
  else if (live.stale) status = <span className="text-amber-700">Connection lost. Retrying.</span>;
  else if (live.updatedAt) status = `Updated ${shortAgo(now - live.updatedAt) === 'now' ? 'just now' : `${shortAgo(now - live.updatedAt)} ago`}`;

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 px-4 sm:px-6 lg:h-20 lg:px-8">
      <HomeLink compact />
      <button className="btn-ghost -ml-1 hidden sm:inline-flex" onClick={() => navigate('/')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        Home
      </button>
      <div className="ml-1 flex min-w-0 items-center gap-2.5 border-l border-stone-200 pl-3 sm:ml-2 sm:pl-4">
        <LiveDot size={9} quiet={live.status !== 'ready'} />
        <h1 className="text-[17px] font-semibold tracking-tight lg:text-[19px]">Live</h1>
        <span className="hidden truncate text-[13px] text-stone-400 sm:inline">{status}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Segmented
          label="Time window"
          size="sm"
          className="[&>button]:whitespace-nowrap"
          value={span}
          onChange={setSpan}
          options={(Object.keys(WINDOW_LABEL) as GlobeWindow[]).map((w) => ({
            value: w,
            label: WINDOW_LABEL[w],
            title: w === 'now' ? 'Who is online now' : `Everyone who visited ${WINDOW_TEXT[w]}`,
          }))}
        />
        {canFull && (
          <button className="btn hidden h-8 px-2.5 sm:inline-flex" onClick={toggle} aria-pressed={full} title={full ? 'Leave fullscreen (Esc)' : 'Fill the screen'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
            </svg>
            <span className="hidden sm:inline">{full ? 'Exit fullscreen' : 'Fullscreen'}</span>
          </button>
        )}
        <ThemeToggle small />
      </div>
    </header>
  );
}

function Notice({ title, body, retry, demo }: { title: string; body: string; retry?: () => void; demo?: boolean }) {
  return (
    <main className="grid flex-1 place-items-center px-6 pb-16">
      <div className="max-w-md text-center">
        <div className="text-[22px] font-semibold tracking-tight">{title}</div>
        <p className="mt-2 text-[14px] leading-relaxed text-stone-500">{body}</p>
        <div className="mt-5 flex justify-center gap-2">
          {retry && (
            <button className="btn-dark" onClick={retry}>
              Try again
            </button>
          )}
          {demo && (
            <button className="btn" onClick={() => (window.location.href = '/live?demo=1')}>
              Watch the demo
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

const panel = 'card p-4 lg:p-5 2xl:p-6';
const heading = 'text-micro uppercase text-stone-400 2xl:text-[13px]';

function Hero({ data, loading, span, visitors, count }: { data: LiveData | null; loading: boolean; span: GlobeWindow; visitors: LiveVisitor[]; count: number }) {
  if (loading || !data) {
    return (
      <div aria-busy>
        <div className="fd-live-skel h-[clamp(56px,7vw,150px)] w-40 rounded-2xl bg-stone-100" />
        <div className="fd-live-skel mt-3 h-4 w-48 rounded bg-stone-100" />
      </div>
    );
  }
  const past = span !== 'now';
  const sitesOn = past ? windowSites(data).length : data.sites.filter((s) => s.online > 0).length;
  // The tags count the listed visitors, so they are left out when the list is cut short.
  const complete = visitors.length >= count;
  const appOn = complete ? visitors.filter((v) => v.platform === 'app').length : 0;
  const customers = complete ? visitors.filter((v) => v.customer).length : 0;
  const across = sitesOn === 1 ? 'On 1 site' : `Across ${sitesOn} sites`;
  let label: string;
  let sub: string;
  if (past) {
    label = count === 0 ? `Nobody visited ${WINDOW_TEXT[span]}` : `${count === 1 ? 'visitor' : 'visitors'} ${WINDOW_TEXT[span]}`;
    sub = count === 0 ? 'A visitor shows up here about 15 seconds after opening a page.' : `${across} · ${data.online} online now`;
  } else {
    label = count === 0 ? 'Nobody online right now' : count === 1 ? 'person online now' : 'people online now';
    sub = count === 0 ? 'A visitor shows up here about 15 seconds after opening a page.' : `${across} in the last ${data.windowMinutes} minutes`;
  }
  return (
    <div>
      <div className="flex items-end gap-3">
        <span className="text-[clamp(64px,7.2vw,168px)] font-semibold leading-[0.85] tracking-[-0.04em]">
          <TickingNumber value={count} />
        </span>
      </div>
      <div className="mt-3 text-[15px] font-medium text-stone-600 lg:text-[17px] 2xl:text-[20px]">{label}</div>
      <div className="mt-1 text-[13px] text-stone-400 2xl:text-[15px]">{sub}</div>
      {(appOn > 0 || customers > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5 text-[12px] 2xl:text-[14px]">
          {appOn > 0 && <span className="rounded-full border border-stone-200 px-2 py-0.5 text-stone-600">{appOn} in an app</span>}
          {customers > 0 && (
            <span className="rounded-full bg-revenueSoft px-2 py-0.5 font-medium text-revenue">{customers === 1 ? '1 customer' : `${customers} customers`}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The sites of a window with their visitor counts, most first. A site whose visitors arrived after the server counted
 * shows at least the ones online now.
 */
function windowSites(data: LiveData): LiveSite[] {
  const by = new Map<string, LiveSite>(data.recentSites.map((s) => [s.id, { id: s.id, name: s.name, domain: s.domain, online: s.visitors }]));
  for (const s of data.sites) {
    const had = by.get(s.id);
    if (!had || had.online < s.online) by.set(s.id, s);
  }
  return [...by.values()].filter((s) => s.online > 0).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
}

/** Visitors per site: online now, or seen in the chosen window. */
function Sites({ data, span }: { data: LiveData | null; span: GlobeWindow }) {
  const past = span !== 'now';
  const sites = useMemo(() => (!data ? [] : past ? windowSites(data) : data.sites), [data, past]);
  if (!data || sites.length === 0) return null;
  const shown = sites.slice(0, 8);
  const rest = sites.length - shown.length;
  const max = Math.max(1, ...shown.map((s) => s.online));
  return (
    <div className={panel}>
      <div className="flex items-baseline justify-between gap-3">
        <div className={heading}>Sites</div>
        <div className="text-[12px] text-stone-400">{past ? 'Visitors' : 'Online now'}</div>
      </div>
      <ul className="mt-3 space-y-2.5 2xl:space-y-3.5">
        {shown.map((s) => (
          <SiteRow key={s.id} site={s} max={max} />
        ))}
      </ul>
      {rest > 0 && <div className="mt-3 text-[12px] text-stone-400">{past ? `${rest} more sites` : `${rest} more with nobody online`}</div>}
    </div>
  );
}

function SiteRow({ site, max }: { site: LiveSite; max: number }) {
  const idle = site.online === 0;
  return (
    <li className={`transition-opacity duration-500 ${idle ? 'opacity-45' : ''}`}>
      <div className="flex items-center gap-2.5">
        <Favicon domain={site.domain} size={18} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium 2xl:text-[16px]">{site.name}</span>
        <span className="text-[16px] font-semibold tabular-nums 2xl:text-[19px]">
          <TickingNumber value={site.online} />
        </span>
      </div>
      <div className="ml-[28px] mt-1.5 h-1 overflow-hidden rounded-full bg-stone-100">
        <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${(site.online / max) * 100}%`, background: ACCENT }} />
      </div>
    </li>
  );
}

/** Payments, trials and sign-ups: the last hour for `now`, or the chosen window. */
function Activity({ data, span, hover, setHover }: { data: LiveData | null; span: GlobeWindow; hover: string | null; setHover: (id: string | null) => void }) {
  const now = useNow(5000);
  const minutes = WINDOW_MINUTES[span];
  const { events, totals, count } = useMemo(() => {
    if (!data) return { events: [], totals: [], count: 0 };
    if (minutes === null) return { events: data.events, totals: paymentTotals(data.events), count: data.events.filter((e) => e.kind === 'payment').length };
    const w = windowActivity(data, minutes);
    return { events: w.events, totals: w.revenue, count: w.revenue.reduce((n, r) => n + r.payments, 0) };
  }, [data, minutes]);
  // Names for the rows: `data.sites` has only the sites with someone online.
  const sites = useMemo(() => (data && minutes !== null ? windowSites(data) : data?.sites ?? []), [data, minutes]);
  // Every row of the window; the list scrolls on a desktop, where the page itself does not.
  const rows = usePresence(events, (e) => e.key, 260);
  // Rows that arrive after the page opened flash once.
  const mounted = useRef(Date.now());
  if (!data) return null;
  return (
    <div className={`${panel} flex flex-col lg:min-h-0`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className={heading}>{WINDOW_HEADING[span]}</div>
        {count > 0 && <div className="text-[12px] text-stone-400">{count === 1 ? '1 payment' : `${count} payments`}</div>}
      </div>
      {totals.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 text-[28px] font-semibold tracking-tight text-revenue 2xl:text-[36px]">
          {totals.map((t) => (
            <span key={t.currency} className="tabular-nums">
              <TickingNumber value={t.amount} format={(n) => fmtMoney(n, t.currency, currencyDecimals(t.currency))} />
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[13px] text-stone-400">No payments {span === 'now' ? 'in the last hour' : WINDOW_TEXT[span]}.</div>
      )}
      {rows.length > 0 && (
        <ul className="-mx-2 mt-3 max-h-[420px] space-y-0.5 overflow-y-auto pr-1 [scrollbar-width:thin] lg:max-h-none lg:min-h-0 lg:flex-1">
          {rows.map(({ item: e, key, leaving }) => (
            <EventRow key={key} e={e} sites={sites} now={now} leaving={leaving} fresh={e.ts > mounted.current - 15_000} lit={hover === e.key} setHover={setHover} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EventRow({ e, sites, now, leaving, fresh, lit, setHover }: { e: LiveEvent; sites: LiveSite[]; now: number; leaving: boolean; fresh: boolean; lit: boolean; setHover: (id: string | null) => void }) {
  const money = e.kind === 'payment';
  const site = siteName(sites, e.siteId);
  return (
    <li
      onMouseEnter={() => setHover(e.key)}
      onMouseLeave={() => setHover(null)}
      className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors 2xl:text-[15px] ${leaving ? 'fd-live-out' : 'fd-live-in'} ${fresh && money ? 'fd-live-flash' : ''} ${lit ? 'bg-stone-100' : ''}`}
    >
      <Flag cc={e.country} size={16} />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className={`font-semibold ${money ? 'text-revenue' : 'text-ink'}`}>{money ? eventAmount(e) ?? 'Payment' : eventVerb(e)}</span>
          <span className="text-stone-500"> · {placeLabel(e)}</span>
        </div>
        {(site || (money && e.label)) && <div className="truncate text-[12px] text-stone-400 2xl:text-[13px]">{[site, money ? e.label : null].filter(Boolean).join(' · ')}</div>}
      </div>
      <span className="shrink-0 tabular-nums text-[12px] text-stone-400">{shortAgo(now - e.ts)}</span>
    </li>
  );
}

/**
 * The visitors of the chosen window. `now` lists who is online. A longer window lists everyone seen in it, newest
 * first: the people online come from every poll, the rest from the window's list, which the page refreshes every few
 * minutes (useLive).
 */
function Feed({ data, span, visitors, count, hover, setHover }: { data: LiveData | null; span: GlobeWindow; visitors: LiveVisitor[]; count: number; hover: string | null; setHover: (id: string | null) => void }) {
  const now = useNow(5000);
  const online = useMemo(() => new Set((data?.visitors ?? []).map((v) => v.id)), [data]);
  const sites = useMemo(() => (data && span !== 'now' ? windowSites(data) : data?.sites ?? []), [data, span]);
  const rows = usePresence(visitors, (v) => v.id, 260);
  const past = span !== 'now';
  const capped = past && count > visitors.length;
  return (
    <div className={`${panel} flex flex-col lg:min-h-0 lg:max-h-full`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className={heading}>{past ? 'Visitors' : 'Visitors now'}</div>
        {data && visitors.length > 0 && (
          <div className="whitespace-nowrap text-[12px] text-stone-400">{capped ? `Latest ${visitors.length} of ${fmtNumber(count)}` : 'Newest first'}</div>
        )}
      </div>
      {!data ? (
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="fd-live-skel h-9 rounded-lg bg-stone-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-2 text-[13px] text-stone-400">{past ? `Nobody visited ${WINDOW_TEXT[span]}.` : 'Nobody here right now.'}</div>
      ) : (
        <ul className="-mx-2 mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {rows.map(({ item: v, key, leaving }) => (
            <VisitorRow key={key} v={v} sites={sites} now={now} leaving={leaving} online={!past || online.has(v.id)} dot={past && online.has(v.id)} lit={hover === v.id} setHover={setHover} />
          ))}
        </ul>
      )}
    </div>
  );
}

const DEVICE: Record<string, string> = { desktop: 'Desktop', mobile: 'Phone', tablet: 'Tablet' };

/** "4 min ago", "3 h ago": when a visitor who left was last seen. */
const lastSeen = (ms: number) => {
  const t = shortAgo(ms);
  return t === 'now' ? 'just now' : `${t} ago`;
};

function VisitorRow({ v, sites, now, leaving, online, dot, lit, setHover }: { v: LiveVisitor; sites: LiveSite[]; now: number; leaving: boolean; online: boolean; dot: boolean; lit: boolean; setHover: (id: string | null) => void }) {
  const site = sites.find((s) => s.id === v.siteId);
  const meta = [sourceLabel(v.source), v.device ? DEVICE[v.device] : v.platform === 'app' ? 'App' : null].filter(Boolean).join(' · ');
  return (
    <li
      onMouseEnter={() => setHover(v.id)}
      onMouseLeave={() => setHover(null)}
      className={`flex items-center gap-3 rounded-lg px-2 py-2 transition-colors ${leaving ? 'fd-live-out' : 'fd-live-in'} ${lit ? 'bg-stone-100' : ''}`}
    >
      <Flag cc={v.country} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {dot && (
            <span className="shrink-0" title="Online now">
              <LiveDot size={6} />
            </span>
          )}
          <span className="truncate text-[13.5px] font-medium 2xl:text-[15px]">{placeLabel(v)}</span>
          {v.customer && <span className="shrink-0 rounded-md bg-revenueSoft px-1.5 py-px text-[10.5px] font-semibold text-revenue">Customer</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-stone-400 2xl:text-[13px]">
          {site && <Favicon domain={site.domain} size={12} />}
          <span className="max-w-[62%] shrink-0 truncate font-mono text-[11.5px] text-stone-600 2xl:text-[12.5px]">{pageLabel(v)}</span>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">{meta}</span>
        </div>
      </div>
      {online ? (
        <span className="shrink-0 tabular-nums text-[12px] text-stone-400" title="Time on the site">
          {shortAgo(now - v.startedAt)}
        </span>
      ) : (
        <span className="shrink-0 tabular-nums text-[12px] text-stone-400" title="Last seen">
          {lastSeen(now - v.lastSeenAt)}
        </span>
      )}
    </li>
  );
}
