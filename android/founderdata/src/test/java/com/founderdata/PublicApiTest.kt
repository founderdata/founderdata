package com.founderdata

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.net.URL
import java.util.Locale
import java.util.concurrent.TimeUnit

/** The public API end to end, as an app uses it, on Robolectric's Android. */
@RunWith(RobolectricTestRunner::class)
class PublicApiTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val folder: File get() = File(context.noBackupFilesDir, "founderdata")

    @Before fun setUp() {
        FounderData.resetForTests()
        FounderData.referrerSource = { ReferrerSource { } }
        FounderData.appSetIdSource = { AppSetIdSource { } }
        folder.deleteRecursively()
    }

    @After fun tearDown() {
        FounderData.resetForTests()
        folder.deleteRecursively()
    }

    private fun configure(installId: InstallId = InstallId.RANDOM) =
        FounderData.configure(context, "site_consent_test", "http://127.0.0.1:9", installId = installId)

    @Test fun withoutConsentNothingIsStored() = runBlocking {
        val callsBefore = FounderData.installIdFileCalls
        configure()
        FounderData.screen("/Home")
        FounderData.goal("onboarding_complete")
        FounderData.identify("u_1")
        val token = FounderData.obfuscatedAccountId
        val core = FounderData.current!!
        core.appEnteredBackground()
        core.flush(ignoreBackoff = true)
        core.saveNow()

        assertEquals(callsBefore, FounderData.installIdFileCalls)
        assertFalse(FounderData.hasConsent)
        assertFalse(core.isPersistent)
        assertEquals(core.installId, token)
        assertEquals(token, InstallIdStore.normalized(token))
        assertFalse(folder.exists())
        assertEquals("Home", core.snapshot.queue.items.first { it.event.t == WireEventType.SCREEN }.event.n)
    }

    @Test fun resetWithoutConsentChangesTheIdInMemory() {
        val callsBefore = FounderData.installIdFileCalls
        configure()
        val before = FounderData.obfuscatedAccountId
        FounderData.reset()
        val after = FounderData.obfuscatedAccountId
        assertNotEquals(before, after)
        assertEquals(after, FounderData.current!!.installId)
        assertEquals(mapOf("founderDataVisitorId" to after), FounderData.revenueCatAttributes)
        assertEquals(callsBefore, FounderData.installIdFileCalls)
        assertFalse(folder.exists())
    }

    @Test fun consentStoresInNoBackupFilesAndWithdrawalDeletes() {
        FounderData.setConsent(true)
        configure()
        FounderData.screen("Home")
        val core = FounderData.current!!
        core.saveNow()
        val stored = File(folder, "install_id").readText()
        assertEquals(core.installId, stored)
        assertTrue(File(folder, "state.json").exists())
        assertTrue(core.snapshot.queue.items.all { it.ctx.consent == true })

        FounderData.setConsent(false)
        assertFalse(folder.exists())
        assertNotEquals(stored, core.installId)
        FounderData.screen("Settings")
        core.saveNow()
        assertFalse(folder.exists())
    }

    @Test fun consentAfterConfigureKeepsTheLaunchId() {
        configure()
        val launchId = FounderData.obfuscatedAccountId
        FounderData.setConsent(true)
        assertEquals(launchId, File(folder, "install_id").readText())
        assertTrue(FounderData.current!!.isPersistent)
    }

    @Test fun aStoredIdComesBackOnTheNextLaunch() {
        folder.mkdirs()
        File(folder, "install_id").writeText("0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D")
        FounderData.setConsent(true)
        configure()
        assertEquals("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", FounderData.obfuscatedAccountId)
    }

    @Test fun setConsentFalseBeforeConfigureErasesAnEarlierFolder() {
        folder.mkdirs()
        File(folder, "state.json").writeText("{}")
        FounderData.setConsent(false)
        configure()
        assertFalse(folder.exists())
    }

    @Test fun theDefaultIsRandom() {
        configure()
        assertNull(FounderData.current!!.vendorInstallId)
    }

    @Test fun vendorModeAdoptsTheAppSetIdWhenItArrives() {
        configure(InstallId.VENDOR)
        val core = FounderData.current!!
        val provisional = core.installId
        FounderData.screen("Home")
        FounderData.vendorIdArrived(core, "site_consent_test", provisional, "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b")
        val expected = VendorInstallId.derive("6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b", "site_consent_test")
        assertEquals(expected, FounderData.obfuscatedAccountId)
        assertTrue(core.snapshot.queue.items.all { it.vid == expected && it.ctx.id == "vendor" })
        assertFalse(folder.exists())

        // Withdrawing consent continues under the vendor id.
        FounderData.setConsent(true)
        assertEquals(expected, File(folder, "install_id").readText())
        FounderData.setConsent(false)
        assertEquals(expected, core.installId)
    }

    @Test fun consentWithVendorStoresTheVendorId() {
        FounderData.setConsent(true)
        configure(InstallId.VENDOR)
        val core = FounderData.current!!
        assertFalse("nothing stored before the App set ID arrives", File(folder, "install_id").exists())
        FounderData.vendorIdArrived(core, "site_consent_test", core.installId, "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b")
        val expected = VendorInstallId.derive("6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b", "site_consent_test")
        assertEquals(expected, File(folder, "install_id").readText())
        assertEquals(expected, core.installId)
    }

    @Test fun consentWithVendorButNoAppSetIdStoresTheLaunchId() {
        FounderData.setConsent(true)
        configure(InstallId.VENDOR)
        val core = FounderData.current!!
        val launchId = core.installId
        FounderData.vendorIdArrived(core, "site_consent_test", launchId, null)
        assertEquals(launchId, File(folder, "install_id").readText())
        assertEquals(launchId, core.installId)
        assertTrue(core.snapshot.queue.items.all { it.ctx.id == null })
    }

    @Test fun handleReadsIntentsUrisAndStrings() {
        configure()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/open?utm_source=tiktok&gclid=Cj0KCQiA-abc_123"))
        assertTrue(FounderData.handle(intent))
        val start = FounderData.current!!.snapshot.queue.items.first().event
        assertEquals("tiktok", start.src?.utmSource)
        assertEquals("google_ads", start.src?.clickNetwork)
        assertFalse(FounderData.handle(Intent(Intent.ACTION_MAIN)))
        assertFalse(FounderData.handle(null as Intent?))
        assertFalse(FounderData.handle(Uri.parse("https://example.com/item/42")))
        assertTrue(FounderData.handle("shipkit://open?ref=friend"))
    }

    @Test fun sessionPropertiesAndExperimentsBeforeConfigure() {
        FounderData.setSessionProperty("user_state", "new")
        FounderData.experiment("Paywall Copy", "b")
        configure()
        FounderData.onboardingStep(1, "welcome")
        val start = FounderData.current!!.snapshot.queue.items.first().event
        assertEquals(mapOf("user_state" to "new", "exp_paywall_copy" to "b"), start.sp)
        assertEquals(mapOf("user_state" to "new", "exp_paywall_copy" to "b"), FounderData.sessionProperties)
    }

    @Test fun helpersRecordGoals() {
        configure()
        FounderData.paywallViewed(PaywallSource.ONBOARDING)
        FounderData.purchaseStarted("pro", PaywallSource.SETTINGS)
        FounderData.purchaseFailed("pro", PaywallSource.SETTINGS, PurchaseFailureReason.STORE)
        FounderData.restoreStarted(PaywallSource.SETTINGS)
        FounderData.restoreSucceeded(PaywallSource.SETTINGS)
        FounderData.onboardingSkipped("Notifications")
        FounderData.onboardingComplete()
        FounderData.flowStarted()
        FounderData.flowExited("upload")
        FounderData.activation("first_export")
        FounderData.permissionPrompted("notifications")
        FounderData.permissionAnswered("notifications", PermissionResult.GRANTED)
        val names = FounderData.current!!.snapshot.queue.items.mapNotNull { it.event.n }
        assertEquals(
            listOf(
                "paywall_view", "purchase_start", "purchase_failed", "restore_start", "restore_success", "onboarding_skip",
                "onboarding_complete", "flow_start", "flow_exit", "activation", "permission_notifications_prompt",
                "permission_notifications",
            ),
            names,
        )
    }

    @Test fun optOutBeforeConfigureSendsNothing() {
        FounderData.isEnabled = false
        configure()
        FounderData.screen("Home")
        assertTrue(FounderData.current!!.snapshot.queue.isEmpty)
        FounderData.isEnabled = true
    }

    @Test fun flushBeforeConfigureSendsNothing() = runBlocking {
        assertEquals(0, FounderData.flush())
    }

    @Test fun badArgumentsThrowInADebuggableApp() {
        context.applicationInfo.flags = context.applicationInfo.flags or android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE
        try {
            FounderData.configure(context, " ", "http://founderdata.example.com")
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("site id is empty"))
        }
        assertNull(FounderData.current)
    }

    @Test fun badArgumentsOnlyLogInARelease() {
        context.applicationInfo.flags = context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE.inv()
        FounderData.configure(context, "site_1", "http://founderdata.example.com")
        assertNotNull("the host is still a URL, so it runs", FounderData.current)
    }

    @Test fun debugHostIsUsedOnlyInADebuggableApp() {
        context.applicationInfo.flags = context.applicationInfo.flags or android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE
        FounderData.configure(context, "site_1", "https://founderdata.example.com", "http://10.0.2.2:8787")
        assertEquals("http://10.0.2.2:8787/api/app/events", FounderData.current!!.config.endpoint.toString())
        FounderData.resetForTests()
        context.applicationInfo.flags = context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE.inv()
        FounderData.configure(context, "site_1", "https://founderdata.example.com", "http://10.0.2.2:8787")
        assertEquals("https://founderdata.example.com/api/app/events", FounderData.current!!.config.endpoint.toString())
    }

    @Test fun deviceContext() {
        val ctx = DeviceContext.current(context)
        assertEquals("android", ctx.platform)
        assertEquals(context.packageName, ctx.bundleId)
        assertEquals(android.os.Build.MODEL, ctx.device)
        assertEquals(android.os.Build.VERSION.RELEASE, ctx.osVersion)
        assertEquals("phone", ctx.formFactor)
        assertNull(ctx.consent)
        assertNull(ctx.id)
    }

    @Config(qualifiers = "sw600dp")
    @Test fun tabletFormFactor() {
        assertEquals("tablet", DeviceContext.current(context).formFactor)
    }

    @Test fun localeIdentifiers() {
        assertEquals("en_US", DeviceContext.localeIdentifier(Locale.US))
        assertEquals("de", DeviceContext.localeIdentifier(Locale("de")))
        assertEquals("sr_RS", DeviceContext.localeIdentifier(Locale.Builder().setLanguage("sr").setRegion("RS").setScript("Latn").build()))
        assertEquals("phone", DeviceContext.formFactor(599))
        assertEquals("tablet", DeviceContext.formFactor(600))
    }
}

