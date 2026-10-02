@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.devpocket.app

import dev.devpocket.app.background.*
import dev.devpocket.app.data.*
import java.io.IOException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class BackgroundMonitorTest {
    private val account = Account("account", "https://relay.example", "fixture-only", "device", "Test")
    private val a = Scope(account.id, "host-a", "session-a")
    private val b = Scope(account.id, "host-b", "session-b")

    @Test fun watchesEveryAuthorizedUnarchivedSessionIncludingOfflineSessions() = runTest {
        val source = FakeSource(catalog(listOf(info(a), info(b).copy(online = false),
            info(a.copy(sessionId = "archived")).copy(archived = true), info(a.copy(hostId = "unauthorized")))))
        val monitor = BackgroundMonitor({ source }, MemoryStore(), { _, _ -> }, {})
        val job = backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        assertEquals(setOf(a, b), source.opened.toSet())
        assertEquals(2, monitor.status.value.connected)
        job.cancel()
        runCurrent()
        assertEquals(setOf(a, b), source.closed.toSet())
    }

    @Test fun archivedRemovedAndNewSessionsAreReconciledFromTheFreshCatalog() = runTest {
        val source = FakeSource(catalog(listOf(info(a), info(b))))
        val store = MemoryStore()
        val dismissed = mutableListOf<Scope>()
        val monitor = BackgroundMonitor({ source }, store, { _, _ -> }, dismissed::add)
        backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        val added = a.copy(sessionId = "new-session")
        source.current = catalog(listOf(info(a).copy(archived = true), info(added)))
        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(setOf(a, b), source.closed.toSet())
        assertEquals(setOf(a, b), dismissed.toSet())
        assertEquals(setOf(added), monitor.status.value.sessions.keys)
        assertFalse(store.values.containsKey(a))
        assertFalse(store.values.containsKey(b))
    }

    @Test fun reconnectCatchesUpFromItsOwnCursorAndDoesNotReplayTheNotice() = runTest {
        val source = FakeSource(catalog(listOf(info(a))))
        val store = MemoryStore()
        source.pages[a] = ArrayDeque(listOf(page(state(a, 1, "idle"))))
        val notices = mutableListOf<SessionNotice>()
        val monitor = BackgroundMonitor({ source }, store, { _, notice -> notices.add(notice) }, {})
        backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        assertTrue(notices.isEmpty())
        source.frames.getValue(a).send(Result.success(page(state(a, 2, "running"))))
        source.frames.getValue(a).send(Result.failure(IOException("connection lost")))
        source.pages[a] = ArrayDeque(listOf(page(requests(a, 3, "request"), hasMore = true),
            page(requests(a, 4), state(a, 5, "idle"))))
        runCurrent()
        assertEquals(0, monitor.status.value.connected)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(SessionNotice("event-5", "status")), notices)
        assertEquals(listOf(0L, 2L, 3L), source.reads.map { it.second })
        source.frames.getValue(a).send(Result.success(page(state(a, 5, "idle"))))
        runCurrent()
        assertEquals(1, notices.size)
        assertEquals(5L, store.values.getValue(a).cursor)
    }

    @Test fun noticeRemainsPendingWhenPostingFailsAndIsRetriedWithoutLosingTheCursor() = runTest {
        val store = MemoryStore()
        val source = FakeSource(catalog(listOf(info(a))))
        source.pages[a] = ArrayDeque(listOf(page(requests(a, 1, "pending"))))
        var fail = true
        val notices = mutableListOf<SessionNotice>()
        val monitor = BackgroundMonitor({ source }, store, { _, notice ->
            if (fail) throw IOException("notification unavailable")
            notices.add(notice)
        }, {})
        backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        assertEquals(1L, store.values.getValue(a).cursor)
        assertNotNull(store.values.getValue(a).pending)
        assertTrue(monitor.status.value.errors.contains("notification unavailable"))
        fail = false
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(SessionNotice("event-1", "attention")), notices)
        assertNull(store.values.getValue(a).pending)
    }

    @Test fun revokedScopeStopsRetryingButOtherHostContinuesAndRemovalsClearNotices() = runTest {
        val source = FakeSource(catalog(listOf(info(a), info(b))))
        val dismissed = mutableListOf<Scope>()
        val store = MemoryStore()
        val monitor = BackgroundMonitor({ source }, store, { _, _ -> }, dismissed::add)
        backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        source.frames.getValue(a).send(Result.failure(ApiFailure(403, WireError("FORBIDDEN", "revoked"))))
        runCurrent()
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(1, source.opened.count { it == a })
        assertEquals(1, monitor.status.value.connected)
        assertTrue(dismissed.contains(a))
        assertFalse(store.values.containsKey(a))
        assertNotNull(monitor.status.value.sessions.getValue(a).error)
    }

    @Test fun relayRevocationCancelsAllItsSubscriptionsWithoutAffectingAnotherRelay() = runTest {
        val other = account.copy(id = "other")
        val otherScope = a.copy(accountId = other.id)
        val source = FakeSource(catalog(listOf(info(a), info(b))))
        val otherSource = FakeSource(catalog(listOf(info(otherScope))))
        val monitor = BackgroundMonitor({ if (it.id == account.id) source else otherSource }, MemoryStore(), { _, _ -> }, {})
        backgroundScope.launch { monitor.run(listOf(account, other)) }
        runCurrent()
        source.catalogFailure = ApiFailure(401, WireError("UNAUTHORIZED", "revoked"))
        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(setOf(a, b), source.closed.toSet())
        assertEquals(setOf(otherScope), monitor.status.value.sessions.keys)
        assertNotNull(monitor.status.value.relays[account.id])
        assertEquals(1, monitor.status.value.connected)
    }

    @Test fun cancellingTheMonitorCancelsAnInFlightReplayAndNeverPostsALateNotice() = runTest {
        val source = FakeSource(catalog(listOf(info(a))))
        val store = MemoryStore()
        var saved = false
        val blocked = Channel<Unit>()
        val checkpointStore = object : NoticeCheckpointStore by store {
            override suspend fun save(scope: Scope, checkpoint: NoticeCheckpoint) {
                saved = true
                blocked.receive()
                store.save(scope, checkpoint)
            }
        }
        var notified = false
        val monitor = BackgroundMonitor({ source }, checkpointStore, { _, _ -> notified = true }, {})
        val job = backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        assertTrue(saved)
        job.cancel()
        runCurrent()
        assertFalse(notified)
        assertTrue(store.values.isEmpty())
        assertTrue(source.opened.isEmpty())
    }

    @Test fun anotherSessionsEventsStayVisibleAsErrorsWithoutNotifying() = runTest {
        val source = FakeSource(catalog(listOf(info(a))))
        source.pages[a] = ArrayDeque(listOf(page(requests(b, 1, "secret"))))
        var notified = false
        val monitor = BackgroundMonitor({ source }, MemoryStore(), { _, _ -> notified = true }, {})
        backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        assertFalse(notified)
        assertTrue(monitor.status.value.errors.isNotEmpty())
        assertTrue(source.opened.isEmpty())
    }

    @Test fun storageReadFailureIsVisibleAndDoesNotOpenAnUncheckpointedStream() = runTest {
        val source = FakeSource(catalog(listOf(info(a))))
        val store = object : NoticeCheckpointStore by MemoryStore() {
            override suspend fun load(scope: Scope): NoticeCheckpoint = throw IOException("storage unavailable")
        }
        var notified = false
        val monitor = BackgroundMonitor({ source }, store, { _, _ -> notified = true }, {})
        backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        assertFalse(notified)
        assertTrue(source.opened.isEmpty())
        assertEquals(listOf("storage unavailable"), monitor.status.value.errors)
    }

    @Test fun failedCheckpointCleanupDoesNotKeepAnArchivedSessionConnectedAndIsRetried() = runTest {
        val source = FakeSource(catalog(listOf(info(a))))
        val memory = MemoryStore()
        var failRemoval = true
        val store = object : NoticeCheckpointStore by memory {
            override suspend fun remove(scope: Scope) {
                if (failRemoval) throw IOException("cannot clear checkpoint")
                memory.remove(scope)
            }
        }
        val dismissed = mutableListOf<Scope>()
        val monitor = BackgroundMonitor({ source }, store, { _, _ -> }, dismissed::add)
        backgroundScope.launch { monitor.run(listOf(account)) }
        runCurrent()
        source.current = catalog(listOf(info(a).copy(archived = true)))
        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(0, monitor.status.value.connected)
        assertEquals(listOf(a), source.closed)
        assertTrue(dismissed.contains(a))
        assertEquals(listOf("cannot clear checkpoint"), monitor.status.value.errors)
        failRemoval = false
        advanceTimeBy(15_000)
        runCurrent()
        assertTrue(monitor.status.value.errors.isEmpty())
        assertFalse(memory.values.containsKey(a))
    }

    private fun info(scope: Scope) = SessionInfo(scope.hostId, scope.sessionId, "project", "Project", "Session",
        "1.0.90-0", "idle", "manual", "model", capabilities = Capabilities(), registeredAt = 1,
        online = true, pinned = false, archived = false, lastSeen = 1)
    private fun catalog(sessions: List<SessionInfo>) = Catalog(Device("device", "Test"),
        listOf(Host(a.hostId, "A", true, 1), Host(b.hostId, "B", true, 1)), sessions, false, 1)
    private fun state(scope: Scope, cursor: Long, state: String) = event(scope, cursor, "runtime.state", """{"state":"$state"}""")
    private fun requests(scope: Scope, cursor: Long, vararg ids: String) = event(scope, cursor, "requests",
        """{"items":[${ids.joinToString { """{"requestId":"$it","type":"question","title":"private","detail":"private","supported":true}""" }}]}""")
    private fun event(scope: Scope, cursor: Long, kind: String, body: String) = WireEvent("event-$cursor",
        "2026-10-02T00:00:00Z", kind, WireJson.parseToJsonElement(body).jsonObject, cursor, scope.hostId, scope.sessionId)
    private fun page(vararg events: WireEvent, hasMore: Boolean = false) =
        EventPage(events.toList(), events.last().cursor, hasMore)

    private class MemoryStore : NoticeCheckpointStore {
        val values = mutableMapOf<Scope, NoticeCheckpoint>()
        override suspend fun load(scope: Scope) = values[scope] ?: NoticeCheckpoint()
        override suspend fun save(scope: Scope, checkpoint: NoticeCheckpoint) { values[scope] = checkpoint }
        override suspend fun remove(scope: Scope) { values.remove(scope) }
    }

    private class FakeSource(var current: Catalog) : SessionEventSource {
        val pages = mutableMapOf<Scope, ArrayDeque<EventPage>>()
        val frames = mutableMapOf<Scope, Channel<Result<EventPage>>>()
        val opened = mutableListOf<Scope>()
        val closed = mutableListOf<Scope>()
        val reads = mutableListOf<Pair<Scope, Long>>()
        var catalogFailure: Exception? = null
        override suspend fun catalog(): Catalog {
            catalogFailure?.let { throw it }
            return current
        }
        override suspend fun events(scope: Scope, after: Long): EventPage {
            reads.add(scope to after)
            return pages[scope]?.removeFirstOrNull() ?: EventPage(emptyList(), after)
        }
        override fun stream(scope: Scope, after: Long, onOpen: () -> Unit): Flow<EventPage> = flow {
            opened.add(scope)
            onOpen()
            try {
                val channel = frames.getOrPut(scope) { Channel(Channel.UNLIMITED) }
                for (result in channel) emit(result.getOrThrow())
            } finally { closed.add(scope) }
        }
    }
}
