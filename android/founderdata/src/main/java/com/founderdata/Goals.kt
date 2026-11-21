package com.founderdata

// Types for the goal names the dashboard reads (docs/APP-EVENTS.md, sections 3 to 6). The helpers that send them are
// on FounderData; each sends one ordinary goal, so FounderData.goal keeps working next to them.

/**
 * Where a paywall opened, the `source` prop. Keep a short, fixed list per app: the paywall panels group by it.
 * `PaywallSource("streak_banner")` works for your own names.
 */
public class PaywallSource(public val rawValue: String) {
    override fun equals(other: Any?): Boolean = other is PaywallSource && other.rawValue == rawValue
    override fun hashCode(): Int = rawValue.hashCode()
    override fun toString(): String = rawValue

    public companion object {
        /** The paywall inside first-run onboarding. */
        @JvmField public val ONBOARDING: PaywallSource = PaywallSource("onboarding")

        /** The upgrade entry in the app's settings. */
        @JvmField public val SETTINGS: PaywallSource = PaywallSource("settings")

        /** A locked feature, when the app does not tell them apart. */
        @JvmField public val FEATURE_GATE: PaywallSource = PaywallSource("feature_gate")

        /** One locked feature: `gate("Stats")` is `gate_stats`. */
        @JvmStatic
        public fun gate(feature: String): PaywallSource =
            PaywallSource("gate_" + (FounderData.propertyKey(feature, 60) ?: "feature"))
    }
}

/** The `reason` prop of `purchase_failed`. */
public enum class PurchaseFailureReason(public val wire: String) {
    NETWORK("network"),
    STORE("store"),
    VERIFICATION("verification"),
    OTHER("other");

    public companion object {
        /**
         * Sorts a Play Billing response code (`BillingResponseCode`): `SERVICE_UNAVAILABLE`, `NETWORK_ERROR`,
         * `SERVICE_DISCONNECTED` and `SERVICE_TIMEOUT` are [NETWORK], other errors [STORE]. Report `USER_CANCELED`
         * with `purchaseCancelled` instead.
         */
        @JvmStatic
        public fun fromBillingResponseCode(code: Int): PurchaseFailureReason = when (code) {
            BillingCodes.SERVICE_UNAVAILABLE, BillingCodes.NETWORK_ERROR,
            BillingCodes.SERVICE_DISCONNECTED, BillingCodes.SERVICE_TIMEOUT -> NETWORK
            else -> STORE
        }

        /**
         * Sorts an exception from purchase code: RevenueCat's `NetworkError` and any `IOException` are [NETWORK],
         * RevenueCat's other errors [STORE], the rest [OTHER].
         */
        @JvmStatic
        public fun of(error: Throwable): PurchaseFailureReason {
            RevenueCatError.code(error)?.let { return if (it == RevenueCatError.NETWORK) NETWORK else STORE }
            return if (error is java.io.IOException) NETWORK else OTHER
        }
    }
}

/** The `result` prop of `permission_<kind>`. */
public enum class PermissionResult(public val wire: String) {
    GRANTED("granted"),
    DENIED("denied"),
    LIMITED("limited"),
}

/** How a purchase attempt ended. [FounderData.trackPurchase] sends the matching goal. */
public sealed class PurchaseOutcome {
    /** The purchase went through. No goal: the purchase itself reaches FounderData through `trackPurchase(purchase)`. */
    public object Purchased : PurchaseOutcome()

    /** The user closed the payment sheet: `purchase_cancelled`. */
    public object Cancelled : PurchaseOutcome()

    /** Waiting for payment (pending purchase): `purchase_pending`. */
    public object Pending : PurchaseOutcome()

    /** The purchase failed: `purchase_failed` with `reason`. */
    public data class Failed(val reason: PurchaseFailureReason) : PurchaseOutcome()

