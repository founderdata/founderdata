import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ReferenceLine } from 'recharts';
import { api, isViewer, qs, type ChartNote, type NoteImpact } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtDateTime } from '../lib/format';
import { navigate } from '../lib/nav';
import { useApi } from '../lib/useApi';
import { Modal } from './Modal';
import { Skeleton } from './ui/Skeleton';
import { StatusChip, type StatusTone } from './ui/StatusChip';
import { EmptyState } from './ui/EmptyState';

/**
 * Chart notes on the overview chart (src/worker/notes.ts, docs/GUIDE.md "Chart notes"): a marker per bucket that has
 * notes, colored by the kind of change, and under the chart the changes list, one row per note with its kind, target,
 * before and after, actor and the impact verdict (GET /api/sites/:id/notes/:nid/impact). A strip under the KPI row
 * sums the period up. Adding and deleting stays in the notes window.
 */

export interface ChartNotes {
  list: ChartNote[];
  reload: () => void;
}

/** The notes in the dashboard's current range. */
export function useChartNotes(): ChartNotes {
  const { site, q, reloadKey } = useDash();
  const [bump, setBump] = useState(0);
  const { data } = useApi<ChartNote[]>(`/api/sites/${site.id}/notes?${qs({ ...q, filters: {} })}`, reloadKey * 1000 + bump);
  return { list: data ?? [], reload: () => setBump((b) => b + 1) };
}

/** The verdict fields of the impact (docs/API.md, "The verdict"). Each is optional, so an older server still renders. */
type Verdict = 'better' | 'worse' | 'inconclusive';
export type Impact = NoteImpact & {
  verdict?: Verdict | null;
  verdict_metric?: string | null;
  /** What the note is judged on (docs/API.md "The verdict"); null for the visit rule of an older note. */
  metric?: string | null;
  reason?: string | null;
  /** "page": a page only. "site": the whole site. keyword, prompt, ads and app: the metric's own block. */
  scope?: 'page' | 'site' | 'keyword' | 'prompt' | 'ads' | 'app' | null;
  page?: string | null;
  /** scope "keyword": an ASO note judged by the keyword's App Store rank. change.keyword_rank is the mean places moved. */
  keyword?: { term: string; country: string | null } | null;
  review_after?: string | null;
  /** An experiment's start or stop (FounderData Pro): no verdict, its own results judge it. */
  experiment?: { key: string | null; dashboard_path: string; api_path: string } | null;
  note?: { review?: { reviewed_at: string; outcome: 'kept' | 'reverted' | 'iterated' | null; comment: string | null } | null };
};
type ImpactState = Impact | { error: string };

const DAY = 86_400_000;

/** What a marker and a chip look like per kind of change. Plain notes (no kind) get a small neutral dot. */
type Kind = NonNullable<ChartNote['change_kind']> | 'note';
const KIND: Record<Kind, { label: string; color: string }> = {
  pricing: { label: 'Pricing', color: 'var(--note-pricing)' },
  launch: { label: 'Launch', color: 'var(--note-launch)' },
  copy: { label: 'Copy', color: 'var(--note-copy)' },
  seo: { label: 'SEO', color: 'var(--note-seo)' },
  ads: { label: 'Ads', color: 'var(--note-ads)' },
  release: { label: 'Release', color: 'var(--note-release)' },
  aso: { label: 'ASO', color: 'var(--note-aso)' },
  ai: { label: 'AI', color: 'var(--note-ai)' },
  outage: { label: 'Outage', color: 'var(--note-outage)' },
  other: { label: 'Other', color: 'var(--note-other)' },
  note: { label: 'Note', color: 'var(--chart-note)' },
};

/**
 * A kind's glyph as stroke paths on a 24 unit grid, so the marker, the chip and the legend draw the same mark: a
 * dollar sign, an arrow up, a T, a magnifier, a megaphone, a box, a phone. Color is never the only cue.
 */
