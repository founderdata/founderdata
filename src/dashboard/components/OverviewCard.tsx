import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, LabelList, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { qs, type Coverage, type Kpis, type Overview } from '../lib/api';
import { useDash } from '../lib/context';
import { useApi } from '../lib/useApi';
import { CoverageLine } from './Coverage';
import { isAppOnly } from '../lib/siteKind';
import { bucketLabel, dayInTz, fmtDuration, fmtNumber, fmtPct } from '../lib/format';
import { NoteHoverCard, NoteLegend, noteLines, type ChartNotes, type NoteHover, type NoteHoverFn } from './ChartNotes';
import { Avatar, AvatarMark } from './Icons';
import type { ChartNote } from '../lib/api';
import { BasisChip } from './BasisChip';
import { TREND_RULES } from '../../shared/trend-rules';
import { DOWN_IS_GOOD, METRIC_NOTE, TYPE_TILES, typeOf, type ProductNumbers } from './ProductType';
import { chartAnim, chartDefs, chartGrid, chartLine, chartLineCursor, chartTooltip, chartXAxis, chartYAxis, SERIES } from './ui/chart';
import { Skeleton, SkeletonChart } from './ui/Skeleton';
import { StatStrip, StatTile } from './ui/StatTile';
import { Delta, Key } from './site/primitives';
import { hasApp, isAppFilter } from '../../shared/platform';

type Metric = 'visitors' | 'revenue';

/** The tiles a site without payments leaves out (home.ts paymentsConnected). */
const MONEY_TILES = new Set(['revenue', 'conversionRate', 'revenuePerVisitor']);

/** What an app's visitor count is without consent (docs/APP-API.md section 3). */
export const APP_VISITORS_NOTE =
  'Without consent, a device counts once a day, however often the app opens. The next day it counts again. An install with consent or the vendor install id counts once in the whole period.';

/** What New installs counts, so it compares with App Store Connect and RevenueCat (docs/APP-API.md section 7). */
export const NEW_INSTALLS_NOTE =
  "Installs with consent (FounderData.setConsent(true)) first seen in this period. Without consent FounderData knows a device for one day only, so it can't tell a new install from a returning one, and those installs are not counted here. App Store Connect and RevenueCat count every install.";

/** The app numbers the Overview leads with, from the same routes as the Subscriptions, App and Search Ads views. */
interface SubsLead { hasData: boolean; current: { mrr: number; mrrStart: number } }
interface TrialLead { trialToPaid: number | null; trialsPaid: number; trialsEnded: number }
interface AsaLead { hasSpend: boolean; from: string; to: string; totals: { spend: number | null; paid: number; cpa: number | null; roas: number | null } }

/**
 * One KPI tile, shown by StatTile. `num` with `fmt` ticks to each new value (null is a muted dash); `display` is shown
 * as it is ("n/a"). `meta` is the change under the number, or a short muted line.
 */
interface Tile {
  key: string;
  label: string;
  /** Next to the label: the revenue basis (BasisChip). */
  chip?: ReactNode;
  num?: number | null;
  fmt?: (n: number) => string;
  display?: ReactNode;
  /** Skeleton in place of the number while its route loads. */
  loading?: boolean;
  meta?: ReactNode;
  /** One muted line after the change. */
  sub?: ReactNode;
  tone?: 'visitors' | 'revenue';
  metric?: Metric;
  title?: string;
}

/** A payment row from GET /api/sites/:id/customers, the fields the chart reads. */
interface CustomerRow { id: string; visitor_id: string | null; name: string | null; pay_name: string | null; renewal: number | boolean; ts: number }

/** The chart's total height: the key row, then the visitors line over the revenue strip. */
const CHART_H = 348;

