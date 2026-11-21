# FounderData for Android

A Kotlin library that sends screens, goals, sessions and Google Play purchases from an Android app to a FounderData
Worker. It is the Android port of the Swift SDK in [`ios/`](../ios/README.md) and sends the same batches to the same
endpoint (`POST /api/app/events`, [docs/APP-API.md](../docs/APP-API.md), section 9). It never reads `ANDROID_ID`, the
advertising id or any hardware id, and by default it stores nothing on the device.

- Group `com.founderdata`, artifact `founderdata-android`, package `com.founderdata`.
- minSdk 23. Built with compileSdk 36, so the app needs compileSdk 36 or later.
- Kotlin 2.0 or later in the app (the library's metadata and stdlib are pinned to 2.0). Java works too: every call is
  a static method on `FounderData`, except the `suspend` ones.

FounderData core records every event the SDK sends and credits each purchase to its session's source. The App section
with the onboarding funnel, the paywall split, retention and experiments is a report in FounderData Pro
([docs/PRO.md](../docs/PRO.md)).

## Install

```kotlin
// build.gradle.kts of the app
dependencies {
    implementation("com.founderdata:founderdata-android:1.0.0")
    // Optional, only if you use them:
    implementation("com.android.billingclient:billing:8.3.0")              // trackPurchase(purchase, kind)
    implementation("com.google.android.gms:play-services-appset:16.1.0")   // installId = InstallId.VENDOR
}
```

The library brings kotlinx-coroutines-android, androidx `lifecycle-process` and the Play `installreferrer` client. Play
Billing and `play-services-appset` are `compileOnly` dependencies: an app without them does not pull them in, and the
SDK checks at runtime that they are there. Until a release is on Maven Central, build it from this folder with
`./gradlew :founderdata:publishToMavenLocal` and add `mavenLocal()` to the app's repositories; the version is then
`1.0.0-SNAPSHOT`.

The library ships consumer R8 rules (`consumer-rules.pro`), so a minified app needs no rules of its own.

## Before the first launch

Give FounderData the app's application id (package name). In the dashboard, enter it in the site's Settings as the
Android package (`android_package`). Until it is set, the server answers `403` to every upload, and the SDK drops a
batch that gets a `403` without retrying, so events sent before the setting exists are lost. The Android package is
separate from the iOS bundle id, because an app often has different ids on the two stores.

## Setup

Call `configure` once, in `Application.onCreate`:

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        FounderData.setConsent(settings.analyticsConsent)   // your app's own stored choice, before configure
        FounderData.configure(
            context = this,
            siteId = "SITE_ID",
            host = "https://founderdata.example.com",
            debugHost = "http://10.0.2.2:8787",               // the emulator's address for your computer
        )
        FounderData.setSessionProperties(mapOf(
            "user_state" to if (store.hasCompletedOnboarding) "returning" else "new",
            "build_channel" to if (BuildConfig.DEBUG) "debug" else "play",
        ))
    }
}
```

Then, in the app:

1. Screens: `FounderData.screen("Settings")` when a top-level screen appears (Compose: in a `LaunchedEffect(Unit)`
   of the screen; views: in `onResume`). Names are fixed PascalCase strings with `/` for nesting.
2. Links: `FounderData.handle(intent)` in `onCreate` and `onNewIntent` of the activity that receives App Links and
   deep links. `handle(uri)` and `handle(url)` take a `Uri` or a string.
3. Onboarding: `FounderData.onboardingStep(1, "welcome")`, `onboardingStep(2, "name")` and so on, then
   `onboardingComplete()`.
4. Paywall: `FounderData.paywallViewed(PaywallSource.ONBOARDING)` when it appears.
5. Purchases: see "Google Play purchases" below.
6. Sign-out: `FounderData.reset()`.

`debugHost` applies only when the app is debuggable (a debug build), read from the app's own `FLAG_DEBUGGABLE`.
Release builds always use `host`. Plain `http` to `10.0.2.2` or a LAN address also needs cleartext allowed for that
host in a debug-only network security config; Android blocks cleartext by default.

`build_channel` set to `debug` is how the server knows a session came from a test build: the Drop-off view leaves out
sessions whose `build_channel` is `debug` (or `testflight` on iOS) unless you ask for them. The SDK does not set it by
itself; set it as above.

### Checks in `configure`

`configure` logs an error and does nothing when the site id is empty or the host is not a URL. It also logs an error
when `host` or `debugHost` uses plain http for anything but `localhost`, a `*.local` name or a private address
(`10.x`, which covers the emulator's `10.0.2.2`, `172.16.x` to `172.31.x`, `192.168.x`, `127.x`). In a debuggable app
each of these throws `IllegalArgumentException` with the message, so the mistake shows up on the first run instead of
as an empty dashboard. Release builds only log.

### Unit tests

Skip `configure` in your app's unit tests, Robolectric tests and screenshot runs. Otherwise the SDK sends test events
to your site, and Robolectric runs `Application.onCreate` for every test. The simplest way is a test `Application`
without the call (`@Config(application = TestApp::class)`), or a check you already have for test runs. Every other
`FounderData` call does nothing before `configure`, so the rest of the app needs no change.

## Storage and consent

The SDK never reads `ANDROID_ID`, the advertising id or any hardware id, and does no fingerprinting. By default it
stores nothing on the device: each process gets a random id that lives in memory, and that id is all FounderData uses
to tell launches apart.

In the EU, Article 5(3) of the ePrivacy Directive, the rule behind cookie banners, needs the user's consent before an
app stores information on the device or reads information stored there. The only exception is storage that is
strictly necessary for a service the user asked for, and analytics is not. So without consent the SDK writes nothing
to files, SharedPreferences, databases or WorkManager, and reads nothing from them:

- The install id and the session id are random for each process and live in memory.
- The event queue lives in memory. The SDK sends it when the app goes to the background. Events still unsent when the
  process dies are lost.
- `isEnabled` and the consent flag live in memory too. The app stores its own settings and passes them in on each
  launch.

The server groups these launches so the numbers stay clean: launches of one device on one UTC day count as one
visitor, from a daily key over the IP, the user agent, the device model, the Android version and the locale. Only the
key is stored ([docs/APP-API.md](../docs/APP-API.md), section 3). The next day the same device counts as a new
visitor, so returning users and retention reach back one day only. `InstallId.VENDOR` changes that.

With consent, call `FounderData.setConsent(true)`. The SDK then keeps the install id in `install_id` and the queue in
`state.json`, both in `noBackupFilesDir/founderdata`, which Auto Backup and device-to-device transfer skip, so an id is
never restored to another device. Files are written to a temporary file and renamed, so a crash never leaves half a
file. If the device already holds an id from an earlier consent, events continue under it; otherwise the current
process's id is stored, so the visit goes on unbroken. `setConsent(false)` deletes the folder and continues in memory
under a new random id.

The SDK does not remember consent. Store the user's choice and pass it in before `configure` on every launch, as in
the setup above.

### One id per install without consent

```kotlin
FounderData.configure(this, "SITE_ID", "https://founderdata.example.com", installId = InstallId.VENDOR)
```

With `InstallId.VENDOR` the install id is the same on every launch, so returning users, retention and New installs
also cover users who never saw a consent prompt. It needs `play-services-appset` in the app. On each launch the SDK
reads the App set ID and sends a hash of it:

- Only the developer scope counts. An app-scoped App set ID, a device without Google Play services, a missing library
  or any error gives a random id for that launch.
- The id is the first 16 bytes of SHA-256 over a fixed prefix, the site id and the App set ID, sent as a UUID. The
  raw App set ID never leaves the device. The formula is the iOS one ([docs/APP-API.md](../docs/APP-API.md),
  section 9).
- The App set ID arrives asynchronously. The first upload of a launch waits for it for up to 5 seconds, and events
  recorded before it arrived move to the vendor id. `obfuscatedAccountId` changes once in those first moments, so
  read it when the user taps buy.
- Google resets the App set ID when the user removes every app of your developer account, or after 13 months without
  any of them being used.
- Batches under the vendor id carry `"id": "vendor"` in `ctx`, and the server counts the install for retention.
- `reset()` switches to a random id until the process ends. With consent the stored id wins; a first consent stores
  the vendor id, and `setConsent(false)` continues under the vendor id.

It is an identifier: declare it under Device or other IDs in Play's Data safety form (see below). Whether your app may
read it for analytics without consent is a legal call for you to make under the ePrivacy rule above; keep the
default, `InstallId.RANDOM`, if you follow the strict reading.

## Google Play purchases

The server checks each purchase token with Google before it stores money ([docs/APP-API.md](../docs/APP-API.md),
section 9), so the app holds no secret.

1. Set the obfuscated account id on every billing flow, so Google's purchase records and later notifications carry
   the install id:

   ```kotlin
   val params = BillingFlowParams.newBuilder()
       .setProductDetailsParamsList(listOf(productParams))
       .setFounderDataAccountId()   // same as .setObfuscatedAccountId(FounderData.obfuscatedAccountId)
       .build()
   FounderData.purchaseStarted(product = "pro_yearly", source = PaywallSource.ONBOARDING)
   billingClient.launchBillingFlow(activity, params)
   ```

2. Report the result in your `PurchasesUpdatedListener`:

   ```kotlin
   override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
       FounderData.trackPurchaseResult(result, purchases, PurchaseKind.SUBS, product = "pro_yearly", source = PaywallSource.ONBOARDING)
       // acknowledge and deliver as before
   }
   ```

   It sends `purchase_cancelled`, `purchase_pending` or `purchase_failed` with a reason, and calls
   `FounderData.trackPurchase(purchase, kind)` for each purchased item. Call `trackPurchase(purchase, kind)` yourself
   for purchases you find with `queryPurchasesAsync`, such as one that completed while the app was closed.

`trackPurchase` sends only purchases in the purchased state, each token once, with the token, the first product id,
the kind (`subs` or `inapp`) and the order id. A purchase also uploads right away. Without Play Billing in the app,
`FounderData.trackPurchase(purchaseToken, productId, kind, orderId)` takes the parts.

On the server, point a Pub/Sub push subscription for your app's real-time developer notifications at
`https://founderdata.example.com/api/webhooks/google/SITE_ID`, and give FounderData a service account
([docs/APP-API.md](../docs/APP-API.md), section 9). Renewals, refunds and purchases made while the app is closed
arrive that way.

