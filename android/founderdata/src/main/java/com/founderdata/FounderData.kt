package com.founderdata

import android.content.Context
import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

/** The Play product type of a purchase, sent as `kind`. Matches `BillingClient.ProductType`. */
public enum class PurchaseKind(public val wire: String) {
    /** A subscription (`BillingClient.ProductType.SUBS`). */
    SUBS("subs"),

    /** A one-time product (`BillingClient.ProductType.INAPP`). */
    INAPP("inapp");

    public companion object {
        /** From `BillingClient.ProductType.SUBS` or `INAPP`. Anything but `"subs"` is [INAPP]. */
        @JvmStatic
        public fun of(productType: String): PurchaseKind = if (productType == SUBS.wire) SUBS else INAPP
    }
}

/**
 * Analytics and Google Play revenue for a FounderData site.
 *
 * Call [configure] once, in `Application.onCreate`. Every other call is safe from any thread and does nothing until
 * then (consent, opt-out and session properties set before it are kept for it).
 *
 * By default the SDK stores nothing on the device: the install id and the session are random per process, and the
 * event queue lives in memory. After `setConsent(true)` it keeps the install id and the queue in the app's no-backup
 * folder. `configure(..., installId = InstallId.VENDOR)` keeps one id per install without consent, derived from the
 * App set ID.
 */
public object FounderData {
    private class Settings {
        var consent = false
        var enabled = true
        var launchId: String = UUID.randomUUID().toString()
        var sessionProperties: Map<String, String> = emptyMap()
        /** The [InstallId.VENDOR] id, once the App set ID arrived. Null in [InstallId.RANDOM] mode. */
        var vendorId: String? = null
        /** `setConsent(false)` before `configure`: the folder is erased once a context exists. */
        var eraseRequested = false
    }

    private val lock = Any()
    private var settings = Settings()
    private var core: Core? = null
    private var appContext: Context? = null

    private val installIdStore = InstallIdStore { storageDir() }

    /** Where the Install Referrer and the App set ID come from. Tests replace them. */
    internal var referrerSource: (Context) -> ReferrerSource = ::PlayReferrerSource
    internal var appSetIdSource: (Context) -> AppSetIdSource = ::PlayAppSetIdSource

    internal val current: Core? get() = synchronized(lock) { core }

    private fun storageDir(): File? = synchronized(lock) { appContext }?.noBackupFilesDir?.let(StorageDir::under)

    /**
     * Starts the SDK.
     *
     * @param context Any context; the SDK keeps the application context.
     * @param siteId The site id from the FounderData dashboard.
     * @param host Where your FounderData Worker runs, for example `"https://founderdata.example.com"`.
     * @param debugHost Used instead of [host] when the app is debuggable (a debug build).
     * @param installId The id without consent. [InstallId.RANDOM] (default) is random for each process.
     *   [InstallId.VENDOR] is a hash of the App set ID and the site id, the same on every launch.
     *
     * An empty site id, a host that is not a URL, or a host on plain `http` other than `localhost`, the emulator's
     * `10.0.2.2` or another private address is logged as an error and, in a debuggable app, throws
     * [IllegalArgumentException].
     */
    @JvmStatic
    @JvmOverloads
    public fun configure(
        context: Context,
        siteId: String,
        host: String,
        debugHost: String? = null,
        installId: InstallId = InstallId.RANDOM,
    ) {
        val app = context.applicationContext ?: context
        val debuggable = DeviceContext.isDebuggable(app)
        val problems = configurationProblems(siteId, host, debugHost)
        for (problem in problems) SdkLog.e("FounderData.configure: $problem")
        if (debuggable && problems.isNotEmpty()) {
            throw IllegalArgumentException("FounderData.configure: " + problems.joinToString(" "))
        }
        val chosenHost = if (debuggable && debugHost != null) debugHost else host
        val endpoint = Endpoint.events(chosenHost) ?: return
        val site = siteId.clipped(64) ?: return

        val created: Core
        val provisional: String?
        synchronized(lock) {
            if (core != null) {
                SdkLog.i("FounderData.configure was called more than once; the first call wins")
                return
            }
            appContext = app
            val s = settings
            val dir = StorageDir.under(app.noBackupFilesDir)
            if (!s.consent && s.eraseRequested) StorageDir.eraseAll(app.noBackupFilesDir)
            s.eraseRequested = false
            val stored = if (s.consent) installIdStore.read() else null
            val waitForVendor = installId == InstallId.VENDOR && stored == null
            val startId = when {
                stored != null -> stored
                waitForVendor -> s.launchId
                s.consent -> installIdStore.adopt(s.launchId)
                else -> s.launchId
            }
            provisional = if (waitForVendor) startId else null
            created = Core(
                Core.Configuration(
                    siteId = site,
                    endpoint = endpoint,
                    installId = startId,
                    context = DeviceContext.current(app),
                    store = if (s.consent) StateStore.inDirectory(dir) else null,
                    transport = HttpTransport(),
                    enabled = s.enabled,
                    sessionProperties = s.sessionProperties,
                ),
            )
            core = created
        }
        start(app, created, site, installId, provisional)
        // A session restored from the queue file gets the properties set before this call.
        val properties = synchronized(lock) { settings.sessionProperties }
        if (properties.isNotEmpty()) created.setSessionProperties(properties)
    }

