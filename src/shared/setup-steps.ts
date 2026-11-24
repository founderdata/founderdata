// The setup state an owner, the dashboard, `npm run doctor` and an agent read from GET /api/v1/setup (docs/API.md,
// "Setup state"). One shape everywhere: the dashboard's onboarding, the CLI and the MCP tool get_setup show the same steps.
// Types only, so the dashboard can import them without pulling in Worker code.

/**
 * - done: a real signal arrived (a visit, a linked payment, an Apple notification, a key call).
 * - waiting: set up, and the real signal has not arrived yet.
 * - todo: not started.
 * - broken: set up and failing (bad signatures, a cron that stopped).
 * - off: optional and not chosen.
 * - locked: needs FounderData Pro. Core only; the step says what it unlocks.
 */
export type StepStatus = 'done' | 'waiting' | 'todo' | 'broken' | 'off' | 'locked';

/** agent: the coding agent does it alone. you: only the human can. browser: the agent drives a browser, the human signs in. */
export type StepWho = 'agent' | 'you' | 'browser';

export type StepGroup = 'deploy' | 'track' | 'revenue' | 'growth' | 'agent';

export interface Step {
  /** Stable: 'deploy', 'cron', 'email', 'agent-key', 'agent-used', 'tracker:<site>', 'sdk:<site>', 'payments:<site>', 'attribution:<site>', 'apple:<site>', and Pro's. */
  id: string;
  group: StepGroup;
  /** null: the step belongs to the whole deployment. */
  site: { id: string; name: string } | null;
  title: string;
  /** What the owner gets, one sentence. */
  outcome: string;
  status: StepStatus;
  who: StepWho;
  /** Required: deploy, a tracker or SDK per site, and one payment provider with attribution per site. */
  required: boolean;
  /** The real signal behind the status, or null when there is none. */
  evidence: string | null;
  /** One plain sentence on what to do, or null when nothing is left. */
  next: string | null;
  /** Paste-ready text for the coding agent. Never holds a secret. */
  prompt: string | null;
  /** Repo path of the guide the agent follows, such as 'skills/founderdata-connect/stripe.md'. */
  skill: string | null;
  /** A provider page (https://...) or a dashboard path ('/site/<id>/settings#stripe'). */
  url: string | null;
  /** A command to run in the FounderData checkout, such as 'npm run connect -- stripe --site <id>'. */
  command: string | null;
  /** Names and whether each is set. Never a value, prefix or length. */
  secrets?: { name: string; set: boolean }[];
  /** What it costs, such as "Free". */
  cost: string | null;
  /** Needs FounderData Pro. */
  pro?: boolean;
}

export type SiteKind = 'web' | 'app' | 'both';

export interface SetupSiteSummary {
  id: string;
  name: string;
  kind: SiteKind;
  /** Steps of this site that are done, and all of its steps that count (not off, not locked). */
  done: number;
  total: number;
  /** The id of this site's next step, or null when nothing is left. */
  next: string | null;
}

export interface SetupState {
  edition: 'core' | 'pro';
  version: string;
  origin: string;
  now: number;
  /** Steps that count leave out off and locked ones. */
  progress: { done: number; total: number; required_done: number; required_total: number };
  /** The one step to do next: broken first, then required in order, then optional in order. Null when nothing is left. */
  next: Step | null;
  /** Ordered by group: deploy, track, revenue, agent, growth. */
  steps: Step[];
  sites: SetupSiteSummary[];
}

export const STEP_GROUPS: StepGroup[] = ['deploy', 'track', 'revenue', 'agent', 'growth'];
