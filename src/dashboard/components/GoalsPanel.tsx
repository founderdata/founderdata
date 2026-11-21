import { useEffect, useState } from 'react';
import { api, apiPage, isViewer, qs, type BreakdownRow } from '../lib/api';
import { useDash } from '../lib/context';
import { countryName, fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPct, shortId } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useUrlTab } from '../lib/urlState';
import { CUSTOMER_TABS, type CustomerTab } from '../../shared/dashboard-tabs';
import { AsaName } from './AsaNameSlot';
import { ExportButton } from './ExportButton';
import { Avatar, BrowserIcon, DeviceIcon, Flag, OSIcon, SourceIcon } from './Icons';
import { GROSS_HINT, isGross, PROVIDER_NAMES } from './RevenuePanel';
import { ChangesList, type ChartNotes, type NoteImpacts } from './ChartNotes';
import { GoalIcon, Row, SkeletonTable, Table } from './site/primitives';
import { EmptyIcons, EmptyState } from './ui/EmptyState';
import { MeterBar } from './ui/MeterBar';
import { Note } from './ui/Note';
import { ProSlot } from './ProSlot';
import { SetupRow } from './ui/SetupRow';
import { TabRow } from './ui/Tabs';
import { Spinner } from './ui/Spinner';
import { Skeleton } from './ui/Skeleton';

type Tab = CustomerTab;
const TABS: { key: Tab; label: string }[] = [
  { key: 'journey', label: 'Customers' },
  { key: 'goal', label: 'Goals' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'user', label: 'Visitors' },
  { key: 'changes', label: 'Changes' },
];

/** Under the breakdowns: who paid and where they came from, goals, funnels, visitors, and the changes in the period. */
export function GoalsPanel({ totalVisitors, notes, impacts }: { totalVisitors: number; notes: ChartNotes; impacts: NoteImpacts }) {
  const { site, q } = useDash();
  // The open tab lives in ?tab=, so Back, a refresh or an agent's dashboard_url (?tab=changes) opens the same one.
  const [tab, setTab] = useUrlTab<Tab>(CUSTOMER_TABS);
  const [search, setSearch] = useState('');
  return (
    <div className="card fd-reveal min-w-0 p-3">
      <div className="flex min-h-[32px] flex-wrap items-center justify-between gap-2 pb-2">
        <TabRow className="min-w-0 overflow-x-auto [scrollbar-width:none]" activeKey={tab} label="Customers and goals">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab whitespace-nowrap ${tab === t.key ? 'tab-active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === 'changes' && notes.list.length > 0 && <span className="ml-1.5 tabular-nums text-stone-400">{notes.list.length}</span>}
            </button>
          ))}
        </TabRow>
        {(tab === 'user' || tab === 'journey') && (
          <div className="flex items-center gap-2">
            {/* Customers: one row per payment with its attribution. Visitors: one row per visit. */}
            {!isViewer() && <ExportButton url={`/api/sites/${site.id}/export/${tab === 'journey' ? 'payments' : 'sessions'}.csv?${qs(q)}`} />}
            <div className="relative">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m20 20-4-4" />
              </svg>
              <input className="input h-8 w-[180px] py-1 pl-8 text-[13px]" placeholder="Search" aria-label={tab === 'journey' ? 'Search customers' : 'Search visitors'} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        )}
      </div>
      {tab === 'goal' && <Goals totalVisitors={totalVisitors} />}
      {tab === 'funnel' && <Funnels />}
      {tab === 'user' && <Users search={search} />}
      {tab === 'journey' && <Journey search={search} />}
      {tab === 'changes' && <ChangesList notes={notes} impacts={impacts} bare />}
    </div>
  );
}

