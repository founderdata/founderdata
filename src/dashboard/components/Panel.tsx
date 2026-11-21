import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BreakdownTab } from '../../shared/dashboard-tabs';
import { qs, type BreakdownRow } from '../lib/api';
import { ASA_DIMS } from '../lib/asaDims';
import { clickNetworkSource } from '../../shared/sources';
import { useDash } from '../lib/context';
import { countryName, fmtNumber, fmtPct, languageName } from '../lib/format';
import { navigate } from '../lib/nav';
import { rowActions, type RowAction } from '../lib/rowActions';
import { useApi } from '../lib/useApi';
import { useUrlTab } from '../lib/urlState';
import { BrowserIcon, ChannelIcon, DeviceIcon, Favicon, Flag, Glyph, OSIcon, PlatformIcon, SourceIcon } from './Icons';
import { AsaName } from './AsaNameSlot';
import { ExportButton } from './ExportButton';
import { Modal } from './Modal';
import { Num, Row, Table } from './site/primitives';
import { EmptyIcons, EmptyState } from './ui/EmptyState';
import { SkeletonRows } from './ui/Skeleton';
import { TabRow } from './ui/Tabs';
import { isPro } from '../lib/pro';
import { DEFAULT_LABELS } from '../../shared/surveys';

/** A breakdown tab: its label, dimension and the session filter a row click adds (src/shared/dashboard-tabs.ts). */
export type TabDef = BreakdownTab;

/** Dimensions the server also answers by first touch (src/worker/stats.ts FIRST_TOUCH_DIMS, docs/GUIDE.md "First touch"). */
const FIRST_TOUCH_DIMS = new Set(['channel', 'source', 'campaign', 'referrer_domain', 'entry_page']);
type Model = 'last' | 'first';

/** Last or first touch, for the panels whose tab has both. */
function ModelToggle({ model, onChange }: { model: Model; onChange: (m: Model) => void }) {
  const opt = (m: Model, label: string, title: string) => (
    <button
      type="button"
      aria-pressed={model === m}
      title={title}
      className={`rounded-md px-2 py-1 text-xs font-medium transition-colors duration-fast ${model === m ? 'bg-stone-100 text-ink' : 'text-stone-400 hover:bg-stone-100 hover:text-ink'}`}
      onClick={() => onChange(m)}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Credit revenue to">
      {opt('last', 'Last touch', 'Credits the visit each payment came from.')}
      {opt('first', 'First touch', "Credits the visitor's first visit. Rows don't filter in this view.")}
    </div>
  );
}

