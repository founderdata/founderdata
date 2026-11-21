package com.founderdata

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** What the server answered: the HTTP status and, when it sent one, `Retry-After` in seconds. */
internal data class TransportResponse(val status: Int, val retryAfterSeconds: Long? = null)

internal interface Transport {
    /** POSTs [body] as JSON. Throws on a network error. */
    suspend fun post(body: ByteArray, url: URL): TransportResponse
}

/** `HttpURLConnection`, so the SDK pulls in no HTTP library. No cookies, no cache. */
internal class HttpTransport(private val timeoutMs: Int = 30_000) : Transport {
    override suspend fun post(body: ByteArray, url: URL): TransportResponse = withContext(Dispatchers.IO) {
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.useCaches = false
            conn.instanceFollowRedirects = false
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            val status = conn.responseCode
            val retryAfter = RetryAfter.parse(conn.getHeaderField("Retry-After"), System.currentTimeMillis())
            // Drain the body so the connection can be reused.
            runCatching { (if (status >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() } }
            TransportResponse(status, retryAfter)
        } finally {
            conn.disconnect()
        }
    }
}

internal object RetryAfter {
    /** Seconds from a `Retry-After` value: delta seconds or an HTTP date. Null when missing or unreadable. */
    fun parse(value: String?, nowMs: Long): Long? {
        val v = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        v.toLongOrNull()?.let { return maxOf(0, it) }
        return runCatching {
            val format = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US)
            format.timeZone = TimeZone.getTimeZone("GMT")
            maxOf(0, (format.parse(v)!!.time - nowMs) / 1000)
        }.getOrNull()
    }
}

internal enum class DeliveryOutcome {
    /** 2xx: remove the batch. A 202 with `rejected: n` means the server skipped n bad events; they go too. */
    DELIVERED,

    /** 400 bad payload, 403 package not allowed for this site, 413 too large, 422: the server never takes it. */
    REJECTED,

    /** Network error, 404 (site not set up yet), 429 or 5xx: keep it and back off. */
    RETRY;

    companion object {
        fun of(status: Int): DeliveryOutcome = when (status) {
            in 200..299 -> DELIVERED
            400, 403, 413, 422 -> REJECTED
            else -> RETRY
        }
    }
}

internal object Backoff {
    /** The longest wait a `Retry-After` can ask for: the daily write cap resets within a day. */
    const val MAX_RETRY_AFTER_MS: Long = 24L * 60 * 60 * 1000

    /** 5 s, 10 s, 20 s ... capped at 15 minutes, times a jitter factor around 1. In milliseconds. */
    fun delayMs(failures: Int, jitter: Double = 1.0): Long {
        val exponent = (failures - 1).coerceIn(0, 16)
        val seconds = minOf(900.0, 5.0 * Math.pow(2.0, exponent.toDouble())) * jitter
        return Math.round(seconds * 1000)
    }

    /** The later of the backoff and the server's `Retry-After`. */
    fun waitMs(failures: Int, jitter: Double, retryAfterSeconds: Long?): Long {
        val backoff = delayMs(failures, jitter)
        val server = retryAfterSeconds?.let { minOf(it * 1000, MAX_RETRY_AFTER_MS) } ?: 0
        return maxOf(backoff, server)
    }
}

internal object Endpoint {
    /** `https://stats.example.com` or `stats.example.com` becomes `https://stats.example.com/api/app/events`. */
    fun events(host: String): URL? {
        var base = host.trim()
        if (base.isEmpty()) return null
        if (!base.contains("://")) base = "https://$base"
        base = base.trimEnd('/')
        return runCatching {
            val url = URL(base)
            if (url.host.isNullOrEmpty()) null else URL("$base/api/app/events")
        }.getOrNull()
    }
}
