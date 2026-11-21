package com.founderdata

import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.Purchase
import com.revenuecat.purchases.PurchasesErrorCode
import com.revenuecat.purchases.PurchasesException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.io.IOException

/** The typed helpers send the goal names and props that docs/APP-EVENTS.md defines. */
class GoalsTest {
    @Test fun paywallAndPurchaseGoals() {
        val view = GoalEvent.paywallView(PaywallSource.ONBOARDING, null)
        assertEquals("paywall_view", view.name)
        assertEquals(mapOf("source" to "onboarding"), view.props)
        assertEquals(
            mapOf("source" to "gate_stats_screen", "paywall" to "annual_first"),
            GoalEvent.paywallView(PaywallSource.gate("Stats Screen"), "annual_first").props,
        )
        for (name in listOf("purchase_start", "purchase_cancelled", "purchase_pending")) {
            val goal = GoalEvent.purchase(name, "pro_yearly", PaywallSource.SETTINGS)
            assertEquals(name, goal.name)
            assertEquals(mapOf("source" to "settings", "product" to "pro_yearly"), goal.props)
        }
        val failed = GoalEvent.purchaseFailed("pro_yearly", PaywallSource("streak_banner"), PurchaseFailureReason.NETWORK)
        assertEquals("purchase_failed", failed.name)
        assertEquals(mapOf("source" to "streak_banner", "product" to "pro_yearly", "reason" to "network"), failed.props)
        assertEquals("feature_gate", PaywallSource.FEATURE_GATE.rawValue)
    }

    @Test fun onboardingFlowActivationAndPermissionGoals() {
        assertEquals(GoalEvent("onboarding_skip", mapOf("step" to "notifications")), GoalEvent.onboardingSkip("Notifications"))
        assertTrue(GoalEvent.of("activation", "what" to null).props.isEmpty())
        assertEquals("permission_notifications_prompt", GoalEvent.permissionPrompt("Notifications")?.name)
        val answer = GoalEvent.permission("photos", PermissionResult.LIMITED)
        assertEquals("permission_photos", answer?.name)
        assertEquals(mapOf("result" to "limited"), answer?.props)
        assertNull(GoalEvent.permissionPrompt("--"))
    }

    @Test fun billingResponseCodesMapToOutcomes() {
        assertSame(PurchaseOutcome.Purchased, PurchaseOutcome.fromBillingResponseCode(BillingClient.BillingResponseCode.OK))
        assertSame(PurchaseOutcome.Pending, PurchaseOutcome.fromBillingResponseCode(BillingClient.BillingResponseCode.OK, pending = true))
        assertSame(PurchaseOutcome.Cancelled, PurchaseOutcome.fromBillingResponseCode(BillingClient.BillingResponseCode.USER_CANCELED))
        val network = PurchaseOutcome.Failed(PurchaseFailureReason.NETWORK)
        @Suppress("DEPRECATION")
        for (code in listOf(
            BillingClient.BillingResponseCode.NETWORK_ERROR, BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,
            BillingClient.BillingResponseCode.SERVICE_DISCONNECTED, BillingClient.BillingResponseCode.SERVICE_TIMEOUT,
        )) {
            assertEquals("$code", network, PurchaseOutcome.fromBillingResponseCode(code))
        }
        assertEquals(PurchaseOutcome.Failed(PurchaseFailureReason.STORE), PurchaseOutcome.fromBillingResponseCode(BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED))
        assertEquals(PurchaseOutcome.Failed(PurchaseFailureReason.STORE), PurchaseOutcome.fromBillingResponseCode(BillingClient.BillingResponseCode.DEVELOPER_ERROR))
    }

    @Test fun failureReasonsFromErrors() {
        assertEquals(PurchaseFailureReason.NETWORK, PurchaseFailureReason.of(IOException("timeout")))
        assertEquals(PurchaseFailureReason.NETWORK, PurchaseFailureReason.of(PurchasesException(PurchasesErrorCode.NetworkError)))
        assertEquals(PurchaseFailureReason.STORE, PurchaseFailureReason.of(PurchasesException(PurchasesErrorCode.StoreProblemError)))
        assertEquals(PurchaseFailureReason.OTHER, PurchaseFailureReason.of(IllegalStateException()))
    }

