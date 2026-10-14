package dev.devpocket.app

import android.app.Application
import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.devpocket.app.background.BackgroundCheckpoints
import dev.devpocket.app.background.BackgroundState
import dev.devpocket.app.data.*
import dev.devpocket.app.push.Notifications
import dev.devpocket.app.push.PushSetup
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put

data class BoxCard(val accountId: String, val relayUrl: String, val host: Host, val sessions: List<SessionInfo>)
data class PocketUi(
    val loading: Boolean = true,
    val accounts: List<Account> = emptyList(),
    val catalogs: Map<String, Catalog> = emptyMap(),
    val reachable: Set<String> = emptySet(),
    val selected: Scope? = null,
    val session: SessionInfo? = null,
    val events: List<WireEvent> = emptyList(),
    val draft: Draft = Draft(),
    val outbox: List<Outbox> = emptyList(),
    val submittingAnswers: Set<String> = emptySet(),
    val requests: List<PendingRequest> = emptyList(),
    val connection: String = "未连接",
    val busy: Boolean = false,
    val uploading: Boolean = false,
    val error: String? = null,
    val theme: String = "system",
    val pushStatus: String = "未配置原生推送",
    val background: BackgroundState = BackgroundState(),
    val navigateToSession: Boolean = false,
    val files: List<FileEntry> = emptyList(),
    val filePath: String = "",
    val fileTruncated: Boolean = false,
    val preview: FilePreview? = null,
    val git: GitInfo? = null,
    val diff: String? = null,
    val models: List<ModelOption> = emptyList(),
    val attachments: List<Attachment> = emptyList(),
) {
    val boxes: List<BoxCard> get() = accounts.flatMap { account ->
        catalogs[account.id]?.let { catalog ->
            catalog.hosts.map { host ->
                BoxCard(account.id, account.relayUrl, host.copy(online = host.online && account.id in reachable),
                    catalog.sessions.filter { it.hostId == host.id }.map {
                        if (account.id in reachable) it else it.copy(online = false, state = "offline")
                    })
            }
        }.orEmpty()
    }
}

class PocketViewModel(application: Application) : AndroidViewModel(application) {
    private val local = LocalStore(application)
    private val vault = Vault(application)
    private val prefs = application.getSharedPreferences("devpocket_settings", 0)
    private val background = (application as DevPocketApplication).background
    private val mutable = MutableStateFlow(PocketUi(theme = prefs.getString("theme", "system") ?: "system",
        background = background.state.value))
    val ui = mutable.asStateFlow()
    private var active = false
    private var streamJob: Job? = null
    private var refreshJob: Job? = null
    private var notificationJob: Job? = null
    private val staging = mutableSetOf<Pair<String, Long>>()
    private val answerStaging = mutableSetOf<Pair<String, String>>()
    private val api: RelayApi get() = apiFor(mutable.value.selected ?: error("没有选择会话。"))
    private fun apiFor(scope: Scope) = RelayApi(mutable.value.accounts.first { it.id == scope.accountId })

    init {
        viewModelScope.launch {
            background.state.collect { status -> mutable.update { it.copy(background = status) } }
        }
        viewModelScope.launch {
            attempt {
                val accounts = withContext(Dispatchers.IO) { vault.accounts() }
                val catalogs = withContext(Dispatchers.IO) { accounts.mapNotNull { a -> local.catalog(a.id)?.let { a.id to it } }.toMap() }
                mutable.update { it.copy(accounts = accounts, catalogs = catalogs, loading = false, pushStatus = PushSetup.status(application)) }
                prefs.getString("last_scope", null)?.let { saved ->
                    val scope = WireJson.decodeFromString<Scope>(saved)
                    val session = catalogs[scope.accountId]?.sessions?.find { it.hostId == scope.hostId && it.sessionId == scope.sessionId }
                    if (session != null) open(scope, session.copy(online = false, state = "offline"))
                }
                refresh()
            }
            mutable.update { it.copy(loading = false) }
        }
    }

