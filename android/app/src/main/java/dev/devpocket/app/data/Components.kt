package dev.devpocket.app.data

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

const val COMPONENT_VERSION = 1
const val MAX_COMPONENT_BYTES = 256 * 1024
const val MAX_COMPONENT_PAYLOAD = ((MAX_COMPONENT_BYTES + 2) / 3) * 4

@Serializable
data class ComponentReference(val componentId: String, val sha256: String) {
    init {
        require(componentId.isNotBlank() && componentId.length <= 200)
        require(Regex("[a-f0-9]{64}").matches(sha256))
    }
}

@Serializable
data class ComponentSelection(val reference: ComponentReference, val title: String) {
    init { require(title.length <= 200) }
}

@Serializable
data class ComponentCard(
    val componentId: String, val toolCallId: String, val version: Int, val status: String,
    val encoding: String? = null, val payload: String? = null, val sha256: String? = null,
    val redacted: Boolean = false, val error: WireError? = null, val originatingMessageId: String? = null,
) {
    init {
        require(componentId.isNotBlank() && componentId.length <= 200 && toolCallId.isNotBlank() && toolCallId.length <= 200)
        require(version == COMPONENT_VERSION && status in setOf("ready", "unavailable"))
        require(originatingMessageId == null || originatingMessageId.isNotBlank() && originatingMessageId.length <= 200)
        if (status == "ready") {
            require(encoding == "base64-json" && payload != null && payload.length <= MAX_COMPONENT_PAYLOAD)
            require(sha256 != null && Regex("[a-f0-9]{64}").matches(sha256) && error == null)
        } else require(error != null && error.code.length <= 80 && error.message.length <= 2000 &&
            payload == null && sha256 == null && encoding == null)
    }

    @Transient
    val spec: JsonObject? = if (status == "ready") decodeComponentPayload(payload!!, sha256!!) else null

    val title: String get() = spec?.stringValue("title")?.takeIf { it.isNotBlank() } ?: when (spec?.stringValue("type")) {
        "line", "bar" -> "图表"
        "datagrid" -> "数据表格"
        "markdown" -> "说明"
        else -> "可视化内容"
    }

    fun selection(): ComponentSelection {
        require(status == "ready" && sha256 != null)
        return ComponentSelection(ComponentReference(componentId, sha256), title)
    }
}

fun JsonObject.stringValue(name: String): String? = (get(name) as? JsonPrimitive)
    ?.takeIf { it.isString }?.content

private fun JsonObject.origin(): String? = stringValue("originatingMessageId")?.takeIf { it.isNotBlank() && it.length <= 200 }

fun decodeComponentPayload(payload: String, expectedHash: String): JsonObject {
    require(payload.length <= MAX_COMPONENT_PAYLOAD) { "组件超过显示上限。" }
    val bytes = Base64.getDecoder().decode(payload)
    require(bytes.size <= MAX_COMPONENT_BYTES && Base64.getEncoder().encodeToString(bytes) == payload) { "组件编码无效。" }
    val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    require(hash == expectedHash) { "组件内容校验失败。" }
    val text = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    } catch (error: CharacterCodingException) {
        throw IllegalArgumentException("组件不是有效的 UTF-8 内容。", error)
    }
    val spec = WireJson.parseToJsonElement(text) as? JsonObject ?: throw IllegalArgumentException("组件内容不是对象。")
    require(spec.stringValue("type") in setOf("line", "bar", "datagrid", "markdown")) { "组件类型不受支持。" }
    require(spec.stringValue("title")?.length?.let { it <= 200 } != false)
    if (spec.stringValue("type") == "datagrid") {
        require((spec["rows"] as? JsonArray)?.size?.let { it <= 1000 } == true)
        require((spec["columns"] as? JsonArray)?.size?.let { it in 1..20 } == true)
    }
    if (spec.stringValue("type") in setOf("line", "bar")) {
        val rows = (spec["data"] as? JsonArray)?.size ?: throw IllegalArgumentException("图表数据缺失。")
        val series = (spec["series"] as? JsonArray)?.size ?: throw IllegalArgumentException("图表系列缺失。")
        require(series in 1..1000 && rows <= 1000 && rows.toLong() * series <= 1000)
    }
    return spec
}

fun componentCard(event: WireEvent): ComponentCard = event.component ?: invalidComponent(event)

internal fun decodeComponentCard(event: WireEvent): ComponentCard {
    try { return WireJson.decodeFromJsonElement<ComponentCard>(event.data) }
    catch (error: SerializationException) { return invalidComponent(event) }
    catch (error: IllegalArgumentException) { return invalidComponent(event) }
}

private fun invalidComponent(event: WireEvent) = ComponentCard(
    componentId = "invalid-component:${event.cursor}", toolCallId = "invalid-component:${event.cursor}",
    version = COMPONENT_VERSION, status = "unavailable",
    error = WireError("COMPONENT_INVALID", "组件内容无法校验，请在原始客户端查看。"),
)

class ResponseOrigins(events: List<WireEvent>) {
    private val messages = mutableMapOf<String, String?>()
    private val tools = mutableMapOf<String, String?>()

    init {
        for (event in events) {
            if (event.kind != "assistant.message") continue
            val origin = event.data.origin() ?: continue
            val messageId = event.data.stringValue("messageId") ?: continue
            remember(messages, messageId, origin)
            val links = event.data["toolCallIds"] as? JsonArray ?: continue
            if (links.size > 128) continue
            val ids = links.map { (it as? JsonPrimitive)?.takeIf { id -> id.isString }?.content }
            if (ids.any { it.isNullOrBlank() || it.length > 200 }) continue
            for (id in ids.filterNotNull()) remember(tools, id, origin)
        }
    }

    private fun remember(target: MutableMap<String, String?>, id: String, origin: String) {
        target[id] = if (!target.containsKey(id) || target[id] == origin) origin else null
    }

    fun message(id: String): String? = messages[id]
    fun tool(id: String, explicit: String?): String? =
        if (tools.containsKey(id)) tools[id]?.takeIf { explicit == null || explicit == it } else explicit
}

fun sameResponse(left: TimelineItem?, right: TimelineItem?): Boolean =
    left != null && right != null && left.originatingMessageId != null &&
        left.originatingMessageId == right.originatingMessageId &&
        left.role in setOf("assistant", "tool", "component") && right.role in setOf("assistant", "tool", "component")
