package dev.devpocket.app

import android.app.Application
import dev.devpocket.app.background.BackgroundMode
import dev.devpocket.app.push.Notifications
import dev.devpocket.app.push.PushSetup

class DevPocketApplication : Application() {
    val background by lazy { BackgroundMode(this) }

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        PushSetup.initialize(this)
    }
}
