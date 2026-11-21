# Event naming: from first visit to purchase

FounderData counts any goal name you send. A few names have a meaning, though. The onboarding funnel, the paywall panels
and the Drop-off view look for them, so use these names where they fit. They answer one question: which step loses
people, and how many of those who get through it see the paywall and buy. The wire format is in
[APP-API.md](APP-API.md), the iOS SDK in [../ios/README.md](../ios/README.md). In Swift, each name below has a helper on
`FounderData` (listed next to it), so the compiler catches a typo; `FounderData.goal(name, props:)` still sends any name. On a
website, send the same goals with `window.founderdata('goal', name, props)` or `data-rt-goal`.

## 1. Setup in an iOS app

- Call `FounderData.configure(siteId:host:debugHost:)` in the App init, with your deployment URL as the host and
  `http://localhost:8787` as the debug host. Skip it in unit tests, UI tests and screenshot runs.
- Keep the default no-storage mode. Call `setConsent(true)` only if the app asks for consent that covers analytics.
- Call `FounderData.observeTransactions()` once at launch if the app sells through StoreKit.
- Keep the SDK calls in one file of your app. That makes it easy to see what the app sends.

In an Android app, call `FounderData.configure(this, siteId, host, debugHost)` in `Application.onCreate` instead,
report Play Billing purchases with `FounderData.trackPurchase(purchase, kind)`, and skip the call in unit and
Robolectric tests. The helpers below have the same names in Kotlin (`FounderData.paywallViewed(PaywallSource.ONBOARDING)`).
Set the session property `build_channel` to `debug` in debug builds. [../android/README.md](../android/README.md)
has the details.

## 2. Session properties (set as early as the app knows them)

| Key | Values | Meaning |
|---|---|---|
| `user_state` | `new`, `returning` | `new` until the app's own state says onboarding finished or the first paid or core action happened. Read it from state the app already stores; add none for this. |
| `plan` | `free`, `pro`, `trial`, `paid` | entitlement at session start, from the app's existing entitlement state |
| `exp_<name>` | variant id | via `FounderData.experiment(name, variant:)`, only where the app really branches |

At most 10 keys, short values, never personal data.

## 3. Onboarding

- `FounderData.onboardingStep(index, name)` when each first-run onboarding step **appears**. Indices start at 1 and follow display order; names are short snake_case (`welcome`, `goal`, `permissions`, `paywall`, ...). A step the user never sees sends nothing. If the flow branches, keep one index per position and let the name differ.
- `FounderData.onboardingComplete()` when the user lands in the main app after onboarding.
- `onboarding_skip` goal with prop `step` (the step name) when the user skips the rest: `FounderData.onboardingSkipped(at: "notifications")`.
- A paywall shown inside onboarding is both a step (`onboardingStep(n, "paywall")`) and a `paywall_view` with `source=onboarding`.

## 4. The main flow and its failures (Drop-off view)

- `flow_start` when the user starts the task that leads to buying: a signup form, a configurator, an upload, a
  multi-step form. Send it once per session. Sessions without it still count, but the Drop-off view can only show
  where people stop after they started. Swift: `FounderData.flowStarted()`.
- `flow_exit` with prop `step` when an app user leaves the flow without finishing it. Swift: `FounderData.flowExited(at: "upload")`.
- Failure goals: `purchase_failed`, `purchase_cancelled`, and any goal whose name ends in `_failed`, `_error` or
  `_invalid` (`upload_failed`, `checkout_error`, `address_invalid`). Give them the props `reason` (a short fixed code
  such as `timeout` or `card_declined`) and `step`. The Drop-off view lists them with how many of those sessions still
  bought.

## 5. Paywall and purchase

| Goal | Props | When | Swift |
|---|---|---|---|
| `paywall_view` | `source`, `paywall` (optional id or variant) | the paywall or offer becomes visible | `paywallViewed(source:paywall:)` |
| `purchase_start` | `source`, `product` | the buy button is pressed | `purchaseStarted(product:source:)` |
| `purchase_cancelled` | `source`, `product` | StoreKit `.userCancelled`, or the payment sheet was dismissed | `purchaseCancelled(product:source:)` |
| `purchase_pending` | `source`, `product` | StoreKit `.pending` | `purchasePending(product:source:)` |
| `purchase_failed` | `source`, `product`, `reason` (`network`, `store`, `verification`, `other`) | any error | `purchaseFailed(product:source:reason:)` |
| `restore_start`, `restore_success` | `source` | restore purchases | `restoreStarted(source:)`, `restoreSucceeded(source:)` |

