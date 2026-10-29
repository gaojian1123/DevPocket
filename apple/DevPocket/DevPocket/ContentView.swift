import SwiftUI
#if os(iOS)
import UIKit
#endif

enum WorkbenchSurface {
    static var canvas: Color {
        #if os(macOS)
        Color(nsColor: .windowBackgroundColor)
        #else
        Color(uiColor: .systemBackground)
        #endif
    }

    static var card: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(uiColor: .secondarySystemGroupedBackground)
        #endif
    }
}

struct ContentView: View {
    @Bindable var model: WorkbenchModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var renderers = ComponentRendererPool()

    var body: some View {
        Group {
            if model.loadBlocked {
                ContentUnavailableView {
                    Label("本地示例未能打开", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(model.errorMessage ?? "请检查离线资源。")
                } actions: {
                    Button("重置本地示例") { model.reset() }
                }
            } else {
                GeometryReader { proxy in
                    LibraryWorkbench(model: model, renderers: renderers, width: proxy.size.width)
                }
            }
        }
        .id(model.rendererGeneration)
        .preferredColorScheme(model.snapshot.appearance == "light" ? .light : model.snapshot.appearance == "dark" ? .dark : nil)
        .sheet(isPresented: Binding(
            get: { model.reader != nil },
            set: { if !$0 { model.closeReader() } })) {
                if let reader = model.reader {
                    #if os(macOS)
                    ComponentReader(model: model, selection: reader, renderers: renderers)
                        .frame(minWidth: 480, idealWidth: 600, minHeight: 560, idealHeight: 720)
                    #else
                    NavigationStack {
                        ComponentReader(model: model, selection: reader, renderers: renderers)
                    }
                    .presentationDetents([.large])
                    .presentationSizing(.form)
                    #endif
                }
            }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let error = model.errorMessage, !model.loadBlocked {
                HStack(alignment: .top) {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                    Button("关闭提示", systemImage: "xmark") { model.errorMessage = nil }
                        .labelStyle(.iconOnly)
                }
                .padding().background(.background).foregroundStyle(.red)
                .accessibilityIdentifier("application-error")
            }
        }
        .onChange(of: model.rendererGeneration) { renderers.reset() }
        .onChange(of: scenePhase) { if scenePhase != .active { model.persist() } }
    }

}

struct WorkbenchBackdrop: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        ZStack {
            WorkbenchSurface.canvas
            if !reduceTransparency && contrast != .increased {
                LinearGradient(
                    colors: [.accentColor.opacity(0.10), .clear, .accentColor.opacity(0.05)],
                    startPoint: .topLeading, endPoint: .bottomTrailing)
            }
        }
        .ignoresSafeArea()
        .backgroundExtensionEffect(isEnabled: !reduceTransparency && contrast != .increased)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct SessionList: View {
    @Bindable var model: WorkbenchModel
    @State private var renameID: String?
    @State private var renamedTitle = ""

    var body: some View {
        List(selection: Binding(get: { model.snapshot.selectedSessionID }, set: { model.select($0) })) {
            Section {
                ForEach(model.visibleSessions) { session in
                    Group {
                        #if os(macOS)
                        Button { model.select(session.id) } label: { rowContents(session) }
                            .buttonStyle(.plain)
                        #else
                        NavigationLink(value: session.id) { rowContents(session) }
                        #endif
                    }
                    .tag(session.id)
                    .accessibilityIdentifier("session-\(session.id)")
                    .contextMenu {
                        pinAction(session)
                        Button("重命名", systemImage: "pencil") {
                            renamedTitle = session.title
                            renameID = session.id
                        }
                        archiveAction(session)
                    }
                    #if os(iOS)
                    .swipeActions(edge: .leading, allowsFullSwipe: false) { pinAction(session).tint(.orange) }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) { archiveAction(session).tint(.gray) }
                    #endif
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay {
            if model.visibleSessions.isEmpty {
                ContentUnavailableView("没有匹配的会话", systemImage: model.library.scope.symbol,
                    description: Text(model.library.scope == .archived ? "归档的本地会话会出现在这里。" : "可以更换查看范围或清除搜索与筛选。"))
            }
        }
        .accessibilityIdentifier("session-list")
        .alert("重命名本地条目", isPresented: Binding(get: { renameID != nil }, set: { if !$0 { renameID = nil } })) {
            TextField("名称", text: $renamedTitle)
            Button("取消", role: .cancel) { renameID = nil }
            Button("保存") {
                if let id = renameID {
                    model.updateSession(id) { $0.title = String(renamedTitle.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)) }
                }
                renameID = nil
            }.disabled(renamedTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: { Text("仅改变 DevPocket 示例元数据，不操作原始会话。") }
    }

    private func pinAction(_ session: DemoSession) -> some View {
        Button(session.pinned ? "取消置顶" : "置顶", systemImage: session.pinned ? "pin.slash" : "pin") {
            model.setPinned(!session.pinned, sessionID: session.id)
        }
        .accessibilityIdentifier("pin-session-\(session.id)")
    }

    private func archiveAction(_ session: DemoSession) -> some View {
        Button(session.archived ? "恢复到会话库" : "归档", systemImage: session.archived ? "arrow.uturn.backward" : "archivebox") {
            model.setArchived(!session.archived, sessionID: session.id)
        }
        .accessibilityIdentifier("archive-session-\(session.id)")
    }

    private func symbol(_ session: DemoSession) -> String {
        switch session.id {
        case "visual": "chart.xyaxis.line"
        case "decisions": "checkmark.shield"
        case "working": "hourglass"
        case "uncertain": "exclamationmark.bubble"
        default: "bubble.left.and.bubble.right"
        }
    }

    private func rowContents(_ session: DemoSession) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol(session))
                .font(.body)
                .frame(width: 24, height: 28)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(session.title).font(.body.weight(.semibold)).lineLimit(2)
                    if session.pinned { Image(systemName: "pin.fill").font(.caption).accessibilityLabel("已置顶") }
                }
                Text(preview(session)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                Text("\(session.project) · \(session.host)").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 8) {
                    RuntimeStatus(runtime: session.runtime, offline: model.snapshot.offline)
                    Label(session.branch, systemImage: "arrow.triangle.branch")
                        .lineLimit(1)
                }.font(.caption2)
            }
        }
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
    private func preview(_ session: DemoSession) -> String {
        session.entries.last(where: { $0.kind == .assistant && !$0.text.isEmpty })?.text
            ?? session.entries.first(where: { !$0.text.isEmpty })?.text ?? "本地示例"
    }
}

