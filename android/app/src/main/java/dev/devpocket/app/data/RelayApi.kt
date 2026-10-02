package dev.devpocket.app.data

import dev.devpocket.app.BuildConfig
import dev.devpocket.app.background.SessionEventSource
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class ApiFailure(val status: Int, val detail: WireError) : IOException("${detail.code}: ${detail.message}")
private data class Payload(val status: Int, val headers: Headers, val bytes: ByteArray)
data class Download(val name: String, val mime: String, val bytes: ByteArray)

class RelayApi(val account: Account) : SessionEventSource {
    private val base = RelayAddress.validate(account.relayUrl, BuildConfig.ALLOW_EMULATOR_HTTP).toHttpUrl()
    private fun path(vararg segments: String): HttpUrl = base.newBuilder().apply { segments.forEach(::addPathSegment) }.build()
    private fun sessionPath(scope: Scope, vararg segments: String): HttpUrl {
        require(scope.accountId == account.id) { "A session cannot use another relay's credential." }
        return path("v1", "hosts", scope.hostId, "sessions", scope.sessionId, *segments)
    }
    private fun request(url: HttpUrl, method: String = "GET", json: JsonObject? = null): Request =
        Request.Builder().url(url).header("Authorization", "Bearer ${account.token}")
            .method(method, json?.toString()?.toRequestBody(JSON_MEDIA)).build()

    override suspend fun catalog(): Catalog {
        val catalog = WireJson.decodeFromJsonElement<Catalog>(json(request(path("v1", "catalog"))))
        if (catalog.protocol != 1) throw ApiFailure(409, WireError("PROTOCOL_VERSION", "请升级 DevPocket：中转协议版本不兼容。"))
        return catalog
    }

    override suspend fun events(scope: Scope, after: Long): EventPage =
        WireJson.decodeFromJsonElement(json(request(sessionPath(scope, "events").newBuilder()
            .addQueryParameter("after", after.toString()).build())))

    suspend fun submit(scope: Scope, command: Command): Receipt =
        WireJson.decodeFromJsonElement(json(request(sessionPath(scope, "commands"), "POST",
            WireJson.encodeToJsonElement(command).jsonObject)))

    suspend fun receipt(scope: Scope, commandId: String): Receipt =
        WireJson.decodeFromJsonElement(json(request(sessionPath(scope, "commands", commandId))))

    suspend fun metadata(scope: Scope, patch: JsonObject): SessionInfo =
        WireJson.decodeFromJsonElement(json(request(sessionPath(scope, "metadata"), "PATCH", patch)))

    suspend fun revoke(hostId: String) {
        json(request(path("v1", "grants", hostId), "DELETE"))
    }

    suspend fun registerPush(token: String?) {
        json(request(path("v1", "push-token"), "PUT", buildJsonObject { put("provider", "fcm"); put("token", token) }))
    }

    suspend fun attachments(scope: Scope): List<Attachment> {
        val result = json(request(sessionPath(scope, "attachments")))
        return WireJson.decodeFromJsonElement(result.getValue("attachments"))
    }

    suspend fun upload(scope: Scope, name: String, mime: String, bytes: ByteArray): Attachment {
        require(bytes.isNotEmpty() && bytes.size <= 2 * 1024 * 1024) { "附件大小必须在 1 字节到 2 MiB 之间。" }
        val req = Request.Builder().url(sessionPath(scope, "attachments"))
            .header("Authorization", "Bearer ${account.token}")
            .header("X-File-Name", URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
            .post(bytes.toRequestBody(mime.toMediaType())).build()
        return try { WireJson.decodeFromJsonElement(json(req)) }
        catch (error: IOException) {
            if (error is ApiFailure) throw error
            throw ApiFailure(0, WireError("UPLOAD_UNCERTAIN", "上传结果未确认。请先刷新会话附件，确认是否已存在；应用不会自动重传。"))
        }
    }

    suspend fun download(scope: Scope, attachment: Attachment): Download {
        val result = fetch(request(sessionPath(scope, "attachments", attachment.id)), 2 * 1024 * 1024)
        checkResponse(result)
        val checksum = MessageDigest.getInstance("SHA-256").digest(result.bytes).joinToString("") { "%02x".format(it) }
        if (checksum != attachment.sha256 || checksum != result.headers["X-Content-Sha256"])
            throw ApiFailure(409, WireError("ATTACHMENT_CORRUPT", "附件校验失败，未打开文件。"))
        return Download(attachment.name, attachment.mime, result.bytes)
    }

    override fun stream(scope: Scope, after: Long, onOpen: () -> Unit): Flow<EventPage> = callbackFlow {
        require(scope.accountId == account.id)
        val url = path("v1", "events").newBuilder()
            .addQueryParameter("hostId", scope.hostId).addQueryParameter("sessionId", scope.sessionId)
            .addQueryParameter("after", after.toString()).build()
        val socket = client.newWebSocket(request(url), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { onOpen() }
            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    require(text.length <= 4 * 1024 * 1024) { "事件帧超过大小限制。" }
                    val frame = WireJson.parseToJsonElement(text).jsonObject
                    if (frame.text("type") != "events") throw IOException("中转返回了不支持的事件帧。")
                    val page = WireJson.decodeFromJsonElement<EventPage>(frame)
                    if (!trySend(page).isSuccess) close(IOException("接收缓冲已满，正在重新同步。"))
                } catch (error: Exception) {
                    close(error)
                    webSocket.close(1008, "Invalid protocol frame")
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val status = response?.code
                close(when {
                    status == 401 || status == 403 -> ApiFailure(status, WireError("UNAUTHORIZED", "配对凭据无效或已被撤销。"))
                    status == 429 -> ApiFailure(status, WireError("TOO_MANY_STREAMS", "中转实时连接额度已满。"))
                    else -> t
                })
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                close(if (code == 4003) ApiFailure(403, WireError("FORBIDDEN", "这台设备的配对已被撤销。"))
                else IOException("连接已断开，将恢复历史记录。"))
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
        })
        awaitClose { socket.cancel() }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
        private val client = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS).retryOnConnectionFailure(false)
            .followRedirects(false).followSslRedirects(false).build()
        private val idempotentClient = client.newBuilder().retryOnConnectionFailure(true).build()

