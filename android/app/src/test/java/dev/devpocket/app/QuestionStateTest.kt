package dev.devpocket.app

import dev.devpocket.app.data.*
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class QuestionStateTest {
    private val scope = Scope("account", "host", "session")
    private val request = PendingRequest("question", "question", "Question", "Full question\nwith another line",
        choices = listOf("Phone", "Original"), supported = true)
    private val pending = QuestionRecord("question-history", request, "pending")
    private val command = Command("11111111-1111-4111-8111-111111111111", Action.Answer("question", "Phone"))
    private val context = AnswerContext(pending.questionId, request, "2026-10-13T04:00:00.000Z", 1)
    private fun entry(status: String = "sending", receipt: Receipt? = null) =
        Outbox(scope, command, status, 1, receipt = receipt, question = context)
    private fun event(cursor: Long, kind: String, data: JsonObject) =
        WireEvent("event-$cursor", context.at, kind, data, cursor, scope.hostId, scope.sessionId)
    private fun question(cursor: Long, value: QuestionRecord) = event(cursor, "question", WireJson.encodeToJsonElement(value) as JsonObject)
    private fun requests(cursor: Long, vararg items: PendingRequest) =
        event(cursor, "requests", buildJsonObject { put("items", WireJson.encodeToJsonElement(items.toList())) })
    private val full get() = Receipt(command.commandId, "completed", buildJsonObject { put("resolved", true) })

    @Test fun receiptSurvivesReplay() {
        assertEquals(full, retainReceiptEvidence(full, Receipt(command.commandId, "completed")))
        assertEquals(full, retainReceiptEvidence(Receipt(command.commandId, "completed"), full))
        val foreign = Receipt("another-command", "completed")
        assertEquals(foreign, retainReceiptEvidence(full, foreign))
        val failed = Receipt(command.commandId, "failed")
        assertEquals(failed, retainReceiptEvidence(full, failed))
    }

    @Test fun disappearanceIsNotProof() {
        val events = listOf(question(1, pending), requests(2, request), requests(3))
        for (status in listOf("sending", "dispatched", "admitted", "processing", "failed", "uncertain", "delivery_unknown", "completed")) {
            val attempt = entry(status, if (status == "completed") Receipt(command.commandId, "completed") else null)
            val history = questionHistory(events, listOf(attempt), scope).single()
            assertEquals(status, "unknown", history.record.status)
            assertNull(history.record.answer)
            assertTrue(history.blocksNewAnswer)
            assertNotEquals(status, "confirmed", answerAttemptStatus(attempt, history.record))
        }
    }

    @Test fun fullReceiptConfirmsOwnAnswer() {
        val events = listOf(question(1, pending), requests(2))
        val history = questionHistory(events, listOf(entry("completed", full)), scope).single()
        assertEquals("confirmed", history.record.status)
        assertEquals("Phone", history.record.answer)
        assertTrue(history.blocksNewAnswer)
        assertEquals("confirmed", answerAttemptStatus(history.attempts.single(), history.record))
        for (receipt in listOf(
            full.copy(commandId = "wrong-command"),
            full.copy(result = buildJsonObject { put("resolved", "true") }),
            full.copy(result = buildJsonObject { put("resolved", false) }),
        )) assertEquals("unknown", questionHistory(events, listOf(entry("completed", receipt)), scope).single().record.status)
    }

    @Test fun anotherClientIsNotOurAnswer() {
        val other = pending.copy(status = "confirmed", answer = "Original", commandId = "22222222-2222-4222-8222-222222222222")
        val history = questionHistory(listOf(question(1, pending), question(2, other), requests(3)), listOf(entry("failed")), scope).single()
        assertEquals("Original", history.record.answer)
        assertEquals("failed", answerAttemptStatus(history.attempts.single(), history.record))
        assertTrue(history.blocksNewAnswer)
    }

    @Test fun delayedProofWinsOverUnknown() {
        val confirmed = pending.copy(status = "confirmed", answer = "[REDACTED]", commandId = command.commandId)
        val events = listOf(question(1, pending), question(2, pending.copy(status = "unknown")), requests(3),
            question(4, confirmed), question(5, pending.copy(status = "unknown")), question(1, pending))
        val history = questionHistory(events, listOf(entry("uncertain")), scope).single()
        assertEquals("[REDACTED]", history.record.answer)
        assertEquals("confirmed", answerAttemptStatus(history.attempts.single(), history.record))
        assertEquals(1L, history.cursor)
    }

    @Test fun confirmedRedactionMarkerKeepsRuntimeProofWithoutRestoringRawControlText() {
        val raw = command.copy(action = Action.Answer(request.requestId, "\u001b[31m"))
        val attempt = entry("completed", full).copy(command = raw)
        val confirmed = pending.copy(status = "confirmed", answer = "[REDACTED]", commandId = command.commandId)
        val events = listOf(question(1, pending), requests(2), question(3, confirmed))
        val history = questionHistory(events, listOf(attempt), scope).single()
        assertEquals("confirmed", history.record.status)
        assertEquals("[REDACTED]", history.record.answer)
        assertTrue(history.blocksNewAnswer)
        assertEquals("confirmed", answerAttemptStatus(attempt, history.record))
    }

    @Test fun confirmedReceiptFallbackNeverDisplaysRawControlContent() {
        val events = listOf(question(1, pending), requests(2))
        for ((raw, safe) in listOf(
            "\u001b[31m" to "[REDACTED]",
            " \n\t\u0000\u001b[31m " to "[REDACTED]",
            "  visible\u001b[31m answer\n" to "  visible answer\n",
            "label ghp_secret" to "label [REDACTED]",
            "Normal visible answer" to "Normal visible answer",
        )) {
            val attempt = entry("completed", full).copy(command = command.copy(action = Action.Answer(request.requestId, raw)))
            val history = questionHistory(events, listOf(attempt), scope).single()
            assertEquals("confirmed", history.record.status)
            assertEquals(safe, history.record.answer)
            assertEquals(raw, (history.attempts.single().command.action as Action.Answer).answer)
            val uncertain = questionHistory(events, listOf(attempt.copy(status = "uncertain", receipt = null)), scope).single()
            assertEquals("unknown", uncertain.record.status)
            assertNull(uncertain.record.answer)
        }
    }

    @Test fun receiptFallbackTruncationUsesTheOriginalClientAndKeepsItsWireLimit() {
        val safe = answerHistoryText("ghp_x ".repeat(1200))
        assertEquals(8000, safe.length)
        assertTrue(safe.endsWith("\n[truncated; see original client]"))
        assertFalse(safe.contains("ghp_x"))
    }

    @Test fun scopesAndReusedIdsStaySeparate() {
        val replacement = pending.copy(questionId = "replacement", request = request.copy(detail = "Different question"))
        val events = listOf(question(1, pending), question(2, pending.copy(status = "unknown")),
            question(3, replacement), requests(4, replacement.request))
        val histories = questionHistory(events, listOf(entry("failed")), scope)
        assertEquals(2, histories.size)
        assertEquals(1, histories.first().attempts.size)
        assertTrue(histories.last().attempts.isEmpty())
        assertFalse(histories.last().blocksNewAnswer)
        assertTrue(timeline(events, listOf(entry()), scope.copy(sessionId = "another")).isEmpty())
        for (foreign in listOf(scope.copy(accountId = "other"), scope.copy(hostId = "other"), scope.copy(sessionId = "other"))) {
            assertTrue(questionHistory(events, listOf(entry().copy(scope = foreign)), scope).all { it.attempts.isEmpty() })
        }
    }

    @Test fun legacyHistoryNeverInventsAnswers() {
        val events = listOf(requests(1, request), requests(2, request), requests(3))
        val history = timeline(events).single().question!!
        assertEquals(request, history.record.request)
        assertEquals("unknown", history.record.status)
        assertNull(history.record.answer)
        val noEvidence = """{"scope":{"accountId":"account","hostId":"host","sessionId":"session"},"command":{"commandId":"legacy","action":{"type":"answer","requestId":"question","answer":"Phone"}},"status":"completed","createdAt":1}"""
        val old = WireJson.decodeFromString<Outbox>(noEvidence)
        assertNull(old.question)
        assertEquals("unknown", questionHistory(events, listOf(old), scope).single().record.status)
    }

    @Test fun retainedCompletionIsSelfContained() {
        val confirmed = pending.copy(status = "confirmed", answer = "Phone", commandId = command.commandId)
        assertEquals(request, questionHistory(listOf(question(6001, confirmed))).single().record.request)
        val reset = listOf(event(7000, "requests", buildJsonObject { put("items", buildJsonArray {}) }))
        assertTrue(questionHistory(reset, listOf(entry("completed", full)), scope).isEmpty())
    }
}
