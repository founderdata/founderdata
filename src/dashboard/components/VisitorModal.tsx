import { useState } from 'react';
import { api, isViewer } from '../lib/api';
import { useDash } from '../lib/context';
import { countryName, fmtAgo, fmtDateTime, fmtDuration, fmtNumber, shortId, sourceText } from '../lib/format';
import { useApi } from '../lib/useApi';
import { AsaName } from './AsaNameSlot';
import { Avatar, BrowserIcon, DeviceIcon, Flag, OSIcon, SourceIcon } from './Icons';
import { PaymentAmount, PaymentSource } from './GoalsPanel';
import { Modal } from './Modal';
import { ProSlot } from './ProSlot';
import { Skeleton } from './ui/Skeleton';
import { Spinner } from './ui/Spinner';
import { StatStrip, StatTile } from './ui/StatTile';
import { platformOf } from '../../shared/platform';
import { isTestProvider } from '../../shared/test-providers';

interface Profile {
  visitor: { id: string; first_seen: number; name: string | null; email: string | null; user_id: string | null } | null;
  /** Every visitor id of this person: more than one when identify() joined devices (stats.ts visitorProfile). */
  visitors?: string[];
  sessions: any[];
  events: { session_id: string; ts: number; type: string; name: string | null; path: string; props: string | null }[];
  payments: any[];
}