    @Test fun eachReturnedOutcomeSendsItsGoal() = runBlocking {
        val cases = listOf(
            Triple(PurchaseOutcome.Purchased, listOf("purchase_start"), emptyMap()),
            Triple(PurchaseOutcome.Cancelled, listOf("purchase_start", "purchase_cancelled"), emptyMap()),
            Triple(PurchaseOutcome.Pending, listOf("purchase_start", "purchase_pending"), emptyMap()),
            Triple(PurchaseOutcome.Failed(PurchaseFailureReason.NETWORK), listOf("purchase_start", "purchase_failed"), mapOf("reason" to "network")),
            Triple(PurchaseOutcome.Failed(PurchaseFailureReason.STORE), listOf("purchase_start", "purchase_failed"), mapOf("reason" to "store")),
        )
        for ((outcome, names, extra) in cases) {
            val sent = ArrayList<GoalEvent>()
            val returned = FounderData.trackPurchase("pro_yearly", PaywallSource.ONBOARDING, { sent.add(it) }) { outcome }
            assertEquals(outcome, returned)
            assertEquals("$outcome", names, sent.map { it.name })
            assertEquals(mapOf("source" to "onboarding", "product" to "pro_yearly") + extra, sent.last().props)
        }
    }

    @Test fun thrownErrorsAreSortedAndThrownAgain() = runBlocking {
        val cases = listOf(
            Triple<Throwable, String, Map<String, String>>(PurchasesException(PurchasesErrorCode.PurchaseCancelledError), "purchase_cancelled", emptyMap()),
            Triple(PurchasesException(PurchasesErrorCode.PaymentPendingError), "purchase_pending", emptyMap()),
            Triple(PurchasesException(PurchasesErrorCode.NetworkError), "purchase_failed", mapOf("reason" to "network")),
            Triple(PurchasesException(PurchasesErrorCode.UnknownError), "purchase_failed", mapOf("reason" to "store")),
            Triple(IOException("offline"), "purchase_failed", mapOf("reason" to "network")),
            Triple(IllegalStateException("x"), "purchase_failed", mapOf("reason" to "other")),
        )
        for ((original, goal, extra) in cases) {
            val sent = ArrayList<GoalEvent>()
            try {
                FounderData.trackPurchase("pro_monthly", PaywallSource.gate("Stats"), { sent.add(it) }) { throw original }
                fail("$original was not thrown again")
            } catch (e: Throwable) {
                assertSame(original, e)
            }
            assertEquals("$original", listOf("purchase_start", goal), sent.map { it.name })
            assertEquals(mapOf("source" to "gate_stats", "product" to "pro_monthly") + extra, sent.last().props)
        }
    }

    /** Every name a helper sends is documented, so a rename on either side fails here. */
    @Test fun everyHelperGoalIsInTheEventDoc() {
        val doc = File(repoRoot, "docs/APP-EVENTS.md").readText()
        val names = listOf(
            "paywall_view", "purchase_start", "purchase_cancelled", "purchase_pending", "purchase_failed",
            "restore_start", "restore_success", "onboarding_skip", "flow_start", "flow_exit", "activation",
            "permission_<kind>_prompt", "permission_<kind>",
        )
        for (name in names) assertTrue("$name is missing from docs/APP-EVENTS.md", doc.contains("`$name`"))
        for (reason in PurchaseFailureReason.entries) assertTrue(doc.contains("`${reason.wire}`"))
        for (result in PermissionResult.entries) assertTrue(doc.contains("`${result.wire}`"))
    }

    @Test fun revenueCatAttributeMatchesTheServer() {
        val attributes = FounderData.revenueCatAttributes
        assertEquals(setOf("founderDataVisitorId"), attributes.keys)
        val value = attributes["founderDataVisitorId"]!!
        assertEquals(value, InstallIdStore.normalized(value))
        val worker = File(repoRoot, "src/worker/revenuecat.ts").readText()
        assertTrue(worker.contains("attrs.${FounderData.REVENUECAT_ATTRIBUTE_KEY}"))
    }
}

