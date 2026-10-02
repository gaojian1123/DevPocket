package dev.devpocket.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.devpocket.app.BuildConfig
import dev.devpocket.app.MainActivity
import dev.devpocket.app.R
import dev.devpocket.app.data.Account
import dev.devpocket.app.data.RelayApi
import dev.devpocket.app.data.Vault
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

object PushSetup {
    val configured: Boolean get() = listOf(BuildConfig.FCM_APPLICATION_ID, BuildConfig.FCM_API_KEY,
        BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_SENDER_ID).all { it.isNotBlank() }

    fun initialize(context: Context) {
        if (!configured || FirebaseApp.getApps(context).isNotEmpty()) return
        try {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FCM_APPLICATION_ID).setApiKey(BuildConfig.FCM_API_KEY)
                .setProjectId(BuildConfig.FCM_PROJECT_ID).setGcmSenderId(BuildConfig.FCM_SENDER_ID).build())
        } catch (error: IllegalArgumentException) {
            context.getSharedPreferences("devpocket_push", 0).edit().putString("status", "FCM 配置无效：${error.message}").apply()
            Log.e("DevPocketPush", "Firebase configuration is invalid", error)
        }
    }

    fun status(context: Context): String {
        if (!configured) return "未配置 FCM；后台和锁屏推送不可用。前台通过原生 WebSocket 同步。"
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return "通知权限未开启，后台提醒不可用。"
        return context.getSharedPreferences("devpocket_push", 0).getString("status", "FCM 已配置，尚未注册到中转。").orEmpty()
    }

    suspend fun register(context: Context, accounts: List<Account>) {
        if (!configured) return
        initialize(context)
        val token = suspendCancellableCoroutine<String> { continuation ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (!continuation.isActive) return@addOnCompleteListener
                if (task.isSuccessful) continuation.resumeWith(Result.success(task.result))
                else continuation.resumeWith(Result.failure(task.exception ?: IllegalStateException("FCM 注册失败。")))
            }
        }
        Vault(context).put("fcm_token", token)
        for (account in accounts) RelayApi(account).registerPush(token)
        context.getSharedPreferences("devpocket_push", 0).edit()
            .putString("status", "已向 ${accounts.size} 个中转注册 FCM。送达仍取决于系统、网络和中转配置；未承诺必达。").apply()
    }
}

object Notifications {
    const val CHANNEL = "devpocket_attention"
    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "会话提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "CLI 等待审批、问题或任务结束。不会在锁屏显示消息内容。"
            lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
        })
    }

    fun show(context: Context, id: String, kind: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val message = if (kind == "attention") "原始 CLI 会话需要你处理审批或问题。" else "会话状态有更新，打开应用同步确认。"
        NotificationManagerCompat.from(context).notify(id.hashCode(), NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher).setContentTitle("DevPocket").setContentText(message)
            .setContentIntent(pending).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
    }
}

class DevPocketMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val vault = Vault(applicationContext)
                vault.put("fcm_token", token)
                for (account in vault.accounts()) RelayApi(account).registerPush(token)
            } catch (error: Exception) {
                Log.e("DevPocketPush", "Push token registration failed", error)
                applicationContext.getSharedPreferences("devpocket_push", 0).edit()
                    .putString("status", "FCM token 更新未同步，请在设置中重新注册。").apply()
            }
        }
    }
    override fun onMessageReceived(message: RemoteMessage) {
        val host = message.data["hostId"] ?: return
        val session = message.data["sessionId"] ?: return
        val eventId = message.data["eventId"] ?: return
        if (!host.matches(Regex("[a-f0-9-]{36}")) || !session.matches(Regex("[a-f0-9-]{36}"))) return
        Executors.newSingleThreadExecutor().apply {
            execute { try { Notifications.show(applicationContext, eventId, message.data["kind"].orEmpty()) } finally { shutdown() } }
        }
    }
}
