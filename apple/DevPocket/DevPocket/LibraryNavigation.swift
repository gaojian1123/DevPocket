import SwiftUI
#if os(macOS)
import AppKit
#endif

struct LibraryWorkbench: View {
    @Bindable var model: WorkbenchModel
    let renderers: ComponentRendererPool
    let width: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var compactColumn = NavigationSplitViewColumn.sidebar
    @State private var showingComputerPairing = false
    #if os(macOS)
    @State private var searchFocusRequested = false
    #else
    @FocusState private var searchFocused: Bool
    #endif
    @State private var divided = false

    private var sidebarMaterial: AnyShapeStyle {
        reduceTransparency ? AnyShapeStyle(.background) : AnyShapeStyle(.thinMaterial)
    }

    private var inspectorPresented: Binding<Bool> {
        Binding(
            get: { model.selected?.section == "files" || model.selected?.section == "changes" },
            set: { presented in
                if let session = model.selected {
                    model.updateSession(session.id) {
                        $0.section = presented ? ($0.section == "changes" ? "changes" : "files") : "chat"
                    }
                }
            })
    }

    var body: some View {
        navigation
            .sheet(isPresented: $showingComputerPairing) {
                ComputerPairingView()
            }
            #if os(iOS)
            .sheet(isPresented: $model.showingSettings) {
                NavigationStack {
                    FixtureSettings(model: model)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("完成") { model.showingSettings = false }
                                    .accessibilityIdentifier("settings-close")
                            }
                        }
                }
            }
            #endif
            .onGeometryChange(for: Bool.self) { proxy in
                #if os(iOS)
                if #available(iOS 27.1, *) {
                    return !proxy.reservedRegions(kind: .division).isEmpty
                } else {
                    return false
                }
                #else
                return false
                #endif
            } action: {
                divided = $0
            }
            .onChange(of: model.snapshot.selectedSessionID, initial: true) {
                compactColumn = model.selected == nil ? .sidebar : .detail
            }
            .onChange(of: model.library.scope) { compactColumn = .sidebar }
            .onChange(of: model.library.searchText) { model.persist() }
            .onChange(of: model.searchRequest) {
                model.closeReader()
                model.select(nil)
                columns = .all
                compactColumn = .sidebar
                #if os(macOS)
                searchFocusRequested = true
                #else
                searchFocused = true
                #endif
            }
    }

    @ViewBuilder private func inspector(_ session: DemoSession) -> some View {
        let content = ReadOnlyFixtureView(
            section: session.section == "changes" ? "changes" : "files", branch: session.branch)
        #if os(iOS)
        if horizontalSizeClass == .compact {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Picker("查看内容", selection: Binding(
                        get: { session.section == "changes" ? "changes" : "files" },
                        set: { section in
                            model.updateSession(session.id) { $0.section = section }
                        })) {
                            Text("文件").tag("files")
                            Text("更改").tag("changes")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .accessibilityIdentifier("inspector-sections")
                    Button("关闭", systemImage: "xmark") {
                        inspectorPresented.wrappedValue = false
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .controlSize(.large)
                    .accessibilityIdentifier("inspector-close")
                    .keyboardShortcut(.cancelAction)
                }
                .padding(12)
                content
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("session-inspector")
        } else {
            content
        }
        #else
        content
        #endif
    }

    private var filterMenu: some View {
        Menu("筛选", systemImage: model.library.hasRefinements ? "line.3.horizontal.decrease.circle.fill"
             : "line.3.horizontal.decrease.circle") {
            LibraryRefinementMenu(model: model)
        }
        .accessibilityIdentifier("library-filters")
    }

    @ViewBuilder private var navigation: some View {
        #if os(macOS)
        if width < 660 {
            NavigationStack {
                if model.selected != nil {
                    conversationContent
                        .toolbar {
                            ToolbarItem(placement: .navigation) {
                                Button("会话列表", systemImage: "chevron.left") { model.select(nil) }
                                    .accessibilityIdentifier("library-back")
                            }
                        }
                } else {
                    listContent.navigationTitle("DevPocket")
                }
            }
        } else {
            splitView
        }
        #else
        splitView
        #endif
    }

    private var splitView: some View {
        NavigationSplitView(columnVisibility: $columns, preferredCompactColumn: $compactColumn) {
            listContent
                .navigationSplitViewColumnWidth(min: 240,
                    ideal: divided ? width / 2 : 300, max: divided ? max(380, width * 0.65) : 380)
                #if os(iOS)
                .containerBackground(sidebarMaterial, for: .navigation)
                .containerBackground(.clear, for: .navigationSplitView)
                #endif
        } detail: {
            conversationContent
        }
        .navigationSplitViewStyle(.balanced)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library-navigation")
    }

    @ViewBuilder private var conversationContent: some View {
        Group {
            if let session = model.selected {
                ConversationPane(model: model, sessionID: session.id, renderers: renderers)
            } else {
                ContentUnavailableView("选择一个会话", systemImage: "bubble.left.and.bubble.right",
                    description: Text("从侧栏选择会话，或按项目与电脑筛选。本地示例未连接真实主机。"))
                    .navigationTitle("DevPocket · 本地示例")
            }
        }
        .frame(minWidth: 280, maxWidth: .infinity, maxHeight: .infinity)
        .background { WorkbenchBackdrop() }
        .inspector(isPresented: inspectorPresented) {
            if let session = model.selected {
                inspector(session)
                    .inspectorColumnWidth(min: 260, ideal: 320, max: 440)
                    .presentationDetents([.large])
                    #if os(iOS)
                    .presentationBackground(sidebarMaterial)
                    .presentationDragIndicator(.visible)
                    .accessibilityAction(.escape) { inspectorPresented.wrappedValue = false }
                    #endif
            }
        }
        .toolbar {
            if let session = model.selected {
                SessionInspectorToolbar(model: model, sessionID: session.id)
            }
        }
    }

    private var scopeMenu: some View {
        Menu {
            Picker("查看范围", selection: Binding(
                get: { model.library.scope }, set: { model.selectScope($0) })) {
                ForEach(LibraryScope.collections, id: \.self) { scope in
                    Label("\(scope.title) · \(model.count(in: scope))", systemImage: scope.symbol)
                        .tag(scope)
                        .accessibilityIdentifier(scope.identifier)
                }
            }
        } label: {
            Text(model.library.scope.title).font(.headline)
        }
        .accessibilityLabel("查看范围：\(model.library.scope.title)")
        .accessibilityIdentifier("library-scope")
    }

    private var libraryActions: some View {
        Menu("会话库操作", systemImage: "ellipsis") {
            Button("添加电脑", systemImage: "plus") { showingComputerPairing = true }
                .accessibilityIdentifier("add-computer")
            #if os(iOS)
            Button("设置", systemImage: "gearshape") { model.showingSettings = true }
                .accessibilityIdentifier("library-settings")
            #endif
        }
        .accessibilityIdentifier("library-actions")
    }

    private var attentionShortcut: some View {
        Button {
            model.selectScope(.attention)
        } label: {
            Label("\(model.count(in: .attention))", systemImage: "tray")
                .font(.caption.weight(.medium))
                #if os(iOS)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                #endif
        }
        .buttonStyle(.plain)
        .foregroundStyle(.orange)
        .accessibilityLabel("待处理：\(model.count(in: .attention))")
        .accessibilityIdentifier("library-attention")
    }

    private var listContent: some View {
        #if os(macOS)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    scopeMenu.menuStyle(.borderlessButton).fixedSize()
                    Spacer()
                    if model.count(in: .attention) > 0 { attentionShortcut }
                }
                HStack(spacing: 8) {
                    LibrarySearchField(text: $model.library.searchText, focusRequested: $searchFocusRequested)
                        .frame(maxWidth: .infinity)
                    filterMenu
                        .labelStyle(.iconOnly)
                        .menuStyle(.borderlessButton)
                        .buttonStyle(.glass)
                        .fixedSize()
                    libraryActions
                        .labelStyle(.iconOnly)
                        .menuStyle(.borderlessButton)
                        .buttonStyle(.glass)
                        .fixedSize()
                }
            }
            .padding(12)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("library-controls")
            libraryResults
        }
        #else
        libraryResults
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack {
                    scopeMenu
                    Spacer()
                    if model.count(in: .attention) > 0 { attentionShortcut }
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(sidebarMaterial)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("library-controls")
            }
            .navigationTitle("会话")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $model.library.searchText, prompt: "搜索会话、项目或分支")
            .searchFocused($searchFocused)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    filterMenu
                    libraryActions
                }
            }
        #endif
    }

    private var libraryResults: some View {
        Group {
            if model.library.scope == .attention {
                PendingView(model: model)
            } else {
                SessionList(model: model)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.library.hasRefinements {
                HStack {
                    Text([model.library.projectFilter, model.library.hostFilter].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).lineLimit(2)
                    Spacer()
                    Button("清除筛选", systemImage: "xmark.circle.fill") {
                        model.refineLibrary(project: nil, host: nil)
                    }
                    .labelStyle(.iconOnly)
                    .accessibilityIdentifier("clear-library-filters")
                }.padding(12).background(sidebarMaterial)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack {
                Label(model.snapshot.offline ? "离线示例" : "本地示例",
                    systemImage: model.snapshot.offline ? "wifi.slash" : "circle.dotted")
                Spacer()
                Text("未连接真实主机")
            }
            .font(.caption2).foregroundStyle(.secondary)
            .padding(12)
            .background(sidebarMaterial)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("library-status")
        }
    }
}

struct SessionInspectorToolbar: ToolbarContent {
    @Bindable var model: WorkbenchModel
    let sessionID: String

    private var placement: ToolbarItemPlacement {
        #if os(macOS)
        .primaryAction
        #else
        .topBarTrailing
        #endif
    }

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: placement) {
            item("文件", symbol: "doc.text", section: "files")
            item("更改", symbol: "arrow.triangle.branch", section: "changes")
        }
    }

    private func item(_ title: String, symbol: String, section: String) -> some View {
        let active = model.sessions.first { $0.id == sessionID }?.section == section
        return Toggle(title, systemImage: symbol, isOn: Binding(
            get: { model.sessions.first { $0.id == sessionID }?.section == section },
            set: { selected in
                model.updateSession(sessionID) { $0.section = selected ? section : "chat" }
            }))
        .toggleStyle(.button)
        .labelStyle(.iconOnly)
        .accessibilityIdentifier("inspector-\(section)")
        .help(active ? "收起\(title)" : "查看\(title)")
    }
}