/** `controls` sit at the left of the chart's key row: the platform switch of a site with a web and an app side. */
export function OverviewCard({ data, notes, controls }: { data: Overview | null; notes: ChartNotes; controls?: ReactNode }) {
  const { money, q, site, reloadKey, decimals } = useDash();
  // Payments linked to a visit (Coverage.tsx). Whole site, so hidden while a filter is on.
  const coverage = useApi<Coverage>(Object.keys(q.filters).length ? null : `/api/sites/${site.id}/coverage?${qs(q)}`, reloadKey).data;
  const [hidden, setHidden] = useState<Record<Metric, boolean>>({ visitors: false, revenue: false });
  // Revenue per visitor over time instead of visitors and revenue (its tile switches it).
  const [rpv, setRpv] = useState(false);
  // "Include imported history": the revenue strip draws imported and native revenue as one line (importedLine). Totals stay native.
  const [withImported, setWithImported] = useState(false);
  // New paying customers drawn on the revenue bars, by day. The first page of the Customers list is enough for a chart.
  const daily = (data?.range.granularity ?? 'day') === 'day';
  const buyers = useApi<CustomerRow[]>(daily && site.payments_connected !== false ? `/api/sites/${site.id}/customers?${qs(q)}` : null, reloadKey).data;
  const byDay = useMemo(() => {
    const m = new Map<string, CustomerRow[]>();
    for (const r of buyers ?? []) {
      if (r.renewal) continue;
      const d = dayInTz(r.ts, site.timezone);
      m.set(d, [...(m.get(d) ?? []), r]);
    }
    return m;
  }, [buyers, site.timezone]);
  // Avatars go on the days with the most new customers only, at most 8, so the bars stay readable. The hover card
  // lists every customer of a day.
  const avatarDays = useMemo(() => {
    const top = [...byDay].sort((a, b) => b[1].length - a[1].length || b[0].localeCompare(a[0])).slice(0, 8);
    return new Set(top.map(([d]) => d));
  }, [byDay]);
  const notesByBucket = useMemo(() => {
    const m = new Map<string, ChartNote[]>();
    for (const n of notes.list) m.set(n.bucket, [...(m.get(n.bucket) ?? []), n]);
    return m;
  }, [notes.list]);
  const importedRevenue = !!data?.series.some((d) => d.imported_revenue);
  const line = withImported && importedRevenue;
  const c = data?.current;
  const p = data?.previous;
  // An app that takes payments leads with what pays: revenue, MRR, trial to paid and the Search Ads cost per paid user.
  // Visit numbers (visitors, bounce rate, session time) move to a smaller row under them.
  const lead = hasApp(site) && site.payments_connected !== false && (data?.kind === 'app' || isAppOnly(site) || isAppFilter(q.filters.platform));
  const subs = useApi<SubsLead>(lead ? `/api/sites/${site.id}/subscriptions?${qs(q)}` : null, reloadKey).data;
  const trial = useApi<TrialLead>(lead ? `/api/sites/${site.id}/app/paywall?${qs(q, { split: 'source' })}` : null, reloadKey).data;
  const trialBefore = useApi<TrialLead>(lead ? `/api/sites/${site.id}/app/paywall?${qs(q, { split: 'source', compare: 'previous' })}` : null, reloadKey).data;
  const asa = useApi<AsaLead>(lead ? `/api/sites/${site.id}/asa?${qs(q)}` : null, reloadKey).data;
  // An extension or a newsletter leads with its own numbers instead of bounce rate and session time (ProductType.tsx).
  const ptype = typeOf(site);
  const counted = ptype === 'extension' || ptype === 'newsletter' ? ptype : null;
  const product = useApi<{ product: ProductNumbers | null }>(counted ? `/api/sites/${site.id}/product?${qs(q)}` : null, reloadKey).data?.product;

  // Without sessions before, visit-based numbers had nothing to measure.
  const noSessions = !!p && p.sessions === 0;
  const pts = (n: number) => `${Math.round(n * 100)} pts`;
  // An app-only site, or the App filter: without a kept install id a visitor is one device on one day.
  const app = data?.kind === 'app' || isAppOnly(site) || isAppFilter(q.filters.platform);
  // New installs: consented installs only. An app that never asks for consent has none, so the tile says so.
  const installs = app && c?.newInstalls !== undefined;
  const noConsent = installs && !c!.consentedInstalls && !p!.consentedInstalls;
  const convDigits = c && c.conversionRate >= 0.1 ? 0 : 2;
  const kpis: {
    key: keyof Kpis;
    label: string;
    chip?: ReactNode;
    num?: number;
    value?: string;
    show: (n: number) => string;
    invert?: boolean;
    metric?: Metric;
    tone?: 'visitors' | 'revenue';
    fmt: (n: number) => string;
    noData?: boolean;
    title?: string;
    /** Shown instead of the change. */
    note?: string;
  }[] = c
    ? [
        {
          key: 'visitors',
          label: 'Visitors',
          num: c.visitors,
          show: fmtNumber,
          metric: 'visitors',
          tone: 'visitors',
          fmt: fmtNumber,
          noData: noSessions && !p!.visitors,
          title: app ? APP_VISITORS_NOTE : undefined,
        },
        ...(installs
          ? [
              {
                key: 'newInstalls' as const,
                label: 'New installs',
                ...(noConsent ? { value: 'n/a' } : { num: c.newInstalls ?? 0 }),
                show: fmtNumber,
                fmt: fmtNumber,
                noData: noSessions,
                title: NEW_INSTALLS_NOTE,
                note: noConsent ? 'no install gave consent' : undefined,
              },
            ]
          : []),
        {
          key: 'revenue',
          label: 'Revenue',
          chip: line ? <span className="rounded-md bg-stone-100 px-1 text-[11px] font-normal text-stone-500">native only</span> : <BasisChip basis={data?.basis} />,
          num: c.revenue,
          show: (n) => money(n, true),
          metric: 'revenue',
          tone: 'revenue',
          fmt: (n) => money(n, true),
          title:
            "Payments plus App Store sales. For the App Store, FounderData uses Apple's daily sales report on the days it has imported and the purchases it recorded on the other days, such as today. Gross, after refunds. With a filter, only payments linked to matching visits count.",
        },
        {
          key: 'conversionRate',
          label: 'Conversion rate',
          num: c.conversionRate,
          show: (n) => fmtPct(n, convDigits),
          fmt: pts,
          noData: noSessions,
          title: `New customers over visitors, from recorded payments. Apple's sales report has no customers.${app ? `\n${APP_VISITORS_NOTE}` : ''}`,
        },
        { key: 'revenuePerVisitor', label: 'Revenue/visitor', num: c.revenuePerVisitor, show: (n) => money(n), fmt: (n) => money(n), noData: noSessions },
        { key: 'bounceRate', label: 'Bounce rate', num: c.bounceRate, show: (n) => fmtPct(n), invert: true, fmt: pts, noData: noSessions },
        { key: 'avgDuration', label: 'Session time', num: c.avgDuration, show: fmtDuration, fmt: fmtDuration, noData: noSessions },
      ]
    : [];

  const g = data?.range.granularity ?? 'day';
  // The revenue strip under the line, unless revenue is hidden or the site has no payments.
  // No payment provider set up and no payment ever: pageviews instead of the money tiles, and no revenue on the chart.
  const noPay = site.payments_connected === false;
  const tiles =
    noPay && c
      ? kpis
          .filter((k) => !MONEY_TILES.has(k.key))
          .flatMap((k) =>
            k.key === (installs ? 'newInstalls' : 'visitors')
              ? [k, { key: 'pageviews' as const, label: app ? 'Screen views' : 'Pageviews', num: c.pageviews, show: fmtNumber, fmt: fmtNumber, noData: noSessions }]
              : [k],
          )
      : kpis;

  const asTile = (k: (typeof tiles)[number]): Tile => ({
    key: k.key,
    label: k.label,
    chip: k.chip,
    num: k.num,
    fmt: k.show,
    display: k.value ? <span className="text-stone-400" title={k.note}>{k.value}</span> : undefined,
    tone: k.tone,
    metric: k.metric,
    title: k.title,
    // Nothing before and nothing now is no news: no badge.
    meta: k.note || ((c![k.key] ?? 0) === 0 && (p![k.key] ?? 0) === 0) ? null : <Delta cur={c![k.key] ?? 0} prev={p![k.key] ?? 0} invert={k.invert} noData={k.noData} fmt={k.fmt} />,
  });

  // The primary goal (site Settings) as a tile, the number Home shows for the site (src/worker/primary-goal.ts).
  const goalTile: Tile | null = data?.goal
    ? {
        key: 'goal',
        label: data.goal.label,
        num: data.goal.count,
        fmt: fmtNumber,
        title: `Primary goal: ${data.goal.name}. Visitors who reached it in the period, as on Home.`,
        meta: data.goal.count === 0 && data.goal.previous === 0 ? null : <Delta cur={data.goal.count} prev={data.goal.previous} fmt={fmtNumber} />,
      }
    : null;
  // No visit or app session for a day or more (TREND_RULES.quietHours, the same rule as Home's "Quiet").
  const quietSince = data?.lastVisitAt != null && Date.now() - data.lastVisitAt >= TREND_RULES.quietHours * 3_600_000 ? data.lastVisitAt : null;

  const decided = trial ? trial.trialsPaid + trial.trialsEnded : 0;
  const productTiles: Tile[] = counted
    ? TYPE_TILES[counted].map(({ key, label }) => {
        const m = product?.metrics.find((x) => x.key === key);
        return {
          key,
          label,
          ...(m ? { num: m.value, fmt: fmtNumber } : { loading: true }),
          title: METRIC_NOTE[key],
          meta: m ? <Delta cur={m.value} prev={m.previous} invert={DOWN_IS_GOOD.has(key)} fmt={fmtNumber} before={key === 'subscribers' ? 'at the start of the period' : 'before'} /> : null,
        };
      })
    : [];
  const leadTiles: Tile[] = counted && c
    ? [...productTiles, ...(noPay ? [] : [asTile(tiles.find((k) => k.key === 'revenue')!)])]
    : lead && c
      ? [
          asTile(tiles.find((k) => k.key === 'revenue')!),
          ...(subs?.hasData === false
            ? []
            : [
                {
                  key: 'mrr',
                  label: 'MRR',
                  ...(subs ? { num: subs.current.mrr, fmt: (n: number) => money(n, true) } : { loading: true }),
                  title: 'Monthly recurring revenue of the paying subscriptions at the end of the period, as in the Subscriptions tab. A yearly plan counts as a twelfth.',
                  meta: subs ? <Delta cur={subs.current.mrr} prev={subs.current.mrrStart} fmt={(n) => money(n, true)} before="at the start of the period" /> : null,
                },
              ]),
          {
            key: 'trialToPaid',
            label: 'Trial to paid',
            ...(trial ? (trial.trialToPaid === null ? { num: null, display: <span className="text-stone-300" title="No trial decided yet">–</span> } : { num: trial.trialToPaid, fmt: (n: number) => fmtPct(n) }) : { loading: true }),
            title: `Trials that paid by the end of the trial plus 3 days, over the trials that paid or ended, as in the App tab.${trial ? ` ${trial.trialsPaid} of ${decided} decided.` : ''}`,
            meta: trial && trial.trialToPaid !== null ? <Delta cur={trial.trialToPaid} prev={trialBefore?.trialToPaid ?? 0} noData={trialBefore?.trialToPaid == null} fmt={pts} /> : null,
          },
          ...(asa && !asa.hasSpend
            ? []
            : [
                {
                  key: 'asaCpp',
                  label: 'Search Ads cost per paid',
                  ...(asa ? (asa.totals.cpa === null ? { num: null, display: <span className="text-stone-300" title="No paid user from Search Ads yet">–</span> } : { num: asa.totals.cpa, fmt: (n: number) => money(n) }) : { loading: true }),
                  title: `Apple Search Ads spend over the users it brought who paid${asa ? `, ${asa.from} to ${asa.to}` : ''}. Apple reports a day late, so a period up to today counts the same number of days up to yesterday, as the iPhone does. ROAS is revenue to date from those users over the spend.`,
                  sub: asa ? (
                    <>
                      {money(asa.totals.spend ?? 0, true)} spend
                      {asa.totals.roas !== null && <>, ROAS {fmtPct(asa.totals.roas)}</>}
                    </>
                  ) : undefined,
                },
              ]),
        ]
      : [];
  const secondary: Tile[] = counted && c
    ? [asTile(tiles.find((k) => k.key === 'visitors')!)]
    : lead && c ? [...tiles.filter((k) => k.key !== 'revenue').map(asTile), ...(goalTile ? [goalTile] : [])] : [];
  const mainTiles: Tile[] = lead || counted ? leadTiles : c ? [...tiles.map(asTile), ...(goalTile ? [goalTile] : [])] : [];
  // Visitors and Revenue tiles pick what the chart shows: click one to show it alone, click it again for both.
  // Revenue/visitor swaps the chart for that ratio over time. Nothing else on the row changes the chart.
  const canPick = (t: Tile) => !noPay && (!!t.metric || t.key === 'revenuePerVisitor');
  const isOn = (t: Tile) => (rpv ? t.key === 'revenuePerVisitor' : !!t.metric && !hidden[t.metric]);
  const pickTile = (t: Tile) => {
    if (t.key === 'revenuePerVisitor') return setRpv((r) => !r);
    if (!t.metric) return;
    if (rpv) {
      setRpv(false);
      return setHidden({ visitors: false, revenue: false });
    }
    const other: Metric = t.metric === 'visitors' ? 'revenue' : 'visitors';
    setHidden((h) => (h[other] || h[t.metric!] ? { visitors: false, revenue: false } : { ...h, [other]: true }));
  };
  const stat = (t: Tile) => {
    const can = canPick(t);
    const on = can && isOn(t);
    const hint = can ? (on && !rpv && t.metric ? 'Click to show it alone on the chart' : 'Click to show on the chart') : '';
    const title = [t.title, hint].filter(Boolean).join('\n');
    return (
      <StatTile
        key={t.key}
        label={<span title={title || undefined}>{t.label}</span>}
        info={t.chip}
        // The bar under a chosen tile is the series' own color, so the tile reads as the chart's key.
        tone={t.key === 'revenuePerVisitor' ? 'revenue' : t.tone}
        value={t.num}
        format={t.fmt}
        display={t.display}
        loading={t.loading}
        footer={t.meta}
        sub={t.sub}
        onClick={can ? () => pickTile(t) : undefined}
        active={on}
      />
    );
  };

  // No revenue in the whole period: the strip under the line would be an empty grid, so the line takes its height.
  const hasRevenue = !data || data.series.some((d) => d.revenue > 0 || (d.imported_revenue ?? 0) > 0);
  const showR = !noPay && !hidden.revenue && hasRevenue;
  const showV = !hidden.visitors || !showR;

  return (
    <div className="card fd-reveal overflow-hidden">
      {quietSince !== null && <QuietLine since={quietSince} app={app} settingsHref={`/site/${site.id}/settings`} timezone={site.timezone} />}
      {c ? (
        <>
          <StatStrip flat label="Headline numbers">
            {mainTiles.map(stat)}
          </StatStrip>
          {secondary.length > 0 && (
            <StatStrip flat label="More numbers">
              {secondary.map(stat)}
            </StatStrip>
          )}
        </>
      ) : (
        <TilesSkeleton />
      )}
      {data && !noPay && coverage && coverage.payments > 0 && coverage.linked / coverage.payments < 0.9 && (
        <CoverageLine data={coverage} settingsHref={`/site/${site.id}/settings#payments`} />
      )}

      <div className="relative px-2 pb-2 pt-3 sm:px-3">
        {data ? (
          <>
            <div className={`mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-2 text-xs text-stone-500 ${controls ? 'min-h-8' : 'min-h-[20px]'}`}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                {controls}
                {noPay ? (
                  <a className="text-stone-400 underline-offset-2 hover:text-ink hover:underline" href={`/site/${site.id}/settings#payments`}>
                    Connect payments to see revenue
                  </a>
                ) : (
                  <div className="hidden sm:block">
                    <NoteLegend notes={notes.list} />
                  </div>
                )}
              </div>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
                {rpv ? (
                  <Key swatch="h-[3px] w-3 rounded-full bg-revenue" label="Revenue per visitor" />
                ) : (
                  <>
                    {showV && <Key swatch="h-[3px] w-3 rounded-full bg-visitors" label="Visitors" />}
                    {showR && <Key swatch="h-2 w-2 rounded-[3px] bg-revenue" label="Revenue" />}
                    {data.series.some((d) => d.imported) && <Key swatch="h-2 w-3 rounded-[3px] bg-stone-200" label="Imported days" />}
                  </>
                )}
                {importedRevenue && !noPay && !rpv && (
                  <label className="flex cursor-pointer items-center gap-1.5" title="Draws imported revenue (from your DataFast import) and native revenue as one line, with a marker on the first day FounderData recorded itself. The numbers above stay native only.">
                    <input type="checkbox" checked={withImported} onChange={(e) => setWithImported(e.target.checked)} />
                    Include imported history
                  </label>
                )}
              </div>
            </div>
            {line && showR && !rpv && (
              <p className="px-2 pb-1 text-xs text-stone-400">
                Revenue line includes {money(data.imported?.revenue ?? 0)} imported. Totals above are native only.
              </p>
            )}
            <OverviewChart
              data={data}
              notes={notes.list}
              notesByBucket={notesByBucket}
              byDay={byDay}
              avatarDays={avatarDays}
              daily={daily}
              decimals={decimals}
              noPay={noPay}
              line={line}
              rpv={rpv}
              showV={showV}
              showR={showR}
            />
          </>
        ) : (
          <>
            <div className="mb-1 flex h-5 items-center justify-end gap-4 px-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-16" />
            </div>
            <SkeletonChart height={CHART_H - 24} className="px-[52px]" />
          </>
        )}
      </div>
    </div>
  );
}

