package dev.devpocket.app.push

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.installations.FirebaseInstallations
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.devpocket.app.BuildConfig
import dev.devpocket.app.MainActivity
import dev.devpocket.app.R
import dev.devpocket.app.background.BackgroundService
import dev.devpocket.app.background.SessionNotice
import dev.devpocket.app.data.Account
import dev.devpocket.app.data.RelayApi
import dev.devpocket.app.data.PushRegistration
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.Vault
import dev.devpocket.app.data.WireJson
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

object PushSetup {
    private val registrationLock = Mutex()
    val configured: Boolean get() = listOf(BuildConfig.FCM_APPLICATION_ID, BuildConfig.FCM_API_KEY,
        BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_SENDER_ID).all { it.isNotBlank() }

    fun initialize(context: Context) {
        if (!configured || FirebaseApp.getApps(context).isNotEmpty()) return
        try {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FCM_APPLICATION_ID).setApiKey(BuildConfig.FCM_API_KEY)
                .setProjectId(BuildConfig.FCM_PROJECT_ID).setGcmSenderId(BuildConfig.FCM_SENDER_ID).build())
        } catch (error: IllegalArgumentException) {
            context.getSharedPreferences("devpocket_push", 0).edit { putString("status", "FCM 配置无效：${error.message}") }
            Log.e("DevPocketPush", "Firebase configuration is invalid", error)
        }
    }

    fun status(context: Context): String {
        if (!configured) return "未配置 FCM；可手动开启后台模式接收提醒，不依赖 Google 服务。"
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return "通知权限未开启，后台提醒不可用。"
        return context.getSharedPreferences("devpocket_push", 0).getString("status", "FCM 已配置，尚未注册到中转。").orEmpty()
    }

    suspend fun register(context: Context, accounts: List<Account>) {
        if (!configured) return
        initialize(context)
        context.getSharedPreferences("devpocket_push", 0).edit {
            putString("status", "正在注册 FCM 安装标识；中转同步尚未确认。")
        }
        registrationLock.withLock {
            val fid = awaitResult(FirebaseInstallations.getInstance().id)
            awaitResult(FirebaseMessaging.getInstance().register())
            check(awaitResult(FirebaseInstallations.getInstance().id) == fid) {
                "FCM 注册标识已变化，请重新注册。"
            }
            synchronize(context, accounts, fid)
        }
    }

    suspend fun registered(context: Context, fid: String) {
        if (!configured) return
        initialize(context)
        registrationLock.withLock {
            if (awaitResult(FirebaseInstallations.getInstance().id) != fid) {
                Log.i("DevPocketPush", "A superseded FCM registration callback was ignored")
                return@withLock
            }
            synchronize(context, Vault(context).accounts(), fid)
        }
    }

    private suspend fun <T> awaitResult(task: Task<T>): T =
        suspendCancellableCoroutine { continuation ->
            task.addOnCompleteListener { completed ->
                if (!continuation.isActive) return@addOnCompleteListener
                if (completed.isSuccessful) continuation.resumeWith(Result.success(completed.result))
                else continuation.resumeWith(Result.failure(completed.exception ?: IllegalStateException("FCM 注册失败。")))
            }
        }

    private suspend fun synchronize(context: Context, accounts: List<Account>, fid: String) {
        val registration = PushRegistration.Installation(fid)
        context.getSharedPreferences("devpocket_push", 0).edit {
            putString("status", "FCM 标识已注册，正在同步到中转；尚未确认全部同步完成。")
        }
        for (account in accounts) RelayApi(account).registerPush(registration.fid)
        Vault(context).apply {
            put("fcm_fid", fid)
            put("fcm_token", null)
        }
        context.getSharedPreferences("devpocket_push", 0).edit {
            putString("status", "已向 ${accounts.size} 个中转注册 FCM 安装标识。送达仍取决于系统、网络和中转配置；未承诺必达。")
        }
    }
}

