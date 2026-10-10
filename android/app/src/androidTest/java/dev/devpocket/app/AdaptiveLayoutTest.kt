package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class AdaptiveLayoutTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun visibleErrorAllowsSessionSelectionAndPreservesDraftAcrossWindowAndActivityChanges() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account(UUID.randomUUID().toString(), "https://127.0.0.1:1",
            "dpd_" + "x".repeat(43), UUID.randomUUID().toString(), "Offline layout fixture")
        val host = Host(UUID.randomUUID().toString(), "隔离布局测试电脑", false, 0)
        val session = SessionInfo(host.id, UUID.randomUUID().toString(), "fixture", "大字体与窗口适配",
            "仅缓存的原生布局测试会话", "test-fixture", "offline", "manual", "offline-fixture",
            capabilities = Capabilities(), registeredAt = 0, online = false, pinned = false, archived = false, lastSeen = 0)
        val oldAccounts = Vault(context).accounts()
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            Vault(context).saveAccounts(listOf(account))
            LocalStore(context).use { it.saveCatalog(account.id,
                Catalog(Device(account.deviceId, account.name), listOf(host), listOf(session), false, 1)) }
            context.getSharedPreferences("devpocket_settings", 0).edit().remove("last_scope").commit()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntil(20_000) { compose.onAllNodesWithText(session.title).fetchSemanticsNodes().isNotEmpty() }
            compose.waitUntil(20_000) { compose.onAllNodesWithText("知道了").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("error_notice").assertIsDisplayed()
            compose.onNodeWithText(session.title).performScrollTo()
            val targetBounds = compose.onNodeWithText(session.title).fetchSemanticsNode().boundsInRoot
            val errorBounds = compose.onNodeWithTag("error_notice").fetchSemanticsNode().boundsInRoot
            compose.onNodeWithText(session.title).performTouchInput { click() }
            compose.onNodeWithTag("session_detail")
                .assertExists("Session tap failed while the error remained visible: session=$targetBounds notice=$errorBounds")
                .assertIsDisplayed()
            compose.onNodeWithTag("error_notice").assertIsDisplayed()
            compose.onNodeWithText("知道了").assertIsDisplayed().performTouchInput { click() }
            compose.waitUntil(20_000) { compose.onAllNodesWithText("知道了").fetchSemanticsNodes().isEmpty() }
            if (context.resources.configuration.screenWidthDp >= 840)
                compose.onNodeWithTag("session_list").assertIsDisplayed()
            else compose.onNodeWithTag("session_list").assertDoesNotExist()
            compose.onNodeWithTag("message_input").performClick()
            compose.onNodeWithTag("message_input").performTextInput("这是一条用于大字体、旋转和窗口变化的原生中文草稿，不会发送。")
            compose.onNodeWithContentDescription("发送到原始 CLI").assertIsNotEnabled()
            scenario.recreate()
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("message_input").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("message_input").assertTextContains("这是一条用于大字体、旋转和窗口变化的原生中文草稿，不会发送。")
            LocalStore(context).use { store ->
                assertEquals(0, store.outbox(Scope(account.id, host.id, session.sessionId)).size)
            }
        } finally {
            scenario?.close()
            Vault(context).saveAccounts(oldAccounts)
            LocalStore(context).use { it.forgetAccount(account.id) }
            context.getSharedPreferences("devpocket_settings", 0).edit().remove("last_scope").commit()
        }
    }
}
