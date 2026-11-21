package com.founderdata

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Thread-safe engine behind the public [FounderData] API, a port of the Swift SDK's `Core`.
 *
 * Every public call takes the lock once, updates the session and the queue synchronously (so event order is call
 * order), then schedules a coalesced write of the state file. Delivery runs in a coroutine and never holds the lock
 * across a network call. Without a store (the default, no consent) the queue and the session live in memory only.
 */
internal class Core(val config: Configuration) {
    class Configuration(
        val siteId: String,
        val endpoint: URL,
        /** The id events start with. Consent: the stored id. Otherwise random per process. */
        val installId: String,
        val context: WireContext,
        /** Where the queue is saved. Null keeps everything in memory. */
        val store: StateStore?,
        val transport: Transport,
        val now: () -> Long = { System.currentTimeMillis() },
        val enabled: Boolean = true,
        val jitter: () -> Double = { 0.8 + Math.random() * 0.4 },
        val makeSessionId: () -> String = { UUID.randomUUID().toString() },
        /** Delay before a scheduled save is written. Lifecycle events write at once. */
        val saveDelayMs: Long = 1_000,
        /** Send a purchase right away instead of waiting for the next timer tick. */
        val flushAfterPurchase: Boolean = true,
        /** Session properties set before `configure`. */
        val sessionProperties: Map<String, String> = emptyMap(),
        /** The [InstallId.VENDOR] id when already known. Events under it without consent carry `ctx.id`. */
        val vendorInstallId: String? = null,
        val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    )

    sealed class Action {
        data class Screen(val name: String) : Action()
        data class Goal(val name: String, val props: Map<String, String>) : Action()
        data class Identify(val userId: String?, val email: String?, val name: String?) : Action()
        data class GooglePlayPurchase(val token: String, val product: String, val kind: String, val order: String?) : Action()
    }

    class State(
        var installId: String,
        var store: StateStore?,
        var session: SessionTracker,
        var sessionProperties: Map<String, String>,
        var enabled: Boolean,
        var vendorInstallId: String?,
    ) {
        var queue = EventQueue()
        var pendingSource: WireSource? = null
        var referrerResolved = false
        var reportedPurchases: List<String> = emptyList()
        var flushing = false
        var failures = 0
        var nextAttemptAt: Long? = null
        /** Reasons delivery waits, each with its deadline: the Install Referrer and the App set ID. */
        val holds = HashMap<String, Long>()
        var saveScheduled = false

        fun persisted() = PersistedState(
            queue = queue.copy(),
            session = session.state,
            pendingSource = pendingSource,
            referrerResolved = referrerResolved,
            reportedPurchases = reportedPurchases.toList(),
        )
    }