/** The KPI strip while the first answer loads: six tiles of the real tile's size. */
function TilesSkeleton() {
  return (
    <StatStrip flat label="Loading">
      {Array.from({ length: 6 }, (_, i) => (
        <StatTile key={i} label={<Skeleton className="h-3.5 w-20" />} value={undefined} loading />
      ))}
    </StatStrip>
  );
}

/**
 * The visitors line over the revenue strip, one instrument: both share the x axis (same y axis widths and a band
 * scale), one hairline crosshair (syncId) and the note markers. Memoized, so a tile hover or a note card does not
 * redraw the charts.
 */
const OverviewChart = memo(function OverviewChart({
  data,
  notes,
  notesByBucket,
  byDay,
  avatarDays,
  daily,
  decimals,
  noPay,
  line,
  rpv,
  showV,
  showR,
}: {
  data: Overview;
  notes: ChartNote[];
  notesByBucket: Map<string, ChartNote[]>;
  byDay: Map<string, CustomerRow[]>;
  avatarDays: Set<string>;
  daily: boolean;
  decimals: number;
  noPay: boolean;
  line: boolean;
  rpv: boolean;
  showV: boolean;
  showR: boolean;
}) {
  const { money } = useDash();
  const g = data.range.granularity;
  const series = data.series;
  const wrap = useRef<HTMLDivElement>(null);
  // The note hover card: set straight from the markers' handlers, so the charts themselves never re-render for it.
  const hover = useRef<NoteHoverFn>(() => {});
  const onNoteHover = useMemo<NoteHoverFn>(() => (h) => hover.current(h), []);

  const lineSeries = useMemo(() => importLine(series), [series]);
  const ticks = useMemo(() => chartTicks(line ? lineSeries.map((d) => ({ ...d, revenue: d.combined })) : series, decimals), [line, lineSeries, series, decimals]);
  // First and last chart bucket that holds imported days: shaded behind the visitors line.
  const importedBuckets = useMemo(() => {
    const b = series.filter((d) => d.imported).map((d) => d.bucket);
    return b.length ? { from: b[0], to: b[b.length - 1] } : null;
  }, [series]);
  const rpvSeries = useMemo(() => series.map((d) => ({ ...d, rpv: d.visitors ? d.revenue / d.visitors : 0 })), [series]);
  const rpvTicks = useMemo(() => {
    const max = Math.max(0, ...rpvSeries.map((d) => d.rpv));
    const step = niceStep(max / 3) || 1;
    return [0, 1, 2, 3].map((i) => i * step);
  }, [rpvSeries]);
  const fmtBucket = useMemo(() => (b: string) => bucketLabel(b, g), [g]);
  // On a band axis Recharts puts the line cursor at the band's left edge, while the bars and the series points sit at
  // its middle. This cursor moves the hairline to the middle, so it meets the revenue strip's crosshair.
  const bandCursor = useMemo(() => <BandCursor n={series.length} />, [series.length]);
  const anim = chartAnim();

  // The chart that owns the hover card: visitors when shown, else revenue.
  const tip = (band: boolean) => (
    <Tooltip
      {...chartTooltip}
      cursor={band ? bandCursor : chartLineCursor}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0].payload as Overview['series'][0];
        const who = daily ? byDay.get(d.bucket) ?? [] : [];
        const marks = notesByBucket.get(d.bucket) ?? [];
        return (
          <div className="pop min-w-[208px] max-w-[280px] px-3 py-2.5 text-xs" style={{ animation: 'fd-fade var(--dur-fast) var(--ease-out) both' }}>
            <div className="mb-1.5 font-medium text-stone-500">{bucketLabel(d.bucket, g, true)}</div>
            {d.imported && <div className="mb-1.5 text-stone-400">Imported. Visitors are summed per day.</div>}
            <div className="space-y-1">
              <TipRow color={SERIES.visitors} label="Visitors" value={fmtNumber(d.visitors)} strong />
              <TipRow color="rgb(var(--stone-300))" label="Pageviews" value={fmtNumber(d.pageviews)} />
              {!noPay && <TipRow color={SERIES.revenue} label={line && d.imported_revenue ? 'Native revenue' : 'Revenue'} value={money(d.revenue)} strong />}
              {!noPay && line && !!d.imported_revenue && <TipRow color="rgb(var(--stone-300))" label="Imported revenue" value={money(d.imported_revenue)} />}
              {!noPay && d.visitors > 0 && d.revenue > 0 && <TipRow label="Revenue/visitor" value={money(d.revenue / d.visitors)} />}
            </div>
            {who.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-stone-200/70 pt-2">
                {who.slice(0, 3).map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-stone-600">
                    <Avatar id={r.visitor_id ?? r.id} name={r.name ?? r.pay_name} size={16} ring={false} />
                    <span className="truncate">{r.name ?? r.pay_name ?? 'New customer'}</span>
                  </div>
                ))}
                {who.length > 3 && <div className="pl-6 text-stone-400">and {who.length - 3} more</div>}
              </div>
            )}
            {marks.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-stone-200/70 pt-2 text-stone-600">
                {marks.slice(0, 3).map((n) => (
                  <div key={n.id} className="flex gap-2">
                    <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400" />
                    <span className="line-clamp-2">{n.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }}
    />
  );
  // One avatar on a day's bar for its first new customer.
  const buyerLabel = (props: { x?: number | string; y?: number | string; width?: number | string; index?: number }) => {
    const d = series[props.index ?? -1];
    const who = d && avatarDays.has(d.bucket) ? byDay.get(d.bucket) : undefined;
    if (!who?.length || !d.revenue) return null;
    const cx = Number(props.x) + Number(props.width) / 2;
    const cy = Number(props.y) - 13;
    return (
      <g pointerEvents="none" style={{ animation: 'fd-fade var(--dur-base) var(--ease-out) both' }}>
        <AvatarMark id={who[0].visitor_id ?? who[0].id} name={who[0].name ?? who[0].pay_name} cx={cx} cy={cy} r={10} />
      </g>
    );
  };
  const xAxis = { ...chartXAxis, dataKey: 'bucket', tickFormatter: fmtBucket };
  const yAxis = { ...chartYAxis, width: 52 };

  return (
    // While a note's card is open, the day's tooltip steps aside so the two never overlap.
    <div ref={wrap} className="relative [&[data-note]_.recharts-tooltip-wrapper]:!invisible">
      {rpv && (
        <div style={{ height: CHART_H - 24 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rpvSeries} margin={{ top: 14, right: 8, left: 0, bottom: 0 }}>
              {chartDefs()}
              <CartesianGrid {...chartGrid} />
              <XAxis {...xAxis} scale="band" />
              <YAxis yAxisId="p" {...yAxis} tickFormatter={(v) => money(v)} domain={[0, rpvTicks[3]]} ticks={rpvTicks} interval={0} />
              <Tooltip
                {...chartTooltip}
                cursor={bandCursor}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as (typeof rpvSeries)[0];
                  return (
                    <div className="pop min-w-[188px] px-3 py-2.5 text-xs" style={{ animation: 'fd-fade var(--dur-fast) var(--ease-out) both' }}>
                      <div className="mb-1.5 font-medium text-stone-500">{bucketLabel(d.bucket, g, true)}</div>
                      <div className="space-y-1">
                        <TipRow color={SERIES.revenue} label="Revenue/visitor" value={d.visitors ? money(d.rpv) : '–'} strong />
                        <TipRow label="Revenue" value={money(d.revenue)} />
                        <TipRow label="Visitors" value={fmtNumber(d.visitors)} />
                      </div>
                    </div>
                  );
                }}
              />
              <Area yAxisId="p" type="monotone" dataKey="rpv" fill="url(#fd-revenue)" {...chartLine(SERIES.revenue)} {...anim} />
              {noteLines(notes, 'p', true, onNoteHover)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      {!rpv && showV && (
        <div style={{ height: showR ? 200 : CHART_H - 24 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} syncId="overview" margin={{ top: 14, right: 8, left: 0, bottom: showR ? 6 : 0 }}>
              {chartDefs()}
              <CartesianGrid {...chartGrid} />
              <XAxis {...xAxis} scale="band" hide={showR} />
              <YAxis yAxisId="v" {...yAxis} allowDecimals={false} tickFormatter={(v) => fmtNumber(v)} domain={[0, ticks.visitors[4]]} ticks={ticks.visitors} interval={0} />
              {tip(true)}
              {importedBuckets && <ReferenceArea yAxisId="v" x1={importedBuckets.from} x2={importedBuckets.to} fill="var(--chart-cursor)" fillOpacity={0.6} ifOverflow="visible" />}
              <Area yAxisId="v" type="monotone" dataKey="visitors" fill="url(#fd-visitors)" {...chartLine(SERIES.visitors)} {...anim} />
              {noteLines(notes, 'v', true, onNoteHover)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      {!rpv && showR && (
        <div style={{ height: showV ? 148 : CHART_H - 24 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={line ? lineSeries : series} syncId="overview" margin={{ top: showV ? 26 : 30, right: 8, left: 0, bottom: 0 }}>
              {chartDefs()}
              <CartesianGrid {...chartGrid} />
              <XAxis {...xAxis} />
              <YAxis yAxisId="r" {...yAxis} tickFormatter={(v) => money(v, true)} domain={[0, ticks.revenue[2]]} ticks={ticks.revenue} interval={0} />
              {/* With the visitors chart shown, it owns the hover card; this one carries the crosshair on down. */}
              {showV ? <Tooltip {...chartTooltip} cursor={chartLineCursor} content={() => null} /> : tip(false)}
              {line ? (
                <>
                  <Area yAxisId="r" type="monotone" dataKey="combined" fill="url(#fd-revenue)" {...chartLine(SERIES.revenue)} {...anim} />
                  {data.imported?.seam_bucket && (
                    <ReferenceLine
                      yAxisId="r"
                      x={data.imported.seam_bucket}
                      stroke="var(--chart-axis)"
                      strokeDasharray="4 3"
                      label={{ value: `Native data starts ${bucketLabel(data.imported.seam_bucket, g)}`, position: 'insideTopRight', fill: 'var(--chart-axis)', fontSize: 11 }}
                    />
                  )}
                </>
              ) : (
                <Bar yAxisId="r" dataKey="revenue" fill="url(#fd-revenue-bar)" radius={[4, 4, 0, 0]} maxBarSize={18} activeBar={{ fill: SERIES.revenue }} {...anim}>
                  {daily && <LabelList dataKey="revenue" content={buyerLabel} />}
                </Bar>
              )}
              {noteLines(notes, 'r', !showV, onNoteHover)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <NoteCardLayer hover={hover} wrap={wrap} />
    </div>
  );
});

/** The hover card of a note marker, placed under the marker inside the chart and kept inside its width. */
function NoteCardLayer({ hover, wrap }: { hover: React.MutableRefObject<NoteHoverFn>; wrap: React.RefObject<HTMLDivElement> }) {
  const [h, setH] = useState<NoteHover | null>(null);
  useEffect(() => {
    hover.current = (next) => {
      const el = wrap.current;
      if (el) {
        if (next) el.dataset.note = '';
        else delete el.dataset.note;
      }
      setH(next);
    };
    return () => {
      hover.current = () => {};
    };
  }, [hover, wrap]);
  if (!h || !wrap.current) return null;
  const box = wrap.current.getBoundingClientRect();
  const left = Math.max(0, Math.min(h.x - box.left - 140, box.width - 280));
  return (
    <div className="pop pointer-events-none absolute z-30" style={{ left, top: h.y - box.top + 6, animation: 'fd-pop-in var(--dur-base) var(--ease-out) both' }} role="tooltip">
      <NoteHoverCard notes={h.notes} />
    </div>
  );
}

/** The crosshair of a band axis chart, in the middle of the hovered band. Recharts passes the plot box and points. */
function BandCursor({ n, points, width }: { n: number; points?: { x: number; y: number }[]; width?: number }) {
  if (!points?.length || !width || !n) return null;
  const x = points[0].x + width / n / 2;
  return <line x1={x} x2={x} y1={points[0].y} y2={points[points.length - 1].y} stroke="var(--chart-cursor-line)" strokeWidth={1} pointerEvents="none" />;
}

/** A tooltip row: swatch, label, right-aligned value. */
function TipRow({ color, label, value, strong }: { color?: string; label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: color ?? 'transparent' }} aria-hidden="true" />
      <span className="text-stone-500">{label}</span>
      <span className={`ml-auto pl-4 tabular-nums ${strong ? 'font-semibold text-ink' : 'font-medium text-stone-600'}`}>{value}</span>
    </div>
  );
}

/** The series with imported revenue added to native, as `combined` (the "Include imported history" line); `revenue` stays native. */
function importLine<T extends { revenue: number; imported_revenue?: number }>(series: T[]): (T & { combined: number })[] {
  return series.map((d) => ({ ...d, combined: d.revenue + (d.imported_revenue ?? 0) }));
}

/** A step of 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/**
 * The y ticks: five for visitors (0 to 4 steps), three for the revenue strip (0 to 2 steps), both round numbers,
 * revenue in major units.
 */
export function chartTicks(series: { visitors: number; revenue: number }[], decimals: number) {
  const maxV = Math.max(0, ...series.map((d) => d.visitors));
  const vStep = Math.max(1, Math.ceil(niceStep(maxV / 4)));
  const unit = 10 ** decimals;
  const maxR = Math.max(0, ...series.map((d) => d.revenue)) / unit;
  const rStep = niceStep(maxR / 2) * unit;
  return { visitors: [0, 1, 2, 3, 4].map((i) => i * vStep), revenue: [0, 1, 2].map((i) => i * rStep) };
}

/** "Quiet since Oct 31": no visit or app session for a day or more, and what to check. */
function QuietLine({ since, app, settingsHref, timezone }: { since: number; app: boolean; settingsHref: string; timezone: string }) {
  const day = new Date(since).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: timezone });
  const days = Math.floor((Date.now() - since) / 86_400_000);
  const gap = days >= 2 ? `${days} days` : `${Math.floor((Date.now() - since) / 3_600_000)} hours`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-200/60 bg-amber-50 px-5 py-2 text-[13px] text-amber-900" role="status">
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
      <span className="font-medium">Quiet since {day}.</span>
      <span>
        No {app ? 'app sessions' : 'visits'} for {gap}. {app ? 'Check that the app still sends events.' : 'Check the tracking script.'}
      </span>
      <a className="ml-auto font-medium underline underline-offset-2 hover:text-ink" href={settingsHref}>
        Settings & install
      </a>
    </div>
  );
}
