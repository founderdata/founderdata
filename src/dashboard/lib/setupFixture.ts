import type { SetupState, Step, StepStatus } from './setup';

/**
 * Sample setup states with the exact shape of GET /api/v1/setup, for the demo (`?setup=fresh` and friends), the
 * screenshots, the tests, and a dev server whose Worker does not answer the route yet. Never used for a real answer.
 */
export type FixtureName = 'nosite' | 'fresh' | 'half' | 'multi' | 'done';
export const FIXTURES: FixtureName[] = ['nosite', 'fresh', 'half', 'multi', 'done'];

interface SiteSpec {
  id: string;
  name: string;
  kind: 'web' | 'app' | 'both';
  track: StepStatus;
  payments: StepStatus;
  attribution: StepStatus;
  apple?: StepStatus;
}

function step(p: Partial<Step> & Pick<Step, 'id' | 'group' | 'title' | 'outcome' | 'status' | 'who'>): Step {
  return { site: null, required: false, evidence: null, next: null, prompt: null, skill: null, url: null, command: null, cost: null, ...p };
}

function siteSteps(s: SiteSpec, origin: string): Step[] {
  const site = { id: s.id, name: s.name };
  const out: Step[] = [];
  const web = s.kind !== 'app';
  if (web)
    out.push(
      step({
        id: `tracker:${s.id}`,
        group: 'track',
        site,
        title: 'Install the tracker',
        outcome: 'Every visit, with the post or search that brought it.',
        status: s.track,
        who: 'agent',
        required: true,
        evidence: s.track === 'done' ? 'First visit 4 minutes ago' : s.track === 'waiting' ? 'Tag found on the homepage. No visit yet.' : null,
        next: s.track === 'done' ? null : s.track === 'waiting' ? 'Open the site once in a normal browser tab.' : 'Ask your agent to add the script tag to every page.',
        prompt: `Add the FounderData tracker to this codebase: <script defer data-website-id="${s.id}" src="${origin}/js/script.js"></script> in the <head> of every page.`,
        skill: 'skills/founderdata-setup/SKILL.md',
        url: `/site/${s.id}/settings#tracker`,
        cost: 'Free',
      }),
    );
  if (s.kind !== 'web')
    out.push(
      step({
        id: `sdk:${s.id}`,
        group: 'track',
        site,
        title: 'Add the iOS SDK',
        outcome: 'App sessions, screens and purchases next to your website.',
        status: web ? 'todo' : s.track,
        who: 'agent',
        required: true,
        evidence: s.track === 'done' && !web ? 'First app event 12 minutes ago' : null,
        next: 'Add the FounderDataKit package and call configure in App.init.',
        prompt: `Add the FounderDataKit Swift package to this app and call FounderData.configure(siteId: "${s.id}", host: "${origin}") in App.init.`,
        skill: 'skills/founderdata-setup/SKILL.md',
        url: `/site/${s.id}/settings#ios-sdk`,
        cost: 'Free',
      }),
    );
  out.push(
    step({
      id: `payments:${s.id}`,
      group: 'revenue',
      site,
      title: 'Connect payments',
      outcome: 'Revenue from your payment provider, refunds included.',
      status: s.payments,
      who: 'you',
      required: true,
      evidence: s.payments === 'done' ? 'Stripe webhook secret set' : null,
      next: s.payments === 'done' ? null : 'Paste the Stripe signing secret into the page the command opens.',
      prompt: `Connect Stripe to FounderData for ${s.name}. Follow skills/founderdata-connect/stripe.md and stop when I need to sign in.`,
      skill: 'skills/founderdata-connect/stripe.md',
      url: 'https://dashboard.stripe.com/webhooks',
      command: `npm run connect -- stripe --site ${s.id}`,
      secrets: [{ name: 'Stripe signing secret', set: s.payments === 'done' }],
      cost: 'Free',
    }),
    step({
      id: `attribution:${s.id}`,
      group: 'revenue',
      site,
      title: 'Link payments to visits',
      outcome: 'See which post, search or ad brought each paying customer.',
      status: s.attribution,
      who: 'agent',
      required: true,
      evidence:
        s.attribution === 'done' ? 'Last payment 2 hours ago, linked to a visit' : s.attribution === 'waiting' ? '3 payments, none linked to a visit yet' : null,
      next: s.attribution === 'done' ? null : 'Add the visitor ids to the checkout metadata.',
      prompt: `Add FounderData's attribution ids to every checkout in this codebase (window.founderdata.attribution() into the payment metadata). Site id ${s.id}.`,
      skill: 'skills/founderdata-connect/stripe.md',
      cost: 'Free',
    }),
  );
  if (s.apple)
    out.push(
      step({
        id: `apple:${s.id}`,
        group: 'revenue',
        site,
        title: 'Point App Store notifications here',
        outcome: 'Renewals and refunds that happen while the app is closed.',
        status: s.apple,
        who: 'browser',
        required: false,
        evidence: s.apple === 'done' ? 'Last Apple notification 1 day ago' : null,
        next: 'Set the notification URL in App Store Connect, App Information.',
        url: 'https://appstoreconnect.apple.com/apps',
        prompt: `Open App Store Connect and set the App Store Server Notifications V2 URL to ${origin}/api/webhooks/apple/${s.id}. Stop when I need to sign in.`,
        skill: 'skills/founderdata-connect/app-store.md',
        cost: 'Free',
      }),
    );
  out.push(
    step({
      id: `google:${s.id}`,
      group: 'growth',
      site,
      title: 'Connect Search Console',
      outcome: 'See which Google searches bring paying customers.',
      status: 'locked',
      who: 'browser',
      pro: true,
      cost: 'Free',
    }),
    step({
      id: `plan:${s.id}`,
      group: 'growth',
      site,
      title: 'Start a growth plan',
      outcome: 'Your agent works a plan for this product every night and asks you before it spends.',
      status: 'locked',
      who: 'agent',
      pro: true,
      cost: 'Free',
    }),
  );
  return out;
}

