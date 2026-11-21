import { memo, useId, useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { bucketLabel, fmtDuration, fmtNumber, fmtPct } from '../../lib/format';
import { BasisChip } from '../BasisChip';
import { APP_VISITORS_NOTE, NEW_INSTALLS_NOTE } from '../OverviewCard';
import { InfoTip } from '../InfoTip';
import { chartAnim, chartDefs, chartGrid, chartTooltip, chartXAxis, chartYAxis, ChartTooltip, NumberTicker, Segmented, SERIES, StatStrip, StatTile } from '../ui';
import { RevenueBucket } from './RevenueBucket';
import { AreaSpark } from './Spark';
import {
  currenciesOf,
  Delta,
  InfoIcon,
  money,
  MRR_MOVEMENT_NOTE,
  MRR_NOTE,
  NEW_CUSTOMERS_NOTE,
  PAYMENTS_ONLY_NOTE,
  REVENUE_NOTE,
  VISITOR_SUM_NOTE,
} from './shared';
import type { HomeData, Money } from './types';

/**
 * Fine print that shows on hover or keyboard focus of a number, so the number itself stays one label, one value, one
 * change. `pos` places the panel (left or right edge) so it stays on screen.
 */
function Tip({ detail, pos = 'left-0', className = '', children }: { detail?: ReactNode; pos?: string; className?: string; children: ReactNode }) {
  const id = useId();
  if (!detail) return <div className={className}>{children}</div>;
  return (
    <div tabIndex={0} aria-describedby={id} className={`group/tip relative rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}>
      {children}
      <div
        id={id}
        role="tooltip"
        className={`pop pointer-events-none invisible absolute top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-1.5 p-3.5 text-[13px] font-normal leading-relaxed text-stone-600 opacity-0 transition-opacity duration-base group-hover/tip:visible group-hover/tip:opacity-100 group-focus/tip:visible group-focus/tip:opacity-100 ${pos}`}
      >
        {detail}
      </div>
    </div>
  );
}

function Label({ children, info, swatch }: { children: ReactNode; info?: boolean; swatch?: string }) {
  return (
    <div className="flex h-5 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium leading-5 text-stone-500">
      {swatch && <span className={`h-2 w-2 shrink-0 rounded-[3px] ${swatch}`} aria-hidden="true" />}
      {children}
      {info && <InfoIcon />}
    </div>
  );
}

/**
 * What the revenue total is made of (`basis` in src/worker/home.ts): payments net of refunds, and App Store sales at
 * the customer price before Apple's cut. The two are added up, so the line names both.
 */
function BasisLine({ total, appStore, currency }: { total: number; appStore: number; currency: string }) {
  if (!total) return null;
  const payments = total - appStore;
  if (!appStore) return <p className="font-medium text-ink">All {money(total, currency)} is payments, net of refunds.</p>;
  if (!payments) return <p className="font-medium text-ink">All {money(total, currency)} is App Store sales at the customer price, before Apple's cut.</p>;
  return (
    <p className="font-medium text-ink">
      {money(total, currency)} adds up two kinds of revenue. {money(payments, currency)} is payments, net of refunds. {money(appStore, currency)} is App Store
      sales at the customer price, before Apple's cut.
    </p>
  );
}

/** Several currencies under the main amount, smaller, so they never read as one total. */
function OtherCurrencies({ list }: { list: [string, number][] }) {
  if (list.length < 2) return null;
  return <div className="mt-1 text-sm font-medium text-stone-500">+ {list.slice(1).map(([cc, v]) => money(v, cc, true)).join(', ')}</div>;
}

/**
 * Under the MRR number: what moved it, "+$20 new, +$10 expansion, −$11 churned". The three add up to the change shown
 * above it (mrrMovement in pro/worker/subscription-metrics.ts). Nothing when nothing moved.
 */
function MrrMovementLine({ m, currency }: { m: NonNullable<HomeData['totals']['mrrMovement']>; currency: string }) {
  const n = m.new[currency] ?? 0;
  const x = m.expansion[currency] ?? 0;
  const c = m.churned[currency] ?? 0;
  if (!n && !x && !c) return null;
  const part = (v: number, sign: '+' | '−', label: string, cls: string) => (
    <span className="whitespace-nowrap">
      <span className={`font-medium tabular-nums ${cls}`}>
        {sign}
        {money(Math.abs(v), currency, true)}
      </span>{' '}
      {label}
    </span>
  );
  return (
    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-500">
      {part(n, '+', 'new', 'text-emerald-700')}
      {x !== 0 && part(x, '+', 'expansion', 'text-emerald-700')}
      {part(c, c < 0 ? '+' : '−', 'churned', 'text-red-600')}
    </p>
  );
}

/** Revenue per bucket across all sites, one currency at a time: the chart under the headline. */
const RevenueChart = memo(function RevenueChart({
  series,
  granularity,
  currency,
  onPick,
}: {
  series: HomeData['series'];
  granularity: HomeData['range']['granularity'];
  currency: string | undefined;
  /** Opens a bar's details; only bars with revenue in some currency open. */
  onPick: (bucket: string) => void;
}) {
  const rows = useMemo(() => series.map((b) => ({ bucket: b.bucket, revenue: currency ? b.revenue[currency] ?? 0 : 0, any: Object.values(b.revenue).some((v) => v !== 0) })), [series, currency]);
  if (!currency) return <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-stone-200 text-[13px] text-stone-400">No payments in this period.</div>;
  // A click anywhere in a bar's column opens it, so a short bar is as easy to hit as a tall one.
  const pick = (s: { activeLabel?: string | number } | null) => {
    const row = s?.activeLabel !== undefined ? rows.find((r) => r.bucket === String(s.activeLabel)) : undefined;
    if (row?.any) onPick(row.bucket);
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap="22%" onClick={pick} className="cursor-pointer">
        {chartDefs()}
        <CartesianGrid {...chartGrid} />
        <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(b, granularity)} {...chartXAxis} />
        <YAxis {...chartYAxis} width={52} tickFormatter={(v) => money(v, currency, true)} />
        <Tooltip
          {...chartTooltip}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <ChartTooltip
                title={bucketLabel(payload[0].payload.bucket, granularity, true)}
                rows={[{ label: 'Revenue', value: money(payload[0].payload.revenue, currency), color: SERIES.revenue }]}
                footer={payload[0].payload.any ? 'Click for sites, sources and payments' : undefined}
              />
            ) : null
          }
        />
        <Bar dataKey="revenue" fill="url(#fd-revenue-bar)" radius={[3, 3, 0, 0]} maxBarSize={22} {...chartAnim()} />
      </BarChart>
    </ResponsiveContainer>
  );
});

const fmtCount = (n: number) => fmtNumber(Math.round(n));

/**
 * The top of Home: revenue and MRR large, with the revenue chart under them. 360 px tall from lg up, the height of the
 * LiveCard beside it. Fine print sits behind each number on hover or focus.
 */
export function MoneyCard({ data }: { data: HomeData }) {
  const c = data.totals.current;
  const p = data.totals.previous;

  // Revenue: the largest currency is the number; the change compares that currency only.
  const revenue = currenciesOf(c.revenue);
  const main = revenue[0]?.[0] ?? currenciesOf(p.revenue)[0]?.[0] ?? data.sites[0]?.currency ?? 'USD';
  const several = revenue.length > 1;
  const mrrList = data.totals.mrr ? currenciesOf(data.totals.mrr) : null;
  const mrrMain = mrrList?.[0]?.[0] ?? data.sites[0]?.currency ?? 'USD';
  const mrrSpark = useMemo(() => (data.totals.mrrSeries ?? []).map((m) => m[mrrMain] ?? 0), [data.totals.mrrSeries, mrrMain]);

  // The chart's currency: the largest over the series unless one is picked.
  const chartCurrencies = useMemo(() => {
    const t: Money = {};
    for (const b of data.series) for (const [cc, v] of Object.entries(b.revenue)) t[cc] = (t[cc] ?? 0) + v;
    return currenciesOf(t).map(([cc]) => cc);
  }, [data.series]);
  const [picked, setPicked] = useState<string | null>(null);
  // The chart bar opened in the dialog, by bucket label.
  const [opened, setOpened] = useState<string | null>(null);
  const chartCurrency = picked && chartCurrencies.includes(picked) ? picked : chartCurrencies[0];

  const fmtMain = (n: number) => money(Math.round(n), main);
  const fmtMrr = (n: number) => money(Math.round(n), mrrMain);

  return (
    <section className="card flex h-full flex-col overflow-hidden lg:h-[360px]" aria-label="Revenue and MRR">
      <div className="flex min-h-0 flex-1 flex-col p-5">
        <div className={`grid gap-x-8 gap-y-5 ${mrrList ? 'grid-cols-1 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]' : ''}`}>
          <Tip
            pos="left-0"
            detail={
              <>
                <p>{REVENUE_NOTE}</p>
                <BasisLine total={c.revenue[main] ?? 0} appStore={c.appStoreRevenue[main] ?? 0} currency={main} />
                {several && <p>The change compares {main} only. Other currencies stay apart, never added up.</p>}
              </>
            }
          >
            <Label info swatch="bg-revenue">
              Revenue
              <BasisChip basis={data.totals.basis} />
            </Label>
            <div className="mt-2 text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[48px]">
              <NumberTicker value={revenue[0]?.[1] ?? 0} format={fmtMain} />
            </div>
            <OtherCurrencies list={revenue} />
            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {revenue.length || Object.keys(p.revenue).length ? (
                <Delta cur={c.revenue[main] ?? 0} prev={p.revenue[main] ?? 0} minBase={0} fmt={(v) => money(v, main, true)} />
              ) : (
                <span className="text-xs text-stone-400">No payments yet</span>
              )}
              {p.revenue[main] ? <span className="whitespace-nowrap text-xs text-stone-400">{money(p.revenue[main], main, true)} before</span> : null}
            </div>
          </Tip>
          {mrrList && (
            <Tip
              pos="left-0 sm:left-auto sm:right-0"
              className="sm:rounded-none sm:border-l sm:border-stone-200/60 sm:pl-8"
              detail={
                <>
                  <p>{MRR_NOTE}</p>
                  {data.totals.mrrMovement && <p>{MRR_MOVEMENT_NOTE}</p>}
                </>
              }
            >
              <Label info>MRR</Label>
              <div className="mt-2 flex items-end gap-4 sm:mt-3">
                <div className="text-[30px] font-semibold leading-[1.1] tracking-[-0.03em] text-ink">
                  <NumberTicker value={mrrList[0]?.[1] ?? 0} format={fmtMrr} />
                </div>
                {mrrSpark.length > 1 && mrrSpark.some((v) => v) && (
                  <AreaSpark
                    values={mrrSpark}
                    height={28}
                    dot
                    className="mb-1 min-w-0 max-w-[112px] flex-1 text-revenue"
                    label={`${mrrMain} MRR through the period, from ${money(mrrSpark[0] ?? 0, mrrMain, true)} to ${money(mrrSpark[mrrSpark.length - 1] ?? 0, mrrMain, true)}`}
                  />
                )}
              </div>
              <OtherCurrencies list={mrrList} />
              <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Delta cur={data.totals.mrr![mrrMain] ?? 0} prev={data.totals.mrrStart?.[mrrMain] ?? 0} minBase={0} fmt={(v) => money(v, mrrMain, true)} />
                {data.totals.mrrStart?.[mrrMain] ? <span className="whitespace-nowrap text-xs text-stone-400">{money(data.totals.mrrStart[mrrMain], mrrMain, true)} at the start</span> : null}
              </div>
              {data.totals.mrrMovement && <MrrMovementLine m={data.totals.mrrMovement} currency={mrrMain} />}
            </Tip>
          )}
        </div>

        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <div className="mb-1 flex h-7 items-center justify-between gap-2">
            <span className="text-xs text-stone-400">
              Revenue per {data.range.granularity}
              {chartCurrency ? ` in ${chartCurrency}` : ''}, all sites
            </span>
            {chartCurrencies.length > 1 && <Segmented size="sm" label="Currency" options={chartCurrencies.map((cc) => ({ value: cc, label: cc }))} value={chartCurrency!} onChange={setPicked} />}
          </div>
          <div className="h-[160px] lg:h-auto lg:min-h-0 lg:flex-1">
            <RevenueChart series={data.series} granularity={data.range.granularity} currency={chartCurrency} onPick={setOpened} />
          </div>
          <RevenueBucket bucket={opened} granularity={data.range.granularity} period={data.period} tz={data.tz} onClose={() => setOpened(null)} />
        </div>
      </div>
    </section>
  );
}

/**
 * The four numbers behind the money: web visitors, app visitors, new customers and conversion, in one strip under the
 * money card. LiveCard owns "online now", so the strip does not repeat it.
 */
export function PulseStrip({ data }: { data: HomeData }) {
  const c = data.totals.current;
  const p = data.totals.previous;
  const min = data.minBase;
  // Web and app visitors apart: a rate never mixes the two. Bounce and session time are web only.
  const zero = { visitors: 0, sessions: 0, bounceRate: 0, avgDuration: 0, customers: 0, conversionRate: 0, newInstalls: 0 };
  const web = data.totals.platforms?.web ?? { current: zero, previous: zero };
  const app = data.totals.platforms?.app ?? { current: zero, previous: zero };
  const hasApps = data.sites.some((s) => s.hasApp);
  const hasWeb = data.sites.some((s) => s.kind !== 'app') || !hasApps;
  const rate = (r: number) => fmtPct(r, r >= 0.1 ? 0 : 2);
  // No web sessions before: rates and times had nothing to measure, so there is nothing to compare.
  const webNoSessions = web.previous.sessions === 0;
  const conversion = hasWeb ? web : app;
  // No tile has a sparkline: the only series Home has is every visitor on every platform, which the chart below it draws.
  return (
    <StatStrip label="Visitors, customers and conversion">
      {hasWeb && (
        <StatTile
          label="Web visitors"
          tone="visitors"
          value={web.current.visitors}
          format={fmtCount}
          info={
            <InfoTip label="How web visitors are counted">
              <p>{VISITOR_SUM_NOTE}</p>
              <p>
                Bounce rate {fmtPct(web.current.bounceRate)}
                {webNoSessions ? '' : `, ${fmtPct(web.previous.bounceRate)} before`}. Session time {fmtDuration(web.current.avgDuration)}
                {webNoSessions ? '' : `, ${fmtDuration(web.previous.avgDuration)} before`}.
              </p>
            </InfoTip>
          }
          footer={<Delta cur={web.current.visitors} prev={web.previous.visitors} minBase={min} noData={webNoSessions && !web.previous.visitors} />}
        />
      )}
      {hasApps && (
        <StatTile
          label="App visitors"
          tone="visitors"
          value={app.current.visitors}
          format={fmtCount}
          info={
            <InfoTip label="How app visitors are counted">
              {app.current.newInstalls > 0 && (
                <p className="font-medium text-ink">
                  {fmtNumber(app.current.newInstalls)} new {app.current.newInstalls === 1 ? 'install' : 'installs'} with consent.
                </p>
              )}
              <p>Each app's visitors, added up. {APP_VISITORS_NOTE}</p>
              <p>{NEW_INSTALLS_NOTE}</p>
            </InfoTip>
          }
          footer={<Delta cur={app.current.visitors} prev={app.previous.visitors} minBase={min} noData={app.previous.sessions === 0 && !app.previous.visitors} />}
        />
      )}
      <StatTile
        label="New customers"
        value={c.customers}
        format={fmtCount}
        info={
          <InfoTip label="How new customers are counted">
            <p>{NEW_CUSTOMERS_NOTE}</p>
          </InfoTip>
        }
        footer={<Delta cur={c.customers} prev={p.customers} minBase={min} />}
      />
      <StatTile
        label={hasWeb && hasApps ? 'Web conversion' : 'Conversion'}
        value={conversion.current.conversionRate}
        format={rate}
        info={
          <InfoTip label="How conversion is counted">
            {conversion.previous.visitors > 0 && (
              <p className="font-medium text-ink">
                {rate(conversion.previous.conversionRate)} before{hasWeb && hasApps ? `. App: ${rate(app.current.conversionRate)} of app visitors` : ''}.
              </p>
            )}
            <p>
              {hasWeb ? 'New customers whose first payment is linked to a web visit, over web visitors.' : 'New customers whose first payment is linked to an app session, over app visitors.'}{' '}
              Payments with no linked visit count in neither. {PAYMENTS_ONLY_NOTE}
            </p>
          </InfoTip>
        }
        // Percentage points, never a percent of a percent.
        footer={
          <Delta
            cur={conversion.current.conversionRate * 100}
            prev={conversion.previous.conversionRate * 100}
            minBase={Infinity}
            fmt={(n) => `${n.toFixed(2)} pts`}
            noData={!conversion.previous.visitors}
          />
        }
      />
    </StatStrip>
  );
}