function Goals({ totalVisitors }: { totalVisitors: number }) {
  const { site, q, reloadKey, money, addFilter } = useDash();
  const { data, loading } = useApi<BreakdownRow[]>(`/api/sites/${site.id}/breakdown?${qs(q, { dim: 'goal' })}`, reloadKey);
  if (!data) return <SkeletonTable rows={4} cols={5} />;
  if (!data.length)
    return (
      <EmptyState compact icon={<GoalIcon size={18} />} title="No goals yet" className="!py-6">
        Add <code className="rounded bg-stone-100 px-1 text-[12px]">data-rt-goal="signup"</code> to a button to count it.
      </EmptyState>
    );
  const top = Math.max(1, ...data.map((g) => g.visitors));
  return (
    <div className={`transition-opacity duration-base ${loading ? 'opacity-60' : ''}`}>
      <Table head={['Goal', 'Visitors', 'Completions', 'Conversion', 'Revenue']}>
        {data.map((g) => (
          <Row
            key={g.label}
            onClick={() => addFilter('goal', g.label ?? '')}
            title="Filter by visitors who completed this goal"
            cells={[
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-500">
                  <GoalIcon size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink">{g.label}</div>
                  <MeterBar share={g.visitors / top} className="mt-1 max-w-[220px]" />
                </div>
              </div>,
              <span className="font-medium text-ink">{fmtNumber(g.visitors)}</span>,
              g.pageviews ? fmtNumber(g.pageviews) : null,
              totalVisitors ? fmtPct(g.visitors / totalVisitors, 1) : null,
              g.revenue ? money(g.revenue) : null,
            ]}
          />
        ))}
      </Table>
    </div>
  );
}

interface FunnelDef {
  id: string;
  name: string;
  steps: { type: 'page' | 'goal'; value: string }[];
}

