package dev.devpocket.app

import dev.devpocket.app.background.NoticeCheckpoint
import dev.devpocket.app.background.SessionNotice
import dev.devpocket.app.data.EventPage
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.WireEvent
import dev.devpocket.app.data.WireJson
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class NoticeCheckpointTest {
    private val scope = Scope("account", "host", "session")

    @Test fun firstHistoryImportDoesNotNotifyForOldCompletionsOrResolvedRequests() {
        val first = NoticeCheckpoint().apply(scope, page(
            state(1, "running"), requests(2, "old"), state(3, "idle"), hasMore = true))
        assertFalse(first.initialized)
        assertNull(first.pending)
        val ready = first.apply(scope, page(requests(4))).caughtUp()
        assertTrue(ready.initialized)
        assertNull(ready.pending)
    }

    @Test fun firstImportAlertsOnlyForTheRequestStillPendingAtTheEndOfPagination() {
        val first = NoticeCheckpoint().apply(scope, page(requests(1, "old"), hasMore = true))
        val ready = first.apply(scope, page(requests(2), requests(3, "current"))).caughtUp()
        assertEquals(SessionNotice("event-3", "attention"), ready.pending)
        assertEquals(setOf("permission:current"), ready.requests)
    }

    @Test fun replayAndRepeatedRequestSnapshotsDoNotNotifyAgain() {
        val ready = NoticeCheckpoint(initialized = true).apply(scope, page(requests(1, "current")))
        val delivered = ready.copy(pending = null)
        assertNull(delivered.apply(scope, page(requests(1, "current"))).pending)
        assertNull(delivered.apply(scope, page(requests(2, "current"))).pending)
        assertEquals("event-3", delivered.apply(scope, page(requests(3, "current", "new"))).pending?.eventId)
    }

    @Test fun reconnectCoalescesCompletionsAndDiscardsRequestsResolvedDuringTheGap() {
        val ready = NoticeCheckpoint(initialized = true, runtimeState = "running")
        val pending = ready.apply(scope, page(requests(1, "request"), hasMore = true))
        val caughtUp = pending.apply(scope, page(requests(2), state(3, "idle"))).caughtUp()
        assertEquals(SessionNotice("event-3", "status"), caughtUp.pending)
    }

    @Test fun idleIsNotTreatedAsTaskSuccessOrRepeatedCompletion() {
        val initial = NoticeCheckpoint(initialized = true).apply(scope, page(state(1, "idle")))
        assertNull(initial.pending)
        val running = initial.apply(scope, page(state(2, "running")))
        val idle = running.apply(scope, page(state(3, "idle")))
        assertEquals(SessionNotice("event-3", "status"), idle.pending)
        assertNull(idle.copy(pending = null).apply(scope, page(state(4, "idle"))).pending)
        assertNull(NoticeCheckpoint(initialized = true, runtimeState = "offline").apply(scope, page(state(1, "idle"))).pending)
    }

    @Test fun retentionResetRebaselinesWithoutReplayingOldCompletions() {
        val previous = NoticeCheckpoint(cursor = 100, initialized = true, runtimeState = "running",
            pending = SessionNotice("old", "status"))
        val reset = previous.apply(scope, page(state(1, "running"), state(2, "idle")).copy(reset = true)).caughtUp()
        assertEquals(2L, reset.cursor)
        assertNull(reset.pending)
    }

    @Test fun checkpointPersistsOnlyRoutingAndDecisionIdentifiersNotContent() {
        val checkpoint = NoticeCheckpoint(initialized = true).apply(scope, page(requests(1, "request")))
        val encoded = WireJson.encodeToString(checkpoint)
        assertFalse(encoded.contains("sensitive-title"))
        assertFalse(encoded.contains("sensitive-detail"))
        assertEquals(checkpoint, WireJson.decodeFromString<NoticeCheckpoint>(encoded))
        assertEquals(SessionNotice("event-1", "attention"), checkpoint.pending)
    }

    @Test fun sessionMismatchInvalidCursorAndOutOfOrderFramesFailClosed() {
        assertThrows(IllegalArgumentException::class.java) {
            NoticeCheckpoint().apply(scope, page(state(1, "idle").copy(hostId = "other-host")))
        }
        assertThrows(IllegalArgumentException::class.java) {
            NoticeCheckpoint().apply(scope, page(state(1, "idle")).copy(cursor = 0))
        }
        assertThrows(IllegalArgumentException::class.java) {
            NoticeCheckpoint().apply(scope, page(state(2, "running"), state(1, "idle")).copy(cursor = 2))
        }
    }

    @Test fun bootstrapCanResumeAfterProcessLossHalfwayThroughPagination() {
        val partial = NoticeCheckpoint().apply(scope, page(state(1, "running"), requests(2, "old"), hasMore = true))
        val restored = WireJson.decodeFromString<NoticeCheckpoint>(WireJson.encodeToString(partial))
        val ready = restored.apply(scope, page(requests(3), state(4, "idle"))).caughtUp()
        assertNull(ready.pending)
        assertTrue(ready.initialized)
    }

    private fun requests(cursor: Long, vararg ids: String): WireEvent = event(cursor, "requests",
        """{"items":[${ids.joinToString { """{"requestId":"$it","type":"permission","title":"sensitive-title","detail":"sensitive-detail","supported":true}""" }}]}""")
    private fun state(cursor: Long, state: String) = event(cursor, "runtime.state", """{"state":"$state"}""")
    private fun event(cursor: Long, kind: String, data: String) =
        WireEvent("event-$cursor", "2026-10-02T00:00:00Z", kind, WireJson.parseToJsonElement(data).jsonObject,
            cursor, scope.hostId, scope.sessionId)
    private fun page(vararg events: WireEvent, hasMore: Boolean = false) =
        EventPage(events.toList(), events.lastOrNull()?.cursor ?: 0, hasMore)
}
