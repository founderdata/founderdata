package com.founderdata

import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** Everything the SDK keeps between launches after consent, in one JSON file. */
internal data class PersistedState(
    val version: Int = 1,
    val queue: EventQueue = EventQueue(),
    val session: SessionState = SessionState(),
    val pendingSource: WireSource? = null,
    /** The Play Install Referrer was read once. Kept only with consent, so without it the SDK asks each launch. */
    val referrerResolved: Boolean = false,
    val reportedPurchases: List<String> = emptyList(),
) {
    fun toJson(): Map<String, Any?> = mapOf(
        "version" to version,
        "queue" to queue.toJson(),
        "session" to session.toJson(),
        "pendingSource" to pendingSource?.toJson(),
        "referrerResolved" to referrerResolved,
        "reportedPurchases" to reportedPurchases,
    )

    companion object {
        fun fromJson(m: Map<*, *>) = PersistedState(
            version = m.long("version")?.toInt() ?: 1,
            queue = m.obj("queue")?.let(EventQueue::fromJson) ?: EventQueue(),
            session = m.obj("session")?.let(SessionState::fromJson) ?: SessionState(),
            pendingSource = m.obj("pendingSource")?.let(WireSource::fromJson),
            referrerResolved = m.bool("referrerResolved") ?: false,
            reportedPurchases = m.list("reportedPurchases")?.filterIsInstance<String>() ?: emptyList(),
        )
    }
}

/** Writes [text] to [file] through a temporary file and a rename, so a crash never leaves half a file. */
internal fun writeAtomically(file: File, text: String) {
    file.parentFile?.mkdirs()
    val tmp = File(file.parentFile, file.name + ".tmp")
    FileOutputStream(tmp).use { out ->
        out.write(text.toByteArray(Charsets.UTF_8))
        out.flush()
        runCatching { out.fd.sync() }
    }
    if (!tmp.renameTo(file)) {
        file.delete()
        if (!tmp.renameTo(file)) {
            tmp.delete()
            throw java.io.IOException("could not rename ${tmp.name}")
        }
    }
}

/**
 * The SDK's folder, `noBackupFilesDir/founderdata`: excluded from Auto Backup and device transfer, so an install id
 * is never restored to another device. Only used after consent.
 */
internal object StorageDir {
    const val NAME = "founderdata"

    fun under(noBackupFilesDir: File): File = File(noBackupFilesDir, NAME)

    /** Deletes the folder without creating anything. */
    fun eraseAll(noBackupFilesDir: File) {
        under(noBackupFilesDir).deleteRecursively()
    }
}

/** Reads and writes `state.json` in the SDK's folder. */
internal class StateStore(val file: File) {
    fun load(): PersistedState? {
        if (!file.exists()) return null
        return try {
            PersistedState.fromJson(Json.parse(file.readText(Charsets.UTF_8)) as Map<*, *>)
        } catch (e: Exception) {
            SdkLog.e("FounderData state file unreadable, starting empty")
            null
        }
    }

    fun save(state: PersistedState) {
        try {
            writeAtomically(file, Json.write(state.toJson()))
        } catch (e: Exception) {
            SdkLog.e("FounderData could not save its queue: ${e.message}")
        }
    }

    fun delete() {
        file.delete()
    }

    companion object {
        fun inDirectory(dir: File) = StateStore(File(dir, "state.json"))
    }
}

/**
 * The persistent install id, used only after consent: a random UUID v4 in `install_id` in the SDK's no-backup
 * folder. Without consent the SDK never reads or creates it.
 */
internal class InstallIdStore(private val dir: () -> File?) {
    private val lock = Any()
    private var cache: String? = null
    private var calls = 0

    /** How often this store touched the file system. Tests use it to prove the default mode never does. */
    val fileCalls: Int get() = synchronized(lock) { calls }

    /** The stored id if the device has one, otherwise stores [candidate] and returns it. */
    fun adopt(candidate: String): String = synchronized(lock) {
        cache?.let { return it }
        val id = stored() ?: (normalized(candidate) ?: candidate).also(::write)
        cache = id
        id
    }

    /** Forgets the cached id. Tests only. */
    fun forget() = synchronized(lock) { cache = null }

    /** The stored id, or null. Creates nothing. */
    fun read(): String? = synchronized(lock) { cache ?: stored()?.also { cache = it } }

    fun erase() {
        synchronized(lock) {
            cache = null
            val d = dir() ?: return
            calls++
            File(d, FILE).delete()
        }
    }

    private fun stored(): String? {
        val d = dir() ?: return null
        calls++
        val f = File(d, FILE)
        if (!f.exists()) return null
        return runCatching { normalized(f.readText(Charsets.UTF_8)) }.getOrNull()
    }

    private fun write(id: String) {
        val d = dir() ?: return
        calls++
        try {
            writeAtomically(File(d, FILE), id)
        } catch (e: Exception) {
            SdkLog.e("FounderData could not store the install id: ${e.message}")
        }
    }

    companion object {
        const val FILE = "install_id"

        /** Lowercase UUID with dashes, the form `obfuscatedAccountId` and the server use. */
        fun normalized(raw: String): String? = runCatching {
            val t = raw.trim()
            if (t.length != 36) return null
            UUID.fromString(t).toString().lowercase()
        }.getOrNull()
    }
}

/** android.util.Log, quiet where it is not available (plain JVM tests). */
internal object SdkLog {
    private const val TAG = "FounderData"

    fun d(message: String) = log { android.util.Log.d(TAG, message) }
    fun i(message: String) = log { android.util.Log.i(TAG, message) }
    fun e(message: String) = log { android.util.Log.e(TAG, message) }

    private inline fun log(block: () -> Unit) {
        try {
            block()
        } catch (_: Throwable) {
        }
    }
}