private struct RuntimeStatus: View {
    let runtime: DemoRuntime
    let offline: Bool
    private var color: Color { offline ? .secondary : runtime == .idle ? .green : runtime == .running ? .blue : .orange }
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 5, height: 5).accessibilityHidden(true)
            Text(offline ? "离线示例" : runtime.label)
        }
    }
}

struct ConversationPane: View {
    @Bindable var model: WorkbenchModel
    let sessionID: String
    let renderers: ComponentRendererPool
    private var session: DemoSession? { model.sessions.first { $0.id == sessionID } }
    var body: some View {
        if let session {
            conversation(session)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("conversation-pane")
        }
    }

    private func conversation(_ session: DemoSession) -> some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                #if os(iOS)
                Text("\(session.project) · \(session.host)")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                #endif
                HStack(spacing: 10) {
                    Label(session.branch, systemImage: "arrow.triangle.branch")
                        .lineLimit(1).foregroundStyle(.secondary)
                    RuntimeStatus(runtime: session.runtime, offline: model.snapshot.offline)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("conversation-runtime")
                    Spacer(minLength: 0)
                    Text("本地示例").foregroundStyle(.secondary)
                }.font(.caption)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 10)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("conversation-header")
            if model.snapshot.offline || session.runtime == .cancelRequested {
                Label(model.snapshot.offline ? "离线示例 · 内容可读，草稿不会自动发送" : "取消已请求 · 等待模拟空闲回执",
                      systemImage: model.snapshot.offline ? "wifi.slash" : "clock")
                    .font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10).background(.orange.opacity(0.08))
            }
            ScrollViewReader { reader in
                ScrollView {
                    Group {
                        if session.decisions.isEmpty {
                            LazyVStack(alignment: .leading, spacing: 0) { timelineRows(session) }
                        } else {
                            // Keep input forms mounted while the keyboard changes the viewport.
                            VStack(alignment: .leading, spacing: 0) { timelineRows(session) }
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 18).padding(.bottom, 20)
                    .frame(maxWidth: 820).frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("conversation-timeline")
                .scrollPosition(id: Binding(get: { self.session?.readingID }, set: { id in
                    model.updateSession(sessionID) { $0.readingID = id }
                }), anchor: .top)
                .defaultScrollAnchor(.top)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: sessionID, initial: true) {
                    if let readingID = self.session?.readingID {
                        reader.scrollTo(readingID, anchor: .top)
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ComposerView(model: model, session: session)
                }
            }
        }
        .navigationTitle(session.title)
        #if os(iOS)
        .containerBackground(.clear, for: .navigation)
        .toolbarTitleDisplayMode(.inlineLarge)
        #else
        .navigationSubtitle("\(session.project) · \(session.host)")
        .toolbarBackground(.clear, for: .windowToolbar)
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        #endif
    }

    @ViewBuilder private func timelineRows(_ session: DemoSession) -> some View {
        Text("本地虚构对话").font(.caption2).foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity).padding(.vertical, 18)
        ForEach(Array(session.entries.enumerated()), id: \.element.id) { index, entry in
            TimelineRow(model: model, session: session, entry: entry,
                startsReply: index == 0 || session.entries[index - 1].origin != entry.origin
                    || session.entries[index - 1].kind == .user,
                startsComponents: index == 0 || session.entries[index - 1].kind != .component
                    || session.entries[index - 1].origin != entry.origin,
                renderers: renderers)
                .id(entry.id)
        }
    }
}

