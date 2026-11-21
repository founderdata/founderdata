# Mobile API and App Store sales import

Contract for the owner's iPhone app, which signs in to your deployment, shows the dashboard and receives payment
pushes, and for the App Store Connect sales import. The app and the sales import are FounderData Pro
features ([PRO.md](PRO.md)), and the app is in the Pro repository. Any other client can use the same routes.

Amounts in this API are decimal numbers in major units (`4.9` is 4.90), always next to an ISO currency code. Times are
Unix milliseconds. Sandbox and TestFlight purchases never send a push and never count in totals.

## 1. Auth

The app talks to one FounderData deployment. The user types the deployment URL and the admin password once.

- `POST /api/mobile/login` `{ password, deviceName }` → `{ token, deviceId }`. Same lockout as `/api/auth/login`.
  The token is 32 random bytes, hex. Only its SHA-256 is stored (table `devices`, column `token_hash`), behind a
  16-character prefix derived from `SESSION_SECRET` and `ADMIN_PASSWORD`: `<prefix>:<sha256>`.
- Every other `/api/mobile/*` route needs `Authorization: Bearer <token>`. The existing login-protected routes
  (`/api/home`, `/api/live`, `/api/apps`, `/api/sites/...`, `/api/appstore`) accept the same bearer token for reading: GET and HEAD.
  Any other method there answers HTTP 403 `{ error }`, so a phone token can't change, rotate or delete a site. A phone
  writes only two things outside its own device settings. The first is chart notes: `POST /api/sites/:id/notes`,
  `DELETE /api/sites/:id/notes/:nid` and `POST /api/sites/:id/notes/:nid/review`
  (`{ outcome: "kept" | "reverted" | "iterated", comment? }`, docs/API.md). The second is its mail actions under
  `/api/mobile/mail/*`: read state, archive and replies in a thread (section 11). Inside `/api/mobile/*` it also acts
  on Today's cards and settings (section 12). Other writes need the dashboard cookie. Inside `/api/mobile/*` the token
  works for every route listed here.
- A phone token reads no secrets. In every JSON answer to it, the site's write key `api_key`, the webhook signing
  secrets, `revenuecat_auth`, `gumroad_token` and any other `*_secret`, `*_token` or `*_auth` field is `null`. Share
  links and read keys (`/api/sites/:id/share`) and alert channels (`/api/alerts`) answer 403. A lost phone can read
  stats but can't post payments with the write key or open a read key.
- A phone token sees names, emails, user ids and customer ids, like the dashboard. Set `PHONE_PII=0` on the Worker to
  get `null` for them instead. With `PHONE_PII=0` a phone also gets no mail: every `/api/mobile/mail/*` route answers
  403, no mail push goes out (section 11), and Today leaves out its Reply cards (section 12). Raw CSV exports (`/api/sites/:id/export/*`) always answer 403 to a phone.
- The dashboard's mail routes, `/api/mail-admin/*`, answer 403 to a phone token whatever the method. A phone reads
  mail through `/api/mobile/mail/*` instead.
- The viewer login (docs/GUIDE.md, "Viewer login") can't sign a phone in: `/api/mobile/login` takes the admin
  password only.
- A new `ADMIN_PASSWORD` or `SESSION_SECRET` changes the prefix, so every token stops working at once and answers
  401; the app asks for the password again. The next successful sign-in (dashboard or phone), or the nightly cron,
  marks the old devices revoked and clears their push tokens. Until then they can still receive payment pushes.
- Phones signed in on a version from before the prefix keep working after the upgrade. Their row holds a bare SHA-256
  (no `:`). The next request with that token is accepted, and the row is rewritten as `<prefix>:<sha256>`. Until then
  the phone still gets payment pushes, and neither a sign-in nor the nightly cron revokes it.
- `POST /api/mobile/logout` revokes the calling device.
- `GET /api/mobile/devices` → `{ devices: [{ id, name, createdAt, lastSeenAt, push: bool, widgetPush: bool }] }`,
  `DELETE /api/mobile/devices/:id`. With a phone token the list holds only the calling device, and the delete works
  only on its own id (another id answers 403). With the dashboard cookie both cover every device; the dashboard
  Settings page lists them with a revoke button. The viewer login gets 403 on both.

## 2. Push registration

- `PUT /api/mobile/push` `{ token, environment: "sandbox" | "production", topic }`: the APNs device token (hex) for
  alerts. `topic` is the app's bundle id.
- `PUT /api/mobile/widget-push` `{ token, environment, topic }`: the WidgetKit push token from `WidgetPushHandler`.
  `topic` is the app's bundle id; the Worker sends to `<topic>.push-type.widgets`.
- `PUT /api/mobile/live-activity` `{ token, kind: "start" | "update", environment, topic }`: a Live Activity token.
  `start` is the push-to-start token of `Activity<RevenueActivityAttributes>.pushToStartTokenUpdates`, `update` the
  running activity's `pushTokenUpdates` token. `topic` is the app's bundle id; the Worker sends to
  `<topic>.push-type.liveactivity`. Both tokens share one `environment` and `topic`. A new or changed token writes 1
  row, the same token again none. A token registered by another device moves to this one.
- `DELETE /api/mobile/live-activity` clears both Live Activity tokens (the Account switch off): no more starts or updates.
- APNs answers 410, `BadDeviceToken`, `Unregistered` or `DeviceTokenNotForTopic` disable that token until the app
  registers it again. A dead Live Activity token is cleared.
- `POST /api/mobile/push-test` sends a test alert and a widget push to the calling device and returns
  `{ alert: { status, reason? }, widget: { status, reason? } }`. It doubles as the check that the Worker reaches APNs.

Worker secrets: `APNS_KEY_P8` (the .p8 file contents), `APNS_KEY_ID`, `APNS_TEAM_ID`. Without them push is off and
`push-test` answers HTTP 503 with `{ error: "APNs not configured" }`. Auth is token-based (ES256 JWT, cached up to 50 minutes).

## 3. Notification settings

Events: `purchase` (a new paid payment), `renewal` (a payment with `renewal = 1`), `refund`, `trial` (a trial start
signal). Defaults: purchase and renewal on, refund and trial off. Sites and products are on unless switched off.

- `GET /api/mobile/notifications` →
  `{ events: { purchase, renewal, refund, trial }, digest: { daily, weekly, timezone }, renewalMinimum: { amount, currency },
  sites: [{ id, name, enabled, products: [{ product, enabled }] }], mail: {...} }`.
  `products` lists the distinct non-sandbox `payments.product` values of the site from the last 365 days. `mail` is
  described under [Mail pushes](#mail-pushes).
- `PUT /api/mobile/notifications` with any subset:
  `{ events?: {...}, digest?: { daily?, weekly? }, renewalMinimum?: { amount, currency? }, sites?: [{ id, enabled?, products?: [{ product, enabled }] }], mail?: {...} }`
  → the full object again. A value of the wrong type answers 400 `{ error }` and changes nothing.

Settings are per device. A payment pushes to every device whose settings allow its event, site and product.

`renewalMinimum` mutes small renewals. A renewal under `amount` (major units of `currency`) sends no alert; the widget
push still goes out. The default is 5 in the first site's currency, so a $2.99 renewal stays quiet. `amount: 0` pushes
every renewal. Leave out `currency` to keep the current one. A renewal in another currency converts at the newest ECB
rate stored in the last 14 days. With no rate it pushes.

`digest` switches the two scheduled pushes. Both start on, for new and existing devices:

- `daily`: at 08:00 every day, the phone Home's "Since yesterday" numbers (section 7) at that moment.
- `weekly`: at 08:00 on Mondays, the sentences of the weekly report (`GET /api/v1/weekly`, `totals.lines`).

08:00 is in the reporting timezone (docs/API.md, "Reporting timezone"), which `digest.timezone` names. The Worker's cron (`*/5 * * * *` in
`wrangler.jsonc`; the run at minute 0 does the hourly work) checks the time. A run between 08:00 and 10:59 local time sends a push that has not gone out that
day, so a skipped cron run still delivers. Each push goes out once per day: the first run claims the day with one row
in `scheduled_pushes`. A device that switched sites off gets the numbers of its other sites. Revoked devices, devices
signed in under an old password and devices without a live alert token get nothing.

The same 08:00 run starts the day's Live Activity on every device with a push-to-start token, whatever its `digest`
switches, inside the daily push's claim. A device with an update token first gets an `end` for its old activity.

### Mail pushes

FounderData Pro with mail on your own domains ([MAIL.md](MAIL.md)) can push each received message to the phone. The
switches are per device, in the `mail` object of the settings:

```json
{
  "available": true,
  "enabled": false,
  "newThreadsOnly": false,
  "skipSpam": true,
  "domains": [{
    "id": "dom_k3j2", "name": "mail.acme.example", "receiving": true, "enabled": true,
    "addresses": [{ "id": "adr_7f2a", "address": "support@mail.acme.example", "enabled": true }]
  }]
}
```

- `available` is false when the Worker has `PHONE_PII=0`. The phone then gets no mail push and no mail route, whatever
  the switches say. Hide the mail settings when it is false.
- `enabled` turns mail pushes on. It starts off for every device, old and new: a phone asks for them.
- `newThreadsOnly` pushes only the message that starts a thread, not the answers in it. It starts off.
- `skipSpam` sends no push for a message that is likely spam (rule below). It starts on. The message still lands in
  the inbox.
- `domains` lists every mail domain by name. `receiving` says whether the domain takes mail at all. `addresses` lists
  the domain's addresses whose action is `inbox`, the catch-all `*@domain` last. Mail to an address with another action
  (`forward`, `webhook`, `drop`) never pushes, so those are left out.
- A domain or address is on until the device switches it off. One added later starts on. A message pushes only when
  both its domain and its address are on.

`PUT` takes any subset, for example
`{ "mail": { "enabled": true, "domains": [{ "id": "dom_k3j2", "addresses": [{ "id": "adr_7f2a", "enabled": false }] }] } }`.
Unknown domain and address ids are skipped, as unknown sites are. An address id that belongs to another domain, or to
an address that is not `inbox`, is skipped too. Signing the device out deletes its switches.

When a message pushes. All of these must hold:

1. Mail is set up and the message was stored in the inbox of an address whose action is `inbox`. A refused forward
   that fell back to the inbox stays quiet, and so does a message to an address deleted while it was being stored.
2. The From address is not on one of this deployment's mail domains, so mail you sent yourself never pushes.
3. The device has a live alert token, `enabled` on, the domain and the address on, and is signed in under the current
   password.
4. With `newThreadsOnly`, the message started its thread. With `skipSpam`, the message is not likely spam.

At most 20 devices get a push per message, oldest sign-in first. The push leaves after the message is stored, on the
queue consumer's `waitUntil`, so receiving never waits on APNs. A push that fails is not sent again. A token APNs calls
dead is switched off as for payment pushes (section 2).

