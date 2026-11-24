/**
 * Onboarding: the setup state the Worker answers on GET /api/v1/setup, and the decisions the dashboard makes from it
 * (which screen shows, which step is next, how long the rest takes, what one product row of the grid says).
 *
 * Everything here is plain functions over the state, so test/onboarding.test.ts covers it without a browser. The
 * components live in components/onboarding/.
 */

// The shape is the Worker's own (src/shared/setup-steps.ts), so a change on either side fails the typecheck.
import type { SetupSiteSummary, SetupState, Step, StepGroup, StepStatus, StepWho } from '../../shared/setup-steps';

export type { SetupState, Step, StepGroup, StepStatus };
export type Who = StepWho;
export type SetupSite = SetupSiteSummary;

/** The part of a step id before the site: 'tracker' for 'tracker:abc'. */
export const kindOfStep = (id: string) => id.split(':')[0];

/** The tracker or SDK step: the one whose first signal ends the first run. */
export const isInstallStep = (s: Pick<Step, 'id'>) => {
  const k = kindOfStep(s.id);
  return k === 'tracker' || k === 'sdk';
};

/** A step that counts toward progress: optional steps nobody picked and Pro steps in core do not. */
export const counts = (s: Step) => s.status !== 'off' && s.status !== 'locked';

/** First run: no site has seen its first visit or app event yet. Also true while there is no site at all. */
export function isFirstRun(state: SetupState): boolean {
  return !state.steps.some((s) => isInstallStep(s) && s.status === 'done');
}

/** Required steps still open. */
export const requiredOpen = (state: SetupState) => state.steps.filter((s) => s.required && s.status !== 'done' && s.status !== 'off' && s.status !== 'locked');

const GROUP_ORDER: StepGroup[] = ['deploy', 'track', 'revenue', 'agent', 'growth'];

/**
 * The one next step. The server picks it (state.next); this is the same rule for a fixture or an older Worker:
 * anything broken first, then required steps in order, then optional ones that were started. Never a locked step,
 * and never a step that is only waiting for a signal while something else can be done.
 */
export function pickNext(steps: Step[], siteId?: string): Step | null {
  const mine = siteId ? steps.filter((s) => !s.site || s.site.id === siteId) : steps;
  const ordered = [...mine].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return (
    ordered.find((s) => s.status === 'broken') ??
    ordered.find((s) => s.required && s.status === 'todo') ??
    ordered.find((s) => s.required && s.status === 'waiting') ??
    ordered.find((s) => !s.required && s.status === 'todo') ??
    ordered.find((s) => !s.required && s.status === 'waiting') ??
    null
  );
}

/** The next step for the whole deployment (the server's, when it sent one) or for one site. */
export function nextStep(state: SetupState, siteId?: string): Step | null {
  if (!siteId && state.next && state.next.status !== 'locked') return state.next;
  return pickNext(state.steps, siteId);
}

/** Minutes a step takes the agent, or the person, roughly. A sign-in or a console takes longer than a command. */
const MINUTES: Record<Who, number> = { agent: 2, browser: 4, you: 3 };

/**
 * "About 15 minutes, it needs you for 2 sign-ins": the time left over the open steps that count, rounded up to 5,
 * and how many of them need the person (a sign-in, a pasted secret, a click in a console).
 */
export function estimate(steps: Step[]): { minutes: number; signIns: number } {
  const open = steps.filter((s) => counts(s) && s.status !== 'done' && s.status !== 'waiting');
  const raw = open.reduce((n, s) => n + MINUTES[s.who], 0);
  return { minutes: raw ? Math.max(5, Math.ceil(raw / 5) * 5) : 0, signIns: open.filter((s) => s.who !== 'agent').length };
}

/** The groups of the first-run list, by who acts. Optional steps nobody picked and Pro steps go in their own lists. */
export function byWho(steps: Step[]): { who: Who; steps: Step[] }[] {
  const live = steps.filter(counts);
  return (['agent', 'you', 'browser'] as Who[]).map((who) => ({ who, steps: live.filter((s) => s.who === who) })).filter((g) => g.steps.length);
}

