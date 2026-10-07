package dev.devpocket.app

import dev.devpocket.app.data.Draft
import dev.devpocket.app.data.DraftLogic
import dev.devpocket.app.data.Capabilities
import dev.devpocket.app.data.PendingRequest
import dev.devpocket.app.data.RelayAddress
import dev.devpocket.app.data.SessionInfo
import dev.devpocket.app.data.WireJson
import dev.devpocket.app.data.acceptDelivery
import dev.devpocket.app.ui.stateLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ClientStateTest {
    @Test fun pendingControlsRequireTheirOwnLiveCapabilityAndCompleteDetails() {
        val permission = PendingRequest("permission", "permission", "Permission", "Read a file", supported = true)
        val question = PendingRequest("question", "question", "Question", "Choose an option", supported = true)
        val capabilities = Capabilities(permissions = true, questions = false)
        assertEquals(true, permission.supportedBy(capabilities))
        assertEquals(false, question.supportedBy(capabilities))
        assertEquals(false, permission.supportedBy(capabilities.copy(permissions = false)))
        assertEquals(true, question.supportedBy(capabilities.copy(questions = true)))
        assertEquals(false, permission.copy(supported = false).supportedBy(capabilities))
        assertEquals(false, question.copy(type = "terminal").supportedBy(capabilities.copy(questions = true)))
    }

    @Test fun runtimeCapabilitiesDecodeIndependentlyOfRecordedVersionAndMessaging() {
        for (version in listOf("1.0.90-0", "99.0.0-preview", "unknown")) {
            val session = WireJson.decodeFromString<SessionInfo>(
                """{"hostId":"host","sessionId":"session","projectId":"project","projectName":"Project","title":"Original",
                    "cliVersion":"$version","state":"unsupported","permissionMode":"unknown","modelId":"model",
                    "capabilities":{"messages":false,"abort":true,"permissions":false,"questions":true,"models":true,"files":true,"git":true},
                    "registeredAt":1,"online":true,"pinned":false,"archived":false,"lastSeen":1}"""
            )
            assertEquals(version, session.cliVersion)
            assertEquals(false, session.capabilities.messages)
            assertEquals(true, session.capabilities.abort)
            assertEquals(false, session.capabilities.permissions)
            assertEquals(true, session.capabilities.questions)
            assertEquals(true, session.capabilities.models)
            assertEquals(true, session.capabilities.files)
            assertEquals(true, session.capabilities.git)
        }
        assertEquals("\u8fd0\u884c\u65f6\u80fd\u529b\u672a\u786e\u8ba4", stateLabel("unsupported"))
    }

    @Test fun releaseRejectsCleartextAndEmbeddedCredentials() {
        assertThrows(IllegalArgumentException::class.java) { RelayAddress.validate("http://example.com", false) }
        assertThrows(IllegalArgumentException::class.java) { RelayAddress.validate("https://user:password@example.com", false) }
        assertThrows(IllegalArgumentException::class.java) { RelayAddress.validate("https://example.com/path", false) }
        assertEquals("https://relay.example", RelayAddress.validate("https://relay.example/", false))
        assertEquals("http://10.0.2.2:8787", RelayAddress.validate("http://10.0.2.2:8787", true))
        assertThrows(IllegalArgumentException::class.java) { RelayAddress.validate("http://192.168.1.2", true) }
    }

    @Test fun lateSendAcknowledgmentCannotClearANewerDraft() {
        val sent = Draft(text = "Original", revision = 4)
        val newer = Draft(text = "New thought", revision = 5)
        assertEquals(newer, DraftLogic.afterStaging(newer, sent))
        assertEquals("", DraftLogic.afterStaging(sent, sent).text)
        assertEquals(5L, DraftLogic.afterStaging(sent, sent).revision)
    }

    @Test fun lateAdmittedAcknowledgmentCannotReplaceCompletedOrUncertainDelivery() {
        assertEquals("completed", acceptDelivery("completed", "admitted"))
        assertEquals("processing", acceptDelivery("processing", "admitted"))
        assertEquals("uncertain", acceptDelivery("uncertain", "dispatched"))
        assertEquals("completed", acceptDelivery("processing", "completed"))
    }
}