    private fun start(app: Context, core: Core, siteId: String, mode: InstallId, provisional: String?) {
        if (core.needsReferrer) {
            core.hold(Core.HOLD_REFERRER, Core.REFERRER_WAIT_MS)
            referrerSource(app).fetch { raw ->
                core.resolveReferrer(raw)
                core.config.scope.launch { core.flush() }
            }
        }
        if (mode == InstallId.VENDOR) {
            val once = java.util.concurrent.atomic.AtomicBoolean(false)
            val arrived = { appSetId: String? ->
                if (once.compareAndSet(false, true)) vendorIdArrived(core, siteId, provisional, appSetId)
            }
            if (provisional != null) {
                core.hold(Core.HOLD_VENDOR, VendorInstallId.WAIT_MS)
                // Play services that never answer: the launch goes on under its random id.
                core.config.scope.launch {
                    kotlinx.coroutines.delay(VendorInstallId.WAIT_MS)
                    arrived(null)
                }
            }
            appSetIdSource(app).fetch { arrived(it) }
        }
        LifecycleBridge.install(core)
        NetworkWatcher.start(app, core)
    }

    internal fun vendorIdArrived(core: Core, siteId: String, provisional: String?, appSetId: String?) {
        val vendorId = appSetId?.let { VendorInstallId.derive(it, siteId) }
        val consent = synchronized(lock) {
            settings.vendorId = vendorId
            settings.consent
        }
        if (vendorId == null) SdkLog.i("FounderData: no developer-scoped App set ID, this launch uses a random install id")
        // A first consent stores the vendor id, so the install keeps its id; without one it stores the launch id.
        val target = if (consent && provisional != null) installIdStore.adopt(vendorId ?: provisional) else vendorId
        core.resolveVendorId(provisional ?: "", if (provisional != null) target else null, vendorId)
        core.config.scope.launch { core.flush() }
    }

    /** Records a screen view. The server stores it as a page view with path `/` + [name]. */
    @JvmStatic
    public fun screen(name: String) {
        val clipped = name.trim().trimStart('/').clipped(200) ?: return
        current?.record(Core.Action.Screen(clipped))
    }

    /** Records a goal (conversion), with optional string properties. */
    @JvmStatic
    @JvmOverloads
    public fun goal(name: String, props: Map<String, String> = emptyMap()) {
        val clipped = name.clipped(100) ?: return
        current?.record(Core.Action.Goal(clipped, cleanedProps(props)))
    }

    // Session properties, experiments, onboarding

    /** At most this many session properties are kept. Further keys are dropped. */
    public const val MAX_SESSION_PROPERTIES: Int = 10

    /**
     * Sets small properties on the current session and on every later session of this process, for example
     * `mapOf("user_state" to "returning", "build_channel" to "debug")`.
     *
     * Keys become lowercase `a-z`, `0-9` and `_`, at most 40 characters. Values are cut at 100 characters. An empty
     * value removes the key. Calls merge into the properties set so far; keys beyond [MAX_SESSION_PROPERTIES] are
     * dropped. Nothing is stored on the device: set them again on every launch, right after [configure].
     */
    @JvmStatic
    public fun setSessionProperties(properties: Map<String, String>) {
        val merged = synchronized(lock) {
            settings.sessionProperties = mergedSessionProperties(settings.sessionProperties, properties)
            settings.sessionProperties
        }
        current?.setSessionProperties(merged)
    }

