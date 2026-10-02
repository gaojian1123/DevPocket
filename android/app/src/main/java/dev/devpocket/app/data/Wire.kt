package dev.devpocket.app.data

import java.net.URI
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

val WireJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    isLenient = false
}

@Serializable
data class Account(val id: String, val relayUrl: String, val token: String, val deviceId: String, val name: String) {
    override fun toString(): String = "Account(id=$id, relayUrl=$relayUrl, token=[REDACTED])"
}

@Serializable
data class Scope(val accountId: String, val hostId: String, val sessionId: String) {
    val key: String get() = "$accountId|$hostId|$sessionId"
}

@Serializable
data class Host(val id: String, val name: String, val online: Boolean, val lastSeen: Long)

@Serializable
data class Device(val id: String, val name: String)

@Serializable
data class Capabilities(
    val messages: Boolean = false, val abort: Boolean = false, val permissions: Boolean = false,
    val questions: Boolean = false, val models: Boolean = false, val files: Boolean = false, val git: Boolean = false,
)

@Serializable
data class SessionInfo(
    val hostId: String, val sessionId: String, val projectId: String, val projectName: String, val title: String,
    val cliVersion: String, val state: String, val permissionMode: String, val modelId: String,
    val reasoningEffort: String = "", val capabilities: Capabilities, val warnings: List<String> = emptyList(),
    val registeredAt: Long, val online: Boolean, val pinned: Boolean, val archived: Boolean, val lastSeen: Long,
)

@Serializable
data class Catalog(
    val device: Device, val hosts: List<Host>, val sessions: List<SessionInfo>,
    val pushConfigured: Boolean, val protocol: Int,
)

@Serializable
data class WireError(val code: String, val message: String)

@Serializable
data class Receipt(
    val commandId: String, val status: String, val result: JsonObject? = null, val error: WireError? = null,
)

@Serializable
data class WireEvent(
    val id: String, val at: String, val kind: String, val data: JsonObject,
    val cursor: Long, val hostId: String, val sessionId: String,
)

@Serializable
data class EventPage(
    val events: List<WireEvent>, val cursor: Long, val hasMore: Boolean = false, val reset: Boolean = false,
)

@Serializable
data class PendingRequest(
    val requestId: String, val type: String, val title: String, val detail: String,
    val permissionKind: String? = null, val choices: List<String> = emptyList(),
    val allowFreeform: Boolean = false, val supported: Boolean = false,
)

@Serializable
data class Attachment(val id: String, val name: String, val mime: String, val size: Long, val sha256: String)

@Serializable
data class Draft(val text: String = "", val revision: Long = 0, val attachments: List<Attachment> = emptyList())

object DraftLogic {
    fun afterStaging(current: Draft, sent: Draft): Draft =
        if (current.revision == sent.revision) Draft(revision = sent.revision + 1) else current
}

fun acceptDelivery(current: String, incoming: String): String {
    if (current in setOf("completed", "cancelled", "failed", "uncertain")) return current
    if (current == "processing" && incoming in setOf("dispatched", "admitted", "queued")) return current
    if (current == "queued" && incoming in setOf("dispatched", "admitted")) return current
    if (current == "admitted" && incoming == "dispatched") return current
    return incoming
}

@Serializable
sealed interface Action {
    @Serializable @SerialName("message")
    data class Message(val text: String, val attachmentIds: List<String> = emptyList()) : Action
    @Serializable @SerialName("abort")
    data object Abort : Action
    @Serializable @SerialName("permission")
    data class Permission(val requestId: String, val decision: String) : Action
    @Serializable @SerialName("answer")
    data class Answer(val requestId: String, val answer: String) : Action
    @Serializable @SerialName("models")
    data object Models : Action
    @Serializable @SerialName("model.set")
    data class SetModel(val modelId: String, val reasoningEffort: String? = null) : Action
    @Serializable @SerialName("files.list")
    data class ListFiles(val path: String) : Action
    @Serializable @SerialName("files.read")
    data class ReadFile(val path: String) : Action
    @Serializable @SerialName("git.status")
    data object GitStatus : Action
    @Serializable @SerialName("git.diff")
    data class GitDiff(val path: String, val staged: Boolean) : Action
    @Serializable @SerialName("refresh")
    data object Refresh : Action
}

@Serializable
data class Command(val commandId: String, val action: Action)

@Serializable
data class Outbox(
    val scope: Scope, val command: Command, val status: String, val createdAt: Long,
    val receipt: Receipt? = null, val error: String? = null,
    val attachments: List<Attachment> = emptyList(),
)

@Serializable
data class FileEntry(val name: String, val path: String, val directory: Boolean)

@Serializable
data class FilePreview(
    val path: String = "", val name: String, val mime: String, val size: Long, val encoding: String, val content: String,
)

@Serializable
data class GitFile(val path: String, val index: String, val worktree: String)

@Serializable
data class GitInfo(val branch: String, val files: List<GitFile>, val truncated: Boolean = false)

@Serializable
data class ModelOption(val id: String, val name: String, val reasoningEfforts: List<String>, val enabled: Boolean, val reasoningManual: Boolean = false)

object RelayAddress {
    fun validate(value: String, debug: Boolean): String {
        val uri = URI(value.trim())
        require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null)
        require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
        require(uri.scheme == "https" || (debug && uri.scheme == "http" && uri.host in setOf("10.0.2.2", "127.0.0.1", "localhost")))
        require(uri.port == -1 || uri.port in 1..65535)
        return uri.toASCIIString().trimEnd('/')
    }
}

data class TimelineItem(
    val id: String, val role: String, val text: String, val at: String,
    val streaming: Boolean = false, val name: String = "", val attachments: List<String> = emptyList(),
)

fun JsonObject.text(name: String): String = get(name)?.jsonPrimitive?.contentOrNull.orEmpty()

fun timeline(events: List<WireEvent>): List<TimelineItem> {
    val result = linkedMapOf<String, TimelineItem>()
    for (event in events.sortedBy { it.cursor }) {
        val data = event.data
        when (event.kind) {
            "user.message" -> {
                val id = "user:${data.text("messageId")}"
                val names = data["attachments"]?.let { WireJson.decodeFromJsonElement<List<String>>(it) }.orEmpty()
                result[id] = TimelineItem(id, "user", data.text("content"), event.at, attachments = names)
            }
            "assistant.delta", "assistant.message" -> {
                val id = "assistant:${data.text("messageId")}"
                if (event.kind == "assistant.message" || result[id]?.streaming != false)
                    result[id] = TimelineItem(id, "assistant", data.text("content"), event.at, event.kind == "assistant.delta")
            }
            "tool.start", "tool.output" -> {
                val id = "tool:${data.text("toolCallId")}"
                val previous = result[id]
                result[id] = TimelineItem(
                    id, "tool", data.text("text"), event.at,
                    event.kind == "tool.start" || data.text("complete") == "false",
                    if (event.kind == "tool.start") data.text("name") else previous?.name.orEmpty(),
                )
            }
            "notice" -> result[event.id] = TimelineItem(event.id, "notice", data.text("message"), event.at)
        }
    }
    return result.values.toList()
}