function Funnels() {
  const { site, q, reloadKey } = useDash();
  const [version, setVersion] = useState(0);
  const { data: funnels } = useApi<FunnelDef[]>(`/api/sites/${site.id}/funnels`, version);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const current = funnels?.find((f) => f.id === selected) ?? funnels?.[0];
  const { data: stats } = useApi<(FunnelDef['steps'][0] & { visitors: number })[]>(
    current ? `/api/sites/${site.id}/funnels/${current.id}/stats?${qs(q)}` : null,
    reloadKey + version,
  );

  if (!funnels) return <FunnelSkeleton />;
  if (creating || !funnels.length)
    return (
      <FunnelForm
        onDone={(id) => {
          setCreating(false);
          if (id) setSelected(id);
          setVersion((v) => v + 1);
        }}
        canCancel={funnels.length > 0}
      />
    );

  const top = stats?.[0]?.visitors || 0;
  return (
    <div className="px-3 pb-3">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="input h-9 w-auto py-1.5" value={current?.id} onChange={(e) => setSelected(e.target.value)} aria-label="Funnel">
          {funnels.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {!isViewer() && (
          <button className="btn h-9 py-1.5" onClick={() => setCreating(true)}>
            New funnel
          </button>
        )}
        {current && !isViewer() && (
          <button
            className="btn-ghost ml-auto h-9 py-1.5 text-stone-500 hover:text-red-600"
            onClick={async () => {
              if (!confirm(`Delete funnel "${current.name}"?`)) return;
              await api(`/api/sites/${site.id}/funnels/${current.id}`, { method: 'DELETE' });
              setSelected(null);
              setVersion((v) => v + 1);
            }}
          >
            Delete
          </button>
        )}
      </div>
      {!stats ? (
        <FunnelSkeleton steps={current?.steps.length ?? 3} bare />
      ) : (
        <FunnelSteps stats={stats} top={top} siteId={site.id} funnelId={current?.id ?? ''} />
      )}
    </div>
  );
}

/** A funnel as rows: each step's bar against the first, and between two steps how many dropped off. */
function FunnelSteps({ stats, top, siteId, funnelId }: { stats: (FunnelDef['steps'][0] & { visitors: number })[]; top: number; siteId: string; funnelId: string }) {
  return (
    <ol className="fd-stagger">
      {stats.map((s, i) => {
        const pct = top ? s.visitors / top : 0;
        const prev = i ? stats[i - 1].visitors : s.visitors;
        const lost = i ? prev - s.visitors : 0;
        return (
          <li key={i} className="min-w-0">
            {i > 0 && (
              <div className="flex h-7 items-center gap-2 pl-[11px] text-xs">
                <span className="h-full w-px bg-stone-200" aria-hidden="true" />
                <span className="ml-3 font-medium tabular-nums text-red-600">−{prev ? fmtPct(1 - s.visitors / prev) : '0%'} drop-off</span>
                <span className="tabular-nums text-stone-400">{fmtNumber(Math.max(0, lost))} dropped</span>
                {/* FounderData Pro (round 7, lane errors): the recorded visits of those who reached step i and not step i + 1, both counted from 1. */}
                <ProSlot name="funnelWatch" siteId={siteId} funnelId={funnelId} step={i} />
              </div>
            )}
            <div className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[24px_minmax(0,220px)_minmax(0,1fr)_auto]">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-100 text-[11px] font-semibold tabular-nums text-stone-500">{i + 1}</span>
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink" title={s.value}>
                {s.type === 'goal' && <GoalIcon size={13} className="text-stone-400" />}
                <span className="truncate">{s.value}</span>
              </div>
              <div className="col-start-2 mt-1.5 h-7 overflow-hidden rounded-lg bg-stone-100/70 sm:col-start-auto sm:mt-0">
                <div
                  className="h-full w-full rounded-lg bg-visitors/80 transition-transform duration-slower ease-out"
                  style={{ transform: `translateX(calc(max(${(pct * 100).toFixed(2)}%, 6px) - 100%))` }}
                />
              </div>
              <div className="col-start-2 mt-1 flex items-baseline gap-2 text-[13px] tabular-nums sm:col-start-auto sm:mt-0 sm:w-[150px] sm:justify-end">
                <span className="font-semibold text-ink">{fmtNumber(s.visitors)}</span>
                <span className="text-stone-500">visitors</span>
                <span className="w-10 text-right text-stone-400">{fmtPct(pct)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function FunnelSkeleton({ steps = 3, bare = false }: { steps?: number; bare?: boolean }) {
  return (
    <div className={bare ? '' : 'px-3 pb-3'} role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      {!bare && <Skeleton className="mb-4 h-9 w-48 rounded-[10px]" />}
      {Array.from({ length: steps }, (_, i) => (
        <div key={i} className={`flex items-center gap-3 ${i ? 'mt-7' : ''}`}>
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-7 flex-1 rounded-lg" style={{ opacity: 1 - i * 0.2 }} />
          <Skeleton className="h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}

function FunnelForm({ onDone, canCancel }: { onDone: (id?: string) => void; canCancel: boolean }) {
  const { site } = useDash();
  const [name, setName] = useState('Signup funnel');
  const [steps, setSteps] = useState<FunnelDef['steps']>([
    { type: 'page', value: '/' },
    { type: 'page', value: '/pricing' },
    { type: 'goal', value: 'checkout' },
  ]);
  const [error, setError] = useState('');
  const set = (i: number, patch: Partial<FunnelDef['steps'][0]>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <form
      className="max-w-xl space-y-3 px-3 pb-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const f = await api<FunnelDef>(`/api/sites/${site.id}/funnels`, { method: 'POST', json: { name, steps } });
          onDone(f.id);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <p className="text-[13px] text-stone-500">Steps count in order per visitor. Paths take wildcards like <code>/blog/*</code>.</p>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Funnel name" />
      {steps.map((s, i) => (
        <div key={i} className="flex gap-2">
          <select className="input w-28" value={s.type} onChange={(e) => set(i, { type: e.target.value as 'page' | 'goal' })}>
            <option value="page">Page</option>
            <option value="goal">Goal</option>
          </select>
          <input className="input" value={s.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={s.type === 'page' ? '/pricing' : 'signup'} />
          <button type="button" className="btn px-3" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} disabled={steps.length <= 2}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={() => setSteps((s) => [...s, { type: 'page', value: '' }])} disabled={steps.length >= 10}>
          Add step
        </button>
        <button className="btn-dark">Save funnel</button>
        {canCancel && (
          <button type="button" className="btn" onClick={() => onDone()}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

function VisitorCell({ id, name, email, country, city, device, os, browser, badge }: Record<string, any>) {
  return (
    <div className="flex items-center gap-3">
      <Avatar id={id} name={name || email} size={36} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-ink">{name || email || `Visitor ${shortId(id)}`}</span>
          {badge}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">
          <span className="flex items-center gap-1">
            <Flag cc={country} size={13} /> {city ? `${city}, ` : ''}
            {countryName(country)}
          </span>
          <span className="flex items-center gap-1">
            <DeviceIcon name={device} size={13} /> {device}
          </span>
          <span className="flex items-center gap-1">
            <OSIcon name={os} size={13} /> {os}
          </span>
          <span className="flex items-center gap-1">
            <BrowserIcon name={browser} size={13} /> {browser}
          </span>
        </div>
      </div>
    </div>
  );
}

function matches(r: Record<string, any>, search: string) {
  if (!search) return true;
  const s = search.toLowerCase();
  return ['name', 'email', 'pay_email', 'pay_name', 'source', 'country', 'city', 'visitor_id', 'utm_campaign', 'ref'].some((k) =>
    String(r[k] ?? '').toLowerCase().includes(s),
  );
}

/** A list route read a page at a time (200 rows); `more` appends the next page. */
function usePaged(url: string, reloadKey: number) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    apiPage(url).then(
      (r) => alive && (setRows(r.rows), setNext(r.next)),
      () => alive && setRows([]),
    );
    return () => {
      alive = false;
    };
  }, [url, reloadKey]);
  const more = async () => {
    if (next === null || loading) return;
    setLoading(true);
    try {
      const r = await apiPage(`${url}&offset=${next}`);
      setRows((x) => [...(x ?? []), ...r.rows]);
      setNext(r.next);
    } finally {
      setLoading(false);
    }
  };
  return { rows, hasMore: next !== null, more, loading };
}

function ShowAll({ total, shown, hasMore, loading, onClick, onMore }: { total: number; shown: number; hasMore: boolean; loading: boolean; onClick: () => void; onMore: () => void }) {
  const cls = 'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink disabled:opacity-60';
  if (total > shown) {
    return (
      <div className="flex justify-end pt-2">
        <button className={cls} onClick={onClick}>
          Show all {total}
          {hasMore ? '+' : ''}
        </button>
      </div>
    );
  }
  if (!hasMore) return null;
  return (
    <div className="flex justify-end pt-2">
      <button className={cls} onClick={onMore} disabled={loading}>
        {loading ? <><Spinner /> Loading</> : 'Load more'}
      </button>
    </div>
  );
}

const MATCH_LABELS: Record<string, string> = {
  return_page: 'return page',
  customer: 'earlier payment',
  email: 'email',
  timing: 'checkout click timing',
  app_event: 'the app',
  app_account_token: 'App Store account token',
};

/** A payment's amount in the site's currency; one paid in another currency shows converted once it is. */
export function PaymentAmount({ amount, currency, amountConv }: { amount: number; currency: string; amountConv?: number | null }) {
  const { site, money, moneyIn } = useDash();
  return <>{currency !== site.currency && amountConv != null ? money(amountConv) : moneyIn(amount, currency)}</>;
}

/** Under an amount: where the payment came from, what was paid in another currency, and whether it counts as revenue. */
export function PaymentSource({ provider, currency, amount, amountConv }: { provider: string; currency: string; amount?: number; amountConv?: number | null }) {
  const { site, moneyIn } = useDash();
  const notes = [PROVIDER_NAMES[provider] ?? provider];
  if (isGross(provider)) notes.push('gross');
  if (currency !== site.currency && amountConv != null && amount !== undefined) notes.push(`paid ${moneyIn(amount, currency)}`);
  if (provider === 'app_store_sandbox') notes.push('test, not revenue');
  else if (currency !== site.currency && amountConv == null) notes.push('not converted yet, not in totals');
  return (
    <div className="text-xs font-normal text-stone-400" title={isGross(provider) ? GROSS_HINT : undefined}>
      {notes.join(' · ')}
    </div>
  );
}

function Journey({ search }: { search: string }) {
  const { site, q, reloadKey, openVisitor } = useDash();
  const [all, setAll] = useState(false);
  const [version, setVersion] = useState(0);
  const [rematch, setRematch] = useState<string | null>(null);
  const [reasons, setReasons] = useState<{ id: string; name: string | null; matched: boolean; reason: string | null }[]>([]);
  const { rows: data, hasMore, more, loading } = usePaged(`/api/sites/${site.id}/customers?${qs(q)}`, reloadKey + version);
  if (!data) return <PeopleSkeleton />;
  if (!data.length)
    return site.payments_connected === false ? (
      <div className="px-1 pb-1">
        <SetupRow icon={EmptyIcons.inbox} title="Connect payments" action={<a className="btn h-8 text-[13px]" href={`/site/${site.id}/settings#payments`}>Open settings</a>}>
          See who paid and where they came from.
        </SetupRow>
      </div>
    ) : (
      <EmptyState compact icon={EmptyIcons.inbox} title="No payments in this period" className="!py-6" />
    );
  const unmatched = data.filter((r) => !r.visitor_id).length;
  return (
    <div className="overflow-x-auto">
      {unmatched > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-2 pb-2">
          <Note tone="warn">
            {unmatched} payment{unmatched > 1 ? 's' : ''} not linked to a visitor.{' '}
            <a className="font-medium underline underline-offset-2" href={`/site/${site.id}/settings`}>
              Why?
            </a>
          </Note>
          <button
            className="btn h-8 py-1 text-[13px]"
            disabled={rematch === 'working'}
            onClick={async () => {
              setRematch('working');
              const r = await api<{ matched: number; checked: number; details: typeof reasons }>(`/api/sites/${site.id}/rematch`, {
                method: 'POST',
              });
              setRematch(`Matched ${r.matched} of ${r.checked}`);
              setReasons(r.details ?? []);
              setVersion((v) => v + 1);
            }}
          >
            {rematch === 'working' ? <><Spinner /> Matching</> : rematch ?? 'Try matching again'}
          </button>
          {reasons.length > 0 && (
            <ul className="w-full space-y-1 border-t border-stone-200/60 pt-2 text-xs text-stone-500">
              {reasons.map((r) => (
                <li key={r.id}>
                  <b className="font-medium text-ink">{r.name ?? r.id}</b>: {r.matched ? 'matched' : 'not matched'}
                  {r.reason ? ` · ${r.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="text-left text-xs text-stone-400">
            <th className="h-9 pl-2 pr-3 font-medium">Visitor</th>
            <th className="font-medium">Source</th>
            <th className="font-medium">Spent</th>
            <th className="font-medium">Time to complete</th>
            <th className="pr-2 font-medium">Completed at</th>
          </tr>
        </thead>
        <tbody>
          {data
            .filter((r) => matches(r, search))
            .slice(0, all || search ? undefined : 10)
            .map((r) => (
              <tr
                key={r.id}
                className={`border-t border-stone-200/60 transition-colors duration-fast ${r.visitor_id ? 'cursor-pointer hover:bg-stone-50 focus-visible:bg-stone-50' : ''}`}
                onClick={() => r.visitor_id && openVisitor(r.visitor_id)}
                tabIndex={r.visitor_id ? 0 : undefined}
                onKeyDown={(e) => r.visitor_id && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openVisitor(r.visitor_id))}
              >
                <td className="h-[60px] py-2 pl-2 pr-3">
                  <VisitorCell
                    id={r.visitor_id ?? r.id}
                    name={r.name ?? r.pay_name}
                    email={r.email ?? r.pay_email}
                    country={r.country}
                    city={null}
                    device={r.device}
                    os={r.os}
                    browser={r.browser}
                    badge={r.renewal ? <span className="rounded-md bg-stone-100 px-1.5 py-px text-[11px] font-medium text-stone-500">Renewal</span> : undefined}
                  />
                </td>
                <td className="py-2">
                  {r.session_id ? (
                    <div className="flex items-center gap-2">
                      <SourceIcon source={r.source} domain={r.referrer_domain} />
                      <div>
                        <div>{r.source}</div>
                        {(r.utm_campaign || r.ref) && <div className="text-xs text-stone-500">{r.utm_campaign ? <AsaName kind="campaign" id={r.utm_campaign} /> : r.ref}</div>}
                        {r.matched_by && r.matched_by !== 'metadata' && (
                          <div className="text-xs text-stone-400" title="How this payment was linked to the visitor">
                            matched by {MATCH_LABELS[r.matched_by] ?? r.matched_by}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <span className="text-stone-400" title="No visitor id in the payment metadata, and no return-page, email or timing match">
                      Not attributed
                    </span>
                  )}
                </td>
                <td className="py-2 font-semibold tabular-nums text-ink">
                  <PaymentAmount amount={r.amount} currency={r.currency} amountConv={r.amount_conv} />
                  <PaymentSource provider={r.provider} currency={r.currency} amount={r.amount} amountConv={r.amount_conv} />
                </td>
                <td className="py-2 tabular-nums">
                  {r.first_seen ? fmtAgo(r.ts - r.first_seen) : <span className="text-stone-300">–</span>}
                  {r.visits > 0 && <div className="text-xs text-stone-500">{r.visits} visit{r.visits > 1 ? 's' : ''}</div>}
                </td>
                <td className="whitespace-nowrap py-2 pr-2 tabular-nums text-stone-500">{fmtDateTime(r.ts, site.timezone)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {!search && <ShowAll total={data.length} shown={all ? data.length : 10} hasMore={hasMore} loading={loading} onClick={() => setAll(true)} onMore={more} />}
    </div>
  );
}

function Users({ search }: { search: string }) {
  const { site, q, reloadKey, money, openVisitor } = useDash();
  const [all, setAll] = useState(false);
  const { rows: data, hasMore, more, loading } = usePaged(`/api/sites/${site.id}/visitors?${qs(q)}`, reloadKey);
  if (!data) return <PeopleSkeleton />;
  if (!data.length) return <EmptyState compact icon={EmptyIcons.chart} title="No visitors in this period" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="text-left text-xs text-stone-400">
            <th className="h-9 pl-2 pr-3 font-medium">Visitor</th>
            <th className="font-medium">Source</th>
            <th className="text-right font-medium">Visits</th>
            <th className="text-right font-medium">Pages</th>
            <th className="text-right font-medium">Time</th>
            <th className="text-right font-medium">Spent</th>
            <th className="pl-3 pr-2 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data
            .filter((r) => matches(r, search))
            .slice(0, all || search ? undefined : 10)
            .map((r) => (
              <tr
                key={r.visitor_id}
                className="cursor-pointer border-t border-stone-200/60 tabular-nums transition-colors duration-fast hover:bg-stone-50 focus-visible:bg-stone-50"
                onClick={() => openVisitor(r.visitor_id)}
                tabIndex={0}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openVisitor(r.visitor_id))}
              >
                <td className="h-[60px] py-2 pl-2 pr-3">
                  <VisitorCell
                    id={r.visitor_id}
                    name={r.name}
                    email={r.email}
                    country={r.country}
                    city={r.city}
                    device={r.device}
                    os={r.os}
                    browser={r.browser}
                    badge={r.spent > 0 ? <span className="rounded-md bg-revenueSoft px-1.5 py-px text-[11px] font-medium text-revenue">Customer</span> : null}
                  />
                </td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <SourceIcon source={r.source} domain={r.referrer_domain} /> {r.source}
                  </div>
                </td>
                <td className="py-2 text-right">{r.sessions}</td>
                <td className="py-2 text-right">{r.pageviews}</td>
                <td className="py-2 text-right">{fmtDuration(r.duration)}</td>
                <td className="py-2 text-right font-medium text-ink">{r.spent ? money(r.spent) : <span className="font-normal text-stone-300">–</span>}</td>
                <td className="whitespace-nowrap py-2 pl-3 pr-2 text-right text-stone-500">{fmtAgo(Date.now() - r.last_seen)} ago</td>
              </tr>
            ))}
        </tbody>
      </table>
      {!search && <ShowAll total={data.length} shown={all ? data.length : 10} hasMore={hasMore} loading={loading} onClick={() => setAll(true)} onMore={more} />}
    </div>
  );
}

/** Customers and visitors while the first page loads: rows of the real row height, avatar and two lines. */
function PeopleSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="flex h-8 items-center gap-8 px-3">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-3 w-12" />
        <span className="flex-1" />
        <Skeleton className="h-3 w-16" />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-[60px] items-center gap-3 border-t border-stone-200/60 px-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-44" />
          </div>
          <span className="flex-1" />
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="ml-6 h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}
