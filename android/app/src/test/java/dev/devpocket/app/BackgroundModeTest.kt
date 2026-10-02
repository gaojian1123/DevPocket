@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.devpocket.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import dev.devpocket.app.background.BackgroundCheckpoints
import dev.devpocket.app.background.BackgroundMode
import dev.devpocket.app.background.BackgroundService
import dev.devpocket.app.background.NoticeCheckpoint
import dev.devpocket.app.background.SessionNotice
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.WireJson
import dev.devpocket.app.push.Notifications
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 35])
@LooperMode(LooperMode.Mode.PAUSED)
class BackgroundModeTest {
    private lateinit var app: DevPocketApplication
    private val dispatcher = StandardTestDispatcher()

    @Before fun setup() {
        Dispatchers.setMain(dispatcher)
        app = RuntimeEnvironment.getApplication() as DevPocketApplication
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        shadowOf(app.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(true)
    }

    @After fun cleanup() {
        app.background.stop()
        Dispatchers.resetMain()
    }

    @Test fun disabledByDefaultAndInterruptedProcessDoesNotAutomaticallyRestart() {
        assertFalse(app.background.state.value.enabled)
        assertNull(shadowOf(app).nextStartedService)
        app.getSharedPreferences("devpocket_background", Context.MODE_PRIVATE).edit().putBoolean("requested", true).commit()
        val restored = BackgroundMode(app)
        assertFalse(restored.state.value.enabled)
        assertTrue(restored.state.value.message.contains("中断"))
        assertNull(shadowOf(app).nextStartedService)
    }

    @Test fun explicitStartCreatesVisibleNonStickyServiceWithAStopAction() {
        val mode = app.background
        mode.start()
        val intent = shadowOf(app).nextStartedService
        assertEquals(BackgroundService.START, intent.action)
        assertTrue(mode.state.value.starting)
        val controller = Robolectric.buildService(BackgroundService::class.java).create()
        try {
            assertEquals(Service.START_NOT_STICKY, controller.get().onStartCommand(intent, 0, 1))
            val notification = shadowOf(controller.get()).lastForegroundNotification
            assertEquals(Notifications.BACKGROUND_CHANNEL, notification.channelId)
            assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
            assertEquals(BackgroundService.STOP, shadowOf(notification.actions.single().actionIntent).savedIntent.action)
            mode.stop()
            assertFalse(mode.state.value.enabled)
        } finally { controller.destroy() }
        dispatcher.scheduler.runCurrent()
        assertFalse(mode.state.value.enabled)
    }

    @Test fun unexpectedServiceStartCannotResurrectAnOptedOutMode() {
        val controller = Robolectric.buildService(BackgroundService::class.java).create()
        try {
            assertEquals(Service.START_NOT_STICKY,
                controller.get().onStartCommand(Intent(app, BackgroundService::class.java).setAction(BackgroundService.START), 0, 1))
            assertNull(shadowOf(controller.get()).lastForegroundNotification)
            assertFalse(app.background.state.value.enabled)
        } finally { controller.destroy() }
    }

    @Test fun destroyingAnOldRunCannotDisableANewExplicitStart() {
        app.background.start()
        val intent = shadowOf(app).nextStartedService
        val controller = Robolectric.buildService(BackgroundService::class.java).create()
        controller.get().onStartCommand(intent, 0, 1)
        app.background.stop()
        app.background.start()
        controller.destroy()
        dispatcher.scheduler.runCurrent()
        assertTrue(app.background.state.value.enabled)
        assertTrue(app.background.state.value.starting)
    }

    @Test @Config(sdk = [35])
    fun manifestUsesAnUnexportedSpecialUseServiceNotAnUnlimitedDataSyncService() {
        val info = app.packageManager.getServiceInfo(ComponentName(app, BackgroundService::class.java), 0)
        assertFalse(info.exported)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE, info.foregroundServiceType)
    }

    @Test fun disabledNotificationsOrBlockedChannelsPreventStartup() {
        val manager = app.getSystemService(NotificationManager::class.java)
        shadowOf(manager).setNotificationsEnabled(false)
        assertThrows(IllegalStateException::class.java) { app.background.start() }
        assertNull(shadowOf(app).nextStartedService)
        assertFalse(app.background.state.value.enabled)
        shadowOf(manager).setNotificationsEnabled(true)
        manager.deleteNotificationChannel(Notifications.BACKGROUND_CHANNEL)
        manager.createNotificationChannel(NotificationChannel(Notifications.BACKGROUND_CHANNEL, "Blocked", NotificationManager.IMPORTANCE_NONE))
        assertThrows(IllegalStateException::class.java) { app.background.start() }
        assertNull(shadowOf(app).nextStartedService)
    }

    @Test fun losingNotificationPermissionStopsTheModeInsteadOfClaimingReception() {
        app.background.start()
        shadowOf(app.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
        app.background.checkPermissions()
        assertFalse(app.background.state.value.enabled)
        assertNotNull(app.background.state.value.error)
    }

    @Test fun noticesAreGenericScopedAndReplaceOnlyTheSameSessionsCard() {
        val scope = Scope("account", "host", "session")
        Notifications.showBackground(app, scope, SessionNotice("event", "attention"))
        val manager = app.getSystemService(NotificationManager::class.java)
        val first = manager.activeNotifications.single().notification
        assertFalse(first.extras.getString(Notification.EXTRA_TEXT).orEmpty().contains("session"))
        assertEquals(Notification.VISIBILITY_PRIVATE, first.visibility)
        val intent = shadowOf(first.contentIntent).savedIntent
        assertEquals(scope, WireJson.decodeFromString<Scope>(intent.getStringExtra(MainActivity.NOTIFICATION_SCOPE)!!))
        Notifications.showBackground(app, scope, SessionNotice("event", "attention"))
        assertEquals(1, manager.activeNotifications.size)
        assertTrue(manager.activeNotifications.single().notification.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        Notifications.showBackground(app, scope, SessionNotice("next", "status"))
        assertEquals(1, manager.activeNotifications.size)
        assertEquals(0, manager.activeNotifications.single().notification.flags and Notification.FLAG_ONLY_ALERT_ONCE)
        val another = scope.copy(accountId = "other-account")
        Notifications.showBackground(app, another, SessionNotice("event", "attention"))
        assertEquals(2, manager.activeNotifications.size)
        Notifications.clearBackgroundNotice(app, scope)
        assertEquals(1, manager.activeNotifications.size)
        Notifications.clearBackgroundNotices(app)
        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test fun cursorsAreIndependentFromUiHistoryAndRemovingARelayRemovesItsCheckpoints() = runBlocking {
        val scope = Scope("account", "host", "session")
        val other = scope.copy(accountId = "other")
        val store = BackgroundCheckpoints(app)
        val checkpoint = NoticeCheckpoint(cursor = 12, initialized = true, pending = SessionNotice("event", "status"))
        store.save(scope, checkpoint)
        store.save(other, checkpoint.copy(cursor = 20))
        assertEquals(checkpoint, BackgroundCheckpoints(app).load(scope))
        val history = dev.devpocket.app.data.LocalStore(app)
        try { assertEquals(0L, history.cursor(scope)) } finally { history.close() }
        store.retainAccounts(setOf(other.accountId))
        assertEquals(NoticeCheckpoint(), store.load(scope))
        assertEquals(20L, store.load(other).cursor)
    }
}
