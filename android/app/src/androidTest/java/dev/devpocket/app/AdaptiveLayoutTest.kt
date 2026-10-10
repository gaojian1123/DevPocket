package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.*
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class AdaptiveLayoutTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun visibleErrorAllowsSessionSelectionAndPreservesDraftAcrossWindowAndActivityChanges() {
        exerciseCachedSession("https://127.0.0.1:1")
    }

    @Test fun multilineErrorAllowsSessionSelectionWithoutDismissingDetails() {
        val message = (1..25).joinToString("\n") { "Diagnostic detail line $it" }
        withCatalogError(message) { relay -> exerciseCachedSession(relay, message) }
    }

    private fun exerciseCachedSession(relay: String, expectedError: String? = null) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account(UUID.randomUUID().toString(), relay,
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
            compose.waitUntil(20_000) { compose.onAllNodesWithText("知道了").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("error_notice").assertIsDisplayed()
            expectedError?.let { compose.onNodeWithText(it, substring = true).assertIsDisplayed() }
            val pageBounds = compose.onNodeWithTag("session_list").fetchSemanticsNode().boundsInRoot
            assertTrue("The visible error consumed the session page: $pageBounds", pageBounds.height > 0f)
            compose.onNode(hasScrollToIndexAction() and hasAnyAncestor(hasTestTag("session_list")))
                .performScrollToNode(hasText(session.title))
            val targetBounds = compose.onNodeWithText(session.title).fetchSemanticsNode().boundsInRoot
            val errorBounds = compose.onNodeWithTag("error_notice").fetchSemanticsNode().boundsInRoot
            compose.onNodeWithText(session.title).performTouchInput { click() }
            compose.onNodeWithTag("session_detail")
                .assertExists("Session tap failed while the error remained visible: session=$targetBounds notice=$errorBounds")
                .assertIsDisplayed()
            compose.onNodeWithTag("error_notice").assertIsDisplayed()
            if (expectedError != null) {
                val message = compose.onNodeWithText(expectedError, substring = true)
                val layout = mutableListOf<TextLayoutResult>()
                message.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layout) }
                assertFalse("Diagnostic text must not be truncated: size=${layout.single().size}, " +
                    "paragraphHeight=${layout.single().multiParagraph.height}, " +
                    "widthOverflow=${layout.single().didOverflowWidth}, heightOverflow=${layout.single().didOverflowHeight}, " +
                    "lines=${layout.single().lineCount}, textLength=${layout.single().layoutInput.text.length}.",
                    layout.single().hasVisualOverflow)
                val visible = message.fetchSemanticsNode()
                if (layout.single().size.height > visible.boundsInRoot.height + 1f) {
                    val range = visible.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange)
                    assertNotNull("Clipped diagnostic lines must be scrollable.", range)
                    assertTrue(range!!.maxValue() > 0f)
                    message.performTouchInput { swipeUp() }
                    compose.waitForIdle()
                    assertTrue("The error text must respond to a normal swipe.",
                        message.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f)
                }
            }
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

    private fun withCatalogError(message: String, test: (String) -> Unit) {
        val body = buildJsonObject {
            put("error", buildJsonObject { put("code", "UNAVAILABLE"); put("message", message) })
        }.toString().toByteArray(Charsets.UTF_8)
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        val executor = Executors.newSingleThreadExecutor()
        val serving = executor.submit {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (error: SocketException) {
                    if (server.isClosed) break else throw error
                }
                try {
                    socket.use {
                        it.soTimeout = 5000
                        val reader = it.getInputStream().bufferedReader()
                        var headers = 0
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isEmpty()) break
                            check(++headers <= 100) { "Fixture request headers exceeded their bound." }
                        }
                        it.getOutputStream().apply {
                            write(("HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n" +
                                "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII))
                            write(body)
                            flush()
                        }
                    }
                } catch (error: SocketException) {
                    if (!server.isClosed && error.message !in setOf("Broken pipe", "Connection reset")) throw error
                    println("Error fixture peer disconnected during activity lifecycle.")
                }
            }
        }
        try {
            test("http://127.0.0.1:${server.localPort}")
        } finally {
            server.close()
            try { serving.get(10, TimeUnit.SECONDS) } finally { executor.shutdownNow() }
        }
    }
}