### RevenueCat or your own purchase code

```kotlin
suspend fun buy(activity: Activity, pkg: Package, source: PaywallSource) {
    Purchases.sharedInstance.setAttributes(FounderData.revenueCatAttributes)
    FounderData.trackPurchase(product = pkg.product.id, source = source) {
        Purchases.sharedInstance.awaitPurchase(PurchaseParams.Builder(activity, pkg).build())
        PurchaseOutcome.Purchased
    }
}
```

`trackPurchase(product, source) { ... }` sends `purchase_start`, runs the block, and sends the goal for the outcome it
returns. An exception from the block is reported and thrown again unchanged: RevenueCat's `PurchaseCancelledError` as
`purchase_cancelled`, `PaymentPendingError` as `purchase_pending`, `NetworkError` and any `IOException` as
`purchase_failed` with reason `network`, other RevenueCat errors with reason `store`. The SDK reads RevenueCat's error
code by name, so it needs no RevenueCat dependency.

`FounderData.revenueCatAttributes` is `{"founderDataVisitorId": <install id>}`. Set it after configuring RevenueCat,
after `logIn`, after `FounderData.reset()` and before each purchase; without consent the id changes on every launch.

## Goals

| Helper | Goal | Props |
|---|---|---|
| `paywallViewed(source, paywall)` | `paywall_view` | `source`, `paywall` if passed |
| `purchaseStarted(product, source)` | `purchase_start` | `source`, `product` |
| `purchaseCancelled(product, source)` | `purchase_cancelled` | `source`, `product` |
| `purchasePending(product, source)` | `purchase_pending` | `source`, `product` |
| `purchaseFailed(product, source, reason)` | `purchase_failed` | `source`, `product`, `reason` |
| `restoreStarted(source)`, `restoreSucceeded(source)` | `restore_start`, `restore_success` | `source` |
| `onboardingStep(index, name)` | `onboarding_<name>` | `step`, `index` |
| `onboardingComplete()`, `onboardingSkipped(step)` | `onboarding_complete`, `onboarding_skip` | `step` on skip |
| `flowStarted()`, `flowExited(step)` | `flow_start`, `flow_exit` | `step` on `flow_exit` |
| `activation(what)` | `activation` | `what` if passed |
| `permissionPrompted(kind)` | `permission_<kind>_prompt` | none |
| `permissionAnswered(kind, result)` | `permission_<kind>` | `result`: `granted`, `denied` or `limited` |

