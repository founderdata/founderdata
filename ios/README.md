# FounderDataKit

A Swift package that sends screens, goals, sessions and App Store purchases
from an iOS app to a FounderData Worker. It has no dependencies beyond Apple's
frameworks and needs iOS 17 and Xcode 26 or later. It never reads the IDFA,
and by default it stores nothing on the device.

In Xcode, choose File > Add Package Dependencies, paste
`https://github.com/founderdata/founderdata`, choose Up to Next Major Version
from 1.0.0 and link `FounderDataKit` to the app target. Then follow the path
that matches how your app sells.

FounderData core records every event the SDK sends and credits each purchase
to its session's source. The App section, with the onboarding funnel, the
paywall split, retention and experiments, is a report in FounderData Pro
([docs/PRO.md](../docs/PRO.md)). Passages below that describe it say so.

Both paths need the app's bundle id in FounderData first. Add the app on Home
with "+ Add site or app", or enter the bundle id in the site's Settings,
General. Until then the server refuses the app's events.

## Using RevenueCat

Three steps in the app:

1. Configure both SDKs and link them. `FounderData.revenueCatAttributes` sets
   the subscriber attribute `founderDataVisitorId`, which ties each RevenueCat
   purchase to the app session it came from.

   ```swift
   import RevenueCat
   import FounderDataKit

   init() {
       FounderData.configure(siteId: "SITE_ID", host: "https://founderdata.example.com")
       Purchases.configure(withAPIKey: "appl_...")
       Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes)
   }
   ```

2. Set the attribute again after `Purchases.shared.logIn`, after
   `FounderData.reset()` and before each purchase. The id changes at those
   points, and without consent or `.vendor` on every launch.
3. Call `FounderData.paywallViewed(source: .onboarding)` when the paywall
   appears, and buy through `FounderData.trackPurchase`:

   ```swift
   func buy(_ package: Package, source: FounderData.PaywallSource) async throws {
       Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes)
       try await FounderData.trackPurchase(product: package.storeProduct.productIdentifier, source: source) {
           let result = try await Purchases.shared.purchase(package: package)
           return result.userCancelled ? .cancelled : .purchased
       }
   }
   ```

   It sends `purchase_start`, runs your closure, and sends the goal for what
   the closure returns, the same goals as `FounderData.purchase` for StoreKit.
   A RevenueCat error is reported and thrown again unchanged:
   `purchaseCancelledError` as `purchase_cancelled`, `paymentPendingError`
   as `purchase_pending`, `networkError` as `purchase_failed` with reason
   `network`, any other as `purchase_failed` with reason `store`. FounderDataKit
   reads RevenueCat's error domain and codes, so it needs no RevenueCat
   dependency. The closure runs on the caller's actor, so it can unlock
   content from `result.customerInfo` before it returns.

On the server: in FounderData, open the site's Settings, Payments, RevenueCat.
Add the webhook URL shown there in RevenueCat under Integrations, Webhooks,
and set the same Authorization secret in both places. The webhook reports
purchases, renewals, refunds, trial starts and cancellations, so you skip App
Store Server Notifications. [docs/APP-API.md](../docs/APP-API.md), section 8,
has the details.

What you get: every RevenueCat purchase and renewal on the dashboard,
credited to the app session it happened in and to that session's source,
such as a campaign link, Apple Ads or a visit to your website. In Pro, the
App section shows paywall views, buy starts, cancels and failures per paywall
source and per product, next to the onboarding funnel. A purchase that also
arrives from the App Store counts once.

## Using StoreKit 2

Three steps in the app:

1. Configure the SDK and listen for transactions:

   ```swift
   import FounderDataKit

   init() {
       FounderData.configure(siteId: "SITE_ID", host: "https://founderdata.example.com")
       FounderData.observeTransactions()
   }
   ```

2. Buy through `FounderData.purchase` instead of `product.purchase`:

   ```swift
   let result = try await FounderData.purchase(product, source: .onboarding)
   if case .success(.verified(let transaction)) = result {
       // deliver the content
       await transaction.finish()
   }
   ```

   It adds the `appAccountToken`, sends `purchase_start` and the outcome
   goal, reports the verified transaction and returns StoreKit's result
   unchanged.
3. Call `FounderData.paywallViewed(source: .onboarding)` when the paywall
   appears.

On the server: in App Store Connect, open App Information, App Store Server
Notifications, and set
`https://founderdata.example.com/api/webhooks/apple/SITE_ID` as the Production
URL, Version 2. Renewals and refunds that happen while the app is closed
arrive this way. If your backend already owns that URL, forward the raw body,
see "App Store Server Notifications".

