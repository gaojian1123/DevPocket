package dev.devpocket.app.background

import android.content.Context
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.WireJson
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class BackgroundCheckpoints(context: Context) : NoticeCheckpointStore {
    private val prefs = context.getSharedPreferences("devpocket_background_checkpoints", Context.MODE_PRIVATE)

    override suspend fun load(scope: Scope): NoticeCheckpoint = withContext(Dispatchers.IO) {
        prefs.getString(scope.key, null)?.let { WireJson.decodeFromString<NoticeCheckpoint>(it) } ?: NoticeCheckpoint()
    }

    override suspend fun save(scope: Scope, checkpoint: NoticeCheckpoint) = withContext(Dispatchers.IO) {
        val editor = prefs.edit()
        editor.putString(scope.key, WireJson.encodeToString(checkpoint))
        if (!editor.commit())
            throw IOException("无法保存后台提醒游标，提醒可能重复；请检查本机存储。")
    }

    override suspend fun remove(scope: Scope) = withContext(Dispatchers.IO) {
        val editor = prefs.edit()
        editor.remove(scope.key)
        if (!editor.commit()) throw IOException("无法清除后台提醒游标。")
    }

    suspend fun retainAccounts(accountIds: Set<String>) = withContext(Dispatchers.IO) {
        val removed = prefs.all.keys.filter { it.substringBefore('|') !in accountIds }
        if (removed.isNotEmpty()) {
            val editor = prefs.edit()
            removed.forEach { editor.remove(it) }
            if (!editor.commit()) throw IOException("无法清除已移除中转的后台提醒缓存。")
        }
    }
}
