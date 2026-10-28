import Foundation
import Observation

enum DemoRuntime: String, Codable {
    case idle, running, waiting, cancelRequested
    var label: String {
        switch self {
        case .idle: "模拟空闲"
        case .running: "模拟工作中"
        case .waiting: "模拟待决定"
        case .cancelRequested: "模拟取消待确认"
        }
    }
}

enum DemoOutcome: String, CaseIterable, Codable {
    case confirmed, uncertain, failed
    var label: String {
        switch self {
        case .confirmed: "确认成功"
        case .uncertain: "结果不确定"
        case .failed: "明确失败"
        }
    }
}

enum DemoDelivery: String, Codable {
    case dispatched, queued, completed, failed, uncertain, cancelled, cancelRequested
    var label: String {
        switch self {
        case .dispatched: "模拟请求已记录，等待回执"
        case .queued: "模拟已排队，尚未确认执行"
        case .completed: "模拟回执已确认"
        case .failed: "模拟请求失败"
        case .uncertain: "模拟结果不确定，未重发"
        case .cancelled: "模拟取消已确认"
        case .cancelRequested: "模拟取消已请求，尚未停止"
        }
    }
    var isPending: Bool { [.dispatched, .queued, .cancelRequested].contains(self) }
}

struct DemoDraft: Codable, Equatable {
    var text = ""
    var reference: ComponentSelection?
}

struct DemoOperation: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case message, abort, permission, answer }
    let id: UUID
    let sessionID: String
    let kind: Kind
    let text: String
    let reference: ComponentSelection?
    let decisionID: String?
    var status: DemoDelivery
}

struct DemoDecision: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case permission, question, unsupported }
    let id: String
    let kind: Kind
    let title: String
    let details: String
    let choices: [String]
    var answer = ""
    var operationID: UUID?
    var confirmedAnswer: String?
}

struct TimelineEntry: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case user, assistant, tool, component, decision, notice }
    let id: String
    let kind: Kind
    let text: String
    let at: Date
    let origin: String?
    var component: ComponentRecord?
    var decisionID: String?
    var operationID: UUID?
}

struct DemoSession: Codable, Equatable, Identifiable {
    let id: String
    var title: String
    let project: String
    let host: String
    let branch: String
    var runtime: DemoRuntime
    var entries: [TimelineEntry]
    var decisions: [DemoDecision] = []
    var operations: [DemoOperation] = []
    var draft = DemoDraft()
    var readingID: String?
    var collapsedCards: Set<String> = []
    var section = "chat"
    var pinned = false
    var archived = false

    var hasUnresolvedCancellation: Bool {
        operations.contains { $0.kind == .abort && ($0.status.isPending || $0.status == .uncertain) }
    }

    var pendingDecisions: [DemoDecision] {
        decisions.filter { decision in
            decision.confirmedAnswer == nil && !operations.contains {
                $0.id == decision.operationID && $0.status == .cancelled
            }
        }
    }

    func card(_ id: String) -> ComponentRecord? {
        entries.first { $0.component?.componentId == id }?.component
    }
}

struct FixtureSnapshot: Codable {
    static let maximumBytes = 8 * 1024 * 1024
    var version = 1
    var fixturesOnly = true
    var sessions: [DemoSession]
    var selectedSessionID: String?
    var offline = false
    var appearance = "system"
    var nextOutcome = DemoOutcome.confirmed
    var library: SessionLibrary?
}

struct ReaderSelection: Equatable, Identifiable {
    let sessionID: String
    let cardID: String
    let returnReadingID: String?
    var id: String { "\(sessionID)/\(cardID)" }
}

@MainActor @Observable
final class WorkbenchModel {
    var snapshot = FixtureSnapshot(sessions: [])
    var reader: ReaderSelection?
    var library = SessionLibrary()
    var showingSettings = false
    var searchRequest = 0
    var errorMessage: String?
    var loadBlocked = false
    var rendererGeneration = UUID()
    @ObservationIgnored let persistenceURL: URL?
    @ObservationIgnored let automaticallyConfirm: Bool
    @ObservationIgnored private var componentFixtures: [ComponentRecord] = []
    @ObservationIgnored private var pendingTasks: [UUID: Task<Void, Never>] = [:]

