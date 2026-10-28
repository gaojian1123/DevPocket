import SwiftUI

struct ComposerView: View {
    @Bindable var model: WorkbenchModel
    let session: DemoSession
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var confirmsStop = false
    @FocusState private var inputFocused: Bool
    private var draft: DemoDraft { model.sessions.first { $0.id == session.id }?.draft ?? session.draft }
    private var hasText: Bool { !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var showsStop: Bool { !hasText && session.runtime != .idle }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reference = draft.reference {
                HStack(alignment: .top) {
                    Label("关于「\(reference.title)」", systemImage: "square.stack.3d.up").font(.callout).lineLimit(2)
                    Spacer()
                    Button {
                        model.updateSession(session.id) { $0.draft.reference = nil }
                    } label: {
                        Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("移除引用")
                    .accessibilityIdentifier("remove-reference")
                }
                .padding(.leading, 12)
                .foregroundStyle(.tint)
                .background(.tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("composer-reference")
            }
            if reduceTransparency {
                composerControls.background(.background, in: RoundedRectangle(cornerRadius: 24))
            } else {
                composerControls.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24))
            }
            Text(model.snapshot.offline ? "离线草稿 · 恢复在线后也不会自动发送" : "本地演示 · 引用占用 1 个附件位置 · 不连接真实服务")
                .font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .onChange(of: model.library.scope) { inputFocused = false }
        .onChange(of: model.showingSettings) { if model.showingSettings { inputFocused = false } }
        .onDisappear { inputFocused = false }
        #if os(iOS)
        .toolbar {
            if inputFocused {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("完成输入") { inputFocused = false }.accessibilityIdentifier("dismiss-keyboard")
                }
            }

        }
        #endif
        .alert("停止本地模拟？", isPresented: $confirmsStop) {
            Button("继续等待", role: .cancel) {}
            Button("请求停止", role: .destructive) { model.requestStop(sessionID: session.id) }
                .accessibilityIdentifier("confirm-stop")
        } message: {
            Text("这会记录取消请求，并可能取消尚未确认的模拟排队消息。收到模拟空闲回执前仍显示取消待确认。不会控制原始客户端或终止系统进程。")
        }
    }

    private var composerControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(model.snapshot.offline ? "离线草稿，不会自动补发…" : "继续这轮思路，发起新的请求…", text: Binding(
                get: { draft.text }, set: { text in model.updateSession(session.id) { $0.draft.text = text } }),
                axis: .vertical)
                .lineLimit(1...6)
                .font(.body)
                .focused($inputFocused)
                .textFieldStyle(.plain)
                .padding(.horizontal, 4).padding(.top, 4)
                .accessibilityIdentifier("composer-draft")
                .accessibilityHint("本地模拟草稿，不会发送给真实 GitHub Copilot")
            HStack {
                Label("本地模拟", systemImage: "sparkle")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    if showsStop { confirmsStop = true } else { model.send(sessionID: session.id) }
                } label: {
                    Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                        .font(.body.weight(.semibold))
                }
                .buttonStyle(.borderedProminent).buttonBorderShape(.circle)
                .controlSize(.large)
                .frame(minWidth: 44, minHeight: 44)
                .tint(showsStop ? .red : .accentColor)
                .disabled(model.snapshot.offline || (!showsStop && !hasText) || (showsStop && session.runtime == .cancelRequested))
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel(showsStop ? "Stop" : "Send")
                .accessibilityIdentifier("composer-primary")
            }
        }
        .padding(14)
    }
}

