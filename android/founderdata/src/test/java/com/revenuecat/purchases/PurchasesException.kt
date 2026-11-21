package com.revenuecat.purchases

/** A stand-in with RevenueCat's shape: `PurchasesException.code` is a `PurchasesErrorCode` enum. */
enum class PurchasesErrorCode { UnknownError, PurchaseCancelledError, StoreProblemError, NetworkError, PaymentPendingError }

open class PurchasesException(val code: PurchasesErrorCode) : Exception(code.name)
