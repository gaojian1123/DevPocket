@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.devpocket.app.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.devpocket.app.PocketUi
import dev.devpocket.app.PocketViewModel
import dev.devpocket.app.data.*

@Composable
fun SessionPane(state: PocketUi, model: PocketViewModel, expanded: Boolean) {
    val session = state.session ?: return
    var tab by rememberSaveable { mutableStateOf("chat") }
    var info by rememberSaveable { mutableStateOf(false) }
    var modelPicker by rememberSaveable { mutableStateOf(false) }
    var confirmStop by rememberSaveable { mutableStateOf(false) }
    var confirmPermission by remember { mutableStateOf<Pair<PendingRequest, String>?>(null) }
    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(model::upload) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri -> uri?.let(model::savePreview) }
    BackHandler(enabled = state.preview != null || state.diff != null || tab != "chat") {
        if (state.preview != null || state.diff != null) model.clearPreview() else tab = "chat"
    }
    Column(Modifier.fillMaxSize().imePadding().testTag("session_detail")) {
        TopAppBar(
            title = { Column {
                Text(session.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                Text(listOfNotNull(session.projectName, workspaceLabel(session), stateLabel(session.state)).joinToString(" · "),
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } },
            navigationIcon = {
                IconButton(onClick = model::closeSession) { Icon(if (expanded) Icons.Default.Close else Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = if (expanded) "关闭会话详情" else "返回会话列表") }
            },
            actions = { IconButton(onClick = { info = true }) { Icon(Icons.Default.Info, contentDescription = "运行时与权限状态") } },
        )
        if (!session.online || state.connection != "实时连接") {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
                Text(if (!session.online) "原始 CLI 当前离线。历史与草稿已保留，未完成任务不会被标记完成。" else state.connection,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
            }
        }
        if (session.state == "cancel_requested") {
            Text("停止请求已发送。只有运行时发出空闲/终止证据后才算停止；后台或脱离的子进程请在终端核实。",
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
        }
        SecondaryScrollableTabRow(
            selectedTabIndex = listOf("chat", "files", "git", "attachments").indexOf(tab).coerceAtLeast(0),
            edgePadding = 8.dp, divider = {},
        ) {
            for ((id, title) in listOf("chat" to "对话", "files" to "文件", "git" to "Git 只读", "attachments" to "附件")) {
                Tab(selected = tab == id, onClick = {
                    tab = id
                    when (id) {
                        "files" -> if (session.capabilities.files && session.online) model.listFiles(state.filePath)
                        "git" -> if (session.capabilities.git && session.online) model.loadGit()
                        "attachments" -> model.loadAttachments()
                    }
                }, text = { Text(title) })
            }
        }
        if (state.busy || state.uploading) LinearProgressIndicator(Modifier.fillMaxWidth())
        when (tab) {
            "chat" -> {
                ChatHistory(state, model, { request, decision -> confirmPermission = request to decision }, Modifier.weight(1f))
                ComposeBar(state, model,
                    attach = { upload.launch(arrayOf("text/plain", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp")) },
                    models = { modelPicker = true; model.loadModels() }, stop = { confirmStop = true })
            }
            "files" -> FilesPane(state, model, Modifier.weight(1f))
            "git" -> GitPane(state, model, Modifier.weight(1f))
            "attachments" -> AttachmentsPane(state, model, Modifier.weight(1f))
        }
    }
    if (confirmStop) AlertDialog(
        onDismissRequest = { confirmStop = false }, title = { Text("停止当前工作？") },
        text = { Text("向当前原始 CLI 发送取消请求，不关闭终端。CLI 也会清空等待处理的消息队列；消息文本仍保留在本机，可手动恢复为草稿。仅收到请求确认不代表所有子进程已退出。") },
        confirmButton = { TextButton(
            enabled = session.online && session.capabilities.abort && session.state in setOf("running", "waiting", "cancel_requested"),
            onClick = { confirmStop = false; model.action(Action.Abort) }) { Text("请求停止") } },
        dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("继续运行") } },
    )
    confirmPermission?.let { (request, decision) ->
        AlertDialog(onDismissRequest = { confirmPermission = null }, title = { Text(if (decision == "approve-once") "仅批准这一次？" else "拒绝此操作？") },
            text = { LazyColumn { item {
                Text(request.title, fontWeight = FontWeight.SemiBold)
                SelectionContainer { Text(request.detail, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                Text("此内容由工具/模型产生，可能不可信。组织策略仍由原始 CLI 执行。")
            } } },
            confirmButton = { TextButton(modifier = Modifier.testTag("confirm_permission"),
                enabled = !state.busy && session.online && state.requests.any { it == request && it.supportedBy(session.capabilities) },
                onClick = {
                confirmPermission = null
                model.action(Action.Permission(request.requestId, decision))
            }) { Text(if (decision == "approve-once") "批准一次" else "拒绝") } },
            dismissButton = { TextButton(onClick = { confirmPermission = null }) { Text("取消") } })
    }
    if (info) AlertDialog(onDismissRequest = { info = false }, title = { Text("原始运行时") },
        text = { LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("项目：${session.projectName}") }
            session.workspace?.let { workspace ->
                item { Text("工作区：${workspace.name}\n分支：${workspace.branch.ifBlank { "分离 HEAD" }}") }
            }
            item { Text("连接：${state.connection}\nCLI：${session.cliVersion}\n权限模式：${session.permissionMode}\n模型：${session.modelId}\n推理：${session.reasoningEffort.ifBlank { "运行时默认" }}") }
            item { SelectionContainer { Text("会话 ${session.sessionId}", style = MaterialTheme.typography.bodySmall) } }
            item { Text("手机只提供单次批准/拒绝，不修改终端权限模式，也不持有 GitHub 凭据。消息采用 CLI 原生排队：正在运行的工具不会因新消息立刻被改写。") }
            items(session.warnings) { warning -> Text(warning, style = MaterialTheme.typography.bodySmall) }
        } }, confirmButton = { TextButton(onClick = { info = false }) { Text("关闭") } })
    if (modelPicker) ModelDialog(state, onDismiss = { modelPicker = false }) { option, effort ->
        model.action(Action.SetModel(option.id, effort))
        modelPicker = false
    }
    state.preview?.let { preview ->
        PreviewDialog(preview, dismiss = model::clearPreview, save = { save.launch(preview.name) })
    }
    state.diff?.let { diff ->
        AlertDialog(onDismissRequest = model::clearPreview, title = { Text("只读差异") },
            text = { LazyColumn { item { SelectionContainer { Text(diff, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } } } },
            confirmButton = { TextButton(onClick = model::clearPreview) { Text("关闭") } })
    }
}

@Composable
private fun ChatHistory(state: PocketUi, model: PocketViewModel,
    decide: (PendingRequest, String) -> Unit, modifier: Modifier) {
    val messages = remember(state.events) { timeline(state.events) }
    val listState = rememberLazyListState()
    var followTail by rememberSaveable { mutableStateOf(true) }
    val outstanding = state.outbox.filter { it.command.action is Action.Message }
    val total = messages.size + state.requests.size + outstanding.size
    val scrollObserver = remember(listState) {
        object : NestedScrollConnection {
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput) followTail = !listState.canScrollForward
                return Offset.Zero
            }
        }
    }
    LaunchedEffect(messages.lastOrNull()?.text, total, state.selected, followTail) {
        if (followTail && total > 0) listState.scrollToItem(total - 1)
    }
    Box(modifier.fillMaxWidth()) {
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize().nestedScroll(scrollObserver),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(messages, key = { it.id }) { item ->
                Box(Modifier.fillMaxWidth(), contentAlignment = if (item.role == "user") Alignment.CenterEnd else Alignment.CenterStart) {
                    Surface(
                        modifier = Modifier.widthIn(max = 720.dp),
                        shape = MaterialTheme.shapes.large,
                        color = when (item.role) {
                            "user" -> MaterialTheme.colorScheme.primaryContainer
                            "tool" -> MaterialTheme.colorScheme.surfaceContainerHigh
                            "notice" -> MaterialTheme.colorScheme.tertiaryContainer
                            else -> MaterialTheme.colorScheme.surfaceContainerLow
                        },
                    ) {
                        Column(Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(when (item.role) { "user" -> "你"; "assistant" -> "Copilot"; "tool" -> item.name.ifBlank { "工具" }; else -> "提示" },
                                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                if (item.streaming) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.dp)
                            }
                            if (item.role == "tool") {
                                var show by rememberSaveable(item.id) { mutableStateOf(false) }
                                TextButton(onClick = { show = !show }, modifier = Modifier.heightIn(min = 48.dp)) {
                                    Text(if (show) "收起输出" else "查看工具输出（不可信内容）")
                                }
                                if (show) SelectionContainer { Text(item.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                            } else SelectionContainer {
                                Text(item.text.ifEmpty { if (item.streaming) "正在接收…" else "" },
                                    style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 6.dp))
                            }
                            item.attachments.forEach { name -> Text("附件：$name", style = MaterialTheme.typography.labelSmall) }
                        }
                    }
                }
            }
            items(outstanding, key = { "delivery:${it.command.commandId}" }) { entry ->
                OutlinedCard(Modifier.fillMaxWidth().widthIn(max = 720.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(deliveryLabel(entry.status), style = MaterialTheme.typography.labelMedium,
                            color = if (entry.status in setOf("failed", "uncertain", "delivery_unknown")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                        if (entry.status in setOf("sending", "delivery_unknown", "not_received", "failed", "uncertain"))
                            Text((entry.command.action as Action.Message).text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodySmall)
                        entry.error?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        Row {
                            if (entry.status in setOf("sending", "delivery_unknown", "not_received"))
                                TextButton(enabled = state.session?.online == true, onClick = { model.retry(entry) }) { Text("重试原请求") }
                            if (entry.status in setOf("failed", "cancelled")) TextButton(onClick = { model.restoreDraft(entry) }) { Text("恢复为草稿") }
                        }
                    }
                }
            }
            items(state.requests, key = { "request:${it.requestId}" }) { request ->
                val supported = state.session?.let { request.supportedBy(it.capabilities) } == true
                RequestCard(request.copy(supported = supported),
                    state.busy || state.session?.online != true, decide) { answer ->
                    model.action(Action.Answer(request.requestId, answer))
                }
            }
        }
        if (messages.isEmpty() && state.requests.isEmpty()) {
            Text("发送消息，继续这一个终端会话。\n可在手机和终端之间切换，既有历史会同步到这里。",
                modifier = Modifier.align(Alignment.Center).padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (!followTail && total > 0) FilledTonalButton(onClick = { followTail = true },
            modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp)) {
            Icon(Icons.Default.ArrowDownward, contentDescription = null)
            Text("最新")
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RequestCard(request: PendingRequest, disabled: Boolean,
    decide: (PendingRequest, String) -> Unit, answer: (String) -> Unit) {
    var typed by rememberSaveable(request.requestId) { mutableStateOf("") }
    ElevatedCard(Modifier.fillMaxWidth().widthIn(max = 720.dp),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(request.title, style = MaterialTheme.typography.titleMedium)
            SelectionContainer { Text(request.detail, style = MaterialTheme.typography.bodyMedium) }
            if (!request.supported || request.type == "terminal") {
                Text("请在原始终端处理。此形式不支持远程确认，不会自动接受。",
                    color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.SemiBold)
            } else if (request.type == "permission") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !disabled, onClick = { decide(request, "approve-once") },
                        modifier = Modifier.testTag("request_approve_${request.requestId}")) { Text("批准一次") }
                    OutlinedButton(enabled = !disabled, onClick = { decide(request, "reject") }) { Text("拒绝") }
                }
            } else {
                request.choices.forEach { choice ->
                    OutlinedButton(enabled = !disabled, onClick = { answer(choice) }, modifier = Modifier.fillMaxWidth()) {
                        Text(choice, modifier = Modifier.fillMaxWidth())
                    }
                }
                if (request.allowFreeform) {
                    OutlinedTextField(typed, { typed = it.take(8000) }, modifier = Modifier.fillMaxWidth(), label = { Text("你的回答") })
                    Button(enabled = typed.isNotBlank() && !disabled, onClick = { answer(typed) }) { Text("回答") }
                }
            }
        }
    }
}

@Composable
private fun ComposeBar(state: PocketUi, model: PocketViewModel, attach: () -> Unit, models: () -> Unit, stop: () -> Unit) {
    val session = state.session ?: return
    Surface(tonalElevation = 3.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = models, enabled = session.online && session.capabilities.models && !state.busy,
                    modifier = Modifier.weight(1f)) {
                    Text("${session.modelId.ifBlank { "模型不可用" }}${session.reasoningEffort.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()}",
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                IconButton(onClick = attach, enabled = session.online && !state.uploading && state.draft.attachments.size < 4) {
                    Icon(Icons.Default.AttachFile, contentDescription = "选择附件，最多 2 MiB")
                }
                IconButton(onClick = stop, enabled = session.online && session.capabilities.abort && session.state in setOf("running", "waiting", "cancel_requested")) {
                    Icon(Icons.Default.StopCircle, contentDescription = "请求停止当前任务", tint = MaterialTheme.colorScheme.error)
                }
            }
            for (attachment in state.draft.attachments) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(attachment.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                    IconButton(onClick = { model.removeAttachment(attachment.id) }) { Icon(Icons.Default.Close, contentDescription = "移除附件 ${attachment.name}") }
                }
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(state.draft.text, model::editDraft,
                    modifier = Modifier.weight(1f).heightIn(max = 180.dp).testTag("message_input"), maxLines = 5,
                    label = { Text(if (session.online) "继续原始会话" else "离线草稿") },
                    supportingText = { Text("CLI 排队处理 · 不立即中断工具", style = MaterialTheme.typography.labelSmall) })
                FilledIconButton(onClick = model::send,
                    enabled = state.draft.text.isNotBlank() && session.online && session.capabilities.messages && !state.uploading,
                    modifier = Modifier.padding(bottom = 28.dp).size(48.dp)) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送到原始 CLI")
                }
            }
        }
    }
}