    private suspend fun attempt(block: suspend () -> Unit) {
        try { block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { mutable.update { it.copy(error = error.message ?: "操作失败，请查看 Dev Box 终端。") } }
    }

    fun clearError() = mutable.update { it.copy(error = null) }
    fun setTheme(value: String) {
        require(value in setOf("system", "light", "dark"))
        prefs.edit().putString("theme", value).apply()
        mutable.update { it.copy(theme = value) }
    }

    fun foreground(value: Boolean) {
        active = value
        if (!value) {
            streamJob?.cancel(); refreshJob?.cancel()
            mutable.update { it.copy(connection = if (background.state.value.enabled)
                "界面同步已暂停；后台模式继续监听未归档会话" else "后台已暂停实时连接") }
            return
        }
        background.checkPermissions()
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            while (isActive) { refresh(); delay(15_000) }
        }
        mutable.value.selected?.let(::startStream)
    }

    fun refreshNow() { viewModelScope.launch { refresh() } }

    fun setBackgroundMode(enabled: Boolean) {
        if (!enabled) {
            background.stop()
            return
        }
        viewModelScope.launch { attempt {
            check(active) { "请在应用可见时手动开启后台模式。" }
            check(mutable.value.accounts.isNotEmpty()) { "请先配对 Dev Box。" }
            background.start()
        } }
    }

    fun openNotification(serializedScope: String) {
        notificationJob?.cancel()
        notificationJob = viewModelScope.launch { attempt {
            ui.first { !it.loading }
            val scope = WireJson.decodeFromString<Scope>(serializedScope)
            val account = mutable.value.accounts.find { it.id == scope.accountId } ?: error("通知对应的中转已移除。")
            val catalog = RelayApi(account).catalog()
            check(account in mutable.value.accounts) { "通知对应的配对已发生变化，请重新打开。" }
            val session = catalog.sessions.find {
                it.hostId == scope.hostId && it.sessionId == scope.sessionId && !it.archived &&
                    catalog.hosts.any { host -> host.id == it.hostId }
            } ?: error("通知对应的会话已归档或授权已失效。")
            withContext(Dispatchers.IO) { local.saveCatalog(scope.accountId, catalog) }
            check(account in mutable.value.accounts) { "通知对应的配对已发生变化，请重新打开。" }
            mutable.update { it.copy(catalogs = it.catalogs + (scope.accountId to catalog),
                reachable = it.reachable + scope.accountId) }
            open(scope, session)
            mutable.update { it.copy(navigateToSession = true) }
        } }
    }

    fun navigationHandled() = mutable.update { it.copy(navigateToSession = false) }

