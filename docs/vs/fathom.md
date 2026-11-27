# FounderData vs Fathom

Fathom is hosted web analytics with every feature on every plan. It counts visits without cookies and processes EU
visitors on EU servers. It costs from $15 a month for 100,000 pageviews, with no free plan. Goals are called events and
can carry a value. It imports GA4 history, links Search Console and has an AI assistant in the dashboard.

We make FounderData, so read this page with that in mind. FounderData runs on your own Cloudflare account, ties every
visit to the payments that came after it, and lets your AI agent read the numbers over MCP. It is built for people who
sell something. If you want a hosted dashboard with nothing to deploy, EU processing for EU visitors, or unlimited team
members on the first plan, Fathom fits and FounderData does not.

Checked on 28 November 2026, from Fathom's pricing and features pages, its help center, its changelog and its Fathom Lite
repository on GitHub (see [Sources](#sources)). They may have changed, so check them before you decide. For a shorter
note on Fathom next to Umami and PostHog, see
[FounderData vs Plausible](plausible.md#a-note-on-fathom-umami-and-posthog).

## Side by side

| | Fathom | FounderData | Keep Fathom for |
| --- | --- | --- | --- |
| Hosting | Hosted only. Its features page says there is no local hosting option. Fathom Lite, an older open-source version under MIT, is on GitHub, and its README says it gets bug fixes and no new features | Your own Cloudflare account: a Worker and a D1 database. No hosted version. `npm run setup` takes Node.js 20 and a free Cloudflare account | A service with nothing to deploy |
| Price | No free plan. A 7-day trial needs a card. Every plan has every feature, at least 50 sites and unlimited team members. Per month, in USD, by pageviews: $15 up to 100,000, $25 up to 200,000, $45 up to 500,000, $60 up to 1 million, $100 up to 2 million, $140 up to 5 million, $200 up to 10 million, $290 up to 15 million, $380 up to 20 million, $470 up to 25 million, custom above that. Yearly plans cost 10 times the monthly price. 50 more sites cost $10 a month or $100 a year | Core is free under MIT. FounderData Pro is €99.99 or $99.99 once. The free Cloudflare plan covers about 3,100 web visits a day. See [What it costs](../../README.md#what-it-costs) | |
| What counts toward the limit | Pageviews and custom events share one allowance across all sites. Each API request counts like a pageview | Nothing is metered by FounderData. Cloudflare's limits apply | |
| Where the data lives | EU visitors, and visitors from Iceland, Liechtenstein, Norway, Switzerland and the UK, are processed in the EU, on by default. The servers are in Falkenstein, Helsinki and Nuremberg. Other visitors are processed in the US. A second script URL, `cdn-eu.usefathom.com`, routes all traffic through the EU | A D1 database in your own account. Created with `--region eu`, it is stored in the EU. The Worker handles each request in the Cloudflare data center nearest the visitor, so the data is stored in the EU and not processed only there. See [Privacy](../PRIVACY.md) | A promise that EU visitors are processed in the EU |
| Cookies and visitor id | Its analytics use no cookies. A visitor signature is a SHA-256 hash of request information, the site's identity and a salt that rotates at midnight UTC. Its docs do not say whether the IP address or user agent goes into the hash, or whether the IP is stored | No cookies by default. The visitor id is a hash with a daily-rotating salt, and the IP is never stored. Cookies only when your site turns them on after consent | |
| How long data stays | Pricing lists unlimited data retention on every plan. Removing visits hides them and does not delete them | You set it. Visits and events go after 24 months by default (`RETENTION_MONTHS`). A payment keeps its source after old visits are deleted | |
| Revenue and attribution | An event can carry a value. Your code sends `_value` in cents, and you set the currency in the dashboard, per event or as a site default. Its docs name no payment provider, and their one example reads prices from Shopify templates. A UTM campaign filters the dashboard to that campaign's pages and events. The e-commerce docs do not say how a sale is credited to a source | Payment webhooks from Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, the App Store and RevenueCat, credited to the buyer's last visit from a real source. Source panels can credit the first visit instead. Renewals and refunds count. MRR, churn and cohorts are in Pro | |
| Goals and funnels | Goals are events, created in code with `fathom.trackEvent('name')`. The only option is `_value`. The conversion rate is completions divided by pageviews, or by visitors if you switch it. The events docs describe no funnel | Goals and funnels in core. Pro adds web retention and lifecycle, and Paths of up to 3 pages | |
| Session replay and heatmaps | Its features page lists neither | Pro, web only. Recordings go to an R2 bucket in your account, every input is masked, and recording can wait for cookie consent. Click maps and scroll depth are drawn over your real https page | |
| Page speed | Its features page lists no page speed report | Core Web Vitals from real visitors in core: the 75th percentile of LCP, INP, CLS, FCP and TTFB with Google's rating, overall, per device and per page | |
| Tracker size | `script.js` from Fathom's CDN was 6,981 bytes and 2,086 bytes gzipped on 28 November 2026. Its docs state no size | `script.js` is 15,554 bytes, 6,670 gzipped | The smaller script |
| Search Console | On every plan, shows search terms, clicks, impressions and positions next to your analytics | In Pro, with 16 months of queries next to visits and revenue per page | Search Console without a license |
| Visits from AI tools | An AI tab beside Sources groups visitors by ChatGPT, Perplexity, Claude, Gemini, Microsoft Copilot, DeepSeek, Grok, Meta AI, You.com and Poe, from referrers and `utm_source` tags. A visit with neither shows as Direct | A Channel AI and AI assistants under Referrer. Pro's Content tab lists ChatGPT, Claude, Perplexity, Gemini and Copilot with visitors, customers and revenue | |
| Agents | An API at `api.usefathom.com/v1` to manage sites, events and milestones and to pull reports, with keys at four access levels. It is free, with paid plans of $19 to $399 a month for higher limits. Luna, a chat assistant in the dashboard, can read your stats after you click Allow. The API page and Luna's changelog entry name no MCP server | An MCP server at `/mcp` on your own Worker, with scoped keys: 10 tools in core, 40 with Pro. A key without `read:revenue` sees no money. A key with `notes:write` can log a change, and FounderData compares the days after the change with the days before and answers better, worse or inconclusive. See [MCP](../MCP.md) | An assistant in the dashboard that answers questions about Fathom itself |
| Teams | Unlimited team members on every plan, as admin, editor or viewer. Editors and viewers can be limited to chosen sites. Dashboards can be shared by a public or password-protected link. A team activity log covers 365 days | One admin password and one shared viewer password in core. Pro adds teammates with their own login, each an owner or a viewer for every site | Unlimited team members with no setup |
| Apps | The features page and the docs index list a website script, website platform integrations and an API, and no app SDK | A Swift SDK for iOS 17 and later, with StoreKit 2 and RevenueCat purchases. No Android | |
| Import | A GA4 importer on every plan. It brings daily data only, no events, and can take up to 48 hours. Universal Analytics data cannot be imported, because Google deleted it. CSV export of your data | No Fathom import. See Moving over | Bringing GA4 history into the dashboard |

## What FounderData does not do

- **No hosted version.** There is no signup page. You deploy it to your own Cloudflare account, and that needs a
  terminal.
- **No EU-only processing.** The database can be pinned to the EU. The Worker still runs near each visitor.
- **No Fathom import.** Only a Plausible-format export or a DataFast read comes in ([IMPORT.md](../IMPORT.md)). Your
  Fathom history stays in Fathom.
- **No GA4 import.** Fathom's importer reads GA4 daily data. FounderData has none for Google Analytics.
- **Logins for a team are in Pro.** Core has one admin password and one viewer password. Fathom allows unlimited
  members from the first plan.
- **Search Console is in Pro.**
- **A larger tracker.** 6,670 bytes gzipped against Fathom's 2,086.
- **No Android SDK.** Apps are iOS only, and recordings and click maps are web only.

## Moving over

1. Deploy FounderData and add your site. See [Deploy a fresh copy](../../AGENTS.md#deploy-a-fresh-copy).
2. Add the tracker next to Fathom's script. The two can run side by side while you compare numbers.
3. Connect your payment provider, so revenue starts to arrive by webhook. Use
   [Import Stripe history](../GUIDE.md#import-stripe-history) for past payments.
4. Keep Fathom running until FounderData has the weeks of history you need. Export what you want to keep from Fathom,
   because FounderData cannot read it.
5. Remove Fathom's script when you are done, and turn on in Settings what you use from Pro. In Pro, connect
   [Search Console](../SEO.md#connect-google).

## Links

- [Revenue attribution with Stripe](../GUIDE.md#revenue-attribution-with-stripe) and [Page speed](../GUIDE.md#page-speed)
  in the guide
- [MCP](../MCP.md) and [Privacy](../PRIVACY.md)

## Sources

Fathom's pages, read on 28 November 2026:

- [Pricing](https://usefathom.com/pricing): plans, prices, pageview tiers, trial, sites, retention, what counts toward the allowance
- [Features](https://usefathom.com/features): hosted only, cookies, EU isolation, events, teams, Search Console, GA4 importer, CSV exports
- [Help center index](https://usefathom.com/docs): where each topic lives
- [Cookies](https://usefathom.com/docs/troubleshooting/cookies) and [Salts and hashes](https://usefathom.com/docs/troubleshooting/hashes-salts): visitor signatures
- [EU isolation](https://usefathom.com/docs/script/eu-isolation): where visitors are processed
- [Data removals](https://usefathom.com/docs/features/data-removals): removed visits are hidden, not deleted
- [Events](https://usefathom.com/docs/events/overview) and [E-commerce conversions](https://usefathom.com/docs/events/ecommerce-conversions): event options, conversion rate, `_value`, currency
- [Google Analytics importer](https://usefathom.com/docs/features/ga-importer): GA4 only, daily data, no events
- [Install the script](https://usefathom.com/docs/script/embed): the script tag, with no size stated
- [API](https://usefathom.com/api) and [API feature article](https://usefathom.com/docs/features/api): endpoints, key levels, billing by pageview
- [Changelog](https://usefathom.com/changelog): [Luna, the AI assistant](https://usefathom.com/changelog/oct2026-luna) (6 October 2026), [the AI tab](https://usefathom.com/changelog/oct2026-ai-tab) (2 October 2026), [API plans](https://usefathom.com/changelog/jun2026-api-plans) (19 June 2026)
- [Fathom Lite on GitHub](https://github.com/usefathom/fathom): MIT license, no new features
- [Fathom's tracker script](https://cdn.usefathom.com/script.js): size measured with `curl`
