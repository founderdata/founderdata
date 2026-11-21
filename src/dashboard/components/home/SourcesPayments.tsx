import { memo, useMemo, useState } from 'react';
import { navigate } from '../../App';
import { fmtAgo, fmtMoney, fmtNumber, fmtPct } from '../../lib/format';
import { Favicon, Flag, SourceIcon } from '../Icons';
import { Num, Row, Table } from '../site/primitives';
import { CardHeader, EmptyIcons, EmptyState, MeterBar } from '../ui';
import { currenciesOf, money, NEW_CUSTOMERS_NOTE, PhoneGlyph, PROVIDERS } from './shared';
import type { HomeData, Money, Payment } from './types';

function MoneyList({ m }: { m: Money }) {
  const list = currenciesOf(m);
  if (!list.length) return null;
  return (
    <>
      {list.map(([cc, v]) => (
        <div key={cc}>{money(v, cc, true)}</div>
      ))}
    </>
  );
}

const APP_STORE_ROW_NOTE = "App Store sales from Apple's report that no payment linked to a visit explains.";
const NO_SOURCE_ROW_NOTE = 'Stripe and other payments with no linked visit. App Store sales have their own row.';
/** Rows before "Show all". */
const SOURCES_SHOWN = 8;

export const Sources = memo(function Sources({ sources }: { sources: HomeData['sources'] }) {
  const [all, setAll] = useState(false);
  // The share bars measure the largest currency; a row's other currencies show in its revenue column only.
  const { main, total } = useMemo(() => {
    const t: Money = {};
    for (const r of sources) for (const [cc, v] of Object.entries(r.revenue)) if (v > 0) t[cc] = (t[cc] ?? 0) + v;
    const top = currenciesOf(t)[0];
    return { main: top?.[0] ?? null, total: top?.[1] ?? 0 };
  }, [sources]);
  const rows = all ? sources : sources.slice(0, SOURCES_SHOWN);
  return (
    <section className="card flex flex-col" aria-labelledby="sources-title">
      <CardHeader
        title={
          <h2 id="sources-title" className="truncate text-[13px] font-semibold leading-6 text-ink">
            Where customers come from
          </h2>
        }
        info={
          <p>
            Revenue goes to the visit each payment is linked to. Payments with no linked visit, and App Store sales no payment explains, get their own rows. So the revenue column adds up to the
            Revenue tile.{main ? ` The bar is each source's share of ${main} revenue.` : ''}
          </p>
        }
        infoLabel="How revenue is credited to sources"
        sub="All sites, this period"
      />
      {sources.length ? (
        <div className="px-5 pb-5">
          <Table
            head={[
              'Source',
              'Visitors',
              <span key="c" title={NEW_CUSTOMERS_NOTE}>
                <span className="hidden sm:inline">New customers</span>
                <span className="sm:hidden">New</span>
              </span>,
              'Revenue',
            ]}
          >
            {rows.map((r) => {
              const synthetic = r.appStore || r.noVisit;
              const share = main && total ? Math.max(0, r.revenue[main] ?? 0) / total : 0;
              const pct = fmtPct(share, share < 0.1 ? 1 : 0);
              return (
                <Row
                  key={r.label}
                  title={r.appStore ? APP_STORE_ROW_NOTE : r.noVisit ? NO_SOURCE_ROW_NOTE : `${r.channel}, ${r.sites} ${r.sites === 1 ? 'site' : 'sites'}`}
                  cells={[
                    <span key="s" className="flex min-w-0 items-center gap-2">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {r.appStore ? <PhoneGlyph size={16} /> : r.noVisit ? <span className="text-stone-300" aria-hidden="true">–</span> : <SourceIcon source={r.label} domain={r.domain} size={16} />}
                      </span>
                      <span className="truncate font-medium text-ink">{r.label}</span>
                      <span className="hidden shrink-0 text-xs text-stone-400 md:inline">{r.appStore ? 'Apple report' : r.channel}</span>
                    </span>,
                    synthetic ? null : <Num value={r.visitors} format={fmtNumber} />,
                    synthetic ? null : <Num value={r.customers} format={fmtNumber} />,
                    <span key="r" className="inline-flex items-center justify-end gap-3">
                      {main && share > 0 && (
                        <>
                          <span className="hidden w-14 sm:block">
                            <MeterBar share={share} tone="revenue" label={`${pct} of ${main} revenue`} />
                          </span>
                          <span className="hidden w-9 text-right text-xs text-stone-400 sm:inline">{pct}</span>
                        </>
                      )}
                      <span className="min-w-[3.5rem] text-right font-medium text-ink">
                        <MoneyList m={r.revenue} />
                      </span>
                    </span>,
                  ]}
                />
              );
            })}
          </Table>
          {sources.length > SOURCES_SHOWN && (
            <button className="btn-ghost mt-3 w-full" aria-expanded={all} onClick={() => setAll((a) => !a)}>
              {all ? `Show the top ${SOURCES_SHOWN}` : `Show all ${fmtNumber(sources.length)} sources`}
            </button>
          )}
        </div>
      ) : (
        <div className="px-5 pb-5">
          <EmptyState compact icon={EmptyIcons.search} title="No visitors in this period" />
        </div>
      )}
    </section>
  );
});

/** A payment's amount in the site's currency, as the row shows it. */
export const shownAmount = (p: Payment) => p.converted ?? { amount: p.amount, currency: p.currency, decimals: p.decimals };

/**
 * The latest payments, with renewals in a row of the same site and currency folded into one muted line ("3 renewals,
 * $8.97"), so a new $299 sale doesn't sit among a dozen $2.99 renewals at the same weight. A single renewal stays a
 * row, muted.
 */
