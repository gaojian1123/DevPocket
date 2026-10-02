package dev.devpocket.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.Account
import dev.devpocket.app.data.LocalStore
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.Vault
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class NativeFlowTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun nativePairingFormUsesEditableComposeControlsWithoutAWebView() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("开始配对").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("开始配对").performClick()
        compose.onNodeWithTag("native_pair_form").assertIsDisplayed()
        compose.onNodeWithText("HTTPS 中转地址").performTextInput("https://relay.example.test")
        compose.onNodeWithText("一次性配对码").performTextInput("one-time-value")
        compose.onNodeWithText("设备名称").performTextReplacement("我的原生安卓")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("开始配对").assertIsDisplayed()
    }

    @Test fun keystoreCredentialRoundTripAndBackupDisabled() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = Vault(context)
        vault.put("instrumentation-test", "ephemeral-native-proof")
        assertEquals("ephemeral-native-proof", vault.get("instrumentation-test"))
        val raw = context.getSharedPreferences("devpocket_encrypted", 0).getString("instrumentation-test", null)
        assertNotNull(raw)
        assertFalse(raw!!.contains("ephemeral-native-proof"))
        vault.put("instrumentation-test", null)
        assertEquals(0, context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_ALLOW_BACKUP)
    }
}
