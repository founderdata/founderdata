import { useMemo } from 'react';
import { navigate } from '../../App';
import { bucketLabel, fmtMoney, fmtNumber, fmtPct } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { Favicon, SourceIcon } from '../Icons';
import { Modal } from '../Modal';
import { MeterBar, SkeletonRows } from '../ui';
import { currenciesOf, money, PhoneGlyph } from './shared';
import { PaymentMeta, shownAmount } from './SourcesPayments';
import type { Money, Payment } from './types';

/** GET /api/home/bucket (src/worker/home-bucket.ts): one bar of the revenue chart, opened. */
interface BucketData {
  bucket: string;
  granularity: 'hour' | 'day' | 'week' | 'month';
  tz: string;
  from: number;
  to: number;
  revenue: Money;
  payments: number;
  sites: { id: string; name: string; domain: string; revenue: Money; payments: number; appStoreReport: { units: number; revenue: Money } | null }[];
  sources: { label: string; domain: string | null; channel: string; revenue: Money; payments: number; appStore?: boolean; noVisit?: boolean }[];
  list: (Payment & { reported: boolean })[];
  more: boolean;
}

const UNIT: Record<BucketData['granularity'], string> = { hour: 'hour', day: 'day', week: 'week', month: 'month' };
const APP_STORE_ROW_NOTE = "App Store sales from Apple's report that no payment linked to a visit explains.";
const NO_SOURCE_ROW_NOTE = 'Payments with no linked visit. App Store sales have their own row.';
const REPORTED_NOTE = "Apple's report for this day counts this sale, so the total adds the report instead of this row.";

function MoneyLines({ m }: { m: Money }) {
  const list = currenciesOf(m).filter(([, v]) => v !== 0);
  if (!list.length) return <span className="text-stone-400">{money(0, Object.keys(m)[0] ?? 'USD', true)}</span>;
  return (
    <>
      {list.map(([cc, v]) => (
        <div key={cc}>{money(v, cc)}</div>
      ))}
    </>
  );
}

/** A row with a share bar: the bar is the row's part of the bucket's largest currency. */
function ShareRow({ icon, label, sub, title, m, main, total }: { icon: React.ReactNode; label: string; sub?: string; title?: string; m: Money; main: string | null; total: number }) {
  const share = main && total > 0 ? Math.max(0, m[main] ?? 0) / total : 0;
  return (
    <li className="flex items-center gap-3 py-1.5 text-[13px]" title={title}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium text-ink">{label}</span>
          {sub && <span className="hidden shrink-0 text-xs text-stone-400 sm:inline">{sub}</span>}
        </div>
        {main && <MeterBar className="mt-1" share={share} tone="revenue" label={`${fmtPct(share, 0)} of ${main} revenue`} />}
      </div>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-stone-400">{main && share > 0 ? fmtPct(share, share < 0.1 ? 1 : 0) : ''}</span>
      <span className="min-w-[4.5rem] shrink-0 text-right font-medium tabular-nums text-ink">
        <MoneyLines m={m} />
      </span>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="text-micro uppercase text-stone-400">{title}</h3>
      {children}
    </section>
  );
}

/**
 * One bar of Home's revenue chart, opened in a dialog: what it adds up to, which sites and sources it came from, and
 * every payment in it. `period` and `tz` are Home's, so the total matches the bar.
 */
