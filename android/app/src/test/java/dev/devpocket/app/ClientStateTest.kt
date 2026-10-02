package dev.devpocket.app

import dev.devpocket.app.data.Draft
import dev.devpocket.app.data.DraftLogic
import dev.devpocket.app.data.RelayAddress
import dev.devpocket.app.data.acceptDelivery
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ClientStateTest {
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