    private suspend fun refresh() {
        for (account in mutable.value.accounts) {
            try {
                val catalog = RelayApi(account).catalog()
                withContext(Dispatchers.IO) { local.saveCatalog(account.id, catalog) }
                mutable.update { state ->
                    val selected = state.selected
                    val current = if (selected?.accountId == account.id)
                        catalog.sessions.find { it.hostId == selected.hostId && it.sessionId == selected.sessionId } else state.session
                    state.copy(catalogs = state.catalogs + (account.id to catalog), reachable = state.reachable + account.id, session = current)
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                mutable.update { state ->
                    val selected = state.selected?.accountId == account.id
                    state.copy(reachable = state.reachable - account.id,
                        session = if (selected) state.session?.copy(online = false, state = "offline") else state.session,
                        connection = if (selected) "中转离线 · 保留草稿" else state.connection,
                        error = "无法连接 ${account.relayUrl}：${error.message}")
                }
            }
        }
    }

    fun pair(url: String, code: String, name: String, complete: () -> Unit) {
        viewModelScope.launch {
            mutable.update { it.copy(busy = true) }
            attempt {
                val normalized = RelayAddress.validate(url, BuildConfig.ALLOW_EMULATOR_HTTP)
                val existing = mutable.value.accounts.find { it.relayUrl == normalized }
                val account = RelayApi.pair(normalized, code.trim(), name, existing)
                val accounts = mutable.value.accounts.filterNot { it.id == account.id } + account
                withContext(Dispatchers.IO) { vault.saveAccounts(accounts) }
                background.configurationChanged()
                mutable.update { it.copy(accounts = accounts) }
                refresh()
                syncPush()
                complete()
            }
            mutable.update { it.copy(busy = false) }
        }
    }

    fun open(scope: Scope, session: SessionInfo) {
        streamJob?.cancel()
        prefs.edit().putString("last_scope", WireJson.encodeToString(scope)).apply()
        mutable.update { it.copy(selected = scope, session = session, events = emptyList(), requests = emptyList(),
            draft = Draft(), outbox = emptyList(), files = emptyList(), filePath = "", preview = null, git = null, diff = null,
            models = emptyList(), attachments = emptyList(), connection = "正在读取缓存") }
        viewModelScope.launch {
            attempt { loadLocal(scope) }
            if (active && mutable.value.selected == scope) startStream(scope)
        }
    }

    fun closeSession() {
        streamJob?.cancel()
        prefs.edit().remove("last_scope").apply()
        mutable.update { it.copy(selected = null, session = null, events = emptyList(), requests = emptyList()) }
    }

    private suspend fun loadLocal(scope: Scope) {
        val data = withContext(Dispatchers.IO) { Triple(local.events(scope), local.draft(scope), local.outbox(scope)) }
        val requestEvent = data.first.lastOrNull { it.kind == "requests" }
        val requests = requestEvent?.data?.get("items")?.let { WireJson.decodeFromJsonElement<List<PendingRequest>>(it) }
        mutable.update { state ->
            if (state.selected != scope) state else state.copy(events = data.first,
                draft = if (data.second.revision >= state.draft.revision) data.second else state.draft,
                outbox = data.third, requests = requests ?: state.requests)
        }
    }

    private suspend fun applyPage(scope: Scope, page: EventPage) {
        withContext(Dispatchers.IO) { local.applyPage(scope, page) }
        loadLocal(scope)
        val liveState = mutable.value.takeIf { it.selected == scope }?.events?.lastOrNull { it.kind == "runtime.state" }?.data?.text("state")
        if (!liveState.isNullOrEmpty()) mutable.update { state ->
            if (state.selected == scope) state.copy(session = state.session?.copy(state = liveState, online = liveState != "offline")) else state
        }
        if (page.reset) mutable.update { it.copy(error = "历史保留窗口已变化，已重新同步。旧记录仍可在原始终端查看。") }
    }

    private suspend fun catchUp(scope: Scope) {
        var pages = 0
        while (true) {
            val cursor = withContext(Dispatchers.IO) { local.cursor(scope) }
            val page = apiFor(scope).events(scope, cursor)
            applyPage(scope, page)
            if (!page.hasMore) break
            check(++pages < 100) { "历史记录过大，请在终端查看较早内容。" }
        }
    }

    private fun startStream(scope: Scope) {
        streamJob?.cancel()
        streamJob = viewModelScope.launch {
            var failures = 0
            while (isActive && active && mutable.value.selected == scope) {
                try {
                    mutable.update { it.copy(connection = "正在同步历史") }
                    catchUp(scope)
                    recoverCommands(scope)
                    synchronizeRequests(scope)
                    val cursor = withContext(Dispatchers.IO) { local.cursor(scope) }
                    apiFor(scope).stream(scope, cursor) {
                        mutable.update { if (it.selected == scope) it.copy(connection = "实时连接") else it }
                    }.collect { page ->
                        if (page.hasMore) catchUp(scope) else applyPage(scope, page)
                        failures = 0
                    }
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    val revoked = error is ApiFailure && error.status in listOf(401, 403)
                    mutable.update { state -> if (state.selected != scope) state else state.copy(
                        connection = if (revoked) "配对已失效" else "已断线 · 正在重连",
                        session = state.session?.copy(online = false, state = "offline"),
                        error = if (revoked) error.message else state.error,
                    ) }
                    if (revoked) break
                    delay(minOf(30_000L, 1000L shl minOf(failures++, 5)))
                    refresh()
                }
            }
        }
    }

    private suspend fun synchronizeRequests(scope: Scope) {
        if (mutable.value.selected != scope || mutable.value.session?.online != true) return
        val receipt = command(scope, Action.Refresh)
        val requests = receipt.result?.get("requests")?.let { WireJson.decodeFromJsonElement<List<PendingRequest>>(it) } ?: return
        mutable.update { if (it.selected == scope) it.copy(requests = requests) else it }
    }

    fun editDraft(text: String) {
        val scope = mutable.value.selected ?: return
        val current = mutable.value.draft
        val draft = current.copy(text = text.take(32_000), revision = current.revision + 1)
        mutable.update { it.copy(draft = draft) }
        viewModelScope.launch { attempt { withContext(Dispatchers.IO) { local.saveDraft(scope, draft) } } }
    }

    fun removeAttachment(id: String) {
        val scope = mutable.value.selected ?: return
        val current = mutable.value.draft
        val draft = current.copy(attachments = current.attachments.filterNot { it.id == id }, revision = current.revision + 1)
        mutable.update { it.copy(draft = draft) }
        viewModelScope.launch { attempt { withContext(Dispatchers.IO) { local.saveDraft(scope, draft) } } }
    }

    fun send() {
        val state = mutable.value
        val scope = state.selected ?: return
        if (state.draft.text.isBlank() || state.session?.online != true || !state.session.capabilities.messages) return
        val draft = state.draft
        val stageKey = scope.key to draft.revision
        if (!staging.add(stageKey)) return
        val command = Command(UUID.randomUUID().toString(), Action.Message(draft.text, draft.attachments.map { it.id }))
        mutable.update { current ->
            if (current.selected == scope) current.copy(draft = DraftLogic.afterStaging(current.draft, draft)) else current
        }
        viewModelScope.launch {
            try {
                val staged = withContext(Dispatchers.IO) { local.stage(scope, draft, command) }
                loadLocal(scope)
                transmit(staged)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                mutable.update { current ->
                    if (current.selected != scope) current.copy(error = error.message)
                    else current.copy(
                        draft = if (current.draft.revision == draft.revision + 1 && current.draft.text.isEmpty())
                            draft.copy(revision = current.draft.revision + 1) else current.draft,
                        outbox = listOf(Outbox(scope, command, "failed", System.currentTimeMillis(),
                            error = "本机存储失败，消息未发送。", attachments = draft.attachments)) +
                            current.outbox.filterNot { it.command.commandId == command.commandId },
                        error = "本机存储失败，消息未发送：${error.message}",
                    )
                }
            } finally { staging.remove(stageKey) }
        }
    }

    private suspend fun transmit(entry: Outbox) {
        try {
            val receipt = apiFor(entry.scope).submit(entry.scope, entry.command)
            withContext(Dispatchers.IO) { local.applyReceipt(entry.scope, receipt) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            val rejected = error is ApiFailure && error.status in listOf(400, 401, 403, 404, 409, 413, 415, 429, 503)
            withContext(Dispatchers.IO) {
                local.transportFailure(entry, if (rejected) "failed" else "delivery_unknown", error.message)
            }
            mutable.update { it.copy(error = if (rejected) error.message else "发送结果暂不确定，将查询同一请求编号；不会自动生成新任务。") }
        }
        loadLocal(entry.scope)
    }

    private suspend fun recoverCommands(scope: Scope) {
        val pending = withContext(Dispatchers.IO) { local.outbox(scope) }
            .filter {
                (it.command.action is Action.Message || it.command.action is Action.Answer) &&
                    (it.status !in setOf("completed", "cancelled", "failed", "uncertain") ||
                        (it.command.action is Action.Answer && it.status == "completed" && !it.hasConfirmedAnswer()))
            }
        for (entry in pending) {
            try {
                val receipt = apiFor(scope).receipt(scope, entry.command.commandId)
                withContext(Dispatchers.IO) { local.applyReceipt(scope, receipt) }
            } catch (error: ApiFailure) {
                if (error.status == 404) {
                    withContext(Dispatchers.IO) {
                        local.transportFailure(entry, "not_received", "中转没有该请求。点击“重试原请求”后才会发送。")
                    }
                } else throw error
            }
        }
        loadLocal(scope)
    }

    fun retry(entry: Outbox) {
        if (entry.status !in setOf("delivery_unknown", "not_received", "sending")) return
        if (entry.command.action is Action.Answer) {
            val state = mutable.value
            val session = state.session ?: return
            if (state.selected != entry.scope || !session.online || state.busy || !session.capabilities.questions) return
            val current = state.outbox.find { it.command == entry.command && it.scope == entry.scope } ?: return
            if (current.status !in setOf("delivery_unknown", "not_received", "sending")) return
            val question = current.question ?: return
            if (state.requests.none { it.sameQuestion(question.request) && it.supportedBy(session.capabilities) }) return
            val history = questionHistory(state.events, state.outbox, entry.scope).find { it.record.questionId == question.questionId }
            if (history?.record?.status == "confirmed") return
            launchAnswer(entry.scope, current.command, question, current) {}
            return
        }
        viewModelScope.launch { attempt { transmit(entry) } }
    }

    private fun answer(action: Action.Answer, done: (Receipt) -> Unit) {
        val state = mutable.value
        val scope = state.selected ?: return
        val session = state.session ?: return
        if (!session.online || state.busy) return
        val request = state.requests.find { it.requestId == action.requestId && it.type == "question" } ?: return
        if (!request.supportedBy(session.capabilities)) return
        val history = questionHistory(state.events, state.outbox, scope).lastOrNull {
            it.record.request.sameQuestion(request) && it.record.status == "pending"
        }
        if (history == null) {
            mutable.update { it.copy(error = "问题详情尚未同步，请等待同步后再回答。") }
            return
        }
        if (history.blocksNewAnswer) return
        val context = AnswerContext(history.record.questionId, request, history.at, history.cursor)
        launchAnswer(scope, Command(UUID.randomUUID().toString(), action), context, null, done)
    }

    private fun launchAnswer(scope: Scope, command: Command, question: AnswerContext,
        previous: Outbox?, done: (Receipt) -> Unit) {
        val key = scope.key to question.questionId
        if (!answerStaging.add(key)) return
        mutable.update { it.copy(busy = true, submittingAnswers = it.submittingAnswers + command.commandId) }
        viewModelScope.launch {
            var staged = previous
            try {
                val entry = previous ?: withContext(Dispatchers.IO) { local.stageAnswer(scope, command, question) }
                staged = entry
                loadLocal(scope)
                transmitAnswer(entry, done)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                mutable.update { it.copy(error = if (staged == null) "本机保存失败，回答未发送：${error.message}"
                    else "无法恢复回答状态，请在原始客户端核实：${error.message}") }
            } finally {
                answerStaging.remove(key)
                mutable.update { it.copy(busy = false, submittingAnswers = it.submittingAnswers - command.commandId) }
            }
        }
    }

    private suspend fun transmitAnswer(entry: Outbox, done: (Receipt) -> Unit) {
        var submitted = false
        try {
            var receipt = apiFor(entry.scope).submit(entry.scope, entry.command)
            submitted = true
            var polls = 0
            while (true) {
                withContext(Dispatchers.IO) { local.applyReceipt(entry.scope, receipt) }
                loadLocal(entry.scope)
                if (receipt.status in setOf("completed", "failed", "uncertain", "cancelled")) break
                if (polls++ >= 90) {
                    withContext(Dispatchers.IO) { local.transportFailure(entry, "delivery_unknown", "回答结果尚未确认，请在原始客户端核实。") }
                    break
                }
                delay(500)
                receipt = apiFor(entry.scope).receipt(entry.scope, entry.command.commandId)
            }
            if (receipt.status in setOf("failed", "uncertain"))
                mutable.update { it.copy(error = receipt.error?.message ?: "回答结果未确认，请在原始客户端核实。") }
            if (receipt.status == "completed" && mutable.value.selected == entry.scope) done(receipt)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            val rejected = !submitted && error is ApiFailure && error.status in listOf(400, 401, 403, 404, 409, 413, 415, 429, 503)
            withContext(Dispatchers.IO) {
                local.transportFailure(entry, if (rejected) "failed" else "delivery_unknown", error.message)
            }
            mutable.update { it.copy(error = if (rejected) error.message else "回答结果不确定；保留同一请求编号，不会自动提交新的答案。") }
        }
        loadLocal(entry.scope)
        if (mutable.value.selected == entry.scope) attempt { catchUp(entry.scope) }
        refresh()
    }

    fun restoreDraft(entry: Outbox) {
        val action = entry.command.action as? Action.Message ?: return
        if (mutable.value.draft.text.isNotBlank()) { mutable.update { it.copy(error = "当前已有草稿，请先保存或发送。") }; return }
        val scope = mutable.value.selected ?: return
        if (scope != entry.scope) return
        val draft = Draft(action.text, mutable.value.draft.revision + 1, entry.attachments)
        mutable.update { it.copy(draft = draft) }
        viewModelScope.launch { attempt { withContext(Dispatchers.IO) { local.saveDraft(scope, draft) } } }
    }

    private suspend fun command(scope: Scope, action: Action): Receipt {
        check(mutable.value.selected == scope && mutable.value.session?.online == true) { "原始 CLI 会话离线，操作未发送。" }
        val command = Command(UUID.randomUUID().toString(), action)
        var receipt = apiFor(scope).submit(scope, command)
        var attempts = 0
        while (receipt.status !in setOf("completed", "failed", "uncertain", "cancelled", "cancel_requested") && attempts++ < 90) {
            delay(500)
            receipt = apiFor(scope).receipt(scope, command.commandId)
        }
        if (receipt.status in setOf("failed", "uncertain")) throw ApiFailure(409, receipt.error ?: WireError("FAILED", "操作未完成。"))
        if (receipt.status !in setOf("completed", "cancel_requested", "cancelled"))
            throw ApiFailure(504, WireError("RESULT_PENDING", "操作结果尚未确认。请在终端核实，勿重复提交。"))
        return receipt
    }

    fun action(action: Action, done: (Receipt) -> Unit = {}) {
        if (action is Action.Answer) { answer(action, done); return }
        val scope = mutable.value.selected ?: return
        viewModelScope.launch {
            mutable.update { it.copy(busy = true) }
            attempt {
                val receipt = command(scope, action)
                if (mutable.value.selected == scope) {
                    if (action == Action.Abort && receipt.status == "cancel_requested")
                        mutable.update { it.copy(session = it.session?.copy(state = "cancel_requested")) }
                    done(receipt)
                    catchUp(scope)
                }
                refresh()
            }
            mutable.update { it.copy(busy = false) }
        }
    }

    fun metadata(session: SessionInfo, accountId: String, title: String? = null, pinned: Boolean? = null, archived: Boolean? = null) {
        if (archived == true) notificationJob?.cancel()
        viewModelScope.launch { attempt {
            val scope = Scope(accountId, session.hostId, session.sessionId)
            apiFor(scope).metadata(scope, buildJsonObject {
                title?.let { put("title", it) }; pinned?.let { put("pinned", it) }; archived?.let { put("archived", it) }
            })
            if (archived == true) background.sessionArchived(scope)
            else if (archived == false) background.configurationChanged()
            refresh()
        } }
    }

    fun listFiles(path: String) {
        action(Action.ListFiles(path)) { result ->
            val entries = result.result?.get("entries")?.let { WireJson.decodeFromJsonElement<List<FileEntry>>(it) }.orEmpty()
            mutable.update { it.copy(files = entries, filePath = path, fileTruncated = result.result?.text("truncated") == "true", preview = null) }
        }
    }
    fun readFile(path: String) {
        action(Action.ReadFile(path)) { result ->
            result.result?.get("file")?.let { file -> mutable.update { it.copy(preview = WireJson.decodeFromJsonElement(file)) } }
        }
    }
    fun loadGit() {
        action(Action.GitStatus) { result ->
            result.result?.get("git")?.let { git -> mutable.update { it.copy(git = WireJson.decodeFromJsonElement(git), diff = null) } }
        }
    }
    fun loadDiff(path: String, staged: Boolean) {
        action(Action.GitDiff(path, staged)) { result ->
            val diff = result.result?.get("diff") as? JsonObject
            mutable.update { it.copy(diff = diff?.text("text").orEmpty().ifEmpty { "没有差异（未跟踪文件可从文件页面查看）。" }) }
        }
    }
    fun loadModels() {
        action(Action.Models) { result ->
            result.result?.get("models")?.let { models -> mutable.update { it.copy(models = WireJson.decodeFromJsonElement(models)) } }
        }
    }
    fun clearPreview() = mutable.update { it.copy(preview = null, diff = null) }

    fun upload(uri: Uri) {
        val scope = mutable.value.selected ?: return
        if (mutable.value.draft.attachments.size >= 4) { mutable.update { it.copy(error = "每条消息最多附加 4 个文件。") }; return }
        viewModelScope.launch {
            mutable.update { it.copy(uploading = true) }
            attempt {
                val resolver = getApplication<Application>().contentResolver
                val file = withContext(Dispatchers.IO) { readDocument(resolver, uri) }
                val attachment = apiFor(scope).upload(scope, file.first, file.second, file.third)
                if (mutable.value.selected == scope) {
                    val current = mutable.value.draft
                    val draft = current.copy(attachments = current.attachments + attachment, revision = current.revision + 1)
                    mutable.update { it.copy(draft = draft) }
                    withContext(Dispatchers.IO) { local.saveDraft(scope, draft) }
                }
            }
            mutable.update { it.copy(uploading = false) }
        }
    }

    private fun readDocument(resolver: ContentResolver, uri: Uri): Triple<String, String, ByteArray> {
        var name = "attachment.txt"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                name = cursor.getString(0)
                if (!cursor.isNull(1)) require(cursor.getLong(1) <= 2 * 1024 * 1024) { "附件不能超过 2 MiB。" }
            }
        }
        val mime = resolver.getType(uri) ?: "text/plain"
        require(mime in setOf("text/plain", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp")) { "支持文本、JSON、PDF、PNG、JPEG 和 WebP。" }
        val bytes = resolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count == -1) break
                require(out.size() + count <= 2 * 1024 * 1024) { "附件不能超过 2 MiB。" }
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        } ?: error("无法读取所选附件。")
        return Triple(name, mime, bytes)
    }