/** How each dimension's label and icon are shown. */
export function renderLabel(dim: string, row: Pick<BreakdownRow, 'label' | 'extra'> & { name?: string | null }): ReactNode {
  const l = row.label;
  const text = (s: ReactNode) => <span className="truncate">{s}</span>;
  switch (dim) {
    case 'channel':
      return (
        <>
          <ChannelIcon channel={l} />
          {text(l)}
        </>
      );
    case 'source':
      return (
        <>
          <SourceIcon source={l} domain={row.extra} />
          {text(l ?? 'Direct/None')}
        </>
      );
    case 'country':
      return (
        <>
          <Flag cc={l} />
          {text(countryName(l))}
        </>
      );
    case 'language':
      return text(languageName(l));
    case 'click_network':
      return (
        <>
          <SourceIcon source={clickNetworkSource(l) ?? null} domain={null} />
          {text(clickNetworkSource(l) ?? l ?? 'None')}
        </>
      );
    case 'region':
    case 'city':
      return (
        <>
          <Flag cc={row.extra ?? null} />
          {text(l ?? 'Unknown')}
        </>
      );
    case 'browser':
      return (
        <>
          <BrowserIcon name={l} />
          {text(l)}
        </>
      );
    case 'os':
      return (
        <>
          <OSIcon name={l} />
          {text(l)}
        </>
      );
    case 'device':
      return (
        <>
          <DeviceIcon name={l} />
          {text(l)}
        </>
      );
    case 'hostname':
      return (
        <>
          {l?.startsWith('ios:') ? <PlatformIcon name="iOS" /> : <Favicon domain={l} />}
          {text(l)}
        </>
      );
    case 'platform':
      return (
        <>
          <PlatformIcon name={l} />
          {text(l)}
        </>
      );
    case 'exit_link': {
      let host: string | null = null;
      try {
        host = l ? new URL(l).hostname : null;
      } catch {}
      return (
        <>
          <Favicon domain={host} />
          {text(l?.replace(/^https?:\/\/(www\.)?/, ''))}
        </>
      );
    }
    // Apple Search Ads ids show as their names once imported (pro/worker/asa.ts); other values as they are.
    case 'campaign':
    case 'keyword':
    case 'utm_content':
      return l ? text(<AsaName kind={ASA_DIMS[dim]} id={l} name={row.name} />) : text(<span className="text-stone-400">(none)</span>);
    // How did you hear about us: the answer, then the channels those visitors arrived by (src/worker/surveys.ts).
    case 'heard_about': {
      const tracked = (row as { tracked?: { channel: string; visitors: number }[] }).tracked ?? [];
      return (
        <>
          {text(DEFAULT_LABELS.heard_about[l ?? ''] ?? l)}
          {tracked.length > 0 && (
            <span className="hidden min-w-0 shrink truncate text-xs text-stone-400 sm:inline" title={`Tracked as ${tracked.map((t) => `${t.channel} (${t.visitors})`).join(', ')}`}>
              Tracked as {tracked.map((t) => t.channel).join(', ')}
            </span>
          )}
        </>
      );
    }
    default:
      return text(l ?? <span className="text-stone-400">(none)</span>);
  }
}

/** The Heard about tab without answers: where to turn the question on (Pro) or how to send answers (core). */
function NoAnswers({ siteId }: { siteId: string }) {
  return (
    <EmptyState compact icon={EmptyIcons.chart} title="No answers yet">
      Ask new customers where they heard about you.{' '}
      {isPro ? (
        <a className="underline underline-offset-2 hover:text-ink" href={`/site/${siteId}/settings#surveys`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(`/site/${siteId}/settings#surveys`); }}>
          Turn on the question
        </a>
      ) : (
        <a className="underline underline-offset-2 hover:text-ink" href="https://github.com/founderdata/founderdata/blob/main/docs/API.md#survey-answers" target="_blank" rel="noreferrer">
          Send answers with founderdata('answer')
        </a>
      )}
    </EmptyState>
  );
}

type Sort = 'visitors' | 'revenue' | 'perVisitor';

/** The number columns of a panel: their header and each row use the same widths, so the numbers line up. */
const COL = { visitors: 'w-[64px]', revenue: 'w-[76px]', perVisitor: 'w-[84px]' } as const;

/** What the Revenue column counts on each tab. A page view isn't a session, so pages count customers who viewed them. */
function revenueHint(dim: string): string {
  if (dim === 'page') return 'Revenue from customers who viewed this page in the period. A customer who viewed 3 pages counts on each of them.';
  if (dim === 'exit_link') return 'Exit links have no revenue.';
  return 'Revenue from payments linked to these visits. The coral line under each row is its revenue against the top row.';
}

const perVisitor = (r: BreakdownRow) => (r.visitors ? r.revenue / r.visitors : 0);

