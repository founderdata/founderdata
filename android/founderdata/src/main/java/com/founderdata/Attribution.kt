package com.founderdata

import java.io.ByteArrayOutputStream

/**
 * Ad networks that add a click id to the link, in the server's order (src/shared/sources.ts, CLICK_NETWORKS): when a
 * link carries two, the first network here wins. Meta's fbclid is not here: Meta adds it to organic clicks too.
 */
internal enum class ClickNetwork(val wire: String, val parameters: List<String>) {
    GOOGLE_ADS("google_ads", listOf("gclid", "gbraid", "wbraid")),
    MICROSOFT_ADS("microsoft_ads", listOf("msclkid")),
    TIKTOK_ADS("tiktok_ads", listOf("ttclid")),
    X_ADS("x_ads", listOf("twclid")),
    LINKEDIN_ADS("linkedin_ads", listOf("li_fat_id")),
    REDDIT_ADS("reddit_ads", listOf("rdt_cid")),
    SNAPCHAT_ADS("snapchat_ads", listOf("sccid")),
    PINTEREST_ADS("pinterest_ads", listOf("epik"));

    companion object {
        val parameterNames: Set<String> = entries.flatMap { it.parameters }.toSet()

        /**
         * The server's click id rule: 8 to 500 printable ASCII characters without spaces or braces. A `+` that
         * arrived as a space is put back. Braces mean an unfilled macro such as `{gclid}`.
         */
        fun validClickId(raw: String): String? {
            val v = raw.trim(' ', '\t').replace(' ', '+')
            val count = v.codePointCount(0, v.length)
            if (count !in 8..500) return null
            val ok = v.codePoints().allMatch { it in 0x21..0x7A || it == '|'.code || it == '~'.code }
            return if (ok) v else null
        }

        /** The first valid click id [values] (lowercased names) carry, by network order, then parameter order. */
        fun click(values: Map<String, String>): Pair<ClickNetwork, String>? {
            for (network in entries) {
                for (name in network.parameters) {
                    val id = values[name]?.let(::validClickId) ?: continue
                    return network to id
                }
            }
            return null
        }
    }
}

/**
 * Reads utm_*, ref, rt_vid (or the older ml_vid) and ad click ids from a deep link, an App Link or the Play Install
 * Referrer string. Percent escapes are decoded; a `+` stays a `+`, as in the Swift SDK.
 */
internal object LinkAttribution {
    const val MAX_VALUE_LENGTH = 200

    /** From a full URL such as `https://example.com/open?utm_source=x`. Null without attribution parameters. */
    fun fromUrl(url: String): WireSource? {
        val withoutFragment = url.substringBefore('#')
        val q = withoutFragment.indexOf('?')
        if (q < 0) return null
        return fromQuery(withoutFragment.substring(q + 1))
    }

    /** From a query string such as the Install Referrer's `utm_source=google-play&utm_medium=organic`. */
    fun fromQuery(query: String): WireSource? {
        val values = HashMap<String, String>()
        val clickValues = HashMap<String, String>()
        for ((rawName, rawValue) in queryItems(query)) {
            val key = rawName.lowercase()
            if (key in ClickNetwork.parameterNames) {
                // Never clipped: a cut id would not match the network's. An invalid one leaves room for a later one.
                if (clickValues.containsKey(key)) continue
                val value = rawValue?.let(ClickNetwork::validClickId) ?: continue
                clickValues[key] = value
                continue
            }
            if (values.containsKey(key)) continue
            val value = rawValue?.clipped(MAX_VALUE_LENGTH) ?: continue
            values[key] = value
        }
        val click = ClickNetwork.click(clickValues)
        val source = WireSource(
            utmSource = values["utm_source"],
            utmMedium = values["utm_medium"],
            utmCampaign = values["utm_campaign"],
            utmTerm = values["utm_term"],
            utmContent = values["utm_content"],
            ref = values["ref"],
            webVisitorId = (values["rt_vid"] ?: values["ml_vid"])?.let(::validVisitorId),
            clickNetwork = click?.first?.wire,
            clickId = click?.second,
        )
        return if (source.isEmpty) null else source
    }

    /** `a=1&b=%20x&c` as name and value pairs, percent-decoded. `c` has a null value. */
    fun queryItems(query: String): List<Pair<String, String?>> =
        query.split('&').filter { it.isNotEmpty() }.map { part ->
            val eq = part.indexOf('=')
            if (eq < 0) percentDecode(part) to null else percentDecode(part.substring(0, eq)) to percentDecode(part.substring(eq + 1))
        }

    /** Decodes `%XX` escapes as UTF-8. A broken escape stays as it is. */
    fun percentDecode(s: String): String {
        if (!s.contains('%')) return s
        val out = ByteArrayOutputStream()
        val bytes = s.toByteArray(Charsets.UTF_8)
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == '%'.code.toByte() && i + 2 < bytes.size) {
                val hi = Character.digit(bytes[i + 1].toInt(), 16)
                val lo = Character.digit(bytes[i + 2].toInt(), 16)
                if (hi >= 0 && lo >= 0) {
                    out.write(hi * 16 + lo)
                    i += 3
                    continue
                }
            }
            out.write(b.toInt())
            i++
        }
        return out.toString("UTF-8")
    }

    /** The server accepts visitor ids of 8 to 64 characters from [A-Za-z0-9_-]. */
    fun validVisitorId(raw: String): String? {
        if (raw.length !in 8..64) return null
        return if (raw.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '_' || it == '-' }) raw else null
    }
}