export function VisitorModal({ visitorId, onClose }: { visitorId: string | null; onClose: () => void }) {
  const { site, money } = useDash();
  // The parent remounts this per visitor (key), so `data` always belongs to `visitorId`.
  const { data: p } = useApi<Profile>(visitorId ? `/api/sites/${site.id}/visitors/${visitorId}` : null);
  const [erased, setErased] = useState<string | null>(null);
  const last = p?.sessions[0];
  const firstSession = p?.sessions[p.sessions.length - 1];
  // Same rule as the revenue totals: in the site's currency (converted when paid in another), no sandbox purchases.
  const paid =
    p?.payments
      .filter((x) => !isTestProvider(x.provider))
      .reduce((a, x) => a + (x.currency === site.currency ? x.amount : (x.amount_conv ?? 0)), 0) ?? 0;
  const firstPayment = p?.payments.filter((x) => x.kind === 'payment').at(-1);

  // Timeline: each visit with its events and payments, newest first. A recorded page's clicks and errors (`activity`
  // rows) belong to FounderData Pro's People view, not to this list.
  const bySession = new Map<string, Profile['events']>();
  for (const e of p?.events ?? []) {
    if (e.type === 'activity') continue;
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
    bySession.get(e.session_id)!.push(e);
  }

  const devices = deviceNames(p?.sessions ?? []);
  const goals = (p?.events ?? []).filter((e) => e.type === 'goal');
  const pages = (p?.events ?? []).filter((e) => e.type === 'pageview').length;
  const time = (ts: number) => new Intl.DateTimeFormat('en', { timeZone: site.timezone, hour: 'numeric', minute: '2-digit' }).format(ts);
  const day = (ts: number) => new Intl.DateTimeFormat('en', { timeZone: site.timezone, month: 'short', day: 'numeric' }).format(ts);

  return (
    <Modal open={!!visitorId} onClose={onClose} width="max-w-3xl" title="Visitor profile">
      {!p && !erased && <ProfileSkeleton />}
      {erased && (
        <div className="space-y-4 text-sm">
          <p>{erased}</p>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}
      {p && !erased && (
        <div className="fd-reveal">
          <div className="flex items-center gap-4">
            <Avatar id={visitorId!} name={p.visitor?.name || p.visitor?.email} size={56} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-title text-ink">{p.visitor?.name || p.visitor?.email || `Visitor ${shortId(visitorId!)}`}</div>
              {p.visitor?.email && p.visitor.name && <div className="text-[13px] text-stone-500">{p.visitor.email}</div>}
              {/* identify() joined devices: say so, since the visits below come from all of them. */}
              {devices.length > 1 && <div className="text-[13px] text-stone-500">Visits from {andList(devices)}, joined by their sign-in</div>}
              {last && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">
                  <span className="flex items-center gap-1">
                    <Flag cc={last.country} size={13} /> {last.city ? `${last.city}, ` : ''}
                    {countryName(last.country)}
                  </span>
                  <span className="flex items-center gap-1">
                    <DeviceIcon name={last.device} size={13} /> {last.device}
                  </span>
                  <span className="flex items-center gap-1">
                    <OSIcon name={last.os} size={13} /> {last.os}
                  </span>
                  <span className="flex items-center gap-1">
                    <BrowserIcon name={last.browser} size={13} /> {last.browser}
                  </span>
                </div>
              )}
            </div>
            {/* FounderData Pro: a link to this person's page in People. Nothing in core. */}
            <ProSlot name="personLink" siteId={site.id} visitorId={visitorId} />
          </div>

          {/* The story at a glance: where they came from, how often they came back, what they did, and what they paid. */}
          <StatStrip className="mt-6" label="Journey">
            <StatTile
              label="First visit"
              value={null}
              display={
                firstSession ? (
                  <span className="flex min-w-0 items-center gap-1.5 text-[17px] leading-7">
                    <SourceIcon source={firstSession.source} domain={firstSession.referrer_domain} size={16} />
                    <span className="truncate">{sourceText(firstSession.source)}</span>
                  </span>
                ) : (
                  <span className="text-stone-300" title="No visit recorded">–</span>
                )
              }
              sub={p.visitor ? day(p.visitor.first_seen) : firstSession ? day(firstSession.started_at) : undefined}
            />
            <StatTile label="Visits" value={p.sessions.length} format={fmtNumber} sub={`${pages} ${pages === 1 ? 'page' : 'pages'}`} />
            <StatTile
              label="Goals"
              value={goals.length}
              format={fmtNumber}
              sub={goals.length ? [...new Set(goals.map((g) => g.name))].slice(0, 2).join(', ') : undefined}
            />
            <StatTile
              label="Total spent"
              tone="revenue"
              value={paid}
              format={(n) => money(n)}
              sub={firstPayment && p.visitor ? `first after ${fmtAgo(firstPayment.ts - p.visitor.first_seen)}` : undefined}
            />
          </StatStrip>

          <div className="mt-7">
            <div className="mb-3 text-micro uppercase text-stone-400">Timeline, newest first</div>
            <ol className="relative space-y-5 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-stone-200">
              {p.sessions.map((s) => {
                const evs = [...(bySession.get(s.id) ?? [])].reverse();
                const pays = p.payments.filter((x) => x.ts >= s.started_at && x.ts <= s.last_seen_at + 30 * 60_000);
                const bought = pays.some((x) => x.kind !== 'refund');
                return (
                  <li key={s.id} className="relative pl-7">
                    <span
                      className={`absolute left-0 top-[5px] h-[11px] w-[11px] rounded-full ring-4 ring-white dark:ring-[rgb(var(--stone-50))] ${bought ? 'bg-revenue' : 'bg-visitors'}`}
                      aria-hidden="true"
                    />
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                      <span className="font-semibold text-ink">{fmtDateTime(s.started_at, site.timezone)}</span>
                      <span className="flex items-center gap-1.5 rounded-md bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">
                        <SourceIcon source={s.source} domain={s.referrer_domain} size={13} /> {sourceText(s.source)}
                      </span>
                      {s.utm_campaign && (
                        <span className="rounded-md bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
                          campaign: <AsaName kind="campaign" id={s.utm_campaign} />
                        </span>
                      )}
                      {s.utm_term && s.source === 'Apple Search Ads' && (
                        <span className="rounded-md bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
                          keyword: <AsaName kind="keyword" id={s.utm_term} />
                        </span>
                      )}
                      {s.ref && <span className="rounded-md bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">ref: {s.ref}</span>}
                      <span className="text-xs tabular-nums text-stone-400">{fmtDuration(s.duration)}</span>
                      {/* FounderData Pro: a Watch button when this visit was recorded. Nothing in core. */}
                      <ProSlot name="watchVisit" siteId={site.id} visitorId={s.visitor_id ?? visitorId} sessionId={s.id} startedAt={s.started_at} />
                    </div>
                    {s.referrer && <div className="mt-0.5 max-w-full truncate text-xs text-stone-400">{s.referrer}</div>}
                    <ol className="mt-2 space-y-0.5 text-[13px]">
                      {/* Events and payments in one list, in time order. */}
                      {[...evs.map((e, i) => ({ ts: e.ts, i, e, x: null })), ...pays.map((x) => ({ ts: x.ts as number, i: -1, e: null, x }))]
                        .sort((a, b) => a.ts - b.ts)
                        .map(({ i, e, x }) =>
                          e ? (
                        <li key={i} className="flex min-w-0 items-center gap-2.5 rounded-md py-0.5">
                          <span className="w-16 shrink-0 text-xs tabular-nums text-stone-400">{time(e.ts)}</span>
                          {e.type === 'pageview' && (
                            <>
                              <EventIcon kind="page" />
                              <span className="truncate text-stone-600">{e.path}</span>
                            </>
                          )}
                          {e.type === 'goal' && (
                            <>
                              <EventIcon kind="goal" />
                              <span className="truncate font-medium text-ink">
                                {e.name} <span className="font-normal text-stone-400">on {e.path}</span>
                              </span>
                            </>
                          )}
                          {e.type === 'outbound' && (
                            <>
                              <EventIcon kind="out" />
                              <span className="truncate text-stone-500">Left to {e.name?.replace(/^https?:\/\//, '')}</span>
                            </>
                          )}
                        </li>
                          ) : (
                        <li key={x.id} className="flex items-start gap-2.5 py-0.5">
                          <span className="w-16 shrink-0 pt-px text-xs tabular-nums text-stone-400">{time(x.ts)}</span>
                          <EventIcon kind="pay" />
                          <span className="min-w-0">
                            <span className="font-semibold text-revenue">
                              {x.kind === 'refund' ? 'Refund' : 'Paid'} <PaymentAmount amount={x.amount} currency={x.currency} amountConv={x.amount_conv} />
                            </span>
                            <PaymentSource provider={x.provider} currency={x.currency} amount={x.amount} amountConv={x.amount_conv} />
                          </span>
                        </li>
                          ),
                        )}
                    </ol>
                  </li>
                );
              })}
            </ol>
            {p.payments.length > 0 && (
              <div className="card-inset mt-6 p-4 text-[13px]">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-ink">Payments</span>
                  <span className="font-semibold tabular-nums text-revenue">{money(paid)}</span>
                </div>
                {p.payments.map((x) => (
                  <div key={x.id} className="flex items-start justify-between gap-4 border-t border-stone-200/60 py-1.5 first:border-t-0">
                    <span className="tabular-nums text-stone-600">
                      {fmtDateTime(x.ts, site.timezone)} · {x.kind === 'refund' ? 'Refund' : x.renewal ? 'Renewal' : 'Payment'}
                    </span>
                    <span className="text-right font-medium tabular-nums text-ink">
                      <PaymentAmount amount={x.amount} currency={x.currency} amountConv={x.amount_conv} />
                      <PaymentSource provider={x.provider} currency={x.currency} amount={x.amount} amountConv={x.amount_conv} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {!isViewer() && <EraseButton visitorId={visitorId!} visitor={p.visitor} onDone={setErased} />}
        </div>
      )}
    </Modal>
  );
}

/** The device of a visit in a few words: "Mac", "iPhone", "iPhone app". */
function deviceName(s: { os?: string | null; device?: string | null; hostname?: string | null }): string {
  const platform = platformOf(s.hostname);
  if (platform === 'ios') return s.device === 'Tablet' ? 'iPad app' : 'iPhone app';
  if (platform === 'android') return s.device === 'Tablet' ? 'Android tablet app' : 'Android app';
  const os = (s.os ?? '').replace(/\s[\d.]+$/, '');
  const names: Record<string, string> = { 'Mac OS': 'Mac', iOS: 'iPhone', iPadOS: 'iPad', Windows: 'Windows PC', 'Chrome OS': 'Chromebook', Linux: 'Linux PC' };
  if (names[os]) return names[os];
  if (os === 'Android') return s.device === 'Tablet' ? 'Android tablet' : 'Android phone';
  return s.device === 'Mobile' ? 'phone' : s.device === 'Tablet' ? 'tablet' : 'computer';
}

/** The devices of a profile's visits, newest first, each once. */
function deviceNames(sessions: { os?: string | null; device?: string | null; hostname?: string | null }[]): string[] {
  return [...new Set(sessions.map(deviceName))].slice(0, 4);
}

const andList = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The small mark before each event in the timeline. */
function EventIcon({ kind }: { kind: 'page' | 'goal' | 'out' | 'pay' }) {
  const path = {
    page: 'M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5zM14 3.5V8h4',
    goal: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
    out: 'M9 5h10v10M19 5 6 18',
    pay: 'M12 3.5v17M16 7.5h-5.5a2.75 2.75 0 0 0 0 5.5h3a2.75 2.75 0 0 1 0 5.5H7.5',
  }[kind];
  const tone = kind === 'pay' ? 'bg-revenueSoft text-revenue' : kind === 'goal' ? 'bg-stone-100 text-ink' : 'text-stone-400';
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${tone}`} aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </span>
  );
}

function ProfileSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className="flex items-center gap-4">
        <Skeleton className="h-14 w-14 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>
      <Skeleton className="mt-6 h-[92px] w-full rounded-2xl" />
      <div className="mt-7 space-y-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 pl-7">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Erase this person (docs/GUIDE.md, "Erase one person"). With an email or user id it erases every visitor that
 * shares it; payments stay, without the link.
 */
function EraseButton({ visitorId, visitor, onDone }: { visitorId: string; visitor: Profile['visitor']; onDone: (message: string) => void }) {
  const { site } = useDash();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = visitor?.email || visitor?.user_id ? 'everyone with this email or user id' : 'this visitor';
  const run = async () => {
    const ok = confirm(
      `Erase ${who}? Their visits, pages, clicks and identity are deleted and can't be restored. Payments stay for your books, without their name, email or source.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r =
        visitor?.email || visitor?.user_id
          ? await api<{ visitors: number; sessions: number; payments: number }>(`/api/sites/${site.id}/erase`, {
              method: 'POST',
              json: { email: visitor.email ?? undefined, user_id: visitor.user_id ?? undefined },
            })
          : await api<{ visitors: number; sessions: number; payments: number }>(`/api/sites/${site.id}/visitors/${visitorId}`, { method: 'DELETE' });
      const n = (x: number, one: string) => `${x} ${one}${x === 1 ? '' : 's'}`;
      onDone(
        `Erased ${n(r.visitors, 'visitor')} and ${n(r.sessions, 'visit')}. ${n(r.payments, 'payment')} kept without the link to this person. Lists update on the next refresh.`,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-stone-200/60 pt-4 text-sm">
      {error && <span className="text-red-600">{error}</span>}
      <button className="btn h-8 py-1 text-[13px] text-red-600" onClick={run} disabled={busy}>
        {busy ? <><Spinner /> Erasing</> : 'Erase this person'}
      </button>
    </div>
  );
}