What you get: every purchase, renewal and refund on the dashboard, credited
to the app session and its source, and the same paywall and purchase panels
as above. FounderData checks Apple's signature on each transaction, so the app
holds no secret.

The full checklist, with screens, onboarding, links and sign-out, is under
"Integration steps".

## Requirements

- iOS 17 or later. The package supports iOS only.
- Xcode 26 or later. `Package.swift` declares `swift-tools-version: 6.2`, and
  Swift 6.2 ships with Xcode 26. Older Xcode versions cannot resolve the
  package.
- The package compiles in the Swift 6 language mode. Your app can use either
  language mode.

## Storage and consent

The SDK never reads the IDFA, never shows the App Tracking Transparency
prompt and does no fingerprinting. By default it stores nothing on the
device: each app launch gets a random id that lives in memory, and that id is
all FounderData uses to tell launches apart. With the user's consent the id goes
to the Keychain and lasts for the install. Without consent, `installId:
.vendor` keeps one id per install from a hash of `identifierForVendor`, see
below.

In the EU, Article 5(3) of the ePrivacy Directive, the rule behind cookie
banners, needs the user's consent before an app stores information on the
device or reads information stored there. The only exception is storage that
is strictly necessary for a service the user asked for, and analytics is not.
The web script is cookieless for the same reason.

So without consent, FounderDataKit writes nothing to the Keychain, to files or to
UserDefaults, and reads nothing from them:

- The install id and the session id are random for each app launch and live in
  memory.
- The event queue lives in memory. The SDK sends it when the app goes to the
  background, under a background task so iOS lets the upload finish. Events
  still unsent when the app is terminated are lost.
- `isEnabled` and the consent flag live in memory too. The app stores its own
  settings and passes them in on each launch.

The server groups these launches so the numbers stay clean. Launches of one
device on one UTC day count as one visitor, the way the web script counts
cookieless visitors: the server builds a daily key from the IP, the user
agent, the device model, the iOS version and the locale, and stores only the
key. A launch within 30 minutes of the last activity continues the session.
The SDK changes nothing for this, and nothing more is stored on the device
(`docs/APP-API.md`, section 3).

What this costs: the next day the same device counts as a new visitor, so
returning users, retention and time to convert reach back one day only. The
`.vendor` mode below changes that. A purchase still
links to the visitor of the launch it happened in, through `appAccountToken`, and renewals
link to the first purchase through Apple's original transaction id. The SDK
asks for the Apple Ads token on every launch, because it cannot remember that
it already did, so each launch of an Apple Ads install is credited to the
campaign.

With consent, call `FounderData.setConsent(true)`. The SDK then keeps the install
id in the Keychain and the queue in `Application Support/FounderData/state.json`.
If the device already holds an id from an earlier consent, events continue
under it; otherwise the current launch's id is stored, so the visit goes on
unbroken. `FounderData.setConsent(false)` deletes the Keychain item and the queue
file and continues in memory under a new random id.

The SDK does not remember consent. Store the user's choice in the app and pass
it in before `configure` on every launch:

```swift
init() {
    FounderData.setConsent(settings.analyticsConsent)   // your app's own stored choice
    FounderData.configure(siteId: "SITE_ID", host: "https://founderdata.example.com")
}
```

### One id per install without consent

```swift
FounderData.configure(siteId: "SITE_ID", host: "https://founderdata.example.com", installId: .vendor)
```

With `.vendor` the install id is the same on every launch, so returning
users, retention and New installs also cover the users who never saw a
consent prompt. The SDK still writes nothing to the device. On each launch it
reads `UIDevice.current.identifierForVendor` and sends a hash of it:

- The id is the first 16 bytes of SHA-256 over a fixed prefix, the site id
  and the vendor id, sent as a UUID so it works as `appAccountToken`. The raw
  `identifierForVendor` never leaves the device.
- The site id is part of the hash. Two of your apps that report to two
  FounderData sites send unrelated ids, and the ids go only to your own Worker.
- iOS issues a new `identifierForVendor` after the user removes every app of
  your team from the device. A reinstall after that counts as a new install.
- Right after a restart, before the first unlock, iOS may have no
  `identifierForVendor` yet. That launch uses a random id.
- Each batch under the vendor id carries `"id": "vendor"` in `ctx`, and the
  server counts the install for retention, as it does for consent.
