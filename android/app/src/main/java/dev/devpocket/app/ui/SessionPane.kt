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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
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
    var componentId by rememberSaveable { mutableStateOf<String?>(null) }
    var componentReferenceError by remember(componentId) { mutableStateOf<String?>(null) }
    var focusComposer by remember { mutableStateOf(false) }
    val composerFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(model::upload) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri -> uri?.let(model::savePreview) }
    BackHandler(enabled = componentId != null || state.preview != null || state.diff != null || tab != "chat") {
        if (componentId != null) componentId = null
        else if (state.preview != null || state.diff != null) model.clearPreview() else tab = "chat"
    }
    LaunchedEffect(focusComposer) {
        if (focusComposer) {
            withFrameNanos { }
            composerFocus.requestFocus()
            keyboard?.show()
            focusComposer = false
        }
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
                Text(if (!session.online) "原始 GitHub Copilot 会话当前离线。历史与草稿已保留，未完成任务不会被标记完成。" else state.connection,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
            }
        }
        if (session.state == "cancel_requested") {
            Text("停止请求已发送。只有运行时发出空闲/终止证据后才算停止；后台或脱离的子进程请在原始客户端核实。",
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
                ChatHistory(state, model, { request, decision -> confirmPermission = request to decision },
                    { componentId = it.componentId }, Modifier.weight(1f))
                ComposeBar(state, editDraft = model::editDraft, removeAttachment = model::removeAttachment, send = model::send,
                    attach = { upload.launch(arrayOf("text/plain", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp")) },
                    models = { modelPicker = true; model.loadModels() }, stop = { confirmStop = true },
                    removeComponentReference = model::removeComponentReference,
                    inputModifier = Modifier.focusRequester(composerFocus))
            }
            "files" -> FilesPane(state, model, Modifier.weight(1f))
            "git" -> GitPane(state, model, Modifier.weight(1f))
            "attachments" -> AttachmentsPane(state, model, Modifier.weight(1f))
        }
    }
    componentId?.let { selected ->
        val card = state.events.asReversed().firstOrNull { it.component?.componentId == selected &&
            it.hostId == state.selected?.hostId && it.sessionId == state.selected.sessionId }?.component
        ComponentDetail(card, state.requests.isNotEmpty(), !state.uploading, componentReferenceError,
            dismiss = { componentId = null }, reference = { value ->
                val scope = state.selected
                if (scope != null && model.referenceComponent(scope, value)) {
                    componentId = null
                    tab = "chat"
                    focusComposer = true
                } else componentReferenceError = model.ui.value.error ?: "无法引用这张卡片，请返回对话重新选择。"
            })
    }
    if (confirmStop) AlertDialog(
        onDismissRequest = { confirmStop = false }, title = { Text("停止当前工作？") },
        text = { Text("向当前 GitHub Copilot 会话发送取消请求，不关闭原始客户端。运行时也会清空等待处理的消息队列；消息文本仍保留在本机，可手动恢复为草稿。仅收到请求确认不代表所有子进程已退出。") },
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
                Text("此内容由工具/模型产生，可能不可信。组织策略仍由原始 GitHub Copilot 运行时执行。")
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
            item { Text("连接：${state.connection}\n运行时版本：${session.cliVersion}\n权限模式：${session.permissionMode}\n模型：${session.modelId}\n推理：${session.reasoningEffort.ifBlank { "运行时默认" }}") }
            item { SelectionContainer { Text("会话 ${session.sessionId}", style = MaterialTheme.typography.bodySmall) } }
            item { Text("手机只提供单次批准/拒绝，不修改原始运行时的权限模式，也不持有 GitHub 凭据。消息采用 GitHub Copilot 原生排队：正在运行的工具不会因新消息立刻被改写。") }
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
    decide: (PendingRequest, String) -> Unit, openComponent: (ComponentCard) -> Unit, modifier: Modifier) {
    val messages = remember(state.events, state.outbox, state.selected, state.firstRetainedEventCursor) {
        timeline(state.events, state.outbox, state.selected, state.firstRetainedEventCursor)
    }
    val questions = messages.mapNotNull { it.question }
    val requests = state.requests.filter { request ->
        request.type != "question" || questions.none { it.record.request.sameQuestion(request) }
    }
    val listState = rememberLazyListState()
    var followTail by rememberSaveable { mutableStateOf(true) }
    var componentLayout by remember { mutableIntStateOf(0) }
    val responseRail = MaterialTheme.colorScheme.primary.copy(alpha = .3f)
    val outstanding = state.outbox.filter { it.command.action is Action.Message }
    val total = messages.size + requests.size + outstanding.size
    val scrollObserver = remember(listState) {
        object : NestedScrollConnection {
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput) followTail = !listState.canScrollForward
                return Offset.Zero
            }
        }
    }
    LaunchedEffect(messages, requests, outstanding, state.selected, followTail, componentLayout) {
        if (followTail && total > 0) {
            var positioned = false
            snapshotFlow {
                val layout = listState.layoutInfo
                Triple(layout.visibleItemsInfo.lastOrNull { it.index == total - 1 }?.size,
                    (layout.viewportSize.height - layout.beforeContentPadding - layout.afterContentPadding).coerceAtLeast(0),
                    listState.isScrollInProgress)
            }.collect { (tailSize, viewport, scrolling) ->
                if (!scrolling) {
                    if (tailSize != null) {
                        val requestPosition = !positioned || listState.canScrollForward
                        positioned = true
                        if (requestPosition)
                            listState.requestScrollToItem(total - 1, (tailSize - viewport).coerceAtLeast(0))
                    } else if (!positioned) {
                        positioned = true
                        listState.requestScrollToItem(total - 1)
                    }
                }
            }
        }
    }
    Box(modifier.fillMaxWidth()) {
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize().nestedScroll(scrollObserver).testTag("chat_history"),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(0.dp)) {
            itemsIndexed(messages, key = { _, item -> item.id }) { index, item ->
                val grouped = sameResponse(messages.getOrNull(index - 1), item)
                val question = item.question
                if (question != null) {
                    Spacer(Modifier.height(12.dp))
                    val pending = state.requests.find { it.sameQuestion(question.record.request) }
                    val request = pending ?: question.record.request
                    val supported = state.session?.let { request.supportedBy(it.capabilities) } == true
                    RequestCard(request.copy(supported = supported), state.busy || state.session?.online != true, decide,
                        history = question, pending = pending != null, submitting = state.submittingAnswers, retry = model::retry) { answer ->
                        model.action(Action.Answer(request.requestId, answer))
                    }
                    return@itemsIndexed
                }
                val associated = item.originatingMessageId != null && item.role in setOf("assistant", "tool", "component")
                val responseModifier = if (associated) Modifier.drawBehind {
                    drawLine(responseRail, Offset.Zero, Offset(0f, size.height), strokeWidth = 2.dp.toPx())
                }.padding(start = 10.dp) else Modifier
                Box(Modifier.fillMaxWidth().padding(top = if (grouped) 2.dp else 12.dp).then(responseModifier),
                    contentAlignment = if (item.role == "user") Alignment.CenterEnd else Alignment.CenterStart) {
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
                            if (!grouped) Row(
                                modifier = Modifier.testTag("response_header_${item.id}"),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Text(if (associated) "Copilot" else when (item.role) {
                                    "user" -> "你"; "assistant" -> "Copilot"; "tool" -> item.name.ifBlank { "工具" }
                                    "component" -> "可视化"; else -> "提示"
                                }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (item.streaming) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.dp)
                            if (item.component != null) {
                                ComponentCardView(item.component, open = {
                                    followTail = false
                                    openComponent(item.component)
                                },
                                    onMeasured = { componentLayout++ })
                            } else if (item.role == "tool") {
                                if (associated) Text(item.name.ifBlank { "工具" }, style = MaterialTheme.typography.labelSmall)
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
                Spacer(Modifier.height(12.dp))
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
            items(requests, key = { "request:${it.requestId}" }) { request ->
                Spacer(Modifier.height(12.dp))
                val supported = state.session?.let { request.supportedBy(it.capabilities) } == true
                RequestCard(request.copy(supported = supported),
                    state.busy || state.session?.online != true, decide) { answer ->
                    model.action(Action.Answer(request.requestId, answer))
                }
            }
        }
        if (messages.isEmpty() && requests.isEmpty()) {
            Text("发送消息，继续这一个 GitHub Copilot 会话。\n可在手机和原始客户端之间切换，既有历史会同步到这里。",
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
    decide: (PendingRequest, String) -> Unit, history: QuestionHistory? = null, pending: Boolean = true,
    submitting: Set<String> = emptySet(), retry: (Outbox) -> Unit = {}, answer: (String) -> Unit) {
    var typed by rememberSaveable(request.requestId) { mutableStateOf("") }
    val readOnly = history != null && (!pending || history.blocksNewAnswer)
    ElevatedCard(Modifier.fillMaxWidth().widthIn(max = 720.dp)
        .then(if (history != null) Modifier.testTag("question_history_${history.record.questionId}") else Modifier),
        colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(request.title, style = MaterialTheme.typography.titleMedium)
            SelectionContainer { Text(request.detail, style = MaterialTheme.typography.bodyMedium) }
            if (history != null) {
                if (history.record.status == "confirmed") {
                    Text("已确认的回答 · 只读", fontWeight = FontWeight.SemiBold)
                    SelectionContainer { Text(history.record.answer.orEmpty(), modifier = Modifier.testTag("confirmed_answer_${history.record.questionId}")) }
                } else if (history.record.status == "unknown" || !pending) {
                    Text("问题已不在待处理列表；实际答案未知。", fontWeight = FontWeight.SemiBold)
                }
                history.attempts.forEach { attempt ->
                    val status = answerAttemptStatus(attempt, history.record)
                    if (status != "confirmed") {
                        Text(when (status) {
                            "failed" -> "回答失败 · 未确认"
                            "cancelled" -> "回答已取消 · 未确认"
                            "uncertain" -> "回答结果不确定"
                            "sending" -> if (attempt.command.commandId in submitting) "正在提交回答" else "回答尚未确认"
                            else -> "回答尚未确认"
                        }, fontWeight = FontWeight.SemiBold)
                        SelectionContainer { Text("尝试提交：${answerHistoryText((attempt.command.action as Action.Answer).answer)}") }
                        attempt.error?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        if (pending && history.record.status == "pending" &&
                            attempt.status in setOf("sending", "delivery_unknown", "not_received")) {
                            TextButton(enabled = !disabled && request.supported, onClick = { retry(attempt) }) { Text("重试原回答请求") }
                        }
                    }
                }
            }
            if (readOnly) {
                request.choices.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
                if (history.record.status != "confirmed")
                    Text("未确认的尝试不代表运行时接受了该答案；请在原始客户端核实。", style = MaterialTheme.typography.bodySmall)
            } else if (!request.supported || request.type == "terminal") {
                Text("请在原始 GitHub Copilot 客户端处理。此形式不支持远程确认，不会自动接受。",
                    color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.SemiBold)
            } else if (request.type == "permission") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !disabled, onClick = { decide(request, "approve-once") },
                        modifier = Modifier.testTag("request_approve_${request.requestId}")) { Text("批准一次") }
                    OutlinedButton(enabled = !disabled, onClick = { decide(request, "reject") }) { Text("拒绝") }
                }
            } else {
                request.choices.forEachIndexed { index, choice ->
                    OutlinedButton(enabled = !disabled, onClick = { answer(choice) },
                        modifier = Modifier.fillMaxWidth().testTag("question_choice_${request.requestId}_$index")) {
                        Text(choice, modifier = Modifier.fillMaxWidth())
                    }
                }
                if (request.allowFreeform) {
                    OutlinedTextField(typed, { typed = it.take(8000) },
                        modifier = Modifier.fillMaxWidth().testTag("question_input_${request.requestId}"), label = { Text("你的回答") })
                    Button(enabled = typed.isNotBlank() && !disabled, onClick = { answer(typed) },
                        modifier = Modifier.testTag("question_submit_${request.requestId}")) { Text("回答") }
                }
            }
        }
    }
}

@Composable
internal fun ComposeBar(
    state: PocketUi,
    editDraft: (String) -> Unit,
    removeAttachment: (String) -> Unit,
    send: () -> Unit,
    attach: () -> Unit,
    models: () -> Unit,
    stop: () -> Unit,
    modifier: Modifier = Modifier,
    removeComponentReference: () -> Unit = {},
    inputModifier: Modifier = Modifier,
) {
    val session = state.session ?: return
    val hasMessage = state.draft.text.isNotBlank()
    val showStop = !hasMessage && session.state in setOf("running", "waiting", "cancel_requested")
    Surface(modifier = modifier, tonalElevation = 3.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = models, enabled = session.online && session.capabilities.models && !state.busy,
                    modifier = Modifier.weight(1f)) {
                    Text("${session.modelId.ifBlank { "模型不可用" }}${session.reasoningEffort.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()}",
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                IconButton(onClick = attach, enabled = session.online && !state.uploading && state.draft.attachmentCount < 4) {
                    Icon(Icons.Default.AttachFile, contentDescription = "选择附件，最多 2 MiB")
                }
            }
            for (attachment in state.draft.attachments) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(attachment.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                    IconButton(onClick = { removeAttachment(attachment.id) }) { Icon(Icons.Default.Close, contentDescription = "移除附件 ${attachment.name}") }
                }
            }
            state.draft.componentReference?.let { selection ->
                Row(Modifier.fillMaxWidth().testTag("component_reference"), verticalAlignment = Alignment.CenterVertically) {
                    Text("引用整张卡片：${selection.title}", Modifier.weight(1f), maxLines = 2,
                        overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium)
                    IconButton(onClick = removeComponentReference) {
                        Icon(Icons.Default.Close, contentDescription = "移除卡片引用")
                    }
                }
                if (session.online && session.componentVersion != COMPONENT_VERSION)
                    Text("当前连接不支持引用；可保留草稿或移除引用。", color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.labelSmall)
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(state.draft.text, editDraft,
                    modifier = Modifier.weight(1f).heightIn(max = 180.dp).then(inputModifier).testTag("message_input"), maxLines = 5,
                    label = { Text(if (session.online) "继续原始会话" else "离线草稿") },
                    supportingText = { Text("原始会话排队处理 · 不立即中断工具", style = MaterialTheme.typography.labelSmall) })
                FilledIconButton(onClick = if (showStop) stop else send,
                    enabled = if (showStop) session.online && session.capabilities.abort
                        else hasMessage && session.online && session.capabilities.messages && !state.uploading &&
                            (state.draft.componentReference == null || session.componentVersion == COMPONENT_VERSION),
                    colors = if (showStop) IconButtonDefaults.filledIconButtonColors(
                        containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError,
                    ) else IconButtonDefaults.filledIconButtonColors(),
                    modifier = Modifier.padding(bottom = 28.dp).size(48.dp).testTag("composer_action")) {
                    if (showStop) Icon(Icons.Default.Stop, contentDescription = "请求停止当前任务")
                    else Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送到原始 GitHub Copilot 会话")
                }
            }
        }
    }
}

