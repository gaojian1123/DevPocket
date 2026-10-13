package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.text
import org.junit.Rule
import org.junit.Test

class FixtureFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun nativePairingMessageAndNewDraftSurviveReconnectAndLateAdmission() {
        val args = InstrumentationRegistry.getArguments()
        val relay = requireNotNull(args.getString("relayUrl")) { "Automated relay fixture is required." }
        val code = requireNotNull(args.getString("pairingCode")) { "Fixture pairing is required; this test cannot skip." }
        val title = requireNotNull(args.getString("sessionTitle"))
        fun assertReply(text: String) {
            compose.waitUntil(30_000) {
                var received = false
                compose.runOnIdle {
                    received = ViewModelProvider(compose.activity)[PocketViewModel::class.java].ui.value.events.any {
                        it.kind == "assistant.message" && it.data.text("content") == text
                    }
                }
                received
            }
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(text))
            compose.onNodeWithText(text).assertIsDisplayed()
        }
        compose.waitUntil(20_000) { compose.onAllNodesWithText("开始配对").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("开始配对").performClick()
        compose.onNodeWithText("HTTPS 中转地址").performTextInput(relay)
        compose.onNodeWithText("一次性配对码").performTextInput(code)
        compose.onNodeWithText("设备名称").performTextReplacement("Automated Android fixture")
        compose.onNodeWithText("配对", substring = false).performClick()
        compose.waitUntil(30_000) { compose.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(title).performClick()
        compose.onNodeWithTag("session_detail").assertIsDisplayed()
        compose.waitUntil(20_000) {
            compose.onAllNodesWithText("Fixture history before attachment").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("message_input").performTextInput("native fixture hello")
        compose.waitUntil(20_000) {
            compose.onAllNodes(hasContentDescription("发送到原始 GitHub Copilot 会话") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
        compose.onNodeWithTag("message_input").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithTag("message_input").performTextInput("New draft must remain")
        assertReply("Fixture reply: native fixture hello")
        compose.onNodeWithTag("message_input").assertTextContains("New draft must remain")
        compose.activityRule.scenario.recreate()
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("message_input").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("message_input").assertTextContains("New draft must remain")
        compose.onNodeWithTag("message_input").performTextReplacement("native fixture after reconnect")
        compose.waitUntil(20_000) {
            compose.onAllNodes(hasContentDescription("发送到原始 GitHub Copilot 会话") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
        compose.onNodeWithTag("message_input").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        assertReply("Fixture reply: native fixture after reconnect")
        compose.runOnIdle {
            val events = ViewModelProvider(compose.activity)[PocketViewModel::class.java].ui.value.events
            org.junit.Assert.assertEquals(1, events.count {
                it.kind == "user.message" && it.data.text("content") == "native fixture after reconnect"
            })
        }
    }
}