- `reset()` switches to a random id until the app quits. The next launch is
  back under the vendor id, so on a device shared by several accounts the
  launches of all of them land on one install. Use consent in that case.
- Consent still wins. After `setConsent(true)` the SDK uses the Keychain id;
  on the first consent it stores the vendor id there, so the install keeps
  its id. `setConsent(false)` continues under the vendor id.

The trade-off:

- It is an identifier. Declare Device ID in the App Store privacy label, see
  the table under "Privacy manifest and App Store privacy label", and name it
  in your privacy policy.
- It is not tracking in Apple's sense. It stays within your team's apps, is
  never combined with other companies' data and needs no App Tracking
  Transparency prompt.
- The ePrivacy rule above covers reading information from the device as well
  as storing it, and `identifierForVendor` is information iOS keeps on the
  device. Whether your app may read it for analytics without consent is a
  legal call for you to make, and the SDK does not make it. Keep the default,
  `.perLaunch`, if you follow the strict reading.

## Before the first launch

Give FounderData the app's bundle id. When you add the app, the dashboard asks
for it: on Home, choose "+ Add site or app", then iOS app (or website and
app). For a site you added earlier, enter it in Settings, General. It is
stored as the site's `app_bundle_id`. Until it is set, the server answers
`403` to every upload and rejects every App Store notification. The SDK drops a batch that gets a `403` and does not retry it,
so events sent before the setting exists are lost.

## Add the package

In Xcode, choose File > Add Package Dependencies and paste
`https://github.com/founderdata/founderdata`. Then link `FounderDataKit` to the app
target. A local checkout works too: add its `ios` folder.

In the dependency rule menu, choose Up to Next Major Version from 1.0.0. In a
`Package.swift`:

```swift
.package(url: "https://github.com/founderdata/founderdata", from: "1.0.0")
```

Read [CHANGELOG.md](CHANGELOG.md) before you update. "Versions" has the
policy.

## Integration steps

1. Add the package and link `FounderDataKit` to the app target.
2. In `App.init()`, call `FounderData.configure(siteId: "SITE_ID", host: "https://founderdata.example.com")`.
   If the user consented to on-device storage, call `FounderData.setConsent(true)` before it (see above).
3. Right after that, call `FounderData.observeTransactions()` to catch renewals and purchases made on other devices.
4. On the root view, add `.onOpenURL { FounderData.handle(url: $0) }` so links can carry campaign data.
5. On each screen, add `.founderDataScreen("Settings")`, or call `FounderData.screen("Settings")` yourself.
6. Right after `configure`, call `FounderData.setSessionProperties(["user_state": ...])` with what the app knows
   about this launch, and `FounderData.experiment(...)` for each running experiment (see below).
7. At each onboarding step, call `FounderData.onboardingStep(1, "welcome")`, `FounderData.onboardingStep(2, "name")`
   and so on. When onboarding ends, call `FounderData.onboardingComplete()`.
8. Buy with `FounderData.purchase(product, source: .onboarding)`. It adds `appAccountToken`, sends the purchase
   goals and reports the verified transaction.
9. When a paywall appears, call `FounderData.paywallViewed(source:)`. The other helpers are under "Paywall and
   purchase goals" below.
10. On sign-out, call `FounderData.reset()`.
11. Point App Store Server Notifications at FounderData, or forward them from your backend, as described below.

RevenueCat apps replace step 8 with `FounderData.trackPurchase` and skip step 11, see "Using RevenueCat".

The same in code:

```swift
import FounderDataKit

@main struct MyApp: App {
    init() {
        FounderData.configure(siteId: "SITE_ID", host: "https://founderdata.example.com", debugHost: "http://localhost:8787")
        FounderData.observeTransactions()
    }
    var body: some Scene {
        WindowGroup { RootView().onOpenURL { FounderData.handle(url: $0) } }
    }
}

func buy(_ product: Product) async throws {
    let result = try await FounderData.purchase(product, source: .settings)
    if case .success(.verified(let transaction)) = result {
        // deliver the content
        await transaction.finish()
    }
}
```

`debugHost` applies only when the app is built in the Debug configuration.
Release builds always use `host`. See "Checks in `configure`" for what a
Debug build stops on.

## Naming

Screens become page views with the path `/` plus the name, so
`FounderData.screen("Onboarding/Step2")` shows up as `/Onboarding/Step2`. Use
stable names, not titles that change with the language.