struct DecisionView: View {
    @Bindable var model: WorkbenchModel
    let session: DemoSession
    let decision: DemoDecision
    @State private var permission: String?
    @FocusState private var answerFocused: Bool
    private var operation: DemoOperation? { session.operations.first { $0.id == decision.operationID } }
    private var locked: Bool { model.snapshot.offline || decision.operationID != nil }
    private var answer: String {
        model.sessions.first { $0.id == session.id }?.decisions.first { $0.id == decision.id }?.answer ?? decision.answer
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(decision.title).font(.headline)
            Text(decision.details).textSelection(.enabled)
            if let answer = decision.confirmedAnswer {
                Label("模拟已确认：\(answer == "approve-once" ? "仅允许一次" : answer == "reject" ? "拒绝" : answer)",
                      systemImage: "checkmark.circle").foregroundStyle(.secondary)
            } else if decision.kind == .unsupported {
                Label("需要原始客户端 · 此示例不执行操作", systemImage: "laptopcomputer")
                    .foregroundStyle(.orange)
            } else {
                if decision.kind == .permission {
                    HStack {
                        Button { permission = "reject" } label: {
                            Text("拒绝").frame(minWidth: 44, minHeight: 44)
                        }.disabled(locked)
                        Button { permission = "approve-once" } label: {
                            Text("仅允许一次").frame(minHeight: 44)
                        }
                            .buttonStyle(.bordered).disabled(locked)
                    }
                } else {
                    Menu {
                        ForEach(decision.choices, id: \.self) { choice in
                            Button(choice) { updateAnswer(choice) }
                        }
                    } label: {
                        Text("选择一个答案").frame(minHeight: 44)
                    }.disabled(decision.operationID != nil)
                    TextField("或输入你自己的答案", text: Binding(get: { answer }, set: updateAnswer), axis: .vertical)
                        .focused($answerFocused)
                        .textFieldStyle(.roundedBorder).disabled(decision.operationID != nil)
                        .accessibilityIdentifier("decision-answer")
                    Button {
                        model.decide(sessionID: session.id, decisionID: decision.id, answer: answer)
                    } label: {
                        Text("提交模拟答案").frame(minHeight: 44)
                    }
                    .disabled(locked || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("submit-answer")
                }
                if let operation {
                    Text(operation.status.label).font(.callout).foregroundStyle(.orange)
                    Text("这不是已确认的决定；不会自动再次提交。").font(.caption)
                } else if model.snapshot.offline {
                    Text("离线：答案可以保留，不能提交。").font(.caption)
                }
            }
        }
        .onChange(of: model.library.scope) { answerFocused = false }
        .onChange(of: model.showingSettings) { if model.showingSettings { answerFocused = false } }
        #if os(iOS)
        .toolbar {
            if answerFocused {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("完成输入") { answerFocused = false }.accessibilityIdentifier("dismiss-keyboard")
                }
            }
        }
        #endif
        .alert("确认本地模拟决定", isPresented: Binding(
            get: { permission != nil }, set: { if !$0 { permission = nil } })) {
            Button("取消", role: .cancel) { permission = nil }
            Button("确认") {
                if let permission { model.decide(sessionID: session.id, decisionID: decision.id, answer: permission) }
                permission = nil
            }
        } message: { Text("\(decision.details)\n\n只记录本地模拟请求，收到模拟回执后才显示确认。") }
    }

    private func updateAnswer(_ text: String) {
        model.updateSession(session.id) {
            if let index = $0.decisions.firstIndex(where: { $0.id == decision.id }) { $0.decisions[index].answer = text }
        }
    }
}