@Composable
private fun FilesPane(state: PocketUi, model: PocketViewModel, modifier: Modifier) {
    if (state.session?.capabilities?.files != true) {
        Text("文件浏览需要原始 GitHub Copilot 运行时可用的内容排除策略。当前不可用，请在原始客户端查看。", modifier.padding(24.dp))
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
            if (state.fileTruncated) item { Text("当前目录仅显示前 200 项，请在原始客户端查看其余内容。", Modifier.padding(16.dp)) }
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
        Text("Git 只读视图当前不可用。需要原始 GitHub Copilot 运行时的项目目录、Git 和内容排除策略。", modifier.padding(24.dp))
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ModelDialog(state: PocketUi, onDismiss: () -> Unit, select: (ModelOption, String?) -> Unit) {
    var selectedId by rememberSaveable(state.selected, state.session?.sessionId) { mutableStateOf<String?>(null) }
    val modelId = selectedId ?: state.session?.modelId
    val selected = state.models.find { it.id == modelId }
    var effortEdited by rememberSaveable(state.selected, modelId) { mutableStateOf(false) }
    var effortInput by rememberSaveable(state.selected, modelId) { mutableStateOf("") }
    val currentEffort = state.session?.takeIf { it.modelId == modelId }?.reasoningEffort.orEmpty()
    val effortText = if (effortEdited) effortInput else currentEffort
    val effort = effortText.trim().ifEmpty { null }
    val validEffort = selected != null && (effort == null || selected.reasoningManual || effort in selected.reasoningEfforts)
    val enabled = !state.busy && state.session?.online == true && state.session.capabilities.models
    var modelMenu by remember { mutableStateOf(false) }
    // Keep editable content from repeatedly changing the dialog's wrap-content width.
    AlertDialog(onDismissRequest = onDismiss, title = { Text("模型与推理强度") },
        properties = DialogProperties(usePlatformDefaultWidth = false),
        modifier = Modifier.padding(horizontal = 24.dp).widthIn(max = 560.dp).fillMaxWidth(),
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("选择这台 Dev Box 上 GitHub Copilot 实时提供的模型。组织策略与订阅不变；运行中的模型切换可能排队生效。", style = MaterialTheme.typography.bodySmall)
            Box(Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = { modelMenu = true }, enabled = enabled && state.models.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth().testTag("model_picker")) {
                    Text(selected?.name ?: modelId?.ifBlank { null } ?: "选择模型", modifier = Modifier.weight(1f),
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Default.ArrowDropDown, contentDescription = "选择模型")
                }
                DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false },
                    modifier = Modifier.heightIn(max = 280.dp)) {
                    state.models.forEach { option ->
                        DropdownMenuItem(text = { Text(option.name) }, enabled = enabled && option.enabled, onClick = {
                            selectedId = option.id
                            modelMenu = false
                        })
                    }
                }
            }
            selected?.let { option ->
                HorizontalDivider()
                Text("推理强度", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = effort == null, enabled = enabled && option.enabled,
                        onClick = { effortEdited = true; effortInput = "" }, label = { Text("运行时默认") })
                    option.reasoningEfforts.forEach { level ->
                        FilterChip(selected = effort == level, enabled = enabled && option.enabled,
                            onClick = { effortEdited = true; effortInput = level }, label = { Text(level) })
                    }
                }
                if (option.reasoningManual) {
                    Text("此模型目录未列出可选推理级别。可输入级别交由原始运行时校验；不支持或策略禁止时会明确拒绝，不会猜测支持。",
                        style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(effortText, { effortEdited = true; effortInput = it.take(60) },
                        enabled = enabled && option.enabled, label = { Text("推理级别（留空为默认）") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("reasoning_input"))
                }
                if (!validEffort) {
                    Text("当前推理级别 $effort 不在此模型的实时目录中，请重新选择。",
                        color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (state.models.isEmpty() && !state.busy) Text("模型目录未能加载，请在原始客户端查看。")
        } }, confirmButton = { TextButton(
            enabled = selected?.enabled == true && validEffort && enabled, modifier = Modifier.testTag("apply_model"),
            onClick = { selected?.let { select(it, effort) } }) { Text("应用") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}
