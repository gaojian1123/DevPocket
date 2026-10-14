package dev.devpocket.app

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.swipeWithVelocity
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import dev.devpocket.app.data.*
import dev.devpocket.app.ui.SessionPane
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h640dp", application = DevPocketApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class QuestionHistoryLayoutTest {
    @get:Rule val compose = createComposeRule()

    private val scope = Scope("account", "host", "session")
    private val session = SessionInfo(scope.hostId, scope.sessionId, "project", "Project", "History",
        "fixture", "idle", "manual", "model", capabilities = Capabilities(), registeredAt = 0,
        online = true, pinned = false, archived = false, lastSeen = 0)
    private fun event(cursor: Long, kind: String, data: JsonObject) =
        WireEvent("event-$cursor", "2026-10-13T00:00:00.000Z", kind, data, cursor, scope.hostId, scope.sessionId)
    private val request = PendingRequest("request", "question", "Question", "Complete retained question",
        choices = listOf("Phone", "Original"), supported = true)
    private val question = QuestionRecord("last-question", request, "confirmed", "Phone")
    private val events = (1..30).map { index ->
        event(index.toLong(), "assistant.message", buildJsonObject {
            put("messageId", "message-$index"); put("content", "Earlier message $index")
        })
    } + event(31, "question", WireJson.encodeToJsonElement(question) as JsonObject)
    private val history = PocketUi(loading = false, selected = scope, session = session,
        connection = "实时连接", events = events)
    private val later = event(32, "assistant.message", buildJsonObject {
        put("messageId", "later"); put("content", "Later live message")
    })
    private val cachedEarlier = event(0, "assistant.message", buildJsonObject {
        put("messageId", "cached-earlier"); put("content", "Earlier cached page")
    })

    private fun withHistory(initial: PocketUi = history, check: (MutableState<PocketUi>) -> Unit) {
        val model = PocketViewModel(ApplicationProvider.getApplicationContext())
        val models = ViewModelStore().also { it.put("fixture", model) }
        val replayed = mutableStateOf(initial)
        try {
            compose.setContent {
                MaterialTheme {
                    SubcomposeLayout(Modifier.fillMaxSize()) { constraints ->
                        val current = replayed.value
                        val children = subcompose("history") { SessionPane(current, model, expanded = false) }
                            .map { it.measure(constraints) }
                        layout(constraints.maxWidth, constraints.maxHeight) {
                            children.forEach { it.place(0, 0) }
                        }
                    }
                }
            }
            check(replayed)
        } finally {
            compose.mainClock.autoAdvance = true
            models.clear()
        }
    }

    private fun scrollPosition(): Float = compose.onNodeWithTag("chat_history").fetchSemanticsNode()
        .config[SemanticsProperties.VerticalScrollAxisRange].value()

    private fun visibleMessageAnchor(): Pair<String, Float> {
        val viewport = compose.onNodeWithTag("chat_history").fetchSemanticsNode().boundsInRoot
        val anchor = compose.onAllNodes(hasText("Earlier message", substring = true)).fetchSemanticsNodes()
            .filter { it.boundsInRoot.top > viewport.top && it.boundsInRoot.bottom < viewport.bottom }
            .minBy { it.boundsInRoot.top }
        return anchor.config[SemanticsProperties.Text].single().text to anchor.boundsInRoot.top
    }

    @Test fun replayedQuestionHistoryCanFollowItsTailDuringSubcomposition() =
        withHistory(history.copy(events = emptyList())) { replayed ->
            repeat(3) {
                compose.runOnIdle { replayed.value = history }
                compose.onNodeWithTag("confirmed_answer_last-question").assertIsDisplayed()
                compose.runOnIdle { replayed.value = history.copy(events = emptyList()) }
            }
            compose.runOnIdle { replayed.value = history }
            compose.onNodeWithTag("confirmed_answer_last-question").assertIsDisplayed()
            repeat(3) { compose.onNodeWithTag("chat_history").performTouchInput { swipeDown() } }
            compose.onNodeWithTag("confirmed_answer_last-question").assertIsNotDisplayed()
            compose.runOnIdle { replayed.value = history.copy(events = events + later) }
            compose.onNodeWithText("Later live message").assertIsNotDisplayed()
            compose.onNodeWithText("\u6700\u65b0").performClick()
            compose.onNodeWithText("Later live message").assertIsDisplayed()
        }

    @Test fun liveAndCachedUpdatesDuringAnUnfinishedDragKeepTheReadingPosition() = withHistory { replayed ->
        compose.onNodeWithTag("confirmed_answer_last-question").assertIsDisplayed()
        val tail = scrollPosition()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("chat_history").performTouchInput {
            down(Offset(centerX, height * 0.15f))
            moveTo(Offset(centerX, height * 0.65f), delayMillis = 120)
        }
        compose.mainClock.advanceTimeByFrame()
        val dragged = scrollPosition()
        assertTrue("The real pointer must scroll away from the tail before the update.", dragged < tail)
        compose.runOnIdle { replayed.value = history.copy(events = events + later) }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(dragged, scrollPosition(), 0.02f)
        val anchor = visibleMessageAnchor()
        compose.runOnIdle { replayed.value = history.copy(events = listOf(cachedEarlier) + events + later) }
        compose.mainClock.advanceTimeByFrame()
        val cachedPosition = scrollPosition()
        assertEquals("Prepending a cached item preserves the same visible item and offset.", anchor.second,
            compose.onNodeWithText(anchor.first).fetchSemanticsNode().boundsInRoot.top, 0.5f)
        compose.onNodeWithTag("chat_history").performTouchInput {
            moveTo(Offset(centerX, height * 0.9f), delayMillis = 120)
        }
        compose.mainClock.advanceTimeByFrame()
        assertTrue("The original drag must still respond after the update.", scrollPosition() < cachedPosition)
        compose.onNodeWithTag("chat_history").performTouchInput { up() }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.onNodeWithText("Later live message").assertIsNotDisplayed()
        compose.onNodeWithText("\u6700\u65b0").performClick()
        compose.onNodeWithText("Later live message").assertIsDisplayed()
    }

    @Test fun locatingAnEarlierHistoryItemDoesNotImmediatelyJumpBackToTheTail() = withHistory {
        compose.onNodeWithTag("confirmed_answer_last-question").assertIsDisplayed()
        compose.onNodeWithTag("chat_history").performScrollToNode(hasText("Earlier message 10"))
        compose.onNodeWithText("Earlier message 10").assertIsDisplayed()
        compose.onNodeWithTag("confirmed_answer_last-question").assertIsNotDisplayed()
    }

    @Test fun aLastQuestionTallerThanTheViewportKeepsItsChoicesVisibleAfterReachingTheBottom() {
        val tall = request.copy(detail = (1..24).joinToString("\n") { "Full question detail line $it" })
        val pending = QuestionRecord("last-question", tall, "pending")
        val state = history.copy(session = session.copy(capabilities = Capabilities(questions = true)),
            requests = listOf(tall), events = events.dropLast(1) +
                event(31, "question", WireJson.encodeToJsonElement(pending) as JsonObject))
        withHistory(state) { replayed ->
            val list = compose.onNodeWithTag("chat_history")
            val card = compose.onNodeWithTag("question_history_last-question")
            val cardBounds = card.getUnclippedBoundsInRoot()
            val viewport = list.getUnclippedBoundsInRoot()
            assertTrue("Exercise one tall request card, not just many short history rows.",
                cardBounds.bottom - cardBounds.top > viewport.bottom - viewport.top)
            repeat(4) { list.performTouchInput { swipeUp(durationMillis = 300) } }
            compose.onNodeWithTag("question_choice_request_1").assertIsDisplayed()
            list.performTouchInput { swipeDown() }
            compose.onNodeWithText("\u6700\u65b0").assertIsDisplayed().performClick()
            compose.onNodeWithTag("question_choice_request_1").assertIsDisplayed()
            val expanded = tall.copy(detail = tall.detail + "\n" + (25..35).joinToString("\n") { "More safe detail $it" })
            compose.runOnIdle {
                replayed.value = state.copy(requests = listOf(expanded), events = events.dropLast(1) +
                    event(31, "question", WireJson.encodeToJsonElement(pending.copy(request = expanded)) as JsonObject))
            }
            compose.onNodeWithTag("question_choice_request_1").assertIsDisplayed()
        }
    }

    @Test fun aChoiceInsideATallCardBeforeDeliveryRowsCanBeFullyScrolledIntoView() {
        val tall = request.copy(detail = (1..24).joinToString("\n") { "Full question detail line $it" })
        val pending = QuestionRecord("last-question", tall, "pending")
        val state = history.copy(session = session.copy(capabilities = Capabilities(questions = true)),
            requests = listOf(tall), events = events.dropLast(1) +
                event(31, "question", WireJson.encodeToJsonElement(pending) as JsonObject),
            outbox = List(5) { index -> Outbox(scope, Command("command-$index", Action.Message("Message $index")),
                "completed", index.toLong()) })
        withHistory(state) {
            compose.onNodeWithTag("chat_history").performScrollToNode(
                androidx.compose.ui.test.hasTestTag("question_choice_request_1"))
            val choice = compose.onNodeWithTag("question_choice_request_1")
            choice.performScrollTo().assertIsDisplayed()
            val bounds = choice.getUnclippedBoundsInRoot()
            val viewport = compose.onNodeWithTag("chat_history").getUnclippedBoundsInRoot()
            assertTrue(bounds.top >= viewport.top && bounds.bottom <= viewport.bottom)
        }
    }

    @Test fun aConfirmedAnswerInAnOversizedReplayedCardCanBeScrolledToItsOwnBounds() {
        val tall = request.copy(detail = (1..24).joinToString("\n") { "Full retained question detail $it" })
        val confirmed = question.copy(request = tall)
        val state = history.copy(events = events.dropLast(1) +
            event(31, "question", WireJson.encodeToJsonElement(confirmed) as JsonObject) + later,
            outbox = List(5) { index -> Outbox(scope, Command("command-$index", Action.Message("Message $index")),
                "completed", index.toLong()) })
        withHistory(state.copy(events = emptyList())) { replayed ->
            repeat(3) {
                compose.runOnIdle { replayed.value = state }
                compose.onNodeWithTag("chat_history").performScrollToNode(
                    androidx.compose.ui.test.hasTestTag("confirmed_answer_last-question"))
                compose.onNodeWithTag("confirmed_answer_last-question").performScrollTo().assertTextEquals("Phone").assertIsDisplayed()
                compose.runOnIdle { replayed.value = state.copy(events = emptyList()) }
            }
        }
    }

    @Test fun followTailKeepsTheSameLastMessageVisibleWhenAnEarlierQuestionExpands() {
        val short = QuestionRecord("last-question", request, "pending")
        val initial = history.copy(events = events.dropLast(1) +
            event(31, "question", WireJson.encodeToJsonElement(short) as JsonObject) + later)
        withHistory(initial) { replayed ->
            compose.onNodeWithText("Later live message").assertIsDisplayed()
            compose.runOnIdle {
                val completed = short.copy(status = "confirmed",
                    answer = (1..80).joinToString("\n") { "Confirmed answer detail $it" })
                replayed.value = initial.copy(events = events.dropLast(1) +
                    event(31, "question", WireJson.encodeToJsonElement(completed) as JsonObject) + later)
            }
            compose.onNodeWithText("Later live message").assertIsDisplayed()
        }
    }

    @Test fun explicitHistoryNavigationAndReadGesturesPreserveTargetsAcrossLateEvents() = withHistory { replayed ->
        compose.onNodeWithTag("confirmed_answer_last-question").assertIsDisplayed()
        compose.onNodeWithTag("chat_history").performScrollToNode(hasText("Earlier message 10"))
        compose.onNodeWithText("Earlier message 10").assertIsDisplayed()
        compose.onNodeWithText("\u6700\u65b0").assertIsDisplayed()
        compose.runOnIdle { replayed.value = history.copy(events = events + later) }
        compose.onNodeWithText("Earlier message 10").assertIsDisplayed()
        compose.onNodeWithText("Later live message").assertIsNotDisplayed()
        compose.onNodeWithText("\u6700\u65b0").performClick()
        compose.onNodeWithText("Later live message").assertIsDisplayed()

        compose.onNodeWithTag("chat_history").performTouchInput { swipeDown() }
        compose.onNodeWithText("\u6700\u65b0").assertIsDisplayed()
        compose.onNodeWithTag("chat_history").performScrollToNode(hasText("Earlier message 10"))
        compose.onNodeWithText("Earlier message 10").assertIsDisplayed()
        compose.runOnIdle {
            replayed.value = history.copy(events = listOf(cachedEarlier) + events + later +
                event(33, "assistant.message", buildJsonObject {
                    put("messageId", "newest"); put("content", "Newest live message")
                }))
        }
        compose.onNodeWithText("Earlier message 10").assertIsDisplayed()
        compose.onNodeWithText("Newest live message").assertIsNotDisplayed()
        compose.onNodeWithText("\u6700\u65b0").performClick()
        compose.onNodeWithText("Newest live message").assertIsDisplayed()
    }

    @Test fun updatesDuringFlingPreserveMotionAndLatestWaitsThenReachesTheNewTail() = withHistory { replayed ->
        compose.onNodeWithTag("confirmed_answer_last-question").assertIsDisplayed()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("chat_history").performTouchInput {
            swipeWithVelocity(Offset(centerX, height * 0.15f), Offset(centerX, height * 0.7f),
                endVelocity = 2500f, durationMillis = 150)
        }
        compose.mainClock.advanceTimeByFrame()
        val released = scrollPosition()
        compose.mainClock.advanceTimeBy(32)
        val moving = scrollPosition()
        assertTrue("The finger is up; changing position must now come from the actual fling.", moving < released)
        compose.runOnIdle { replayed.value = history.copy(events = events + later) }
        compose.mainClock.advanceTimeBy(32)
        val afterUpdate = scrollPosition()
        assertTrue("A live update must not cancel the fling or jump to the tail.", afterUpdate < moving)
        val anchor = visibleMessageAnchor()
        compose.runOnIdle { replayed.value = history.copy(events = listOf(cachedEarlier) + events + later) }
        compose.mainClock.advanceTimeBy(32)
        assertTrue("Cache replay must not cancel the ongoing fling.",
            compose.onNodeWithText(anchor.first).fetchSemanticsNode().boundsInRoot.top > anchor.second)
        compose.onNodeWithText("Later live message").assertIsNotDisplayed()
        compose.onNodeWithText("\u6700\u65b0").assertIsDisplayed().performClick()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.onNodeWithText("Later live message").assertIsDisplayed()
    }
}
