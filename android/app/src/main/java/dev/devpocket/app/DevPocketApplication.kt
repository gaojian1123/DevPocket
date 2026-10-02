package dev.devpocket.app

import android.app.Application
import dev.devpocket.app.push.Notifications
import dev.devpocket.app.push.PushSetup

class DevPocketApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        PushSetup.initialize(this)
    }
}
