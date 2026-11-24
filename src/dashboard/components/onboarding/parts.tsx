import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { navigate } from '../../App';
import { buildAiPrompt } from '../../lib/aiPrompt';
import { api, ApiError, type Site } from '../../lib/api';
import { isInstallStep, kindOfStep, STATUS_LABEL, WHO_SHORT, type Step, type StepStatus, type Who } from '../../lib/setup';
import { hasWebsite } from '../../lib/siteKind';
import { ProActions } from '../ProUpsell';
import { CopyButton } from '../setup/kit';
import { LiveDot, Spinner } from '../ui';

/** The mark in front of a step: a check when done, a breathing dot while it waits for its signal, a ring to do. */
export function StatusMark({ status, size = 22 }: { status: StepStatus; size?: number }) {
  const box = `relative flex shrink-0 items-center justify-center rounded-full`;
  const style = { width: size, height: size };
  const label = STATUS_LABEL[status];
  switch (status) {
    case 'done':
      return (
        <span className={`${box} bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/70`} style={style} role="img" aria-label={label}>
          <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m2.5 6.5 2.5 2.5 4.5-6" />
          </svg>
        </span>
      );
    case 'waiting':
      return (
        <span className={`${box} ring-1 ring-inset ring-brand/30`} style={style} role="img" aria-label={label}>
          <LiveDot size={Math.round(size * 0.32)} />
        </span>
      );
    case 'broken':
      return (
        <span className={`${box} bg-red-50 text-red-700 ring-1 ring-inset ring-red-200/70`} style={style} role="img" aria-label={label}>
          <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
            <path d="M6 2.5v4M6 9v.2" />
          </svg>
        </span>
      );
    case 'locked':
      return (
        <span className={`${box} bg-stone-100 text-stone-400`} style={style} role="img" aria-label={label}>
          <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
      );
    case 'off':
      return (
        <span className={`${box} text-stone-300`} style={style} role="img" aria-label={label}>
          <span className="h-[1.5px] w-2.5 rounded-full bg-stone-300" />
        </span>
      );
    default:
      return <span className={`${box} ring-[1.5px] ring-inset ring-stone-300`} style={style} role="img" aria-label={label} />;
  }
}

const WHO_ICON: Record<Who, ReactNode> = {
  agent: <path d="M12 3v3M8 9h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3zM9.5 14h.01M14.5 14h.01" />,
  you: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M3 9h18M6.5 6.8h.01M9 6.8h.01" />
    </>
  ),
};

export function WhoIcon({ who, size = 14 }: { who: Who; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {WHO_ICON[who]}
    </svg>
  );
}

/** Who acts on a step, as a small pill. */
export function WhoChip({ who }: { who: Who }) {
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-stone-100 px-2 text-xs font-medium text-stone-600" title={`Who acts: ${WHO_SHORT[who]}`}>
      <WhoIcon who={who} size={12} />
      {WHO_SHORT[who]}
    </span>
  );
}

/** A thin bar of done over total. */
export function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const share = total ? done / total : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div className="h-full origin-left rounded-full bg-emerald-500 transition-transform duration-slower ease-out" style={{ transform: `scaleX(${share})` }} />
    </div>
  );
}

/** A dashboard path from a step's url: '/settings#agents' opens the first site's Settings on that card. */
export function resolveUrl(url: string | null, siteId: string | null): { href: string; internal: boolean } | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return { href: url, internal: false };
  const m = /^\/settings(#.*)?$/.exec(url);
  if (m) return siteId ? { href: `/site/${siteId}/settings${m[1] ?? ''}`, internal: true } : null;
  return { href: url, internal: true };
}

type Check = { state: 'busy' } | { state: 'done'; ok: boolean; message: string };

/** "Check now": the Worker fetches the site's homepage and looks for this site's tag (POST /api/v1/setup/verify-install). */
function CheckNow({ siteId, sample }: { siteId: string; sample: boolean }) {
  const [check, setCheck] = useState<Check | null>(null);
  async function run() {
    setCheck({ state: 'busy' });
    if (sample) return setCheck({ state: 'done', ok: false, message: 'This is sample data, so there is no site to check.' });
    try {
      const r = await api<{ ok: boolean; found: string; message: string }>('/api/v1/setup/verify-install', { method: 'POST', json: { site: siteId } });
      setCheck({ state: 'done', ok: r.ok, message: r.message });
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 404 ? 'This server cannot check installs yet. Update FounderData to get the check.' : (e as Error).message;
      setCheck({ state: 'done', ok: false, message: msg });
    }
  }
  return (
    <>
      <button type="button" className="btn btn-pill" onClick={run} disabled={check?.state === 'busy'}>
        {check?.state === 'busy' ? (
          <>
            <Spinner /> Checking
          </>
        ) : (
          'Check now'
        )}
      </button>
      <p role="status" className={`w-full text-[13px] ${check?.state === 'done' ? (check.ok ? 'text-emerald-700' : 'text-stone-500') : 'sr-only'}`}>
        {check?.state === 'done' ? check.message : ''}
      </p>
    </>
  );
}

