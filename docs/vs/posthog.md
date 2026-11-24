# FounderData vs PostHog

PostHog is a product analytics suite with a hosted Cloud and a big free tier. It covers events, session replay,
feature flags, experiments, surveys, error tracking, heatmaps, a data warehouse, and more. One SDK
covers all of it, and its flags and experiments reach your backend and mobile apps too.

FounderData is smaller on purpose. It runs on your own Cloudflare account, ties every visit to the payments that came
after it, and lets your agent read the numbers over MCP. FounderData Pro adds the parts of PostHog a founder of a small
site uses most: experiments and flags on the website, recordings, click maps, error issues, paths, web retention and
two fixed surveys. Most of them show who paid next to what people did. Where PostHog goes further, the table
says so. In those places, keep PostHog.

Checked in November 2026. PostHog's pricing page and its docs on feature flags, experiments, session replay, heatmaps,
surveys, error tracking, revenue analytics, user paths, retention, self-hosting and its MCP server were read on 22
November 2026. They may have changed.

## Side by side

| | PostHog | FounderData | Keep PostHog for |
| --- | --- | --- | --- |
| Experiments | Built on feature flags. Bayesian or frequentist statistics. Metrics from events as funnels, means or ratios, and revenue from a synced warehouse table. No-code web experiments, which its docs say suit simple text changes better than single-page apps | Pro, web and iOS. The Worker picks a web visitor's version at the page view. Each version is judged on revenue per visitor and on a goal, with a split check, the uplift and its 95% range. The result leaves out renewals and app store purchases, and a person who paid before the test counts as a visitor with no revenue. iOS tests come from the session property FounderDataKit sets and count installs. An API key reads results, and only the dashboard creates, starts or stops a test | Tests in your backend, server-rendered code or Android app, and tests without code |
| Feature flags | Targets people by properties, cohorts and groups, with a percentage rollout. Server SDKs can evaluate flags locally, and flags can be bootstrapped. 1 million flag requests a month free | Pro. A flag is an experiment with the versions `off` and `on` and a rollout. The browser gets the version in the page view's answer. No targeting by user, plan or property, and no flag call from a server or an app. Without cookies or Remember visitors a visitor gets a new id at 00:00 UTC, so a flag can switch for the same person the next day. Stopping with a winner keeps serving the winner | Flags for your backend or mobile app, and targeting by user or plan |
| Surveys | A builder with question types such as NPS and open text, branching on earlier answers, and targeting by URL, events, properties, cohorts and flags. 1,500 responses a month free | Pro. Two fixed questions: how people heard of you, and why they cancel. You can change the wording and the labels. Cancel reasons also arrive from Stripe, Polar, the App Store and Google Play, and the store ones are categories, never the customer's words. No builder, NPS or targeting | Any survey besides those two |
| Session replay | Web, iOS, Android, React Native and Flutter, with console logs and network requests. 5,000 recordings a month free | Pro, web only. Recording can wait for consent. Every visit gets a summary built from facts, and the list filters by error issue, experiment version, channel, paying customer and funnel step. No console or network capture | Mobile replay, and console and network logs |
| Heatmaps | Click maps, rage clicks and scroll maps in the toolbar on your site (the toolbar view needs a pay-as-you-go plan), or in PostHog over a screenshot of the page | Pro. A click map drawn on your live https page through a link from the dashboard, and scroll depth per page over 28 days. In November 2026 a test watched it draw on an https page with a strict content security policy, in a browser that had turned off its own visits. Your page needs the FounderData host in `script-src` and `connect-src`. No screenshots inside the dashboard, and no map on a local or plain http copy | Heatmaps of a page you cannot serve on https at your own domain |
| Error tracking | Web, backend and mobile SDKs. Source map upload, releases and commits per exception, alerts when an issue is created or reopened, and spike alerts. 100,000 exceptions a month free | Pro, browser only. Uncaught errors and unhandled promise rejections, grouped into issues, with the paying customers each one hit. A new-error alert and a back-again alert, checked once an hour, at most 5 alerts a run per rule. No source maps, caught errors, releases, breadcrumbs or server errors | Server and mobile errors, readable stack traces from source maps, and releases |
| Paths, retention and lifecycle | User paths as a flow chart. Retention of any start event and return event, and lifecycle | Pro. Paths of up to 3 pages, as a table with how many visits left and how many paid later. Web retention and lifecycle of the people your site recognizes. No retention by goal and no flow chart | Paths of more steps, flow charts, and retention by event |
| Product analytics depth | Events with autocapture, SQL, a data warehouse with outside sources, group analytics, data pipelines to other tools, LLM observability | A fixed set of reports, a `query` tool for agents and CSV exports. No SQL editor, data warehouse, group analytics, data pipelines or LLM observability | Anything you would ask in SQL or a warehouse |
| Revenue | Revenue analytics is in beta. It reads Stripe through the data warehouse. Chargebee, Polar and RevenueCat are listed as coming soon | Payment webhooks from Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, the App Store and RevenueCat, credited to the buyer's last visit from a real source. MRR, churn and cancel reasons in Pro, and MRR per visitor on each experiment version | |
| Agents | An official hosted MCP server that reads and writes across its products, SQL included | MCP with scoped keys: 9 tools in core, 39 and twelve workflows in Pro. A key without `read:revenue` sees no money and does not learn who paid, in experiments, errors, recordings, people and paths | Agents that create flags and experiments |
| Hosting and cost | Cloud, free up to the allowances above, then pay as you go. The free plan has 1 project and keeps data 1 year. Self-hosting is a Docker deploy under MIT that PostHog does not support, with paid features on Cloud only | Your own Cloudflare account. Core is free under MIT. FounderData Pro is €99.99 or $99.99 once. The free Cloudflare plan covers about 3,100 web visits a day, and Pro's reports read rows from its 5 million a day: a 30-day Paths view at 3,000 visits a day reads up to about 825,000. See [What it costs](../../README.md#what-it-costs) | |
| Import | Not compared | No PostHog import. Only a Plausible-format export or a DataFast read comes in ([IMPORT.md](../IMPORT.md)) | |