        suspend fun pair(url: String, code: String, name: String, existing: Account?): Account {
            val origin = RelayAddress.validate(url, BuildConfig.ALLOW_EMULATOR_HTTP)
            require(code.matches(Regex("dpp_[A-Za-z0-9_-]{43}"))) { "请输入 Dev Box 生成的一次性配对码。" }
            require(name.isNotBlank() && name.length <= 80)
            require(existing == null || existing.relayUrl == origin)
            val request = Request.Builder().url("$origin/v1/pair")
                .post(buildJsonObject { put("code", code); put("name", name.trim()) }.toString().toRequestBody(JSON_MEDIA))
                .apply { if (existing != null) header("Authorization", "Bearer ${existing.token}") }.build()
            val paired = try { json(request) }
            catch (error: IOException) {
                if (error is ApiFailure) throw error
                throw ApiFailure(0, WireError("PAIRING_UNCERTAIN", "配对结果未确认，应用不会自动创建新身份。请在 Dev Box 检查并撤销未确认设备，再生成新配对码。"))
            }
            val token = paired.text("token").ifEmpty { existing?.token.orEmpty() }
            require(token.startsWith("dpd_") && paired.text("deviceId").isNotEmpty()) { "中转未返回有效设备凭据。" }
            return Account(existing?.id ?: UUID.randomUUID().toString(), origin, token, paired.text("deviceId"), name.trim())
        }

        private suspend fun json(request: Request): JsonObject {
            val result = fetch(request)
            checkResponse(result)
            return WireJson.parseToJsonElement(result.bytes.toString(Charsets.UTF_8)).jsonObject
        }

        private fun checkResponse(result: Payload) {
            if (result.status in 200..299) return
            val error = runCatching {
                val value = WireJson.parseToJsonElement(result.bytes.toString(Charsets.UTF_8)).jsonObject.getValue("error")
                WireJson.decodeFromJsonElement<WireError>(value)
            }.getOrElse { WireError("HTTP_${result.status}", "中转请求失败，请检查地址、HTTPS 和配对状态。") }
            throw ApiFailure(result.status, error)
        }

        private suspend fun fetch(request: Request, maxBytes: Int = 4 * 1024 * 1024): Payload = suspendCancellableCoroutine { continuation ->
            val replaySafe = request.method == "GET" ||
                (request.method == "POST" && request.url.encodedPath.endsWith("/commands"))
            val call = (if (replaySafe) idempotentClient else client).newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWith(Result.failure(e))
                }
                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching {
                        response.use {
                            val body = it.body ?: throw IOException("中转返回了空响应。")
                            if (body.contentLength() > maxBytes) throw IOException("响应超过安全大小限制。")
                            val output = ByteArrayOutputStream()
                            body.byteStream().use { input ->
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val read = input.read(buffer)
                                    if (read == -1) break
                                    if (output.size() + read > maxBytes) throw IOException("响应超过安全大小限制。")
                                    output.write(buffer, 0, read)
                                }
                            }
                            Payload(it.code, it.headers, output.toByteArray())
                        }
                    }
                    if (continuation.isActive) continuation.resumeWith(result)
                }
            })
        }
    }
}