struct TimelineRow: View {
    @Bindable var model: WorkbenchModel
    let session: DemoSession
    let entry: TimelineEntry
    let startsReply: Bool
    let startsComponents: Bool
    let renderers: ComponentRendererPool
    @Environment(\.dynamicTypeSize) private var typeSize
    private var operation: DemoOperation? { session.operations.first { $0.id == entry.operationID } }

    var body: some View {
        Group {
            if entry.kind == .user {
                VStack(alignment: .trailing, spacing: 8) {
                    Text(entry.text).textSelection(.enabled)
                        .padding(14).background(.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 18))
                    let metadata = typeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4))
                        : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
                    metadata {
                        Text("你 · 本地示例").font(.subheadline)
                            .accessibilityIdentifier("role-\(entry.id)")
                        Text(entry.at.formatted(date: .omitted, time: .shortened)).font(.subheadline)
                            .accessibilityIdentifier("time-\(entry.id)")
                    }.foregroundStyle(.secondary)
                    receipt
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 30).padding(.bottom, 22)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    if startsReply || entry.origin == nil {
                        HStack(spacing: 8) {
                            Image(systemName: "terminal").font(.caption)
                                .padding(6).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                            Text(entry.origin == nil ? "独立示例记录" : "GitHub Copilot · 模拟")
                                .font(.subheadline.weight(.semibold))
                                .accessibilityIdentifier("role-\(entry.id)")
                            Spacer(minLength: 4)
                            Text(entry.at.formatted(date: .omitted, time: .shortened))
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.top, 4)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        if let card = entry.component {
                            if startsComponents {
                                Label("Canvas 回复 · 本地示例", systemImage: "square.stack.3d.up")
                                    .font(.caption).foregroundStyle(.tint)
                            }
                            ComponentCard(model: model, session: session, card: card, renderers: renderers)
                        } else if let id = entry.decisionID, let decision = session.decisions.first(where: { $0.id == id }) {
                            DecisionView(model: model, session: session, decision: decision)
                                .padding(16).background(WorkbenchSurface.card, in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.quaternary))
                        } else if entry.kind == .tool {
                            DisclosureGroup {
                                Text(entry.text).font(.callout).textSelection(.enabled).padding(.vertical, 8)
                            } label: {
                                Label("公开工具活动 · 模拟", systemImage: "terminal")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(12).background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                        } else if entry.kind == .notice {
                            Label(entry.text, systemImage: "exclamationmark.circle")
                                .font(.callout).foregroundStyle(.orange)
                                .padding(12).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                        } else {
                            Text(entry.text).font(.body).lineSpacing(5).textSelection(.enabled)
                        }
                        receipt
                    }
                    .padding(.leading, entry.origin == nil ? 0 : 14)
                    .padding(.bottom, 14)
                    .overlay(alignment: .leading) {
                        if entry.origin != nil {
                            Rectangle().fill(.quaternary).frame(width: 1).accessibilityHidden(true)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("entry-\(entry.id)")
    }

    @ViewBuilder private var receipt: some View {
        if let operation {
            Text(operation.status.label).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("receipt-\(operation.id)")
            if let reference = operation.reference { Label(reference.title, systemImage: "link").font(.caption) }
            if operation.kind == .message && [.failed, .uncertain, .cancelled].contains(operation.status) {
                Button("恢复为新草稿") { model.restoreDraft(sessionID: session.id, operationID: operation.id) }
            }
        }
    }
}

struct ComponentCard: View {
    @Bindable var model: WorkbenchModel
    let session: DemoSession
    let card: ComponentRecord
    let renderers: ComponentRendererPool

