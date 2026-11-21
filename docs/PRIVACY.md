# Privacy and GDPR

This page is for whoever runs a FounderData deployment and has to answer for it: what the database holds, for how long,
who can read it, what Cloudflare sees, and a checklist for the GDPR paperwork. You are the controller. FounderData is
software you run on your own Cloudflare account, so the only processor in the default setup is Cloudflare.

This is a technical description, not legal advice. Have your counsel read it next to your privacy policy.

## What the database stores

All data sits in one D1 database. "Personal" below means personal data under the GDPR. Pseudonymous data (a visitor id
without a name) is still personal data.

| Table | What it holds | Personal? | How long |
| --- | --- | --- | --- |
| `visitors` | Visitor id, first seen, and the first visit's source, channel, campaign, referring domain and entry page (first touch). `user_id`, `name`, `email` only when your site calls `identify()` or a payment carries them. `traits`: the other keys your site passes to `identify()`, at most 20, each value cut to 100 characters. For apps, whether the id persists: after consent, or with the opt-in `installId: .vendor`, a hash of `identifierForVendor` (see "The visitor id"). | Yes. Pseudonymous, and identifying once `identify()` fills it | Deleted once no visit or payment points at it after `RETENTION_MONTHS`. Name, email and user id cleared after `PII_RETENTION_MONTHS` without a visit, when set |
| `sessions` | One visit: visitor id, start and end, pages, referrer, UTM tags, `ref`, country, region, city, coarse coordinates from the same lookup (one decimal, about 11 km), browser, OS, device type, the browser's first language from `Accept-Language` (`de`, never the full header), app version, app properties. Whether the visit came from a hosting network such as AWS (a 0 or 1 flag, from the network number Cloudflare reports; the IP is not kept). For a visit from another network's ad (its URL carried `gclid`, `gbraid`, `wbraid`, `msclkid`, `ttclid`, `twclid`, `li_fat_id`, `rdt_cid`, `ScCid` or `epik`): the network, the click id and when it was first seen. For a visit from a Meta ad or link (its URL carried `fbclid` or `ad_id`): Meta's click id and when it was first seen, the ad id, and the visit's user agent. Whether the visitor gave marketing consent (`founderdata('marketing', true)`), and with that consent the Meta browser id from the `_fbp` cookie, when a Meta pixel on the site set one | Yes, pseudonymous | `RETENTION_MONTHS` (default 24). The user agent, the Meta click id and the Meta browser id are cleared 28 days after the visit, and the browser id also when consent is withdrawn; the ad id stays. Other networks' click ids are cleared 90 days after the visit, the window Google Ads takes offline conversions in; the network name stays |
| `events` | Pageviews, goals, outbound clicks: visitor and visit id, time, path, goal name, the properties you send, and the visit's hosting-network flag. On a recorded visit (Pro), one `activity` row per page with its clicks (the button's visible text, up to 40 characters, without anything inside `data-fd-mask`, `data-fd-block`, a form field or an editable part, never what was typed), rage clicks with the element's tag and class, and JavaScript error messages | Yes, pseudonymous. Properties hold whatever you put in them | `RETENTION_MONTHS` |
| `replays` | One row per recorded visit (Pro): site, visit id, visitor id, start time, entry page and the digest (pages, time, scroll, clicks that changed nothing, names of fields changed). The recording itself is in R2, see "Recordings (Pro)" | Yes, pseudonymous | As long as the recording |
| `vitals` | Page speed of one page load: site, time, path, device type (desktop, mobile or tablet) and the five timings LCP, INP, CLS, TTFB and FCP. No visitor id, no visit id, no IP, no user agent. The browser measures them with its own `PerformanceObserver`, and the tracker sends them inside the engaged-time ping it already sends when the page is hidden | No. A row can't be tied to a visitor or a visit | 90 days, or `RETENTION_MONTHS` when shorter. Settings, Daily write cap, sets the share of page loads stored, 0 turns it off |
| `payments` | Provider, amount, currency, product, time, your payment id, subscription id, the provider's customer id, buyer email and name when the provider sends them, the visitor and visit credited, and a copy of that visit's channel, source and campaign (so revenue keeps its source after the visit is deleted) | Yes | Kept for your books. Email and name cleared after `PII_RETENTION_MONTHS`, when set. Erase clears the person's fields and the copied source |
| `subscriptions` | Subscription state for MRR: provider ids, customer id, credited visitor and visit, a copy of that visit's source, prices and dates | Yes, pseudonymous | Kept for MRR. Erase clears the visitor, visit, customer id and source |
| `app_aliases` | For app launches without a kept install id: the daily key (an HMAC of IP, user agent, device model, OS version and locale under the daily salt, never the values), a launch's install id or an SDK session id, and the visitor and visit it belongs to | Yes, pseudonymous | 30 days, or `RETENTION_MONTHS` when shorter. Erase deletes the visitor's rows |
| `subscription_signals` | Trial starts, cancellations and other lifecycle events with the credited visitor | Yes, pseudonymous | `RETENTION_MONTHS` |
| `payment_claims` | A payment id seen on your thank-you page, with the visitor id that saw it | Yes, pseudonymous | `RETENTION_MONTHS` |
| `stripe_objects` | Stripe object ids (charge, invoice, refund) that point at a payment | No | With the site |
| `login_failures` | A keyed hash of the IP address (HMAC with `SESSION_SECRET`, never the IP) and the time of a wrong dashboard or phone password | Yes, pseudonymous | 15 minutes for the lockout. The daily cron deletes older rows, so a row lasts a day at most |
| `team_members` | Teammate logins: name, optional email, role, a PBKDF2 hash of the password, session version, a hash of the invite link, last sign-in | The owner's colleagues' own data | Until the owner revokes the person, which deletes the row. Not tied to a site, so a site delete leaves it |
| `devices` | Signed-in phones: the name typed at sign-in, SHA-256 of the token, APNs push tokens, last seen | The owner's own device data | Until revoked; the row stays with the push tokens cleared |
| `alert_channels` | Your Slack, Discord or webhook URL, Telegram chat id and bot token, or an email address | The owner's own contact data | Until you delete the channel |
| `erasures` | Erase log: site id and name, time, method (visitor, email, user id), rows removed per kind, who handled it (`admin` or `api`) and an optional note. No identifier of the person | No | Kept after a site delete, as proof the requests were answered. Delete rows by hand when you no longer need them |
| `imports`, `imported_daily` | History imported from another tool (docs/IMPORT.md): per day, the visitor, pageview, visit and bounce counts, and per panel a label (page, source, country, device) with two counts. No visitor id, no IP | No. Aggregates | With the site, or when you delete the import. Imported days show only before the oldest visit still stored, so erasing that visit or retention deleting old visits moves that date later (docs/IMPORT.md) |
| `stripe_imports` | Progress of a Stripe history import, and the restricted key while it runs | No | The key goes when the import ends, fails, is canceled, or makes no step for 1 hour |
| `meta_settings` | Per site: ad account, campaign filter, dataset id, the Conversions API settings and its last error | No | With the site |
| `meta_accounts`, `meta_objects`, `meta_daily` | Meta ad account name, currency and timezone, campaign, ad set and ad names and status, and Meta's daily numbers per ad | No | Not tied to a site, so a site delete leaves them. Delete them by hand after you stop (below) |
| `meta_capi_log` | Per event the Conversions API handled: site, event name, the payment id or goal id, time, status (sent, failed, skipped) and the reason. No email, no click id | Pseudonymous. The payment id leads to the payment | 30 days. The daily cron deletes older rows |
| `asa_names`, `asa_daily`, `asa_status` | Apple Ads campaign, ad group and keyword names, and daily spend, for the whole Apple Ads account | No | Not tied to a site, so a site delete leaves them. They stay until you remove the `ASA_*` secrets and delete the rows by hand (below) |
| `aso_reviews` | App Store reviews of your app from Apple's public feed: review id, country, time, stars, title, text, the reviewer's App Store nickname, app version | Yes. The nickname and text are public on the App Store, and a nickname can be a real name | With the site. Remove one with a `DELETE` on the row by hand |
| `aso_keywords`, `aso_settings`, `aso_snapshots`, `aso_popularity`, `aso_status` | ASO keywords, countries, competitors, ranks, the top 10 apps per keyword, ratings and Apple Ads popularity | No | With the site. Popularity rows go when no site tracks the keyword |
| `email_messages` | Per email sent through Resend: Resend's email id, the site, the day, the sender address, the `category` tag, which event types were counted, and the send time. No recipient address and no subject | Pseudonymous. Resend's email id leads to the recipient inside your Resend account | 30 days. The daily cron deletes older rows |
| `email_daily` | Per site, day, sender address and tag: counts of sent, delivered, delayed, bounced, complained, opened and clicked emails | No | With the site |
| `sites`, `funnels`, `notes`, `share_tokens`, `site_usage`, `seo_snapshots`, `fx_rates`, `asc_sales`, `device_*_prefs` | Settings, secrets, aggregates and imports | No | With the site, or until replaced |

