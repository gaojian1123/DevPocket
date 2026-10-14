package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.*
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class NativeFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun nativePairingFormUsesEditableComposeControlsWithoutAWebView() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("开始配对").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("开始配对").performClick()
        compose.onNodeWithTag("native_pair_form").assertIsDisplayed()
        compose.onNodeWithText("HTTPS 中转地址").performTextInput("https://relay.example.test")
        compose.onNodeWithText("一次性配对码").performTextInput("one-time-value")
        compose.onNodeWithText("设备名称").performTextReplacement("我的原生安卓")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("开始配对").assertIsDisplayed()
    }

    @Test fun keystoreCredentialRoundTripAndBackupDisabled() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = Vault(context)
        vault.put("instrumentation-test", "ephemeral-native-proof")
        assertEquals("ephemeral-native-proof", vault.get("instrumentation-test"))
        val raw = context.getSharedPreferences("devpocket_encrypted", 0).getString("instrumentation-test", null)
        assertNotNull(raw)
        assertFalse(raw!!.contains("ephemeral-native-proof"))
        vault.put("instrumentation-test", null)
        assertEquals(0, context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_ALLOW_BACKUP)
    }

    @Test fun questionSnapshotAndFullConfirmationSurviveDatabaseReopenAndSparseDeliveryReplay() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val scope = Scope(UUID.randomUUID().toString(), "history-host", "history-session")
        val request = PendingRequest("question", "question", "Question", "Complete question\nwith another line",
            choices = listOf("Phone", "Original"), supported = true)
        val pending = QuestionRecord("question-history", request, "pending")
        val command = Command(UUID.randomUUID().toString(), Action.Answer(request.requestId, "Phone"))
        val question = AnswerContext(pending.questionId, request, "2026-10-13T04:00:00.000Z", 1)
        val full = Receipt(command.commandId, "completed", buildJsonObject { put("resolved", true) })
        fun event(cursor: Long, kind: String, data: JsonObject) =
            WireEvent("history-$cursor", question.at, kind, data, cursor, scope.hostId, scope.sessionId)
        try {
            LocalStore(context).use { local ->
                local.applyPage(scope, EventPage(listOf(event(1, "question", WireJson.encodeToJsonElement(pending) as JsonObject)), 1))
                val draft = Draft("Unsent ordinary message", 3)
                local.saveDraft(scope, draft)
                val staged = local.stageAnswer(scope, command, question)
                assertEquals(staged, local.stageAnswer(scope, command, question))
                assertEquals(draft, local.draft(scope))
                assertThrows(IllegalArgumentException::class.java) {
                    local.stageAnswer(scope, command.copy(action = Action.Answer(request.requestId, "Original")), question)
                }
                assertThrows(IllegalArgumentException::class.java) {
                    local.stageAnswer(scope.copy(sessionId = "other"), command, question)
                }
            }
            LocalStore(context).use { local ->
                val staged = local.outbox(scope).single()
                assertEquals(command, staged.command)
                assertEquals(question, staged.question)
                assertEquals("sending", staged.status)
                assertNull(questionHistory(local.events(scope), local.outbox(scope), scope).single().record.answer)
                local.applyReceipt(scope, full)
                val delivery = event(2, "delivery", WireJson.encodeToJsonElement(Receipt(command.commandId, "completed")) as JsonObject)
                local.applyPage(scope, EventPage(listOf(delivery), 2))
                local.applyPage(scope, EventPage(listOf(delivery), 2))
            }
            LocalStore(context).use { local ->
                val saved = local.outbox(scope).single()
                assertEquals(full, saved.receipt)
                val history = timeline(local.events(scope), local.outbox(scope), scope).single().question!!
                assertEquals(request, history.record.request)
                assertEquals("confirmed", history.record.status)
                assertEquals("Phone", history.record.answer)
                assertTrue(history.blocksNewAnswer)
                assertTrue(local.outbox(scope.copy(sessionId = "other")).isEmpty())
            }
        } finally {
            LocalStore(context).use { local ->
                local.forgetAccount(scope.accountId)
                assertTrue(local.events(scope).isEmpty())
                assertTrue(local.outbox(scope).isEmpty())
            }
        }
    }
}
