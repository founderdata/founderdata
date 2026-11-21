package com.founderdata

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/** `FounderData.reset()` on sign-out: a new install id and a new session. */
class ResetTest {
    private val newId = "11111111-2222-4333-8444-555555555555"

    @Test fun resetStartsANewSessionUnderTheNewId() {
        val h = Harness(persistent = false)
        h.core.appBecameActive()
        h.core.record(Core.Action.Screen("Account"))
        val oldSid = h.core.snapshot.session.sessionId!!
        h.clock.advance(20)
        h.core.resetIdentity(newId)
        assertEquals(newId, h.core.installId)
        assertNull(h.core.snapshot.session.sessionId)

        h.core.record(Core.Action.Screen("SignIn"))
        val items = h.core.snapshot.queue.items
        val ping = items.first { it.event.t == WireEventType.PING }
        assertEquals(LAUNCH_ID, ping.vid)
        assertEquals(oldSid, ping.event.sid)
        assertEquals(20_000L, ping.event.d)
        assertEquals(listOf(LAUNCH_ID, newId), items.filter { it.event.t == WireEventType.SESSION_START }.map { it.vid })
        assertEquals(newId, items.last().vid)
        assertNotEquals(oldSid, items.last().event.sid)
    }

    @Test fun engagedTimeKeepsCountingAfterReset() {
        val h = Harness(persistent = false)
        h.core.appBecameActive()
        h.clock.advance(5)
        h.core.resetIdentity(newId)
        h.core.record(Core.Action.Screen("SignIn"))
        val newSid = h.core.snapshot.session.sessionId
        h.clock.advance(30)
        h.core.appEnteredBackground()
        val pings = h.core.snapshot.queue.items.filter { it.event.t == WireEventType.PING && it.event.sid == newSid }
        assertEquals(listOf(30_000L), pings.map { it.event.d })
        assertEquals(listOf(newId), pings.map { it.vid })
    }

    @Test fun resetWithConsentKeepsSavingTheQueue() {
        val h = Harness()
        try {
            h.core.record(Core.Action.Screen("Account"))
            h.core.resetIdentity(newId)
            h.core.record(Core.Action.Screen("SignIn"))
            h.core.saveNow()
            assertTrue(h.core.isPersistent)
            assertEquals(listOf(LAUNCH_ID, LAUNCH_ID, newId, newId), StateStore(h.stateFile).load()!!.queue.items.map { it.vid })
        } finally {
            h.cleanUp()
        }
    }

    @Test fun resetWhileOptedOutOnlyChangesTheId() {
        val h = Harness(enabled = false, persistent = false)
        h.core.resetIdentity(newId)
        assertEquals(newId, h.core.installId)
        assertTrue(h.core.snapshot.queue.isEmpty)
    }
}

class SessionPropertiesTest {
    @Test fun keysAreLowercaseSnakeCase() {
        assertEquals("user_state", FounderData.propertyKey("User State"))
        assertEquals("paywall_copy", FounderData.propertyKey("  _Paywall-Copy!_ "))
        assertNull(FounderData.propertyKey("---"))
        assertEquals(40, FounderData.propertyKey("a".repeat(60))?.length)
    }

    @Test fun mergeCapsAtTenAndEmptyValueRemoves() {
        var props = emptyMap<String, String>()
        for (i in 0 until 12) props = FounderData.mergedSessionProperties(props, mapOf(String.format("k%02d", i) to "v"))
        assertEquals(FounderData.MAX_SESSION_PROPERTIES, props.size)
        assertNull(props["k10"])
        props = FounderData.mergedSessionProperties(props, mapOf("k00" to "", "k10" to "x"))
        assertNull(props["k00"])
        props = FounderData.mergedSessionProperties(props, mapOf("k10" to "x"))
        assertEquals("x", props["k10"])
        props = FounderData.mergedSessionProperties(props, mapOf("k01" to "v".repeat(150)))
        assertEquals(100, props["k01"]?.length)
        props = FounderData.mergedSessionProperties(props, mapOf("k02" to "changed"))
        assertEquals("changed", props["k02"])
    }

    @Test fun onboardingStepGoal() {
        val goal = FounderData.onboardingGoal(2, "Notifications")!!
        assertEquals("onboarding_notifications", goal.name)
        assertEquals(mapOf("step" to "notifications", "index" to "2"), goal.props)
        assertNull(FounderData.onboardingGoal(1, "  "))
    }

