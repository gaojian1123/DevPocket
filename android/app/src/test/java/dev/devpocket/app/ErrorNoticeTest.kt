package dev.devpocket.app

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarVisuals
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import dev.devpocket.app.ui.ErrorNotice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w915dp-h411dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class ErrorNoticeTest {
    @get:Rule val compose = createComposeRule()

    private fun checkNotice(fontScale: Float) {
        val text = "UNAVAILABLE: " + (1..25).joinToString("\n") { "Diagnostic detail line $it" }
        val label = "\u77e5\u9053\u4e86"
        var actions = 0
        val data = object : SnackbarData {
            override val visuals = object : SnackbarVisuals {
                override val message = text
                override val actionLabel = label
                override val withDismissAction = false
                override val duration = SnackbarDuration.Long
            }
            override fun performAction() { actions++ }
            override fun dismiss() = Unit
        }
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                MaterialTheme { ErrorNotice(data, Modifier.heightIn(max = 128.dp)) }
            }
        }
        val message = compose.onNodeWithText(text)
        val layouts = mutableListOf<TextLayoutResult>()
        message.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertFalse(layouts.single().hasVisualOverflow)
        val range = message.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        assertTrue(range.maxValue() > 0f)
        message.performTouchInput { swipeUp() }
        compose.waitForIdle()
        assertTrue(message.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f)
        compose.onNodeWithText(label).assertIsDisplayed().performTouchInput { click() }
        assertEquals(1, actions)
    }

    @Test fun multilineDetailsScrollWithoutMovingTheDismissButton() = checkNotice(1f)

    @Test fun largeFontStillAllowsScrollingAndDismissing() = checkNotice(2f)

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun compactNoticeKeepsFullTextAndATouchableDismissButton() = checkNotice(1f)
}