    init(persistenceURL: URL? = nil, automaticallyConfirm: Bool = true) {
        self.persistenceURL = persistenceURL
        self.automaticallyConfirm = automaticallyConfirm
        do {
            guard let file = Bundle.main.url(forResource: "component-fixtures", withExtension: "json", subdirectory: "Renderer") else {
                throw DemoError.invalid("缺少离线资源。请先运行 node apple/prepare-components.mjs，再构建应用。")
            }
            componentFixtures = try JSONDecoder().decode([ComponentRecord].self, from: Data(contentsOf: file))
            for component in componentFixtures { _ = try component.validatedJSON() }
            if let persistenceURL, FileManager.default.fileExists(atPath: persistenceURL.path) {
                let data = try Data(contentsOf: persistenceURL)
                guard data.count <= FixtureSnapshot.maximumBytes else { throw DemoError.invalid("本地示例存储超过上限，请明确重置后继续。") }
                snapshot = try JSONDecoder().decode(FixtureSnapshot.self, from: data)
                guard snapshot.version == 1, snapshot.fixturesOnly, snapshot.sessions.count == 5,
                      Set(snapshot.sessions.map(\.id)) == ["visual", "decisions", "working", "uncertain", "offline"] else {
                    throw DemoError.invalid("本地示例存储版本不兼容。未丢弃或覆盖原数据。")
                }
                for session in snapshot.sessions {
                    for entry in session.entries where entry.component?.status == "ready" {
                        _ = try entry.component?.validatedJSON()
                    }
                }
                for index in snapshot.sessions.indices {
                    for operation in snapshot.sessions[index].operations.indices where snapshot.sessions[index].operations[operation].status.isPending {
                        snapshot.sessions[index].operations[operation].status = .uncertain
                    }
                    if snapshot.sessions[index].hasUnresolvedCancellation {
                        snapshot.sessions[index].runtime = .cancelRequested
                    }
                }
                library = snapshot.library ?? SessionLibrary()
            } else {
                snapshot.sessions = try FixtureSamples.sessions(components: componentFixtures)
            }
        } catch {
            loadBlocked = true
            errorMessage = "无法读取本地示例：\(error.localizedDescription)"
        }
    }

    var sessions: [DemoSession] { snapshot.sessions }
    var selected: DemoSession? { sessions.first { $0.id == snapshot.selectedSessionID } }
    var visibleSessions: [DemoSession] { library.sessions(in: sessions) }
    var libraryProjects: [String] { Array(Set(sessions.map(\.project))).sorted() }
    var libraryHosts: [String] { Array(Set(sessions.map(\.host))).sorted() }
    var visibleAttention: [LibraryAttention] { visibleSessions.flatMap(\.attentionItems) }

    func count(in scope: LibraryScope) -> Int {
        let matching = SessionLibrary(scope: scope).sessions(in: sessions)
        return scope == .attention ? matching.reduce(0) { $0 + $1.attentionItems.count } : matching.count
    }

    func selectScope(_ scope: LibraryScope) {
        closeReader()
        library = SessionLibrary(scope: scope)
        snapshot.selectedSessionID = nil
        persist()
    }

    func refineLibrary(project: String?, host: String?) {
        library.projectFilter = project
        library.hostFilter = host
        if let selected, !visibleSessions.contains(where: { $0.id == selected.id }) {
            closeReader()
            snapshot.selectedSessionID = nil
        }
        persist()
    }

    func setPinned(_ pinned: Bool, sessionID: String) {
        updateSession(sessionID) { $0.pinned = pinned }
    }

    func setArchived(_ archived: Bool, sessionID: String) {
        if snapshot.selectedSessionID == sessionID {
            closeReader()
            snapshot.selectedSessionID = nil
        }
        updateSession(sessionID) { $0.archived = archived }
    }

    func openAttention(_ item: LibraryAttention) {
        guard let session = sessions.first(where: { $0.id == item.sessionID }),
              let entryID = item.entryID, session.entries.contains(where: { $0.id == entryID }) else {
            errorMessage = "找不到这条事项的原始记录，请在会话中查看未确认状态。"
            return
        }
        select(session.id)
        updateSession(session.id) {
            $0.section = "chat"
            $0.readingID = entryID
        }
    }

