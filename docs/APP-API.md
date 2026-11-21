# FounderData: app API contract (shared by the server and the iOS SDK)

The contract between the server and the iOS SDK. The SDK is the `FounderDataKit` Swift package in `ios/`. Examples use `https://founderdata.example.com` as the host; use your own deployment.

## 1. App events: `POST /api/app/events`

Public, unauthenticated (like the web tracker; the site id is public). CORS not needed. Body max 64 KB, max 50 events.

```json
{
  "w": "<site id>",
  "ctx": {
    "platform": "ios",
    "app_version": "1.4.0",
    "build": "57",
    "os_version": "26.1",
    "device": "iPhone17,1",
    "locale": "en_US",
    "bundle_id": "com.example.shipkit",
    "consent": true
  },
  "vid": "<install id: UUID v4 without dashes or with, 8-64 [\\w-]>",
  "events": [
    { "t": "session_start", "sid": "<session id>", "ts": 1761400000000,
      "src": { "ads_token": "<AdServices attribution token, first launch only>", "utm_source": "...", "utm_medium": "...", "utm_campaign": "...", "ref": "..." },
      "sp": { "user_state": "new", "exp_paywall_copy": "b" } },
    { "t": "session_props", "sid": "...", "ts": 1761400000500, "p": { "user_state": "new", "exp_paywall_copy": "b", "onboarding_variant": "short" } },
    { "t": "screen",   "sid": "...", "ts": 1761400001000, "n": "Onboarding/Step2" },
    { "t": "goal",     "sid": "...", "ts": 1761400001500, "n": "onboarding_name", "p": { "step": "name", "index": "2" } },
    { "t": "goal",     "sid": "...", "ts": 1761400002000, "n": "onboarding_complete", "p": { "variant": "b" } },
    { "t": "ping",     "sid": "...", "ts": 1761400030000, "d": 28000 },
    { "t": "identify", "sid": "...", "ts": 1761400040000, "p": { "user_id": "u_1", "email": "a@b.c", "name": "A" } },
    { "t": "purchase", "sid": "...", "ts": 1761400050000, "jws": "<StoreKit 2 VerificationResult.jwsRepresentation>" }
  ]
}
```

Rules:
- `screen` maps to a pageview whose path is `/` + screen name (so pages, entry/exit, funnels work unchanged). Session hostname is `ios:<bundle_id>`.
- Sessions: the SDK owns the session id; new session after 30 min in background. `session_start` carries source info; deep links / universal links with utm_* or ref fill `src`.
- `ads_token` (AdServices `AAAttribution.attributionToken()`): server POSTs it to `https://api-adservices.apple.com/api/v1/` (text/plain body). If `attribution: true`, set channel `Paid`, source `Apple Search Ads`, utm_campaign = campaignId, utm_term = keywordId, utm_content = adGroupId. Do it via `ctx.waitUntil`, with one retry; Apple may return 404 for the first seconds.
- Response `202` with `{ "ok": true }`. Bad payload `400`. Unknown site `404`. Bots are not filtered for app events (no browser UA).
- Site past its daily write cap (docs/GUIDE.md, "Daily write cap"): `429` with `{ "error": "daily write cap reached" }` and `Retry-After` set to the seconds until 00:00 UTC. Nothing from the batch is stored. The SDK keeps the batch and sends it again later.
- `sp` on `session_start` and `p` on `session_props` are session properties, section 6.
- `ctx.consent` is `true` while the SDK keeps the install id on the device (`setConsent(true)`) and absent otherwise. The server marks such installs as persistent; only they can come back under the same id, so retention covers them alone (section 7).
- `ctx.id` is `"vendor"` while the install id is the `.vendor` id (`configure(..., installId: .vendor)`) and the user has not given consent, and absent otherwise. That id is derived from `identifierForVendor` (section 3), so later launches come back under it, and the server marks the install as persistent too. Any other value is ignored. After consent the SDK sends `consent` instead.
- `ts` is client time; clamp to [now - 72h, now + 5 min]; events are sent in batches from an offline queue.
- Country/region/city from `request.cf` only (the server never stores the IP address of an app upload); browser = "App", os = "iOS <os_version>", device = "Mobile"/"Tablet" from device model prefix (iPad).

## 2. App Store revenue

Three ways, all deduplicated by `transactionId` (payment id `apple_<transactionId>`): the app's purchase event (a), App Store Server Notifications (b) and the RevenueCat webhook (section 8).

a) Client purchase event (`t: "purchase"`, `jws`): the server verifies the JWS (ES256, x5c chain ending at Apple Root CA - G3, embedded as a constant; check leaf OID 1.2.840.113635.100.6.11.1 and intermediate OID 1.2.840.113635.100.6.2.1; check validity dates against signedDate). Decoded payload gives `transactionId`, `originalTransactionId`, `productId`, `price` (milliunits), `currency`, `environment`, `purchaseDate`, `appAccountToken`, `type`, `revocationDate`. Reject `environment != "Production"` unless the site setting `accept_sandbox` is on (store sandbox rows with provider `app_store_sandbox` so they never mix into revenue). Credit to `vid`/`sid` from the request. Renewals (same originalTransactionId, later transaction) set `renewal = 1`.
b) App Store Server Notifications V2: `POST /api/webhooks/apple/:siteId` with `{ "signedPayload": "..." }`, verified the same way, `bundleId` must match the site's `app_bundle_id` setting. Handles SUBSCRIBED, DID_RENEW, ONE_TIME_CHARGE (from `signedTransactionInfo`), REFUND / REVOKE (negative refund row). Visitor link: `appAccountToken` (the SDK sets it to the install id as UUID) or an earlier payment with the same originalTransactionId. A product backend that already owns the ASC notification URL can forward the raw body here.