/** `trackPurchase(purchase, kind)` with real Play Billing `Purchase` objects, built from Play's JSON. */
@RunWith(RobolectricTestRunner::class)
class GooglePlayPurchaseTest {
    private lateinit var h: Harness

    @Before fun setUp() {
        FounderData.resetForTests()
        h = Harness(persistent = false)
        installCore(h.core)
    }

    @After fun tearDown() = FounderData.resetForTests()

    private fun purchase(state: Int = 0, order: String? = "GPA.3398-1234-5678-90123", products: String = """["pro_yearly"]"""): Purchase {
        val orderField = order?.let { "\"orderId\":\"$it\"," } ?: ""
        return Purchase(
            """{$orderField"packageName":"com.example.shipkit","productIds":$products,"purchaseTime":1761400050000,""" +
                """"purchaseState":$state,"purchaseToken":"opaque-token-abc","acknowledged":false}""",
            "signature",
        )
    }

    @Test fun purchaseEventShape() {
        FounderData.trackPurchase(purchase(), PurchaseKind.SUBS)
        val event = h.queued.last()
        assertEquals(
            """{"kind":"subs","order":"GPA.3398-1234-5678-90123","product":"pro_yearly","sid":"s1","store":"google_play","t":"purchase","token":"opaque-token-abc","ts":1761400000000}""",
            event.encoded(),
        )
    }

    @Test fun withoutAnOrderIdTheFieldIsLeftOut() {
        FounderData.trackPurchase(purchase(order = null, products = """["coins_100","coins_bonus"]"""), PurchaseKind.INAPP)
        val event = h.queued.last()
        assertNull(event.order)
        assertEquals("coins_100", event.product)
        assertEquals("inapp", event.kind)
        assertFalse(event.encoded().contains("order"))
    }

    @Test fun pendingPurchasesAreNotSentAndTokensOnlyOnce() {
        FounderData.trackPurchase(purchase(state = 4), PurchaseKind.SUBS)
        assertTrue(h.queued.isEmpty())
        FounderData.trackPurchase(purchase(), PurchaseKind.SUBS)
        FounderData.trackPurchase(purchase(), PurchaseKind.SUBS)
        assertEquals(1, h.queued.count { it.t == WireEventType.PURCHASE })
    }

    @Test fun purchaseResultSendsTheOutcomeGoalAndThePurchase() {
        val ok = BillingResult.newBuilder().setResponseCode(BillingClient.BillingResponseCode.OK).build()
        assertSame(PurchaseOutcome.Purchased, FounderData.trackPurchaseResult(ok, listOf(purchase()), PurchaseKind.SUBS, "pro_yearly", PaywallSource.ONBOARDING))
        assertEquals(listOf(WireEventType.SESSION_START, WireEventType.PURCHASE), h.queued.map { it.t })

        assertSame(PurchaseOutcome.Pending, FounderData.trackPurchaseResult(ok, listOf(purchase(state = 4)), PurchaseKind.SUBS, "pro_yearly", PaywallSource.ONBOARDING))
        assertEquals("purchase_pending", h.queued.last().n)

        val cancelled = BillingResult.newBuilder().setResponseCode(BillingClient.BillingResponseCode.USER_CANCELED).build()
        assertSame(PurchaseOutcome.Cancelled, FounderData.trackPurchaseResult(cancelled, null, PurchaseKind.SUBS, "pro_yearly", PaywallSource.SETTINGS))
        assertEquals("purchase_cancelled", h.queued.last().n)
        assertEquals(mapOf("source" to "settings", "product" to "pro_yearly"), h.queued.last().p)
    }

    @Test fun purchaseByItsParts() {
        FounderData.trackPurchase("tok_1", "pro", PurchaseKind.SUBS, null)
        assertEquals("tok_1", h.queued.last().token)
        FounderData.trackPurchase("  ", "pro", PurchaseKind.SUBS, null)
        assertEquals(1, h.queued.count { it.t == WireEventType.PURCHASE })
    }
}
