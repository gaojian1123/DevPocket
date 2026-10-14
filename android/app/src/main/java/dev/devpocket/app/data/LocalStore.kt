package dev.devpocket.app.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.serialization.json.decodeFromJsonElement

class LocalStore(context: Context) : SQLiteOpenHelper(context, "devpocket-cache.db", null, 1) {
    init { setWriteAheadLoggingEnabled(true) }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE events (scope TEXT NOT NULL,cursor INTEGER NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,cursor),UNIQUE(scope,id))")
        db.execSQL("CREATE TABLE cursors (scope TEXT PRIMARY KEY,value INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE drafts (scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL)")
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY,scope TEXT NOT NULL,created_at INTEGER NOT NULL,body TEXT NOT NULL)")
        db.execSQL("CREATE TABLE catalogs (account_id TEXT PRIMARY KEY,body TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) =
        error("A DevPocket cache migration is required from $oldVersion to $newVersion.")

    @Synchronized fun catalog(accountId: String): Catalog? =
        readableDatabase.rawQuery("SELECT body FROM catalogs WHERE account_id=?", arrayOf(accountId)).use {
            if (it.moveToFirst()) WireJson.decodeFromString<Catalog>(it.getString(0)) else null
        }

    @Synchronized fun saveCatalog(accountId: String, catalog: Catalog) {
        writableDatabase.execSQL("INSERT INTO catalogs VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET body=excluded.body",
            arrayOf(accountId, WireJson.encodeToString(catalog)))
    }

    @Synchronized fun draft(scope: Scope): Draft =
        readableDatabase.rawQuery("SELECT body FROM drafts WHERE scope=?", arrayOf(scope.key)).use {
            if (it.moveToFirst()) WireJson.decodeFromString<Draft>(it.getString(0)) else Draft()
        }

    @Synchronized fun saveDraft(scope: Scope, draft: Draft) {
        writableDatabase.execSQL(
            "INSERT INTO drafts VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,body=excluded.body WHERE excluded.revision>=drafts.revision",
            arrayOf<Any>(scope.key, draft.revision, WireJson.encodeToString(draft)),
        )
    }

    @Synchronized fun stage(scope: Scope, draft: Draft, command: Command): Outbox {
        val entry = Outbox(scope, command, "sending", System.currentTimeMillis(), attachments = draft.attachments)
        val db = writableDatabase
        db.beginTransaction()
        try {
            saveOutbox(entry)
            if (this.draft(scope).revision <= draft.revision) saveDraft(scope, Draft(revision = draft.revision + 1))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        return entry
    }

    @Synchronized fun stageAnswer(scope: Scope, command: Command, question: AnswerContext): Outbox {
        require(command.action is Action.Answer && command.action.requestId == question.request.requestId)
        require(question.request.type == "question")
        val previous = readableDatabase.rawQuery("SELECT body FROM outbox WHERE id=?", arrayOf(command.commandId)).use {
            if (it.moveToFirst()) WireJson.decodeFromString<Outbox>(it.getString(0)) else null
        }
        if (previous != null) {
            require(previous.scope == scope && previous.command == command && previous.question == question) { "回答请求编号和内容不能更改。" }
            return previous
        }
        return Outbox(scope, command, "sending", System.currentTimeMillis(), question = question).also(::saveOutbox)
    }

    @Synchronized fun saveOutbox(entry: Outbox) {
        writableDatabase.execSQL("INSERT INTO outbox VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            arrayOf<Any>(entry.command.commandId, entry.scope.key, entry.createdAt, WireJson.encodeToString(entry)))
    }

    @Synchronized fun outbox(scope: Scope): List<Outbox> =
        readableDatabase.rawQuery("SELECT body FROM outbox WHERE scope=? ORDER BY created_at DESC LIMIT 100", arrayOf(scope.key)).use {
            buildList {
                while (it.moveToNext()) {
                    add(WireJson.decodeFromString<Outbox>(it.getString(0)))
                }
            }
        }

    @Synchronized fun applyReceipt(scope: Scope, receipt: Receipt) {
        val previous = readableDatabase.rawQuery("SELECT body FROM outbox WHERE id=? AND scope=?", arrayOf(receipt.commandId, scope.key)).use {
            if (it.moveToFirst()) WireJson.decodeFromString<Outbox>(it.getString(0)) else null
        } ?: return
        val status = acceptDelivery(previous.status, receipt.status)
        if (status == receipt.status) saveOutbox(previous.copy(status = status,
            receipt = retainReceiptEvidence(previous.receipt, receipt), error = receipt.error?.message))
    }

    @Synchronized fun transportFailure(entry: Outbox, status: String, message: String?) {
        val current = readableDatabase.rawQuery("SELECT body FROM outbox WHERE id=? AND scope=?",
            arrayOf(entry.command.commandId, entry.scope.key)).use {
            if (it.moveToFirst()) WireJson.decodeFromString<Outbox>(it.getString(0)) else null
        } ?: return
        if ((current.receipt != null && current.command.action !is Action.Answer) ||
            current.status in setOf("completed", "cancelled", "uncertain", "failed")) return
        saveOutbox(current.copy(status = status, error = message))
    }

    @Synchronized fun cursor(scope: Scope): Long =
        readableDatabase.rawQuery("SELECT value FROM cursors WHERE scope=?", arrayOf(scope.key)).use {
            if (it.moveToFirst()) it.getLong(0) else 0L
        }

    @Synchronized fun firstRetainedEventCursor(scope: Scope): Long =
        readableDatabase.rawQuery("SELECT MIN(cursor) FROM events WHERE scope=?", arrayOf(scope.key)).use {
            if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else Long.MAX_VALUE
        }

    @Synchronized fun events(scope: Scope): List<WireEvent> =
        readableDatabase.rawQuery("SELECT body FROM events WHERE scope=? ORDER BY cursor DESC LIMIT 6000", arrayOf(scope.key)).use {
            buildList {
                var characters = 0
                while (it.moveToNext()) {
                    val body = it.getString(0)
                    if (characters + body.length > 4 * 1024 * 1024 && isNotEmpty()) break
                    characters += body.length
                    add(WireJson.decodeFromString<WireEvent>(body))
                }
            }.reversed()
        }

    @Synchronized fun applyPage(scope: Scope, page: EventPage) {
        require(page.events.all { it.hostId == scope.hostId && it.sessionId == scope.sessionId }) { "Relay returned another session's events." }
        val db = writableDatabase
        db.beginTransaction()
        try {
            if (page.reset) db.delete("events", "scope=?", arrayOf(scope.key))
            for (event in page.events) {
                val values = ContentValues().apply {
                    put("scope", scope.key); put("cursor", event.cursor); put("id", event.id); put("body", WireJson.encodeToString(event))
                }
                db.insertWithOnConflict("events", null, values, SQLiteDatabase.CONFLICT_REPLACE)
                if (event.kind == "delivery") applyReceipt(scope, WireJson.decodeFromJsonElement<Receipt>(event.data))
            }
            val cursor = if (page.reset) page.cursor else maxOf(cursor(scope), page.cursor)
            db.execSQL("INSERT INTO cursors VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value", arrayOf<Any>(scope.key, cursor))
            db.execSQL("DELETE FROM events WHERE scope=? AND cursor NOT IN (SELECT cursor FROM events WHERE scope=? ORDER BY cursor DESC LIMIT 6000)",
                arrayOf(scope.key, scope.key))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    @Synchronized fun forgetAccount(accountId: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("catalogs", "account_id=?", arrayOf(accountId))
            for (table in listOf("events", "cursors", "drafts", "outbox")) db.delete(table, "scope LIKE ?", arrayOf("$accountId|%"))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
}
