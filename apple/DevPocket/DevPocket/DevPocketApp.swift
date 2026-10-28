import SwiftUI

@main
struct DevPocketApp: App {
    @State private var model: WorkbenchModel

    init() {
        let directory = URL.applicationSupportDirectory.appending(path: "DevPocketFixtures", directoryHint: .isDirectory)
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        let file = arguments.contains("--fixture-test-store") ? "ui-tests.json" : "state-v1.json"
        let url: URL? = arguments.contains("--fixture-in-memory") ? nil : directory.appending(path: file)
        let model = WorkbenchModel(persistenceURL: url)
        if arguments.contains("--fixture-reset") { model.reset() }
        #else
        let model = WorkbenchModel(persistenceURL: directory.appending(path: "state-v1.json"))
        #endif
        _model = State(initialValue: model)
    }

    var body: some Scene {
        #if os(macOS)
        Window("DevPocket · 本地示例", id: "workbench") {
            ContentView(model: model).frame(minWidth: 360, minHeight: 420)
        }
        .defaultSize(width: 1180, height: 820)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(after: .textEditing) {
                Button("搜索会话") { model.searchRequest += 1 }
                    .keyboardShortcut("k", modifiers: .command)
            }
        }
        Settings {
            FixtureSettings(model: model)
                .frame(minWidth: 420, idealWidth: 520, minHeight: 480)
                .onAppear { model.showingSettings = true }
                .onDisappear { model.showingSettings = false }
        }
        #else
        WindowGroup {
            ContentView(model: model)
        }
        #endif
    }
}