Name onboarding steps the same way in every app, so one funnel works across
all your apps: `onboardingStep(1, "welcome")`, `onboardingStep(2, "name")`
and so on, and `onboardingComplete()` when the user reaches the main screen
for the first time. Apps that already send `FounderData.goal("onboarding_<step>")`
keep working; those goals show up in the funnel after the numbered steps.

Goal properties are strings: `FounderData.goal("paywall_view", props: ["variant": "b"])`.
The SDK keeps up to 20 properties per goal and about 1,000 characters in
total, which is what the server stores. It drops the rest.

## Session properties and experiments

Without consent the SDK cannot tell a returning user from a new one, but the
app usually can: it has an account, a finished onboarding or saved data.
Pass that in, together with the variants the launch shows:

```swift
FounderData.setSessionProperties([
    "user_state": store.hasCompletedOnboarding ? "returning" : "new",
    "build_channel": isTestFlight ? "testflight" : "app_store",
])
FounderData.experiment("onboarding", variant: "short")   // sets exp_onboarding = short
FounderData.experiment("paywall_copy", variant: "b")     // sets exp_paywall_copy = b
```

- A session keeps at most 10 properties. Keys become lowercase `a-z`, `0-9`
  and `_` with at most 40 characters; values are cut at 100 characters. An
  empty value removes the key.
- Each call merges into the properties set so far. They go on the current
  session and every later session of this launch. Nothing is stored on the
  device, so set them again on every launch.
- Set them right after `configure`, before the first screen, and they ride on
  the session's first event at no extra cost. A change later in the session
  sends one small event with the full set; setting the same values again
  sends nothing.
- In Pro, the dashboard's App section splits the onboarding funnel, the
  paywall conversion and the versions by any property.
- In Pro, every `exp_*` property is an experiment in Analytics >
  Experiments, next to the website's experiments. Its arms count installs:
  each install once, in the version of its first session with the
  property, with the sessions shown beside them. A buyer is an install that
  bought in a session with the property. Without consent or the `.vendor`
  install id the server knows a device for one day only, so the same person
  counts again the next day. The control is the version named `control`,
  `baseline`, `default`, `original`, `off` or `a`, else the first name in
  alphabetical order; the experiment's page says which. A difference in
  buyers gets a verdict once each version has 100 installs and 30 buyers.
  Name your control `control` so the rule never guesses. The App section's
  experiments card keeps counting sessions.

Keep values to a handful per key. A user id or a timestamp as a value makes
every session its own group, and the splits say nothing.

## Onboarding

```swift
FounderData.onboardingStep(1, "welcome")
FounderData.onboardingStep(2, "name")
FounderData.onboardingStep(3, "notifications")
FounderData.onboardingComplete()
```

`onboardingStep(_:_:)` sends the goal `onboarding_<name>` with the props
`step` and `index`. In Pro, the dashboard builds the funnel from these goals
in `index` order, with the drop-off and the median time between steps.
`onboardingComplete()` sends `onboarding_complete`. Number the steps in the
order the user sees them. When a variant skips a step, keep the numbers of
the other steps, so both variants line up in one funnel.

`.founderDataScreen` and `FounderData.screen` stay as they are. In Pro, the App
section shows the screen flow from them.

## Paywall and purchase goals

In Pro, the App section's paywall panels and the Drop-off view read a fixed set of
goal names from [docs/APP-EVENTS.md](../docs/APP-EVENTS.md). Each has a
helper, so a typo cannot leave a panel empty:

| Helper | Goal | Props |
|---|---|---|
| `paywallViewed(source:paywall:)` | `paywall_view` | `source`, `paywall` if passed |
| `purchaseStarted(product:source:)` | `purchase_start` | `source`, `product` |
| `purchaseCancelled(product:source:)` | `purchase_cancelled` | `source`, `product` |
| `purchasePending(product:source:)` | `purchase_pending` | `source`, `product` |
| `purchaseFailed(product:source:reason:)` | `purchase_failed` | `source`, `product`, `reason` |
| `restoreStarted(source:)`, `restoreSucceeded(source:)` | `restore_start`, `restore_success` | `source` |
| `onboardingSkipped(at:)` | `onboarding_skip` | `step` |
| `flowStarted()`, `flowExited(at:)` | `flow_start`, `flow_exit` | `step` on `flow_exit` |
| `activation(_:)` | `activation` | `what` if passed |
| `permissionPrompted(_:)` | `permission_<kind>_prompt` | none |
| `permissionAnswered(_:result:)` | `permission_<kind>` | `result`: `granted`, `denied` or `limited` |

