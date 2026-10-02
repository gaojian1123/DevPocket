package dev.devpocket.app.background

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import dev.devpocket.app.push.Notifications
import java.io.IOException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class BackgroundState(
    val enabled: Boolean = false,
    val starting: Boolean = false,
    val message: String = "后台模式未开启",
    val error: String? = null,
)

class BackgroundMode(private val context: Context) {
    private val prefs = context.getSharedPreferences("devpocket_background", Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(BackgroundState(
        message = if (prefs.getBoolean("requested", false)) "上次后台连接已中断，请手动重新开启。" else "后台模式未开启",
    ))
    val state = mutable.asStateFlow()
    internal val revision = MutableStateFlow(0L)
    internal var requested = false
        private set
    internal var runId = 0L
        private set
    internal var cancelMonitoring: (() -> Unit)? = null

    fun start() {
        if (mutable.value.enabled) return
        Notifications.backgroundUnavailable(context)?.let { throw IllegalStateException(it) }
        if (!prefs.edit().putBoolean("requested", true).commit()) throw IOException("无法保存后台模式状态，未启动连接。")
        runId++
        requested = true
        mutable.value = BackgroundState(enabled = true, starting = true, message = "正在启动后台连接")
        try {
            ContextCompat.startForegroundService(context, Intent(context, BackgroundService::class.java)
                .setAction(BackgroundService.START).putExtra(BackgroundService.RUN_ID, runId))
        } catch (error: RuntimeException) {
            failed("无法启动后台连接：${error.message}")
        }
    }

    fun stop() {
        requested = false
        cancelMonitoring?.invoke()
        cancelMonitoring = null
        runId++
        context.stopService(Intent(context, BackgroundService::class.java))
        val error = if (prefs.edit().putBoolean("requested", false).commit()) null else "连接已停止，但无法保存关闭状态。"
        if (error != null) Log.e("DevPocketBackground", error)
        mutable.value = BackgroundState(message = "后台模式已关闭；不会停止原始 CLI。", error = error)
    }

    fun configurationChanged() {
        revision.update { it + 1 }
        Notifications.clearBackgroundNotices(context)
    }

    fun checkPermissions() {
        if (mutable.value.enabled) Notifications.backgroundUnavailable(context)?.let { failed(it) }
    }

    internal fun isRequested(id: Long) = requested && runId == id

    internal fun report(id: Long, status: MonitorStatus) {
        if (!isRequested(id)) return
        val message = if (status.sessions.isEmpty()) "后台模式已开启，正在发现未归档会话"
            else if (status.polling > 0)
                "后台监听：${status.connected} 个实时，${status.polling} 个定时同步，共 ${status.sessions.size} 个会话。定时提醒可能延迟。"
            else "后台监听 ${status.connected}/${status.sessions.size} 个会话"
        val errors = status.errors + if (status.historyReset) listOf("部分历史超出中转保留窗口，期间提醒可能不完整。") else emptyList()
        mutable.value = BackgroundState(enabled = true, message = message, error = errors.takeIf { it.isNotEmpty() }?.joinToString("\n"))
    }

    internal fun failed(message: String, id: Long = runId) {
        if (id != runId) return
        requested = false
        cancelMonitoring?.invoke()
        mutable.value = BackgroundState(message = "后台连接已停止，请处理问题后手动开启。", error = message)
        Log.e("DevPocketBackground", message)
        context.stopService(Intent(context, BackgroundService::class.java))
    }

    internal fun destroyed(id: Long) {
        if (id != runId) return
        cancelMonitoring = null
        if (requested) {
            requested = false
            mutable.value = BackgroundState(message = "后台连接已中断，请手动重新开启。")
        }
    }
}
