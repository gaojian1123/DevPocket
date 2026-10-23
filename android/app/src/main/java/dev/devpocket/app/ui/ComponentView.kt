@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.devpocket.app.ui

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.devpocket.app.data.*
import java.io.ByteArrayInputStream
import java.util.UUID
import kotlin.math.roundToInt
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*

private const val COMPONENT_ORIGIN = "https://appassets.androidplatform.net"
private const val COMPONENT_PAGE = "$COMPONENT_ORIGIN/assets/components/index.html"
private val componentResources = setOf("/assets/components/index.html", "/assets/components/component.js",
    "/assets/components/component.css", "/assets/components/component.js.LEGAL.txt", "/assets/components/THIRD-PARTY-NOTICES.txt")

internal fun componentExternalUri(value: String): Uri? {
    if (value.length > 2000 || value.any { it <= ' ' || it == '\u007f' || it == '\\' }) return null
    val uri = Uri.parse(value)
    return uri.takeIf { it.scheme in setOf("http", "https") && !it.host.isNullOrEmpty() &&
        it.userInfo == null && it.host != "appassets.androidplatform.net" }
}

@Composable
internal fun ComponentCardView(card: ComponentCard, open: () -> Unit, onMeasured: () -> Unit) {
    OutlinedCard(Modifier.fillMaxWidth().widthIn(max = 720.dp).testTag("component_${card.componentId}")) {
        Column(Modifier.padding(12.dp)) {
            Text(card.title, style = MaterialTheme.typography.titleSmall)
            if (card.redacted) Text("敏感内容已隐藏", style = MaterialTheme.typography.labelSmall)
            if (card.status == "ready") {
                ComponentSurface(card, detail = false, onMeasured = onMeasured)
                TextButton(onClick = open, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.Default.Fullscreen, contentDescription = null)
                    Text("展开查看完整内容")
                }
            } else Text(componentFailure(card.error?.code), color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(vertical = 12.dp))
        }
    }
}

@Composable
internal fun ComponentDetail(card: ComponentCard?, pendingRequests: Boolean, canReference: Boolean, referenceError: String?,
    dismiss: () -> Unit, reference: (ComponentCard) -> Unit) {
    var rendered by remember(card?.componentId, card?.sha256) { mutableStateOf(false) }
    Dialog(onDismissRequest = dismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding().testTag("component_detail")) {
                TopAppBar(title = { Text(card?.title ?: "可视化内容") },
                    navigationIcon = { IconButton(onClick = dismiss) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回对话")
                    } })
                if (pendingRequests) TextButton(onClick = dismiss, modifier = Modifier.fillMaxWidth()) {
                    Text("会话有待处理请求，返回查看")
                }
                if (card?.status == "ready") {
                    if (card.redacted) Text("敏感内容已隐藏", Modifier.padding(horizontal = 16.dp),
                        style = MaterialTheme.typography.labelSmall)
                    ComponentSurface(card, detail = true, modifier = Modifier.weight(1f), onRendered = { rendered = it })
                    referenceError?.let {
                        Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("component_reference_error"),
                            color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    Button(onClick = { reference(card) }, enabled = canReference && rendered,
                        modifier = Modifier.fillMaxWidth().padding(16.dp).heightIn(min = 48.dp)
                            .testTag("reference_component")) { Text("引用这张卡片提问") }
                } else Box(Modifier.weight(1f).padding(24.dp)) {
                    Text(if (card == null) "这张卡片已不在当前历史中，请返回对话。"
                        else componentFailure(card.error?.code))
                }
            }
        }
    }
}