function shared(agentKey: StepStatus, agentUsed: StepStatus, email: StepStatus): Step[] {
  return [
    step({
      id: 'deploy',
      group: 'deploy',
      title: 'Deploy FounderData',
      outcome: 'Your own copy on Cloudflare, with your data in your database.',
      status: 'done',
      who: 'agent',
      required: true,
      evidence: 'Version 1.5.0 is live',
      command: 'npm run setup',
      cost: 'Free on the Workers free plan',
    }),
    step({
      id: 'cron',
      group: 'deploy',
      title: 'Check the schedule',
      outcome: 'Daily imports, alerts and the weekly report run on their own.',
      status: 'done',
      who: 'agent',
      evidence: 'Last run 3 minutes ago',
      cost: 'Free',
    }),
    step({
      id: 'agent-key',
      group: 'agent',
      title: 'Give your agent a key',
      outcome: 'Your agent reads your numbers through the MCP server.',
      status: agentKey,
      who: 'agent',
      evidence: agentKey === 'done' ? 'Key "Claude Code" made 2 days ago' : null,
      next: agentKey === 'done' ? null : 'Make a read key and add the MCP server to your agent.',
      prompt: 'Make a FounderData API key with read access for this agent and add the FounderData MCP server. Follow skills/founderdata-setup/SKILL.md.',
      url: '/settings#agents',
      cost: 'Free',
    }),
    step({
      id: 'agent-used',
      group: 'agent',
      title: 'Ask your agent a first question',
      outcome: 'Answers like "Which post brought the most revenue this week?"',
      status: agentUsed,
      who: 'agent',
      evidence: agentUsed === 'done' ? 'Last call 1 hour ago' : null,
      next: agentUsed === 'done' ? null : 'Ask it which source brought the most visitors this week.',
      prompt: 'Use the FounderData MCP server: which source brought the most visitors this week, and which brought revenue?',
      cost: 'Free',
    }),
    step({
      id: 'email',
      group: 'deploy',
      title: 'Send the weekly report by email',
      outcome: 'A short summary of each site in your inbox every Monday.',
      status: email,
      who: 'you',
      next: 'Create a Resend key and paste it into the page the command opens.',
      url: 'https://resend.com/api-keys',
      command: 'npm run connect -- resend',
      secrets: [{ name: 'RESEND_API_KEY', set: email === 'done' }],
      skill: 'skills/founderdata-connect/resend.md',
      cost: 'Free up to 3,000 emails a month',
    }),
    step({ id: 'dataforseo', group: 'growth', title: 'Track keyword ranks', outcome: 'Where you rank on Google for the words that sell.', status: 'locked', who: 'you', pro: true, cost: 'About $0.01 a check' }),
    step({ id: 'ai-engines', group: 'growth', title: 'Check AI answers', outcome: 'Whether ChatGPT and Perplexity name you when people ask.', status: 'locked', who: 'you', pro: true, cost: 'About $1 a month' }),
    step({ id: 'schedule', group: 'growth', title: 'Run your agent every night', outcome: 'Your agent works the plan while you sleep and leaves a note.', status: 'locked', who: 'agent', pro: true, cost: 'Free' }),
  ];
}

