import CoreGraphics
import Foundation
import XCTest
#if os(iOS)
import UIKit
#endif

@MainActor
final class DevPocketUITests: XCTestCase {
    private var app: XCUIApplication!

    private func launch(contentSize: String? = nil) {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["--fixture-test-store", "--fixture-reset", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        if let contentSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", contentSize] }
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement {
        if id == "session-search" { return app.searchFields.firstMatch }
        #if os(macOS)
        return app.windows.descendants(matching: .any).matching(identifier: id).firstMatch
        #else
        return app.descendants(matching: .any).matching(identifier: id).firstMatch
        #endif
    }

    private func activate(_ element: XCUIElement) {
        let exists = element.waitForExistence(timeout: 10)
        if !exists {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "missing-control-hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        XCTAssertTrue(exists)
        #if os(macOS)
        if app.state != .runningForeground { app.activate() }
        element.click()
        #else
        element.tap()
        #endif
    }

    private func enter(_ text: String, into element: XCUIElement) {
        #if os(macOS)
        waitForInputSourceHint()
        // Let the input-source hint settle after the first real key before batching text.
        if let first = text.first {
            element.typeKey(String(first), modifierFlags: [])
            waitForInputSourceHint()
            if text.count > 1 { element.typeText(String(text.dropFirst())) }
        }
        #else
        element.typeText(text)
        #endif
        #if os(macOS)
        // Commit the input method's marked text without changing the user's input source.
        waitForInputSourceHint()
        element.typeKey(.return, modifierFlags: [])
        waitForInputSourceHint()
        element.typeKey(.tab, modifierFlags: [])
        #endif
    }

    #if os(macOS)
    private func waitForInputSourceHint() {
        // The transient hint can change accessibility type; wait without clicking it.
        let hint = app.descendants(matching: .any).matching(identifier: "InputSource").firstMatch
        XCTAssertTrue(hint.waitForNonExistence(timeout: 5))
    }
    #endif

    private func clear(_ element: XCUIElement) {
        #if os(macOS)
        activate(element)
        // Selecting text can replace the field's accessibility element.
        app.typeKey("a", modifierFlags: .command)
        app.typeKey(.delete, modifierFlags: [])
        #else
        // Keep the caret at the end after typing; retapping can move it before the text.
        let count = (element.value as? String)?.count ?? 0
        element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: count))
        #endif
    }

    private func text(_ value: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@", value, value)).firstMatch
    }

    private func finishEditing() {
        #if os(iOS)
        let done = element("dismiss-keyboard")
        if done.exists || app.keyboards.firstMatch.exists {
            activate(done)
            XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 10))
        }
        #endif
    }

    private func conversationViewport() -> CGRect {
        let frame = element("conversation-timeline").frame.intersection(element("conversation-pane").frame)
        let top = max(frame.minY, element("conversation-header").frame.maxY)
        let bottom = min(frame.maxY, element("conversation-composer").frame.minY)
        XCTAssertGreaterThan(frame.width, 0)
        XCTAssertGreaterThan(bottom, top)
        return CGRect(x: frame.minX, y: top, width: frame.width, height: bottom - top)
    }

    private func reveal(_ target: XCUIElement) {
        finishEditing()
        let timeline = element("conversation-timeline")
        for _ in 0..<12 {
            let viewport = conversationViewport()
            if target.exists && target.isHittable && viewport.contains(target.frame) { return }
            let above = target.exists && target.frame.minY < viewport.minY
            #if os(macOS)
            timeline.scroll(byDeltaX: 0, deltaY: above ? 250 : -250)
            #else
            let distance = target.exists ? abs(target.frame.midY - viewport.midY) : viewport.height * 0.45
            let step = min(max(40, distance), viewport.height * 0.45)
            let start = timeline.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
                dx: viewport.midX - timeline.frame.minX,
                dy: viewport.minY - timeline.frame.minY + viewport.height * (above ? 0.3 : 0.7)))
            let end = start.withOffset(CGVector(dx: 0, dy: above ? step : -step))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
            #endif
        }
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "unreachable-control-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        XCTAssertTrue(target.isHittable && conversationViewport().contains(target.frame))
    }

    private func readingAnchor() throws -> String {
        let viewport = conversationViewport()
        let snapshot = try element("conversation-timeline").snapshot()
        var pending = snapshot.children
        var rows: [any XCUIElementSnapshot] = []
        while let row = pending.popLast() {
            if row.identifier.hasPrefix("entry-") { rows.append(row) }
            pending.append(contentsOf: row.children)
        }
        return try XCTUnwrap(rows.filter { !$0.frame.isEmpty && $0.frame.intersects(viewport) }
            .sorted { $0.frame.minY < $1.frame.minY }.first?.identifier)
    }

    private func openSession(_ id: String) {
        let target = element("session-\(id)")
        let header = element("library-controls")
        let footer = element("library-status")
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        XCTAssertTrue(footer.waitForExistence(timeout: 10))
        var visible = CGRect.null
        for _ in 0..<12 {
            let list = element("session-list")
            let frame = list.frame
            let top = max(frame.minY, header.frame.maxY)
            let bottom = min(frame.maxY, footer.frame.minY)
            XCTAssertGreaterThan(bottom, top)
            let viewport = CGRect(x: frame.minX, y: top, width: frame.width, height: bottom - top)
            visible = target.exists ? target.frame.intersection(viewport) : .null
            if visible.width >= 44 && visible.height >= 44 { break }
            let above = target.exists && target.frame.midY < viewport.midY
            #if os(macOS)
            list.scroll(byDeltaX: 0, deltaY: above ? 300 : -300)
            #else
            if above { list.swipeDown() } else { list.swipeUp() }
            #endif
        }
        XCTAssertGreaterThanOrEqual(visible.width, 44)
        XCTAssertGreaterThanOrEqual(visible.height, 44)
        let point = target.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: visible.midX - target.frame.minX, dy: visible.midY - target.frame.minY))
        #if os(macOS)
        if app.state != .runningForeground { app.activate() }
        point.click()
        #else
        point.tap()
        #endif
        #if os(iOS)
        let list = element("session-list")
        let pane = element("conversation-pane")
        if list.exists && list.isHittable && pane.exists && list.frame.intersects(pane.frame),
           let hide = app.buttons.matching(NSPredicate(format: "label == %@", "隐藏边栏"))
            .allElementsBoundByIndex.first(where: \.isHittable) {
            activate(hide)
        }
        let ready = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"), object: element("composer-draft"))
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
        #endif
    }

    private func openSettings() {
        if element("dismiss-keyboard").exists { activate(element("dismiss-keyboard")) }
        #if os(macOS)
        activate(app.menuBars.menuBarItems["DevPocket"])
        activate(app.menuItems["设置…"])
        #else
        showLibrary()
        activate(element("library-actions"))
        let settings = element("library-settings")
        XCTAssertEqual(app.buttons.matching(identifier: "library-settings").allElementsBoundByIndex.filter(\.isHittable).count, 1)
        activate(settings)
        #endif
        XCTAssertTrue(element("fixture-settings").waitForExistence(timeout: 10))
    }

    private func closeSettings() {
        #if os(macOS)
        app.typeKey("w", modifierFlags: .command)
        #else
        activate(element("settings-close"))
        #endif
        XCTAssertTrue(element("fixture-settings").waitForNonExistence(timeout: 10))
    }

    private var navigationBack: XCUIElement {
        let native = app.buttons["BackButton"]
        // Duo can place navigation controls in its system toolbar instead of a navigation bar.
        if native.exists && native.isHittable { return native }
        return app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@",
            ["会话", "返回"])).firstMatch
    }

    private func assertSessionSearchAvailable() {
        #if os(iOS)
        let searchButton = app.buttons["搜索"]
        if searchButton.exists {
            XCTAssertTrue(searchButton.isHittable)
            return
        }
        #endif
        XCTAssertTrue(element("session-search").waitForExistence(timeout: 10))
    }

    private func sessionSearchField() -> XCUIElement {
        let search = element("session-search")
        #if os(iOS)
        if !search.exists { activate(app.buttons["搜索"]) }
        #endif
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        return search
    }

    private func showLibrary() {
        if element("dismiss-keyboard").exists { activate(element("dismiss-keyboard")) }
        #if os(macOS)
        let visibleControl = element("library-scope")
        #else
        // The native toolbar identifies the visible column; inset menus can report stale hit state.
        let visibleControl = element("library-actions")
        #endif
        if visibleControl.exists && visibleControl.isHittable { return }
        #if os(macOS)
        let back = element("library-back")
        if back.exists && back.isHittable {
            activate(back)
        } else {
            activate(app.buttons.matching(NSPredicate(format: "label IN %@", ["显示边栏", "切换边栏"])).firstMatch)
        }
        #else
        if let sidebar = app.buttons.matching(NSPredicate(format: "label == %@", "显示边栏"))
            .allElementsBoundByIndex.first(where: \.isHittable) {
            activate(sidebar)
        } else {
            activate(navigationBack)
        }
        #endif
        let visible = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"), object: visibleControl)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 10), .completed)
    }

    private func selectScope(_ identifier: String) {
        let titles = ["scope-all": "全部会话", "scope-pinned": "已置顶",
                      "scope-attention": "待处理", "scope-archived": "已归档"]
        guard let title = titles[identifier] else {
            XCTFail("Unknown library scope: \(identifier)")
            return
        }
        showLibrary()
        activate(element("library-scope"))
        // Native picker menus expose the displayed labels, not identifiers on their SwiftUI labels.
        #if os(macOS)
        activate(app.menuItems["查看范围"])
        activate(app.menuItems.matching(NSPredicate(format: "title BEGINSWITH %@", "\(title) · ")).firstMatch)
        let selected = NSPredicate(format: "title CONTAINS %@", title)
        #else
        activate(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(title) · ")).firstMatch)
        let selected = NSPredicate(format: "label CONTAINS %@", title)
        #endif
        let scope = element("library-scope")
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: selected, object: scope)], timeout: 10)
        if result != .completed {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "scope-selection-hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        XCTAssertEqual(result, .completed, "Expected \(title); \(scope.debugDescription)")
    }

    private func openSessionMenu(_ id: String) {
        let row = element("session-\(id)")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        #if os(macOS)
        row.rightClick()
        #else
        row.press(forDuration: 1)
        #endif
    }

    private func sessionMenuAction(_ identifier: String, title: String) {
        #if os(macOS)
        activate(app.menuItems[title])
        #else
        activate(element(identifier))
        #endif
    }

    private func refineLibrary(_ group: String, value: String) {
        activate(element("library-filters"))
        #if os(macOS)
        if app.menuItems[group].exists { activate(app.menuItems[group]) }
        activate(app.menuItems[value])
        #else
        if app.buttons[group].exists { activate(app.buttons[group]) }
        activate(app.buttons[value])
        #endif
    }

    private func toggleOffline(expected: String) {
        let toggle = element("offline-toggle")
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        let control = toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        #if os(macOS)
        control.click()
        #else
        control.tap()
        #endif
        let value = (toggle.value as? String) ?? (toggle.value as? NSNumber).map { String($0.intValue) }
        XCTAssertEqual(value, expected)
    }

    private func selectSegment(_ id: String, second: Bool) {
        let control = element(id)
        XCTAssertTrue(control.waitForExistence(timeout: 10))
        let point = control.coordinate(withNormalizedOffset: CGVector(dx: second ? 0.75 : 0.25, dy: 0.5))
        #if os(macOS)
        point.click()
        #else
        point.tap()
        #endif
    }

    private func assertInspectorToolbarAvailable() {
        XCTAssertFalse(element("session-content-picker").exists)
        for identifier in ["inspector-files", "inspector-changes"] {
            let control = element(identifier)
            XCTAssertTrue(control.waitForExistence(timeout: 10))
            XCTAssertTrue(control.isHittable)
            XCTAssertEqual(app.descendants(matching: .any).matching(identifier: identifier).count, 1)
        }
    }

    func testWorkbenchListsSessionsWithoutPromotionalCard() {
        launch()
        defer { app.terminate() }
        assertSessionSearchAvailable()
        XCTAssertEqual(app.navigationBars.buttons.matching(identifier: "library-settings").count, 0)
        #if os(iOS)
        let attention = element("library-attention")
        XCTAssertTrue(attention.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(attention.frame.width, 44)
        XCTAssertGreaterThanOrEqual(attention.frame.height, 44)
        #endif
        openSettings()
        closeSettings()
        #if os(iOS)
        selectScope("scope-all")
        #endif
        assertSessionSearchAvailable()
        for phrase in ["最近的回答，有了新的维度", "把进展，看得更清楚。", "看看这轮回复"] {
            let promotion = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", phrase)).firstMatch
            XCTAssertFalse(promotion.exists, "The native workbench must not include the prototype's promotional card.")
        }
        XCTAssertTrue(element("session-visual").isHittable)
        let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        image.name = "native-workbench-without-promotion"
        image.lifetime = .keepAlways
        add(image)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "native-library-navigation"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        #if os(iOS)
        XCTAssertFalse(app.buttons["ToggleSideBar"].exists, "Do not add a second app-level adaptive Tab sidebar.")
        XCTAssertEqual(app.tabBars.count, 0)
        openSession("visual")
        #else
        element("session-visual").coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).click()
        #endif
        XCTAssertTrue(element("composer-draft").waitForExistence(timeout: 10))
    }

    func testLibraryScopesAndMetadataActions() {
        launch()
        defer { app.terminate() }
        selectScope("scope-pinned")
        XCTAssertFalse(element("session-visual").exists)
        selectScope("scope-all")
        openSessionMenu("visual")
        sessionMenuAction("pin-session-visual", title: "置顶")
        selectScope("scope-pinned")
        XCTAssertTrue(element("session-visual").exists)
        XCTAssertFalse(element("session-working").exists)

        selectScope("scope-all")
        openSessionMenu("visual")
        sessionMenuAction("archive-session-visual", title: "归档")
        selectScope("scope-archived")
        XCTAssertTrue(element("session-visual").exists)
        openSessionMenu("visual")
        sessionMenuAction("archive-session-visual", title: "恢复到会话库")
        XCTAssertFalse(element("session-visual").exists)
        selectScope("scope-pinned")
        XCTAssertTrue(element("session-visual").exists)
        openSessionMenu("visual")
        sessionMenuAction("pin-session-visual", title: "取消置顶")
        XCTAssertFalse(element("session-visual").exists)
        selectScope("scope-all")
        openSession("visual")
        XCTAssertTrue(element("composer-draft").waitForExistence(timeout: 10))
    }

    func testLibraryProjectAndHostFilters() {
        launch()
        defer { app.terminate() }
        selectScope("scope-all")
        refineLibrary("项目", value: "DevPocket · 示例项目")
        XCTAssertTrue(element("session-visual").exists)
        XCTAssertTrue(element("session-decisions").exists)
        XCTAssertFalse(element("session-working").exists)
        selectScope("scope-all")
        refineLibrary("电脑", value: "Build Mac · 虚构主机")
        XCTAssertTrue(element("session-decisions").exists)
        XCTAssertTrue(element("session-offline").exists)
        XCTAssertFalse(element("session-visual").exists)
    }

    func testAddComputerEntryIsOfflineAndPreservesDraft() async throws {
        launch()
        defer { app.terminate() }
        #if os(macOS)
        try await setWindowLayout(wide: false)
        #endif
        openSession("visual")
        let draft = element("composer-draft")
        activate(draft)
        enter("PAIRING_ENTRY_DRAFT", into: draft)
        let expected = try XCTUnwrap(draft.value as? String)
        showLibrary()
        activate(element("library-actions"))
        #if os(macOS)
        activate(app.menuItems["添加电脑"])
        #else
        activate(element("add-computer"))
        #endif
        let page = element("computer-pairing")
        XCTAssertTrue(page.waitForExistence(timeout: 10))
        XCTAssertTrue(text("真实配对尚未接入").exists)
        XCTAssertEqual(page.textFields.count, 0)
        XCTAssertEqual(page.secureTextFields.count, 0)
        XCTAssertEqual(app.windows.buttons.matching(identifier: "pairing-close").count, 1)
        let image = XCTAttachment(screenshot: page.screenshot())
        image.name = "native-offline-pairing-entry"
        image.lifetime = .keepAlways
        add(image)
        activate(element("pairing-close"))
        XCTAssertTrue(page.waitForNonExistence(timeout: 10))
        selectScope("scope-all")
        openSession("visual")
        XCTAssertEqual(element("composer-draft").value as? String, expected)
    }

    func testSessionViewsAdaptWithoutLosingDraft() async throws {
        #if os(iOS)
        let orientation = XCUIDevice.shared.orientation
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
        #endif
        launch()
        #if os(iOS)
        defer { XCUIDevice.shared.orientation = orientation; app.terminate() }
        #else
        defer { app.terminate() }
        try await setWindowLayout(wide: true)
        #endif
        openSession("visual")
        let draft = element("composer-draft")
        activate(draft)
        enter("SECTION_VIEW_DRAFT", into: draft)
        let expected = try XCTUnwrap(draft.value as? String)
        if element("dismiss-keyboard").exists { activate(element("dismiss-keyboard")) }
        assertInspectorToolbarAvailable()
        #if os(macOS)
        assertMacHeaderInsideConversation(title: "回顾最近两周的进展")
        #endif
        let wide = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        wide.name = "native-session-view-toolbar"
        wide.lifetime = .keepAlways
        add(wide)
        activate(element("inspector-files"))
        XCTAssertTrue(element("session-files-content").waitForExistence(timeout: 10))
        let sections = element("inspector-sections")
        activate(sections.exists ? sections.buttons["更改"] : element("inspector-changes"))
        XCTAssertTrue(element("session-changes-content").waitForExistence(timeout: 10))
        #if os(macOS)
        try await setWindowLayout(wide: false)
        #else
        if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .portrait }
        #endif
        if !element("session-changes-content").waitForExistence(timeout: 3) {
            // Native adaptation may dismiss the inspector; it must remain consistent and reopenable.
            assertInspectorToolbarAvailable()
            XCTAssertEqual(element("composer-draft").value as? String, expected)
            let changes = element("inspector-changes")
            let value = changes.value
            XCTAssertFalse(changes.isSelected || (value as? NSNumber)?.intValue == 1 || (value as? String) == "1")
            activate(changes)
        }
        XCTAssertTrue(element("session-changes-content").waitForExistence(timeout: 10))
        activate(element("inspector-close").exists ? element("inspector-close") : element("inspector-changes"))
        XCTAssertTrue(element("session-changes-content").waitForNonExistence(timeout: 10))
        assertInspectorToolbarAvailable()
        XCTAssertEqual(element("composer-draft").value as? String, expected)
        #if os(macOS)
        try await setWindowLayout(wide: true)
        assertInspectorToolbarAvailable()
        assertMacHeaderInsideConversation(title: "回顾最近两周的进展")
        #endif
    }

    func testLibraryCombinesFacetsAndKeepsSearchAfterReader() throws {
        launch()
        defer { app.terminate() }
        selectScope("scope-all")
        refineLibrary("项目", value: "DevPocket · 示例项目")
        refineLibrary("电脑", value: "Studio Mac · 虚构主机")
        XCTAssertTrue(element("session-visual").exists)
        XCTAssertFalse(element("session-decisions").exists)
        let search = sessionSearchField()
        activate(search)
        enter("visual", into: search)
        openSession("visual")
        let draft = element("composer-draft")
        activate(draft)
        enter("FILTERED_DRAFT", into: draft)
        let expected = try XCTUnwrap(draft.value as? String)
        reveal(element("open-card-fixture-trend"))
        activate(element("open-card-fixture-trend"))
        activate(element("reader-close"))
        XCTAssertEqual(element("composer-draft").value as? String, expected)
        app.terminate()
        app.launchArguments.removeAll { $0 == "--fixture-reset" }
        app.launch()
        XCTAssertTrue(element("composer-draft").waitForExistence(timeout: 10))
        XCTAssertEqual(element("composer-draft").value as? String, expected)
        showLibrary()
        XCTAssertEqual((sessionSearchField().value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), "visual")
        XCTAssertTrue(element("session-visual").exists)
        XCTAssertFalse(element("session-decisions").exists)
        XCTAssertTrue(element("clear-library-filters").exists)
    }

    func testAttentionReturnsToTheOriginalEntry() async throws {
        launch()
        defer { app.terminate() }
        #if os(macOS)
        try await setWindowLayout(wide: false)
        #endif
        selectScope("scope-attention")
        activate(element("attention-decisions/decision/fixture-question"))
        XCTAssertTrue(element("decision-answer").waitForExistence(timeout: 10))
        XCTAssertTrue(element("decision-answer").isHittable)
        XCTAssertTrue(element("entry-decision-question").frame.intersects(element("conversation-timeline").frame))
        XCTAssertFalse(element("submit-answer").isEnabled, "Opening an attention item must not submit a decision.")
        let draft = element("composer-draft")
        activate(draft)
        enter("ATTENTION_DRAFT", into: draft)
        let expected = try XCTUnwrap(draft.value as? String)
        selectScope("scope-all")
        selectScope("scope-attention")
        activate(element("attention-decisions/decision/fixture-question"))
        XCTAssertEqual(element("composer-draft").value as? String, expected)
        selectScope("scope-attention")
        activate(element("attention-uncertain/component/unavailable-card"))
        XCTAssertTrue(element("entry-unavailable-card").frame.intersects(element("conversation-timeline").frame))
        XCTAssertFalse(element("reference-fixture-unavailable").exists)
    }

    func testReaderHasOneCloseAndPreservesDraftAndReference() throws {
        launch()
        defer { app.terminate() }
        openSession("visual")
        let draft = element("composer-draft")
        activate(draft)
        enter("KEEP_THIS_DRAFT", into: draft)
        let expectedDraft = draft.value as? String
        XCTAssertEqual(expectedDraft?.trimmingCharacters(in: .whitespacesAndNewlines), "KEEP_THIS_DRAFT")
        XCTAssertTrue(element("composer-primary").isEnabled, "Nonblank native input must immediately enable Send.")
        finishEditing()
        let open = element("open-card-fixture-trend")
        reveal(open)
        let anchor = try readingAnchor()
        activate(open)
        XCTAssertTrue(element("reader-close").waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "reader-close").count, 1)
        XCTAssertFalse(app.buttons["取消"].exists)
        activate(element("reader-close"))
        XCTAssertEqual(draft.value as? String, expectedDraft)
        XCTAssertTrue(element(anchor).frame.intersects(conversationViewport()),
                      "Closing the reader must restore the original visible timeline entry.")
        reveal(open)
        activate(open)
        let reference = element("reader-reference")
        XCTAssertTrue(reference.waitForExistence(timeout: 10))
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: reference)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 15), .completed)
        activate(reference)
        XCTAssertTrue(element("composer-reference").waitForExistence(timeout: 5))
        XCTAssertEqual(draft.value as? String, expectedDraft)
        activate(element("remove-reference"))
        XCTAssertFalse(element("composer-reference").exists)
        XCTAssertEqual(draft.value as? String, expectedDraft)
        let screenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        screenshot.name = "native-reader-return-preserved-draft"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testBusyComposerChoosesSendAndStopRequiresConfirmation() throws {
        launch()
        defer { app.terminate() }
        openSession("working")
        let primary = element("composer-primary")
        XCTAssertTrue(primary.label.contains("Stop"))
        let draft = element("composer-draft")
        activate(draft)
        enter("LOCAL_ONLY", into: draft)
        XCTAssertTrue(primary.label.contains("Send"))
        clear(draft)
        XCTAssertTrue(primary.label.contains("Stop"))
        activate(primary)
        let confirmation = app.windows.buttons.matching(identifier: "请求停止").firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        let runtime = element("conversation-runtime")
        XCTAssertFalse(runtime.label.contains("模拟空闲") || (runtime.value as? String)?.contains("模拟空闲") == true)
        activate(confirmation)
        let idle = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@ OR value == %@", "模拟空闲", "模拟空闲"), object: runtime)
        XCTAssertEqual(XCTWaiter.wait(for: [idle], timeout: 10), .completed)
        XCTAssertTrue(primary.label.contains("Send"))
        XCTAssertFalse(primary.isEnabled)
    }

    #if os(iOS)
    func testSidebarKeepsInspectorToolbarReachable() throws {
        launch()
        defer { app.terminate() }
        openSession("visual")
        let files = element("inspector-files")
        let changes = element("inspector-changes")
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        XCTAssertTrue(changes.isHittable)

        func sidebarButton(_ label: String) -> XCUIElement? {
            app.buttons.matching(NSPredicate(format: "label == %@", label))
                .allElementsBoundByIndex.first(where: \.isHittable)
        }
        if sidebarButton("隐藏边栏") == nil && sidebarButton("显示边栏") == nil {
            activate(navigationBack)
            XCTAssertTrue(element("session-visual").waitForExistence(timeout: 10))
            openSession("visual")
            XCTAssertTrue(files.isHittable)
            XCTAssertTrue(changes.isHittable)
            return
        }
        if let show = sidebarButton("显示边栏") { activate(show) }
        XCTAssertNotNil(sidebarButton("隐藏边栏"))

        func rect(_ frame: CGRect) -> [Double] {
            [Double(frame.minX), Double(frame.minY), Double(frame.width), Double(frame.height)]
        }
        var states: [[String: Any]] = []
        var transitions: [[String: String]] = []
        func record(_ name: String) {
            states.append([
                "name": name,
                "time": Date().timeIntervalSince1970,
                "window": rect(app.windows.firstMatch.frame),
                "files": rect(files.frame),
                "changes": rect(changes.frame),
                "inspectorSelected": files.isSelected,
            ])
            for id in ["inspector-files", "inspector-changes"] {
                XCTAssertEqual(app.descendants(matching: .any).matching(identifier: id).count, 1)
                XCTAssertTrue(element(id).isHittable)
            }
        }
        func cycle(_ mode: String) throws {
            record("\(mode)-visible")
            Thread.sleep(forTimeInterval: 0.5)
            activate(try XCTUnwrap(sidebarButton("隐藏边栏")))
            XCTAssertNotNil(sidebarButton("显示边栏"))
            record("\(mode)-hidden")
            transitions.append(["name": "\(mode)-hide", "from": "\(mode)-visible", "to": "\(mode)-hidden"])
            Thread.sleep(forTimeInterval: 0.5)
            activate(try XCTUnwrap(sidebarButton("显示边栏")))
            XCTAssertNotNil(sidebarButton("隐藏边栏"))
            record("\(mode)-visible-again")
            transitions.append(["name": "\(mode)-show", "from": "\(mode)-hidden", "to": "\(mode)-visible-again"])
            Thread.sleep(forTimeInterval: 0.5)
        }

        try cycle("inspector-closed")
        activate(files)
        XCTAssertTrue(element("session-files-content").waitForExistence(timeout: 10))
        let sheet = element("inspector-sections").exists
        if sheet {
            activate(element("inspector-close"))
        } else {
            try cycle("inspector-open")
            // Native adaptation may dismiss the inspector when the sidebar reclaims its column.
            if !files.isSelected {
                XCTAssertTrue(element("session-files-content").waitForNonExistence(timeout: 10))
                activate(files)
                XCTAssertTrue(element("session-files-content").waitForExistence(timeout: 10))
                XCTAssertTrue(files.isSelected)
            }
            activate(files)
        }
        XCTAssertTrue(element("session-files-content").waitForNonExistence(timeout: 10))

        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "kind": "sidebar-toolbar",
            "inspectorPresentation": sheet ? "sheet" : "column",
            "states": states,
            "transitions": transitions,
        ], options: [.sortedKeys, .prettyPrinted]), uniformTypeIdentifier: "public.json")
        attachment.name = "sidebar-toolbar-trace"
        attachment.lifetime = .keepAlways
        add(attachment)

        // Check settled placement; transient sidebar-animation flicker is a retained known issue.
        for id in ["files", "changes"] {
            let initial = try XCTUnwrap(states.first?[id] as? [Double])
            for state in states {
                let current = try XCTUnwrap(state[id] as? [Double])
                for (value, original) in zip(current, initial) {
                    XCTAssertEqual(value, original, accuracy: 1)
                }
            }
        }
    }

    func testInspectorKeepsNativeLeadingTitle() throws {
        launch()
        defer { app.terminate() }
        openSession("visual")
        if let hideSidebar = app.buttons.matching(NSPredicate(format: "label == %@", "隐藏边栏"))
            .allElementsBoundByIndex.first(where: \.isHittable) {
            activate(hideSidebar)
        }

        let bar = app.navigationBars["回顾最近两周的进展"]
        let title = bar.staticTexts["回顾最近两周的进展"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertFalse(element("conversation-toolbar-title").exists)
        let files = element("inspector-files")
        let changes = element("inspector-changes")
        let initialTitle = title.frame
        let initialInset = initialTitle.minX - element("conversation-pane").frame.minX
        let initialFiles = files.frame
        let initialChanges = changes.frame
        func checkTitle() {
            let pane = element("conversation-pane").frame
            XCTAssertTrue(title.exists)
            XCTAssertGreaterThanOrEqual(title.frame.minX, pane.minX)
            XCTAssertLessThan(title.frame.minX, pane.midX)
            XCTAssertEqual(title.frame.minX - pane.minX, initialInset, accuracy: 2)
            XCTAssertEqual(title.frame.minY, initialTitle.minY, accuracy: 1)
            XCTAssertEqual(title.frame.height, initialTitle.height, accuracy: 1)
        }
        checkTitle()
        activate(files)
        XCTAssertTrue(element("session-files-content").waitForExistence(timeout: 10))
        let sheet = element("inspector-sections").exists
        if !sheet { checkTitle() }
        activate(sheet ? element("inspector-close") : files)
        XCTAssertTrue(element("session-files-content").waitForNonExistence(timeout: 10))
        checkTitle()
        XCTAssertEqual(files.frame.midX, initialFiles.midX, accuracy: 1)
        XCTAssertEqual(files.frame.midY, initialFiles.midY, accuracy: 1)
        XCTAssertEqual(changes.frame.midX, initialChanges.midX, accuracy: 1)
        XCTAssertEqual(changes.frame.midY, initialChanges.midY, accuracy: 1)
        XCTAssertTrue(files.isHittable)
        XCTAssertTrue(changes.isHittable)
        XCTAssertFalse(element("inspector-sections").exists)
    }
    #endif

    func testFileAndChangeToolsRemainReachable() throws {
        launch()
        defer { app.terminate() }
        openSession("visual")
        #if os(iOS)
        // The native sidebar overlay intercepts the first tap outside it.
        if let hideSidebar = app.buttons.matching(NSPredicate(format: "label == %@", "隐藏边栏"))
            .allElementsBoundByIndex.first(where: \.isHittable) {
            activate(hideSidebar)
        }
        #endif

        let draft = element("composer-draft")
        activate(draft)
        enter("INSPECTOR_DRAFT", into: draft)
        let expectedDraft = try XCTUnwrap(draft.value as? String)
        XCTAssertTrue(expectedDraft.contains("INSPECTOR_DRAFT"))
        if element("dismiss-keyboard").exists { activate(element("dismiss-keyboard")) }

        func checkTools(selected: String? = nil) {
            for identifier in ["inspector-files", "inspector-changes"] {
                let control = element(identifier)
                XCTAssertTrue(control.waitForExistence(timeout: 10))
                XCTAssertTrue(control.isHittable)
                XCTAssertEqual(app.descendants(matching: .any).matching(identifier: identifier).count, 1)
                let value = control.value
                let isOn = control.isSelected || (value as? NSNumber)?.intValue == 1 || (value as? String) == "1"
                XCTAssertEqual(isOn, identifier == selected,
                    "Native toggle state for \(identifier): \(String(reflecting: value))")
            }
        }

        checkTools()
        XCTAssertFalse(element("inspector-toggle").exists)
        let identifiers = ["inspector-files", "inspector-changes"]
        func toolbarAnchors() -> [CGPoint] {
            let window = app.windows.firstMatch.frame
            return identifiers.map { identifier in
                let frame = element(identifier).frame
                return CGPoint(x: window.maxX - frame.midX, y: frame.midY - window.minY)
            }
        }
        let closedAnchors = toolbarAnchors()
        func checkStableToolbar() {
            for (closed, current) in zip(closedAnchors, toolbarAnchors()) {
                XCTAssertEqual(current.x, closed.x, accuracy: 1)
                XCTAssertEqual(current.y, closed.y, accuracy: 1)
            }
        }

        activate(element("inspector-files"))
        let filesVisible = element("session-files-content").waitForExistence(timeout: 10)
        if !filesVisible {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "inspector-presentation-hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "inspector-presentation"
            screenshot.lifetime = .keepAlways
            add(screenshot)
        }
        XCTAssertTrue(filesVisible)
        let sections = element("inspector-sections")
        if sections.exists {
            XCTAssertTrue(sections.buttons["文件"].isSelected)
            XCTAssertTrue(element("inspector-close").isHittable)
            activate(sections.buttons["更改"])
            XCTAssertTrue(element("session-changes-content").waitForExistence(timeout: 10))
            XCTAssertTrue(sections.buttons["更改"].isSelected)
            activate(sections.buttons["更改"])
            XCTAssertTrue(element("session-changes-content").exists)
            activate(element("inspector-close"))
            XCTAssertTrue(sections.waitForNonExistence(timeout: 10))
            XCTAssertTrue(element("session-changes-content").waitForNonExistence(timeout: 10))
            checkTools()

            activate(element("inspector-changes"))
            XCTAssertTrue(sections.waitForExistence(timeout: 10))
            XCTAssertTrue(element("session-changes-content").waitForExistence(timeout: 10))
            XCTAssertTrue(sections.buttons["更改"].isSelected)
            let grabber = app.buttons["表单控制柄"]
            XCTAssertTrue(grabber.exists)
            XCTAssertTrue(grabber.isHittable)
            let start = grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
            start.press(forDuration: 0.05, thenDragTo: end)
        } else {
            XCTAssertFalse(element("inspector-close").exists)
            checkTools(selected: "inspector-files")
            checkStableToolbar()
            activate(element("inspector-changes"))
            XCTAssertTrue(element("session-changes-content").waitForExistence(timeout: 10))
            checkTools(selected: "inspector-changes")
            checkStableToolbar()
            activate(element("inspector-changes"))
        }
        XCTAssertTrue(sections.waitForNonExistence(timeout: 10))
        XCTAssertTrue(element("session-files-content").waitForNonExistence(timeout: 10))
        XCTAssertTrue(element("session-changes-content").waitForNonExistence(timeout: 10))
        checkTools()
        checkStableToolbar()
        XCTAssertTrue(element("conversation-timeline").exists)
        if !draft.isHittable {
            let hierarchy = XCTAttachment(string:
                "Application state: \(app.state)\nDraft frame: \(draft.frame)\n\(app.debugDescription)")
            hierarchy.name = "inspector-composer-reachability"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
            #if os(macOS)
            let window = app.windows["workbench"]
            if window.exists {
                let screenshot = XCTAttachment(data: window.screenshot().pngRepresentation,
                    uniformTypeIdentifier: "public.png")
                screenshot.name = "inspector-composer-window"
                screenshot.lifetime = .keepAlways
                add(screenshot)
            }
            #endif
        }
        XCTAssertEqual(draft.value as? String, expectedDraft)
        activate(draft)
        enter("AFTER_INSPECTOR", into: draft)
        let updatedDraft = try XCTUnwrap(draft.value as? String)
        XCTAssertTrue(updatedDraft.contains("INSPECTOR_DRAFT"))
        XCTAssertTrue(updatedDraft.contains("AFTER_INSPECTOR"))
    }

    func testQuestionNeedsASeparateSubmissionAndKeepsConfirmedHistory() throws {
        launch()
        defer { app.terminate() }
        openSession("decisions")
        let answer = element("decision-answer")
        reveal(answer)
        activate(answer)
        enter("4242", into: answer)
        let expectedAnswer = try XCTUnwrap(answer.value as? String)
        XCTAssertEqual(expectedAnswer.trimmingCharacters(in: .whitespacesAndNewlines), "4242")
        XCTAssertTrue(element("submit-answer").isEnabled)
        finishEditing()
        reveal(element("submit-answer"))
        activate(element("submit-answer"))
        XCTAssertTrue(text("模拟已确认：\(expectedAnswer)").waitForExistence(timeout: 10))
        XCTAssertFalse(element("decision-answer").exists)
    }

    func testDraftSurvivesRelaunchWithoutSubmission() throws {
        launch()
        defer { app.terminate() }
        openSession("visual")
        let draft = element("composer-draft")
        activate(draft)
        enter("PERSIST_LOCAL_DRAFT", into: draft)
        let expectedDraft = draft.value as? String
        XCTAssertEqual(expectedDraft?.trimmingCharacters(in: .whitespacesAndNewlines), "PERSIST_LOCAL_DRAFT")
        app.terminate()
        app.launchArguments.removeAll { $0 == "--fixture-reset" }
        app.launch()
        XCTAssertTrue(element("composer-draft").waitForExistence(timeout: 10))
        XCTAssertEqual(element("composer-draft").value as? String, expectedDraft)
    }

    func testOfflineDraftDoesNotSendWhenReturningOnline() throws {
        launch()
        defer { app.terminate() }
        openSession("offline")
        openSettings()
        toggleOffline(expected: "1")
        closeSettings()
        #if os(iOS)
        selectScope("scope-all")
        openSession("offline")
        #endif
        XCTAssertTrue(element("composer-draft").waitForExistence(timeout: 10))
        XCTAssertFalse(element("composer-primary").isEnabled)
        let draft = element("composer-draft")
        let original = try XCTUnwrap(draft.value as? String)
        activate(draft)
        enter("112233", into: draft)
        let expected = try XCTUnwrap(draft.value as? String)
        XCTAssertTrue(expected.contains("112233"), "Actual committed fixture draft: \(expected)")
        XCTAssertEqual(expected.replacingOccurrences(of: "112233", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines), original.trimmingCharacters(in: .whitespacesAndNewlines))
        openSettings()
        toggleOffline(expected: "0")
        closeSettings()
        #if os(iOS)
        selectScope("scope-all")
        openSession("offline")
        #endif
        XCTAssertEqual(element("composer-draft").value as? String, expected)
        XCTAssertTrue(element("composer-primary").isEnabled)
        XCTAssertFalse(text(expected).exists)
    }

    #if os(macOS)
    private func assertMacHeaderInsideConversation(title: String) {
        let pane = element("conversation-pane")
        let header = element("conversation-header")
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(header.frame.minX, pane.frame.minX - 2)
        XCTAssertLessThanOrEqual(header.frame.maxX, pane.frame.maxX + 2)
        let list = element("session-list")
        if list.exists && list.isHittable {
            XCTAssertGreaterThanOrEqual(header.frame.minX, list.frame.maxX - 2)
        }
        let nativeTitle = app.windows.matching(identifier: "workbench").firstMatch.children(matching: .staticText)
            .matching(NSPredicate(format: "label == %@ OR value == %@", title, title)).firstMatch
        let titleVisible = nativeTitle.waitForExistence(timeout: 10)
        if !titleVisible {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "native-mac-title-hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        XCTAssertTrue(titleVisible, "The session title must remain in the native window titlebar.")
        XCTAssertLessThanOrEqual(nativeTitle.frame.maxY, header.frame.minY + 2)
        XCTAssertFalse(element("conversation-title").exists)
        for identifier in ["inspector-files", "inspector-changes"] {
            XCTAssertEqual(app.toolbars.descendants(matching: .any).matching(identifier: identifier).count, 1)
        }
    }

    func testConversationHeaderDoesNotSpanTheSessionList() async throws {
        launch()
        defer { app.terminate() }
        try await setWindowLayout(wide: true)
        openSession("visual")
        let before = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        before.name = "native-mac-pane-header-boundary"
        before.lifetime = .keepAlways
        add(before)
        assertMacHeaderInsideConversation(title: "回顾最近两周的进展")
        openSession("working")
        assertMacHeaderInsideConversation(title: "生成中与停止请求")
        try await setWindowLayout(wide: false)
        assertMacHeaderInsideConversation(title: "生成中与停止请求")
        try await setWindowLayout(wide: true)
        assertMacHeaderInsideConversation(title: "生成中与停止请求")
    }

    func testSettingsUseOnlyTheNativeMenu() {
        launch()
        defer { app.terminate() }
        XCTAssertFalse(element("library-settings").exists)
        openSettings()
        closeSettings()
        openSession("visual")
        XCTAssertFalse(element("library-settings").exists)
        openSettings()
        closeSettings()
        XCTAssertFalse(element("library-settings").exists)
    }

    func testSearchAndFiltersBelongToTheSessionList() async throws {
        launch()
        defer { app.terminate() }
        try await setWindowLayout(wide: true)
        let search = element("session-search")
        let filters = element("library-filters")
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        XCTAssertTrue(filters.exists)
        let list = element("session-list").frame
        let controls = XCTAttachment(string: "List: \(list)\nSearch: \(search.frame)\nFilters: \(filters.frame)")
        controls.name = "native-library-control-bounds"
        controls.lifetime = .keepAlways
        add(controls)
        for control in [search, filters] {
            XCTAssertGreaterThanOrEqual(control.frame.minX, list.minX - 2)
            XCTAssertLessThanOrEqual(control.frame.maxX, list.maxX + 2)
            XCTAssertLessThanOrEqual(control.frame.maxY, list.minY + 2)
        }
        activate(search)
        enter("offline", into: search)
        XCTAssertTrue(element("session-offline").exists)
        XCTAssertFalse(element("session-visual").exists)
    }

    private func focusWorkbenchWindow() -> XCUIElement {
        app.activate()
        let window = app.windows.matching(identifier: "workbench").firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        // App activation alone can leave the window's first edge drag ignored.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
            .withOffset(CGVector(dx: 0, dy: 8)).click()
        return window
    }

    private func setWindowLayout(wide: Bool) async throws {
        let window = focusWorkbenchWindow()
        let original = window.frame
        let display = CGDisplayBounds(CGMainDisplayID())
        let targetWidth: CGFloat = wide ? 1000 : 600
        if abs(window.frame.width - targetWidth) > 2 {
            if window.frame.maxX + 1 >= display.maxX || window.frame.minX + targetWidth + 1 >= display.maxX {
                // Native tiling exposes an on-screen resize border without moving a filled window offscreen.
                activate(app.menuBars.menuBarItems["窗口"])
                activate(app.menuItems["移动与调整大小"])
                activate(app.menuItems["左侧"])
            }
            XCTAssertLessThan(window.frame.maxX + 1, display.maxX)
            XCTAssertLessThan(window.frame.minX + targetWidth + 1, display.maxX)
            // Reach the native resize border instead of the content's scroll hit area.
            let edge = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5))
                .withOffset(CGVector(dx: 1, dy: 0))
            edge.click(forDuration: 0.2, thenDragTo: edge.withOffset(CGVector(dx: targetWidth - window.frame.width, dy: 0)))
        }
        for _ in 0..<50 {
            let width = app.windows.firstMatch.frame.width
            if wide ? width >= 820 : width < 660 { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let width = app.windows.firstMatch.frame.width
        let dimensions = XCTAttachment(string: "Requested width: \(targetWidth)\nBefore: \(original)\nAfter: \(window.frame)\nSheets: \(app.sheets.count)\nApp state: \(app.state.rawValue)")
        dimensions.name = "native-mac-window-dimensions"
        dimensions.lifetime = .keepAlways
        add(dimensions)
        if wide { XCTAssertGreaterThanOrEqual(width, 820) }
        else { XCTAssertLessThan(width, 660) }
    }

    func testNarrowWindowWorksAtDisplayEdge() async throws {
        launch()
        defer { app.terminate() }
        let window = focusWorkbenchWindow()
        let display = CGDisplayBounds(CGMainDisplayID())
        let titlebar = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0))
            .withOffset(CGVector(dx: 0, dy: 8))
        let shift = display.maxX - window.frame.maxX
        if abs(shift) > 2 {
            titlebar.click(forDuration: 0.2, thenDragTo: titlebar.withOffset(CGVector(dx: shift, dy: 0)))
        }
        for _ in 0..<30 where abs(window.frame.maxX - display.maxX) > 2 {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(window.frame.maxX, display.maxX, accuracy: 2)
        try await setWindowLayout(wide: false)
        try await setWindowLayout(wide: true)
    }

    private func assertModalReader() {
        XCTAssertTrue(app.sheets.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(element("component-reader").exists)
        XCTAssertTrue(element("reader-close").isHittable)
        XCTAssertEqual(app.buttons.matching(identifier: "reader-close").count, 1)
        XCTAssertFalse(element("composer-draft").isHittable)
    }

    func testKeyboardSearchWorksInNarrowWindow() async throws {
        launch()
        defer { app.terminate() }
        try await setWindowLayout(wide: false)
        for _ in 0..<3 {
            openSession("visual")
            app.typeKey("k", modifierFlags: .command)
            let search = element("session-search")
            XCTAssertTrue(search.waitForExistence(timeout: 10))
            // typeText requires keyboard focus; clicking here would hide a failed shortcut.
            enter("offline", into: search)
            let query = (search.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if query != "offline" {
                let hierarchy = XCTAttachment(string: app.debugDescription)
                hierarchy.name = "keyboard-search-focus"
                hierarchy.lifetime = .keepAlways
                add(hierarchy)
            }
            XCTAssertEqual(query, "offline")
            XCTAssertTrue(element("session-offline").exists)
            XCTAssertFalse(element("session-visual").exists)
            clear(search)
            XCTAssertTrue(element("session-visual").waitForExistence(timeout: 10))
        }
        try await setWindowLayout(wide: true)
    }

    func testInspectorKeepsNarrowMacToolbar() async throws {
        launch()
        defer { app.terminate() }
        try await setWindowLayout(wide: false)
        openSession("visual")
        let files = element("inspector-files")
        let changes = element("inspector-changes")
        let before = files.frame
        activate(files)
        XCTAssertTrue(element("session-files-content").waitForExistence(timeout: 10))
        XCTAssertFalse(element("inspector-sections").exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "inspector-files").count, 1)
        XCTAssertEqual(files.frame.midX, before.midX, accuracy: 1)
        XCTAssertEqual(files.frame.midY, before.midY, accuracy: 1)
        activate(changes)
        XCTAssertTrue(element("session-changes-content").waitForExistence(timeout: 10))
        activate(changes)
        XCTAssertTrue(element("session-changes-content").waitForNonExistence(timeout: 10))
        XCTAssertTrue(element("conversation-timeline").exists)
        XCTAssertTrue(element("library-back").isHittable)
        XCTAssertTrue(files.isHittable)
        try await setWindowLayout(wide: true)
    }

    func testReaderResizingPreservesTableViewAndDraft() async throws {
        launch()
        defer { app.terminate() }
        try await setWindowLayout(wide: true)
        openSession("visual")
        let draft = element("composer-draft")
        activate(draft)
        enter("RESIZE_DRAFT", into: draft)
        let expected = draft.value as? String
        let open = element("open-card-fixture-modules")
        reveal(open)
        activate(open)
        let reader = element("component-reader")
        let filter = reader.searchFields.firstMatch
        activate(filter)
        // HTML filtering reacts to input and needs no native IME commit sequence.
        filter.typeText("20")
        XCTAssertEqual(filter.value as? String, "20")
        assertModalReader()
        try await setWindowLayout(wide: false)
        assertModalReader()
        XCTAssertEqual(reader.searchFields.firstMatch.value as? String, "20")
        XCTAssertEqual(app.buttons.matching(identifier: "reader-close").count, 1)
        XCTAssertTrue(element("reader-title").exists)
        let narrow = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        narrow.name = "native-narrow-reader"
        narrow.lifetime = .keepAlways
        add(narrow)
        try await setWindowLayout(wide: true)
        XCTAssertEqual(reader.searchFields.firstMatch.value as? String, "20")
        assertModalReader()
        activate(element("reader-close"))
        XCTAssertEqual(element("composer-draft").value as? String, expected)
    }
    #else
    func testSettingsOnlyAppearInTheLibrary() throws {
        launch()
        defer { app.terminate() }
        openSettings()
        closeSettings()
        selectScope("scope-all")
        XCTAssertEqual(app.navigationBars.buttons.matching(identifier: "library-settings").count, 0)
        openSession("visual")
        XCTAssertEqual(app.navigationBars.buttons.matching(identifier: "library-settings").count, 0)
        reveal(element("open-card-fixture-trend"))
        activate(element("open-card-fixture-trend"))
        XCTAssertEqual(app.buttons.matching(identifier: "reader-close").count, 1)
        XCTAssertFalse(element("component-reader").buttons["library-settings"].exists)
    }

    private func blueCoverage(_ screenshot: XCUIScreenshot) throws -> Double {
        let image = try XCTUnwrap(screenshot.image.cgImage)
        let width = 96
        let height = max(1, Int(Double(image.height) / Double(image.width) * Double(width)))
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        try pixels.withUnsafeMutableBytes { bytes in
            let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var blue = 0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let red = Int(pixels[index]), green = Int(pixels[index + 1]), value = Int(pixels[index + 2])
            if value > red + 40 && green > red + 20 && value > 100 { blue += 1 }
        }
        return Double(blue) / Double(width * height)
    }

    func testSessionSelectionDoesNotTintLibraryControls() throws {
        launch()
        defer { app.terminate() }
        selectScope("scope-all")
        refineLibrary("项目", value: "Workbench Kit · 示例项目")
        showLibrary()
        let controls = element("library-scope")
        let before = controls.screenshot()
        XCTAssertTrue(element("session-list").waitForExistence(timeout: 10))
        openSession("working")
        showLibrary()
        let after = controls.screenshot()
        for (name, image) in [("before-selection", before), ("after-selection", after)] {
            let attachment = XCTAttachment(screenshot: image)
            attachment.name = "native-sidebar-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        let baseline = try blueCoverage(before)
        let selected = try blueCoverage(after)
        let measurement = XCTAttachment(string: "Before: \(baseline)\nAfter: \(selected)")
        measurement.name = "native-sidebar-blue-coverage"
        measurement.lifetime = .keepAlways
        add(measurement)
        XCTAssertLessThanOrEqual(selected, baseline + 0.02,
            "The native selected-row highlight must not spread into the library's scope controls.")
    }

    func testRotationPreservesReaderAndDraft() async throws {
        launch()
        defer { XCUIDevice.shared.orientation = .portrait; app.terminate() }
        openSession("visual")
        let draft = element("composer-draft")
        activate(draft)
        enter("ROTATION_DRAFT", into: draft)
        let expected = draft.value as? String
        let open = element("open-card-fixture-trend")
        reveal(open)
        activate(open)
        if UIDevice.current.userInterfaceIdiom == .pad {
            let window = app.windows.firstMatch
            let original = window.frame
            XCTAssertFalse(element("composer-draft").isHittable)
            let corner = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1))
                .withOffset(CGVector(dx: -12, dy: -12))
            corner.press(forDuration: 0.1,
                thenDragTo: corner.withOffset(CGVector(dx: 600 - original.width, dy: 850 - original.height)),
                withVelocity: .slow, thenHoldForDuration: 0.2)
            for _ in 0..<50 where window.frame.width >= 820 {
                try await Task.sleep(for: .milliseconds(100))
            }
            let narrow = window.frame
            let dimensions = XCTAttachment(string: "Original window: \(original)\nNarrow window: \(narrow)")
            dimensions.name = "native-ipad-window-dimensions"
            dimensions.lifetime = .keepAlways
            add(dimensions)
            XCTAssertLessThan(narrow.width, 820, "Resize the real iPad window, not an inner view or screenshot.")
            XCTAssertFalse(element("composer-draft").isHittable)
            let image = XCTAttachment(screenshot: window.screenshot())
            image.name = "native-ipad-narrow-reader"
            image.lifetime = .keepAlways
            add(image)
            let resizedCorner = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1))
                .withOffset(CGVector(dx: -12, dy: -12))
            resizedCorner.press(forDuration: 0.1,
                thenDragTo: resizedCorner.withOffset(CGVector(dx: original.width - narrow.width, dy: original.height - narrow.height)),
                withVelocity: .slow, thenHoldForDuration: 0.2)
            for _ in 0..<50 where window.frame.width < 820 {
                try await Task.sleep(for: .milliseconds(100))
            }
            XCTAssertGreaterThanOrEqual(window.frame.width, 820)
            XCTAssertFalse(element("composer-draft").isHittable)
        } else {
            XCUIDevice.shared.orientation = .landscapeLeft
            XCTAssertTrue(element("reader-close").waitForExistence(timeout: 10))
            XCUIDevice.shared.orientation = .portrait
            XCTAssertTrue(element("reader-close").waitForExistence(timeout: 10))
        }
        XCTAssertEqual(app.buttons.matching(identifier: "reader-close").count, 1)
        activate(element("reader-close"))
        XCTAssertEqual(element("composer-draft").value as? String, expected)
    }

    func testStandardDynamicTypeCategoriesUseNativeFontMetrics() throws {
        try assertNativeFontMetrics([
            .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge
        ])
    }

    func testAccessibilityDynamicTypeCategoriesUseNativeFontMetrics() throws {
        try assertNativeFontMetrics([
            .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
            .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge
        ])
    }

    private func assertNativeFontMetrics(_ categories: [UIContentSizeCategory]) throws {
        defer { if app?.state != .notRunning { app?.terminate() } }
        var measurements: [String] = []
        for category in categories {
            launch(contentSize: category.rawValue)
            openSession("visual")
            let timestamp = element("time-fixture-request-visual")
            XCTAssertTrue(timestamp.waitForExistence(timeout: 10))
            let font = UIFont.preferredFont(forTextStyle: .subheadline,
                                           compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
            XCTAssertEqual(timestamp.frame.height, font.lineHeight, accuracy: 2, "Native font metrics: \(category.rawValue)")
            let roleHeight = element("role-fixture-request-visual").frame.height
            let lines = max(1, (roleHeight / font.lineHeight).rounded())
            XCTAssertEqual(roleHeight, lines * font.lineHeight, accuracy: 3,
                           "Native role font metrics: \(category.rawValue)")
            measurements.append("\(category.rawValue): nativeLineHeight=\(font.lineHeight), timestamp=\(timestamp.frame.height), role=\(roleHeight), lines=\(lines)")
            XCTAssertGreaterThanOrEqual(element("composer-primary").frame.height, 44)
            XCTAssertTrue(element("composer-draft").isHittable)
            app.terminate()
        }
        let evidence = XCTAttachment(string: measurements.joined(separator: "\n"))
        evidence.name = "native-dynamic-type-metrics"
        evidence.lifetime = .keepAlways
        add(evidence)
    }
    #endif

    func testDesignReferenceScreenshots() throws {
        launch()
        defer { app.terminate() }
        openSettings()
        activate(element("appearance-picker"))
        #if os(macOS)
        activate(app.menuItems["浅色"])
        #else
        activate(app.buttons["浅色"].firstMatch)
        #endif
        closeSettings()
        #if os(iOS)
        selectScope("scope-all")
        #endif
        for name in ["workbench", "conversation", "reader"] {
            if name == "conversation" {
                openSession("visual")
                let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"),
                                                     object: element("reference-inline-fixture-trend"))
                XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
            } else if name == "reader" {
                let open = element("open-card-fixture-trend")
                reveal(open)
                activate(open)
                let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"),
                                                     object: element("reader-reference"))
                XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
                XCTAssertEqual(app.buttons.matching(identifier: "reader-close").count, 1)
            }
            let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
            image.name = "design-reference-\(name)"
            image.lifetime = .keepAlways
            add(image)
            if name == "reader" {
                selectSegment("chart-range", second: false)
                selectSegment("chart-display", second: true)
                XCTAssertTrue(text("7 / 7 行").waitForExistence(timeout: 10))
                XCTAssertTrue(text("48").exists)
                let dataView = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
                dataView.name = "design-reference-reader-seven-day-data"
                dataView.lifetime = .keepAlways
                add(dataView)
                activate(element("reader-close"))
                let open = element("open-card-fixture-trend")
                reveal(open)
                XCTAssertTrue(element("entry-visual-trend").staticTexts
                    .matching(NSPredicate(format: "label == %@ OR value == %@", "87", "87")).firstMatch.exists,
                              "Changing the reader range must not replace the original inline card.")
                activate(open)
                XCTAssertTrue(text("7 / 7 行").waitForExistence(timeout: 10))
            }
            #if os(iOS)
            if name == "reader", UIDevice.current.userInterfaceIdiom == .pad {
                let hierarchy = XCTAttachment(string: app.debugDescription)
                hierarchy.name = "native-ipad-window-controls"
                hierarchy.lifetime = .keepAlways
                add(hierarchy)
            }
            #endif
        }
    }

    func testLightAndDarkWorkbenchAndReaderAppearance() throws {
        launch()
        defer { app.terminate() }
        openSession("visual")
        for (title, name) in [("浅色", "light"), ("深色", "dark")] {
            openSettings()
            activate(element("appearance-picker"))
            #if os(macOS)
            activate(app.menuItems[title])
            #else
            activate(app.buttons[title].firstMatch)
            #endif
            let settings = XCTAttachment(screenshot: element("fixture-settings").screenshot())
            settings.name = "native-settings-\(name)"
            settings.lifetime = .keepAlways
            add(settings)
            closeSettings()
            #if os(iOS)
            selectScope("scope-all")
            openSession("visual")
            #endif
            let open = element("open-card-fixture-trend")
            reveal(open)
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"),
                                                 object: element("reference-inline-fixture-trend"))
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
            let workbench = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
            workbench.name = "native-workbench-\(name)"
            workbench.lifetime = .keepAlways
            add(workbench)
            activate(open)
            let reference = element("reader-reference")
            let rendered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: reference)
            XCTAssertEqual(XCTWaiter.wait(for: [rendered], timeout: 15), .completed)
            XCTAssertEqual(app.buttons.matching(identifier: "reader-close").count, 1)
            #if os(macOS)
            XCTAssertTrue(element("reader-title").exists)
            assertModalReader()
            #endif
            let reader = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
            reader.name = "native-reader-\(name)"
            reader.lifetime = .keepAlways
            add(reader)
            activate(element("reader-close"))
        }
    }

    func testNativeLayoutAndAccessibility() throws {
        launch()
        defer { app.terminate() }
        openSession("visual")
        XCTAssertTrue(element("composer-draft").exists)
        XCTAssertTrue(element("composer-primary").exists)
        #if os(macOS)
        XCTAssertTrue(text("回顾最近两周的进展").exists
            || app.windows.firstMatch.label.contains("回顾最近两周的进展"))
        #endif
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"),
                                             object: element("reference-inline-fixture-trend"))
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
        #if os(iOS)
        // Font scaling is checked against UIKit metrics in every category above, including reflowed rows.
        for kind in [XCUIAccessibilityAuditType.hitRegion, .sufficientElementDescription] {
            try app.performAccessibilityAudit(for: kind) { issue in
                let details = XCTAttachment(string: issue.detailedDescription + "\n" + (issue.element?.debugDescription ?? "No element"))
                details.name = "native-accessibility-issue"
                details.lifetime = .keepAlways
                self.add(details)
                return false
            }
        }
        #endif
        let image = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        image.name = "native-workbench"
        image.lifetime = .keepAlways
        add(image)
    }
}
