// The seams FounderData Pro plugs into (docs/PRO.md). Core runs without Pro: `pro` in edition.ts is null, every hook
// here is optional, and each place that calls one behaves as if the feature did not exist when it is missing.
//
// Rules for a hook:
// - Core never imports from pro/. Pro imports from core freely.
// - A hook is optional and typed here. Core calls it as `pro?.hook?.(...)` and has a sensible answer without it.
// - Data that arrives from outside (tracker, SDK, payment webhooks) is stored by core in every edition, so turning Pro
//   on shows history at once. Pro adds reports, imports that pull from third-party APIs, and the agent layer.
import type { Hono } from 'hono';
import type { AppEnv, Site } from './env';
import type { PaymentPush } from './notify';
import type { JudgeInput, Judgement } from './note-metrics';
import type { AscPrefetch, ConvertedProceeds, MoneyLine } from './revenue';
import type { MrrMovement } from './subscriptions';
import type { SearchDrop } from '../shared/seo-insights';
import type { AlertKind, AlertMessage, ChannelRow } from './alerts';
import type { NewEvent } from './alert-events';
import type { Digest, DigestSite } from './digest';
import type { home } from './home';
import type { Plan } from './cron';
import type { SubrequestBudget } from './subrequests';
import type { McpTool } from './mcp-kit';
import type { Env } from './env';
import type { BreakdownRow, Ctx } from './stats';
import type { NetShares } from './commission';
import type { SourceHealth, SourceProbe } from './sources';
import type { Row as SetupRow } from './setup-checklist';
import type { SetupSite } from './setup-state';
import type { Step } from '../shared/setup-steps';
import type { MapWhere, PageClicks } from './page-maps';

type App = Hono<AppEnv>;
export type Bindings = AppEnv['Bindings'];

/** What a scheduled job gets: the metered env and fetch of the invocation, and its subrequest budget. */
export interface CronContext {
  env: Bindings;
  now: number;
  plan: Plan;
  budget: SubrequestBudget;
  fetch: typeof fetch;
}

/**
 * A job on the five-minute tick (or the old hourly cron). The phases run in this order in one invocation:
 * - `slot`: the hourly slot jobs, after core's (idle import sweep, daily alerts, weekly report).
 * - `tick`: every tick, before the feeds (Meta Conversions API, AI answer counts).
 * - `feed`: the hourly imports (X poll, Search Console, Meta ads), in list order.
 * - `work`: rank checks and AI checks. On the old hourly cron `work` runs before `feed`.
 */
export interface ProJob {
  name: string;
  phase: 'slot' | 'tick' | 'feed' | 'work';
  /** Whether this invocation runs it. */
  when(plan: Plan, budget: SubrequestBudget): boolean;
  run(c: CronContext): Promise<unknown>;
}

/** MRR of one site at the end of Home's period and at its start, in the site's currency (subscription-metrics.ts mrrBySite). */
export interface SiteMrr {
  mrr: number;
  active: number;
  mrrStart: number;
  movement: MrrMovement;
}

/** Downloads and proceeds Apple reports over a span of days (ascsales.ts appStoreByPeriod); `importedDays` 0 means not measured. */
export interface AppStoreSpan {
  importedDays: number;
  sites: Map<string, { downloads: number; proceeds: MoneyLine[]; proceedsConverted: ConvertedProceeds }>;
}

/** What core's Home tells Pro in its first round trip. */
export interface HomeStart {
  /** The totals-only read (GET /api/home?parts=pulse): no changes, drops, actions or App Store. */
  pulse: boolean;
  /** False: the caller skipped the changes and the next actions (`changes: false`). */
  changes: boolean;
  now: number;
  /** The days (YYYY-MM-DD) of Apple's report core reads ahead (ascPrefetchSpan). */
  span: { from: string; to: string };
}

/** What core's Home tells Pro once the sites and the period are known. */
export interface HomeParts {
  sites: Site[];
  range: { from: number; to: number };
  tz: string;
  /** The timezone's offset at the end of the period, to turn the period into the days of Apple's report. */
  offset: number;
  now: number;
  /** Apple's report rows core read ahead; pass them on instead of reading them again. */
  prefetch: AscPrefetch;
}