Likely spam is decided from what Cloudflare recorded when the message arrived. A message is likely spam when its DMARC
result is `fail`, or when neither its SPF nor its DKIM result is `pass`, or when Cloudflare's spam score
(`X-CF-SpamH-Score`) is 5 or more. The SPF and DKIM part applies only when Cloudflare's `Authentication-Results`
header is there. Cloudflare does not publish the scale of its spam score, so the threshold of 5 is a guess that leans
to silence. The rule leans that way on purpose: a missed push costs less than a phone that buzzes for junk.

### Push payloads

A new App Store review at or below the app's star limit ([ASO.md](ASO.md#review-alerts)) sends an alert with `event`
`aso_review` and no `paymentId`. It goes to every device with a live alert token that hasn't muted the site, whatever its
payment event settings. The title is the app name, the body is the stars, the country and up to 140 characters of the
review. Treat `event` values you don't know as a plain alert.

```json
{ "aps": { "alert": { "title": "Habitly", "body": "2 stars, US: Crashes on launch. Since the update..." },
           "sound": "default", "thread-id": "<siteId>" },
  "siteId": "<siteId>", "event": "aso_review", "country": "us" }
```

Questions from a plan's agent ([section 10](#10-questions)) send one alert per site and run, with `event` `questions`
and the number asked in that run as `count`. The title is the site name and that number, the body the first question.
`badge` is every open question across all sites. It goes to every device with a live alert token that hasn't muted the
site. A tap opens the Growth tab at that site:

```json
{ "aps": { "alert": { "title": "Habitly: 2 questions", "body": "Which channels should we post on next week? (and 1 more)" },
           "sound": "default", "badge": 3, "thread-id": "questions-<siteId>" },
  "siteId": "<siteId>", "event": "questions", "count": 2 }
```

