# FounderData vs Umami

Umami is open-source web analytics under the MIT license. You can run it yourself on a Node.js server with PostgreSQL, or
use Umami Cloud, which has a free plan. It counts visits without cookies and has reports for goals, funnels, retention,
UTM campaigns, revenue and attribution. Since version 3.1 it also has session replay, heatmaps and Web Vitals.

We make FounderData, so read this page with that in mind. FounderData runs on your own Cloudflare account, ties every
visit to the payments that came after it, and lets your AI agent read the numbers over MCP. It is built for people who
sell something. If you want a hosted dashboard with a free plan, or a server of your own with PostgreSQL, Umami fits and
FounderData does not.

Checked on 27 November 2026, from Umami's pricing page, its documentation and its GitHub repository (see
[Sources](#sources)). They may have changed, so check them before you decide. For a shorter note on Umami next to Fathom
and PostHog, see [FounderData vs Plausible](plausible.md#a-note-on-fathom-umami-and-posthog).

## Side by side

| | Umami | FounderData | Keep Umami for |
| --- | --- | --- | --- |
| Hosting | Umami Cloud, or self-hosted on a server with Node.js 20.19 or newer and PostgreSQL 12.14 or newer. Install from source, with Docker Compose (the file includes PostgreSQL), from a prebuilt image, or with a third-party Helm chart | Your own Cloudflare account: a Worker and a D1 database. No hosted version, no Docker image and no PostgreSQL option. `npm run setup` takes Node.js 20 and a free Cloudflare account | A hosted version, and a server and database you already run |
| Price | Cloud Hobby is free: 100K events a month, 1 website, 6 months of data. Pro is $20 a month: 1M events, up to 20 websites, up to 10 team members, 14-day trial. Business is $200 a month: 10M events, unlimited websites. Enterprise is custom. Past the included events Pro costs $0.00003 and Business $0.00002 an event. Billed monthly. Self-hosting costs your server and database | Core is free under MIT. FounderData Pro is €99.99 or $99.99 once. The free Cloudflare plan covers about 3,100 web visits a day. See [What it costs](../../README.md#what-it-costs) | A free hosted plan for one small site |
| What counts as an event | Pageviews, plus every custom event and every custom event property stored | Nothing is metered by FounderData. Cloudflare's limits apply | |
| Cookies and visitor id | The tracker uses no cookies. The visitor id hashes the website id, IP address, user agent and a salt that rotates monthly by default. The IP is used in the hash and not stored in the session record | No cookies by default. The visitor id is a hash with a daily-rotating salt, and the IP is never stored. Cookies only when your site turns them on after consent | |
| How long data stays | Cloud: 6 months on Hobby, 2 years on Pro, 5 years on Business. Self-hosted: kept until you delete it | You set it. Visits and events go after 24 months by default (`RETENTION_MONTHS`). A payment keeps its source after old visits are deleted | |
| Revenue and attribution | A Revenue report adds up the `revenue` and `currency` values that your page sends with an event. Its docs name no payment provider. An Attribution report credits a conversion step, which is a page view or an event, to the first or last click | Payment webhooks from Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, the App Store and RevenueCat, credited to the buyer's last visit from a real source. Source panels can credit the first visit instead. Renewals and refunds count. MRR, churn and cohorts are in Pro | |
| Goals and funnels | Goals on a page or an event, with the conversion rate. Funnels of 2 or more steps with a window in minutes. Also retention, journeys, UTM, breakdown and compare reports | Goals and funnels in core. Pro adds web retention and lifecycle, and Paths of up to 3 pages | |
| Session replay and heatmaps | Replay since v3.1.0 and heatmaps since v3.2.0. Replay uses a separate recorder script, hides form inputs by default, samples 15% of sessions by default and keeps recordings 30 days. Heatmaps show clicks and scroll depth over a live preview of the page. On Cloud both are on Business and Enterprise. Business includes 5,000 replays, then $0.005 each. The docs do not say whether a self-hosted install needs a plan | Pro, web only. Recordings go to an R2 bucket in your account, every input is masked, and recording can wait for cookie consent. Click maps and scroll depth are drawn over your real https page. Each visit can be filtered by paying customer, error issue or funnel step | Replay and heatmaps on a hosted plan, with your data in Umami's cloud |
| Page speed | A Performance report with LCP, INP, CLS, FCP and TTFB at p50, p75 and p95, turned on with `data-performance="true"` on the script | Core Web Vitals from real visitors in core: the 75th percentile of the same five metrics with Google's rating, overall, per device and per page | Percentiles other than the 75th |
| Tracker size | `script.js` from Umami Cloud was 9,490 bytes and 4,226 bytes gzipped on 27 November 2026. Its docs state no size | `script.js` is 15,554 bytes, 6,670 gzipped | The smaller script |
| Agents | A read-only MCP server with 23 tools, at `/mcp` on Cloud (Pro and above) or on your own instance (version 3.4.0 or later, off until `MCP_ENABLED=1`). It takes an API key as a bearer token. Replays, heatmaps and boards are not available through MCP. An API covers what the app does | An MCP server at `/mcp` on your own Worker, with scoped keys: 10 tools in core, 40 with Pro. A key without `read:revenue` sees no money. A key with `notes:write` can log a change, and FounderData compares the days after the change with the days before and answers better, worse or inconclusive. See [MCP](../MCP.md) | |
| Teams | Cloud Pro allows up to 10 team members, Business unlimited. Teams and boards are in the docs | One admin password and one shared viewer password in core. Pro adds teammates with their own login, each an owner or a viewer for every site | Teams and shared boards without setup |
| Apps | The docs list a website tracker and an API. They have no app SDK section | A Swift SDK for iOS 17 and later, with StoreKit 2 and RevenueCat purchases. No Android | |
| Import | Data import is listed on Cloud Pro and above. Data export is on every plan | No Umami import. See Moving over | |

## What FounderData does not do

- **No hosted version.** There is no signup page. You deploy it to your own Cloudflare account, and that needs a
  terminal.
- **No PostgreSQL or Docker.** FounderData runs on Cloudflare Workers and D1 only.
- **No Umami import.** Only a Plausible-format export or a DataFast read comes in ([IMPORT.md](../IMPORT.md)). Your
  Umami history stays in Umami.
- **No free hosted plan.** The free part is core, which you run yourself.
- **Logins for a team are in Pro.** Core has one admin password and one viewer password.
- **A larger tracker.** 6,670 bytes gzipped against Umami's 4,226.
- **No Android SDK.** Apps are iOS only, and recordings and click maps are web only.

## Moving over

1. Deploy FounderData and add your site. See [Deploy a fresh copy](../../AGENTS.md#deploy-a-fresh-copy).
2. Add the tracker next to Umami's script. The two can run side by side while you compare numbers.
3. Connect your payment provider, so revenue starts to arrive by webhook. Use
   [Import Stripe history](../GUIDE.md#import-stripe-history) for past payments.
4. Keep Umami running until FounderData has the weeks of history you need. Export what you want to keep from Umami,
   because FounderData cannot read it.
5. Remove Umami's script when you are done, and turn on in Settings what you use from Pro.

## Links

- [Revenue attribution with Stripe](../GUIDE.md#revenue-attribution-with-stripe) and [Page speed](../GUIDE.md#page-speed)
  in the guide
- [Recordings](../GUIDE.md#people-and-recordings-pro) and
  [Click maps and scroll depth](../GUIDE.md#click-maps-heatmaps-and-scroll-depth-pro)
- [MCP](../MCP.md) and [Privacy](../PRIVACY.md)

## Sources

Umami's pages, read on 27 November 2026:

- [Cloud pricing](https://umami.is/pricing): plans, prices, events included, retention, overage, what counts as an event, features by plan
- [Introduction](https://docs.umami.is/docs/): reports, cookies, boards, teams, API and MCP
- [Install](https://docs.umami.is/docs/install): Node.js and PostgreSQL versions, install methods
- [FAQ](https://docs.umami.is/docs/faq): cookies, retention on self-hosted installs
- [Metric definitions](https://docs.umami.is/docs/metric-definitions): how a visitor is identified and the salt
- [Revenue](https://docs.umami.is/docs/revenue) and [Attribution](https://docs.umami.is/docs/attribution)
- [Goals](https://docs.umami.is/docs/goals) and [Funnel](https://docs.umami.is/docs/funnel)
- [Session replay](https://docs.umami.is/docs/replays) and [Heatmaps](https://docs.umami.is/docs/heatmaps)
- [Performance](https://docs.umami.is/docs/performance)
- [MCP](https://docs.umami.is/docs/mcp) and [API](https://docs.umami.is/docs/api)
- [Umami Cloud](https://docs.umami.is/docs/cloud): which plans have replays, heatmaps, API and MCP
- [Umami on GitHub](https://github.com/umami-software/umami): MIT license
- [Umami Cloud's tracker script](https://cloud.umami.is/script.js): size measured with `curl`