What is never stored: the visitor's IP address, and the full user agent string of a visit that did not come through a
Meta ad or link. Without cookies, the Worker hashes both into the day's visitor id and keeps only the hash. A visit whose URL carried
`fbclid` or `ad_id` keeps its user agent for 28 days, because Meta's Conversions API needs it ([Meta ads](#meta-ads)). With the Conversions API in
mode "every web purchase", every visit with marketing consent on that site keeps it for 28 days. The country, region and city come from Cloudflare's lookup of the IP.
So do the coordinates, which the Worker rounds to one decimal before it stores them. One decimal is about 11 km, no
finer than the city name beside them, and they are never more precise than that in any answer. The live globe
(`GET /api/live`, docs/MOBILE-API.md section 9) draws them; it shows no visitor id, name or email.
The browser, OS and device type come from the user agent.

A visit from a hosting network (AWS, Google Cloud, Azure, Hetzner and 10 others, `src/worker/datacenter.ts`) gets a
flag and drops out of the visitor counts, because a browser on a cloud server is almost always a bot. Settings, Privacy,
Datacenter visits counts them again. The flag comes from the network number Cloudflare attaches to each request, not
from a stored IP.

Click ids from Google, Microsoft, TikTok, X, LinkedIn, Reddit, Snapchat and Pinterest ads are stored raw for 90 days so
you can upload offline conversions to that network later. They identify one ad click, not a person, but the network can
tie the click to the account that saw the ad. The daily cron clears them after 90 days (`src/worker/retention.ts`).

