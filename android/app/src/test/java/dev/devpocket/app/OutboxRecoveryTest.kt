package dev.devpocket.app

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import android.database.sqlite.SQLiteOpenHelper
import androidx.test.core.app.ApplicationProvider
import dev.devpocket.app.data.*
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = DevPocketApplication::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class OutboxRecoveryTest {
    @Test fun cacheUpgradePreservesOldDraftsAndReferencedRetriesRefuseAnOldClientDowngrade() {
        val context = ApplicationProvider.getApplicationContext<DevPocketApplication>()
        val scope = Scope(UUID.randomUUID().toString(), "host", "session")
        val legacyDraft = Draft("Keep the unsent question", 3)
        val legacyCommand = Command(UUID.randomUUID().toString(), Action.Message("Already staged"))
        val selection = ComponentSelection(ComponentReference("card", "a".repeat(64)), "Complete card")
        val referenced = legacyDraft.copy(revision = 4, componentReference = selection)
        val command = Command(UUID.randomUUID().toString(), Action.Message(referenced.text,
            componentReference = selection.reference))
        try {
            LocalStore(context).use { local ->
                local.saveDraft(scope, legacyDraft)
                local.saveOutbox(Outbox(scope, legacyCommand, "delivery_unknown", 1))
                local.writableDatabase.version = 1
            }
            LocalStore(context).use { local ->
                assertEquals(legacyDraft, local.draft(scope))
                assertEquals(legacyCommand, local.outbox(scope).single().command)
                assertEquals(2, local.readableDatabase.version)
                local.saveDraft(scope, referenced)
                local.stage(scope, referenced, command)
            }
            val older = object : SQLiteOpenHelper(context, "devpocket-cache.db", null, 1) {
                override fun onCreate(db: SQLiteDatabase) = error("The existing cache must not be recreated.")
                override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) =
                    error("This is a downgrade check.")
            }
            try { assertThrows(SQLiteException::class.java) { older.readableDatabase } }
            finally { older.close() }
            LocalStore(context).use { local ->
                val retained = local.outbox(scope).single { it.command.commandId == command.commandId }
                assertEquals(command, retained.command)
                assertEquals(selection, retained.componentReference)
                assertEquals("sending", retained.status)
                assertEquals(legacyCommand, local.outbox(scope).single { it.command != command }.command)
            }
        } finally { LocalStore(context).use { it.forgetAccount(scope.accountId) } }
    }

    @Test fun eventDisplayTruncationDoesNotReopenAnAlreadyAttemptedQuestion() {
        val context = ApplicationProvider.getApplicationContext<DevPocketApplication>()
        val scope = Scope(UUID.randomUUID().toString(), "host", "session")
        val request = PendingRequest("pending", "question", "Question", "Choose",
            choices = listOf("Phone", "Original"), supported = true)
        val pending = QuestionRecord("stable-question", request, "pending")
        val command = Command(UUID.randomUUID().toString(), Action.Answer(request.requestId, "Phone"))
        fun event(cursor: Long, kind: String, data: JsonObject) =
            WireEvent("event-$cursor", "2026-10-14T00:00:00.000Z", kind, data, cursor, scope.hostId, scope.sessionId)
        val first = event(1, "question", WireJson.encodeToJsonElement(pending) as JsonObject)
        try {
            LocalStore(context).use { local ->
                local.applyPage(scope, EventPage(listOf(first), 1))
                val staged = local.stageAnswer(scope, command, AnswerContext(pending.questionId, request, first.at, 1))
                local.transportFailure(staged, "delivery_unknown", "Awaiting the same operation")
                for (batch in (2L..85L).chunked(7)) {
                    val events = batch.map { cursor -> event(cursor, "assistant.message", buildJsonObject {
                        put("messageId", "message-$cursor"); put("content", "x".repeat(64000))
                    }) }
                    local.applyPage(scope, EventPage(events, batch.last()))
                }
                local.applyPage(scope, EventPage(listOf(event(86, "requests", buildJsonObject {
                    put("items", WireJson.encodeToJsonElement(listOf(request)))
                })), 86))
            }
            LocalStore(context).use { local ->
                val visible = local.events(scope)
                assertTrue("Exercise the actual display byte cutoff.", visible.first().cursor > 1)
                val history = questionHistory(visible, local.outbox(scope), scope, local.firstRetainedEventCursor(scope))
                val active = history.single { it.record.status == "pending" }
                assertTrue("A display cutoff cannot permit a new answer operation.", active.blocksNewAnswer)
                assertEquals(command, active.attempts.single().command)
                assertNull(active.record.answer)
                local.applyPage(scope, EventPage(listOf(event(100, "requests", buildJsonObject {
                    put("items", WireJson.encodeToJsonElement(emptyList<PendingRequest>()))
                })), 100, reset = true))
                assertTrue(questionHistory(local.events(scope), local.outbox(scope), scope,
                    local.firstRetainedEventCursor(scope)).isEmpty())
            }
        } finally { LocalStore(context).use { it.forgetAccount(scope.accountId) } }
    }

    @Test fun largeQuestionSnapshotsDoNotHideUnresolvedCommandsWithinTheRetainedHundredRows() {
        val context = ApplicationProvider.getApplicationContext<DevPocketApplication>()
        val scope = Scope(UUID.randomUUID().toString(), "host", "session")
        val message = Command(UUID.randomUUID().toString(), Action.Message("Unconfirmed message"))
        val answer = Command(UUID.randomUUID().toString(), Action.Answer("old-question", "Phone"))
        val request = PendingRequest("old-question", "question", "Question", "Pending question",
            choices = listOf("Phone", "Original"), supported = true)
        val answerContext = AnswerContext("old-history", request, "2026-10-14T00:00:00.000Z", 1)
        val largeRequest = request.copy(detail = "d".repeat(12000),
            choices = List(50) { index -> "$index-" + "c".repeat(990) }, allowFreeform = true)
        try {
            LocalStore(context).use { local ->
                local.saveOutbox(Outbox(scope, message, "sending", 1))
                val staged = local.stageAnswer(scope, answer, answerContext)
                local.saveOutbox(staged.copy(createdAt = 2, status = "delivery_unknown"))
                repeat(98) { index ->
                    val command = Command(UUID.randomUUID().toString(), Action.Answer("large-$index", "a".repeat(8000)))
                    val question = answerContext.copy(questionId = "large-history-$index",
                        request = largeRequest.copy(requestId = "large-$index"))
                    val row = local.stageAnswer(scope, command, question)
                    local.saveOutbox(row.copy(createdAt = index + 3L, status = "completed",
                        receipt = Receipt(command.commandId, "completed", buildJsonObject { put("resolved", true) })))
                }
                local.saveOutbox(Outbox(scope.copy(sessionId = "foreign"), Command(UUID.randomUUID().toString(),
                    Action.Message("Another scope")), "sending", 1000))
            }
            LocalStore(context).use { local ->
                val retained = local.outbox(scope)
                assertEquals("The display-size budget must not hide recoverable retained commands.", 100, retained.size)
                assertTrue(retained.sumOf { WireJson.encodeToString(it).length.toLong() } > 4L * 1024 * 1024)
                assertEquals(listOf(message, answer), retained.filter { it.status in setOf("sending", "delivery_unknown") }
                    .sortedBy { it.createdAt }.map { it.command })
                assertTrue(retained.all { it.scope == scope })
                assertEquals(answerContext, retained.single { it.command.commandId == answer.commandId }.question)
                local.applyReceipt(scope, Receipt(answer.commandId, "completed", buildJsonObject { put("resolved", true) }))
            }
            LocalStore(context).use { local ->
                val recovered = local.outbox(scope)
                assertEquals(100, recovered.size)
                val confirmed = recovered.single { it.command.commandId == answer.commandId }
                assertEquals(answer, confirmed.command)
                assertTrue(confirmed.hasConfirmedAnswer())
                assertEquals(message, recovered.single { it.status == "sending" }.command)
            }
        } finally { LocalStore(context).use { it.forgetAccount(scope.accountId) } }
    }
}
