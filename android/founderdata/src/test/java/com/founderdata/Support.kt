package com.founderdata

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File
import java.net.URL
import java.nio.file.Files

/** 2025-10-25T13:46:40Z, the contract's first timestamp, in milliseconds. */
internal const val T0: Long = 1_761_400_000_000L

internal class TestClock(start: Long = T0) {
    @Volatile var now: Long = start
    fun advance(seconds: Double) {
        now += Math.round(seconds * 1000)
    }
    fun advance(seconds: Int) = advance(seconds.toDouble())
}

/** Statuses returned in order; 202 once the list is used up. -1 throws a network error. */
internal class FakeTransport : Transport {
    private val scripted = ArrayList<TransportResponse>()
    private val sent = ArrayList<ByteArray>()

    @Synchronized fun script(vararg statuses: Int) {
        scripted.clear()
        statuses.forEach { scripted.add(TransportResponse(it)) }
    }

    @Synchronized fun scriptResponses(vararg responses: TransportResponse) {
        scripted.clear()
        scripted.addAll(responses)
    }

    val bodies: List<ByteArray> @Synchronized get() = sent.toList()
    val batches: List<WireBatch> get() = bodies.map { WireBatch.decode(String(it, Charsets.UTF_8)) }

    override suspend fun post(body: ByteArray, url: URL): TransportResponse {
        val response = synchronized(this) {
            sent.add(body)
            if (scripted.isEmpty()) TransportResponse(202) else scripted.removeAt(0)
        }
        if (response.status == -1) throw java.io.IOException("offline")
        return response
    }
}

internal class Counter {
    private var value = 0
    @Synchronized fun next(): String {
        value += 1
        return "s$value"
    }
}

internal val FIXTURE = WireContext(
    appVersion = "1.4.0", build = "57", osVersion = "16", device = "Pixel 9", formFactor = "phone",
    locale = "en_US", bundleId = "com.example.shipkit",
)

internal const val LAUNCH_ID = "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b"

internal class Harness(
    directory: File? = null,
    enabled: Boolean = true,
    persistent: Boolean = true,
    vendorInstallId: String? = null,
    installId: String? = null,
) {
    val clock = TestClock()
    val transport = FakeTransport()
    val ids = Counter()
    val directory: File = directory ?: Files.createTempDirectory("founderdata-tests").toFile().also { it.delete() }
    val core: Core = makeCore(
        this.directory, clock, transport, ids, enabled, persistent, vendorInstallId,
        installId ?: vendorInstallId ?: LAUNCH_ID,
    )

    val stateFile: File get() = File(directory, "state.json")
    val queued: List<WireEvent> get() = core.snapshot.queue.items.map { it.event }

    fun cleanUp() {
        directory.deleteRecursively()
    }

    companion object {
        fun makeCore(
            directory: File,
            clock: TestClock,
            transport: Transport,
            ids: Counter,
            enabled: Boolean = true,
            persistent: Boolean = true,
            vendorInstallId: String? = null,
            installId: String = vendorInstallId ?: LAUNCH_ID,
            endpoint: URL = URL("https://stats.example.com/api/app/events"),
        ): Core = Core(
            Core.Configuration(
                siteId = "site_1",
                endpoint = endpoint,
                installId = installId,
                context = FIXTURE,
                store = if (persistent) StateStore(File(directory, "state.json")) else null,
                transport = transport,
                now = { clock.now },
                enabled = enabled,
                jitter = { 1.0 },
                makeSessionId = { ids.next() },
                saveDelayMs = 3_600_000,
                flushAfterPurchase = false,
                vendorInstallId = vendorInstallId,
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
            ),
        )
    }
}

/** The repository root: tests run in android/founderdata. */
internal val repoRoot: File = generateSequence(File("").absoluteFile) { it.parentFile }
    .first { File(it, "docs/APP-API.md").exists() }

internal fun parse(text: String): Any? = Json.parse(text)
internal fun parse(bytes: ByteArray): Any? = Json.parse(String(bytes, Charsets.UTF_8))

internal fun installCore(core: Core) = FounderData.installForTests(core)
