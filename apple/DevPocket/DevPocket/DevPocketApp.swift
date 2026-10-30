import SwiftUI

@main
struct DevPocketApp: App {
    @State private var model: WorkbenchModel

    init() {
        let directory = URL.applicationSupportDirectory.appending(path: "DevPocketFixtures", directoryHint: .isDirectory)
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        let url = Self.fixtureStoreURL(directory: directory, arguments: arguments,
                                       isTestHost: NSClassFromString("XCTestCase") != nil)
        let model = WorkbenchModel(persistenceURL: url)
        if arguments.contains("--fixture-reset") { model.reset() }
        #else
        let model = WorkbenchModel(persistenceURL: directory.appending(path: "state-v1.json"))
        #endif
        _model = State(initialValue: model)
    }

    #if DEBUG
    static func fixtureStoreURL(directory: URL, arguments: [String], isTestHost: Bool) -> URL? {
        if arguments.contains("--fixture-in-memory") { return nil }
        if arguments.contains("--fixture-test-store") { return directory.appending(path: "ui-tests.json") }
        return isTestHost ? nil : directory.appending(path: "state-v1.json")
    }
    #endif

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