    /** Sets one session property. An empty value removes it. See [setSessionProperties]. */
    @JvmStatic
    public fun setSessionProperty(key: String, value: String) {
        setSessionProperties(mapOf(key to value))
    }

    /** The session properties set so far in this process. */
    @JvmStatic
    public val sessionProperties: Map<String, String> get() = synchronized(lock) { settings.sessionProperties }

    /**
     * Records which variant of an experiment this launch sees, as the session property `exp_<name>`:
     * `experiment("paywall_copy", "b")` sets `exp_paywall_copy = b`. It counts toward the 10 session properties.
     */
    @JvmStatic
    public fun experiment(name: String, variant: String) {
        val key = propertyKey(name, 36) ?: return
        setSessionProperties(mapOf("exp_$key" to variant))
    }

    /**
     * The user reached onboarding step [index] (1 for the first) named [name]: the goal `onboarding_<name>` with the
     * props `step` and `index`. `onboardingStep(2, "Notifications")` sends `onboarding_notifications`.
     */
    @JvmStatic
    public fun onboardingStep(index: Int, name: String) {
        val goal = onboardingGoal(index, name) ?: return
        current?.record(goal)
    }

    internal fun onboardingGoal(index: Int, name: String): Core.Action.Goal? {
        val step = propertyKey(name, 53) ?: return null
        return Core.Action.Goal("onboarding_$step", mapOf("step" to step, "index" to index.toString()))
    }

    /** The user finished onboarding: the goal `onboarding_complete`. */
    @JvmStatic
    public fun onboardingComplete() {
        current?.record(Core.Action.Goal("onboarding_complete", emptyMap()))
    }

    // Goal helpers (docs/APP-EVENTS.md)

    /** The paywall became visible: `paywall_view` with `source`, and `paywall` when you pass an id or variant. */
    @JvmStatic
    @JvmOverloads
    public fun paywallViewed(source: PaywallSource, paywall: String? = null): Unit = send(GoalEvent.paywallView(source, paywall))

    /** The buy button was pressed: `purchase_start` with `source` and `product` (the Play product id). */
    @JvmStatic
    public fun purchaseStarted(product: String, source: PaywallSource): Unit =
        send(GoalEvent.purchase("purchase_start", product, source))

    /** Billing answered `USER_CANCELED`, or the payment sheet was dismissed: `purchase_cancelled`. */
    @JvmStatic
    public fun purchaseCancelled(product: String, source: PaywallSource): Unit =
        send(GoalEvent.purchase("purchase_cancelled", product, source))

    /** The purchase is `PENDING` (cash, bank transfer): `purchase_pending`. */
    @JvmStatic
    public fun purchasePending(product: String, source: PaywallSource): Unit =
        send(GoalEvent.purchase("purchase_pending", product, source))

    /** The purchase failed: `purchase_failed` with `reason`. */
    @JvmStatic
    public fun purchaseFailed(product: String, source: PaywallSource, reason: PurchaseFailureReason): Unit =
        send(GoalEvent.purchaseFailed(product, source, reason))

    /** The user pressed restore purchases: `restore_start`. */
    @JvmStatic
    public fun restoreStarted(source: PaywallSource): Unit = send(GoalEvent.of("restore_start", "source" to source.rawValue))

    /** Restore found a purchase to give back: `restore_success`. */
    @JvmStatic
    public fun restoreSucceeded(source: PaywallSource): Unit = send(GoalEvent.of("restore_success", "source" to source.rawValue))

    /** The user skipped the rest of onboarding at [step]: `onboarding_skip` with `step`. */
    @JvmStatic
    public fun onboardingSkipped(step: String): Unit = send(GoalEvent.onboardingSkip(step))

    /** The user started the task that leads to buying: `flow_start`. Send it once per session. */
    @JvmStatic
    public fun flowStarted(): Unit = send(GoalEvent("flow_start"))

