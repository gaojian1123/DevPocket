package dev.devpocket.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.net.toUri
import dev.devpocket.app.ui.DevPocket

class MainActivity : ComponentActivity() {
    private val model: PocketViewModel by viewModels()
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        model.notifyPermissionChanged()
    }
    private val localNetworkPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        model.localNetworkPermissionChanged()
        if (granted) model.refreshNow()
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            DevPocket(model,
                requestNotifications = {
                    if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    else model.notifyPermissionChanged()
                },
                requestLocalNetwork = {
                    if (Build.VERSION.SDK_INT >= 37 && applicationInfo.targetSdkVersion >= 37)
                        localNetworkPermission.launch(Manifest.permission.ACCESS_LOCAL_NETWORK)
                },
                openPermissionSettings = {
                    try {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri()))
                    } catch (error: ActivityNotFoundException) {
                        Log.e("DevPocket", "Application permission settings are unavailable", error)
                        model.localNetworkSettingsUnavailable()
                    }
                })
        }
        openNotification(intent)
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openNotification(intent)
    }
    private fun openNotification(intent: Intent) {
        intent.getStringExtra(NOTIFICATION_SCOPE)?.let {
            intent.removeExtra(NOTIFICATION_SCOPE)
            model.openNotification(it)
        }
    }
    override fun onStart() { super.onStart(); model.foreground(true) }
    override fun onStop() { model.foreground(false); super.onStop() }

    companion object {
        const val NOTIFICATION_SCOPE = "dev.devpocket.notification.SCOPE"
    }
}
