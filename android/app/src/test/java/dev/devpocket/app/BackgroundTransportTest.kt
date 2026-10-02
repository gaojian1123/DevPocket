package dev.devpocket.app

import dev.devpocket.app.background.BackgroundMonitor
import dev.devpocket.app.background.NoticeCheckpoint
import dev.devpocket.app.background.NoticeCheckpointStore
import dev.devpocket.app.background.SessionNotice
import dev.devpocket.app.data.Account
import dev.devpocket.app.data.ApiFailure
import dev.devpocket.app.data.Capabilities
import dev.devpocket.app.data.Catalog
import dev.devpocket.app.data.Device
import dev.devpocket.app.data.Host
import dev.devpocket.app.data.RelayApi
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.SessionInfo
import dev.devpocket.app.data.WireJson
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test

class BackgroundTransportTest {
    @Test fun realWebSocketsRespectTheRelayViewerLimitWhileOverflowStillReceivesNotices() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val account = Account("account", server.url("/").toString().trimEnd('/'), "fixture-only-token", "device", "Test")
            val scopes = (1..12).map { Scope(account.id, "host", "session-$it") }
            val catalog = Catalog(Device(account.deviceId, account.name), listOf(Host("host", "Host", true, 1)),
                scopes.map { SessionInfo(it.hostId, it.sessionId, "project", "Project", "Session", "1.0.90-0",
                    "idle", "manual", "model", capabilities = Capabilities(), registeredAt = 1,
                    online = true, pinned = false, archived = false, lastSeen = 1) }, false, 1)
            val active = AtomicInteger()
            val maximum = AtomicInteger()
            val rejected = AtomicInteger()
            val notices = Channel<Scope>(Channel.UNLIMITED)
            val requests = CopyOnWriteArrayList<RecordedRequest>()
            val lock = Any()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests.add(request)
                    val url = request.requestUrl!!
                    if (url.encodedPath == "/v1/catalog") return MockResponse().setBody(WireJson.encodeToString(catalog))
                    if (url.encodedPath.startsWith("/v1/hosts/host/sessions/") && url.encodedPath.endsWith("/events")) {
                        val session = url.pathSegments[4]
                        return MockResponse().setBody("""{"events":[{"id":"pending-$session","at":"2026-10-02T00:00:00Z","kind":"requests","data":{"items":[{"requestId":"pending","type":"question","title":"private","detail":"private","supported":true}]},"cursor":1,"hostId":"host","sessionId":"$session"}],"cursor":1,"hasMore":false,"reset":false}""")
                    }
                    if (url.encodedPath != "/v1/events") return MockResponse().setResponseCode(404)
                    synchronized(lock) {
                        if (active.get() >= 8) {
                            rejected.incrementAndGet()
                            return MockResponse().setResponseCode(429)
                        }
                        val inUse = active.incrementAndGet()
                        maximum.updateAndGet { maxOf(it, inUse) }
                    }
                    val released = AtomicBoolean()
                    fun release() { if (released.compareAndSet(false, true)) active.decrementAndGet() }
                    return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            webSocket.send("""{"type":"events","events":[],"cursor":1,"hasMore":false,"reset":false}""")
                        }
                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { release() }
                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { release() }
                    })
                }
            }
            val checkpoints = mutableMapOf<Scope, NoticeCheckpoint>()
            val store = object : NoticeCheckpointStore {
                override suspend fun load(scope: Scope) = checkpoints[scope] ?: NoticeCheckpoint()
                override suspend fun save(scope: Scope, checkpoint: NoticeCheckpoint) { checkpoints[scope] = checkpoint }
                override suspend fun remove(scope: Scope) { checkpoints.remove(scope) }
            }
            val monitor = BackgroundMonitor(::RelayApi, store, { scope, _ -> notices.send(scope) }, {})
            val background = launch { monitor.run(listOf(account)) }
            var foreground: Job? = null
            try {
                withTimeout(15_000) {
                    monitor.status.first { it.connected == 7 && it.polling == 5 }
                    val received = mutableSetOf<Scope>()
                    repeat(scopes.size) { received.add(notices.receive()) }
                    assertEquals(scopes.toSet(), received)
                    val ready = CompletableDeferred<Unit>()
                    foreground = this@runBlocking.launch {
                        try {
                            RelayApi(account).stream(scopes.first(), 1) { ready.complete(Unit) }.collect {}
                        } catch (error: CancellationException) { throw error }
                        catch (error: Exception) { ready.completeExceptionally(error) }
                    }
                    ready.await()
                    assertEquals(8, maximum.get())
                    assertEquals(8, active.get())
                    assertEquals(0, rejected.get())
                }
            } finally {
                foreground?.cancelAndJoin()
                background.cancelAndJoin()
            }
            assertTrue(requests.all { it.method == "GET" })
            assertTrue(requests.all { it.getHeader("Authorization") == "Bearer fixture-only-token" })
            assertEquals(8, requests.count { it.requestUrl!!.encodedPath == "/v1/events" })
        }
    }

    @Test fun websocketHandshakeQuotaRejectionPreservesItsStatusForPollingFallback() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setResponseCode(429))
            val account = Account("account", server.url("/").toString().trimEnd('/'), "fixture-only-token", "device", "Test")
            val failure = runCatching {
                withTimeout(5_000) { RelayApi(account).stream(Scope(account.id, "host", "session"), 0) {}.first() }
            }.exceptionOrNull()
            assertTrue(failure is ApiFailure)
            assertEquals(429, (failure as ApiFailure).status)
            assertEquals("TOO_MANY_STREAMS", failure.detail.code)
        }
    }

    @Test fun realWebSocketReconnectReplaysOnlyItsScopeWithoutIssuingCommands() = runBlocking {
        MockWebServer().use { server ->
            val requests = CopyOnWriteArrayList<RecordedRequest>()
            val sockets = Channel<WebSocket>(Channel.UNLIMITED)
            val notices = Channel<SessionNotice>(Channel.UNLIMITED)
            val values = mutableMapOf<Scope, NoticeCheckpoint>()
            val store = object : NoticeCheckpointStore {
                override suspend fun load(scope: Scope) = values[scope] ?: NoticeCheckpoint()
                override suspend fun save(scope: Scope, checkpoint: NoticeCheckpoint) { values[scope] = checkpoint }
                override suspend fun remove(scope: Scope) { values.remove(scope) }
            }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests.add(request)
                    val url = request.requestUrl!!
                    if (url.encodedPath == "/v1/catalog") return MockResponse().setBody(
                        """{"device":{"id":"device","name":"Test"},"hosts":[{"id":"host","name":"Host","online":true,"lastSeen":1}],"sessions":[{"hostId":"host","sessionId":"session","projectId":"project","projectName":"Project","title":"Session","cliVersion":"1.0.90-0","state":"idle","permissionMode":"manual","modelId":"model","capabilities":{},"registeredAt":1,"online":true,"pinned":false,"archived":false,"lastSeen":1}],"pushConfigured":false,"protocol":1}""")
                    if (url.encodedPath == "/v1/hosts/host/sessions/session/events") {
                        val events = if (url.queryParameter("after") == "0")
                            """[${event(1, "runtime.state", """{"state":"idle"}""")}]"""
                        else """[${event(3, "requests", """{"items":[]}""")},${event(4, "runtime.state", """{"state":"running"}""")},${event(5, "runtime.state", """{"state":"idle"}""")}]"""
                        val cursor = if (url.queryParameter("after") == "0") 1 else 5
                        return MockResponse().setBody("""{"events":$events,"cursor":$cursor,"hasMore":false,"reset":false}""")
                    }
                    if (url.encodedPath == "/v1/events") return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            webSocket.send("""{"type":"events","events":[],"cursor":${url.queryParameter("after")},"hasMore":false,"reset":false}""")
                            sockets.trySend(webSocket)
                        }
                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                    })
                    return MockResponse().setResponseCode(404)
                }
            }
            server.start()
            val account = Account("account", server.url("/").toString().trimEnd('/'), "fixture-only-token", "device", "Test")
            val monitor = BackgroundMonitor(::RelayApi, store, { _, notice -> notices.send(notice) }, {})
            val job = launch { monitor.run(listOf(account)) }
            try {
                withTimeout(15_000) {
                    val socket = sockets.receive()
                    assertTrue(notices.tryReceive().isFailure)
                    socket.send("""{"type":"events","events":[${event(2, "requests", """{"items":[{"requestId":"question","type":"question","title":"private-title","detail":"private-detail","supported":true}]}""")}],"cursor":2,"hasMore":false,"reset":false}""")
                    assertEquals(SessionNotice("event-2", "attention"), notices.receive())
                    socket.close(1001, "Simulated network change")
                    assertEquals(SessionNotice("event-5", "status"), notices.receive())
                    sockets.receive()
                    assertTrue(notices.tryReceive().isFailure)
                    assertEquals(5L, values.getValue(Scope(account.id, "host", "session")).cursor)
                }
            } finally { job.cancelAndJoin() }
            assertTrue(requests.all { it.method == "GET" })
            assertTrue(requests.all { it.getHeader("Authorization") == "Bearer fixture-only-token" })
            val subscriptions = requests.filter { it.requestUrl!!.encodedPath == "/v1/events" }.map { it.requestUrl!! }
            assertEquals(listOf("1", "5"), subscriptions.map { it.queryParameter("after") })
            assertTrue(subscriptions.all { it.queryParameter("hostId") == "host" && it.queryParameter("sessionId") == "session" })
        }
    }

    private fun event(cursor: Int, kind: String, data: String) =
        """{"id":"event-$cursor","at":"2026-10-02T00:00:00Z","kind":"$kind","data":$data,"cursor":$cursor,"hostId":"host","sessionId":"session"}"""
}