`source` is a `PaywallSource`: `ONBOARDING`, `SETTINGS`, `FEATURE_GATE`, `PaywallSource.gate("stats")` for
`gate_stats`, or `PaywallSource("streak_banner")`. `reason` is a `PurchaseFailureReason` (`NETWORK`, `STORE`,
`VERIFICATION`, `OTHER`); `PurchaseFailureReason.fromBillingResponseCode(code)` sorts a Play Billing code.
`FounderData.goal(name, props)` still sends any name. A goal keeps up to 20 string props and about 1,000 characters.
[docs/APP-EVENTS.md](../docs/APP-EVENTS.md) says what each name means.

## Session properties and experiments

`setSessionProperties(map)`, `setSessionProperty(key, value)` and `experiment(name, variant)` (which sets
`exp_<name>`) work as on iOS: at most 10 keys, lowercase `a-z`, `0-9` and `_`, values up to 100 characters, an empty
value removes a key. They go on the current session and every later session of the process. Nothing is stored, so set
them again on each launch, right after `configure`. Never put personal data in them.

## Users

`FounderData.identify(userId = "u_123", email = "a@b.c", name = "Ada")` links the install to your own user record.
Call it after sign-in. On sign-out, call `FounderData.reset()`: the next events go out under a new install id in a new
session. Events already queued keep the old id. The SDK never logs an email or a purchase token.