    /** The user left that task without finishing it: `flow_exit` with `step`. */
    @JvmStatic
    public fun flowExited(step: String): Unit = send(GoalEvent.of("flow_exit", "step" to step))

    /** The user first got the app's core value in this launch: `activation`, with `what` when you pass it. */
    @JvmStatic
    @JvmOverloads
    public fun activation(what: String? = null): Unit = send(GoalEvent.of("activation", "what" to what))

    /** The system permission prompt for [kind] (`"notifications"`) is on screen: `permission_<kind>_prompt`. */
    @JvmStatic
    public fun permissionPrompted(kind: String) {
        GoalEvent.permissionPrompt(kind)?.let(::send)
    }

    /** The user answered the prompt for [kind]: `permission_<kind>` with `result`. */
    @JvmStatic
    public fun permissionAnswered(kind: String, result: PermissionResult) {
        GoalEvent.permission(kind, result)?.let(::send)
    }

    internal fun send(event: GoalEvent) = goal(event.name, event.props)

    // Purchases

    /**
     * Reports a Google Play purchase by its parts. Apps with Play Billing call `trackPurchase(purchase, kind)`
     * instead. Send it after Play Billing returns a purchase in the purchased state; each token is sent once per
     * launch (and once ever with consent). The server checks the token with Google before it stores money.
     */
    @JvmStatic
    public fun trackPurchase(purchaseToken: String, productId: String, kind: PurchaseKind, orderId: String?) {
        val token = purchaseToken.trim().takeIf { it.isNotEmpty() } ?: return
        val product = productId.clipped(200) ?: return
        current?.record(Core.Action.GooglePlayPurchase(token, product, kind.wire, orderId?.clipped(200)))
    }

    /**
     * Wraps your own purchase code, for example RevenueCat's `awaitPurchase`. Sends `purchase_start`, runs [perform],
     * then the goal for the outcome it returns. An exception from [perform] is reported (RevenueCat's
     * `PurchaseCancelledError` as `purchase_cancelled`, `PaymentPendingError` as `purchase_pending`, anything else as
     * `purchase_failed`) and thrown again unchanged.
     */
    public suspend fun trackPurchase(
        product: String,
        source: PaywallSource,
        perform: suspend () -> PurchaseOutcome,
    ): PurchaseOutcome = trackPurchase(product, source, ::send, perform)

    internal suspend fun trackPurchase(
        product: String,
        source: PaywallSource,
        send: (GoalEvent) -> Unit,
        perform: suspend () -> PurchaseOutcome,
    ): PurchaseOutcome {
        send(GoalEvent.purchase("purchase_start", product, source))
        val outcome = try {
            perform()
        } catch (e: Throwable) {
            if (e !is kotlinx.coroutines.CancellationException) {
                PurchaseOutcome.of(e).goal(product, source)?.let(send)
            }
            throw e
        }
        outcome.goal(product, source)?.let(send)
        return outcome
    }

    /**
     * The install id as a lowercase UUID (36 characters). Pass it to `BillingFlowParams.Builder.setObfuscatedAccountId`
     * so Google's purchase records can be credited to this install.
     *
     * Without consent it is the id of the current process. In [InstallId.VENDOR] mode it changes once, in the first
     * moments after [configure], when the App set ID arrives; read it when the user taps buy, not at startup.
     */
    @JvmStatic
    public val obfuscatedAccountId: String
        get() {
            current?.let { return it.installId }
            val (consent, launchId, hasContext) = synchronized(lock) { Triple(settings.consent, settings.launchId, appContext != null) }
            return if (consent && hasContext) installIdStore.adopt(launchId) else launchId
        }

    /**
     * The RevenueCat subscriber attribute that links a purchase to this install:
     * `{"founderDataVisitorId": <obfuscatedAccountId>}`. Pass it to `Purchases.sharedInstance.setAttributes` after
     * configuring RevenueCat, after `logIn`, after [reset] and before each purchase.
     */
    @JvmStatic
    public val revenueCatAttributes: Map<String, String> get() = mapOf(REVENUECAT_ATTRIBUTE_KEY to obfuscatedAccountId)

    /** The attribute name `src/worker/revenuecat.ts` reads. RevenueCat reserves names that start with `$`. */
    internal const val REVENUECAT_ATTRIBUTE_KEY = "founderDataVisitorId"