const SPECS: Record<FixtureName, { sites: SiteSpec[]; agent: [StepStatus, StepStatus]; email: StepStatus }> = {
  nosite: { sites: [], agent: ['todo', 'todo'], email: 'off' },
  fresh: { sites: [{ id: 'SITE_ID', name: 'acme.example', kind: 'web', track: 'waiting', payments: 'todo', attribution: 'todo' }], agent: ['todo', 'todo'], email: 'off' },
  half: {
    sites: [{ id: 'SITE_ID', name: 'acme.example', kind: 'web', track: 'done', payments: 'done', attribution: 'waiting' }],
    agent: ['done', 'todo'],
    email: 'off',
  },
  multi: {
    sites: [
      { id: 'acme', name: 'acme.example', kind: 'web', track: 'done', payments: 'done', attribution: 'done' },
      { id: 'notes', name: 'Notes for iPhone', kind: 'app', track: 'done', payments: 'done', attribution: 'waiting', apple: 'todo' },
      { id: 'blog', name: 'blog.acme.example', kind: 'web', track: 'waiting', payments: 'todo', attribution: 'todo' },
      { id: 'tools', name: 'tools.acme.example', kind: 'web', track: 'done', payments: 'broken', attribution: 'todo' },
    ],
    agent: ['done', 'done'],
    email: 'todo',
  },
  done: {
    sites: [
      { id: 'acme', name: 'acme.example', kind: 'web', track: 'done', payments: 'done', attribution: 'done' },
      { id: 'notes', name: 'Notes for iPhone', kind: 'app', track: 'done', payments: 'done', attribution: 'done', apple: 'done' },
    ],
    agent: ['done', 'done'],
    email: 'done',
  },
};

/**
 * A fixture with this deployment's address in its prompts. `real` lends the sample this deployment's own site ids
 * and names, in order, so links and Settings line up with the sites that exist; the sample keeps its own number of sites.
 */
export function setupFixture(name: FixtureName, origin = 'https://founderdata.example.com', now = Date.now(), real: { id: string; name: string }[] = []): SetupState {
  const base = SPECS[name];
  const spec = { ...base, sites: base.sites.map((s, i) => (real[i] ? { ...s, id: real[i].id, name: real[i].name } : s)) };
  const steps = [...shared(spec.agent[0], spec.agent[1], spec.email)];
  // Deploy-wide steps first, then each site's, in the order deploy, track, revenue, agent, growth.
  const perSite = spec.sites.flatMap((s) => siteSteps(s, origin));
  const order = ['deploy', 'track', 'revenue', 'agent', 'growth'];
  const all = [...steps, ...perSite].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  if (spec.sites.some((s) => s.payments === 'broken')) {
    const b = all.find((s) => s.status === 'broken')!;
    b.evidence = '4 deliveries refused in 24 hours, bad signature';
    b.next = 'The signing secret changed in Stripe. Paste the new one.';
  }
  const live = all.filter((s) => s.status !== 'off' && s.status !== 'locked');
  const req = live.filter((s) => s.required);
  const sites = spec.sites.map((s) => {
    const mine = all.filter((x) => x.site?.id === s.id && x.status !== 'off' && x.status !== 'locked');
    const open = mine.find((x) => x.status !== 'done');
    return { id: s.id, name: s.name, kind: s.kind, done: mine.filter((x) => x.status === 'done').length, total: mine.length, next: open?.title ?? null };
  });
  const state: SetupState = {
    edition: 'core',
    version: '1.5.0',
    origin,
    now,
    progress: { done: live.filter((s) => s.status === 'done').length, total: live.length, required_done: req.filter((s) => s.status === 'done').length, required_total: req.length },
    next: null,
    steps: all,
    sites,
  };
  return state;
}

export const isFixtureName = (x: string | null): x is FixtureName => !!x && (FIXTURES as string[]).includes(x);
