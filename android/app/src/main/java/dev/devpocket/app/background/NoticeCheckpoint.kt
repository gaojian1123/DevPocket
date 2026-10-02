package dev.devpocket.app.background

import dev.devpocket.app.data.EventPage
import dev.devpocket.app.data.PendingRequest
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.WireJson
import dev.devpocket.app.data.text
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement

@Serializable
data class SessionNotice(val eventId: String, val kind: String)

@Serializable
data class NoticeCheckpoint(
    val cursor: Long = 0,
    val initialized: Boolean = false,
    val requests: Set<String> = emptySet(),
    val requestEventId: String? = null,
    val runtimeState: String? = null,
    val pending: SessionNotice? = null,
) {
    fun apply(scope: Scope, page: EventPage): NoticeCheckpoint {
        require(page.cursor >= 0 && page.events.all {
            it.hostId == scope.hostId && it.sessionId == scope.sessionId && it.cursor > 0 && it.cursor <= page.cursor
        }) { "中转返回了不属于此会话的事件或无效游标。" }
        require(page.events.zipWithNext().all { (a, b) -> a.cursor < b.cursor }) { "中转事件顺序无效。" }
        var next = if (page.reset) NoticeCheckpoint() else this
        for (event in page.events) {
            if (event.cursor <= next.cursor) continue
            when (event.kind) {
                "requests" -> {
                    val items = WireJson.decodeFromJsonElement<List<PendingRequest>>(event.data.getValue("items"))
                    val ids = items.map { "${it.type}:${it.requestId}" }.toSet()
                    val notice = when {
                        !next.initialized -> null
                        ids.any { it !in next.requests } -> SessionNotice(event.id, "attention")
                        ids.isEmpty() && next.pending?.kind == "attention" -> null
                        else -> next.pending
                    }
                    next = next.copy(requests = ids, requestEventId = event.id.takeIf { ids.isNotEmpty() }, pending = notice)
                }
                "runtime.state" -> {
                    val state = event.data.text("state")
                    val completed = next.initialized && state == "idle" &&
                        next.runtimeState in setOf("running", "waiting", "cancel_requested")
                    next = next.copy(runtimeState = state, pending =
                        if (completed && next.pending?.kind != "attention") SessionNotice(event.id, "status") else next.pending)
                }
            }
            next = next.copy(cursor = event.cursor)
        }
        return next.copy(cursor = maxOf(next.cursor, page.cursor))
    }

    fun caughtUp(): NoticeCheckpoint {
        if (initialized) return this
        return copy(initialized = true, pending = requestEventId?.let { SessionNotice(it, "attention") })
    }
}

interface NoticeCheckpointStore {
    suspend fun load(scope: Scope): NoticeCheckpoint
    suspend fun save(scope: Scope, checkpoint: NoticeCheckpoint)
    suspend fun remove(scope: Scope)
}
