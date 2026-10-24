package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsActions
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
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
        val components = args.getString("components") == "true"
        require(!components || args.getString("extended") != "true") { "Component acceptance does not include permission or cancellation experiments." }
        assumeTrue("Requires a separately authorized disposable original-client proof.", relay.isNotEmpty() && code.isNotEmpty())
        compose.waitUntil(15_000) { compose.onAllNodesWithText("开始配对").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("开始配对").performClick()
        compose.onNodeWithText("HTTPS 中转地址").performTextInput(relay)
        compose.onNodeWithText("一次性配对码").performTextInput(code)
        compose.onNodeWithText("设备名称").performTextReplacement("Android emulator proof")
        compose.onNodeWithTag("pairing_fields").performScrollToNode(hasText("配对", substring = false))
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
            compose.onAllNodes(hasContentDescription("发送到原始 GitHub Copilot 会话") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
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
        if (components) {
            check(session!!.cliVersion != "automated-test-adapter") { "The synthetic fixture is not original-client acceptance." }
            verifyComponentCards(scope, marker)
        }
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
                    compose.onAllNodes(hasContentDescription("发送到原始 GitHub Copilot 会话") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
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

    private fun verifyComponentCards(scope: Scope, marker: String) {
        require(marker.matches(Regex("[A-Za-z0-9_]{1,80}")))
        val prefix = "${marker}_COMPONENT"
        fun chart(type: String) = buildJsonObject {
            put("type", type); put("title", "${prefix}_$type"); put("xAxisKey", "label")
            putJsonArray("data") {
                repeat(if (type == "line") 12 else 3) { index -> add(buildJsonObject {
                    put("label", if (type == "line") "2026-10-${(index + 1).toString().padStart(2, '0')}T00:00:00Z"
                        else listOf("A", "B", "C")[index])
                    put("value", index % 3 + 1)
                }) }
            }
            putJsonArray("series") { add(buildJsonObject { put("name", "Count"); put("dataKey", "value") }) }
        }
        val expected = listOf(chart("line"), chart("bar"), buildJsonObject {
            put("type", "datagrid"); put("title", "${prefix}_table")
            putJsonArray("columns") {
                add(buildJsonObject { put("key", "name"); put("label", "Name") })
                add(buildJsonObject { put("key", "count"); put("label", "Count"); put("type", "number") })
            }
            putJsonArray("rows") { listOf("A", "B", "C").forEachIndexed { index, name ->
                add(buildJsonObject { put("name", name); put("count", index + 1) })
            } }
        }, buildJsonObject {
            put("type", "markdown"); put("title", "${prefix}_notes"); put("content", "$prefix synthetic acceptance data.")
        })
        fun state(): PocketUi {
            lateinit var value: PocketUi
            compose.runOnIdle { value = ViewModelProvider(compose.activity)[PocketViewModel::class.java].ui.value }
            assertEquals(scope, value.selected)
            return value
        }
        fun send(text: String) {
            compose.onNodeWithTag("message_input").performTextReplacement(text)
            compose.waitUntil(35_000) {
                compose.onAllNodes(hasContentDescription("发送到原始 GitHub Copilot 会话") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
        }
        val prompt = "For this explicitly authorized disposable Copilot App test, use the installed AgenticDeck canvas. " +
            "You may load its skill, inspect canvas capabilities and open one new panel. " +
            "Call render_component exactly once for each of these four exact specs. Do not clear existing canvases, " +
            "read or change files, run shell commands, change permissions or use other services. " +
            "These are fictitious acceptance values, not product data:\n" + JsonArray(expected).toString()
        send(prompt)
        compose.onNodeWithTag("message_input").performTextInput("Preserve the component-test draft")
        val titles = expected.map { it.text("title") }.toSet()
        compose.waitUntil(180_000) {
            state().events.mapNotNull { it.component }.count { it.status == "ready" && it.title in titles } == 4
        }
        val received = state()
        val origin = received.events.single { it.kind == "user.message" && it.data.text("content") == prompt }.data.text("messageId")
        val cards = received.events.mapNotNull { it.component }.filter { it.title in titles }
        for (spec in expected) {
            val card = cards.single { it.title == spec.text("title") }
            assertEquals(spec, card.spec)
            assertEquals(origin, card.originatingMessageId)
        }
        fun open(card: ComponentCard) {
            compose.runOnIdle {
                val window = compose.activity.window
                WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
            }
            compose.waitUntil(20_000) {
                var hidden = false
                compose.runOnIdle {
                    hidden = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                        ?.isVisible(WindowInsetsCompat.Type.ime()) == false
                }
                hidden
            }
            compose.onNodeWithTag("chat_history").performScrollToNode(hasTestTag("component_${card.componentId}"))
            compose.onNode(hasText("展开查看完整内容") and hasAnyAncestor(hasTestTag("component_${card.componentId}")))
                .performScrollTo().performClick()
            compose.onNodeWithTag("component_detail").assertIsDisplayed()
            compose.waitUntil(20_000) {
                compose.onAllNodes(hasTestTag("reference_component") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
            }
        }
        cards.forEach {
            open(it)
            compose.onNodeWithContentDescription("返回对话").performClick()
        }
        val table = cards.single { it.spec?.text("type") == "datagrid" }
        val before = state().outbox.size
        open(table)
        compose.onNodeWithTag("reference_component").performClick()
        compose.onNodeWithTag("component_reference").assertIsDisplayed()
        compose.onNodeWithTag("message_input").assertTextContains("Preserve the component-test draft")
        assertEquals(before, state().outbox.size)
        val question = "Using the attached table reference, add all values in its count column. " +
            "Reply exactly ${prefix}_REFERENCE_ followed by the sum. Do not render another card or use tools."
        send(question)
        compose.waitUntil(120_000) {
            state().events.any { it.kind == "assistant.message" && it.data.text("content").trim() == "${prefix}_REFERENCE_6" }
        }
        val after = state()
        assertEquals(1, after.outbox.count { (it.command.action as? Action.Message)?.componentReference == table.selection().reference })
        val submitted = after.events.single { it.kind == "user.message" && it.data.text("content") == question }
        assertTrue(submitted.data["attachments"]!!.jsonArray.any {
            it.jsonPrimitive.content == "component-reference-${table.sha256!!.take(16)}.json"
        })
    }
}