    private val lock = Any()
    private val state: State
    private val io: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "founderdata-io").apply { isDaemon = true }
    }

    init {
        val initial = State(
            installId = config.installId,
            store = config.store,
            session = SessionTracker(makeId = config.makeSessionId),
            sessionProperties = config.sessionProperties,
            enabled = config.enabled,
            vendorInstallId = config.vendorInstallId,
        )
        if (config.enabled) {
            config.store?.load()?.let { stored ->
                initial.queue = stored.queue
                initial.session.state = stored.session
                initial.session.relaunched()
                initial.pendingSource = stored.pendingSource
                initial.referrerResolved = stored.referrerResolved
                initial.reportedPurchases = stored.reportedPurchases
                initial.queue.purgeExpired(config.now())
            }
        } else {
            config.store?.delete()
        }
        state = initial
    }

    private inline fun <T> locked(block: State.() -> T): T = synchronized(lock) { state.block() }

    // Events

    fun record(action: Action) {
        val now = config.now()
        val isPurchase = locked {
            if (!enabled) return@locked false
            var purchase = false
            if (action is Action.GooglePlayPurchase) {
                if (action.token in reportedPurchases) return@locked false
                reportedPurchases = (reportedPurchases + action.token).takeLast(MAX_REPORTED_PURCHASES)
                purchase = true
            }
            val (sid, start) = session.ensureSession(now, pendingSource)
            if (start != null) {
                pendingSource = null
                enqueue(start)
            }
            enqueue(event(action, sid, now))
            purchase
        }
        scheduleSave()
        if (isPurchase && config.flushAfterPurchase) config.scope.launch { flush() }
    }

    /** A deep link or App Link with attribution parameters. */
    fun attach(linkSource: WireSource) {
        val now = config.now()
        locked {
            if (!enabled) return@locked
            val sid = session.sessionId
            val started = session.state.startedAt
            if (sid != null && !session.isExpired(now) && started != null &&
                now - started < SOURCE_MERGE_WINDOW_MS && queue.mergeSource(linkSource, sid)
            ) return@locked
            session.closeForRestart(now).forEach { enqueue(it) }
            val merged = (pendingSource ?: WireSource()).merging(linkSource)
            pendingSource = null
            enqueue(session.startSession(now, merged).second)
        }
        scheduleSave()
    }

    /** The full set of session properties. A running session gets them on its queued `session_start` or one event. */
    fun setSessionProperties(props: Map<String, String>) {
        val now = config.now()
        val changed = locked {
            sessionProperties = props
            val sid = session.sessionId
            if (!enabled || sid == null || session.isExpired(now)) return@locked false
            if ((session.state.properties ?: emptyMap()) == props) return@locked false
            session.state = session.state.copy(properties = props)
            if (queue.setSessionProperties(props, sid)) return@locked true
            enqueue(WireEvent(WireEventType.SESSION_PROPS, sid, now, p = props))
            true
        }
        if (changed) scheduleSave()
    }

    // Holds: the Install Referrer and the App set ID join the first batch

    val needsReferrer: Boolean get() = locked { enabled && !referrerResolved }

    fun hold(reason: String, forMs: Long) {
        val until = config.now() + forMs
        locked { holds[reason] = until }
    }

    /**
     * The Play Install Referrer string (or null): its `utm_*`, `ref` and click ids go into the first session's `src`.
     * They only fill fields that are unset: a link the app opened with (`handle`) wins over the referrer.
     */
    fun resolveReferrer(raw: String?) {
        locked {
            referrerResolved = true
            holds.remove(HOLD_REFERRER)
            if (!enabled) return@locked
            val source = raw?.let(LinkAttribution::fromQuery) ?: return@locked
            val sid = session.sessionId
            if (sid != null && queue.mergeSource(source, sid, fillOnly = true)) return@locked
            pendingSource = source.merging(pendingSource ?: WireSource())
        }
        scheduleSave()
    }

    /**
     * The App set ID arrived (or not) for an [InstallId.VENDOR] launch. When the core still runs under [provisional],
     * the launch id it started with, events continue under [resolved], and the queued ones move to it too: delivery
     * was held, so none of them left yet.
     */
    fun resolveVendorId(provisional: String, resolved: String?, vendorId: String?) {
        locked {
            holds.remove(HOLD_VENDOR)
            vendorInstallId = vendorId
            if (resolved == null || installId != provisional || resolved == provisional) return@locked
            installId = resolved
            queue.rekey(provisional, resolved) { ctx ->
                if (ctx.consent != true && resolved == vendorId) ctx.copy(id = VendorInstallId.CONTEXT_VALUE) else ctx
            }
        }
        scheduleSave()
    }

    // Lifecycle

    fun appBecameActive() {
        val now = config.now()
        locked {
            if (!enabled) return@locked
            session.becameActive(now, pendingSource)?.let {
                pendingSource = null
                enqueue(it)
            }
        }
        scheduleSave()
    }

    fun appResignedActive() {
        val now = config.now()
        locked { if (enabled) session.resignedActive(now) }
    }

    fun appEnteredBackground() {
        val now = config.now()
        locked {
            if (!enabled) return@locked
            session.enteredBackground(now).forEach { enqueue(it) }
        }
        saveNow()
    }

    /** 30-second timer while the app is visible. */
    fun tick() {
        val now = config.now()
        val added = locked {
            if (!enabled) return@locked false
            val pings = session.tick(now)
            pings.forEach { enqueue(it) }
            pings.isNotEmpty()
        }
        if (added) scheduleSave()
    }

    // Consent

    val installId: String get() = locked { installId }
    val isPersistent: Boolean get() = locked { store != null }
    val vendorInstallId: String? get() = locked { vendorInstallId }

    /**
     * Consent given: from now on the queue is saved to [store]. When the device holds an id from an earlier consent
     * ([newId] differs), events continue under it in a new session; otherwise the visit continues.
     */
    fun enablePersistence(store: StateStore, newId: String) {
        val now = config.now()
        val stored = store.load()
        locked {
            this.store = store
            if (!enabled) return@locked
            if (newId != installId) restart(newId, now)
            if (stored != null) {
                val merged = EventQueue()
                for (item in stored.queue.items + queue.items) merged.append(item.event, item.vid, item.ctx)
                merged.purgeExpired(now)
                queue = merged
                referrerResolved = referrerResolved || stored.referrerResolved
                reportedPurchases = (stored.reportedPurchases + reportedPurchases).takeLast(MAX_REPORTED_PURCHASES)
            }
        }
        saveNow()
    }

    /** Consent withdrawn: nothing is saved any more, and events continue in memory under [newId] in a new session. */
    fun disablePersistence(newId: String) {
        val now = config.now()
        val old = locked { store.also { store = null } }
        // On the io thread, so a save already scheduled cannot write the file again afterwards.
        runOnIo { old?.delete() }
        locked {
            store = null
            saveScheduled = false
            restart(newId, now)
        }
    }

    /** Sign-out: events continue under [newId] in a new session. Queued events keep their id. */
    fun resetIdentity(newId: String) {
        val now = config.now()
        locked { restart(newId, now) }
        saveNow()
    }

    private fun State.restart(newId: String, now: Long) {
        if (!enabled) {
            installId = newId
            return
        }
        session.closeForRestart(now).forEach { enqueue(it) }
        session.end()
        installId = newId
    }

    // Opt-out

    val isEnabled: Boolean get() = locked { enabled }

    fun setEnabled(value: Boolean) {
        locked {
            enabled = value
            if (!value) {
                queue.removeAll()
                session = SessionTracker(makeId = config.makeSessionId)
                pendingSource = null
                holds.clear()
                failures = 0
                nextAttemptAt = null
            }
        }
        saveNow()
    }

    // Delivery

    /**
     * Sends queued events in batches until the queue is empty or a request fails. [ignoreBackoff] is for the upload
     * on background and for [FounderData.flush]. Returns the number of events the server accepted.
     */
    suspend fun flush(ignoreBackoff: Boolean = false): Int {
        val start = config.now()
        val claimed = locked {
            if (!enabled || flushing) return@locked false
            holds.entries.removeAll { it.value <= start }
            if (holds.isNotEmpty()) return@locked false
            val next = nextAttemptAt
            if (!ignoreBackoff && next != null && start < next) return@locked false
            queue.purgeExpired(start)
            if (queue.isEmpty) return@locked false
            flushing = true
            true
        }
        if (!claimed) return 0

        var delivered = 0
        try {
            while (true) {
                val batch = locked { if (enabled) queue.nextBatch(config.siteId) else null } ?: break
                val response = try {
                    config.transport.post(batch.body, config.endpoint)
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    TransportResponse(-1)
                }
                val outcome = DeliveryOutcome.of(response.status)
                val failedAt = config.now()
                val jitter = config.jitter()
                locked {
                    when (outcome) {
                        DeliveryOutcome.DELIVERED -> {
                            queue.remove(batch.ids)
                            failures = 0
                            nextAttemptAt = null
                        }
                        DeliveryOutcome.REJECTED -> queue.remove(batch.ids)
                        DeliveryOutcome.RETRY -> {
                            failures += 1
                            nextAttemptAt = failedAt + Backoff.waitMs(failures, jitter, response.retryAfterSeconds)
                        }
                    }
                }
                when (outcome) {
                    DeliveryOutcome.DELIVERED -> delivered += batch.ids.size
                    DeliveryOutcome.REJECTED ->
                        SdkLog.e("FounderData server rejected a batch of ${batch.ids.size} events (HTTP ${response.status}), dropped it")
                    DeliveryOutcome.RETRY -> {
                        SdkLog.d("FounderData delivery failed (status ${response.status}), will retry")
                        break
                    }
                }
            }
        } finally {
            locked { flushing = false }
        }
        scheduleSave()
        return delivered
    }

    /** Network came back: forget the backoff and send. */
    suspend fun networkReturned() {
        locked {
            failures = 0
            nextAttemptAt = null
        }
        flush()
    }

    // Persistence

    fun scheduleSave() {
        val first = locked {
            if (store == null || saveScheduled) return@locked false
            saveScheduled = true
            true
        }
        if (!first) return
        io.schedule({ writeSnapshot() }, config.saveDelayMs, TimeUnit.MILLISECONDS)
    }

    /** Writes the state file before returning. */
    fun saveNow() {
        if (locked { store == null }) return
        runOnIo { writeSnapshot() }
    }

    private fun runOnIo(block: () -> Unit) {
        io.submit(block).get()
    }

    private fun writeSnapshot() {
        val (store, snapshot) = locked {
            saveScheduled = false
            store to (if (enabled) persisted() else null)
        }
        store ?: return
        if (snapshot != null) store.save(snapshot) else store.delete()
    }

    // Test access

    /** A copy of the state, for tests. */
    val snapshot: Snapshot
        get() = locked {
            Snapshot(installId, queue.copy(), session.state, pendingSource, failures, nextAttemptAt, referrerResolved, store != null)
        }

    data class Snapshot(
        val installId: String,
        val queue: EventQueue,
        val session: SessionState,
        val pendingSource: WireSource?,
        val failures: Int,
        val nextAttemptAt: Long?,
        val referrerResolved: Boolean,
        val persistent: Boolean,
    )

    // Helpers

    private fun State.enqueue(event: WireEvent) {
        var e = event
        if (e.t == WireEventType.SESSION_START) {
            // Every new session starts with the launch's session properties.
            e = e.copy(sp = sessionProperties.ifEmpty { null })
            session.state = session.state.copy(properties = sessionProperties)
        }
        var ctx = config.context
        val vendor = vendorInstallId
        if (store != null) {
            ctx = ctx.copy(consent = true)
        } else if (vendor != null && installId == vendor) {
            ctx = ctx.copy(id = VendorInstallId.CONTEXT_VALUE)
        }
        val dropped = queue.append(e, installId, ctx)
        if (dropped > 0) SdkLog.i("FounderData queue full, dropped $dropped oldest events")
    }

    companion object {
        /** A link this soon after a session started fills that session's `src` (cold launch from a link). */
        const val SOURCE_MERGE_WINDOW_MS: Long = 60_000
        /** Longest wait for the Install Referrer before the first batch leaves. */
        const val REFERRER_WAIT_MS: Long = 10_000
        const val MAX_REPORTED_PURCHASES = 200
        const val HOLD_REFERRER = "referrer"
        const val HOLD_VENDOR = "vendor"
        const val GOOGLE_PLAY = "google_play"

        fun event(action: Action, sid: String, now: Long): WireEvent = when (action) {
            is Action.Screen -> WireEvent(WireEventType.SCREEN, sid, now, n = action.name)
            is Action.Goal -> WireEvent(WireEventType.GOAL, sid, now, n = action.name, p = action.props.ifEmpty { null })
            is Action.Identify -> WireEvent(
                WireEventType.IDENTIFY, sid, now,
                p = buildMap {
                    action.userId?.let { put("user_id", it) }
                    action.email?.let { put("email", it) }
                    action.name?.let { put("name", it) }
                },
            )
            is Action.GooglePlayPurchase -> WireEvent(
                WireEventType.PURCHASE, sid, now,
                store = GOOGLE_PLAY, token = action.token, product = action.product, kind = action.kind, order = action.order,
            )
        }
    }
}