/** The prompt a step offers: the full install prompt for a tracker or SDK step when the site is known, else the step's own. */
export function promptOf(step: Step, site: Site | undefined, origin: string): string | null {
  if (isInstallStep(step) && site) return buildAiPrompt(site, origin);
  return step.prompt;
}

function StepDetail({ step, site, origin, firstSiteId, sample, id }: { step: Step; site?: Site; origin: string; firstSiteId: string | null; sample: boolean; id: string }) {
  const link = resolveUrl(step.url, step.site?.id ?? firstSiteId);
  const prompt = promptOf(step, site, origin);
  const canCheck = kindOfStep(step.id) === 'tracker' && step.site && step.status !== 'done' && (!site || hasWebsite(site));
  if (step.status === 'locked') {
    return (
      <div id={id} className="pb-5 pl-[52px] pr-4 sm:pr-5">
        <p className="text-[15px] leading-relaxed text-ink">{step.outcome}</p>
        <p className="mt-1 text-[13px] text-stone-500">Comes with FounderData Pro. Nothing in the free setup waits for it.</p>
        <div className="mt-3">
          <ProActions compact />
        </div>
      </div>
    );
  }
  return (
    <div id={id} className="pb-5 pl-[52px] pr-4 sm:pr-5">
      <p className="text-[15px] leading-relaxed text-ink">{step.outcome}</p>
      <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[88px_minmax(0,1fr)]">
        <dt className="text-stone-400">Signal</dt>
        <dd className="text-stone-600">{step.evidence ?? (step.status === 'done' ? 'Done' : 'None yet')}</dd>
        {step.secrets && step.secrets.length > 0 && (
          <>
            <dt className="text-stone-400">Secrets</dt>
            <dd className="flex flex-wrap gap-1.5">
              {step.secrets.map((x) => (
                <span key={x.name} className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium ring-1 ring-inset ${x.set ? 'bg-emerald-50 text-emerald-700 ring-emerald-200/60' : 'bg-stone-100 text-stone-600 ring-stone-200'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${x.set ? 'bg-emerald-500' : 'bg-stone-400'}`} aria-hidden="true" />
                  {x.name}
                  <span className="sr-only">{x.set ? ', set' : ', not set'}</span>
                </span>
              ))}
            </dd>
          </>
        )}
        {step.cost && (
          <>
            <dt className="text-stone-400">Cost</dt>
            <dd className="text-stone-600">{step.cost}</dd>
          </>
        )}
        {step.skill && (
          <>
            <dt className="text-stone-400">Guide</dt>
            <dd className="min-w-0 break-words font-mono text-xs text-stone-500">{step.skill}</dd>
          </>
        )}
      </dl>
      {step.command && (
        <div className="mt-3 flex min-w-0 items-center gap-2 rounded-xl bg-stone-100 py-1 pl-3 pr-1">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink">
            <span className="select-none text-stone-400">$ </span>
            {step.command}
          </code>
          <CopyButton value={step.command} label="Copy command" className="btn-ghost h-8 px-2 text-xs" />
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {prompt && <CopyButton value={prompt} label={isInstallStep(step) && site ? 'Copy install prompt' : 'Copy prompt'} className="btn-dark btn-pill h-10" />}
        {link &&
          (link.internal ? (
            <a
              className="btn btn-pill h-10"
              href={link.href}
              onClick={(e) => {
                e.preventDefault();
                navigate(link.href);
              }}
            >
              Open settings
            </a>
          ) : (
            <a className="btn btn-pill h-10" href={link.href} target="_blank" rel="noreferrer">
              Open {new URL(link.href).hostname.replace(/^www\./, '')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 17 17 7M8 7h9v9" />
              </svg>
            </a>
          ))}
        {canCheck && <CheckNow siteId={step.site!.id} sample={sample} />}
      </div>
    </div>
  );
}

/** Moves focus between step headers with the arrow keys, Home and End. */
function onListKey(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const list = e.currentTarget.closest('[data-step-list]');
  if (!list) return;
  const heads = [...list.querySelectorAll<HTMLButtonElement>('[data-step-head]')];
  const i = heads.indexOf(e.currentTarget as HTMLButtonElement);
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? heads.length - 1 : Math.max(0, Math.min(heads.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  e.preventDefault();
  heads[to]?.focus();
}

export interface RowContext {
  origin: string;
  sites: Map<string, Site>;
  firstSiteId: string | null;
  showSite: boolean;
  sample: boolean;
  /** False inside a list already grouped by who acts. */
  showWho?: boolean;
}

/** One step: a header that opens it, and the detail with the outcome, the signal and the actions. */
export function StepRow({ step, ctx, open, onToggle }: { step: Step; ctx: RowContext; open: boolean; onToggle: () => void }) {
  const id = useId();
  const ref = useRef<HTMLLIElement>(null);
  const sub = step.status === 'locked' ? step.outcome : step.status === 'done' ? step.evidence : (step.next ?? step.evidence ?? step.outcome);
  return (
    <li ref={ref} id={`step-${step.id}`} className={`scroll-mt-24 transition-colors duration-fast ${open ? 'bg-stone-50/70' : ''}`}>
      <button
        type="button"
        data-step-head=""
        className="group flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-fast hover:bg-stone-50 focus-visible:outline-offset-[-2px] sm:gap-4 sm:px-5"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        onKeyDown={onListKey}
      >
        <StatusMark status={step.status} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={`text-sm font-medium ${step.status === 'done' ? 'text-stone-500' : 'text-ink'}`}>{step.title}</span>
            {ctx.showSite && step.site && <span className="truncate text-xs text-stone-400">{step.site.name}</span>}
          </span>
          {sub && <span className="mt-0.5 line-clamp-2 text-[13px] text-stone-500 sm:line-clamp-1">{sub}</span>}
        </span>
        {ctx.showWho !== false && (
          <span className="hidden sm:inline-flex">
            <WhoChip who={step.who} />
          </span>
        )}
        <svg
          className={`shrink-0 text-stone-400 transition-transform duration-base ease-out group-hover:text-ink ${open ? 'rotate-180' : ''}`}
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="animate-fade">
          <StepDetail step={step} site={step.site ? ctx.sites.get(step.site.id) : undefined} origin={ctx.origin} firstSiteId={ctx.firstSiteId} sample={ctx.sample} id={id} />
        </div>
      )}
    </li>
  );
}

/** A list of steps in one card. `openId` opens one from outside (a grid cell, ?step=). */
export function StepList({ steps, ctx, openId, label, showWho = true }: { steps: Step[]; ctx: RowContext; openId?: string | null; label: string; showWho?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(openId ? [openId] : []));
  useEffect(() => {
    if (!openId || !steps.some((s) => s.id === openId)) return;
    setOpen((o) => new Set(o).add(openId));
    const el = document.getElementById(`step-${openId}`);
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector<HTMLButtonElement>('[data-step-head]')?.focus({ preventScroll: true });
  }, [openId]);
  return (
    <ul data-step-list="" aria-label={label} className="card divide-y divide-stone-200/60 overflow-hidden">
      {steps.map((s) => (
        <StepRow
          key={s.id}
          step={s}
          ctx={showWho ? ctx : { ...ctx, showWho: false }}
          open={open.has(s.id)}
          onToggle={() =>
            setOpen((o) => {
              const n = new Set(o);
              if (n.has(s.id)) n.delete(s.id);
              else n.add(s.id);
              return n;
            })
          }
        />
      ))}
    </ul>
  );
}

/**
 * Says a status change out loud: "Install the tracker, acme.example: done." Only changes after the first answer, so
 * opening the page reads nothing.
 */
export function useAnnouncer(steps: Step[] | undefined): string {
  const prev = useRef<Map<string, StepStatus> | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!steps) return;
    const now = new Map(steps.map((s) => [s.id, s.status]));
    if (prev.current) {
      const changed = steps.filter((s) => prev.current!.has(s.id) && prev.current!.get(s.id) !== s.status);
      if (changed.length) setMsg(changed.map((s) => `${s.title}${s.site ? `, ${s.site.name}` : ''}: ${STATUS_LABEL[s.status].toLowerCase()}.`).join(' '));
    }
    prev.current = now;
  }, [steps]);
  return msg;
}
