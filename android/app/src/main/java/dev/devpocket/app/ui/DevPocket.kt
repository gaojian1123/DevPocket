@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.devpocket.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.devpocket.app.BoxCard
import dev.devpocket.app.PocketUi
import dev.devpocket.app.PocketViewModel
import dev.devpocket.app.data.Scope
import dev.devpocket.app.data.SessionInfo

@Composable
fun DevPocket(model: PocketViewModel, requestNotifications: () -> Unit) {
    val state by model.ui.collectAsStateWithLifecycle()
    var destination by rememberSaveable { mutableStateOf("sessions") }
    var pairing by rememberSaveable { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val holder = rememberSaveableStateHolder()
    LaunchedEffect(state.error) {
        state.error?.let { snackbar.showSnackbar(it, actionLabel = "知道了", duration = SnackbarDuration.Long); model.clearError() }
    }
    LaunchedEffect(state.navigateToSession) {
        if (state.navigateToSession) {
            destination = "sessions"
            model.navigationHandled()
        }
    }
    BackHandler(enabled = !pairing && (destination != "sessions" || state.selected != null)) {
        if (destination != "sessions") destination = "sessions" else model.closeSession()
    }
    PocketTheme(state.theme) {
        BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            val expanded = maxWidth >= 840.dp
            val rail = maxWidth >= 600.dp
            Scaffold(
                contentWindowInsets = WindowInsets.safeDrawing,
                snackbarHost = { SnackbarHost(snackbar) },
                bottomBar = {
                    if (!rail && (state.selected == null || destination != "sessions")) NavigationBar {
                        NavigationBarItem(selected = destination == "sessions", onClick = { destination = "sessions" },
                            icon = { Icon(Icons.Default.Devices, contentDescription = null) }, label = { Text("工作台") })
                        NavigationBarItem(selected = destination == "settings", onClick = { destination = "settings" },
                            icon = { Icon(Icons.Default.Settings, contentDescription = null) }, label = { Text("设置") })
                    }
                },
            ) { padding ->
                Row(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                    if (rail) {
                        NavigationRail {
                            Spacer(Modifier.height(12.dp))
                            Icon(Icons.Default.Terminal, contentDescription = "DevPocket", tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.padding(16.dp))
                            NavigationRailItem(selected = destination == "sessions", onClick = { destination = "sessions" },
                                icon = { Icon(Icons.Default.Devices, contentDescription = null) }, label = { Text("工作台") })
                            NavigationRailItem(selected = destination == "settings", onClick = { destination = "settings" },
                                icon = { Icon(Icons.Default.Settings, contentDescription = null) }, label = { Text("设置") })
                        }
                        VerticalDivider()
                    }
                    if (destination == "settings") {
                        SettingsPane(state, model, requestNotifications, { pairing = true }, Modifier.weight(1f))
                    } else if (expanded) {
                        SessionList(state, model, { pairing = true }, Modifier.widthIn(max = 360.dp).width(320.dp).fillMaxHeight())
                        VerticalDivider()
                        Box(Modifier.weight(1f).fillMaxHeight()) {
                            if (state.selected != null && state.session != null) {
                                holder.SaveableStateProvider(state.selected!!.key) {
                                    SessionPane(state, model, expanded = true)
                                }
                            } else EmptyDetail()
                        }
                    } else if (state.selected != null && state.session != null) {
                        holder.SaveableStateProvider(state.selected!!.key) {
                            SessionPane(state, model, expanded = false)
                        }
                    } else SessionList(state, model, { pairing = true }, Modifier.weight(1f).fillMaxHeight())
                }
            }
        }
        if (pairing) PairDialog(state, model) { pairing = false }
    }
}

