import { warmQuery } from '../lib/prefetch';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import type { Overview, Query, Site } from '../lib/api';
import { quarterOf } from '../../worker/lib/time';
import { dayInTz } from '../lib/format';
import { SiteIcon } from './Icons';
import { HomeLink } from './Logo';
import { SupportButton } from './Support';
import { Check, ThemeToggle } from './ThemeToggle';
import { LiveDot } from './ui/LiveDot';
import { SegTrack } from './ui/Segmented';
import { StickyBar } from './ui/StickyBar';
import { isPro } from '../lib/pro';
import { SECTION_GROUPS, SECTION_LABELS, SECTION_SHORT_LABELS, sectionState, sectionUrl, type View } from '../lib/sections';
import { hasApp } from '../../shared/platform';

export const PERIODS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '48h', label: 'Last 2 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'thisquarter', label: 'This quarter' },
  { value: 'lastquarter', label: 'Last quarter' },
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];

/** "Q3 2026" for the first day of a quarter. */
const quarterName = (from: string) => `Q${Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1} ${from.slice(0, 4)}`;

/**
 * The first day of the calendar quarter the query shows, or null when it shows something else. A custom range counts
 * when it runs from a quarter's first day to its last day, or to today inside the current quarter.
 */
function shownQuarter(q: Query, today: string): string | null {
  if (q.period === 'thisquarter') return quarterOf(today).from;
  if (q.period === 'lastquarter') return quarterOf(today, -1).from;
  if (q.period !== 'custom' || !q.from || !q.to) return null;
  const quarter = quarterOf(q.from);
  if (q.from !== quarter.from) return null;
  return q.to === quarter.to || (q.to === today && today < quarter.to) ? quarter.from : null;
}

const GRANULARITIES = [
  { value: 'hour', label: 'Hourly', short: 'Hour' },
  { value: 'day', label: 'Daily', short: 'Day' },
  { value: 'week', label: 'Weekly', short: 'Week' },
  { value: 'month', label: 'Monthly', short: 'Month' },
];

