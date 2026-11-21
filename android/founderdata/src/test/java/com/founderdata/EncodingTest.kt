package com.founderdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Payload encoding against docs/APP-API.md, sections 1 and 9. */
class EncodingTest {
    companion object {
        /** The example body of section 1, with the Android `ctx` of section 9 and its purchase event. */
        internal val CONTRACT_JSON = """
        {
          "w": "site_1",
          "ctx": {
            "platform": "android",
            "app_version": "1.4.0",
            "build": "57",
            "os_version": "16",
            "device": "Pixel 9",
            "form_factor": "phone",
            "locale": "en_US",
            "bundle_id": "com.example.shipkit"
          },
          "vid": "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b",
          "events": [
            { "t": "session_start", "sid": "s1", "ts": 1761400000000,
              "src": { "utm_source": "newsletter", "utm_medium": "email", "utm_campaign": "launch", "ref": "friend" } },
            { "t": "screen",   "sid": "s1", "ts": 1761400001000, "n": "Onboarding/Step2" },
            { "t": "goal",     "sid": "s1", "ts": 1761400002000, "n": "onboarding_complete", "p": { "variant": "b" } },
            { "t": "ping",     "sid": "s1", "ts": 1761400030000, "d": 28000 },
            { "t": "identify", "sid": "s1", "ts": 1761400040000, "p": { "user_id": "u_1", "email": "a@b.c", "name": "A" } },
            { "t": "purchase", "sid": "s1", "ts": 1761400050000,
              "store": "google_play", "token": "tok_abc", "product": "pro_yearly", "kind": "subs", "order": "GPA.1234-5678-9012-34567" }
          ]
        }
        """.trimIndent()

        internal val CONTRACT_BATCH = WireBatch(
            w = "site_1",
            ctx = FIXTURE,
            vid = LAUNCH_ID,
            events = listOf(
                WireEvent(
                    WireEventType.SESSION_START, "s1", 1_761_400_000_000,
                    src = WireSource(utmSource = "newsletter", utmMedium = "email", utmCampaign = "launch", ref = "friend"),
                ),
                WireEvent(WireEventType.SCREEN, "s1", 1_761_400_001_000, n = "Onboarding/Step2"),
                WireEvent(WireEventType.GOAL, "s1", 1_761_400_002_000, n = "onboarding_complete", p = mapOf("variant" to "b")),
                WireEvent(WireEventType.PING, "s1", 1_761_400_030_000, d = 28_000),
                WireEvent(WireEventType.IDENTIFY, "s1", 1_761_400_040_000, p = mapOf("user_id" to "u_1", "email" to "a@b.c", "name" to "A")),
                WireEvent(
                    WireEventType.PURCHASE, "s1", 1_761_400_050_000,
                    store = "google_play", token = "tok_abc", product = "pro_yearly", kind = "subs", order = "GPA.1234-5678-9012-34567",
                ),
            ),
        )
    }

    @Test fun matchesContractExample() {
        assertEquals(parse(CONTRACT_JSON), parse(CONTRACT_BATCH.encoded()))
    }

    @Test fun encodesTimestampsAsIntegersAndOmitsNulls() {
        val text = CONTRACT_BATCH.encoded()
        assertTrue(text.contains("\"ts\":1761400000000"))
        assertTrue(text.contains("\"d\":28000"))
        assertFalse(text.contains("null"))
        assertFalse(text.contains("\\/"))
        assertTrue(text.contains("\"n\":\"Onboarding/Step2\""))
    }

    @Test fun keysAreSortedLikeTheSwiftEncoder() {
        val event = WireEvent(WireEventType.GOAL, "s1", T0, n = "signup", p = mapOf("z" to "1", "a" to "2"))
        assertEquals("""{"n":"signup","p":{"a":"2","z":"1"},"sid":"s1","t":"goal","ts":1761400000000}""", event.encoded())
    }

    @Test fun coreBuildsContractEvents() {
        val h = Harness(persistent = false)
        h.core.attach(WireSource(utmSource = "newsletter", utmMedium = "email", utmCampaign = "launch", ref = "friend"))
        h.clock.advance(1)
        h.core.record(Core.Action.Screen("Onboarding/Step2"))
        h.clock.advance(1)
        h.core.record(Core.Action.Goal("onboarding_complete", mapOf("variant" to "b")))
        h.clock.advance(28)
        h.core.tick()
        h.core.appEnteredBackground()
        h.clock.advance(10)
        h.core.record(Core.Action.Identify("u_1", "a@b.c", "A"))
        h.clock.advance(10)
        h.core.record(Core.Action.GooglePlayPurchase("tok_abc", "pro_yearly", "subs", "GPA.1234-5678-9012-34567"))

        val batch = h.core.snapshot.queue.nextBatch("site_1")!!
        val decoded = WireBatch.decode(String(batch.body, Charsets.UTF_8))
        // No lifecycle in this test, so no ping; splice the contract's ping in to compare the rest.
        val events = decoded.events.toMutableList().apply { add(3, CONTRACT_BATCH.events[3]) }
        assertEquals(parse(CONTRACT_JSON), parse(decoded.copy(events = events).encoded()))
    }

