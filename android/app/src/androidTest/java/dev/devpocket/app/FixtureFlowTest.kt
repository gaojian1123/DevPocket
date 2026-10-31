package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.lifecycle.ViewModelProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.*
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class FixtureFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun nativePairingMessageAndNewDraftSurviveReconnectAndLateAdmission() {
        val args = InstrumentationRegistry.getArguments()
        val relay = requireNotNull(args.getString("relayUrl")) { "Automated relay fixture is required." }
        val code = requireNotNull(args.getString("pairingCode")) { "Fixture pairing is required; this test cannot skip." }
        val title = requireNotNull(args.getString("sessionTitle"))
        if (android.os.Build.VERSION.SDK_INT >= 37) {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            instrumentation.uiAutomation.grantRuntimePermission(instrumentation.targetContext.packageName,
                android.Manifest.permission.ACCESS_LOCAL_NETWORK)
            compose.runOnIdle {
                val model = ViewModelProvider(compose.activity)[PocketViewModel::class.java]
                model.localNetworkPermissionChanged()
                assertEquals(true, model.ui.value.localNetworkAllowed)
                assertTrue("Granting network access must not pair automatically.", model.ui.value.accounts.isEmpty())
            }
        }
        fun windowMetadata(): String {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            fun fields(command: String, names: List<String>): String {
                val descriptor = instrumentation.uiAutomation.executeShellCommand(command)
                return android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { reader ->
                    reader.lineSequence().filter { line -> names.any(line::contains) }.take(4).joinToString("\n")
                }
            }
            var app = ""
            instrumentation.runOnMainSync {
                val view = compose.activity.window.decorView
                app = "shown=${view.isShown}, windowFocus=${view.hasWindowFocus()}, ime=" +
                    ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime())
            }
            val windows = instrumentation.uiAutomation.windows.filter { it.isFocused || it.isActive }
                .take(4).map { "type=${it.type}, focused=${it.isFocused}, package=${it.root?.packageName}" }
            return "$app, windows=$windows\n" +
                fields("dumpsys window displays", listOf("mCurrentFocus=", "mFocusedApp=")) + "\n" +
                fields("dumpsys activity activities", listOf("topResumedActivity=", "mResumedActivity:"))
        }
        fun closeKeyboardForHistory() {
            compose.runOnIdle {
                val window = compose.activity.window
                WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
            }
            try {
                compose.waitUntil(20_000) {
                    var hidden = false
                    compose.runOnIdle {
                        hidden = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                            ?.isVisible(WindowInsetsCompat.Type.ime()) == false
                    }
                    hidden
                }
            } catch (error: ComposeTimeoutException) {
                throw AssertionError("Keyboard dismissal was not confirmed by window insets: ${windowMetadata()}", error)
            }
        }
        fun answerControl(tag: String, kind: String): SemanticsNodeInteraction {
            val control = compose.onNodeWithTag(tag).performScrollTo().assertIsEnabled()
            try {
                control.assertIsDisplayed()
                val bounds = control.getUnclippedBoundsInRoot()
                val viewport = compose.onNodeWithTag("chat_history").getUnclippedBoundsInRoot()
                assertTrue("The full answer control must be inside the chat viewport.",
                    bounds.top >= viewport.top && bounds.bottom <= viewport.bottom)
            } catch (error: AssertionError) {
                var keyboardVisible = false
                compose.runOnIdle {
                    keyboardVisible = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                        ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                }
                throw AssertionError("Question control not visible: kind=$kind, ime=$keyboardVisible, " +
                    "fontScale=${compose.activity.resources.configuration.fontScale}, " +
                    "density=${compose.activity.resources.displayMetrics.density}, " +
                    "root=${compose.onRoot().fetchSemanticsNode().boundsInRoot}, " +
                    "viewport=${compose.onNodeWithTag("chat_history").fetchSemanticsNode().boundsInRoot}, " +
                    "control=${control.fetchSemanticsNode().boundsInRoot}, " +
                    "unclipped=${control.getUnclippedBoundsInRoot()}", error)
            }
            return control
        }
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
        compose.onNodeWithTag("pairing_fields").performScrollToNode(hasText("配对", substring = false))
        compose.onNodeWithText("配对", substring = false).performClick()
        compose.waitUntil(30_000) { compose.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(title).performClick()
        compose.onNodeWithTag("session_detail").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals("The layout matrix must restore the fixture font scale.",
                1f, compose.activity.resources.configuration.fontScale, 0.01f)
        }
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
        data class SavedQuestion(val id: String, val request: PendingRequest, val answer: String?, val failure: String?)
        val saved = mutableListOf<SavedQuestion>()
        var restartedActivity: MainActivity? = null
        fun state(): PocketUi {
            lateinit var current: PocketUi
            compose.runOnIdle { current = ViewModelProvider(restartedActivity ?: compose.activity)[PocketViewModel::class.java].ui.value }
            return current
        }
        fun waitForHistory() {
            compose.waitUntil(20_000) {
                val current = state()
                compose.onAllNodesWithTag("chat_history").fetchSemanticsNodes().isNotEmpty() &&
                    saved.all { question -> current.events.any {
                        it.kind == "question" && it.data.text("questionId") == question.id &&
                            it.data.text("status") in setOf("confirmed", "unknown")
                    } }
            }
        }
        fun assertHistory(question: SavedQuestion) {
            val card = "question_history_${question.id}"
            val inside = hasAnyAncestor(hasTestTag(card))
            val target = if (question.answer != null) hasTestTag("confirmed_answer_${question.id}")
                else hasText(question.failure!!) and inside
            compose.onNodeWithTag("chat_history").performScrollToNode(target)
            compose.onNode(hasText(question.request.detail) and inside).assertExists()
            compose.onNode(target).performScrollTo().assertIsDisplayed()
            if (question.answer != null) {
                compose.onNodeWithTag("confirmed_answer_${question.id}").assertTextEquals(question.answer).assertIsDisplayed()
                compose.onNode(hasText("已确认的回答 · 只读") and inside).assertExists()
            } else {
                compose.onNode(hasText("问题已不在待处理列表；实际答案未知。") and inside).assertExists()
                compose.onNode(hasText("尝试提交：Beta") and inside).assertExists()
                compose.onAllNodes(hasText("已确认的回答 · 只读") and inside).assertCountEquals(0)
            }
            compose.onAllNodes(hasClickAction() and inside).assertCountEquals(0)
            compose.onNodeWithTag("question_input_${question.request.requestId}").assertDoesNotExist()
            compose.onNodeWithTag("question_submit_${question.request.requestId}").assertDoesNotExist()
        }
        compose.onNodeWithTag("message_input").performTextReplacement("native fixture components")
        compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
        assertReply("Fixture components ready")
        compose.waitUntil(20_000) { state().events.count { it.component?.status == "ready" } == 4 }
        val cards = state().events.mapNotNull { it.component }
        assertEquals(setOf("line", "bar", "datagrid", "markdown"), cards.map { it.spec?.text("type") }.toSet())
        val table = cards.single { it.spec?.text("type") == "datagrid" }
        assertEquals(6, table.spec!!["rows"]!!.jsonArray.size)
        compose.onNodeWithTag("message_input").performTextInput("Draft kept while reading")
        closeKeyboardForHistory()
        fun openTable() {
            compose.onNodeWithTag("chat_history").performScrollToNode(hasTestTag("component_${table.componentId}"))
            compose.onNode(hasText("展开查看完整内容") and
                hasAnyAncestor(hasTestTag("component_${table.componentId}"))).performScrollTo().performClick()
            compose.onNodeWithTag("component_detail").assertIsDisplayed()
            compose.waitUntil(20_000) {
                compose.onAllNodes(hasTestTag("reference_component") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
            }
        }
        openTable()
        compose.onNodeWithContentDescription("返回对话").performClick()
        compose.onNodeWithTag("component_${table.componentId}").assertIsDisplayed()
        val beforeReference = state().outbox.size
        openTable()
        compose.onNodeWithTag("reference_component").performClick()
        compose.onNodeWithTag("component_detail").assertDoesNotExist()
        compose.onNodeWithTag("component_reference").assertIsDisplayed()
        compose.onNodeWithTag("message_input").assertTextContains("Draft kept while reading")
        assertEquals(beforeReference, state().outbox.size)
        assertEquals(table.selection(), state().draft.componentReference)
        compose.activityRule.scenario.recreate()
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("component_reference").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("message_input").assertTextContains("Draft kept while reading")
        compose.onNodeWithContentDescription("移除卡片引用").performClick()
        compose.onNodeWithTag("component_reference").assertDoesNotExist()
        closeKeyboardForHistory()
        openTable()
        compose.onNodeWithTag("reference_component").performClick()
        compose.onNodeWithTag("message_input").performTextReplacement("native fixture referenced card")
        compose.waitUntil(20_000) {
            compose.onAllNodes(hasContentDescription("发送到原始 GitHub Copilot 会话") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
        assertReply("Fixture received complete component reference")
        assertEquals(1, state().outbox.count { (it.command.action as? Action.Message)?.componentReference == table.selection().reference })
        compose.onNodeWithTag("component_reference").assertDoesNotExist()
        for (kind in List(2) { listOf("choice", "text", "form", "race", "uncertain") }.flatten()) {
            val prompt = "native fixture ask $kind"
            val previousCommands = state().outbox.map { it.command.commandId }.toSet()
            compose.onNodeWithTag("message_input").performTextReplacement(prompt)
            compose.waitUntil(20_000) {
                compose.onAllNodes(hasContentDescription("发送到原始 GitHub Copilot 会话") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").performClick()
            try {
                compose.waitUntil(30_000) {
                    val current = state()
                    !current.busy && current.requests.any {
                        it.type == "question" && it.detail.contains("Fixture $kind question") && it.supported
                    }
                }
            } catch (error: ComposeTimeoutException) {
                val current = state()
                val sent = current.outbox.singleOrNull {
                    it.command.commandId !in previousCommands && (it.command.action as? Action.Message)?.text == prompt
                }
                assertNotNull("A fresh fixture-question operation must have been staged.", sent)
                assertTrue("The fixture-question operation must reach admission.",
                    sent!!.status in setOf("admitted", "queued", "processing", "completed"))
                assertTrue("The fixture session must remain online.", current.session?.online == true)
                assertFalse("An unrelated local operation is still blocking question controls.", current.busy)
                val question = current.requests.singleOrNull {
                    it.type == "question" && it.detail.contains("Fixture $kind question")
                }
                assertNotNull("The requested fixture question was not synchronized.", question)
                assertTrue("The fixture question must retain a supported shape.", question!!.supported)
                throw error
            }
            val before = state()
            val request = before.requests.single { it.type == "question" }
            val record = questionHistory(before.events, before.outbox, before.selected).last { it.record.request.requestId == request.requestId }.record
            val answer = if (kind == "text") "完整的自由文本回答\n第二行也应保留" else "Beta"
            closeKeyboardForHistory()
            if (kind == "text") {
                compose.onNodeWithTag("chat_history").performScrollToNode(hasTestTag("question_input_${request.requestId}"))
                compose.onNodeWithTag("question_input_${request.requestId}").performTextInput(answer)
                closeKeyboardForHistory()
                compose.onNodeWithTag("chat_history").performScrollToNode(hasTestTag("question_submit_${request.requestId}"))
                compose.onNodeWithTag("question_input_${request.requestId}").assertTextContains(answer)
                answerControl("question_submit_${request.requestId}", kind).performClick()
            } else {
                compose.onNodeWithTag("chat_history").performScrollToNode(hasTestTag("question_choice_${request.requestId}_1"))
                answerControl("question_choice_${request.requestId}_1", kind).performClick()
            }
            val expected = when (kind) { "race" -> "failed"; "uncertain" -> "uncertain"; else -> "completed" }
            try {
                compose.waitUntil(30_000) {
                    val current = state()
                    current.requests.none { it.requestId == request.requestId } &&
                        current.outbox.any { (it.command.action as? Action.Answer)?.requestId == request.requestId && it.status == expected }
                }
            } catch (error: ComposeTimeoutException) {
                val current = state()
                val attempts = current.outbox.filter { (it.command.action as? Action.Answer)?.requestId == request.requestId }
                throw AssertionError("Question fixture did not settle: kind=$kind, pending=" +
                    current.requests.any { it.requestId == request.requestId } +
                    ", busy=${current.busy}, attemptStatuses=${attempts.map { it.status }}, " +
                    "confirmedReceipts=${attempts.count { it.hasConfirmedAnswer() }}", error)
            }
            val current = state()
            assertEquals(1, current.outbox.count { (it.command.action as? Action.Answer)?.requestId == request.requestId })
            assertFalse(current.events.any { it.kind == "assistant.message" && it.data.text("content").contains(answer) })
            val question = SavedQuestion(record.questionId, request, answer.takeIf { expected == "completed" },
                when (kind) { "race" -> "回答失败 · 未确认"; "uncertain" -> "回答结果不确定"; else -> null })
            saved += question
            assertHistory(question)
        }

        compose.onNode(hasContentDescription("返回会话列表") or hasContentDescription("关闭会话详情")).performClick()
        compose.onNodeWithText(title).performClick()
        waitForHistory()
        saved.forEach(::assertHistory)
        compose.runOnIdle {
            ViewModelProvider(compose.activity)[PocketViewModel::class.java].apply { foreground(false); foreground(true) }
        }
        compose.waitUntil(30_000) { state().connection == "实时连接" }
        saved.forEach(::assertHistory)
        compose.activityRule.scenario.recreate()
        waitForHistory()
        saved.forEach(::assertHistory)

        compose.activityRule.scenario.close()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { restartedActivity = it }
            waitForHistory()
            saved.forEach(::assertHistory)
        }
    }
}