- `source` is a fixed per-app list: `onboarding`, `settings`, `feature_gate`, or `gate_<feature>` for specific locked features. Keep it short. In Swift it is a `FounderData.PaywallSource`: `.onboarding`, `.settings`, `.featureGate`, `.gate("stats")`, or a string literal.
- `reason` in Swift is `FounderData.PurchaseFailureReason`; `PurchaseFailureReason(error)` picks it from a StoreKit error. In a StoreKit 2 app, `FounderData.purchase(product, source:)` sends `purchase_start` and the outcome goal for you. [../ios/README.md](../ios/README.md) has a buy button that sends every goal in this table, for StoreKit and for RevenueCat.
- `product` is the App Store product id or the app's own pack id. Never a price string from the user's locale.
- The purchase itself: StoreKit 2 apps buy with `FounderData.purchase`, or pass `.appAccountToken(FounderData.appAccountToken)` and call `FounderData.track(purchase:)` with the verified result (the server checks Apple's signature and records amount, currency, product, trial and renewal). Stripe in the app: send `rt_visitor_id = FounderData.appAccountToken.uuidString.lowercased()` to the backend, which adds it and the pinned `rt_site_id` to the PaymentIntent or Checkout Session metadata. RevenueCat apps: pass `FounderData.revenueCatAttributes` (the subscriber attribute `founderDataVisitorId` with the same lowercase id) to `Purchases.shared.attribution.setAttributes` before the purchase (see APP-API.md, RevenueCat).
- Subscriptions: renewals, refunds and cancellations come from App Store Server Notifications (forward from the backend that owns the URL, or point the URL at FounderData when no backend uses it) or from the RevenueCat webhook.

## 6. Activation and core actions

- `activation` goal with prop `what` once per launch when the user first gets the core value (for example the first project created or the first export). Use one fixed `what` per app. Swift: `FounderData.activation("first_export")`.
- Up to 5 more core-action goals per app, snake_case, e.g. `project_created`, `export_done`, `invite_sent`.
- Permissions: `permission_<kind>_prompt` when the system prompt is shown, `permission_<kind>` with prop `result` (`granted`, `denied`, `limited`). Swift: `FounderData.permissionPrompted("notifications")` and `FounderData.permissionAnswered("notifications", result: .granted)`.

## 7. Screens

`.founderDataScreen("Name")` on top-level screens and onboarding steps. Names are fixed strings in PascalCase with `/` for nesting (`Settings/Language`). No ids, titles or user content in names.

## 8. Never send

Names, emails, addresses, user-written text, file or image content, locations or routes, health data, contacts, document data, prices typed by the user. Goal props come only from the fixed values above.

## 9. Privacy checklist for your app

What follows is a summary of what the SDK does, not legal advice. Check it against your own privacy policy.

- `PrivacyInfo.xcprivacy`: FounderDataKit ships its own manifest with Product Interaction, Purchase History and Coarse
  Location, all for Analytics and not linked, Tracking No, no tracking domains, and UserDefaults with reason `CA92.1`.
  Your app's manifest adds Device ID when the app calls `setConsent(true)`, and User ID, Email Address or Name when it
  calls `identify` with them, and then marks the rows linked. The table in [../ios/README.md](../ios/README.md)
  ("Privacy manifest and App Store privacy label") has every case.
- Your privacy policy names FounderData and the facts behind it: a random id per launch kept in memory (in the Keychain
  only after consent), launches of one device grouped per day by a hashed key on the server, no stored IP address, coarse location derived from the IP on the server, Cloudflare as the
  processor, and visit data deleted after 24 months (the default; `RETENTION_MONTHS` changes it).
- The App Privacy answers in App Store Connect match the manifest.
