package dev.devpocket.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import dev.devpocket.app.data.Capabilities
import dev.devpocket.app.data.Draft
import dev.devpocket.app.data.Attachment
import dev.devpocket.app.data.ComponentReference
import dev.devpocket.app.data.ComponentSelection
import dev.devpocket.app.data.SessionInfo
import dev.devpocket.app.ui.ComposeBar
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h640dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class ComposerActionTest {
    @get:Rule val compose = createComposeRule()

    private val sendDescription = "\u53d1\u9001\u5230\u539f\u59cb GitHub Copilot \u4f1a\u8bdd"
    private val stopDescription = "\u8bf7\u6c42\u505c\u6b62\u5f53\u524d\u4efb\u52a1"
    private val session = SessionInfo(
        hostId = "host", sessionId = "session", projectId = "project", projectName = "Project",
        title = "Original", cliVersion = "test", state = "idle", permissionMode = "manual",
        modelId = "test-model", capabilities = Capabilities(messages = true, abort = true),
        registeredAt = 1, online = true, pinned = false, archived = false, lastSeen = 1,
    )
    private val initial = PocketUi(session = session, loading = false)
    private var state by mutableStateOf(initial)
    private val sent = mutableListOf<String>()
    private var stopRequests = 0

    private fun show(value: PocketUi = initial, modifier: Modifier = Modifier, inputModifier: Modifier = Modifier) {
        state = value
        compose.setContent {
            MaterialTheme {
                ComposeBar(
                    state,
                    editDraft = { state = state.copy(draft = state.draft.copy(text = it)) },
                    removeAttachment = {},
                    send = { sent += state.draft.text },
                    attach = {},
                    models = {},
                    stop = { stopRequests++ },
                    modifier = modifier,
                    removeComponentReference = { state = state.copy(draft = state.draft.copy(componentReference = null)) },
                    inputModifier = inputModifier,
                )
            }
        }
    }

    @Test fun containerModifierPreservesTheSeparateInputFocusTarget() {
        val focus = FocusRequester()
        show(modifier = Modifier.testTag("composer_container"), inputModifier = Modifier.focusRequester(focus))
        compose.onNodeWithTag("composer_container").assertIsDisplayed()
        compose.runOnIdle { focus.requestFocus() }
        compose.onNodeWithTag("message_input").assertIsFocused().performTextInput("Still editable")
        assertEquals("Still editable", state.draft.text)
    }

    @Test fun idleWithoutTextHasOnlyADisabledSendButton() {
        show()
        compose.onNodeWithContentDescription(stopDescription).assertDoesNotExist()
        compose.onNodeWithTag("composer_action").assert(hasContentDescription(sendDescription)).assertIsNotEnabled()
    }

    @Test fun activeWithoutTextUsesThePrimaryButtonForStopConfirmation() {
        show(initial.copy(session = session.copy(state = "running")))
        for (activity in listOf("running", "waiting", "cancel_requested")) {
            compose.runOnIdle { state = state.copy(session = session.copy(state = activity)) }
            compose.onNodeWithContentDescription(sendDescription).assertDoesNotExist()
            compose.onAllNodesWithContentDescription(stopDescription).assertCountEquals(1)
            compose.onNodeWithTag("composer_action").assert(hasContentDescription(stopDescription))
                .assertIsEnabled().performClick()
        }
        assertEquals(3, stopRequests)
        assertEquals(emptyList<String>(), sent)
    }

    @Test fun typingDuringWorkSelectsSendAndClearingTextRestoresStop() {
        show(initial.copy(session = session.copy(state = "running")))
        compose.onNodeWithTag("message_input").performTextInput("Queue this message")
        compose.onNodeWithContentDescription(stopDescription).assertDoesNotExist()
        compose.onNodeWithTag("composer_action").assert(hasContentDescription(sendDescription))
            .assertIsEnabled().performClick()
        assertEquals(listOf("Queue this message"), sent)
        assertEquals(0, stopRequests)
        compose.onNodeWithTag("message_input").performTextReplacement("   ")
        compose.onNodeWithContentDescription(sendDescription).assertDoesNotExist()
        compose.onNodeWithTag("composer_action").assert(hasContentDescription(stopDescription)).assertIsEnabled()
    }

    @Test fun runtimeBecomingIdleRemovesStopWithoutChangingTheDraft() {
        show(initial.copy(session = session.copy(state = "running")))
        compose.runOnIdle { state = state.copy(session = session) }
        compose.onNodeWithContentDescription(stopDescription).assertDoesNotExist()
        compose.onNodeWithTag("composer_action").assert(hasContentDescription(sendDescription)).assertIsNotEnabled()
        compose.onNodeWithTag("message_input").performTextInput("Next task")
        compose.onNodeWithTag("composer_action").assertIsEnabled().performClick()
        assertEquals(listOf("Next task"), sent)
        assertEquals(0, stopRequests)
    }

    @Test fun stopStillRequiresAnOnlineAbortCapableSession() {
        show(initial.copy(session = session.copy(state = "running")))
        for (unavailable in listOf(
            session.copy(state = "running", online = false),
            session.copy(state = "running", capabilities = Capabilities(messages = true)),
        )) {
            compose.runOnIdle { state = state.copy(session = unavailable) }
            compose.onNodeWithTag("composer_action").assert(hasContentDescription(stopDescription))
                .assertIsNotEnabled().performTouchInput { click() }
        }
        assertEquals(0, stopRequests)
        assertEquals(emptyList<String>(), sent)
    }

    @Test fun textKeepsSendVisibleWhenSendingIsUnavailable() {
        show(initial.copy(session = session.copy(state = "running"), draft = Draft(text = "Keep this draft")))
        for (unavailable in listOf(
            state.copy(session = session.copy(state = "running", online = false)),
            state.copy(session = session.copy(state = "running", capabilities = Capabilities(abort = true))),
            state.copy(uploading = true),
        )) {
            compose.runOnIdle { state = unavailable }
            compose.onNodeWithContentDescription(stopDescription).assertDoesNotExist()
            compose.onNodeWithTag("composer_action").assert(hasContentDescription(sendDescription))
                .assertIsNotEnabled().performTouchInput { click() }
        }
        assertEquals(0, stopRequests)
        assertEquals(emptyList<String>(), sent)
        assertEquals("Keep this draft", state.draft.text)
    }

    @Test fun unrelatedBusyWorkDoesNotBlockSendOrCancellation() {
        show(initial.copy(session = session.copy(state = "running"), busy = true, uploading = true))
        compose.onNodeWithTag("composer_action").assert(hasContentDescription(stopDescription)).assertIsEnabled()
        compose.runOnIdle { state = state.copy(draft = Draft(text = "Queue while busy"), uploading = false) }
        compose.onNodeWithTag("composer_action").assert(hasContentDescription(sendDescription)).assertIsEnabled()
    }

    @Test fun unknownOrOfflineRuntimeStatesDoNotInventAStopControl() {
        show()
        for (activity in listOf("unsupported", "offline")) {
            compose.runOnIdle { state = state.copy(session = session.copy(state = activity)) }
            compose.onNodeWithContentDescription(stopDescription).assertDoesNotExist()
            compose.onNodeWithTag("composer_action").assert(hasContentDescription(sendDescription)).assertIsNotEnabled()
        }
    }

    @Test fun aReferenceIsVisibleOnceWithoutFilesAndRemovingItNeverSendsOrClearsTheDraft() {
        val reference = ComponentSelection(ComponentReference("card", "a".repeat(64)), "Complete card")
        show(initial.copy(session = session.copy(componentVersion = 1),
            draft = Draft("Keep this question", componentReference = reference)))
        compose.onNodeWithTag("component_reference").assertIsDisplayed()
        compose.onNodeWithContentDescription("\u79fb\u9664\u5361\u7247\u5f15\u7528").assertIsDisplayed()
        compose.runOnIdle {
            state = state.copy(draft = state.draft.copy(attachments = List(2) {
                Attachment("file-$it", "file-$it.txt", "text/plain", 1, "b".repeat(64))
            }))
        }
        compose.onAllNodesWithContentDescription("\u79fb\u9664\u5361\u7247\u5f15\u7528").assertCountEquals(1)
        compose.onNodeWithContentDescription("\u79fb\u9664\u5361\u7247\u5f15\u7528").performClick()
        compose.onNodeWithTag("component_reference").assertDoesNotExist()
        compose.onNodeWithTag("message_input").assertTextContains("Keep this question")
        assertEquals(2, state.draft.attachments.size)
        assertEquals(emptyList<String>(), sent)
    }

    @Test fun aLegacyConnectionCannotSendAReferencedDraftAsAnOrdinaryMessage() {
        val reference = ComponentSelection(ComponentReference("card", "a".repeat(64)), "Complete card")
        show(initial.copy(draft = Draft("Keep this question", componentReference = reference)))
        compose.onNodeWithTag("component_reference").assertIsDisplayed()
        compose.onNodeWithTag("composer_action").assertIsNotEnabled()
        assertEquals(emptyList<String>(), sent)
        compose.onNodeWithContentDescription("\u79fb\u9664\u5361\u7247\u5f15\u7528").performClick()
        compose.onNodeWithTag("composer_action").assertIsEnabled()
    }
}