@Composable
private fun ComponentSurface(card: ComponentCard, detail: Boolean, modifier: Modifier = Modifier,
    onMeasured: () -> Unit = {}, onRendered: (Boolean) -> Unit = {}) {
    val context = LocalContext.current
    val theme = if (MaterialTheme.colorScheme.background.luminance() < .5f) "dark" else "light"
    val textZoom = (LocalDensity.current.fontScale * 100).roundToInt().coerceAtLeast(1)
    var height by remember(card.componentId) { mutableIntStateOf(280) }
    var failure by remember(card.componentId) { mutableStateOf<String?>(null) }
    var link by remember(card.componentId) { mutableStateOf<Uri?>(null) }
    var linkError by remember(card.componentId) { mutableStateOf<String?>(null) }
    val changed by rememberUpdatedState(onMeasured)
    val rendering by rememberUpdatedState(onRendered)
    val supported = remember {
        WebView.getCurrentWebViewPackage() != null &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)
    }
    if (!supported || failure != null) {
        Text(failure ?: "当前系统 WebView 不支持安全显示此内容，请在原始客户端查看。",
            modifier.padding(vertical = 16.dp), color = MaterialTheme.colorScheme.error)
        return
    }
    key(card.componentId, context) {
        AndroidView(
            factory = { viewContext ->
                ComponentWebView(viewContext, failed = { failure = it }, measured = {
                    val bounded = it.coerceIn(72, 420)
                    if (!detail && height != bounded) { height = bounded; changed() }
                }, rendered = { rendering(it) }, requestLink = { if (link == null) link = it })
            },
            modifier = if (detail) modifier.fillMaxWidth() else modifier.fillMaxWidth().height(height.dp),
            onReset = null,
            onRelease = { it.close() },
            update = { it.render(card, if (detail) "detail" else "inline", theme, textZoom) },
        )
    }
    link?.let { destination ->
        AlertDialog(onDismissRequest = { link = null }, title = { Text("在浏览器打开链接？") },
            text = { Text(destination.toString()) },
            confirmButton = { TextButton(onClick = {
                link = null
                try { context.startActivity(Intent(Intent.ACTION_VIEW, destination).addCategory(Intent.CATEGORY_BROWSABLE)) }
                catch (error: ActivityNotFoundException) { linkError = "没有可以打开该链接的浏览器。" }
            }) { Text("打开") } },
            dismissButton = { TextButton(onClick = { link = null }) { Text("取消") } })
    }
    linkError?.let { message ->
        AlertDialog(onDismissRequest = { linkError = null }, title = { Text("链接未打开") },
            text = { Text(message) }, confirmButton = { TextButton(onClick = { linkError = null }) { Text("知道了") } })
    }
}