    // Users

    /** Links this install to your own user record. Call it after sign-in. */
    @JvmStatic
    @JvmOverloads
    public fun identify(userId: String?, email: String? = null, name: String? = null) {
        val user = userId?.clipped(128)
        val mail = email?.clipped(200)
        val display = name?.clipped(128)
        if (user == null && mail == null && display == null) return
        current?.record(Core.Action.Identify(user, mail, display))
    }

    /**
     * Call it when the user signs out. The next events go out under a new install id in a new session. Without
     * consent the new id is random and lives in memory (in [InstallId.VENDOR] mode until the process ends); with
     * consent it replaces the stored id. Session properties, consent and [isEnabled] stay.
     */
    @JvmStatic
    public fun reset() {
        val fresh = UUID.randomUUID().toString()
        val id = if (hasConsent) {
            installIdStore.erase()
            installIdStore.adopt(fresh)
        } else {
            fresh
        }
        synchronized(lock) { settings.launchId = id }
        current?.resetIdentity(id)
    }

    // Links

    /**
     * Reads campaign parameters (`utm_*`, `ref`), a web visitor id (`rt_vid`) and ad click ids (`gclid`, ...) from
     * the intent's data, an App Link or deep link. Call it from `onCreate` and `onNewIntent`. True when the link
     * carried any of them.
     */
    @JvmStatic
    public fun handle(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        return handle(data)
    }

    /** As [handle] for an intent, from a `Uri`. */
    @JvmStatic
    public fun handle(uri: Uri): Boolean = handle(uri.toString())

    /** As [handle] for an intent, from a URL string. */
    @JvmStatic
    public fun handle(url: String): Boolean {
        val source = LinkAttribution.fromUrl(url) ?: return false
        current?.attach(source)
        return true
    }

    // Consent and opt-out

    /** Whether the user agreed to on-device storage. Not stored by the SDK. */
    @JvmStatic
    public val hasConsent: Boolean get() = synchronized(lock) { settings.consent }

    /**
     * Turns on-device storage on or off. Call it with the user's stored choice before [configure] on every launch,
     * and again whenever the user changes it.
     *
     * - `true`: the install id and the queue go to `noBackupFilesDir/founderdata`, so an install keeps one id across
     *   launches and unsent events survive the process. An id stored by an earlier consent is used again.
     * - `false`: deletes that folder and continues in memory under a new random id, or the vendor id.
     */
    @JvmStatic
    public fun setConsent(granted: Boolean) {
        val wasGranted = synchronized(lock) { settings.consent.also { settings.consent = granted } }
        if (granted) {
            val c = current ?: return
            val dir = storageDir() ?: return
            if (c.isPersistent) return
            c.enablePersistence(StateStore.inDirectory(dir), installIdStore.adopt(c.installId))
        } else {
            if (wasGranted) {
                val next = synchronized(lock) {
                    settings.launchId = settings.vendorId ?: UUID.randomUUID().toString()
                    settings.launchId
                }
                current?.disablePersistence(next)
            }
            installIdStore.erase()
            val base = synchronized(lock) { appContext }?.noBackupFilesDir
            if (base != null) StorageDir.eraseAll(base) else synchronized(lock) { settings.eraseRequested = true }
        }
    }

    /**
     * Opt-out switch, kept in memory for this process. False drops every queued event and stops all collection until
     * it is set back to true. Store an opt-out in the app and set this before [configure] on every launch.
     */
    @JvmStatic
    public var isEnabled: Boolean
        get() = synchronized(lock) { settings.enabled }
        set(value) {
            synchronized(lock) { settings.enabled = value }
            current?.setEnabled(value)
        }

    /**
     * Uploads the queued events now and returns how many the server accepted, skipping the wait after a failed upload.
     * It returns 0 without sending when nothing is queued, before [configure], while another upload runs, or while
     * the first upload of a launch waits for the Install Referrer (at most 10 s) or the App set ID (at most 5 s).
     */
    @JvmStatic
    public suspend fun flush(): Int = flush(current)

    internal suspend fun flush(core: Core?): Int = core?.flush(ignoreBackoff = true) ?: 0

    // Configuration checks

