package dev.devpocket.app

import dev.devpocket.app.data.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class WireContractTest {
    @Test fun sharedV1CorpusDecodesWithExplicitCompatibilityExpectations() {
        val source = checkNotNull(javaClass.getResourceAsStream("/protocol/v1.json")) {
            "Shared protocol corpus is missing from the JVM test resources."
        }.bufferedReader().use { it.readText() }
        val samples = WireJson.parseToJsonElement(source).jsonArray
        assertTrue(samples.size >= 6)
        for (sample in samples.map { it.jsonObject }) {
            val id = sample.getValue("id").jsonPrimitive.content
            val wire = sample.getValue("wire").jsonObject
            val result = runCatching {
                when (sample.getValue("shape").jsonPrimitive.content) {
                    "command" -> WireJson.decodeFromJsonElement<Command>(wire)
                    "session" -> WireJson.decodeFromJsonElement<SessionInfo>(wire)
                    "request" -> WireJson.decodeFromJsonElement<PendingRequest>(wire)
                    "receipt" -> WireJson.decodeFromJsonElement<Receipt>(wire)
                    "question" -> WireJson.decodeFromJsonElement<QuestionRecord>(wire)
                    "component" -> WireJson.decodeFromJsonElement<ComponentCard>(wire)
                    else -> error("Unknown shared sample shape: $id")
                }
            }
            assertEquals(id, sample.getValue("androidValid").jsonPrimitive.boolean, result.isSuccess)
            when (val value = result.getOrNull()) {
                is Command -> {
                    val persisted = WireJson.decodeFromString<Command>(WireJson.encodeToString(value))
                    assertEquals(id, value, persisted)
                    assertEquals(id, wire.getValue("commandId").jsonPrimitive.content, persisted.commandId)
                }
                is SessionInfo -> {
                    assertEquals(id, wire.getValue("sessionId").jsonPrimitive.content, value.sessionId)
                    if (id == "legacy-session-without-workspace") {
                        assertNull(value.workspace)
                        assertFalse(value.capabilities.messages)
                        assertTrue(value.capabilities.questions)
                    }
                    if (id == "workspace-session") assertEquals("", value.workspace?.branch)
                }
                is PendingRequest -> assertFalse(value.supportedBy(Capabilities(permissions = true, questions = true)))
                is Receipt -> assertEquals("uncertain", acceptDelivery(value.status, "completed"))
                is QuestionRecord -> assertEquals(value, WireJson.decodeFromString<QuestionRecord>(WireJson.encodeToString(value)))
                is ComponentCard -> {
                    assertEquals(value, WireJson.decodeFromString<ComponentCard>(WireJson.encodeToString(value)))
                    if (value.status == "ready") assertNotNull(value.spec)
                }
            }
        }
    }
}