function paymentGroups(list: Payment[]): ({ kind: 'one'; p: Payment } | { kind: 'renewals'; items: Payment[] })[] {
  const out: ({ kind: 'one'; p: Payment } | { kind: 'renewals'; items: Payment[] })[] = [];
  for (const p of list) {
    const prev = out[out.length - 1];
    const renewal = p.renewal && p.kind !== 'refund' && p.amount >= 0;
    if (renewal && prev) {
      const head = prev.kind === 'renewals' ? prev.items[0] : prev.p.renewal && prev.p.kind !== 'refund' && prev.p.amount >= 0 ? prev.p : null;
      if (head && head.siteId === p.siteId && shownAmount(head).currency === shownAmount(p).currency) {
        if (prev.kind === 'renewals') prev.items.push(p);
        else out[out.length - 1] = { kind: 'renewals', items: [prev.p, p] };
        continue;
      }
    }
    out.push({ kind: 'one', p });
  }
  return out;
}

export function PaymentMeta({ p }: { p: Payment }) {
  return (
    <div className="flex items-center gap-1.5 truncate text-xs text-stone-500">
      <span className={p.kind === 'refund' ? 'text-red-600' : p.renewal ? '' : 'text-emerald-700'}>{p.kind === 'refund' ? 'Refund' : p.renewal ? 'Renewal' : 'New'}</span>
      <span className="text-stone-300" aria-hidden="true">·</span>
      {PROVIDERS[p.provider] ?? p.provider}
      {p.source && (
        <>
          <span className="text-stone-300" aria-hidden="true">·</span>
          <SourceIcon source={p.source} domain={p.sourceDomain} size={12} /> {p.source}
        </>
      )}
      {p.country && (
        <>
          <span className="text-stone-300" aria-hidden="true">·</span>
          <Flag cc={p.country} size={12} />
        </>
      )}
    </div>
  );
}

export const Payments = memo(function Payments({ payments }: { payments: HomeData['payments'] }) {
  const groups = useMemo(() => paymentGroups(payments), [payments]);
  const now = Date.now();
  const ago = (ts: number) => <span className="shrink-0 self-start pt-0.5 text-xs tabular-nums text-stone-400">{fmtAgo(now - ts)} ago</span>;
  const row = '-mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors duration-fast hover:bg-stone-50';
  return (
    <section className="card flex flex-col" aria-labelledby="payments-title">
      <CardHeader
        title={
          <h2 id="payments-title" className="truncate text-[13px] font-semibold leading-6 text-ink">
            Latest payments
          </h2>
        }
        info="Renewals in a row on the same site and currency share one line."
        infoLabel="How latest payments are listed"
        sub={`The ${payments.length} most recent, whatever the period`}
      />
      {payments.length ? (
        <ul className="px-5 pb-3">
          {groups.map((g) => {
            if (g.kind === 'renewals') {
              const first = g.items[0];
              const cur = shownAmount(first);
              const sum = g.items.reduce((t, p) => t + shownAmount(p).amount, 0);
              const products = [...new Set(g.items.map((p) => p.product).filter(Boolean))];
              return (
                <li key={first.id} className="border-t border-stone-200/60 first:border-t-0">
                  <button className={row} onClick={() => navigate(`/site/${first.siteId}`)} title={g.items.map((p) => `${fmtMoney(shownAmount(p).amount, cur.currency, cur.decimals)} ${p.product ?? ''}, ${fmtAgo(now - p.ts)} ago`).join('\n')}>
                    <span className="flex w-[18px] shrink-0 justify-center opacity-60">
                      <Favicon domain={first.siteDomain} size={18} />
                    </span>
                    <div className="min-w-0 flex-1 text-stone-500">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium tabular-nums text-stone-600">
                          {fmtNumber(g.items.length)} renewals, {fmtMoney(sum, cur.currency, cur.decimals)}
                        </span>
                        <span>{first.siteName}</span>
                      </div>
                      <div className="truncate text-xs text-stone-400">{products.length === 1 ? products[0] : products.length ? `${products.length} products` : 'Renewals'}</div>
                    </div>
                    {ago(first.ts)}
                  </button>
                </li>
              );
            }
            const p = g.p;
            const amount = shownAmount(p);
            const quietRow = p.renewal && p.kind !== 'refund';
            return (
              <li key={p.id} className="border-t border-stone-200/60 first:border-t-0">
                <button className={row} onClick={() => navigate(`/site/${p.siteId}`)}>
                  <span className={`flex w-[18px] shrink-0 justify-center ${quietRow ? 'opacity-60' : ''}`}>
                    <Favicon domain={p.siteDomain} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* Amount and site on the first line; the product wraps to its own line on a phone instead of truncating. */}
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`tabular-nums ${p.amount < 0 ? 'font-semibold text-red-600' : quietRow ? 'font-medium text-stone-600' : 'font-semibold text-ink'}`}>
                        {fmtMoney(amount.amount, amount.currency, amount.decimals)}
                      </span>
                      {p.converted && <span className="shrink-0 text-xs tabular-nums text-stone-400">paid {fmtMoney(p.amount, p.currency, p.decimals)}</span>}
                      <span className="text-stone-500">{p.siteName}</span>
                      {p.product && (
                        <span className={`min-w-0 basis-full break-all text-xs sm:basis-auto sm:truncate ${quietRow ? 'text-stone-400' : 'text-stone-500'}`} title={p.product}>
                          {p.product}
                        </span>
                      )}
                    </div>
                    <PaymentMeta p={p} />
                  </div>
                  {ago(p.ts)}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="px-5 pb-5">
          <EmptyState compact icon={EmptyIcons.inbox} title="No payments yet">
            Connect Stripe, the App Store or RevenueCat in a site's Settings.
          </EmptyState>
        </div>
      )}
    </section>
  );
});
