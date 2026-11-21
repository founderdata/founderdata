package com.founderdata

import android.content.Context
import com.google.android.gms.appset.AppSet
import com.google.android.gms.appset.AppSetIdInfo

/**
 * Reads the App set ID through `play-services-appset`, which the app adds itself (the SDK depends on it with
 * `compileOnly`). Only the developer scope counts: an app-scoped id changes with each reinstall and would claim a
 * persistence it does not have. Every failure, including a missing library, gives null.
 */
internal class PlayAppSetIdSource(private val context: Context) : AppSetIdSource {
    override fun fetch(callback: (String?) -> Unit) {
        if (!isAvailable()) {
            SdkLog.i("FounderData: play-services-appset is not in the app, this launch uses a random install id")
            callback(null)
            return
        }
        try {
            AppSet.getClient(context).appSetIdInfo
                .addOnSuccessListener { info: AppSetIdInfo? ->
                    val id = info?.takeIf { it.scope == AppSetIdInfo.SCOPE_DEVELOPER }?.id
                    if (info != null && id == null) SdkLog.i("FounderData: the App set ID is app-scoped, using a random install id")
                    callback(id?.takeIf { it.isNotBlank() })
                }
                .addOnFailureListener { callback(null) }
        } catch (e: Throwable) {
            // LinkageError from a library version without these classes, or Play services missing on the device.
            callback(null)
        }
    }

    companion object {
        fun isAvailable(): Boolean = try {
            Class.forName("com.google.android.gms.appset.AppSet")
            true
        } catch (_: Throwable) {
            false
        }
    }
}