## What FounderData does not do

- **No hosted version.** You deploy it to your own Cloudflare account.
- **No flags or experiments outside the browser.** Your server and your iOS app cannot ask for a flag.
- **No survey builder.** Only the two fixed questions.
- **No replay or heatmaps for apps.** Recordings and click maps are web only.
- **No source maps.** Stack frames point at the minified file, and a minified function name does not split an issue.
- **No SQL, warehouse or data pipelines.**
- **No PostHog import.** History starts the day the tracker goes in.

## Moving over

1. Deploy FounderData and add your site. See [Deploy a fresh copy](../../AGENTS.md#deploy-a-fresh-copy).
2. Add the tracker next to PostHog's snippet. The two can run side by side while you compare numbers.
3. Connect your payment provider, so revenue starts to arrive by webhook.
4. In FounderData Pro, turn on what you use in Settings: Record visits, Catch JavaScript errors, Click maps and the
   surveys. Each one is off by default.
5. Move web experiments one at a time. Stop the PostHog test, start the same one in Experiments, and paste its Copy AI
   prompt into your coding agent.
6. Keep PostHog for the rows above that say so.

## Links

- [Experiments](../GUIDE.md#experiments-pro), [Surveys](../GUIDE.md#surveys), [Errors](../GUIDE.md#errors-pro),
  [Paths](../GUIDE.md#paths) and [Retention and lifecycle](../GUIDE.md#retention-and-lifecycle) in the guide
- [Click maps and scroll depth](../GUIDE.md#click-maps-heatmaps-and-scroll-depth-pro)
- [MCP](../MCP.md) and [Who paid](../API.md#who-paid)
- [Privacy](../PRIVACY.md)
- PostHog: [pricing](https://posthog.com/pricing), [feature flags](https://posthog.com/docs/feature-flags),
  [experiments](https://posthog.com/docs/experiments), [session replay](https://posthog.com/docs/session-replay),
  [heatmaps](https://posthog.com/docs/toolbar/heatmaps), [error tracking](https://posthog.com/docs/error-tracking),
  [revenue analytics](https://posthog.com/docs/revenue-analytics/payment-platforms),
  [self-hosting](https://posthog.com/docs/self-host)