Amounts are customer prices including tax, stored in the transaction currency. A purchase in another currency than the site's also gets `amount_conv`, the amount in the site's currency at the ECB rate of the purchase day, which the revenue totals count. Label them "gross" in the dashboard.

These rows count in revenue only on days FounderData has not imported from Apple's daily sales report. On an imported day the report counts the App Store sales (gross customer price, converted per day) and the payment rows of that day stay out, so a sale never counts twice. Attribution, customers and the Customers tab keep using the payment rows. The rule lives in `src/worker/revenue.ts`; the "How revenue is counted" section of [GUIDE.md](GUIDE.md) explains it.

### Forward from your backend

App Store Connect takes one Production URL per app. When a product backend already owns it, the backend keeps it and passes each notification on. It answers Apple first, then posts the raw body to FounderData unchanged, with a 5 second timeout, and never waits for or retries the forward: FounderData must not slow down or fail Apple's delivery. FounderData checks Apple's signature itself, so the forward needs no secret. Express:

```js
const FOUNDERDATA = 'https://founderdata.example.com/api/webhooks/apple/<site id>';

app.post('/apple/notifications', express.raw({ type: '*/*' }), async (req, res) => {
  await handleAppleNotification(req.body); // your own handling, unchanged
  res.sendStatus(200); // Apple has its answer before the forward starts

  fetch(FOUNDERDATA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: req.body, // the bytes Apple sent, not re-serialised
    signal: AbortSignal.timeout(5000),
  }).catch(() => {}); // fire and forget
});
```

Use `express.raw` (or keep the raw body some other way) for the forward, so the body is the one Apple signed. Re-serialising parsed JSON also works, because FounderData checks the JWS inside `signedPayload`, not the body bytes, but the raw body is the safe default. FounderData answers `200` for the forward as for a direct delivery (section 5, point 8); the backend can ignore the answer. A notification forwarded twice is stored once.

## 3. Install id and appAccountToken

The install id is a random UUID v4. Without consent (the default; see the EU ePrivacy rules in [../ios/README.md](../ios/README.md)) the SDK stores nothing on the device: the install id and session id are random per app launch and kept in memory, and so is the queue. After `FounderData.setConsent(true)` the install id is kept in the Keychain (`kSecAttrAccessibleAfterFirstUnlock`, not synced), so it survives reinstalls on the device, and the queue in a file; `setConsent(false)` deletes both. No IDFA, no ATT prompt, no fingerprinting. `FounderData.appAccountToken` returns the current install id as a UUID (per launch without consent) so apps pass it to `product.purchase(options: [.appAccountToken(...)])`. `FounderData.reset()`, for sign-out, switches to a new random install id (kept in memory without consent; with consent it replaces the Keychain item) and starts a new session; `appAccountToken` returns the new id from then on. Events queued before keep the old `vid`.

With `FounderData.configure(..., installId: .vendor)` the install id without consent is the first 16 bytes of SHA-256(`"founderdata-vendor-v1:" + site id + ":" + identifierForVendor` in lowercase), as a lowercase UUID with the version nibble set to 8 (RFC 9562, custom). It is the same on every launch until the user removes every app of the developer team, it is never stored, and the raw `identifierForVendor` is never sent. Batches under it carry `ctx.id: "vendor"`. Before the first unlock after a restart iOS may have no `identifierForVendor`; that launch uses a random id. `reset()` uses a random id until the app quits. With consent the Keychain id wins; a first consent stores the vendor id there, and `setConsent(false)` continues under the vendor id.

### Launches without a kept install id

A batch without `ctx.consent` and without `ctx.id: "vendor"` comes from a launch whose install id lives in memory only. The server groups these launches by device and day, the way it counts cookieless web visitors, so a person who opens the app 20 times a day counts as one visitor:

- The daily key is HMAC(daily salt, `"app|"` + site id + IP + `User-Agent` + `ctx.device` + `ctx.os_version` + `ctx.locale`). The daily salt is the web tracker's: HMAC(`VISITOR_SALT_SECRET`, or else `SESSION_SECRET`, UTC date), so the key changes at 00:00 UTC. The server never stores the IP or the user agent.
- The first launch with a key on a day becomes the visitor: its install id is the `visitor_id`. A later launch with the same key is stored under that visitor, and `app_aliases` remembers which visitor the launch's install id belongs to. Its later batches stay with the visitor when the IP changes, after midnight and after `setConsent(true)` stores the id in the Keychain.
- A new session of a grouped launch continues the visitor's latest session when it starts less than 30 minutes after that session's last event. The session keeps its id, source and first screen. A later start is a new session of the same visitor.
- An `appAccountToken` in a purchase or App Store notification, and the RevenueCat attribute `founderDataVisitorId` (section 8), go through `app_aliases` too, so a purchase made in a later launch is credited to the grouped visitor.
- The next day the same device is a new visitor. Two devices of the same model, OS version and locale behind one IP count as one, and a device that changes networks between launches counts twice. Retention, New installs and the 7-day purchase window need an id that lasts longer: consent or `.vendor`.
- Batches with `ctx.consent` or `ctx.id: "vendor"` are never grouped. Each install id is its own visitor.
- `app_aliases` rows go after 30 days, or with the retention window when that is shorter, and with the visitor on erase.

## 4. Web <-> app

`FounderData.handle(url:)` reads utm_* / ref / `rt_vid` (or the older `ml_vid`) and ad click ids (`gclid`, `msclkid` and others, point 11 below) from universal links. If the link carries a web visitor id the server stores it as `linked_web_vid` on the app visitor, so a web visitor who installs and buys is one journey.