    @Test fun consentFlagOnlyWhileTheIdIsKept() {
        val kept = Harness()
        try {
            kept.core.record(Core.Action.Screen("Home"))
            assertTrue(kept.core.snapshot.queue.items.all { it.ctx.consent == true })
            assertTrue(String(kept.core.snapshot.queue.nextBatch("site_1")!!.body).contains("\"consent\":true"))
        } finally {
            kept.cleanUp()
        }
        val memory = Harness(persistent = false)
        memory.core.record(Core.Action.Screen("Home"))
        assertFalse(String(memory.core.snapshot.queue.nextBatch("site_1")!!.body).contains("consent"))
    }

    @Test fun identifyOmitsMissingFields() {
        val event = Core.event(Core.Action.Identify("u_1", null, null), "s1", T0)
        assertEquals("""{"p":{"user_id":"u_1"},"sid":"s1","t":"identify","ts":1761400000000}""", event.encoded())
    }

    @Test fun goalWithoutPropsHasNoP() {
        val event = Core.event(Core.Action.Goal("signup", emptyMap()), "s1", T0)
        assertEquals("""{"n":"signup","sid":"s1","t":"goal","ts":1761400000000}""", event.encoded())
    }

    @Test fun goalPropsFitTheServerLimit() {
        val props = (0 until 30).associate { String.format("key%02d", it) to "v".repeat(300) }
        val cleaned = FounderData.cleanedProps(props)
        assertEquals(3, cleaned.size)
        assertTrue(Json.write(cleaned).length <= 1_000)
        assertEquals(256, cleaned["key00"]?.length)
        assertEquals(mapOf("variant" to "b"), FounderData.cleanedProps(mapOf("variant" to "b", " " to "x")))
        assertEquals(20, FounderData.cleanedProps((0 until 25).associate { "k$it" to "v" }).size)
    }

    @Test fun webVisitorIdUsesRtVidKey() {
        assertEquals("""{"rt_vid":"web_visitor_123"}""", Json.write(WireSource(webVisitorId = "web_visitor_123").toJson()))
    }

    @Test fun queueFileWithTheOlderMlVidKeyStillDecodes() {
        val old = WireSource.fromJson(parse("""{"ml_vid":"web_visitor_123","ref":"x"}""") as Map<*, *>)
        assertEquals(WireSource(ref = "x", webVisitorId = "web_visitor_123"), old)
        val both = WireSource.fromJson(parse("""{"ml_vid":"old_visitor","rt_vid":"new_visitor"}""") as Map<*, *>)
        assertEquals("new_visitor", both.webVisitorId)
    }

    @Test fun endpointFromHost() {
        assertEquals("https://stats.example.com/api/app/events", Endpoint.events("https://stats.example.com").toString())
        assertEquals("https://stats.example.com/api/app/events", Endpoint.events("stats.example.com/").toString())
        assertEquals("http://localhost:8787/api/app/events", Endpoint.events("http://localhost:8787").toString())
        assertEquals("http://10.0.2.2:8787/api/app/events", Endpoint.events("http://10.0.2.2:8787").toString())
        assertNull(Endpoint.events("  "))
    }

    @Test fun installIdNormalisesToLowercaseUUID() {
        assertEquals(LAUNCH_ID, InstallIdStore.normalized("6F1C2B9E-0D4A-4E57-9A0B-3C2D1E0F9A8B"))
        assertNull(InstallIdStore.normalized("not-a-uuid"))
        assertNull(InstallIdStore.normalized("1-1-1-1-1"))
    }

    @Test fun jsonRoundTripsEscapesAndUnicode() {
        val value = mapOf("a" to "quote \" backslash \\ newline \n tab \t ctrl \u0001 é 漢 😀", "n" to 12L, "b" to true, "l" to listOf(1L, "x"))
        val text = Json.write(value)
        assertEquals(value, parse(text))
        assertEquals(mapOf("x" to "/"), parse("""{"x":"\/"}"""))
        assertEquals(mapOf("u" to "é"), parse("""{"u":"é"}"""))
    }

    @Test fun stateFileRoundTrips() {
        val h = Harness()
        try {
            h.core.attach(WireSource(utmSource = "x", clickNetwork = "google_ads", clickId = "abcdefgh12"))
            h.core.setSessionProperties(mapOf("user_state" to "new"))
            h.core.record(Core.Action.GooglePlayPurchase("tok", "p", "inapp", null))
            h.core.saveNow()
            val stored = StateStore(h.stateFile).load()!!
            assertEquals(h.core.snapshot.queue.items, stored.queue.items)
            assertEquals(h.core.snapshot.session, stored.session)
            assertEquals(listOf("tok"), stored.reportedPurchases)
            assertFalse(java.io.File(h.directory, "state.json.tmp").exists())
        } finally {
            h.cleanUp()
        }
    }
}