Deleting a site in Settings removes its rows from every table above that has a `site_id`, with one exception: the
erase log stays, with the site's name and domain, because it is the proof that you answered requests and holds no
identifier of the person. `GET /api/erasures` lists it for every site, deleted ones included. Apple's sales rows stay
without the site link, because they are Apple's report and not visitor data. Alert channels limited to that site stop
naming it. The Apple Ads tables have no site link and stay. To remove them after you stop using Apple Ads:

```bash
node scripts/wrangler.mjs d1 execute founderdata --remote --command "DELETE FROM asa_daily; DELETE FROM asa_names; DELETE FROM asa_status;"
```

The Meta ads tables work the same way. After you remove `META_ACCESS_TOKEN`:

```bash
node scripts/wrangler.mjs d1 execute founderdata --remote --command "DELETE FROM meta_daily; DELETE FROM meta_objects; DELETE FROM meta_accounts;"
```

## Retention settings

Set these as `vars` in `wrangler.local.jsonc` or in the Cloudflare dashboard (Workers, founderdata, Settings, Variables).
The daily cron at 03:17 UTC applies them.

| Variable | Default | Effect |
| --- | --- | --- |
| `RETENTION_MONTHS` | `24` | Visits, events, subscription signals and thank-you page claims older than this are deleted. Visitors go once nothing points at them. A month counts as 30.44 days. Page speed rows go after 90 days, or after this when it is shorter. |
| `PII_RETENTION_MONTHS` | unset (keep) | Clears `email` and `name` on payments older than this, and `email`, `name` and `user_id` on visitors first seen before it with no visit since. Amounts, products and the customer id stay, so revenue and renewals keep adding up. |

Both take a whole number from 1 to 1200. Any other value falls back to the default.

## Who can read it