@Composable
fun EmptyDetail() {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.Terminal, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(56.dp))
        Spacer(Modifier.height(20.dp))
        Text("把终端带在身边", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        Text("选择已注册的 CLI 会话。\n这里连接的是 Dev Box 上原来的终端，不会启动另一个代理。",
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SessionList(state: PocketUi, model: PocketViewModel, pair: () -> Unit, modifier: Modifier = Modifier) {
    var query by rememberSaveable { mutableStateOf("") }
    var archived by rememberSaveable { mutableStateOf(false) }
    var rename by remember { mutableStateOf<Pair<BoxCard, SessionInfo>?>(null) }
    Column(modifier.testTag("session_list")) {
        TopAppBar(title = { Text("DevPocket", fontWeight = FontWeight.SemiBold) }, actions = {
            IconButton(onClick = model::refreshNow) { Icon(Icons.Default.Refresh, contentDescription = "刷新电脑和会话") }
            IconButton(onClick = pair) { Icon(Icons.Default.Add, contentDescription = "配对新的 Dev Box") }
        })
        OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) }, label = { Text("搜索电脑、项目或会话") },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp))
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !archived, onClick = { archived = false }, label = { Text("当前") })
            FilterChip(selected = archived, onClick = { archived = true }, label = { Text("已归档") })
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.accounts.isEmpty()) {
            Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
                Icon(Icons.Default.PhonelinkSetup, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(48.dp))
                Spacer(Modifier.height(16.dp))
                Text("连接你的 Dev Box", style = MaterialTheme.typography.headlineSmall)
                Text("使用独立的一次性配对码。手机不需要登录 GitHub，你的授权和订阅始终留在终端。", Modifier.padding(vertical = 12.dp))
                Button(onClick = pair, modifier = Modifier.fillMaxWidth()) { Text("开始配对") }
            }
        } else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            for (box in state.boxes) {
                val matches = box.sessions.filter { session ->
                    session.archived == archived && (query.isBlank() ||
                        listOf(box.host.name, session.projectName, session.title).any { it.contains(query, ignoreCase = true) })
                }.sortedWith(compareByDescending<SessionInfo> { it.pinned }.thenByDescending { it.lastSeen })
                if (matches.isEmpty() && query.isNotBlank()) continue
                item(key = "host:${box.accountId}:${box.host.id}") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Icons.Default.Computer, contentDescription = null, modifier = Modifier.size(20.dp))
                            Text(box.host.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            StatusLabel(if (box.host.online) "在线" else "离线", box.host.online)
                        }
                        if (matches.isEmpty()) Text("还没有注册的会话。请在原始终端选择启用 DevPocket 扩展。",
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                    }
                }
                for ((project, sessions) in matches.groupBy { it.projectId }) {
                    item(key = "project:${box.accountId}:${box.host.id}:$project") {
                        Text(sessions.first().projectName, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(start = 20.dp, top = 4.dp, bottom = 6.dp))
                    }
                    items(sessions, key = { "${box.accountId}:${it.hostId}:${it.sessionId}" }) { session ->
                        val scope = Scope(box.accountId, session.hostId, session.sessionId)
                        var menu by remember { mutableStateOf(false) }
                        Surface(
                            color = if (state.selected == scope) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
                            shape = MaterialTheme.shapes.large,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp).fillMaxWidth()
                                .clickable { model.open(scope, session) },
                        ) {
                            Row(Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        if (session.pinned) Icon(Icons.Default.PushPin, contentDescription = "已置顶",
                                            modifier = Modifier.size(16.dp).padding(end = 2.dp))
                                        Text(session.title.ifBlank { "未命名会话" }, style = MaterialTheme.typography.titleSmall,
                                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    }
                                    Text("${stateLabel(session.state)} · ${session.modelId.ifBlank { "模型未知" }}",
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(top = 5.dp), maxLines = 2)
                                }
                                Box {
                                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "会话选项") }
                                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                        DropdownMenuItem(text = { Text("重命名") }, onClick = { menu = false; rename = box to session })
                                        DropdownMenuItem(text = { Text(if (session.pinned) "取消置顶" else "置顶") },
                                            onClick = { menu = false; model.metadata(session, box.accountId, pinned = !session.pinned) })
                                        DropdownMenuItem(text = { Text(if (session.archived) "取消归档" else "归档（不停止终端）") },
                                            onClick = { menu = false; model.metadata(session, box.accountId, archived = !session.archived) })
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (state.boxes.isEmpty()) item {
                Text("尚无授权电脑，或配对已撤销。可刷新连接或重新配对。", Modifier.padding(24.dp))
            }
        }
    }
    rename?.let { (box, session) ->
        var title by remember(session.sessionId) { mutableStateOf(session.title) }
        AlertDialog(onDismissRequest = { rename = null }, title = { Text("会话显示名称") },
            text = { Column {
                OutlinedTextField(value = title, onValueChange = { title = it.take(160) }, label = { Text("名称") })
                Text("名称保存在 DevPocket，不修改 CLI 的会话文件。", style = MaterialTheme.typography.bodySmall)
            } }, confirmButton = {
                TextButton(enabled = title.isNotBlank(), onClick = { model.metadata(session, box.accountId, title = title.trim()); rename = null }) { Text("保存") }
            }, dismissButton = { TextButton(onClick = { rename = null }) { Text("取消") } })
    }
}

