package dev.devpocket.app.background

import dev.devpocket.app.data.Account
import dev.devpocket.app.data.ApiFailure
import dev.devpocket.app.data.Catalog
import dev.devpocket.app.data.EventPage
import dev.devpocket.app.data.Scope
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

interface SessionEventSource {
    suspend fun catalog(): Catalog
    suspend fun events(scope: Scope, after: Long): EventPage
    fun stream(scope: Scope, after: Long, onOpen: () -> Unit): Flow<EventPage>
}

data class WatchStatus(val connected: Boolean = false, val error: String? = null, val historyReset: Boolean = false)
data class MonitorStatus(
    val relays: Map<String, String?> = emptyMap(),
    val sessions: Map<Scope, WatchStatus> = emptyMap(),
) {
    val connected: Int get() = sessions.values.count { it.connected }
    val errors: List<String> get() = (relays.values.filterNotNull() + sessions.values.mapNotNull { it.error }).distinct()
    val historyReset: Boolean get() = sessions.values.any { it.historyReset }
}

class BackgroundMonitor(
    private val source: (Account) -> SessionEventSource,
    private val checkpoints: NoticeCheckpointStore,
    private val notify: suspend (Scope, SessionNotice) -> Unit,
    private val dismiss: (Scope) -> Unit,
) {
    private val mutable = MutableStateFlow(MonitorStatus())
    val status = mutable.asStateFlow()

    suspend fun run(accounts: List<Account>): Nothing = coroutineScope {
        require(accounts.isNotEmpty()) { "请先配对 Dev Box。" }
        mutable.value = MonitorStatus(relays = accounts.associate { it.id to null })
        for (account in accounts) launch { watchAccount(account) }
        awaitCancellation()
    }

    private suspend fun watchAccount(account: Account) = coroutineScope {
        val jobs = mutableMapOf<Scope, Job>()
        try {
            val api = source(account)
            while (isActive) {
                try {
                    val catalog = api.catalog()
                    val hosts = catalog.hosts.map { it.id }.toSet()
                    val scopes = catalog.sessions.filter { !it.archived && it.hostId in hosts }
                        .map { Scope(account.id, it.hostId, it.sessionId) }.toSet()
                    for (scope in jobs.keys.toSet() - scopes) {
                        jobs.getValue(scope).cancelAndJoin()
                        mutable.update { it.copy(sessions = it.sessions - scope) }
                        dismiss(scope)
                        checkpoints.remove(scope)
                        jobs.remove(scope)
                    }
                    mutable.update { state -> state.copy(
                        relays = state.relays + (account.id to null),
                        sessions = state.sessions.filterKeys { it.accountId != account.id || it in scopes },
                    ) }
                    for (scope in scopes - jobs.keys) {
                        mutable.update { it.copy(sessions = it.sessions + (scope to WatchStatus())) }
                        jobs[scope] = launch { watchSession(scope, api) }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    mutable.update { it.copy(relays = it.relays + (account.id to describe(error))) }
                    if (error is ApiFailure && error.status in setOf(401, 403)) {
                        for ((scope, job) in jobs) {
                            job.cancelAndJoin()
                            dismiss(scope)
                        }
                        mutable.update { it.copy(sessions = it.sessions.filterKeys { scope -> scope.accountId != account.id }) }
                        for (scope in jobs.keys) checkpoints.remove(scope)
                        return@coroutineScope
                    }
                }
                delay(15_000)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            jobs.values.forEach { it.cancelAndJoin() }
            jobs.keys.forEach(dismiss)
            mutable.update { it.copy(relays = it.relays + (account.id to describe(error)),
                sessions = it.sessions.filterKeys { scope -> scope.accountId != account.id }) }
        }
    }

    private suspend fun watchSession(scope: Scope, api: SessionEventSource) {
        var failures = 0
        var reset = false
        fun report(connected: Boolean = false, error: String? = null) {
            mutable.update { if (scope in it.sessions)
                it.copy(sessions = it.sessions + (scope to WatchStatus(connected, error, reset))) else it }
        }
        try {
            var checkpoint = checkpoints.load(scope)
            suspend fun apply(page: EventPage, durable: Boolean = false) {
                currentCoroutineContext().ensureActive()
                reset = reset || page.reset
                val next = checkpoint.apply(scope, page)
                // Text deltas advance the in-memory cursor without a disk write per token.
                if (durable || next.copy(cursor = checkpoint.cursor) != checkpoint) checkpoints.save(scope, next)
                checkpoint = next
            }
            suspend fun catchUp() {
                var pages = 0
                while (true) {
                    val before = checkpoint.cursor
                    val page = api.events(scope, before)
                    apply(page, durable = true)
                    if (!page.hasMore) break
                    check(page.reset || checkpoint.cursor > before) { "中转历史游标未前进。" }
                    check(++pages < 100) { "历史过大，后台提醒已暂停；请在原始终端查看。" }
                }
                val ready = checkpoint.caughtUp()
                checkpoints.save(scope, ready)
                checkpoint = ready
            }
            suspend fun deliver() {
                val notice = checkpoint.pending ?: return
                currentCoroutineContext().ensureActive()
                notify(scope, notice)
                val delivered = checkpoint.copy(pending = null)
                checkpoints.save(scope, delivered)
                checkpoint = delivered
            }
            while (currentCoroutineContext().isActive) {
                try {
                    report()
                    catchUp()
                    deliver()
                    api.stream(scope, checkpoint.cursor) { report(connected = true) }.collect { page ->
                        if (page.hasMore) catchUp() else {
                            apply(page)
                            val ready = checkpoint.caughtUp()
                            if (ready != checkpoint) checkpoints.save(scope, ready)
                            checkpoint = ready
                        }
                        deliver()
                        failures = 0
                        report(connected = true)
                    }
                    throw IOException("实时连接已结束，将重新同步。")
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    report(error = describe(error))
                    if (error is ApiFailure && error.status in setOf(401, 403, 404)) {
                        dismiss(scope)
                        checkpoints.remove(scope)
                        return
                    }
                    delay(minOf(30_000L, 1000L shl minOf(failures++, 5)))
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            report(error = describe(error))
        }
    }

    private fun describe(error: Exception): String =
        if (error is ApiFailure && error.status in setOf(401, 403)) "配对已失效，请重新配对后手动重启后台模式。"
        else error.message ?: "后台同步失败，请检查网络并重新开启。"
}