`source` is a `FounderData.PaywallSource`: `.onboarding`, `.settings`,
`.featureGate`, `.gate("stats")` for `gate_stats`, or any string literal.
`product` is the App Store product id. `reason` is `.network`, `.store`,
`.verification` or `.other`; `PurchaseFailureReason(error)` picks one from a
StoreKit error. `FounderData.goal(_:props:)` still sends any name.

### The purchase wrapper

`FounderData.purchase(_:source:options:)` is the default way to buy with
StoreKit 2. It passes your `options` to `product.purchase(options:)` with
`.appAccountToken(FounderData.appAccountToken)` added, sends `purchase_start`,
then one goal for the outcome:

| StoreKit answers | Goal |
|---|---|
| `.success`, verified | none: `track(purchase:)` sends the transaction |
| `.success`, unverified | `purchase_failed`, reason `verification` |
| `.userCancelled`, or throws `StoreKitError.userCancelled` | `purchase_cancelled` |
| `.pending` (Ask to Buy, Strong Customer Authentication) | `purchase_pending` |
| throws any other error | `purchase_failed`, reason from `PurchaseFailureReason(error)` |

It returns StoreKit's result unchanged and throws StoreKit's error again
after reporting it, so your code delivers the content and calls `finish()` as
before. Leave `.appAccountToken` out of `options`: FounderData adds its own, and
renewals are credited through it.

```swift
func buy(_ product: Product, source: FounderData.PaywallSource) async {
    do {
        let result = try await FounderData.purchase(product, source: source)
        if case .success(.verified(let transaction)) = result {
            // deliver the content
            await transaction.finish()
        }
    } catch {
        // StoreKit's error; FounderData already sent purchase_failed or purchase_cancelled
    }
}
```

### Calling StoreKit yourself

If you call `product.purchase` yourself, for example
`purchase(confirmIn:options:)` for a particular scene, this buy button sends
the same goals as the wrapper:

```swift
func buy(_ product: Product, source: FounderData.PaywallSource) async {
    FounderData.purchaseStarted(product: product.id, source: source)
    do {
        let result = try await product.purchase(options: [.appAccountToken(FounderData.appAccountToken)])
        switch result {
        case .success(let verification):
            FounderData.track(purchase: verification)
            if case .unverified(_, let error) = verification {
                FounderData.purchaseFailed(product: product.id, source: source, reason: .init(error))
            }
            // deliver the content and call finish() as before
        case .userCancelled:
            FounderData.purchaseCancelled(product: product.id, source: source)
        case .pending:
            FounderData.purchasePending(product: product.id, source: source)
        @unknown default:
            break
        }
    } catch {
        FounderData.purchaseFailed(product: product.id, source: source, reason: .init(error))
    }
}
```

### RevenueCat or your own purchase code

`FounderData.trackPurchase(product:source:_:)` wraps any purchase call. It sends
`purchase_start`, runs your closure, and sends the goal for the
`FounderData.PurchaseOutcome` the closure returns:

| The closure | Goal |
|---|---|
| returns `.purchased` | none: the transaction arrives through `track(purchase:)`, App Store Server Notifications or the RevenueCat webhook |
| returns `.cancelled`, or throws RevenueCat's `purchaseCancelledError` or `StoreKitError.userCancelled` | `purchase_cancelled` |
| returns `.pending`, or throws RevenueCat's `paymentPendingError` | `purchase_pending` |
| returns `.failed(reason)` | `purchase_failed` with `reason` |
| throws any other error | `purchase_failed`, reason from `PurchaseFailureReason(error)`: `network` for RevenueCat's `networkError`, `store` for its other errors |

It throws the closure's error again unchanged and returns the outcome. The
RevenueCat example is under "Using RevenueCat".

In every case, call `FounderData.paywallViewed(source: source)` when the paywall
appears. The purchase itself is `FounderData.track(purchase:)`, see Purchases
below.

## Users

`FounderData.identify(userId: "u_123", email: "a@b.c", name: "Ada")` links the
install to your own user record. Call it after sign-in. Before that call, the
data has no link to a person. The SDK never writes the email or a purchase
JWS to the device log.

In FounderData Pro, the call also makes this install a person in People, joined
with the website visits that `identify()` the same user id or email. The app
sends no traits: a person's About card shows only what your website sends
(docs/GUIDE.md, "Identify people").