    var body: some View {
        if card.status == "ready" {
            let host = renderers.session(sessionID: session.id, card: card, detail: false)
            let collapsed = session.collapsedCards.contains(card.id)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: host.presentation?.symbol ?? "rectangle.3.group")
                        .foregroundStyle(.tint).padding(8)
                        .background(.tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(card.title()).font(.subheadline.weight(.semibold))
                        Text("只读 · 本地虚构数据").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if collapsed {
                        Button {
                            model.updateSession(session.id) { $0.collapsedCards.remove(card.id) }
                        } label: {
                            Text("展开").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.tint)
                    }
                    Button {
                        model.openReader(sessionID: session.id, cardID: card.id)
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("展开\(card.title())")
                    .accessibilityIdentifier("open-card-\(card.id)")
                }.padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
                if !collapsed {
                    if host.rendered, let presentation = host.presentation {
                        ComponentSummary(presentation: presentation)
                    }
                    ComponentSurface(session: host)
                }
                if !collapsed {
                    Divider()
                    HStack {
                        Button {
                            model.updateSession(session.id) { $0.collapsedCards.insert(card.id) }
                        } label: {
                            Text("收起").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }.foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            model.referenceCard(sessionID: session.id, cardID: card.id, renderedDigest: host.rendered ? card.sha256 : nil)
                        } label: {
                            Label("围绕它提问", systemImage: "bubble.left")
                                .frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .disabled(!host.rendered)
                        .accessibilityIdentifier("reference-inline-\(card.id)")
                    }
                    .buttonStyle(.plain).font(.caption).padding(.horizontal, 12).frame(minHeight: 44)
                }
            }
            .background(WorkbenchSurface.card, in: RoundedRectangle(cornerRadius: 18))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(.quaternary))
        } else {
            Label(card.error?.message ?? "组件结果不可用，未显示输入。", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange).padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

struct ComponentReader: View {
    @Bindable var model: WorkbenchModel
    let selection: ReaderSelection
    let renderers: ComponentRendererPool
    private var session: DemoSession? { model.sessions.first { $0.id == selection.sessionID } }
    private var usesPaneHeader: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
    }

    var body: some View {
        Group {
            if let session, let card = session.card(selection.cardID), card.status == "ready" {
                let host = renderers.session(sessionID: session.id, card: card, detail: true)
                VStack(spacing: 0) {
                    if usesPaneHeader {
                        HStack {
                            Text(card.title()).font(.headline).accessibilityIdentifier("reader-title")
                            Spacer()
                            closeButton
                        }.padding(.horizontal, 16).frame(minHeight: 52).background(.bar)
                    }
                    HStack(alignment: .center, spacing: 8) {
                        Image(systemName: "text.alignleft").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("本地示例 · 只读查看器").font(.caption)
                            Text("来自同一会话的内容块").font(.caption2)
                        }.foregroundStyle(.secondary)
                        Spacer(minLength: 4)
                        Button("查看来源回复") { model.closeReader(returnToSource: true) }
                            .buttonStyle(.plain).font(.caption).foregroundStyle(.tint)
                            .accessibilityIdentifier("reader-source")
                    }.padding(14)
                    Divider()
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(session.entries.compactMap(\.component).filter { $0.status == "ready" }) { item in
                                Button(shortTitle(item)) { model.openReader(sessionID: session.id, cardID: item.id) }
                                    .buttonStyle(.bordered).buttonBorderShape(.capsule)
                                    .tint(item.id == card.id ? .accentColor : .secondary)
                                    .font(.caption).lineLimit(1)
                                    .accessibilityLabel(item.title())
                            }
                        }.padding(.horizontal, 14).padding(.vertical, 12)
                    }
                    .scrollIndicators(.hidden)
                    .clipped()
                    if host.rendered, let presentation = host.presentation,
                       ["line", "bar"].contains(presentation.type), let count = presentation.data?.count, count > 0 {
                        ChartViewControls(session: host, count: count,
                            usesDays: presentation.data?.allSatisfy { $0.day != nil } == true)
                    }
                    if !session.pendingDecisions.isEmpty || session.runtime == .cancelRequested
                        || session.operations.contains(where: { $0.status == .uncertain || $0.status == .failed }) {
                        Label("会话有待处理或未确认的状态，返回对话可查看。", systemImage: "exclamationmark.bubble")
                            .font(.caption).foregroundStyle(.orange).padding(.horizontal, 14).padding(.bottom, 8)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 8) {
                            Image(systemName: host.presentation?.symbol ?? "rectangle.3.group").foregroundStyle(.tint)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(card.title()).font(.subheadline.weight(.semibold))
                                Text("已生成内容 · 本地虚构数据").font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }.padding(14)
                        if host.rendered, let presentation = host.presentation {
                            ComponentSummary(presentation: presentation, windowSize: host.chartWindowSize)
                        }
                        ComponentSurface(session: host).frame(maxWidth: .infinity, maxHeight: .infinity)
                    }

                    .background(WorkbenchSurface.card, in: RoundedRectangle(cornerRadius: 18))
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(.quaternary))
                    .padding(.horizontal, 14).padding(.bottom, 12)
                    Divider()
                    VStack(spacing: 7) {
                        Button {
                            model.referenceCard(sessionID: session.id, cardID: card.id, renderedDigest: host.rendered ? card.sha256 : nil)
                        } label: {
                            Label("围绕这张卡片提问", systemImage: "bubble.left")
                                .frame(maxWidth: .infinity).frame(minHeight: 32)
                        }
                        .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                        .disabled(!host.rendered).accessibilityIdentifier("reader-reference")
                        Text("仅添加引用草稿，不会立即发送").font(.caption2).foregroundStyle(.secondary)
                    }.padding(14).background(.bar)
                }
            } else {
                VStack {
                    if usesPaneHeader { HStack { Spacer(); closeButton }.padding() }
                    ContentUnavailableView("卡片不可用", systemImage: "exclamationmark.triangle",
                                           description: Text("草稿和其他会话内容仍然保留。"))
                }
            }
        }
        .background(WorkbenchSurface.canvas)
        #if os(iOS)
        .navigationTitle(usesPaneHeader ? "" : session?.card(selection.cardID)?.title() ?? "只读查看器")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !usesPaneHeader {
                ToolbarItem(placement: .topBarTrailing) { closeButton }
            }
        }
        #endif
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("component-reader")
    }

    @ViewBuilder private var closeButton: some View {
        if usesPaneHeader {
            Button { model.closeReader() } label: {
                Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("关闭")
            .accessibilityIdentifier("reader-close").keyboardShortcut(.cancelAction)
        } else {
            Button("关闭", systemImage: "xmark") { model.closeReader() }
                .accessibilityIdentifier("reader-close").keyboardShortcut(.cancelAction)
        }
    }

    private func shortTitle(_ card: ComponentRecord) -> String {
        switch card.presentationType {
        case "markdown": "说明"
        case "line": "趋势"
        case "datagrid": "表格"
        case "bar": "柱状图"
        default: "内容"
        }
    }
}

