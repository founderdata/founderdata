package com.founderdata

internal data class QueuedEvent(
    val id: Long,
    val vid: String,
    val ctx: WireContext,
    val event: WireEvent,
) {
    fun toJson(): Map<String, Any?> = mapOf("id" to id, "vid" to vid, "ctx" to ctx.toJson(), "event" to event.toJson())

    companion object {
        fun fromJson(m: Map<*, *>): QueuedEvent? {
            val id = m.long("id") ?: return null
            val vid = m.str("vid") ?: return null
            val ctx = m.obj("ctx")?.let(WireContext::fromJson) ?: return null
            val event = m.obj("event")?.let(WireEvent::fromJson) ?: return null
            return QueuedEvent(id, vid, ctx, event)
        }
    }
}

/** One request body ready to send, with the queue ids it covers. */
internal class OutgoingBatch(val ids: List<Long>, val body: ByteArray)

/** Offline queue. Oldest first, capped at 2,000 events, events older than 72 hours dropped. Not thread-safe. */
internal class EventQueue {
    private val list = ArrayList<QueuedEvent>()
    var nextId: Long = 1
        private set

    val items: List<QueuedEvent> get() = list.toList()
    val count: Int get() = list.size
    val isEmpty: Boolean get() = list.isEmpty()

    /** Appends an event and drops the oldest beyond the cap. Returns how many were dropped. */
    fun append(event: WireEvent, vid: String, ctx: WireContext): Int {
        list.add(QueuedEvent(nextId, vid, ctx, event))
        nextId += 1
        val overflow = list.size - MAX_COUNT
        if (overflow <= 0) return 0
        repeat(overflow) { list.removeAt(0) }
        return overflow
    }

    /** Drops events whose client time is more than 72 hours before [nowMs]. Returns how many were dropped. */
    fun purgeExpired(nowMs: Long): Int {
        val cutoff = nowMs - MAX_AGE_MS
        val before = list.size
        list.removeAll { it.event.ts < cutoff }
        return before - list.size
    }

    fun remove(ids: Collection<Long>) {
        val set = ids.toHashSet()
        list.removeAll { it.id in set }
    }

    fun removeAll() = list.clear()

    /**
     * Merges [source] into the queued `session_start` of [sid]; with [fillOnly] it only fills fields that are unset.
     * False when that event already left the queue.
     */
    fun mergeSource(source: WireSource, sid: String, fillOnly: Boolean = false): Boolean {
        val index = indexOfStart(sid)
        if (index < 0) return false
        val item = list[index]
        val existing = item.event.src ?: WireSource()
        val merged = if (fillOnly) source.merging(existing) else existing.merging(source)
        list[index] = item.copy(event = item.event.copy(src = if (merged.isEmpty) null else merged))
        return true
    }

    /** Replaces the session properties on the queued `session_start` of [sid]. False when it already left. */
    fun setSessionProperties(props: Map<String, String>, sid: String): Boolean {
        val index = indexOfStart(sid)
        if (index < 0) return false
        val item = list[index]
        list[index] = item.copy(event = item.event.copy(sp = props.ifEmpty { null }))
        return true
    }

    /** Rewrites the install id (and context) of every queued event under [from]. Returns how many changed. */
    fun rekey(from: String, to: String, ctx: (WireContext) -> WireContext): Int {
        var changed = 0
        for (i in list.indices) {
            val item = list[i]
            if (item.vid == from) {
                list[i] = item.copy(vid = to, ctx = ctx(item.ctx))
                changed++
            }
        }
        return changed
    }

    private fun indexOfStart(sid: String) =
        list.indexOfFirst { it.event.t == WireEventType.SESSION_START && it.event.sid == sid }

    /**
     * The next request body: the oldest events sharing one `vid` and `ctx`, at most [maxCount] of them and at most
     * [maxBytes] (always at least one event).
     */
    fun nextBatch(siteId: String, maxCount: Int = MAX_BATCH_COUNT, maxBytes: Int = MAX_BODY_BYTES): OutgoingBatch? {
        val first = list.firstOrNull() ?: return null
        var bytes = utf8Size(WireBatch(siteId, first.ctx, first.vid, emptyList()).encoded())
        val chosen = ArrayList<QueuedEvent>()
        for (item in list) {
            if (chosen.size >= maxCount || item.vid != first.vid || item.ctx != first.ctx) break
            val size = utf8Size(item.event.encoded()) + 1
            if (chosen.isNotEmpty() && bytes + size > maxBytes) break
            bytes += size
            chosen.add(item)
        }
        val body = WireBatch(siteId, first.ctx, first.vid, chosen.map { it.event }).encoded()
        return OutgoingBatch(chosen.map { it.id }, body.toByteArray(Charsets.UTF_8))
    }

    fun toJson(): Map<String, Any?> = mapOf("items" to list.map { it.toJson() }, "nextId" to nextId)

    fun copy(): EventQueue = EventQueue().also {
        it.list.addAll(list)
        it.nextId = nextId
    }

    companion object {
        const val MAX_COUNT = 2_000
        const val MAX_BATCH_COUNT = 50
        /** The server accepts 64 KB per body. Keep a margin. */
        const val MAX_BODY_BYTES = 60 * 1024
        const val MAX_AGE_MS: Long = 72L * 60 * 60 * 1000

        fun fromJson(m: Map<*, *>): EventQueue {
            val q = EventQueue()
            m.list("items")?.forEach { raw -> (raw as? Map<*, *>)?.let(QueuedEvent::fromJson)?.let(q.list::add) }
            q.nextId = maxOf(m.long("nextId") ?: 1, (q.list.maxOfOrNull { it.id } ?: 0) + 1)
            return q
        }

        private fun utf8Size(s: String) = s.toByteArray(Charsets.UTF_8).size
    }
}
