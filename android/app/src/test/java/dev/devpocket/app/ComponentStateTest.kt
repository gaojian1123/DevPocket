package dev.devpocket.app

import dev.devpocket.app.data.*
import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ComponentStateTest {
    private val scope = Scope("account", "host", "session")
    private val at = "2026-10-19T00:00:00Z"
    private fun event(kind: String, cursor: Long, data: JsonObject, host: String = scope.hostId) =
        WireEvent("event-$cursor", at, kind, data, cursor, host, scope.sessionId)

    private fun componentData(content: String = "A visible card", origin: String? = "user-A"): JsonObject {
        val spec = buildJsonObject { put("type", "markdown"); put("title", "Notes"); put("content", content) }
        val bytes = spec.toString().toByteArray(Charsets.UTF_8)
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return buildJsonObject {
            put("componentId", "card-1"); put("toolCallId", "render-1"); put("version", 1)
            put("status", "ready"); put("encoding", "base64-json")
            put("payload", Base64.getEncoder().encodeToString(bytes)); put("sha256", sha); put("redacted", false)
            if (origin != null) put("originatingMessageId", origin)
        }
    }

    @Test fun componentBytesAreVerifiedBeforeDisplayOrReference() {
        val wire = event("component", 1, componentData("中文与 Unicode 内容"))
        val card = componentCard(wire)
        assertEquals("ready", card.status)
        assertEquals("中文与 Unicode 内容", card.spec?.text("content"))
        assertEquals("card-1", card.selection().reference.componentId)
        assertFalse(WireJson.encodeToString(wire).contains("\"component\":"))
        val tampered = JsonObject(wire.data + ("sha256" to JsonPrimitive("0".repeat(64))))
        assertEquals("unavailable", componentCard(event("component", 2, tampered)).status)
        val invalid = JsonObject(wire.data + ("payload" to JsonPrimitive("!not-base64!")))
        assertEquals("unavailable", componentCard(event("component", 3, invalid)).status)
    }

    @Test fun ordinaryMessageEncodingStaysCompatibleAndReferencesAreExplicit() {
        val plain = WireJson.encodeToString< Action >(Action.Message("Hello"))
        assertFalse(plain.contains("componentReference"))
        val reference = componentCard(event("component", 1, componentData())).selection().reference
        val quoted = WireJson.encodeToString<Action>(Action.Message("Explain this", componentReference = reference))
        assertTrue(quoted.contains("componentReference"))
        assertEquals(reference, (WireJson.decodeFromString<Action>(quoted) as Action.Message).componentReference)
    }

    @Test fun addingAReferencePreservesTheDraftAndConsumesOneAttachmentSlot() {
        val reference = componentCard(event("component", 1, componentData())).selection()
        val attachment = Attachment("file", "note.txt", "text/plain", 4, "a".repeat(64))
        val draft = Draft("Keep my question", 5, listOf(attachment))
        val selected = draft.copy(componentReference = reference, revision = 6)
        assertEquals(draft.text, selected.text)
        assertEquals(draft.attachments, selected.attachments)
        assertEquals(2, selected.attachmentCount)
        assertEquals(selected, WireJson.decodeFromString<Draft>(WireJson.encodeToString(selected)))
        assertEquals(selected, DraftLogic.afterStaging(selected, draft))
        assertNull(DraftLogic.afterStaging(selected, selected).componentReference)
    }

    @Test fun componentsReplaceOnlyTheirOwnToolRowAndLateToolUpdatesDoNotRemoveThem() {
        val start = event("tool.start", 1, buildJsonObject {
            put("toolCallId", "render-1"); put("name", "invoke_canvas_action"); put("text", "Rendering")
            put("originatingMessageId", "user-A")
        })
        val card = event("component", 2, componentData())
        val complete = event("tool.output", 3, buildJsonObject {
            put("toolCallId", "render-1"); put("text", "Done"); put("complete", true); put("success", true)
        })
        val items = timeline(listOf(start, card, complete), scope = scope)
        assertEquals(1, items.size)
        assertEquals("component", items.single().role)
        assertEquals(1L, items.single().cursor)
        assertEquals("card-1", items.single().component?.componentId)
        assertEquals("user-A", items.single().originatingMessageId)
        assertTrue(timeline(listOf(card.copy(hostId = "another-host")), scope = scope).isEmpty())
    }

    @Test fun responseGroupingUsesEvidenceAndNeverMovesContentAcrossAnotherUserMessage() {
        fun assistant(id: String, origin: String?, cursor: Long) = event("assistant.message", cursor, buildJsonObject {
            put("messageId", id); put("content", id)
            if (origin != null) put("originatingMessageId", origin)
        })
        val events = listOf(assistant("part-1", "user-A", 1), assistant("part-2", "user-A", 2),
            event("user.message", 3, buildJsonObject {
                put("messageId", "user-B"); put("content", "Queued question"); put("attachments", JsonArray(emptyList()))
            }), assistant("part-3", "user-A", 4), assistant("unlinked", null, 5))
        val items = timeline(events, scope = scope)
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), items.map { it.cursor })
        assertTrue(sameResponse(items[0], items[1]))
        assertFalse(sameResponse(items[1], items[2]))
        assertFalse(sameResponse(items[2], items[3]))
        assertFalse(sameResponse(items[3], items[4]))
    }

    @Test fun conflictingToolOwnersDoNotProduceAResponseGroup() {
        fun owner(origin: String, cursor: Long) = event("assistant.message", cursor, buildJsonObject {
            put("messageId", "owner-$origin"); put("content", "")
            put("originatingMessageId", origin); put("toolCallIds", JsonArray(listOf(JsonPrimitive("render-1"))))
        })
        val items = timeline(listOf(owner("A", 1), owner("B", 2), event("component", 3, componentData())), scope = scope)
        assertEquals(1, items.size)
        assertNull(items.single().originatingMessageId)
    }
}