| Who | How they sign in | What they see |
| --- | --- | --- |
| Owner | `ADMIN_PASSWORD` | Everything, and can change everything |
| Teammate | Name or email and their own password, from an invite link | Owner: as the owner. Viewer: as the viewer. The owner can revoke one person at once. Their session and the keys and links they made end. What they saw stays known, so rotate it ([GUIDE.md](GUIDE.md#team-pro)) |
| Viewer | `VIEWER_PASSWORD`, optional | Every dashboard number, read-only. No write key, webhook secret, share link, read key, alert channel or device. Names, emails and user ids show as empty unless `VIEWER_PII` is `1`. No raw CSV export without it. Visitor ids and journeys are visible |
| Phone | Device token from `/api/mobile/login` with the admin password | Stats, read-only except chart notes, with every secret set to null. Names, emails, user ids and customer ids show, because the owner's app locks with Face ID; `PHONE_PII=0` hides them. Raw CSV exports answer 403, so a lost phone does not hold the customer list as a file. It can list and revoke only itself |
| Share link | `/share/<token>` | Aggregates of one site. No visitors, journeys, names or emails. The page and its API send `X-Robots-Tag: noindex, nofollow`, so search engines skip it if the link leaks |
| Read key | `Authorization: Bearer rtr_...` | Aggregates of one site through `/api/v1/stats/*` |

The cookie of each role is bound to its own password: changing `ADMIN_PASSWORD` signs out the owner's browsers and
phones, changing `VIEWER_PASSWORD` signs out viewers, and changing `SESSION_SECRET` signs out everyone.

## The visitor id

Without cookies, the visitor id is `HMAC(daily salt, site id | IP | user agent)` and the daily salt is
`HMAC(secret, UTC date)`. The secret is `VISITOR_SALT_SECRET` when set, else `SESSION_SECRET`. A new day gives a new
id, and nothing stored links Monday's id to Tuesday's.

The limit: whoever holds the secret and a copy of the database can test a guess. Given someone's IP address and user
agent on a given day, they can compute that day's id and look it up. So treat the secret like a database password.
Set `VISITOR_SALT_SECRET` to keep it apart from the login secret:

```bash
openssl rand -base64 32 | node scripts/wrangler.mjs secret put VISITOR_SALT_SECRET
```

Setting or changing it gives every cookieless visitor a new id for the rest of that day, the same as changing
`SESSION_SECRET` did before. After that, rotating `SESSION_SECRET` (to sign everyone out) no longer touches visitor ids,
and rotating `VISITOR_SALT_SECRET` no longer signs anyone out.

Your own data can link the ids. When your site calls `identify()` with a user id or an email, or a payment carries an
email, the visitor row keeps it. Two partial indexes, `visitors_user` and `visitors_email`, list only those identified
rows. FounderData reads them in two places. A purchase goes to the last visit from a real source of any visitor id
with the buyer's user id or email, so a signup on Monday from a tweet and a purchase on Friday join up.
`POST /api/v1/goals` with `user_id` or `email` finds that person's latest visit. Anonymous visitors are never joined:
a visitor id without a user id or email stays a one-day id. A site that never calls `identify()` and takes no buyer
emails joins nothing.

With cookies on (`data-cookies="on"` after consent), the id is random and lives in the `rt_vid` cookie for a year.
FounderDataKit in an app keeps a random id per launch, and in the Keychain only after `setConsent(true)`. Without
consent the server groups one device's launches on one UTC day into one visitor, with a key built the same way as the
cookieless web id: HMAC(daily salt, site id, IP, user agent, device model, OS version, locale). It keeps the key and
the launch ids it grouped in `app_aliases` for 30 days, never the IP or the user agent. The next day the device gets an
unrelated key (docs/APP-API.md, section 3).

An app developer can opt in to one id per install without consent: `installId: .vendor` in `FounderData.configure`
(ios/README.md, "One id per install without consent"). The SDK then sends the first 16 bytes of SHA-256 over a fixed
prefix, the site id and `identifierForVendor`, as a UUID. The raw `identifierForVendor` never leaves the phone. The
server stores the id in `visitors` like a consented install (`persistent` is 1), and each batch says `"id": "vendor"`.
It is off by default. An app that turns it on must declare Device ID in its App Store privacy label and name it in its
privacy policy. Reading `identifierForVendor` is reading information from the device, so whether it needs consent
under Article 5(3) of the ePrivacy Directive is a question the app's developer has to answer for their app.

## What Cloudflare processes

- **Workers** run every API call. The Worker sees each request's IP address and headers in memory, to hash the visitor
  id and to read the location Cloudflare attaches. It writes neither to storage.
- **D1** stores the tables above. Cloudflare places a new database near where it was created, unless you pick a
  jurisdiction (next section).
- **Workers Logs** are on, with invocation logs off (`wrangler.jsonc`, `observability`). Invocation logs would keep
  each request's URL and headers, and the headers include the visitor's IP address. With them off, Workers Logs keep
  only the lines the code writes, which are error messages from the cron jobs and alert sends. None holds visitor data.
  Cloudflare keeps them 3 days on the free plan and 7 on Workers Paid. To turn logs off entirely, set
  `"observability": { "enabled": false }` in `wrangler.local.jsonc`; `npx wrangler tail` still shows live output.
- **Cache API** keeps site icons the dashboard asked for, by domain name, for 7 days. No visitor data.
- **Static assets**: the dashboard and `/js/script.js` are served as files. Cloudflare sees the request like any web
  server would.

## Keep the database in the EU

D1 can pin a database to a jurisdiction when it is created. Cloudflare can't move an existing database there later.

```bash
npm run setup -- --jurisdiction eu
# by hand: npx wrangler d1 create founderdata --jurisdiction eu
```

For a deployment that already runs, create a second database with `--jurisdiction eu`, export the old one
(`npx wrangler d1 export founderdata --remote --output founderdata.sql`), import the file into the new one
(`npx wrangler d1 execute <new name> --remote --file founderdata.sql`), and point `database_name` in
`wrangler.local.jsonc` at the new name.

The Worker can't ask D1 where the database is, so setup writes `"vars": { "DATA_JURISDICTION": "eu" }` into
`wrangler.local.jsonc` when it creates the database there. For a database you moved by hand, add that line yourself
and deploy. Settings > General then shows "Stored in: EU (D1 jurisdiction eu)", and `GET /api/v1/definitions` returns
it as `data_location`. Without the variable both say the database is not pinned to a region.

The same row has a **Copy for DPA** button. It copies one paragraph for your record of processing or a DPA appendix:
where the database is stored, where requests are handled, how the IP address and user agent are hashed, the retention
in days from `RETENTION_MONTHS` and `PII_RETENTION_MONTHS`, and the tracker's cookie modes. The server can't tell
whether a site turned on cookie mode, so the paragraph states it as a condition. Read it once before you paste it.

The jurisdiction covers the stored data only. The Worker runs in the Cloudflare data center nearest each visitor,
inside or outside the EU, and handles the request there: it reads the IP address and user agent in memory, hashes them
and sends the result to the database in the EU. If your policy promises that data stays in the EU, say "stored in the
European Union" and not "processed only in the European Union". The policy text below does.

## Subprocessors

Always:

- **Cloudflare, Inc.**: Workers, D1, Workers Logs, Cache, and R2 once you set up recordings (Pro) or mail (Pro).
  Cloudflare's DPA is part of its self-serve terms (cloudflare.com/cloudflare-customer-dpa), with the EU Standard
  Contractual Clauses.

Only when you turn the feature on. Each one receives what is listed, nothing else:

| Service | Turned on by | What it receives |
| --- | --- | --- |
| Apple Push Notification service | `APNS_*` secrets | Your phones' push tokens, and site name, amount, product and source of each payment |
| Resend | `RESEND_API_KEY` and an email alert channel | Your alert address and the alert text: site name, amounts, products, sources. No buyer name or email |
| Slack, Discord, Telegram, your webhook | An alert channel | The same alert text |
| Apple App Store Connect, Apple Ads | `ASC_*` or `ASA_*` secrets | Nothing about visitors. The Worker downloads your sales and ad reports |
| Meta Platforms Ireland (Marketing API) | `META_ACCESS_TOKEN` and an ad account in a site's settings | Nothing about visitors. The Worker downloads your ad account's numbers and the ads' thumbnails |
| Meta Platforms Ireland (Conversions API) | A dataset id and a mode other than Off in a site's Meta settings | Per purchase: SHA-256 of the buyer's email, of the payment provider's customer id, of the visit's country and city; the ad click id (`fbc`); the Meta browser id (`fbp`) of a visit with marketing consent; the user agent; the landing page URL; amount, currency, payment id and product. Per mapped goal from an ad visit: the same without the purchase fields. No IP address, no name |
| Cloudflare R2 | `npm run setup -- --replay` (recordings) or `--mail` | The recording files: the page as the visitor saw it, with masked text and inputs, mouse moves, scrolls and clicks. Mail bodies and attachments for mail. In the EU when the database is |
| Your AI agent's model provider | A key you give an agent, and the agent calling `get_recordings` | Click labels, form field names, page paths and error messages from recordings, as the agent's input. No video, no names or emails |
| Frankfurter (ECB rates) | Always, when a payment is in another currency | A currency code and a date |
| Apple App Store search hints | Typing in the ASO tab's Add keywords box | The typed word and a country, from the Worker. No visitor data |
| The websites you track | Opening the dashboard | A request for `/favicon.ico` from the Worker, with no visitor data |

The ASO collector (`scripts/aso-collect.mjs`, [ASO.md](ASO.md)) runs on your own machine and talks to Apple from
there. Apple receives the app's keywords, countries and App Store ids, and that machine's IP address. It sends no
visitor data.

Resend's email webhook goes the other way: Resend sends FounderData an event for each email your sites send, once you
add the webhook ([GUIDE.md](GUIDE.md#email-resend-pro)). The event carries the recipient address and the subject. The
Worker reads the email id, the sender, the `category` tag, the event type and the time, and drops the rest before
anything is stored. Opens and clicks exist only when you turned on Resend's open or click tracking, which puts a pixel
and redirected links in your emails; that choice and its consent question sit with the sender, not with FounderData.

Your payment providers (Stripe, Dodo, Lemon Squeezy, Polar, Paddle, Gumroad, RevenueCat, Apple) send payments to
FounderData. They are already your processors for the payment itself. The checkout metadata you add (`rt_visitor_id`,
`rt_session_id`, `rt_site_id`) is pseudonymous.

## Mail (Pro)

Mail is the one feature that stores what people write. With it set up, the deployment holds the messages your apps
send and the messages people send to your addresses.

- **What is stored.** D1 holds each message's sender, recipients, subject, first 200 characters, headers and status.
  An R2 bucket holds the text, the HTML, the attachments and, for received mail, the raw message.
- **How long.** Bodies of mail an app sent through the API go after 30 days, with delivery events and webhook
  deliveries. Inbox mail stays until you delete it. [MAIL.md](MAIL.md#what-is-stored-and-for-how-long) has the table.
- **Who can read it.** The owner in the dashboard, and a scoped key with `mail:read`. Viewers, viewer teammates, the
  iPhone app, share links and keys with `read` get no mail.
- **Where it is.** The bucket is created in the EU when the database is. The queue is different: Cloudflare Queues
  have no jurisdiction setting, and a queue message for received mail or a delivery event carries the sender's and
  the recipient's address until the Worker has handled it. Bodies never go on the queue.
- **Erase.** Erasing a person by email deletes every message with their address on it, the stored objects and their
  suppression entries, here and on Cloudflare's suppression list. The admin login does that, and so does a key that
  holds `mail:write` next to `payments:write`. A key without `mail:write` erases the site's rows only and answers
  `mail_skipped: true`. The erase refuses one of your own addresses, because every thread it wrote in would go.
- **Cloudflare.** Cloudflare Email Service and Email Routing process every message and keep their own delivery logs.
  Both are covered by the Cloudflare DPA above.
- **Your privacy policy** says that you answer support mail from this system, if you do.

## Recordings (Pro)

Recordings are of your website only. The iPhone app is never recorded, so they change your privacy policy, not your
App Privacy answers in App Store Connect.

Record visits is off for every site until you turn it on (docs/GUIDE.md, "People and recordings"). A recording is a
copy of the page as the visitor saw it, and of what they did on it: the page's HTML and styles, mouse moves, scrolls,
clicks and the size of the window. Recording sets no cookie and stores nothing in the visitor's browser.

- **What is hidden.** Every input is masked in the browser, before anything is sent: typing shows as dots. Text inside
  an element with `data-fd-mask` is masked the same way. An element with `data-fd-block` is left out, and the player
  shows an empty box. Canvas, web fonts and frames from other domains are not recorded. A page on the site's list of
  **Pages that are never recorded**, such as `/account`, is not recorded at all, and the script sends no clicks or
  errors from it. Mask anything else that shows personal data, such as names and addresses on account pages.
- **Where it is.** In the R2 bucket `npm run setup -- --replay` creates on your own Cloudflare account, in the EU when
  the database is. Each chunk is a file `r/<site id>/<visit id>/<number>`. D1 holds one row per recording in
  `replays`. Nothing goes to another company.
- **How long.** The days you pick for the site: 7, 30 or 90, 30 by default. With "keep only visits where something
  happened", a recording without a goal or a payment goes after 24 hours. A rule on the bucket deletes every file 90
  days after upload, whatever the setting.
- **The digest.** Next to each recording D1 keeps a short summary the script builds in the browser, at most 2,000
  characters: the size of the window, and for each page its path, the seconds on it, how far down the visitor
  scrolled, the label of each click that changed nothing, the names of form fields the visitor changed (such as
  `email`, never what they typed) and whether a form was sent. A field inside `data-fd-mask` or `data-fd-block`, or a
  password field, is never named. A click label leaves out the text of anything masked, blocked, editable or a form
  field inside the element, and inside `data-fd-mask` or `data-fd-block` it is the tag name. Your agents read the
  digest with a read key; it holds no name, email or user id. It goes with the recording: same days, same erase.
- **Clicks and errors.** A recorded visit also sends, with the ping it already sends, each page's clicks (the same
  labels, and a rage click's element tag and class) and JavaScript error messages with their file and line. They are
  `activity` rows in `events`, and live as long as the visit's other events: `RETENTION_MONTHS`, 24 months by
  default, not the recording's days. Erasing a person deletes them too.
- **Who can watch.** People who sign in to the dashboard. Share links show no recordings.
- **Erase.** Erasing a person deletes their recordings, files and rows, and the erase log counts them.
- **Which visits.** Your own visits with `?rt_ignore=true`, bots and visits from hosting networks (datacenter visits)
  are never recorded. The share of visits recorded and
  the most visits a day are site settings.
- **Consent.** Recording a visitor's screen usually needs their consent in the EU and the UK. By default the script
  records a picked visit whether or not the visitor accepted your cookie banner. With **Wait for consent** on (Settings,
  Record visits, Advanced), it records only after the visitor consents to cookies: your banner calls
  `founderdata('consent', true)`, or the page has `data-cookies="on"`. Until then it loads no recorder and sends no
  clicks or errors. Remember visitors does not count as consent.
- **Your AI agent.** When an agent reads recordings with `get_recordings` or the read API, the click labels, form
  field names, page paths and error messages in the answer go into that agent's prompt, so its model provider
  (Anthropic, OpenAI or whoever runs it) receives them. The video, the page's own text, what visitors typed, mouse
  movement and names and emails never go. To keep text out of click labels and error messages, mark it with
  `data-fd-mask`; a label inside it is the tag name. Use a model provider you have a data processing agreement with,
  or don't give the agent a read key.
- **Your privacy policy.** Say that you record visits, what is recorded and hidden, where the recordings are and how
  long you keep each part. A paragraph you can adapt, with your own days, retention and company name:

  > We record some visits to this website to find and fix problems. A recording shows the pages as you saw them,
  > including their text, with your mouse moves, scrolling and clicks. Anything you type into a form is never
  > recorded, and we hide other personal details on our pages. We also keep the names of form fields you filled in,
  > the words on buttons you clicked and error messages, without what you typed. Recordings are stored with
  > Cloudflare, our hosting provider, and deleted after 30 days; the clicks and error messages are kept with our other
  > visit statistics for 24 months. Nobody else gets them. You can ask us to delete your recordings at any time.

  The Record visits card has a shorter sentence with your own days and a copy button. If you turn on **Wait for
  consent**, you can add: "We record your visit only after you accept cookies." Ask your counsel whether recording
  without that is allowed where your visitors live.
- **A data protection assessment.** If you write one (a DPIA under GDPR Article 35, which large-scale monitoring of
  behavior can require), the facts it needs are here: the purpose (finding faults on the site), the data (the page as
  shown, with masked inputs; clicks, scrolls, field names and error messages; a pseudonymous visitor id, no IP address),
  who can see it (dashboard logins, and agents with a read key, which get no video), where it lives (your Cloudflare
  account, in the EU when the database is), how long (the days above), and the controls (off by default, masking,
  never-record pages, Wait for consent, a daily maximum, a share of visits, erase per person).

**Remember visitors.** A site setting that keeps a visitor id in first-party cookies (`rt_vid`, `rt_sid` and
`rt_consent=r`) without the visitor's consent, so People can follow someone across days. It is off by default. Storing
an id on the device without consent breaks Article 5(3) of the ePrivacy Directive in most of the EU, so turn it on only
where your counsel says you may.

## Experiments

Experiments (FounderData Pro) store no new personal data. The version a visit saw is one session property,
`exp_<key>`, such as `exp_pricing_headline: b`, on the visit row FounderData writes anyway. The Worker picks it from a
hash of the experiment's key and the visitor id. Nothing is stored in the browser for it: no cookie, no local storage.
A preview link (`?fd_exp=`) stores nothing at all.

Without cookies the visitor id changes every day at 00:00 UTC, so FounderData cannot keep a person in one version
across days, and the results say how many people it saw in more than one. With Remember visitors on, the id in the
cookie keeps them in one version; that setting needs the consent the section above describes.

The results join payments and subscriptions to the people in each version, the same way the revenue reports do. A
dashboard login sees the names of paying people per version; an API key gets visitor ids and amounts only. Erasing a
person removes their visits, and with them the version they saw. Deleting an experiment keeps the property on old
visits, which expire with them.

## Surveys

<!-- r7 survey: written by lane survey -->

## Click maps and scroll

<!-- r7 pages: written by lane pages -->

## Errors

<!-- r7 errors: written by lane errors -->

## Meta ads

The spend import sends nothing about visitors to Meta: the Worker only downloads your own ad account's numbers.

The Conversions API is different. It sends Meta data about your buyers, hashed where Meta asks for a hash, so Meta can
match them to its users ([what goes](#subprocessors)). Meta is then a recipient, and for some uses a joint controller,
of that data. Before you turn it on:

- **Consent.** Meta's terms ask you not to send events about people who did not consent, and the API has no consent
  field. "Only visitors who gave marketing consent" is on by default: FounderData then sends only buyers whose visit
  carried marketing consent, which your banner's marketing category gives with `founderdata('marketing', true)`. It is
  a separate call from analytics cookies, because consent to analytics is not consent to sharing with Meta. A site
  without a banner sends nothing in that setting, and the setup checklist says so when every buyer was skipped for it.
- **Without consent.** Turning the switch off is a legal decision for your counsel, not a technical one: the click id
  and a hashed email identify a person to Meta. The settings ask for a confirmation and keep the time it was given.
- **Your privacy policy** names Meta as a recipient, what goes (the subprocessor table above) and the purpose
  (measuring and optimizing ads).
- **Retention.** The click id and the user agent go after 28 days, Meta's longest click window; the ad id names an ad,
  not a person, and stays. The log of what was sent keeps no email and no click id, and goes after 30 days.
- **Erase.** Erasing a person deletes their visits with the click id and user agent. Events already sent to Meta stay
  with Meta: ask Meta to delete them under its terms.

## GDPR checklist for a deployment

1. **Legal basis.** Cookieless analytics stores nothing on the visitor's device. Most deployments rely on legitimate
   interests (Article 6(1)(f)) for it and write a short balancing test. The EDPB's Guidelines 2/2023 read Article 5(3)
   of the ePrivacy Directive broadly, so ask your counsel whether hashing the IP and user agent needs consent in your
   country. Cookie mode needs consent: turn it on only after it (`window.founderdata('consent', true)`).
2. **`identify()`** sends a user id, name or email and turns a visitor into a known person. Call it only for signed-in
   users, name it in your privacy policy, and leave out fields you don't need. A user id alone is enough to erase later.
   FounderData uses it to credit a purchase to an earlier visit of the same person (see "The visitor id"), so say in
   your policy that you link a signed-in user's visits.
3. **DPA.** Accept Cloudflare's DPA (it applies to every account; keep a copy). Sign one with every optional service
   from the table above that you turn on.
4. **Region.** Create the database with `--jurisdiction eu` if your policy promises EU storage.
5. **Retention.** Pick `RETENTION_MONTHS` and `PII_RETENTION_MONTHS` and write the same numbers in your policy and
   your record of processing activities.
6. **Access.** Give colleagues `VIEWER_PASSWORD` instead of the admin password. Leave `VIEWER_PII` off unless they
   need to see who bought. Give tools a read key, not the write key.
7. **Data subject requests.** Erase a person from their profile, or call `POST /api/sites/<id>/erase` with
   `{"email": "..."}` or `{"user_id": "..."}`, or `POST /api/v1/erase` with the site's API key (docs/API.md, "Erase one
   person"). Add `"note"` with your ticket number. Repeat on each site they used. For
   access requests, open the profile, or export `payments.csv`, `sessions.csv` and `events.csv` from the site
   (docs/API.md) and filter by the visitor id.
8. **Records.** Settings, "Erase log" lists each erase request with its time, method, counts, who handled it (the
   dashboard login or a script with the API key) and your note, and exports as CSV. It keeps no identifier of the
   person, so the log itself holds no personal data, and it outlives the site. With one shared admin password, "who"
   means the login, not a named colleague, so put the name in the note.
9. **Breach readiness.** Read the breach procedure below once, before you need it.
10. **Recordings and Remember visitors (Pro).** Both are off by default. Before you turn either on, read "Recordings
    (Pro)" above and add them to your privacy policy.

### Legitimate interest balancing test

Article 6(1)(f) needs three answers, written down before you start. Copy this into your records and fill the brackets.

> **Purpose.** We measure how many people visit [site], where they come from, which pages they read and which visits
> lead to a purchase, to decide where to spend on content and marketing and to find broken pages.
>
> **Necessity.** Aggregate counts per day, page, source and country answer these questions. Revenue per source needs a
> link from a purchase to the visit before it. FounderData stores no IP address and, without cookies, an id that changes
> every day, so no anonymous visitor can be followed across days. [We call `identify()` only for signed-in users, to
> [reason]. Their visits on different days are linked to credit a purchase to the visit that brought them.] [We do not
> use `identify()`.]
>
> **Balancing.** Visitors expect a site to count its visits. The data stays with us on Cloudflare and goes to no ad
> network or data broker. Visit data is deleted after [24] months, [names and emails on purchases after [N]
> months]. Visitors can object at [address], and we erase them with the tool built for it. [Cookie mode runs only
> after consent.] We think the impact on visitors is low and our interest is not overridden.
>
> **Reviewed** on [date] by [name]. Next review: [date], or when we add a field, a site or `identify()`.

### Breach procedure

A breach here most likely means one of three things: a leaked admin password, a lost phone that is signed in, or a
copy of the database in the wrong hands. Within the first hour:

1. **Rotate what leaked.** A new `ADMIN_PASSWORD` signs out every admin browser and every phone; a new
   `SESSION_SECRET` signs out everyone; a new `VIEWER_PASSWORD` signs out viewers.

   ```bash
   openssl rand -base64 24 | node scripts/wrangler.mjs secret put ADMIN_PASSWORD
   openssl rand -base64 32 | node scripts/wrangler.mjs secret put SESSION_SECRET
   ```

   Revoke a lost phone under Settings, Devices, or change `ADMIN_PASSWORD`. Rotate a site's write key in its Settings
   (or `POST /api/sites/<id>/rotate-key`). Rotate each webhook secret at the provider first, then paste the new one in
   Settings, Payments. Revoke share links and read keys in Settings, Share links. Set a new `VISITOR_SALT_SECRET` if the
   database copy and the secret could both have leaked.
2. **Find out what was exposed.** The table at the top says what each table holds. A phone token never gets exports,
   and sees names and emails unless `PHONE_PII=0`. A viewer without `VIEWER_PII` sees no names or emails. An admin password or a database copy
   exposes everything in the database, including buyer emails and names on payments.
3. **Write it down.** Time found, what happened, what data, how many people, what you did. Article 33(5) wants this
   record even when you decide not to notify.
4. **Tell your supervisory authority within 72 hours** of finding it, unless the breach is unlikely to risk
   anyone's rights (Article 33). Pseudonymous visit data alone is usually low risk; buyer emails and names usually are
   not. If the risk to people is high, tell them too (Article 34).
5. **Tell Cloudflare** only if you think their side failed: cloudflare.com/trust-hub has the contact. Report a flaw in
   FounderData itself through the Security tab of the repository (SECURITY.md).

### Privacy policy text to adapt

Replace the bracketed parts and delete what does not apply.

> We measure visits to [site] with FounderData, analytics software we run ourselves on Cloudflare. It sets no cookies
> [unless you agree to analytics cookies]. For each visit we store the pages you open, the site that sent you, the
> campaign tags in the link, your country, region and city (with its location to about 11 km), and your browser, operating system and device type. To count
> visitors, the server combines your IP address and browser into an identifier that changes every day. Your IP address
> is not stored. [When you sign in, we link your visits to your account id [and email].] [When you buy, we link the
> purchase to the visit that brought you, to learn which channels lead to sales.]
>
> Our legal basis is our legitimate interest in understanding how people find and use [site] [and, for analytics
> cookies, your consent]. Visit data is deleted after [24] months. [Names and emails on purchase records are removed
> after [N] months.] Purchase records are kept as long as tax law requires.
>
> The data is stored by Cloudflare, Inc. [in the European Union. The servers that receive each request run in the
> Cloudflare data center nearest you, which can be outside the European Union.] [Alerts about purchases go to [Slack /
> email via Resend] without your name or email.] To see or delete your data, write to [address].

## For procurement

A short answer sheet for a security or vendor review.

- **What it is.** Open source software (MIT) that you deploy to your own Cloudflare account. There is no FounderData
  company or service between you and Cloudflare, and nothing phones home.
- **What runs where.** A Cloudflare Worker serves the API, the dashboard and the tracking script, in the Cloudflare
  data center nearest each request. All data sits in one D1 database, in the jurisdiction you choose when you create
  it (`--jurisdiction eu` for the EU). Three daily cron jobs run on the same Worker.
- **Processors.** Cloudflare, Inc. is the only one in the default setup, under its customer DPA with the EU Standard
  Contractual Clauses. Optional services, each off until you turn it on, are in the subprocessor table above.
- **Personal data.** Pseudonymous visit data; buyer email and name when a payment provider sends them; whatever your
  site passes to `identify()`. No IP address and no cookies by default. The full user agent only on visits that came
  through a Meta ad or link, for 28 days. Retention is in the table at
  the top.
- **Access.** One admin password, an optional read-only viewer password, named teammate logins with a revoke for each, phone
  tokens and read keys. No single sign-on. Login failures lock an IP out after 10 tries for 15 minutes, and a teammate account after 20 tries for an hour.
- **Encryption.** HTTPS to the Worker. D1 encrypts data at rest on Cloudflare's side.
- **Record of processing.** "Web analytics of [site]: pages, referrer, campaign, country and device of each visit,
  with a daily-changing pseudonymous id; purchases linked to the visit before them. Legal basis Article 6(1)(f).
  Processor Cloudflare, Inc., data stored in [the EU]. Retention [24] months for visits."
- **Security contact.** Report a vulnerability through the repository's Security tab (SECURITY.md). For a
  deployment, the contact is whoever runs it.

## Known limits

- The favicon fetcher refuses IP addresses in every spelling, private names and redirects to them, but a Worker can't
  resolve DNS, so it can't see that a public name points at a private address. On Cloudflare that does no harm: a
  Worker's `fetch` can't reach private ranges. Under `wrangler dev` on a laptop it can, so don't run a dev server
  with a real login on an untrusted network.
- Forwarded IP and location headers (`X-Forwarded-For`, `x-vercel-ip-*`) count only with `TRUST_FORWARDED_FOR=1`,
  because any client can send them. Turn it on only when every event comes through your own proxy.
- Payment ids, amounts and customer ids stay after erase and after `PII_RETENTION_MONTHS`. Your payment provider keeps
  its own copy too. Erase at the provider as well.
- Erasing one person leaves `email_messages` alone. Its rows hold no address to find the person by, and they go
  after 30 days. Erase the person in Resend as well.
