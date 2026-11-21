import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { TREND_RULES } from '../../../shared/trend-rules';
import { changeView, currencyDecimals, fmtMoney, fmtNumber, NO_COMPARISON } from '../../lib/format';
import { Favicon } from '../Icons';
import { TypeGlyph } from '../ProductType';
import { NoComparison, StatusChip } from '../ui';
import type { Money, SiteRow, TrendStatus } from './types';

export const PERIODS = [
  { value: 'today', label: 'Today', short: 'Today' },
  { value: '24h', label: 'Last 24 hours', short: '24h' },
  { value: '7d', label: 'Last 7 days', short: '7D' },
  { value: '30d', label: 'Last 30 days', short: '30D' },
  { value: '90d', label: 'Last 90 days', short: '90D' },
  { value: 'thisquarter', label: 'This quarter', short: 'This quarter' },
  { value: 'lastquarter', label: 'Last quarter', short: 'Last quarter' },
  { value: '12m', label: 'Last 12 months', short: '12M' },
];
export const PREVIOUS: Record<string, string> = {
  today: 'yesterday at this time',
  '24h': 'the 24 hours before',
  '7d': 'the 7 days before',
  '30d': 'the 30 days before',
  '90d': 'the 90 days before',
  thisquarter: 'the same days last quarter',
  lastquarter: 'the quarter before',
  '12m': 'the 12 months before',
};
export const PERIOD_PHRASE: Record<string, string> = {
  today: 'Today',
  '24h': 'The last 24 hours',
  '7d': 'The last 7 days',
  '30d': 'The last 30 days',
  '90d': 'The last 90 days',
  thisquarter: 'This quarter so far',
  lastquarter: 'Last quarter',
  '12m': 'The last 12 months',
};
export const PROVIDERS: Record<string, string> = { stripe: 'Stripe', app_store: 'App Store', google_play: 'Google Play', revenuecat: 'RevenueCat', dodo: 'Dodo', api: 'API', lemonsqueezy: 'Lemon Squeezy', polar: 'Polar', paddle: 'Paddle', gumroad: 'Gumroad', income: 'Other revenue' };

export const money = (minor: number, currency: string, compact = false) => fmtMoney(minor, currency, currencyDecimals(currency), compact);
/** Currencies by amount, largest first. */
export const currenciesOf = (m: Money) => Object.entries(m).sort((a, b) => b[1] - a[1]);
export const signedMoney = (d: number, cc: string) => `${d > 0 ? '+' : '−'}${money(Math.abs(d), cc, true)}`;
export const signedPct = (share: number) => `${share > 0 ? '+' : '−'}${Math.round(Math.abs(share) * 100)}%`;
export const shortDate = (ts: number) => new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });

/** How the App Store part of revenue is counted, for tooltips. */
export const REVENUE_NOTE =
  "Stripe, Dodo and API payments, plus App Store sales. For the App Store, FounderData uses Apple's daily sales report on the days it has imported and the purchases it recorded on the other days, such as today. Gross, after refunds, without sandbox purchases.";
export const PAYMENTS_ONLY_NOTE = "Counted from recorded payments. Apple's sales report has no customers, so App Store sales FounderData has no payment for are not in here.";
export const MRR_NOTE = 'Monthly recurring revenue at the end of the period, against its start: every paying subscription at its price per month. The Subscriptions tab of each site has the details.';
export const MRR_MOVEMENT_NOTE =
  'New is subscriptions first paid in the period. Expansion is price rises. Churned is subscriptions that ended, plus price cuts. New plus expansion minus churned is the change.';
export const NEW_CUSTOMERS_NOTE = `New customers count the visitors with a payment in the period that is not a renewal. Renewals add revenue, not customers. A payment without a visitor counts by the provider's customer id. ${PAYMENTS_ONLY_NOTE}`;
export const VISITOR_SUM_NOTE =
  "Each website's visitors, added up. Visitor ids belong to one site, so a person who visits two sites counts twice. App visitors have their own tile.";