/** Pro's share of Home across sites. Without it Home has no MRR, App Store reports, changes, search drops or next actions. */
export interface ProHome {
  /**
   * Round trip 1: start the reads Pro needs next to core's, synchronously, so they go out in the same batch. The
   * promise is handed to `parts`.
   */
  start(db: D1Database, a: HomeStart): Promise<unknown>;
  /** Round trip 2, with the `start` answer. Every promise is started here and awaited by core when it builds the answer. */
  parts(db: D1Database, early: unknown, a: HomeParts): {
    /** MRR now and at the period's start, by site with subscriptions. */
    mrr: Promise<Map<string, SiteMrr>>;
    /** MRR at 12 even steps through the period, by site. */
    mrrSeries: Promise<Map<string, number[]>>;
    /** Apple's downloads and proceeds for apps with an app bundle id; null when no app. */
    appStore: Promise<AppStoreSpan> | null;
    /** The last 7 days of changes with verdicts, already summarized (changes-summary.ts); null when skipped. */
    changes: Promise<unknown> | null;
    /** Sites whose Google traffic dropped (search-drop.ts); null when skipped. */
    drops: Map<string, SearchDrop> | null;
    /** The highest next actions across sites, public shape, at most HOME_ACTIONS (home.ts). */
    actions: unknown[];
  };
}

/** Pro's parts of the daily alerts and the weekly report (digest.ts). Core's own content (revenue, visitors, sources, products, quiet sites, stopped providers) never depends on them. */
export interface ProDigest {
  /**
   * Called from buildDigest, right after Home's numbers, so the reads start in the same batches as core's. `sites` are
   * Home's. Returns, for every site, fields copied onto its DigestSite (the weekly report's data), and fields copied onto
   * the Digest itself.
   */
  weekly?(a: {
    db: D1Database;
    sites: Awaited<ReturnType<typeof home>>['sites'];
    from: number;
    to: number;
    tz: string;
    fromDay: string;
    toDay: string;
  }): Promise<{ sites: Map<string, Record<string, unknown>>; report: Record<string, unknown> }>;
  /** Lines under a site's numbers in the report, after its top pages and screens. */
  siteLines?(s: DigestSite, showRevenue: boolean): string[];
  /** Fields a site adds to the weekly report's JSON (GET /api/v1/weekly). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  siteJson?(s: DigestSite, showRevenue: boolean): Record<string, any>;
  /** Lines after the "All sites" block (null: none) and fields for the alert's data and the weekly JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reportPart?(d: Digest, siteIds: string[] | null, showRevenue: boolean): { lines: string[] | null; data: Record<string, any> };
  /**
   * More daily alerts, run in runDailyAlerts after core's. Push the inbox rows to `events`; return counts by name,
   * which join the answer of runDailyAlerts. `takes(kind)` says whether any channel takes the kind.
   */
  daily?(a: {
    env: Bindings;
    now: number;
    channels: ChannelRow[];
    fetchFn: typeof fetch;
    takes(kind: AlertKind): boolean;
    events: NewEvent[];
  }): Promise<Record<string, number>>;
  /**
   * The "Send test" message of an alert kind that is Pro's (numbers, aso_collector, aso_review), on one of the
   * channel's sites; undefined for any other kind, null for a kind with nothing to show.
   */
  preview?(a: { db: D1Database; ch: ChannelRow; kind: AlertKind; site: Site; only: string[] | null; now: number }): Promise<AlertMessage | null | undefined>;
}

/** FounderData Pro, as the build that includes pro/ exports it (pro/worker/index.ts). */
export interface Pro {
  /** Routes that need no login (webhooks, OAuth callbacks). Registered before core's auth middleware. */
  publicRoutes?(app: App): void;
  /** Routes behind login or an API key. Registered after core's routes, before the /api 404. */
  routes?(app: App): void;
  /** Jobs on the tick cron. */
  jobs?: ProJob[];
  /**
   * A scheduled event core does not plan (the nightly 03:17 cron, the App Store sales cron, the old daily cron).
   * Return the promises to wait on; core adds its own nightly work to the 03:17 cron.
   */
  scheduled?(cron: string, env: Bindings, scheduledTime: number): Promise<unknown>[];
  /** The deployment has the ASA_* secrets, so an app's Apple Search Ads section is not muted (GET /api/sites has_asa). */
  asaConfigured?(env: Bindings): boolean;
  /** A site was deleted: drop what Pro caches about it in this isolate. */
  forgetSite?(siteId: string): void;

  // ---- builder A
  /** Builds the tools the MCP server adds to core's ten (mcp.ts calls it once, at load). Each names the tool it follows in `after`, so tools/list keeps one order. */
  mcpTools?(): McpTool[];
  /** MCP prompts: Pro's agent skills (each skills/NAME/SKILL.md, bundled by pro/scripts/sync-skills.mjs). They join core's (src/worker/core-skills.ts); one with a core skill's name replaces it. */
  skills?: { name: string; title: string; description: string; body: string }[];

