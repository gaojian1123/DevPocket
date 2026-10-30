import Foundation

enum FixtureSamples {
    static func sessions(components: [ComponentRecord]) throws -> [DemoSession] {
        guard components.count == 4, Set(components.map(\.id)).count == 4,
              let overview = components.first(where: { $0.id == "fixture-overview" }),
              let trend = components.first(where: { $0.id == "fixture-trend" }),
              let modules = components.first(where: { $0.id == "fixture-modules" }),
              let bars = components.first(where: { $0.id == "fixture-bars" }) else {
            throw DemoError.invalid("四种本地组件示例不完整。")
        }
        let base = Date(timeIntervalSince1970: 1_791_676_800)
        func entry(_ id: String, _ kind: TimelineEntry.Kind, _ text: String, _ order: Double,
                   origin: String? = nil, card: ComponentRecord? = nil, decision: String? = nil) -> TimelineEntry {
            TimelineEntry(id: id, kind: kind, text: text, at: base.addingTimeInterval(order),
                          origin: origin, component: card, decisionID: decision)
        }
        func session(_ id: String, _ title: String, _ runtime: DemoRuntime, _ entries: [TimelineEntry],
                     decisions: [DemoDecision] = [], project: String = "DevPocket · 示例项目",
                     host: String = "Studio Mac · 虚构主机") -> DemoSession {
            DemoSession(id: id, title: title, project: project, host: host,
                        branch: "demo/\(id)", runtime: runtime, entries: entries, decisions: decisions)
        }
        let origin = "fixture-request-visual"
        var visual = session("visual", "回顾最近两周的进展", .idle, [
            entry(origin, .user, "用图表看看最近两周的进展，并列出后一周的模块分布。", 0),
            entry("visual-intro", .assistant, "我会把趋势、模块分布和解读放在这一次示例回复里。先整理展示数据，再给出结论。", 1, origin: origin),
            entry("visual-tool", .tool, "示例工具 · 已读取本地 fixture，没有访问仓库或服务。", 2, origin: origin),
            entry("visual-overview", .component, "", 3, origin: origin, card: overview),
            entry("visual-trend", .component, "", 4, origin: origin, card: trend),
            entry("visual-modules", .component, "", 5, origin: origin, card: modules),
            entry("visual-final", .assistant, "趋势、模块分布和解读都在上方。示例后一周完成 48 项，前一周 39 项。数量不能说明任务难度或工作质量。展开任一卡片可以继续查看；引用不会自动发送。", 6, origin: origin),
            entry("fixture-request-bars", .user, "追加柱状图，保留之前的折线图。", 7),
            entry("visual-bars", .component, "", 8, origin: "fixture-request-bars",
                  card: bars.appended(id: bars.id, origin: "fixture-request-bars")),
            entry("visual-bars-final", .assistant, "这是后续追加的独立卡片，不替换早先的内容。", 9, origin: "fixture-request-bars")
        ])
        visual.collapsedCards = ["fixture-overview"]
        let permission = DemoDecision(id: "fixture-permission", kind: .permission, title: "允许这一次模拟检查？",
            details: "示例工具：npm test\n示例目录：/fictional/DevPocket\n这是已知的单次权限表单；不会运行这个命令。", choices: [])
        let question = DemoDecision(id: "fixture-question", kind: .question, title: "下一步先关注什么？",
            details: "你的答案只写入本地示例。提交前可以修改；未知回执不会被当成确认。", choices: ["离线体验", "原生可访问性"])
        let unsupported = DemoDecision(id: "fixture-unsupported", kind: .unsupported, title: "不完整的权限表单",
            details: "此示例缺少安全决策所需信息。真实集成必须在原始客户端处理；手机端不猜测、不自动接受。", choices: [])
        let decision = session("decisions", "确认下一步改动", .waiting, [
            entry("decision-request", .user, "展示权限、问题和无法处理的表单。", 0),
            entry("decision-tool", .tool, "示例工具正在等待决定。", 1, origin: "decision-request"),
            entry("decision-permission", .decision, "", 2, origin: "decision-request", decision: permission.id),
            entry("decision-question", .decision, "", 3, origin: "decision-request", decision: question.id),
            entry("decision-unsupported", .decision, "", 4, origin: "decision-request", decision: unsupported.id)
        ], decisions: [permission, question, unsupported], host: "Build Mac · 虚构主机")
        let working = session("working", "生成中与停止请求", .running, [
            entry("working-request", .user, "开始一个本地生成中场景。", 0),
            entry("working-tool", .tool, "模拟生成中 · 尚无完成事件，不能把输入当成已生成组件。", 1, origin: "working-request"),
            entry("working-notice", .notice, "空草稿显示 Stop；非空草稿仍然显示 Send。停止需要确认和模拟空闲回执。", 2)
        ], project: "Workbench Kit · 示例项目")
        let unavailable = ComponentRecord(componentId: "fixture-unavailable", toolCallId: "fixture-unavailable-tool",
            version: 1, status: "unavailable", encoding: nil, payload: nil, sha256: nil, redacted: nil,
            originatingMessageId: "unavailable-request", error: .init(code: "COMPONENT_OUTCOME_UNKNOWN",
            message: "示例：生成结果未被确认。不能显示输入、添加引用或声称组件已完成。"))
        let uncertain = session("uncertain", "错误与未确认的结果", .idle, [
            entry("unavailable-request", .user, "展示未确认的组件。", 0),
            entry("unavailable-card", .component, "", 1, origin: "unavailable-request", card: unavailable),
            entry("unavailable-error", .notice, "示例错误：离线期间没有收到明确结果。历史仍可阅读；没有重新发送。", 2),
            entry("legacy-assistant", .assistant, "这是一条归属不明的旧示例消息，不与相邻请求强行归组。", 3)
        ], host: "Build Mac · 虚构主机")
        var offline = session("offline", "离线阅读与草稿", .idle, [
            entry("offline-request", .user, "离线时保留我的文字与阅读位置。", 0),
            entry("offline-answer", .assistant, "在设置中启用离线示例后，仍可阅读收到的内容和编辑草稿。重新在线不会自动发送。", 1, origin: "offline-request")
        ], project: "Workbench Kit · 示例项目", host: "Build Mac · 虚构主机")
        offline.draft.text = "这是尚未发送的本地草稿。"
        return [visual, decision, working, uncertain, offline]
    }
}
