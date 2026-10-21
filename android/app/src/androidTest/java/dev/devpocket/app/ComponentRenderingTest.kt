package dev.devpocket.app

import android.view.View
import android.webkit.WebView
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.Density
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.UiController
import androidx.test.espresso.ViewAction
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.platform.app.InstrumentationRegistry
import dev.devpocket.app.data.*
import dev.devpocket.app.ui.ComponentDetail
import dev.devpocket.app.ui.PocketTheme
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import org.hamcrest.Matcher
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ComponentRenderingTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun card(spec: JsonObject, id: String = UUID.randomUUID().toString()): ComponentCard {
        val bytes = spec.toString().toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return ComponentCard(id, "tool-$id", 1, "ready", "base64-json",
            Base64.getEncoder().encodeToString(bytes), digest)
    }

    private fun script(value: String): JsonElement {
        var result: String? = null
        val complete = CountDownLatch(1)
        onView(isAssignableFrom(WebView::class.java)).inRoot(isDialog()).perform(object : ViewAction {
            override fun getConstraints(): Matcher<View> = isAssignableFrom(WebView::class.java)
            override fun getDescription() = "Inspect the packaged component in its owned WebView"
            override fun perform(controller: UiController, view: View) {
                val web = view as WebView
                assertEquals("https://appassets.androidplatform.net/assets/components/index.html", web.url)
                assertTrue(web.settings.blockNetworkLoads)
                assertFalse(web.settings.allowFileAccess)
                assertFalse(web.settings.allowContentAccess)
                web.evaluateJavascript(value) { result = it; complete.countDown() }
            }
        })
        assertTrue("The local renderer did not answer.", complete.await(10, TimeUnit.SECONDS))
        return WireJson.parseToJsonElement(checkNotNull(result))
    }

    private fun waitForRender() {
        compose.waitUntil(20_000) {
            compose.onAllNodes(hasTestTag("reference_component") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test fun offlineWebViewRendersAllTypesAndKeepsLinksImagesAndFailuresInsideTheHostContract() {
        val markdown = buildJsonObject {
            put("type", "markdown"); put("title", "Offline Markdown")
            put("content", "# Offline heading\n\n<script>window.componentInjected=true</script>\n\n" +
                "![blocked](https://example.invalid/image.png)\n\n[Safe link](https://example.test/details)\n\n" +
                "| Name | Value |\n| --- | --- |\n| Complete | 3 |")
        }
        var selected by mutableStateOf(card(markdown))
        var theme by mutableStateOf("light")
        var scale by mutableStateOf(1f)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    PocketTheme(theme) {
                        val density = LocalDensity.current
                        CompositionLocalProvider(LocalDensity provides Density(density.density, scale)) {
                            ComponentDetail(selected, false, true, null, dismiss = {}, reference = {})
                        }
                    }
                }
            }
            waitForRender()
            assertTrue(script("document.querySelector('.markdown').innerText.includes('Offline heading')").jsonPrimitive.boolean)
            assertTrue(script("!window.componentInjected && !document.querySelector('.markdown script, .markdown img')").jsonPrimitive.boolean)
            assertTrue(script("!!document.querySelector('.unsupported-image') && !!document.querySelector('.markdown table')").jsonPrimitive.boolean)
            script("window.devPocketHost.postMessage(JSON.stringify({version:1,type:'open-link',requestId:'wrong-request',url:'https://example.test/wrong'})); true")
            compose.waitForIdle()
            compose.onNodeWithText("在浏览器打开链接？").assertDoesNotExist()
            script("document.querySelector('.markdown a[data-url]').click(); true")
            compose.onNodeWithText("在浏览器打开链接？").assertIsDisplayed()
            compose.onNodeWithText("https://example.test/details").assertIsDisplayed()
            compose.onNodeWithText("取消").performClick()

            compose.runOnIdle { theme = "dark"; scale = 2f }
            waitForRender()
            compose.waitUntil(10_000) { script("document.getElementById('component').dataset.theme === 'dark'").jsonPrimitive.boolean }
            for (type in listOf("line", "bar")) {
                val chart = buildJsonObject {
                    put("type", type); put("title", "Offline $type"); put("xAxisKey", "day")
                    putJsonArray("data") { repeat(12) { index ->
                        add(buildJsonObject { put("day", "Day ${index + 1}"); put("value", index % 3 + 1) })
                    } }
                    putJsonArray("series") { add(buildJsonObject { put("name", "Count"); put("dataKey", "value") }) }
                }
                compose.runOnIdle { selected = card(chart) }
                waitForRender()
                compose.waitUntil(10_000) {
                    script("(() => { const c=document.querySelector('canvas'); return !!c && c.width>0 && c.height>0 && " +
                        "c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0); })()").jsonPrimitive.boolean
                }
                script("document.querySelector('.chart-data').open=true; true")
                compose.waitUntil(10_000) { script("document.querySelectorAll('tbody tr').length === 12").jsonPrimitive.boolean }
                assertTrue(script("document.querySelector('tbody').innerText.includes('Day 12')").jsonPrimitive.boolean)
            }
            val table = buildJsonObject {
                put("type", "datagrid"); put("title", "Offline table"); put("pageSize", 2)
                putJsonArray("columns") {
                    add(buildJsonObject { put("key", "name"); put("label", "Name") })
                    add(buildJsonObject { put("key", "value"); put("label", "Count"); put("type", "number") })
                }
                putJsonArray("rows") { repeat(6) { index ->
                    add(buildJsonObject { put("name", "Row ${index + 1}"); put("value", 6 - index) })
                } }
            }
            compose.runOnIdle { selected = card(table) }
            waitForRender()
            assertEquals("6 / 6 行", script("document.querySelector('.row-count').textContent").jsonPrimitive.content)
            script("document.querySelector('.pager button:last-child').click(); document.querySelector('.pager button:last-child').click(); true")
            assertTrue(script("document.querySelector('tbody').innerText.includes('Row 6')").jsonPrimitive.boolean)
            script("const f=document.querySelector('.filter'); f.value='Row 3'; f.dispatchEvent(new Event('input')); true")
            assertEquals("1 / 6 行", script("document.querySelector('.row-count').textContent").jsonPrimitive.content)
            script("document.querySelector('.filter').value=''; document.querySelector('.filter').dispatchEvent(new Event('input')); " +
                "document.querySelectorAll('th button')[1].click(); true")
            assertEquals("Row 6", script("document.querySelector('tbody td').textContent").jsonPrimitive.content)
            compose.runOnIdle {
                scale = 1f
                selected = card(buildJsonObject { put("type", "markdown"); put("content", "x".repeat(240_000)) })
            }
            waitForRender()
            assertEquals(240_000, script("document.querySelector('.markdown p').textContent.length").jsonPrimitive.int)
            compose.runOnIdle { selected = card(JsonObject(markdown + ("unsupported" to JsonPrimitive(true)))) }
            compose.waitUntil(20_000) {
                compose.onAllNodesWithText("组件无法安全显示，请在原始客户端查看。").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithTag("reference_component").assertIsNotEnabled()
        }
    }

    @Test fun cachedCardsKeepReadingPositionAndShowReferenceErrorsWithoutLosingAnOfflineDraft() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account(UUID.randomUUID().toString(), "https://127.0.0.1:1",
            "dpd_" + "x".repeat(43), UUID.randomUUID().toString(), "Offline component fixture")
        val host = Host(UUID.randomUUID().toString(), "Offline fixture", false, 0)
        val session = SessionInfo(host.id, UUID.randomUUID().toString(), "fixture", "Components",
            "Offline component history", "test-fixture", "offline", "manual", "offline-fixture",
            capabilities = Capabilities(), registeredAt = 0, online = false, pinned = false,
            archived = false, lastSeen = 0, componentVersion = 1)
        val scope = Scope(account.id, host.id, session.sessionId)
        val selected = card(buildJsonObject {
            put("type", "markdown"); put("title", "Retained card"); put("content", "Complete **offline** content.")
        })
        val files = List(4) { Attachment("file-$it", "file-$it.txt", "text/plain", 1, "a".repeat(64)) }
        val draft = Draft("Keep my offline question", 1, files)
        val events = (1L..35L).map { cursor ->
            if (cursor == 20L) WireEvent("card-event", "2026-10-19T00:00:00Z", "component",
                WireJson.encodeToJsonElement(selected).jsonObject, cursor, host.id, session.sessionId)
            else WireEvent("text-$cursor", "2026-10-19T00:00:00Z", "assistant.message",
                buildJsonObject { put("messageId", "message-$cursor"); put("content", "Retained message $cursor") },
                cursor, host.id, session.sessionId)
        }
        val oldAccounts = Vault(context).accounts()
        var scenario: ActivityScenario<MainActivity>? = null
        try {
            Vault(context).saveAccounts(listOf(account))
            LocalStore(context).use {
                it.saveCatalog(account.id, Catalog(Device(account.deviceId, account.name), listOf(host), listOf(session), false, 1))
                it.applyPage(scope, EventPage(events, events.last().cursor))
                it.saveDraft(scope, draft)
            }
            context.getSharedPreferences("devpocket_settings", 0).edit().remove("last_scope").commit()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            compose.waitUntil(20_000) { compose.onAllNodesWithText(session.title).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(session.title).performClick()
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("message_input").fetchSemanticsNodes().isNotEmpty() }
            scenario.onActivity { ViewModelProvider(it)[PocketViewModel::class.java].foreground(false) }
            if (compose.onAllNodesWithText("知道了").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithText("知道了").performClick()
            fun openCard(): Float {
                compose.onNodeWithTag("chat_history").performScrollToNode(hasTestTag("component_${selected.componentId}"))
                val button = compose.onNode(hasText("展开查看完整内容") and
                    hasAnyAncestor(hasTestTag("component_${selected.componentId}"))).performScrollTo()
                val position = compose.onNodeWithTag("chat_history").fetchSemanticsNode()
                    .config[SemanticsProperties.VerticalScrollAxisRange].value()
                button.performClick()
                waitForRender()
                return position
            }
            val position = openCard()
            compose.onNodeWithContentDescription("返回对话").performClick()
            assertEquals(position, compose.onNodeWithTag("chat_history").fetchSemanticsNode()
                .config[SemanticsProperties.VerticalScrollAxisRange].value(), 0.01f)
            openCard()
            compose.onNodeWithTag("reference_component").performClick()
            compose.onNodeWithTag("component_detail").assertIsDisplayed()
            compose.onNodeWithTag("component_reference_error").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回对话").performClick()
            if (compose.onAllNodesWithText("知道了").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithText("知道了").performClick()
            compose.onNodeWithContentDescription("移除附件 file-0.txt").performClick()
            openCard()
            compose.onNodeWithTag("reference_component").performClick()
            compose.onNodeWithTag("component_reference").assertIsDisplayed()
            compose.onNodeWithTag("message_input").assertTextContains(draft.text)
            compose.onNodeWithContentDescription("发送到原始 GitHub Copilot 会话").assertIsNotEnabled()
            scenario.recreate()
            compose.waitUntil(20_000) { compose.onAllNodesWithTag("component_reference").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("message_input").assertTextContains(draft.text)
            LocalStore(context).use {
                assertTrue(it.outbox(scope).isEmpty())
                assertEquals(selected.selection(), it.draft(scope).componentReference)
                assertEquals(3, it.draft(scope).attachments.size)
                assertEquals("ready", componentCard(it.events(scope).single { event -> event.kind == "component" }).status)
            }
        } finally {
            scenario?.close()
            Vault(context).saveAccounts(oldAccounts)
            LocalStore(context).use { it.forgetAccount(account.id) }
            context.getSharedPreferences("devpocket_settings", 0).edit().remove("last_scope").commit()
        }
    }
}