Today ([section 12](#12-today)) sends one push at 08:00 in the reporting timezone when Reply or critical Fix cards
wait, with `event` `today`. `count` is the Reply cards plus the critical Fix cards that are not muted. A phone on a
deployment with `PHONE_PII=0` counts only the critical Fix cards, because it sees no Reply cards. No push goes out at
zero, or while the Today setting `push` is off. It goes to every phone with a live alert token, whatever its site
switches, because Today covers every site. A tap opens Today:

```json
{ "aps": { "alert": { "title": "3 things need you", "body": "2 to answer, 1 to fix" },
           "sound": "default", "thread-id": "today" },
  "event": "today", "day": "2026-11-21", "count": 3 }
```

A critical Fix card that starts (payments stopped arriving, a webhook refused, a write cap reached) sends one push at
once, within a tick of five minutes, with `event` `today_fix` and the card's `key`. It goes out as often as the alert
channels get the same alert: a refused webhook once a day per site and provider, a write cap once a day, stopped
payments on the first day and then once a week. A muted card and the Today setting `fix` off send nothing. The title
and body are the alert's own words, cut at 80 and 140 characters. It goes to the phones that have not muted the site
(every phone for the shared write cap). A tap opens Today:

```json
{ "aps": { "alert": { "title": "Stripe webhooks refused on ShipKit", "body": "Stripe: 1 delivery to ShipKit refused today for a bad signature. Check that the…" },
           "sound": "default", "thread-id": "today-fix" },
  "event": "today_fix", "key": "webhook_refused:SITE_ID:stripe", "siteId": "SITE_ID" }
```

Alert, one per payment, after the payment row is inserted for the first time (duplicates never push):

```json
{ "aps": { "alert": { "title": "ShipKit · $4.90", "body": "Lifetime · from Google" },
           "sound": "default", "thread-id": "<siteId>" },
  "siteId": "<siteId>", "paymentId": "<paymentId>", "event": "purchase" }
```

The title is the site name and the amount in the payment's own currency. The body is the product (or the provider when
there is no product) and the attributed source when known. Renewals start the body with `Renewal`, refunds with
`Refund`, trials with `Trial`. A payment that arrives more than a day after it happened ends the body with its date in the
site's timezone, `Lifetime · paid 29 Oct`. The App Store can deliver a notification days late. The dashboard counts
the payment on the day it was paid, not the day the push went out.

A received message, one alert per device that wants it:

```json
{ "aps": { "alert": { "title": "Ann Example", "subtitle": "Refund for order 1042", "body": "Hi, I was charged twice for..." },
           "sound": "default", "thread-id": "<threadId>", "badge": 3 },
  "event": "mail", "threadId": "<threadId>", "domainId": "<domainId>", "messageId": "<messageId>" }
```

The title is the sender's name, else the address, else `Unknown sender`. The subtitle is the subject, `(no subject)`
when empty. The body is the start of the text, at most 140 characters. The sender wrote all three, so the Worker removes
control characters, bidirectional overrides and zero-width characters, folds whitespace to single spaces and cuts the
title at 80 characters and the subtitle at 120, ending a cut with `…`. Treat them as untrusted all the same. `badge` is
the number of unarchived threads with unread mail on the domains this device has on. Open the thread on a tap with
`GET /api/mobile/mail/threads/<threadId>` (section 11). There is no `siteId`.

Scheduled push, daily and weekly. It has no `siteId`, so a tap opens Home:

```json
{ "aps": { "alert": { "title": "Since yesterday",
                      "body": "$597 revenue, 1 trial, 7 new customers\nSearch Ads $19 on Nov 3. Over 30 days, $39 per paid and ROAS 140%\nMeta ads $42 on Nov 3. Over 7 days, $49 per customer and ROAS 139%" },
           "sound": "default", "thread-id": "scheduled-daily" },
  "scheduled": "daily", "day": "2026-11-04" }
```

The first line is revenue per currency (largest first, no cents from 10 up), trials and new customers of the last 24
hours. The Search Ads line shows when `sinceYesterday.asa` is set: the latest day's spend, then cost per paid and ROAS
(`asa.roas`, as a percent) over the 30 days, in the currency with the most spend. The Meta line shows when
`sinceYesterday.meta` is set: the latest day's spend, then cost per customer and ROAS over the 7 days. The run reads
the Meta numbers once for all phones, in 2 subrequests. When the cron's 50 subrequests cannot cover them, the push goes
out without the Meta line. The weekly push has
`"scheduled": "weekly"`, the report's `title` ("Weekly report: Oct 26 to Nov 1") and `totals.lines` without the
"All sites" line as the body.

Widget push, at most one per device per 5 minutes (Apple budgets these anyway), sent with every alert-worthy payment
whether or not the alert is switched off: header `apns-push-type: widgets`, payload
`{ "aps": { "content-changed": true } }`.

### Live Activity payloads

Header `apns-push-type: liveactivity`, `apns-priority: 10`, topic `<bundle id>.push-type.liveactivity`. Every payload
carries the same `content-state`, today's numbers across every site:

```json
{ "revenue": 492.49, "currency": "USD", "purchases": 2,
  "last": { "site": "Habit", "amount": 9.99, "currency": "EUR", "product": "Pro" },
  "ts": 1793599200000 }
```

- `revenue`: today's revenue in major units of `currency`, the first site's currency. Today is the calendar day in the
  reporting timezone (section 3). It counts like `today` in the summary (section 4): recorded payments minus refunds,
  sandbox never. A site amount in another currency converts at the newest ECB rate stored in the last 14 days, and
  stays out without one.
- `purchases`: payments today, refunds not counted.
- `last`: the newest payment today, in its own currency, major units. `product` is `""` when there is none. `null`
  before the first payment of the day.
- `ts`: when the numbers were read, ms since 1970. Declare it as a number in Swift, not `Date`: ActivityKit decodes
  `Date` from a push as seconds since 2001.

Update, after each new payment or refund (not trials), at most one per device per minute. A payment inside that minute
shows with the next update. The claim writes 1 row per device:

```json
{ "aps": { "timestamp": 1793599200, "event": "update", "content-state": { "...": "as above" },
           "stale-date": 1793635200 } }
```

Start, at 08:00 to the push-to-start token. The alert is a silent banner, "No purchases yet" before the first one:

```json
{ "aps": { "timestamp": 1793664000, "event": "start", "content-state": { "...": "as above" },
           "stale-date": 1793721600, "attributes-type": "RevenueActivityAttributes",
           "attributes": { "day": "2026-11-03" },
           "alert": { "title": "Today", "body": "$25 from 1 purchase so far" } } }
```

End, to the old update token just before a start: `{ "aps": { "timestamp", "event": "end", "content-state",
"dismissal-date" } }` with `dismissal-date` now.

`timestamp`, `stale-date` and `dismissal-date` are seconds since 1970. `stale-date` is the next local midnight in the
reporting timezone. `attributes` is the `RevenueActivityAttributes` struct: `day` is today, YYYY-MM-DD.

## 4. Widget and home summary

`GET /api/mobile/summary?tz=America/New_York&currency=USD` →

`tz` is optional. Without it the days follow the reporting timezone, like Home.

```json
{
  "generatedAt": 0,
  "today": {
    "visitors": 0, "visitorsYesterdaySamePoint": 0, "purchases": 0,
    "revenue": [{ "currency": "USD", "amount": 0 }],
    "revenueYesterdaySamePoint": [{ "currency": "USD", "amount": 0 }]
  },
  "sites": [{
    "id": "", "name": "", "kind": "web" | "app", "currency": "USD",
    "today": { "visitors": 0, "purchases": 0, "revenue": 0 },
    "last7": [{ "date": "2026-10-23", "visitors": 0, "revenue": 0 }],
    "last30": [{ "date": "2026-09-30", "visitors": 0, "revenue": 0 }],
    "periods": {
      "7d": { "visitors": 0, "customers": 0, "purchases": 0, "revenue": 0 },
      "30d": { "visitors": 0, "customers": 0, "purchases": 0, "revenue": 0 }
    },
    "latestPayment": { "ts": 0, "amount": 0, "currency": "USD", "product": "", "source": "" } ,
    "appStore": { "date": "2026-10-28", "downloads": 0, "proceeds": [{ "currency": "USD", "amount": 0 }] }
  }],
  "periods": {
    "7d": {
      "from": "2026-10-23", "to": "2026-10-29", "visitors": 0, "customers": 0, "purchases": 0,
      "revenue": [{ "currency": "USD", "amount": 0 }], "totalCurrency": "USD", "revenueTotal": 0, "notConverted": [],
      "days": [{ "date": "2026-10-23", "visitors": 0, "revenueTotal": 0 }],
      "previous": { "from": "2026-10-16", "to": "2026-10-22", "visitors": 0, "customers": 0, "revenueTotal": 0 }
    },
    "30d": { "...": "same shape, 30 days" }
  },
  "sinceYesterday": { "...": "the same block as GET /api/home, section 7" },
  "latest": [{ "siteId": "", "siteName": "", "ts": 0, "amount": 0, "currency": "", "product": "", "provider": "", "source": "" }]
}
```

`sinceYesterday` is the phone Home's block (section 7), for the Since yesterday widget, so the widget, Home and the
08:00 push show the same numbers. Null when there are no sites; absent from a server that predates it. Its `meta` is
always null here, because the widget has no Meta line.

`today.revenue` groups site revenue (already converted to each site's currency, as on the home page) by currency,
largest first. `sites[].today.revenue` and `last7[].revenue` are in the site currency. `latestPayment`, `appStore` and
`source` may be `null`. `product` is an empty string, not `null`, when a payment has none. `appStore` is the latest App Store Connect sales day for the site (section 5). `latest` holds
the 10 newest non-sandbox payments across sites. One call runs at most 13 D1 statements.

Revenue and purchases follow the revenue definition in [GUIDE.md](GUIDE.md) ("How revenue is counted", `src/worker/revenue.ts`).
On a day imported from Apple's sales report, App Store sales come from the report (gross customer price,
in the site currency at that day's ECB rate, units sold as purchases) and the App Store payment rows of that day stay
out. Today is never imported, so `today` counts recorded purchases. `revenueYesterdaySamePoint` compares part of a day
and counts recorded payments only. `customers` stays payment based. `latestPayment` and `latest` list payment rows.

`periods` covers the last 7 and 30 local days, today included, the same ranges as the dashboard's
`7d` and `30d`. Visitors are distinct visitor ids per site, added across sites. Customers are new customers (payments
that are not renewals), counted like the home page. Purchases count payments. `revenue` groups by currency like
`today.revenue`. `revenueTotal` adds every site into one figure in `totalCurrency`: the `currency` query parameter
(`?currency=USD`), else the first site's currency. Each day's amount converts at the ECB rate of that day (the
newest stored rate on or before it, missing days filled by one call to the rate API's time series), rounded to cents. An amount in a currency with no rate at all stays out of
`revenueTotal` and is listed in `notConverted`. `days` is the combined daily series for a chart. `sites[].periods` has the
same windows per site, revenue in the site currency. `last7` is the tail of `last30`.

`periods.7d.previous` and `periods.30d.previous` hold the window before, for a widget's change against it. It has as
many days, and its last day counts up to the time it is now, so a window that ends today at 15:00 compares with one
that ended 7 (or 30) days ago at 15:00. `from` and `to` are its first and last day. `visitors` and `customers` count
the same way as the window's own. `revenueTotal` is in `totalCurrency` at each day's rate, Apple's report on the whole
days it covers, and payment rows only on the last day, since the report has no hours. An amount with no rate stays
out. The summary reads 60 days for this instead of 30, with the same number of statements. Absent from a server that
predates it.

## 5. App Store Connect sales import

The Worker pulls Apple's daily Sales and Trends summary report itself, so every app shows downloads and proceeds,
including apps without FounderDataKit.

- Worker secrets: `ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_VENDOR_NUMBER`. Use a key with the Sales and Reports role only.
  Without them the import is off and the App Store panels say so.
- `GET https://api.appstoreconnect.apple.com/v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=…&filter[reportDate]=YYYY-MM-DD`
  returns a gzip TSV (unpack with `DecompressionStream('gzip')`). 404 with "no sales" means a real zero day.
- A cron at `30 10 * * *` UTC re-imports the last 3 days (rows replace that day's rows, so late corrections land).
- `POST /api/appstore/backfill` `{ from, to }` (login required) imports up to 30 days per call, oldest first, and returns
  `{ imported: [dates], next: "YYYY-MM-DD" | null }`. Free-plan Workers allow 50 subrequests per request, so a script
  (`scripts/asc-backfill.sh`) loops it. Apple keeps daily reports for 365 days.
- Rows map to a site through the app's Apple id: the Worker resolves `sites.app_bundle_id` to the App Store app id and
  SKU once (`GET /v1/apps?filter[bundleId]=`) and stores them on the site (`asc_app_id`, `asc_sku`). App rows match on
  `Apple Identifier`, in-app purchase rows on `Parent Identifier` = the app SKU. Rows that match no site are kept with
  `site_id` NULL.
- Product type identifiers: downloads are `1`, `1F`, `1T`, `F1`; re-downloads `3`, `3F`, `3T`, `F3`; updates (`7`,
  `7F`, `7T`, `F7`) are not counted; in-app purchases and subscriptions are `IA1`, `IA9`, `IAY`, `IAC`, `FI1` and the
  other `IA*` codes. Proceeds stay per currency of proceeds; units with negative values are refunds.
- `GET /api/sites/:id/appstore?from=&to=` → `{ configured, days: [{ date, downloads, redownloads, iapUnits, proceeds: [{currency, amount}] }],
  totals: {...}, products: [{ sku, title, units, proceeds: [...] }], coverage: { attributedPurchases, ascIapUnits } }`.
  Coverage is the share of App Store sales that FounderData also saw with attribution (SDK or webhook).
- `GET /api/appstore?from=&to=` → the same totals per site.
- Both reads also take `period` (`today`, `yesterday`, `24h`, `48h`, `7d`, `30d`, `90d`, `12m`, `thisquarter`,
  `lastquarter`, `all`) in place of `from` and `to`; the default is the last 30 days ending today (UTC). `thisquarter`
  runs from the first day of the current calendar quarter to today, `lastquarter` is the whole quarter before (on
  October 30: July 1 to September 30). Quarters follow UTC days here; the other dashboard endpoints use the site's
  timezone and `/api/home` the reporting timezone. Amounts are decimals in major units.
- `proceedsConverted` sits next to every `proceeds` list: in `totals`, in each `days[]` entry, in
  each `products[]` entry, in `GET /api/appstore` under `sites[].totals` and `unmatched`, and in the home page's
  `sites[].appStore`. Its shape is `{ currency, amount, notConverted: [{ currency, amount }] }`. `currency` is the
  site's currency (`sites.currency`; USD for `unmatched`). `amount` adds every currency of proceeds, each day's amount
  at that day's ECB reference rate (`src/worker/fx.ts`, `rateLookup`), rounded like Apple's amounts. A currency the
  ECB does not publish stays out of `amount` and is listed in `notConverted`, so a reader can show "plus X not
  converted". The `proceeds` lists are unchanged. Like them, `proceedsConverted` is Apple's net proceeds, never part
  of revenue, and not Apple's payout, which uses Apple's own monthly rates.
- What the Worker adds to the shapes above. `days` holds every day of the range, with `imported: false` for a day not
  imported yet (a real zero day has `imported: true` and zeros). `totals` also has `refundedUnits`. `products[]` has
  `type` (`app` or `iap`). `coverage` also has `share` (null when Apple reports no in-app purchases). The site read adds
  `configured`, `mapped` (the app is matched in App Store Connect), `from`, `to` and `lastImportedDay`. `GET /api/appstore`
  answers `{ configured, from, to, lastImportedDay, sites: [{ id, name, bundleId, mapped, totals }], unmatched }`.
- A backfill call stops at 30 days, at the Worker's subrequest budget or at the first error, and `next` is the first day
  not imported. An error answers 502 `{ imported, next, error }`. Today and later are never requested.
- `latestAppStoreDay(db, siteIds)` in the Pro repository's `worker/ascsales.ts` returns a `Map` from site id to
  `{ date, downloads, proceeds } | null`, the latest imported day with rows. A site without a matched app is null.

Proceeds stay apart from revenue. Revenue counts the same report at gross customer prices, on the days it covers, in
place of the App Store payment rows of those days ([GUIDE.md](GUIDE.md), "How revenue is counted"). Conversion and customers stay
payment based. The dashboard shows an App Store tab per site with an app, and on the home page an app without
FounderDataKit data shows its App Store downloads next to its revenue.

What the revenue reads add:

- `GET /api/home`: `sites[].current.appStoreRevenue` and `previous.appStoreRevenue` (and the same in `totals`) hold
  the App Store part of `revenue`, by currency, in minor units. `payments` adds the units Apple reports as sold on
  imported days. `sources[]` can end with `{ label: "App Store, no source", channel: "App Store", appStore: true }`:
  App Store revenue minus the App Store payments linked to a visit, never below 0. It can also hold
  `{ label: "No source", channel: "No linked visit", noVisit: true }`: payments that are not App Store sales and have
  no linked visit. The revenue of all `sources[]` adds up to `totals.current.revenue`. `appStoreNoSource` maps a site
  id to that site's share of the "App Store, no source" row, in minor units of the site currency. `totals.mrrSeries` is MRR at
  12 even steps from the start of the period to its end (or now), oldest first, each by currency in minor units; null
  without subscriptions.
- `GET /api/sites/:id/breakdown` for `channel`, `source`, `referrer`, `campaign`, `keyword`, `utm_source`,
  `utm_medium`, `utm_content` and `ref`, without filters: the same rows, `{ label: "No source", noVisit: true }` and
  `{ label: "App Store, no source", appStore: true }`. Neither is a value to filter by. A `campaign` row whose label
  is the name or id of a campaign in the site's Meta ad account has `meta: true`.
- `GET /api/sites/:id/revenue`: one `app_store` line in the site currency carries the report; RevenueCat purchases
  made in the App Store count under `app_store`. App Store payments in another currency keep their own line.

## 6. ASO

The ASO tab's data for one app, for an ASO screen on the phone. A phone token reads it like any site route. Changes
need the dashboard login, so a phone gets 403 on the write routes in [ASO.md](ASO.md#api). The data comes from the
collector, a script outside Cloudflare ([ASO.md](ASO.md)), and from Apple Ads for popularity.

`GET /api/sites/:id/aso?days=30` →

```json
{
  "appId": "123456789",
  "bundleId": "com.example.app",
  "settings": { "countries": ["us", "de"], "competitors": ["987654321"], "saved": true, "reviewAlert": { "on": true, "stars": 3 } },
  "limits": { "keywords": 200, "countries": 10, "pairs": 1000, "competitors": 5, "staleHours": 36, "historyDays": 90 },
  "keywords": [{ "keyword": "habit tracker", "addedAt": 1793600000000 }],
  "collector": { "lastAt": 1793700000000, "stale": false, "name": "aso-collect/1" },
  "latest": {
    "us": {
      "day": "2026-11-03",
      "collectedAt": 1793700000000,
      "top": { "habit tracker": [["987654321", "Name", "Subtitle", 98279, 4.5, "2015-06-02"]] },
      "sources": { "search": { "ok": 2, "failed": 0, "skipped": 0, "status": 200, "retryAfter": null, "paused": false } }
    }
  },
  "days": [["us", "2026-11-03", 1793700000000, { "habit tracker": [14, 249, { "987654321": 3 }] }, [["123456789", "Name", 1234, 4.7, "2.4.0"]]]],
  "popularity": {
    "configured": true, "week": "2026-10-25", "checkedAt": 1793600000000, "error": null,
    "byCountry": { "us": { "habit tracker": [44, 3, "2026-10-25"] } }
  },
  "reviewCounts": [["us", 5, 120]]
}
```

- `appId` is the App Store id: the one the sales import found, the one entered in Settings, else the one the
  collector looked up. `null` until one of them has it.
- `collector.lastAt` is the newest snapshot's collection time in ms, `null` before the first one. While it is `null`,
  show the setup steps instead of numbers. It counts snapshots of any source. `stale` is true 36 hours after the last
  snapshot from the collector itself: DataForSEO ranks and imports do not count, and an app that never had a collector is
  never stale.
- `latest` has one entry per country with a snapshot: its UTC `day`, the top 10 per keyword as
  `[id, name, subtitle, rating count, average rating, release day]`, and per source the counts of the run, as in
  [ASO.md](ASO.md#the-snapshot). `sources` may be `null`.
- `days` holds the last `days` days, 7 to 90, 90 by default, ordered by country and then day. A phone token's answer
  is parsed once more on the server to null secrets, so ask for the days the screen shows: 50 keywords in 5 countries
  over 90 days is about 900 KB, over 30 days about 300 KB. An app with more than 444 keyword and country pairs gets
  fewer days than asked: `40,000 / pairs`, at least 7. `limits.historyDays` says how many. Each entry is
  `[country, day, collectedAt, ranks, ratings]`. `ranks` maps a keyword to `[rank, results, competitor ranks]`, with
  `rank` 1-based or `null` when the app wasn't in the results. A keyword missing from a day wasn't checked that day.
  `ratings` rows are `[app id, name, rating count, average rating, version]`, or `null`.
- `popularity.byCountry` maps country and keyword to `[1 to 100, 1 to 5, week]`. Both scores `null`: Apple publishes
  none for the term. A keyword missing: not checked yet. `configured` is false without the `ASA_*` secrets. `error`
  is the last run's error, such as the role text when Apple answers 403.
- `reviewCounts` rows are `[country, stars, reviews]`.
- `hosted` is the state of ranks without your Mac ([ASO.md](ASO.md#ranks-without-your-mac)): `configured`, `enabled`,
  `pairs`, `checked_today`, `waiting`, the month's `spent_usd`, `cap_usd`, the estimates, `collect_per_day` (what the
  deployment collects in a day, shared with Google ranks), `refused` (per country, the pairs DataForSEO refused today
  with its message, tried again tomorrow) and `error`. `settings.hostedRanks`
  is the switch, and `latest.<country>.rankSource` maps a keyword to `dataforseo` or `import` for the latest day (a
  keyword without an entry came from the collector). All three are additive, and an older app ignores them.

Rank changes, best rank and difficulty are not in the answer. Work them out on the phone the way
`dashboard/lib/aso.ts` in the Pro repository does: `movement()` for 1 and 7 days and the best rank, `difficulty()` for the score
([ASO.md](ASO.md#difficulty)).

`GET /api/sites/:id/aso/reviews?country=us&stars=1&offset=0&limit=50` → an array, newest first:
`{ country, id, at, rating, title, body, author, version }`, with `at` in ms. `X-Next-Offset` is set when there are
more. `limit` is at most 200.

`author` is the reviewer's App Store nickname, which Apple shows publicly. `PHONE_PII=0` doesn't hide it, since that
setting covers the names, emails and user ids of payments and visitors.

## 7. Home

The phone's Home reads `GET /api/home?period=`, the same JSON as the web home page. Leave out `tz`: the server then
counts days in the deployment's reporting timezone ([API.md](API.md), "Reporting timezone"), the same days as web
Home, `/api/v1/portfolio` and `/api/v1/weekly`, so the phone shows the same numbers. Send `tz` only when the user
picks the phone's own timezone on purpose; the answer then counts in that one. Older apps that always send `tz` keep
working. Besides the totals, sites, sources, payments and `attention`, it uses these fields:

- `tz`: the timezone the answer counts days in. `tzSource`: `request` (the `tz` you sent), `setting` (picked in
  Settings), `sites` (every site uses it) or `default` (UTC). `reportingTz`: the deployment's reporting timezone,
  whatever you sent. Show "Days in <tz>" from `tz`.
- `sites[].basis` and `totals.basis`: what the revenue adds up. `net_of_refunds` (payments, minus refunds, before
  provider fees), `app_store_gross` (App Store sales at the customer price, before Apple's cut) or `mixed`; null with no
  revenue. `current.appStoreRevenue` holds the App Store part, so "of which $4,225 App Store" is
  `totals.current.appStoreRevenue`. Show it as a chip next to every revenue number, as the web does: `net`, `gross`
  or `mixed`, from `totals.basis` on the Home hero and from `basis` on a site's screen. The site overview
  (`GET /api/sites/:id/overview`) has the same `basis` and `current.appStoreRevenue` for its own period and timezone.
  A footer that says what revenue counts names App Store revenue as gross whenever a basis is `app_store_gross` or
  `mixed`.
- Weekly summary: `GET /api/v1/weekly` takes the phone's bearer token too. `title` plus a blank line plus `text` is
  what web Home's **Copy weekly summary** copies: the week, the timezone, what revenue adds up and every site's lines,
  ready to paste into Slack ([API.md](API.md), "Weekly report").
- `totals.mrrMovement`: what moved MRR over the period, per currency in minor units, or null without subscriptions.
  `{ new, expansion, churned, net }`, each `{ "USD": 200000 }`. `new` is subscriptions first paid in the period,
  `expansion` price rises, `churned` subscriptions that ended plus price cuts. `new + expansion - churned = net`, and
  `net` is `totals.mrr - totals.mrrStart`, so the three add up to the change under the MRR number. Each
  `sites[].subscriptions` has the site's own `movement` in the same shape, numbers instead of currency maps.
- Percent changes round half away from zero to a whole percent, as on the web: -10.5% shows as -11%.
- `totals.current.trials` and `totals.previous.trials` (and the same in each `sites[].current` and `previous`): trials
  that started in the period, sandbox left out. It is the count `sinceYesterday.trials` makes, over the period, so
  `period=24h` gives the same two numbers as `sinceYesterday`.
- `series[]`: one point per bucket (hour, day, week or month, as `range.granularity` says), `{ bucket, visitors,
  revenue, customers, trials }`. `revenue` is by currency in minor units, `customers` counts new customers. Revenue,
  customers and trials add up to `totals.current`. Visitors are distinct per bucket, so they don't add up to the total.
- `previousSeries[]`: the comparison period in the same shape and granularity, oldest first, for a chart's comparison
  line. Point i of both lists is the same position in its period. The comparison period can be shorter (this quarter
  so far, today against yesterday up to now), so `previousSeries` can hold fewer points. It adds up to
  `totals.previous` the way `series` adds up to `totals.current`.
- `previousRange`: `{ from, to }` of the comparison period, in ms. `compare`: `previous` or `sametime`.
- Buckets are local days and hours in `tz`, also when daylight saving starts or ends inside the period, so the 7 days
  after the clocks change still end with today.

Two query parameters trim the answer for the phone's Pulse grid, and a third adds Meta ads to "Since yesterday":

- `compare=sametime` with `period=today` compares today so far with yesterday from midnight up to now minus 24 hours.
  Without it, today at 15:00 compares with yesterday from 09:00 to midnight, the same length right before. Any other
  period ignores it and answers `compare: "previous"`.
- `parts=pulse` answers only `range`, `previousRange`, `compare`, `tz`, `tzSource`, `reportingTz`, `period`,
  `parts: "pulse"`, `totals`, `series` and `previousSeries`. The totals are the full answer's, to the cent, from the same
  statements. It skips the sites, sources, payments, `sinceYesterday`, `changes` and `attention`, and their reads, so
  it runs 12 D1 statements on a deployment with subscriptions. The app loads `period=today&compare=sametime&parts=pulse`
  and `period=30d&parts=pulse` next to the full `period=7d`.
- `yesterday=meta` fills `sinceYesterday.meta`. Without it, `meta` is null and costs no read. The app sends it with
  the full `period=7d`, the answer its Paid strip reads. The web dashboard does not show the block, so it leaves it out.

- `sites[].trend` `{ status, revenueChange }`. `status` is `growing`, `flat`, `declining`, `quiet` or `no_payments`
  ([GUIDE.md](GUIDE.md), "What it tracks"). `revenueChange` is the period's revenue minus the period before, in minor
  units of the site currency. The ranked list sorts on it, biggest gain first.
- `sites[].weekly`: the last 8 full weeks, oldest first, `{ week, visitors, revenue }`. `week` is the Monday,
  `revenue` is in minor units of the site currency. The row's sparkline draws revenue, or visitors when no week had
  revenue.
- `sites[].falling`: `{ metric, weeks, since, from, to }` when weekly revenue (or visitors) fell 3 weeks in a row or
  more, else null.
- `sites[].timezone`: the site's own timezone. Its dashboard counts days in it, so its totals can differ from Home's
  when it is not `tz`. Label that on the site's screen, as the web does ("Days in Europe/Berlin").
- `sites[].weeksDeclining`: how many full weeks in a row, up to the last one, ended below the week before. It counts
  revenue when any of the 8 weeks had some, else visitors. The web shows "down 3 weeks" next to
  the status chip from 2 up.
- `sites[].goal`: the site's primary goal (Settings, Primary goal; [API.md](API.md), "Primary goal") in the period
  and the one before, or null. `{ name, label, count, previous, change_pct }`. `count` and `previous` are visitors who
  sent the goal. `label` is what to show ("Signups"). `change_pct` is a whole percent, null when `previous` is 0. The
  keys are snake case, as in the portfolio. A site without revenue shows it where revenue would be.
- `sites[].type`: `website`, `app`, `extension` or `newsletter`. `sites[].product`: an extension's or a newsletter's
  numbers, or null for the other types. `{ type, headline, metrics: [{ key, label, value, previous, change_pct }] }`,
  in snake case as in the portfolio ([API.md](API.md#product-types)). Show `headline`'s metric where revenue would be
  when the site has none, and the `metrics` in order on its screen instead of bounce rate and session time. Unknown
  `type` values may come later: treat them as `website`.
- `changes`: the notes of the last 7 days, whatever `period` is, or null on a server with no sites.
  `{ from, to, count, better, worse, inconclusive, due, worst }`. `count` is the notes made in the 7 days. `better`,
  `worse` and `inconclusive` are verdicts that came in during them (notes made 7 to 14 days ago). `due` is notes whose
  window closed and nobody reviewed. `worst` is null or `{ site_id, site_name, note_id, time, text, kind, actor,
  target, verdict, verdict_metric, change_pct, reason }`. The web links it to the site's changes list.
- `attention[].kind` can also be `falling`, with `revenue: true` when it is about revenue.
- `attention[].kind` can also be `search_drop`, when the whole site's Google impressions or clicks fell by half or
  more ([SEO.md](SEO.md#search-drop)). Its `link` is `seo`, the site's SEO tab, and `text` is the server's sentence.
  Show it as it comes.
- `sinceYesterday`: the last 24 hours against the 24 hours before, whatever `period` is. Null on a server that has no
  sites.

```json
"sinceYesterday": {
  "from": 1793684469133, "to": 1793770869133,
  "revenue": { "USD": 78691 }, "revenuePrevious": { "USD": 39991 },
  "customers": 8, "customersPrevious": 5,
  "trials": 1, "trialsPrevious": 4,
  "asa": {
    "day": "2026-11-03", "spend": { "USD": 1893 },
    "from": "2026-10-05", "to": "2026-11-03", "periodSpend": { "USD": 112777 },
    "paid": 29, "costPerPaid": { "USD": 3889 }, "revenue": { "USD": 168420 }, "roas": { "USD": 1.4934 }
  },
  "meta": {
    "sites": ["SITE_ID"], "day": "2026-11-03", "spend": { "USD": 4200 },
    "from": "2026-10-28", "to": "2026-11-03", "periodSpend": { "USD": 29400 },
    "customers": 6, "cpa": { "USD": 4900 }, "revenue": { "USD": 40866 }, "roas": { "USD": 1.39 }
  }
}
```

- Money is in minor units, by currency, each site's payments converted to its currency as on the home page.
  `revenue` counts payment rows. A rolling 24 hours never holds a whole day of Apple's sales report, so it is the same
  number as the "Last 24 hours" period.
- `customers` counts first payments that are not renewals, one per customer and site. `trials` counts subscriptions
  whose trial started in the window, sandbox left out, as the Subscriptions tab does.
- `asa` is null until Apple's numbers hold spend for a site's app in the last 30 days. `day` is the latest UTC day
  with spend, yesterday at the latest, since Apple reports a few hours late. `spend` is that day's spend in the site
  currency at the day's ECB rate.
- `periodSpend`, `paid`, `costPerPaid`, `revenue` and `roas` cover the 30 days from `from` to `to`: the 30 days up
  to yesterday in the site's timezone. They are the totals of `GET /api/sites/:id/asa?period=30d`, which the site's
  overview, its Apple Search Ads section and `GET /api/v1/asa?period=30d` show too. A period that reaches into today reads Apple's days
  one day back, since Apple has no spend for today, so "30 days" means the same days everywhere.
  `paid` counts first purchases of installs from Apple Search Ads that started in those days, to date. `costPerPaid`
  is `periodSpend` over `paid` per currency, and leaves out a currency with no paid install. `revenue` is the gross
  revenue to date from those installs, renewals and refunds included, sandbox left out. `roas` is `revenue` over
  `periodSpend` as a ratio. Show it as a percent (1.4934 is "149%"), as the web and the daily push do.
- `meta` is null without `yesterday=meta`, and null until a site with a Meta ad account (Settings, Meta ads) has
  spend in the 7 days up to yesterday. Older servers leave it out. `sites` lists the sites with that spend, oldest
  site first. `day` is the latest ad account day with spend across those sites, yesterday at the latest. `spend` is
  that day's spend in the site currency, at the day's ECB rate when the account bills in another currency. A site
  with no spend on `day` adds nothing to it.
- `periodSpend`, `customers`, `cpa`, `revenue` and `roas` cover 7 days up to yesterday in each site's timezone. They
  are the totals of `GET /api/sites/:id/meta` for the same days. `from` and `to` are the days of the first site in
  `sites`, so they always span 7 days. `customers` counts first purchases credited to visits from a Meta ad that
  started in those days, to date. `cpa` is `periodSpend` over `customers` per currency, and leaves out a currency
  with no customer. `revenue` is the revenue to date credited to those visits, renewals and refunds included. `roas`
  is `revenue` over `periodSpend` as a ratio.
- The block costs two or three reads in one batch, plus three per app with Apple spend. `meta` adds two statements
  to that batch for all sites together, and one rate read when an ad account bills in another currency. They read
  the 7 days' Meta spend rows and the payments since the 7 days began, not the sessions. The block writes nothing.
  The portfolio route and the weekly report leave it out.

### Growth row

Web Home draws its Growth row from `GET /api/home/growth?period=`, with the same `period` and `tz` as `/api/home`. It
is a request of its own, so Home's numbers never wait for it. It writes nothing. It reads one stored Search Console
row per site, the spend rows of both periods, and one AI count row per site. The Worker counts AI checks per site and
day once an hour, at minute 55, so a Home load never reads the checks themselves. It takes 2 D1 round trips, or 3 when
some spend came in another currency than the site's (the exchange rates).

```json
{ "period": "30d", "tz": "UTC", "from": "...", "to": "...", "previous_from": "...", "previous_to": "...",
  "sites": [{ "id": "SITE_ID",
    "spend": { "spend": 10000, "spend_previous": 5000, "by_channel": { "google_ads": 10000 }, "apple_share": 0.85 },
    "search": { "from": "2026-10-16", "to": "2026-11-14", "days": 30, "clicks": 300, "impressions": 3000, "position": 5,
                "previous": { "from": "2026-09-16", "to": "2026-10-15", "clicks": 150, "impressions": 3000, "position": 8 }, "stale": false },
    "ai": { "from": "2026-10-19", "to": "2026-11-17", "days": 30, "checks": 10, "mentioned": 4, "cited": 2,
            "mention_rate": 0.4, "citation_rate": 0.2, "previous": { "checks": 10, "mentioned": 2, "cited": 0, "mention_rate": 0.2, "citation_rate": 0 },
            "counted_at": "2026-11-17T08:50:00.000Z" } }],
  "ai_counted_at": "2026-11-17T08:50:00.000Z" }
```

- `spend` is every ad channel's spend in minor units of the site currency, the `ad_spend` of `/api/v1/portfolio`, or
  `null` with no spend in either period. `apple_share` is the share of App Store revenue the site keeps. MER is
  `revenue - appStoreRevenue x (1 - apple_share)` from `/api/home` over `spend`, and blended CAC is `spend` over
  `current.customers`, the same numbers as the portfolio's `mer` and `cac`.
- `search` and `ai` are the portfolio's fields of the same name ([API.md](API.md), "Portfolio"), `null` when the site
  has no Search Console data or no AI checks.
- `spend_truncated` is `true` when more spend in other currencies came in than one request converts.
- `ai_counted_at` is when the hourly AI count last ran, or `null` before the first one. Until then every `ai` is `null`.

## 8. Charts over time

The site screens draw these from routes the dashboard already uses. Each field is new, so decode it as optional: a
server that predates it leaves it out. None of them writes to D1 or adds a statement, except `versions?series=1`,
which adds one.

- Trial to paid over time: `GET /api/sites/:id/subscriptions` has `series[].trialsConverted` next to
  `series[].trials` ([GUIDE.md](GUIDE.md), "Subscriptions"). Both count in the bucket the trial started in, so a trial
  that paid 5 days later still counts on its start day. `trialsConverted` follows the rule and `trial_days` of
  `current.trialsConverted`, and the series adds up to it.
- Paywall conversion over time: `GET /api/sites/:id/app/paywall` has `series[]`, `{ bucket, views, purchases, trials }`
  per bucket of the range ([APP-API.md](APP-API.md), section 7). `views` counts sessions by the time of their first
  `paywall_view`; `purchases` and `trials` are those sessions that bought or started a trial. The series adds up to
  `paywallViews`, `purchases` and `trials`.
- Version adoption: `GET /api/sites/:id/app/versions?series=1` adds `series[]`, `{ bucket, version, sessions }`, for
  the 5 versions with the most app sessions in the range (a tie goes to the newer one), every bucket for each.
  `seriesTotals[]`, `{ bucket, sessions }`, counts every version's sessions per bucket, so a share is `sessions` over
  the total and an "other" band is the total minus the five. Without `series=1` the answer is as before.

## 9. Live visitors

`GET /api/live` says who is on your sites right now. The dashboard's globe draws it, and the phone may use it too. It
takes the dashboard login (owner or viewer) or a phone token, like `/api/home`, and covers every site: there are no
per-site logins. Logged out it answers 401. Unlike the rest of this document, amounts here are integers in minor units
of their currency, as on `/api/home` (`4900` with `USD` is $49.00).

```json
{
  "now": 1794667342793,
  "windowMinutes": 5,
  "online": 12,
  "sites": [{ "id": "SITE_ID", "name": "Acme", "domain": "acme.example", "online": 7 }],
  "visitors": [{
    "id": "a1b2c3d4", "siteId": "SITE_ID", "platform": "web",
    "country": "DE", "region": "Berlin", "city": "Berlin", "lat": 52.5, "lon": 13.4,
    "page": "/pricing", "source": "Google", "device": "desktop", "customer": false,
    "startedAt": 1794666982793, "lastSeenAt": 1794667330000
  }],
  "events": [{
    "ts": 1794667100000, "siteId": "SITE_ID", "kind": "payment", "label": "Pro yearly",
    "amount": 4900, "currency": "USD", "country": "US", "city": "Austin", "lat": 30.3, "lon": -97.7
  }],
  "places": [{ "country": "US", "city": "Austin", "lat": 30.3, "lon": -97.7, "visitors": 41 }],
  "placesMinutes": 1440,
  "recent": [{
    "id": "e5f6a7b8", "siteId": "SITE_ID", "platform": "web",
    "country": "US", "region": "Texas", "city": "Austin", "lat": 30.3, "lon": -97.7,
    "page": "/blog/launch", "source": "Twitter", "device": "mobile", "customer": false,
    "startedAt": 1794655000000, "lastSeenAt": 1794655420000
  }],
  "recentCount": 412,
  "recentSites": [{ "id": "SITE_ID", "name": "Acme", "domain": "acme.example", "visitors": 412 }],
  "recentRevenue": [{ "currency": "USD", "amount": 34300, "payments": 7 }],
  "recentEvents": [{
    "ts": 1794630000000, "siteId": "SITE_ID", "kind": "payment", "label": "Pro yearly",
    "amount": 4900, "currency": "USD", "country": "US", "city": "Austin", "lat": 30.3, "lon": -97.7
  }]
}
```

- `online` counts the visitors seen in the last `windowMinutes` (5) on all sites, the same rule as the home page's
  online number: a visit seen more than 5 minutes ago is gone, one seen 4 minutes 59 seconds ago is online. Only
  visits started in the last 6 hours count. Counts are exact up to 5,000 visitors online.
- `sites` lists the sites with at least one visitor online, most first.
- `visitors` has one entry per visitor online, newest activity first, at most 150. App sessions count, with
  `platform: "app"`. `id` is 8 hex characters, an HMAC of the visit under a key derived from `SESSION_SECRET`. It stays
  the same for the whole visit and is never the stored visitor or session id. `page` is the current page, or the screen
  for an app. `source` is the label the dashboard shows. `device` is `desktop`, `mobile`, `tablet` or `null`.
  `customer` is true when the visitor has a real payment on that site (refunds and sandbox purchases don't count).
- `events` has the last 60 minutes, newest first, at most 30. `kind` is `payment` (a payment, not a refund or sandbox
  purchase; renewals included), `trial` (a trial that started, sandbox left out), `signup` or `goal`. A goal counts as
  `signup` when its name, lowercased with spaces and hyphens read as underscores, is `signup`, `sign_up`, `signed_up`,
  `register`, `registered`, `registration`, `create_account`, `account_created`, `subscribe` or `subscribed`, or ends
  in `_signup` or `_sign_up`. Other goals appear only when they are the site's primary goal (docs/GUIDE.md), as
  `goal`. `label` is the product of a payment or trial and the name of a goal, or `null`. `amount` and `currency` are
  set for payments only. The location is the one of the visit the event is credited to, or `null` without one.
- `places` groups the visitors seen in the last `placesMinutes` by country and city, most visitors first, at most 60.
  The window is 24 hours (1440) unless you send `?placesMinutes=` with a whole number from 5 to 1440. Under 24 hours,
  a visit also has to have started in the 6 hours before the window, as for `online`. `city` is `null` when the lookup
  had none. Visits without a country stay out. Send `?places=0` to leave them out: `places`, `placesMinutes`,
  `recent` and the four other `recent...` fields are then `null`. A client that polls every few seconds should ask for places once every few minutes. The dashboard's
  live page asks for none by default, so its globe glows only where people are online; its 30 min, 1 h and 24 h
  buttons ask for that window.
- `recent` lists the visitors seen in the same `placesMinutes` window one by one, in the shape of `visitors`: one entry
  per visitor and site, the visit seen last, newest activity first, at most 150. Visits without a country count here.
  A visitor online is in both lists with the same `id`. It comes and goes with `places`, so it can be a few minutes
  older than `visitors`. The dashboard merges the two and keeps the online row of a visitor in both.
- `recentCount`, `recentSites`, `recentRevenue` and `recentEvents` are the numbers of the same window. `recentCount`
  is every visitor seen in it, counted per visitor and site as `online` is, so it can be larger than the 150 entries of
  `recent`. `recentSites` gives that count per site, most visitors first, sites without a visitor left out.
  `recentRevenue` sums the window's payments per currency in minor units, largest first, with the same rule for what
  counts as a payment as `events`. `recentEvents` has the window's events in the shape of `events`, newest first, at
  most 30. The dashboard's live page shows these when a window is chosen and adds the payments that `events` has
  brought since.
- `lat` and `lon` have one decimal, about 11 km, the way collection stores them (docs/PRIVACY.md). Visits recorded
  before migration 0063, and visits Cloudflare could not place, have `null`. Put those at the country's centroid.
- No names, emails, user ids or customer ids, whatever `PHONE_PII` or `VIEWER_PII` say.

What a call costs: one D1 batch of 3 statements, or 8 with places and the window's fields, every one on an index. With
`npm run seed` (about 750 visits in the last 24 hours) a call read about 370 rows without places and about 1,900 with
them before `recent` existed; `recent` and the per-site count each read the same visits as `places` once more, and
the window's payments and events read that window's rows. Most of that is
the visits of the last 6 and 24 hours, so reads grow with your traffic. A call writes nothing. The answer has
`Cache-Control: no-store`.

Every `GET /api/...` answer sends a `Server-Timing` header, for example
`total;dur=412;desc="Worker and D1", d1;dur=2;desc="D1 round trips in sequence, 2 calls", sql;dur=96;desc="41200 rows read"`.
`total` is the server's time for the call, almost all of it D1, and `sql` the part D1 spent running the statements.
`d1` counts the D1 round trips the call waited for one after another: 2 for
Home, Pulse and a site's overview, 3 for the same reads with a phone token (the token is checked first), 1 for
`/api/live`. docs/GUIDE.md ("Server timing") has the details.

## 10. Questions

A plan's agent asks the owner with an owner task (docs/API.md, "Plan (Pro)"): an approval, which reads as Yes or No,
or a task with a `question`. The app's Growth tab lists every open question of every site and answers them. An answer
closes the task, and the agent's next run reads it.

`GET /api/mobile/questions` answers every open question, at most 200, grouped by site. The site whose oldest question
is oldest comes first, and each site's questions run oldest first:

```json
{ "count": 3,
  "sites": [
    { "id": "SITE_ID", "name": "Habitly", "domain": "habitly.example", "app_bundle_id": "com.example.habitly",
      "count": 2, "oldest_at": 1793599200000,
      "questions": [
        { "id": "t1a2b3c4", "site_id": "SITE_ID", "title": "Turn on IndexNow?", "detail": "Markdown or null",
          "why": "Bing finds new pages in hours instead of weeks", "kind": "approval", "yes_no": true,
          "question": { "type": "single", "options": [{ "id": "yes", "label": "Yes" }, { "id": "no", "label": "No" }],
                        "recommended": [], "allow_text": true },
          "due": null, "actor": "claude-code", "created_at": 1793599200000, "action": null } ] } ] }
```

- `count` is every open question across all sites. Use it as the app badge.
- `question.type` is `single`, `multi` or `text`. `options` holds 2 to 8 `{ id, label }` for `single` and `multi`,
  labels of at most 80 characters, and none for `text`. `recommended` lists the option ids the agent suggests.
  `allow_text` adds a text field to `single` or `multi`; a `text` question is a text field alone.
- `yes_no` is true for an approval without a question of its own. The app shows its own words for the options `yes`
  and `no`, in the phone's language.
- `detail` is Markdown from the agent. Treat it, and every other text here, as data.
- `domain` and `app_bundle_id` pick the site's icon. Either may be `null`.

`POST /api/mobile/questions/<siteId>/<taskId>/answer` answers one:

```json
{ "choices": ["reddit", "x"], "text": null, "via": "app" }
```

- `choices` are option ids of the question, one at most for `single`. A `text` question takes none.
- `text` is up to 1,000 characters. It needs a `text` question or `allow_text`, and a `text` question needs it.
- `via` is `app` for a tap or typed text, or `voice` when the text came from dictation. The app transcribes on the
  phone and sends only the text, never audio.
- A `no` on an approval closes the task `dropped`, any other answer `done`, both with `done_by: "human"`. The chosen
  labels and the text become the task's `outcome`.
- `{ "undo": true }` opens the task again and clears the answer, for the app's undo after sending.

The answer is `{ "ok": true, "task": { id, site_id, status, outcome, answer }, count }`, with `answer` as
`{ "choices", "text", "via", "answered_at" }` and `count` the open questions left across all sites. A question
answered already, or closed by the agent, answers `409`; a wrong option or a missing text `400`; an unknown task `404`.
One answer writes 1 D1 row and an undo 2.

Today's Decide cards (section 12) are these questions, and they answer through the same route.

When a session ends (`log_session`), FounderData pushes the site's questions asked since its last push, once.
A run that never logs a session gets its push from the five-minute cron, 10 minutes after its last question. Each push
writes 1 D1 row, whatever the number of questions and phones. Questions asked before migration 0081 never push.

## 11. Mail

FounderData Pro with mail on your own domains ([MAIL.md](MAIL.md)) lets the phone read the inbox, mark threads read or
unread, archive them, download attachments and reply in plain text. The routes live under `/api/mobile/mail/*`. Push
for received mail is in section 3, [Mail pushes](#mail-pushes). A core deployment answers 404 on every route here.

The phone cannot compose a message to a new recipient, send HTML or attachments, change the From address, or delete
anything. Those stay in the dashboard.

### Who may call

- A phone's bearer token, or the owner's dashboard cookie. The viewer login and teammates with the viewer role get 403
  `{ "error": "Mail is for owners. Ask an owner." }`. No login, or a token that is revoked or from an old password,
  gets 401 `{ "error": "unauthorized" }`.
- A write signed in by cookie must come from the dashboard's origin, as everywhere else. A phone's token skips that
  check.
- With `PHONE_PII=0` on the Worker, every route here answers 403 to a phone:
  `{ "error": "Mail is off for phones on this deployment: PHONE_PII is 0, and mail is personal data through and through. Read it in the dashboard." }`.
  Mail is other people's addresses and words, and none of it can be blanked the way names are elsewhere. The owner's
  cookie still works.
- Unlike the routes in section 1, these answers are not filtered for secrets. Mail holds no deployment secret, and the
  filter would blank the `auth` field of a message.

### Errors and lists

- Errors are `{ "error": "<one sentence for a person>" }` with 400 (bad input), 401, 403, 404 (no such thread,
  message or attachment), 413 (a request body over 25 MB), 422 (the mail service refused the reply, or a recipient is
  suppressed), 429 (the phone's reply cap), 502 (the send failed) or 503 (mail is not set up). A route may add fields;
  they are listed with it.
- Times are integers, ms since 1970. Ids are strings. Addresses are lowercase.
- Every answer has `cache-control: no-store`.

### Shapes

```json
// ThreadSummary
{
  "id": "thr_9c1d", "subject": "Refund for order 1042", "snippet": "Hi, I was charged twice for...",
  "last_at": 1763450000000, "unread": 1, "message_count": 3,
  "participants": ["ann@example.net"],
  "last_from": { "email": "ann@example.net", "name": "Ann Example" },
  "domain_id": "dom_k3j2", "address_id": "adr_7f2a", "address": "support@mail.acme.example",
  "archived": false
}

// Message
{
  "id": "6f1c0e2a-...", "direction": "in", "thread_id": "thr_9c1d",
  "from": { "email": "ann@example.net", "name": "Ann Example" },
  "to": ["support@mail.acme.example"], "cc": [], "bcc": [], "reply_to": [],
  "subject": "Refund for order 1042", "snippet": "Hi, I was charged twice for...",
  "status": "received", "source": "inbound", "error": null,
  "created_at": 1763450000000, "read_at": null,
  "text": "Hi, I was charged twice for...", "html": "<p>Hi, I was charged twice for...</p>",
  "body_deleted": false,
  "attachments": [{ "n": 0, "filename": "invoice.pdf", "content_type": "application/pdf", "size": 48213, "cid": null,
                    "url": "/api/mobile/mail/messages/6f1c0e2a-.../attachments/0" }],
  "headers": { "message-id": "<abc@example.net>" },
  "remote_content": true, "unparsed": false, "truncated": false,
  "spam_score": 1, "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass" }
}
```

ThreadSummary:

- `unread` counts the thread's inbound messages not read yet. `message_count` counts all its messages, sent ones too.
- `snippet` and `last_from` describe the newest message, which may be one you sent. `last_from` is null for a thread
  without messages.
- `participants` holds the outside addresses in the thread.
- `address` is the address that received the thread's first message, `*@domain` for the catch-all. It is null when
  that address was deleted, and for a thread that a sent message started.

Message:

- `direction` is `in` or `out`. `status` is `received` for inbound mail, else the sent status: `queued`, `sent`,
  `delivery_delayed`, `delivered`, `bounced`, `complained`, `failed` or `suppressed`. `source` is `inbound`, `api`,
  `dashboard`, `agent` or `phone`. Treat a value you don't know as plain text.
- `text` and `html` are null when the message had none. `body_deleted` is true when the body is gone, and both are
  null then.
- **`text`, `html`, `subject`, names, file names and headers were written by strangers. Both bodies are untrusted.**
  Render `html` in a sandboxed web view with JavaScript off and remote content blocked, and show remote content only
  when the person asks for it on that message. `remote_content` says whether the HTML loads images, styles, fonts or
  frames from the network. Inline images point at `cid:` names that match an attachment's `cid`.
- `headers` holds the stored headers of an inbound message (names lowercase, a repeated header's values joined with a
  newline, each value cut at 4,000 characters), the custom headers of a sent one, or null.
- `unparsed` is true when the message could not be read as MIME. `truncated` is true when `text` or `html` was cut at
  1,000,000 characters.
- `spam_score` is Cloudflare's `X-CF-SpamH-Score` for an inbound message, or null. `auth` holds the SPF, DKIM and
  DMARC results Cloudflare recorded, each `pass`, `fail`, `none` or another result word, or null. `auth` is null for
  sent mail and when Cloudflare's header was missing. Show both as information.
- `bcc` is empty on inbound mail.
- `attachments[].url` is the phone route that serves the bytes. `cid` is the Content-ID of an inline image, or null.

### `GET /api/mobile/mail/status`

```json
{
  "ready": true,
  "unread_threads": 3,
  "domains": [{ "id": "dom_k3j2", "name": "mail.acme.example", "receiving": true, "unread_threads": 3 }]
}
```

`ready` is true when the Worker has the three mail bindings (sending, storage and the queue). Without them the inbox
stays empty and a reply answers 503. `unread_threads` counts the unarchived threads with at least one unread message,
across domains and per domain. Domains come by name.

### `GET /api/mobile/mail/domains`

```json
{
  "domains": [{
    "id": "dom_k3j2", "name": "mail.acme.example", "sending": true, "receiving": true, "unread_threads": 3,
    "addresses": [{ "id": "adr_7f2a", "address": "support@mail.acme.example", "display_name": "Acme support",
                    "action": "inbox", "threads": 12, "unread": 2 }]
  }]
}
```

For the domain filter and the address filter. `addresses` holds every address of the domain by name, the catch-all
`*@domain` last. `action` is `inbox`, `forward`, `webhook` or `drop`. `threads` counts the address's unarchived threads
and `unread` their unread messages, not threads.

### `GET /api/mobile/mail/threads`

Query, every part optional:

| Parameter | Meaning |
| --- | --- |
| `domain_id` | Threads of one domain. |
| `address_id` | Threads one address received. |
| `unread=1` | Only threads with unread mail. |
| `archived=1` | The archive instead of the inbox. Default `0`. |
| `q` | Text that the subject or a participant's address contains, case-insensitive for ASCII letters, up to 100 characters. It does not search message text. |
| `sort` | `newest` (default), `oldest`, `unread_first` or `sender`. |
| `limit` | 1 to 100, default 50. |
| `cursor` | The `next_cursor` of the page before. |

```json
{ "threads": [ThreadSummary], "next_cursor": "eyJzIjoic2VuZGVyIiwidCI6MTc2MzQ1MDAwMDAwMCwiaSI6InRocl85YzFkIn0" }
```

What each sort does, with the tie-breaks that make paging exact:

- `newest`: by `last_at`, newest first, then by id from high to low.
- `oldest`: by `last_at`, oldest first, then by id from low to high.
- `unread_first`: threads with unread mail first, then the rest, each part newest first as in `newest`.
- `sender`: A to Z by the newest message's sender name, or its address when the name is empty, then newest first.
  The comparison ignores case for ASCII letters and reads the first 100 characters. The newest message may be one you
  sent, so a thread you answered last sorts under your own name. This sort reads every thread the filters keep on each
  page, so it is slower than the others on a large inbox.

`next_cursor` is null on the last page. Send it back with the same `sort` and filters. A cursor is opaque. A cursor
from another sort answers 400 (`This cursor belongs to the oldest order. ...`), and so does a cursor the server did
not give out. An unknown `sort` answers 400 `sort must be one of newest, oldest, unread_first, sender.`. A thread whose
`last_at` or unread state changes while you page can move to a page you already read or have not read yet; reload from
the first page after a change you made.

### `GET /api/mobile/mail/threads/:id`

```json
{ "thread": ThreadSummary, "messages": [Message] }
```

Messages oldest first, with their bodies. A thread with more than 100 messages answers its newest 100. Reading does
not mark the thread read. 404 for an unknown id.

### `POST /api/mobile/mail/threads/:id/read`

Body `{ "read": true }` or `{ "read": false }`. `read` defaults to true. Marks every inbound message of the thread read
or unread. Answers `{ "ok": true, "unread": 0 }` with the thread's new unread count. 400 when `read` is not a boolean,
404 for an unknown id.

### `POST /api/mobile/mail/threads/:id/archive`

Body `{ "archived": true }` or `{ "archived": false }`. `archived` defaults to true. Answers `{ "ok": true }`. A new
inbound message takes a thread out of the archive. 400 when `archived` is not a boolean, 404 for an unknown id.

### `GET /api/mobile/mail/messages/:id/attachments/:n`

The bytes of one attachment, the `url` of a Message's attachment. Headers: the stored `content-type`,
`content-length`, `content-disposition: attachment; filename="..."; filename*=UTF-8''...`,
`x-content-type-options: nosniff`, `content-security-policy: sandbox; default-src 'none'` and
`cache-control: no-store`. Save the file or hand it to Quick Look. Never render it in a web view that can run script.
404 when the message or the attachment is unknown or deleted.

### `POST /api/mobile/mail/threads/:id/reply`

```json
{ "text": "Thanks, the refund is on its way.", "reply_all": false }
```

- `text` is required: plain text, 1 to 20,000 characters, not only spaces. `reply_all` is optional, a boolean.
- `html`, `attachments`, `from`, `to`, `cc`, `bcc`, `reply_to`, `subject` and `headers` are refused with 400
  `A reply from the phone is plain text to the people in the thread. Leave out <field>.`.
- From is the address that received the thread, with its display name, else an address of the thread's domain.
- To is the sender of the thread's last inbound message. A Reply-To on that message is followed only when it names
  someone already in the thread (a participant, or someone who wrote in it); otherwise the reply goes to the sender.
  The dashboard follows any Reply-To, the phone does not, because a stranger chose it. With `reply_all`, Cc adds the
  thread's other people, again only those already in it, never your own addresses.
- The subject gets `Re: ` once, and In-Reply-To and References come from the thread, so the reply stays in the
  recipient's thread.
- It goes through the same path as a reply from the dashboard: the suppression list, the Sent tab, delivery status and
  webhooks. The Sent tab shows its source as the iPhone app.

Answers `{ "id": "8a2e...", "status": "sent", "thread_id": "thr_9c1d", "to": ["ann@example.net"] }`.

Errors:

- 400 for the body problems above, and when the thread has nothing to reply to: no message, or only messages you sent
  to people the thread does not name (`This thread names nobody to reply to from the phone. ...`).
- 404 for an unknown thread.
- 413 when the body is larger than 25 MB.
- 422 when a recipient is on the suppression list or the mail service refused the content, 502 when the send failed.
  Both add `"id"`, `"status"` (`suppressed` or `failed`) and `"code"` (the provider's code, or null) when the message
  was stored.
- 429 when the phone reached its daily cap:
  `{ "error": "This phone sent 50 replies in the last 24 hours, its cap. ...", "cap": 50, "sent_24h": 50 }`.
- 503 while mail is not set up.

The cap counts the replies this phone sent in the last 24 hours, so a stolen token cannot send without end. It is 50
unless the Worker sets `PHONE_MAIL_DAILY_REPLIES`, a whole number from 1 to 1,000. A reply the mail service refused or
the suppression list stopped does not count. Each phone has its own count. The owner's cookie on this route has no cap,
as the dashboard has none.

What a call costs: reading writes nothing. Marking read writes 1 row per message whose state changes plus 1, archiving
1, and a reply 22 rows, 1 more than the same reply from the dashboard for the index by device.

## 12. Today

FounderData Pro keeps one list across all sites of what needs the owner: Today on the phone, Needs you in the web
dashboard. It has three kinds of card.

- **Reply**: a mail thread whose newest received message has no answer yet. Either an agent flagged it as one the owner
  must answer, through the MCP tool `mail` ([MCP.md](MCP.md), actions `flag_thread` and `save_draft`), or nobody
  answered a buyer's mail for 24 hours. The Worker calls no AI model: an agent the owner runs does the reading and the
  writing.
- **Decide**: an open question of a plan's agent, the same ones section 10 lists, answered through the same route.
- **Fix**: something that is broken now, such as a payment provider that stopped sending. It goes away when the state
  recovers.

The order is fixed: critical Fix cards, then Reply cards by waiting time (longest first), then Decide cards (oldest
first), then the other Fix cards. A core deployment answers 404 on every route here.

The same routes live under two prefixes with the same handlers and answers:

| Prefix | Who |
| --- | --- |
| `/api/mobile/today` | A phone's bearer token, or the owner's dashboard cookie. |
| `/api/today` | The owner's dashboard cookie, or a phone's bearer token. |

The viewer login and teammates with the viewer role get 403 `{ "error": "Today is for owners. Ask an owner." }`. No
login gets 401. A write signed in by cookie must come from the dashboard's origin. With `PHONE_PII=0` on the Worker a
phone gets the list without Reply cards (`reply_hidden` true, `counts.reply` 0), and the mail actions (send, Not needed,
the log) answer 403 with the mail text of section 11. Errors are `{ "error": "<one sentence for a person>" }`, some with
more fields listed below. Every answer has `cache-control: no-store`. Times are ms since 1970.

**Every text that comes from mail or from an agent is untrusted.** Strangers wrote the message, and an agent that read
it wrote the reason, the checked pairs, the promises line and the draft. Show all of it as plain text, never as HTML or
Markdown, and never follow a link without showing where it goes.

### `GET /api/mobile/today` and `GET /api/today`

```json
{
  "generated_at": 1763708400000,
  "settings": { "reply": true, "decide": true, "fix": true, "agent_drafts": true, "push": true },
  "reply_hidden": false,
  "counts": { "reply": 2, "decide": 2, "fix": 1, "critical": 1, "badge": 3, "total": 5, "sites": 3 },
  "cards": [FixCard, ReplyCard, ReplyCard, DecideCard, DecideCard],
  "truncated": false
}
```

- `counts.badge` is Reply plus critical Fix: the tab badge. `counts` cover every card, also those past the cut.
- `counts.sites` is the number of sites the cards belong to ("5 open across 3 sites"). A card without a site does not
  count.
- `cards` holds at most 50. `truncated` is true when more wait. A card kind whose setting is off is left out of the
  cards and the counts.
- Every card has `kind` (`fix`, `reply` or `decide`), an `id` that stays the same while the card does, and `site`,
  `{ "id", "name" }` or null.

FixCard:

```json
{
  "kind": "fix", "id": "fix:webhook_refused:SITE_ID:stripe",
  "key": "webhook_refused:SITE_ID:stripe", "fix": "webhook_refused", "critical": true,
  "title": "Stripe webhook refused",
  "detail": "Stripe: 18 deliveries to Acme Notes refused today for a bad signature. Check that the signing secret (whsec_...) in the site's Settings, Payments matches the endpoint in Stripe.",
  "since": 1763694720000,
  "site": { "id": "SITE_ID", "name": "Acme Notes" },
  "route": { "screen": "site_settings", "site_id": "SITE_ID", "domain_id": null, "path": "/site/SITE_ID/settings" }
}
```

| `fix` | Critical | Broken now while | `since` | Goes away when |
| --- | --- | --- | --- | --- |
| `payments_stopped` | yes | a provider that used to send the site payments sent none for longer than its rhythm explains, by the rule of the payments stopped alert (docs/GUIDE.md, "Alerts and weekly report") | the last payment | a payment arrives, or the rule gives up after 60 days or more |
| `webhook_refused` | yes | a delivery from the provider was refused for a bad signature or token in the last 24 hours | the first refusal the alert inbox holds from the last 7 days, else the last refusal | a payment from that provider arrives after the last refusal, or 24 hours pass without a refusal |
| `cap` | yes | the site's own daily write cap, or the shared pool (`key` `cap:*`, `site` null), was reached today | when it was reached | 00:00 UTC |
| `quiet` | no | the site had no visit or app session for 24 hours or more, up to 30 days | the last session | a session arrives |
| `aso_collector` | no | the ASO collector sent no snapshot for 36 hours or more, up to 30 days, and DataForSEO does not cover every country | the last snapshot | a snapshot arrives |
| `mail_domain` | no | the hourly mail health job alerted a problem with a domain's setup, and its last check still finds it | when the problems last changed | the check finds none |

- `key` is stable while the state lasts. Mute takes it.
- `title` and `detail` are written for a person, in English. `detail` says what to check.
- `route.screen` is `home`, `site_settings`, `aso` or `mail_domain`, with the site or the mail domain it is about.
  `route.path` is the dashboard path for the same screen. Treat a screen you don't know as `home`.
- Fix states the Worker cannot judge cheaply are not cards: a failed payment, a cancellation, a rule alert, an App
  Store review. Those stay in the alert inbox and the alert channels.

ReplyCard:

```json
{
  "kind": "reply", "id": "reply:thr_9c1d", "thread_id": "thr_9c1d", "source": "agent",
  "site": { "id": "SITE_ID", "name": "Acme Notes" },
  "subject": "Charged twice for the yearly plan",
  "from": { "email": "dana@reyes.example", "name": "Dana Reyes" },
  "to": "support@acme.example",
  "message": { "id": "6f1c0e2a-...", "at": 1763644920000, "text": "Hi,\nI upgraded to the yearly plan on Tuesday...",
               "text_cut": false, "text_from_html": false, "body_deleted": false },
  "waiting_since": 1763644920000,
  "flag": {
    "reason": "A paying customer asks for money back. Nobody has answered in 19 h.",
    "checked": [{ "label": "Orders", "value": "#1042 and #1043, $29 each" },
                { "label": "Subscription", "value": "Yearly, active" }],
    "promises": "Promises a refund of $29",
    "by": "Juno", "at": 1763691240000
  },
  "draft": {
    "text": "Hi Dana,\nYou're right, order #1043 charged you a second time...",
    "to": "dana@reyes.example", "by": "Juno", "at": 1763691240000,
    "new_links": ["acme.example/billing"]
  },
  "draft_outdated": false
}
```

- `source` is `agent` for a thread an agent flagged, `unanswered` for a buyer's mail nobody answered in 24 hours. An
  `unanswered` card has `flag` null and no draft.
- A buyer is a sender whose address is the email of a recorded payment (not a sandbox one, not a refund) on any site.
  The addresses are compared ignoring case. App Store buyers, whose payments carry no email, never make an
  `unanswered` card.
  Mail that looks automatic (an `Auto-Submitted` header, `Precedence: bulk`, `list` or `auto_reply`, a `List-Id` or
  `List-Unsubscribe` header, a `noreply` sender) or likely spam (as for mail pushes, section 3) never does either.
- `message` is the thread's newest received message, the one a reply answers. `text` is its full text, cut at 20,000
  characters (`text_cut`). A message with HTML only comes as the words of its HTML (`text_from_html`).
  `body_deleted` is true when retention deleted the body: `text` is empty then.
- `to` is the address of yours that received the message, or null.
- `waiting_since` is the first received message after the last answer. "Waiting 19 h" counts from it.
- `flag.by` and `draft.by` name the API key the agent used. `checked` holds at most 8 pairs.
- `draft` is null when no agent wrote one, or when the draft answers an older message: `draft_outdated` is true then.
  `draft.to` is the only address the reply can go to.
- `draft.new_links` lists the links in the draft that appear in none of the thread's 20 newest messages, as written in
  the draft. Mark each one in the draft and let the owner check it before sending. A link here is a host with a path
  (`acme.example/billing`), or anything starting `http://`, `https://` or `www.`.
- A card closes the moment any sent message exists in the thread after the message the agent flagged, whoever sent
  it and from wherever: the dashboard, the phone, an agent or an app. A message the mail service refused does not count.
  A new received message after an answer opens a new waiting stretch, which needs a new flag or 24 hours.

DecideCard:

```json
{
  "kind": "decide", "id": "decide:SITE_ID:t1a2b3c4",
  "site": { "id": "SITE_ID", "name": "Tidy Ledger" },
  "question": { "id": "t1a2b3c4", "site_id": "SITE_ID", "title": "Which yearly price should the next test use?", "...": "..." }
}
```

`question` is exactly a question of `GET /api/mobile/questions` (section 10). Answer it with
`POST /api/mobile/questions/<siteId>/<taskId>/answer` on the phone, or `POST /api/sites/<siteId>/plan/tasks/<taskId>/answer`
with the dashboard cookie (docs/API.md, "Plan (Pro)"), with the same body. Undo works the same way.

### `POST .../reply/:threadId/send`

```json
{ "message_id": "6f1c0e2a-...", "text": "Hi Dana, ..." }
```

Sends the reply of a Reply card at once. The 30-second hold with Undo is the client's: wait, then call this route.

- `message_id` is required: the card's `message.id`, the message the owner read.
- `text` is optional, plain text up to 20,000 characters. Without it the card's draft goes. With it, that text goes,
  which is how an edited draft or a reply to a card without a draft is sent.
- The reply goes to the sender of that message (`from.email`) and nobody else, from the address that received the
  thread, with `Re: ` and the threading headers, inside the thread, as plain text. It takes the reply path of section 11:
  the suppression list, the Sent tab and delivery status, and the phone's daily reply cap. The dashboard's login has
  no cap, as in section 11.
- One card is sent once. A second send of the same card and message answers 409.

Answers `{ "id": "8a2e...", "status": "sent", "thread_id": "thr_9c1d", "to": ["dana@reyes.example"], "from_draft": true, "edited": false }`.
`from_draft` is true when the card had a draft for that message, `edited` when the text sent differs from it.

Errors:

- 400: no `message_id`, `text` not a string, an empty reply, a card without a draft and no `text`, a reply over 20,000
  characters.
- 403: a phone with `PHONE_PII=0`.
- 404: an unknown thread.
- 409: nothing in the thread waits for an answer any more (someone answered it, or it is archived), or a newer message
  arrived after `message_id` (the answer adds `"message_id"` with the newest one: show it, then send again), or this
  card was sent already.
- 422 and 502 as for a reply in section 11, with `id`, `status` and `code` when the message was stored. The card stays,
  and a second send may try again.
- 429: the phone's daily cap, with `cap` and `sent_24h`.

### `POST .../reply/:threadId/dismiss`

Not needed. Body `{ "message_id": "6f1c0e2a-..." }`, the card's `message.id`. Answers `{ "ok": true }`. The card goes
away until a newer message arrives in the thread. The agent's flag stays for the log. 409 with `message_id` when a
newer message arrived, 409 when nothing waits, 404 for an unknown thread, 403 for a phone with `PHONE_PII=0`.

### `POST .../fix/mute`

Mute 24 h. Body `{ "key": "webhook_refused:SITE_ID:stripe" }`, the card's `key`. Answers
`{ "ok": true, "key": "...", "since": 1763694720000, "until": 1763781120000 }`. The card leaves the list, the counts,
the 08:00 push and the push for a critical Fix until `until`, or until the state recovers: the mute holds only while
the card's `since` stays the same, so a state that recovers and breaks again shows at once. 404 when that key is not
broken now. Muting takes no personal data, so a phone with `PHONE_PII=0` may mute.

### `GET .../settings` and `PUT .../settings`

```json
{ "settings": { "reply": true, "decide": true, "fix": true, "agent_drafts": false, "push": true } }
```

The owner's settings, one set for the deployment, the same on every phone and in the dashboard.

- `reply`, `decide`, `fix`: show that card kind. All start on.
- `agent_drafts`: agents may save drafts. Starts off. While it is off, an agent's `save_draft` is refused with
  `Agent drafts are off. ...` and cards carry no new drafts. Drafts saved before stay.
- `push`: the 08:00 push. Starts on.

`PUT` takes any of the five as true or false and answers the whole set. An unknown key or a value that is not a boolean
answers 400.

### `GET .../log`

What agents wrote and what was sent from a card, newest first. Query: `limit` 1 to 200 (default 50) and `before`, the
`next_before` of the page before.

```json
{
  "entries": [
    { "id": "send:thr_9c1d:6f1c0e2a-...", "at": 1763708430000, "kind": "send", "thread_id": "thr_9c1d",
      "subject": "Charged twice for the yearly plan", "message_id": "6f1c0e2a-...", "actor": "phone",
      "detail": { "from_draft": true, "edited": true, "sent_id": "8a2e...", "status": "sent" } },
    { "id": "log_k2j3h4g5f6", "at": 1763691240000, "kind": "draft", "thread_id": "thr_9c1d", "subject": "...",
      "message_id": "6f1c0e2a-...", "actor": "Juno", "detail": { "text": "Hi Dana, ...", "new_links": ["acme.example/billing"] } },
    { "id": "log_a1s2d3f4g5", "at": 1763691200000, "kind": "flag", "thread_id": "thr_9c1d", "subject": "...",
      "message_id": "6f1c0e2a-...", "actor": "Juno",
      "detail": { "important": true, "reason": "...", "checked": [{ "label": "Orders", "value": "..." }], "promises": "Promises a refund of $29" } }
  ],
  "next_before": null
}
```

- `kind` is `flag`, `draft` or `send`. `actor` is the agent's API key name for `flag` and `draft`, and `phone` or
  `dashboard` for `send`. Every draft an agent saved is here, also one a later draft replaced.
- A `send` entry's `detail.status` is `sending` for a send still under way, else `sent`. A failed send leaves no entry.
- Entries are kept 90 days, and go with their thread. 403 for a phone with `PHONE_PII=0`.

### Rows and reads

Reading the list writes nothing. It reads one D1 batch (settings, mutes, the Reply candidates, the open questions), the
Fix states (the payments of silent providers, today's caps, the refused webhooks, the ASO collector and the mail health
memory), one read of `payments` when a thread is old enough to be an `unanswered` card, and one R2 read per Reply card
for its text.

| Write | D1 rows |
| --- | --- |
| Send a Reply card | the reply's own (21 from the dashboard, 22 from a phone, section 11) + 2 |
| Not needed | 1 |
| Mute | 1 |
| Change the settings | 1 |
| An agent's flag, or its draft | 2 each |
| The 08:00 push | 1 a day |
| The push for a critical Fix | 1 per tick that finds a new one |