## 5. Server notes: where the server goes beyond this contract

Each point says why.

1. **Bundle check, `403`.** `POST /api/app/events` answers `403` when `ctx.bundle_id` differs from the site's `app_bundle_id`, or when the site has none set. Websites get the same protection from the domain check, so a public site id is not enough to write app data. The SDK should treat `403` like `400`: drop the batch, don't retry.
2. **Body over 64 KB answers `413`.** `400` stays for bad JSON, a missing `w` or `vid`, and an `events` array that is empty or longer than 50.
3. **One bad event does not fail the batch.** Events with an unknown `t`, a malformed `sid`, a `screen` or `goal` without `n`, or a `purchase` without `jws` are skipped. A purchase is also skipped when its JWS fails verification, belongs to another bundle, or is a sandbox purchase on a site that doesn't accept them. The response is `202 { "ok": true, "rejected": <skipped count> }`. Retrying such a batch can't help, so the SDK should not.
4. **Linked web visitor travels in `src.rt_vid`.** Section 4 says the server stores `linked_web_vid` but names no field. The SDK sends the `rt_vid` query parameter of the universal link (or `ml_vid` when only that is present) as `src.rt_vid` on the `session_start` of that session, next to the utm values. Format `[\w-]{8,64}`. The server also accepts `src.ml_vid`, the field older SDK builds send.
5. **Install ids are compared as lowercase UUIDs with dashes.** The server stores a UUID-shaped `vid` (with or without dashes, any case) as lowercase with dashes, so it matches `appAccountToken`, which Apple returns in that form. Other id formats are stored as sent.
6. **Free and revoked transactions are not stored.** A transaction with `price` 0 or missing (free trial, free offer) is not revenue, so it creates no payment row. The first paid transaction after a trial counts as the new customer. A purchase event whose transaction has a `revocationDate` is ignored, because the REFUND notification records that.
7. **What counts as a renewal.** `renewal = 1` when the site already has an earlier payment, by `purchaseDate`, with the same `originalTransactionId`. Payment rows store `customer_id = "apple:<originalTransactionId>"` and `subscription_id = <originalTransactionId>`.
8. **Notification answers.** `401` for a JWS that fails verification. `400` when `data.bundleId` is not the site's bundle or when the site has no bundle id. `200 { "ok": true, "ignored": "sandbox" }` for sandbox notifications on a site with `accept_sandbox` off. `200` with `ignored` for types the server doesn't handle, including `TEST`. `200 { "ok": true, "result": ... }` otherwise. A REFUND or REVOKE for a payment this site never recorded is answered with `result: "no_original"` and changes nothing.
9. **Either delivery can come first.** When the notification arrives before the app's purchase event, the payment is stored first, linked through `appAccountToken` if set. The app's event for the same transaction then fills in the install and session if the row has none.
10. **Apple Search Ads.** The server retries once after 5 seconds on a 404 or a network error. It does not retry a 400. It sets `utm_campaign` to campaignId, `utm_term` to keywordId and `utm_content` to adGroupId, as the contract says. `utm_source` and `utm_medium` stay as the app sent them.
11. **Ad click ids travel in `src.click_network` and `src.click_id`.** When a link carries a click id (`gclid`, `gbraid` or `wbraid` for `google_ads`, `msclkid` for `microsoft_ads`, `ttclid` for `tiktok_ads`, `twclid` for `x_ads`, `li_fat_id` for `linkedin_ads`, `rdt_cid` for `reddit_ads`, `ScCid` for `snapchat_ads`, `epik` for `pinterest_ads`), the SDK sends the network and the raw id on that session's `session_start`. The server stores both only when the network is one of these and the id is 8 to 500 printable characters without spaces or braces; the session is then channel `Paid` with the network as its source ("Google Ads"). The raw id is cleared after 90 days. Same table as the web tracker (`src/shared/sources.ts`, `CLICK_NETWORKS`).
12. **Language and first touch.** The server stores the primary subtag of `ctx.locale` (`en_US` is `en`) on each session, and the first session's source, channel, campaign and entry screen on the install's visitor row (first touch, docs/GUIDE.md).

## 6. Session properties, experiments and onboarding