    func select(_ id: String?) {
        guard id == nil || sessions.contains(where: { $0.id == id }) else {
            errorMessage = "本地会话已不存在，请重新选择。"
            return
        }
        reader = nil
        snapshot.selectedSessionID = id
        persist()
    }

    @discardableResult
    func updateSession(_ id: String, _ edit: (inout DemoSession) -> Void) -> Bool {
        guard let index = snapshot.sessions.firstIndex(where: { $0.id == id }) else {
            errorMessage = "本地会话已不存在，请重新选择。"
            return false
        }
        var updated = snapshot.sessions[index]
        edit(&updated)
        snapshot.sessions[index] = updated
        return persist()
    }

    func setOffline(_ offline: Bool) {
        snapshot.offline = offline
        if offline {
            for index in snapshot.sessions.indices {
                for operation in snapshot.sessions[index].operations.indices where snapshot.sessions[index].operations[operation].status.isPending {
                    snapshot.sessions[index].operations[operation].status = .uncertain
                }
            }
        }
        // Reconnection changes availability only; no operation or draft is replayed.
        persist()
    }

    func openReader(sessionID: String, cardID: String) {
        guard let session = sessions.first(where: { $0.id == sessionID }), session.card(cardID) != nil else {
            errorMessage = "卡片已不在这段本地历史中。"
            return
        }
        let returnReadingID: String?
        if let current = reader, current.sessionID == sessionID {
            returnReadingID = current.returnReadingID
        } else {
            returnReadingID = session.readingID
        }
        reader = ReaderSelection(sessionID: sessionID, cardID: cardID, returnReadingID: returnReadingID)
    }

    func closeReader(returnToSource: Bool = false) {
        guard let selection = reader else { return }
        updateSession(selection.sessionID) { session in
            session.readingID = returnToSource
                ? session.entries.first(where: { $0.component?.id == selection.cardID })?.id
                : selection.returnReadingID
        }
        reader = nil
    }

    func referenceCard(sessionID: String, cardID: String, renderedDigest: String?) {
        guard let session = sessions.first(where: { $0.id == sessionID }),
              snapshot.selectedSessionID == sessionID, let card = session.card(cardID),
              card.status == "ready", let digest = card.sha256, digest == renderedDigest else {
            errorMessage = "只有当前会话中成功显示的同一张卡片才能被引用。"
            return
        }
        do { _ = try card.validatedJSON() }
        catch { errorMessage = error.localizedDescription; return }
        updateSession(sessionID) {
            $0.draft.reference = ComponentSelection(sessionID: sessionID,
                reference: ComponentReference(componentId: cardID, sha256: digest), title: card.title())
        }
        closeReader()
    }

