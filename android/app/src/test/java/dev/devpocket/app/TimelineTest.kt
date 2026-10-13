package dev.devpocket.app

import dev.devpocket.app.data.WireEvent
import dev.devpocket.app.data.text
import dev.devpocket.app.data.timeline
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TimelineTest {
    private fun event(cursor: Long, kind: String, data: JsonObject) = WireEvent(
        "event-$cursor", "2026-10-10T04:00:00.000Z", kind, data, cursor, "host", "session",
    )

    private fun assistant(cursor: Long, id: String, text: String, streaming: Boolean = false) =
        event(cursor, if (streaming) "assistant.delta" else "assistant.message", buildJsonObject {
            put("messageId", id)
            put("content", text)
        })

    @Test fun completedBlankAssistantMessagesDoNotCreateChatRows() {
        val events = listOf(
            assistant(1, "tool-only", ""),
            assistant(2, "whitespace-only", " \t\r\n"),
            assistant(3, "answer", "Visible answer"),
        )
        val items = timeline(events)
        assertEquals(listOf("assistant:answer"), items.map { it.id })
        assertEquals("Visible answer", items.single().text)
        assertFalse(items.single().streaming)
        assertEquals(3, events.size)
        assertEquals("", events.first().data.text("content"))
    }

    @Test fun emptyStreamingPlaceholderRemainsUntilACompletedMessageArrives() {
        val partial = assistant(1, "stream", "", streaming = true)
        val pending = timeline(listOf(partial)).single()
        assertTrue(pending.streaming)
        assertEquals("", pending.text)
        assertTrue(timeline(listOf(partial, assistant(2, "stream", ""))).isEmpty())
    }

    @Test fun blankCompletionStillPreventsALateDeltaFromResurrectingTheMessage() {
        val events = listOf(
            assistant(1, "stream", "Partial text", streaming = true),
            assistant(2, "stream", ""),
            assistant(3, "stream", "Late partial text", streaming = true),
        )
        assertTrue(timeline(events).isEmpty())
    }

    @Test fun finalTextReplacesStreamingTextWithoutTrimmingOrAcceptingLateDeltas() {
        val events = listOf(
            assistant(1, "stream", "", streaming = true),
            assistant(2, "stream", "Visible", streaming = true),
            assistant(3, "stream", "  Visible answer\n"),
            assistant(4, "stream", "Late partial", streaming = true),
        )
        val item = timeline(events).single()
        assertEquals("  Visible answer\n", item.text)
        assertFalse(item.streaming)
    }

    @Test fun replayedPagesUseCursorOrderAndCanReplaceAnEarlierBlankCompletion() {
        val events = listOf(
            assistant(4, "later", "Later answer"),
            assistant(3, "original", "Original answer"),
            assistant(1, "original", "", streaming = true),
            assistant(2, "original", ""),
        )
        assertEquals(listOf("Original answer", "Later answer"), timeline(events).map { it.text })
    }

    @Test fun toolCardsKeepTheirOwnOutputWhenToolOnlyAssistantMessagesAreHidden() {
        val events = listOf(
            assistant(1, "tool-only", ""),
            event(2, "tool.start", buildJsonObject {
                put("toolCallId", "tool-1")
                put("name", "view")
                put("text", "Tool arguments remain in the terminal.")
            }),
            event(3, "tool.output", buildJsonObject {
                put("toolCallId", "tool-1")
                put("text", "Tool output")
                put("complete", true)
            }),
            assistant(4, "answer", "Visible answer"),
        )
        val items = timeline(events)
        assertEquals(listOf("tool", "assistant"), items.map { it.role })
        assertEquals("view", items.first().name)
        assertEquals("Tool output", items.first().text)
        assertFalse(items.first().streaming)
    }

    @Test fun blankFilteringDoesNotRemoveUserAttachmentsOrOtherEventRoles() {
        val events = listOf(
            event(1, "user.message", buildJsonObject {
                put("messageId", "user-1")
                put("content", "")
                put("attachments", buildJsonArray { add("diagram.png") })
            }),
            event(2, "tool.output", buildJsonObject {
                put("toolCallId", "tool-1")
                put("text", "")
                put("complete", true)
            }),
            event(3, "notice", buildJsonObject { put("message", "Visible notice") }),
            event(4, "delivery", buildJsonObject { put("status", "completed") }),
            event(5, "runtime.state", buildJsonObject { put("state", "idle") }),
            assistant(6, "empty", ""),
        )
        val items = timeline(events)
        assertEquals(listOf("user", "tool", "notice"), items.map { it.role })
        assertEquals(listOf("diagram.png"), items.first().attachments)
        assertEquals(6, events.size)
    }
}