struct PendingView: View {
    @Bindable var model: WorkbenchModel
    var body: some View {
        List {
            ForEach(LibraryAttention.Kind.allCases, id: \.self) { kind in
                let items = model.visibleAttention.filter { $0.kind == kind }
                if !items.isEmpty {
                    Section(kind.title) {
                        ForEach(items) { item in
                            Button { model.openAttention(item) } label: {
                                Label {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(item.title).font(.body.weight(.medium))
                                        Text(item.detail).font(.caption)
                                        if let session = model.sessions.first(where: { $0.id == item.sessionID }) {
                                            Text("\(session.title) · \(session.host)").font(.caption2)
                                        }
                                    }
                                } icon: {
                                    Image(systemName: kind.symbol)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("attention-\(item.id)")
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .overlay {
            if model.visibleAttention.isEmpty {
                ContentUnavailableView("没有待处理事项", systemImage: "tray",
                    description: Text("需要决定或确认的本地示例事项会出现在这里。"))
            }
        }
        .accessibilityIdentifier("attention-list")
    }
}

struct ComputerPairingView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack {
                ContentUnavailableView {
                    Label("真实配对尚未接入", systemImage: "desktopcomputer")
                } description: {
                    Text("这里将用于配对新的电脑。当前版本仅提供原生入口和离线预览，不会扫描二维码、连接主机或保存配对凭据。")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("computer-pairing")
            .navigationTitle("添加电脑")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("pairing-close")
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 440, idealWidth: 520, minHeight: 300, idealHeight: 360)
        #endif
    }
}

struct FixtureSettings: View {
    @Bindable var model: WorkbenchModel
    @State private var resetting = false
    var body: some View {
        Form {
            Section("外观") {
                Picker("显示模式", selection: $model.snapshot.appearance) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
                .accessibilityIdentifier("appearance-picker")
                Text("使用系统字号、对比度、减少透明度和 VoiceOver 设置。没有自定义折叠或卡片转场。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("本地示例数据") {
                Toggle("离线示例", isOn: Binding(get: { model.snapshot.offline }, set: model.setOffline))
                    .toggleStyle(.switch)
                    .accessibilityIdentifier("offline-toggle")
                Picker("下一条模拟回执", selection: $model.snapshot.nextOutcome) {
                    ForEach(DemoOutcome.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Text("模拟回执在本地延迟呈现。断开、失败和未确认的操作不会自动重试。重新打开应用保留草稿；仍在等待的操作显示为不确定。")
                    .font(.caption).foregroundStyle(.secondary)
                Text("新版示例包含跨项目、跨电脑的会话。已保存的数据不会自动替换；明确重置后才载入新版示例。")
                    .font(.caption).foregroundStyle(.secondary)
                Button("重置所有本地示例", role: .destructive) { resetting = true }
                    .accessibilityIdentifier("reset-fixtures")
            }
            Section("连接与隐私") {
                Label("未连接真实 GitHub Copilot", systemImage: "network.slash")
                Text("没有 relay 配对、主机注册、设备凭据或后台推送。文件和 Git 页面也是虚构的只读数据。")
                Text("图表、表格和 Markdown 使用随应用打包的 DevPocket renderer。WKWebView 禁止联网和自由导航；外部链接需要原生确认。")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("设置")
        .preferredColorScheme(model.snapshot.appearance == "light" ? .light : model.snapshot.appearance == "dark" ? .dark : nil)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fixture-settings")
        .onChange(of: model.snapshot.appearance) { model.persist() }
        .onChange(of: model.snapshot.nextOutcome) { model.persist() }
        .alert("重置本地示例？", isPresented: $resetting) {
            Button("取消", role: .cancel) {}
            Button("重置", role: .destructive) { model.reset() }
        } message: {
            Text("只清除这个示例应用的草稿、引用、模拟回执和视图状态，并恢复虚构数据。不改变任何真实主机或会话。")
        }
    }
}

struct ReadOnlyFixtureView: View {
    let section: String
    let branch: String
    var body: some View {
        List {
            Section {
                Label("只读虚构示例 · 不访问文件系统或 Git", systemImage: "lock")
                    .font(.callout).foregroundStyle(.secondary)
            }
            .listRowBackground(Color.clear)
            if section == "files" {
                Section("示例项目") {
                    DisclosureGroup("README.md") {
                        Text("# Fictional workspace\n\n这段内容来自应用内的本地 fixture。没有读取真实仓库。")
                            .font(.body.monospaced()).textSelection(.enabled)
                    }
                    DisclosureGroup("Sources/Example.swift") {
                        Text("struct Example {\n    let title = \"Local fixture\"\n}")
                            .font(.body.monospaced()).textSelection(.enabled)
                    }
                }
                .listRowBackground(Color.clear)
            } else {
                Section("示例分支 \(branch) · 1 个虚构更改") {
                    Text("README.md").font(.headline)
                    Text("@@ -1 +1 @@\n- Draft example\n+ Offline fixture example")
                        .font(.body.monospaced()).textSelection(.enabled)
                    Text("没有暂存、提交、检出或推送功能。").foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier("session-\(section)-content")
    }
}