object Notifications {
    const val CHANNEL = "devpocket_attention"
    const val BACKGROUND_CHANNEL = "devpocket_background_connection"
    const val BACKGROUND_ID = 1001
    private const val BACKGROUND_TAG = "devpocket-background:"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "会话提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "GitHub Copilot 会话等待审批、问题或任务结束。不会在锁屏显示消息内容。"
            lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
        })
        manager.createNotificationChannel(NotificationChannel(BACKGROUND_CHANNEL, "后台连接状态", NotificationManager.IMPORTANCE_LOW).apply {
            description = "手动开启的后台会话监听，可随时从通知停止。"
            lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
        })
    }

    fun backgroundUnavailable(context: Context): String? {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            return "请先开启通知权限，再启动后台模式。"
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return "请先开启通知权限，再启动后台模式。"
        val manager = context.getSystemService(NotificationManager::class.java)
        if (listOf(CHANNEL, BACKGROUND_CHANNEL).any { manager.getNotificationChannel(it)?.importance == NotificationManager.IMPORTANCE_NONE })
            return "请在系统设置中开启“会话提醒”和“后台连接状态”通知频道。"
        return null
    }

    fun backgroundConnection(context: Context, message: String): android.app.Notification {
        val open = PendingIntent.getActivity(context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(context, 1,
            Intent(context, BackgroundService::class.java).setAction(BackgroundService.STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, BACKGROUND_CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher).setContentTitle("DevPocket 后台模式")
            .setContentText(message).setContentIntent(open)
            .setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "停止后台模式", stop).build()
    }

    fun updateBackgroundConnection(context: Context, message: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            throw IllegalStateException("通知权限已关闭，后台模式已停止。")
        backgroundUnavailable(context)?.let { throw IllegalStateException(it) }
        NotificationManagerCompat.from(context).notify(BACKGROUND_ID, backgroundConnection(context, message))
    }

    fun showBackground(context: Context, scope: Scope, notice: SessionNotice) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            throw IllegalStateException("通知权限已关闭，后台提醒未送达。")
        backgroundUnavailable(context)?.let { throw IllegalStateException(it) }
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setData("devpocket://background/${Uri.encode(scope.key)}".toUri())
            .putExtra(MainActivity.NOTIFICATION_SCOPE, WireJson.encodeToString(scope))
        val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val message = if (notice.kind == "attention") "GitHub Copilot 会话需要你处理审批或问题。请停车后打开应用。"
            else "会话状态有更新，打开应用同步确认；通知不代表任务成功。"
        val tag = "$BACKGROUND_TAG${scope.key}"
        val repeated = context.getSystemService(NotificationManager::class.java).activeNotifications.any {
            it.tag == tag && it.notification.extras.getString("devpocket.eventId") == notice.eventId
        }
        NotificationManagerCompat.from(context).notify(tag, 0,
            NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle("DevPocket").setContentText(message).setContentIntent(open)
                .setExtras(Bundle().apply { putString("devpocket.eventId", notice.eventId) })
                .setOnlyAlertOnce(repeated).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
    }

    fun clearBackgroundNotice(context: Context, scope: Scope) {
        NotificationManagerCompat.from(context).cancel("$BACKGROUND_TAG${scope.key}", 0)
    }

    fun clearBackgroundNotices(context: Context, accountId: String, hostId: String? = null) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val prefix = "$BACKGROUND_TAG$accountId|" + (hostId?.let { "$it|" } ?: "")
        manager.activeNotifications.filter { it.tag?.startsWith(prefix) == true }
            .forEach { manager.cancel(it.tag, it.id) }
    }

    fun show(context: Context, id: String, kind: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val message = if (kind == "attention") "GitHub Copilot 会话需要你处理审批或问题。" else "会话状态有更新，打开应用同步确认。"
        NotificationManagerCompat.from(context).notify(id.hashCode(), NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher).setContentTitle("DevPocket").setContentText(message)
            .setContentIntent(pending).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
    }
}

// FID mode uses onRegistered; this lint check still requires the legacy token callback.
@SuppressLint("MissingFirebaseInstanceTokenRefresh")
class DevPocketMessagingService : FirebaseMessagingService() {
    override fun onRegistered(installationId: String) {
        super.onRegistered(installationId)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                PushSetup.registered(applicationContext, installationId)
            } catch (error: Exception) {
                Log.e("DevPocketPush", "Push installation registration failed", error)
                applicationContext.getSharedPreferences("devpocket_push", 0).edit {
                    putString("status", "FCM 安装标识尚未同步到全部中转，请确认中转支持 FID 后在设置中重新注册。")
                }
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