/** Columns of the products grid. */
export type GridColumn = 'track' | 'revenue' | 'agent' | 'growth';
export const GRID_COLUMNS: { id: GridColumn; label: string; short: string }[] = [
  { id: 'track', label: 'Tracking', short: 'Track' },
  { id: 'revenue', label: 'Revenue', short: 'Pay' },
  { id: 'agent', label: 'Agent', short: 'Agent' },
  { id: 'growth', label: 'Growth', short: 'Grow' },
];

export interface GridCell {
  status: StepStatus;
  /** The step a click opens: the worst one in the cell. */
  step: Step | null;
  done: number;
  total: number;
}

const WORST: StepStatus[] = ['broken', 'todo', 'waiting', 'done'];

/** One cell: the worst status of the steps it holds. The agent column counts the deployment's own agent steps. */
export function gridCell(steps: Step[], siteId: string, col: GridColumn): GridCell {
  const mine = steps.filter((s) => s.group === col && (s.site ? s.site.id === siteId : col === 'agent'));
  const live = mine.filter(counts);
  for (const status of WORST) {
    const hit = live.find((s) => s.status === status);
    if (hit) return { status, step: hit, done: live.filter((s) => s.status === 'done').length, total: live.length };
  }
  const locked = mine.find((s) => s.status === 'locked');
  return { status: locked ? 'locked' : 'off', step: locked ?? mine[0] ?? null, done: 0, total: 0 };
}

/** A product is fully set up when every step of it that counts is done. */
export function productDone(steps: Step[], siteId: string): boolean {
  const mine = steps.filter((s) => s.site?.id === siteId && counts(s));
  return mine.length > 0 && mine.every((s) => s.status === 'done');
}

/** Steps of one site, plus the deployment's own steps when `withShared`. */
export const stepsOfSite = (steps: Step[], siteId: string, withShared = false) => steps.filter((s) => (s.site ? s.site.id === siteId : withShared));

