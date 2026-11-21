// What the MCP tools are built from (docs/MCP.md): the tool shape, the JSON Schema helpers, the shared output schemas and
// the argument checks. mcp.ts (the server and core's tools) and FounderData Pro's tools both import it, so it imports
// nothing that is Pro and nothing that reads the edition.
import type { WriteScope } from './keys';

export type Args = Record<string, unknown>;
export type Json = Record<string, unknown>;

export interface Tool {
  name: string;
  /** Pro tools only: the tool this one follows in tools/list, so the order stays the same with the Pro tools merged in. */
  after?: string;
  title: string;
  description: string;
  inputSchema: Json;
  /** The JSON Schema of structuredContent. test/agent-access.test.ts validates every tool's live answer against it. */
  outputSchema: Json;
  annotations: Json;
  /** The scope a write tool needs; the route checks it. */
  scope?: WriteScope;
  /** The route names unknown fields in `ignored`, so callTool passes them on instead of refusing them (the plan's writes). */
  namesUnknown?: true;
  /** The route and query, from the arguments. Throws ArgError for a bad argument. */
  route: (a: Args) => { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: string[]; body?: Json; auth?: 'write'; scope?: WriteScope };
  /** Turns the route's JSON into the tool's answer. */
  shape?: (body: unknown, res: Response, a: Args) => unknown;
  /** What to do when the answer is cut to fit. */
  more?: string;
}

export class ArgError extends Error {}

export const PERIODS = ['today', 'yesterday', '24h', '48h', '7d', '30d', '90d', '12m', 'thisquarter', 'lastquarter', 'all'];
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const RANGE_PROPS = {
  period: { type: 'string', enum: PERIODS, description: 'Default 30d; from or to replace it.' },
  from: { type: 'string', pattern: DAY.source, description: 'First day.' },
  to: { type: 'string', pattern: DAY.source, description: 'Last day.' },
  filters: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Only matching visits, such as {"country":"DE"}; keys in get_definitions. "" matches none.',
  },
};
export const RANGE = ['period', 'from', 'to', 'filters'];
export const SITE_PROP = {
  site: { type: 'string', description: 'Site id, for a multi-site key.' },
};

