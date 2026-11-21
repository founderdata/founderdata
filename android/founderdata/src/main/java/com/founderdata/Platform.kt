package com.founderdata

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

internal object DeviceContext {
    fun current(context: Context): WireContext {
        val pm = context.packageManager
        val info = runCatching {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, 0)
        }.getOrNull()
        val build = when {
            info == null -> "0"
            Build.VERSION.SDK_INT >= 28 -> info.longVersionCode.toString()
            else -> @Suppress("DEPRECATION") info.versionCode.toString()
        }
        return WireContext(
            appVersion = info?.versionName?.takeIf { it.isNotBlank() } ?: "0",
            build = build,
            osVersion = Build.VERSION.RELEASE?.takeIf { it.isNotBlank() } ?: Build.VERSION.SDK_INT.toString(),
            device = Build.MODEL?.takeIf { it.isNotBlank() } ?: "unknown",
            formFactor = formFactor(context.resources.configuration.smallestScreenWidthDp),
            locale = localeIdentifier(Locale.getDefault()),
            bundleId = context.packageName,
        )
    }

    /** The model name says nothing about the size, so the server reads the form factor. */
    fun formFactor(smallestScreenWidthDp: Int): String = if (smallestScreenWidthDp >= 600) "tablet" else "phone"

    /** `en_US`, built by hand: `Locale.toString()` can add script and extension suffixes. */
    fun localeIdentifier(locale: Locale): String {
        val language = locale.language.ifEmpty { "und" }
        return if (locale.country.isNullOrEmpty()) language else "${language}_${locale.country}"
    }

    /** The app's own debuggable flag: a library's `BuildConfig.DEBUG` is always false in a release AAR. */
    fun isDebuggable(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}

/** Reads the Play Install Referrer once per call. Behind an interface so tests need no Play Store. */
internal fun interface ReferrerSource {
    fun fetch(callback: (String?) -> Unit)
}

internal class PlayReferrerSource(private val context: Context) : ReferrerSource {
    override fun fetch(callback: (String?) -> Unit) {
        val done = AtomicBoolean(false)
        fun finish(value: String?) {
            if (done.compareAndSet(false, true)) callback(value)
        }
        try {
            val client = InstallReferrerClient.newBuilder(context).build()
            client.startConnection(object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    val value = if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                        runCatching { client.installReferrer.installReferrer }.getOrNull()
                    } else {
                        null
                    }
                    runCatching { client.endConnection() }
                    finish(value)
                }

                override fun onInstallReferrerServiceDisconnected() = finish(null)
            })
        } catch (e: Throwable) {
            finish(null)
        }
    }
}

/**
 * Wires the app's process lifecycle to the core: sessions and pings on start and stop, the 30-second timer while
 * the app is visible, and an upload when it goes to the background.
 *
 * The background upload is a coroutine, not WorkManager: WorkManager keeps its work, and so the events, in its own
 * database on the device, which the SDK must not do without consent. Events still unsent when the process dies are
 * lost without consent, as on iOS; with consent the queue file keeps them for the next launch.
 */
internal class LifecycleBridge(private val core: Core) : DefaultLifecycleObserver {
    private var timer: Job? = null

    override fun onStart(owner: LifecycleOwner) {
        core.appBecameActive()
        timer?.cancel()
        timer = core.config.scope.launch {
            while (isActive) {
                delay(30_000)
                core.tick()
                core.flush()
            }
        }
    }

    override fun onStop(owner: LifecycleOwner) {
        timer?.cancel()
        timer = null
        core.appEnteredBackground()
        core.config.scope.launch {
            core.flush(ignoreBackoff = true)
            core.saveNow()
        }
    }

    companion object {
        private val installed = AtomicBoolean(false)

        fun install(core: Core) {
            if (!installed.compareAndSet(false, true)) return
            val add = Runnable {
                runCatching { ProcessLifecycleOwner.get().lifecycle.addObserver(LifecycleBridge(core)) }
                    .onFailure { SdkLog.e("FounderData could not observe the app lifecycle: ${it.message}") }
            }
            if (Looper.myLooper() == Looper.getMainLooper()) add.run() else Handler(Looper.getMainLooper()).post(add)
        }
    }
}

/** Uploads when the network comes back after being lost. */
internal object NetworkWatcher {
    private val started = AtomicBoolean(false)

    @SuppressLint("MissingPermission")
    fun start(context: Context, core: Core) {
        if (!started.compareAndSet(false, true)) return
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        var lost = false
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val returned = synchronized(this) { lost.also { lost = false } }
                if (returned) core.config.scope.launch { core.networkReturned() }
            }

            override fun onLost(network: Network) {
                synchronized(this) { lost = true }
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                cm.registerDefaultNetworkCallback(callback)
            } else {
                val request = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
                cm.registerNetworkCallback(request, callback)
            }
        } catch (e: Exception) {
            SdkLog.d("FounderData could not watch the network: ${e.message}")
        }
    }
}
