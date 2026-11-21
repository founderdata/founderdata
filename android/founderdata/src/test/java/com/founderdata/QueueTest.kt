package com.founderdata

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QueueTest {
    private fun screen(i: Int, ts: Long = T0) = WireEvent(WireEventType.SCREEN, "s1", ts, n = "Screen$i")

    @Test fun capKeepsNewestTwoThousand() {
        val q = EventQueue()
        var dropped = 0
        for (i in 0 until 2_050) dropped += q.append(screen(i), LAUNCH_ID, FIXTURE)
        assertEquals(2_000, q.count)
        assertEquals(50, dropped)
        assertEquals("Screen50", q.items.first().event.n)
        assertEquals("Screen2049", q.items.last().event.n)
    }

    @Test fun dropsEventsOlderThanSeventyTwoHours() {
        val q = EventQueue()
        q.append(screen(0, T0 - EventQueue.MAX_AGE_MS - 1), LAUNCH_ID, FIXTURE)
        q.append(screen(1, T0 - EventQueue.MAX_AGE_MS), LAUNCH_ID, FIXTURE)
        q.append(screen(2, T0), LAUNCH_ID, FIXTURE)
        assertEquals(1, q.purgeExpired(T0))
        assertEquals(listOf("Screen1", "Screen2"), q.items.map { it.event.n })
    }

    @Test fun batchHoldsAtMostFifty() {
        val q = EventQueue()
        for (i in 0 until 120) q.append(screen(i), LAUNCH_ID, FIXTURE)
        val batch = q.nextBatch("site_1")!!
        assertEquals(50, batch.ids.size)
        val decoded = WireBatch.decode(String(batch.body))
        assertEquals(50, decoded.events.size)
        assertEquals("Screen0", decoded.events.first().n)
    }

    @Test fun batchStaysUnderBodyLimit() {
        val q = EventQueue()
        val token = "a".repeat(5_000)
        repeat(30) {
            q.append(WireEvent(WireEventType.PURCHASE, "s1", T0, store = "google_play", token = token, product = "p", kind = "subs"), LAUNCH_ID, FIXTURE)
        }
        val batch = q.nextBatch("site_1")!!
        assertTrue(batch.body.size <= EventQueue.MAX_BODY_BYTES)
        assertEquals("5 KB tokens: 11 fit in 60 KB", 11, batch.ids.size)
        assertTrue(batch.body.size < 64 * 1024)
    }

    @Test fun oversizedSingleEventStillLeavesAlone() {
        val q = EventQueue()
        q.append(WireEvent(WireEventType.GOAL, "s1", T0, n = "x", p = mapOf("v" to "b".repeat(70_000))), LAUNCH_ID, FIXTURE)
        q.append(screen(1), LAUNCH_ID, FIXTURE)
        assertEquals(listOf(1L), q.nextBatch("site_1")!!.ids)
    }

    @Test fun batchDoesNotMixContexts() {
        val q = EventQueue()
        val newer = FIXTURE.copy(appVersion = "1.5.0")
        q.append(screen(0), LAUNCH_ID, FIXTURE)
        q.append(screen(1), LAUNCH_ID, FIXTURE)
        q.append(screen(2), LAUNCH_ID, newer)
        val first = q.nextBatch("site_1")!!
        assertEquals(listOf(1L, 2L), first.ids)
        q.remove(first.ids)
        assertEquals("1.5.0", WireBatch.decode(String(q.nextBatch("site_1")!!.body)).ctx.appVersion)
    }

    @Test fun queueAndSessionSurviveRelaunch() {
        val first = Harness()
        try {
            first.core.appBecameActive()
            first.core.record(Core.Action.Screen("Home"))
            first.core.record(Core.Action.Goal("onboarding_complete", mapOf("variant" to "b")))
            first.core.saveNow()
            assertTrue(first.stateFile.exists())

            val second = Harness.makeCore(first.directory, first.clock, first.transport, first.ids)
            val restored = second.snapshot
            assertEquals(
                listOf(WireEventType.SESSION_START, WireEventType.SCREEN, WireEventType.GOAL),
                restored.queue.items.map { it.event.t },
            )
            assertEquals(listOf(1L, 2L, 3L), restored.queue.items.map { it.id })
            assertEquals("s1", restored.session.sessionId)
            assertNull(restored.session.activeSince)

            second.record(Core.Action.Screen("Settings"))
            assertEquals(4L, second.snapshot.queue.items.last().id)
            assertEquals("s1", second.snapshot.queue.items.last().event.sid)
        } finally {
            first.cleanUp()
        }
    }

    @Test fun relaunchDropsExpiredEvents() {
        val first = Harness()
        try {
            first.core.record(Core.Action.Screen("Old"))
            first.core.saveNow()
            first.clock.advance(73 * 3600)
            val second = Harness.makeCore(first.directory, first.clock, first.transport, first.ids)
            assertTrue(second.snapshot.queue.isEmpty)
        } finally {
            first.cleanUp()
        }
    }

    @Test fun flushSendsAllAndEmptiesQueue() = runBlocking {
        val h = Harness()
        try {
            for (i in 0 until 119) h.core.record(Core.Action.Screen("S$i"))
            assertEquals(120, h.core.flush())
            assertEquals(listOf(50, 50, 20), h.transport.batches.map { it.events.size })
            assertTrue(h.core.snapshot.queue.isEmpty)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun failureKeepsEventsAndBacksOff() = runBlocking {
        val h = Harness()
        try {
            h.transport.script(503)
            h.core.record(Core.Action.Screen("Home"))
            assertEquals(0, h.core.flush())
            assertEquals(2, h.core.snapshot.queue.count)
            assertEquals(T0 + 5_000, h.core.snapshot.nextAttemptAt)

            h.clock.advance(2)
            assertEquals(0, h.core.flush())
            assertEquals(1, h.transport.bodies.size)

            h.transport.script(-1)
            h.clock.advance(4)
            assertEquals(0, h.core.flush())
            assertEquals(2, h.core.snapshot.failures)
            assertEquals(T0 + 6_000 + 10_000, h.core.snapshot.nextAttemptAt)

            h.core.networkReturned()
            assertTrue(h.core.snapshot.queue.isEmpty)
            assertEquals(0, h.core.snapshot.failures)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun retryAfterWinsWhenLongerThanTheBackoff() = runBlocking {
        val h = Harness(persistent = false)
        h.transport.scriptResponses(TransportResponse(429, retryAfterSeconds = 3_600))
        h.core.record(Core.Action.Screen("Home"))
        assertEquals(0, h.core.flush())
        assertEquals(2, h.core.snapshot.queue.count)
        assertEquals(T0 + 3_600_000, h.core.snapshot.nextAttemptAt)
        h.clock.advance(3_599)
        assertEquals(0, h.core.flush())
        assertEquals(1, h.transport.bodies.size)
        h.clock.advance(1)
        assertEquals(2, h.core.flush())

        val short = Harness(persistent = false)
        short.transport.scriptResponses(TransportResponse(503, retryAfterSeconds = 1))
        short.core.record(Core.Action.Screen("Home"))
        short.core.flush()
        assertEquals("the backoff still applies", T0 + 5_000, short.core.snapshot.nextAttemptAt)
    }

    @Test fun backoffDoublesAndCaps() {
        assertEquals(5_000L, Backoff.delayMs(1))
        assertEquals(10_000L, Backoff.delayMs(2))
        assertEquals(80_000L, Backoff.delayMs(5))
        assertEquals(900_000L, Backoff.delayMs(12))
        assertEquals(900_000L, Backoff.delayMs(400))
        assertEquals(86_400_000L, Backoff.waitMs(1, 1.0, 10_000_000))
        assertEquals(5_000L, Backoff.waitMs(1, 1.0, null))
    }

    @Test fun retryAfterParsesSecondsAndDates() {
        assertEquals(120L, RetryAfter.parse("120", T0))
        assertEquals(0L, RetryAfter.parse("-5", T0))
        assertNull(RetryAfter.parse("soon", T0))
        assertNull(RetryAfter.parse(null, T0))
        // 2025-10-25T13:46:40Z is T0; one hour later.
        assertEquals(3_600L, RetryAfter.parse("Sat, 25 Oct 2025 14:46:40 GMT", T0))
    }

    @Test fun badPayloadIsDropped() = runBlocking {
        val h = Harness()
        try {
            h.transport.script(400)
            h.core.record(Core.Action.Screen("Home"))
            assertEquals(0, h.core.flush())
            assertTrue(h.core.snapshot.queue.isEmpty)
            assertEquals(0, h.core.snapshot.failures)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun statusCodesMapToOutcomes() {
        assertEquals(DeliveryOutcome.DELIVERED, DeliveryOutcome.of(202))
        assertEquals(DeliveryOutcome.REJECTED, DeliveryOutcome.of(400))
        assertEquals(DeliveryOutcome.REJECTED, DeliveryOutcome.of(403))
        assertEquals(DeliveryOutcome.REJECTED, DeliveryOutcome.of(413))
        assertEquals(DeliveryOutcome.RETRY, DeliveryOutcome.of(404))
        assertEquals(DeliveryOutcome.RETRY, DeliveryOutcome.of(429))
        assertEquals(DeliveryOutcome.RETRY, DeliveryOutcome.of(500))
        assertEquals(DeliveryOutcome.RETRY, DeliveryOutcome.of(-1))
    }

    @Test fun wrongPackageIsDroppedNotRetried() = runBlocking {
        val h = Harness()
        try {
            h.transport.script(403)
            h.core.record(Core.Action.Screen("Home"))
            assertEquals(0, h.core.flush())
            assertTrue(h.core.snapshot.queue.isEmpty)
            assertNull(h.core.snapshot.nextAttemptAt)
            assertEquals(1, h.transport.bodies.size)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun partialRejectionIsNotResent() = runBlocking {
        val h = Harness()
        try {
            h.transport.script(202)
            h.core.record(Core.Action.Goal("", emptyMap()))
            h.core.record(Core.Action.Screen("Home"))
            assertEquals(3, h.core.flush())
            assertTrue(h.core.snapshot.queue.isEmpty)
            assertEquals(0, h.core.flush())
            assertEquals(1, h.transport.bodies.size)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun optOutClearsQueueAndFile() = runBlocking {
        val h = Harness()
        try {
            h.core.record(Core.Action.Screen("Home"))
            h.core.saveNow()
            assertTrue(h.stateFile.exists())

            h.core.setEnabled(false)
            assertTrue(h.core.snapshot.queue.isEmpty)
            assertFalse(h.stateFile.exists())
            h.core.record(Core.Action.Screen("Ignored"))
            assertTrue(h.core.snapshot.queue.isEmpty)
            assertEquals(0, h.core.flush())
            assertTrue(h.transport.bodies.isEmpty())

            h.core.setEnabled(true)
            h.core.record(Core.Action.Screen("Back"))
            assertEquals(listOf(WireEventType.SESSION_START, WireEventType.SCREEN), h.queued.map { it.t })
        } finally {
            h.cleanUp()
        }
    }

    @Test fun purchaseIsReportedOncePerToken() {
        val h = Harness()
        try {
            h.core.record(Core.Action.GooglePlayPurchase("tok_1", "pro", "subs", "GPA.1"))
            h.core.record(Core.Action.GooglePlayPurchase("tok_1", "pro", "subs", "GPA.1"))
            h.core.record(Core.Action.GooglePlayPurchase("tok_2", "coins", "inapp", null))
            assertEquals(listOf(WireEventType.SESSION_START, WireEventType.PURCHASE, WireEventType.PURCHASE), h.queued.map { it.t })
            assertEquals(listOf("tok_1", "tok_2"), h.queued.mapNotNull { it.token })
        } finally {
            h.cleanUp()
        }
    }

    @Test fun referrerHoldsFirstFlushAndJoinsFirstSession() = runBlocking {
        val h = Harness()
        try {
            assertTrue(h.core.needsReferrer)
            h.core.hold(Core.HOLD_REFERRER, Core.REFERRER_WAIT_MS)
            h.core.appBecameActive()
            h.core.record(Core.Action.Screen("Home"))
            assertEquals(0, h.core.flush())
            assertTrue(h.transport.bodies.isEmpty())

            h.core.resolveReferrer("utm_source=google-play&utm_medium=organic&utm_campaign=launch&gclid=Cj0KCQiA-abc_123")
            assertFalse(h.core.needsReferrer)
            assertEquals(2, h.core.flush())
            val start = h.transport.batches.first().events.first()
            assertEquals(WireEventType.SESSION_START, start.t)
            assertEquals(
                WireSource(utmSource = "google-play", utmMedium = "organic", utmCampaign = "launch", clickNetwork = "google_ads", clickId = "Cj0KCQiA-abc_123"),
                start.src,
            )
        } finally {
            h.cleanUp()
        }
    }

    @Test fun referrerBeforeTheFirstSessionWaitsForIt() {
        val h = Harness(persistent = false)
        h.core.resolveReferrer("utm_source=partner")
        assertEquals("partner", h.core.snapshot.pendingSource?.utmSource)
        h.core.record(Core.Action.Screen("Home"))
        assertEquals("partner", h.queued.first().src?.utmSource)
        assertNull(h.core.snapshot.pendingSource)
    }

    @Test fun referrerIsAskedOnceOnlyWithConsent() {
        val kept = Harness()
        try {
            kept.core.resolveReferrer(null)
            kept.core.saveNow()
            val relaunched = Harness.makeCore(kept.directory, kept.clock, kept.transport, kept.ids)
            assertFalse(relaunched.needsReferrer)
        } finally {
            kept.cleanUp()
        }
        // Without consent nothing is stored, so the next launch asks again.
        val memory = Harness(persistent = false)
        memory.core.resolveReferrer(null)
        val next = Harness.makeCore(memory.directory, memory.clock, memory.transport, memory.ids, persistent = false)
        assertTrue(next.needsReferrer)
    }

    @Test fun referrerWaitExpires() = runBlocking {
        val h = Harness()
        try {
            h.core.hold(Core.HOLD_REFERRER, Core.REFERRER_WAIT_MS)
            h.core.record(Core.Action.Screen("Home"))
            h.clock.advance(11)
            assertEquals(2, h.core.flush())
        } finally {
            h.cleanUp()
        }
    }

    @Test fun aLinkWinsOverALaterReferrer() {
        val h = Harness(persistent = false)
        h.core.attach(WireSource(utmSource = "newsletter", utmMedium = "email"))
        h.core.resolveReferrer("utm_source=google-play&utm_medium=organic&utm_campaign=launch")
        assertEquals(WireSource(utmSource = "newsletter", utmMedium = "email", utmCampaign = "launch"), h.queued.first().src)

        val pending = Harness(persistent = false)
        pending.core.resolveReferrer("utm_source=google-play&utm_medium=organic")
        pending.core.attach(WireSource(utmSource = "tiktok"))
        assertEquals(WireSource(utmSource = "tiktok", utmMedium = "organic"), pending.queued.first().src)
    }
}