#if os(macOS)
private struct LibrarySearchField: NSViewRepresentable {
    @Binding var text: String
    @Binding var focusRequested: Bool

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    func makeNSView(context: Context) -> LibrarySearchControl {
        let field = LibrarySearchControl()
        field.placeholderString = "搜索会话库"
        field.sendsSearchStringImmediately = true
        field.sendsWholeSearchString = false
        field.target = context.coordinator
        field.action = #selector(Coordinator.searchChanged(_:))
        field.setAccessibilityIdentifier("session-search")
        field.setAccessibilityLabel("搜索会话库")
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateNSView(_ field: LibrarySearchControl, context: Context) {
        context.coordinator.text = $text
        if field.stringValue != text { field.stringValue = text }
        field.focusRequested = $focusRequested
        if focusRequested { field.applyFocusRequest() }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: LibrarySearchControl, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? nsView.intrinsicContentSize.width, height: nsView.intrinsicContentSize.height)
    }

    final class Coordinator: NSObject {
        var text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        @objc func searchChanged(_ field: NSSearchField) { text.wrappedValue = field.stringValue }
    }
}

final class LibrarySearchControl: NSSearchField {
    var focusRequested = Binding.constant(false)

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyFocusRequest()
    }

    func applyFocusRequest() {
        DispatchQueue.main.async { [weak self] in
            guard let self, focusRequested.wrappedValue, let window else { return }
            if window.makeFirstResponder(self) { focusRequested.wrappedValue = false }
        }
    }
}
#endif

private struct LibraryRefinementMenu: View {
    @Bindable var model: WorkbenchModel

    var body: some View {
        if case .project = model.library.scope {
            hostPicker
        } else if case .host = model.library.scope {
            projectPicker
        } else {
            projectPicker
            hostPicker
        }
        if model.library.hasRefinements {
            Button("清除筛选") { model.refineLibrary(project: nil, host: nil) }
        }
    }

    private var projectPicker: some View {
        Picker("项目", selection: Binding(
            get: { model.library.projectFilter },
            set: { model.refineLibrary(project: $0, host: model.library.hostFilter) })) {
                Text("所有项目").tag(String?.none)
                ForEach(model.libraryProjects, id: \.self) { Text($0).tag(Optional($0)) }
            }
    }

    private var hostPicker: some View {
        Picker("电脑", selection: Binding(
            get: { model.library.hostFilter },
            set: { model.refineLibrary(project: model.library.projectFilter, host: $0) })) {
                Text("所有电脑").tag(String?.none)
                ForEach(model.libraryHosts, id: \.self) { Text($0).tag(Optional($0)) }
            }
    }
}
