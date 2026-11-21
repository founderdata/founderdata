# FounderData for Android changelog

Changes to the Kotlin library in `android/` (`com.founderdata:founderdata-android`). The server, the dashboard and
the Swift SDK are not listed here. Versions follow the repository's release tags in plain semver with no `v`; a
breaking change to the public API needs a new major version.

## 1.0.0 (unreleased)

The first release, a port of FounderDataKit 1.0.0 for iOS. It sends the same batches to `POST /api/app/events`, with
`ctx.platform: "android"` (docs/APP-API.md, section 9).

### Added

- `FounderData.configure(context, siteId, host, debugHost, installId)`, with `InstallId.RANDOM` (the default, a random
  id per process) and `InstallId.VENDOR` (a hash of the developer-scoped App set ID and the site id, through the
  optional `play-services-appset`).
- `screen`, `goal`, the goal helpers of docs/APP-EVENTS.md, `onboardingStep`, `onboardingComplete`,
  `setSessionProperties`, `setSessionProperty`, `experiment`, `identify`, `reset`, `isEnabled` and `flush`.
- `setConsent`: without consent nothing is stored on the device; with it the install id and the queue live in
  `noBackupFilesDir/founderdata`.
- `handle(intent)`, `handle(uri)` and `handle(url)` read `utm_*`, `ref`, `rt_vid` and ad click ids from App Links and
  deep links. The Play Install Referrer fills the first session's source the same way.
- Google Play purchases through the optional Play Billing library: `trackPurchase(purchase, kind)`,
  `trackPurchaseResult(result, purchases, kind, product, source)`, `BillingFlowParams.Builder.setFounderDataAccountId()`
  and `obfuscatedAccountId`. `trackPurchase(purchaseToken, productId, kind, orderId)` works without the library.
- `trackPurchase(product, source) { ... }` and `revenueCatAttributes` for RevenueCat and other purchase code.
- Delivery honors `Retry-After` on top of the exponential backoff.
