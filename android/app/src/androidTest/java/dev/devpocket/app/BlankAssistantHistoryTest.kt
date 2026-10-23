package dev.devpocket.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.Account
import dev.devpocket.app.data.Capabilities
import dev.devpocket.app.data.Catalog
import dev.devpocket.app.data.Device
import dev.devpocket.app.data.EventPage
import dev.devpocket.app.data.Host
import dev.devpocket.app.data.LocalStore
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.SessionInfo
import dev.devpocket.app.data.Vault
import dev.devpocket.app.data.WireEvent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class BlankAssistantHistoryTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun cachedBlankMessagesStayStoredButDoNotRenderCopilotBubblesAfterRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account(UUID.randomUUID().toString(), "https://127.0.0.1:1",
            "dpd_" + "x".repeat(43), UUID.randomUUID().toString(), "Blank history fixture")
        val host = Host(UUID.randomUUID().toString(), "Offline fixture", false, 0)
        val session = SessionInfo(
            host.id, UUID.randomUUID().toString(), "fixture", "Fixture project", "Blank history fixture session",
            "test-fixture", "offline", "manual", "fixture-model", capabilities = Capabilities(),
            registeredAt = 0, online = false, pinned = false, archived = false, lastSeen = 0,
        )
        val scope = Scope(account.id, host.id, session.sessionId)
        fun event(cursor: Long, kind: String, data: JsonObject) =
            WireEvent("event-$cursor", "2026-10-10T04:00:00.000Z", kind, data, cursor, host.id, session.sessionId)
        val events = listOf(
            event(1, "assistant.message", buildJsonObject { put("messageId", "empty"); put("content", "") }),
            event(2, "assistant.message", buildJsonObject { put("messageId", "whitespace"); put("content", " \n\t") }),
            event(3, "tool.start", buildJsonObject { put("toolCallId", "tool-1"); put("name", "view"); put("text", "") }),
            event(4, "tool.output", buildJsonObject { put("toolCallId", "tool-1"); put("text", "Tool output"); put("complete", true) }),
            event(5, "assistant.message", buildJsonObject { put("messageId", "answer"); put("content", "Visible answer") }),
        )
        val vault = Vault(context)
        val oldAccounts = vault.accounts()
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            vault.saveAccounts(listOf(account))
            LocalStore(context).use {
                it.saveCatalog(account.id, Catalog(Device(account.deviceId, account.name), listOf(host), listOf(session), false, 1))
                it.applyPage(scope, EventPage(events, events.last().cursor))
            }
            context.getSharedPreferences("devpocket_settings", 0).edit().remove("last_scope").commit()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntil(20_000) { compose.onAllNodesWithText("\u77e5\u9053\u4e86").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("\u77e5\u9053\u4e86").performClick()
            compose.waitUntil(20_000) { compose.onAllNodesWithText(session.title).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(session.title).performClick()

            fun assertHistory() {
                compose.waitUntil(20_000) { compose.onAllNodesWithText("Visible answer").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Visible answer").assertIsDisplayed()
                compose.onAllNodesWithText("Copilot").assertCountEquals(1)
                compose.onNodeWithText("view").assertIsDisplayed()
                LocalStore(context).use { assertEquals(events, it.events(scope)) }
            }
            assertHistory()
            scenario.recreate()
            assertHistory()
        } finally {
            scenario?.close()
            vault.saveAccounts(oldAccounts)
            LocalStore(context).use { it.forgetAccount(account.id) }
            context.getSharedPreferences("devpocket_settings", 0).edit().remove("last_scope").commit()
        }
    }
}
