import Foundation

enum LibraryScope: Codable, Hashable {
    case all, pinned, attention, archived
    case project(String), host(String)

    static let collections: [LibraryScope] = [.all, .pinned, .attention, .archived]

    var title: String {
        switch self {
        case .all: "全部会话"
        case .pinned: "已置顶"
        case .attention: "待处理"
        case .archived: "已归档"
        case .project(let name), .host(let name): name
        }
    }

    var symbol: String {
        switch self {
        case .all: "bubble.left.and.bubble.right"
        case .pinned: "pin"
        case .attention: "tray"
        case .archived: "archivebox"
        case .project: "folder"
        case .host: "desktopcomputer"
        }
    }

    var identifier: String {
        switch self {
        case .all: "scope-all"
        case .pinned: "scope-pinned"
        case .attention: "scope-attention"
        case .archived: "scope-archived"
        case .project(let name): "scope-project-\(name)"
        case .host(let name): "scope-host-\(name)"
        }
    }
}

struct SessionLibrary: Codable, Equatable {
    var scope = LibraryScope.all
    var searchText = ""
    var projectFilter: String?
    var hostFilter: String?

    var project: String? {
        if case .project(let name) = scope { name } else { projectFilter }
    }

    var host: String? {
        if case .host(let name) = scope { name } else { hostFilter }
    }

    var hasRefinements: Bool { projectFilter != nil || hostFilter != nil }

    func sessions(in sessions: [DemoSession]) -> [DemoSession] {
        let search = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return sessions.filter { session in
            let included: Bool
            switch scope {
            case .all, .project, .host: included = !session.archived
            case .pinned: included = session.pinned && !session.archived
            case .archived: included = session.archived
            case .attention: included = !session.attentionItems.isEmpty
            }
            return included && (project == nil || project == session.project)
                && (host == nil || host == session.host)
                && (search.isEmpty || "\(session.title) \(session.project) \(session.host) \(session.branch)"
                    .localizedCaseInsensitiveContains(search))
        }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            let left = $0.entries.last?.at ?? .distantPast
            let right = $1.entries.last?.at ?? .distantPast
            return left == right ? $0.id < $1.id : left > right
        }
    }
}

struct LibraryAttention: Identifiable {
    enum Kind: String, CaseIterable {
        case decision, unconfirmed, failure

        var title: String {
            switch self {
            case .decision: "需要决定"
            case .unconfirmed: "待确认"
            case .failure: "错误"
            }
        }

        var symbol: String {
            switch self {
            case .decision: "questionmark.bubble"
            case .unconfirmed: "clock"
            case .failure: "exclamationmark.triangle"
            }
        }
    }

    let id: String
    let sessionID: String
    let entryID: String?
    let kind: Kind
    let title: String
    let detail: String
}

extension DemoSession {
    var attentionItems: [LibraryAttention] {
        var items = pendingDecisions.map { decision in
            let operation = operations.first { $0.id == decision.operationID }
            let kind: LibraryAttention.Kind = operation?.status == .failed ? .failure
                : operation == nil ? .decision : .unconfirmed
            return LibraryAttention(id: "\(id)/decision/\(decision.id)", sessionID: id,
                entryID: entries.first { $0.decisionID == decision.id }?.id, kind: kind,
                title: decision.title,
                detail: decision.kind == .unsupported ? "需要原始客户端" : operation?.status.label ?? "尚未提交决定")
        }
        for operation in operations where [.failed, .uncertain, .cancelRequested].contains(operation.status) {
            if decisions.contains(where: { $0.id == operation.decisionID }) { continue }
            let title: String
            switch operation.kind {
            case .message: title = "消息发送"
            case .abort: title = "停止请求"
            case .permission: title = "权限决定"
            case .answer: title = "问题回答"
            }
            items.append(LibraryAttention(id: "\(id)/operation/\(operation.id)", sessionID: id,
                entryID: entries.last { $0.operationID == operation.id }?.id,
                kind: operation.status == .failed ? .failure : .unconfirmed,
                title: title, detail: operation.status.label))
        }
        for entry in entries where entry.component?.status == "unavailable" {
            items.append(LibraryAttention(id: "\(id)/component/\(entry.id)", sessionID: id,
                entryID: entry.id, kind: .unconfirmed, title: "组件结果不可用",
                detail: entry.component?.error?.message ?? "尚未收到有效结果"))
        }
        return items
    }
}