@Composable
private fun FilesPane(state: PocketUi, model: PocketViewModel, modifier: Modifier) {
    if (state.session?.capabilities?.files != true) {
        Text("文件浏览需要原始 CLI 可用的内容排除策略。当前不可用，请在终端查看。", modifier.padding(24.dp))
        return
    }
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { model.listFiles(state.filePath.substringBeforeLast('/', "")) }, enabled = state.filePath.isNotBlank() && state.session.online) {
                Icon(Icons.Default.ArrowUpward, contentDescription = "上一级目录")
            }
            Text(state.filePath.ifBlank { "项目根目录" }, Modifier.weight(1f), maxLines = 2, style = MaterialTheme.typography.bodySmall)
            IconButton(onClick = { model.listFiles(state.filePath) }, enabled = state.session.online) { Icon(Icons.Default.Refresh, contentDescription = "刷新文件") }
        }
        LazyColumn {
            if (state.fileTruncated) item { Text("当前目录仅显示前 200 项，请在终端查看其余内容。", Modifier.padding(16.dp)) }
            items(state.files, key = { it.path }) { file ->
                ListItem(
                    headlineContent = { Text(file.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Icon(if (file.directory) Icons.Default.Folder else Icons.Default.Description, contentDescription = null) },
                    modifier = Modifier.clickable(enabled = state.session.online && !state.busy) {
                        if (file.directory) model.listFiles(file.path) else model.readFile(file.path)
                    },
                )
            }
            if (state.files.isEmpty() && !state.busy) item { Text("没有可显示的项目文件。凭据路径、符号链接和组织排除内容不会显示。", Modifier.padding(24.dp)) }
        }
    }
}

