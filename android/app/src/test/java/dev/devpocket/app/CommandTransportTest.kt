package dev.devpocket.app

import dev.devpocket.app.data.Account
import dev.devpocket.app.data.Action
import dev.devpocket.app.data.Command
import dev.devpocket.app.data.RelayApi
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.ApiFailure
import dev.devpocket.app.data.WireJson
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandTransportTest {
    @Test fun pushRegistrationUsesExplicitFidsAndLegacyRelayRejectionIsVisible() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setBody("""{"registered":true,"provider":"fcm-fid"}"""))
            server.enqueue(MockResponse().setBody("""{"registered":false,"provider":"fcm-fid"}"""))
            server.enqueue(MockResponse().setResponseCode(400).setBody(
                """{"error":{"code":"INVALID_REQUEST","message":"Relay upgrade required"}}"""))
            val account = Account("account", server.url("/").toString().trimEnd('/'), "test-only-credential", "device", "Test")
            val api = RelayApi(account)
            val fid = "c" + "a".repeat(21)
            api.registerPush(fid)
            val registered = server.takeRequest()
            assertEquals("PUT", registered.method)
            assertEquals("/v1/push-token", registered.path)
            assertEquals("Bearer test-only-credential", registered.getHeader("Authorization"))
            val body = WireJson.parseToJsonElement(registered.body.readUtf8()).jsonObject
            assertEquals(setOf("provider", "fid"), body.keys)
            assertEquals("fcm-fid", body.getValue("provider").jsonPrimitive.content)
            assertEquals(fid, body.getValue("fid").jsonPrimitive.content)
            api.registerPush(null)
            assertEquals(JsonNull, WireJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject["fid"])
            assertTrue(runCatching { api.registerPush(fid) }.exceptionOrNull() is ApiFailure)
            assertEquals(3, server.requestCount)
        }
    }

    @Test fun lostCommandResponseRetriesTheSameImmutableCommandId() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val id = UUID.randomUUID().toString()
            server.enqueue(MockResponse().setBody("""{"device":{"id":"device","name":"Test"},"hosts":[],"sessions":[],"pushConfigured":false,"protocol":1}"""))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setBody("""{"commandId":"$id","status":"completed","result":{"resolved":true}}"""))
            val account = Account("account", server.url("/").toString().trimEnd('/'), "test-only-credential", "device", "Test")
            val api = RelayApi(account)
            api.catalog()
            val result = api.submit(Scope("account", UUID.randomUUID().toString(), UUID.randomUUID().toString()),
                Command(id, Action.Permission("request", "approve-once")))
            assertEquals("completed", result.status)
            server.takeRequest()
            val initial = server.takeRequest()
            val retry = server.takeRequest()
            assertEquals("POST", initial.method)
            assertEquals(initial.path, retry.path)
            assertEquals(initial.body.readUtf8(), retry.body.readUtf8())
            assertEquals(3, server.requestCount)
        }
    }

    @Test fun oneTimePairingIsNotBlindlyRetriedAfterLosingItsResponse() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setBody("""{"device":{"id":"device","name":"Test"},"hosts":[],"sessions":[],"pushConfigured":false,"protocol":1}"""))
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"PAIRING_INVALID","message":"Already consumed"}}"""))
            val origin = server.url("/").toString().trimEnd('/')
            RelayApi(Account("account", origin, "test-only-credential", "device", "Test")).catalog()
            val failure = runCatching { RelayApi.pair(origin, "dpp_" + "x".repeat(43), "Test", null) }.exceptionOrNull()
            assertTrue(failure is java.io.IOException)
            assertEquals(2, server.requestCount)
        }
    }
}
