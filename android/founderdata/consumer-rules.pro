# FounderData for Android: rules for apps that shrink with R8.

# Play Billing and play-services-appset are optional (compileOnly). Apps that leave them out never load the classes
# that use them (FounderDataBilling, PlayAppSetIdSource), so R8 must not fail on the missing references.
-dontwarn com.android.billingclient.**
-dontwarn com.google.android.gms.appset.**
-dontwarn com.google.android.gms.tasks.**

# The SDK checks for play-services-appset by class name.
-keepnames class com.google.android.gms.appset.AppSet

# RevenueCat errors are sorted by reading PurchasesException.getCode() by reflection, without a RevenueCat dependency.
-keepclassmembers class com.revenuecat.purchases.PurchasesException { public *** getCode(); }
-keepclassmembers class com.revenuecat.purchases.PurchasesTransactionException { public *** getCode(); }
-dontwarn com.revenuecat.purchases.**