export const schema = (props: Json, required: string[] = []): Json => ({
  type: 'object',
  properties: { ...props, ...SITE_PROP },
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ---------- output schemas: what structuredContent holds. Loose on purpose: extra fields are allowed (a cut answer adds
// `trimmed`), and a field is required only when every answer of the tool has it, for every key.

export const str = { type: 'string' };
export const num = { type: 'number' };
export const bool = { type: 'boolean' };
export const nstr = { type: ['string', 'null'] };
export const nnum = { type: ['number', 'null'] };
export const nbool = { type: ['boolean', 'null'] };
export const anyObj = { type: 'object' };
export const nobj = { type: ['object', 'null'] };
export const alwaysNull = { type: 'null', description: 'Always null: names, emails and user ids never leave FounderData.' };
export const out = (properties: Json, required: string[] = [], description?: string): Json => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  ...(required.length ? { required } : {}),
});
export const arr = (items?: Json) => (items ? { type: 'array', items } : { type: 'array' });
export const strs = arr(str);
export const RANGE_OUT = { site_id: str, timezone: str, from: str, to: str, currency: str, currency_decimals: num };
export const STATUS = { type: 'string', enum: ['ok', 'stale', 'error', 'off'] };
/** tracking_since (src/worker/sources.ts): when each kind of data starts. */
export const TRACKING_OUT = out({ web: nstr, app: nstr, imported: nstr, payments: nstr, app_store: nstr, gsc: nstr, visitors: nstr, revenue: nstr });
/** The short form of source health for a list of sites: each status, and the ones that need a look. */
export const SOURCES_SHORT = out({ status: anyObj, problems: arr(out({ source: str, status: STATUS, last_ok_at: nstr, last_error: nstr, detail: str }, ['source', 'status'])) }, ['status', 'problems']);
/** Attribution coverage (stats.ts coverageOut). */
export const COVERAGE_OUT = out(
  { payments: num, linked_payments: num, linked_share: nnum, amount: num, linked_amount: num, app_store_no_source: num, attributed_share: nnum, not_linked: anyObj },
  ['payments', 'linked_payments', 'attributed_share'],
);
/** One group of get_web_vitals: page loads and, per metric, the p75 (null below min_sample) and the rating shares. */
export const VITAL_OUT = out({ p75: nnum, samples: num, good: nnum, needs_improvement: nnum, poor: nnum, rating: nstr }, ['p75', 'samples']);
export const VITALS_OUT = out({ page_loads: num, device: str, path: str, lcp: VITAL_OUT, inp: VITAL_OUT, cls: VITAL_OUT, ttfb: VITAL_OUT, fcp: VITAL_OUT }, ['page_loads', 'lcp', 'inp', 'cls', 'ttfb', 'fcp']);
export const MONEY_OUT = out({ currency: str, amount: num }, ['currency', 'amount']);
/** One next action (pro/worker/actions-store.ts). */
export const ACTION_OUT = out(
  { site_id: str, kind: str, title: str, value: nnum, currency: nstr, value_basis: nstr, clicks: nnum, evidence: anyObj, next: anyObj, skill: nstr, link: str },
  ['site_id', 'kind', 'title', 'value', 'next'],
);
export const NOTE_OUT = out(
  {
    site_id: str,
    id: str,
    ts: num,
    time: str,
    bucket: str,
    text: str,
    kind: nstr,
    origin: str,
    actor: nstr,
    target: nstr,
    before: nstr,
    after: nstr,
    idempotency_key: nstr,
    metric: nstr,
    window_days: { type: ['number', 'null'] },
    group: nstr,
    ends_at: nstr,
    created_at: num,
    review_after: str,
    review: nobj,
    impact: anyObj,
    group_notes: strs,
  },
  ['id', 'time', 'text'],
);
export const limitProp = (max: number, def: number, what: string) => ({ type: 'integer', minimum: 1, maximum: max, description: `${what} Default ${def}.` });

export function oneOf(a: Args, key: string, allowed: readonly string[], fallback?: string): string | undefined {
  const v = a[key] ?? fallback;
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new ArgError(`${key} is one of ${allowed.join(', ')}`);
  return v;
}

export const BREAKDOWN_DIMS = [
  'channel', 'source', 'referrer', 'campaign', 'keyword', 'utm_source', 'utm_medium', 'utm_content', 'ref',
  'country', 'region', 'city', 'browser', 'os', 'device', 'platform', 'app_version', 'hostname',
  'page', 'entry_page', 'exit_page', 'goal', 'exit_link', 'x_post', 'referrer_domain', 'click_network', 'language',
  'heard_about',
];
export const NOTE_VIEWS = ['list', 'actors'];
/** get_overview and get_portfolio: the numbers, or the next actions (pro/worker/actions.ts). */
export const ACTION_VIEWS = ['summary', 'actions'];

/** Arguments that belong to some modes of a tool only: an argument of another mode is refused, never dropped. */
export function onlyIn(a: Args, mode: string, homes: Record<string, string[]>, what: string | Record<string, { label: string; how: string }>) {
  for (const [arg, home] of Object.entries(homes)) {
    if (a[arg] === undefined || home.includes(mode)) continue;
    // A tool whose modes are not one argument (list_notes) names each mode by the arguments that pick it.
    if (typeof what !== 'string') {
      throw new ArgError(`${arg} works only with ${home.map((m) => what[m].label).join(' or ')}. This call asks for ${what[mode].label}, which ignores it. Drop ${arg}, or ${what[home[0]].how}.`);
    }
    throw new ArgError(`${arg} is only for ${what} ${home.join(' or ')}. You asked for ${what} ${mode}, which ignores it. Drop ${arg}, or set ${what} to ${home[0]}.`);
  }
}

/** list_notes modes in the arguments that pick them: it has view and due, not mode. */
export const NOTE_MODES = {
  list: { label: 'the note list', how: 'leave out view and due' },
  due: { label: 'due true', how: 'set due to true and leave out view' },
  actors: { label: 'view "actors"', how: 'set view to "actors" and leave out due' },
};

export const wrapRows = (body: unknown) => (Array.isArray(body) ? { rows: body } : body);


/** A tool, as mcp.ts lists it and `Pro.mcpTools` contributes it. */
export type McpTool = Tool;

/**
 * The API's errors name REST parameters and routes; a tool takes arguments instead. Exported for tests: no MCP error
 * may say ?site=, a URL or an /api/ path.
 */
export const forAgents = (msg: string, tool = 'this tool') =>
  msg
    .replace(/Add \?site=<site id>; GET \/api\/v1\/portfolio lists the ids\./, 'Pass the site argument; whoami and get_portfolio list the ids.')
    .replace(/Add \?site=<site id>; GET \/api\/v1\/whoami lists the sites it covers\./, 'Pass the site argument; whoami lists the sites it covers.')
    .replace(/Add \?site=<site id> to the URL\./, 'Pass the site argument; whoami lists the sites it covers.')
    .replace(/GET \/api\/v1\/portfolio lists the ids\./, 'Call whoami or get_portfolio for the site ids.')
    .replace(/GET \/api\/v1\/whoami lists the sites it covers\./, 'Call whoami for the sites it covers.')
    .replace(/\?(\w+)=<[^>]*>/g, 'the $1 argument')
    .replace(/(?:(?:GET|POST|PUT|DELETE) )?\/api\/v1\/[\w/{}<>.:-]*\w/g, tool);