export function RevenueBucket({ bucket, granularity, period, tz, onClose }: { bucket: string | null; granularity: string; period: string; tz: string; onClose: () => void }) {
  const url = bucket ? `/api/home/bucket?${new URLSearchParams({ period, bucket, tz })}` : null;
  const { data, error } = useApi<BucketData>(url);
  const shown = data && data.bucket === bucket ? data : null;
  const { main, total } = useMemo(() => {
    const top = shown ? currenciesOf(shown.revenue)[0] : undefined;
    return { main: top?.[0] ?? null, total: top?.[1] ?? 0 };
  }, [shown]);
  const unit = UNIT[(shown?.granularity ?? granularity) as BucketData['granularity']] ?? 'day';
  const multiDay = granularity === 'week' || granularity === 'month';
  const time = (ts: number) =>
    new Date(ts).toLocaleString('en', multiDay ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz } : { hour: 'numeric', minute: '2-digit', timeZone: tz });

  return (
    <Modal open={!!bucket} onClose={onClose} width="max-w-xl" title={bucket ? bucketLabel(bucket, granularity, true) : ''}>
      {error && !shown ? (
        <p className="text-[13px] text-red-600">This {unit} did not load. Close it and click the bar again.</p>
      ) : !shown ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <div className="text-[32px] font-semibold leading-none tracking-[-0.03em] text-ink">{main ? money(total, main) : money(0, 'USD')}</div>
            {currenciesOf(shown.revenue).length > 1 && (
              <div className="text-sm font-medium text-stone-500">
                + {currenciesOf(shown.revenue)
                  .slice(1)
                  .map(([cc, v]) => money(v, cc))
                  .join(', ')}
              </div>
            )}
            <div className="text-[13px] text-stone-500">
              {shown.payments === 1 ? '1 payment' : `${fmtNumber(shown.payments)} payments`}
              {shown.sites.length > 1 ? ` on ${shown.sites.length} sites` : ''}
            </div>
          </div>

          {shown.payments === 0 && shown.list.length === 0 ? (
            <p className="mt-4 text-[13px] text-stone-500">No payments this {unit}.</p>
          ) : (
            <div className="mt-6">
              {shown.sites.length > 0 && (
                <Section title="By site">
                  <ul className="mt-2">
                    {shown.sites.map((s) => (
                      <ShareRow
                        key={s.id}
                        icon={<Favicon domain={s.domain} size={16} />}
                        label={s.name}
                        sub={
                          s.appStoreReport
                            ? `${fmtNumber(s.payments)} sold, ${fmtNumber(s.appStoreReport.units)} from Apple's report`
                            : s.payments === 1
                              ? '1 payment'
                              : `${fmtNumber(s.payments)} payments`
                        }
                        m={s.revenue}
                        main={main}
                        total={total}
                      />
                    ))}
                  </ul>
                </Section>
              )}
              {shown.sources.length > 0 && (
                <Section title="By source">
                  <ul className="mt-2">
                    {shown.sources.map((r) => (
                      <ShareRow
                        key={r.label}
                        icon={r.appStore ? <PhoneGlyph size={16} /> : r.noVisit ? <span className="text-stone-300">–</span> : <SourceIcon source={r.label} domain={r.domain} size={16} />}
                        label={r.label}
                        sub={r.appStore ? "Apple's report" : r.noVisit ? 'No linked visit' : r.channel}
                        title={r.appStore ? APP_STORE_ROW_NOTE : r.noVisit ? NO_SOURCE_ROW_NOTE : undefined}
                        m={r.revenue}
                        main={main}
                        total={total}
                      />
                    ))}
                  </ul>
                </Section>
              )}
              {shown.list.length > 0 && (
                <Section title="Payments">
                  <ul className="mt-1">
                    {shown.list.map((p) => {
                      const amount = shownAmount(p);
                      return (
                        <li key={p.id} className="border-t border-stone-200/60 first:border-t-0">
                          <button
                            className={`-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left text-[13px] transition-colors duration-fast hover:bg-stone-50 ${p.reported ? 'opacity-60' : ''}`}
                            onClick={() => navigate(`/site/${p.siteId}`)}
                            title={p.reported ? REPORTED_NOTE : `Open ${p.siteName}`}
                          >
                            <Favicon domain={p.siteDomain} size={18} />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className={`tabular-nums font-semibold ${p.amount < 0 ? 'text-red-600' : 'text-ink'}`}>{fmtMoney(amount.amount, amount.currency, amount.decimals)}</span>
                                {p.converted && <span className="text-xs tabular-nums text-stone-400">paid {fmtMoney(p.amount, p.currency, p.decimals)}</span>}
                                <span className="text-stone-500">{p.siteName}</span>
                                {p.product && (
                                  <span className="min-w-0 truncate text-xs text-stone-500" title={p.product}>
                                    {p.product}
                                  </span>
                                )}
                              </div>
                              <PaymentMeta p={p} />
                            </div>
                            <span className="shrink-0 self-start pt-0.5 text-right text-xs tabular-nums text-stone-400">
                              {time(p.ts)}
                              {p.reported && <div>In Apple's report</div>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {shown.more && <p className="pt-2 text-xs text-stone-400">The {fmtNumber(shown.list.length)} newest payments. The totals above count all of them.</p>}
                </Section>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