    fun loadAttachments() {
        val scope = mutable.value.selected ?: return
        viewModelScope.launch { attempt {
            val files = api.attachments(scope)
            if (mutable.value.selected == scope) mutable.update { it.copy(attachments = files) }
        } }
    }
    fun previewAttachment(attachment: Attachment) {
        val scope = mutable.value.selected ?: return
        viewModelScope.launch { attempt {
            val file = apiFor(scope).download(scope, attachment)
            val binary = file.mime.startsWith("image/") || file.mime == "application/pdf"
            val content = if (binary) android.util.Base64.encodeToString(file.bytes, android.util.Base64.NO_WRAP) else file.bytes.toString(Charsets.UTF_8)
            if (mutable.value.selected == scope) mutable.update {
                it.copy(preview = FilePreview(name = file.name, mime = file.mime, size = file.bytes.size.toLong(),
                    encoding = if (binary) "base64" else "utf8", content = content))
            }
        } }
    }
    fun savePreview(uri: Uri) {
        val preview = mutable.value.preview ?: return
        viewModelScope.launch { attempt {
            withContext(Dispatchers.IO) {
                val bytes = if (preview.encoding == "base64") android.util.Base64.decode(preview.content, android.util.Base64.DEFAULT) else preview.content.toByteArray()
                getApplication<Application>().contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: error("无法写入目标文档。")
            }
        } }
    }