@Composable
private fun PairDialog(state: PocketUi, model: PocketViewModel, dismiss: () -> Unit) {
    var relay by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("我的 Android") }
    androidx.compose.ui.window.Dialog(onDismissRequest = { if (!state.busy) dismiss() },
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.widthIn(max = 560.dp).fillMaxWidth().padding(16.dp).imePadding().testTag("native_pair_form"),
            shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
            LazyColumn(contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                item { Text("安全配对", style = MaterialTheme.typography.headlineSmall) }
                item { Text("在 Dev Box 的 DevPocket 管理命令中生成 5 分钟有效的一次性码。每台手机持有独立、可撤销的凭据。") }
                item { OutlinedTextField(relay, { relay = it }, label = { Text("HTTPS 中转地址") },
                    placeholder = { Text("https://relay.example.com") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    singleLine = true, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(code, { code = it }, label = { Text("一次性配对码") },
                    visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth()) }
                item { OutlinedTextField(name, { name = it.take(80) }, label = { Text("设备名称") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
                item { Text("GitHub 令牌不会被传到手机。只向你信任的独立中转发送配对码。", style = MaterialTheme.typography.bodySmall) }
                state.error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) } }
                item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = dismiss, enabled = !state.busy) { Text("取消") }
                    Button(onClick = { model.pair(relay, code, name) { code = ""; dismiss() } },
                        enabled = !state.busy && relay.isNotBlank() && code.isNotBlank() && name.isNotBlank()) {
                        if (state.busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("配对")
                    }
                } }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SettingsPane(state: PocketUi, model: PocketViewModel, notifications: () -> Unit,
    pair: () -> Unit, modifier: Modifier = Modifier) {
    var revoke by remember { mutableStateOf<BoxCard?>(null) }
    var forget by remember { mutableStateOf<String?>(null) }
    Column(modifier.fillMaxHeight()) {
        TopAppBar(title = { Text("设置") })
        LazyColumn(Modifier.widthIn(max = 800.dp).fillMaxWidth(), contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item { Text("外观", style = MaterialTheme.typography.titleLarge) }
            item { FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((id, title) in listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色"))
                    FilterChip(selected = state.theme == id, onClick = { model.setTheme(id) }, label = { Text(title) })
            } }
            item { SettingsCard("后台模式", Icons.Default.NotificationsActive) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("接收后台提醒", modifier = Modifier.weight(1f))
                    Switch(checked = state.background.enabled, onCheckedChange = model::setBackgroundMode,
                        enabled = !state.loading && (state.background.enabled || state.accounts.isNotEmpty()),
                        modifier = Modifier.testTag("background_toggle"))
                }
                Text(state.background.message, modifier = Modifier.testTag("background_status"))
                state.background.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text("监听所有已配对主机的未归档会话，不需要 FCM。开启后显示常驻通知，可随时停止，不影响原始 CLI。",
                    style = MaterialTheme.typography.bodySmall)
                Text("需保持联网并允许通知。系统清理、Doze、车机休眠或断电仍可能中断接收；不会开机自启或自动重启。审批和问题请停车后处理。",
                    style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = notifications) { Text("通知权限") }
            } }
            item { SettingsCard("Google FCM（可选）", Icons.Default.Notifications) {
                Text(state.pushStatus)
                Text("未开启后台模式时，界面实时连接会在应用进入后台时暂停。FCM 另需 Google 服务及可达网络，也不承诺必达。",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = model::syncPush) { Text("重新注册") }
                }
                if (state.catalogs.values.any { !it.pushConfigured })
                    Text("至少一个中转尚未配置 FCM 服务端。", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            } }
            item { SettingsCard("设备授权", Icons.Default.VerifiedUser) {
                Text("撤销此手机对某台 Dev Box 的授权后，即时断开该电脑的所有订阅和操作。也可在 Dev Box 命令行撤销其他手机。",
                    style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = pair) { Text("添加 Dev Box") }
            } }
            items(state.boxes, key = { "${it.accountId}:${it.host.id}" }) { box ->
                OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) {
                    Text(box.host.name, style = MaterialTheme.typography.titleMedium)
                    Text(box.relayUrl, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { revoke = box }) { Text("撤销此手机访问权限") }
                } }
            }
            items(state.accounts, key = { "relay:${it.id}" }) { account ->
                TextButton(onClick = { forget = account.id }) { Text("移除中转及本机缓存：${account.relayUrl}") }
            }
            item { SettingsCard("关于 DevPocket", Icons.Default.Info) {
                Text("0.1.0 · 开发版\nKotlin + Jetpack Compose 原生 Android 应用")
                Text("只连接明确注册的现有 CLI。无法热挂载的会话不会被伪装为已连接。归档/置顶是独立元数据。文件/Git 只读，遵守终端组织内容排除策略。",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 10.dp))
                Text("本地聊天缓存和草稿受 Android 应用沙箱保护；设备密钥由 Android Keystore 加密，备份已禁用。请使用系统锁屏。中转可见转发内容，不提供端到端加密。",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 10.dp))
            } }
        }
    }
    revoke?.let { box ->
        AlertDialog(onDismissRequest = { revoke = null }, title = { Text("撤销访问 ${box.host.name}？") },
            text = { Text("不会停止电脑上的 CLI。重新连接需要新的配对码。") },
            confirmButton = { TextButton(onClick = { model.revoke(box.accountId, box.host.id); revoke = null }) { Text("撤销") } },
            dismissButton = { TextButton(onClick = { revoke = null }) { Text("取消") } })
    }
    forget?.let { id ->
        AlertDialog(onDismissRequest = { forget = null }, title = { Text("移除本机凭据与缓存？") },
            text = { Text("本机草稿、历史缓存将被删除。这不是服务端撤销；丢失设备的授权请在 Dev Box 撤销。") },
            confirmButton = { TextButton(onClick = { model.forget(id); forget = null }) { Text("移除") } },
            dismissButton = { TextButton(onClick = { forget = null }) { Text("取消") } })
    }
}