/** Progress over a list of steps: done of those that count. */
export function progressOf(steps: Step[]) {
  const live = steps.filter(counts);
  return { done: live.filter((s) => s.status === 'done').length, total: live.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Which screen shows

/** Get started is skipped for this browser once the owner says "I'll finish later". */
const SKIP_KEY = 'fd-get-started-skipped';
/** The Home card hides for 7 days after its close button. */
const DISMISS_KEY = 'fd-setup-card-dismissed';
export const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function store(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string, s: Store | null = store()): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string | null, s: Store | null = store()) {
  try {
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    // Storage blocked (private mode, a full quota): the choice lasts for this page load only.
  }
}

export const getStartedSkipped = (s?: Store | null) => read(SKIP_KEY, s) !== null;
export const skipGetStarted = (now = Date.now(), s?: Store | null) => write(SKIP_KEY, String(now), s);
export const unskipGetStarted = (s?: Store | null) => write(SKIP_KEY, null, s);

/** The Home card is dismissed until 7 days after the click. */
export function cardDismissed(now = Date.now(), s?: Store | null): boolean {
  const at = Number(read(DISMISS_KEY, s));
  return Number.isFinite(at) && at > 0 && now - at < DISMISS_MS;
}
export const dismissCard = (now = Date.now(), s?: Store | null) => write(DISMISS_KEY, String(now), s);

/**
 * What Home shows for the owner: the full-screen Get started on the first run (unless skipped), the pinned card while
 * required steps are open (unless dismissed), or nothing. A viewer never sees either.
 */
export function homeSetupView(state: SetupState | null, o: { viewer: boolean; skipped: boolean; dismissed: boolean }): 'get-started' | 'card' | 'none' {
  if (!state || o.viewer) return 'none';
  if (isFirstRun(state) && !o.skipped) return 'get-started';
  if (o.dismissed) return 'none';
  return requiredOpen(state).length > 0 || isFirstRun(state) ? 'card' : 'none';
}

// ---------------------------------------------------------------------------------------------------------------------
// Polling

export interface VisibilitySource {
  hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

/**
 * Runs `tick` now and every `everyMs` while the page is visible. A hidden tab stops the timer; coming back runs a tick
 * at once and starts it again. `stop()` ends it for good. `tick` may be async: the next one waits for it.
 */
export function startPolling(tick: () => unknown, everyMs: number, doc: VisibilitySource = document) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const run = async () => {
    clear();
    if (stopped || doc.hidden || running) return;
    running = true;
    try {
      await tick();
    } catch {
      // A failed poll waits for the next one.
    } finally {
      running = false;
    }
    if (!stopped && !doc.hidden) timer = setTimeout(run, everyMs);
  };
  const onVisibility = () => (doc.hidden ? clear() : void run());
  doc.addEventListener('visibilitychange', onVisibility);
  void run();
  return {
    stop() {
      stopped = true;
      clear();
      doc.removeEventListener('visibilitychange', onVisibility);
    },
    /** True while a timer is set: the poll is live. */
    get active() {
      return timer !== null || running;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

export const WHO_LABEL: Record<Who, string> = { agent: 'Your agent', you: 'You', browser: 'Browser' };
export const WHO_SHORT: Record<Who, string> = { agent: 'Agent', you: 'You', browser: 'Browser' };
export const WHO_HINT: Record<Who, string> = {
  agent: 'Your coding agent does these alone.',
  you: 'Only you can: a sign-in, a pasted secret, a yes to spend.',
  browser: 'Your agent drives the browser. You sign in when it asks.',
};
export const STATUS_LABEL: Record<StepStatus, string> = { done: 'Done', waiting: 'Waiting', todo: 'To do', broken: 'Broken', off: 'Off', locked: 'Pro' };

/** "About 15 minutes. It needs you for 2 sign-ins." */
export function estimateLine(steps: Step[]): string {
  const { minutes, signIns } = estimate(steps);
  if (!minutes) return 'Everything that is left waits for a first signal.';
  const you = signIns === 0 ? 'Your agent does all of it.' : `It needs you for ${signIns === 1 ? 'one sign-in' : `${signIns} sign-ins`}.`;
  return `About ${minutes} minutes. ${you}`;
}

/** The pulse's words: the first visit for a website, the first app event for an app. */
export function firstSignalWords(state: SetupState): { thing: string; done: Step | null; waiting: boolean } {
  const installs = state.steps.filter(isInstallStep);
  const done = installs.find((s) => s.status === 'done') ?? null;
  const web = installs.some((s) => kindOfStep(s.id) === 'tracker') || !installs.length;
  return { thing: web ? 'visit' : 'app event', done, waiting: installs.some((s) => s.status === 'waiting') };
}

// ---------------------------------------------------------------------------------------------------------------------
// The prompt for the coding agent

/**
 * One paste-ready prompt that hands the whole setup to the coding agent: this deployment's address, each site's id,
 * the open steps by who acts, and the rules (secrets go through the paste page, the plan comes first). It holds no
 * secret: the state carries none.
 */
export function setupPrompt(state: SetupState): string {
  const sites = state.sites.length
    ? state.sites.map((s) => `- ${s.name}: site id ${s.id} (${s.kind === 'app' ? 'iOS app' : s.kind === 'both' ? 'website and iOS app' : 'website'})`).join('\n')
    : '- None yet. Ask me which websites and apps to track, then add each one.';
  const open = state.steps.filter((s) => counts(s) && s.status !== 'done');
  const list = open.length
    ? open.map((s) => `- ${s.title}${s.site ? ` for ${s.site.name}` : ''} (${s.who === 'agent' ? 'you' : s.who === 'browser' ? 'you in the browser, I sign in' : 'me, ask me when'})`).join('\n')
    : '- Nothing required. Offer me the optional steps.';
  return `Set up FounderData, my own analytics, and do as much of it as you can yourself.

My FounderData: ${state.origin}

Sites:
${sites}

Open steps:
${list}

How to work:
1. In my FounderData folder (the one with wrangler.jsonc), follow skills/founderdata-setup/SKILL.md. Run \`npm run doctor -- --json\` to see where setup stands. Once the FounderData MCP server is added, the get_setup tool answers the same.
2. Ask me everything you need at once before you start: which codebase belongs to which site, which payment provider each one uses.
3. Show me the plan before you change any account.
4. Never read, print or type a secret. When a step needs one, run \`npm run connect -- <provider>\`. It opens a page where I paste it.
5. Do the next step, check it with doctor or get_setup, then read the state again. Stop and tell me when it is my turn.
6. When you are done, tell me what is live and what is still mine to do.`;
}
