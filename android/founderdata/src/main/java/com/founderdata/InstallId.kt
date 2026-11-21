package com.founderdata

import java.security.MessageDigest
import java.util.UUID

/**
 * Which install id the SDK uses while the user has not given consent ([FounderData.setConsent]). With consent the
 * id stored in the app's no-backup folder wins in both modes.
 */
public enum class InstallId {
    /** A random id for each process, kept in memory. Nothing is stored on the device. The default. */
    RANDOM,

    /**
     * A SHA-256 hash of the App set ID (developer scope) and the site id, sent as a UUID. The same install comes back
     * under the same id on every launch, without consent and without writing to the device. Needs
     * `com.google.android.gms:play-services-appset` in the app; without it, without Google Play services, or with an
     * app-scoped App set ID, the launch uses a random id. Declare it as Device or other IDs in Play's Data safety form.
     */
    VENDOR,
}

/** The [InstallId.VENDOR] id: never the raw App set ID, and a different id for each FounderData site. */
internal object VendorInstallId {
    /** Sent as `ctx.id` with every batch under this id, so the server counts the install for retention. */
    const val CONTEXT_VALUE = "vendor"

    /** How long the first upload of a [InstallId.VENDOR] launch waits for the App set ID. */
    const val WAIT_MS: Long = 5_000

    /**
     * The first 16 bytes of SHA-256("founderdata-vendor-v1:" + site id + ":" + app set id in lowercase), as a
     * lowercase UUID with the RFC 9562 version 8 (custom) bits set. The same formula as the Swift SDK.
     */
    fun derive(appSetId: String, siteId: String): String {
        val input = "founderdata-vendor-v1:$siteId:${appSetId.trim().lowercase()}"
        val b = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8)).copyOf(16)
        b[6] = ((b[6].toInt() and 0x0f) or 0x80).toByte()
        b[8] = ((b[8].toInt() and 0x3f) or 0x80).toByte()
        var msb = 0L
        var lsb = 0L
        for (i in 0 until 8) msb = (msb shl 8) or (b[i].toLong() and 0xff)
        for (i in 8 until 16) lsb = (lsb shl 8) or (b[i].toLong() and 0xff)
        return UUID(msb, lsb).toString()
    }
}

/** Delivers the developer-scoped App set ID once, or null. Behind an interface so tests need no Play services. */
internal fun interface AppSetIdSource {
    fun fetch(callback: (String?) -> Unit)
}
