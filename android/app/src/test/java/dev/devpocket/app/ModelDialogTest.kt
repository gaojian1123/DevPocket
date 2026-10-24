package dev.devpocket.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Density
import dev.devpocket.app.data.Capabilities
import dev.devpocket.app.data.ModelOption
import dev.devpocket.app.data.SessionInfo
import dev.devpocket.app.ui.ModelDialog
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
class ModelDialogTest {
    @get:Rule val compose = createComposeRule()

    private val session = SessionInfo(
        hostId = "host", sessionId = "session", projectId = "project", projectName = "Project",
        title = "Original", cliVersion = "test", state = "idle", permissionMode = "manual",
        modelId = "model-0", reasoningEffort = "high", capabilities = Capabilities(models = true),
        registeredAt = 1, online = true, pinned = false, archived = false, lastSeen = 1,
    )
    private val models = List(20) { index ->
        ModelOption("model-$index", "Model $index", listOf("low", "high"), enabled = true)
    }

    private val initial get() = PocketUi(session = session, models = models, loading = false)

    private fun show(
        state: PocketUi = initial,
        select: (ModelOption, String?) -> Unit = { _, _ -> },
    ) {
        compose.setContent {
            MaterialTheme {
                ModelDialog(state, onDismiss = {}, select = select)
            }
        }
    }

    private fun chooseModel(name: String) {
        compose.onNodeWithTag("model_picker").performClick()
        compose.onAllNodesWithText(name).onLast().performScrollTo().performClick()
    }

    @Test fun currentModelsReasoningControlsAreVisibleOnOpen() {
        show()
        compose.onNodeWithText("\u63a8\u7406\u5f3a\u5ea6").assertIsDisplayed()
        compose.onNodeWithText("high").assertIsDisplayed().assertIsSelected()
    }

    @Test fun selectingAModelDoesNotHideReasoningBelowTheWholeCatalogue() {
        show()
        compose.onNodeWithText("Model 0").performClick()
        compose.onAllNodesWithText("Model 0").onLast().performClick()
        compose.onNodeWithText("\u63a8\u7406\u5f3a\u5ea6").assertIsDisplayed()
        compose.onNodeWithText("high").assertIsDisplayed()
    }

    @Test fun applyPreservesTheCurrentModelAndConfirmedReasoning() {
        var selection: Pair<String, String?>? = null
        show { option, effort -> selection = option.id to effort }
        compose.onNodeWithTag("apply_model").performClick()
        assertEquals("model-0" to "high", selection)
    }

    @Test fun anotherModelStartsAtDefaultAndSubmitsItsChosenReasoning() {
        var selection: Pair<String, String?>? = null
        show { option, effort -> selection = option.id to effort }
        chooseModel("Model 19")
        compose.onNodeWithText("\u8fd0\u884c\u65f6\u9ed8\u8ba4").assertIsSelected()
        compose.onNodeWithText("low").performClick()
        compose.onNodeWithTag("apply_model").performClick()
        assertEquals("model-19" to "low", selection)
    }

    @Test fun unenumeratedReasoningRemainsEditableAndDefaultClearsTheInput() {
        var selection: Pair<String, String?>? = null
        show(initial.copy(models = models.map { it.copy(reasoningEfforts = emptyList(), reasoningManual = true) })) {
            option, effort -> selection = option.id to effort
        }
        compose.onNodeWithTag("reasoning_input").performScrollTo().assertIsDisplayed()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("high")))
            .performTextReplacement("medium")
        compose.onNodeWithTag("apply_model").performClick()
        assertEquals("model-0" to "medium", selection)
        chooseModel("Model 1")
        compose.onNodeWithTag("reasoning_input").performScrollTo()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
            .performTextReplacement("low")
        compose.onNodeWithText("\u8fd0\u884c\u65f6\u9ed8\u8ba4").performScrollTo().performClick()
        compose.onNodeWithTag("reasoning_input")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithTag("apply_model").performClick()
        assertEquals("model-1" to null, selection)
    }

    @Test fun asyncCatalogueUsesTheCurrentSelectionWithoutRequiringAnotherModelClick() {
        var state by mutableStateOf(initial.copy(models = emptyList(), busy = true))
        compose.setContent { MaterialTheme { ModelDialog(state, onDismiss = {}) { _, _ -> } } }
        compose.onNodeWithTag("apply_model").assertIsNotEnabled()
        compose.runOnIdle { state = initial }
        compose.onNodeWithText("high").assertIsDisplayed().assertIsSelected()
    }

    @Test fun refreshedPolicyAndCapabilityEvidenceDisableStaleSelections() {
        var state by mutableStateOf(initial)
        compose.setContent { MaterialTheme { ModelDialog(state, onDismiss = {}) { _, _ -> } } }
        chooseModel("Model 1")
        compose.onNodeWithText("high").performClick()
        for (unavailable in listOf(
            initial.copy(models = models.map { it.copy(reasoningEfforts = listOf("low")) }),
            initial.copy(models = models.map { it.copy(enabled = false) }),
            initial.copy(models = models.take(1)),
            initial.copy(session = session.copy(online = false)),
            initial.copy(session = session.copy(capabilities = Capabilities())),
            initial.copy(busy = true),
        )) {
            compose.runOnIdle { state = unavailable }
            compose.onNodeWithTag("apply_model").assertIsNotEnabled()
        }
    }

    @Test fun selectionAndReasoningSurviveDialogStateRestoration() {
        val restoration = StateRestorationTester(compose)
        var selection: Pair<String, String?>? = null
        restoration.setContent {
            MaterialTheme { ModelDialog(initial, onDismiss = {}) { option, effort -> selection = option.id to effort } }
        }
        chooseModel("Model 1")
        compose.onNodeWithText("low").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("low").assertIsSelected()
        compose.onNodeWithTag("apply_model").performClick()
        assertEquals("model-1" to "low", selection)
    }

    @Test
    @Config(qualifiers = "w640dp-h360dp")
    fun reasoningRemainsReachableInLandscapeWithLargeFonts() {
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                MaterialTheme { ModelDialog(initial, onDismiss = {}) { _, _ -> } }
            }
        }
        compose.onNodeWithText("high").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("apply_model").assertIsDisplayed()
    }
}