/** Column headers on the right of the panel: Visitors, Revenue and, for entry pages, revenue per visitor. Click to sort. */
function Columns({ cols, sort, onSort, dim, earns }: { cols: Sort[]; sort: Sort; onSort?: (s: Sort) => void; dim: string; earns: boolean }) {
  // The swatches look like the marks in the rows: a soft blue block for visitors, a thin coral line for revenue.
  const meta: Record<Sort, { label: string; swatch?: string; title: string }> = {
    visitors: { label: 'Visitors', swatch: 'h-2 w-2 rounded-[3px] bg-visitors', title: 'Unique visitors. The blue bar behind each row is its visitors against the top row.' },
    revenue: { label: 'Revenue', swatch: 'h-2 w-2 rounded-[3px] bg-revenue', title: revenueHint(dim) },
    perVisitor: { label: 'Per visitor', title: 'Revenue divided by visitors. The page that brings the most money per visit.' },
  };
  return (
    <div className="flex shrink-0 items-center self-end pr-2.5 text-xs font-medium text-stone-400 sm:self-auto lg:self-end xl:self-auto">
      {cols.map((c) => {
        const m = meta[c];
        // Nothing earned in this view: the money columns dim, and keep their sort button.
        const quiet = !earns && c !== 'visitors';
        const body = (
          <>
            {m.swatch && <span className={`shrink-0 ${m.swatch} ${quiet ? 'opacity-40' : ''}`} aria-hidden="true" />}
            <span className={sort === c ? 'text-ink' : quiet ? 'text-stone-300' : ''}>{m.label}</span>
            {onSort && sort === c && <span className="text-ink" aria-hidden="true">↓</span>}
          </>
        );
        return onSort ? (
          <button key={c} className={`${COL[c]} flex items-center justify-end gap-1 whitespace-nowrap hover:text-ink`} onClick={() => onSort(c)} title={`${m.title} Click to sort.`} aria-pressed={sort === c}>
            {body}
          </button>
        ) : (
          <span key={c} className={`${COL[c]} flex items-center justify-end gap-1 whitespace-nowrap`} title={m.title}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

function Bars({ rows, dim, tab, sort, cols, limit, onPick, earns }: { rows: BreakdownRow[]; dim: string; tab: TabDef; sort: Sort; cols: Sort[]; limit?: number; onPick?: (r: BreakdownRow) => void; earns: boolean }) {
  const { money, site } = useDash();
  // The row whose menu is open: its hover card stays hidden so the two never overlap.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  // No payments connected (home.ts paymentsConnected): the tooltip leaves out revenue, customers and conversion.
  const noPay = site.payments_connected === false;
  const value = (r: BreakdownRow) => (sort === 'perVisitor' ? perVisitor(r) : (r[sort] ?? 0));
  const sorted = useMemo(() => [...rows].sort((a, b) => value(b) - value(a) || b.visitors - a.visitors), [rows, sort]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  const maxV = Math.max(1, ...rows.map((r) => r.visitors));
  const maxR = Math.max(1, ...rows.map((r) => r.revenue));
  const hasRevenue = earns;
  const dash = <span className="text-stone-300">–</span>;
  // Bars grow from the left on first paint, then glide to new widths. They move by transform only: each bar is as wide
  // as its row and slides in from the left edge, so its rounded end keeps its shape at every width.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const slide = (pct: number, i: number) => ({
    transform: `translateX(calc(${grown ? `max(${pct.toFixed(2)}%, 4px)` : '0px'} - 100%))`,
    transition: `transform var(--dur-slower) var(--ease-out) ${grown ? 0 : i * 24}ms`,
  });

  return (
    <div className="space-y-0.5">
      {shown.map((r, i) => {
        // Visitors fill the row from the left; revenue is a thin coral line along its bottom, each on its own scale,
        // so the two never share an edge or blend into one color.
        const vw = (r.visitors / maxV) * 100;
        const rw = hasRevenue ? (Math.max(0, r.revenue) / maxR) * 100 : 0;
        const special = r.appStore || r.noVisit;
        const filters = !!tab.filter && !special;
        // The row is a group, not a button: the filter is a button laid over the whole row, and the arrow menu sits
        // beside it, so neither control is nested in the other and screen readers reach both.
        return (
          <div key={`${r.label}-${i}`} className="group relative flex h-9 items-center rounded-lg">
            <div className="absolute inset-0 overflow-hidden rounded-lg">
              {r.visitors > 0 && <div className="h-full w-full rounded-lg bg-visitorsSoft" style={slide(vw, i)} />}
              {rw > 0 && <div className="absolute bottom-[3px] left-0 h-[2px] w-full rounded-full bg-revenue/90" style={slide(rw, i)} />}
            </div>
            <div className="absolute inset-0 rounded-lg bg-stone-900/[0.035] opacity-0 transition-opacity duration-fast group-hover:opacity-100 dark:bg-white/[0.04]" />
            {filters && (
              <button
                type="button"
                aria-label={`Filter by ${r.name ?? r.label ?? '(none)'}`}
                className="absolute inset-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                onClick={() => onPick?.(r)}
              />
            )}
            <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-sm">
              {special ? <span className="truncate">{r.label}</span> : renderLabel(dim, r)}
            </div>
            <div className="pointer-events-none relative flex shrink-0 items-center pr-2.5 text-sm tabular-nums">
              {!special && (
                <span className="pointer-events-auto">
                  <RowMenu
                    label={r.name ?? r.label ?? ''}
                    actions={rowActions(site, dim, r, window.location.search)}
                    onFilter={tab.filter ? () => onPick?.(r) : undefined}
                    onOpenChange={(o) => setMenuFor(o ? i : null)}
                  />
                </span>
              )}
              {cols.map((c) => (
                <span key={c} className={`${COL[c]} text-right ${c === 'visitors' ? 'font-medium' : 'text-stone-500'}`}>
                  {c === 'visitors'
                    ? special
                      ? dash
                      : fmtNumber(r.visitors)
                    : !earns
                      ? null
                      : c === 'revenue'
                        ? r.revenue
                          ? money(r.revenue, true)
                          : dash
                        : r.visitors && r.revenue
                          ? money(perVisitor(r))
                          : dash}
                </span>
              ))}
            </div>
            <div className={`pop pointer-events-none invisible absolute left-1/2 top-full z-30 mt-1 w-60 -translate-x-1/2 translate-y-[-2px] space-y-0.5 px-3 py-2.5 text-xs text-stone-700 opacity-0 transition-[opacity,transform,visibility] duration-fast ${menuFor === i ? '' : 'group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-hover:delay-150'}`}>
              <div className="mb-1 truncate font-medium">{r.name ? `${r.name} (${r.label})` : (r.label ?? '(none)')}</div>
              <div className="flex justify-between"><span className="text-stone-400">Visitors</span>{fmtNumber(r.visitors)}</div>
              {r.pageviews !== undefined && dim === 'page' && <div className="flex justify-between"><span className="text-stone-400">Pageviews</span>{fmtNumber(r.pageviews)}</div>}
              {!noPay && (
                <>
                  <div className="flex justify-between"><span className="text-stone-400">Revenue</span>{money(r.revenue)}</div>
                  <div className="flex justify-between"><span className="text-stone-400">New customers</span>{r.customers}</div>
                  <div className="flex justify-between"><span className="text-stone-400">Conversion</span>{r.visitors ? fmtPct(r.customers / r.visitors, 1) : '–'}</div>
                  <div className="flex justify-between"><span className="text-stone-400">Revenue per visitor</span>{r.visitors ? money(perVisitor(r)) : '–'}</div>
                </>
              )}
              {!noPay && r.importedRevenue ? (
                <div className="flex justify-between"><span className="text-stone-400">Imported revenue</span>{money(r.importedRevenue)}</div>
              ) : null}
              {!noPay && r.importedRevenue ? <div className="text-stone-400">From the DataFast import, {r.importedPayments ?? 0} payments on the imported days. Not in the revenue above.</div> : null}
              {r.appStore && <div className="mt-1 text-stone-400">App Store sales from Apple's report that no payment linked to a visit explains.</div>}
              {r.noVisit && <div className="mt-1 text-stone-400">Stripe and other payments with no linked visit. App Store sales have their own row.</div>}
              {tab.filter && !special && <div className="mt-1 text-stone-400">{rowActions(site, dim, r, '').length ? 'Click to filter, or use the arrow for more' : 'Click to filter'}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-stone-600 outline-none transition-colors duration-fast hover:bg-stone-100 hover:text-ink focus-visible:bg-stone-100';

/**
 * A breakdown row's arrow: a menu with "Filter by this" and the deeper screens the row opens (lib/rowActions.ts).
 * It shows on hover or focus, and always on a touch screen. A row with nothing deeper has no arrow; its click filters.
 */
export function RowMenu({ label, actions, onFilter, onOpenChange }: { label: string; actions: RowAction[]; onFilter?: () => void; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!actions.length) return null;
  return (
    // Clicks and keys inside stay here: in the "Show all" table the row around it filters on click.
    <div ref={ref} className="relative mr-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key !== 'Escape' && e.stopPropagation()}>
      <button
        type="button"
        aria-label={`Open ${label || 'this row'} in another view`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-[opacity,background-color,color] duration-fast hover:bg-stone-100 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 ${open ? 'bg-stone-100 text-ink opacity-100' : 'opacity-0'}`}
        onClick={() => setOpen(!open)}
      >
        <Glyph name="referral" size={14} />
      </button>
      {open && (
        <div role="menu" aria-label={label} className="pop pop-in absolute right-0 top-full z-40 mt-1 min-w-[200px] origin-top-right p-1 text-left font-normal">
          {onFilter && (
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                onFilter();
              }}
            >
              <span className="text-stone-400">
                <Glyph name="filter" size={14} />
              </span>
              Filter by this
            </button>
          )}
          {actions.map((a) => (
            <a
              key={a.id}
              role="menuitem"
              href={a.href}
              className={MENU_ITEM}
              onClick={(e) => {
                // A new tab or window keeps the browser's own behavior.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                setOpen(false);
                navigate(a.href);
              }}
            >
              <span className="text-stone-400">
                <Glyph name="referral" size={14} />
              </span>
              {a.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Panel({ tabs }: { tabs: TabDef[] }) {
  const { site, q, reloadKey, addFilter, money } = useDash();
  // No payments connected: no revenue sort and no money columns.
  const noPay = site.payments_connected === false;
  // The open tab lives in ?tab=, so a refresh, Back or a shared link (an agent's dashboard_url) opens the same one.
  const [active, setActive] = useUrlTab(tabs.map((t) => t.dim));
  const [sortBy, setSort] = useState<Sort>('visitors');
  const [details, setDetails] = useState(false);
  const [search, setSearch] = useState('');
  const [modelPick, setModel] = useState<Model>('last');
  const tab = tabs.find((t) => t.dim === active) ?? tabs[0];
  // First touch only on the source tabs, and only where there is revenue to credit.
  const hasModel = !noPay && FIRST_TOUCH_DIMS.has(tab.dim);
  const model: Model = hasModel ? modelPick : 'last';
  const params = { dim: tab.dim, ...(model === 'first' ? { model } : {}) };
  const { data, loading, error } = useApi<BreakdownRow[]>(`/api/sites/${site.id}/breakdown?${qs(q, params)}`, reloadKey);
  // Revenue per visitor answers "which page brings money" on entry pages, where each visit has one.
  const cols: Sort[] = noPay ? ['visitors'] : tab.dim === 'entry_page' ? ['visitors', 'revenue', 'perVisitor'] : ['visitors', 'revenue'];
  const sort: Sort = cols.includes(sortBy) ? sortBy : 'visitors';

  // The filters match the visit itself, so a first-touch row has nothing to filter by.
  const filterKey = model === 'last' ? tab.filter : undefined;
  const filters = !!filterKey;
  const pick = (r: BreakdownRow) => {
    if (!filterKey || r.appStore || r.noVisit) return;
    setDetails(false);
    addFilter(filterKey, r.label ?? '');
  };

  // A view where no row earned anything shows no column of dashes.
  const earns = !noPay && (data ?? []).some((r) => r.revenue > 0);
  const filtered = (data ?? []).filter((r) => !search || `${r.label ?? ''} ${r.name ?? ''}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="card flex min-h-[220px] min-w-0 flex-col p-3">
      {/* Narrow screens: the column headers on a line of their own under the tabs. */}
      <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between lg:flex-col lg:items-stretch xl:flex-row xl:items-center">
        <TabRow className="min-w-0 overflow-x-auto [scrollbar-width:none]" activeKey={tab.dim} label="Breakdown">
          {tabs.map((t) => (
            <button key={t.dim} role="tab" aria-selected={t.dim === tab.dim} className={`tab whitespace-nowrap ${t.dim === tab.dim ? 'tab-active' : ''}`} onClick={() => setActive(t.dim)}>
              {t.label}
            </button>
          ))}
        </TabRow>
        <Columns cols={cols} sort={sort} onSort={noPay ? undefined : setSort} dim={tab.dim} earns={earns || !data} />
      </div>
      <div className={`flex-1 transition-opacity duration-base ${loading && data ? 'opacity-60' : ''}`}>
        {error && <p className="p-3 text-sm text-red-600">{error}</p>}
        {!data && !error && <SkeletonRows rows={6} />}
        {data && data.length === 0 && (tab.dim === 'heard_about' ? <NoAnswers siteId={site.id} /> : <EmptyState compact icon={EmptyIcons.chart} title="No visits in this period" />)}
        {data && <Bars key={`${tab.dim}-${model}`} rows={data} dim={tab.dim} tab={filters ? tab : { ...tab, filter: undefined }} sort={sort} cols={cols} limit={10} onPick={pick} earns={earns} />}
      </div>
      {data && data.length > 0 && (
        // One footer row in every card: the credit model on the left, the list actions on the right.
        <div className="mt-auto flex min-h-8 items-center justify-between gap-3 pt-2">
          {hasModel ? <ModelToggle model={model} onChange={setModel} /> : <span />}
          <div className="flex items-center gap-1">
            {data.length > 10 && (
              <button className="rounded-md px-2 py-1 text-xs font-medium text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink" onClick={() => setDetails(true)}>
                Show all {fmtNumber(data.length)}
              </button>
            )}
            <ExportButton url={`/api/sites/${site.id}/breakdown?${qs(q, { ...params, format: 'csv' })}`} />
          </div>
        </div>
      )}
      <Modal open={details} onClose={() => setDetails(false)} title={tab.label} width="max-w-3xl">
        <input className="input mb-4" placeholder="Search" aria-label={`Search ${tab.label.toLowerCase()}`} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <Table head={[tab.label, 'Visitors', ...(noPay ? [] : ['Revenue', 'Conv.', 'Rev/visitor'])]}>
          {filtered.map((r, i) => (
            <Row
              key={i}
              onClick={filters && !r.appStore && !r.noVisit ? () => pick(r) : undefined}
              cells={[
                <div className="flex min-w-0 items-center gap-2">
                  {renderLabel(tab.dim, r)}
                  {!r.appStore && !r.noVisit && (
                    <span className="ml-auto">
                      <RowMenu label={r.name ?? r.label ?? ''} actions={rowActions(site, tab.dim, r, window.location.search)} onFilter={filters ? () => pick(r) : undefined} />
                    </span>
                  )}
                </div>,
                <Num value={r.visitors} />,
                ...(noPay ? [] : [<Num value={r.revenue} format={(n) => money(n)} />, r.visitors ? fmtPct(r.customers / r.visitors, 1) : null, r.visitors ? <Num value={r.revenue / r.visitors} format={(n) => money(n)} /> : null]),
              ]}
            />
          ))}
        </Table>
      </Modal>
    </div>
  );
}