    internal fun goal(product: String, source: PaywallSource): GoalEvent? = when (this) {
        Purchased -> null
        Cancelled -> GoalEvent.purchase("purchase_cancelled", product, source)
        Pending -> GoalEvent.purchase("purchase_pending", product, source)
        is Failed -> GoalEvent.purchaseFailed(product, source, reason)
    }

    override fun toString(): String = when (this) {
        Purchased -> "Purchased"
        Cancelled -> "Cancelled"
        Pending -> "Pending"
        is Failed -> "Failed(${reason.wire})"
    }

    public companion object {
        /**
         * From a Play Billing response code: `OK` is [Purchased] (or [Pending] when [pending] is true, from
         * `Purchase.PurchaseState.PENDING`), `USER_CANCELED` [Cancelled], anything else [Failed].
         */
        @JvmStatic
        @JvmOverloads
        public fun fromBillingResponseCode(code: Int, pending: Boolean = false): PurchaseOutcome = when (code) {
            BillingCodes.OK -> if (pending) Pending else Purchased
            BillingCodes.USER_CANCELED -> Cancelled
            else -> Failed(PurchaseFailureReason.fromBillingResponseCode(code))
        }

        /** Sorts an exception: RevenueCat's cancel and pending codes, anything else [Failed]. */
        @JvmStatic
        public fun of(error: Throwable): PurchaseOutcome = when (RevenueCatError.code(error)) {
            RevenueCatError.PURCHASE_CANCELLED -> Cancelled
            RevenueCatError.PAYMENT_PENDING -> Pending
            else -> Failed(PurchaseFailureReason.of(error))
        }
    }
}

/** `BillingClient.BillingResponseCode` values, so the SDK needs no billing dependency to read them. */
internal object BillingCodes {
    const val SERVICE_TIMEOUT = -3
    const val SERVICE_DISCONNECTED = -1
    const val OK = 0
    const val USER_CANCELED = 1
    const val SERVICE_UNAVAILABLE = 2
    const val NETWORK_ERROR = 12
}

/**
 * RevenueCat's error codes without a RevenueCat dependency: `PurchasesException.code` is a `PurchasesErrorCode`
 * enum, read here by name.
 */
internal object RevenueCatError {
    const val PURCHASE_CANCELLED = "PurchaseCancelledError"
    const val NETWORK = "NetworkError"
    const val PAYMENT_PENDING = "PaymentPendingError"

    fun code(error: Throwable): String? {
        if (!error.javaClass.name.startsWith("com.revenuecat.purchases.")) return null
        return runCatching {
            val code = error.javaClass.getMethod("getCode").invoke(error)
            (code as? Enum<*>)?.name ?: code?.toString()
        }.getOrNull()
    }
}

/** A goal name and its props. Null props are left out. */
internal data class GoalEvent(val name: String, val props: Map<String, String> = emptyMap()) {
    companion object {
        fun of(name: String, vararg props: Pair<String, String?>): GoalEvent =
            GoalEvent(name, props.mapNotNull { (k, v) -> v?.let { k to it } }.toMap())

        fun paywallView(source: PaywallSource, paywall: String?) =
            of("paywall_view", "source" to source.rawValue, "paywall" to paywall)

        fun purchase(name: String, product: String, source: PaywallSource) =
            of(name, "source" to source.rawValue, "product" to product)

        fun purchaseFailed(product: String, source: PaywallSource, reason: PurchaseFailureReason) =
            of("purchase_failed", "source" to source.rawValue, "product" to product, "reason" to reason.wire)

        fun onboardingSkip(step: String) = of("onboarding_skip", "step" to FounderData.propertyKey(step, 53))

        fun permissionPrompt(kind: String): GoalEvent? =
            FounderData.propertyKey(kind, 60)?.let { GoalEvent("permission_${it}_prompt") }

        fun permission(kind: String, result: PermissionResult): GoalEvent? =
            FounderData.propertyKey(kind, 60)?.let { of("permission_$it", "result" to result.wire) }
    }
}
