package com.founderdata

/** Persisted part of the session clock. Times are Unix milliseconds. */
internal data class SessionState(
    val sessionId: String? = null,
    val startedAt: Long? = null,
    val lastActivityAt: Long? = null,
    /** Set while the app is in the background. */
    val backgroundedAt: Long? = null,
    /** Set while the app is visible (started). */
    val activeSince: Long? = null,
    /** Engaged time not yet reported in a ping. */
    val engagedMs: Long = 0,
    /** Session properties this session already carries (on its `session_start` or a `session_props` event). */
    val properties: Map<String, String>? = null,
) {
    fun toJson(): Map<String, Any?> = mapOf(
        "sessionId" to sessionId,
        "startedAt" to startedAt,
        "lastActivityAt" to lastActivityAt,
        "backgroundedAt" to backgroundedAt,
        "activeSince" to activeSince,
        "engagedMs" to engagedMs,
        "properties" to properties,
    )

    companion object {
        fun fromJson(m: Map<*, *>) = SessionState(
            sessionId = m.str("sessionId"),
            startedAt = m.long("startedAt"),
            lastActivityAt = m.long("lastActivityAt"),
            backgroundedAt = m.long("backgroundedAt"),
            activeSince = m.long("activeSince"),
            engagedMs = m.long("engagedMs") ?: 0,
            properties = m.stringMap("properties"),
        )
    }
}

/**
 * Session rules, free of Android and I/O so tests can drive them with a fake clock. The same rules as the Swift SDK:
 *
 * - A session starts on the first event or when the app comes to the foreground.
 * - It ends after 30 minutes in the background (or 30 minutes idle without lifecycle callbacks); the next event or
 *   foreground starts a new one.
 * - `ping` carries engaged time as a delta, every 5 minutes while active, split at 10 minutes (the server's cap).
 */
internal class SessionTracker(
    var state: SessionState = SessionState(),
    private val makeId: () -> String = { java.util.UUID.randomUUID().toString() },
) {
    val sessionId: String? get() = state.sessionId

    fun isExpired(now: Long): Boolean {
        if (state.sessionId == null) return true
        if (state.activeSince != null) return false
        val idleSince = state.backgroundedAt ?: state.lastActivityAt ?: state.startedAt ?: return true
        return now - idleSince >= TIMEOUT_MS
    }

    /** The session id for an event at [now], and a `session_start` if a new session began. */
    fun ensureSession(now: Long, source: WireSource?): Pair<String, WireEvent?> {
        val sid = state.sessionId
        if (!isExpired(now) && sid != null) {
            state = state.copy(lastActivityAt = now)
            return sid to null
        }
        return startSession(now, source)
    }

    /** Starts a new session unconditionally. Call [closeForRestart] first to report open engaged time. */
    fun startSession(now: Long, source: WireSource?): Pair<String, WireEvent> {
        val sid = makeId()
        val wasActive = state.activeSince != null
        state = SessionState(
            sessionId = sid,
            startedAt = now,
            lastActivityAt = now,
            activeSince = if (wasActive) now else null,
        )
        val src = if (source == null || source.isEmpty) null else source
        return sid to WireEvent(WireEventType.SESSION_START, sid, now, src = src)
    }

    /** App came to the foreground. Starts a session when none is running or the old one timed out. */
    fun becameActive(now: Long, source: WireSource?): WireEvent? {
        var start: WireEvent? = null
        if (isExpired(now)) start = startSession(now, source).second
        state = state.copy(backgroundedAt = null, activeSince = state.activeSince ?: now, lastActivityAt = now)
        return start
    }

    fun resignedActive(now: Long) {
        val since = state.activeSince ?: return
        state = state.copy(engagedMs = state.engagedMs + ms(since, now), activeSince = null, lastActivityAt = now)
    }

    /** App went to the background. Returns the pings for engaged time since the last ping. */
    fun enteredBackground(now: Long): List<WireEvent> {
        resignedActive(now)
        val total = state.engagedMs
        state = state.copy(engagedMs = 0, backgroundedAt = now, lastActivityAt = now)
        return pings(total, now)
    }

    /** Timer tick while active. Reports engaged time once it reaches 5 minutes. */
    fun tick(now: Long): List<WireEvent> {
        if (state.sessionId == null) return emptyList()
        val since = state.activeSince ?: return emptyList()
        val total = state.engagedMs + ms(since, now)
        if (total < PING_INTERVAL_MS) return emptyList()
        state = state.copy(engagedMs = 0, activeSince = now, lastActivityAt = now)
        return pings(total, now)
    }

    /** Reports engaged time of the current session before a new session replaces it. */
    fun closeForRestart(now: Long): List<WireEvent> {
        var total = state.engagedMs
        val since = state.activeSince
        if (since != null) {
            total += ms(since, now)
            state = state.copy(activeSince = now)
        }
        state = state.copy(engagedMs = 0)
        return pings(total, now)
    }

    /** Ends the session without a ping; call [closeForRestart] first. An app still active stays active. */
    fun end() {
        state = SessionState(activeSince = state.activeSince)
    }

    /** After a cold launch the process was gone, so there is no active stretch to continue. */
    fun relaunched() {
        state = state.copy(activeSince = null, engagedMs = 0)
    }

    private fun pings(totalMs: Long, now: Long): List<WireEvent> {
        val sid = state.sessionId ?: return emptyList()
        if (totalMs <= 0) return emptyList()
        var remaining = totalMs
        val out = ArrayList<WireEvent>()
        while (remaining > 0) {
            val chunk = minOf(remaining, MAX_PING_MS)
            out.add(WireEvent(WireEventType.PING, sid, now, d = chunk))
            remaining -= chunk
        }
        return out
    }

    companion object {
        const val TIMEOUT_MS: Long = 30L * 60 * 1000
        const val PING_INTERVAL_MS: Long = 5L * 60 * 1000
        const val MAX_PING_MS: Long = 10L * 60 * 1000

        fun ms(start: Long, end: Long): Long = maxOf(0, end - start)
    }
}