    fun revoke(accountId: String, hostId: String) {
        notificationJob?.cancel()
        viewModelScope.launch { attempt {
            val account = mutable.value.accounts.first { it.id == accountId }
            RelayApi(account).revoke(hostId)
            background.accessRemoved(accountId, hostId)
            if (mutable.value.selected?.let { it.accountId == accountId && it.hostId == hostId } == true) closeSession()
            refresh()
        } }
    }
    fun forget(accountId: String) {
        notificationJob?.cancel()
        viewModelScope.launch { attempt {
            val accounts = mutable.value.accounts.filterNot { it.id == accountId }
            withContext(Dispatchers.IO) { vault.saveAccounts(accounts); local.forgetAccount(accountId) }
            background.accessRemoved(accountId)
            BackgroundCheckpoints(getApplication()).retainAccounts(accounts.map { it.id }.toSet())
            if (mutable.value.selected?.accountId == accountId) closeSession()
            mutable.update { it.copy(accounts = accounts, catalogs = it.catalogs - accountId, reachable = it.reachable - accountId) }
        } }
    }
    fun syncPush() {
        viewModelScope.launch { attempt {
            PushSetup.register(getApplication(), mutable.value.accounts)
            mutable.update { it.copy(pushStatus = PushSetup.status(getApplication())) }
        } }
    }
    fun notifyPermissionChanged() {
        Notifications.createChannels(getApplication())
        background.checkPermissions()
        syncPush()
    }
    override fun onCleared() {
        streamJob?.cancel(); refreshJob?.cancel()
        super.onCleared()
    }
}