    /** What is wrong with the arguments of [configure], one sentence each. Empty when they are fine. */
    internal fun configurationProblems(siteId: String, host: String, debugHost: String?): List<String> {
        val problems = ArrayList<String>()
        if (siteId.clipped(64) == null) {
            problems.add("the site id is empty. Copy it from the site's Settings in the FounderData dashboard.")
        }
        for ((name, value) in listOf("host" to host, "debugHost" to debugHost)) {
            val problem = value?.let(::hostProblem) ?: continue
            problems.add("$name \"$value\" $problem")
        }
        return problems
    }

    /** Null for an https URL, or an http URL on this machine, the emulator's host or the local network. */
    internal fun hostProblem(host: String): String? {
        val url = Endpoint.events(host) ?: return "is not a URL."
        return when (url.protocol.lowercase()) {
            "https" -> null
            "http" -> if (isLocalHost(url.host ?: "")) null else HTTP_PROBLEM
            else -> HTTP_PROBLEM
        }
    }

    private const val HTTP_PROBLEM =
        "needs https. Plain http works only for localhost, *.local and private network addresses (10.0.2.2 on the emulator)."

    /** `localhost`, `*.local`, loopback and private IPv4 addresses (10/8, 172.16/12, 192.168/16). */
    internal fun isLocalHost(host: String): Boolean {
        val name = host.lowercase().trim('[', ']')
        if (name == "localhost" || name == "::1" || name.endsWith(".local")) return true
        val octets = name.split('.')
        val parts = octets.mapNotNull { it.toIntOrNull()?.takeIf { n -> n in 0..255 && it.all(Char::isDigit) } }
        if (octets.size != 4 || parts.size != 4) return false
        return when {
            parts[0] == 127 || parts[0] == 10 -> true
            parts[0] == 192 && parts[1] == 168 -> true
            parts[0] == 172 && parts[1] in 16..31 -> true
            else -> false
        }
    }

    /**
     * The server stores props as JSON cut at 1,000 characters, and a cut JSON string is unreadable. Keep at most 20
     * props and stay under that size.
     */
    internal fun cleanedProps(props: Map<String, String>): Map<String, String> {
        val cleaned = LinkedHashMap<String, String>()
        var size = 2
        for ((key, value) in props.entries.sortedBy { it.key }) {
            if (cleaned.size >= 20) continue
            val k = key.clipped(64) ?: continue
            val v = value.clipped(256) ?: continue
            val entry = Json.write(mapOf(k to v)).toByteArray(Charsets.UTF_8).size
            if (size + entry - 1 > 1_000) continue
            size += entry - 1
            cleaned[k] = v
        }
        return cleaned
    }

    /** Lowercase `a-z`, `0-9` and `_`; other characters become `_`, leading and trailing `_` are removed. */
    internal fun propertyKey(raw: String, maxLength: Int = 40): String? {
        val out = StringBuilder()
        for (ch in raw.lowercase()) out.append(if (ch in 'a'..'z' || ch in '0'..'9' || ch == '_') ch else '_')
        val trimmed = out.toString().trim('_')
        if (trimmed.isEmpty()) return null
        return trimmed.take(maxLength)
    }

    internal fun mergedSessionProperties(current: Map<String, String>, update: Map<String, String>): Map<String, String> {
        val out = LinkedHashMap(current)
        for ((rawKey, rawValue) in update.entries.sortedBy { it.key }) {
            val key = propertyKey(rawKey) ?: continue
            val value = rawValue.clipped(100)
            if (value == null) {
                out.remove(key)
                continue
            }
            if (!out.containsKey(key) && out.size >= MAX_SESSION_PROPERTIES) {
                SdkLog.i("FounderData keeps $MAX_SESSION_PROPERTIES session properties, dropped one")
                continue
            }
            out[key] = value
        }
        return out
    }

    /** Forgets the running core and the settings. Tests only. */
    internal fun resetForTests() {
        synchronized(lock) {
            core = null
            settings = Settings()
            appContext = null
        }
        installIdStore.forget()
    }

    /** Runs [core] as the configured core. Tests only. */
    internal fun installForTests(core: Core) {
        synchronized(lock) { this.core = core }
    }

    internal val installIdFileCalls: Int get() = installIdStore.fileCalls
}
