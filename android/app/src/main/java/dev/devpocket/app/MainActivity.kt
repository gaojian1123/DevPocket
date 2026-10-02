package dev.devpocket.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import dev.devpocket.app.ui.DevPocket

class MainActivity : ComponentActivity() {
    private val model: PocketViewModel by viewModels()
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        model.notifyPermissionChanged()
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            DevPocket(model) {
                if (Build.VERSION.SDK_INT >= 33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                else model.notifyPermissionChanged()
            }
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