@SuppressLint("SetJavaScriptEnabled")
private class ComponentWebView(context: Context, private val failed: (String) -> Unit,
    private val measured: (Int) -> Unit, private val rendered: (Boolean) -> Unit, private val requestLink: (Uri) -> Unit) : WebView(context) {
    private var active = true
    private var ready = false
    private var requestId = ""
    private var signature = ""
    private var pending: String? = null
    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()

    init {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.port == -1 &&
                    uri.userInfo == null && uri.query == null && uri.encodedPath in componentResources) {
                    return loader.shouldInterceptRequest(uri) ?: blockedResource()
                }
                return blockedResource()
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) fail("本地可视化资源加载失败，请在原始客户端查看。")
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (active) {
                    active = false
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()
                    rendered(false)
                    failed("可视化进程已退出。对话已保留，请返回后重新打开卡片。")
                }
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.w("DevPocket", "Component script reported an error.")
                    fail("可视化显示失败，请在原始客户端查看。")
                }
                return true
            }
        }
        WebViewCompat.addWebMessageListener(this, "devPocketHost", setOf(COMPONENT_ORIGIN)) { _, message, origin, mainFrame, _ ->
            if (!active) return@addWebMessageListener
            if (!mainFrame || origin.scheme != "https" || origin.host != "appassets.androidplatform.net" ||
                origin.port != -1 || origin.userInfo != null) {
                Log.w("DevPocket", "Blocked an untrusted component frame.")
                return@addWebMessageListener
            }
            if (message.type != WebMessageCompat.TYPE_STRING) { fail("渲染器消息类型不受支持。"); return@addWebMessageListener }
            receive(message.data.orEmpty())
        }
        loadUrl(COMPONENT_PAGE)
        postDelayed({ if (active && !ready) fail("可视化渲染器未能启动，请在原始客户端查看。") }, 15_000)
    }

    fun render(card: ComponentCard, view: String, theme: String, zoom: Int) {
        val next = "${card.componentId}:${card.sha256}:$view:$theme:$zoom"
        if (!active || next == signature) return
        signature = next
        requestId = UUID.randomUUID().toString()
        rendered(false)
        settings.textZoom = zoom
        pending = buildJsonObject {
            put("version", COMPONENT_VERSION); put("type", "render"); put("requestId", requestId)
            put("view", view); put("theme", theme); put("spec", card.spec ?: error("Missing validated component data."))
        }.toString()
        send()
    }

    private fun send() {
        if (active && ready) pending?.let {
            WebViewCompat.postWebMessage(this, WebMessageCompat(it), Uri.parse(COMPONENT_ORIGIN))
            pending = null
        }
    }

    private fun receive(message: String) {
        if (message.length > 4096) { fail("渲染器消息超过允许范围。"); return }
        val value = try { WireJson.parseToJsonElement(message) as? JsonObject }
        catch (error: SerializationException) { fail("渲染器消息无法解析。"); return }
        val version = value?.get("version") as? JsonPrimitive
        if (value == null || version == null || version.isString || version.intOrNull != COMPONENT_VERSION) {
            fail("渲染器消息版本不受支持。"); return
        }
        val type = value.stringValue("type")
        if (type == "ready" && value.keys == setOf("version", "type")) { ready = true; send(); return }
        if (value.stringValue("requestId") != requestId) return
        when (type) {
            "rendered" -> {
                if (value.keys != setOf("version", "type", "requestId")) fail("渲染器消息格式不受支持。")
                else rendered(true)
            }
            "height" -> {
                val primitive = value["height"] as? JsonPrimitive
                val height = primitive?.takeUnless { it.isString }?.doubleOrNull
                if (value.keys != setOf("version", "type", "requestId", "height") ||
                    height == null || !height.isFinite() || height !in 0.0..10_000_000.0) {
                    fail("渲染器尺寸信息无效。"); return
                }
                measured(height.toInt())
            }
            "open-link" -> {
                val uri = value.stringValue("url")?.let(::componentExternalUri)
                if (value.keys != setOf("version", "type", "requestId", "url") || uri == null) {
                    fail("已阻止不受支持的链接。"); return
                }
                requestLink(uri)
            }
            "error" -> {
                if (value.keys != setOf("version", "type", "requestId", "code")) fail("渲染器消息格式不受支持。")
                else fail(componentFailure(value.stringValue("code")))
            }
            else -> fail("渲染器消息格式不受支持。")
        }
    }

    private fun fail(message: String) {
        if (active) {
            rendered(false)
            failed(message)
        }
    }

    fun close() {
        if (!active) return
        active = false
        // Removing a live message listener during teardown crashes WebView 124; destruction owns its cleanup.
        stopLoading()
        (parent as? ViewGroup)?.removeView(this)
        destroy()
    }

    private fun blockedResource() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked",
        emptyMap(), ByteArrayInputStream(ByteArray(0)))
}

private fun componentFailure(code: String?): String = when (code) {
    "COMPONENT_UNSUPPORTED" -> "此客户端暂不支持这种组件，请在原始客户端查看。"
    "COMPONENT_TOO_LARGE" -> "组件超过显示上限，内容未被截断，请在原始客户端查看。"
    "COMPONENT_RENDER_FAILED" -> "原始画布调用失败，没有可确认的组件结果。"
    "COMPONENT_OUTCOME_UNKNOWN" -> "画布调用的结果尚未确认，请在原始客户端核实。"
    else -> "组件无法安全显示，请在原始客户端查看。"
}
