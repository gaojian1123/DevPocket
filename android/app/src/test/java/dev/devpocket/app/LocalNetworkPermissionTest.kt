package dev.devpocket.app

import android.Manifest
import android.os.Build
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import dev.devpocket.app.ui.LocalNetworkAccessControls
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35, 37], qualifiers = "w360dp-h640dp", application = DevPocketApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class LocalNetworkPermissionTest {
    @get:Rule val compose = createComposeRule()

    @Test fun permissionStateTracksGrantAndRevocationOnlyOnSupportedTargets() {
        val app = ApplicationProvider.getApplicationContext<DevPocketApplication>()
        if (Build.VERSION.SDK_INT >= 37) shadowOf(app).denyPermissions(Manifest.permission.ACCESS_LOCAL_NETWORK)
        val store = ViewModelStore()
        val model = PocketViewModel(app)
        store.put("permission-test", model)
        try {
            assertEquals(if (Build.VERSION.SDK_INT >= 37) false else null, model.ui.value.localNetworkAllowed)
            if (Build.VERSION.SDK_INT >= 37) shadowOf(app).grantPermissions(Manifest.permission.ACCESS_LOCAL_NETWORK)
            model.localNetworkPermissionChanged()
            assertEquals(if (Build.VERSION.SDK_INT >= 37) true else null, model.ui.value.localNetworkAllowed)
            if (Build.VERSION.SDK_INT >= 37) shadowOf(app).denyPermissions(Manifest.permission.ACCESS_LOCAL_NETWORK)
            model.localNetworkPermissionChanged()
            assertEquals(if (Build.VERSION.SDK_INT >= 37) false else null, model.ui.value.localNetworkAllowed)
            assertTrue(model.ui.value.accounts.isEmpty())
        } finally { store.clear() }
    }

    @Test fun legacyTargetsDoNotRequestTheNewPermission() {
        val app = ApplicationProvider.getApplicationContext<DevPocketApplication>()
        val target = app.applicationInfo.targetSdkVersion
        val store = ViewModelStore()
        try {
            app.applicationInfo.targetSdkVersion = 35
            val model = PocketViewModel(app)
            store.put("legacy-target", model)
            assertNull(model.ui.value.localNetworkAllowed)
        } finally {
            store.clear()
            app.applicationInfo.targetSdkVersion = target
        }
    }

    @Test fun permissionControlsRequireExplicitActionsAndRemainUsableAtLargeFont() {
        var allowed by mutableStateOf(false)
        var requests = 0
        var settings = 0
        compose.setContent {
            MaterialTheme {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        LocalNetworkAccessControls(allowed, { requests++ }, { settings++ })
                    }
                }
            }
        }
        assertEquals(0, requests)
        compose.onNodeWithTag("local_network_permission_request").performScrollTo()
            .assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(1, requests)
        compose.onNodeWithTag("local_network_status").assertTextEquals("局域网访问尚未允许")
        compose.runOnIdle { allowed = true }
        compose.onNodeWithTag("local_network_permission_request").assertDoesNotExist()
        compose.onNodeWithTag("local_network_status").assertTextEquals("已允许局域网访问")
        compose.onNodeWithTag("local_network_permission_settings").performScrollTo()
            .assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(1, settings)
        compose.runOnIdle { allowed = false }
        compose.onNodeWithTag("local_network_permission_request").performScrollTo().assertIsDisplayed()
        assertEquals(1, requests)
    }
}