const pct = (share: number) => `${Math.round(share * 100)}%`;
/** The rules of siteTrend in src/worker/home.ts, in words, from the same thresholds (src/shared/trend-rules.ts). */
export const STATUS_NOTE = `Growing and Declining mean revenue moved ${pct(TREND_RULES.revenueShare)} or more against the period before. Without revenue in either period, visitors decide: ${pct(TREND_RULES.visitorShare)} or more, from a base of ${TREND_RULES.visitorBase}. A site with no payments connected is Declining when its visitors fell that much. Quiet means no visit or app session for ${TREND_RULES.quietHours} hours and no revenue in the period. Flat is everything in between.`;

const UP = (
  <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 9.5V2.5M2.75 5.75 6 2.5l3.25 3.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
/** changeView's text without its arrow character: the chip draws the arrow. */
const bare = (t: string) => t.replace(/\s*[↑↓]$/, '');

type ChangeProps = { cur: number; prev: number; minBase: number; invert?: boolean; fmt?: (n: number) => string; noData?: boolean };

/** No change: a muted "0%", never a chip and never the words. Nothing at all when both periods are zero. */
function Flat({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap text-xs font-medium tabular-nums text-stone-400 ${className}`} title="No change against the period before">
      <span className="sr-only">no change</span>
      <span aria-hidden="true">0%</span>
    </span>
  );
}

/**
 * Change against the previous period, as plain colored text for rows and cards. On a small base (fewer than
 * `minBase` before, or 0) it shows the count, because 3 to 6 visitors is not a 100% story. With nothing to compare
 * (`noData`) it shows nothing and keeps the words for a screen reader, so "no data before" never repeats down a column.
 */
export function Change({ cur, prev, minBase, invert = false, fmt = fmtNumber, noData = false }: ChangeProps) {
  const v = changeView(cur, prev, { minBase, noData, fmt });
  if (v.kind === 'noData') return <span className="sr-only">{NO_COMPARISON}</span>;
  if (v.kind === 'none') return cur === 0 && prev === 0 ? null : <Flat />;
  const good = invert ? !v.up : v.up;
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-medium tabular-nums ${good ? 'text-emerald-700' : 'text-red-600'}`} title={`${fmt(prev)} before`}>
      <span className="sr-only">{v.up ? 'up' : 'down'}</span>
      {bare(v.text)}
      <span className={v.up ? '' : 'rotate-180'}>{UP}</span>
    </span>
  );
}

/**
 * The same change as a tinted chip, the ChangeBadge look, for the headline tiles. Nothing to compare is a muted dash
 * with a title (NoComparison), no change a muted "0%".
 */
export function Delta({ cur, prev, minBase, invert = false, fmt = fmtNumber, noData = false }: ChangeProps) {
  const v = changeView(cur, prev, { minBase, noData, fmt });
  if (v.kind === 'noData') return <NoComparison />;
  if (v.kind === 'none') return <Flat className="h-5" />;
  const good = invert ? !v.up : v.up;
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md px-1.5 text-xs font-medium tabular-nums ${good ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
      title={`${fmt(prev)} before`}
    >
      <span className={v.up ? '' : 'rotate-180'}>{UP}</span>
      <span className="sr-only">{v.up ? 'up' : 'down'}</span>
      {bare(v.text)}
    </span>
  );
}

/** A change in money, colored, with the percent against `prev` on hover. No change shows nothing. */
export function MoneyChange({ d, prev, currency, before = 'before' }: { d: number; prev: number; currency: string; before?: string }) {
  if (!d) return null;
  return (
    <span
      className={`whitespace-nowrap text-xs font-medium tabular-nums ${d > 0 ? 'text-emerald-700' : 'text-red-600'}`}
      title={prev > 0 ? `${signedPct(d / prev)} against ${money(prev, currency)} ${before}` : `Nothing ${before}`}
    >
      {signedMoney(d, currency)}
    </span>
  );
}

