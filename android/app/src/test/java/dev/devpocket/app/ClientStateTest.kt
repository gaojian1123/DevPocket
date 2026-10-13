package dev.devpocket.app

import dev.devpocket.app.data.Draft
import dev.devpocket.app.data.DraftLogic
import dev.devpocket.app.data.Capabilities
import dev.devpocket.app.data.PendingRequest
import dev.devpocket.app.data.RelayAddress
import dev.devpocket.app.data.SessionInfo
import dev.devpocket.app.data.WireJson
import dev.devpocket.app.data.Workspace
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.acceptDelivery
import dev.devpocket.app.ui.deliveryLabel
import dev.devpocket.app.ui.sessionMatchesQuery
import dev.devpocket.app.ui.stateLabel
import dev.devpocket.app.ui.workspaceLabel
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ClientStateTest {
    private fun session(): SessionInfo = WireJson.decodeFromString(
        """{"hostId":"host","sessionId":"session","projectId":"repository","projectName":"Project","title":"Original",
            "cliVersion":"unknown","state":"idle","permissionMode":"manual","modelId":"model","capabilities":{},
            "registeredAt":1,"online":true,"pinned":false,"archived":false,"lastSeen":1}"""
    )

    @Test fun sharedDeliveryLabelsReferToTheOriginalSessionAndClient() {
        val statuses = listOf("dispatched", "admitted", "queued")
        for (status in statuses) {
            assertEquals(true, deliveryLabel(status).contains("\u539f\u59cb\u4f1a\u8bdd"))
            assertEquals(false, deliveryLabel(status).contains("CLI"))
        }
        assertEquals(3, statuses.map(::deliveryLabel).toSet().size)
        assertEquals(true, deliveryLabel("uncertain").contains("\u539f\u59cb\u5ba2\u6237\u7aef"))
    }

    @Test fun optionalWorkspaceMetadataDecodesWithoutChangingSessionScope() {
        val legacy = session()
        assertEquals(null, legacy.workspace)
        assertEquals(null, workspaceLabel(legacy))
        val encoded = WireJson.encodeToString(legacy)
            .replace("\"workspace\":null", "\"workspace\":{\"name\":\"task-worktree\",\"branch\":\"feature/grouping\"}")
        val grouped = WireJson.decodeFromString<SessionInfo>(encoded)
        assertEquals(Workspace("task-worktree", "feature/grouping"), grouped.workspace)
        assertEquals(grouped, WireJson.decodeFromString<SessionInfo>(WireJson.encodeToString(grouped)))
        assertEquals(Scope("account", legacy.hostId, legacy.sessionId), Scope("account", grouped.hostId, grouped.sessionId))
        assertEquals(legacy.projectId, grouped.projectId)
        assertEquals(legacy.capabilities, grouped.capabilities)
    }

    @Test fun workspaceLabelsDistinguishBranchesAndDetachedWorktreesWithoutDuplicatingNames() {
        val base = session()
        assertEquals("feature/grouping \u00b7 task-worktree", workspaceLabel(base.copy(workspace = Workspace("task-worktree", "feature/grouping"))))
        assertEquals("main", workspaceLabel(base.copy(workspace = Workspace("main", "main"))))
        assertEquals("task-worktree \u00b7 \u5206\u79bb HEAD", workspaceLabel(base.copy(workspace = Workspace("task-worktree", ""))))
    }

    @Test fun sessionSearchIncludesBranchAndWorktreeAsWellAsExistingFields() {
        val session = session().copy(workspace = Workspace("task-worktree", "feature/grouping"))
        for (query in listOf("", "box", "PROJECT", "Original", "TASK-WORKTREE", "GROUPING"))
            assertEquals(true, sessionMatchesQuery(session, "Dev Box", query))
        assertEquals(false, sessionMatchesQuery(session, "Dev Box", "unrelated"))
        assertEquals(false, sessionMatchesQuery(session.copy(workspace = null), "Dev Box", "grouping"))
    }

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
