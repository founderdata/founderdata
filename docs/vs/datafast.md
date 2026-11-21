# FounderData vs DataFast

DataFast is a hosted analytics tool for founders, closed source, built around revenue per source. It is good at
getting you to a first useful number fast. A one-minute script install, Stripe and other payment providers connected from
a settings page, a live visitor globe, tweets pinned on the chart and a ChatGPT app are the parts its users praise.

FounderData is the self-hosted alternative. Core is free under MIT. It covers the same revenue-per-source question and
adds iOS apps. FounderData Pro, €29.99 or $29.99 once, adds SEO, App Store ranks and AI visibility. In return you deploy and maintain it
yourself.

Checked in November 2026. DataFast prices come from the tier table in its own pricing page code, read on 3 November, and
its features from its docs and changelog, read on 6 November. They may have changed.

## Side by side

| | DataFast | FounderData |
| --- | --- | --- |
| Hosting and license | Hosted only, closed source | Your own Cloudflare account, MIT |
| Price | Starter $9 a month for 10,000 events, $19 for 100,000, $29 for 200,000, $49 for 500,000, $69 for 1 million. Growth $19, $39, $59, $99 and $139 at the same volumes. Yearly is 10 times monthly. 14-day trial, no free tier | Core is free. Pro is €29.99 or $29.99 once. The Cloudflare free plan covers about 3,100 web visits a day. Workers Paid is $5 a month |
| Sites and seats | Starter 1 site and 1 member. Growth 30 sites and 30 members | Sites share one deployment and one daily write budget. Core has one admin password and one shared viewer password. Pro adds teammates as owner or viewer for every site, with no single sign-on and no per-site permissions |
| History kept | Starter 3 years, Growth 5 years or more | 24 months of visits by default, set with `RETENTION_MONTHS` |
| Over the limit | Tracking continues and the dashboard locks until you upgrade | Past a daily write cap, website events are dropped until 00:00 UTC. You set the cap per site |
| Cookies | Cookies by default. A cookieless script loses journeys and new-versus-returning | No cookies by default. The visitor id is a daily-rotating hash, and no IP address is stored |
| Payments | Stripe, Lemon Squeezy, Polar, Paddle, Shopify and WooCommerce from a settings page. Stripe Checkout needs no webhook | Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, App Store, RevenueCat and any source through `POST /api/v1/payments`. Each needs a webhook and the visitor id in checkout metadata |
| Revenue attribution | Revenue on every breakdown card | A payment goes to the buyer's last visit from a real source. Renewals, refunds, failed payments and MRR split by source, for Stripe and the App Store together |
| Which tweet paid | Resolves `t.co` to the tweet, Growth plan | In Pro, reads your own posts with your X token and credits the closest earlier post that links to the landing page within 48 hours. Each post row splits visits, customers and revenue into exact and probable, and nearly every match is probable. X charges $0.005 for each post read |
| Live view | A 3D globe with visitor detail, replay and a public second-screen mode | A globe of who is online now, with the last 30 minutes, hour or 24 hours, their payments and a visitor list |
| Search Console | One-click Google sign-in, revenue estimated per keyword | In Pro, sign in with your own Google Cloud client. 16 months of queries, with the top 40 queries and 40 pages by clicks and by impressions kept per day. Revenue is per page, not per keyword |
| Ad spend | Meta Ads spend and ROAS | In Pro, Meta ads and Apple Search Ads spend and ROAS, and spend from other channels |
| iOS and Android | React Native and Expo SDK, a mobile app the docs call an MVP | Swift SDK with StoreKit 2 and RevenueCat. Pro adds onboarding and paywall funnels, App Store sales, ASO, and an iPhone app you build with your own Apple team. No Android |
| AI visibility | An add-on at $99 a month for 50 prompts on ChatGPT only, or $399 for 100 prompts on three engines. It was not on a public page, and we could not confirm it is live | In Pro, OpenAI, Anthropic and Gemini on your own keys, plus Google AI Overviews and Perplexity through DataForSEO. About $45 a month in API bills for 50 prompts on three engines |
| AI crawler traffic | Server package with IP verification, 100,000 requests a cycle included | In Pro, your server forwards bot hits to an endpoint. Counts per bot and page. No IP is received |
| Agents | Remote MCP with OAuth and about 60 tools, a CLI, a ChatGPT app | MCP with a pasted `fdk_` key and chart notes that agents review with a before and after verdict. 9 tools in core. Pro has 39, twelve workflows served as MCP prompts and a research log |
| Data out | No export file in its terms, a REST API at 60 calls a minute | CSV export of every panel, visit, event, payment and subscription, a read API, a share link |
| Install | Plugins and guides for WordPress, Shopify, GTM, Webflow, Framer, Wix, Squarespace and Bubble | One script tag, and a Copy AI prompt button that has your coding agent do the install |

## What FounderData does not do

- **No one-click payment connection.** Each provider needs a webhook, and the checkout must pass the visitor id. DataFast's
  Stripe Checkout path needs no webhook.
- **No plugins for site builders and stores.** There is no WordPress, Shopify, Webflow or WooCommerce package.
- **Which tweet paid is a best guess.** X sends no post code, so exact matches are rare. The first read goes back 7 days,
  and up to 300 posts are read per run. Older tweets get no post-level credit. Test ten of your own tweets against
  Stripe before you cancel DataFast.
- **No Reddit mentions, no GitHub commits on the chart, no visitor avatars, no purchase-likelihood score.** Agents and you
  can add notes to the chart by hand or through MCP.
- **No React Native SDK.** Meta ads ROAS needs Pro.
- **No hosted version.** Cloudflare Workers and D1 only, no Docker image, no Postgres.
- **Setup is a terminal job.** `npm run setup` deploys, but X, Google and DataForSEO each need a secret. Settings, Setup
  checklist tests the DataForSEO login and the X token live and says which row is broken.
- **A large MCP tool set in Pro.** 39 tools, and no OAuth sign-in for ChatGPT or claude.ai connectors.
- **No iPhone app from the App Store.** You build it yourself.

## Moving over

1. **Deploy.** `npm run setup`, then add your site and the script tag. See the [README](../../README.md#install).
2. **Bring your history.** In Settings, Import history, choose **Import from DataFast**, paste a `df_` site key or a `dft_`
   token with `analytics:read`, and pick weekly or daily breakdowns. Daily over 14 months is about 50 minutes, weekly
   about 7. See [Import from DataFast](../IMPORT.md#import-from-datafast). Limits to know before you start:
   - Visitors are summed per bucket, so a person who came on 3 days counts 3 times.
   - There are no bounce rate, visit duration, entry pages or goals for imported days.
   - Imported revenue is shown labelled and never joins your native revenue, customers or conversion. A checkbox on the
     chart draws both as one line with a marked seam.
3. **Bring your payments.** Connect Stripe and use **Import past payments** with a read-only key for 3 to 36 months. See
   [Import Stripe history](../GUIDE.md#import-stripe-history).
4. **Connect Search Console.** See [Connect Google](../SEO.md#connect-google). It needs your own Google Cloud project.
5. **Run both for a month on one site** before you cancel, and compare revenue per source against your Stripe totals.