    @Test fun propertiesSetBeforeTheFirstEventRideOnSessionStart() {
        val h = Harness(persistent = false)
        h.core.setSessionProperties(mapOf("user_state" to "new", "exp_paywall" to "b"))
        h.core.record(Core.Action.Screen("Home"))
        assertEquals(listOf(WireEventType.SESSION_START, WireEventType.SCREEN), h.queued.map { it.t })
        assertEquals(mapOf("user_state" to "new", "exp_paywall" to "b"), h.queued.first().sp)
    }

    @Test fun changeWhileSessionStartIsQueuedRewritesItWithoutAnExtraEvent() {
        val h = Harness(persistent = false)
        h.core.record(Core.Action.Screen("Home"))
        h.core.setSessionProperties(mapOf("user_state" to "returning"))
        assertEquals(listOf(WireEventType.SESSION_START, WireEventType.SCREEN), h.queued.map { it.t })
        assertEquals(mapOf("user_state" to "returning"), h.queued.first().sp)
    }

    @Test fun changeAfterSessionStartWasSentSendsOneEventWithTheFullSet() = runBlocking {
        val h = Harness(persistent = false)
        h.core.setSessionProperties(mapOf("user_state" to "new"))
        h.core.record(Core.Action.Screen("Home"))
        h.core.flush(ignoreBackoff = true)
        assertTrue(h.queued.isEmpty())
        h.clock.advance(5)
        val props = mapOf("user_state" to "new", "onboarding_variant" to "b")
        h.core.setSessionProperties(props)
        val sid = h.core.snapshot.session.sessionId!!
        assertEquals(listOf(WireEvent(WireEventType.SESSION_PROPS, sid, h.clock.now, p = props)), h.queued)
        h.core.setSessionProperties(props)
        assertEquals(1, h.queued.size)
    }

    @Test fun aLaterSessionStartsWithTheProperties() {
        val h = Harness(persistent = false)
        h.core.setSessionProperties(mapOf("build_channel" to "debug"))
        h.core.record(Core.Action.Screen("Home"))
        h.core.appEnteredBackground()
        h.clock.advance(31 * 60)
        h.core.record(Core.Action.Screen("Home"))
        val starts = h.queued.filter { it.t == WireEventType.SESSION_START }
        assertEquals(2, starts.size)
        assertTrue(starts.all { it.sp == mapOf("build_channel" to "debug") })
    }

    @Test fun noSessionYetMeansNoEvent() {
        val h = Harness(persistent = false)
        h.core.setSessionProperties(mapOf("user_state" to "new"))
        assertTrue(h.queued.isEmpty())
    }

    @Test fun memoryModeStillWritesNothing() {
        val h = Harness(persistent = false)
        h.core.record(Core.Action.Screen("Home"))
        h.core.setSessionProperties(mapOf("user_state" to "new"))
        h.core.saveNow()
        assertFalse(h.directory.exists())
    }

    @Test fun encodesSessionPropsOnTheWire() {
        assertEquals(
            """{"sid":"s1","sp":{"user_state":"new"},"t":"session_start","ts":1761400000000}""",
            WireEvent(WireEventType.SESSION_START, "s1", T0, sp = mapOf("user_state" to "new")).encoded(),
        )
        assertEquals(
            """{"p":{"exp_paywall":"b"},"sid":"s1","t":"session_props","ts":1761400000000}""",
            WireEvent(WireEventType.SESSION_PROPS, "s1", T0, p = mapOf("exp_paywall" to "b")).encoded(),
        )
    }

    @Test fun persistedSessionKeepsItsPropertiesSoARelaunchSendsNothingNew() = runBlocking {
        val h = Harness()
        try {
            h.core.setSessionProperties(mapOf("user_state" to "returning"))
            h.core.record(Core.Action.Screen("Home"))
            h.core.flush(ignoreBackoff = true)
            h.core.appEnteredBackground()
            val relaunched = Harness.makeCore(h.directory, h.clock, h.transport, h.ids)
            relaunched.setSessionProperties(mapOf("user_state" to "returning"))
            assertTrue(relaunched.snapshot.queue.items.isEmpty())
            relaunched.setSessionProperties(mapOf("user_state" to "new"))
            assertEquals(listOf(WireEventType.SESSION_PROPS), relaunched.snapshot.queue.items.map { it.event.t })
        } finally {
            h.cleanUp()
        }
    }
}