const GLYPH: Record<Kind, string[]> = {
  pricing: ['M12 3v18', 'M16.5 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7'],
  launch: ['M12 20V5', 'M5.5 11.5 12 5l6.5 6.5'],
  copy: ['M5 7V4.5h14V7', 'M12 4.5V20', 'M9 20h6'],
  seo: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M15.5 15.5 20 20'],
  ads: ['M4 10v4h3l7 4.5v-13L7 10z', 'M17.5 9a4 4 0 0 1 0 6'],
  release: ['M12 3 4 7.5v9L12 21l8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  aso: ['M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z', 'M11 17.5h2'],
  ai: ['M12 4v4', 'M12 16v4', 'M4 12h4', 'M16 12h4', 'M7 7l2.5 2.5', 'M14.5 14.5 17 17', 'M17 7l-2.5 2.5', 'M9.5 14.5 7 17'],
  outage: ['M4 12h5', 'M15 12h5', 'M10.5 8 9 16', 'M15 8l-1.5 8'],
  other: ['M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  note: [],
};

/** A kind's glyph at `size` px, in `color` (currentColor by default). */
function Glyph({ kind, size, color = 'currentColor', width = 2.5 }: { kind: Kind; size: number; color?: string; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {GLYPH[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Chip text in a kind's color, pulled toward the ink so light hues stay readable in both themes. */
const chipText = (color: string) => `color-mix(in srgb, ${color} 72%, rgb(var(--ink)))`;

/** A note's kind: its annotation, an app version counts as a release, anything else is a plain note. */
const kindOf = (n: ChartNote): Kind => n.change_kind ?? (n.kind === 'version' ? 'release' : 'note');

/** Who made the change: the actor, else where the note came from. */
const actorOf = (n: ChartNote) => n.actor ?? (n.kind === 'manual' ? 'You' : n.kind === 'version' ? 'FounderData' : 'API');

/** "$19 → $24", "→ $24" or "$19 →", or '' when the note has neither. */
const beforeAfter = (n: ChartNote) => (n.before || n.after ? [n.before, '→', n.after].filter(Boolean).join(' ') : '');

/** A note's hover text on the chart: the text, then the kind, target and actor, then the change. */
const hoverText = (n: ChartNote) =>
  [n.text, [kindOf(n) !== 'note' && KIND[kindOf(n)].label, n.target, n.actor && `by ${n.actor}`].filter(Boolean).join(', '), beforeAfter(n)]
    .filter(Boolean)
    .join('\n');

const signedPct = (x: number) => new Intl.NumberFormat('en', { style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 0 }).format(x);
const shortDate = (ms: number, tz: string) => new Intl.DateTimeFormat('en', { timeZone: tz, month: 'short', day: 'numeric' }).format(ms);

/** The tint behind a chip or marker in a kind's color. color-mix keeps it on the theme tokens in both themes. */
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// ---------- impact

/** Notes whose impact loads with the page: the newest ones. Older ones load when the list shows them. */
const AUTO_IMPACT = 10;

/** The impact of each note, loaded once per note and kept until the site or the refresh button changes. */
export function useNoteImpacts(notes: ChartNote[]) {
  const { site, reloadKey } = useDash();
  const [map, setMap] = useState<Record<string, ImpactState>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    asked.current = new Set();
    setMap({});
  }, [site.id, reloadKey]);
  const load = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        if (asked.current.has(id)) continue;
        asked.current.add(id);
        // No window: each note is judged over its own (28 days for Search Console and AI notes, 7 for the rest).
        api<Impact>(`/api/sites/${site.id}/notes/${id}/impact`).then(
          (d) => setMap((m) => ({ ...m, [id]: d })),
          (e) => setMap((m) => ({ ...m, [id]: { error: (e as Error).message } })),
        );
      }
    },
    // reloadKey: a refresh asks again.
    [site.id, reloadKey],
  );
  useEffect(() => load(newestFirst(notes).slice(0, AUTO_IMPACT).map((n) => n.id)), [notes, load]);
  return { map, load };
}
export type NoteImpacts = ReturnType<typeof useNoteImpacts>;

const newestFirst = (notes: ChartNote[]) => [...notes].sort((a, b) => b.ts - a.ts);

/**
 * The number a change is judged by: the server's verdict_metric, else revenue per visitor when either side has
 * revenue, else visitors.
 */
function headline(i: Impact): { label: string; rel: number | null; shown?: string } {
  if (i.scope === 'keyword' || i.verdict_metric === 'google_rank' || i.verdict_metric === 'search_position') {
    const m = i.verdict_metric === 'search_position' ? 'search_position' : i.verdict_metric === 'google_rank' || i.metric === 'google_rank' ? 'google_rank' : 'keyword_rank';
    const label = m === 'search_position' ? 'Position' : m === 'google_rank' ? 'Google rank' : 'Rank';
    const places = i.change[m]?.absolute ?? null;
    if (places === null) return { label, rel: null, shown: 'no data' };
    return { label, rel: places, shown: `${places > 0 ? '+' : ''}${places} ${Math.abs(places) === 1 ? 'place' : 'places'}` };
  }
  // Rates in points: AI mention and citation rates.
  const special: Record<string, string> = {
    search_clicks: 'Google clicks',
    ai_mention_rate: 'AI mentions',
    ai_citation_rate: 'AI citations',
    cpa: 'CPA',
    roas: 'ROAS',
    paywall_conversion: 'Paywall conv.',
    trial_rate: 'Trials/view',
  };
  const sm = i.verdict_metric ?? i.metric ?? null;
  if (sm && special[sm]) {
    const c = i.change[sm];
    if (!c) return { label: special[sm], rel: null, shown: 'no data' };
    if (sm.startsWith('ai_')) {
      const pts = Math.round(c.absolute * 100);
      return { label: special[sm], rel: pts, shown: `${pts > 0 ? '+' : ''}${pts} pts` };
    }
    // A lower CPA is better: the headline's color follows the verdict, so flip its sign.
    return { label: special[sm], rel: sm === 'cpa' && c.relative !== null ? -c.relative : c.relative, shown: c.relative === null ? 'new' : signedPct(c.relative) };
  }
  const m = i.verdict_metric && i.verdict_metric in labels ? (i.verdict_metric as keyof typeof labels) : i.before.revenue || i.after.revenue ? 'revenue_per_visitor' : 'visitors';
  const c = i.change[m];
  if (c) return { label: labels[m], rel: c.relative };
  return { label: 'Visitors', rel: i.change.visitors?.relative ?? null };
}
const labels = { revenue_per_visitor: 'Rev/visitor', conversion_rate: 'Conversion', visitors: 'Visitors' } as const;

/** When the window closes: the server's review_after, else the note's time plus the window. */
function reviewAt(i: Impact, note: ChartNote): number {
  const t = i.review_after ? Date.parse(i.review_after) : NaN;
  return Number.isFinite(t) ? t : note.ts + i.window_days * DAY;
}

/** "Only /pricing" or "Whole site", from the impact's scope; null when the server sends none. */
function scopeLabel(i: Impact): string | null {
  if (i.scope === 'page' && i.page) return `Only ${i.page}`;
  if (i.scope === 'keyword' && i.keyword) return `"${i.keyword.term}"${i.keyword.country ? ` in ${i.keyword.country.toUpperCase()}` : ''}`;
  if (i.scope === 'prompt') return 'One AI prompt';
  if (i.scope === 'ads') return 'Ad spend';
  if (i.scope === 'app') return 'App paywall';
  return i.scope === 'site' ? 'Whole site' : null;
}

const OUTCOME = { kept: 'Kept', reverted: 'Reverted', iterated: 'Iterated' } as const;

/** One status per note for the pill and the strip's tally. */
type Status = Verdict | 'experiment' | 'measuring' | 'thin' | 'measured' | 'loading' | 'error';
function statusOf(i: ImpactState | undefined): Status {
  if (!i) return 'loading';
  if ('error' in i) return 'error';
  if (i.experiment) return 'experiment';
  // An open window has no verdict yet; the server says inconclusive, the pill counts the days.
  if (i.days_covered < 1 || !i.complete) return i.verdict && i.verdict !== 'inconclusive' ? i.verdict : 'measuring';
  if (i.verdict) return i.verdict;
  return i.enough_data ? 'measured' : 'thin';
}

const PILL: Record<Verdict, { label: string; tone: StatusTone }> = {
  better: { label: 'Better', tone: 'ok' },
  worse: { label: 'Worse', tone: 'error' },
  // The window closed and the answer is "no clear change". An open window is the dashed pill below.
  inconclusive: { label: 'Inconclusive', tone: 'neutral' },
};

/** "After 7 days: revenue per visitor +6%, visitors -2%. Not enough data yet." The pill's hover text. */
function impactText(i: Impact): string {
  if (i.days_covered < 1) return 'The impact shows after the first full day.';
  const days = Math.floor(i.days_covered);
  const head = i.complete ? `After ${i.window_days} days` : `After ${days} of ${i.window_days} days`;
  const parts: string[] = [];
  const rpv = i.change.revenue_per_visitor?.relative;
  if (rpv != null && (i.before.revenue || i.after.revenue)) parts.push(`revenue per visitor ${signedPct(rpv)}`);
  const v = i.change.visitors?.relative;
  parts.push(v != null ? `visitors ${signedPct(v)}` : `visitors 0 → ${i.after.visitors}`);
  let out = `${head}: ${parts.join(', ')}.`;
  if (!i.enough_data) out += ' Not enough data yet.';
  const others = i.overlapping.length;
  if (others) out += ` ${others === 1 ? '1 other note falls' : `${others} other notes fall`} in the same days.`;
  return out;
}

function StatusPill({ impact, note }: { impact: ImpactState | undefined; note: ChartNote }) {
  const { site } = useDash();
  const status = statusOf(impact);
  if (status === 'loading') return <Skeleton className="h-[22px] w-20 rounded-full" />;
  if (status === 'error')
    return (
      <StatusChip tone="neutral" dot={false} title={(impact as { error: string }).error} className="!text-stone-400">
        No impact
      </StatusChip>
    );
  const i = impact as Impact;
  if (status === 'experiment' && i.experiment) return <ExperimentLink to={i.experiment.dashboard_path} reason={i.reason ?? undefined} />;
  const title = [i.reason, impactText(i), scopeLabel(i)].filter(Boolean).join('\n');
  if (status === 'better' || status === 'worse' || status === 'inconclusive') {
    return (
      <StatusChip tone={PILL[status].tone} title={title}>
        {PILL[status].label}
      </StatusChip>
    );
  }
  if (status === 'measuring') {
    const days = Math.floor(i.days_covered);
    // Outlined and dashed: still measuring, so it must not read like the filled Inconclusive pill.
    const open = 'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-stone-300 px-2 text-xs font-medium text-stone-500';
    return (
      <span className={open} title={`${title}\nThe ${i.window_days} days close on ${shortDate(reviewAt(i, note), site.timezone)}.`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-stone-400" aria-hidden="true" />
        Day {Math.max(days, 0)} of {i.window_days}
      </span>
    );
  }
  return (
    <StatusChip tone="neutral" dot={false} title={title}>
      {status === 'thin' ? 'Too little data' : `${i.window_days} of ${i.window_days} days`}
    </StatusChip>
  );
}

/**
 * An experiment's start or stop has no verdict: both versions run after it. The pill opens the experiment, whose
 * results judge it.
 */
function ExperimentLink({ to, reason }: { to: string; reason?: string }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      title={reason}
      className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full bg-stone-100 px-2 text-xs font-medium text-stone-600 underline-offset-2 hover:text-ink hover:underline"
    >
      See results
    </a>
  );
}

/** The impact column: the headline change, and under it visitors, the scope or the day the window closes. */
function ImpactCell({ impact, note }: { impact: ImpactState | undefined; note: ChartNote }) {
  const { site } = useDash();
  if (!impact)
    return (
      <div className="flex flex-col items-end gap-1.5">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
    );
  if ('error' in impact) return <span className="text-xs text-stone-300">–</span>;
  // Before and after mix both versions of an experiment, so no change is shown for its notes.
  if (impact.experiment) return <span className="text-right text-xs text-stone-500">Judged on the experiment page</span>;
  if (impact.days_covered < 1) return <span className="text-xs text-stone-400">After the first day</span>;
  const h = headline(impact);
  const thin = !impact.enough_data;
  // Until the window closes the number is a partial reading: gray and regular weight, never a green or red headline.
  const open = !impact.complete;
  const color = open ? 'font-normal text-stone-400' : h.rel === null || h.rel === 0 || thin ? 'font-medium text-stone-500' : h.rel > 0 ? 'font-medium text-emerald-600' : 'font-medium text-red-500';
  const v = impact.change.visitors?.relative;
  const sub = !impact.complete
    ? `so far, verdict on ${shortDate(reviewAt(impact, note), site.timezone)}`
    : (scopeLabel(impact) ?? (h.label !== 'Visitors' && v != null ? `visitors ${signedPct(v)}` : ''));
  return (
    <div className="min-w-0 text-right leading-tight" title={impactText(impact)}>
      <div className={`text-[13px] tabular-nums ${color}`}>
        <span className={`font-normal ${open ? 'text-stone-400' : 'text-stone-500'}`}>{h.label}</span> {h.shown ?? (h.rel === null ? 'new' : signedPct(h.rel))}
      </div>
      <div className="truncate text-xs text-stone-500" title={sub}>
        {sub}
      </div>
    </div>
  );
}

// ---------- chart markers

/** Where the hover card for a marker goes, relative to the page, and the notes it lists. */
export interface NoteHover {
  x: number;
  y: number;
  notes: ChartNote[];
}
export type NoteHoverFn = (h: NoteHover | null) => void;

function Flag({ viewBox, label, kind, notes, onHover }: { viewBox?: { x: number; y: number }; label: string; kind: Kind; notes: ChartNote[]; onHover?: NoteHoverFn }) {
  if (!viewBox) return null;
  const { color } = KIND[kind];
  const count = notes.length;
  const y = viewBox.y + 1;
  const show = (e: { currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    onHover?.({ x: r.left + r.width / 2, y: r.bottom, notes });
  };
  const hide = () => onHover?.(null);
  // A marker is a quiet 16 px stone disc. The kind's color shows as a thin ring, and in full on hover or focus; a
  // count or the kind's glyph sits inside, so color is never the only cue.
  const ink = 'rgb(var(--stone-500))';
  return (
    <g
      className="fd-note-flag"
      style={{ cursor: 'default', outline: 'none' }}
      tabIndex={0}
      role="img"
      aria-label={label}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {!onHover && <title>{label}</title>}
      <circle cx={viewBox.x} cy={y} r={14} fill="transparent" />
      <g className="transition-transform duration-fast ease-out [.fd-note-flag:focus-visible_&]:scale-[1.15] [.fd-note-flag:hover_&]:scale-[1.15]" style={{ transformOrigin: `${viewBox.x}px ${y}px` }}>
        <circle cx={viewBox.x} cy={y} r={8} fill="rgb(var(--stone-100))" stroke="var(--chart-dot-ring)" strokeWidth={2} />
        <circle cx={viewBox.x} cy={y} r={8} fill="none" stroke={color} strokeWidth={1.25} strokeOpacity={0.55} />
        <circle
          cx={viewBox.x}
          cy={y}
          r={8}
          fill={tint(color, 16)}
          stroke={color}
          strokeWidth={1.5}
          className="opacity-0 transition-opacity duration-fast [.fd-note-flag:focus-visible_&]:opacity-100 [.fd-note-flag:hover_&]:opacity-100"
        />
        {count > 1 ? (
          <text x={viewBox.x} y={y} dy="0.35em" textAnchor="middle" fontSize={10} fontWeight={600} fill="rgb(var(--stone-600))" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {count}
          </text>
        ) : kind === 'note' ? (
          <circle cx={viewBox.x} cy={y} r={2} fill={ink} />
        ) : (
          <g transform={`translate(${viewBox.x - 4.75} ${y - 4.75}) scale(0.396)`} fill="none" stroke={ink} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            {GLYPH[kind].map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
        )}
      </g>
    </g>
  );
}

/**
 * The note markers, as children of a chart (Recharts reads its children by type, so this is a function, not a
 * component). One marker per bucket; several notes in a bucket share it and show their count. `flags` false draws
 * nothing, for the revenue strip under the chart. `onHover` opens the hover card.
 */
export function noteLines(notes: ChartNote[], yAxisId: string, flags = true, onHover?: NoteHoverFn) {
  // Without markers a line has nothing to belong to: the revenue strip under the chart draws none.
  if (!flags) return [];
  const byBucket = new Map<string, ChartNote[]>();
  for (const n of notes) byBucket.set(n.bucket, [...(byBucket.get(n.bucket) ?? []), n]);
  return [...byBucket].map(([bucket, list]) => {
    const kinds = new Set(list.map(kindOf));
    const kind: Kind = kinds.size === 1 ? kindOf(list[0]) : 'other';
    return (
      <ReferenceLine
        key={`note-${bucket}`}
        x={bucket}
        yAxisId={yAxisId}
        stroke="var(--chart-note-line)"
        strokeDasharray="2 4"
        // The drop line shows only for the marker under the pointer or the keyboard.
        className="[&>line]:opacity-0 [&>line]:transition-opacity [&>line]:duration-fast [&:focus-within>line]:opacity-100 [&:hover>line]:opacity-100"
        label={<Flag label={list.map(hoverText).join('\n\n')} kind={kind} notes={list} onHover={onHover} />}
      />
    );
  });
}

/** The card a marker opens: each note of the bucket with its kind, time, target, before and after, and who made it. */
export function NoteHoverCard({ notes }: { notes: ChartNote[] }) {
  const { site } = useDash();
  const shown = newestFirst(notes).slice(0, 4);
  return (
    <div className="w-[280px] space-y-2.5 px-3.5 py-3 text-[13px]">
      {shown.map((n) => {
        const ba = beforeAfter(n);
        return (
          <div key={n.id} className="min-w-0">
            <div className="flex items-center gap-2">
              <KindChip kind={kindOf(n)} />
              <span className="ml-auto shrink-0 text-xs tabular-nums text-stone-400">{fmtDateTime(n.ts, site.timezone)}</span>
            </div>
            <p className="mt-1.5 line-clamp-3 leading-snug text-ink">{n.text}</p>
            {(n.target || ba) && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                {n.target && <code className="max-w-full truncate rounded bg-stone-100 px-1 py-px font-mono text-[11px] text-stone-600">{n.target}</code>}
                {ba && (
                  <span className="min-w-0 break-words">
                    {n.before && <span className="text-stone-400 line-through decoration-stone-300">{n.before}</span>}
                    <span className="px-1 text-stone-500">→</span>
                    {n.after && <span className="font-medium text-ink">{n.after}</span>}
                  </span>
                )}
              </div>
            )}
            <div className="mt-1 text-xs text-stone-400">by {actorOf(n)}</div>
          </div>
        );
      })}
      {notes.length > shown.length && <div className="border-t border-stone-200/70 pt-2 text-xs text-stone-400">and {notes.length - shown.length} more in the Changes tab</div>}
    </div>
  );
}

// ---------- the strip under the KPI row

/** "3 changes in this period, 2 actors, 1 better, 1 worse. Revenue per visitor +6% against the period before." */
export function ChangesStrip({
  notes,
  impacts,
  rpv,
}: {
  notes: ChartNote[];
  impacts: NoteImpacts;
  /** Revenue per visitor now and in the period before; null without payments. */
  rpv: { cur: number; prev: number; noData: boolean } | null;
}) {
  if (!notes.length) return null;
  const actors = [...new Set(notes.map(actorOf))];
  const tally: Partial<Record<Status, number>> = {};
  for (const n of notes) {
    const s = statusOf(impacts.map[n.id]);
    tally[s] = (tally[s] ?? 0) + 1;
  }
  const kinds = [...new Set(newestFirst(notes).map(kindOf))].slice(0, 4);
  const parts: { text: string; cls: string }[] = [
    { text: `${tally.better ?? 0} better`, cls: 'text-emerald-700' },
    { text: `${tally.worse ?? 0} worse`, cls: 'text-red-600' },
    { text: `${tally.inconclusive ?? 0} inconclusive`, cls: 'text-stone-500' },
    { text: `${tally.measuring ?? 0} measuring`, cls: 'text-stone-500' },
    { text: `${tally.measured ?? 0} measured`, cls: 'text-stone-500' },
    { text: `${tally.thin ?? 0} with too little data`, cls: 'text-stone-500' },
    { text: `${tally.experiment ?? 0} judged as experiments`, cls: 'text-stone-500' },
  ].filter((p) => !p.text.startsWith('0 '));
  const rpvChange = rpv && !rpv.noData && rpv.prev > 0 ? (rpv.cur - rpv.prev) / rpv.prev : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-100 px-5 py-2.5 text-sm">
      <span className="flex -space-x-1" aria-hidden="true">
        {kinds.map((k) => (
          <span key={k} className="h-3 w-3 rounded-full ring-2 ring-white" style={{ background: KIND[k].color }} />
        ))}
      </span>
      <a href="#changes" className="font-medium text-ink underline-offset-2 hover:underline">
        {notes.length === 1 ? '1 change' : `${notes.length} changes`} in this period
      </a>
      <Sep />
      <span className="text-stone-600" title={actors.join(', ')}>
        {actors.length === 1 ? `by ${actors[0]}` : `${actors.length} actors`}
      </span>
      {parts.length > 0 && <Sep />}
      {parts.map((p, i) => (
        <span key={p.text} className={p.cls}>
          {p.text}
          {i < parts.length - 1 ? ',' : ''}
        </span>
      ))}
      {rpvChange !== null && (
        <span className="text-stone-500 sm:ml-auto">
          Revenue per visitor{' '}
          <span className={`font-medium tabular-nums ${rpvChange > 0 ? 'text-emerald-600' : rpvChange < 0 ? 'text-red-500' : 'text-stone-600'}`}>{signedPct(rpvChange)}</span> against
          the period before
        </span>
      )}
    </div>
  );
}

const Sep = () => (
  <span className="hidden text-stone-300 sm:inline" aria-hidden="true">
    ·
  </span>
);

// ---------- the changes list under the chart

function KindChip({ kind }: { kind: Kind }) {
  const { color, label } = KIND[kind];
  const style: CSSProperties = { background: tint(color, 12), color: chipText(color) };
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium" style={kind === 'note' ? undefined : style}>
      {kind === 'note' ? <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" /> : <Glyph kind={kind} size={12} color={color} />}
      <span className={kind === 'note' ? 'text-stone-500' : ''}>{label}</span>
    </span>
  );
}

/** The chart's key: a quiet chip per kind of change in the period, in KIND's order. */
export function NoteLegend({ notes }: { notes: ChartNote[] }) {
  const present = new Set(notes.map(kindOf));
  const kinds = (Object.keys(KIND) as Kind[]).filter((k) => present.has(k));
  if (!kinds.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1" role="group" aria-label="Kinds of change on the chart">
      {kinds.map((k) => (
        <span key={k} className="inline-flex h-[18px] items-center gap-1 rounded-md px-1 text-[11px] font-medium text-stone-400">
          <span className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full" style={{ boxShadow: `inset 0 0 0 1.25px ${tint(KIND[k].color, 60)}` }} aria-hidden="true">
            {k === 'note' ? <span className="h-1 w-1 rounded-full bg-stone-400" /> : <Glyph kind={k} size={7} width={3.2} />}
          </span>
          {KIND[k].label}
        </span>
      ))}
    </div>
  );
}

function Actor({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-stone-600" title={name}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[10px] font-semibold uppercase text-stone-500" aria-hidden="true">
        {name.slice(0, 1)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Target and before → after in code type, then how a review ended. A closed window with no verdict adds the reason
 * (too few visitors, a change under the threshold); the other reasons repeat the impact column and show on hover.
 */
function Details({ note, impact }: { note: ChartNote; impact: ImpactState | undefined }) {
  const ba = beforeAfter(note);
  const i = impact && !('error' in impact) ? impact : null;
  const reason = i?.complete && i.verdict === 'inconclusive' ? i.reason : null;
  const review = i?.note?.review;
  if (!note.target && !ba && !reason && !review) return null;
  return (
    <>
      {(review?.outcome || note.target || ba) && (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
          {review?.outcome && (
            <span className="shrink-0 rounded bg-stone-100 px-1 py-px text-[11px] font-medium text-stone-600" title={review.comment ?? undefined}>
              {OUTCOME[review.outcome]}
            </span>
          )}
          {note.target && (
            <code className="min-w-0 max-w-full truncate rounded bg-stone-100 px-1 py-px font-mono text-[11px] text-stone-600" title={note.target}>
              {note.target}
            </code>
          )}
          {ba && (
            // Wraps instead of cutting off: "$79 a month → $99 a month" is the point of the row.
            <span className="min-w-0 break-words text-xs leading-snug" title={ba}>
              {note.before && <span className="text-stone-400 line-through decoration-stone-300">{note.before}</span>}
              <span className="px-1 text-stone-600" aria-label="to">
                →
              </span>
              {note.after && <span className="text-stone-700">{note.after}</span>}
            </span>
          )}
        </div>
      )}
      {reason && (
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-stone-500" title={reason}>
          {reason}
        </p>
      )}
    </>
  );
}

function ChangeRow({ note, impact }: { note: ChartNote; impact: ImpactState | undefined }) {
  const { site } = useDash();
  const kind = kindOf(note);
  return (
    <li className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2.5 transition-colors duration-fast hover:bg-stone-50 sm:grid-cols-[52px_92px_minmax(0,1fr)_128px_150px_112px] sm:gap-x-4">
      <span className="hidden text-xs tabular-nums text-stone-400 sm:block" title={fmtDateTime(note.ts, site.timezone)}>
        {shortDate(note.ts, site.timezone)}
      </span>
      <span className="hidden sm:block">
        <KindChip kind={kind} />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="sm:hidden">
            <KindChip kind={kind} />
          </span>
          <span className="line-clamp-2 text-sm leading-snug text-ink" title={note.text}>
            {note.text}
          </span>
        </div>
        <Details note={note} impact={impact} />
        <div className="mt-0.5 text-xs text-stone-400 sm:hidden">
          {shortDate(note.ts, site.timezone)}, {actorOf(note)}
        </div>
      </div>
      <span className="hidden min-w-0 sm:block">
        <Actor name={actorOf(note)} />
      </span>
      <span className="hidden justify-end sm:flex">
        <ImpactCell impact={impact} note={note} />
      </span>
      <span className="flex justify-end">
        <StatusPill impact={impact} note={note} />
      </span>
    </li>
  );
}

/** Rows the list shows before "Show all". */
const FIRST_ROWS = 5;

const localInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** The Changes tab: the period's changes as rows, newest first, and the window to add or delete notes. */
/** `bare`: inside a tab that already names it, so no heading row of its own, only the button to add notes. */
export function ChangesList({ notes, impacts, bare = false }: { notes: ChartNotes; impacts: NoteImpacts; bare?: boolean }) {
  const { site } = useDash();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [when, setWhen] = useState(() => localInput(Date.now()));
  const [error, setError] = useState('');
  const sorted = newestFirst(notes.list);
  const shown = all ? sorted : sorted.slice(0, FIRST_ROWS);
  const n = sorted.length;
  const { load } = impacts;
  const shownIds = shown.map((x) => x.id).join();
  useEffect(() => load(shownIds ? shownIds.split(',') : []), [shownIds, load]);

  async function add() {
    setError('');
    try {
      await api(`/api/sites/${site.id}/notes`, { method: 'POST', json: { text, ts: new Date(when).getTime() } });
      setText('');
      notes.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    await api(`/api/sites/${site.id}/notes/${id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    notes.reload();
  }

  const manage = !isViewer() && (
    <button
      className="btn-ghost h-8 px-2.5 text-xs"
      onClick={() => {
        setWhen(localInput(Date.now()));
        setOpen(true);
      }}
    >
      {n ? 'Add or delete notes' : '+ Add note'}
    </button>
  );

  return (
    <div id="changes" className={bare ? '' : 'scroll-mt-6 border-t border-stone-100'}>
      {bare ? (
        <div className="flex min-h-[32px] items-center justify-between gap-3 px-3 pb-1">
          <span className="text-xs text-stone-400">{n ? "Impact over each change's own window" : ''}</span>
          {manage}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-ink">Changes</h3>
            <span className="text-xs text-stone-400">
              {n ? `${n} in this period` : 'None in this period'}
              {n > 0 && <span className="hidden sm:inline">. SEO and AI changes get 28 days, the rest 7.</span>}
            </span>
          </div>
          {manage}
        </div>
      )}
      {n === 0 ? (
        <EmptyState
          compact
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
            </svg>
          }
          title="No changes in this period"
        >
          A launch or a price change shows here with its impact.
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-px">
            {shown.map((note) => (
              <ChangeRow key={note.id} note={note} impact={impacts.map[note.id]} />
            ))}
          </ul>
          {n > FIRST_ROWS && (
            <div className="flex justify-end pt-2">
              <button className="rounded-md px-2 py-1 text-xs font-medium text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink" onClick={() => setAll((a) => !a)}>
                {all ? 'Show fewer' : `Show all ${n}`}
              </button>
            </div>
          )}
        </>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Chart notes" width="max-w-lg">
        <p className="text-sm text-stone-500">
          Mark a launch, a deploy or a price change. It shows on the chart and in the changes list. Deploy scripts and agents add notes with{' '}
          <code>POST /api/v1/notes</code>.
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label className="label">Note</label>
            <input className="input" maxLength={280} placeholder="Launched on Product Hunt" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div>
            <label className="label">When (your local time)</label>
            <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <button className="btn-dark" disabled={!text.trim() || !when} onClick={add}>
              Add note
            </button>
            {error && <span className="text-sm text-red-600">{error}</span>}
          </div>
        </div>
        {n > 0 && (
          <ul className="mt-6 divide-y divide-stone-100 border-t border-stone-100 text-sm">
            {sorted.map((note) => (
              <li key={note.id} className="flex items-center gap-3 py-2">
                <KindChip kind={kindOf(note)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{note.text}</div>
                  <div className="text-xs text-stone-500">
                    {fmtDateTime(note.ts, site.timezone)}, {actorOf(note)}
                  </div>
                </div>
                <button className="rounded-lg px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 hover:text-red-600" onClick={() => remove(note.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
