package com.founderdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionTest {
    private fun tracker(): SessionTracker {
        val ids = Counter()
        return SessionTracker(makeId = ids::next)
    }

    private fun t(seconds: Int) = T0 + seconds * 1000L

    @Test fun firstEventStartsSession() {
        val s = tracker()
        val (sid, start) = s.ensureSession(T0, null)
        assertEquals("s1", sid)
        assertEquals(WireEvent(WireEventType.SESSION_START, "s1", T0), start)
        val (again, none) = s.ensureSession(t(5), null)
        assertEquals("s1", again)
        assertNull(none)
    }

    @Test fun foregroundStartsSessionAndBackgroundPingsEngagedTime() {
        val s = tracker()
        assertEquals(WireEventType.SESSION_START, s.becameActive(T0, null)?.t)
        assertEquals(listOf(WireEvent(WireEventType.PING, "s1", t(28), d = 28_000)), s.enteredBackground(t(28)))
    }

    @Test fun interruptionDoesNotCountAsEngaged() {
        val s = tracker()
        s.becameActive(T0, null)
        s.resignedActive(t(10))
        s.becameActive(t(70), null)
        assertEquals(listOf(15_000L), s.enteredBackground(t(75)).map { it.d })
    }

    @Test fun backgroundUnderThirtyMinutesKeepsSession() {
        val s = tracker()
        s.becameActive(T0, null)
        s.enteredBackground(t(60))
        assertNull(s.becameActive(t(60 + 29 * 60), null))
        assertEquals("s1", s.sessionId)
    }

    @Test fun backgroundThirtyMinutesStartsNewSession() {
        val s = tracker()
        s.becameActive(T0, null)
        s.enteredBackground(t(60))
        val start = s.becameActive(t(60 + 30 * 60), null)
        assertEquals(WireEventType.SESSION_START, start?.t)
        assertEquals("s2", start?.sid)
        assertEquals("s2", s.sessionId)
    }

    @Test fun eventInBackgroundAfterTimeoutStartsNewSession() {
        val s = tracker()
        s.becameActive(T0, null)
        s.enteredBackground(t(10))
        val (sid, start) = s.ensureSession(t(10 + 31 * 60), null)
        assertEquals("s2", sid)
        assertNotNull(start)
    }

    @Test fun idleWithoutLifecycleRollsOver() {
        val s = tracker()
        s.ensureSession(T0, null)
        s.ensureSession(t(20 * 60), null)
        assertEquals("s1", s.sessionId)
        s.ensureSession(t(20 * 60 + 30 * 60), null)
        assertEquals("s2", s.sessionId)
    }

    @Test fun activeAppNeverTimesOut() {
        val s = tracker()
        s.becameActive(T0, null)
        val (sid, start) = s.ensureSession(t(2 * 3600), null)
        assertEquals("s1", sid)
        assertNull(start)
    }

    @Test fun tickPingsEveryFiveMinutesWhileActive() {
        val s = tracker()
        s.becameActive(T0, null)
        assertTrue(s.tick(t(270)).isEmpty())
        assertEquals(listOf(300_000L), s.tick(t(300)).map { it.d })
        assertEquals(listOf(30_000L), s.enteredBackground(t(330)).map { it.d })
    }

    @Test fun longStretchIsSplitIntoTenMinutePings() {
        val s = tracker()
        s.becameActive(T0, null)
        assertEquals(listOf(600_000L, 600_000L, 300_000L), s.enteredBackground(t(25 * 60)).map { it.d })
    }

    @Test fun sourceGoesIntoSessionStart() {
        val src = WireSource(utmSource = "x", ref = "y")
        assertEquals(src, tracker().becameActive(T0, src)?.src)
        assertNull(tracker().becameActive(T0, WireSource())?.src)
    }

    @Test fun coldLaunchContinuesRecentSession() {
        val s = tracker()
        s.becameActive(T0, null)
        s.enteredBackground(t(60))
        val relaunched = SessionTracker(s.state) { "new" }
        relaunched.relaunched()
        assertNull(relaunched.becameActive(t(10 * 60), null))
        assertEquals("s1", relaunched.sessionId)

        val late = SessionTracker(s.state) { "new" }
        late.relaunched()
        assertEquals("new", late.becameActive(t(45 * 60), null)?.sid)
    }

    @Test fun coreRollsSessionAcrossLongBackground() {
        val h = Harness()
        try {
            h.core.appBecameActive()
            h.core.record(Core.Action.Screen("Home"))
            h.clock.advance(40)
            h.core.appResignedActive()
            h.core.appEnteredBackground()
            h.clock.advance(31 * 60)
            h.core.appBecameActive()
            h.core.record(Core.Action.Screen("Home"))
            assertEquals(
                listOf("session_start:s1", "screen:s1", "ping:s1", "session_start:s2", "screen:s2"),
                h.queued.map { "${it.t.wire}:${it.sid}" },
            )
            assertEquals(40_000L, h.queued[2].d)
        } finally {
            h.cleanUp()
        }
    }
}