On sign-out, call `FounderData.reset()`. The next events go out under a new
install id in a new session, so whoever uses the device next is not linked
to the user before. Events already queued keep the old id.

- Without consent the new id is random and lives in memory, like the launch
  id. With `installId: .vendor` it lasts until the app quits, and the next
  launch is back under the vendor id.
- With consent the SDK replaces the id in the Keychain, so the new id lasts
  across launches.
- `appAccountToken` changes with the id. A RevenueCat app sets
  `revenueCatAttributes` again after `reset()`.
- Consent, `isEnabled` and the session properties stay as they are. Set the
  properties again if they describe the user who left, such as `plan`.

## Purchases

`FounderData.purchase` passes `FounderData.appAccountToken` as the
`appAccountToken` purchase option; pass it yourself when you call StoreKit
directly. It is the install id as a UUID, so Apple puts it into every transaction and every
server notification for that subscription. FounderData uses it to credit
renewals to the install that bought.

`FounderData.track(purchase:)` takes the `VerificationResult` from
`product.purchase()`, and `FounderData.purchase` calls it for you. It sends `jwsRepresentation` and nothing else. The
server checks Apple's signature, reads product, price and currency from the
JWS, and stores one row per transaction id, so a purchase reported twice
counts once. Unverified results are skipped.

`FounderData.observeTransactions()` starts its own `Transaction.updates` loop
and reports what arrives there: renewals while the app runs, purchases made on
another device and Ask to Buy approvals. It does not call `finish()`. Keep
your own updates loop for delivering content and finishing transactions.

Revoked transactions are not sent from the app. Refunds reach FounderData as
REFUND and REVOKE server notifications. Free transactions, such as a free
trial, are not revenue: the server skips them, and the first paid
transaction after a trial counts as the new customer.

Revenue is the customer price including tax, in the currency of the
transaction. The dashboard labels it gross.

### App Store Server Notifications

Renewals that happen while the app is closed reach FounderData only through
App Store Server Notifications V2. If no backend owns the notification URL
yet, open App Information > App Store Server Notifications in App Store
Connect and set it to:

```
https://founderdata.example.com/api/webhooks/apple/SITE_ID
```

This needs the site's `app_bundle_id`, see "Before the first launch".

If your backend already receives the notifications, forward the raw body
unchanged after you handle it. FounderData verifies the signature itself, so
it needs the original `signedPayload`:

```ts
// inside your existing App Store notification handler
const raw = await request.text();               // {"signedPayload":"..."}
ctx.waitUntil(fetch("https://founderdata.example.com/api/webhooks/apple/SITE_ID", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: raw,
}));
```

Notifications are matched to an install by `appAccountToken`, or by an
earlier purchase with the same original transaction id.

## RevenueCat details

Setup is under "Using RevenueCat" at the top. Why it differs from StoreKit:
`Purchases.shared.purchase(package:)` never hands you StoreKit's
`VerificationResult`, so `FounderData.purchase`, `FounderData.track(purchase:)` and
the `appAccountToken` option do not apply. FounderData takes RevenueCat purchases
from RevenueCat's webhook instead, and FounderDataKit has no RevenueCat
dependency. `FounderData.trackPurchase` sends the purchase goals around your
RevenueCat call; its `.purchased` outcome sends no goal, because the webhook
reports the purchase. The webhook reads the subscriber attribute `founderDataVisitorId`,
which `FounderData.revenueCatAttributes` holds.

Without consent the install id changes on every launch, unless the app uses
`installId: .vendor`. The first purchase links to the visitor of the launch it happened in, as long as the attribute
was set in that launch. A renewal carries the id of the last launch that set the attribute,
and the server links it to the first purchase through RevenueCat's customer
id. Returning users and time to convert reach back one day, the same as
for StoreKit apps.

`FounderData.observeTransactions()` is optional with RevenueCat. It sends
renewals that arrive while the app runs, and the server stores each
transaction once, whether it comes from the SDK or from the webhook.

## Links and attribution

`FounderData.handle(url:)` reads `utm_source`, `utm_medium`, `utm_campaign`,
`utm_term`, `utm_content`, `ref` and `rt_vid` from a universal link or a custom
scheme link. Links that still carry the older `ml_vid` work too. It also reads
ad click ids: `gclid`, `gbraid` and `wbraid` (Google Ads), `msclkid`
(Microsoft Ads), `ttclid` (TikTok), `twclid` (X), `li_fat_id` (LinkedIn),
`rdt_cid` (Reddit), `ScCid` (Snapchat) and `epik` (Pinterest). A session with
one counts as Paid, with the network as its source, the same as on the web. It
returns true when it found any of them. Call it from
`.onOpenURL`, and from `.onContinueUserActivity(NSUserActivityTypeBrowsingWeb)`
with `activity.webpageURL` if you handle universal links that way.

