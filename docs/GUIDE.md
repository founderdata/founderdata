# FounderData guide

The full reference: what FounderData tracks, how to install it on a site and in an iOS app, how each payment provider
connects, and how revenue is counted. For a quick start, see the [README](../README.md).

Sections marked (Pro) need FounderData Pro ([PRO.md](PRO.md)).

## What it tracks

- **A home page across every site**: totals for the period against the period before (web and app visitors as separate tiles, revenue in each site's currency with other currencies converted, new customers, conversion for the web with the app's rate under it, bounce rate and session time for websites only, online now), visitors and revenue charts for all sites, a list of every site and app ranked by revenue change against the period before, each with an 8-week sparkline, its MRR change in money (Pro) and a status (growing, flat, declining, quiet, no payments connected), a card per site with a visitors sparkline and revenue bars, its numbers and top source (a site with an app bundle id and no web visits in 90 days shows as an app, with its bundle id instead of the placeholder domain), the sources that brought customers across all sites, the 12 latest payments, in Pro a Growth row (ad spend with MER and blended CAC, Google Search clicks, and the share of AI answers that mention the site, each added up across sites with every site's number linked to its Paid overview, SEO or AI visibility section), and a "Worth a look" list (a website with no visits yet, one line for all apps that have not sent an app session yet, a site or app quiet for 24 hours, traffic doubled or halved on a base of at least 20 visitors, weekly revenue or visitors down 3 weeks in a row, first customers). Changes on fewer than 20 visitors show as counts, not percentages. The home counts days in the reporting timezone (see "One number everywhere" below); `GET /api/home?period=&tz=` returns the JSON
- **Live visitors**: who is on your sites right now, for a globe. `GET /api/live` returns the visitors seen in the last 5 minutes with their city and coarse coordinates, the last hour's payments, trials and sign-ups, and, on request, the visitors of the last 30 minutes, hour or 24 hours, by city and one by one ([MOBILE-API.md](MOBILE-API.md#9-live-visitors)). The globe glows only where people are online now; the live page's 30 min, 1 h and 24 h buttons switch the whole page to that window: the visitor count, the count per site, the payments, a list of the visitors (newest first, up to 150) and a dimmer glow where they were.
- **Visitors, revenue, conversion rate, revenue per visitor, bounce rate, session time, online now**, each with a % change against the previous period. The **This quarter** and **Last quarter** periods are calendar quarters in the site's timezone (the reporting timezone on the home page). Last quarter compares with the whole quarter before it. This quarter compares with the same days of the quarter before, so October 1 to 10 compares with July 1 to 10
- A chart of visitors (line) and revenue (bars), hourly, daily, weekly or monthly
- Date ranges: today, yesterday, last 24h, last 2 days, 7/30/90 days, 12 months, all time and custom, with ‹ › to step back and forward
- **Where visitors come from**: channel, referrer (X, Google, ChatGPT, Reddit…), campaign (`utm_campaign`), keyword (`utm_term`), `?ref=` tags, and ad clicks from Google, Microsoft, TikTok, X, LinkedIn, Reddit, Snapchat and Pinterest (see [Ad clicks other than Meta](#ad-clicks-other-than-meta)). Source panels credit the visit a payment came from, or with `model=first` on the API the visitor's first visit
- **Where they are and what they use**: country, region, city, browser, OS, device, language
- **What they did**: pages, entry pages, exit links (outbound clicks), button clicks and custom goals, funnels
- Each breakdown row shows its visitors and its revenue, and entry pages add revenue per visitor. Click a column header to sort by it. The Platform and App version panel shows only for a site with an app
- **Who paid**: a Customers list of every customer with their source, amount, time to convert, and a full visitor timeline (visit → pages → clicks → payment)
- **Payments from Stripe, the App Store, Dodo Payments** or any provider through the payments API, with revenue per provider
- **iOS apps** next to the website in the same site: app sessions, screens, goals, App Store purchases, app versions, and in Pro Apple Search Ads campaigns with their names, spend and ROAS per keyword (see [Apple Search Ads](#apple-search-ads-pro))
- **An App section (Pro)** for each site with an app: the onboarding funnel with drop-off and time per step, screen flow and exit screens, paywall to purchase conversion, versions side by side, experiments per variant, sources, and day-1 and day-7 retention for installs that consented to on-device storage. Each panel can be split by app version or by session properties the app sets, such as `user_state` or an experiment variant. The JSON behind every panel is in [APP-API.md](APP-API.md) section 7
- **A Drop-off view (Pro)** for every site: the purchase funnel (sessions, flow start, paywall, purchase start, bought) for the website and the app side by side, the failure goals that stop people by reason and step, and the last page or screen of sessions that did not buy. Debug and TestFlight builds stay out unless you include them. API in [APP-API.md](APP-API.md) section 7
- The overview shows web and app together, or the website or the app alone
- Click any row to filter the whole dashboard (for example "only visitors from the launch tweet"), or open the page, SEO, AI visibility or ads screen behind it
- Multiple websites, one login
- **Mail (Pro)**: send and receive email on your own domains through Cloudflare. Apps keep the `resend` package and change the base URL and the key, and replies land in an inbox on the Mail page. See [Mail](#mail-pro)
- **Email from Resend (Pro)**: sent, delivered, bounced, complained, opened and clicked emails per day, sender and tag, with bounce and complaint rates. One Resend webhook covers every site. See [Email (Resend)](#email-resend-pro)
- **A Content tab (Pro)** for every site with a website: one table of entry pages with visitors, customers, revenue, revenue per visitor and the change against the period before, plus Google clicks and position when the SEO snapshot has the page. Chips filter by folder, such as `/blog/`, and a click on a page opens its 12 weeks, notes, keywords and customers. Below it, AI assistants (ChatGPT, Claude, Perplexity, Gemini, Copilot) with their visitors, customers, revenue and top 5 landing pages. See [Content](#content-pro)
- **An SEO tab (Pro)** for every site with a website: Search Console clicks, impressions, click-through rate and position for 7 days to 12 months, beside FounderData's own search visitors and revenue; target keywords with volume, Google position, the latest SERP check and whether the AI Overview cites the site; pages that lost over 30% of their clicks; queries close to page one and page-one pages with a low click-through rate; top queries and pages, each page with its search visitors and revenue; an SEO plan and ship log; AI assistant answers; who ranks instead and backlinks. You push the data; see [SEO](#seo-pro)

### Reading a site

The header holds everything that changes the page. Pick the site in the menu on the left and the period on the right.
The period control has Today, 7D, 30D, 90D and 12M. **More** has the rest, a custom range and the grouping by hour,
day, week or month. The arrows step one period back or forward.

Under them, one row holds every section of the site in four groups:

| Group | Sections |
| --- | --- |
| Analytics | Overview, Content, Drop-off, App |
| Organic | SEO, AI visibility, ASO |
| Paid | Paid overview, Meta ads, Apple Search Ads |
| Revenue | Subscriptions, App Store |

In core, every section after Overview opens the Pro card, which explains what the section shows and how to get Pro.
The rest of this part describes Pro.

Every section is one click away on every site. A section the site cannot use yet stays in the row in gray with a
hollow dot. It opens a screen that names the missing step and links to it in Settings: a website for Content, SEO and
AI visibility, an app for App, ASO and App Store, a payment provider for Subscriptions. Meta ads and Apple Search Ads
open their own setup steps until the integration is connected. The Paid overview stays gray until Meta, Apple Search
Ads or [spend from another channel](#ad-spend-from-other-channels-pro) is connected. On a phone the row scrolls sideways.

On the Overview, the row of numbers drives the chart. Visitors and Revenue are both on by default. Click one to see it
alone, and click it again for both. Revenue/visitor swaps the chart for that ratio per day. The revenue bars carry an
avatar on the 8 days with the most new customers. Hover any day to see its numbers, who paid and the notes.

Click a row in Channel, Page, Country or Browser to filter the whole page by it. Back removes the filter again. A row
that leads somewhere deeper shows an arrow on hover, always on a phone. Its menu has **Filter by this** and the screens
that row opens:

| Row | Opens |
| --- | --- |
| A page or entry page | The page's detail in Content |
| Channel Organic Search, or a search engine under Referrer | SEO |
| Channel AI, or an AI assistant under Referrer | AI visibility |
| Channel Paid | The Paid overview, Meta ads and Apple Search Ads |
| Google Ads, Microsoft Ads, TikTok Ads or another ad network under Referrer | The Paid overview |
| Facebook or Instagram under Referrer | Meta ads, on a site with a Meta ad account |
| A campaign whose name or id is a campaign in the site's Meta ad account | Meta ads |
| An Apple Search Ads campaign or keyword | Apple Search Ads |

Under the breakdowns, the Customers tab lists who paid and where they came from, with Goals, Funnel, Visitors and
Changes beside it.

The URL holds the state of the page, so a refresh, Back or a link you send opens the same view: the period and
filters, each card's open tab in `?tab=`, a section's sub-view in `?view=` and an open visitor profile in `?visitor=`.
Agents get the same kind of link: every read API answer that a screen shows carries a `dashboard_url`
([API.md](API.md#dashboard-links)).

Email delivery numbers sit at the end of the Overview. Without Resend connected, that is one gray line, **Email: Not
connected**, that opens the setup steps. A viewer login does not see it.

Press ⌘K (Ctrl K on Windows and Linux) to jump to a site, a section, a period or a setting. The page fetches fresh
numbers when you come back to the tab after a minute or more.

## Deploy

`npm run setup` does the whole install on your Cloudflare account (see the [README](../README.md#install)). To do it
by hand instead:

```bash
npm install
npx wrangler login
npx wrangler d1 create founderdata          # if Wrangler offers to add it to your config, say no: it finds it by name
                                         # add --jurisdiction eu to keep the data in the EU (docs/PRIVACY.md)
openssl rand -base64 24 | node scripts/wrangler.mjs secret put ADMIN_PASSWORD     # or type your own
openssl rand -base64 32 | node scripts/wrangler.mjs secret put SESSION_SECRET
npm run deploy                           # builds the dashboard, applies D1 migrations, deploys the Worker
```

Keep the password somewhere you can find it; `npm run setup` keeps it in `~/.config/founderdata/admin-password`.
`wrangler secret put` offers to create the Worker if it does not exist yet; say yes. If `wrangler deploy` fails with
`fetch failed` or a Cloudflare API error, run it again; those are network or API hiccups.

`SESSION_SECRET` also salts the daily cookieless visitor id. Changing it gives every cookieless visitor a new id for the
rest of the day. To keep the two apart, set a separate `VISITOR_SALT_SECRET`
(`openssl rand -base64 32 | node scripts/wrangler.mjs secret put VISITOR_SALT_SECRET`). Visitor ids then come from it,
and rotating `SESSION_SECRET` only signs people out. [PRIVACY.md](PRIVACY.md#the-visitor-id) explains the trade-off.

The login cookie and phone tokens are bound to both secrets. Changing `ADMIN_PASSWORD` or `SESSION_SECRET` signs out
every browser at once and stops every signed-in phone's token from working; sign in again with the new password. The
next sign-in also revokes the old phones in Settings and stops their payment pushes, and so does the nightly cron
at 03:17 UTC if nobody signs in first. To end one stolen session without changing the password, revoke that phone in
Settings. A browser cookie can only be ended by changing the password.

### Upgrading

Run `npm run setup` again (or `npm run deploy`). It applies the new migrations and keeps your password and data.
Upgrading from a version without the viewer login signs every browser out once, because the login cookie changed.
Sign in again with the same password. Phones stay signed in. A phone's token moves to the new format on its next
request, and the phone keeps getting payment pushes until then.

### Run the Worker next to its database

Every D1 query is a round trip from the Worker to the database. Cloudflare runs the Worker in the data center that
took the request, so when you sit far from the database (Southeast Asia against a database in Western Europe, for
example) each round trip costs 270 to 450 ms. The reads count their round trips (next section) and keep them low:
Home, the site overview and Pulse make 2, a phone's read 3 (its token is checked first), the site list and the live
globe 1.

Placement runs the Worker near the database instead. The round trips then cost a few milliseconds, and only the trip
from you to the Worker stays long. Two forms, either one in your own `wrangler.local.jsonc`:

```jsonc
// Cloudflare picks the location. It needs traffic from several places and can take 15 minutes to decide.
"placement": { "mode": "smart" },
```

```jsonc
// A cloud region near the database, from the first request. This one suits a database in Western Europe.
"placement": { "region": "aws:eu-central-1" },
```

Cloudflare's [placement page](https://developers.cloudflare.com/workers/configuration/placement/) says placement moves
only where the `fetch` handler runs (the cron stays where it is) and that static files are still served from the data
center nearest the visitor. It does not say what happens to the visitor's location in `request.cf`, which collection
stores. We measured it on 2026-11-15 with `"region": "aws:eu-central-1"` and a request from Thailand: the Worker ran in
Frankfurt (`cf-placement: remote-FRA`), and `request.cf` still held the caller's country, city, coordinates and
timezone, with `colo` naming the data center the request came in at. That is one measurement, not a promise from
Cloudflare, so check your own deployment:

1. Deploy. With `region` it applies at once; with `mode: "smart"`, use the dashboard for a while first.
2. Look at the `Server-Timing` header of `GET /api/home` in the browser's network panel. `placement` names where the
   request ran (`remote-` plus an airport code when it moved), and `total` should fall.
3. Open a page of one of your sites from where you are, then the live globe (`GET /api/live`). Your visit must show
   your own country and city. If it shows the database's country instead, remove the line and deploy again.

To undo it, delete the line and deploy. The committed `wrangler.jsonc` has no placement: a deployment whose readers sit
near the database gains nothing from it, the right region depends on where your database is, and the location result
above comes from one deployment.

D1 read replication is the other tool for readers far away: Cloudflare keeps read-only copies of the database in other
regions ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)). Those copies hold
all of the data, customers' too, in those regions. Check how a database created with a jurisdiction (`--jurisdiction
eu`) places its copies before you rely on it for an EU promise (docs/PRIVACY.md). FounderData does not use the Sessions
API that replicas need, so switching replication on changes nothing today: every query still goes to the primary.

### Server timing

Every `GET /api/...` answer has a `Server-Timing` header, which the browser's network panel shows under Timing:

- `total`: milliseconds from the first middleware to the answer. The Worker's clock moves only while it waits, so this
  is almost all D1 (and the exchange rate API, on the rare read that has to fill a gap).
- `d1`: the D1 round trips the request waited for one after another, with the number of calls in its description. The
  reads a request starts together leave in one batch, so the two numbers are usually the same.
- `sql`: D1's own time for the request's statements, summed, with the rows they read in its description. `total` minus
  `sql` is mostly the network between the Worker and the database.
- `placement`: where Smart Placement ran the request, when it is on.

`test/round-trips.test.ts` holds Home, the overview, Pulse, the phone's summary, the site list and the live globe to
their counts on the demo data, so a change that adds a round trip fails the tests.

Payments in another currency are converted when their webhook records them. The reads also convert what that missed
(a rate API outage, or an App Store purchase sent by the app). Each Worker instance remembers the newest payment it has
checked, so a read looks only at the payments recorded after it; a fresh instance checks them all once.

### Setup checklist

Settings, Setup checklist lists every integration with a live status (Working, Needs a look, Broken or Off) and the next step.
It is for owners. The viewer login and a phone token get 403, and an API key gets 401. After a deploy, open it and work down
the rows. Core has the cron, payment webhook and email rows. The DataForSEO, Google, X, Meta ads, Apple Search Ads, App
Store sales, push and AI engine rows and the Test buttons come with Pro. It covers:

- **Cron ticks.** When the `*/5 * * * *` cron last ran, and whether the old hourly cron, `0 * * * *`, is still listed.
  The cron writes a heartbeat at minutes 0, 15, 30 and 45 of each hour. A first deploy shows "No heartbeat yet" until the
  first one. The row says Working while the last heartbeat is under 35 minutes old, which survives one missed run. With both
  crons listed the row says Needs a look. Remove `0 * * * *` from `triggers.crons` and deploy again. With only the hourly
  cron, first ranks take up to an hour.
- **DataForSEO login.** The two secrets by name, and a Test button that calls DataForSEO's `/appendix/user_data`. That call
  should cost nothing. We have not confirmed it with DataForSEO, so check your DataForSEO usage after the first test.
- **DataForSEO location codes.** One Broken row per site and country (Google ranks, or one App Store country) whose
  location or language code DataForSEO refused, with its message. The same message shows on that country's row in the Ranks
  settings and the App Store tab. The row appears only while the setting still has that code: it disappears when you remove
  the country, turn tracking off or delete the keywords. It clears when DataForSEO accepts a check for that country, or
  when you save a different location or language. Saving the same code again keeps it.
- **Google sign-in.** The exact redirect URI to paste into your Google OAuth client, built from the address you opened the
  dashboard on, with a copy button. It shows before the secrets are set, so you can fill in Google Cloud first. See
  [Connect Google](SEO.md#connect-google).
- **X bearer token.** A Test button that calls X's `GET /2/usage/tweets`. That call should cost nothing. We have not
  confirmed it, and X bills reads per post, so check your X usage after the first test.
- **Meta ads.** Whether `META_ACCESS_TOKEN` is set. Per site with an ad account, when the last import ran and its error,
  a warning when Meta counted link clicks in the last 7 days and no visit carried an ad id, and the URL parameters with a
  copy button. Per site with a dataset, the Conversions API's sent and skipped events of the last 7 days, the most common
  skip reason and Meta's last refusal. See [Meta ads](#meta-ads-pro).
- **Apple Search Ads.** Which secrets are set, then the last import. The row is Broken when Apple refused the last import
  (it shows Apple's message, such as `invalid_client`) or when the last import is more than 36 hours old. A refused key
  needs a new API user key in Apple Ads, Settings, API. Agents see the same error in each site's `sources` and in
  `get_apple_search_ads` with `view: "campaigns"` ([API.md](API.md#apple-search-ads-per-campaign-pro)).
- **App Store sales, push, AI engine keys, email.** Which secrets are set, by name. With some but not all of
  an integration's secrets set, the row says which are missing. A deployment needs one AI engine key, not all.
- **Payment webhooks.** For each site and each provider with a signing secret: when the last payment arrived through it, and
  whether deliveries failed the signature check in the last 24 hours. It shows the last payment, not the last delivery,
  so a provider that sends only events FounderData ignores looks quiet until a payment arrives.

Loading the list calls nobody and writes nothing. It reads one row per site and payment provider with a signing secret,
from the payments index. A test runs only when you press its button, from the dashboard, and waits 15 seconds
between presses. Each call has a 5 second timeout. A secret never appears, by value or by prefix. The routes are in
[API.md](API.md#setup-checklist).

### Set up integrations

Every integration is optional. Each one needs an account or key that only the owner has, so set up the ones they want and
skip the rest. Set a secret with `node scripts/wrangler.mjs secret put <NAME>` in a terminal. It asks for the value, so
the secret never shows up in a chat or a shell history.

| Integration | Turns on | The owner gets | Secrets and steps | Guide |
| --- | --- | --- | --- | --- |
| Payments | Revenue per visitor and source | A signing secret from Stripe, Dodo, Lemon Squeezy, Polar, Paddle or Gumroad | Webhook URL in the provider, signing secret in the site's settings | [Stripe](#revenue-attribution-with-stripe), [Dodo](#revenue-attribution-with-dodo-payments), [others](#revenue-attribution-with-lemon-squeezy-polar-paddle-and-gumroad) |
| Email alerts | Alerts and the weekly report by email | A Resend key, or Cloudflare Email Routing | `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | [Alerts](#alerts-and-weekly-report) |
| DataForSEO (Pro) | Google rank tracking and keyword research (SEO tab), App Store ranks without a Mac (ASO tab), Google AI Overviews and Perplexity (AI visibility tab) | The API login and API password from the DataForSEO dashboard. The API password is not the account password. The account needs a balance | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, then press Test on the checklist's DataForSEO row. Per site: the country and monthly cap under SEO, Google ranks, then keywords | [SEO.md](SEO.md#keyword-research-and-rank-tracking), [ASO.md](ASO.md#ranks-without-your-mac) |
| Search Console (Pro) | The SEO tab's clicks, queries, pages and decay | A Google Cloud project with an OAuth client of type Web application | Paste the redirect URI from the checklist's Google row into the client, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then the owner clicks **Connect Google** in the SEO tab and picks a property per site | [SEO.md](SEO.md#connect-google) |
| ASO collector (Pro) | App Store ranks, the top 10, ratings and reviews per country | A machine that is not on Cloudflare, such as their Mac | Keywords and countries in the ASO tab, `node scripts/aso-collect.mjs --probe`, then a daily schedule. Reviews and ratings need it even when DataForSEO checks the ranks | [ASO.md](ASO.md#set-it-up) |
| Apple Search Ads (Pro) | Ad spend and ROAS, and Apple's popularity score in the ASO tab | An API user in Apple Ads with a public key uploaded | `ASA_CLIENT_ID`, `ASA_TEAM_ID`, `ASA_KEY_ID`, `ASA_PRIVATE_KEY`, optional `ASA_AD_ACCOUNT_ID` | [Apple Search Ads](#apple-search-ads-pro) |
| App Store sales (Pro) | Downloads, proceeds and Apple's cut | An App Store Connect team key with the Sales and Reports role | `ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_VENDOR_NUMBER` | [App Store sales](#app-store-sales-pro) |
| AI visibility (Pro) | How often assistants name the site | One key or more, each with a spend limit at the provider | Any of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`. DataForSEO adds Google AI Overviews. Then prompts, names, engines and a cap in the AI visibility tab | [AI-VISIBILITY.md](AI-VISIBILITY.md#set-it-up) |
| Meta ads (Pro) | Spend, ROAS and the Conversions API | A system user token with `ads_read` | `META_ACCESS_TOKEN`, then the ad account and URL parameters in the site's settings | [Meta ads](#set-up-meta-ads) |
| X posts (Pro) | Visitors and revenue per post | A bearer token from the X developer console | `X_BEARER_TOKEN`, then press Test and type the handle in the site's settings | [Which post paid](#which-post-paid-pro) |
| Resend email stats (Pro) | Sent, delivered, bounced and opened per site | A Resend webhook | `RESEND_WEBHOOK_SECRET` | [Email (Resend)](#email-resend-pro) |
| Push (Pro) | Notifications on the iPhone app | An APNs auth key | `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` | [Phone app and push](#phone-app-and-push-pro) |
| Mail (Pro) | Sending and receiving on the owner's domains | Workers Paid, and a domain whose DNS is on the same Cloudflare account | `npm run setup -- --mail`, then `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then a domain on the Mail page | [MAIL.md](MAIL.md#set-it-up) |
| Recordings (Pro) | Recordings of visits in People | R2 on the Cloudflare account | `npm run setup -- --replay`, then Record visits in the site's settings, Data and privacy | [People and recordings](#people-and-recordings-pro) |
| Plan agent (Pro) | An AI agent that works each site's plan on a schedule | An agent tool that runs a prompt on a schedule, and a FounderData key with `read`, `read:revenue`, `notes:write` and `research:write` | The steps on the Plan tab's **Runs by itself** card | [Run an agent on a schedule](#run-an-agent-on-a-schedule-pro) |

One DataForSEO login serves every site, and each site has one monthly DataForSEO cap. Google ranks, keyword research,
App Store ranks without a Mac, AI Overviews and Perplexity through DataForSEO all spend from that cap. Set it to what
they need together. A cap of $0 stops all of them.

When you're done, open the [setup checklist](#setup-checklist), or call `GET /api/setup` with the owner's login. Each
integration the owner chose should say Working. The rest should say Off. Fix each row that says Needs a look or Broken
by following its `next` step.

### Viewer login

For a colleague who should see the dashboard but not change it, set a second password:

```bash
openssl rand -base64 18 | node scripts/wrangler.mjs secret put VIEWER_PASSWORD
```

Signing in with it opens a read-only dashboard. Every request other than GET gets HTTP 403, so a viewer can't edit
settings, erase people, add notes or funnels, or delete anything. The write key, webhook secrets, share links, read
keys, alert channels and devices stay hidden. Names, emails and user ids show as empty; set the variable `VIEWER_PII`
to `1` if the viewer needs them, which also allows the raw CSV exports. `GET /api/auth/me` answers
`{ "loggedIn": true, "role": "viewer" }`, and the dashboard hides its write buttons.

The viewer cookie is bound to `VIEWER_PASSWORD`: changing it signs out every viewer and leaves the owner signed in.
Removing the secret turns the viewer login off. Use a different password from `ADMIN_PASSWORD`; when both match, the
login signs in as the owner. Phones sign in with the admin password only. A phone sees names, emails and user ids,
because the owner's app locks itself with Face ID; set `PHONE_PII=0` to hide them on phones too. A phone never gets
a raw CSV export, so a lost phone does not hold your customer list as a file.

### Team (Pro)

For a co-founder or a colleague who should have their own login, add them under Settings, Team. You can revoke one
person without touching anyone else's access or the shared passwords.

1. Click **Invite**, type a name, pick **Viewer** or **Owner** and, if you like, an email address.
2. Copy the link and send it yourself. FounderData sends no email for this. The link works once and expires after 7
   days.
3. They open it and choose a password of at least 12 characters. That signs them in.
4. From then on they sign in with their name or email and that password. When a team exists, the login screen shows
   a name or email field. Leave it empty to use `ADMIN_PASSWORD` or `VIEWER_PASSWORD` as before.

A **viewer** sees what the [viewer login](#viewer-login) sees: every number, read-only, with names and emails hidden
unless `VIEWER_PII` is `1`. An **owner** can change everything and manage the team. Nobody on the team can remove
`ADMIN_PASSWORD`, which stays the root owner, and you cannot revoke or demote the login you are using.

**Revoke** deletes the person. Their browser fails on its next request, and the API keys, read keys and share links they
made from their own session are deleted with them. Revoking does not undo what they saw or copied. When an owner leaves,
rotate each site's write key, the webhook signing secrets and the alert webhook URLs, because the owner screens show
them in full. Keys and links made with `ADMIN_PASSWORD`, or before migration 0052, belong to no person. Delete those
yourself under Settings. Phone tokens belong to no person either. **Reset link** makes a new link, clears their
password and signs them out everywhere, for a forgotten password. The Team list shows each person's role, status
(invited, active or expired) and last sign-in. The last sign-in is written when someone signs in, not on every
request.

Sessions last 30 days. A teammate's cookie is signed with a key derived from `SESSION_SECRET` and carries the
person's id and a version number. Each request reads that person's row once, which is how a revoke takes effect at
once. Changing `ADMIN_PASSWORD` signs out the people who use it (their browsers and every phone) and leaves teammates
signed in. Changing `SESSION_SECRET` signs out everyone, teammates included. After a suspected leak, change that one.

Passwords are hashed with PBKDF2-SHA256 and a random salt per person. The hash runs at sign-in and when an invite is
accepted, never on an ordinary request. The default is 30,000 rounds, about 5 ms of CPU, which fits the Free plan's
10 ms a request. On Workers Paid, set the variable `PASSWORD_ITERATIONS` to a number from 10,000 to 100,000 (the most WebCrypto
accepts). At 100,000 a hash takes about 20 ms. When a teammate signs in and the stored hash has another round count,
FounderData rewrites it at the current target in the same request, so a change reaches everyone as they sign in.
Passwords need at least 12 characters.

Two limits slow guessing. An IP is locked out after 10 wrong tries in 15 minutes, and an IPv6 address counts as its
/64. That limit is shared with the shared passwords. One name or email is locked out after 20 wrong tries in an hour,
from any address. A correct sign-in clears neither count. So a stranger who knows a name can lock that person out for up
to an hour, and the `ADMIN_PASSWORD` login still works.

A teammate cannot pair the iPhone app. Pairing takes `ADMIN_PASSWORD`, so an owner who wants the phone needs it, and
a phone token is not revoked with a person. A teammate also has no way to change their own password or sign out
everywhere. They ask an owner for a reset link.

Limits: up to 50 people, every site for everyone (no per-site access), and no email delivery or single sign-on.
The people belong to the deployment, so deleting a site leaves them alone. Routes are in
[API.md](API.md#team-pro).

A custom domain such as `analytics.yourdomain.com` goes in Cloudflare, Workers & Pages, founderdata, Settings, Domains &
Routes. Use it everywhere this guide writes `https://founderdata.example.com`.

Open the dashboard, log in, add a website and copy its script tag. Each site's Settings page also has a **Copy AI
prompt** button: paste the prompt into Claude Code or Cursor and it does the install in that site's codebase.

### What the free plan covers

| Cloudflare free limit | What it means here |
| --- | --- |
| 100,000 Worker requests/day | One request per web event (pageview, goal, outbound click, engaged-time ping) and one per app batch of up to 50 events. The script and dashboard files are static and don't count. |
| 100,000 D1 rows written/day | The binding limit. See the table below: about 3,100 typical web visits a day, or 2,700 app sessions, or a mix. |
| 5M D1 rows read/day | A dashboard load reads roughly 10 times the sessions in the range, so with 10k visitors/month that's hundreds of loads a day |
| 5 GB D1 storage | Years of data at side-project traffic |

D1 counts each index entry it writes as a row. These are the rows each write path costs, measured on local D1 by
`test/cost.test.ts` for core and by a cost test in the Pro repository for Pro's write paths. Each test fails if a
number changes:

| Write path | D1 rows written |
| --- | --- |
| Web: first pageview of a new visitor | 11 |
| Web: each further pageview, goal or outbound click | 5 |
| Web: engaged-time ping | 1 |
| Web: `identify()` | 0 when no field changes, as on every page of a signed-in user. Otherwise 1 for the visitor row, plus 1 for each of email and user id the visitor has after the call (their indexes join one person's daily ids). Traits are a column of the same row: a call that changes only traits writes 1 |
| Web: the ping when a page of a recorded visit is hidden or left, with its clicks, rage clicks and errors ([People and recordings](#people-and-recordings-pro)) | 4 more (one `activity` event: the row, its 2 index entries and the id counter), 0 when the page had none |
| Recorded visit (Pro): the first chunk / each later chunk | 3 (its row in `replays` and 2 index entries) / 0. Each chunk is 1 Worker request, about one every 30 seconds of the visit, and 1 R2 write |
| Web: the ping when a page is hidden, with that page load's Core Web Vitals ([Page speed](#page-speed)) | 2: the ping and 1 row in `vitals`. At a lower sample, 1 for the loads it skips |
| Web: a running experiment ([Experiments](#experiments-pro)) on the visit's first pageview / on the first later pageview that reaches it | 0, a column of the session row / 1 per experiment, once per visit |
| Experiment (Pro): created, changed, started, stopped or deleted | 2: its row and the site's list of running experiments |
| Survey answer ([Surveys](#surveys)) from the survey card or `founderdata('answer', ...)` | 2: the answer and the visitor's traits. 1 when the trait did not change. Each answer is 1 Worker request |
| Survey card shown (Pro) | 0. It reads the visitor row on each page view while a survey is on. `/js/survey.js` is 1 request, cached |
| Cancel reason from a Stripe or Polar webhook | 1, plus 1 when the subscription has a visitor. The webhook request is already counted |
| Web: click map of one page view ([Click maps](#click-maps-and-scroll-depth-pro)), in the ping it already sends | 1 at the default 100% sample, plus 1 each time the visitor comes back to the tab and clicks more. 0 with click maps off |
| Web: scroll depth of one page load | 0, a column of the page speed row |
| Web: errors of one page view ([Errors](#errors-pro)), in the ping it already sends | 1 per distinct error, 5 at most, plus 1 the first time an issue appears. 0 without errors |
| Error issue (Pro) resolved, ignored or reopened | 1 |
| New error alert rule (Pro), checked hourly | As any rule: 1 when it fires, plus 1 [inbox](#alert-inbox-pro) row per alert |
| Reading lifecycle, retention, paths, experiment results, error issues or a click map (Pro) | 0 |
| App: new install's first `session_start` | 7 (6 with a kept install id: consent or `.vendor`) |
| App: relaunch on the same day without consent, `session_start` only | 3 within 30 minutes of the last activity (the session continues), 5 later |
| App: screens and goals in one batch | 3 each, plus 2 per batch (the session update and the id counter) |
| App: batch of 10 screens / 50 screens, one session | 32 / 152 |
| App: typical session, known install (start, 8 screens, 2 goals, ping) | 36 |
| App: session properties on `session_start` (`setSessionProperties` before the first screen) | 0 extra (7 for a new install, as without) |
| App: `session_props` event, alone / in a batch with other events of its session | 1 / 0 extra |
| App: `onboardingStep` goal | 3, like any goal |
| App: consented install (`ctx.consent`) | 0 extra, 1 fewer for the first `session_start` |
| App Store purchase (app event or notification) | 6, a repeat delivery 0 to 1; 7 for a subscription (its row in `subscriptions`). Each payment credited to a visitor counts 1 for its entry in the index that tells the [live globe](MOBILE-API.md#9-live-visitors) who has paid before |
| App Store free trial from the app (a `trial_start` signal, no payment) | 3, a repeat delivery 1; 5 with the subscription's row and its entry in the trial index |
| App Store auto-renew off or on, failed renewal, expiry (notification) | 1, plus 1 [inbox](#alert-inbox-pro) row when a paying subscription fails to renew or is canceled |
| App Store sales import (below): a day with 20 sales rows, first import / re-import | 63 / 82 |
| Apple Search Ads import (below): 1 campaign and 2 keywords over 3 days, first import / unchanged re-import | 13 / 1 |
| Meta ads import ([below](#meta-ads-pro)): 3 ad-days, 4 names and the 7-day frequency of 1 ad, first import / unchanged re-import | 11 / 1 |
| Ad spend sent with `POST /api/v1/spend` or a CSV ([above](#ad-spend-from-other-channels-pro)): a new or changed row of a day and campaign / a row sent again unchanged / a row deleted | 1 / 0 / 1. The Google Ads Script resending 7 days of 5 campaigns writes 5 to 10 rows a day. Meta and Apple Search Ads join in from their imports and write nothing more |
| Meta Conversions API: an event sent or skipped / a tick with nothing pending | 1, plus 1 for the site's status when it changes / 0 |
| Stripe payment / Stripe refund | 5 / 7 (the refund keeps the charge's state in `stripe_objects`), a repeat delivery 0 |
| Stripe subscription payment (`invoice.paid`) | 9: the payment and its invoice id in `stripe_objects`, and the subscription's row |
| Stripe `customer.subscription.*`, `invoice.payment_failed`, a subscription Checkout | 1 each (2 when it creates a subscription with a trial: the trial index), a repeat delivery 0. A failed payment or cancellation of a paying subscription adds 1 [inbox](#alert-inbox-pro) row |
| RevenueCat purchase / refund | 6 / 4 (a subscription purchase updates its row), a repeat delivery (or a purchase the SDK already sent) 0 |
| RevenueCat trial start / cancellation, expiration, billing issue | 4 (the signal, the subscription's row and its entry in the trial index) / 3 each (the signal and the subscription's row), 4 for a paying subscription (its [inbox](#alert-inbox-pro) row) |
| Lemon Squeezy, Polar, Paddle or Gumroad payment / refund | 5 / 4, a repeat delivery 0 |
| Dodo payment / a subscription's payment / a subscription event / a cancellation, expiry or failed renewal | 5 / 6 (the subscription's row) / 1 / 3 (the signal and the row), 4 for a paying subscription (its [inbox](#alert-inbox-pro) row), a repeat delivery 0 |
| A payment that fills its visitor's empty email or name | 1 more for the visitor row, plus 1 for each of email and user id the visitor has after it (2 for a first email). 0 when both are already set |
| Lemon Squeezy, Polar, Paddle or Gumroad cancellation, trial, expiration, billing issue | 3 each (the signal and the subscription's row), 1 more when a trial creates the subscription (the trial index), 1 more for a paying subscription's cancellation or failed payment (its [inbox](#alert-inbox-pro) row) |
| Other revenue (`POST /api/v1/payments` with `"kind":"income"`) | 4 |
| Other revenue or a refund corrected (sent again with another amount) / deleted (`DELETE /api/v1/payments/...` or the dashboard) | 1 / 1 per row deleted |
| Stripe history import (below) | 7 per imported charge (the payment and its charge id in `stripe_objects`), 1 per step, 0 for a charge already stored |
| History import from Plausible or DataFast ([IMPORT.md](IMPORT.md)) | 1 per stored day-row (about 4,400 for a year with every panel), plus 1 per chunk of up to 100 rows and 3 to start. Its own allowance of 20,000 rows a day, outside the tracker's cap |
| X posts: a read that finds N posts linking to the site / a read with nothing new / a post added by hand | N + 2 (the claim, the posts, the settings row) / 1 (the claim) / 1. Matching writes nothing |
| Daily write cap counter (below) | 2 per 200 rows the tracker and app endpoints write (the site's count and the shared total) |
| ASO snapshot from the collector (below), one app in one country, any number of keywords | 1, plus 1 the first time it stores the app's id; a second snapshot the same day 1 |
| ASO reviews / keywords / countries or competitors | 1 per new review, 0 for one stored, plus 1 [inbox](#alert-inbox-pro) row for a post with a review that alerts / 1 per keyword, plus 1 for the first settings row / 1 |
| ASO popularity, once a week | 1 per keyword and country, plus 1 status row |
| Chart note (`POST /api/v1/notes`, the dashboard or the version cron) / its review (`POST /api/v1/notes/<id>/review`) | 3, 4 with an `idempotency_key`, a repeat 0 / 1, a second review 0 |
| SEO snapshot: one part pushed, with the login or a `seo:write` key | 2 for a new part, 1 to replace it |
| Research log entry (`POST /api/v1/research`) | 1, 2 with an `idempotency_key`, a repeat 0 |
| Setup checklist: the cron heartbeat / a test button pressed / a refused location code stored | 1 at most every 10 minutes, so 4 an hour and 96 a day / 2 (the rate limit row and the outcome), 0 inside 15 seconds / 1 a day per refused country, 0 for the same message again, 1 to clear it. Reading the checklist writes 0 |
| Tracking start: the nightly scan for each site's first web and app visit | 1 for a site the night its first web or app visit is found, else 1 a week while one is unknown (an app without a web tracker stays there), 0 once both are known. Reading `tracking_since` or `sources` writes 0 |
| Google rank tracking ([SEO.md](SEO.md#keyword-research-and-rank-tracking)): a keyword added / its daily check posted / its result collected / bought keyword research | 1, plus 1 for the site's first settings row / 1 per keyword, plus 1 for the spend counter per call / 1 / 2 (the counter and the research log entry), 0 when the research log already has it |
| AI answer check (`POST /api/v1/ai-answers`), per prompt, surface and day | 1, new or replaced: 60 for a run of 10 prompts on 6 surfaces |
| AI visibility ([AI-VISIBILITY.md](AI-VISIBILITY.md)): settings saved / a prompt saved | 1 / 1, a prompt already saved 0 |
| AI visibility: a run of N checks on one engine, one site | N + 1 (each answer, and the month's spend once per site and engine); a failed run 1 when its error is new, else 0 |
| AI visibility: the first run of a day that finds no check left for a site / a prompt added after that | 1 (the done mark), 0 for the later runs of the day / 1 more (clears the mark) |
| AI visibility, Perplexity check through DataForSEO / on its own key (`PERPLEXITY_API_KEY`) | 3 (answer, AI spend, DataForSEO counter) / 2 |
| AI visibility, a Google AI Overview check: posted / collected | 2N + 2 for N prompts in one post (a claim and a task id each, the AI spend, the DataForSEO counter) / 2 (the answer, the deleted claim) |
| AI visibility, one sentiment rating (`sentiment_per_day`, off by default, up to 500 a site and day) | 2 (the label on the answer, the AI spend) |
| AI crawler hits (`POST /api/sites/<id>/crawler-hits`) | 1 per distinct day, bot, page and status in the request, however many hits it holds; 500 hits on one page are 1 |
| Scoped API key (Settings, Agents): creating one / its usage | 1 / 1 a minute per key and Worker instance at most, whatever the number of calls |
| Primary goal saved or cleared in Settings (below) | 1; counting it writes nothing |
| Threshold alert rule: new / changed or deleted / fired, back over its line, a change judged or a test send / a quiet hourly check | 2 / 1 / 1, plus 1 [inbox](#alert-inbox-pro) row per alert it sent / 0 |
| Stripe check ([below](#check-mrr-against-stripe-pro)): a finished check / a second one the same day / a step before the last / reading the history | 1 (the day's history row) / 1 (it replaces the row) / 0 / 0 |
| Daily numbers at 07:00 UTC, per channel | 2 (the day's marker, then sent), plus 1 for each retry of a refused send; a second trigger or a later tick writes 0 |
| Weekly report on Monday at 07:05 UTC, per channel | 2 (the week's marker, then sent), plus 1 for each retry; 1 [inbox](#alert-inbox-pro) row per site a week |
| Alert inbox ([above](#alert-inbox-pro)): Worth a look, payments stopped, the ASO collector, refused webhooks, the write cap, a low review, mail problems | 1 per message and site, also with no channel. A day with nothing to say writes 0 |
| Next actions ([above](#next-actions-pro)): the daily run on the minute-50 tick | 2 per site a day (the claim, then the items); reading them 0 |
| Phone pushes at 08:00 (the daily one, the Monday one) | 1 per push and day for any number of phones; the other hourly runs 0 |
| Phone: a push switch or the renewal threshold (`PUT /api/mobile/notifications`) | 1 |
| Resend email event (`POST /api/webhooks/resend`): the first of its type for an email / a retry, a second open or click, or a sender on no site's domain | 2 / 0 |
| Resend email cleanup, daily: an email past 30 days | 1 |
| Mail ([MAIL.md](MAIL.md)): an app sends to one address (`POST /api/mail/emails`) / with an `Idempotency-Key` / the same key and body again | 18 (10 when stored, 8 when Cloudflare took it), plus 2 for each further address and 1 for each attachment / 21 / 0 |
| Mail: the dashboard or an agent sends / a reply in a thread | 23 from the dashboard and 24 from an agent (the send, and 6 for the thread it starts) / 21 from the dashboard and 22 from an agent |
| Mail: a send with a template / create a template / change its draft / publish it | 1 more than the same send without one / 3 / 1 / 3 |
| Mail: a status event from Cloudflare, such as delivered / the same event again | 5 (the message, and 4 for its event row), plus 1 or 2 in the Email panel's counts when the domain is linked to a site / 0 |
| Mail: a received message that starts a thread / one that joins a thread | 15 / 14, plus 1 for each attachment. The `email()` hook itself writes none |
| Mail: a webhook delivery queued / each attempt | 4 / 1, or 2 when the endpoint's failure count changes |
| Mail: a thread marked read / archived / reading the inbox, the sent log or a message | 1 for each unread message, plus 1 / 1 / 0 |
| Mail health, once an hour at minute 20 ([MAIL.md](MAIL.md#health-alerts)): an hour with nothing to check or report / a domain's daily check / an alert / a received message that could not be read, or that the hourly sweep puts back on the queue or deletes | 0 / 1 for the domain's status, plus 1 when its problems change / 2 (its alert inbox row and its dedupe row) / 1 |
| Phone: a Live Activity token, new or changed / the same again / switched off (`/api/mobile/live-activity`) | 1 / 0 / 1 |
| Live Activity update on a payment or refund / the 08:00 start | 1 per phone with a running activity, at most once a minute / 0, it rides on the daily push's row |
| Payment webhook refused for a bad signature or token (401) | 1 for the first, then at most 1 per site and provider every 10 minutes per Worker instance (`test/privacy-ops-r3.test.ts`) |

A typical web visit (3 pageviews, 1 goal, 3 pings) costs 32 rows and 7 requests: 29, plus 3 for the page speed of its
3 page loads. A typical app session costs 36 to 38 rows and 1 or 2 requests, because the SDK sends batches. So 1,500
web visits, 1,000 app sessions and 50 payments a day across all sites come to about 85,550 rows and 12,550 requests,
under both limits. Cookieless tracking writes
nothing extra; it reads one indexed row on the first event of each page. If you outgrow the free plan, Cloudflare's
Workers Paid plan is $5/month.

### Daily write cap

The tracker and app endpoints are public. Anyone who reads a site id from a script tag can send events, and a fake
Chrome user agent gets past the bot filter. Without a ceiling, a script that sends fake events could use up the free
plan's 100,000 rows for the day, which stops tracking until midnight. On Workers Paid it would run up the bill instead.

Each site has a daily write cap, on by default. Once the site has used up its cap today (UTC):

- website events are dropped. The tracker gets a `202` as if nothing happened.
- app batches get a `429` with `Retry-After` set to the seconds until 00:00 UTC. The SDK keeps them in its queue and
  sends them after the reset, so nothing from the app is lost unless the queue fills up.
- payment webhooks, App Store notifications and `/api/v1` calls still go through. They are signed or need the API key.

The site's dashboard shows a banner with the time the cap was reached, and its card on the home page says
**Capped**. Settings, **Daily write cap**, has the switch, the number and today's count.

The automatic cap is a shared pool: all sites write up to 80,000 rows a day together (80% of the free plan). A site on
automatic is over its cap when the pool is used up, so a busy site can use what quiet sites leave. With more than one
site, one automatic site can use at most half the pool, 40,000 rows, so a flood of fake events on one site leaves the
others at least 40,000. With 11 sites, one site can write 40,000 rows while the other ten write 4,000 each. When the
pool runs out, every site on automatic stops until 00:00 UTC.

A site with its own number stops at that number. Its rows still count toward the 80,000, and so do the rows of a site
with the cap off. So a big number on one site leaves less for the sites on automatic. Give a site its own number to
keep its traffic apart from the others: a flood of fake events then stops at that site's number instead of using up
the pool. With the cap off, the site still counts its rows, so turning it on later starts from today's real number.

On Workers Paid, set the pool to the rows you are willing to pay for, once for every site. Two Worker vars change the
automatic cap, under `vars` in `wrangler.local.jsonc` (copy `wrangler.jsonc` first if you have none):

```jsonc
"vars": {
  "WRITE_POOL_ROWS": "1000000",     // rows a day the automatic sites share; 80,000 when unset
  "WRITE_SITE_MAX_SHARE": "0.25"    // with more than one site, the share of the pool one site may use; 0.5 when unset
}
```

Then deploy again (`npm run setup` or `npm run deploy`). A missing or invalid value keeps the default. A lower share
protects more sites from one flood: at 0.25, two flooded sites still leave half the pool to the others. Workers Paid
includes 50 million D1 rows written a month and bills $1 per million after that, so a pool of 1,000,000 a day (30
million a month) stays inside the included rows. Check Cloudflare's D1 pricing page for current numbers.

The home page shows today's total under the site cards: "Rows written today: 23,400 of 80,000". It counts the rows of
tracker and app events of all sites, the number the pool is checked against.

Every Worker instance counts in memory and adds its count to `site_usage` every 200 rows: one row for the site and
one row (`site_id` `*`) for the shared total, so the cap costs 2 rows per 200. An instance learns what the others
counted each time it adds its own. So a site can go past its cap by up to 200 rows for each running Worker instance.

When an app sends events to a site that has no bundle id, the server answers `403` and the site's dashboard shows a
banner for 24 hours. Recording that costs 1 row per site at most every 10 minutes per Worker instance.

For scripts: `GET /api/sites/:id` returns `usage` with `rows` (the site's rows today), `cap` (its own number, the pool
size on automatic, or `null` with the cap off), `site_max` (on automatic with more than one site, the share of the pool
one site may use, else `null`), `auto` (the pool size, 80,000 or `WRITE_POOL_ROWS`), `shared` (on automatic),
`pool_rows` (all sites today), `capped_at` and `resets_at`. `GET /api/sites` returns `capped_at` per site, and `app_rejected_at` for a site
without a bundle id whose app was refused in the last 24 hours. `GET /api/usage` returns
`{ "capped": { "<site id>": <ms> }, "pool": { "rows", "size", "capped_at", "resets_at" } }`: the sites capped today, and
the rows all sites wrote today against the pool. It reads one row more than before. `GET /api/sites/:id` also returns `last_payments`,
the time of the last payment per provider (`stripe`, `dodo`, `revenuecat`, `app_store`, `api`), which Settings shows on
each payment card, and `refused_webhooks`: per provider, `{ "count", "day", "at" }` for deliveries refused with a bad
signature in the last 24 hours ("Alerts and weekly report").

The retention cron (`17 3 * * *`) deletes visit data older than `RETENTION_MONTHS` (24 by default) and, when
`PII_RETENTION_MONTHS` is set, clears older names and emails ([PRIVACY.md](PRIVACY.md#retention-settings)). A
payment keeps a copy of its visit's channel, source and campaign. After the visit is gone, Home, the Monday report, the
source breakdowns and a filter on channel, source or campaign still credit that source. A filter on anything else
about the visit, such as country or device, leaves the payment out. The cron also deletes wrong-password rows older
than the 15-minute lockout. Every cron run deletes the key of a Stripe import that made no step for an hour. The App
Store sales cron (`30 10 * * *`) imports the last three days again; it does nothing until the `ASC_*` secrets exist.

## Install on a website

```html
<script defer data-website-id="SITE_ID" src="https://founderdata.example.com/js/script.js"></script>
```

- **Button clicks / goals:** `<button data-rt-goal="signup_click">`, or `window.founderdata('goal', 'signup', { plan: 'pro' })`.
  Properties go in extra attributes: `data-rt-goal-plan="pro"`.
- **Identify logged-in users:** `window.founderdata('identify', { user_id, email, name })`, see [Identify people](#identify-people)
- **Ignore your own visits:** open `https://yoursite.com/?rt_ignore=true` once per browser
- **Single-page apps** (Next.js, React Router…) are handled automatically
- **Subdomains:** `app.yoursite.com` and `yoursite.com` count as the same visitor in both modes below
- **Cookies:** off by default; see [Cookies and consent](#cookies-and-consent)

### Cookies and consent

By default the script sets no cookies and stores no identifier in the browser. Many sites need consent before
they store an identifier on a visitor's device (in the EU, Article 5(3) of the ePrivacy Directive on top of the GDPR), and this default needs none.
The script writes to `localStorage` in one case: when you open a page with `?rt_ignore=true` to exclude your own
visits, it stores `rt_ignore=1` in that browser, and `?rt_ignore=false` removes it. It holds no id and is never sent
anywhere. Visitors who never open such a link get nothing stored.

**Without cookies (default).** The server computes the visitor id as a hash of the site id, the visitor's IP address and
the browser's user agent, salted with a secret that changes every day at 00:00 UTC. It never stores the IP address or
the user agent, and nobody can link Monday's id to Tuesday's without the secret ([PRIVACY.md](PRIVACY.md#the-visitor-id)
says what the secret protects and what it doesn't). A visit lasts while the visitor is active at least every 30 minutes.
What you give up:

- A visitor who comes back after midnight UTC (evening in the Americas, 01:00 or 02:00 in central Europe) counts as new. Returning visitors, "time to
  convert" and the last-non-direct credit only reach back to the start of that day. For a person you `identify()`,
  the credit reaches every visit under the same user id or email.
- Two people on one network with the same browser and version count as one visitor that day.
- A payment made the same day links to the visitor through the checkout metadata below. A buyer who pays on a later
  day is linked only through an email you `identify()`'d or an earlier payment.

**With cookies.** Add `data-cookies="on"` to the script tag on every page once the visitor has consented, or call
`window.founderdata('consent', true)` from your consent tool. The script then keeps `rt_vid` (1 year) and `rt_sid`
(30 minutes) on your root domain, plus `rt_consent=1` so later pages keep using cookies. It keeps the ids of the
current visit, so consenting halfway through doesn't split the visit. `window.founderdata('consent', false)` deletes
all three. Without consent the script also deletes `rt_vid` and `rt_sid` left by older versions of the script.

**Marketing consent.** Separate from cookies, and needed only for the Meta Conversions API ([Meta ads](#meta-conversions-api)).
Call `window.founderdata('marketing', true)` when the visitor accepts your banner's marketing or advertising category,
or add `data-marketing="on"` to the script tag. The script then keeps `rt_mkt=1` (1 year) and marks the visit, so
FounderData may send that visitor's purchase to Meta. `window.founderdata('marketing', false)` deletes it and unmarks
every visit of that visitor FounderData can tie together (with cookies, all of them; without, those of the same day).
Marketing consent does not keep a visitor id: call `founderdata('consent', true)` as well when the banner allows it, or a
buyer who comes back the next day is a new visitor whose ad click FounderData cannot find. Without it nothing goes to Meta in the default setting.

**Remember visitors (Pro setting).** A site can keep every visitor in cookies without the visitor's consent. Turn on
**Remember visitors** in Settings, Data and privacy. The server then tells the script on each page, and
the script keeps `rt_vid` and `rt_sid` as above, with `rt_consent=r` in place of `rt_consent=1`. People stay the same
person across days without `identify()`. In the EU that usually needs consent, so turn it on only where you have it or
don't need it. A page that calls `founderdata('consent', false)` keeps that visitor without cookies. Turn the switch off
and each visitor's cookies go on their next page.

**Ids for checkouts.** `window.founderdata.attribution()` returns `{ rt_visitor_id, rt_session_id, rt_site_id }` in
both modes. Without cookies the ids come back with the first request, a fraction of a second after the page loads;
until then it returns `{}`. Send them from the browser with your checkout request and put them in the checkout's
metadata. The server can't read them from a cookie unless cookies are on.

### Erase one person

When someone asks you to delete their data (GDPR Article 17), open their profile from the Visitors or Customers tab and
click **Erase this person**. With an email or user id on the profile, it erases every visitor with that email or user
id, plus payments with that email. A user id also clears the RevenueCat payments and subscriptions filed under that app
user id, even when no visitor links them. Otherwise it erases the one visitor id. From a script, use
`DELETE /api/sites/<id>/visitors/<visitor_id>` or `POST /api/sites/<id>/erase` with `{"email": "..."}` or
`{"user_id": "..."}` while signed in, or the same calls under `/api/v1/` with the site's API key
([API.md](API.md#erase-one-person)). Add `"note": "ticket 4411"` (or `?note=` on the DELETE) to record your
reference.

| Data | What happens |
| --- | --- |
| The visitor row: email, name and user id from `identify()` | Deleted |
| Visits, with their source, pages, location and device | Deleted |
| Pageviews, goals, outbound clicks, and the clicks and errors of recorded pages | Deleted |
| Recordings (Pro): the files in the R2 bucket and their rows | Deleted |
| Return-page claims and subscription signals (trial starts, cancellations) | Deleted |
| Payments | Kept for your books, with the visitor, visit, the visit's source, email, name, customer id and match reason cleared. Revenue totals stay the same, and the payment no longer credits a source. |
| Subscriptions | Kept, with the visitor, visit, customer id and the visit's source cleared. MRR stays the same, and the subscription moves to No source. |
| Payments and subscriptions of another visitor id that were credited to one of the erased visits | Kept, with that visit and its source cleared. They move to No source. |
| App installs that came in through this person's link | Kept, without the link to the erased web visitor |

It can't be undone. It covers one site; erase on each site the person used. Your payment provider keeps its own copy
of the payment. Without cookies a visitor id lasts one day, so one person can have several visitor ids. Erase by email
or user id to catch them all, which needs `identify()` or a payment with that email. The daily cron deletes visits
older than `RETENTION_MONTHS` (24 by default) on its own.

Each erase adds a line to the erase log in Settings: the time, how the person was found (visitor, email, user id),
the rows removed per kind, who handled it (`admin` for the dashboard login, `api` for a script with the API key) and
your note. It keeps no visitor id, email or user id, so you can show when you answered a request without keeping the
person. Deleting a site keeps its erase log, with the site's name. `GET /api/sites/<id>/erasures` returns one site's
log as JSON, `GET /api/erasures` every site's, deleted ones included, and `?format=csv` either as a file.
[PRIVACY.md](PRIVACY.md) has the full data inventory and a GDPR checklist.

### Names from before the rename

FounderData started as a fork of [minilytics](https://github.com/surendrapandar/minilytics). The script and the server
still accept the old names, so a site that has not switched keeps working. Use the new names in new installs:

| Old name | New name | What still works |
| --- | --- | --- |
| `window.minilytics` | `window.founderdata` | the same function; calls queued on either run |
| `window.revtrail` | `window.founderdata` | the same function; calls queued on it run. Kept with no end date, because sites installed under that name read goals and checkout attribution from it |
| `ml_visitor_id`, `ml_session_id`, `ml_site_id` | `rt_visitor_id`, `rt_session_id`, `rt_site_id` | `attribution()` returns both sets; Stripe, Dodo, the payments API and the goals API read both |
| `data-ml-goal`, `data-ml-goal-*` | `data-rt-goal`, `data-rt-goal-*` | both send goals |
| `ml_vid`, `ml_sid`, `ml_consent` cookies | `rt_vid`, `rt_sid`, `rt_consent` | the script copies consented `ml_*` cookies to `rt_*` once and deletes the old ones |
| `?ml_ignore=true` | `?rt_ignore=true` | both |
| `client_reference_id=mlv_<id>` | `rtv_<id>` | the server reads both |
| `?ml_vid=` on universal links, `src.ml_vid` | `?rt_vid=`, `src.rt_vid` | the server reads both |
| API keys `ml_...` | new keys start with `rt_` | existing keys keep working |

### Tracking a specific tweet / article

X, Medium, LinkedIn and others hide which exact post sent someone; the referrer only says `t.co` or `medium.com`.
To see the exact post, tag each link. Settings has a link builder for this:

```
https://yoursite.com/?utm_source=x&utm_medium=social&utm_campaign=launch-tweet
https://yoursite.com/?ref=launch-tweet            (short version)
```

For SEO, Google never shares the search keyword, but **Entry page** with the **Google** referrer tells you which
article people found you through.

### Ad clicks other than Meta

Ad networks add a click id to the landing URL. Google Ads does it by default (auto-tagging) and adds no UTM tags, so
without the click id a Google Ads visit looks like organic search from google.com. FounderData reads these parameters
and counts the visit as channel **Paid**, with the network as the source:

| Parameter | Source |
| --- | --- |
| `gclid`, `gbraid`, `wbraid` | Google Ads |
| `msclkid` | Microsoft Ads |
| `ttclid` | TikTok Ads |
| `twclid` | X Ads |
| `li_fat_id` | LinkedIn Ads |
| `rdt_cid` | Reddit Ads |
| `ScCid` | Snapchat Ads |
| `epik` | Pinterest Ads |

A click id beats the referrer and the UTM tags, because only the network adds it. A Meta `ad_id` still wins, because it
names the ad. A link with two click ids counts for the first network in the table. An unfilled macro such as
`{gclid}` does not count. A click id that arrives on a later page of a direct visit makes the visit paid, and the first
click id a visit saw stays.

The raw id stays 90 days, then the daily cron clears it and keeps the network
([PRIVACY.md](PRIVACY.md)). Filter or break down by `click_network` (`google_ads`, `microsoft_ads`, `tiktok_ads`,
`x_ads`, `linkedin_ads`, `reddit_ads`, `snapchat_ads`, `pinterest_ads`) on the API and in `get_breakdown`. The iOS SDK
reads the same parameters from deep links and universal links. Meta and Apple Search Ads spend comes from their
imports. Spend for the other networks comes in through the API or a CSV, [below](#ad-spend-from-other-channels-pro).

### Ad spend from other channels (Pro)

MER, blended CAC and ROAS need every channel's spend. Meta and Apple Search Ads have imports. Google Ads, Microsoft Ads,
TikTok, Reddit, LinkedIn, X, a newsletter sponsorship or a podcast read arrive one of three ways:

- **A Google Ads Script** that sends each campaign's spend every morning. No developer token, no Google Cloud project.
- **A CSV** from the ads manager, uploaded in Settings, Ads and social, or sent to the API.
- **The API**, `POST /api/v1/spend`, from your own script or an agent ([API.md](API.md#ad-spend-pro)).

All three need a key with the `spend:write` scope for the site (Settings, Agents), except the upload in Settings. The
scope records spend and bills nothing. The paid report, `GET /api/v1/paid` and the MCP tool `get_paid`, then puts each
channel's spend next to the customers and revenue it brought ([API.md](API.md#paid-pro)). The Meta ads tab's MER and
blended CAC count it too.

**The Paid overview** (Paid, Paid overview, in a site's section row) shows the same report. The top row has ad spend,
new customers, blended CAC, MER, aMER, payback and the share of new customers credited to an ad, each against the
period before where one exists. MER, aMER and ROAS count App Store sales after Apple's cut, with the gross MER beside
it. Two charts show spend and new customers per day, with the ad changes from the Changes tab as markers. The channel
table has spend, its share, the platform's own conversions, then the visits, customers, revenue, CPA and ROAS
FounderData credited. Meta ads and Apple Search Ads open their sections. An ad network with a click id, such as
Google Ads, opens the Overview filtered to its ad clicks. Filters do not apply to this page, since MER and CAC count
every customer.

**Google Ads Script.** In Google Ads, open Tools, Bulk actions, Scripts, add a script, paste this, fill in the first
three lines, authorize it, and set it to run daily, after 03:00 in the account's timezone:

```js
// FounderData: send Google Ads spend per campaign and day. Runs inside your Google Ads account.
const FOUNDERDATA_URL = 'https://founderdata.example.com';
const FOUNDERDATA_KEY = 'fdk_...'; // a key with spend:write for this site (Settings, Agents)
const SITE_ID = ''; // only for a key that covers more than one site
const DAYS = 7; // Google corrects recent days; a day that did not change costs nothing

function main() {
  const account = AdsApp.currentAccount();
  const tz = account.getTimeZone();
  const day = (d) => Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  const from = day(new Date(Date.now() - DAYS * 86400000));
  const to = day(new Date(Date.now() - 86400000));
  const rows = [];
  const report = AdsApp.search(
    'SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, ' +
      'metrics.conversions, metrics.conversions_value FROM campaign ' +
      `WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.impressions > 0`,
  );
  while (report.hasNext()) {
    const r = report.next();
    rows.push({
      day: r.segments.date,
      channel: 'google_ads',
      account_id: account.getCustomerId().replace(/-/g, ''),
      campaign_id: String(r.campaign.id),
      campaign_name: r.campaign.name,
      spend_micros: Number(r.metrics.costMicros),
      currency: account.getCurrencyCode(),
      impressions: Number(r.metrics.impressions),
      clicks: Number(r.metrics.clicks),
      conversions: Number(r.metrics.conversions),
      conversion_value_micros: Math.round(Number(r.metrics.conversionsValue) * 1e6),
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const res = UrlFetchApp.fetch(`${FOUNDERDATA_URL}/api/v1/spend${SITE_ID ? `?site=${SITE_ID}` : ''}`, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${FOUNDERDATA_KEY}` },
      payload: JSON.stringify({ rows: rows.slice(i, i + 500) }),
      muteHttpExceptions: true,
    });
    Logger.log(`${res.getResponseCode()} ${res.getContentText()}`);
  }
}
```

It sends the last 7 days each morning, because Google corrects recent days as conversions come in. A day whose numbers
did not move writes no row. Set the Google Ads account's timezone to the site's, or a day's spend and visits land a day
apart. A manager account (MCC) runs one script per client account, or loops over `AdsManagerApp.accounts()`.

**CSV.** Export a report by day and campaign. Each one needs a day column and a cost column:

| Preset | Export from | Columns it reads |
| --- | --- | --- |
| `google_ads` | Google Ads, Campaigns, segmented by Day, Download, CSV | Day, Campaign, Campaign ID, Currency code, Cost, Impr., Clicks, Conversions, Conv. value |
| `microsoft_ads` | Microsoft Advertising, Reports, Campaign, by day | Date, Campaign name, Campaign ID, Spend, Impressions, Clicks, Conversions |
| `tiktok_ads` | TikTok Ads Manager, Campaign, breakdown By Day, Export | By Day, Campaign name, Cost, Impressions, Clicks (destination), Conversions |
| `reddit_ads`, `linkedin_ads`, `x_ads`, `snapchat_ads`, `pinterest_ads` | The ads manager's campaign report by day | A date column (Date, Start Date (in UTC), Time period), Campaign name, Amount spent, Total spent or Spend |
| `generic` | Anything else: a newsletter sponsor, a podcast | Date and Spend, plus a channel name you type in, or a Channel column |

Money in the file is in whole units such as `12.30`, or `12,30` from a German or French export. The currency comes
from a currency column, a code in the cost header (`Cost (EUR)`), or the site. A file holds up to 200 KB and 2,500
lines, about 80 days of 30 campaigns. Split a longer export into date ranges and upload each. The importer skips the title lines above the header and the total line at the end,
and adds up lines of the same day and campaign. Uploading the same file twice changes nothing. A newer export with
corrected numbers replaces the old ones.

**Which visits belong to a channel.** A Google Ads visit is one with a `gclid` (above) or a paid Google visit such as
`utm_medium=cpc`. A newsletter or podcast has no click id, so tag its links with `utm_campaign` set to the campaign name
or id you send with the spend. A visit with that `utm_campaign` counts for that channel.

Meta and Apple Search Ads rows are refused for a site that has their import, so no spend counts twice. Delete a wrong
channel in Settings, Ads and social, or with `DELETE /api/v1/spend?channel=google_ads`.

### First touch

Every source panel credits the visit a payment came from (last touch). FounderData also stores where each visitor came
from the first time: the source, channel, campaign, referring domain and entry page of the visit that created the
visitor. Add `model=first` to `GET /api/v1/stats/breakdown`, the dashboard's breakdown route or `get_breakdown` to credit
that first visit on `channel`, `source`, `campaign`, `referrer_domain` and `entry_page`.

In the dashboard, those tabs have **Last touch** and **First touch** buttons under the list once a payment provider is
connected. A row in the First touch view does not add a filter, because filters match the visit itself.

A visitor id lives for a day without cookies, so first touch reaches back as far as the visitor id does. With cookies,
`identify()` or the app SDK, that can be weeks. Visitors first seen before this was added count by their own visit.

### Datacenter visits

A browser that runs on a cloud server is almost always a bot: an uptime check, a scraper or an AI agent. Cloudflare
reports the network of every request. A visit from AWS, Google Cloud, Azure, DigitalOcean, Hetzner, OVHcloud, Linode,
Oracle Cloud, Vultr, Contabo, Scaleway, Alibaba Cloud, Tencent Cloud or Leaseweb gets a flag
(`src/worker/datacenter.ts`). Visitor and pageview counts leave it out: the overview, every breakdown and page panel,
funnels, Meta ads, note verdicts, Home, the weekly report, the live view and alerts. Payments still count. The sessions
CSV export keeps every visit and marks these with `datacenter` 1.

Settings, Privacy, **Datacenter visits** shows how many visits the flag caught in the last 30 days. Turn on **Count
datacenter visits** when real people reach the site through a cloud server, such as a company VPN. The flag stays on
each visit, so you can turn it off again.

A tracker you serve through your own domain on a cloud host needs `TRUST_FORWARDED_FOR` on
([Accuracy notes](#accuracy-notes)). With it, the Worker reads the visitor's address from `X-Forwarded-For`, sees the
request was forwarded and does not flag it. Without it, those headers count for nothing, because a scraper can send them
too.

### Language

Each web visit stores the browser's first language from the `Accept-Language` header, the primary subtag only (`de`,
`pt`). App sessions take it from the device locale. The Browser panel has a Language tab, and `language` works as a
filter and a breakdown dimension.

### Which post paid (Pro)

An untagged post on X shows up in the sources as one "X" row. This section turns that row into one row per post, with
visitors, customers and revenue. You do not tag any link. It is optional and works for the X account that posts your links.

**Connect.** Create an app in the X developer console, then run `npx wrangler secret put X_BEARER_TOKEN` with its bearer
token. In the site's Settings, X posts, type the handle. The Worker looks the handle up once, then reads the account's own
timeline: new posts only (`since_id`), 100 posts a call, 3 calls at most. Reposts are left out; your replies and quote
posts are read, and stored when they link to the site. The first read goes back 7 days. The hourly cron reads, and opening
the dashboard as the owner reads again when the last read is 10 minutes old, so a new post shows up within about 10 minutes
of a visit to the page. The viewer login never starts a read, because every read costs money on your X account. Only posts
that link to the site's domain are stored: the post id, its author's handle, its time, its text cut to 300 characters, the
landing paths and the t.co codes.

A read is claimed before X is called, so two dashboard loads, or a load and the cron, never bill the same posts twice. If
a call fails halfway, `since_id` stays where it was and the next read fetches the same posts again, so no post is skipped.
After more than 300 new posts in one read the older ones are skipped, and Settings says so. The hourly cron reads at most
3 sites a run, the ones read longest ago first, to stay inside the Free plan's 50 subrequests with the other hourly jobs.

**Handle changes and shared handles.** Changing the handle keeps the posts already stored; each one links to its own
author. Clearing the handle hides the posts it read (posts you added by hand stay). Sites that follow the same handle share
the reads of one run: the second site reuses the first one's read and pays nothing for it, so the cost shows on the site
that read first. Settings names the other sites.

**Without the X API.** Settings has an "Add a post by hand" form: the post's address, its text and the page it links to. A
post added this way matches exactly like a polled one. The dashboard's routes behind the login are `GET` and `PUT
/api/sites/:id/x` (handle, this month's X cost), `POST /api/sites/:id/x/posts` with `{ url, text, links, posted_at }`
(`links` optional when the text holds a link to the site) and `DELETE /api/sites/:id/x/posts/:id`. There is no API-key route.

**What it costs.** X bills every post it reads at $0.005, whether or not the post links to your site, and the one-off handle
lookup at $0.010 ([X pricing](https://docs.x.com/x-api/getting-started/pricing)). An account that posts 30 times a month
pays about $0.15; one that posts 300 times pays about $1.50, even if only a few posts link to the site. Settings shows this
month's reads and dollars. Whether a read with no new post is billed is not documented by X; the Worker only asks for
newer posts, so it should return nothing. Each stored post is 1 D1 row written; a read also writes 1 row for the claim and,
when it read something, 1 for the settings row.

**How a visit is matched.** Nothing is written per visit. When a report is read, every visit whose source is X is matched
to a post. That includes visits from `t.co`, `x.com`, `twitter.com` and the Android app, and visits tagged
`?utm_source=x`, `?utm_source=twitter` or `?ref=x` that came without a referrer:

1. **Exact.** The referrer carries the post's t.co code (`t.co/<code>`). Window and page do not matter. This will usually
   be 0: X sends only `https://t.co/` as the origin, with no code, so the Exact column stays empty for most accounts.
2. **Probable.** The visit started 0 to 48 hours after the post and landed on a path one of the post's links points at.
   Paths ignore the query string, a trailing slash, `/index.html` and letter case. With several such posts the closest
   earlier one wins. Two posts at the same millisecond: the higher id, which is the newer post. A tagged visit with no
   referrer is matched the same way.
3. Otherwise the visit is counted in **X, no matching post**. Links in your bio land there, and so do visits to a page
   that no stored post links to.

The rows of the table add up to the X row of the sources panel: every visit from X is in one post row or in "X, no
matching post". A visitor who came from two posts counts once in each of them, so the visitor numbers can add up to more
than the number of people.

**Revenue.** A payment follows the visit it is credited to, the same rule as every source panel (the last visit with a real
source before the payment). So a post gets the visitors, goal completions, new customers and revenue of the visits
credited to it. A customer who clicked post A on Monday and paid after clicking post B on Friday counts for B.

**Limits.** After a click on X the browser most likely sends only `https://t.co/`, with no code (checked from the spec
and x.com's `Referrer-Policy`; not captured from a live tweet). So nearly every match is probable, not exact. Two posts
that link the same page within 48 hours share their visits, and the later one takes them. Posts by other accounts and
reposts are not read. A report reads the newest 20,000 visits from X in the range and the 2,000 newest posts that can
explain them (from 48 hours before the oldest visit). When a range holds more than 20,000 visits, the report says so
(`truncated: true`, with `visits_considered`), leaves out the older visits and the payments of their sessions together, and
the dashboard asks for a shorter range.

**Reading it.** The dashboard shows an X posts table under the panels once a handle or a post exists. Agents read the same
rows with `get_breakdown` and `dim: x_post`; every row has `post_id`, `text`, `url`, `posted_at`, `exact`, `probable`,
`goals`, `visits_considered` and `truncated`, and the last row, `X, no matching post`, has `note: "no_post"`. With a revenue key,
every row also has `exact_customers`, `probable_customers`, `exact_revenue` and `probable_revenue`, the customers and revenue split by how
their visit was matched. The dashboard shows each row as "3 exact · 41 probable" under visits, and the same split under customers and
revenue. Probable means a guess from timing and landing page, so read a probable number as a lean, not a count.

### Import from DataFast

DataFast cannot export a file, so FounderData reads its API from your browser with your key: Settings, Import history,
Import from DataFast. Daily visitors, pageviews and revenue come first, then sources, pages, countries, devices, browsers,
operating systems and campaigns per week (about 7 minutes for 14 months) or per day (up to about 50 minutes, 60 calls a
minute). The key is never stored. It goes to DataFast, and if DataFast blocks browser calls, each call goes through one forwarding
route of your Worker, which passes it on and keeps nothing. Imported days show before the site's first own visit, filtering by a source answers from them, and DataFast's
revenue shows as labelled imported revenue next to your own. Full details, limits and the routes are in
[IMPORT.md](IMPORT.md#import-from-datafast).

## Revenue attribution with Dodo Payments

1. In Dodo → Developer → Webhooks, add `https://founderdata.example.com/api/webhooks/dodo/SITE_ID` and subscribe to
   `payment.succeeded`, `refund.succeeded` and the subscription events: `subscription.active`, `subscription.renewed`,
   `subscription.plan_changed`, `subscription.on_hold`, `subscription.cancelled`, `subscription.expired` and
   `subscription.failed`. Paste the signing secret (`whsec_…`) into the site settings. Each payment of a subscription
   moves its row on the Subscriptions tab to one period after the payment. The subscription events add the billing
   period, so a yearly plan counts a twelfth of its price in MRR. They also record trials, cancellations and failed
   renewals. Without them, the first payment guesses the period from the product name (year, annual, week, quarter),
   else a month. A yearly plan named "Pro" then counts its full price as MRR and lapses on paper a month later. The
   second payment fixes the row: the gap since the first payment sets the period, and MRR counts a twelfth of the
   price from the first day.
2. Pass the visitor ids as metadata when creating a checkout. Read them in the browser and send them along:

```ts
// Browser
const rt = window.founderdata?.attribution?.() ?? {};
await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ productId, rt }) });

// Server
await dodo.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_xxx', quantity: 1 }],
  metadata: { rt_visitor_id: rt.rt_visitor_id ?? '', rt_session_id: rt.rt_session_id ?? '' },
});
```

Using Dodo **payment links**? The script adds `metadata_rt_visitor_id` and `metadata_rt_session_id` to any
`checkout.dodopayments.com` link on the page once it knows the ids. That metadata doesn't always reach the payment, so also do step 3.

3. Recommended: set the checkout's return / redirect URL to a page on your site (e.g. `/thanks`) that loads the
   script. Dodo adds `?payment_id=…` to it, and FounderData uses that to link the payment to the exact visitor even when
   metadata doesn't come through.

**How credit is given:** a payment goes to the paying visitor's last visit that came from a real source (last non-direct
touch). Without cookies a visitor id lasts one day, so that visit is from the same day, unless you `identify()` the
person: then FounderData looks at every visitor id with the same user id or email. "Clicked a tweet on Monday, signed
up, came back directly on Friday and paid" is credited to the tweet when the signup called `identify()`. A renewal or
a second purchase by the same customer keeps the visit of the first payment, so the source that won the customer keeps
the revenue it brings later. If metadata is
missing, FounderData tries, in order: the return page (`?payment_id=`), an earlier payment by the same customer
(renewals), an email you `identify()`'d, and finally checkout timing (used only when exactly one visitor clicked a Dodo
checkout link in the 3 hours before the payment). The Customers tab shows how each payment was matched, and **Try
matching again** re-runs this for older payments.
Refunds are subtracted from revenue.

Lemon Squeezy, Polar, Paddle and Gumroad have their own webhooks (below). Any other provider can use the payments
API (the key is in site settings, all fields in [API](API.md#post-apiv1payments)):

```bash
curl -X POST https://founderdata.example.com/api/v1/payments -H "Authorization: Bearer rt_..." -H "Content-Type: application/json" \
  -d '{"transaction_id":"txn_1","amount":29.99,"currency":"USD","visitor_id":"<rt_visitor_id from attribution()>","email":"jane@example.com"}'
```

## Revenue attribution with Stripe

1. In Stripe, open Developers, Webhooks, and add `https://founderdata.example.com/api/webhooks/stripe/SITE_ID`
   with these events. Paste the signing secret (`whsec_…`) into the site settings.

| Event | What FounderData does with it |
|---|---|
| `checkout.session.completed` | Checkout payments. For a subscription it links the subscription to the visitor. |
| `checkout.session.async_payment_succeeded` | Checkout payments by SEPA Direct Debit and other delayed methods, which complete the session before the money arrives. |
| `invoice.paid` | Subscription and invoice payments, the first one and renewals. |
| `invoice_payment.paid` | Links an invoice to the PaymentIntent that paid it. Needed on API 2025-03-31 and later, where the invoice no longer names it. Without it, a refund of a subscription payment finds no payment. |
| `payment_intent.succeeded` | Payments made without Checkout or an invoice. |
| `charge.succeeded` | Payments made with the old Charges API, which have no PaymentIntent. Other charges are skipped. |
| `charge.refunded` | Refunds, from the charge's total refunded. |
| `refund.created`, `refund.updated`, `refund.failed` | Each refund on its own, so a refund that fails or is canceled adds the money back. |
| `charge.dispute.created`, `charge.dispute.closed` | Disputes. A lost dispute subtracts like a refund. An open or won one changes nothing. |
| `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` | Subscription state for the Subscriptions tab: price and plan, trial, auto-renew off, the end. |
| `invoice.payment_failed` | A failed subscription payment. The subscription is past due until the next `invoice.paid`. |

   FounderData also reads `charge.refund.updated`, `charge.captured` and the other `charge.dispute.*` events when they
   arrive. Leaving them off loses nothing.
2. Put the ids from `window.founderdata.attribution()` in the checkout's metadata. For subscriptions also put them in
   `subscription_data.metadata`, so renewals carry them too:

```ts
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: 'price_xxx', quantity: 1 }],
  success_url: 'https://yoursite.com/thanks',
  metadata: rt,                        // { rt_visitor_id, rt_session_id, rt_site_id, ... } sent from the browser
  subscription_data: { metadata: rt },
});
```

Stripe **Payment Links** (`buy.stripe.com`) on your pages get `client_reference_id=rtv_<visitor id>` from the script,
unless the link already has a `client_reference_id`.

**Products.** A subscription or invoice payment takes its product from the invoice's subscription line (the product
name, else the price's nickname). A one-time Checkout payment takes `metadata.product` when your checkout code sets it,
else the first line item when the event carries it. Add `product: 'Lifetime deal'` to the metadata above to see
one-time sales per product in the digest, the payment pushes and the Customers tab.

**One payment, one row.** A payment reaches FounderData through several events: Checkout, its PaymentIntent, the invoice,
the charge. FounderData keeps every Stripe id it sees for a payment (PaymentIntent, charge, invoice, Checkout Session) in
the `stripe_objects` table, pointing at one payment row. The row is keyed by the PaymentIntent, else the charge, the
invoice or the Checkout Session. A repeat delivery finds the row through any of those ids and can only fill in a
missing visitor, subscription or customer. On API 2025-03-31 and later an invoice can arrive before FounderData knows its
PaymentIntent. If both got stored, `invoice_payment.paid` merges them into one row. PaymentIntents with the
descriptions Stripe gives invoice payments ("Subscription creation", "Payment for Invoice") are left to `invoice.paid`,
so an endpoint without `invoice_payment.paid` does not count them twice either.

**Refunds and disputes.** Refunds of a charge are one negative row, `stripe_refund_<charge>`, holding what is refunded
now. With the `refund.*` events FounderData counts each refund that has not failed or been canceled. With only
`charge.refunded` it counts the charge's `amount_refunded`, less refunds that failed after it. A failed or canceled
refund never comes back, whatever arrives late. A dispute gets its own row, `stripe_dispute_<id>`, only once Stripe
closes it as lost. Revenue drops on the day it is lost, not on the day the money was held. Refunds and disputes count
only on the site that stored the payment.

Without metadata the usual fallbacks apply: an earlier payment by the same Stripe customer, then the email of a visitor
you `identify()`'d.

**Several sites on one Stripe account.** Stripe sends every event to every endpoint of the account, so each site's
endpoint sees each payment. Each payment goes to one site, the first of these that applies:

1. `rt_site_id` (or the older `ml_site_id`) in the metadata. Other sites skip the payment.
2. The visitor id in the metadata or `client_reference_id`: the site that has visits from that visitor.
3. The subscription: the site that already has a payment of it, or whose Checkout linked it.
4. The Stripe customer: the site where that customer paid before.
5. The Checkout's `success_url`: the site with that domain.
6. Nothing ties it to a site: every site with **Record payments that nothing ties to a site** on (the default, in the
   Stripe settings). Turn it off on all but one of the sites that share an account.

Rules 1 to 5 give the same answer at every endpoint. Once a site has stored a payment, the other endpoints find it by
its Stripe ids and skip it, so a payment never counts on two sites. Keep `rt_site_id` in the metadata
(`attribution()` includes it) and none of the later rules are needed.

### Import Stripe history

The webhook sees payments from the day you connect it. To bring in the months before, open the Stripe card in
Settings and use **Import past payments**:

1. In Stripe, open Developers, API keys, and create a restricted key with Read access to Charges and Invoices.
2. Paste the key (`rk_live_…`), choose 3 to 36 months and start. Test mode keys are refused.
3. Keep the page open. The dashboard runs the import in steps. Each step reads 20 charges from Stripe and stores up to
   about 4 new ones, because the free plan allows 50 D1 queries per request. A step that fails is tried again; a
   closed tab leaves the import paused, and **Resume** continues from the last charge.

The key is stored in the `stripe_imports` table only while the import runs. It is deleted when the import ends, fails
or is canceled, and after 1 hour without a step: each daily cron run, and the next look at the card, mark such an
import "stopped" and delete its key. Paste the key again to resume from the last charge, with the range you chose. Each charge goes through the same code as the webhook event Stripe would have sent: an invoice charge
as `invoice.paid` (so renewals and subscriptions are marked), a PaymentIntent as `payment_intent.succeeded`, an old
Charges API charge as `charge.succeeded`, and its refunds as `charge.refunded`. An imported payment gets the id a
webhook gives it, so a payment the webhook already stored, or that another site holds, is skipped. The ownership rules
above apply, so a site with **Record payments that nothing ties to a site** off imports only the payments tied to it.

Imported payments raise no alert. They have no visit behind them, so they count under No source, unless the buyer's
email matches a visitor you `identify()`'d or the same Stripe customer paid through a linked visit. **Try matching
again** in the Customers tab runs these checks again later. Lost disputes are not imported.

`GET`, `POST` and `DELETE /api/sites/:id/stripe-import` and `POST /api/sites/:id/stripe-import/step` are the routes
behind the card (login required).

### Import from ChartMogul (Pro)

The Stripe import rebuilds a subscription from its charges, so a price change or a pause can be wrong and the first
payment is only as old as the range you chose. ChartMogul records every price change and cancellation of each
subscription. Open **Settings, Import subscription history** and use **From ChartMogul**.

1. In ChartMogul, open your profile, API keys, and copy a read-only key.
2. Paste it and press **Import from ChartMogul**. Keep the page open. Each step reads one page of 200 activities from
   `GET /v1/activities` (oldest first, cursor paging) and stores it.
3. When the last page is in, the browser builds one timeline per subscription and sends them in chunks of up to 100.
   Close the tab at any point and paste the key again. It continues from the stored cursor, or from the chunk it had
   reached.

**The key.** It is sent with every step and used for that one request. FounderData stores the cursor, never the key,
and writes it to no log. This differs from the Stripe import on purpose: that one keeps its key in D1 while it runs, this
one has no use for it between steps.

**Mapping.** ChartMogul reports an MRR after every activity. FounderData follows it:

| ChartMogul activity | FounderData |
| --- | --- |
| `new_biz` | A subscription starts paying at that MRR. Its first payment is that day. |
| `expansion`, `contraction` | A price change, kept as a step. Any number of steps per subscription. A contraction that leaves MRR at 0 (a 100% discount) is a price of 0, and the subscription stays. |
| `churn` | The subscription ends that day. Only a churn ends it. |
| `reactivation` | A new stretch. The newest stretch of a subscription has the subscription's id, and each earlier one is `<id>~1`, `<id>~2` and so on, oldest first. The earlier rows keep their history. It counts as new MRR in the month it returns. |

The subscription id is ChartMogul's `subscription-external-id`, the plan is `plan-external-id`, and the customer is
`customer-external-id`. A subscription id that starts with `sub_` is a Stripe subscription and the row gets the provider
`stripe`, so Stripe events, the Stripe check and the provider split treat it like any Stripe row. Other rows get the
provider `chartmogul`. The import that made a row is kept apart, in `import_source`. ChartMogul amounts are cents
in the activity's currency. FounderData has no billing period for them, so they count as monthly amounts and show as
"unknown" in the LTV per period. The Subscriptions tab, the MRR chart, the retention grid and `get_subscriptions` read
them like any other row. Activities have no trials, so none are imported.

**When ChartMogul mirrors Stripe or the App Store.** The subscription id is the match key. A row that FounderData
already has with the same id, from a webhook, a Stripe import or App Store notifications, is a native row, and native
data wins:

- An imported stretch that starts at or after the native row's first payment is left out.
- An imported stretch that runs up to the native first payment gives that row its earlier history: the first payment
  moves back, and the earlier prices become steps before the native price. The row keeps its id, so a later webhook
  updates it. Deleting the import puts the row back as it was, unless a live event has changed it since (see
  **Delete an import**).
- An imported stretch that ended more than 2 days before the native first payment becomes a row of its own.
- A row made by another import is never changed. A second import (ChartMogul after RevenueCat, say) leaves the
  subscriptions the first one holds as they are, and the import list says how many: "already held by another import".
  Their earlier history from the second source is not added. Delete the first import to let the second one place them.

**Live events after the import.** The webhook, Stripe or App Store event for a subscription names its id, which is the
newest stretch. A renewal updates that row and never touches an ended stretch before it. A subscription whose newest
stretch had ended and then pays again restarts its row like any native subscription does, so that last imported
stretch drops out of the history.

Email is not used for matching, because activities carry no email. If your ChartMogul subscription ids are not the
Stripe or App Store ids (a custom billing system), nothing matches and the same subscription counts twice. The check
below shows it as a gap in the latest months.

**Other currencies.** An amount in another currency than the site's is converted at the ECB rate of the first day of the
month it applies from. ChartMogul converts with its own rates, so a few cents of gap per foreign subscription is normal.
A currency with no ECB rate stops that chunk with a message, and sending it again after a minute usually works.

**What does not come across.** Payments and revenue (the charts of money received are unchanged), customer emails and
names, ChartMogul's later corrections of old months (it revises past MRR, for example when an invoice is paid late, so
activities read today can differ from the ones its dashboard showed last year), manual MRR edits, and plan billing
periods.

**Check the months.** After the import, **Check months** compares FounderData's MRR at the end of each month with
ChartMogul's `GET /v1/metrics/mrr` (monthly, in cents of your ChartMogul account currency). Paste the key again for it.
The table shows both figures and the gap. The target is within one unit of the currency a month. When a month misses it,
the table says so, and **Who moved** lists the imported subscriptions that changed most that month.

Only months from the import's first payment to its last movement are compared, because outside them FounderData's
figure is live data and a match proves nothing about the import. An import that added nothing says "No month with
imported history to compare". FounderData's figure includes every source on the site, so a Stripe subscription that is
not in ChartMogul shows as a gap. ChartMogul's account currency is read from `GET /v1/account`. When it differs from the
site's currency the check stops with a message and does not convert. Set the site's currency and timezone to your
ChartMogul account's first, because a month end is read in the site timezone. The last check is kept with the import.

**Delete an import.** Each row the import holds ends up one of three ways, and the confirmation says how many of each:

- A row the import made, which no live event has changed since, is deleted.
- A native row the import gave earlier history gets its own values back, when it still has exactly the values the
  import wrote.
- A row a live event changed after the import stays, imported history included, and leaves the import. Its MRR is right
  today, and rewinding it would drop what the live events wrote. That row's imported history stays until you delete the
  row itself.

**Month 0 of the retention grid** counts subscription rows by first payment month. ChartMogul's cohorts count customers,
so a customer with two subscriptions, or one who left and returned, is one customer there and two or more here.

**Cost.** A page of activities writes 3 D1 rows. A stored subscription stretch writes 2, the row and its index entry,
and a chunk adds 2 more. All of it counts against the same daily allowance as the Plausible import (20,000 rows a day for
the whole deployment, `IMPORT_DAILY_ROWS`), so an import cannot take the allowance live events need. A chunk past the
allowance waits for 00:00 UTC. 2,000 subscriptions are about 4,100 rows, and 100 pages of activities add 300. A chunk in
another currency fetches at most 10 new exchange-rate days and asks for itself again when more are missing, which keeps
each request under the Free plan's 50 subrequests. The dashboard retries it up to 4 times, waiting longer each time.

### Import from RevenueCat (Pro)

RevenueCat's REST API has no list of all subscriptions, and its subscription object holds only the current state. Its
Scheduled Data Export of transactions has every renewal. FounderData reads that file.

1. In RevenueCat, set up a Scheduled Data Export of the **Transactions** feed as CSV. RevenueCat's docs do not say how far
   back the first delivery reaches, so compare the oldest month afterwards. Take the file from your bucket or email.
   Gzip and plain CSV both work. Choose every file you have at once: a transaction that repeats keeps the row with the
   newest `updated_at`, whatever order the files come in, so a later refund beats the earlier sale.
2. In **Settings, Import subscription history, From RevenueCat**, choose the file or files. The browser reads them and
   builds timelines. Only the timelines go to the server.
3. Close the tab and choose the same file again to continue. A chunk already stored changes nothing when sent twice.

**Mapping.** Columns are the feed's documented ones. A transaction counts once per `store_transaction_id` with
`renewal_number`, the row with the newest `updated_at` winning.

| In the export | In FounderData |
| --- | --- |
| `original_store_transaction_id` | The subscription id. It is the id the RevenueCat webhook and App Store notifications use. |
| `start_time`, `end_time` | The period it pays for. Periods less than 2 days apart are one stretch. A longer gap ends the stretch, and a later purchase is a new stretch. The newest stretch has the subscription's id, the earlier ones `<id>~1`, `<id>~2`. |
| `purchase_price_in_usd` | The gross price, before tax and commission. For a site not in USD, `purchase_price_in_purchased_currency` in `purchased_currency`, converted as above. |
| `product_duration` | Month length of the price: `P1Y` divides by 12, `P1W` multiplies by 52/12. |
| A different price on a renewal | A price change. |
| `is_trial_period` with price 0 | A trial. The subscription's first payment is the first paid transaction after it. A trial with no payment stays a trial. |
| `refunded_at` with `price_in_usd` 0 | A full refund. The period counts only until the refund date, and a refunded last period ends the subscription then. A partial refund keeps the gross price. |
| `is_sandbox`, `is_auto_renewable` false, price 0 outside a trial | Left out. RevenueCat leaves promotional subscriptions out of its MRR, and so does this. |

Gross matches how FounderData counts App Store and RevenueCat subscriptions everywhere else. The net money view scales
these rows by Apple's cut, as for webhook rows, and treats every RevenueCat row as App Store. The
customer id is `apple:<id>` for App Store rows and `rc:<user>` for other stores, the same as webhook rows. The provider is
`revenuecat`.

**Dedupe with webhook rows.** The same rule as ChartMogul: a row with the same id wins from its first payment, earlier
history is added to it, and deleting the import restores it unless a live event changed it since (see **Delete an import** under ChartMogul, which works the same way here).
A subscription that a ChartMogul import already holds is left as it is and counted as "already held by another import".

**What does not come across.** Payments and revenue, grace period days (a period ends at `end_time`, not
`effective_end_time`), family sharing flags, and subscribers whose Google subscription expired more than 60 days before
RevenueCat migrated them, which RevenueCat's file does not carry. How far back the first export reaches is RevenueCat's to
say, and its docs do not.

**Not built: the API v2 pager.** It would need 4,000 to 6,000 calls for 2,000 subscribers, and RevenueCat does not promise
that the customer list reaches every subscriber, so FounderData reads the export instead.

**Check the months.** RevenueCat's charts API allows 25 calls a minute and takes a `resolution` id from a second call, and
the response shape is not in the docs FounderData was built from, so there is no key-based check. In RevenueCat, open the
MRR chart, choose monthly, press **Export CSV** and paste the text. FounderData reads the first date column and the column
named MRR, or the second column, takes the last row of each month as its end, and shows the same table as for ChartMogul.
Two differences are expected. RevenueCat counts a weekly price as 4 per month, FounderData as 52/12 (4.33). RevenueCat's MRR
page does not say how it treats trials and refunds. Open **Who moved** on the biggest gaps. Enter the currency of the series
under the text box: FounderData stops when it differs from the site's.

The routes behind both imports are in [API.md](API.md#subscription-history-import-pro).

## Revenue attribution with Lemon Squeezy, Polar, Paddle and Gumroad

Each works like Stripe: a webhook URL from the site's Settings, a secret that proves the request came from the
provider, and the visitor ids from `window.founderdata.attribution()` in the checkout's custom data. Payments are stored
once per provider id, so a retried webhook writes nothing. A refund that arrives before its payment stores the payment
first. Without ids, the usual fallbacks apply: an earlier payment of the same customer, then the email of a visitor
you `identify()`'d, then checkout timing. Subscription events become trial, cancellation, expiration and billing issue
signals, and update the subscription's row for MRR.

| Provider | Webhook URL | Proof | Events | Visitor ids |
|---|---|---|---|---|
| Lemon Squeezy | `/api/webhooks/lemonsqueezy/SITE_ID` | `X-Signature`, HMAC of the body with the signing secret you type in Lemon Squeezy | `order_created`, `order_refunded`, `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_expired`, `subscription_payment_success`, `subscription_payment_failed`, `subscription_payment_refunded` | `meta.custom_data`: `checkout[custom][rt_visitor_id]` on a checkout link, or `checkout_data.custom` in the API |
| Polar | `/api/webhooks/polar/SITE_ID` (format Raw) | Standard Webhooks signature with the endpoint secret, made before or since Polar's September 2026 signing change | `order.paid`, `order.refunded`, `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.revoked` | the order's `metadata` (copied from the checkout), or `reference_id=rtv_<visitor id>` |
| Paddle Billing | `/api/webhooks/paddle/SITE_ID` | `Paddle-Signature`, `h1` HMAC of `ts:body` with the destination's secret key | `transaction.completed`, `adjustment.created`, `adjustment.updated`, `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.past_due` | the transaction's `custom_data` |
| Gumroad | `/api/webhooks/gumroad/SITE_ID/TOKEN` | the random token in the URL, plus the seller id | `sale`, `refund`, `cancellation`, `subscription_ended` | `url_params` |

**Checkout links.** The script tags links on your pages once it knows the ids: `*.lemonsqueezy.com/checkout/…` get
`checkout[custom][rt_visitor_id]`, `rt_session_id` and `rt_site_id`; `buy.polar.sh` links get
`reference_id=rtv_<visitor id>` unless they have their own reference id; `gumroad.com/l/…` and `*.gumroad.com` links
get `rt_visitor_id`, `rt_session_id` and `rt_site_id` as URL parameters, which Gumroad returns as `url_params`. The
overlays of Lemon Squeezy and Gumroad read the same href, so they carry the ids too.

**Paddle.js.** Paddle's overlay checkout opens from code, not a link. Pass the ids yourself:

```js
Paddle.Checkout.open({
  items: [{ priceId: 'pri_xxx', quantity: 1 }],
  customData: window.founderdata?.attribution?.() ?? {},
});
```

Paddle copies `customData` onto the transaction and its subscription. A refund or chargeback counts once Paddle
approves the adjustment. A rejected or reversed one comes back off.

**Test mode.** Lemon Squeezy events with `test_mode` and Gumroad sales with `test=true` are ignored. Polar's sandbox and
Paddle's sandbox are separate accounts that send no test flag, so connect only the live organization or destination.

**Gumroad's trade-off.** Gumroad signs nothing. FounderData makes a random token for the ping URL, and each sale and
refund must also name your seller id, typed into Settings or saved from the first sale that arrives with the token.
Anyone who learns the URL can post fake sales, so keep it out of public code. **New URL** in Settings turns the old one
off. Gumroad's Ping setting (Settings, Advanced) sends sales only. Add the URL as a resource subscription for refunds
and cancellations:

```bash
for r in sale refund cancellation subscription_ended; do
  curl -X PUT https://api.gumroad.com/v2/resource_subscriptions \
    -d access_token=YOUR_TOKEN -d resource_name=$r -d post_url=PING_URL
done
```

`scripts/setup-sites.mjs` makes the ping URL for a site with `gumroad_seller_id` (or `"gumroad": true`) in
`sites.json`, prints it with the loop above, and lists Gumroad under "missing" until the first sale arrives.

Gumroad sends `price` in the minor unit of `currency` (cents for USD). A refund counts the full price unless the ping
names `amount_refunded_cents`.

**Several sites on one store.** A store or Gumroad account can send to several sites' URLs. Each payment lands on the
site named by `rt_site_id` in its custom data (`attribution()` and the tagged links include it), else on the first
site that receives it. A refund counts on the site that holds the payment.

### Other revenue: ads, affiliate, sponsorships

Money that is not a purchase goes to the payments API with `"kind": "income"`. It adds to revenue, shows as its own
line, Other revenue, in Revenue by provider, and never counts as a customer, a payment or a conversion. It has no
visitor, so it sits under No source. A monthly cron that posts last month's AdSense total:

```bash
# 0 6 2 * *  (06:00 on the 2nd of each month)
MONTH=$(date -d 'last month' +%Y-%m)
curl -X POST https://founderdata.example.com/api/v1/payments -H "Authorization: Bearer rt_..." -H "Content-Type: application/json" \
  -d "{\"transaction_id\":\"adsense-$MONTH\",\"amount\":412.50,\"currency\":\"USD\",\"kind\":\"income\",\"product\":\"AdSense\",\"timestamp\":\"$MONTH-01T00:00:00Z\"}"
```

The `transaction_id` makes a rerun harmless: the same id is stored once. To fix a wrong amount, send the same
`transaction_id` again with the right one. Other revenue and refunds take the new amount. A payment keeps its first
amount, see [API.md](API.md#post-apiv1payments). To remove a row, click the Other revenue line in Revenue by provider: it lists
the period's rows, each with Delete. From a script, `DELETE /api/v1/payments/<transaction_id>` with the API key.

## Product types

A site is a website, an iOS app, a browser extension or a newsletter. Pick the type when you add the site, or later in
the site's Settings, Product type. A site with a bundle id is an iOS app until you pick another type. Every other site
is a website.

The type picks the numbers a site leads with. Bounce rate and session time say nothing about an extension or a
newsletter, so its Overview, its Home card and its Home row show these instead:

| Type | Overview tiles | Headline on Home and in the weekly report |
| --- | --- | --- |
| Browser extension | Installs, weekly active, uninstalls | Weekly active |
| Newsletter | Subscribers, new subscribers, unsubscribes, opens | Subscribers |

Both types count goal events sent to `POST /api/event`, the route the website script uses. They need no other tracker.

| Event | Who sends it | What it counts toward |
| --- | --- | --- |
| `install` | The extension, from `chrome.runtime.onInstalled` | Installs and weekly active |
| `active` | The extension, once a day while the browser runs | Weekly active |
| `uninstall` | The page Chrome opens after an uninstall | Uninstalls |
| `subscribe` | Your newsletter tool's webhook, for a new subscriber | New subscribers and subscribers |
| `unsubscribe` | The webhook, when a subscriber leaves | Unsubscribes and subscribers |
| `open` | The webhook, when a subscriber opens an issue | Opens |

- Installs, uninstalls, new subscribers, unsubscribes and opens count events in the period. A reader who opens one
  issue twice counts 2 opens.
- Weekly active counts the browsers that sent `install` or `active` in the 7 days up to the end of the period, against
  the 7 days before. It stays a 7-day number whatever period you pick.
- Subscribers is every `subscribe` minus every `unsubscribe` up to the end of the period, against the same count at its
  start. To start from an existing list, send one `subscribe` per current subscriber once.
- Each event is `{ "w": "SITE_ID", "t": "goal", "n": "install", "u": "https://acme.example/extension", "vid": "...",
  "sid": "..." }`. `u` has to be on the site's domain. `vid` and `sid` are 8 to 64 letters, digits, `_` or `-`. Keep
  one `vid` per browser or subscriber and start a new `sid` each day, so the chart shows how many were active per day.
- An event writes 5 rows, or about 11 for a person's first event of the day, the same as the website script's pageviews
  and goals. Opens add up: 2,000 opens of one issue write about 22,000 rows, a fifth of the free plan's day.
- Their sessions stay out of Web visitors and web conversion on Home, and out of the weekly report's web visitors.
  Their rows keep their own visitor count.
- Without payments, Home's status follows the headline number. 10% or more up is growing and 10% or more down is
  declining, from at least 20 in the period before.
- `/api/home`, `/api/v1/portfolio` and `/api/v1/weekly` carry `type` and `product` per site
  ([API.md](API.md#product-types)).

### Browser extension

Put this in the extension's background script. It needs Manifest V3 and the `storage` and `alarms` permissions.
Settings, Product type shows it with your site id and host filled in.

```js
const HOST = 'https://founderdata.example.com';
const SITE = 'SITE_ID';

async function send(name) {
  let { fdId } = await chrome.storage.local.get('fdId');
  if (!fdId) await chrome.storage.local.set({ fdId: (fdId = crypto.randomUUID()) });
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  await fetch(HOST + '/api/event', {
    method: 'POST',
    body: JSON.stringify({ w: SITE, t: 'goal', n: name, u: 'https://acme.example/extension', vid: fdId, sid: fdId + '-' + day }),
  });
}

// One active a day: weekly active counts browsers with install or active in the last 7 days.
async function active() {
  const today = new Date().toISOString().slice(0, 10);
  const { fdDay } = await chrome.storage.local.get('fdDay');
  if (fdDay === today) return;
  await chrome.storage.local.set({ fdDay: today });
  await send('active');
}

chrome.runtime.onInstalled.addListener((e) => {
  if (e.reason === 'install') send('install');
  chrome.runtime.setUninstallURL('https://acme.example/uninstalled');
});
chrome.runtime.onStartup.addListener(active);
chrome.alarms.create('fd-active', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(active);
```

Chrome runs no extension code on uninstall. It opens the URL set with `setUninstallURL`. Put the FounderData script on
that page and send the goal from it:

```html
<script>window.addEventListener('load', () => window.founderdata('goal', 'uninstall'));</script>
```

That page's visitor is a website visitor, so a reload counts a second uninstall.

### Newsletter

Buttondown, Kit, beehiiv and most other newsletter tools post a webhook when someone subscribes or leaves, and some
when someone opens an issue. FounderData doesn't read their payloads. A few lines on your server or in a Worker pass
them on:

```js
async function track(name, subscriberId) {
  const vid = String(subscriberId).replace(/[^\w-]/g, '').slice(0, 40).padEnd(8, '0');
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  await fetch('https://founderdata.example.com/api/event', {
    method: 'POST',
    headers: { 'user-agent': 'newsletter-relay/1.0' },
    body: JSON.stringify({ w: 'SITE_ID', t: 'goal', n: name, u: 'https://acme.example/', vid, sid: vid + '-' + day }),
  });
}

// New subscriber:   await track('subscribe', subscriber.id)
// Unsubscribed:     await track('unsubscribe', subscriber.id)
// Opened an issue:  await track('open', subscriber.id)
```

Keep the `user-agent` header. FounderData drops a request with no user agent, or with a script's default such as
`curl`, `python` or `axios`, as a bot.

## iOS apps

A site can track its iOS app too. On the home page, **Add site or app** asks whether you add a website, an iOS app or
both. An app needs a name and its bundle id, no domain (`POST /api/sites` with `app_bundle_id` and no `domain`; the
site gets a placeholder domain under `.invalid` that the dashboard never shows). For a website that gets an app later, set the bundle id in the
site's Settings, General. The server refuses app data and Apple notifications for any other bundle. The Swift package in `ios/` (`FounderDataKit`, see [ios/README.md](../ios/README.md))
posts batches to `POST /api/app/events`. Without the user's consent it stores nothing on the device (the install id is
random per launch, and the server groups one device's launches per day); `FounderData.setConsent(true)` keeps it in the Keychain. The full
contract, including what the server adds to it, is [APP-API.md](APP-API.md).

- Location comes from Cloudflare's `request.cf` only. The app path never reads or stores the IP address.
- App sessions have the hostname `ios:<bundle id>`, browser "App", OS "iOS 26.1" and so on. Screens are stored as
  pages (`Onboarding/Step2` becomes `/Onboarding/Step2`), so entry pages, exit pages and funnels work for apps.
  The Platform tab splits Web and iOS; the App version tab lists versions with their build.
- **App Store purchases** arrive two ways, and either may come first: the app sends the StoreKit 2 transaction, and
  App Store Server Notifications V2 go to `https://founderdata.example.com/api/webhooks/apple/SITE_ID` (set it in App Store Connect
  → App Information, or forward the raw body from your own backend). The server checks Apple's signature against the
  Apple Root CA - G3 certificate built into the Worker. Payments are keyed by transaction id, renewals are flagged,
  REFUND and REVOKE subtract. Free trials are not revenue; the first paid renewal counts as the new customer.
- **Sandbox purchases** (TestFlight, sandbox accounts) are ignored unless the site setting is on. Then they are stored
  as "App Store sandbox" and never count as revenue.
- **Apple Search Ads**: on first launch the app sends its AdServices token. The server asks Apple about it and, for an
  ad install, sets the session's channel to Paid, source to Apple Search Ads, campaign to the campaign id, keyword to
  the keyword id and content to the ad group id.
- **Web to app**: a universal link with `?rt_vid=<web visitor id>` links the install to that web visitor, so an app
  purchase is credited to the web visit that led to it (for example a Google search for a blog post).

## App Store sales (Pro)

FounderData can pull Apple's daily Sales and Trends report itself, so every app shows downloads and proceeds, including
apps that do not run FounderDataKit. It is off until you set four secrets.

**What it imports.** The daily Sales summary from App Store Connect: first downloads, re-downloads, in-app purchases and
subscriptions, with units, proceeds per currency, country and device. App updates are stored but not counted. Rows go to
a site through its app: set the site's bundle id, and the import looks up the App Store id and SKU once. App rows match
on the Apple identifier, in-app purchase rows on the parent SKU. Rows that match no site are kept and show up as
"unmatched" in `GET /api/appstore`.

**Secrets.**

```sh
node scripts/wrangler.mjs secret put ASC_KEY_P8        # the contents of the AuthKey_XXXX.p8 file
node scripts/wrangler.mjs secret put ASC_KEY_ID        # the key id shown next to the key
node scripts/wrangler.mjs secret put ASC_ISSUER_ID     # the issuer id at the top of Users and Access, Integrations
node scripts/wrangler.mjs secret put ASC_VENDOR_NUMBER # Sales and Trends, Reports, the number next to your name
```

Create the key in App Store Connect under Users and Access, Integrations, Team Keys, and give it the **Sales and Reports** role (Apple has no plain Sales role for API keys)
only. The Worker can then read sales reports and nothing else. Without all four secrets the import is off, and the App
Store tab says so.

**When it runs.** A cron at 10:30 UTC imports the last three days again, so late corrections from Apple land. Each
import replaces that day's rows. A 404 from Apple that says there were no sales is stored as a real zero day.

**Backfill.** Apple keeps daily reports for 365 days. After setting the secrets, import the past with the script. It logs
in with your admin password, read from a file, and repeats until every day is in:

```sh
scripts/asc-backfill.sh https://your-founderdata.example.com                 # the last 365 days
scripts/asc-backfill.sh https://your-founderdata.example.com --from 2026-06-01 --to 2026-10-28 \
  --password-file ~/.config/founderdata/admin-password
```

The default password file is `~/.config/founderdata/admin-password`. The script never prints the password. One call to
`POST /api/appstore/backfill` imports at most 30 days, fewer on the free plan (50 subrequests per request), and answers
with `next`, the day to continue from. The script loops until `next` is null.

**Where it shows.** Each site with an app has an App Store tab: a daily chart, totals, a products table and a coverage
line. Apple's sales also count in revenue everywhere (see "How revenue is counted" below). On the home page, an app with
no FounderDataKit sessions in the period shows its App Store downloads next to its revenue. The API is described in
[MOBILE-API.md](MOBILE-API.md), section 5.

**One proceeds figure.** Apple reports proceeds in up to a dozen currencies. The App Store tab, the products table
and the home card add them into one amount in the site's currency. Each day's proceeds use that day's ECB reference
rate; weekends and holidays use the last published rate. A currency the ECB does not publish stays out of the total,
and the tab shows it as "+ amount not converted". The amounts per currency, as Apple reports them, sit under "By
currency". The total is a reading aid, not your payout. Apple converts once a month at its own rates. The rates come
from the `fx_rates` cache. The first read of a range with missing days fills it with one call to the Frankfurter time
series, about 30 rows per weekday; later reads cost no call.

To see what an app made last quarter, open its App Store tab and pick **Last quarter**. The ‹ and › arrows step one
calendar quarter at a time.

**Proceeds and revenue.** The App Store tab shows proceeds: what Apple pays you after its commission and tax. Revenue
counts the same sales at the gross price the customer paid, like Stripe and App Store payments. The coverage line
compares purchases FounderData recorded in the period with the in-app purchase units in Apple's report. Apple's days are
Pacific time and the tab's window is UTC, so on a short period the two can differ by a day.

## Apple Search Ads (Pro)

The AdServices token already tells FounderData which campaign, ad group and keyword brought an install, but only as ids
like `1874400202`. With read access to your Apple Ads account, FounderData also imports their names and Apple's daily
spend, taps, installs and impressions. The Apple Search Ads section (Paid, next to Meta ads) then shows cost per paid
conversion and ROAS per campaign and per keyword. It is off until you set four secrets.

**Create the API user.** These are Apple's steps from
[Implementing OAuth for the Apple Ads Platform API](https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api):

1. Sign in to [Apple Ads](https://ads.apple.com) (Advanced) as an account admin. Under Account Settings, User
   Management, invite a user with the **API Read Only** role. Use an Apple Account that is not yours, and accept the
   invite with it. Read Only is all the import needs: it never changes a campaign.
2. Make a key pair:

   ```sh
   openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   ```

3. Signed in as the API user, open Account Settings, API, paste the whole of `public-key.pem` and save. Apple then shows
   a `clientId`, a `teamId` and a `keyId`.
4. Set the secrets. The private key goes in from the file, so its line breaks survive:

   ```sh
   node scripts/wrangler.mjs secret put ASA_CLIENT_ID     # clientId, SEARCHADS.…
   node scripts/wrangler.mjs secret put ASA_TEAM_ID       # teamId, SEARCHADS.…
   node scripts/wrangler.mjs secret put ASA_KEY_ID        # keyId
   node scripts/wrangler.mjs secret put ASA_PRIVATE_KEY < private-key.pem
   node scripts/wrangler.mjs secret put ASA_AD_ACCOUNT_ID # optional: import this ad account only
   ```

   Then delete `private-key.pem` from your machine, or keep it in a password manager.

The Worker signs a client secret with the key (an ES256 JWT, as Apple's page describes), trades it for an access
token that lasts an hour and keeps the token in memory. It talks to the Apple Ads Platform API
(`api.ads.apple.com/v1`), which replaces the Campaign Management API v5 that Apple turns off on January 26, 2027.
Without `ASA_AD_ACCOUNT_ID` it reads every ad account the API user has a role on.

**What it imports.**

- Names: each campaign with the app it promotes, each ad group and each keyword's text.
- Daily numbers per campaign and per keyword: spend in the ad account's currency, taps, installs (Apple's total of tap
  and view-through installs) and impressions. A day with none of them is not stored.

A campaign belongs to a site through the app it promotes. That app's App Store id must be the site's. The App Store
sales import finds the id from the bundle id. Without that import, enter the id under General in the site's settings.
It is the number in the app's App Store link, `apps.apple.com/app/id123456789`. Settings, Payments, App Store lists
each promoted app that no site has, with its name and id, and the Apple Search Ads section repeats the list.
Until a site has the id, that app's spend shows on no site.

Earlier versions asked Apple's public lookup (`itunes.apple.com/lookup`) for the bundle id of each promoted app. From a
Cloudflare Worker that lookup answers 403 unless Apple's cache already holds the answer, so the match failed without a
word. The Worker no longer calls it. An app it did look up before still matches on its bundle id.

**When it runs.** The 03:17 UTC cron imports the last three days again, since Apple corrects recent days. A row that
changed is updated, a row Apple no longer reports is deleted, and an unchanged row costs nothing. For the past, open the
Apple Search Ads section and click **Import the last 90 days**. It calls `POST /api/asa/backfill` until the range is
done, 15 days per call. Settings, Payments, App Store shows when the last import ran and the error it stopped on, if
any. So do the setup checklist and, for agents, `get_apple_search_ads` with `view: "campaigns"` and each site's `sources`.

**Where it shows.** Campaign, ad group and keyword names replace the ids in the Campaign and Keyword panels, the App
tab's Sources card, the visitor profile, the Customers tab and the filter chips. The id is still what you filter by. The
Apple Search Ads section (`/site/<id>/ads/asa`) has these columns per campaign and per keyword. A row opens the App
tab filtered to that campaign or keyword:

| Column | Where it comes from |
| --- | --- |
| Spend, Taps, Installs, Apple | Apple's numbers for the days of the period, spend converted into the site currency at each day's ECB rate |
| Installs seen | Install ids whose first launch Apple's AdServices answer tied to this campaign or keyword |
| Trials: Started, Paid, Ended unpaid, Open, Trial to paid | Those installs with a free trial start, and how each trial ended. Open is still running or has no subscription events yet. Trial to paid is Paid over Paid plus Ended unpaid |
| First purchases | Those installs with a first purchase |
| Revenue | Every payment credited to those installs up to today, renewals and refunds included |
| Cost per paid | Spend divided by first purchases |
| ROAS | Revenue divided by spend. 100% means the period's spend has paid for itself so far |

The columns sit in three groups, Spend, Trials and Paid, and every header sorts the table. Two switches change what
Revenue and ROAS count. **Revenue window** picks **To date**, **7 days**, **14 days** or **30 days**: trials, first
purchases and revenue that came within that many days of the install's session (`?window=7`, `14` or `30` on the API). A 7-day ROAS stops growing a week after the install, so two periods compare
fairly. **Gross** and **After Apple's cut** pick the amount: gross is what customers paid, tax included; after Apple's
cut follows [Apple's cut](#apples-cut-pro). The API sends both, `revenue` and `roas`, `netRevenue` and `netRoas`.

**What it costs.** One D1 row per campaign and per keyword with activity per day, one per new or renamed name and one
status row per import. A re-import that finds nothing new writes 1 row. An account with 3 campaigns and 40 active
keywords writes about 45 rows a day. A test in the Pro repository measures it. Each run makes about 5 requests plus one per active
campaign. The free plan allows 50 per run, so one run covers keyword reports for about 30 active campaigns; past that,
the backfill button continues where the run stopped.

**Limits.**

- Apple counts more installs than FounderData sees. Apple counts installs that were never opened and installs of app
  versions without FounderDataKit. FounderData counts first launches whose token Apple answered for. Compare the trend, not
  the two numbers.
- Revenue to date is what installs from the period brought in so far. A 30-day period's ROAS rises for months as
  subscriptions renew. Pick a 7 or 30-day window to compare periods. Without consent FounderData knows a device for one day only, so a purchase on a later day is credited to
  that day's visit, not to the ad. With consent it stays with the ad (docs/APP-API.md, section 3).
- Apple's days are UTC; the period follows the site's timezone. On a short period they can be a day apart.
- Apple reports a day after it ends, so a period that reaches into today counts Apple's days one day back: **30 days**
  is the 30 days up to yesterday, with the installs of those days. The site's Overview, the App tab, the iPhone and
  `GET /api/v1/asa` read the same days, so spend, cost per paid and ROAS agree. ROAS shows as a percent everywhere.
- Installs from Search Match have a campaign but no keyword. They show as "No keyword (Search Match)", and their
  spend is in the campaign's row only.

## Meta ads (Pro)

Facebook and Instagram ads, from the click to the payment. FounderData imports Meta's spend per ad and day, ties each
visit to the ad that brought it, and puts the customers and revenue it credited next to the purchases Meta claims. Each
site that names an ad account gets a **Meta ads** tab. With the Conversions API on, FounderData also tells Meta about
each purchase, so a campaign can optimize for buyers without a Meta pixel on your site.

Meta ads are off until you set one secret and add an ad account to a site.

### Set up Meta ads

1. **Make a system user token.** In [Meta Business settings](https://business.facebook.com/settings) of the business
   that owns the ad account, add an app under Accounts, Apps, with the Marketing API product. Then open Users, System
   users, add one with the Employee role and assign it three assets: the app (Manage app), the ad account (View
   performance is enough) and, for the Conversions API, the dataset (Manage). Press Generate token, pick the app,
   choose the expiry **Never** and the permission `ads_read`. `ads_read` covers the spend import and the Conversions
   API. Your own ad account needs no App Review.
2. **Set the secret.**

   ```sh
   node scripts/wrangler.mjs secret put META_ACCESS_TOKEN
   node scripts/wrangler.mjs secret put META_APP_SECRET   # optional: adds appsecret_proof to every call
   ```

3. **Pick the ad account.** In the site's Settings, Meta ads, choose the account from the list the token can read.
   When several products share one ad account, enter text that only this product's campaign names contain, like
   `ACME`. Campaigns without it stay off this site. The text matches anywhere in the name, so `ACME` also matches
   `ACME-old`. FounderData imports today and yesterday at once, then the last 90 days, 15 days a run. **Import the last
   90 days** on the Meta ads tab does the same in one go.
4. **Add the URL parameters to every ad.** In Ads Manager, open the ad, Tracking, URL parameters, and paste:

   ```text
   utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{placement}}&ad_id={{ad.id}}
   ```

   `ad_id` ties a visit to its ad. Meta fills the name macros with the name an ad had when it was first published, so
   a renamed ad keeps its old name in the UTM panels; the Meta ads tab joins on the id and shows the current name.
   `utm_term` carries the placement (Instagram stories, Facebook feed...) and `utm_source` the app: `fb`, `ig`, `msg`
   (Messenger), `an` (Audience Network). Settings and the setup checklist have a copy button. A post boosted from your
   page gets no URL parameters; its visits land in the **No ad id** row.
5. **Test the landing pages.** Open each landing page, in every language, with `?ad_id=1234567890123&fbclid=test123456789`
   added, then check the visit in the dashboard's Realtime view. A redirect that drops the query string (`/` to
   `/de/`) loses the ad id before the tracker runs. Fix the redirect to keep it.
6. **Use the account's timezone for the site.** Meta counts days in the ad account's timezone, which you cannot change
   after the account exists. When the two differ, spend and visits of one day can land a day apart, and the tab, the
   API and the setup checklist say so.
7. **Make one real purchase before you spend.** Open a landing page with `?ad_id=1234567890123&fbclid=test123456789`,
   buy (and refund) the cheapest product, and check that the payment shows under that ad id on the Meta ads tab and as a
   linked payment in the launch check. That proves the checkout passes `founderdata.attribution()` and the payment
   webhook arrives.
8. **Set your targets.** Under Settings, Meta ads, enter what a customer may cost (target CPA) and the ROAS at which an
   ad pays for itself after VAT, cost of goods and fees (break-even ROAS). Revenue in FounderData is what the customer
   paid, VAT and shipping included, while Meta's spend has no VAT, so break-even is usually well above 1.0. A printed
   book sold for 49.99 with 19% VAT, 15 of print and shipping and 2 of fees leaves about 25 of margin: break-even ROAS
   is about 2.0, and a target CPA of 20 leaves 5 of profit per customer.

The **Launch check** card on the Meta ads tab, and `launch` in the API, says which of these steps is still open: the
token, the account status, a fresh import, the timezone, visits with an ad id in the last 24 hours, the share of web
payments linked to a visit (the checkout passing `founderdata.attribution()`), and the Conversions API.

Ads that send people to the App Store are a different matter: see the limits below.

### What the Meta ads tab shows

The tab has the period's totals with the change against the period before, a daily chart of spend against revenue,
and a table per campaign that opens into ad sets and ads. Two sets of columns sit side by side.

| Column | Where it comes from |
| --- | --- |
| Spend, Impressions, Link clicks | Meta's numbers for the period's days, spend converted into the site currency at each day's ECB rate |
| CTR, CPC, CPM | Link clicks over impressions, spend over link clicks, spend per 1,000 impressions |
| Visits | Visits that landed with the ad's `ad_id` and started in the period |
| Landing rate | Visits over Meta's link clicks. Below 100% because some people leave before the page loads, often in Instagram's browser, and some block the tracker. Expect 70 to 85% |
| Checkout starts | Visits that reached the site's checkout goal (Settings, Meta ads), or a goal whose name contains `checkout`. With the rate per visit and the spend per checkout start |
| Customers | First purchases credited to those visits. A repeat buyer counts once, at the first purchase |
| Revenue | Every payment credited to those visits, renewals and refunds included, VAT and shipping included |
| CPA | Spend over customers |
| ROAS | Revenue over spend. Compare it with your break-even ROAS, not with 1.0 |
| Meta purchases, Meta ROAS | What Meta attributes to the ad with the ad set's attribution setting: purchases (`omni_purchase`, the Purchases column of Ads Manager) and their value over spend |
| Gap | Meta purchases over FounderData's customers, minus 1. +50% means Meta claims half again as many. Empty while Meta hears of no purchase from the site |

Ad set rows add the optimization goal, the budget and the learning phase (learning, learning limited, active). Campaign
rows add the objective and a campaign budget. Ads add a thumbnail, the status, the hook rate (3-second video plays over
impressions of video ads, so image ads do not dilute it at campaign level), the hold rate (ThruPlays over 3-second
plays), the frequency of the 7 days up to yesterday, and a fatigue flag. The flag compares an ad's last 7 days with the
28 days before, with at least 7 days of spend before and 1,000 impressions in each window. It shows when two of these
hold: link CTR down 15% or more, CPM up 18% or more, hook rate down 15% or more, 7-day frequency above 2.5. In November
and December CPM rises for everyone, so read a "CPM up" flag in the gift season with that in mind.

Every row also gets a label against your targets, never an action:

- **Learning**: under 1,000 impressions or under 3 days since the ad first spent, in its whole life, not only the
  period you look at.
- **Too early**: fewer than 3 customers, and less than 3 times the target CPA spent.
- **No credited sales**: 3 times the target CPA spent over 7 or more days with no customer FounderData could credit,
  on a site where FounderData credits at least half of new customers to a Meta visit. Below half it stays "too early",
  because buyers who came back another day are missing. Check MER, blended CAC and Meta's purchases before you stop it.
- **On target**, **over target**: CPA against the target CPA, or ROAS against break-even when there is no target CPA.

Ads that cannot deliver (disapproved, with issues, in review) show without spend and with a warning, and so does an ad
account that is disabled or has an unsettled payment.

**The period before** is read at the same age: its visits get as long to pay as this period's visits have had. So the
change arrows on customers, revenue, CPA and ROAS compare like with like, and do not show red every day while this
period's buyers are still deciding. Each row carries its numbers then as `prev`, and the API lists the ads that started
and stopped spending.

Below the table:

- **No ad id.** Paid visits from Meta whose URL had no `ad_id`, such as ads made before you added the parameters or
  boosted posts. They count in the totals. Visits with only Meta's click id (`fbclid`) can be organic posts, so they
  show as a count under the table and stay out of the totals.
- **Blended.** MER is all of the site's revenue in the period over all ad spend, and blended CAC is all ad spend over
  all new customers. All ad spend is Meta's plus Apple Search Ads and any [spend you sent](#ad-spend-from-other-channels-pro).
  Neither depends on attribution. The share of new customers FounderData credited to a Meta visit
  tells you how much of the picture the per-ad columns hold. Below half, trust MER and blended CAC over per-ad CPA.
- **By Meta app and by placement**, from `utm_source` and `utm_term`.
- **Median days to purchase** from the ad visit.

**Revenue window** picks **To date**, **1 day**, **7 days** or **28 days**: customers and revenue that came within that
many days of the ad visit (`?window=1`, `7` or `28` on the API). 7 and 28 days match Meta's 7-day and 28-day click windows.

The tab warns when Meta counted 20 or more link clicks and no visit carried an ad id, when an ad had 30 or more link
clicks and no visit with its id, when fewer than 60% of 100 or more clicks arrived, when the last import failed or is
more than 2.5 hours old, when the account and the site count days in different timezones, and when Meta hears of no
purchase from the site.

**Running without the Conversions API.** Until it is on (and with marketing consent gating, until your banner gives
consent), Meta learns of no purchase. Optimize for link clicks, judge creatives by CTR, CPC, landing rate and cost per
checkout start, and read CPA and ROAS only after the median days to purchase has passed. MER and blended CAC stay the
check that does not depend on attribution.

**Alerts.** Threshold alert rules take `meta_spend`, `meta_roas`, `meta_cpa` and `meta_cac` on whole days up to
yesterday, like the Apple Search Ads metrics, and read the window before at the same age. `meta_cac` is all ad spend
(Meta's, Apple Search Ads and what you sent) over every new customer, from any source. It does not depend on
attribution, so start with it. With spend and no
customer yet, `meta_cpa` counts as Meta's whole spend and `meta_cac` as all ad spend. So "blended CAC rises above
40 € over 7 days" also fires when your ads spent 40 € in total and nobody bought, even with no Meta spend. Its minimum
volume counts the clicks of every channel: Meta's link clicks, Apple Search Ads taps and the clicks your rows send. `meta_spend` with `falls_pct` catches delivery that stopped. The daily
numbers message adds a line per site with yesterday's spend, customers, revenue, and CPA and ROAS from 3 customers on.

**Agents.** `GET /api/v1/meta` and the MCP tool `get_meta_ads` return the tab's numbers ([API.md](API.md#meta-ads-pro)). A
key without revenue gets Meta's side and the visits, without customers, revenue or anything derived from them. They
only read. To change a budget or pause an ad, use Ads Manager or Meta's own ads MCP server.

### Meta Conversions API

Without a Meta pixel or the Conversions API, Meta never learns who bought. A Sales campaign then has nothing to optimize
for but link clicks or reach. With the Conversions API on, FounderData sends a `Purchase` to your dataset for each new
web payment.

**Create a dataset.** In Events Manager, Connect data sources, Web, name it and pick the Conversions API, not the
pixel. Its id is the dataset id, not the ad account id. Assign the dataset to your system user with Manage.

**Turn it on.** In the site's Settings, Meta ads, enter the dataset id and pick a mode:

- **Buyers who came from a Meta click** sends a purchase when the buyer's visit in the 28 days before carried an
  `fbclid` or an `ad_id`.
- **Every web purchase** also sends buyers who came another way, so Meta can match people who saw an ad and came back
  later, by their hashed email. Meta needs the browser's user agent for a website event, so in this mode every visit
  with marketing consent keeps its user agent for 28 days.

**Marketing consent.** "Only visitors who gave marketing consent" is on by default. FounderData then sends only buyers
whose visit carried it. Meta asks you not to send people who did not consent, and its API has no consent flag. Marketing
consent is separate from analytics cookies: your banner's marketing or advertising category calls
`founderdata('marketing', true)`, and withdrawing it calls `founderdata('marketing', false)`. A site that sets it
another way can add `data-marketing="on"` to the script tag. A site with no banner sends nothing in this setting, and
the setup checklist says so. Turning the switch off takes a confirmation, and FounderData keeps when it happened. Do it
only with another legal basis ([PRIVACY.md](PRIVACY.md#meta-ads)).

**What it sends.** The cron sends what is pending every 5 minutes, once a payment is 5 minutes old so its visit link has
settled. Meta recommends events within an hour for optimization and refuses them after 7 days.

| Field | Value |
| --- | --- |
| `event_name`, `event_id` | `Purchase` and the payment id, so a browser pixel that sends the same purchase with that `eventID` is counted once |
| `action_source`, `event_source_url` | `website` and the landing page of the buyer's visit |
| `custom_data.customer_segmentation` | `new_customer_to_business` for a first purchase, `existing_customer_to_business` for a repeat one-time purchase |
| `em` | SHA-256 of the buyer's email from the payment provider, trimmed and lowercased |
| `fbc` | `fb.1.<ms>.<fbclid>`, rebuilt from the click id and the time FounderData first saw it |
| `fbp` | The Meta browser id from the `_fbp` cookie, when a Meta pixel on your site set one and the visit has marketing consent. The tracker reads it only with marketing consent |
| `client_user_agent` | The user agent of the ad click |
| `external_id` | SHA-256 of the payment provider's customer id |
| `country`, `ct` | SHA-256 of the visit's country and city |
| `value`, `currency`, `order_id`, `content_ids` | The amount in major units as the customer paid it, its currency, the payment id and the product |

FounderData never stores an IP address, so it sends none. Email, click id and browser id are the keys Meta weighs most; expect
Events Manager to rate match quality lower than a pixel setup with IP addresses would get. FounderData skips a payment
Meta could not match (no click id and no email), one with no user agent, App Store and RevenueCat purchases,
subscription renewals, refunds, and every payment from before the moment you turned it on. Settings shows what it sent,
failed and skipped in the last 7 days, with the reasons. A refused event goes again alone after 15 minutes: up to 5
times when Meta refused the event itself, and until the event is 7 days old when the problem was the token, a
permission, a rate limit or Meta. Fix a token and the waiting events go.

**Goals as standard events.** A new account has few purchases to learn from. Map up to 10 goals to Meta's standard
events, such as `checkout_click` to `InitiateCheckout`. Goals go only for visits that came through a Meta click, and a
failed send goes again on the next tick.

**The order that works for a new account.** Meta lets you pick an event to optimize for once it has received some.

1. Start with a small traffic ad set, optimizing for link clicks, so ad visits happen.
2. Mapped goal events (`InitiateCheckout`) and purchases arrive in Events Manager.
3. Create the sales ad set optimizing for `InitiateCheckout`.
4. Move to `Purchase` once about 50 purchases a week are realistic for it.

**Test it.** Copy the test code from Events Manager, Test events, into the site's settings and press **Send test
event**. The test is a custom event named `FounderDataTest`, because Meta counts events with a test code like any other.
The code goes only with the test. Real purchases go without it and show in Events Manager's overview within about 20
minutes. The test event does not make Purchase or InitiateCheckout selectable in Ads Manager; real events do.

### Limits

- **Cookieless visitors change at midnight UTC.** "Clicked the ad on Monday, bought on Wednesday" counts for the ad in
  FounderData only when the visitor had cookies after consent. Otherwise the payment goes to Wednesday's visit. Meta's
  column counts it only when the Conversions API (or a pixel) sent the purchase and Meta matched the email. The same
  limit applies when a buyer leaves Instagram's browser for Safari.
- **The checkout has to carry the visitor.** A payment counts for an ad only when FounderData links it to the visit.
  Pass `founderdata.attribution()` into your checkout's metadata (see
  [Revenue attribution with Stripe](#revenue-attribution-with-stripe)), or the match falls back to email and timing.
- **App installs are out of reach.** For an ad that goes to the App Store, or a page that sends people on to it,
  FounderData cannot follow the person into the app. Meta's own numbers (SKAdNetwork and Aggregated Event Measurement)
  cover those campaigns, and they show in Meta's columns only.
- **Meta restates.** Meta corrects conversions for up to 28 days. The hourly run reads today and yesterday again, the
  03:45 UTC run days 2 to 9, which covers the 7-day click window, and on Mondays days 10 to 28.
- **Advantage+ and dynamic creative** fill `{{ad.id}}`, but several creative variants share one ad. Read the campaign
  row for those. `{{placement}}` stays empty for some automatic placements.
- **Refunds stay out of Meta.** Meta has no refund event, so Meta's ROAS stays higher than FounderData's, which nets
  refunds.
- **Thumbnails are not stored.** Meta signs their addresses and they expire, so the tab asks Meta for them when it opens.

**What it costs.** The spend import writes 2 D1 rows per new ad and day (the row and its index entry), 1 per new or
changed campaign, ad set or ad (name, status, budget, learning phase, frequency), and 1 status row per run. A run that
finds nothing new writes 1. Today's rows change every hour as spend comes in, 1 row per active ad and run, so an account
with 20 active ads writes about 500 rows a day. Each run makes 5 to 7 requests per account. The Conversions API writes 1
row per purchase it sends or skips, plus 1 for the site's status when it changes; mapped goals write none; a tick with
nothing pending writes 0. Ad clicks ride on the session row and cost nothing extra. A test in the Pro repository measures it.

## Subscriptions (Pro)

Each site with Stripe, the App Store, RevenueCat or Dodo gets a **Subscriptions** tab: MRR, paying subscriptions,
trials, trial to paid, churn and LTV, an MRR chart with new and churned MRR under it, and tables by channel, referrer,
campaign, provider and product. The home page shows MRR on each site card and in the totals once any site has a
subscription.

FounderData keeps one row per subscription in the `subscriptions` table (migration `0017`). Each lifecycle event updates
it, 1 row written per event (see the cost table above):

| Provider | Events |
| --- | --- |
| Stripe | `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid`, `invoice.payment_failed`, and the subscription Checkout. Add the first four to the webhook endpoint ([Stripe section](#revenue-attribution-with-stripe)). |
| App Store | Purchases from FounderDataKit, and the App Store Server Notifications `SUBSCRIBED`, `DID_RENEW`, `DID_CHANGE_RENEWAL_STATUS`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED` and `EXPIRED`. |
| RevenueCat | `INITIAL_PURCHASE`, `RENEWAL`, `PRODUCT_CHANGE`, `CANCELLATION`, `UNCANCELLATION`, `EXPIRATION`, `BILLING_ISSUE`. |
| Lemon Squeezy, Polar, Paddle | Their subscription events ([their section](#revenue-attribution-with-lemon-squeezy-polar-paddle-and-gumroad)). |
| Dodo Payments | `payment.succeeded` of a subscription, `subscription.active`, `.renewed`, `.plan_changed`, `.on_hold`, `.cancelled`, `.expired`, `.failed` ([Dodo section](#revenue-attribution-with-dodo-payments)). |

Events arrive late and out of order. The first payment, the trial start and the end of the paid period keep their
earliest or latest value whatever the order. The price, the plan, auto-renew and the end follow the newest event.

**Source.** A subscription is credited like a payment: the buyer's last visit from a real source before the
subscription started. The row keeps that visit's channel, referrer and campaign, so the split survives when old visits
are deleted after 24 months. Web and App Store subscriptions sit in the same tables. On this tab only the channel,
referrer and campaign filters apply.

**How each number is computed.** Money is in the site's currency.

| Number | How |
| --- | --- |
| MRR | Every paying subscription at its price per month, at the end of the period. A year counts 1/12, a week 52/12, a day 365/12, and a 3-month plan 1/3. A price in another currency converts at the ECB rate of the day the price was set. |
| Paying subscriptions | Subscriptions with a first payment and no end yet. Past due ones count until they end; auto-renew off ones count until their period ends. |
| Active trials | Started, not paid yet, not ended and before the trial's end. |
| New, expansion, contraction, churned MRR | New: first payments in the period. Expansion and contraction: a paid subscription that changed price. Churned: the MRR of subscriptions that ended in the period. MRR at the end equals MRR at the start plus new and expansion, minus contraction and churned. |
| Trial to paid | Trials that started in the period and paid within 3 days of the trial's end (30 days from the start when the end is unknown), over the trials that started and are decided. Trials that can still convert are left out. `?trial_days=N` uses N days from the start instead. |
| Churn | Subscriptions paying at the start of the period that ended in it, over those paying at the start. The tile says both counts, for example "2 of 15 paying at the start ended", and how many more started and ended inside the period. Those count in churned MRR, not in the rate. Revenue churn is the MRR of the ones paying at the start over MRR at the start. |
| ARPU, LTV | ARPU is MRR over paying subscriptions. LTV is ARPU over churn per 30 days, which comes from the period's churn. The tab shows LTV per billing period (weekly, monthly, yearly) in the LTV tile and the By billing period table, because a weekly plan churns every week and a yearly plan cannot churn before its first renewal. With no churn in the period there is no LTV; a period whose subscriptions never renewed or ended says "no renewal yet". |
| Refund rate | Refunds over payments of subscriptions in the period. |
| Failed payments | Subscriptions whose latest failed payment falls in the period. |

**What counts as churn.** A paid subscription churns when it ends: Stripe's `customer.subscription.deleted`, the App
Store's `EXPIRED`, RevenueCat's `EXPIRATION`. Turning auto-renew off is not churn; the subscription churns when its
paid period runs out. A trial that ends unpaid is not churn either, it is a trial that did not convert. When no renewal
and no end event comes for 30 days after a paid period ran out, the subscription counts as ended on the day the period
ran out. A payment after the end starts the subscription again, as new MRR.

**Payments from before.** The first time the tab opens, FounderData turns stored payments that name a subscription into
rows, 1 row written per subscription: Stripe payments recorded before, Dodo payments from before its webhook kept
subscriptions, and App Store and RevenueCat
purchases with a renewal or a free trial. The period is the median gap between payments, or a month when there is one
payment (a year or a week when the product name says so). `POST /api/sites/:id/subscriptions/backfill` runs it again.

**API.** `GET /api/sites/:id/subscriptions?period=30d&split=channel` (or `source`, `campaign`, `product`, `provider`),
with the dashboard's `period`, `from`, `to` and `filters`. It answers `current` (every number above), `series` (MRR at
the end of each day or week, with its movement, and `trials` and `trialsConverted` by the day the trial started), `intervals` (the same numbers per billing period: `week`, `month`,
`year`, `other` for plans like 3 months, `unknown` without a price) and `rows` (the same numbers per value of the split,
50 at most). On the campaign split, rows whose label is an Apple Search Ads campaign id carry its `name`. Each set of
numbers has `churnedOfStart` and `churnedMrrOfStart` (the numerators of churn and revenue churn), `trialsEnded` (trials
decided without a payment) and `renewedOrEnded` (paid subscriptions that ever renewed or ended). `money=net` gives App
Store and RevenueCat amounts after [Apple's cut](#apples-cut-pro) and adds `net`, the shares used. Every number is a sum in
SQL over the site's rows, so a load reads each subscription once.

**Export.** The tab's Export CSV button downloads every subscription row behind these numbers, with its MRR, dates,
status, customer email and source, whatever the period. The columns are in [API.md](API.md#csv-export).

**Limitations.**

- Stripe MRR is what the customer pays after coupons. A coupon in the subscription event counts at once. A coupon for
  the first invoice only (`once`), or one that has ended, takes nothing off. Since Stripe API 2025-03-31, the
  subscription event names a coupon only by its id. FounderData then takes the amount from the discount lines of the next
  paid invoice. Until that invoice arrives, for example during a trial, the subscription counts at list price. The MRR
  tile's tooltip says this. App Store prices are what the customer pays, tax included, unless you switch to After
  Apple's cut.
- A subscription records one price change: several upgrades show as one, at the time of the last.
- App Store renewals and cancellations need App Store Server Notifications or RevenueCat. With FounderDataKit alone, a
  subscription counts until 30 days after its first period runs out.
- Stripe trials need the `customer.subscription.*` events. A $0 trial invoice says nothing about the trial.
- A subscription that comes back after it ended loses the stretch before from the history.
- Sandbox subscriptions are stored apart and never count.

### Cohorts (Pro)

The Subscriptions tab ends with a retention grid. Each row is a cohort: the subscriptions that first paid in one
calendar month of the site's timezone. Each column is a month since then. Column k shows how many of the cohort still
pay at the start of month k, so month 0 is the cohort's size and month 1 is the first renewal. The grid shows the last
12 months, and the bottom row averages the cohorts that reached each column, weighted by size.

- **Customers or revenue.** Customers is the count still paying over the cohort size. Revenue is the cohort's MRR at that
  point over its MRR at the first payment. An upgrade raises it and a downgrade lowers it, so it can pass 100%. Each
  subscription records one price change, as in the metrics above. A subscription with no price counts as a customer and
  adds 0 to revenue.
- **By first payment or trial start.** With trial start, a row is the trials that began in that month. A trial that
  never paid counts in the size and not in any later column, and its month 0 revenue is 0.
- **Split.** All, Plan, Provider, Channel or Referrer. A split adds a table of the average per value, the 10 largest by
  subscriptions. Click a row to show only that value's cohorts. Channel and Referrer are the visit each subscription is
  credited to, so you can compare the retention of subscribers from Google with those from a launch tweet.
- **Click a cell** to list its subscriptions: id, provider, plan, source, first payment, MRR at that month and whether
  it still pays, with the lost ones first. 200 at most. Names and emails are not part of the list.
- Sandbox subscriptions are left out. After Apple's cut applies when the Subscriptions tab is set to it.
- A row with fewer than 30 subscriptions has a dagger: one customer moves its rate by more than 3 points.

**API.** `GET /api/sites/:id/cohorts?by=paid&cohorts=12&split=product`. `by` is `paid` or `trial`. `cohorts` is 1 to 24.
`split` is `none`, `product`, `provider`, `channel` or `source`. `provider`, `product`, `channel`, `source` and
`utm_campaign` filter the rows, and an empty value matches the rows with none. `money=net` is as above. It answers
`cohorts` (per cohort: `size`, `retained` and `retention` per month, `mrr0`, `mrr` and `revenueRetention` per month),
`average` (the same per month, with `cohorts` counting how many reached it), `groups` (the average per split value, 10 at
most, `more` says how many were left out) and `options` (the providers and plans to filter by). Add `cohort=YYYY-MM` and
`month=k` to list one cell: `size`, `retained`, `truncated` and `rows`. The agent route is `GET /api/v1/cohorts` and the
MCP tool is `get_subscriptions` with `view` `cohorts` ([MCP.md](MCP.md)).

The query reads the site's subscription rows in one pass, grouped in SQL, and writes nothing. The Worker receives at
most 24 rows, or 24 times 10 with a split.

### Check MRR against Stripe (Pro)

A new tool's MRR means little until you can see it match the one you already trust. The **Check against Stripe** card at
the bottom of the Subscriptions tab (shown when the site has a Stripe subscription) compares FounderData's MRR with
Stripe's own subscription list, right now.

1. In Stripe, open Developers, API keys, and create a restricted key. Set **Subscriptions** to Read and leave every
   other permission at None. Nothing else is needed: coupons come inside the subscription, and the check never reads
   customers, charges or invoices.
2. Paste the key (`rk_live_...`) in the card and press **Check against Stripe**. Test mode keys are refused.

The check lists the subscriptions with status `active` and `past_due`, which are the two statuses Stripe counts in its
own MRR (a `trialing` subscription is not counted there, and a `paused` one is not listed). Stripe returns at most 100 per
request, so the card asks again until Stripe has no more, and each request makes one Stripe call and no database write.
A site with 3,000 subscriptions takes 30 requests. The browser carries the progress between requests. The server keeps
not the key and not a subscription. A finished check keeps its totals (see below).

**History.** Each finished check stores one row for its day in the site's timezone: FounderData MRR, Stripe MRR, the
number of gaps, what the gaps are worth a month (a subscription in one side only counts its amount, a different amount
counts the difference) and the result, matches or differs. A second check the same day replaces that day's row, so a
site writes one row a day however often you check. The card shows the last 30 days as a table, newest first. The
cleanup at 03:17 UTC deletes rows older than 400 days, and deleting a site deletes its rows. `GET /api/sites/:id/stripe-check/history`
answers with them without a Stripe call, and every answer of the check carries them as `history`. Agents read the same
field in `get_subscriptions` with `view` `stripe_check`. The check only runs when someone starts it, so a day nobody
checked has no row, and the daily numbers say how old the last result is.

**How each subscription becomes a monthly amount.** The check runs the Stripe subscription through the same code the
webhook uses, so the two sides follow one set of rules:

- Price per period times the quantity, per item, and the items added up.
- A year is divided by 12, a week is multiplied by 52/12, a day by 365/12, and a billing period of N months or years is
  divided by N. The result is rounded to a whole minor unit.
- A coupon that is still running takes its percent or amount off, per item and then on the whole subscription. A coupon
  with duration `once`, or one that has ended, takes nothing off. A discount in another currency than the price is not
  applied, and the subscription then counts at list price.
- Amounts are in the minor units of the currency (a zero-decimal currency such as JPY has none). A subscription in
  another currency than the site is converted at the ECB rate of today. FounderData converted its own copy at the rate
  of the day the price last changed, so a rate move shows up as a small difference. A difference under 2% on a
  converted subscription is not listed, but it stays in the totals.
- A trial, a subscription set to cancel at the period end and a past due subscription all count at full price, as they do
  in the Subscriptions tab, until they end.

FounderData's side is the Stripe subscriptions the Subscriptions tab counts as paying today, at their current price.
App Store, RevenueCat and Dodo subscriptions are in neither number. A subscription that another site on the same
FounderData holds is skipped and counted as `other_site`.

**The result.** Stripe MRR, FounderData MRR, the difference in money and in percent of Stripe MRR, and a green "Matches
within 0.5%" when the difference is at most 0.5% of Stripe's number. Otherwise a short explanation and a list of the
subscriptions that differ, each with both amounts and the likely reason:

| Kind | Meaning | Reasons the check names |
| --- | --- | --- |
| In Stripe only | Stripe lists it and FounderData does not count it as paying | no record (the webhook never delivered it, or it is older than the webhook), ended, lapsed, no first payment |
| In FounderData only | FounderData counts it and Stripe does not list it | canceled, trialing, unpaid, paused or not found in Stripe. The first 10 are looked up one by one, so the status is exact for them |
| Different amount | Both count it, the monthly amounts differ by more than 1 minor unit | currency, discount, quantity above 1, paused collection, a recent trial end, cancel at period end, or a price change whose webhook has not arrived |

The list shows the first 40 differences. The counts and the sums in the answer cover all of them. The "in FounderData
only" part needs the ids of FounderData's paying Stripe subscriptions, and the check tracks up to 500. Above that it
skips that part and says so. The other parts stay exact.

**MRR at the end of each past month.** Under the card, a table shows FounderData's own MRR at the end of each of the
last 12 months, in the site's timezone. Stripe's API has no historical MRR, so the check cannot compare these with
Stripe. Look up the same months in your Stripe dashboard and compare by hand. FounderData has each subscription's first
and latest price and the time of the change, so a subscription that changed price twice shows its first price until the
last change. A subscription FounderData learned about late, for example one from an imported history, is only as
complete as that data. The route is `GET /api/sites/:id/mrr-months?months=12`.

**Agents.** `POST /api/v1/stripe-check` and the MCP tool `get_subscriptions` with `view` `stripe_check` run the same check with a key that has
`read:revenue`. An agent cannot send a Stripe key. A restricted key of the deployment does the work, and only for the site it belongs to. Sites on different Stripe accounts each need their own:

```bash
node scripts/wrangler.mjs secret put STRIPE_RESTRICTED_KEY_<SITE ID IN CAPITALS>   # rk_live_..., Subscriptions: Read only
```

One Stripe account for every site works with `STRIPE_RESTRICTED_KEY` and `STRIPE_RESTRICTED_KEY_SITES`, the site ids it belongs to, separated by commas. A deployment with a single site needs only `STRIPE_RESTRICTED_KEY`. Without a key for the site the route answers `400` and says so, so a key for site B never reads site A's Stripe account. The dashboard card, behind your login, also uses `STRIPE_RESTRICTED_KEY` when you leave the field empty. The check reads 50 subscriptions a call, and a subscription that changes status while it runs can move the total, so run it again before you trust a small difference. The 50 is an estimate for the free plan's 10 ms of CPU, not a measurement.
See [API.md](API.md#post-apiv1stripe-check-pro) and [MCP.md](MCP.md).

### Apple's cut (Pro)

The Subscriptions tab and the Apple Search Ads card have a **Gross / After Apple's cut** switch. The choice holds for
both. Gross is what customers paid, tax included. After Apple's cut scales App Store amounts, and RevenueCat
subscriptions on the Subscriptions tab, to what you keep. Stripe and other web payments stay as they are.

The share you keep is set per product:

- When the App Store Connect sales import has the product, Apple's own ratio: developer proceeds over customer price,
  over the units sold in the last 365 days in rows where both are in one currency. It takes out the commission and the
  VAT Apple pays for you, so it matches the payout.
- Otherwise, 1 minus the **App Store commission** in Settings, Payments, App Store: 15% (Small Business Program, the
  default) or 30%. That takes out the commission only. `PATCH /api/sites/:id` with `{"app_commission": 30}` sets it.

The footnote next to the switch names the products that use Apple's ratio. Home and the overview stay gross.

## How revenue is counted

Revenue is every payment that is not an App Store sale (Stripe, Dodo, the payments API, RevenueCat outside the App
Store), plus App Store revenue. One function computes the App Store part for every view: the home page tiles, chart,
site cards and sources, a site's overview, chart, source panels and revenue by provider, the Apps page and the mobile
summary and widgets, current and previous period alike (`src/worker/revenue.ts`).

App Store revenue, per site and day:

- **A day FounderData has imported from Apple's report** (status ok or zero), for a site whose app is matched in App Store
  Connect: Apple's report is the source. FounderData takes the gross customer amount, `units * |customer price|` in the
  customer's currency, for in-app purchases, subscriptions and paid downloads. Refund rows have negative units and
  subtract. Each day converts into the site currency at that day's ECB rate. A report day counts as the same calendar
  day in the timezone you read in, though Apple's day runs on Pacific time. A sale late on a Pacific evening can sit
  one day off from the payment row of the same sale.
- **Any other day** (today, yesterday until the 10:30 UTC import, any gap, the import switched off, an app not matched):
  the App Store purchases FounderData recorded from FounderDataKit, App Store Server Notifications and RevenueCat. Sandbox
  purchases never count.

On an imported day the App Store payment rows stay out of revenue and out of the purchase count, so no sale counts
twice. Only whole days use the report. A rolling 24 or 48 hours keeps the recorded purchases for the day it cuts
through, and an hourly chart puts a report day at 00:00.

Attribution stays per payment. Sources, channels, campaigns, the Customers tab and customer lists use payments, because
Apple's report says nothing about visitors. Panels that split revenue by where it came from (channel, source, referrer,
campaign, UTM fields) get two more rows, and with them they add up to the Revenue tile:

- **No source**: payments that are not App Store sales (Stripe, Dodo, the payments API) and have no linked visit.
- **App Store, no source**: App Store revenue in the range minus the App Store payments linked to a visit, never
  below 0. If linked App Store payments ever exceed Apple's report (a sale late on a Pacific evening), the panel can
  sit above the tile by that amount.

A payment credited to a visit from before the period counts for that visit's source, so a source can show revenue
with 0 visitors. The home page lists the ten biggest sources plus every other source that made money. Revenue by
provider shows one App Store line by the same rule. RevenueCat purchases made in the App Store are part of that line.

New customers and conversion rate stay payment based: Apple's report has no customers. Every customer count on the
home page and a site's dashboard, the per-source columns included, counts new customers: visitors with a payment in the
period that is not a renewal. Renewals add revenue, not customers. A payment without a visitor counts by the
provider's customer id, so one Stripe or App Store customer who buys two products counts once. Revenue is after
refunds everywhere, the Apps page included. The home page's Web visitors tile adds up each website's visitors, so a
person who visits two sites counts twice. App visitors have their own tile, and bounce rate and session time count web
sessions only. Each conversion rate on the home page counts the new customers whose payment is linked to a visit on
that platform, over that platform's visitors. Payments with no linked visit count in the New customers tile but in
neither rate.
On an app, a visitor without consent is one device on one day, however often the app opens (docs/APP-API.md, section 3).
A device that comes back the next day counts again. Next to Visitors, New installs counts installs with consent first seen in the period. App
Store Connect and RevenueCat count every install, so expect their number to be higher unless all users consent.
Purchases include the units
Apple reports as sold on imported days. With a filter on a site's dashboard, revenue counts only payments linked to
matching visits, so the report stays out.

### One number everywhere

The same metric for the same period reads the same on web Home, the iPhone's Home, a site's page and the read API,
to the cent. Three rules make that hold, and the dashboard labels the places where a number is deliberately another
one.

- **One timezone for the cross-site views.** Home, the iPhone, `/api/v1/portfolio`, `/api/v1/weekly`, the widget
  summary and the Monday report count days in the reporting timezone (Settings, General). Unless you pick one, it is
  the timezone all your sites use, or UTC when they differ. A site's page counts in the site's own timezone. When the
  two differ, the page shows "Days in Europe/Berlin" under the toolbar, and Settings has a button that moves every site
  onto the reporting timezone. `docs/API.md`, "Reporting timezone", has the routes.
- **Revenue says what it adds up.** Payments count at what the customer paid, minus refunds, before the provider's
  fees. App Store sales count at the customer price with tax, before Apple's cut. Home's Revenue tooltip splits the
  total into the two, and `/api/home`, the site overview and `/api/v1/portfolio` carry `basis` per site:
  `net_of_refunds`, `app_store_gross` or `mixed`. A small chip next to Home's Revenue and a site's Revenue tile says
  `net`, `gross` or `mixed`, and the weekly report names the basis under its first line.
- **MRR says what moved it.** Under Home's MRR, one line splits the change into new, expansion and churned. New plus
  expansion minus churned is the change. Churned includes price cuts.
- **Linked revenue is labeled.** The Content list, and panels like Browser or Country, only see revenue linked to a
  visit. They say "linked to a visit", and the Content list shows what no entry page explains. Revenue by provider
  adds up to the Revenue tile and shows each provider's share.

A page detail in the Content tab reads its last 12 weeks, whatever the period picker says, and its tiles say so. Its
"Changes to this page" card opens on 7 days. Its pill is the note's own verdict, the same one the Overview shows: an
SEO change gets 28 days of Search Console clicks.

### No payments connected

A site with no payment provider set up (no webhook secret, no Gumroad ping URL, no app bundle id) and no payment ever
recorded is a content site: a blog, docs, a marketing page. Its dashboard leaves out the Revenue, Conversion rate and
Revenue per visitor tiles, the revenue bars and columns, and the revenue panel. It shows Visitors, Pageviews, bounce
rate and session time, and one line, "Connect payments to see revenue per source", that opens Settings, Payments. Goals
keep their conversion rates. On the home page its card shows bounce rate and session time instead of revenue and
conversion. The first payment, from any provider or the payments API, or a provider's secret, turns revenue back on.
`GET /api/sites` returns `payments_connected` per site, and `GET /api/home` returns `payments` per site.

### Primary goal

A blog or a free tool earns nothing, so revenue can't say how it is doing. Pick its primary goal in the site's
Settings, Primary goal: one of the goal names it sent in the last 90 days, such as `newsletter_signup`, and a label
such as "Signups". Then:

- Home's ranked list shows "Signups 41 -13%" in the Revenue column of a site without revenue, and its card shows
  Signups in place of session time. A site with revenue shows it as a line under MRR.
- The Content tab gets a Signups column next to Customers, which you can sort by.
- The weekly report gets a line such as "Signups: 41, -13% (-6)", and `/api/v1/portfolio` and `/api/v1/weekly` get a
  `goal` field ([API.md](API.md#primary-goal)).

It counts visitors, once each: the visitors with a visit that started in the period and sent the goal. In the Content
tab it counts the visits that started on the page. Saving it writes 1 row; counting it reads only.

### Payments not linked to a visit

A payment counts for a source only when it is linked to a visit. The overview shows how many are, under the tiles:
"72 of 80 payments ($6,120 of $6,650) are linked to a visit. 8 are not." Each payment provider in Settings shows the
same for the last 30 days: "12 payments in 30 days, 11 linked to a visit". **How to fix** lists the causes per
provider. Each payment counts once, under the first cause that applies:

1. **Made before the site's first recorded visit**, such as Stripe history you imported or sales from before the
   script was installed. Nothing can link these.
2. **A renewal** whose first payment is not linked. Renewals link through an earlier payment of the same customer, so
   they follow once the first payment links.
3. **Has the buyer's email**, but no visitor was identified with it. Call
   `window.founderdata('identify', { user_id, email })` at signup or login, then press **Try matching again** on the
   Customers tab.
4. **No visitor id**. The checkout did not carry the ids:
   - Stripe: put `window.founderdata.attribution()` in the Checkout Session `metadata` and `subscription_data.metadata`
     ([Stripe](#revenue-attribution-with-stripe), step 2).
   - Dodo Payments: pass `rt_visitor_id` and `rt_session_id` as metadata and set the return URL to a page with the
     script ([Dodo](#revenue-attribution-with-dodo-payments), steps 2 and 3).
   - App Store: buy with `product.purchase(options: [.appAccountToken(FounderData.appAccountToken)])`.
   - RevenueCat: call `Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes)` before each purchase.
   - Payments API: send `visitor_id` with each payment.
   - Other providers: put the ids from `attribution()` in the checkout's custom data.

The count covers payments only: no refunds, no other revenue and no sandbox purchases, for the whole site whatever
the filters. Linked means the payment is credited to a stored visit, the same rule as the No source row. Revenue from
Apple's sales report has no payment rows, so it is not in these numbers. `GET /api/sites/:id/coverage` (with the
dashboard's `period`, `from` and `to`) returns them: `payments`, `linked`, `amount` and `linkedAmount` in minor units of
the site currency, and `providers[]` with the same fields plus `notLinked` (`beforeTracking`, `renewals`, `withEmail`,
`noIds`).

## Phone app and push (Pro)

The owner's iPhone app in FounderData Pro has widgets
and payment pushes. [MOBILE-API.md](MOBILE-API.md) is its contract. It signs in to one deployment with the admin password and gets a device token. The token reads `/api/home`, `/api/apps` and
`/api/sites/...` like the dashboard cookie does, but it can't change anything there: any request other than GET or HEAD
gets HTTP 403. A lost phone can't edit, rotate or delete a site. It reads no secrets either: the site's write key,
webhook secrets and tokens come back as `null`, and share links, read keys and alert channels answer 403, so the token
can't be used to post fake payments. The one change a phone may make is adding or deleting a chart note. A phone sees
and revokes only itself. The Settings page lists the signed-in phones
with a Revoke button, and a new admin password signs them all out (see [Deploy](#deploy)). The routes, payloads and settings
are in [MOBILE-API.md](MOBILE-API.md).

A new real payment, a refund or a trial pushes to every phone whose settings allow its event, site and product. A repeat
delivery of the same payment never pushes, and neither does a sandbox purchase. Push stays off until the Worker has all
three APNs secrets. Create an APNs auth key (Keys in the Apple developer account, with Apple Push Notifications
service enabled), then set:

```bash
node scripts/wrangler.mjs secret put APNS_KEY_P8     # the contents of the AuthKey_XXXXXXXXXX.p8 file
node scripts/wrangler.mjs secret put APNS_KEY_ID     # the 10-character key id
node scripts/wrangler.mjs secret put APNS_TEAM_ID    # the 10-character team id
```

`POST /api/mobile/push-test` from the app sends a test alert and a widget push, and answers HTTP 503 `APNs not configured`
while a secret is missing. Run `npm run db:migrate` for migration `0009_mobile.sql`
before the first sign-in.

Two pushes arrive on a schedule, at 08:00 in the reporting timezone. Every morning, **Since yesterday** sends the numbers
of the phone Home's card in one notification: "$597 revenue, 1 trial, 7 new customers", plus Search Ads spend, cost
per paid and ROAS when Apple Search Ads is connected. A site with a Meta ad account adds a Meta ads line: the latest
day's spend, then cost per customer and ROAS over 7 days. When the hourly run is short of subrequests, the push goes
out without that line. On Mondays, the weekly report sends the same sentences as
`GET /api/v1/weekly`. A tap on either opens Home. Both are on for every phone; switch them off under **Alerts** in the
app. Renewals under $5 (5 in the first site's currency) send no push, so a $2.99 subscription doesn't buzz every day.
The same screen sets the amount, or 0 for every renewal. The schedule needs the 5-minute cron, `*/5 * * * *` in
`wrangler.jsonc`, and migration `0032_scheduled_push.sql`. The run at minute 0 of each hour does the hourly work. A
deployment that keeps its crons in `wrangler.local.jsonc` can keep `0 * * * *`, which runs the same hourly work,
but then DataForSEO rank checks and AI checks run once an hour, 24 times a day, not 288. Replace `0 * * * *` (or the
old `0 7 * * *`) with `*/5 * * * *` there to get the numbers in the README. The 07:00 UTC run sends the alerts below.

## Alerts and weekly report

FounderData can post to Slack, Discord, Telegram, any JSON webhook, or email. Open **Notifications** on the home page and
add a channel. Each channel has a **Send** button with a list next to it: a plain test message, a preview of any
alert below with made-up numbers on one of the channel's sites, last week's real report, or yesterday's real numbers. So you can see each alert
before anything real happens. Channels cover the whole deployment: every site, or the sites you tick.

| Alert | When | Default |
| --- | --- | --- |
| New payments | As each payment arrives: amount, product, source and provider | on |
| Renewals | Each subscription renewal | off |
| Refunds | Each refund | on |
| Trials started | App Store and RevenueCat free trials | off |
| Payment failed | When a paying subscription's renewal fails: customer, product, MRR at risk, provider and source | on for new channels |
| Subscription canceled | When a paying subscriber turns off auto-renew, or the subscription ends without that: customer, product, MRR lost, provider and source | on for new channels |
| Worth a look | 07:00 UTC, only when a site went quiet or its visitors doubled or halved | on |
| Payments stopped arriving | 07:00 UTC, when a payment provider went silent for longer than its usual rhythm explains | on |
| Webhooks refused | At once, when a payment webhook arrives with a bad signature or token. Once a day per site and provider | on |
| Write cap reached | When a site hits its daily write cap, or all sites fill the shared one. Once a day at most | on |
| ASO collector stopped | Daily at 07:00 UTC, when an app with ASO keywords got no snapshot for 36 hours. Once per outage ([ASO.md](ASO.md#health-and-alerts)) | on, for older channels too |
| Low App Store review | At once, when a new written review at or below the app's star limit arrives, 3 stars by default ([ASO.md](ASO.md#review-alerts)) | on, for older channels too |
| Mail problems | Pro mail only, checked once an hour at minute 20. A domain that fails its daily check, once per change, and a note when it passes again. Failed sends, once a day per domain. Received mail that could not be read or stored, once a day ([MAIL.md](MAIL.md#health-alerts)) | on, for older channels too |
| No plan session (Pro) | Daily at 07:00 UTC, when a site's plan expects the agent every N hours and no session came for 2 x N hours. Once per gap, and the next session re-arms it. A failed run does not ([Plan](#plan-pro)) | on |
| Daily numbers | Every day at 07:00 UTC: yesterday's MRR and change, new and churned subscriptions, revenue, visitors and the Stripe check, per site | off |
| Weekly report | Mondays at 07:05 UTC | on |

A payment alert goes out from the same hook as the iPhone push, so every provider (Stripe, Dodo, the App Store,
RevenueCat, the payments API) sends it once. A repeat delivery sends nothing, and neither does a sandbox purchase.
The title names the product when the provider sends one: "New payment on Habitly: $4.99, habitly.pro.monthly".

"Payment failed" and "Subscription canceled" come from the subscription events (see [Subscriptions](#subscriptions-pro)):
Stripe's `invoice.payment_failed` and `customer.subscription.*`, the App Store's `DID_FAIL_TO_RENEW`,
`DID_CHANGE_RENEWAL_STATUS` and `EXPIRED`, RevenueCat's `BILLING_ISSUE`, `CANCELLATION` and `EXPIRATION`. They cover
subscriptions that paid at least once, so a canceled trial stays quiet. Each goes out once, from the event that
changed the subscription. Stripe retries a failed payment several times, and the retries send nothing more until a
payment goes through and a later one fails. A canceled subscription sends nothing more when it ends. An event older
than 3 days, such as a late retry or one from the Stripe history import, sends nothing. The customer is the email and
name on the Stripe invoice, or else those on the customer's latest payment. App Store customers have neither, so the
alert names the original transaction id. "Payment failed on ShipKit: Jane Doe <jane@example.com>, Pro monthly" goes on
to say the MRR at risk. "Subscription canceled on ShipKit: Pro monthly, $49.00 MRR" goes on to say the day the paid
period ends. Both are on for a channel added since this version and off for older channels, so an existing setup gets
nothing new until you tick them.

"Payments stopped arriving" catches a webhook that broke without an error you would see: a rotated signing secret, an
endpoint deleted in the provider's dashboard, a changed URL. For each site and provider, FounderData counts the payments
(renewals and refunds included, sandbox purchases left out) in the 28 days up to the provider's last one. With 8 or
more, it waits as long as 5 payments usually take, and 3 days at least: `max(3, ceil(140 / payments in 28 days))`
days. One payment a day waits 5 days, 47 or more in 28 days wait 3, and 2 a week wait 18. At a steady rate, a gap that
long happens by chance less than 1% of the time. The alert goes out on the first day, then once a week while the
silence lasts, and stops after 60 days without a payment.

A small product, with fewer than 8 payments in those 28 days, has no steady rate to read. If the provider sent it at
least 2 payments in the 90 days up to its last one, FounderData waits twice the longest gap between those payments, and
14 days at least: `max(14, 2 × longest gap)`. A product that sells every 5 to 9 days waits 18 days; one with a 30-day
gap waits 60. It stops after `max(60, wait + 42)` days, so about 6 weekly alerts. One sale alone has no rhythm, and
other revenue typed in through the payments API (`income`) stays out. The same line
heads the home page's "Worth a look" and links to the site's Settings. It is computed from the `payments` table in the
cron and when the home page loads, never when a payment arrives.

"Worth a look" is the home page's list, sent by the daily cron. It compares yesterday's visitors (UTC) with the same
weekday a week before, so a normal weekend dip stays out. A site that stopped sending data is reported on its first
quiet day, then once a week while it stays quiet.

"Daily numbers" is off until a channel ticks it. It sends every day, even when nothing stands out. For each site it
names the last complete day in the reporting timezone, midnight to midnight. It counts from the real time of the
run, so the day has ended for every timezone from UTC-12 to UTC+14 (a site in Tokyo gets the day that ended 16 hours
earlier, one in Los Angeles the day before the one that ends in an hour):

```text
Yesterday's numbers, 2026-11-08
Acme
MRR $22,310.00, +$310.00 on the day, 4 new subscriptions, 1 churned, revenue $540.00, 1,204 visitors
Stripe check: 2 gaps worth $150.00 a month, last run 2 days ago.
```

MRR is at the end of that day, and the change is the difference from the start of it. New and churned subscriptions
are the ones that first paid or ended that day. A site without payments connected shows visitors only. The Stripe check
line appears for a site with a Stripe webhook secret or a stored check. It is the last result the check stored
([Check MRR against Stripe](#check-mrr-against-stripe-pro)), with its age: "matches", or the number of gaps and what they
are worth a month, or "never run". The cron never calls Stripe, because a check needs a restricted key and many
requests. Run the check in the dashboard, or with an agent, and the next message shows it. The numbers come from the
same code as the home page. Revenue in a currency without an exchange rate is not in `revenue`; the message adds a
line naming it ("12.00 ZZZ without an exchange rate, not in revenue"), and `revenue_other` holds it per currency. The message
makes no Stripe call. It writes one marker row per channel and UTC day, so two triggers at 07:00 (the old daily cron next to
the 5-minute tick) send it once. A channel that refuses it is tried again at the next hourly tick that day. A channel limited
to some sites gets only those. In the webhook payload `type` is `numbers`, and the body adds `day`, `timezone` and `sites[]`
with `site_id`, `name`, `currency`, `visitors`, `revenue` and `customers` (null without payments), `mrr`, `mrr_change`,
`mrr_new`, `mrr_churned`, `new_subscriptions` and `churned_subscriptions` (null without subscriptions), `revenue_other` (an object of minor units per currency) and
`stripe_check` (`status` `matches`, `differs` or `never`, `gap_count`, `gap_amount`, `checked_at`, `age_days`, or
null). Money is in minor units of `currency`. **Send** with "Yesterday's numbers" sends the real message.

"Webhooks refused" catches the moment a secret stops matching. Every 401 from `/api/webhooks/*` (a bad signature, a
wrong Gumroad token or seller id, a wrong RevenueCat header) counts for its site and provider. Whatever the sales
volume, the first refusal of the day alerts at once: "Lemon Squeezy: 4 deliveries to ShipKit refused today for a bad
signature. Check that the signing secret ...". The provider's card in Settings, Payments and the home page's "Worth a
look" show the count for 24 hours. Counting costs at most one D1 row per site and provider every 10 minutes per Worker
instance, so a flood of bad deliveries can't use up the free plan, and the count is a floor. A delivery to a site with
no secret set (400) or an unknown site (404) does not count. Most providers retry a failed delivery for a day or more,
so fixing the secret soon recovers the payments.

The weekly report covers Monday to Sunday in the reporting timezone, against the week before. Per site it lists revenue and new
customers, then web and app visitors on separate lines, never added up. Then MRR with its paying subscriptions for a
site with subscriptions, the top 3 products by revenue (payments that name a product), the top 3 sources by revenue,
the top 3 web pages and the top 3 app screens. All sites together come first, with MRR per currency. Every change has
the same shape, the percent and then the difference: "Web visitors: 1,244, +7% (+81)", "Revenue: $990.00, -12%
(-$135.00)", "MRR: $9,798.10, +5% (+$466.00), 214 paying subscriptions". Below 20 visitors the week before, or with
no revenue the week before, only the difference shows. MRR is at Sunday's end against Monday's start, the same as the
Subscriptions tab. `to` in the webhook payload is the Monday 00:00 after the week in that timezone, an exclusive end. Sites with no
visits, no revenue and no MRR in both weeks get one line at the end.

An extension or a newsletter ([Product types](#product-types)) leads with its headline in one sentence, "Tabsaver:
1,240 weekly active, +4% (+48)", then its other numbers, such as "Installs: 86, +12% (+9)". It has no web visitors line,
and a revenue line only when it had revenue. An app with ASO keywords gets the keywords that moved most against 7 days
before, "Keyword ranks: habit tracker up 5 to #7 in US". A site with Search Console pages in its SEO snapshot gets the
pages the SEO tab lists as decaying, "Search: 2 pages losing clicks over 28 days: /blog/x -140, /pricing -35".

Three more blocks follow when a site has the data. Paid: "Ad spend: $225.00, +221% (+$155.00). Google Ads $120.00, Meta
ads $105.00. MER 0.4, blended CAC $112.50." It adds every channel's spend, as the portfolio does ([Ad spend](#ad-spend-from-other-channels-pro)).
Organic: "Google: 1,240 clicks, -8% (-108), Nov 7 to Nov 13." covers the 7 days up to the last Search Console day,
since Google reports 2 to 3 days late, and "AI mention rate: 34%, 41% the week before." covers the week. Subscriptions:
"Trials: 12, +3. New MRR $120.00, churned MRR $45.00." Last, the site's top 2 [next actions](#next-actions-pro) as
"Next: ..." lines.

The report goes out at 07:05 UTC on Mondays, from its own tick, so the 07:00 alerts and the report never share one
run's 50 subrequests. Each channel gets a marker row for the week (the claim, then sent), so a second trigger never sends
it twice. A channel that refuses it, such as Discord answering 503, is tried again at minute 5 of each later hour that
Monday. So is every channel when the 07:05 run stops before it sends, for example on a D1 error. Slack, Discord and Telegram get plain text; email
gets a table with a column for app visitors and one for MRR when a site has them. **Copy weekly summary**, next to
"How these numbers are counted" on Home, copies last week's report as plain text, ready to paste into Slack.

To set up each channel:

- Slack: create an app at api.slack.com/apps, turn on Incoming Webhooks, add one to a channel and paste its URL.
- Discord: the channel's settings, Integrations, Webhooks, New Webhook. Paste its URL.
- Telegram: message @BotFather, send `/newbot` and paste the token. Send the bot a message (or add it to a group), open
  `https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id`.
- Webhook: FounderData POSTs JSON to your URL. Every alert has `type` (`purchase`, `renewal`, `refund`, `trial`,
  `payment_failed`, `canceled`, `daily`, `numbers`, `payments_stopped`, `webhook_refused`, `cap`, `aso_collector`, `aso_review`, `mail`, `weekly` or `test`), `title`, `text`, `lines` and
  `sent_at`. A preview from **Send** adds `preview: true`. "Webhooks refused" adds `site`, `provider`, `refused` (the
  count) and `at`. "ASO collector stopped" adds `items[]` with `site_id`, `site_name` and `last_snapshot_at`. "Low App Store review" adds `site` (`id`, `name`), `country` and `reviews[]` with `id`, `rating`, `at`, `title`, `text` and `version`. "Mail problems" adds `event` and the fields [MAIL.md](MAIL.md#health-alerts) lists for it. A payment adds `site`, `event`, `id`,
  `provider`, `amount` (minor units, a refund negative), `currency`, `amount_text`, `product`, `source` and
  `channel`. "Payment failed" and "Subscription canceled" add `site`, `event` (`payment_failed`, `canceled` or `ended`),
  `subscription_id`, `provider`, `product`, `customer_id`, `customer_email`, `customer_name`, `mrr` (minor units of
  `currency`, the site's), `mrr_text`, `ends_at`, `source`, `channel` and `campaign`. "Worth a look" adds `items`; "Payments stopped arriving" adds `items` with `site_id`, `site_name`,
  `provider`, `last_payment_at`, `days`, `usual` (payments in the 28 days before) and `text`; the weekly report adds
  `from`, `to`, `totals` and `sites`. `totals` and each site have `webVisitors`, `appVisitors` and their
  `prev...` values, `revenue`, `prevRevenue` and `customers`; `totals.mrr` and `totals.mrrStart` are per currency
  (null without subscriptions), a site's `mrr` is `{ mrr, mrrStart, active }` or null; each site has `topProducts`,
  `topSources`, `topPages` and `topScreens`. `visitors` still adds web and app up, for listeners written before; the write cap adds `site` (null for the shared cap),
  `cap` and `capped_at`. The URL needs https. While you run the Worker with `npm run dev:api` and open the dashboard on
  localhost, `http://localhost` and `http://127.0.0.1` work too, so you can test a listener on your machine without a
  tunnel.
- Email: goes out one of two ways. Both need the sender in `ALERT_EMAIL_FROM`, like `FounderData <alerts@yourdomain.com>`.
  Without either way set up, the Email tab on the Notifications page is grey, says what to set, and nothing tries to
  send email.

  Cloudflare Email Routing needs no other account, and sends only to addresses you verified in Cloudflare. That fits
  alerts to your own inbox. In the Cloudflare dashboard, open your domain, **Email**, **Email Routing**, turn it on, and
  add your inbox under **Destination addresses** (Cloudflare emails you a link to confirm it). Then add the binding and
  the sender to `wrangler.local.jsonc` and deploy again. The sender must be an address on that domain:

  ```jsonc
  "send_email": [{ "name": "EMAIL" }],
  "vars": { "ALERT_EMAIL_FROM": "FounderData <alerts@yourdomain.com>" }
  ```

  The binding stays out of the committed `wrangler.jsonc` because it needs Email Routing on your domain first.
  FounderData builds the message itself (plain text and HTML, no library) and hands it to the binding. Cloudflare
  refuses an address that is not verified; **Send test** shows its answer.

  Resend sends to any address, and needs a [Resend](https://resend.com) account with a verified domain. Set the key as
  a secret and the sender as a variable:

  ```bash
  node scripts/wrangler.mjs secret put RESEND_API_KEY      # re_...
  node scripts/wrangler.mjs secret put ALERT_EMAIL_FROM    # FounderData <alerts@yourdomain.com>
  ```

  With both set up, Resend sends. `GET /api/alerts` returns `email` (true or false) and `email_via` (`resend`,
  `cloudflare` or `null`).

Webhook URLs and the Telegram bot token are stored in D1 (table `alert_channels`, migration `0014_alerts.sql`), like
the Stripe and Dodo signing secrets in `sites`. The dashboard shows only the host and the last 4 characters of a URL,
never the token. Anyone with the admin password can replace or remove them.

Sending runs after the response, so a slow Slack never delays a webhook. Each message writes 1
[alert inbox](#alert-inbox-pro) row per site, and the weekly report writes 2 marker rows per channel. The daily alerts
run at 07:00 UTC from the minute-0 run of the 5-minute cron, `*/5 * * * *` in `wrangler.jsonc` (a deployment that still lists `0 * * * *` or `0 7 * * *` gets
them from that one), and the weekly report from the 07:05 run on Mondays. Apply migrations `0014_alerts.sql` and `0015_notes.sql` with
`npm run db:migrate` (or run `npm run setup` again) before you deploy this version.

### Threshold alerts (Pro)

The alerts above have fixed rules. A threshold alert is one you write: "revenue per visitor on ShipKit fell 15% in 7
days", "the Google clicks of any page fell 30%", "AI visits rose 50%". Add it under **Alert rules** on the
Notifications page, or with `POST /api/v1/alerts/rules` ([API.md](API.md#alert-rules-pro)).

| Setting | Choices |
| --- | --- |
| Site | One site, or all sites. A rule for all sites also covers sites you add later and fires for each site on its own |
| Metric | Visitors, revenue, revenue per visitor, conversion rate, AI visits, Google clicks of one page or any page, a page entering Decaying pages, the whole site's Google clicks or impressions, Apple Search Ads spend or ROAS, a change whose verdict turns worse |
| Comparison | Falls by a percent, rises by a percent, drops below a value, or rises above a value |
| Window | The last 24 hours or 7 days, against the same length before. Google clicks and impressions use whole days up to the last Search Console day, and can also use 28 days. Search Ads use whole days up to yesterday |
| Minimum volume | The rule stays quiet below it: 50 visitors, 3 payments, 10 clicks, 10 AI visits or 20 Search Ads taps by default |
| Check | Every hour (the default for a new rule), or daily at 07:00 UTC |
| Destinations | A webhook URL (signed, with an optional Authorization header, or in GitHub's dispatch shape), every channel that covers the site, the iPhone app. One or more |

**New rule** starts with six presets, and each one fills the form so you can change it:

| Preset | The rule |
| --- | --- |
| A page enters Decaying pages | The SEO tab's Decaying pages card as a rule: a page lost over 30% of at least 10 clicks, the last 28 Search Console days against the 28 before. The alert carries the card's reason, such as "Ranks lower, average position 4.7 to 6.5." |
| Any site loses half its Google impressions | All sites, the whole site's Google impressions fall 50% in 7 days against the 7 before, at least 200 impressions. A redirect or domain change looks like this ([SEO.md](SEO.md#search-drop)) |
| Any site loses 20% of visitors in 7 days | All sites, visitors fall 20% in 7 days, at least 50 visitors |
| No visits for 24 hours | All sites, visitors drop below 1 in 24 hours. It fires when a site that had visits the 24 hours before goes silent |
| A change turns worse | All sites, a change's verdict is worse once its window closes. Filter it by actor (pricing-agent) or kind (pricing) |
| Search Ads ROAS under 50% | ROAS, revenue over spend, drops below 50% for yesterday |

The hourly cron checks each rule that is due. A rule fires once, the first time it is over its line, and again only
after the number has been back. A rule set to check every hour sees a revenue drop within the hour. The 24-hour
window then slides by an hour each run. Apple sends Search Ads numbers once a day, so those rules see new numbers once
a day too. Rules from before this version keep their daily 07:00 UTC check until you change them.

A verdict rule watches chart notes, not a metric. When a change's window closes (7 days for most, 28 for SEO and AI
changes, plus the days their data comes late), the rule judges it as the Changes list does. If the verdict is worse, it sends the note, its impact (before and after, the change, the reason)
and `review_after`. The push reads "Worse: Launch thread on X, Rev/visitor -37%". Each change is judged once, so it
fires at most once. A missed run catches up on changes whose window closed in the 2 days before. The rule keeps the
ids of the changes it judged as its state.

The webhook gets a JSON payload signed with HMAC-SHA256: the two values, the change in percent and the chart notes in
the window, oldest first, each with its actor and verdict. An agent woken by it can see which change came first. The
secret shows once, when you add the webhook. **New secret** makes another one.

A webhook that fails, or answers 408, 429 or 5xx, gets two more tries, after 2 and 10 seconds. Each card shows the
last 20 sends with their status code, and a preview of the payload. **Send test** sends the rule's real numbers right
now, marked `"test": true`. A verdict rule sends its newest closed change, judged now. A rule costs no write while it
stays quiet. A send writes 1 row, since the delivery log lives in the rule's row, and so does a verdict rule judging a
change.

Each check reads the rows it sums. A 7-day rule reads 14 days of sessions and payments for its site, so on a busy site
24 checks a day read 24 times that. Pick a daily check for rules that don't need the hour, if the free plan's
5 million rows read a day gets close.

A webhook that wants a token gets one: `auth_header` goes out as the `Authorization` header of each send, and never
comes back from the API. With `"format": "github_dispatch"` and a webhook URL of
`https://api.github.com/repos/OWNER/REPO/dispatches`, a rule starts a GitHub Actions run itself
([Run an agent on a schedule](#run-an-agent-on-a-schedule-pro)).

### Alert inbox (Pro)

Every alert above is also kept for 90 days, one row per message and site, never per channel: Worth a look, payments
stopped, failed payments and cancellations, refused webhooks, the write cap, the ASO collector and reviews, mail
problems, rules that fired, an agent that went away and the weekly report. It is kept also when no channel takes the alert. Purchases, renewals and Daily numbers
stay out. Names and emails never go in.

An agent reads it with `GET /api/v1/alerts?since=<a minute before its last run>` or the MCP tool `alert_rules` with
`action: "events"` ([API.md](API.md#alert-inbox-pro)), and skips the ids it has seen. A key for one site reads only that
site's rows. The 03:17 cleanup deletes rows past 90 days.

### Next actions (Pro)

Home's Worth a look lists the top 6 next actions across your sites. Each names the thing, what it is worth in about a
month, and opens the tab that shows it. The cron computes them once a day, a few sites on each minute-50 tick:

- an integration that fails, such as Meta ads without `META_ACCESS_TOKEN`
- a page whose Google clicks fell more than 30% over 28 days
- a query at position 5 to 20 that would get more clicks at position 3
- a Meta ad that shows fatigue, with its spend
- an Apple Search Ads campaign below 0.5 ROAS after Apple's cut
- subscriptions past due, with their MRR
- AI prompts whose answers stopped naming you

Search items are worth their clicks times the site's revenue per Organic Search visitor. Without search revenue they
show clicks only. Agents read the same list with `get_portfolio` and `view: "actions"` ([API.md](API.md#next-actions-pro)).
It costs 2 rows per site a day. The run marks a site before it computes it. A site that fails keeps its old list until
the next day, and the other sites still get theirs.

D1 sums the Search Console rows, so the Worker never parses a whole part. That costs rows read once a day per site:
about 5,000 with Connect Google, which builds the totals parts, and up to about 25,000 for parts a script pushes with
80 rows a day and no totals parts.

### Run an agent on a schedule (Pro)

Once a site has a plan ([Plan](#plan-pro)), you schedule one prompt. Each run is one session of that plan: the agent
reads the plan, closes what is due, does the next task and logs what it did.

```text
Work on the growth plan for site SITE_ID in FounderData. Call get_plan and do what its guide says. End with log_session.
```

The Plan tab's **Runs by itself** card has the setup steps with your site id filled in. Your agent can also walk you
through them: `get_plan` returns the same steps in `autopilot.setup`. Connect the FounderData MCP server in the tool
first ([MCP.md](MCP.md#connect)), with a key that has `read`, `read:revenue`, `notes:write` and `research:write`.

Allow the tools the task needs, and nothing more: the FounderData tools, plus file edits in the project folder when
the agent should change your site. Anything else can stay on "ask". Do not switch on a mode that approves everything.

**Which one.** Your Mac sleeps at night? Pick the Claude app. You want code changes as pull requests? Pick GitHub
Actions. You run several products? Read [Several sites](#several-sites-and-one-repository-per-product) too.

| Path | Runs where | A missed run | Can change your code |
| --- | --- | --- | --- |
| Claude app | Anthropic's cloud, on a paid Claude plan | The computer can sleep, so sleep misses nothing. Anthropic does not document what happens to a run that fails to start | No |
| Claude Code | Your Mac, in the Claude desktop app's Code tab | Skipped while the Mac sleeps. On wake, one catch-up run for the newest missed time, up to 7 days back | Yes, in the folder you pick |
| GitHub Actions | GitHub's runners | GitHub may start a scheduled run late, and drop one at busy times. A dropped run does not repeat | Yes, as a pull request |
| Codex | Your computer, in the ChatGPT desktop app | No run while the computer is off | Yes |
| By hand | Wherever you paste the prompt | Nothing runs until you start it | Depends on the app |

What each needs, from the tool's own documentation (checked 2026-11-19, links below):

- **Claude app.** In the Claude app on a computer, or at claude.ai, click **Scheduled** in the left sidebar, then
  **New task**, paste the prompt and set it to daily. Leave the folder empty: a task with a folder runs only while that
  computer is awake and the app is open. Scheduled tasks use the connectors you added, so add FounderData once as a
  custom connector: **Customize**, **Connectors**, **Add**, **Add custom connector**, the URL
  `https://founderdata.example.com/mcp`, Authentication **No sign-in**, and under **Request headers** the header
  `authorization` with the value `Bearer fdk_...`. Request headers are in beta for some accounts. Without that section
  in the dialog, your account cannot connect FounderData this way yet, because FounderData has no sign-in flow for
  connectors: use Claude Code or GitHub Actions. If Claude stops to ask your permission, open
  the connector's page and set FounderData so it does not ask each time. We have not run this path against a live account, so check after the first run that the Plan
  tab shows a session.
- **Claude Code.** In the Claude desktop app, open the **Code** tab, click **Scheduled** in the sidebar, then
  **New task**. Paste the prompt, pick your project folder and choose **Daily**. It runs only while the app is open and
  the Mac is awake; **Keep computer awake** in the app's settings stops idle sleep, but closing the lid still sleeps
  it. It sees the MCP server you added with `claude mcp add`. Click **Run now** on the task's page, watch the first
  run and allow the FounderData tools there. A cloud task in the same list runs while the Mac is off, but it uses the
  connectors from your claude.ai account, as in the Claude app path.
- **GitHub Actions.** The Plan tab's **Copy run-plan.yml** button copies the workflow with your URL and site id filled
  in; the Pro repository has it at `pro/examples/agents/run-plan.yml`. Save it as `.github/workflows/run-plan.yml` in
  the repository of your site, add the secrets `ANTHROPIC_API_KEY` and `FOUNDERDATA_KEY`, set `TEST_COMMAND` and
  `SETUP_COMMAND`, and tick **Allow GitHub Actions to create and approve pull requests** under Settings, Actions,
  General. It runs every day at 08:17 UTC and on every alert a rule sends, in two jobs on two machines. The `plan` job
  runs everything that comes from your repository (`SETUP_COMMAND`, the agent, `TEST_COMMAND`) with a read-only token
  and no token in its environment or git config, so nothing there can push, even code that takes over the machine. It
  hands the agent's branch over as a git bundle. The `pull-request` job holds the only token that can write and runs no
  code from your repository: git with hooks off and gh. It checks that the branch is named `founderdata/...`, pushes
  only that branch and opens a pull request (a draft when the tests failed). Nothing in the file can push to your
  default branch, so it needs no branch protection rule. Repository code in the `plan` job can read the Anthropic key
  and the FounderData key, so give the FounderData key only the four scopes and one site. A run stopped by the turn or
  cost cap sends no branch. Pull requests
  opened with the workflow's token do not start your other workflows; close and reopen one to run your CI on it.
- **Codex.** A scheduled task in the ChatGPT desktop app, under **Scheduled**. It needs the computer on and the app
  running, and it runs in your default sandbox. Add the server to Codex's `config.toml`, which the app, the CLI and the
  IDE extension share. We did not check this path against OpenAI's documentation this round.
- **By hand.** With no scheduler, open a chat as often as you agreed with your agent and paste the prompt. When none
  arrives for twice the interval, FounderData sends the "No plan session" [alert](#alerts-and-weekly-report), which is
  your reminder.
- **Anything else.** A scheduler that can start an agent without you, and an agent that can call an MCP server over
  HTTP, run the same prompt.

Sources: [Claude app scheduled tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork),
[custom connectors and request headers](https://claude.com/docs/connectors/custom/add-unlisted),
[Claude Code Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks),
[cloud scheduled tasks](https://code.claude.com/docs/en/routines),
[Claude Code permission rules](https://code.claude.com/docs/en/permissions),
[Claude Code in GitHub Actions](https://code.claude.com/docs/en/github-actions).

The agent can only do the tasks it can reach, and it only does what the rules allow. The plan's `reach` lists what it
can and cannot touch, and the Plan tab shows both. A task outside its reach becomes a task for you.

#### Several sites and one repository per product

Make one key for all sites. Then run one session per site, so a failure in one does not stop the others: one scheduled
task per site with that site's prompt is safer, and one task whose prompt names the sites is quicker. With no `site`,
`get_plan` lists every site the key covers, and Home copies one prompt that sets your rules for all products and then
makes a plan for each product without one ([Start plans for every product](#start-plans-for-every-product)).

In `run-plan.yml`, list one site id per line under `matrix.site` when one repository holds every site. Each site gets
its own job, and two sites never wait for each other.

When each product has its own repository:

1. Copy `run-plan.yml` into each product's repository, and list only that product's site id under `matrix.site`.
2. Give each copy its own minute in `cron` (`'17 8 * * *'`, `'29 8 * * *'`, ...), so ten repositories do not start at
   the same moment and hit GitHub's busy hour.
3. Use one key for all sites in every repository, or a key per site so one leaked secret exposes one site. Both work.
4. Set each repository's `TEST_COMMAND` and `SETUP_COMMAND` to its own commands.
5. Leave the rules for all products in FounderData (`portfolio`). Every run reads them, so ten repositories still
   share your hours and money as the plans' shares say.

#### What a run costs

You pay your model provider for the tokens, and GitHub for the runner minutes. We measured one run of the workflow's
agent command on 2026-11-19, on a small plan, with `claude-sonnet-5-5` ($2 and $10 per million input and output
tokens, $0.10 per million read from the cache):

| | |
| --- | --- |
| Turns | 9, stopped by `--max-turns 8` before it logged the session |
| Tokens | 220,110 read from the cache, 18,931 written to it, 16 other input, 1,745 output |
| Cost | $0.12 (`total_cost_usd`) |
| `get_plan` answer | 9.8 KB for that plan; a busy plan is 5 to 15 KB |

It read the plan, claimed its task, made a branch, edited one file, ran the tests, committed and wrote the pull
request text in those 8 turns. A run that also logs the change and the session needs about 15 to 25 turns, which we
estimate at $0.25 to $0.50. Each turn re-reads a longer conversation, so cost grows faster than turns: the workflow's
40-turn cap is about $1, and `MAX_BUDGET_USD` stops a run at $3. A daily run at $0.40 is about $12 a month per site.
`claude-opus-5-5` costs twice as much per token. The workflow writes each run's turns, tokens and cost into the run's
summary on GitHub, so you see your own numbers after the first run.

#### When a run fails

`run-plan.yml` logs a failed session when any step fails: `status: "failed"`, a `cause` in plain words such as
"stopped after 40 steps" or "the tests failed on the change, so it waits as a draft", and a `link` to the run. The Plan
tab and Home show "Run failed" with the cause and an **Open the run** link. A failed session does not count as the agent being back, so after twice the cadence
you still get the "No plan session for SITE" [alert](#alerts-and-weekly-report). Another scheduler can do the same with
one call to `POST /api/v1/plans/SITE_ID/sessions` ([API.md](API.md#post-apiv1plansessions)).

The usual causes are a revoked or wrong FounderData key (the tools answer 401 or 403), a key without `research:write`
(the plan tools answer 403 and name the scope), a missing secret, the turn or cost cap, and a tool that waited for
approval with no one there. Fix it and start the run again by hand.

Set `cadence_hours` on the plan to the interval you schedule.

To wake it on an alert, give a rule the workflow's repository as its webhook:

```bash
curl -X POST "https://founderdata.example.com/api/v1/alerts/rules?site=SITE_ID" \
  -H "Authorization: Bearer fdk_..." -H "Content-Type: application/json" \
  -d '{"metric":"note_verdict","webhook_url":"https://api.github.com/repos/OWNER/REPO/dispatches",
       "auth_header":"Bearer github_pat_...","format":"github_dispatch"}'
```

The GitHub token needs Contents read and write on that one repository. GitHub answers 204 and starts the workflow
with the alert in `github.event.client_payload`.

**The weekly review instead.** The Pro repository also has `examples/agents/weekly-review.yml`. It runs every Monday at
08:00 UTC, after the weekly report, and follows `founderdata-portfolio-triage` or `founderdata-weekly-review` for a key
that covers several sites. Each run starts with `get_portfolio` with `view: "actions"` and `alert_rules` with
`action: "events"` since the last run, and saves what it found with `add_research`. Pick it when you want a report
across many sites and no standing plan.

## Plan (Pro)

A plan is the growth project your AI agent runs for one site, with you. It holds what you want, what the agent is doing
now, what waits on you, and what each finished change led to. Open it in the **Plan** tab. Your agent writes the plan
through the MCP tools. You steer it by talking to your agent.

### Start a plan

The Plan tab of a site with no plan shows three steps.

1. Connect your agent. Settings, Agents has the key, and [MCP.md](MCP.md#connect) has the setup.
2. Copy the starting prompt.
3. Paste it into your agent.

The agent reads only the data your site has, and the changes you already logged, then tells you in five lines what
works and what is broken. It says "not measured" where no tool gave it a number. Then it asks, one question at a time:

- If you never set rules for all your products: whether you run other products. If you do, it sets those rules first
  (below), then asks what share of your hours and money this product gets, and shows what the other plans already use.
- What you want from this product, and by when.
- With one product: how many hours a week and how much money a month, and your rules.
- Which tools run the business, and which of them it can reach. It says up front that whatever it cannot reach, such
  as a course platform or customer email, becomes a task for you.

It asks again when an answer is too vague to act on. It proposes one to three goals, the one thing it would do first
and why, and what comes after. It tells you where each goal stands and whether the target is realistic, and changes the
proposal until you say yes. Then it saves the plan, adds three to seven first tasks, asks how often it should work, and
walks you through scheduling it, one step at a time in the chat. The tab fills in.

**Your share** of hours can be half an hour. When the plans' shares add up to more hours or money than you set for
all products, your agent gets a warning and Home shows it, for example "Shares: 7 of 6 hours".

**Your rules** come in three lists: what the agent **does alone**, what it **asks you first**, and what it **never**
does. Each list holds up to 12 lines of 200 characters. "Change App Store keywords and text" can sit in one list,
"Screenshots", "Price" and "Any ad spend" in another.

### Start plans for every product

Home lists every product, with a line for the ones without a plan and **Copy one prompt for all**. That prompt needs
a key for all sites. The agent sets your rules for all products once: your hours a week, your money a month, and the
three lists. Every plan obeys them, and a "never" in either the product's rules or the rules for all wins. Then it
walks each product without a plan in a short interview of three questions (what you want from it, its share of your
hours and money, which tools it can reach), saves the plan and its first tasks, and moves on. Say "skip" to move past
one. At the end it walks you through one schedule for all of them.

### What the tab shows

- **Header.** The plan's title and summary, and one status line for your agent: worked a few hours ago, late, away for
  N days, no schedule yet, or "Run failed" with the cause and a link to the run. **Copy a prompt for your agent** copies
  a prompt that opens the plan in your agent.
- **Your rules.** At the top, always open: **Does alone**, **Asks you first** and **Never**, then what the agent can
  and cannot reach, and this plan's share of your hours and money. On a phone it folds to one row, "Your rules (7)".
- **Waiting on you.** Tasks only you can do, each with the reason the agent gave. A decision the agent needs, such as
  "Approve 100 USD for a 2-week search ad test", has **Yes, approve** and **No**. Any other task has **Done** and
  **Not now**, and a task that needs a page, such as "Connect Search Console", has a button that opens it. Only you
  close these tasks: your agent can change their text or take one back when it is no longer needed, never mark it done
  or say yes for you. With No or Not now you write one line on why: the agent reads it and does not propose the same thing
  again. In the Done list, **Mark as not done** takes back a done, and **Take back your no** takes back a no. These
  answers are the only thing you change in the tab.
- **Goals.** Each goal shows its current value against its target ("$3,920 of $5,000"), a bar, a mark where you should
  be today, and a chip: ahead, on track or behind. A goal at or above its target reads reached. A number FounderData
  cannot read says "Not measured" and why, never 0.
- **Doing now, Up next and Done.** Three lists of tasks. Each of the agent's tasks says what it expected, on the number
  FounderData will judge it on, and a done task shows what it got on that number: "Expected +10% conversion · got +3%
  conversion". When the change could only be judged on another number, the line says so: "judged on paywall
  conversion". A change that needed your yes shows **You said yes** with the day, which only your own answer in the tab
  can set, or **Your rules allow this** with the rule. A result opens to the numbers before and after (a rate with how
  many it counted, "18% of 120 trials → 22% of 131"), the days measured and the other changes that went live in the days
  before or after, by name.
- **What your agent did.** One line per session: when, whether you asked, a schedule started it or an alert did, and
  what it did. A failed run shows its cause and a link. Open a session to read what it checked and what it plans next.
- **Check-in.** Every 2 to 4 weeks the agent writes a review. Its text, labelled "Written by your agent", sits next to
  the numbers FounderData measured, so you see who says what. The numbers carry the date they were taken.
- **The plan.** The strategy and the history of each change with its reason, and the rules as they were in each
  version.
- **Runs by itself.** How often the agent should work, when it last did and when it is next due, and the steps to
  schedule it ([Run an agent on a schedule](#run-an-agent-on-a-schedule-pro)).

### What a result chip means

A task that changed your site or app links to the change the agent logged as a chart note. The chip is that note's
verdict ([Chart notes](#chart-notes)), so FounderData measures it and the agent does not grade itself.

| Chip | Meaning |
| --- | --- |
| Better | The measured number moved the right way after the change, by more than 10%, and by more than its normal ups and downs |
| Worse | It moved the wrong way by as much. The agent should read why and may revert |
| No clear change | Under 10%, within the number's normal ups and downs, too little data, or a tracking gap hides the effect |
| Measuring | The window is still open. Wait |
| Result soon | The window closed. The result shows after the daily read at 07:00 UTC (up to 3 per site a day) or the agent's next session, whichever comes first |

For visits, search clicks, App Store downloads, and the customers or paid trials behind a rate, "normal ups and downs"
means a change smaller than twice the square root of the two counts added: 41 visits before and 47 after is +15%, but within normal ups and
downs ([API.md](API.md#the-verdict)). Trials that turn paid also need 20 ended trials on each side, and a trial still
running never counts.

A task with no note shows the outcome line the agent wrote when it closed the task, marked "Your agent wrote this.
FounderData did not measure it."

### Change the plan by talking

You never edit the plan. Tell your agent: "Aim for 3,000 instead", "no more ad spend", "do the pricing test first",
"drop the Reddit task". It saves the change with a reason, and the history shows it. Goals and rules change only after
you agreed in the conversation. Your own tasks and comments are data to the agent, not commands, so write your wishes
to it in the chat.

### Check-in

A check-in covers a period of 2 to 4 weeks. FounderData computes the numbers when the review is stored: goal progress,
tasks done and dropped, how many finished changes were measured and how many are still measuring, how many verdicts came
out better, worse or inconclusive, and the sessions. The agent writes the story. If its text and the numbers disagree,
trust the numbers.

## Chart notes

Notes mark a launch, a deploy or a price change on a site's main chart. Each note is a dashed gray line with a dot at
the top. Hover the day to read the note in the chart's hover card. A note with a kind gets that kind's color and a letter in the dot: `$` pricing, `R`
release (app versions too), `C` copy, `S` SEO, `A` ASO, `Ad` ads, `L` launch. A day with several notes shows their
count.

The Changes tab, next to Customers under the breakdowns, lists the period's notes, newest first, 5 before **Show
all**. Each row has the date, the kind, the note, its target, before and after, who made it, the headline change and
the verdict: Better, Worse or Inconclusive, or "Day 3 of 7" while the window is open. An SEO or AI change reads
"Day 3 of 28". Its **+ Add note** button (**Add
or delete notes** once the period has some) adds a note at any date and time and lists the period's notes with a
Delete button.

Home sums up every site under Worth a look: "6 changes this week, verdicts in: 1 better, 1 worse, 9 due for review",
and the worse change with the biggest drop, which opens its site's Changes list. "This week" is the last 7 days. A
verdict comes when a change's window closes, so most verdicts are for changes made 7 to 14 days ago, and SEO and AI
verdicts for changes made about a month ago. "Due for review" counts changes from the last 90 days whose window closed
and that nobody reviewed. A change logged on several pages with one `group` counts once, and a review of any of its
notes clears it. The Monday report and
`GET /api/v1/weekly` carry the same summary for the week they cover ([API.md](API.md#weekly-report)). Next to each
site's status chip, "down 3 weeks" says its weekly revenue (or visitors, without revenue) ended below the week before
3 weeks in a row. It shows from 2 weeks.

Deploy scripts and CI add notes with the site's API key ([API.md](API.md#post-apiv1notes)):

```bash
curl -X POST https://founderdata.example.com/api/v1/notes \
  -H "Authorization: Bearer rt_..." -H "Content-Type: application/json" \
  -d '{"text":"Deployed v2.3","timestamp":"2026-11-02T09:30:00Z"}'
```

The daily cron adds a note when an app sends its first session with a new `app_version`. It looks at yesterday's
sessions only, so the ingest path writes nothing extra. A version seen in the 90 days before gets no note. The app
endpoint is public, so the cron skips anything that could be junk. The version has to look like `2.3`, `2.3.1` or
`2.3.1 (45)`: 1 to 4 numbers and an optional build number. It needs 5 sessions from 3 installs that day. A site gets
3 version notes a day at most, the versions with the most sessions first. A note costs 3 rows written, 4 with an
`idempotency_key`. The dashboard reads and adds notes with `GET` and `POST /api/sites/:id/notes`, and deletes one with
`DELETE /api/sites/:id/notes/:noteId`.

A note can also say who made the change, what kind it was, what it touched and the value before and after. Agents
send these fields so their changes show on the chart ([API.md](API.md#post-apiv1notes)). The kind and target pick
what the verdict judges: an SEO change on a page is judged on its Search Console clicks over 28 days, an ads change on
a campaign on CPA, an AI change on how often AI answers name the product, an app price change on paywall conversion.
With Pro, an app release is judged on how many trials turn paid when the app has trials, and an App Store listing
change on App Store downloads when the App Store sales import is on. Other changes compare revenue per visitor in the 7 days after the note with the 7 days before. A note of kind
`outage` marks a gap in the data, such as a day the tracker script was broken. The overview lists it, and a verdict on
visits or payments in that gap turns inconclusive. Hover a row's verdict to read it in full: "After 7 days: revenue per
visitor +6%, visitors -2%." It adds "Not enough data yet." while either side has fewer than 100 visitors, or both
sides together have fewer than 10 new customers. The 10 newest notes in the period load their impact at once; older
ones load when **Show all** lists them. When a note's target is a page path such as `/pricing`, its impact counts only visits that
entered on that page. Each impact has a verdict, better, worse or inconclusive, and agents list the changes due for
review and mark them kept, reverted or iterated ([MCP.md](MCP.md#the-review-loop)).

## ASO (Pro)

The ASO tab of an iOS app shows its rank for each keyword in each country, the 10 apps above it, a difficulty score,
Apple's search popularity, ratings per country and new reviews. Apple refuses these requests from Cloudflare, so a
script on your own machine, `scripts/aso-collect.mjs`, fetches them and posts them to the Worker. It uses App Store
endpoints that Apple's terms don't allow automated access to, so you decide whether to run it. With the DataForSEO
secrets, the Worker can check the ranks itself through DataForSEO's licensed API instead
([Ranks without your Mac](ASO.md#ranks-without-your-mac)). Ratings and reviews still need the collector. Popularity
comes from the Apple Ads API with the `ASA_*` secrets. Setup, scheduling, the formulas and the snapshot format are in
[ASO.md](ASO.md). An app's App Store id, under General in its settings, helps the collector find it. Without one it
looks the app up by its bundle id.

## SEO (Pro)

The SEO tab gets its data three ways, and each is optional:

- **Search Console.** Click **Connect Google** once and the Worker reads clicks, impressions, click-through rate and
  position per day every hour ([Connect Google](SEO.md#connect-google)). `scripts/gsc-sync.mjs` does the same from your
  machine without OAuth ([Sync Search Console](SEO.md#sync-search-console)).
- **Google ranks and keyword research.** With the `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` secrets, the Worker
  checks your keywords on Google once a day and buys keyword research on request, up to the site's monthly cap
  ([Keyword research and rank tracking](SEO.md#keyword-research-and-rank-tracking)).
- **Your own scripts.** `PUT /api/sites/:id/seo/:part` stores a part of the snapshot, such as keyword targets, SERP
  checks, an SEO plan, a ship log, AI assistant answers, competitors and backlinks. A push replaces the last one.

The tab ends every window on the last day Search Console has data for, because Google reports
about two days late, so it hides the period picker. The tab has five views, each with its own URL: Search (the
totals, decaying pages and top queries and pages), Keywords (targets, queries close to page one, who ranks instead), AI
answers (each panel prompt per assistant, and visits from assistants), Plan and work (the SEO plan and the ship
log) and Page audit (your crawler's last run, one row per URL, with a flag for each problem it found). Each decaying page says in one line why it lost clicks: it ranks lower, fewer people searched, or fewer searchers
clicked at the same position. The format and a `curl` example are in [SEO.md](SEO.md).

## Content (Pro)

The Content tab ranks the pages where visits started by the money they bring. Each row shows visitors, new customers,
revenue, revenue per visitor and the change against the period before. Revenue goes to the buyer's last visit from a
real source, so a page gets the payments of visits that entered on it. Click a column to sort, click it again to
reverse the order, search by path, or pick a folder chip such as `/blog/` to keep only its pages. The table shows 25
pages at a time. When the SEO snapshot has `gsc_pages`, two more columns show Google clicks and average position for
the same days, up to the last day Search Console has, with the change against the same number of days before. A site
with no payment provider sees visitors only. With a primary goal ([Primary goal](#primary-goal)), a column such as
Signups counts the visitors who sent it in a visit that started on the page. When the snapshot has `gsc_page_queries`,
a Queries column counts the Search Console queries that showed each page in the last 28 days.

Click a page to open it at `/site/<id>/content/page/<path>`. The page shows 12 weeks: visitors, revenue, Google
clicks and Google position per week, with a dashed line for each note on the page. Under the charts, every note whose
`target` is the page's path (or its full URL) compares the 7, 14 or 28 days from the note's day with as many days
before, for the page's visitors, revenue, Google clicks and position. You can add such a note there, or an agent can
send one to `POST /api/v1/notes` with a `target`. The side column opens with the queries Search Console showed the
page for, from `gsc_page_queries`: clicks, impressions, position and the places it moved against the 28 days before.
Click a column to sort it. Below it come the snapshot's target keywords for the page
and the AI assistants that sent visits to it, and the last card lists the new customers whose paying visit started
there. The AI assistants card lists each assistant that sent a visit with a referrer. Click one for its top
5 landing pages, then filter the dashboard by it. Agents read the same table from `GET /api/v1/content`
([API.md](API.md#get-apiv1content)).

### Page speed

The tracker measures five Core Web Vitals in each visitor's browser, with the browser's own `PerformanceObserver`
and no extra library:

| Metric | What it measures | Good | Poor |
| --- | --- | --- | --- |
| LCP, Largest Contentful Paint | when the main image or text block shows | 2.5 s or less | over 4 s |
| INP, Interaction to Next Paint | the slowest response to a tap, click or key press | 200 ms or less | over 500 ms |
| CLS, Cumulative Layout Shift | how far the page jumps while it loads | 0.1 or less | over 0.25 |
| FCP, First Contentful Paint | when the first text or image shows | 1.8 s or less | over 3 s |
| TTFB, Time to First Byte | how long the server takes to answer | 0.8 s or less | over 1.8 s |

The thresholds are Google's. The tracker sends the numbers once per page load, inside the engaged-time ping it
already sends when the page is hidden, so they cost no extra request. A visit shorter than a second still sends that
one ping. The numbers belong to the page that loaded: after a single-page-app navigation, the next pages get no
numbers of their own. Chrome and Edge report all five. Safari and Firefox report fewer, and INP needs at least one
tap or click. A tab opened in the background reports no paint times.

Google's Chrome UX Report only covers sites with enough Chrome traffic. These numbers come from your own visitors, so
a small site gets them too. Core collects and stores them. In Pro, the Content tab's Page speed card shows the 75th percentile of each metric over the last
28 days, colored by those thresholds, with the share of loads rated good, needs improvement and poor. It splits them
by page and by device, and each page's detail has the same card for that page alone. Below 20 page loads a metric
shows its count instead of a number. Agents read them from `GET /api/v1/vitals` and the `get_web_vitals` MCP tool
([API.md](API.md#get-apiv1vitals)).

Each stored page load writes 1 D1 row with no visitor id ([PRIVACY.md](PRIVACY.md)). Settings, Daily write cap, has a
sample setting: 100% of page loads by default, or 50%, 25%, 10% or off. A busy site can lower it to save rows. The rows
are deleted after 90 days.

### Paths

Content has two views, **Pages** and **Paths**. Paths follows visits through the site one page at a time. It starts
with the pages where visits begin. Click one, and it follows every visit that viewed that page, wherever the visit
started. It shows the pages people went to next, with how many visits did, how many left right there and how many of
those visitors paid later. Click a next page to add it as a step, up to 4
steps: `/` > `/pricing` > `/signup`. A page that repeats in a row counts once.

Each step has **Watch visits**, which opens the recorded visits that viewed that page, and a link to the page's
Content detail. The URL keeps the steps (`/content/paths?seq=/,/pricing`), so you can share it with a teammate.

The page detail has a smaller version, **Before and after this page**: the 5 pages visits came from and went to next.

Agents read the same numbers with `get_app_funnel`, `report: "paths"` and `sequence: ["/", "/pricing"]`
([API.md](API.md#funnels-and-paths)). Paths writes no rows. It reads the page views of the period.

## Email (Resend) (Pro)

The Email panel at the bottom of a site's Overview counts the emails the site sent through Resend: sent, delivered,
bounced and complained, opened and clicked, with the bounce and complaint rates. Agents read the same numbers from
`GET /api/v1/email` ([API.md](API.md#get-apiv1email-pro)) and the MCP tool `get_email`.

One webhook per Resend account covers every site. An event belongs to the site whose domain the sender address is on,
so `acme.example` takes `hello@acme.example` and `news@mail.acme.example`. A sender on a domain no site has is ignored.

1. In Resend, open **Webhooks**, click **Add webhook**, and enter `https://founderdata.example.com/api/webhooks/resend`
   with your Worker's host. Pick these events: `email.sent`, `email.delivered`, `email.delivery_delayed`,
   `email.bounced`, `email.complained`, `email.opened` and `email.clicked`. The API works too:
   `POST https://api.resend.com/webhooks` with `endpoint` and `events`.
2. Copy the webhook's signing secret (`whsec_...`) and set it on the Worker:

   ```bash
   node scripts/wrangler.mjs secret put RESEND_WEBHOOK_SECRET
   ```

   With several Resend accounts, add a webhook in each and put all their secrets in the one variable, separated by
   spaces.
3. Send an email from an address on the site's domain to an inbox you own. The panel shows it once Resend reports
   it, usually within a minute.

To split the numbers by email type, give each email a `category` tag in Resend, such as `welcome` or `password_reset`.
The panel and the API group by sender address and that tag. Other tags are not read.

Opens and clicks read **Off**, and `null` in the API, until Resend sends the first open or click event for the sender's
domain. Resend sends those events only when open or click tracking is on for the domain, a switch on the domain's page in
Resend. FounderData never changes it.

What is counted: each number counts emails, not events. An email opened three times adds 1 to opened, and a retry from
Resend adds nothing. Every event of an email counts on the day the email was sent, in the site's timezone. Events for
an email sent more than 30 days ago are ignored, because the row that remembers what was already counted is deleted
after 30 days. FounderData stores no recipient address and no subject ([PRIVACY.md](PRIVACY.md)).

## People and recordings (Pro)

The People tab lists the people your site knows by more than a daily id: people you `identify()`, buyers, people your
site remembers ([Remember visitors](#cookies-and-consent)) and people who use your iOS app. Each row says whether the
person used your website, your app or both. Each person gets one page. It opens with one sentence, such as "Anna found
you through Google on March 3, came back 6 times and paid $49 on March 21, 18 days after her first visit." Then come
the traits you passed to `identify()`, the devices, and every visit, newest first, in plain steps: Looked at Pricing,
Clicked "Start trial", Paid $49.

The list has four filters:

| Filter | Who is in it |
| --- | --- |
| People you know | Signed in, paid, came back on another day, or use your app |
| Customers | Paid at least once. Newest payment first, with the day of the payment |
| Has recordings | At least one recorded visit |
| Had trouble | A recorded visit with an error, or one where someone clicked one thing again and again (3 or more clicks, each within a second) |

Recorded visits have their own section, **Recordings**, right after People. See
[The Recordings page](#the-recordings-page). A Watch button on a person's visit still opens the player in place.

### Identify people

Call `identify()` when a person signs in, and again each time your app starts while they are signed in. Without it,
People shows them as "Visitor from Berlin", and a visitor id without cookies changes every day.

```ts
declare global {
  interface Window { founderdata?: (cmd: 'identify', person: Record<string, string | number | boolean | undefined>) => void }
}

// After sign-in, and on app start when someone is already signed in.
export function identifyPerson(user: { id: string; email: string; name?: string; plan?: string }) {
  const send = () => window.founderdata?.('identify', { user_id: user.id, email: user.email, name: user.name, plan: user.plan });
  if (window.founderdata) send();
  else window.addEventListener('load', send, { once: true });
}
```

The script tag has `defer`, so it may not have run when your code does. The `load` listener above waits for it. A call
that changes nothing writes no row, so calling it on every app start costs nothing.

Put the same script tag, with the same site id, on your marketing site and in your app. `yoursite.com` and
`app.yoursite.com` are one site. The visits before sign-in join the person when they are from the same day, or from
any day when the visitor accepted cookies or the site uses Remember visitors.

`user_id`, `email` and `name` name the person. Every other key is a trait, shown under About on the person's page:

| Rule | Limit |
| --- | --- |
| Key | Lowercase letters, digits and `_`, 1 to 40 characters |
| Value | Text, a number, true or false. Stored as text, cut to 100 characters |
| Keys per person | 20. Later keys are dropped |
| A second call | Adds its keys. A key sent again replaces the old value |

The iPhone app sends a user id, an email and a name with `FounderData.identify(userId:email:name:)`
([ios/README.md](../ios/README.md#users)). It sends no traits, so About shows only what your website sends.

### From your website to your app

A web visit and an app install are one person when:

- both sign in as the same person: `identify()` on the website and `FounderData.identify(userId:)` in the app, with the
  same user id or email
- a universal link from your website opens the app with the visitor id in `rt_vid`
  ([ios/README.md](../ios/README.md#links-and-attribution)). That works when the app is already installed.

A landing page without sign-in that links to the App Store can do neither. The App Store drops every parameter of the
link, so a new install starts as its own person. You still see which sources send people to the App Store: each click
on the link counts as a link out from that visit, and Apple Ads installs carry their campaign. On the person page, an
app visit shows "Opened the app" and the screens viewed, and a subscription shows as a payment, such as "Paid $4.99".

### Turn on recordings

Recordings are of your website only. The iPhone app is never recorded: its visits show as screens and events. Do the
first four steps before you turn the switch on, so the first recording already follows them.

1. **Storage.** Run `npm run setup -- --replay` in your FounderData folder. It creates the R2 bucket
   `<database name>-replay` in the database's jurisdiction, adds a rule that deletes each file 90 days after upload,
   binds the bucket as `REPLAY_BUCKET`, and deploys the Worker again, as every run of `npm run setup` does. R2 must be
   on for the Cloudflare account: Cloudflare asks for a payment method once to turn it on, even when you stay inside
   the free tier. `npm run setup -- --help` lists every flag.
2. **Consent.** In the EU and the UK, recording a visitor's screen usually needs their consent. By default a visit is
   recorded whether or not the visitor accepted your cookie banner. Turn on **Wait for consent** under Advanced, and a
   visit records only after your banner calls `founderdata('consent', true)`, or on pages with `data-cookies="on"`.
   Add the paragraph from [PRIVACY.md](PRIVACY.md#recordings-pro) to your privacy policy; the Record visits card has a
   sentence you can copy.
3. **Pages that are never recorded.** List the pages that show your customers' data, such as an account area or an
   admin dashboard. Open **Advanced** and enter them under **Pages that are never recorded**, one per line, such as
   `/dashboard`. A page is skipped when its path is `/dashboard` or starts with `/dashboard/`, so `/dashboards` is
   still recorded. Up to 20 paths.
4. **Masking.** Typing is always hidden. Put `data-fd-mask` on text that must not show, such as a name or an address,
   and `data-fd-block` on whole parts of a page, such as an embedded document ([What a recording hides](#what-a-recording-hides)).
5. **Content-Security-Policy.** If your site sends one, add your FounderData host to the `script-src` and
   `connect-src` it already has, and keep what is there:

   ```
   script-src 'self' https://founderdata.example.com
   connect-src 'self' https://founderdata.example.com
   ```

   A policy with only `default-src` covers scripts and uploads too: add a `script-src` and a `connect-src` that each
   repeat what `default-src` allows, plus the host, or the recorder stays blocked. When the tracker loads through a
   proxy on your own domain, the host is that domain, which `'self'` already allows; the proxy must pass
   `/js/replay.js` and `/api/rec` on to FounderData as well.
6. **The switch.** Open the site's Settings, then Data and privacy, and turn on **Record visits**. The Recordings page
   has the same switch while recording is off. `npm run setup -- --replay --record <site id>` (or `--record all`)
   turns it on from the terminal; it prints what recording means for visitors in the EU and the UK, asks before it
   turns on more than one site unless you add `--yes`, and with `--consent` turns on Wait for consent in the same step.

The script tag stays the same. For a visit the server picks, the script loads `/js/replay.js` from your Worker. Other
visits load nothing more. Your own visits with `?rt_ignore=true` and bots are never recorded. Recording sets no
cookie and stores nothing in the browser.

**The checklist.** The Record visits card (Settings, Data and privacy, or `/site/<id>/settings#record-visits`) shows
four lines. While one is open it checks them again every 15 seconds for 10 minutes, then every minute, and not while
the tab is hidden:

1. Storage ready: step 1 above is done.
2. Recording is on.
3. Your site sent a visit since then. Open your site in a new tab to send one.
4. First recording received. A recording shows up a minute or two after the visit.

Once all four are done, the card shows one line instead, such as "Recording works. Last recording 3 minutes ago."
When visits arrive and no recording does, after 10 visits or 30 minutes, the card lists the causes that apply.

**No recording arrives.** What can cause it, and what to do:

| Cause | What you see | What to do |
| --- | --- | --- |
| R2 is not on, or `--replay` never ran | Line 1 of the checklist is open | Run `npm run setup -- --replay`. Turn on R2 in the Cloudflare dashboard first if it asks |
| The Content-Security-Policy blocks the recorder or its upload | Visits arrive, recordings don't. A blocked script leaves a note on the card | Add the host to `script-src` and `connect-src` (step 5) |
| An ad blocker | Some visitors' recordings are missing, and the card may say a browser could not load the recorder | Nothing for those visitors. Proxying the script through your own domain helps |
| Wait for consent is on | Only visitors who accepted the banner are recorded | Accept your own banner when you test |
| Only a share of visits is recorded | Few recordings on a quiet site | Set **Record every visit, or only some** to every visit while you test |
| Today's maximum is reached | No new recordings until 00:00 UTC | Raise **Most visits recorded a day**, or wait |
| The visit saw only pages that are never recorded | No recording for that visit | Test on another page |
| A bot, an automated browser, or a visit from a hosting network (a cloud server, many VPNs) | No recording, by design | Test from a normal browser on a home or office connection |
| Your own visit with `?rt_ignore=true` | No recording, by design | Open the site without it |
| A very short visit | A recording with steps and no video ("too short to save the video") | Stay on the page a few seconds |
| The upload came from another domain | The card names the domain an upload came from | Check the site's domain in Settings, Site |

**Copy AI prompt** on the card gives your coding assistant the whole setup as one prompt: the setup command when
storage is missing (it asks you before it runs it, since it deploys), the two policy lines, `data-fd-mask` and
`data-fd-block` on private text, the logged-in paths for **Pages that are never recorded**, and a call to
`founderdata('consent', true)` from your cookie banner.

### The Recordings page

Open **Recordings** in the Analytics group of the site's sections, or go to `/site/<id>/recordings`. The period picker
sets the dates. The page has two parts.

**What to fix** puts the patterns across recorded visits in plain sentences, such as "12 people clicked "Compare
plans" on /pricing and nothing happened", with the recorded visits under each. Errors, clicks that did nothing, clicks
again and again and forms left behind come first, the ones that hit the most people on top; within one kind, a
checkout, pricing or signup page, or a page where a goal fired, comes first. Pages people went right back from and
pages most visits scroll less than a quarter of follow under **Also worth a look**, so a blog post nobody scrolled
never ranks above a broken pricing button. The words mean the same everywhere on the page:

| Words | What happened |
| --- | --- |
| Error | A JavaScript error on the page |
| Clicked, nothing happened | A click after which the page did not change for 2.5 seconds, and nothing scrolled, opened or was copied |
| Clicked again and again | 3 or more clicks on one element, each within a second of the last |
| Left a form | Typed in a field and never sent its form |
| Went right back | Left a page within 5 seconds for the page before |

Each line has **Watch** and up to two more examples, which open the player 3 seconds before the moment. **Copy AI
prompt** copies the whole list as text for your coding assistant, with the element, the example ids and how to dig
further with `get_recordings`; paste it into your coding assistant (Claude Code, Cursor) in your website's folder. The
part shows from 5 recorded visits, and under 30 it says to treat each line as a lead. The page and device filters below
narrow it too. What happened, Result and Left from pick visits for the list only, and the part says so while one is on.

**Worth watching** lists the recorded visits with the most going on first, each with one sentence on what happened,
in the order it happened, such as "Saw the error "TypeError: plan is undefined" on /signup, then clicked "Buy" again and
again, 4 times on /signup." A visit scores points for an error (30), a click that did nothing (20, or 30 for 3 or
more), clicking again and again (25), leaving a form (15), going right back (10), paying or signing up (15) and
leaving from a pricing or checkout page without converting (10). Visits under 5 seconds lose 30. Switch to **Newest**
for every recording by time. Filters sit in the address, so a filtered list can be shared:

| Filter | Address | Keeps the visits that |
| --- | --- | --- |
| Page | `?page=/pricing` | saw that page. Type to pick from the pages recorded visits saw |
| What happened | `?signal=dead`, `rage`, `error`, `abandoned`, `quick_back` | had that signal |
| Result | `?outcome=paid`, `signed_up`, `none` | paid, signed up, or did neither |
| Device | `?device=desktop`, `mobile`, `tablet` | used that device |
| Left from | `?exit=/pricing` | ended on that page (Drop-off's links set it) |

**The player** opens at `/site/<id>/recordings/<session id>?t=<seconds>` and starts at that second, also when you open
it from People or a person's page, so a reload keeps it open. Closing it puts the list's address back, so Back does not
open it again. **Copy link** copies the address at the second on screen and says "Copied". The header shows the
sentence on what happened, the visit's length (the same length as in the list) and how far down the page on screen the
visitor scrolled. A click that did nothing is a small amber dot on the bar and a step in the list; at that step, and
at a click again and again, a ring on the cursor shows where the click was. When a visitor left before the first part
of the video could be saved, the player says "This visit was too short to save the video. Its steps are below." and
lists the steps. The old address `/site/<id>/people/recordings` opens the Recordings page.

Three reports link here when the period has recorded visits:

- Content: **Watch visits** next to a page opens the visits that saw it.
- Drop-off: **Watch visits that left here** next to a web exit page opens the visits that ended there without buying.
- Overview: a small card under the numbers, such as "3 visits worth watching", when a visit of the period scores 40 or more.

### Let your agent read recordings

An agent can't watch a video, so FounderData gives it the facts behind each recording. The MCP tool `get_recordings`
answers with the same patterns, list and steps the page shows ([MCP.md](MCP.md#recordings-pro)). A good order is
`view` `patterns` first, then one or two examples with `view` `one` and the example's `session_id`, then the site's
code. The answer never guesses why a visitor did something, and every `watch_url` in it opens the player at the
moment for you. When recording is off or caught nothing yet, the answer says what you need to do instead. The
`founderdata-recordings-review` skill ([Skills](MCP.md#skills-pro)) runs this order and logs each fix with `add_note`.

### What a recording hides

- Every input. Typing shows as dots.
- The text of any element with `data-fd-mask`. The layout stays, the letters don't.
- Any element with `data-fd-block`. It shows as an empty box of the same size.
- Canvas, web fonts and frames from other domains. They are not recorded.
- Every page on the list of pages that are never recorded. The recorder doesn't start there, and the script sends no
  clicks or errors from them. Their pageviews still count in your stats. In a single-page app, the recording of that
  page load ends when the visitor opens a listed page, and starts again on their next full page load.

Put `data-fd-mask` on anything that shows personal data, such as the name and address on an account page.

A recorded visit also notes clicks on links and buttons, form submits, clicks again and again (3 or more clicks on one
element, each within a second of the last, with the element's tag and class) and JavaScript errors. They travel with
the ping the script already sends when a page is hidden. A click's label is the button's visible text, cut to 40
characters, without the text of anything inside it that is masked, blocked, editable or a form field. Inside
`data-fd-mask` or `data-fd-block` it is the tag name instead, such as `button`. A click on a large block that is no
button or link, holding several elements, is named by its tag and class, such as `div.card`, never by its text.

### What it costs

What recordings cost, for 200, 1,000 and 3,000 recorded visits a day, kept the default 30 days:

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

To record fewer, lower **Most visits recorded a day** or **Record every visit, or only some** under Advanced.
### Settings

The **Record visits** switch is all most sites need. **Advanced** holds the rest:

| Setting | Default |
| --- | --- |
| Record every visit, or only some | Every visit |
| Keep recordings for | 30 days (7, 30 or 90) |
| Most visits recorded a day | 1,000. After that, new visits are not recorded until 00:00 UTC |
| Keep only visits where someone signed up, hit a goal or paid | Off. When on, the other recordings go after 24 hours, also the ones where someone got stuck, which What to fix is built from |
| Wait for consent | Off. When on, a visit records only after the visitor consents to cookies |
| Pages that are never recorded | None. Up to 20 paths, one per line, such as `/dashboard` or `/account` |

A job that runs every hour deletes recordings older than the days you picked. The bucket's 90-day rule deletes anything left behind.
Erasing a person ([Erase one person](#erase-one-person)) deletes their recordings too. [PRIVACY.md](PRIVACY.md#recordings-pro)
lists what a recording stores.

### Retention and lifecycle

People has two views: **People** (the list) and **Retention**, at `/people/retention`. Retention answers two questions
about your website: does the base grow, and do people come back?

- **Lifecycle** draws each week as a bar. Above the axis: new people (active for the first time), returning people
  (active this week and the week before) and people back after a break (active, not the week before, but earlier).
  Below the axis: people who went quiet (active the week before, not this week). The current week is still running, so
  some of its quiet people may come back before it ends.
- **Retention** groups people by the week they were first seen and shows the share of each group seen again in every
  week after. The average row weighs each group by its size. **By first channel** splits it by the channel of each
  person's first visit, so you can see whether people from X stay as long as people from Google.

Pick days, weeks or months, and **Customers** to count only people who paid. The lifecycle shows 12 periods and the grid
8 groups, ending with the period of the dashboard's date range.

**Who counts.** Retention needs people your site recognizes on another day. **Known people**, the default, are the
visitors your site named with [`identify()`](#identify-people) or a payment, joined by user id, then email, as on a
person's page. **Every visitor id** adds everyone else, and counts a visitor id as new in the period the site first
saw it. Use it only when your site keeps visitors in cookies (consent,
or [Remember visitors](#cookies-and-consent)): without cookies a visitor gets a new id every day and counts as new each
time. With nobody known yet, the view says so and offers both ways in. Your iOS app has its own retention in the App
section.

Agents read the same numbers with `get_app_funnel`, `report: "lifecycle"` or `report: "retention"` with
`platform: "web"`, and scripts with `GET /api/v1/web/lifecycle` and `/api/v1/web/retention`
([API.md](API.md#retention-and-lifecycle-pro)). Reading costs no rows.

## Errors (Pro)

Stack frames are what the browser gives, not mapped back to your source, so a minified build shows functions named `t`
or `e`. Only uncaught browser errors and unhandled promise rejections arrive: no errors your code catches, no server
errors, no releases and no breadcrumbs.

The Errors section shows the JavaScript errors visitors hit on your website, grouped into issues. An issue is one bug:
the same message with other numbers, ids or quoted text, from the same function. The function name counts, so the same
message thrown in two functions makes two issues. Each row says how often it happened,
how many people it hit and how many of them pay you, with their monthly revenue in coral. Issues that cost money come
first.

### Turn it on

Open **Errors** and turn on **Catch JavaScript errors**, or use the card in Settings, group "Errors, maps and surveys".
A site that records visits catches errors already. With Wait for consent on, those errors arrive only with a
recording, after the visitor consents. Catch JavaScript errors sends them from the first page view, without consent,
with the visit and visitor id. Nothing changes in your code: the tracking script catches uncaught
errors and rejected promises, at most 5 per page view, each with its message, file, line and the top 3 stack frames.
Errors show up about a minute after they happen. [PRIVACY.md](PRIVACY.md#errors) lists what a row keeps.

One thing helps. A script from another domain (a CDN, your app's subdomain) reaches the page as "Script error." with
no details, because browsers hide them across domains. Add `crossorigin="anonymous"` to its `<script>` tag and serve it
with an `Access-Control-Allow-Origin` header. The **Copy AI prompt** button on the empty Errors page and in Settings
writes these steps for your coding assistant.

### Read an issue

The list has three tabs: Open, Resolved and Ignored. Filter by page or device, and click the Events, People or
Paying customers column header to sort by it. All three stay in the URL, so `/site/<id>/errors?page=/checkout&sort=events`
is a link you can share. **New** marks an issue first seen in the last 24 hours. **Back again** marks one you resolved
that happened after that. A row without a recorded visit says **No recording**; hover it to see why: recording is off,
its pages are never recorded, or none of its visits was picked for recording. "Script error." rows say the error came
from a script on another domain.

Open an issue for:

- the stack, top frame first, and the variants of the message
- the pages and browsers it happened on, each page linked to its Content page
- the people it hit, customers first with what they pay, each linked to their person page
- recorded visits with it. **Watch** opens the player 3 seconds before the error. Each recording says whether that
  person pays, and the section says how many of the paying customers were recorded, such as "0 of 2 paying customers
  recorded". **All recordings with it** opens Recordings filtered to the issue
- **Resolve**, **Ignore** and **Copy AI prompt**. The prompt gives your coding assistant the message, frames, pages,
  browsers and counts, and tells it to read more with `get_recordings` and log the fix with `add_note`

Resolve an issue once the fix is live. If it happens again, it comes back to Open as Back again. Ignore an issue you
will not fix, such as "ResizeObserver loop completed with undelivered notifications", which browsers raise for layout
code that works. Ignored issues never send an alert.

The Overview shows a small card when there are open issues: how many are new since yesterday, and the one that hit the
most paying customers. The weekly report adds one line per site with the top new issue of the week and the top
recordings pattern.

### Alert me about new errors

**Alert me about new errors on /checkout** on the Errors page makes an alert rule in one click: metric `new_error`,
the page and every page under it, sent to your notification channels and the iPhone app. Rules run once an hour, so
the alert arrives up to an hour after the error. It fires once for each issue first seen in the last 24 hours, so the
same bug never alerts twice. The alert names the message and the page, how many people it hit, how many of them pay
you and what they pay a month, and links to the issue. Settings, Alert rules lists it,
and the preset "A new error on the checkout" makes the same rule there. An AI agent reads the alert's issue with
`get_recordings`, `view` `error`.

### Recordings filters

The Recordings list takes more filters, which other sections link to:

| Filter | Comes from |
| --- | --- |
| An error issue | An issue's **All recordings with it** and its **Issue** button in What to fix |
| An experiment version | An experiment's results |
| A channel | The **Any channel** menu, or `?channel=Organic%20Search` in the address |
| Paying customers | The **Anyone** menu, set to Paying customers |
| A funnel step | **Watch them** on a drop-off line of the Funnel tab under the breakdowns: the visitors who reached that step and not the next, with the filters the tab has on |

A filter that came from a link shows as a chip you can remove: the issue by its message, the experiment by its name
and version. What to fix then counts only those visits, such as "Patterns in 1 recorded visit with this error".

Every visit in the list also has a summary of 2 to 4 sentences, such as "Came from Google to /blog/launch-checklist on
a phone. Read 22% of it, opened /pricing and clicked "Compare plans" 3 times in a row on /pricing. Left from /pricing
after 1 min 40 s without signing up or paying." It follows the order of the visit, names the page of each click, and
is built from what the recorder saw, never from a guess about why.

### Costs

Each distinct error of a page view writes 1 row, so a page view costs 0 to 5 rows. An issue seen for the first time
writes 1 more row, its first sighting. Resolving, ignoring or reopening an issue writes 1 row. A `new_error` rule writes 1 row when it fires, plus 1 row for the alert inbox. Reading issues
writes nothing.

## Experiments (Pro)

Test two versions of a page, or turn new code on for a share of visitors, and see which one brings more revenue per
visitor, not only more clicks. Experiments from your iOS app (`FounderData.experiment()`) sit in the same list.

**Start one.**

1. Experiments > **New experiment**. Pick versions of a page or a feature flag, a name and a key, the versions with
   their share of visitors (the first is the control: the page as it is today), the pages (`/pricing` also covers
   `/pricing/annual`; empty means every page) and the goal it is judged on beside revenue. It saves a draft.
2. **Copy AI prompt** on the experiment's page and paste it into your coding agent. It marks each version in your HTML
   with `data-fd-exp` and `data-fd-variant` (the other versions start `hidden`), or reads the flag in code with
   `founderdata('flag', key)` or `founderdata('flags', fn)`. See "Experiments in the tracker" in [API.md](API.md).
3. Open each preview link (`/pricing?fd_exp=pricing_headline:b`). It shows that version and stores nothing.
4. **Start**. Within a minute new visitors on those pages get a version. Until the first one arrives the page says
   "Waiting for the first visitor on /pricing".

**Read the result.** Each row of the list has one sentence, such as "b: $1.84 per visitor against $1.21, likely
better", or "Too few customers to compare revenue: 12 of 30". The experiment's page has each version's visitors,
people who reached the goal, customers, revenue, revenue per visitor and MRR, the customers per version with links to
their pages, and **Watch visits** for the recorded visits of a version. FounderData calls a gap likely real when a gap
that big would show up by chance less than 5 times in 100. Revenue gets a verdict only once each version has 30
customers; the goal once each has 100 visitors. Pick that bar before you start and wait for it: stopping at the first
good day finds wins that are not there.

Without cookies a visitor id lasts one day, so someone who comes back tomorrow can land in the other version. People
who sign in count once through `identify()`. Remember visitors keeps one version per person across days; the page
says how many people it saw in two versions.

**End it.** **Stop** and pick the winner. FounderData stops assigning versions, so every visitor sees the page as
written (the control) until you change the code. The page then shows a cleanup prompt: paste it into your coding
agent to keep the winner and remove the rest. A stopped experiment stays stopped; start a new one to test again. At
most 10 run at once.

**Change it.** **Edit** on the experiment's page changes the name and the goal, and on a draft the pages too. The
versions stay as created.

**Flags.** A flag has the versions `off` and `on` and a rollout, the percent who get `on`. **Change rollout** on the
flag's page sets it while the flag runs. Raise it and people who had `on` keep it. Your code checks `founderdata('flag', 'new_checkout') === 'on'`; without
an answer it is `null`, so keep the old path as the default.

**Agents.** `get_app_funnel` with `report` `experiments` answers web and app experiments with the verdicts. The skill
`founderdata-experiments` reads them, waits for the minimums and recommends a winner. Starting and stopping stay in the
dashboard.

**Cost.** A visit's version rides on the row its first pageview writes (0 rows). A visit that reaches the pages later
costs 1 row, once. Creating, changing, starting or stopping an experiment writes 2 rows.

## Surveys

Two questions, asked of the right people: **How did you hear about us?** right after signup, and **Why are you
canceling?** when a customer cancels. The first fills the gap attribution leaves: a podcast, a friend or a newsletter
arrives as Direct, and the answer names it. The second puts reasons next to churn.

The questions are fixed so the answers add up across sites. You can change their wording and the labels of the
answers, for a site in another language, but not add questions.

| Survey | Answers |
| --- | --- |
| How did you hear about us? (`heard_about`) | Google, an AI assistant, X, Reddit, YouTube, LinkedIn, a friend, a podcast, a newsletter, somewhere else (with their own words) |
| Why are you canceling? (`cancel_reason`) | Costs too much, missing something, switched to another product, not used enough, too hard to use, did not work well enough, support did not help, another reason (with their own words) |

### Where answers come from

- **Your own question.** If your signup or cancel flow already asks, keep it and send each answer with one line:
  `founderdata('answer', 'heard_about', 'podcast')`. An option of yours that is not on the list arrives as "somewhere
  else" with its label as the text. This works in both editions ([API.md](API.md#survey-answers)).
- **Stripe's cancel reasons.** In Stripe, open Settings, Billing, Customer portal and turn on Cancellation reasons.
  Customers who cancel in the portal pick a reason and may add a comment. FounderData reads both from the webhook it
  already gets, with no code. Polar sends its cancellation reason the same way.
- **The survey card (Pro).** A small card at the bottom right of the page (a sheet at the bottom on a phone) asks the
  question. It uses no cookie and no storage. Closing it counts as "skipped", so the same visitor is not asked again;
  without cookies the visitor's id changes daily, so someone who closed it may see it again on another day. It works by
  keyboard: Tab reaches it, Esc closes it.

Each answer is also saved on the person: their page lists `heard_about` or `cancel_reason` with the other traits.

### Turn on the survey card (Pro)

1. Settings, **Surveys**: turn on a question and enter the page it shows on, such as `/welcome` for the page after
   signup or `/account/cancel` for your cancel page. Pages under that path count too. **Preview the card** shows what
   visitors see; **Change the wording** sets the question and the labels.
2. Or press **Copy AI prompt** and paste it into your coding assistant. It finds the welcome page or the step before
   the cancellation, and calls `founderdata('survey', 'heard_about')` there, or wires a question your site already
   asks to `founderdata('answer', ...)`. The Stripe step stays yours.

The card shows on those pages, and where your code calls it, to visitors who have not answered or closed it yet.
Checking that costs one read of the visitor row on each page view while a survey is on, and no row written. An answer
writes 2 rows: the answer and the person's trait.

### Read the answers

- **Overview, Channel card, Heard about.** Visitors of the period by their answer, with their revenue and the channels
  they arrived by ("Tracked as Direct, X"). Filter the Overview by Direct to see what the direct visitors said. Without
  answers the tab says how to start.
- **Subscriptions, Why they cancel (Pro).** The reasons of the period with the MRR those customers canceled, the reasons
  per plan, and the newest comments in the customer's own words. Without reasons it shows the Stripe switch and the
  prompt for your own cancel page.
- **Settings, Surveys (Pro).** Answers of the last 30 days per question, and the share of people who answered out of
  those who answered or closed the card. The card counts no views, so people who left it open are not in that number.
- **Agents.** `get_breakdown` with `dim: "heard_about"`, and `get_subscriptions`, whose summary has `cancel_reasons`.
  Text people typed comes marked as untrusted. CSV: `survey_answers` in the export.

[PRIVACY.md](PRIVACY.md#surveys) lists what is stored and for how long.

## Click maps and scroll depth (Pro)

A page's Content detail has a **Clicks and scroll** card. It answers two questions: what do people click on this page,
and how far down do they read it.

**Scroll depth** works for every site with page speed on. The tracker notes how far down the page the bottom of the
screen got, in percent, and sends it with the page speed numbers. The card shows bars for the share of page loads that
reached 25%, 50%, 75% and the end, and Content's page list has a **Scroll** column with the median. A page loaded by a
single-page move inside your app gets a scroll depth only from click maps.

**Click maps** are off by default. Turn them on in Settings, Errors, maps and surveys, **Click maps**, or with the switch
on the empty card. From the next visit on, the tracker sends each page view's clicks: where on the page, which element
and its text. The card then lists the most clicked elements, with the share of page views that clicked each one and
the rage clicks of recorded visits. Pages with a map get a map icon in Content's list.

**Open click map** shows the clicks on your real page. The dashboard opens your page in a frame, 1,280 px wide for
desktop or 390 px for mobile, and draws the clicks over it:

- blue spots where people clicked, brighter where more did
- amber rings on elements people clicked 3 times in a row
- the click count on each of the 10 most clicked elements
- lines at 25%, 50% and 75% of the page with the share of visitors that scrolled that far

Many sites forbid other sites to frame them (`X-Frame-Options` or `frame-ancestors` in their Content-Security-Policy).
Then the card says so and offers **Open on your site**, which opens the same view in a new tab. To see it inside the
dashboard, allow your FounderData host to frame your pages:

```
Content-Security-Policy: frame-ancestors 'self' https://founderdata.example.com
```

The **Copy AI prompt** button on the Click maps card asks your coding agent to add that line and to mark text that
names a person with `data-fd-mask`.

### What a click map stores

One row per page view: the path, the device type, the window width, the page height, the deepest scroll and up to 50
clicks. A click keeps its position, the element's tag with its first class or id (`button.buy`), and its visible text up
to 40 characters. It never keeps what someone typed, form fields, editable text, or text inside `data-fd-mask` or
`data-fd-block`. A row has no visitor or session id, so a click map cannot follow a person. Pages on the never-record list
(Settings, Record visits) get no click map. Rows are deleted after 90 days ([PRIVACY.md](PRIVACY.md#click-maps-and-scroll)).

### What it costs

Each mapped page view writes 1 D1 row, on the ping the tracker sends anyway. A visitor who leaves the tab and comes
back to click more updates that row, 1 row more each time. Scroll depth writes nothing: it is a column of the page
speed row. A site with 3,000 page views a day uses 3,000 of the free plan's 100,000 rows. The Click
maps card has a share setting (100%, 50%, 25% or 10% of page views) for a busy site. Reading maps writes nothing.

### For agents

`get_content` with a `path` answers `scroll` and `clicks`, the 10 most clicked elements ([API.md](API.md#clicks-and-scroll-pro)).
`get_web_vitals` answers `scroll` per page. The setup checklist has a row **Click maps arrive**: `off` while no site
maps clicks, `ok` when every site with the switch on got a map in the last 7 days, `warn` otherwise.

## Mail (Pro)

The Mail page sends and receives email on your own domains through Cloudflare Email Service and Email Routing. It
belongs to the deployment, not to one site, so it has its own page in the header. Only the owner sees it.

- Your apps send through `https://founderdata.example.com/api/mail`, which answers like Resend's API. An app keeps
  the `resend` package and changes its base URL and key.
- Mail to an address you added lands in the inbox, threaded with your replies.
- Each sent message shows its status: sent, delivered, delayed, bounced, complained or failed. A hard bounce or a
  complaint puts the address on the suppression list.
- Templates hold the HTML your apps send, per domain, with versions and a test send. The Templates tab also groups
  what your apps send without a template, so you can see every kind of email in one place.
- Agents read and answer mail with a key that has `mail:read` or `mail:write`.

It needs Workers Paid, an R2 bucket and a queue. `npm run setup -- --mail` creates the bucket and the queue.
[MAIL.md](MAIL.md) has the setup, the DNS records, how to move an app off Resend, webhooks, limits and what is
stored for how long.

The [Email panel](#email-resend-pro) of a site also counts mail sent this way, once you link the sending domain to
the site on the Domains tab.

## Share and download your data

**Share links.** Settings, under Share links, makes a link to a read-only dashboard at
`/share/<token>`. Anyone with the link sees visitors, the chart, sources, pages, countries and devices. Revenue shows
only if you tick Show revenue. They never see visitor profiles, journeys, names, emails or settings. Give each person
or post its own link with a label, set it to expire after 7, 30 or 90 days, and revoke it when you're done. Each link
has a badge for a README or a website, "1.2k visitors in 30 days", the revenue or the MRR. A link that shows revenue
also has an MRR tile when the site has subscriptions. A view writes no rows, and answers
are reused for a minute, so a busy page costs few D1 reads. A revoked link can keep answering for up to 60 seconds.
Details are in [API.md](API.md#share-links).

**Read API.** A key with the Read scope (`fdk_...`, Settings, Agents) reads the overview, any panel and the chart as
JSON, for Grafana, a spreadsheet, a cron job or an AI agent. It also reads subscriptions, customers, the App section,
Apple Search Ads, SEO, ASO, chart notes and revenue per entry page, with names and emails left out. Add Read revenue
for money. `/llms.txt` lists the routes for an agent. Routes and fields are in [API.md](API.md#read).

**What an agent can trust.** whoami, `get_definitions` and `get_portfolio` tell an agent, per site, when each kind of
data starts (`tracking_since`) and how each integration is doing (`sources`: ok, stale, error or off, with the last
error). A comparison with a period before tracking started answers `null` with a reason instead of a jump from 0. On
the source panels and the portfolio, `attribution` says what share of revenue a visit explains. See
[API.md](API.md#sources-and-tracking-start).

**Raw rows.** A key with the Raw rows scope (`read:rows`) downloads sessions and events as CSV from
`/api/v1/export/<table>`, and with Read revenue also payments and subscriptions. Payer names, emails and customer
ids stay empty. Event and goal names stay. The scope is off unless you pick it. See [API.md](API.md#raw-rows-for-agents).

**Agents.** Settings, Agents has one row per agent: its key, scopes, last write, calls in the last 24 hours, and the
changes it logged on the site with their verdicts, such as "pricing-agent, Write notes, last write 2 hours ago, 1
change, 0 better, 0 worse". A key and an actor join on the name, so name the key after the actor the agent writes in
its notes. An actor with no key of its name (you, in the dashboard) gets a row too. Read keys from before scoped keys
(`rtr_...`) are listed under them as legacy read keys. They keep working and can be revoked there. A new key with the
Read scope replaces one.

**CSV.** Every panel, the Visitors tab and the Customers tab have an **Export CSV** button. It downloads what you see, with
the period and filters on screen:

| Button | File |
| --- | --- |
| A panel (Channel, Page, Country, ...) | The panel's rows, up to 500 |
| Visitors | One row per visit: source, UTMs, entry and exit page, pageviews, duration, country, device |
| Customers | One row per payment and refund: amount, provider, how it was matched, and the source of the credited visit |

Events (every pageview, goal and click) have a CSV route too, `/api/sites/<id>/export/events.csv`. A big range comes
in parts of 5,000 rows; the button joins them into one file. To export from a script, see
[API.md](API.md#csv-export), which also shows how to export a month at a time.

**Everything.** `node scripts/wrangler.mjs d1 export DB --remote --output founderdata.sql` writes the whole database as
SQL. Add `--table sessions` for one table.

## Accuracy notes

No analytics tool is 100% accurate. These are the main gaps and how this project handles them:

- **Ad blockers** block some analytics domains. Proxy the script through your own domain (Settings shows a Next.js
  rewrite). Payments are always recorded by the webhook, even when the visitor's browser blocked tracking.
  Behind such a proxy, Cloudflare sees the proxy's IP address, not the visitor's, and the cookieless id needs the
  visitor's. Set `TRUST_FORWARDED_FOR` to `1` (`node scripts/wrangler.mjs secret put TRUST_FORWARDED_FOR`, or a `vars`
  entry in `wrangler.local.jsonc`) so the Worker takes the first `X-Forwarded-For` address, which the proxy sets.
  Without it the Worker uses `CF-Connecting-IP` and ignores `X-Forwarded-For`, because any client can write that
  header and pick its own visitor id. The proxy's location headers (`x-vercel-ip-country`, `-country-region`,
  `-city`) follow the same switch: without it the Worker uses Cloudflare's location and ignores them, since any client
  can send them too. The [datacenter flag](#datacenter-visits) skips forwarded requests only with the switch on. Turn
  it on only when every event comes through your proxy.
- **Returning visitors** count as new after midnight UTC without cookies (see above). With cookies, Safari keeps
  cookies set by JavaScript for at most 7 days, so a Safari visitor who returns after more than a week counts as new.
  The email fallback above recovers most of these payments.
- **Bots** are filtered by user agent and the `navigator.webdriver` flag. A bot posing as a browser from a cloud server
  is stored with a flag and left out of the numbers ([Datacenter visits](#datacenter-visits)). One that runs on a home
  or mobile network gets through. The [daily write cap](#daily-write-cap) limits what a flood of fake events can cost.
- **Currencies are converted at the ECB rate of the payment day.** A payment in another currency than the site's (a
  EUR Stripe checkout on a USD site, an App Store purchase in the buyer's currency) is stored as paid and also with
  its amount in the site's currency (`payments.amount_conv`), at the ECB reference rate from the Frankfurter API
  (`src/worker/fx.ts`, rates cached in `fx_rates`). Every total, chart and panel counts the converted amount, and the
  payment lists show it with the amount paid underneath. A payment without a rate (the rate API did not answer, or the
  ECB does not publish the currency) stays out of the totals, marked "not converted yet", until a later dashboard load
  or the daily cron converts it. Changing a site's currency converts its payments again. The converted amount is not
  what Stripe or Apple paid out: their own exchange rate and fees differ.
- **App Store amounts are gross**: what the customer paid, tax included, before Apple's commission. That holds for
  payment rows and for Apple's report alike (see "How revenue is counted").

## Local development

```bash
cp .dev.vars.example .dev.vars        # password: change-me
npm run db:migrate:local
npm run build && npm run dev:api      # http://localhost:8787
npm run dev:web                       # optional: hot-reloading dashboard on http://localhost:5173

npm run seed                          # optional: 60 days of demo data (a SaaS website with an SEO snapshot, an iOS app and a blog)
npm test                              # unit tests
npm run smoke                         # end-to-end test against the running dev server
```

### Setting up several sites at once

`scripts/setup-sites.mjs` creates or updates the sites listed in `sites.json` (copy `sites.example.json`; the file is
gitignored because it holds secrets). A website has a `domain`, an iOS app has an `app_bundle_id` (or `bundle_id`),
and a product with both has both. The script finds a site by its domain, or an app without a website by its bundle id.
Add a `domain` to an app's entry later and the same site gets it.

The file is a list of sites, or `{ "defaults": { ... }, "sites": [ ... ] }`, where every site takes the defaults it does
not set itself. Each entry, and `defaults`, takes:

| Key | What it sets |
| --- | --- |
| `currency`, `timezone` | The site's currency (USD when unset) and timezone (UTC when unset) |
| `write_cap` | A number of rows a day, `"auto"` for the shared pool, or `"off"` |
| `stripe_webhook_secret`, `dodo_webhook_secret` | The signing secrets from Stripe and Dodo Payments |
| `revenuecat_auth` | The Authorization header value you give RevenueCat's webhook |
| `lemonsqueezy_secret`, `polar_secret`, `paddle_secret` | The signing secrets of those providers |
| `gumroad_seller_id` | Your Gumroad seller id. The first run makes the site's ping URL and prints it with the refunds loop; later runs keep it |
| `gumroad` | `true` makes the Gumroad ping URL without a seller id, which the first sale then sets |

Running it again changes nothing unless a setting drifted, and it never clears a bundle id that was set by hand. The
API never shows a secret back, so a secret that is already set stays as it is. After you rotate one, put the new value
in `sites.json` and run the script with `--replace-secrets`. A key the script does not know stops it before it changes
anything, so a typo in a secret's name cannot pass unnoticed. An entry the server refuses (a Stripe secret without
`whsec_`) is reported and the others go on.

For each site it prints the id, the script tag, the webhook URL of each provider with a secret, and what is still
missing: no payment provider at all, or a provider with a secret that has received no event yet, with the URL to paste
into that provider's dashboard. The password comes from `ADMIN_PASSWORD` or `~/.config/founderdata/admin-password`.

```bash
cp sites.example.json sites.json                                           # then list your own sites
node scripts/setup-sites.mjs https://founderdata.example.com --dry-run        # show what it would do
node scripts/setup-sites.mjs https://founderdata.example.com
node scripts/setup-sites.mjs https://founderdata.example.com --replace-secrets   # after rotating a secret
```

## How it's built

- `public/js/script.js`: the tracker, 13 KB (about 4.8 KB gzipped). It handles consent and cookies, pageviews, engaged time, goals, outbound links and checkout link tagging
- `src/worker`: a Hono app on Cloudflare Workers that handles web and app event ingestion, the Stripe, Dodo and App Store webhooks, the payments and goals API, and stats queries on D1 (SQLite). `lib/apple-jws.ts` and `lib/x509.ts` verify Apple's signed transactions with WebCrypto
- `src/dashboard`: the React dashboard (Vite, Tailwind, Recharts), served as static files by the same Worker
- `migrations/`: the database schema

The dashboard reads the same JSON routes you can call with the login cookie (`/api/home`, `/api/apps`,
`/api/sites/:id/overview`, `/breakdown`, `/revenue`, `/coverage`, `/customers`, `/dropoff`, `/app/*`). They are not a stable API yet.
On a site with an app, `/overview` adds `newInstalls` (installs with consent first seen in the range) and
`consentedInstalls` (installs with consent and an app session in the range) to `current` and `previous`. `/api/home`
adds `totals.platforms.web` and `totals.platforms.app`, each with `current` and `previous`: `visitors` (one device per day on
the app without consent), `sessions`, `bounceRate`, `avgDuration`, `customers` (new customers whose payment is linked to a visit on that
platform), `conversionRate` and `newInstalls` (app only).
Each site in `/api/home` has `trend`: `status` (`growing`, `flat`, `declining`, `quiet` or `no_payments`) and
`revenueChange`, the period's revenue minus the previous period's, in minor units of the site currency. Revenue that moved
10% or more is growing or declining. Without revenue in either period, visitors decide: 30% or more, from a base of 50
visitors in the period before. A site with no payments connected shows `no_payments` unless its visitors fell that much,
which makes it `declining`. Quiet means no visit or app session for 24 hours and no revenue in the period. `siteTrend` in
`src/worker/home.ts` applies the rules. The thresholds live in `src/shared/trend-rules.ts`, and `/api/home` returns them as
`trendRules`.
Each site also has `weekly`, the last 8 full weeks (Monday to Sunday in the reporting timezone), oldest first: `week` (the
Monday), `visitors` and `revenue` (minor units of the site currency). One grouped query reads them for all sites. `falling`
is set when weekly revenue, or visitors on a site without revenue, ended below the week before 3 weeks in a row and fell
10% or more from where the run started (visitors need 20 in that first week): `metric`, `weeks`, `since`, `from` and `to`.
Such a site gets a `falling` item in `attention`, for example "ShipKit: weekly revenue fell 3 weeks in a row, from $1,240 to
$610." `timezone` is the site's own timezone. Its dashboard counts days in it, so its totals can differ from the home
page's when it is not the reporting timezone.

**Units.** Money on these dashboard routes is in minor units of the currency: `revenue: 665000` on a USD site is
$6,650.00. Ratios built from money are in minor units too, so `revenuePerVisitor: 140.27` is $1.40 a visitor. A site's
routes count in the site currency, which `/overview` returns as `currency` with its `decimals` (2 for USD, 0 for JPY);
divide by 10 to the power of `decimals` for major units. `/api/home` and `/api/apps` key money by currency code. The
mobile API ([MOBILE-API.md](MOBILE-API.md)) and the App Store sales routes use major units (`4.9` is 4.90) and say so.
Times are Unix milliseconds everywhere.

**Site icons.** The dashboard shows each site's and referrer's icon through `GET /api/favicon/:domain` (login
required). The Worker fetches the site's own `/favicon.ico`, or else the first `<link rel="icon">` in the first 64 KB
of its home page, and keeps the icon up to 100 KB. It caches icons for 7 days and missing ones for 1 day with
Cloudflare's Cache API, so a domain is asked about once a week per data center. The Cache API only works on a custom
domain; on `workers.dev` the browser's own cache (same 7 days and 1 day) is all there is. No browser sends a tracked
or referring domain to a third party, and no D1 row is written. Anything other than a public host name, a missing icon
or one that is too large answers 404, and the dashboard shows a plain link icon instead.

Before a commit, run `npm run typecheck && npm test`.
