package dev.devpocket.app.background

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import dev.devpocket.app.DevPocketApplication
import dev.devpocket.app.data.RelayApi
import dev.devpocket.app.data.Vault
import dev.devpocket.app.push.Notifications
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class BackgroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mode get() = (application as DevPocketApplication).background
    private var work: Job? = null
    private var runId = -1L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            mode.stop()
            stopSelf()
            return START_NOT_STICKY
        }
        val requestedRun = intent?.getLongExtra(RUN_ID, -1) ?: -1
        if (intent?.action != START || !mode.isRequested(requestedRun)) {
            if (work?.isActive != true) stopSelf()
            return START_NOT_STICKY
        }
        if (work?.isActive == true) return START_NOT_STICKY
        runId = requestedRun
        try {
            Notifications.backgroundUnavailable(this)?.let { throw IllegalStateException(it) }
            ServiceCompat.startForeground(this, Notifications.BACKGROUND_ID,
                Notifications.backgroundConnection(this, "正在连接已配对的中转"),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
            mode.cancelMonitoring = { work?.cancel() }
            work = scope.launch {
                try {
                    coroutineScope {
                        launch {
                            while (isActive) {
                                Notifications.backgroundUnavailable(this@BackgroundService)?.let { throw IllegalStateException(it) }
                                delay(15_000)
                            }
                        }
                        mode.revision.collectLatest { revision ->
                            coroutineScope {
                                val accounts = withContext(Dispatchers.IO) { Vault(this@BackgroundService).accounts() }
                                val checkpoints = BackgroundCheckpoints(this@BackgroundService)
                                checkpoints.retainAccounts(accounts.map { it.id }.toSet())
                                val monitor = BackgroundMonitor(::RelayApi, checkpoints,
                                    notify = { target, notice ->
                                        if (!mode.isRequested(requestedRun) || mode.revision.value != revision)
                                            throw CancellationException("Background configuration changed")
                                        Notifications.showBackground(this@BackgroundService, target, notice)
                                    },
                                    dismiss = { target -> Notifications.clearBackgroundNotice(this@BackgroundService, target) })
                                launch {
                                    var previous: BackgroundState? = null
                                    monitor.status.collect { status ->
                                        if (!mode.isRequested(requestedRun) || mode.revision.value != revision) return@collect
                                        mode.report(requestedRun, status)
                                        val current = mode.state.value
                                        if (current != previous) {
                                            if (current.error != null && current.error != previous?.error)
                                                Log.w("DevPocketBackground", current.error)
                                            Notifications.updateBackgroundConnection(this@BackgroundService,
                                                if (current.error == null) current.message else "部分后台连接不可用，请打开应用查看。")
                                            previous = current
                                        }
                                    }
                                }
                                monitor.run(accounts)
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    mode.failed("后台连接失败：${error.message}", requestedRun)
                    stopSelf()
                }
            }
        } catch (error: RuntimeException) {
            mode.failed("系统未允许后台模式：${error.message}", requestedRun)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        mode.failed("系统要求结束后台连接，请在应用内手动重新开启。", runId)
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        mode.destroyed(runId)
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        const val START = "dev.devpocket.background.START"
        const val STOP = "dev.devpocket.background.STOP"
        const val RUN_ID = "dev.devpocket.background.RUN_ID"
    }
}