The app knows things about a launch that FounderData cannot see: whether the user is new or returning (from the app's own data, since the SDK keeps no id across launches without consent), which onboarding or paywall variant it shows, which build channel it is. Session properties carry them, so every panel can be split by them.

- **Shape.** A flat object of string values, at most 10 keys. Keys match `^[a-z0-9_]{1,40}$`, values are 1 to 100 characters. The SDK lowercases keys and turns other characters into `_`. The server drops keys that don't match and cuts longer values.
- **On `session_start`, as `sp`.** The SDK puts the properties set so far in this launch on every `session_start`. A change while that `session_start` is still queued rewrites it, so the common case costs no extra event.
- **`session_props` event.** When the properties change after `session_start` left the device, the SDK sends `{ "t": "session_props", "sid", "ts", "p": { ... } }` with the full current set. The server replaces the session's properties with `p`; `{}` clears them. The SDK sends nothing when the set did not change.
- **Lifetime.** Properties apply to the current session and to every later session of the same launch. The SDK keeps them in memory only, so the app sets them again on each launch, right after `configure`.
- **Experiments.** `FounderData.experiment("paywall_copy", variant: "b")` sets the property `exp_paywall_copy = b`. The dashboard treats every `exp_*` key as an experiment: the App tab's experiments card and Analytics > Experiments, which judges an app arm only once each arm has 30 purchases besides the 100 sessions below (`GET /api/v1/experiments`, [API.md](API.md#experiments-pro)).
- **Onboarding.** `FounderData.onboardingStep(2, "name")` sends the goal `onboarding_name` with props `{ "step": "name", "index": "2" }`. `FounderData.onboardingComplete()` sends the goal `onboarding_complete`. `FounderData.onboardingSkipped(at: "name")` sends `onboarding_skip` with `{ "step": "name" }`. The dashboard orders the funnel by `index`. Goals named `onboarding_<step>` without an `index` (sent with `FounderData.goal` before API v2) still show up, after the indexed steps.
- **Goal helpers.** `FounderData.paywallViewed(source:)`, `purchaseStarted(product:source:)` and the other helpers in [APP-EVENTS.md](APP-EVENTS.md) send ordinary `goal` events with the names and props listed there. The wire format is the same as for `FounderData.goal`.
- **Older servers.** A server without API v2 ignores `sp` and skips `session_props` events, counting them in `rejected`. The rest of the batch is stored.


## 7. App section API (dashboard, login required)

The dashboard's App section reads these endpoints, and your own tools can read them too. They count iOS sessions only (hostname `ios:<bundle id>`).

**Login.** `POST /api/auth/login` with `{ "password": "..." }` sets the `rt_auth` cookie (30 days). Send it with every call. Without it the answer is `401`.

**Query parameters**, the same as every dashboard endpoint:
- `period`: `today`, `yesterday`, `24h`, `48h`, `7d`, `30d` (default), `90d`, `12m`, `thisquarter`, `lastquarter`, `all`, or `custom` with `from` and `to` (`YYYY-MM-DD`, in the site's timezone). The two quarter periods are calendar quarters in the site's timezone; `thisquarter` ends now.
- `compare=previous`: the answer for the period the Overview compares with. That is the same length right before, or the previous quarter for the two quarter periods. The App tab reads the changes on its four headline numbers this way.
- `filters`: a JSON object, URL-encoded, of session filters: `channel`, `source`, `utm_campaign`, `utm_term`, `ref`, `country`, `app_version`, `entry_page`, `exit_page`, `page` (a screen path the session showed), `goal` (a goal it reached) and `prop:<key>` for a session property, for example `{"prop:exp_paywall_copy":"b","app_version":"1.4.0 (57)"}`. An empty string matches a missing value.

Sessions belong to the range by start time. Rates are `null` when their denominator is 0. "Small sample" means fewer than 100 sessions (or eligible installs) in that group; read its counts, not its rates. Panels that load single sessions stop at 50,000 sessions and 200,000 events and then answer `"truncated": true`.

| Endpoint | Extra parameters | Answer |
|---|---|---|
| `GET /api/sites/:id/app/onboarding` | `split=app_version` or `split=prop:<key>` | `appSessions`, `started` (sessions with any `onboarding_*` step goal), `completed`, `completionRate`, `skipped` (sessions that sent `onboarding_skip`, which is never a step), `steps[]`, and with a split `groups[]` (top 10 by started), each with the same fields plus `value` and `smallSample` |
| `GET /api/sites/:id/app/screens` | | `sessions` (with at least one screen), `screens[]` (top 50 by views: `screen`, `views`, `sessions`, `exits`, `next[]` with the top 5 `screen`, `count`, `share`), `exits[]` (top 20: `screen`, `exits`, `shareOfSessions`, `exitRate`) |
| `GET /api/sites/:id/app/paywall` | `split=source` (default), `app_version` or `prop:<key>` | `appSessions`, `paywallViews`, `purchaseStarts`, `purchases`, `startRate`, `purchaseRate`, `conversionRate`, `trials`, `trialsPaid`, `trialsEnded`, `trialsOpen`, `trialToPaid`, `trialRate`, `revenue`, `purchasesWithoutPaywall`, `trialsWithoutPaywall`, `groups[]` (the same funnel per group), `series[]` (`bucket`, `views`, `purchases`, `trials`) |
| `GET /api/sites/:id/app/versions` | `series=1` | `versions[]`, newest first: `version`, `sessions`, `onboardingStarted`, `onboardingCompleted`, `completionRate`, `paywallSessions`, `purchases`, `conversionRate`, `revenue`. With `series=1` also `series[]` (`bucket`, `version`, `sessions`) and `seriesTotals[]` (`bucket`, `sessions`) |
| `GET /api/sites/:id/app/experiments` | | `minSessionsPerArm` (100), `experiments[]`: `key`, `name`, `sessions`, `smallSample`, `control` (the control arm's variant), `arms[]` with the version fields plus `variant`, `purchaseStarts`, the trial fields of the Paywall panel (`trials`, `trialsPaid`, `trialsEnded`, `trialsOpen`, `trialToPaid`, `trialRate`), `revenuePerSession`, `smallSample`, `control` (true on the control arm) and `vsControl` (null on the control arm) |
| `GET /api/sites/:id/app/sources` | `dim=channel` (default), `source`, `campaign`, `ref`, `utm_source`, `keyword` | `rows[]`: `label`, `sessions`, `installIds`, `newUsers`, `sessionsWithUserState`, `purchases`, `revenue`, `conversionRate` |
| `GET /api/sites/:id/app/retention` | | `scope` ("installs with a persistent id"), `cohort`, `days[]` for day 1 and day 7 and `day30`: `day`, `eligible`, `returned`, `rate`, `smallSample`; `grid`: `weeks` (8), `cohortWeeks`, `cohortsShown` (12 at most), `cohorts[]` oldest first: `week` (the Monday, `YYYY-MM-DD`), `installs`, `cells[]` for weeks 1 to 8: `week`, `eligible`, `returned`, `rate` |
| `GET /api/sites/:id/app/properties` | | `appSessions`, `properties[]`: `key`, `sessions`, `values[]` (top 20 `value`, `sessions`) |
| `GET /api/sites/:id/app/onboarding-purchase` | | The headline funnel, see below: `appSessions`, `started`, `completed`, `paywall`, `purchaseStart`, `bought`, `trials`, `trialsPaid`, `trialsEnded`, `trialsOpen`, `trialToPaid`, `revenue`, `completionRate`, `paywallRate`, `purchaseRate`, `smallSample`, `boughtOutsideOnboarding`, `groups` (`user_state[]`, `plan[]`, `app_version[]`, `experiments[]` with `arms[]`), `within7Days`, `dropOff` |
| `GET /api/sites/:id/app/activation` | | `appSessions`, `activated`, `activationRate`, `withActivation` and `withoutActivation` (`sessions`, `purchases`, `purchaseRate`, `smallSample`), `what[]` (`value`, `sessions`) |
| `GET /api/sites/:id/asa` | | Apple Search Ads per campaign and keyword, see below: `configured`, `importedAt`, `lastDay`, `error`, `unmatched`, `from`, `to` (Apple's days), `currency`, `window`, `net` (`commission`, `fallback`, `products[]` with `product` and `share`), `hasSpend`, `totals`, `campaigns[]`, `keywords[]` (top 200), `notConverted[]` (`currency`, `amount`). Each row: `id`, `name`, `spend`, `taps`, `impressions`, `appleInstalls`, `installs`, `trials`, `trialsPaid`, `trialsEnded`, `paid`, `revenue`, `netRevenue`, `cpa`, `roas`, `netRoas`; keyword rows add `campaign`, `campaignName`, `adgroup`, `adgroupName` |
| `GET /api/sites/:id/asa/names` | | `campaign`, `adgroup`, `keyword`: objects from id to name, for the site's app |
| `GET /api/asa/status` | | `configured`, `importedAt` (ms), `lastDay`, `error` of the last Apple Search Ads import, and `unmatched[]` (`id`, `name`): apps the campaigns promote that no site has as its App Store id |
| `POST /api/asa/backfill` | JSON `from`, `to` (`YYYY-MM-DD`, default the last 90 days), `skip` | Imports up to 15 days per call, never older than 90 days: `imported` (`from`, `to`), `next` and `skip` to send back until `next` is null, `campaigns`, `keywords`, `error`. `400` without the `ASA_*` secrets |
| `GET /api/apps` | `period`, `from`, `to` | `minSessions` (100), `apps[]`, one per site with an `app_bundle_id`, most sessions first: `id`, `name`, `domain`, `bundleId`, `from`, `to`, `sessions`, `onboardingStarted`, `onboardingCompleted`, `completionRate`, `paywallSessions`, `paywallRate`, `purchases`, `purchaseRate`, `activated`, `revenue[]` (`currency`, `gross`, `refunds`, `net`, `payments`, `decimals`), `smallSample`. No filters; each site's range uses its own timezone. |

What the numbers mean:
- **Onboarding steps** are the `onboarding_*` goals, ordered by the `index` prop (the most common one per step). Steps without an index follow, by sessions; `onboarding_complete` is always last. Per step: `sessions` that reached it in any order, `shareOfStarted`, `dropOff` and `dropOffRate` against the step before, and `medianMsFromPrevious` over the sessions that reached both steps in order.
- **Screen flow** counts a screen shown twice in a row once. `exitRate` is the share of sessions that showed the screen and ended on it.
- **Paywall:** every count is sessions, not paywall views: a session that showed the paywall three times counts once. `paywallViews` is the number of app sessions with a `paywall_view` goal (debug and TestFlight builds included; the Drop-off view leaves them out), grouped by the `source` prop of its first view. `purchaseStarts` are views with a `purchase_start` goal, and `purchases` are views with a first purchase credited to the session: a verified App Store transaction, a Stripe payment or a RevenueCat purchase. Renewals and sandbox purchases are not counted. `trials` counts views with a `trial_start` signal credited to the session; a trial that converted also counts in `purchases`, through its first payment. Each trial's outcome comes from its subscription row, by the rule of the Subscriptions tab's trial to paid (docs/GUIDE.md "Subscriptions"): `trialsPaid` paid by the end of the trial plus 3 days, `trialsOpen` can still convert, `trialsEnded` the rest. A trial with only a signal and no subscription row has no outcome. `trialToPaid` is `trialsPaid / (trialsPaid + trialsEnded)`, null with nothing decided; `trialRate` is `trials / paywallViews`. `revenue` is in the site currency, App Store amounts gross. `purchasesWithoutPaywall` and `trialsWithoutPaywall` count sessions that bought or started a trial without a `paywall_view` goal.
- **Paywall outcomes** (also in `GET .../app/paywall`): `outcomes` counts app sessions with `purchase_start`, `purchase_cancelled`, `purchase_pending`, `purchase_failed` (with `failedReasons[]` by the `reason` prop), `restore_start` and `restore_success`. `bySource[]` groups the same goals by their own `source` prop and adds `paywallViews` and `purchases` (by the source of the first paywall view). `byProduct[]` groups them by the `product` prop and adds `purchases` and `revenue` by the product on the payment (`payments.product`, from the App Store transaction or RevenueCat). A session counts once per row. Rows under 100 sessions carry `smallSample`.
- **Onboarding to purchase:** among sessions that started onboarding (any `onboarding_*` goal), how many finished it, saw a paywall, pressed buy and bought, each counted if the session reached it in any order. Bought is a first purchase credited to the session (App Store, Stripe or RevenueCat; renewals and sandbox not counted); `trials` counts sessions with a `trial_start` signal (an App Store free-trial transaction from the SDK or a notification, or a RevenueCat trial), with `trialsPaid`, `trialsEnded`, `trialsOpen` and `trialToPaid` as in the Paywall panel. `groups` splits the same counts by the session properties `user_state` and `plan`, each `exp_*` property and the app version, keeping only groups with started onboarding; `smallSample` means fewer than 100 started. `boughtOutsideOnboarding` counts sessions that bought without starting onboarding.
- **Within 7 days** (`within7Days`, consented installs only): installs with `ctx.consent` or `ctx.id: "vendor"` that finished onboarding in a session in the range, and how many made a first purchase from the start of that session to 7 days after the first `onboarding_complete`. `eligible` counts installs whose 7 days are over, `windowOpen` the others, `finished` both. Without consent the id changes per launch, so later purchases cannot be linked; read it as the consented installs' number only.
- **Drop-off** (`dropOff`): the stages in order are the onboarding positions (steps sharing an `index` form one position, labelled `Step <index>: <names>`; steps without an index follow by name), then `complete`, `paywall`, `purchase_start` and `bought`. Per stage: `reached` (sessions that reached it in any order), `shareOfStarted`, and `stoppedHere`, the sessions whose furthest stage it was (null for `bought`). A skipped step does not count against a session that reached a later one. `worst` is the stage with the most `stoppedHere` (ties: the one fewer sessions reached), or null.
- **Activation:** sessions with an `activation` goal, and the share of sessions with a first purchase among those with and without it. `what` lists the `what` prop.
- **All apps:** sessions, onboarding and paywall counts as in the panels above, without filters. `purchases` counts sessions with a first purchase. `revenue` is in the site's currency, with payments in other currencies converted at the ECB rate of the payment day; a payment not converted yet stays in its own currency, never summed with another: every payment and refund in the range from the App Store or RevenueCat, plus Stripe and API payments credited to an app session, renewals included, sandbox left out. App Store sales follow the revenue definition: Apple's report on imported days (gross, refunds as negative units, units sold in `payments`), payment rows on the others. `gross` is before refunds and before the store's commission; `net` is after refunds.
- **Paywall over time** (`series`): one point per bucket of the range (hours, days, weeks or months, like the dashboard's charts). `views` counts the paywall sessions by the time of their first `paywall_view`, and `purchases` and `trials` are those of them that bought or started a trial, so the points add up to `paywallViews`, `purchases` and `trials`. A view after the range ends, in a session that started inside it, counts in the last point.
- **Version adoption** (`series=1`): app sessions per bucket for the 5 versions with the most sessions in the range, a tie going to the newer version, with a point in every bucket for each. `seriesTotals` counts every version per bucket. One more D1 statement, a `GROUP BY` over the range's app sessions; without `series=1` it doesn't run.
- **Versions** and **experiments**: `completionRate` is completed over started onboarding, and `conversionRate` is sessions with a first purchase over all sessions in the group. `paywallSessions` counts sessions with a `paywall_view` goal, as in the Paywall panel. An arm's `revenue` is its first payments to date, trial conversions included, gross; `revenuePerSession` is that over the arm's sessions, minor units.
- **Experiment results:** the control arm is the one named `control`, `baseline`, `default`, `original`, `off` or `a` (any case), else the first arm in alphabetical order. Analytics > Experiments says which rule picked it (`control_reason`). Each other arm's `vsControl` compares its `conversionRate` with the control's in a pooled two-proportion z-test, two-sided: `difference` (arm minus control, a fraction), `z`, `pValue`, `verdict` and `sampleNeededPerArm`. `verdict` is `likely` (p under 0.05, a real difference at 95%), `not_yet` (not enough evidence) or `small_sample` (the arm or the control has fewer than 100 sessions; read the counts). `sampleNeededPerArm` is the sessions per arm that a difference of the observed size needs at 95% significance and 80% power, null when the rates are equal. Example: 19 of 639 against 35 of 638 gives `z` 2.231 and `pValue` 0.0257. With several arms, about 1 comparison in 20 reads as `likely` by chance.
- **Sources:** `installIds` are distinct visitor ids. Without consent that is one per device and day (section 3), not one per install. `newUsers` counts sessions with the property `user_state = new`, which the app sets from its own data; `sessionsWithUserState` says how many sessions carried that property at all. Apple Search Ads installs have the source "Apple Search Ads", with the campaign id as campaign. With `dim=campaign` or `dim=keyword`, a row whose id the Apple Search Ads import knows also has `name`; `label` stays the id, the value to filter by. The breakdowns of `GET /api/sites/:id/breakdown` (`campaign`, `keyword`, `utm_content`) do the same. Links opened through `handle(url:)` carry their `utm_*` and `ref` values.
- **Apple Search Ads** (`GET .../asa`, docs/GUIDE.md "Apple Search Ads"): `spend`, `taps`, `impressions` and `appleInstalls` are Apple's, summed over Apple's UTC days that match the period's days. `from` and `to` are those days, in the site's timezone. Apple has no spend for today, so a rolling period that reaches into today (`today`, `24h`, `7d`, `30d`, `90d`, `12m`) moves back one day: `30d` is the 30 days up to yesterday. A period with a fixed start (`custom`, `thisquarter`, `all`) stops at yesterday. Installs are the sessions that started in those same days. The phone's "Since yesterday" (docs/MOBILE-API.md, section 7) and the site's Overview read these totals for `30d`, so spend, cost per paid and ROAS match everywhere. `spend` is in minor units of the site currency, each day converted at the ECB rate; spend in a currency without a rate is in `notConverted` and left out. `installs` counts install ids of sessions in the range with the source Apple Search Ads, grouped by `utm_campaign` and `utm_term`; `trials` counts those sessions with a `trial_start` signal. `trialsPaid` and `trialsEnded` count the sessions whose trial, from their subscription row, turned paid or ended unpaid; a trial still running or without a subscription row is in neither, so trial to paid is `trialsPaid / (trialsPaid + trialsEnded)`. `paid` counts the ones with a first purchase, and `revenue` every payment credited to them up to now, renewals and refunds included. `window=7`, `14` or `30` counts trials, first purchases and payments only within that many days of the session's start (`window` in the answer, 0 = to date; any other value is 0). `netRevenue` is `revenue` after Apple's cut on App Store payments (docs/GUIDE.md "Apple's cut"): Apple's proceeds ratio per product from the sales import, else 1 minus the site's `app_commission`; `net` lists the shares. `cpa` is `spend / paid`, `roas` is `revenue / spend` and `netRoas` is `netRevenue / spend`, all null without spend. A campaign belongs to the site when its app is the site's `asc_app_id` (found by the App Store sales import) or `app_store_id` (entered in Settings, `PATCH /api/sites/:id` with `app_store_id`, digits). `unmatched[]` (`id`, `name`) lists the promoted apps no site has; their spend shows nowhere. A keyword row with `id: null` holds installs without a keyword (Search Match). Rows with installs but no imported numbers have `spend: null`.
- **Retention** covers installs with a persistent id: users who agreed (`ctx.consent`, section 1) and apps that use the vendor install id (`ctx.id: "vendor"`), first seen in the range, with an app session there that matches the filters. Day 1 is a session 24 to 48 hours after the install was first seen, day 7 one 7 to 8 days after, day 30 one 30 to 31 days after. An install is `eligible` once its day is over. The grid groups the cohort by the site-timezone Monday week of its first open; week k of a cohort is days 7k to 7k + 6 after each install's first open, and a cell counts installs whose week k is over. It reads at most 8 weeks of sessions after the range. It never covers per-launch installs without consent, so never read it as the retention of all users.

### Drop-off: `GET /api/sites/:id/dropoff`

Where people stop before buying, on the website and in the app of one site, in one answer. Unlike the endpoints above it counts web and app sessions. It works for sites without an app too. Login, `period` and `filters` as above. It writes nothing.

| Parameter | Values |
|---|---|
| `platform` | `all` (default), `web` or `app`. Web sessions are those whose hostname does not start with `ios:`. |
| `split` | `platform`, or for app sessions only `user_state`, `app_version` or `prop:<key>`. Without it `groups` is empty. |
| `include_test` | `1` counts app sessions whose session property `build_channel` is `debug` or `testflight`. By default they are left out. |

Answer:
- `platform`, `split`, `includeTestBuilds`, `testSessions` (app sessions from debug or TestFlight builds in scope, counted or not), `hasApp`, `minSessions` (100), `currency`, `truncated`.
- `columns[]`: with `platform=all` three columns, `all`, `web` and `app`; otherwise the one asked for. Each has `platform`, `noData` (`null`, `"no_sessions"` or `"no_app"` for a site without `app_bundle_id`), `sessions`, `smallSample` (under 100 sessions), `stages` and `worst`. A column with `noData` has `stages: null` and no counts, so a missing platform never reads as 0. Columns with data also carry `flowStart`, `entered` (sessions that reached any stage past Sessions, in any order), `paywall`, `purchaseStart`, `bought`, `revenue` (site currency), `flowRate`, `boughtOfFlow`, `conversionRate`.
- `stages[]`, in order `sessions`, `flow_start`, `paywall_view`, `purchase_start`, `bought`: `key`, `label` (the dashboard shows Sessions, Entered the flow, Reached the paywall, Reached a purchase and Bought, because a stage also counts sessions that got further without its goal), `reached` (sessions whose furthest stage is this one or a later one, so it never grows from one stage to the next), `shareOfStart` (of all sessions in the column), `shareOfPrevious`, `stoppedHere` and `stoppedShareOfStart` (null for `bought`).
- `worst`: `key`, `label`, `stoppedHere`, `shareOfFlow` (`stoppedHere` divided by `entered`, so at most 1), or null.
- `groups[]` for the split: `value` and the column counts, `smallSample`. Top 20; app versions newest first. These counts are the sessions that sent each goal (`flowStart` sent `flow_start`, and so on), not the stages, so they can be lower than a stage's `reached`.
- `blockerGoals`: the failure goals the view counts: `purchase_failed`, `purchase_cancelled`, and any goal whose name ends in `_failed`, `_error` or `_invalid` (listed as `*_failed`, `*_error`, `*_invalid`).
- `blockers[]`, only goals that occurred, most sessions first: `goal`, `sessions`, `bought`, `stillBoughtShare`, `web` and `app` (`{ sessions, bought }`, or null when that platform has no sessions in scope), `smallSample`, and `reasons[]` (top 20) with the same fields plus `reason` and `step` (null when the goal had none).
- `exits`: `scope` ("started the flow, did not buy"), `web` and `app`, each null without sessions or `{ sessions, pages[] (top 20: page, sessions, share), smallSample }`. App pages are screen paths (`/` + screen name).
- `flowExits`: null without app sessions, else `{ sessions, steps[] (step, sessions, bought), smallSample }` from the `flow_exit` goal's `step` prop.

What the numbers mean:
- A session reaches a stage when it sent the goal (`flow_start`, `paywall_view`, `purchase_start`) in any order, or, for `bought`, when a first purchase is credited to it. Its furthest stage is where it stopped, so a skipped stage does not count against a session that reached a later one.
- **Bought** is a payment credited to the session that is not a renewal and not sandbox, from any provider. For app sessions that matches the App section (App Store, Stripe through `rt_visitor_id` metadata, RevenueCat); web sessions can also have Dodo or API payments. A session with two payments counts once.
- **Worst** is the stage among `flow_start`, `paywall_view` and `purchase_start` with the most `stoppedHere` (ties: the one fewer sessions reached). The `sessions` stage is not ranked: most sessions never start the flow, so it would always win.
- **Blockers** count sessions, once per goal and once per reason and step. `bought` among them is how many still made a first purchase.
- Sessions belong to the range by start time, like the other panels; the same caps apply (50,000 sessions, 200,000 goals, then `truncated`).

The overview (`GET /api/sites/:id/overview`) reads per platform with the filter `{"platform":"Web"}` or `{"platform":"iOS"}`. With it, revenue counts only payments credited to a session of that platform; payments credited to no session appear only in the unfiltered total.

On a site with an app the overview also returns `newInstalls` and `consentedInstalls` in `current` and `previous`: installs with consent (`ctx.consent`, section 1) or a `.vendor` id (`ctx.id`) and an app session in the range that matches the filters, `newInstalls` only those first seen in the range. The dashboard shows New installs next to Visitors on an app-only site and with the App filter. Without consent the server knows a device for one day only (section 3), so those installs cannot be told apart from returning ones and are not counted. App Store Connect and RevenueCat count every install.

## 8. RevenueCat webhook: `POST /api/webhooks/revenuecat/:siteId`

For apps that sell through RevenueCat.

**Setup.** In RevenueCat, open the project, then Integrations, Webhooks, and add the URL above. Set the webhook's Authorization header value to a random string of 16 to 200 characters without spaces, and store the same string in FounderData: Settings, Connect RevenueCat, or `PATCH /api/sites/:id` with `{ "revenuecat_auth": "<secret>" }` (a leading `Bearer ` is removed, an empty string clears it, `GET` shows it masked). The server accepts the header as the bare secret or as `Bearer <secret>`.

**Visitor link.** The app sets the subscriber attribute `founderDataVisitorId` to `FounderData.appAccountToken.uuidString.lowercased()` before each purchase. `FounderData.revenueCatAttributes` is that dictionary:

```swift
Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes)
```

Set it after configuring RevenueCat, after `Purchases.shared.logIn`, after `FounderData.reset()` and before each purchase. [../ios/README.md](../ios/README.md), "Using RevenueCat", has a purchase function with the paywall goals.

RevenueCat reserves attribute keys that start with `$` for its own attributes, so the key has no `$`. The server also reads `$founderDataVisitorId`. Without the attribute, the payment links like an App Store notification: through an earlier payment of the same subscription (`customer_id`). Without consent the id changes on every launch, so a renewal carries the id of the last launch that set it. The server follows that id to its grouped visitor while the alias exists (section 3). Renewals never count as first purchases, so the App panels are not affected.

**Answers.** `404` unknown site, `400` no secret configured or a body without `event`, `401` a wrong or missing Authorization header. Everything else is `200`, so RevenueCat stops retrying: `{ "ok": true, "result": ... }` with `recorded`, `duplicate`, `trial`, `signal`, `refund`, `no_original` or `free`, or `{ "ok": true, "ignored": "<type>" }` for types the server does not handle (`TEST`, `TRANSFER`, `SUBSCRIPTION_PAUSED`, ...), `"sandbox"` for sandbox events on a site with `accept_sandbox` off, and `"invalid"` for an event without an id.

**Event mapping.**

| `event.type` | What the server stores |
|---|---|
| `INITIAL_PURCHASE`, `RENEWAL`, `NON_RENEWING_PURCHASE` | A payment row, provider `revenuecat`: `price_in_purchased_currency` in `currency`, converted to the currency's minor unit, gross like App Store amounts. With `period_type: TRIAL` it is a trial start instead (a `trial_start` signal, no payment). A price of 0 stores nothing (`free`). |
| `PRODUCT_CHANGE` | A `product_change` signal with `new_product_id`. When it carries a positive price and a transaction id, also a payment, deduplicated like the others. |
| `CANCELLATION` | A `cancellation` signal with `cancel_reason`. Not money. |
| `CANCELLATION` with `cancel_reason: CUSTOMER_SUPPORT` or a negative price, or `REFUND` | A refund: a negative row (`apple_refund_<transaction_id>` for the App Store) for the payment it takes back, linked like that payment. A refund for a payment the site never recorded answers `no_original` and changes nothing. |
| `EXPIRATION`, `BILLING_ISSUE` | An `expiration` (with `expiration_reason`) or `billing_issue` signal. |

**Ids and deduplication.** For `store` `APP_STORE` or `MAC_APP_STORE` the payment id is `apple_<transaction_id>` and the customer id `apple:<original_transaction_id>`, the same ids the SDK's purchase event and App Store Server Notifications use. So a purchase reported through the SDK JWS and through RevenueCat is one row; whichever arrives second can only fill in a missing visitor. Other stores get `rc_<store>_<transaction_id>` and the customer id `rc:<original_app_user_id>`. Signals are keyed by the RevenueCat event id, so a retried delivery writes nothing.

**Renewals.** `renewal = 1` for a `RENEWAL` that is not a trial conversion (`is_trial_conversion`), and for any payment after an earlier one of the same customer. The paid conversion after a trial counts as the first purchase.

**Sandbox.** `environment: SANDBOX` is ignored unless the site's `accept_sandbox` is on; then payments use provider `app_store_sandbox` and signals carry `sandbox = 1`, and neither ever counts.

**Signals** live in the table `subscription_signals` (`type`: `trial_start`, `cancellation`, `expiration`, `billing_issue`, `product_change`), with the visitor and the session credited the same way as a payment. The retention cron deletes them after 24 months (`RETENTION_MONTHS`), like events.