- A link that opens the app within 60 seconds of a new session fills that
  session's source. This covers a cold launch from the link.
- A link that arrives later starts a new session with the link as its source.
- `rt_vid` is the visitor id of the FounderData web script. Add it to links on
  your website and the server joins the web visit and the app install into one
  journey.

The SDK also asks AdServices for an Apple Ads attribution token and sends it
with the first session: on every launch without consent, on the first launch
after consent with it. The server looks it
up with Apple. If the install came from Apple Ads, the session gets the source
"Apple Search Ads" with campaign, keyword and ad group ids. The SDK holds the
first upload for up to 10 seconds while it waits for the token.

## Sessions and delivery

- A session starts with the first event or when the app comes to the
  foreground. After 30 minutes in the background, the next event or foreground
  starts a new one.
- Engaged time counts only while the app is active. The SDK reports it when
  the app goes to the background, and every 5 minutes during long use.
- Without consent, events wait in memory. With consent they wait in a queue
  file, `FounderData/state.json` in Application Support, which is excluded from
  backups and survives a termination. Uploads go out in batches
  of up to 50 events and under 60 KB. The SDK uploads every 30 seconds while
  the app is active, when the app goes to the background, when the network
  comes back, and right after a purchase. The background upload runs under a
  background task so iOS lets it finish.
- A failed upload waits 5 seconds, then 10, 20 and so on up to 15 minutes.
  Network errors, `404`, `429` and `5xx` count as failures. A `400`, `403` or
  `413` means the server will never take that batch, so the SDK drops it.
  When the server skips single bad events, it still answers `202` and the
  SDK does not resend them.
- The queue keeps at most 2,000 events and drops events older than 72 hours.
  The server ignores events older than that anyway.
- `await FounderData.flush()` uploads the queue at once, without the wait that
  follows a failed upload, and returns how many events the server accepted.
  Use it in UI tests or before the app exits on purpose. It returns 0 when
  nothing is queued, before `configure`, while another upload runs, and while
  the first upload of a launch waits for the Apple Ads token (at most 10
  seconds).

## Opt-out

```swift
FounderData.isEnabled = false
```

This drops every queued event (and deletes the queue file, if consent created
one) and stops collection until you set it back to true. The SDK keeps the
value in memory only. To make an opt-out last, store it in the app and set
`FounderData.isEnabled` before `configure` on every launch.

## Checks in `configure`

`configure` logs an error and does nothing when the site id is empty or the
host is not a URL. It also logs an error when `host` or `debugHost` uses plain
http for anything but `localhost`, a `*.local` name or a private network
address (`10.x`, `172.16.x` to `172.31.x`, `192.168.x`, `127.x`). In a Debug
build each of these stops the app at an `assertionFailure` with the message,
so the mistake shows up on the first run instead of as an empty dashboard.
Release builds only log.

## Privacy manifest and App Store privacy label

The package ships a privacy manifest, `PrivacyInfo.xcprivacy`. Xcode adds it
to the privacy report of your archive (Organizer, right-click the archive,
Generate Privacy Report). It declares:

- Collected data: Product Interaction, Purchase History and Coarse Location,
  each for Analytics, not linked to the user and not used for tracking.
- Tracking: No. No tracking domains.
- Required-reason API: UserDefaults, reason `CA92.1` (data only the app
  itself reads). After consent the SDK keeps a copy of the install id there,
  for launches before the first unlock, when the Keychain cannot be read. It
  calls no other API from Apple's required-reason list.

Recordings (Pro) happen on your website only. The SDK never records the
screen, so they change your privacy policy, not these answers.

The manifest describes every install the same way. It cannot know whether
your app asks for consent, uses `installId: .vendor` or calls `identify()`. Answer the App Privacy
questions in App Store Connect from this table, and add the extra rows to
your app's own `PrivacyInfo.xcprivacy` when they apply. Add whatever else
your app collects.

Device ID is the one row the manifest leaves out on purpose. With the
default `.perLaunch` and no consent the SDK collects no Device ID, and a
manifest cannot depend on a setting, so the row belongs in your app's
manifest when your app asks for consent or uses `.vendor`.

