import type { View } from './sections';

/** What each FounderData Pro section does, for the Pro page a core build shows in its place (components/ProPaywall.tsx). */
export const PRO_SECTIONS: Partial<Record<View, { title: string; body: string; collected?: string }>> = {
  plan: {
    title: 'Plan',
    body: 'Your AI agent runs a growth plan for the site. You see the goals and how far along they are, what the agent is doing, what waits on you, and what each change led to.',
  },
  people: {
    title: 'People',
    body: 'Everyone you know by name, email or payment, with one story from their first visit to what they paid. Watch a visit like a video and see where someone got stuck.',
    collected: 'Core already stores who signed in and who paid, so the list shows your history the day you switch.',
  },
  recordings: {
    title: 'Recordings',
    body: 'Watch visits to your website like a video. A list of what to fix comes first: buttons people click that do nothing, errors, forms they leave. Your AI agent reads the same list.',
  },
  errors: {
    title: 'Errors',
    body: 'JavaScript errors on your site, grouped into issues. Each issue lists the people and paying customers it hit and links to a recording of the moment. A new error on your checkout can send you an alert.',
  },
  experiments: {
    title: 'Experiments',
    body: 'Show two versions of a page and see which one brings more revenue per visitor, with the goal you pick judged beside it. Experiments from your iOS app sit in the same list.',
    collected: 'Core already stores the experiments your iOS app sends, so the list shows them the day you switch.',
  },
  content: {
    title: 'Content',
    body: 'Every page with its visitors, Google clicks and position, the revenue it brought, and the pages losing traffic.',
  },
  dropoff: {
    title: 'Drop-off',
    body: 'Where sessions stop before they buy, on the website and in the app: every session, the paywall, checkout, bought.',
    collected: 'Core already stores the goals this view reads.',
  },
  app: {
    title: 'App analytics',
    body: 'Sessions, screens, the onboarding funnel with drop-off per step, paywall conversion, and day-1 and day-7 retention for your iOS app.',
    collected: 'Core already stores the events FounderDataKit sends, so the reports show your history the day you switch.',
  },
  seo: {
    title: 'SEO',
    body: 'Search Console queries and pages, Google rank tracking, decay, opportunities, cannibalization and a page audit.',
  },
  ai: {
    title: 'AI visibility',
    body: 'Ask ChatGPT, Claude, Gemini and Perplexity your prompts every day and see the mention rate, share of voice and the pages they cite.',
  },
  aso: {
    title: 'ASO',
    body: 'App Store rank per keyword and country, the 10 apps above you, difficulty, search popularity, ratings and new reviews.',
  },
  paid: {
    title: 'Paid overview',
    body: 'Spend from every ad channel against every new customer: MER, blended CAC, ROAS per channel and the days until spend paid back.',
  },
  ads: {
    title: 'Meta ads',
    body: "Each campaign, ad set and ad with Meta's spend next to the customers and revenue FounderData credits to it, plus the Conversions API.",
  },
  asa: {
    title: 'Apple Search Ads',
    body: 'Spend, installs, trials, paid conversions and ROAS per campaign and keyword, next to your App Store revenue.',
  },
  subscriptions: {
    title: 'Subscriptions',
    body: 'MRR and its movement, trials, churn, LTV and a retention grid per signup month, split by source, plan and provider.',
    collected: 'Core already stores the subscriptions your payment providers send, so the reports show your history the day you switch.',
  },
  appstore: {
    title: 'App Store',
    body: 'Daily App Store sales and proceeds per product and country, imported from App Store Connect.',
  },
};

/** The Connected apps page (/apps), the Pro card's text for it. */
export const PRO_APPS_PAGE = {
  title: 'Connected apps',
  body: 'Every iOS app on one page: sessions, onboarding completion, paywall conversion, purchases and revenue, side by side.',
  collected: 'Core already stores the events FounderDataKit sends, so the page shows your history the day you switch.',
};

/**
 * The feature cards around the price on the Pro page (components/ProPaywall.tsx): group, name and one line, each true
 * to the README's Pro section. Two columns, one per side, each long enough that no card shows twice at once.
 */