@Composable
private fun GitPane(state: PocketUi, model: PocketViewModel, modifier: Modifier) {
    if (state.session?.capabilities?.git != true) {
        Text("Git 只读视图当前不可用。需要原始 CLI 的项目目录、Git 和内容排除策略。", modifier.padding(24.dp))
        return
    }
    LazyColumn(modifier.fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) {
            Text(state.git?.branch ?: "尚未读取分支", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            IconButton(onClick = model::loadGit, enabled = state.session.online) { Icon(Icons.Default.Refresh, contentDescription = "刷新 Git 状态") }
        } }
        item { Text("只读：分支、索引/工作区状态及差异。没有提交、暂存或推送操作。", style = MaterialTheme.typography.bodySmall) }
        items(state.git?.files.orEmpty(), key = { it.path }) { file ->
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Text(file.path, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
                    Text("索引 ${file.index} · 工作区 ${file.worktree}", style = MaterialTheme.typography.labelSmall)
                    Row {
                        TextButton(onClick = { model.loadDiff(file.path, true) }, enabled = state.session.online && !state.busy) { Text("已暂存差异") }
                        TextButton(onClick = { model.loadDiff(file.path, false) }, enabled = state.session.online && !state.busy) { Text("工作区差异") }
                    }
                }
            }
        }
        if (state.git?.files?.isEmpty() == true) item { Text("没有可见的改动。", Modifier.padding(vertical = 24.dp)) }
        if (state.git?.truncated == true) item { Text("更改过多，仅展示前 300 项。", color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun AttachmentsPane(state: PocketUi, model: PocketViewModel, modifier: Modifier) {
    LazyColumn(modifier.fillMaxWidth(), contentPadding = PaddingValues(16.dp)) {
        item { Row(verticalAlignment = Alignment.CenterVertically) {
            Text("会话附件 · 7 天保留", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            IconButton(onClick = model::loadAttachments) { Icon(Icons.Default.Refresh, contentDescription = "刷新附件") }
        } }
        item { Text("附件只属于此电脑的此会话。文本与图片原生预览，PDF 可保存后用系统应用打开。", style = MaterialTheme.typography.bodySmall) }
        items(state.attachments, key = { it.id }) { attachment ->
            ListItem(headlineContent = { Text(attachment.name) }, supportingContent = { Text("${attachment.mime} · ${attachment.size / 1024} KiB") },
                leadingContent = { Icon(Icons.Default.AttachFile, contentDescription = null) },
                modifier = Modifier.clickable { model.previewAttachment(attachment) })
        }
        if (state.attachments.isEmpty()) item { Text("还没有附件，或附件已到期。", Modifier.padding(vertical = 24.dp)) }
    }
}

@Composable
private fun ModelDialog(state: PocketUi, onDismiss: () -> Unit, select: (ModelOption, String?) -> Unit) {
    var selected by remember { mutableStateOf<ModelOption?>(null) }
    var effort by remember { mutableStateOf<String?>(null) }
    var customEffort by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("模型与推理强度") },
        text = { LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Text("选择来自这台 Dev Box 的实时 CLI 能力。组织策略与订阅不变；运行中的模型切换可能排队生效。", style = MaterialTheme.typography.bodySmall) }
            items(state.models, key = { it.id }) { option ->
                Row(Modifier.fillMaxWidth().clickable(enabled = option.enabled) { selected = option; effort = null }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = selected?.id == option.id, onClick = { selected = option; effort = null }, enabled = option.enabled)
                    Text(option.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                }
            }
            selected?.let { option ->
                item { HorizontalDivider(); Text("推理强度", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp)) }
                item { Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { effort = null }) {
                    RadioButton(selected = effort == null, onClick = { effort = null }); Text("运行时默认")
                } }
                items(option.reasoningEfforts) { level ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { effort = level }) {
                        RadioButton(selected = effort == level, onClick = { effort = level }); Text(level)
                    }
                }
                if (option.reasoningManual) item {
                    Text("此 CLI 目录未列出可选推理级别。可输入级别交由原始运行时校验；不支持或策略禁止时会明确拒绝，不会猜测支持。",
                        style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(customEffort, { customEffort = it.take(60); effort = it.trim().ifEmpty { null } },
                        label = { Text("推理级别（留空为默认）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
            }
            if (state.models.isEmpty() && !state.busy) item { Text("模型目录未能加载，请在原始终端查看。") }
        } }, confirmButton = { TextButton(
            enabled = selected != null && !state.busy && state.session?.online == true && state.session.capabilities.models,
            onClick = { selected?.let { select(it, effort) } }) { Text("应用") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}