/** The revenue change in money, colored, with the percent on hover. */
export function RevenueChange({ site }: { site: SiteRow }) {
  return <MoneyChange d={site.trend.revenueChange} prev={site.previous.revenue[site.currency] ?? 0} currency={site.currency} />;
}

/** The MRR change over the period in money: what subscriptions added, which one-off sales do not. */
export function MrrChange({ site }: { site: SiteRow }) {
  const sub = site.subscriptions!;
  return <MoneyChange d={sub.mrr - sub.mrrStart} prev={sub.mrrStart} currency={site.currency} before="at the start" />;
}

export function InfoIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0 text-stone-400" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.3v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
    </svg>
  );
}

/** Closes a popover on a click outside `ref` or on Escape. */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}

/** A click-to-open panel for fine print that is too long for a hover tooltip. */
export function Popover({ label, trigger, children, align = 'left', triggerClass = 'rounded-md text-stone-500 hover:text-ink' }: { label: string; trigger: ReactNode; children: ReactNode; align?: 'left' | 'right'; triggerClass?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        className={`inline-flex items-center gap-1.5 transition-colors duration-fast ${triggerClass}`}
        aria-expanded={open}
        aria-controls={id}
        aria-label={typeof trigger === 'string' ? undefined : label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={`pop pop-in absolute top-full z-40 mt-2 w-[min(28rem,calc(100vw-2rem))] p-4 text-[13px] leading-relaxed text-stone-600 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A rounded phone outline for an iOS app without a website. */
export function PhoneGlyph({ size }: { size: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[28%] bg-stone-100 text-stone-500 ring-1 ring-inset ring-stone-200/80" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" />
        <path d="M10.5 18.5h3" />
      </svg>
    </span>
  );
}

export function SiteIcon({ site, size }: { site: Pick<SiteRow, 'type' | 'kind' | 'domain'>; size: number }) {
  if (site.type === 'extension' || site.type === 'newsletter') return <TypeGlyph type={site.type} size={size} />;
  if (site.kind === 'app') return <PhoneGlyph size={size} />;
  return <Favicon domain={site.domain} size={size} />;
}

const STATUS: Record<TrendStatus, { label: string; tone: 'ok' | 'neutral' | 'error' | 'warn' }> = {
  growing: { label: 'Growing', tone: 'ok' },
  flat: { label: 'Flat', tone: 'neutral' },
  declining: { label: 'Declining', tone: 'error' },
  quiet: { label: 'Quiet', tone: 'warn' },
  no_payments: { label: 'No payments connected', tone: 'neutral' },
};
export const statusLabel = (s: TrendStatus) => STATUS[s].label;
/** Ties on revenue change (often 0) sort by how good the status is, so quiet sites end up last. */
export const STATUS_ORDER: Record<TrendStatus, number> = { growing: 0, flat: 1, no_payments: 2, declining: 3, quiet: 4 };

export function TrendChip({ status }: { status: TrendStatus }) {
  const s = STATUS[status];
  return (
    <StatusChip tone={s.tone} title={STATUS_NOTE} className={status === 'no_payments' ? 'bg-transparent text-stone-500' : ''}>
      {s.label}
    </StatusChip>
  );
}

/**
 * `fd-stagger` for the first 900 ms after mount, then nothing. A list that re-sorts moves its nodes, and a moved node
 * would play its entrance again; dropping the class once the first one has played keeps entrances to the first load.
 */
export function useEntrance(): string {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(false), 900);
    return () => clearTimeout(t);
  }, []);
  return on ? 'fd-stagger' : '';
}

/** No revenue now or before: nothing to rank, so a compact tile each instead of a full row. */
export const noRevenue = (s: SiteRow) => !(s.current.revenue[s.currency] ?? 0) && !s.trend.revenueChange;
