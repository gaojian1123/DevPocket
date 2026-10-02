package dev.devpocket.app

import dev.devpocket.app.background.BackgroundMonitor
import dev.devpocket.app.background.NoticeCheckpoint
import dev.devpocket.app.background.NoticeCheckpointStore
import dev.devpocket.app.background.SessionNotice
import dev.devpocket.app.data.Account
import dev.devpocket.app.data.RelayApi
import dev.devpocket.app.data.Scope
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
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
