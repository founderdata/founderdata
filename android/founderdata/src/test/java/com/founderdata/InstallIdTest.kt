package com.founderdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** `installId = InstallId.VENDOR`: one id per install without consent, from the App set ID, never the raw value. */
class InstallIdTest {
    private val appSetId = "6F1C2B9E-0D4A-4E57-9A0B-3C2D1E0F9A8B"
    private val vendorId = "fd3e0654-a0ac-81a4-a1dd-6a15db8edbe4"

    @Test fun derivationIsStableAndPinned() {
        // SHA-256("founderdata-vendor-v1:site_1:6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b"), first 16 bytes, version 8 bits.
        val id = VendorInstallId.derive(appSetId, "site_1")
        assertEquals(vendorId, id)
        assertEquals(id, VendorInstallId.derive(appSetId.lowercase(), "site_1"))
        assertEquals("RFC 9562 version 8", '8', id[14])
        assertTrue("variant 10xx", id[19] in "89ab")
        assertEquals("usable as obfuscatedAccountId", id, InstallIdStore.normalized(id))
    }

    @Test fun saltedWithTheSiteIdAndNeverTheRawValue() {
        val one = VendorInstallId.derive(appSetId, "site_1")
        val two = VendorInstallId.derive(appSetId, "site_2")
        assertEquals("7100c543-4328-88cc-8505-c7ed7fee51bc", two)
        assertNotEquals(one, two)
        assertNotEquals(appSetId.lowercase(), one)
        assertNotEquals(one, VendorInstallId.derive("11111111-2222-4333-8444-555555555555", "site_1"))
    }

    /** The documented formula, step by step, as docs/APP-API.md sections 3 and 9 write it. */
    @Test fun matchesTheDocumentedFormula() {
        for (site in listOf("site_1", "abc", "site with spaces")) {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest("founderdata-vendor-v1:$site:${appSetId.lowercase()}".toByteArray()).copyOf(16)
            digest[6] = ((digest[6].toInt() and 0x0f) or 0x80).toByte()
            digest[8] = ((digest[8].toInt() and 0x3f) or 0x80).toByte()
            val hex = digest.joinToString("") { "%02x".format(it) }
            val uuid = "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
            assertEquals(uuid, VendorInstallId.derive(appSetId, site))
        }
    }

    /** The Swift SDK pins the same two vectors (ios/Tests/FounderDataKitTests/InstallIDTests.swift). */
    @Test fun matchesTheSwiftSdk() {
        val swift = File(repoRoot, "ios/Tests/FounderDataKitTests/InstallIDTests.swift").readText()
        assertTrue(swift.contains("6F1C2B9E-0D4A-4E57-9A0B-3C2D1E0F9A8B"))
        assertTrue(swift.contains("#expect(id == \"$vendorId\")"))
        assertTrue(swift.contains("#expect(two == \"${VendorInstallId.derive(appSetId, "site_2")}\")"))
        val source = File(repoRoot, "ios/Sources/FounderDataKit/InstallID.swift").readText()
        assertTrue(source.contains("\"founderdata-vendor-v1:\\(siteId):\\(vendorId.uuidString.lowercased())\""))
        assertTrue(source.contains("b[6] = (b[6] & 0x0f) | 0x80"))
        assertTrue(source.contains("b[8] = (b[8] & 0x3f) | 0x80"))
    }

    @Test fun vendorEventsCarryTheContextFlag() {
        val h = Harness(persistent = false, vendorInstallId = vendorId)
        h.core.record(Core.Action.Screen("Home"))
        assertEquals(vendorId, h.core.installId)
        assertTrue(h.core.snapshot.queue.items.all { it.ctx.id == "vendor" && it.ctx.consent == null })
        val text = String(h.core.snapshot.queue.nextBatch("site_1")!!.body)
        assertTrue(text.contains("\"id\":\"vendor\""))
        assertTrue(text.contains("\"vid\":\"$vendorId\""))
        assertFalse("nothing written to the device", h.directory.exists())
    }