export const PRO_CARDS: [group: string, name: string, line: string][][] = [
  [
    ['Revenue', 'Subscriptions', 'MRR and its movement, trials, churn and LTV, split by source, plan and provider.'],
    ['Revenue', 'Retention grid', 'One row per signup month. Switch between customers kept and revenue kept.'],
    ['Revenue', 'History import', 'Import from ChartMogul or RevenueCat, so MRR starts at your first customer.'],
    ['Apps', 'App analytics', 'Sessions, screens, the onboarding funnel, paywall conversion, day-1 and day-7 retention.'],
    ['Apps', 'App Store sales', 'Daily sales and proceeds per product and country, from App Store Connect.'],
    ['Apps', 'Apple Search Ads', 'Spend, installs, trials, paid conversions and ROAS per campaign and keyword.'],
    ['Apps', 'ASO', 'Your rank per keyword and country, and the 10 apps above you.'],
    ['Phone', 'iPhone app', 'Widgets for your numbers and a push notification for every payment.'],
    ['Funnel', 'Drop-off', 'Where sessions stop before they buy, on the website and in the app.'],
    ['People', 'Recordings', 'Watch a visit like a video. Typing is always hidden.'],
    ['Email', 'Resend', 'Sent, delivered, bounced, opened and clicked emails per day and sender.'],
    ['Team', 'Teammates', 'Each person gets their own login, as owner or viewer.'],
  ],
  [
    ['Ads', 'Meta ads', 'Spend per campaign, ad set and ad, next to the customers and revenue it brought.'],
    ['Ads', 'Conversions API', 'Sends Meta each web purchase, so a campaign can optimize for buyers.'],
    ['Ads', 'Paid overview', 'All ad spend against new customers: MER, blended CAC, ROAS and days to payback.'],
    ['SEO', 'Search Console', 'Queries and pages, with the revenue each page brought.'],
    ['SEO', 'Rank tracking', 'Daily Google ranks for up to 200 keywords a site, on your own DataForSEO account.'],
    ['SEO', 'Page audit', 'Flags pages that are thin, orphaned, noindex or missing a meta description.'],
    ['AI', 'AI visibility', 'Your prompts asked in ChatGPT, Claude, Gemini and Perplexity every day, on your own API keys.'],
    ['Social', 'Which post paid', 'Ties visits and revenue from X to the post that most likely sent them.'],
    ['Agents', '39 MCP tools', 'Your AI agent reads the reports, and one query covers every site its key can see.'],
    ['Agents', 'Custom dashboards', 'Your agent builds a dashboard of live charts and tables over MCP.'],
    ['Agents', 'Alert rules', 'A threshold on any number, with a webhook that can wake your agent.'],
    ['Agents', 'Growth plan', 'Your agent keeps a plan per site: goals, tasks, and what each change led to.'],
    ['Home', 'Next actions', 'The top 6 actions across your sites, each with what it is worth in a month.'],
    ['Home', 'Change verdicts', 'Log a change and see whether it moved the number it was meant to move.'],
  ],
];

/** The Mail page (/mail), the Pro card's text for it. */
export const PRO_MAIL_PAGE = {
  title: 'Mail',
  body: 'Send and receive email on your own domains through Cloudflare. Apps keep the Resend SDK and change one base URL. Replies land in an inbox here, templates keep the HTML your apps send, and agents can read and answer mail over MCP.',
  collected: "Sending needs Cloudflare's Workers Paid plan, which includes 3,000 messages a month and charges $0.35 per 1,000 after that.",
};

/** The custom dashboards page (/dashboards), the Pro card's text for it. */
export const PRO_DASHBOARDS_PAGE = {
  title: 'Dashboards',
  body: 'Ask your agent for a dashboard and it builds one over MCP: numbers, line charts, bar charts and tables from any metric by any dimension, across your sites. Each widget runs when you open the page, so the numbers are always current.',
  collected: 'The widgets read the visits, payments and goals FounderData already stores, so they cover your whole history.',
};

/** Everything Pro adds, for the Pro card in Settings. */
export const PRO_LIST = [
  'MRR, churn, LTV and retention per source, for every subscription provider',
  'iOS app analytics, App Store sales, Apple Search Ads, ASO, and the iPhone app with widgets and a push for every payment',
  'Meta ads with the Conversions API, spend from every other channel, MER and CAC',
  'Search Console, Google rank tracking and a page audit',
  'AI visibility in ChatGPT, Claude, Gemini and Perplexity',
  'People with one story each, from first visit to payment, and recordings of their visits',
  'Home across all your sites with next actions, and a verdict on every change you log',
  'A growth plan per site that your AI agent runs, with goals, tasks and the result of each change',
  'Mail on your own domains through Cloudflare, with an inbox, templates and an API that answers like Resend\'s',
  'All 39 MCP tools, the query tool, custom dashboards, alert rules and agent skills',
  'Teammates with their own login',
];