  /** MRR of one site at `at` and at `from`, and its paying subscriptions: the Overview's MRR (share.ts siteMrr). Undefined without subscriptions. Core has no MRR. */
  mrrForSite?(db: D1Database, siteId: string, at: number, from: number, now: number): Promise<{ mrr: number; mrrStart: number; active: number } | undefined>;
  /** Rows of the x_post breakdown dimension: the posts that paid (stats.ts). Without it the dimension is empty. */
  xPostRows?(ctx: Ctx, limit: number): Promise<BreakdownRow[]>;
  /** The newest imported App Store sales day per site, for the mobile summary (summary.ts). Without it no site has one. */
  latestAppStoreDay?(
    db: D1Database,
    siteIds: string[],
  ): Promise<Map<string, { date: string; downloads: number; proceeds: { currency: string; amount: number }[] } | null>>;
  /** One site's Apple Search Ads totals of the last 30 days, for "Since yesterday" (since-yesterday.ts). Without it that block has no Apple line. */
  asaSummary?(
    db: D1Database,
    site: Site,
    now: number,
    opts: { shares?: NetShares },
  ): Promise<{ from: string; to: string; currency: string; totals: { spend: number | null; paid: number; revenue: number } }>;
  /**
   * Health of the integrations Pro owns, for sources.ts siteTrust (whoami, get_definitions, the portfolio). Called once per
   * site with what core's one D1 batch already read; returns a row for each of app_store, apple_search_ads, meta,
   * search_console, aso, dataforseo, ai_engines, x and email. A missing id is `off` in core's answer.
   */
  sourceHealth?(probe: SourceProbe): Partial<Record<string, SourceHealth>>;
  /**
   * Checklist rows Pro adds to GET /api/setup, after the cron row and before the email and webhook rows (setup-checklist.ts).
   * `state` holds the cron_state rows core read ('tick:*' and 'test:*').
   */
  setupRows?(env: Env, ctx: { origin: string; now: number; state: Map<string, { value: string; at: number }> }): Promise<SetupRow[]>;
  /**
   * Steps Pro adds to GET /api/v1/setup (setup-state.ts), in the `growth` group or any other: Search Console, keyword
   * ranks, AI answers, App Store sales, Apple Search Ads, Meta ads, the plan and the nightly schedule. `sites` are the
   * sites the caller sees, each secret as a boolean; `state` holds the cron_state rows core read. Without the hook core
   * lists the same outcomes as `locked` steps. A step's status needs a real signal for `done` (docs/API.md, "Setup state").
   */
  setupSteps?(env: Env, ctx: { origin: string; now: number; sites: SetupSite[]; state: Map<string, { value: string; at: number }> }): Promise<Step[]>;
  /** Test buttons behind POST /api/setup/test/:name, by name (a row's `test`). Core has none. */
  setupTests?: Record<string, (env: Env) => Promise<{ ok: boolean; message: string }>>;
  // ---- builder B
  /**
   * Phone push for a recorded payment, refund or trial (core's announce(), which already skips sandbox events). Core
   * sends the Slack, Discord, Telegram, webhook and email channels itself. Must not throw; core also swallows a rejection.
   */
  phonePush?(env: Bindings, site: Site, n: PaymentPush): Promise<unknown>;
  /**
   * Judges a change note on a metric core cannot read from visits and payments: Search Console clicks, Google rank, AI
   * answers, ad spend and the paywall (JudgeInput and Judgement in note-metrics.ts). Without it core leaves such a note
   * inconclusive. The visit rule and the App Store rank stay in core.
   */
  judgeMetric?(i: JudgeInput): Promise<Judgement>;
  /** Pro's parts of Home across sites (MRR, App Store reports, changes, search drops, next actions). */
  home?: ProHome;
  /** Pro's parts of the daily alerts and the weekly report. */
  digest?: ProDigest;

  // ---- mail (pro/worker/mail/, migration 0070)
  /**
   * The Worker's `email()` handler: Cloudflare Email Routing hands over one inbound message per recipient. Without it
   * core rejects every message with a reason the sender's server reports back (index.ts).
   */
  email?(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext): Promise<void>;
  /**
   * The Worker's `queue()` handler, for the MAIL_QUEUE consumer: Cloudflare's sending events, inbound parse jobs and
   * webhook deliveries. Pro acks or retries each message. Without it core acks the batch so nothing piles up.
   */
  queue?(batch: MessageBatch<unknown>, env: Bindings, ctx: ExecutionContext): Promise<void>;
  /**
   * Erasing a person by email (erase.ts erasePerson) also removes their mail: messages they sent or received, the R2
   * objects, events, webhook deliveries and suppressions. Mail belongs to the deployment, so this covers every site.
   * Returns counts by name, which join the answer and the erase log. Called only for an erase by email, and only for a
   * caller with authority over mail: the owner's login, or a key that also holds mail:write (erase.ts mayEraseMail).
   */
  erasePerson?(a: { env: Bindings; email: string }): Promise<Record<string, number>>;
  /**
   * Asked before anything is erased, for the same callers as erasePerson: a reason this address cannot be erased from
   * mail (it is one of the deployment's own addresses, or mail storage is missing), or null. A refusal stops the whole
   * erase with its status, so nothing is half done.
   */
  eraseRefusal?(a: { env: Bindings; email: string }): Promise<{ error: string; status: 400 | 503 } | null>;