export function Dropdown({ button, children, align = 'left', width = 'min-w-[200px]' }: { button: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', on);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', on);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="relative flex" ref={ref}>
      <div className="flex" onClick={() => setOpen((o) => !o)}>
        {button}
      </div>
      {open && (
        <div className={`pop pop-in absolute top-full z-40 mt-1.5 max-h-[70vh] overflow-y-auto p-1 ${width} ${align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-stone-400" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export function itemCls(active: boolean) {
  return `flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors duration-fast hover:bg-stone-100 focus-visible:bg-stone-100 ${active ? 'font-medium text-ink' : 'text-stone-600 hover:text-ink'}`;
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="px-2.5 pb-1 pt-2 text-micro uppercase text-stone-400">{children}</div>;
const MenuSep = () => <div className="my-1 border-t border-stone-200/70" />;

/** The quick periods on the segmented control; the rest sit in its menu. */
const QUICK = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: '12m', label: '12M' },
];

/** Opens the command palette (CommandPalette.tsx listens for it). */
export const openPalette = () => window.dispatchEvent(new Event('fd:palette'));

export function SearchButton() {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button className="btn w-9 px-0 text-stone-400 hover:text-ink md:w-auto md:min-w-[150px] md:justify-between md:gap-6 md:px-3" onClick={openPalette} aria-label="Search" aria-keyshortcuts="Meta+K Control+K">
      <span className="flex items-center gap-2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="hidden font-normal md:inline">Search</span>
      </span>
      <span className="kbd hidden md:inline-flex">{mac ? '⌘K' : 'Ctrl K'}</span>
    </button>
  );
}

/** Visitors on the site in the last 5 minutes. Green and pulsing only above 0, or it reads like a live status. */
export function OnlineChip({ count }: { count: number | null }) {
  if (count === null) return null;
  return (
    <span className="hidden h-9 items-center gap-2 px-1.5 text-[13px] text-stone-500 sm:inline-flex" title="Visitors in the last 5 minutes">
      <LiveDot on={count > 0} />
      <span className="tabular-nums"><span className={count > 0 ? 'font-medium text-ink' : ''}>{count}</span> online</span>
    </span>
  );
}

export function Toolbar({
  site,
  sites,
  q,
  update,
  overview,
  view,
  hidePeriod = false,
}: {
  site: Site;
  sites: Site[];
  q: Query;
  update: (p: Partial<Query>) => void;
  overview: Overview | null;
  view: View;
  /** The SEO tab has its own window (Search Console runs two days behind), so the period and step controls go. */
  hidePeriod?: boolean;
}) {
  const [from, setFrom] = useState(q.from ?? '');
  const [to, setTo] = useState(q.to ?? '');

  const today = dayInTz(Date.now(), site.timezone);
  const quarter = shownQuarter(q, today);
  const label =
    q.period === 'custom' && quarter
      ? quarterName(quarter)
      : q.period === 'custom'
      ? q.from === q.to
        ? new Date(q.from + 'T00:00:00Z').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        : `${q.from} → ${q.to}`
      : PERIODS.find((p) => p.value === q.period)?.label ?? 'Last 30 days';
  const quick = QUICK.some((p) => p.value === q.period);
  const granularity = q.granularity ?? overview?.range.granularity;

  function shift(dir: -1 | 1) {
    // A quarter steps by a calendar quarter; any other range by its own length.
    if (quarter) {
      const next = quarterOf(quarter, dir);
      if (next.from > today) return;
      if (next.from === quarterOf(today).from) update({ period: 'thisquarter' });
      else if (next.from === quarterOf(today, -1).from) update({ period: 'lastquarter' });
      else update({ period: 'custom', from: next.from, to: next.to });
      return;
    }
    if (!overview) return;
    const { from, to } = overview.range;
    const span = Math.max(to - from, 86_400_000);
    const nf = from + dir * span;
    const nt = nf + span - 1;
    if (nf > Date.now()) return;
    update({ period: 'custom', from: dayInTz(nf, site.timezone), to: dayInTz(Math.min(nt, Date.now()), site.timezone) });
  }
  const canForward = overview ? overview.range.to < Date.now() - 60_000 : false;
  const arrow = (dir: -1 | 1) => (
    <button
      className="btn-ghost hidden w-8 px-0 disabled:opacity-30 sm:inline-flex"
      onClick={() => shift(dir)}
      disabled={dir === 1 && !canForward}
      aria-label={dir === 1 ? 'Next period' : 'Previous period'}
      title={dir === 1 ? 'Next period' : 'Previous period'}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={dir === 1 ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} />
      </svg>
    </button>
  );

  return (
    <StickyBar>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
      <HomeLink compact />
      <Dropdown
        width="min-w-[240px]"
        button={
          <button className="btn gap-2 pl-2 pr-2.5">
            <SiteIcon domain={site.domain} app={hasApp(site)} size={18} />
            <span className="max-w-[130px] truncate font-semibold sm:max-w-[200px]">{site.name}</span>
            <Chevron />
          </button>
        }
      >
        {(close) => (
          <>
            <MenuLabel>Sites and apps</MenuLabel>
            {sites.map((s) => (
              <button
                key={s.id}
                className={itemCls(s.id === site.id)}
                onClick={() => {
                  close();
                  navigate(`/site/${s.id}${window.location.search}`);
                }}
              >
                <SiteIcon domain={s.domain} app={hasApp(s)} size={16} />
                <span className="truncate">{s.name}</span>
                {s.id === site.id && <Check />}
              </button>
            ))}
            <MenuSep />
            <button className={itemCls(false)} onClick={() => navigate('/')}>
              All sites and apps
            </button>
            <button className={itemCls(false)} onClick={() => navigate(`/site/${site.id}/settings`)}>
              Settings and install
            </button>
          </>
        )}
      </Dropdown>
      <div className="ml-auto flex items-center gap-1.5 sm:hidden">
        <SearchButton />
        <ThemeToggle />
      </div>

      <div className="flex w-full min-w-0 items-center gap-1.5 sm:ml-auto sm:w-auto">
        <OnlineChip count={overview?.online ?? null} />
        {!hidePeriod && (
          <>
            {arrow(-1)}
            <SegTrack className="min-w-0 flex-1 justify-between sm:flex-none" label="Period">
              {QUICK.map((p) => (
                <button key={p.value} aria-pressed={q.period === p.value} onMouseEnter={() => warmQuery({ period: p.value, granularity: undefined })} onFocus={() => warmQuery({ period: p.value, granularity: undefined })} onClick={() => update({ period: p.value, granularity: undefined, from: undefined, to: undefined })}>
                  {p.label}
                </button>
              ))}
              <Dropdown
                align="right"
                width="w-[240px]"
                button={
                  <button aria-pressed={!quick} className="flex h-full items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-[13px] font-medium text-stone-500 transition-colors duration-fast hover:text-ink aria-pressed:text-ink">
                    {quick ? 'More' : label}
                    <Chevron />
                  </button>
                }
              >
                {(close) => (
                  <>
                    <MenuLabel>Period</MenuLabel>
                    {PERIODS.filter((p) => !QUICK.some((x) => x.value === p.value)).map((p) => (
                      <button
                        key={p.value}
                        className={itemCls(q.period === p.value)}
                        onClick={() => {
                          close();
                          update({ period: p.value, granularity: undefined });
                        }}
                      >
                        {p.label}
                        {q.period === p.value && <Check />}
                      </button>
                    ))}
                    <MenuSep />
                    <form
                      className="space-y-2 p-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!from || !to) return;
                        close();
                        update({ period: 'custom', from, to: to < from ? from : to, granularity: undefined });
                      }}
                    >
                      <div className="text-micro uppercase text-stone-400">Custom range</div>
                      <input type="date" className="input py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
                      <input type="date" className="input py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
                      <button className="btn-dark w-full">Apply</button>
                    </form>
                    <MenuSep />
                    <MenuLabel>Group by</MenuLabel>
                    <div className="flex gap-1 px-1.5 pb-1.5">
                      {GRANULARITIES.map((g) => (
                        <button
                          key={g.value}
                          className={`flex-1 rounded-md py-1 text-[12px] font-medium transition-colors duration-fast ${granularity === g.value ? 'bg-stone-100 text-ink' : 'text-stone-500 hover:text-ink'}`}
                          onClick={() => {
                            close();
                            update({ granularity: g.value });
                          }}
                        >
                          {g.short}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </Dropdown>
            </SegTrack>
            {arrow(1)}
          </>
        )}
        <div className="hidden items-center gap-1.5 sm:flex">
          <SearchButton />
          <ThemeToggle />
          <SupportButton compact />
        </div>
      </div>
      </div>
      <SectionNav site={site} view={view} />
    </StickyBar>
  );
}

/**
 * Every section of the site in one row, grouped as Analytics, Organic, Paid and Revenue, each one click away. The
 * twelve fit on one line from 1280 px up; below that the row scrolls sideways under a fade, with the current section
 * scrolled into view. A section the site cannot use yet (no app, no website, no Meta account) stays in the row, muted
 * with a hollow dot, and opens its setup step. In core every section after the Overview is the Pro card: those tabs
 * carry a small Pro mark and the group labels step aside to keep the row on one line.
 */
export function SectionNav({ site, view }: { site: Site; view: View }) {
  return (
    <nav aria-label="Sections" className="mt-3 border-b border-stone-200/80 pb-2">
      <ScrollRow active={view}>
        <div className="flex w-max items-center">
          {SECTION_GROUPS.map((g, i) => (
            <div key={g.id} role="group" aria-label={g.label} className={`flex items-center gap-px ${i ? 'ml-1.5 border-l border-stone-200/80 pl-1.5' : ''}`}>
              {isPro && (
                <span className="hidden px-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-stone-400 lg:inline" aria-hidden="true">
                  {g.label}
                </span>
              )}
              {g.views.map((v) => {
                const on = v === view;
                const muted = sectionState(site, v).muted;
                const href = sectionUrl(site.id, v);
                const full = SECTION_LABELS[v];
                const short = SECTION_SHORT_LABELS[v];
                return (
                  <a
                    key={v}
                    href={href}
                    aria-current={on ? 'page' : undefined}
                    title={muted ? `${full} is not set up yet. Click for the setup step.` : short !== full ? full : undefined}
                    className={`tab flex items-center gap-1.5 whitespace-nowrap px-2 ${on ? 'tab-active' : muted ? 'text-stone-400' : 'text-stone-500'}`}
                    onClick={(e) => {
                      // A new tab or window keeps the browser's own behavior.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(href);
                    }}
                  >
                    {muted && <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-stone-400" aria-hidden="true" />}
                    {short === full ? (
                      full
                    ) : (
                      <>
                        <span aria-hidden="true">{short}</span>
                        <span className="sr-only">{full}</span>
                      </>
                    )}
                    {!isPro && v !== 'overview' && <span className="rounded border border-stone-200 px-[3px] text-[9px] font-medium uppercase leading-[14px] tracking-wide text-stone-400">Pro</span>}
                    {muted && <span className="sr-only"> (not set up)</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </div>
      </ScrollRow>
    </nav>
  );
}

/**
 * A row of tabs that scrolls sideways when it does not fit (a phone, a narrow window), bleeding into the page's px-3
 * gutter on phones, and keeps the active tab (`.tab-active`) in view, centered, whenever `active` changes. Each edge
 * with more tabs behind it fades out over 40 px, so a cut label always reads as "more this way"; on phones that edge
 * also gets a chevron button that scrolls one view further. When the row fits it is a plain row with no mask.
 */
export function ScrollRow({ active, children }: { active: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = () => {
    const row = ref.current;
    if (!row) return;
    const left = row.scrollLeft > 8;
    const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 8;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  };
  const reveal = () => {
    const row = ref.current;
    const tab = row?.querySelector<HTMLElement>('.tab-active');
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    const r = row.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    // Only when the tab is cut or touches a fade, then centered.
    if (t.left < r.left + 48 || t.right > r.right - 56) row.scrollLeft += (t.left + t.right) / 2 - (r.left + r.right) / 2;
  };
  useEffect(() => {
    reveal();
    measure();
  }, [active]);
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    if (row.firstElementChild) ro.observe(row.firstElementChild);
    // Labels change width when the web font arrives: place the active tab again once it has.
    document.fonts?.ready.then(() => {
      reveal();
      measure();
    });
    return () => ro.disconnect();
  }, []);
  const mask = `linear-gradient(to right, transparent, #000 ${more.left ? 40 : 0}px, #000 calc(100% - ${more.right ? 48 : 0}px), transparent)`;
  const by = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.6, behavior: 'smooth' });
  const chevron = (dir: 1 | -1) => (
    <button
      type="button"
      className={`absolute top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-card sm:hidden ${dir === 1 ? 'right-1' : 'left-1'}`}
      onClick={() => by(dir)}
      aria-label={dir === 1 ? 'More tabs' : 'Earlier tabs'}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={dir === 1 ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} />
      </svg>
    </button>
  );
  return (
    <div className="relative -mx-3 min-w-0 max-w-[calc(100%+1.5rem)] sm:mx-0 sm:max-w-full">
      <div
        ref={ref}
        onScroll={measure}
        className="snap-x snap-mandatory scroll-px-3 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&_.tab]:snap-start sm:snap-none sm:px-0"
        style={more.left || more.right ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        {children}
      </div>
      {more.left && chevron(-1)}
      {more.right && chevron(1)}
    </div>
  );
}
