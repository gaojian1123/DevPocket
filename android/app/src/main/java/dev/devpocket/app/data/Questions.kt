package dev.devpocket.app.data

import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

private val answerOsc = Regex("\u001b\\][^\u0007]*(?:\u0007|\u001b\\\\)")
private val answerCsi = Regex("\u001b\\[[0-?]*[ -/]*[@-~]")
private val answerControls = Regex("[\\x00-\\x08\\x0b-\\x1f\\x7f]")
private val answerTokens = Regex("(?:github_pat_|gh[pousr]_|dp[hdp]_)[A-Za-z0-9_]*")
private val answerBearer = Regex("(Bearer\\s+)[A-Za-z0-9._~+/-]+", RegexOption.IGNORE_CASE)
private val answerSecrets = Regex("""((?:api[_-]?key|password|secret|access[_-]?token|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+""",
    RegexOption.IGNORE_CASE)

// Receipt-only recovery uses the same safe projection as the bridge, without changing the stored command.
fun answerHistoryText(value: String): String {
    val clean = value.replace(answerOsc, "").replace(answerCsi, "").replace(answerControls, "")
        .replace(answerTokens, "[REDACTED]").replace(answerBearer, "\$1[REDACTED]")
        .replace(answerSecrets, "\$1[REDACTED]")
    if (clean.isBlank()) return "[REDACTED]"
    val suffix = "\n[truncated; see original client]"
    return if (clean.length <= 8000) clean else clean.take(8000 - suffix.length) + suffix
}

data class QuestionHistory(
    val record: QuestionRecord, val at: String, val cursor: Long,
    val attempts: List<Outbox> = emptyList(),
) {
    val blocksNewAnswer: Boolean get() = record.status != "pending" ||
        attempts.any { answerAttemptStatus(it, record) !in setOf("failed", "cancelled") }
}

fun PendingRequest.sameQuestion(other: PendingRequest): Boolean =
    copy(supported = false) == other.copy(supported = false)

fun Outbox.hasConfirmedAnswer(): Boolean = command.action is Action.Answer &&
    receipt?.let { it.commandId == command.commandId && it.status == "completed" &&
        it.result?.get("resolved") == JsonPrimitive(true) } == true

fun answerAttemptStatus(entry: Outbox, record: QuestionRecord): String = when {
    record.status == "confirmed" && record.commandId == entry.command.commandId -> "confirmed"
    entry.hasConfirmedAnswer() -> "confirmed"
    entry.status in setOf("failed", "cancelled") -> entry.status
    entry.status in setOf("uncertain", "delivery_unknown") -> "uncertain"
    entry.status == "sending" -> "sending"
    else -> "unconfirmed"
}

fun questionHistory(events: List<WireEvent>, outbox: List<Outbox> = emptyList(), scope: Scope? = null): List<QuestionHistory> {
    val records = linkedMapOf<String, QuestionHistory>()
    val active = mutableMapOf<String, String>()
    val aliases = mutableMapOf<String, String>()
    val scopedEvents = (if (scope == null) events else events.filter {
        it.hostId == scope.hostId && it.sessionId == scope.sessionId
    }).sortedBy { it.cursor }
    fun close(id: String) {
        records[id]?.let { if (it.record.status == "pending") records[id] = it.copy(record = it.record.copy(status = "unknown")) }
    }
    for (event in scopedEvents) {
        when (event.kind) {
            "question" -> {
                val incoming = runCatching { WireJson.decodeFromJsonElement<QuestionRecord>(event.data) }.getOrNull() ?: continue
                val requestId = incoming.request.requestId
                val activeId = active[requestId]
                val legacyId = activeId?.takeIf {
                    !records.containsKey(incoming.questionId) && it.startsWith("legacy:") &&
                        records[it]?.record?.request?.sameQuestion(incoming.request) == true
                }
                val previous = records[incoming.questionId] ?: legacyId?.let { records.remove(it) }
                if (legacyId != null) aliases[legacyId] = incoming.questionId
                val record = when {
                    previous?.record?.status == "confirmed" -> previous.record
                    previous?.record?.status == "unknown" && incoming.status == "pending" -> previous.record
                    else -> incoming
                }
                records[incoming.questionId] = QuestionHistory(record, previous?.at ?: event.at, previous?.cursor ?: event.cursor)
                if (record.status == "pending") {
                    if (activeId != null && activeId != incoming.questionId && activeId != legacyId) close(activeId)
                    active[requestId] = incoming.questionId
                } else if (activeId == incoming.questionId || activeId == legacyId) active.remove(requestId)
            }
            "requests" -> {
                val requests = runCatching {
                    WireJson.decodeFromJsonElement<List<PendingRequest>>(event.data.getValue("items"))
                }.getOrNull()?.filter { it.type == "question" } ?: continue
                for ((requestId, id) in active.toMap()) {
                    if (requests.none { it.requestId == requestId && it.sameQuestion(records.getValue(id).record.request) }) {
                        close(id)
                        active.remove(requestId)
                    }
                }
                for (request in requests) {
                    if (active.containsKey(request.requestId)) continue
                    val id = "legacy:" + UUID.nameUUIDFromBytes("${event.id}\u0000${request.requestId}".toByteArray(Charsets.UTF_8))
                    records[id] = QuestionHistory(QuestionRecord(id, request, "pending"), event.at, event.cursor)
                    active[request.requestId] = id
                }
            }
        }
    }
    for (entry in outbox.filter { scope != null && it.scope == scope }.sortedBy { it.createdAt }) {
        val answer = entry.command.action as? Action.Answer ?: continue
        val context = entry.question ?: continue
        if (context.request.type != "question" || context.request.requestId != answer.requestId) continue
        val id = aliases[context.questionId] ?: records.values.find {
            it.record.status == "confirmed" && it.record.commandId == entry.command.commandId
        }?.record?.questionId ?: context.questionId
        var previous = records[id]
        if (previous == null) {
            if (context.cursor > 0 && (scopedEvents.isEmpty() || context.cursor < scopedEvents.first().cursor)) continue
            previous = QuestionHistory(QuestionRecord(id, context.request, "unknown"), context.at, context.cursor)
        }
        if (!previous.record.request.sameQuestion(context.request)) continue
        val record = if (entry.hasConfirmedAnswer() && previous.record.status != "confirmed")
            previous.record.copy(status = "confirmed", answer = answerHistoryText(answer.answer), commandId = entry.command.commandId)
        else previous.record
        records[id] = previous.copy(record = record, attempts = previous.attempts + entry)
    }
    return records.values.toList()
}
