package com.founderdata

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Without consent the SDK stores nothing on the device (EU ePrivacy rules). With consent it keeps the install id and
 * the queue in its no-backup folder, and withdrawing consent deletes both.
 */
class ConsentTest {
    @Test fun memoryModeWritesNoFile() = runBlocking {
        val h = Harness(persistent = false)
        h.core.record(Core.Action.Screen("Home"))
        h.core.record(Core.Action.Goal("signup", mapOf("plan" to "pro")))
        h.core.appEnteredBackground()
        h.core.saveNow()
        h.transport.script(-1)
        h.core.flush(ignoreBackoff = true)
        assertTrue(h.queued.isNotEmpty())
        assertFalse(h.directory.exists())
        assertFalse(h.core.isPersistent)
    }

    @Test fun consentKeepsTheCurrentIdsAndStartsSaving() {
        val h = Harness(persistent = false)
        try {
            h.core.record(Core.Action.Screen("Home"))
            val sid = h.core.snapshot.session.sessionId!!
            val store = StateStore(h.stateFile)
            h.core.enablePersistence(store, LAUNCH_ID)
            h.core.record(Core.Action.Screen("Settings"))
            h.core.saveNow()
            assertEquals(sid, h.core.snapshot.session.sessionId)
            assertEquals(setOf(sid), h.queued.map { it.sid }.toSet())
            assertEquals(h.core.snapshot.queue.count, store.load()?.queue?.count)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun consentWithAStoredInstallIdContinuesUnderItInANewSession() {
        val h = Harness(persistent = false)
        try {
            h.core.record(Core.Action.Screen("Home"))
            val firstSid = h.core.snapshot.session.sessionId
            val stored = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
            h.core.enablePersistence(StateStore(h.stateFile), stored)
            h.core.record(Core.Action.Screen("Settings"))
            val items = h.core.snapshot.queue.items
            assertEquals(stored, h.core.installId)
            assertEquals(stored, items.last().vid)
            assertNotEquals(firstSid, items.last().event.sid)
            assertEquals(LAUNCH_ID, items.first().vid)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun withdrawingConsentDeletesTheFileAndChangesTheId() {
        val h = Harness()
        try {
            h.core.record(Core.Action.Screen("Home"))
            h.core.saveNow()
            assertTrue(h.stateFile.exists())
            h.core.disablePersistence("11111111-2222-4333-8444-555555555555")
            h.core.record(Core.Action.Screen("Settings"))
            h.core.saveNow()
            assertFalse(h.stateFile.exists())
            assertEquals("11111111-2222-4333-8444-555555555555", h.core.snapshot.queue.items.last().vid)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun eraseRemovesTheFolder() {
        val base = Files.createTempDirectory("founderdata-tests").toFile()
        try {
            StateStore.inDirectory(StorageDir.under(base)).save(PersistedState())
            assertTrue(File(base, "founderdata/state.json").exists())
            StorageDir.eraseAll(base)
            assertFalse(File(base, "founderdata").exists())
        } finally {
            base.deleteRecursively()
        }
    }

    @Test fun installIdStoreAdoptsOnceAndErases() {
        val base = Files.createTempDirectory("founderdata-tests").toFile()
        try {
            val store = InstallIdStore { base }
            assertEquals(null, store.read())
            assertEquals(LAUNCH_ID, store.adopt(LAUNCH_ID.uppercase()))
            assertEquals(LAUNCH_ID, File(base, InstallIdStore.FILE).readText())
            val again = InstallIdStore { base }
            assertEquals("the stored id wins", LAUNCH_ID, again.adopt("11111111-2222-4333-8444-555555555555"))
            again.erase()
            assertFalse(File(base, InstallIdStore.FILE).exists())
        } finally {
            base.deleteRecursively()
        }
    }
}