  // ---- people and recordings (pro/docs/replay-plan.md, migration 0072)
  /**
   * Whether to record this visit, asked for every pageview of a site with `record_visits` on and the REPLAY_BUCKET
   * binding (collect.ts trackerConfig). Return the recorder's settings to record, which the pageview answer carries as
   * `cfg.rec` and the tracker hands to /js/replay.js through `window.founderdata._rec.cfg`, or null not to. Keep the
   * answer stable for one `sid` (sample by a hash of it), so every page of a recorded visit records. Reads only: the
   * index row is written by the first chunk. Without the hook no visit is recorded. A rejection counts as null.
   */
  recordDecision?(env: Bindings, site: Site, sid: string, now: number): Promise<RecordConfig | null>;
  /**
   * Erasing visitors (erase.ts: one visitor, or a person by email or user id) also removes their recordings: the R2
   * chunks under r/<site_id>/<session_id>/ and the `replays` rows. Called before core deletes the visits, with every
   * visitor id the erase covers. Returns counts by name (`recordings`), which join the answer and the erase log. Core
   * deletes any `replays` row left after it.
   */
  eraseRecordings?(a: { env: Bindings; site: Site; visitorIds: string[] }): Promise<Record<string, number>>;

  // ---- round 7: experiments and surveys (migration 0090)
  /**
   * Running experiments this pageview enters (plan S4), as {key: variant}. Sync: reads site.exp_live only, never D1.
   * Core asks on every pageview except a preview (`xp`) and a visit from a hosting network; it stores the answer as
   * the session properties exp_<key> (collect.ts) and sends it back as `cfg.x`. {} or null = none.
   */
  experimentDecision?(site: Site, vid: string, path: string): Record<string, string> | null;
  /**
   * Which surveys are on and whether to show one on this page (plan S6), for `cfg.sv`. May read the visitor row.
   * Asked in the same round trip as recordDecision. Null = no survey. A rejection counts as null.
   */
  surveyDecision?(env: Bindings, site: Site, vid: string, path: string, now: number): Promise<SurveyConfig | null>;
  /**
   * `clicks` of the content page answer (notes.ts contentPage, get_content with a path): the page's mapped page views
   * and its 10 most clicked elements in the window, from page_maps (plan S1: the report is Pro's, the rows are core's).
   * Without it, or with no rows, `clicks` is null.
   */
  pageClicks?(db: D1Database, w: MapWhere): Promise<PageClicks | null>;
}

/** `cfg.sv` of the pageview answer: the surveys that are on, and the one to show on this page. */
export interface SurveyConfig {
  /** Survey keys that are on: heard_about, cancel_reason. */
  on: string[];
  /** The survey the tracker shows on this page at once; absent for none. */
  show?: string;
}

/**
 * The recorder settings of one visit (`cfg.rec` in the pageview answer, docs/API.md "Tracker config"). Pro's
 * recordDecision fills it; the tracker only passes it on to /js/replay.js. Every text input is always masked.
 */
export interface RecordConfig {
  /** CSS selector of elements whose text is masked: "[data-fd-mask]". */
  mask: string;
  /** CSS selector of elements left out of the recording: "[data-fd-block]". */
  block: string;
  /**
   * Pages that are never recorded (`record_skip`): path prefixes. The tracker sends no clicks or errors from a page
   * whose path is one of them or starts with one plus "/", and the recorder records nothing there. Absent for none.
   */
  x?: string[];
  /** More settings Pro's replay.js reads. Short keys: this rides on every pageview answer of a recorded visit. */
  [key: string]: string | number | boolean | string[] | undefined;
}

// ---------- the installed edition

let installed: Pro | null = null;

/**
 * Called once by the Worker's entry (index.ts) with edition.ts's `pro`, and by the test setup. Core modules read Pro
 * with proHooks() when they run, never while they load: edition.ts pulls in every Pro module, and Pro modules import
 * core ones, so a core module that imported edition.ts would have Pro run in the middle of its own load.
 */
export function installPro(p: Pro | null) {
  installed = p;
}

/** The installed FounderData Pro, or null in core. */
export const proHooks = (): Pro | null => installed;
