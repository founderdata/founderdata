# FounderData

Open-source analytics for your company. Host it yourself, and follow each visitor from the first visit to the
payment.

Most analytics tools stop at the pageview. FounderData also takes in your Stripe, App Store, Dodo Payments and RevenueCat
payments and ties each one to the visit that brought the buyer. You see which tweet, blog post, Google search or
ChatGPT answer made money. A single dashboard covers your websites and your iOS apps.

It runs on your own Cloudflare account as one Worker with a D1 database. At side-project traffic that fits in
Cloudflare's free plan.

This repository is FounderData core, free and MIT licensed. [FounderData Pro](#founderdata-pro) adds subscription
analytics, iOS app reports, ads, SEO, AI visibility and the full agent layer for a one-time payment.

Not for you if you need it on your own server: it runs on Cloudflare Workers and D1 only, with no Docker image or
Postgres option. Nor if you need single sign-on or per-site permissions. Core has one admin password and one shared
read-only viewer password, set as `VIEWER_PASSWORD`. Pro adds teammates with their own login, each an owner or a viewer
for every site.

![The FounderData dashboard with visitors, revenue, sources and paying customers](docs/dashboard.png)

## Quick start

You need Node.js 20 or later and a free Cloudflare account.

```bash
git clone https://github.com/founderdata/founderdata.git
cd founderdata
npm install
npm run setup
```

`npm run setup` signs you in to Cloudflare, creates the database, deploys the Worker and prints your dashboard URL.
Open it and log in with the password saved in `~/.config/founderdata/admin-password`. [Install](#install) has the
details.

You can also hand [AGENTS.md](AGENTS.md) to a coding agent such as Claude Code or Cursor. Its "Deploy a fresh copy"
section takes the agent through the same steps and says when to ask you.

Cloudflare's free plan covers about 3,100 web visits a day. [What it costs](#what-it-costs) has the numbers.

## What you get

- Visitors, revenue, conversion rate, revenue per visitor, bounce rate and session time, each against the previous
  period, plus who is online now.
- Where visitors come from: channel, referrer (X, Google, ChatGPT, Reddit...), UTM campaign and keyword, `?ref=` tags
  and the browser language. A click id from Google Ads, Microsoft, TikTok, X, LinkedIn, Reddit, Snapchat or Pinterest
  makes the visit Paid with the network as its source, so a Google Ads visit doesn't count as organic search
  ([guide](docs/GUIDE.md#ad-clicks-other-than-meta)). Source panels can also credit each visitor's first visit
  ([first touch](docs/GUIDE.md#first-touch)). Visits from cloud networks such as AWS or Hetzner are almost always bots,
  so visitor counts leave them out until you turn them on ([datacenter visits](docs/GUIDE.md#datacenter-visits)).
- Pages, entry pages, outbound links, button clicks, custom goals and funnels.
- "How did you hear about us?" as a tab of the Channel card. Send the answer your signup form already asks for with
  `founderdata('answer', 'heard_about', 'podcast')`, and Stripe and Polar cancel reasons arrive with their webhooks,
  the App Store's and Google Play's categories with RevenueCat's and Apple's ([Surveys](docs/GUIDE.md#surveys)).
- Revenue per source. A payment is credited to the buyer's last visit that came from a real source, so "clicked the
  launch tweet, came back directly two weeks later and paid" counts for the tweet. Without cookies that needs the
  signup to call `identify()`, which joins one person's daily visitor ids. Renewals stay with the source that won the
  customer, and a payment keeps its source after old visits are deleted.
- A journey for every customer, from the first visit through each page and click to the payment. Extra keys you pass
  to `identify()`, such as a plan or a company, are kept as traits on the visitor ([docs/API.md](docs/API.md#identify-and-traits)).
- A setup checklist in Settings, one row per integration with a live status and the next step: when the cron last ran,
  whether the old hourly cron is still listed, which optional secrets are set (by name), and when each site's payment
  webhook last delivered. Pro adds rows for Google, DataForSEO and X. See [the guide](docs/GUIDE.md#setup-checklist).
- A home page across all your sites, with totals, a card per site and a "worth a look" list of sites that went quiet
  or doubled.
- Page speed from your own visitors: LCP, INP, CLS, FCP and TTFB measured in their browsers, as the 75th percentile per
  page and device with Google's ratings. Small sites get numbers too, where Google's Chrome UX Report has none. Core
  collects and stores them and serves them through `GET /api/v1/vitals` and the `get_web_vitals` MCP tool. The Page
  speed card is in Pro's Content tab ([guide](docs/GUIDE.md#page-speed)).
- Alerts in Slack, Discord, Telegram, a webhook or email (Resend, or Cloudflare Email Routing with no other account):
  each payment and refund with its product, failed renewals and cancellations with the customer, quiet sites, a payment
  provider that stopped sending (small products too), a webhook refused for a bad signature, the write cap, and a
  Monday report with revenue, web and app visitors apart, top products and top sources per site. Notes on the chart for
  launches, deploys and new app versions.
- CSV export of every panel, visit, event, payment and subscription. A read-only share link (with MRR in Pro) and badge per site, and a read API key
  for Grafana or a spreadsheet. Erasing one person for a GDPR request takes one click, and an erase log records who
  handled it without keeping the person, and outlives the site. Colleagues can get a read-only viewer password.
- One API key per agent, with only the scopes it needs: read, read revenue, raw rows, write notes, change alerts, send
  payments, push SEO and push ASO, and write to the research log. A push script needs no admin password. A key can cover one site, several or all, expire on a date, and be revoked alone. Settings shows each
  key's last call, last write and calls in 24 hours. FounderData stores only a hash of the key. A copy agent's key
  can log changes and read visitors, and gets 403 on payments and no revenue fields ([docs/API.md](docs/API.md#api-keys)).
- An MCP server for Claude Code, Cursor and other agents, with 9 tools: `whoami`, `get_definitions`, `get_overview`,
  `get_breakdown`, `get_timeseries`, `get_customers`, `get_web_vitals`, `list_notes` and `add_note`
  ([docs/MCP.md](docs/MCP.md)).
- Agents can tell a real drop from a broken import. Each site answers when its web, app and payment data starts, the
  status of each integration with the last error, and the share of revenue a visit explains. Core reports the tracker,
  the SDK and payments. The other 9 integrations, Search Console among them, report data in Pro. A
  comparison with days before tracking started answers `null` with a reason, not a jump from 0
  ([docs/API.md](docs/API.md#sources-and-tracking-start)).
- A site without payments, such as a blog or docs, shows visitors, pages and goals with no empty revenue tiles.
- No cookies by default. The visitor id is a daily-rotating hash, and FounderData never stores a visitor's IP address.
  Cookies are one attribute away once a visitor consents. The dashboard loads site icons through your own Worker, not Google.
  [docs/PRIVACY.md](docs/PRIVACY.md) lists every stored field with its retention, the subprocessors, and how to keep
  the database in the EU. Settings > General shows where the database is stored, so you can screenshot it for a DPA
  file.

![A visitor profile: source, pages, the checkout click and the payment](docs/visitor.png)

## FounderData Pro

Pro is a lifetime license: €29.99 or $29.99 including VAT after launch, paid once, with every update and no fee per
site. During launch the price starts lower and rises in steps. The dashboard and the checkout show the current price
([buy it on Polar](https://buy.polar.sh/polar_cl_VXmKrwlw4IIWM6GhohnTzJZN5nMhtpjbcy7I63PRvbm)). It adds the reports below to your
own deployment, on your own Cloudflare account. Core already stores every page view, app event, payment and
subscription, so the Pro reports cover your history from the first day.

Open any Pro section in the dashboard to buy it or to get the install prompt for your AI agent. The agent installs
Pro with a `git merge`, so changes you made to your copy stay. [docs/PRO.md](docs/PRO.md) explains buying, installing and updates.

- Subscription metrics per source, Stripe and App Store in one table: MRR and its movement, trials and trial to paid,
  churn, LTV, refunds and failed payments, split by channel, referrer, campaign and product.
- A retention grid for subscriptions: one row per signup month, one column per month since, for Stripe, App Store and
  RevenueCat together. Switch between customers kept and revenue kept, split by plan, provider, channel or referrer,
  and click a cell to list its subscriptions.
- Subscription history from ChartMogul (its API key) or RevenueCat (a transactions export), so the MRR chart and the
  retention grid start at your first paying customer and not on the day you connect. A table compares each month-end
  with the source's own MRR and shows every gap. See [Import from ChartMogul](docs/GUIDE.md#import-from-chartmogul-pro) and
  [Import from RevenueCat](docs/GUIDE.md#import-from-revenuecat-pro).
- iOS apps next to the website: sessions, screens, the onboarding funnel with drop-off per step, paywall conversion,
  App Store purchases, Apple Search Ads campaigns and day-1 and day-7 retention.
- Apple Search Ads spend next to App Store revenue: with a read-only Apple Ads API user, each campaign and keyword
  shows its name, spend, installs, trials, paid conversions, cost per paid conversion and ROAS. See
  [Apple Search Ads](docs/GUIDE.md#apple-search-ads-pro).
- Meta ads (Facebook and Instagram) to the payment: with a read-only system user token, each campaign, ad set and ad
  shows Meta's spend, clicks and purchases next to the visits, customers and revenue FounderData credited to it, with CPA,
  ROAS, landing rate, hook rate, hold rate, 7-day frequency and a fatigue flag. One URL parameter (`ad_id={{ad.id}}`) ties
  a visit to its ad. The Conversions API, off by default, sends Meta each web purchase (hashed email and the ad's click id,
  no IP) so a campaign can optimize for buyers without a Meta pixel. Alert rules on spend, ROAS and cost per customer. See
  [Meta ads](docs/GUIDE.md#meta-ads-pro).
- Spend from every other ad channel: Google Ads through a script that runs in your Google Ads account, TikTok, Reddit,
  LinkedIn or a newsletter sponsor through a CSV export or the API. One paid report puts all spend against every new
  customer: MER, blended CAC, ROAS per channel after Apple's cut, and the days until the spend paid back. Each site's
  Paid overview shows it. See [Ad spend from other channels](docs/GUIDE.md#ad-spend-from-other-channels-pro).
- ASO for your iOS apps: the rank for each keyword and country, the 10 apps above you, a difficulty score, Apple's
  search popularity, ratings per country and new reviews, with an alert for a new review of 3 stars or fewer. It imports
  keywords from an Astro export or a plain list, up to 200 keywords and 10 countries. Apple refuses these requests from Cloudflare, so a small
  collector script fetches them from your own machine. It uses App Store endpoints Apple's terms don't allow automated
  access to, so you decide whether to run it. With a DataForSEO account, the Worker checks the keywords and countries
  instead, through DataForSEO's licensed API and with no machine of yours involved. The Free plan collects up to 1,728
  results a day, shared with Google rank tracking, so 720 pairs get a new rank every day. They cost an estimated $26 to $52 a
  month, and a soft monthly cap limits the spending. An import keeps the
  ranks in an Astro file, and a button lists the keywords an app already ranks for. See [ASO](docs/ASO.md#ranks-without-your-mac).
- Which post paid: give FounderData your own X API token and it reads your posts, then credits each visit from X, and the customers and revenue after it, to the closest earlier post that links to the landing page. No UTM tags. Matches are probable, not certain: landing page within 48 hours. X sends no post code, so exact matches are rare. X charges $0.005 for every post it reads, linked or not: about $0.15 for 30 posts a month, $1.50 for 300. You can also add posts by hand for free. See [the guide](docs/GUIDE.md#which-post-paid-pro).
- Google rank tracking on your own DataForSEO account: up to 200 keywords a site, checked daily, with a CSV import, with the best position, the change over 7 and 30 days, a trend line, whether an AI Overview cites you and Search Console clicks beside it. Each check also keeps the domains in the top 10 and the SERP features (featured snippet, People also ask, video), so agents see who holds the top 10 across your keywords and who moved in this week, at no extra cost ([docs/SEO.md](docs/SEO.md#serp-competitors)). Keyword research finds terms and the keywords a domain ranks for, each with a Track button, and a soft monthly cap limits the spending. 200 keywords cost an estimated $3.60 to $7.20 a month. With the AI Overview flag on, which adds $0.002 a check, they cost about $19.20, and the $10 default cap is reached around day 15. A cap of $25 covers it. See [SEO.md](docs/SEO.md#cost) for the prices and how far to trust them.
- An SEO tab per site for Search Console data, keywords and AI answers. Connect Google in the browser, with your own
  Google Cloud client, and the Worker pulls 16 months of queries on its cron ([docs/SEO.md](docs/SEO.md#connect-google)).
  Or run `scripts/gsc-sync.mjs`, which pushes 90 days from your machine without OAuth
  ([docs/SEO.md](docs/SEO.md#sync-search-console)). Decay and opportunities count every page and query Search Console
  reports over 28 days, not only each day's top 80. An opportunity drops out when the data proves it had no impressions
  in the last 7 days ([docs/SEO.md](docs/SEO.md#search-totals)). A Cannibalization view flags queries that two of your pages share.
  Push your crawler's output too, and a Page audit view flags pages that are thin, orphaned, noindex, not 200, lack a
  meta description or have a long title ([docs/SEO.md](docs/SEO.md#page-audit)).
- AI visibility: save prompts, your brand and your competitors, add your own OpenAI, Anthropic or Gemini key, and the
  cron asks each engine with web search on, a few checks every 5 minutes. A new prompt is asked 3 times on its first
  day. After that, a prompt whose answers stopped changing is asked weekly and the rest every 2 days, with the monthly
  cap spread evenly over the days. You get the mention rate per engine, share of voice, the most cited
  domains and whether your own pages are cited, within a monthly spend cap you set. Two optional engines run on your
  DataForSEO login: Google AI Overviews (whether one appeared, whether you are named or cited) and Perplexity (also
  possible on a `PERPLEXITY_API_KEY`). A sentiment label per answer that names you shows positive, neutral and negative
  counts per engine, this week against last, and costs a fraction of a cent per answer. It is off until you turn it on, and capped per day. Your server can also forward AI
  crawler hits (GPTBot, ClaudeBot, PerplexityBot) for a count per bot and page ([guide](docs/AI-VISIBILITY.md)).
- People and recordings. A People tab lists everyone you know: signed in, paid, remembered or using your app. Each person
  gets one story, from the first visit to the payment, across their devices, once your site calls `identify()` at
  sign-in ([Identify people](docs/GUIDE.md#identify-people)). Turn on Record visits and you can watch a visit to your
  website like a video, with its clicks, rage clicks and errors marked. A Recordings page lists what to fix first:
  clicks that changed nothing, fields people left, errors and pages nobody scrolls, each with example visits that open
  at the moment. Your agent reads the same with the MCP tool `get_recordings`. Pro turns it on for each new site with a website,
  together with Remember visitors, and it never covers the iPhone app. Every input is masked, and `data-fd-mask` and `data-fd-block` hide more. The recordings sit in an R2
  bucket on your own account that `npm run setup -- --replay` creates; `--record <site id|all>` turns recording on in
  the same run, and `--consent` records only visitors who accept your cookie banner. Each recording gets a summary of
  2 to 4 sentences built from what the recorder saw, and the list filters by error issue, experiment version, channel,
  paying customers and funnel step. See [People and recordings](docs/GUIDE.md#people-and-recordings-pro).
- Retention for your website: a lifecycle chart (new, returning, back after a break, gone quiet) and a weekly retention
  grid for the people your site recognizes, split by their first channel. See
  [Retention and lifecycle](docs/GUIDE.md#retention-and-lifecycle).
- Errors: JavaScript errors grouped into issues, each with the people and paying customers it hit, the top stack
  frames and, on a recorded visit, the moment it happened. Mark an issue resolved and it comes back if the bug does.
  One click sets an alert for the first time a new error shows up on your checkout. Off until you turn it on. See
  [Errors](docs/GUIDE.md#errors-pro).
- Experiments and feature flags on your website. Create one in the dashboard and paste its prompt into your coding
  agent. Each version is judged on revenue per visitor and on the goal you pick, and the result says "too few
  customers" until every version has 30. Experiments from your iOS app sit in the same list. See
  [Experiments](docs/GUIDE.md#experiments-pro).
- Click maps and scroll depth on a page's Content detail: the elements people click, drawn over your real page, and
  how far down they read. Paths follows visits page by page, up to 3 pages, with the recordings of each step. See
  [Click maps](docs/GUIDE.md#click-maps-heatmaps-and-scroll-depth-pro) and [Paths](docs/GUIDE.md#paths).
- Two surveys: "How did you hear about us?" after signup and "Why are you canceling?" before a cancel, shown as a small
  card on the pages you pick. Answers fill in what Direct visits leave out, and cancel reasons sit next to churn with
  the MRR they took. Stripe's portal and Polar send cancel reasons with no code, and the App Store and Google Play send
their category (through RevenueCat or Apple's notifications). See [Surveys](docs/GUIDE.md#surveys).
- An iPhone app with widgets and a push notification for every payment.
- An alert inbox keeps every alert for 90 days, one row per message and site, so an agent can read what fired since its
  last run ([guide](docs/GUIDE.md#alert-inbox-pro)). A threshold rule's webhook can send an auth header or a GitHub
  `repository_dispatch`, which starts an agent in GitHub Actions
  ([docs/MCP.md](docs/MCP.md#waking-an-agent-when-a-number-moves-pro)).
- Email from Resend per site: sent, delivered, bounced, complained, opened and clicked emails per day, sender and
  tag, with bounce and complaint rates. One webhook per Resend account covers every site, matched by the sender's
  domain, and no recipient address is stored ([docs/GUIDE.md](docs/GUIDE.md#email-resend-pro)).
- Mail on your own domains through Cloudflare: your apps send through an API that answers like Resend's, so they keep
  the `resend` package and change the base URL and the key. Mail to your addresses lands in an inbox in the dashboard,
  threaded with your replies, and agents read and answer it with the MCP tool `mail`. Templates keep the HTML your apps
  send in the dashboard, per domain, with versions, so a change to a welcome email needs no deploy. Delivery status, a
  suppression list and signed webhooks come with it. Sending needs Workers Paid, which includes 3,000 messages a month
  ([docs/MAIL.md](docs/MAIL.md)).
- Home across all your sites gets a Growth row (ad spend with MER and CAC, Google Search clicks, the AI mention rate),
  search drops in "worth a look" ([docs/SEO.md](docs/SEO.md#search-drop)), and the top 6 next actions across your
  sites, each with what it is worth in a month ([guide](docs/GUIDE.md#next-actions-pro)).
- MRR in the alerts and the Monday report, a daily numbers message, and a verdict for each logged change on the number
  it was meant to move: an SEO edit on its page's Search Console clicks over 28 days, an ad budget change on CPA, an AI
  content change on the mention rate, an app price on paywall conversion.
- All 39 MCP tools, with `query`, which answers metrics by up to 2 dimensions and a day, week or month for every site a
  key covers in one call ([docs/MCP.md](docs/MCP.md#the-query-tool-pro)), alert rules, the research log and twelve agent
  skills.
- Custom dashboards that your agent builds over MCP: numbers, lines, columns, bars, a country map, funnels and tables, run live when
  you open the page ([docs/MCP.md](docs/MCP.md#custom-dashboards-pro)).
- Teammates with their own login, as owner or viewer.

**What Pro does not do.** Surveys are the two fixed ones, how people heard of you and why they cancel, with no survey
builder. The Worker picks each visitor's flag and experiment version when the page view arrives, and the browser gets it
in the answer. There is no flag call for a backend or an app. API keys read experiments but cannot create, start or stop them. Errors have no source map upload, so stack
frames point at the minified file. App Store and Google Play cancel reasons are the store's categories, never the
customer's words. [FounderData vs PostHog](docs/vs/posthog.md) says what to keep PostHog for.

## Install

You need Node.js 20 or later and a Cloudflare account (the free plan is enough).

```bash
git clone https://github.com/founderdata/founderdata.git
cd founderdata
npm install
npm run setup
```

`npm run setup` signs you in to Cloudflare and creates the D1 database, or finds it if it already exists. It then
creates an admin password and a session secret, applies the migrations and deploys the Worker. At the end it prints
your dashboard URL. The password is saved in `~/.config/founderdata/admin-password`. Running it again is safe, and it
is also how you deploy updates.

To pick the password yourself, run `ADMIN_PASSWORD=... npm run setup`. To give the database another name, add
`-- --name my-analytics`. If you'd rather run each step by hand, the [guide](docs/GUIDE.md#deploy) lists them. Setting it up with a coding
agent? Point it at [AGENTS.md](AGENTS.md).

Your own settings stay out of git. `wrangler.jsonc` names the database but holds no id, because Wrangler finds the
database by name. To pin an id, rename the Worker or add routes, copy it to `wrangler.local.jsonc` (gitignored) and
edit the copy. Every npm script runs Wrangler through `scripts/wrangler.mjs`, which uses the local file when it
exists.

Want it on your own domain, such as `analytics.yoursite.com`? Add it in the Cloudflare dashboard under Workers & Pages,
founderdata, Settings, Domains & Routes.

## Add it to a website

Log in, add your site and copy its script tag into every page:

```html
<script defer data-website-id="SITE_ID" src="https://YOUR-FOUNDERDATA-URL/js/script.js"></script>
```

Single-page apps (Next.js, React Router and others) work without extra code. A few things you can add:

```html
<button data-rt-goal="signup_click">Sign up</button>
```

```js
window.founderdata('goal', 'signup', { plan: 'pro' });               // a custom goal with properties
window.founderdata('identify', { user_id, email, name });              // link a logged-in user
window.founderdata('consent', true);                                   // switch to cookies after consent
```

Open `https://yoursite.com/?rt_ignore=true` once per browser to stop counting your own visits.

Each site's Settings page has a "Copy AI prompt" button. Paste the prompt into Claude Code or Cursor in your site's
codebase and the agent does the install, including the checkout metadata below.

## Connect payments

Revenue only shows up once FounderData hears about payments. Each site's Settings page shows the webhook URL to use.

| Provider | How it connects |
| --- | --- |
| Stripe | A webhook endpoint plus the visitor ids in the checkout metadata. Payment Links get tagged by the script. Settings can import past charges with a restricted key. |
| Dodo Payments | A webhook plus checkout metadata. Payment links get tagged by the script. |
| Lemon Squeezy | A signed webhook plus checkout custom data. Checkout links get tagged by the script. |
| Polar | A signed webhook plus checkout metadata. `buy.polar.sh` links get tagged by the script. |
| Paddle Billing | A signed webhook plus `customData` passed to Paddle.js. |
| Gumroad | A ping URL with a secret token. Product links get tagged by the script. |
| App Store | The iOS SDK reports StoreKit 2 purchases, and App Store Server Notifications cover renewals and refunds. |
| RevenueCat | A webhook, with the visitor id as a subscriber attribute. |
| Anything else | `POST /api/v1/payments` with the site's API key. Ad and affiliate income goes there too, as `"kind":"income"`: revenue that never counts as a customer. |

To link a checkout to the visitor, read `window.founderdata.attribution()` in the browser, send it with the checkout
request and put it in the checkout's metadata. When the metadata is missing, FounderData falls back to the customer's
earlier payments, an email you identified and, for Dodo, the return page. Each payment in the Customers tab shows which
of these matched it.

Step-by-step instructions for each provider are in the [guide](docs/GUIDE.md#revenue-attribution-with-stripe).

## iOS apps

`FounderDataKit` is a Swift package with no dependencies for iOS 17 and later, built with Xcode 26 or later. In Xcode,
choose File > Add Package Dependencies, paste `https://github.com/founderdata/founderdata` and choose Up to Next Major
Version from 1.0.0. Every release is a git tag such as `1.4.0`, and the server, the dashboard and the Swift SDK share
that version ([CHANGELOG.md](CHANGELOG.md)). Your deployment learns about updates from `release.json`
([docs/PRO.md](docs/PRO.md#updates)). Then:

```swift
import FounderDataKit

@main
struct MyApp: App {
    init() {
        FounderData.configure(siteId: "SITE_ID", host: "https://YOUR-FOUNDERDATA-URL")
        FounderData.observeTransactions()
    }
    var body: some Scene {
        WindowGroup { ContentView().onOpenURL { FounderData.handle(url: $0) } }
    }
}
```

Without the user's consent the SDK stores nothing on the device, and the server counts one device once a day, however
often the app opens. `installId: .vendor` keeps one id per install without
consent, from a hash of `identifierForVendor`, so retention covers those installs too
([ios/README.md](ios/README.md#one-id-per-install-without-consent)). Then pick your path:

- With RevenueCat, set `FounderData.revenueCatAttributes` on `Purchases.shared.attribution`, buy through
  `FounderData.trackPurchase` and add the RevenueCat webhook in Settings, Payments
  ([ios/README.md](ios/README.md#using-revenuecat)).
- With StoreKit 2, buy with `FounderData.purchase(product, source:)` and point App Store Server Notifications at FounderData
  ([ios/README.md](ios/README.md#using-storekit-2)).

Screens, goals, onboarding steps and sign-out are covered in [ios/README.md](ios/README.md).

### App Store setup

1. In FounderData, add the app (Home, **Add site or app**, iOS app) with its bundle id, or enter the bundle id in an
   existing site's Settings. Until it is set, the server rejects the app's events and Apple's notifications for it.
2. Buy with `try await FounderData.purchase(product, source: .onboarding)`. It adds the app account token, sends the
   purchase goals and records the verified purchase. FounderData checks Apple's signature itself, so the app needs no
   secret. If you call StoreKit yourself, [ios/README.md](ios/README.md) shows the manual steps.
3. In App Store Connect, open the app, then App Information, App Store Server Notifications. Set the URL from the
   site's Settings as the Production URL, Version 2. That brings in renewals and refunds. If your own backend already
   receives these notifications, forward the raw body instead ([ios/README.md](ios/README.md) has an example).
4. Optional, FounderData Pro: let FounderData import Apple's daily Sales report, so downloads and proceeds show up, including apps without
   the SDK. Create an App Store Connect API key with the Sales and Reports role only, then set four secrets:

   ```bash
   node scripts/wrangler.mjs secret put ASC_KEY_P8          # contents of the AuthKey_XXXX.p8 file
   node scripts/wrangler.mjs secret put ASC_KEY_ID
   node scripts/wrangler.mjs secret put ASC_ISSUER_ID
   node scripts/wrangler.mjs secret put ASC_VENDOR_NUMBER   # Sales and Trends, Reports, next to your name
   ```

   A daily cron imports the last three days. `scripts/asc-backfill.sh` imports up to a year back. See
   [App Store sales](docs/GUIDE.md#app-store-sales-pro).

TestFlight and sandbox purchases never count as revenue. To see them while testing, turn on sandbox purchases in the
site's Settings.

### iPhone app (Pro)

FounderData Pro comes with an iPhone app for your deployment. It signs in with your admin password and shows today, 7
day and 30 day totals per site, with Home Screen and Lock Screen widgets. Add an APNs key to the Worker and it sends a
push for every payment. With mail on your own domains it also reads the inbox, replies in plain text inside a thread
and pushes received mail. You build it with your own Apple team, and the steps are in the Pro repository. The phone's
token can read every dashboard number but can't change a site; a new admin password signs every phone out.

## What it costs

Nothing at side-project traffic. The limit you hit first on Cloudflare's free plan is 100,000 D1 rows written a day.
That is roughly 3,100 web visits a day, or about 1,500 web visits plus 1,000 app sessions plus 50 payments. A test
measures the cost of each write path and fails when it changes. Past that, Workers Paid is $5 a month. The
[guide](docs/GUIDE.md#what-the-free-plan-covers) has the numbers.

### Rank checks and AI checks, by plan

The Worker's cron runs every 5 minutes, 288 times a day. Cloudflare's limits apply to each run, 10 ms of CPU and 50
subrequests on Free, so more runs raise what a day does and leave each run as small as before. A run collects up to 6
DataForSEO results (counted as 6 task_get calls), posts at most 4 task_post calls and starts up to 6 AI checks. The
numbers below are for Google rank checks and hosted App Store checks together, since they share one budget.

| | Free | Workers Paid ($5 a month) |
| --- | --- | --- |
| DataForSEO results collected a day | 1,728 (`RANK_COLLECT_PER_RUN` 6) | up to 28,800 (`RANK_COLLECT_PER_RUN` 100) |
| AI checks started a day | up to 1,728 (`AI_CHECKS_PER_RUN` 6) | up to 14,400 (`AI_CHECKS_PER_RUN` 50) |
| Example that fits | 720 App Store pairs and 200 Google keywords (920 a day), plus 50 prompts on 3 engines (150 checks) | 28,800 results is 144 sites of 200 keywords |

Google AI Overview tasks (up to 5 posted and 3 collected a tick) and sentiment ratings (up to 3 a tick) draw on the same
budget of 50, and each call checks it first. A test in the Pro repository runs the busiest tick and holds it under 50.

A test runs a day of ticks for that Free example. Each tick made at most 40 subrequests (DataForSEO calls, engine calls
and D1 queries together) and a tick with nothing to do wrote no D1 rows except the heartbeat the setup checklist reads (1 row at minutes 0, 15, 30 and 45). A busy tick read about 2,500 rows, an idle
one about 750 and a tick before 05:00 UTC with nothing new about 950, so the 288 ticks of a day read about 0.5 million of Free's 5 million. Once a site has nothing left to post
for the UTC day, its ticks skip the scan of its keywords and pairs. Reads still grow with the pairs and keywords you track.

Opening a page's click map (Pro) reads about 15 rows per mapped page view, the newest 2,000 at most (about 30,000
rows), and the overlay about the same again.

Some Pro reports read many rows. The free plan allows 5 million rows read a day, and D1 refuses queries for the rest of
the UTC day once a database passes it. Measured on the demo, which has 6,196 visits in 30 days:

| Report | Rows read |
| --- | --- |
| Paths, top pages / one page / a sequence of 1 to 3 pages | about 23 / 13 / 22 to 28 per visit of the range. A range with more than 75,000 events (40,000 with a sequence) reads only its newest visits and says so, so one look stays under 1 million |
| Experiment detail | about 9 per visit of the site during the run |
| Experiment list | about 10 per visit of the site during each web experiment's run, for each one, 20 at most |
| Web lifecycle / web retention | about 40,000 / 30,000 on the demo, whatever the period. With Known people they read every visit of the people the site recognizes |

At 3,000 visits a day, a 30-day Paths view hits the cap and reads up to about 825,000 rows. An experiment that ran 30
days reads about 840,000 on its page. Six such opens a day reach the 5 million. These numbers come from local D1. Rows read
on a production database: not measured.

The hourly jobs never share a tick: phone pushes and alert rules run at minute 0, the weekly report at 07:05 on Mondays,
the X poll at minute 15, the mail health check at minute 20, the Search Console sync at minute 30, the Meta ads import at minute 45, next actions at
minute 50 (3 sites a tick) and the AI answer counts at minute 55. The Meta Conversions API sends what is pending on every
tick, and a tick with nothing pending costs one query. All jobs of one run draw on one counter of 48 subrequests (50 minus 2 in reserve) that counts
every D1 query and outgoing call, and a paid call (a DataForSEO task or an AI engine call) starts only when the counter
also covers the writes that record it. A test fires every slot of an hour with everything busy: the highest was 48.
Another runs 13 sites with Slack, Discord and email channels through Monday's 07:00, 07:05 and minute-50 ticks: 36, 19
and 14.

You need Workers Paid when you track more than about 1,700 results a day, or when you pass 100,000 D1 rows written a day.
The examples above need neither. Cloudflare allows 5 cron
triggers on Free and this deployment uses 3. Cloudflare's documentation does not say whether cron runs count toward
Free's 100,000 requests a day. At about 290 runs a day they are under 0.3% of it either way. A deployment that keeps
`0 * * * *` in `wrangler.local.jsonc` still works and runs everything once an hour, which collects 144 results and
starts 144 AI checks a day. Replace it with `*/5 * * * *` to get the numbers above.

A monthly cap is soft. A call that would pass it is not made, but two overlapping runs can each size a batch from the same
spend, and DataForSEO's price changes show up only after a call. DataForSEO's own balance is the final limit.

| Write path | D1 rows written |
| --- | --- |
| Web: first pageview of a new visitor / each further pageview or goal. An ad click id, the language and the first touch add columns, not rows. A later page that brings any ad click id, Meta's included, into a direct visit writes 1 row more, or 2 on the visitor's first visit | 11 / 5 |
| Web: page speed (Core Web Vitals) of one page load, in the ping it already sends | 1, at the default 100% sample |
| Web: `identify()` | 0 when no field changes. Otherwise 1 for the visitor row, plus 1 for each of email and user id the visitor has after the call. Traits ride on the same row |
| Web: clicks, rage clicks and errors of one page in a recorded visit (Pro), in the ping it already sends | 0 when the page had none, else 4: one `activity` event, its 2 index entries and the id counter |
| Recorded visit (Pro): the index row with its first chunk / each later chunk | 3 (the row and its 2 index entries) / 0. Each chunk is 1 Worker request and 1 R2 write |
| Recorded visit (Pro): a chunk that carries a changed digest / the same digest | 1 (an update of a column with no index) / 0. A visit too short to save its first snapshot sends a stub chunk 0: 3, as any first chunk |
| Recording health (Pro): a refused upload or a recorder that could not load | 1 at most once an hour per site and Worker instance |
| Web: a running experiment (Pro) on the visit's first pageview / on the first later pageview that reaches it | 0, a column of the session row / 1 per experiment, once per visit |
| Experiment (Pro): created, changed or deleted / started or stopped | 2: its row and the site's list of running experiments / 5: those 2 and 3 for its [chart note](docs/GUIDE.md#chart-notes) |
| Survey answer from the survey card or `founderdata('answer', ...)` / a cancel reason from a Stripe or Polar webhook | 2, 1 when the visitor's trait did not change, 0 for the same answer again that day / 1, plus 1 when the subscription has a visitor |
| Cancel reason from the App Store or Google Play (RevenueCat, or Apple's notifications) | 1, no trait. The expiry that follows a cancellation of the same period, and a retry, 0 |
| Survey card shown (Pro) | 0. It reads the visitor row on each page view while a survey is on |
| Web: click map of one page view (Pro) / scroll depth of one page load, in the ping it already sends | 1 at the default 100% sample, plus 1 each time the visitor comes back to the tab and clicks more / 0 |
| Web: errors of one page view, in the ping it already sends | 1 per distinct error, 5 at most, plus 1 the first time an issue appears. 0 without errors |
| Error issue (Pro) resolved, ignored or reopened / the first new error alert rule / a later one | 1 / 3: the rule's 2 rows plus 1 for the dashboard address its alerts link to / 2 |
| Errors page (Pro) opened in the dashboard | 0. 1 the first time it saves the dashboard address alerts link to, or when that address moved |
| App: typical session of a known install | 36 |
| App: a new install's first session / a relaunch the same day without consent. An install that Apple Search Ads attributes writes 2 rows more when Apple answers | 7 / 3 to 5 |
| Payment from Stripe, the App Store or another provider | 5 to 9. A subscription event that cancels a paying subscription or fails its renewal adds 1 alert inbox row |
| ASO: a snapshot of one app in one country, any number of keywords | 1, a second one the same day 1 |
| ASO: a new review (a review that alerts adds 1 alert inbox row per post) / weekly popularity per keyword and country | 1 / 1 |
| ASO: each keyword added or imported | 1 |
| Hosted App Store ranks: a daily check posted / its result collected, per pair | 3 / 1 (the claim, the task id and its entry in the open-task index, then the cleared task), plus 1 per call for the cost counter, 1 snapshot row per country and run, and 1 a day when nothing is left to post. 720 pairs a day write about 3,100 rows. A run with nothing to post or collect writes none, so the 5-minute cron adds no rows |
| Subscription history import: a page of 200 ChartMogul activities / each subscription stretch stored | 3 / 2 (the row and its index entry), plus 2 a chunk |
| Team: invite a person / accept the invite, sign in, or revoke / reset link | 5 / 1 / 2. A request with a teammate cookie writes nothing. A wrong teammate password writes 4 (the IP and the account) |
| Chart note from an agent / its review | 3, or 4 with an idempotency key / 1 |
| Research log entry from an agent | 1, or 2 with an idempotency key |
| Plan ([docs/API.md](docs/API.md#plan-pro)): create it / change the document, rules or reach / change only the schedule or the share / the portfolio / a task, new or changed, claimed by a run or approved / the owner ticks or answers a task, says yes or no, or undoes it / the question push / a session or a failed run / a check-in / the daily results job / the away alert | 1 / 2 (the plan and the version before; 3 once 30 older versions are kept) / 1 / 1 / 1 each (1 more when an owner task opens), 0 when another run's claim or an owner task refuses it / 1 (2 for an undo, which opens the task again) / 1 per site and push / 2, or 3 with an idempotency key, plus 1 per closed result it keeps (8 at most) / 1, or 2 with an idempotency key, plus 1 per closed result it keeps / 1 per closed result no session kept yet (3 per site a day at most), 0 when there is none / 2 per plan, once per gap. Reading the plan writes 0 |
| Custom dashboard: created, changed or deleted / a widget run | 1 / 0 |
| AI answer check (one prompt on one AI surface on one day), new or replaced | 1 |
| Setup checklist: the cron heartbeat / a test button pressed / a refused location code stored | 1 at most every 10 minutes, so 96 a day / 2, 0 inside 15 seconds / 1 a day per refused country, 1 to clear it. Reading the checklist writes none and reads one row per site and payment provider with a signing secret |
| Google rank tracking: a daily check posted / its result collected, per keyword | 2 / 1 (the claim, then the task id), plus 1 a day for the cost counter and 1 a day when nothing is left to post. 200 keywords write about 600 rows a day. The SERP top 10 and features are columns on the result's row. A keyword that was never checked posts at the next tick, not at 05:00, with the same rows |
| Google rank tracking: a keyword untracked by an agent or in the dashboard | 1, or 2 when it has been checked at least once (its last check is kept) |
| History import from DataFast: a stored day-row / a chunk of up to 100 rows | 1 / 1, in the same 20,000-row daily allowance as the Plausible import |
| X posts: a poll that finds N posts linking to the site / a poll with nothing new / a post added by hand | N + 2 (the claim, the posts, the settings row) / 1 (the claim) / 1. Matching visits to posts happens when a report is read and writes nothing |
| AI visibility: a run of N prompt checks on one engine (answer and spend in one batch) / a prompt or the settings saved / a prompt removed | 2N / 1 / 1 |
| AI visibility: a check that failed for its own prompt (or that the provider billed) | 1 |
| AI visibility: the first run of a day that finds no check left for a site marks it done for the day / prompts added after that clear the mark | 1 a site and day / 1 |
| AI visibility, Perplexity check through DataForSEO / on its own key (`PERPLEXITY_API_KEY`) | 3 (answer, AI spend, DataForSEO counter) / 2 |
| AI visibility, a Google AI Overview check: posted / collected | 2N + 2 for N prompts in one post (a claim and a task id each, the AI spend, the DataForSEO counter) / 2 (the answer, the deleted claim) |
| AI visibility, one sentiment rating (`sentiment_per_day`, off by default, up to 500 a site and day) | 2 (the label on the answer, the AI spend) |
| AI crawler hits: a request with N distinct bot, page and status combinations, M of them new | N, plus 1 for each day that gained a new row (M > 0) |
| SEO snapshot: one part pushed, with the login or a `seo:write` key | 2 for a new part, 1 to replace it |
| Connect Google: a first property picked / a different property picked (deletes the stored parts) / a site's first sync step / a backfill step of about 10 days / a new day, which also reads the last 3 days again, with meta and the page and query pairs / the page totals, then the query totals, of a new day, each in a run of its own / Google disconnected | 1 / 8 / 10 / 4 / 7 / 2 each (3 the first time) / 1. A run with nothing to do writes 0 |
| Tracking start: the nightly scan for each site's first web and app visit | 1 for a site the night its first web or app visit is found, else 1 a week while one is unknown (an app without a web tracker stays there), 0 once both are known. Reading `tracking_since` or `sources` writes 0 |
| Scoped API key: usage (last used, last write, calls) | 1 a minute per key at most, whatever the number of calls |
| Agent reads, the MCP `query` tool included | 0, besides the key's usage row |
| Home's Growth row (ad spend, Search Console clicks, AI mention rate) and a site's Paid overview | 0. The Growth row reads one stored Search Console row and one AI count row per site, never the AI checks themselves |
| AI answer counts for the Growth row and `get_portfolio`, at minute 55 of every hour | 1 for each site with new checks, plus 1. A run reads the checks since the previous run's UTC day, about one day of checks. The first run reads 180 days once |
| Stripe check: a finished check / a second one the same day / a step before the last | 1 (the day's history row) / 1 (it replaces the row) / 0 |
| Daily numbers message at 07:00 UTC, per channel | 2 (the day's marker, then sent), plus 1 for each retry of a refused send. A second trigger or a tick after it writes 0 |
| Phone pushes at 08:00: the daily one / the Monday one | 1 a day / 1 a week, for any number of phones |
| Live Activity: a payment's update / a new token | 1 per phone, at most once a minute / 1 |
| Threshold alert rule, checked hourly: a check that fires or judges a change / a quiet check | 1, plus 1 alert inbox row per alert it sent / 0 |
| Alert inbox: each alert message, per site (rules, Worth a look, payments stopped, a failed payment or cancellation of a paying subscription, refused webhooks, the write cap, the ASO collector, a low review, mail problems) | 1, also with no channel. Purchases and renewals stay out |
| Weekly report on Monday 07:05 UTC, per channel / its inbox rows | 2 (the week's marker, then sent), plus 1 for each retry / 1 per site a week |
| Next actions, computed once a day on the minute-50 tick | 2 per site a day (the claim, then the items) |
| Resend email event: the first of its type for an email / a retry or a second open | 2 / 0 |
| Mail ([docs/MAIL.md](docs/MAIL.md)): an app sends to one address / the dashboard or an agent sends / a status event / a received message that starts a thread | 18, or 21 with an idempotency key / 23 or 24 / 5 / 15 |
| Mail on the iPhone app ([docs/MOBILE-API.md](docs/MOBILE-API.md#11-mail)): a reply / a mail push switch / a received message that pushes | 22 / 1, or 0 when it is already so / 15, the same as without the push |
| Mail health alerts, hourly at minute 20: a quiet hour / a domain's daily check / an alert / a received message that could not be read or stored | 0 / 1, plus 1 when its problems change / 2 / 1 |
| Today ([docs/MOBILE-API.md](docs/MOBILE-API.md#12-today), Pro): an agent's flag or draft / a Reply card sent / Not needed, Mute 24 h or a settings change / the 08:00 push / the push for a critical Fix / the nightly cleanup | 2 / the reply's rows + 2 (23 from the dashboard, 24 from a phone) / 1 / 1 a day / 1 per tick that finds one, 0 otherwise / 1 per log row past 90 days and per ended mute. Reading the list writes 0 |
| Meta ads import: a new ad and day / a new campaign, ad set or ad name / a run that finds nothing new | 2 (the row and its index entry) / 1 / 1. Today's rows change every hour as spend comes in, so 20 active ads write about 500 rows a day |
| Meta Conversions API: an event sent or skipped / a tick with nothing pending | 1, plus 1 for the site's status when it changes / 0 |
| Ad spend from Google Ads, TikTok or any channel without an import (`POST /api/v1/spend` or a CSV): a new or changed row of a day and campaign / a row sent again unchanged | 1 / 0. Meta and Apple Search Ads spend joins in from their imports and writes nothing more |

The [guide](docs/GUIDE.md#what-the-free-plan-covers) has every write path. ASO for 3 apps with 30 keywords in 3
countries writes under 100 rows a day.

### Recordings (Pro)

For 200, 1,000 and 3,000 recorded visits a day, kept the default 30 days:

| Recorded visits a day | 200 | 1,000 | 3,000 | Free plan |
| --- | --- | --- | --- | --- |
| D1 rows written a day | 7,800 | 39,000 | 117,000 | 100,000 a day |
| Worker requests a day | 2,400 | 12,000 | 36,000 | 100,000 a day |
| R2 writes a month (Class A) | 48,000 | 240,000 | 720,000 | 1 million a month |
| R2 reads a month (Class B) | 18,000 | 90,000 | 270,000 | 10 million a month |
| R2 storage | 0.9 GB | 4.5 GB | 13.5 GB | 10 GB |

The free plan ends near 2,200 recorded visits a day, where storage passes 10 GB; D1 rows pass 100,000 near 2,500. Before
that, FounderData's daily write cap stops all sites together at 80,000 rows a day, about 2,000 recorded visits, and one
site at 40,000 when there are several, unless you change it (Settings, Data and privacy). Visits you don't record write their own rows on top. The default maximum of 1,000
recorded visits a day stays inside every limit; keeping recordings 7 days instead of 30 cuts storage to a quarter.

The table assumes each recorded visit is a new visitor with 3 page loads of a minute each and clicks on one page. Per
visit that is 39 rows (21 for the three pageviews, 6 for the pings with page speed, 4 for the clicks, 3 for the
recording's row and 5 digest updates, the counts `pro/test/cost.test.ts` pins), 12 requests (3 pageviews, 3 pings,
6 chunks: one 30 seconds into each page and one as it is left), 8 R2 writes (6 chunks and 2 lists when a later page finds
the chunks before it) and 3 R2 reads (a check per page). Storage assumes 150 KB a visit, gzipped; a minute on a busy
dashboard page measured 30 to 60 KB. Watching a recording reads one R2 object per chunk.

The tracker endpoint is public, so each site has a daily write cap, on by default: your sites share 80,000 rows a day,
and a busy site can use what quiet sites leave, up to half. Fake traffic can't use up the free plan or run up a paid bill. Past the
cap, website events are dropped and the app holds its events until 00:00 UTC. You can give a site its own cap in its
settings. On Workers Paid, the `WRITE_POOL_ROWS` var sets the shared pool for every site at once.

A daily cron deletes visit data older than 24 months. Set `RETENTION_MONTHS` for another window, and
`PII_RETENTION_MONTHS` to clear names and emails sooner ([PRIVACY.md](docs/PRIVACY.md#retention-settings)).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars        # admin password: change-me
npm run db:migrate:local
npm run seed                          # optional: 60 days of demo data: a SaaS website with an SEO snapshot, an iOS app and a blog
npm run build && npm run dev:api      # http://localhost:8787
npm run dev:web                       # optional: dashboard with hot reload on http://localhost:5173
```

Before you commit, run `npm run typecheck && npm test`. `npm run smoke` runs an end-to-end check against the dev
server.

The code is laid out like this:

- `public/js/script.js` is the tracker. The build minifies it to 15,554 bytes, 6,670 gzipped.
- `src/worker` is a [Hono](https://hono.dev) app on Cloudflare Workers. It takes in events, webhooks and API calls and
  runs the stats queries on D1.
- `src/dashboard` is the React dashboard (Vite, Tailwind, Recharts). The same Worker serves it as static files.
- `migrations/` holds the database schema.
- `ios/` holds the FounderDataKit Swift package.
- FounderData Pro adds a `pro/` folder with its reports and the iPhone app ([docs/PRO.md](docs/PRO.md)).

## Docs

- [Guide](docs/GUIDE.md): everything the dashboard tracks, cookies and consent, each payment provider, how revenue is
  counted, accuracy notes. Sections marked (Pro) need FounderData Pro.
- [FounderData vs other tools](docs/vs/README.md): side-by-side pages for DataFast, Plausible, PostHog, OpenSEO, Astro, RevenueCat and ChartMogul, Peec and Profound, with what FounderData does not do and how to move over.
- [Import web history](docs/IMPORT.md): bring in a Plausible CSV export, or read a DataFast site through its API with your key. Past traffic shows in the chart and the top panels, and a source filter answers from it. Other tools that export Plausible's CSV files may work; only Plausible's is tested.
- [App API](docs/APP-API.md): the contract between the server and the iOS SDK.
- [App events](docs/APP-EVENTS.md): a naming convention for onboarding, paywall and purchase events.
- [Mobile API](docs/MOBILE-API.md): the routes the Pro iPhone app uses, and push notifications.
- [SEO snapshots](docs/SEO.md), Pro: the format the SEO tab reads, how to push it, and Google rank tracking and keyword research on your DataForSEO account.
- [ASO](docs/ASO.md), Pro: keyword ranks, ratings and reviews for iOS apps, the collector, its terms caveat and its
  snapshot format.
- [Mail](docs/MAIL.md), Pro: send and receive email on your own domains through Cloudflare, move an app off Resend,
  the inbox, webhooks, limits, and what is stored for how long.
- [Privacy](docs/PRIVACY.md): what is stored and for how long, who can read it, what Cloudflare sees, EU storage, the
  subprocessors, a GDPR checklist, a balancing test template, a breach procedure and an answer sheet for procurement.
- [MCP server](docs/MCP.md): connect Claude Code, Cursor or another agent to `/mcp` with one scoped key, and the OpenAPI
  spec at `/api/v1/openapi.json`. Pro adds a research log where agents record what they found and paid for, the
  history of AI answer checks, and twelve workflows as MCP prompts.
- [API](docs/API.md): the payments and goals API, the read API for stats, share links and badges, CSV export, and
  erasing one person.

## Contributing

Issues and pull requests are welcome. Please include a test for behavior changes and keep `npm run typecheck && npm
test` passing. [AGENTS.md](AGENTS.md) has the project's conventions, for people and coding agents alike. Report
security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

MIT. FounderData started as a fork of [minilytics](https://github.com/surendrapandar/minilytics) by Surendra Pandar,
whose copyright notice stays in [LICENSE](LICENSE).

FounderData Pro is not MIT. Its terms are in [docs/PRO.md](docs/PRO.md#license).