## Links and attribution

- `handle(intent)` reads `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `ref`, `rt_vid` (the
  web script's visitor id, which joins a web visit and the install into one journey) and ad click ids: `gclid`,
  `gbraid`, `wbraid`, `msclkid`, `ttclid`, `twclid`, `li_fat_id`, `rdt_cid`, `ScCid` and `epik`. A link within 60
  seconds of a new session fills that session's source; a later link starts a new session.
- The Play Install Referrer: on launch the SDK asks Google Play for the referrer string the install came with (for
  example `utm_source=google-play&utm_medium=organic`, or the `utm_*` and `gclid` of an ad) and puts it on the first
  session, the same way as a link. The first upload waits up to 10 seconds for it. With consent the SDK remembers that
  it asked; without consent it asks on each launch, which Play allows for 90 days after the install. The `installreferrer`
  library adds the `BIND_GET_INSTALL_REFERRER_SERVICE` permission to your manifest.

## Sessions and delivery

- A session starts with the first event or when the app comes to the foreground (`ProcessLifecycleOwner` start).
  After 30 minutes in the background, the next event or foreground starts a new one.
- Engaged time counts while the app is visible. The SDK reports it as `ping` when the app goes to the background and
  every 5 minutes during long use.
- Uploads go out in batches of up to 50 events and under 60 KB: every 30 seconds while the app is visible, when it
  goes to the background, when the network comes back and right after a purchase.
- A failed upload waits 5 seconds, then 10, 20 and so on up to 15 minutes. Network errors, `404`, `429` and `5xx`
  count as failures, and a `Retry-After` header that asks for longer wins (at most 24 hours; the daily write cap sends
  the seconds until midnight UTC). A `400`, `403`, `413` or `422` means the server will never take that batch, so the
  SDK drops it. When the server skips single bad events it still answers `202`, and the SDK does not resend them.
- The queue keeps at most 2,000 events and drops events older than 72 hours.
- `FounderData.flush()` (a `suspend` function) uploads at once, past the wait after a failure, and returns how many
  events the server accepted.

The sender is a coroutine, not WorkManager. WorkManager keeps each job and its input in its own database on the
device, which the SDK must not do without consent, and an upload on background finishes in well under the time
Android gives a process that just left the foreground. With consent the queue file already survives the process, and
the next launch sends it.

## Opt-out

`FounderData.isEnabled = false` drops every queued event (and the queue file, if consent created one) and stops
collection until it is set back to true. The SDK keeps the value in memory; store an opt-out in the app and set it
before `configure` on every launch.

## Play Data safety

What follows is a summary of what the SDK does, not legal advice. Answer the Data safety form in Play Console from
this table, and add whatever else your app collects.

| Data type | Default (no consent) | `InstallId.VENDOR`, no consent | After `setConsent(true)` | After `identify()` |
|---|---|---|---|---|
| App activity > App interactions (screens, goals, session length) | Collected | Collected | Collected | Collected |
| Financial info > Purchase history | Collected if you report purchases | Same | Same | Same |
| Location > Approximate location | Collected | Collected | Collected | Collected |
| Device or other IDs | Not collected | Collected | Collected | Collected |
| Personal info > User IDs | Not collected | Not collected | Not collected | Collected if you pass `userId` |
| Personal info > Email address, Name | Not collected | Not collected | Not collected | Collected if you pass them |

- Purpose: Analytics for every row. Not shared: the data goes only to your own FounderData Worker. Cloudflare runs
  it as your service provider, which Play does not count as sharing.
- Approximate location is the country, region and city that Cloudflare derives from the IP address of each upload.
  FounderData does not store the IP address, and the SDK never asks for location.
- Device or other IDs: without consent the id is random for each process and identifies nothing beyond it. With
  `InstallId.VENDOR` it is a hash of the App set ID, and with consent a random id kept in the app's no-backup folder.
- Purchase history covers the purchase token, product id and order id the SDK sends after a purchase, and what the
  server then reads from Google.
- Data is encrypted in transit (https). Collection is not optional unless your app offers the opt-out above.
- Deletion: the server deletes visit data after 24 months by default (`RETENTION_MONTHS`), and the dashboard can erase
  a visitor. Say in your privacy policy how users ask for deletion.

Your privacy policy should name FounderData as your own analytics, list the data above, say that nothing is stored on
the device without consent, and explain the consent choice and the opt-out if you offer them.

## What the SDK sends

Every upload is `POST <host>/api/app/events` with a JSON body in the format of
[docs/APP-API.md](../docs/APP-API.md). Each body carries the site id, the install id, the events and `ctx`: platform
`android`, app version (`versionName`), build (`versionCode`), Android version, `Build.MODEL`, `phone` or `tablet`
(smallest screen width 600 dp or more), locale (`en_US`) and the package name. With consent it also carries
`"consent": true`, and under a vendor id without consent `"id": "vendor"`.

## Development

```bash
export JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android/sdk   # or sdk.dir in a gitignored local.properties
./gradlew :founderdata:testDebugUnitTest     # JVM tests, Robolectric where Android is needed
./gradlew assembleRelease                    # the AAR
./gradlew :founderdata:publishToMavenLocal   # 1.0.0-SNAPSHOT into ~/.m2
```

The tests port the iOS suite: payload encoding against the contract example, sessions, consent and the files it
writes, the queue, backoff and `Retry-After` (also against MockWebServer), reset, the vendor id formula (pinned to the
Swift SDK's vectors and checked against its source), link and Install Referrer parsing with click ids, session
properties, the goal helpers against `docs/APP-EVENTS.md`, the RevenueCat attribute against
`src/worker/revenuecat.ts`, and the Google Play purchase event from real Play Billing `Purchase` objects.

Publishing goes to Maven Central through `com.vanniktech.maven.publish`
(`./gradlew :founderdata:publishAndReleaseToMavenCentral`). It reads the Central Portal token and the signing key from
Gradle properties or environment variables (`ORG_GRADLE_PROJECT_mavenCentralUsername`, `..._mavenCentralPassword`,
`..._signingInMemoryKey`, `..._signingInMemoryKeyPassword`); none are in this repository. Set `VERSION_NAME` in
`gradle.properties` to the release tag. Read [CHANGELOG.md](CHANGELOG.md) before you update.
