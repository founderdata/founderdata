@file:JvmName("FounderDataBilling")

package com.founderdata

import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.Purchase

// Play Billing helpers. The SDK depends on `com.android.billingclient:billing` with `compileOnly`: these functions
// live in their own class (FounderDataBilling), so an app without Play Billing never loads them and never needs the
// library. From Kotlin they read like members: `FounderData.trackPurchase(purchase, PurchaseKind.SUBS)`.

/**
 * Reports a Google Play purchase: `{ "t": "purchase", "store": "google_play", "token", "product", "kind", "order" }`
 * (docs/APP-API.md, section 9). Call it from `PurchasesUpdatedListener` and for purchases found by
 * `queryPurchasesAsync`. Only purchases in the purchased state are sent, each token once; a pending purchase sends
 * nothing until it completes. `product` is the first of `purchase.products`.
 */
public fun FounderData.trackPurchase(purchase: Purchase, kind: PurchaseKind) {
    if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) {
        SdkLog.i("FounderData skipped a purchase that is not in the purchased state")
        return
    }
    val product = purchase.products.firstOrNull() ?: return
    trackPurchase(purchase.purchaseToken, product, kind, purchase.orderId)
}

/**
 * Reports what `PurchasesUpdatedListener.onPurchasesUpdated` received for a purchase you started with
 * [FounderData.purchaseStarted]: the outcome goal for [product] and [source] (`purchase_cancelled`,
 * `purchase_pending`, `purchase_failed` with a reason, or none on success), and [trackPurchase] for each purchased
 * item. Returns the outcome.
 */
public fun FounderData.trackPurchaseResult(
    result: BillingResult,
    purchases: List<Purchase>?,
    kind: PurchaseKind,
    product: String,
    source: PaywallSource,
): PurchaseOutcome {
    val list = purchases.orEmpty()
    val pending = result.responseCode == BillingCodes.OK &&
        list.isNotEmpty() && list.all { it.purchaseState == Purchase.PurchaseState.PENDING }
    val outcome = PurchaseOutcome.fromBillingResponseCode(result.responseCode, pending)
    if (result.responseCode == BillingCodes.OK) list.forEach { trackPurchase(it, kind) }
    outcome.goal(product, source)?.let(::send)
    return outcome
}

/**
 * Sets the obfuscated account id to [FounderData.obfuscatedAccountId], so Google's records of this purchase
 * (`obfuscatedExternalAccountId`) credit renewals to this install.
 */
public fun BillingFlowParams.Builder.setFounderDataAccountId(): BillingFlowParams.Builder =
    setObfuscatedAccountId(FounderData.obfuscatedAccountId)
