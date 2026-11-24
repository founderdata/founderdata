import { navigate } from '../../App';
import { counts, gridCell, GRID_COLUMNS, nextStep, productDone, STATUS_LABEL, type SetupState, type StepStatus } from '../../lib/setup';
import { CopyButton } from '../setup/kit';
import { StatusChip } from '../ui';
import { Progress, StatusMark, WhoChip } from './parts';

const openStep = (id: string | null) => navigate(id ? `/get-started?step=${encodeURIComponent(id)}` : '/get-started');

const DOT: Record<StepStatus, string> = {
  done: 'bg-emerald-500',
  waiting: 'bg-brand shadow-[0_0_6px_rgb(var(--brand)/0.6)]',
  todo: 'bg-transparent ring-[1.5px] ring-inset ring-stone-300',
  broken: 'bg-red-500',
  off: 'bg-stone-200',
  locked: 'bg-stone-200',
};

/** Products down, track, revenue, agent and growth across. Each cell opens its worst step on Get started. */
export function SetupGrid({ state }: { state: SetupState }) {
  const full = state.sites.filter((s) => productDone(state.steps, s.id)).length;
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h3 className="text-micro uppercase text-stone-400">Products</h3>
        <p className="text-[13px] text-stone-500">
          <span className="font-semibold text-ink">{full}</span> of {state.sites.length} products fully set up
        </p>
      </div>
      <div className="card-inset overflow-hidden">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <caption className="sr-only">Setup of each product</caption>
          <colgroup>
            <col />
            {GRID_COLUMNS.map((c) => (
              <col key={c.id} className="w-[50px] sm:w-[19%]" />
            ))}
          </colgroup>
          <thead>
            <tr className="h-9 text-left text-xs font-medium text-stone-400">
              <th scope="col" className="px-3 font-medium sm:px-4">
                Product
              </th>
              {GRID_COLUMNS.map((c) => (
                <th key={c.id} scope="col" className="px-1 text-center font-medium sm:px-2 sm:text-left">
                  <span className="hidden sm:inline">{c.label}</span>
                  <span className="sm:hidden" aria-hidden="true">
                    {c.short}
                  </span>
                  <span className="sr-only sm:hidden">{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.sites.map((site) => (
              <tr key={site.id} className="border-t border-stone-200/60">
                <th scope="row" className="truncate px-3 text-left font-medium text-ink sm:px-4">
                  {site.name}
                </th>
                {GRID_COLUMNS.map((c) => {
                  const cell = gridCell(state.steps, site.id, c.id);
                  const word = cell.status === 'locked' ? 'Pro' : STATUS_LABEL[cell.status];
                  const title = cell.step ? `${c.label}: ${cell.step.title}, ${word.toLowerCase()}` : `${c.label}: nothing to set up`;
                  return (
                    <td key={c.id} className="p-0.5">
                      <button
                        type="button"
                        className="flex h-10 w-full items-center justify-center gap-2 rounded-lg px-1 text-stone-600 transition-colors duration-fast hover:bg-stone-100 hover:text-ink disabled:pointer-events-none sm:justify-start sm:px-2"
                        onClick={() => openStep(cell.step?.id ?? null)}
                        disabled={!cell.step}
                        title={title}
                        aria-label={`${site.name}, ${title}`}
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[cell.status]}`} aria-hidden="true" />
                        <span className={`hidden truncate sm:inline ${cell.status === 'off' || cell.status === 'locked' ? 'text-stone-400' : ''}`}>{word}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Home's pinned setup card: progress, the one next step with its prompt, and with two or more products the grid.
 * It closes for 7 days (lib/setup.ts dismissCard); Get started stays one click away in the meantime.
 */
export function SetupCard({ state, onDismiss, sample }: { state: SetupState; onDismiss: () => void; sample?: boolean }) {
  const live = state.steps.filter(counts);
  const done = live.filter((s) => s.status === 'done').length;
  const next = nextStep(state);
  const { required_done: rd, required_total: rt } = state.progress;
  return (
    <section className="card relative p-5" aria-labelledby="setup-card-title">
      <button
        type="button"
        className="absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-full text-stone-400 transition-colors duration-fast hover:bg-stone-100 hover:text-ink"
        aria-label="Hide the setup card for 7 days"
        title="Hide for 7 days"
        onClick={onDismiss}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 pr-10">
        <div className="min-w-0">
          <h2 id="setup-card-title" className="flex items-center gap-2 text-micro uppercase text-stone-400">
            Setup
            {sample && (
              <StatusChip tone="info" dot={false} className="normal-case tracking-normal">
                Sample
              </StatusChip>
            )}
          </h2>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-stat text-ink">{done}</span>
            <span className="text-[15px] text-stone-400">of {live.length} steps done</span>
          </p>
        </div>
        <p className="pb-1 text-[13px] text-stone-500">
          {rt - rd > 0 ? `${rt - rd} required ${rt - rd === 1 ? 'step' : 'steps'} left` : 'Required steps done'}
        </p>
      </div>
      <div className="mt-3">
        <Progress done={done} total={live.length} label="Setup steps done" />
      </div>

      {next && (
        <div className="card-inset mt-5 flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3">
          <StatusMark status={next.status} />
          <div className="min-w-0 flex-1 basis-56">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-ink">{next.title}</span>
              {next.site && <span className="text-xs text-stone-400">{next.site.name}</span>}
              <WhoChip who={next.who} />
            </div>
            <div className="mt-0.5 text-[13px] text-stone-500">{next.next ?? next.outcome}</div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {next.prompt && <CopyButton value={next.prompt} label="Copy prompt" className="btn btn-pill h-10" />}
            <button type="button" className="btn-dark btn-pill h-10" onClick={() => openStep(next.id)}>
              Open setup
            </button>
          </div>
        </div>
      )}

      {state.sites.length >= 2 && <SetupGrid state={state} />}
    </section>
  );
}
