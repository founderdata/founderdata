import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { AddSite } from '../components/AddSite';
import { LogoMark } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { Progress, StatusMark, StepList, useAnnouncer, WhoIcon, type RowContext } from '../components/onboarding/parts';
import { CopyButton } from '../components/setup/kit';
import { Skeleton, StatusChip, toast } from '../components/ui';
import { isViewer, type Site } from '../lib/api';
import { byWho, counts, estimateLine, firstSignalWords, isFirstRun, setupPrompt, skipGetStarted, WHO_HINT, WHO_LABEL, type SetupState } from '../lib/setup';
import { useApi } from '../lib/useApi';
import { useSetupState } from '../lib/useSetupState';

/** Get started polls the setup state this often while the tab is visible. */
export const POLL_MS = 5000;

function later() {
  skipGetStarted();
  navigate('/');
}

/** The prompt for the coding agent, in a soft panel with one big copy button. */
function PromptPanel({ prompt }: { prompt: string }) {
  const [all, setAll] = useState(false);
  return (
    <section className="ob-panel p-2 text-left" aria-labelledby="ob-prompt-title">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pb-2 pt-3 sm:px-5">
        <h2 id="ob-prompt-title" className="text-[13px] font-medium text-stone-500">
          Prompt for Claude Code, Codex or Cursor
        </h2>
        <span className="text-xs text-stone-400">Holds no secrets</span>
      </div>
      <div className="relative rounded-[22px] border border-stone-200/70 bg-white shadow-card">
        <pre
          className={`overflow-hidden whitespace-pre-wrap break-words px-5 pt-4 font-mono text-[12.5px] leading-[1.65] text-stone-600 sm:px-6 sm:pt-5 ${all ? 'pb-4' : 'max-h-[188px] pb-0'}`}
          tabIndex={0}
          aria-label="The prompt"
        >
          {prompt}
        </pre>
        {!all && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-20 rounded-b-[22px] bg-gradient-to-t from-white via-white/80 to-transparent" />}
      </div>
      <div className="flex flex-col gap-2 px-2 pb-2 pt-3 sm:flex-row sm:items-center sm:px-3">
        <CopyButton value={prompt} label="Copy prompt" className="btn-brand h-12 w-full px-6 text-[15px] sm:w-auto" onCopied={() => toast('Copied. Paste it into your coding agent.', 'ok')} />
        <button type="button" className="btn-ghost btn-pill h-10 sm:h-12" aria-expanded={all} onClick={() => setAll((x) => !x)}>
          {all ? 'Show less' : 'Read all of it'}
        </button>
        <p className="text-[13px] text-stone-500 sm:ml-auto sm:max-w-[15rem] sm:text-right">Open your agent in the folder where you ran setup, then paste.</p>
      </div>
    </section>
  );
}

/** "Waiting for your first visit": breathes while it waits, turns green by itself when the signal arrives. */
function Pulse({ state, onAdd }: { state: SetupState; onAdd: () => void }) {
  const { thing, done } = firstSignalWords(state);
  const noSite = !state.sites.length;
  if (done) {
    return (
      <div className="card flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 animate-rise">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/70 animate-pop-in" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2.5 6.5 2.5 2.5 4.5-6" />
          </svg>
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="text-[15px] font-semibold text-ink">Your first {thing} arrived</div>
          <div className="text-[13px] text-stone-500">{done.evidence ?? done.site?.name}</div>
        </div>
        <button type="button" className="btn btn-pill h-10" onClick={() => navigate(done.site ? `/site/${done.site.id}` : '/')}>
          Open the dashboard
        </button>
      </div>
    );
  }
  return (
    <div className="card flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="ob-pulse absolute inset-1.5 rounded-full bg-brand/25" />
        <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-brand/25" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-brand shadow-[0_0_10px_rgb(var(--brand)/0.7)]" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-[15px] font-semibold text-ink">{noSite ? 'Waiting for your first site' : `Waiting for your first ${thing}`}</div>
        <div className="text-[13px] text-stone-500">{noSite ? 'Add it here, or let your agent add it.' : 'This page checks every 5 seconds and turns green by itself.'}</div>
      </div>
      {noSite && (
        <button type="button" className="btn btn-pill h-10" onClick={onAdd}>
          Add a site or app
        </button>
      )}
    </div>
  );
}

function Disclosure({ title, sub, children, defaultOpen = false }: { title: string; sub: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-4">
      <button type="button" className="flex min-h-10 w-full items-center gap-2 rounded-xl px-1 text-left text-sm font-medium text-stone-600 transition-colors duration-fast hover:text-ink" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        <svg className={`transition-transform duration-base ${open ? 'rotate-90' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 4 4 4-4 4" />
        </svg>
        {title}
        <span className="font-normal text-stone-400">{sub}</span>
      </button>
      {open && <div className="mt-2 animate-fade">{children}</div>}
    </section>
  );
}

function Loading() {
  return (
    <div className="mx-auto mt-16 max-w-[760px] px-4 sm:mt-24" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <Skeleton className="mx-auto h-7 w-40 rounded-full" />
      <Skeleton className="mx-auto mt-8 h-14 w-full max-w-lg" />
      <Skeleton className="mx-auto mt-4 h-5 w-full max-w-md" />
      <Skeleton className="mt-12 h-72 w-full rounded-[28px]" />
    </div>
  );
}

/**
 * The first run, full screen: one prompt hands the setup to the coding agent, a pulse waits for the first visit, and
 * the steps are listed by who acts. "I'll finish later" goes to Home, where the setup card keeps the place.
 */
export function GetStarted() {
  const viewer = isViewer();
  const setup = useSetupState({ enabled: !viewer, pollMs: POLL_MS });
  const sitesRes = useApi<Site[]>(viewer ? null : '/api/sites');
  const [adding, setAdding] = useState(false);
  const openId = useMemo(() => new URLSearchParams(window.location.search).get('step'), []);
  const state = setup.state;
  const announce = useAnnouncer(state?.steps);

  // The read-only login has nothing to set up.
  useEffect(() => {
    if (viewer) navigate('/');
  }, [viewer]);
  if (viewer) return null;

  const ctx: RowContext | null = state
    ? {
        origin: state.origin,
        sites: new Map((sitesRes.data ?? []).map((s) => [s.id, s])),
        firstSiteId: state.sites[0]?.id ?? null,
        showSite: state.sites.length > 1,
        sample: setup.sample,
      }
    : null;
  const first = state ? isFirstRun(state) : true;
  const live = state?.steps.filter(counts) ?? [];
  const done = live.filter((s) => s.status === 'done').length;
  const optional = state?.steps.filter((s) => s.status === 'off') ?? [];
  const locked = state?.steps.filter((s) => s.status === 'locked') ?? [];

  return (
    <div className="min-h-screen pb-24">
      <header className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <a
          href="/"
          className="flex items-center gap-2.5 rounded-lg text-[15px] font-semibold tracking-[-0.01em] text-ink"
          onClick={(e) => {
            e.preventDefault();
            later();
          }}
        >
          <LogoMark size={26} animated />
          FounderData
        </a>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <button type="button" className="btn-ghost btn-pill h-10" onClick={later}>
            I'll finish later
          </button>
        </div>
      </header>

      <div className="sr-only" aria-live="polite">
        {announce}
      </div>

      {!state ? (
        setup.ready && !setup.error ? (
          <div className="mx-auto mt-24 max-w-md px-4 text-center">
            <p className="text-sm text-stone-500">This server does not report its setup yet. Update FounderData, then open this page again.</p>
            <button className="btn btn-pill mt-4 h-10" onClick={() => navigate('/')}>
              Go to Home
            </button>
          </div>
        ) : setup.error ? (
          <div className="mx-auto mt-24 max-w-md px-4 text-center" role="alert">
            <p className="text-sm font-medium text-ink">Setup did not load.</p>
            <p className="mt-1 text-[13px] text-red-600">{setup.error}</p>
            <button className="btn btn-pill mt-4 h-10" onClick={setup.reload}>
              Try again
            </button>
          </div>
        ) : (
          <Loading />
        )
      ) : (
        <main className="mx-auto max-w-[760px] px-4 sm:px-6">
          <div className="pt-10 text-center sm:pt-20">
            <p className="inline-flex h-8 items-center gap-2 rounded-full bg-stone-100 px-3.5 text-[13px] font-medium text-stone-600">
              {setup.sample && <StatusChip tone="info" dot={false} className="-ml-1.5">Sample</StatusChip>}
              <span>
                {done} of {live.length} steps done
              </span>
            </p>
            <h1 className="mx-auto mt-6 max-w-[16ch] text-hero text-ink [text-wrap:balance] sm:mt-8">
              {first ? (
                <>
                  Hand the setup to your <span className="font-serif text-[1.1em] font-normal italic tracking-[-0.02em]">agent.</span>
                </>
              ) : (
                <>
                  Your <span className="font-serif text-[1.1em] font-normal italic tracking-[-0.02em]">agent</span> picks up where it stopped.
                </>
              )}
            </h1>
            <p className="mx-auto mt-5 max-w-[36rem] text-[16px] leading-[1.55] text-stone-500 [text-wrap:pretty] sm:text-[17px]">
              Paste one prompt into your coding agent. It installs the tracker and connects payments, then checks each step here. You sign in when it asks.
            </p>
            <p className="mt-5 inline-flex items-center gap-2 text-[13px] font-medium text-stone-600">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              {estimateLine(state.steps)}
            </p>
          </div>

          <div className="mt-10 sm:mt-12">
            <PromptPanel prompt={setupPrompt(state)} />
          </div>

          <div className="mt-4">
            <Pulse state={state} onAdd={() => setAdding(true)} />
          </div>

          <div className="mt-14 flex items-end justify-between gap-4">
            <h2 className="text-title text-ink">The steps</h2>
            <div className="w-32 pb-2 sm:w-48">
              <Progress done={done} total={live.length} label="Steps done" />
            </div>
          </div>

          {!state.sites.length && (
            <div className="card mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-5">
              <StatusMark status="todo" />
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-sm font-medium text-ink">Add your first site or app</div>
                <div className="text-[13px] text-stone-500">A domain or a bundle id. The prompt above asks your agent to do it too.</div>
              </div>
              <button type="button" className="btn-dark btn-pill h-10" onClick={() => setAdding(true)}>
                Add it here
              </button>
            </div>
          )}

          {byWho(state.steps).map((g) => (
            <section key={g.who} className="mt-8" aria-labelledby={`ob-who-${g.who}`}>
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1">
                <h3 id={`ob-who-${g.who}`} className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-100 text-stone-600" aria-hidden="true">
                    <WhoIcon who={g.who} size={13} />
                  </span>
                  {WHO_LABEL[g.who]}
                  <span className="font-normal text-stone-400">
                    {g.steps.filter((s) => s.status === 'done').length} of {g.steps.length}
                  </span>
                </h3>
                <p className="text-[13px] text-stone-500">{WHO_HINT[g.who]}</p>
              </div>
              <StepList steps={g.steps} ctx={ctx!} openId={openId} label={WHO_LABEL[g.who]} showWho={false} />
            </section>
          ))}

          {optional.length > 0 && (
            <Disclosure title="Optional" sub={`${optional.length} more`} defaultOpen={optional.some((s) => s.id === openId)}>
              <StepList steps={optional} ctx={ctx!} openId={openId} label="Optional steps" />
            </Disclosure>
          )}
          {locked.length > 0 && (
            <Disclosure title="With FounderData Pro" sub={`${locked.length} more`} defaultOpen={locked.some((s) => s.id === openId)}>
              <StepList steps={locked} ctx={ctx!} openId={openId} label="Steps that come with FounderData Pro" />
            </Disclosure>
          )}

          <div className="mt-14 flex flex-col items-center gap-3 border-t border-stone-200/60 pt-8 text-center">
            <p className="text-[13px] text-stone-500">Home keeps your place in a setup card.</p>
            <button type="button" className="btn btn-pill h-10" onClick={later}>
              I'll finish later
            </button>
          </div>
        </main>
      )}
      <AddSite
        open={adding}
        onClose={() => {
          setAdding(false);
          setup.reload();
        }}
      />
    </div>
  );
}