private struct ComponentSummary: View {
    let presentation: ComponentPresentation
    var windowSize: Int?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let total = presentation.fixtureTaskTotal(windowSize: windowSize) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(total, format: .number.precision(.fractionLength(0)))
                        .font(.largeTitle.weight(.semibold)).monospacedDigit()
                    Text("项示例任务").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(windowSize == nil ? "合计 · 本地示例" : "当前范围 · 本地示例").font(.caption2).foregroundStyle(.tint)
                }

            }
            if let source = presentation.source {
                Text(source).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }.padding(.horizontal, 14).padding(.bottom, 4)
    }
}

private struct ChartViewControls: View {
    @Bindable var session: ComponentWebSession
    let count: Int
    let usesDays: Bool

    var body: some View {
        HStack(spacing: 12) {
            if count > 7 {
                Picker("查看范围", selection: Binding(
                    get: { session.chartWindowSize ?? count },
                    set: { session.chartWindowSize = $0 == count ? nil : $0 })) {
                        Text(usesDays ? "7 天" : "最后 7 项").tag(7)
                        Text(usesDays ? "\(count) 天" : "全部").tag(count)
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 160)
                    .accessibilityIdentifier("chart-range")
            }
            Spacer(minLength: 0)
            Picker("显示方式", selection: $session.chartDataOnly) {
                Text("图表").tag(false)
                Text("数据").tag(true)
            }
            .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 140)
            .accessibilityIdentifier("chart-display")
        }
        .padding(.horizontal, 14).padding(.bottom, 12)
        .task(id: "\(session.requestID)/\(session.rendered)/\(session.chartWindowSize ?? 0)/\(session.chartDataOnly)") {
            await session.applyChartPresentation()
        }
    }
}