    @Test fun theAppSetIdArrivingMovesTheQueuedEventsToTheVendorId() {
        val h = Harness(persistent = false)
        h.core.hold(Core.HOLD_VENDOR, VendorInstallId.WAIT_MS)
        h.core.record(Core.Action.Screen("Home"))
        assertTrue(h.core.snapshot.queue.items.all { it.vid == LAUNCH_ID && it.ctx.id == null })
        h.core.resolveVendorId(LAUNCH_ID, vendorId, vendorId)
        h.core.record(Core.Action.Screen("Settings"))
        assertEquals(vendorId, h.core.installId)
        assertTrue(h.core.snapshot.queue.items.all { it.vid == vendorId && it.ctx.id == "vendor" })
        assertEquals("one batch", 3, h.core.snapshot.queue.nextBatch("site_1")!!.ids.size)
    }

    @Test fun noDeveloperScopedIdKeepsTheRandomId() {
        val h = Harness(persistent = false)
        h.core.hold(Core.HOLD_VENDOR, VendorInstallId.WAIT_MS)
        h.core.record(Core.Action.Screen("Home"))
        h.core.resolveVendorId(LAUNCH_ID, null, null)
        h.core.record(Core.Action.Screen("Settings"))
        assertEquals(LAUNCH_ID, h.core.installId)
        assertTrue(h.core.snapshot.queue.items.all { it.ctx.id == null })
    }

    @Test fun aResetBeforeTheAppSetIdArrivesWins() {
        val h = Harness(persistent = false)
        h.core.record(Core.Action.Screen("Account"))
        h.core.resetIdentity("11111111-2222-4333-8444-555555555555")
        h.core.resolveVendorId(LAUNCH_ID, vendorId, vendorId)
        assertEquals("11111111-2222-4333-8444-555555555555", h.core.installId)
        assertEquals(vendorId, h.core.vendorInstallId)
    }

    @Test fun consentAndResetReplaceTheFlag() {
        val consented = Harness(persistent = false, vendorInstallId = vendorId)
        try {
            consented.core.enablePersistence(StateStore(consented.stateFile), vendorId)
            consented.core.record(Core.Action.Screen("Home"))
            val last = consented.core.snapshot.queue.items.last()
            assertEquals(true, last.ctx.consent)
            assertNull(last.ctx.id)
        } finally {
            consented.cleanUp()
        }

        val launchId = "11111111-2222-4333-8444-555555555555"
        val signedOut = Harness(persistent = false, vendorInstallId = vendorId)
        signedOut.core.record(Core.Action.Screen("Account"))
        signedOut.core.resetIdentity(launchId)
        signedOut.core.record(Core.Action.Screen("SignIn"))
        val items = signedOut.core.snapshot.queue.items
        assertTrue(items.filter { it.vid == vendorId }.all { it.ctx.id == "vendor" })
        assertTrue(items.filter { it.vid == launchId }.all { it.ctx.id == null })
        assertEquals(launchId, items.last().vid)
    }

    @Test fun randomSendsNoFlag() {
        val h = Harness(persistent = false)
        h.core.record(Core.Action.Screen("Home"))
        assertTrue(h.core.snapshot.queue.items.all { it.ctx.id == null })
        assertFalse(String(h.core.snapshot.queue.nextBatch("site_1")!!.body).contains("\"id\""))
    }

    /** The SDK never reads ANDROID_ID, the advertising id or hardware ids. */
    @Test fun noDeviceIdentifierApiInTheSources() {
        val sources = File(repoRoot, "android/founderdata/src/main").walk().filter { it.isFile }.map { it.readText() }.joinToString("\n")
        for (forbidden in listOf("ANDROID_ID", "Settings.Secure", "AdvertisingIdClient", "getImei", "getSerial", "Build.SERIAL", "getMacAddress")) {
            assertFalse(forbidden, sources.contains(forbidden))
        }
    }
}
