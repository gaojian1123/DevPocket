package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class ConnectedFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun pairOriginalRuntimeSendNativeMessageAndKeepNewDraftAcrossActivityRecreation() {
        val args = InstrumentationRegistry.getArguments()
        val relay = args.getString("relayUrl").orEmpty()
        val code = args.getString("pairingCode").orEmpty()
        val sessionId = args.getString("sessionId").orEmpty()
        val marker = args.getString("marker").orEmpty()
        assumeTrue("Requires a separately running disposable real CLI proof.", relay.isNotEmpty() && code.isNotEmpty())
        compose.waitUntil(15_000) { compose.onAllNodesWithText("开始配对").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("开始配对").performClick()
        compose.onNodeWithText("HTTPS 中转地址").performTextInput(relay)
        compose.onNodeWithText("一次性配对码").performTextInput(code)
        compose.onNodeWithText("设备名称").performTextReplacement("Android emulator proof")
        compose.onNodeWithText("配对", substring = false).performClick()
        compose.waitUntil(25_000) { compose.onAllNodesWithTag("native_pair_form").fetchSemanticsNodes().isEmpty() }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Vault(context).accounts().single()
        var session: SessionInfo? = null
        compose.waitUntil(30_000) {
            session = LocalStore(context).use { it.catalog(account.id)?.sessions?.find { s -> s.sessionId == sessionId } }
            session != null
        }
        compose.onNodeWithText(session!!.title, substring = false).performClick()
        compose.onNodeWithTag("session_detail").assertIsDisplayed()
        compose.onNodeWithTag("message_input").performTextInput("Reply exactly $marker. Do not use any tools.")
        compose.waitUntil(35_000) {
            compose.onAllNodes(hasContentDescription("发送到原始 CLI") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("发送到原始 CLI").performClick()
        compose.onNodeWithTag("message_input").performTextInput("保留的新草稿")
        compose.waitUntil(120_000) {
            LocalStore(context).use { store ->
                store.events(Scope(account.id, session!!.hostId, sessionId)).any {
                    it.kind == "assistant.message" && it.data.text("content").contains(marker)
                }
            }
        }
        compose.onNodeWithTag("message_input").assertTextContains("保留的新草稿")
        compose.activityRule.scenario.recreate()
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("message_input").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("message_input").assertTextContains("保留的新草稿")
        val scope = Scope(account.id, session!!.hostId, sessionId)
        val events = runBlocking {
            val collected = mutableListOf<WireEvent>()
            var cursor = 0L
            do {
                val page = RelayApi(account).events(scope, cursor)
                collected.addAll(page.events)
                cursor = page.cursor
            } while (page.hasMore)
            collected
        }
        assertEquals(1, events.count { it.kind == "user.message" && it.data.text("content").contains(marker) })
        if (args.getString("extended") == "true") {
            val suffix = marker.substringAfterLast('_')
            val permissionMarker = "DP_ANDROID_PERMISSION_$suffix"
            val questionMarker = "DP_ANDROID_QUESTION_$suffix"
            val afterStopMarker = "DP_ANDROID_AFTER_STOP_$suffix"
            fun latestRequests(): List<PendingRequest> = LocalStore(context).use { store ->
                store.events(scope).lastOrNull { it.kind == "requests" }?.data?.get("items")
                    ?.let { WireJson.decodeFromJsonElement<List<PendingRequest>>(it) }.orEmpty()
            }
            fun send(text: String) {
                compose.onNodeWithTag("message_input").performTextReplacement(text)
                compose.waitUntil(35_000) {
                    compose.onAllNodes(hasContentDescription("发送到原始 CLI") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithContentDescription("发送到原始 CLI").performClick()
            }
            fun waitAnswer(value: String) = compose.waitUntil(100_000) {
                LocalStore(context).use { store -> store.events(scope).any { it.kind == "assistant.message" && it.data.text("content").contains(value) } }
            }
            fun approve() {
                compose.waitUntil(100_000) { latestRequests().any { it.type == "permission" && it.supported } }
                val request = latestRequests().first { it.type == "permission" && it.supported }
                compose.waitUntil(35_000) {
                    compose.onAllNodes(hasTestTag("request_approve_${request.requestId}") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithTag("request_approve_${request.requestId}").performClick()
                compose.runOnUiThread {
                    val state = ViewModelProvider(compose.activity)[PocketViewModel::class.java].ui.value
                    check(state.selected != null && state.session?.online == true) { "Native approval scope is offline or missing." }
                    ViewModelProvider(compose.activity)[PocketViewModel::class.java].clearError()
                }
                compose.onNodeWithTag("confirm_permission").assertIsDisplayed()
                    .performSemanticsAction(SemanticsActions.OnClick) { click -> assertTrue(click()) }
                compose.waitUntil(20_000) {
                    val state = ViewModelProvider(compose.activity)[PocketViewModel::class.java].ui.value
                    check(state.error == null) { "Native control error: ${state.error}" }
                    latestRequests().none { it.requestId == request.requestId }
                }
            }
            send("For this safe native Android integration test use only the built-in powershell tool to run exactly Write-Output '$permissionMarker'. Do not change permissions or use other tools. Then reply ${permissionMarker}_DONE.")
            approve()
            waitAnswer("${permissionMarker}_DONE")
            send("For this native Android test call ask_user with exactly one simple string choice field, question 'DevPocket native answer', choices Alpha and Beta. Do not use other tools. After the answer reply ${questionMarker}_ followed by the selected value.")
            compose.waitUntil(100_000) { latestRequests().any { it.type == "question" && it.supported && "Alpha" in it.choices } }
            compose.onNodeWithText("Alpha", substring = false).performClick()
            waitAnswer("${questionMarker}_Alpha")
            send("For a safe native stop-button test call only the built-in powershell tool, sync mode, initial_wait 120, with exactly Start-Sleep -Seconds 60. Do not detach, add commands, change permissions or use other tools. Wait for my stop request.")
            approve()
            compose.waitUntil(30_000) { latestRequests().none { it.type == "permission" } }
            compose.onNodeWithContentDescription("请求停止当前任务").performClick()
            compose.onNodeWithText("请求停止", substring = false).performClick()
            compose.waitUntil(35_000) {
                LocalStore(context).use { store -> store.events(scope).lastOrNull { it.kind == "runtime.state" }?.data?.text("state") == "idle" }
            }
            send("Reply only $afterStopMarker. Do not use tools.")
            waitAnswer(afterStopMarker)
        }
    }
}