/** `configure` stops a debuggable app on arguments that would send nothing, or send over plain http. */
class ConfigureCheckTest {
    private fun problems(siteId: String = "site_1", host: String = "https://founderdata.example.com", debugHost: String? = null) =
        FounderData.configurationProblems(siteId, host, debugHost)

    @Test fun goodArgumentsPass() {
        assertTrue(problems().isEmpty())
        assertTrue(problems(host = "founderdata.example.com").isEmpty())
        assertTrue(problems(debugHost = "http://localhost:8787").isEmpty())
        for (local in listOf(
            "http://127.0.0.1:9", "http://10.0.2.2:8787", "http://192.168.1.20:8787", "http://10.0.0.5",
            "http://172.20.1.1:8787", "http://macbook.local:8787", "http://[::1]:8787",
        )) {
            assertTrue(local, problems(host = local).isEmpty())
        }
    }

    @Test fun emptySiteIdAndPlainHttpAreProblems() {
        assertEquals(1, problems("  ").size)
        assertEquals(1, problems(host = "http://founderdata.example.com").size)
        assertEquals(1, problems(host = "http://10.example.com").size)
        assertEquals(1, problems(host = "http://172.32.0.1").size)
        assertEquals(1, problems(host = "ftp://founderdata.example.com").size)
        assertEquals(1, problems(host = "").size)
        assertTrue(problems(debugHost = "http://staging.example.com").first().startsWith("debugHost"))
        assertEquals(2, problems("", host = "http://founderdata.example.com").size)
    }
}

