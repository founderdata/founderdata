package com.founderdata

// Wire format of POST /api/app/events. Field names follow docs/APP-API.md, sections 1 and 9.
// Null fields are left out of the JSON.

/** Device and app context sent once per batch as `ctx`. */
internal data class WireContext(
    val platform: String = "android",
    val appVersion: String,
    val build: String,
    val osVersion: String,
    val device: String,
    /** `"phone"` or `"tablet"` (smallest screen width 600 dp or more). */
    val formFactor: String,
    val locale: String,
    val bundleId: String,
    /** True while the install id is kept on the device (`setConsent(true)`). Omitted otherwise. */
    val consent: Boolean? = null,
    /** `"vendor"` while events go out under the [InstallId.VENDOR] id without consent. Omitted otherwise. */
    val id: String? = null,
) {
    fun toJson(): Map<String, Any?> = mapOf(
        "platform" to platform,
        "app_version" to appVersion,
        "build" to build,
        "os_version" to osVersion,
        "device" to device,
        "form_factor" to formFactor,
        "locale" to locale,
        "bundle_id" to bundleId,
        "consent" to consent,
        "id" to id,
    )

    companion object {
        fun fromJson(m: Map<*, *>): WireContext = WireContext(
            platform = m.str("platform") ?: "android",
            appVersion = m.str("app_version") ?: "0",
            build = m.str("build") ?: "0",
            osVersion = m.str("os_version") ?: "0",
            device = m.str("device") ?: "unknown",
            formFactor = m.str("form_factor") ?: "phone",
            locale = m.str("locale") ?: "",
            bundleId = m.str("bundle_id") ?: "unknown",
            consent = m.bool("consent"),
            id = m.str("id"),
        )
    }
}

/** Acquisition source attached to `session_start` as `src`. */
internal data class WireSource(
    val utmSource: String? = null,
    val utmMedium: String? = null,
    val utmCampaign: String? = null,
    val utmTerm: String? = null,
    val utmContent: String? = null,
    val ref: String? = null,
    /** Web visitor id from an App Link (`rt_vid`), stored server-side as `linked_web_vid`. */
    val webVisitorId: String? = null,
    /** The ad network whose click id the link carried (`google_ads`, ...), sent with [clickId]. */
    val clickNetwork: String? = null,
    /** The raw click id (`gclid`, `msclkid`, ...). The server keeps it 90 days. */
    val clickId: String? = null,
) {
    val isEmpty: Boolean get() = this == WireSource()

    /** Values from [other] win where they are set. The click network and id travel as a pair. */
    fun merging(other: WireSource): WireSource {
        val otherClick = other.clickId != null
        return WireSource(
            utmSource = other.utmSource ?: utmSource,
            utmMedium = other.utmMedium ?: utmMedium,
            utmCampaign = other.utmCampaign ?: utmCampaign,
            utmTerm = other.utmTerm ?: utmTerm,
            utmContent = other.utmContent ?: utmContent,
            ref = other.ref ?: ref,
            webVisitorId = other.webVisitorId ?: webVisitorId,
            clickNetwork = if (otherClick) other.clickNetwork else clickNetwork,
            clickId = if (otherClick) other.clickId else clickId,
        )
    }

    fun toJson(): Map<String, Any?> = mapOf(
        "utm_source" to utmSource,
        "utm_medium" to utmMedium,
        "utm_campaign" to utmCampaign,
        "utm_term" to utmTerm,
        "utm_content" to utmContent,
        "ref" to ref,
        "rt_vid" to webVisitorId,
        "click_network" to clickNetwork,
        "click_id" to clickId,
    )

    companion object {
        fun fromJson(m: Map<*, *>): WireSource = WireSource(
            utmSource = m.str("utm_source"),
            utmMedium = m.str("utm_medium"),
            utmCampaign = m.str("utm_campaign"),
            utmTerm = m.str("utm_term"),
            utmContent = m.str("utm_content"),
            ref = m.str("ref"),
            webVisitorId = m.str("rt_vid") ?: m.str("ml_vid"),
            clickNetwork = m.str("click_network"),
            clickId = m.str("click_id"),
        )
    }
}

internal enum class WireEventType(val wire: String) {
    SESSION_START("session_start"),
    SCREEN("screen"),
    GOAL("goal"),
    PING("ping"),
    IDENTIFY("identify"),
    PURCHASE("purchase"),
    /** The full set of session properties, sent when they change after `session_start` left the queue. */
    SESSION_PROPS("session_props");

    companion object {
        fun of(wire: String?): WireEventType? = entries.firstOrNull { it.wire == wire }
    }
}

internal data class WireEvent(
    val t: WireEventType,
    val sid: String,
    /** Client time in Unix milliseconds. */
    val ts: Long,
    val n: String? = null,
    val p: Map<String, String>? = null,
    val d: Long? = null,
    val src: WireSource? = null,
    /** Session properties on `session_start`. */
    val sp: Map<String, String>? = null,
    // Google Play purchase (docs/APP-API.md section 9).
    val store: String? = null,
    val token: String? = null,
    val product: String? = null,
    val kind: String? = null,
    val order: String? = null,
) {
    fun toJson(): Map<String, Any?> = mapOf(
        "t" to t.wire,
        "sid" to sid,
        "ts" to ts,
        "n" to n,
        "p" to p,
        "d" to d,
        "src" to src?.toJson(),
        "sp" to sp,
        "store" to store,
        "token" to token,
        "product" to product,
        "kind" to kind,
        "order" to order,
    )

    fun encoded(): String = Json.write(toJson())

    companion object {
        fun fromJson(m: Map<*, *>): WireEvent? {
            val t = WireEventType.of(m.str("t")) ?: return null
            return WireEvent(
                t = t,
                sid = m.str("sid") ?: return null,
                ts = m.long("ts") ?: return null,
                n = m.str("n"),
                p = m.stringMap("p"),
                d = m.long("d"),
                src = m.obj("src")?.let(WireSource::fromJson),
                sp = m.stringMap("sp"),
                store = m.str("store"),
                token = m.str("token"),
                product = m.str("product"),
                kind = m.str("kind"),
                order = m.str("order"),
            )
        }
    }
}

internal data class WireBatch(
    val w: String,
    val ctx: WireContext,
    val vid: String,
    val events: List<WireEvent>,
) {
    fun toJson(): Map<String, Any?> = mapOf(
        "w" to w,
        "ctx" to ctx.toJson(),
        "vid" to vid,
        "events" to events.map { it.toJson() },
    )

    fun encoded(): String = Json.write(toJson())

    companion object {
        fun decode(text: String): WireBatch {
            val m = Json.parse(text) as Map<*, *>
            return WireBatch(
                w = m.str("w")!!,
                ctx = WireContext.fromJson(m.obj("ctx")!!),
                vid = m.str("vid")!!,
                events = m.list("events")!!.mapNotNull { (it as? Map<*, *>)?.let(WireEvent::fromJson) },
            )
        }
    }
}

/** Trims whitespace and cuts to [max] characters. Null when nothing is left. */
internal fun String.clipped(max: Int): String? {
    val trimmed = trim()
    if (trimmed.isEmpty()) return null
    return if (trimmed.codePointCount(0, trimmed.length) > max) {
        trimmed.substring(0, trimmed.offsetByCodePoints(0, max))
    } else {
        trimmed
    }
}