@Composable
private fun SettingsCard(title: String, icon: ImageVector, content: @Composable ColumnScope.() -> Unit) {
    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(icon, contentDescription = null)
                Text(title, style = MaterialTheme.typography.titleMedium)
            }
            content()
        }
    }
}

@Composable
fun StatusLabel(text: String, active: Boolean = false) {
    Surface(shape = MaterialTheme.shapes.small,
        color = if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh) {
        Text(text, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
    }
}

fun stateLabel(state: String): String = when (state) {
    "idle" -> "空闲"; "running" -> "处理中"; "waiting" -> "等待你"; "cancel_requested" -> "已请求停止，待确认"
    "unsupported" -> "版本/能力不支持"; "offline" -> "原始会话离线"; else -> state
}

fun deliveryLabel(status: String): String = when (status) {
    "sending" -> "正在送达"; "dispatched" -> "已到中转，待 CLI 接收"; "admitted" -> "CLI 已接收 · 等待执行状态"
    "queued" -> "已在原始 CLI 中排队"
    "processing" -> "正在处理"; "completed" -> "本次处理完成"; "cancel_requested" -> "已请求停止，待运行时确认"
    "cancelled" -> "本次处理已取消"; "failed" -> "未成功"; "uncertain" -> "结果不确定 · 请在终端核实"
    "delivery_unknown" -> "送达未知 · 正在恢复"; "not_received" -> "中转未收到 · 可重试原请求"; else -> status
}