    @discardableResult
    func send(sessionID: String) -> UUID? {
        guard let session = sessions.first(where: { $0.id == sessionID }),
              snapshot.selectedSessionID == sessionID,
              !session.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorMessage = "先输入消息；仅有卡片引用不会发送。"
            return nil
        }
        guard !snapshot.offline, !loadBlocked, session.draft.text.utf16.count <= 32_000,
              session.entries.count <= 996 else {
            errorMessage = snapshot.offline ? "离线草稿已保留，不会自动重发。" : "消息或本地演示历史超过上限。请缩短消息或重置示例。"
            return nil
        }
        if let selection = session.draft.reference {
            guard selection.sessionID == sessionID,
                  let card = session.card(selection.reference.componentId), card.status == "ready",
                  card.sha256 == selection.reference.sha256 else {
                errorMessage = "引用已失效或不属于这个会话。草稿未发送，请移除引用后重试。"
                return nil
            }
        }
        let operation = DemoOperation(id: UUID(), sessionID: sessionID, kind: .message,
                                      text: session.draft.text, reference: session.draft.reference, decisionID: nil,
                                      status: session.runtime == .idle ? .dispatched : .queued)
        let previous = snapshot
        let saved = updateSession(sessionID) {
            $0.operations.append(operation)
            Self.append(to: &$0, kind: .user, text: operation.text, origin: operation.id.uuidString, operationID: operation.id)
            $0.draft = DemoDraft()
            if $0.runtime == .idle { $0.runtime = .running }
        }
        guard saved else {
            snapshot = previous
            return nil
        }
        schedule(operation)
        return operation.id
    }

    @discardableResult
    func requestStop(sessionID: String) -> UUID? {
        guard !snapshot.offline, !loadBlocked, snapshot.selectedSessionID == sessionID,
              let session = sessions.first(where: { $0.id == sessionID }),
              session.runtime != .idle, session.runtime != .cancelRequested,
              !session.hasUnresolvedCancellation else {
            errorMessage = "当前不能请求停止，已有请求和草稿保持不变。"
            return nil
        }
        let operation = DemoOperation(id: UUID(), sessionID: sessionID, kind: .abort,
                                      text: "", reference: nil, decisionID: nil, status: .cancelRequested)
        let previous = snapshot
        let saved = updateSession(sessionID) {
            $0.operations.append(operation)
            $0.runtime = .cancelRequested
            Self.append(to: &$0, kind: .notice, text: "已记录模拟取消请求；还没有模拟空闲回执。",
                        origin: nil, operationID: operation.id)
        }
        guard saved else { snapshot = previous; return nil }
        schedule(operation)
        return operation.id
    }

    @discardableResult
    func decide(sessionID: String, decisionID: String, answer: String) -> UUID? {
        guard !snapshot.offline, !loadBlocked, snapshot.selectedSessionID == sessionID,
              let session = sessions.first(where: { $0.id == sessionID }),
              let decision = session.decisions.first(where: { $0.id == decisionID }),
              decision.kind != .unsupported, decision.operationID == nil, decision.confirmedAnswer == nil,
              !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, answer.utf16.count <= 8000,
              decision.kind != .permission || ["approve-once", "reject"].contains(answer) else {
            errorMessage = "此决定不可提交，或结果尚未确认。不会自动批准或再次执行。"
            return nil
        }
        let operation = DemoOperation(id: UUID(), sessionID: sessionID,
            kind: decision.kind == .permission ? .permission : .answer,
            text: answer, reference: nil, decisionID: decisionID, status: .dispatched)
        let previous = snapshot
        let saved = updateSession(sessionID) {
            $0.operations.append(operation)
            if let index = $0.decisions.firstIndex(where: { $0.id == decisionID }) {
                $0.decisions[index].operationID = operation.id
            }
        }
        guard saved else { snapshot = previous; return nil }
        schedule(operation)
        return operation.id
    }

    func confirm(operationID: UUID, sessionID: String, outcome: DemoOutcome) {
        guard let index = snapshot.sessions.firstIndex(where: { $0.id == sessionID }),
              let operationIndex = snapshot.sessions[index].operations.firstIndex(where: { $0.id == operationID }),
              snapshot.sessions[index].operations[operationIndex].status.isPending else { return }
        let operation = snapshot.sessions[index].operations[operationIndex]
        updateSession(sessionID) { session in
            let result: DemoDelivery = snapshot.offline || outcome == .uncertain ? .uncertain : outcome == .failed ? .failed : .completed
            session.operations[operationIndex].status = result
            if result != .completed {
                if operation.kind == .abort && result == .failed {
                    session.runtime = session.hasUnresolvedCancellation ? .cancelRequested
                        : session.pendingDecisions.isEmpty ? .running : .waiting
                }
                Self.append(to: &session, kind: .notice,
                            text: result == .uncertain ? "没有确定的模拟回执。不会自动重试、重发草稿或再次提交决定。" : "示例失败：请求没有成功。可以手动恢复消息为一个新草稿。",
                            origin: nil, operationID: operation.id)
                return
            }
            switch operation.kind {
            case .message:
                Self.append(to: &session, kind: .tool, text: "本地示例工具 · 完成读取虚构数据；没有执行命令。",
                            origin: operation.id.uuidString)
                if operation.reference != nil, let bars = componentFixtures.first(where: { $0.id == "fixture-bars" }) {
                    Self.append(to: &session, kind: .component, text: "", origin: operation.id.uuidString,
                                component: bars.appended(id: "fixture-\(operation.id.uuidString)", origin: operation.id.uuidString))
                }
                Self.append(to: &session, kind: .assistant,
                            text: "本地示例回复：已确认这条模拟消息。较早的卡片仍然保留。这不是 GitHub Copilot 的实际回答。",
                            origin: operation.id.uuidString)
            case .abort:
                for item in session.operations.indices where session.operations[item].status.isPending {
                    session.operations[item].status = .cancelled
                }
                Self.append(to: &session, kind: .notice,
                            text: "模拟空闲回执已确认。没有停止原始客户端，也没有终止任何系统进程。", origin: nil)
                session.runtime = .idle
            case .permission, .answer:
                if let decision = session.decisions.firstIndex(where: { $0.id == operation.decisionID }) {
                    session.decisions[decision].confirmedAnswer = operation.text
                }
            }
            if operation.kind != .abort {
                // Unrelated receipts cannot resolve a pending or uncertain cancellation.
                if session.runtime == .cancelRequested || session.hasUnresolvedCancellation {
                    session.runtime = .cancelRequested
                } else {
                    session.runtime = session.operations.contains(where: { $0.status.isPending }) ? .running
                        : session.pendingDecisions.isEmpty ? .idle : .waiting
                }
            }
        }
    }

    func restoreDraft(sessionID: String, operationID: UUID) {
        guard let session = sessions.first(where: { $0.id == sessionID }),
              let operation = session.operations.first(where: { $0.id == operationID && $0.kind == .message }),
              [.failed, .uncertain, .cancelled].contains(operation.status),
              session.draft.text.isEmpty, session.draft.reference == nil else {
            errorMessage = "不能覆盖当前草稿；先保留或清空它，再恢复旧消息。"
            return
        }
        updateSession(sessionID) { $0.draft = DemoDraft(text: operation.text, reference: operation.reference) }
    }

    func reset() {
        do {
            let sessions = try FixtureSamples.sessions(components: componentFixtures)
            pendingTasks.values.forEach { $0.cancel() }
            pendingTasks.removeAll()
            snapshot = FixtureSnapshot(sessions: sessions)
            library = SessionLibrary()
            reader = nil
            rendererGeneration = UUID()
            errorMessage = nil
            loadBlocked = false
            persist()
        } catch {
            errorMessage = "重置失败：\(error.localizedDescription)"
        }
    }

    @discardableResult
    func persist() -> Bool {
        guard !loadBlocked else { return false }
        snapshot.library = library
        guard let persistenceURL else { return true }
        do {
            var directory = persistenceURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            try directory.setResourceValues(resourceValues)
            let data = try JSONEncoder().encode(snapshot)
            guard data.count <= FixtureSnapshot.maximumBytes else {
                throw DemoError.invalid("本地示例存储达到上限。原存档未覆盖，请缩短草稿或重置示例。")
            }
            try data.write(to: persistenceURL, options: .atomic)
            return true
        } catch {
            errorMessage = "本地保存失败，未确认提交；请保留草稿：\(error.localizedDescription)"
            return false
        }
    }

    private func schedule(_ operation: DemoOperation) {
        guard automaticallyConfirm else { return }
        let outcome = snapshot.nextOutcome
        pendingTasks[operation.id] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1.5)) }
            catch is CancellationError { return }
            catch { self?.errorMessage = "模拟计时失败：\(error.localizedDescription)"; return }
            self?.confirm(operationID: operation.id, sessionID: operation.sessionID, outcome: outcome)
            self?.pendingTasks.removeValue(forKey: operation.id)
        }
    }

    private static func append(to session: inout DemoSession, kind: TimelineEntry.Kind, text: String,
                               origin: String?, component: ComponentRecord? = nil, operationID: UUID? = nil) {
        let at = max(Date(), (session.entries.last?.at ?? .distantPast).addingTimeInterval(0.001))
        session.entries.append(TimelineEntry(id: UUID().uuidString, kind: kind, text: text, at: at, origin: origin,
                                            component: component, operationID: operationID))
    }
}