| Data type | Without consent | `installId: .vendor`, no consent | After `setConsent(true)` | After `identify()` |
|---|---|---|---|---|
| Usage Data > Product Interaction (screens, goals, session length) | Collected, not linked | Collected, not linked | Collected, not linked | Collected, linked |
| Purchases > Purchase History | Collected, not linked | Collected, not linked | Collected, not linked | Collected, linked |
| Location > Coarse Location | Collected, not linked | Collected, not linked | Collected, not linked | Collected, linked |
| Identifiers > Device ID | Not collected | Collected, not linked | Collected, not linked | Collected, linked |
| Identifiers > User ID | Not collected | Not collected | Not collected | Collected, linked, if you pass `userId` |
| Contact Info > Email Address, Name | Not collected | Not collected | Not collected | Collected, linked, if you pass them |

Every collected row has the purpose Analytics, and "Used for tracking" is No.
The `identify()` column adds to the other three: once the app calls it, every
row it collects is linked to the user.

- Purchase History is collected when you report purchases, through
  `track(purchase:)`, App Store Server Notifications or RevenueCat.
- Coarse Location is the country, region and city that Cloudflare derives
  from the IP address of each upload (`request.cf`). FounderData does not store
  the IP address, and the app never asks for location.
- Device ID: without consent the install id is random for each launch and
  lives in memory, so it identifies nothing beyond that launch. With
  `.vendor` it is a hash of `identifierForVendor` and comes back on every
  launch until the user removes all of your team's apps. With consent it
  stays in the Keychain and survives a reinstall. Apple's definition of
  Device ID includes "other device-level ID", so declare it. Answering Yes
  costs nothing at review, and a missing row can.

"Used for tracking" stays No. FounderData data never leaves your own Worker
and is never combined with other companies' data for advertising. The Apple
Ads token goes only to Apple, and Apple states that AdServices attribution
needs no ATT consent.

Your privacy policy should name FounderData as your own analytics, list the
data above, say that nothing is stored on the device without consent, and
explain the consent choice and the opt-out if you offer them. With `.vendor`,
also say that the app sends a hash of the device's vendor id, which counts
returning users and is reset when all of your apps are removed.

## What the SDK sends

Every upload is `POST <host>/api/app/events` with a JSON body, in the format
that `docs/APP-API.md` in this repo defines. Each body
carries the site id, the install id, the events, and the app version, build,
iOS version, device model, locale and bundle id. With consent it also carries
`"consent": true`, and under a `.vendor` id without consent `"id": "vendor"`,
so the server knows the install id lasts across launches. Pro's retention
panel counts only those installs.

## Versions

Releases are git tags in plain semver with no `v`, starting at `1.0.0`. The
server, the dashboard and the SDK share one version. In Xcode, choose Up to
Next Major Version from 1.0.0. In a `Package.swift`, use
`.package(url: "https://github.com/founderdata/founderdata", from: "1.0.0")`.

A breaking change to the SDK's public API needs a new major version, and
[CHANGELOG.md](CHANGELOG.md) says what to change in your app. A minor release
adds features, and a patch release only fixes bugs. A change to the upload
format also updates `docs/APP-API.md`, and the server keeps accepting every
upload format a released SDK sends.

## Tests

The package declares iOS as its only platform. Run the tests on an iOS
simulator from the `ios` folder:

```bash
xcodebuild test -scheme FounderDataKit -destination 'platform=iOS Simulator,name=iPhone 17'
```

They cover session rollover, queue persistence and caps, the payload against
the example in `docs/APP-API.md`, session properties and the onboarding goals,
the goal helpers against `docs/APP-EVENTS.md`, `reset()`, the RevenueCat
attribute against `src/worker/revenuecat.ts`, the privacy manifest, link
parsing, `flush()`, the checks in `configure`, and that the default mode
writes no Keychain item, file or UserDefaults key. They pin the `.vendor` id
derivation, check that `.perLaunch` stays the default and that a Keychain id
wins over the vendor id after consent. The purchase wrapper's goals are
tested with scripted StoreKit results and errors, and `trackPurchase` with
each outcome and with RevenueCat's error codes.

`StoreKitPurchaseTests` also buys through a local StoreKit test session
(`Tests/FounderDataKitTests/FounderDataKitTests.storekit`): a verified purchase,
Ask to Buy, a StoreKit error and an unverified transaction. StoreKit loads
no products in a package's test bundle, which has no host app, so in the
command above these 4 tests are skipped. StoreKit testing needs a test
target hosted by an app.