/** `HttpTransport` against a local server, and the core delivering through it. */
class TransportTest {
    private val server = MockWebServer()

    @Before fun start() = server.start()

    @After fun stop() = server.shutdown()

    private val url: URL get() = server.url("/api/app/events").toUrl()

    @Test fun postsJsonAndReadsTheStatus() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"ok":true}"""))
        val response = HttpTransport().post("""{"w":"site_1"}""".toByteArray(), url)
        assertEquals(TransportResponse(202, null), response)
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/api/app/events", request.path)
        assertEquals("application/json", request.getHeader("Content-Type"))
        assertEquals("""{"w":"site_1"}""", request.body.readUtf8())
        assertNull(request.getHeader("Cookie"))
    }

    @Test fun readsRetryAfterOn429() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "3600").setBody("""{"error":"daily write cap reached"}"""))
        assertEquals(TransportResponse(429, 3_600), HttpTransport().post("{}".toByteArray(), url))
    }

    @Test fun aDroppedConnectionThrows() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        try {
            HttpTransport(timeoutMs = 2_000).post("{}".toByteArray(), url)
            fail("expected an IOException")
        } catch (e: java.io.IOException) {
        }
    }

    @Test fun coreRetriesOn5xxHonorsRetryAfterAndDropsOn400() = runBlocking {
        val clock = TestClock()
        val dir = java.nio.file.Files.createTempDirectory("founderdata-tests").toFile()
        try {
            val core = Harness.makeCore(dir, clock, HttpTransport(), Counter(), persistent = false, endpoint = url)
            core.record(Core.Action.Screen("Home"))

            server.enqueue(MockResponse().setResponseCode(503))
            assertEquals(0, core.flush())
            assertEquals(T0 + 5_000, core.snapshot.nextAttemptAt)

            server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "120"))
            assertEquals(0, core.flush(ignoreBackoff = true))
            assertEquals(T0 + 120_000, core.snapshot.nextAttemptAt)
            assertEquals(2, core.snapshot.queue.count)

            server.enqueue(MockResponse().setResponseCode(202).setBody("""{"ok":true}"""))
            assertEquals(2, core.flush(ignoreBackoff = true))
            val sent = (1..3).map { server.takeRequest(5, TimeUnit.SECONDS)!!.body.readUtf8() }.last()
            val batch = WireBatch.decode(sent)
            assertEquals("site_1", batch.w)
            assertEquals("android", batch.ctx.platform)
            assertEquals(listOf(WireEventType.SESSION_START, WireEventType.SCREEN), batch.events.map { it.t })

            core.record(Core.Action.Screen("Bad"))
            server.enqueue(MockResponse().setResponseCode(400))
            assertEquals(0, core.flush(ignoreBackoff = true))
            assertTrue("dropped, not retried", core.snapshot.queue.isEmpty)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun publicFlushSkipsTheBackoffAndReturnsTheAcceptedCount() = runBlocking {
        val h = Harness(persistent = false)
        h.core.record(Core.Action.Screen("Paywall"))
        h.transport.script(-1)
        assertEquals(0, h.core.flush())
        assertEquals(0, h.core.flush())
        assertEquals("the second automatic flush waits out the backoff", 1, h.transport.bodies.size)
        assertEquals(2, FounderData.flush(h.core))
        assertTrue(h.queued.isEmpty())
        assertEquals(2, h.transport.bodies.size)
        assertEquals(0, FounderData.flush(h.core))
        assertEquals(0, FounderData.flush(null))
    }
}
