import CryptoKit
import CoreGraphics
import Foundation
import Testing
import WebKit
#if os(macOS)
import AppKit
import SwiftUI
#else
import UIKit
#endif
@testable import DevPocket

@MainActor
struct DevPocketTests {
    @Test func fixtureStorageSeparatesOrdinaryUnitAndUITestHosts() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "fixture-storage-routing")
        let isTestHost = NSClassFromString("XCTestCase") != nil
        #expect(isTestHost)
        #expect(DevPocketApp.fixtureStoreURL(directory: directory, arguments: [], isTestHost: isTestHost) == nil)
        #expect(DevPocketApp.fixtureStoreURL(directory: directory, arguments: [], isTestHost: false)
                == directory.appending(path: "state-v1.json"))
        for host in [false, true] {
            #expect(DevPocketApp.fixtureStoreURL(directory: directory, arguments: ["--fixture-test-store"],
                                               isTestHost: host) == directory.appending(path: "ui-tests.json"))
            #expect(DevPocketApp.fixtureStoreURL(directory: directory,
                                               arguments: ["--fixture-test-store", "--fixture-in-memory"],
                                               isTestHost: host) == nil)
        }
    }

    private func model(_ session: String = "visual", url: URL? = nil) throws -> WorkbenchModel {
        let value = WorkbenchModel(persistenceURL: url, automaticallyConfirm: false)
        #expect(!value.loadBlocked, "\(value.errorMessage ?? "")")
        value.select(session)
        return value
    }

    @Test func libraryFiltersCombineProjectHostAndSearch() throws {
        let value = try model()
        let visual = try #require(value.selected)
        #expect(value.libraryProjects.count == 2)
        #expect(value.libraryHosts.count == 2)
        #expect(value.visibleSessions.count == 5)
        value.selectScope(.project(visual.project))
        #expect(Set(value.visibleSessions.map(\.id)) == ["visual", "decisions", "uncertain"])
        #expect(Set(value.visibleSessions.map(\.host)).count == 2)
        value.refineLibrary(project: nil, host: visual.host)
        #expect(value.visibleSessions.map(\.id) == ["visual"])
        value.library.searchText = "DEMO/VISUAL"
        #expect(value.visibleSessions.map(\.id) == ["visual"])
        value.library.searchText = "does not exist"
        #expect(value.visibleSessions.isEmpty)
        let secondHost = try #require(value.sessions.first { $0.id == "offline" }).host
        value.selectScope(.host(secondHost))
        #expect(value.library.searchText.isEmpty)
        #expect(!value.library.hasRefinements)
        #expect(Set(value.visibleSessions.map(\.id)) == ["decisions", "uncertain", "offline"])
        #expect(Set(value.visibleSessions.map(\.project)).count == 2)
    }

    @Test func libraryCollectionsOnlyChangeLocalMetadata() throws {
        let value = try model("working")
        value.updateSession("working") { $0.draft.text = "Keep this draft" }
        let original = try #require(value.selected)
        value.setPinned(true, sessionID: "working")
        value.selectScope(.pinned)
        #expect(value.visibleSessions.map(\.id) == ["working"])
        value.setArchived(true, sessionID: "working")
        #expect(value.visibleSessions.isEmpty)
        value.selectScope(.archived)
        let archived = try #require(value.visibleSessions.first)
        #expect(archived.id == "working")
        #expect(archived.runtime == original.runtime)
        #expect(archived.operations == original.operations)
        #expect(archived.entries == original.entries)
        #expect(archived.draft == original.draft)
        value.setArchived(false, sessionID: "working")
        #expect(value.visibleSessions.isEmpty)
        value.selectScope(.pinned)
        #expect(value.visibleSessions.map(\.id) == ["working"])
        value.setPinned(false, sessionID: "working")
        #expect(value.visibleSessions.isEmpty)
        #expect(value.count(in: .all) == 5)
    }

    @Test func libraryScopeAndDraftSurviveReaderAndStorage() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer {
            do { try FileManager.default.removeItem(at: directory) }
            catch { Issue.record(error) }
        }
        let file = directory.appending(path: "fixtures.json")
        let value = try model(url: file)
        let session = try #require(value.selected)
        value.selectScope(.project(session.project))
        value.refineLibrary(project: nil, host: session.host)
        value.library.searchText = "visual"
        value.select("visual")
        value.updateSession("visual") { $0.draft.text = "Keep library draft"; $0.readingID = "visual-modules" }
        let scope = value.library
        value.openReader(sessionID: "visual", cardID: "fixture-trend")
        value.closeReader()
        #expect(value.library == scope)
        #expect(value.selected?.readingID == "visual-modules")
        let recovered = WorkbenchModel(persistenceURL: file, automaticallyConfirm: false)
        #expect(!recovered.loadBlocked)
        #expect(recovered.library == scope)
        #expect(recovered.selected?.id == "visual")
        #expect(recovered.selected?.draft.text == "Keep library draft")

        var legacy = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        legacy.removeValue(forKey: "library")
        try JSONSerialization.data(withJSONObject: legacy).write(to: file, options: .atomic)
        let oldStore = WorkbenchModel(persistenceURL: file, automaticallyConfirm: false)
        #expect(!oldStore.loadBlocked)
        #expect(oldStore.library == SessionLibrary())
        #expect(oldStore.selected?.draft.text == "Keep library draft")
    }

    @Test func libraryAttentionRetainsArchivedAndUncertainItems() throws {
        let value = try model()
        value.setArchived(true, sessionID: "decisions")
        value.selectScope(.attention)
        #expect(value.count(in: .attention) == 4)
        let question = try #require(value.visibleAttention.first { $0.id.hasSuffix("fixture-question") })
        value.openAttention(question)
        #expect(value.selected?.id == "decisions")
        #expect(value.selected?.readingID == "decision-question")
        #expect(value.library.scope == .attention)
        let answer = try #require(value.decide(sessionID: "decisions", decisionID: "fixture-question", answer: "Keep this answer"))
        value.confirm(operationID: answer, sessionID: "decisions", outcome: .confirmed)
        #expect(!value.visibleAttention.contains { $0.id == question.id })
        #expect(value.count(in: .attention) == 3)
        value.selectScope(.all)
        value.select("working")
        value.updateSession("working") { $0.draft.text = "An uncertain message" }
        let message = try #require(value.send(sessionID: "working"))
        value.confirm(operationID: message, sessionID: "working", outcome: .uncertain)
        value.selectScope(.attention)
        let item = try #require(value.visibleAttention.first { $0.id.hasSuffix(message.uuidString) })
        #expect(item.kind == .unconfirmed)
        value.openAttention(item)
        #expect(value.selected?.id == "working")
        #expect(value.selected?.readingID == item.entryID)
        #expect(value.selected?.operations.count == 1)
    }

    @Test func canonicalBytesAndAllFourTypes() throws {
        let value = try model()
        let cards = try #require(value.selected).entries.compactMap(\.component)
        #expect(cards.count == 4)
        let types = try cards.map { card in
            let json = try card.validatedJSON()
            let payload = try #require(card.payload)
            let bytes = try #require(Data(base64Encoded: payload))
            #expect(Data(json.utf8) == bytes)
            #expect(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == card.sha256)
            let spec = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let presentation = try JSONDecoder().decode(ComponentPresentation.self, from: bytes)
            if ["line", "bar"].contains(presentation.type) {
                #expect(presentation.fixtureTaskTotal == 87)
            } else {
                #expect(presentation.fixtureTaskTotal == nil)
            }
            return spec["type"] as? String
        }
        #expect(Set(types.compactMap { $0 }) == ["line", "bar", "datagrid", "markdown"])
    }

    @Test func componentRejectsChangedBytesAndBounds() throws {
        let card = try #require(model().selected?.card("fixture-trend"))
        let corrupted = ComponentRecord(componentId: card.id, toolCallId: card.toolCallId, version: 1, status: "ready",
            encoding: "base64-json", payload: Data("{}".utf8).base64EncodedString(), sha256: card.sha256,
            redacted: false, originatingMessageId: nil, error: nil)
        #expect(throws: (any Error).self) { try corrupted.validatedJSON() }
        let oversize = ComponentRecord(componentId: card.id, toolCallId: card.toolCallId, version: 1, status: "ready",
            encoding: "base64-json", payload: Data(repeating: 32, count: ComponentRecord.maximumBytes + 1).base64EncodedString(),
            sha256: card.sha256, redacted: false, originatingMessageId: nil, error: nil)
        #expect(throws: (any Error).self) { try oversize.validatedJSON() }
    }

    @Test func nativeSummaryDoesNotRestrictChartColumnTypes() throws {
        let json = #"{"type":"bar","source":"本地虚构数据","xAxisKey":"tasks","series":[{"dataKey":"count","name":"次数"}],"data":[{"tasks":"Build","count":3}]}"#
        let value = try JSONDecoder().decode(ComponentPresentation.self, from: Data(json.utf8))
        #expect(value.type == "bar")
        #expect(value.fixtureTaskTotal == nil)
    }

    @Test func nativeAccentUsesBlueInBothAppearances() throws {
        for dark in [false, true] {
            let expected: [CGFloat] = dark ? [0.039, 0.518, 1] : [0, 0.408, 0.851]
            var components: [CGFloat]?
            #if os(macOS)
            let appearance = try #require(NSAppearance(named: dark ? .darkAqua : .aqua))
            appearance.performAsCurrentDrawingAppearance {
                if let color = NSColor(named: "AccentColor", bundle: .main)?.usingColorSpace(.sRGB) {
                    components = [color.redComponent, color.greenComponent, color.blueComponent]
                }
            }
            #else
            let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
            let color = try #require(UIColor(named: "AccentColor", in: .main, compatibleWith: traits))
                .resolvedColor(with: traits)
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            #expect(color.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
            components = [red, green, blue]
            #endif
            let actual = try #require(components)
            #expect(zip(actual, expected).allSatisfy { abs($0 - $1) < 0.005 },
                    "Accent in \(dark ? "dark" : "light") appearance: \(actual), expected \(expected)")
        }
    }

    @Test func rendererBoundaryRejectsUntrustedShapesAndURLs() throws {
        #expect(ComponentBoundary.resource(ComponentBoundary.page) == "index.html")
        for text in ["file:///etc/passwd", "https://bundle/index.html", "devpocket-component://bundle/component-fixtures.json",
                     "devpocket-component://bundle/index.html?q=1", "devpocket-component://user@bundle/index.html"] {
            let url = try #require(URL(string: text))
            #expect(ComponentBoundary.resource(url) == nil)
        }
        for text in ["javascript:alert(1)", "file:///tmp/private", "https://user:password@example.com",
                     "https://example.com/a b", "https://example.com/\\x", "https://bundle/index.html"] {
            #expect(ComponentBoundary.externalLink(text) == nil)
        }
        #expect(ComponentBoundary.externalLink("https://developer.apple.com/documentation/swiftui") != nil)
        #expect(try ComponentBoundary.message(#"{"version":1,"type":"ready"}"#, requestID: "a") == .ready)
        #expect(try ComponentBoundary.message(#"{"version":1,"type":"rendered","requestId":"old"}"#, requestID: "a") == .stale)
        for text in [#"{"version":true,"type":"ready"}"#,
                     #"{"version":1,"type":"rendered","requestId":"a","command":"send"}"#,
                     #"{"version":1,"type":"height","requestId":"a","height":true}"#,
                     #"{"version":1,"type":"height","requestId":"a","height":100001}"#,
                     #"{"version":1,"type":"open-link","requestId":"a","url":"file:///tmp/a"}"#,
                     #"{"version":1,"type":"send","requestId":"a"}"#] {
            #expect(throws: (any Error).self) { try ComponentBoundary.message(text, requestID: "a") }
        }
    }

    @Test func referenceRequiresMatchingSuccessAndPreservesDraftAndReading() throws {
        let value = try model()
        value.updateSession("visual") { $0.draft.text = "Keep this draft"; $0.readingID = "visual-modules" }
        value.openReader(sessionID: "visual", cardID: "fixture-trend")
        value.referenceCard(sessionID: "visual", cardID: "fixture-trend", renderedDigest: nil)
        #expect(value.selected?.draft.reference == nil)
        let digest = try #require(value.selected?.card("fixture-trend")?.sha256)
        value.referenceCard(sessionID: "visual", cardID: "fixture-trend", renderedDigest: digest)
        #expect(value.selected?.draft.text == "Keep this draft")
        #expect(value.selected?.readingID == "visual-modules")
        #expect(value.reader == nil)
        #expect(value.selected?.draft.reference?.reference.sha256 == digest)
        #expect(value.selected?.operations.isEmpty == true)
        value.select("offline")
        value.referenceCard(sessionID: "visual", cardID: "fixture-trend", renderedDigest: digest)
        #expect(value.selected?.draft.reference == nil)
    }

    @Test func sendAppendsANewResponseAndNeverReplacesOldCard() throws {
        let value = try model()
        let before = try #require(value.selected).entries.compactMap(\.component)
        value.referenceCard(sessionID: "visual", cardID: "fixture-trend", renderedDigest: before.first { $0.id == "fixture-trend" }?.sha256)
        value.updateSession("visual") { $0.draft.text = "Append a new chart" }
        let id = try #require(value.send(sessionID: "visual"))
        let operation = try #require(value.selected?.operations.last)
        #expect(operation.text == "Append a new chart")
        #expect(operation.reference?.reference.componentId == "fixture-trend")
        #expect(value.selected?.draft == DemoDraft())
        value.updateSession("visual") { $0.draft.text = "A newer draft" }
        value.confirm(operationID: id, sessionID: "visual", outcome: .confirmed)
        let after = try #require(value.selected).entries.compactMap(\.component)
        #expect(Array(after.prefix(before.count)) == before)
        #expect(after.count == before.count + 1)
        #expect(after.last?.originatingMessageId == id.uuidString)
        #expect(value.selected?.draft.text == "A newer draft")
        #expect(value.selected?.operations.last?.text == operation.text)
        let count = value.selected?.entries.count
        value.confirm(operationID: id, sessionID: "visual", outcome: .confirmed)
        #expect(value.selected?.entries.count == count)
        let entries = try #require(value.selected).entries
        #expect(zip(entries, entries.dropFirst()).allSatisfy { $0.at <= $1.at })
    }

    @Test func switchingReaderCardsRetainsOriginalReadingContext() throws {
        let value = try model()
        value.updateSession("visual") { $0.readingID = "visual-modules"; $0.draft.text = "Keep this draft" }
        value.openReader(sessionID: "visual", cardID: "fixture-trend")
        value.updateSession("visual") { $0.readingID = "visual-bars" }
        value.openReader(sessionID: "visual", cardID: "fixture-modules")
        value.closeReader()
        #expect(value.selected?.readingID == "visual-modules")
        #expect(value.selected?.draft.text == "Keep this draft")
    }

    @Test func stopRequestIsNotConfirmationAndBusyTextStillSends() throws {
        let value = try model("working")
        value.updateSession("working") { $0.draft.text = "Queue this text" }
        let message = try #require(value.send(sessionID: "working"))
        #expect(value.selected?.operations.last?.status == .queued)
        let stop = try #require(value.requestStop(sessionID: "working"))
        #expect(value.selected?.runtime == .cancelRequested)
        #expect(value.selected?.operations.last?.status == .cancelRequested)
        #expect(value.requestStop(sessionID: "working") == nil)
        value.updateSession("working") { $0.draft.text = "Keep after stopping" }
        value.confirm(operationID: stop, sessionID: "working", outcome: .confirmed)
        #expect(value.selected?.runtime == .idle)
        #expect(value.selected?.operations.first(where: { $0.id == message })?.status == .cancelled)
        #expect(value.selected?.draft.text == "Keep after stopping")
    }

    @Test func unrelatedReceiptsPreservePendingCancellation() throws {
        for kind in [DemoOperation.Kind.message, .permission, .answer] {
            let sessionID = kind == .message ? "working" : "decisions"
            let value = try model(sessionID)
            let receipt: UUID
            if kind == .message {
                value.updateSession(sessionID) { $0.draft.text = "Queued before stopping" }
                receipt = try #require(value.send(sessionID: sessionID))
            } else {
                receipt = try #require(value.decide(sessionID: sessionID,
                    decisionID: kind == .permission ? "fixture-permission" : "fixture-question",
                    answer: kind == .permission ? "approve-once" : "Keep this answer"))
            }
            let stop = try #require(value.requestStop(sessionID: sessionID))
            let originalStop = try #require(value.selected?.operations.first { $0.id == stop })
            value.updateSession(sessionID) { $0.draft.text = "Keep while stopping" }
            value.confirm(operationID: receipt, sessionID: sessionID, outcome: .confirmed)
            #expect(value.selected?.runtime == .cancelRequested)
            #expect(value.selected?.operations.first { $0.id == stop } == originalStop)
            #expect(value.requestStop(sessionID: sessionID) == nil)
            #expect(value.selected?.operations.count == 2)
            #expect(value.selected?.operations.first { $0.id == receipt }?.status == .completed)
            value.confirm(operationID: stop, sessionID: sessionID, outcome: .confirmed)
            #expect(value.selected?.runtime == .idle)
            #expect(value.selected?.draft.text == "Keep while stopping")
        }
    }

    @Test func pendingAbortRejectsDuplicateWithStaleRuntime() throws {
        let value = try model("working")
        let stop = try #require(value.requestStop(sessionID: "working"))
        value.updateSession("working") { $0.runtime = .running }
        #expect(value.requestStop(sessionID: "working") == nil)
        #expect(value.selected?.operations.count == 1)
        #expect(value.selected?.operations.first?.id == stop)
        #expect(value.errorMessage?.contains("当前不能请求停止") == true)
    }

    @Test func unrelatedReceiptDoesNotResolveUncertainCancellation() throws {
        let value = try model("working")
        value.updateSession("working") { $0.draft.text = "Queued before stopping" }
        let message = try #require(value.send(sessionID: "working"))
        let stop = try #require(value.requestStop(sessionID: "working"))
        value.confirm(operationID: stop, sessionID: "working", outcome: .uncertain)
        value.confirm(operationID: message, sessionID: "working", outcome: .confirmed)
        #expect(value.selected?.runtime == .cancelRequested)
        #expect(value.selected?.operations.first { $0.id == stop }?.status == .uncertain)
        #expect(value.requestStop(sessionID: "working") == nil)
        #expect(value.selected?.operations.count == 2)
    }

    @Test func cancellationRecoveryPreservesUnresolvedOperation() throws {
        for (uncertain, staleRuntime) in [(false, false), (true, false), (true, true)] {
            let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
            defer {
                do { try FileManager.default.removeItem(at: directory) }
                catch { Issue.record(error) }
            }
            let file = directory.appending(path: "fixtures.json")
            let value = try model("working", url: file)
            value.updateSession("working") { $0.draft.text = "Keep across cancellation recovery" }
            let stop = try #require(value.requestStop(sessionID: "working"))
            if uncertain { value.confirm(operationID: stop, sessionID: "working", outcome: .uncertain) }
            if staleRuntime { value.updateSession("working") { $0.runtime = .running } }
            var expected = try #require(value.selected?.operations.first)
            expected.status = .uncertain
            let recovered = try model("working", url: file)
            #expect(recovered.selected?.runtime == .cancelRequested)
            #expect(recovered.selected?.operations == [expected])
            #expect(recovered.selected?.draft.text == "Keep across cancellation recovery")
            #expect(recovered.requestStop(sessionID: "working") == nil)
            #expect(recovered.selected?.operations.count == 1)
            let message = try #require(recovered.send(sessionID: "working"))
            recovered.updateSession("working") { $0.draft.text = "A newer draft" }
            recovered.confirm(operationID: message, sessionID: "working", outcome: .confirmed)
            #expect(recovered.selected?.runtime == .cancelRequested)
            #expect(recovered.selected?.operations.first(where: { $0.id == stop }) == expected)
            #expect(recovered.requestStop(sessionID: "working") == nil)
            #expect(recovered.selected?.operations.count == 2)
            #expect(recovered.selected?.draft.text == "A newer draft")
        }
    }

    @Test func decisionsKeepAttemptsDistinctAndUnsupportedFormsFailClosed() throws {
        let value = try model("decisions")
        let id = try #require(value.decide(sessionID: "decisions", decisionID: "fixture-question", answer: "My answer"))
        #expect(value.selected?.decisions.first(where: { $0.id == "fixture-question" })?.confirmedAnswer == nil)
        #expect(value.decide(sessionID: "decisions", decisionID: "fixture-question", answer: "Changed answer") == nil)
        value.confirm(operationID: id, sessionID: "decisions", outcome: .confirmed)
        #expect(value.selected?.decisions.first(where: { $0.id == "fixture-question" })?.confirmedAnswer == "My answer")
        #expect(value.decide(sessionID: "decisions", decisionID: "fixture-unsupported", answer: "approve-once") == nil)
        let approval = try #require(value.decide(sessionID: "decisions", decisionID: "fixture-permission", answer: "approve-once"))
        value.confirm(operationID: approval, sessionID: "decisions", outcome: .uncertain)
        #expect(value.selected?.decisions.first(where: { $0.id == "fixture-permission" })?.confirmedAnswer == nil)
        #expect(value.selected?.operations.last?.status == .uncertain)
    }

    @Test func failedStopDoesNotClaimIdleAndAllowsANewRequest() throws {
        let value = try model("working")
        let first = try #require(value.requestStop(sessionID: "working"))
        value.confirm(operationID: first, sessionID: "working", outcome: .failed)
        #expect(value.selected?.runtime == .running)
        #expect(value.selected?.operations.first?.status == .failed)
        let second = try #require(value.requestStop(sessionID: "working"))
        #expect(first != second)
        #expect(value.selected?.operations.first?.id == first)
    }

    @Test func rendererCacheEvictsDetachedViewsWithoutChangingCards() throws {
        let card = try #require(model().selected?.card("fixture-trend"))
        let pool = ComponentRendererPool()
        defer { pool.reset() }
        let original = pool.session(sessionID: "visual", card: card, detail: true)
        for index in 0..<17 {
            _ = pool.session(sessionID: "visual", card: card.appended(id: "fixture-\(index)", origin: "request"), detail: true)
        }
        let reopened = pool.session(sessionID: "visual", card: card, detail: true)
        #expect(original !== reopened)
        #expect(reopened.card == card)
    }

    @Test func offlineNeverReplaysAndRecoveryKeepsOriginalOperation() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "fixtures.json")
        let value = try model(url: file)
        value.updateSession("visual") { $0.draft.text = "Pending immutable message" }
        let id = try #require(value.send(sessionID: "visual"))
        value.updateSession("visual") { $0.draft.text = "Unsent new draft" }
        value.setOffline(true)
        #expect(value.send(sessionID: "visual") == nil)
        let recovered = try model(url: file)
        #expect(recovered.selected?.draft.text == "Unsent new draft")
        #expect(recovered.selected?.operations.count == 1)
        #expect(recovered.selected?.operations.first?.id == id)
        #expect(recovered.selected?.operations.first?.status == .uncertain)
        recovered.setOffline(false)
        #expect(recovered.selected?.operations.count == 1)
        #expect(recovered.selected?.draft.text == "Unsent new draft")
        recovered.confirm(operationID: id, sessionID: "visual", outcome: .confirmed)
        #expect(recovered.selected?.operations.first?.status == .uncertain)
    }

    @Test func persistenceFailureKeepsDraftAndDoesNotScheduleSubmission() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let blocker = directory.appending(path: "file")
        try Data("Not a directory".utf8).write(to: blocker)
        let value = try model(url: blocker.appending(path: "state.json"))
        value.updateSession("visual") { $0.draft.text = "Do not lose this" }
        #expect(value.send(sessionID: "visual") == nil)
        #expect(value.selected?.draft.text == "Do not lose this")
        #expect(value.selected?.operations.isEmpty == true)
        #expect(value.errorMessage?.contains("保存失败") == true)
    }

    @Test func oversizedSnapshotDoesNotOverwriteReadableStore() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "state.json")
        let value = try model(url: file)
        value.updateSession("visual") { $0.draft.text = "Saved draft" }
        value.updateSession("visual") { $0.draft.text = String(repeating: "a", count: FixtureSnapshot.maximumBytes) }
        #expect(value.errorMessage?.contains("存储达到上限") == true)
        #expect(try Data(contentsOf: file).count < FixtureSnapshot.maximumBytes)
        let recovered = try model(url: file)
        #expect(recovered.selected?.draft.text == "Saved draft")
    }

    #if os(macOS)
    @Test func librarySearchFocusWaitsForWindowAttachment() async throws {
        var requested = true
        let search = LibrarySearchControl(frame: CGRect(x: 20, y: 20, width: 320, height: 26))
        search.focusRequested = Binding(get: { requested }, set: { requested = $0 })
        search.applyFocusRequest()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
        #expect(requested)
        #expect(search.window == nil)

        let previousWindow = NSApp.keyWindow
        let window = NSWindow(contentRect: CGRect(x: 100, y: 100, width: 400, height: 140),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer {
            window.contentView = nil
            window.close()
            previousWindow?.makeKeyAndOrderFront(nil)
        }
        let content = try #require(window.contentView)
        let original = NSTextField(frame: CGRect(x: 20, y: 80, width: 320, height: 26))
        content.addSubview(original)
        window.makeKeyAndOrderFront(nil)
        try #require(window.makeFirstResponder(original))
        #expect(window.firstResponder === original.currentEditor())

        content.addSubview(search)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
        #expect(!requested)
        let editor = try #require(search.currentEditor())
        #expect(window.firstResponder === editor)
    }
    #endif

    @Test func actualWKWebViewRendersBundledComponents() async throws {
        let value = try model()
        for card in try #require(value.selected).entries.compactMap(\.component) {
            let renderer = ComponentWebSession(card: card, detail: true)
            renderer.webView.frame = CGRect(x: 0, y: 0, width: 600, height: 600)
            #if os(macOS)
            let previousWindow = NSApp.keyWindow
            let window = NSWindow(contentRect: renderer.webView.frame, styleMask: [.titled],
                backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = renderer.webView
            window.makeKeyAndOrderFront(nil)
            defer {
                renderer.dispose()
                window.contentView = nil
                window.close()
                previousWindow?.makeKeyAndOrderFront(nil)
            }
            #else
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let previousWindow = scene.keyWindow
            let window = UIWindow(windowScene: scene)
            let controller = UIViewController()
            controller.view = renderer.webView
            window.rootViewController = controller
            window.makeKeyAndVisible()
            defer {
                renderer.dispose()
                window.isHidden = true
                window.rootViewController = nil
                previousWindow?.makeKey()
            }
            #endif
            for theme in ["light", "dark"] {
                await renderer.start(theme: theme, scale: 1)
                for _ in 0..<100 where !renderer.rendered && renderer.failure == nil {
                    try await Task.sleep(for: .milliseconds(100))
                }
                #expect(renderer.rendered, "\(card.id), \(theme): \(renderer.failure ?? "No renderer acknowledgement")")
                #expect(renderer.failure == nil)
                if renderer.rendered {
                    let result = try await renderer.webView.callAsyncJavaScript("""
                        const style = getComputedStyle(document.getElementById('component'));
                        const canvas = document.querySelector('canvas');
                        let hasGridPixels = null;
                        if (canvas) {
                          const grid = style.getPropertyValue('--chart-grid').trim();
                          const rgb = [1, 3, 5].map(offset => parseInt(grid.slice(offset, offset + 2), 16));
                          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                          hasGridPixels = false;
                          for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index + 3] > 0 && rgb.every((value, channel) => Math.abs(value - pixels[index + channel]) <= 2)) {
                              hasGridPixels = true;
                              break;
                            }
                          }
                        }
                        return {
                          background: style.backgroundColor,
                          text: style.color,
                          accent: style.getPropertyValue('--accent').trim(),
                          body: getComputedStyle(document.body).backgroundColor,
                          grid: hasGridPixels
                        };
                        """, arguments: [:], in: nil, contentWorld: .page)
                    let style = try #require(result as? [String: Any])
                    let background = theme == "dark" ? "rgb(33, 38, 47)" : "rgb(255, 255, 255)"
                    #expect(style["background"] as? String == background)
                    #expect(style["body"] as? String == background)
                    #expect(style["text"] as? String == (theme == "dark" ? "rgb(237, 241, 247)" : "rgb(28, 32, 40)"))
                    #expect(style["accent"] as? String == (theme == "dark" ? "#80baff" : "#0068d9"))
                    if card.id == "fixture-trend" || card.id == "fixture-bars" {
                        #expect(style["grid"] as? Bool == true, "Chart canvas must use the host's neutral grid color.")
                        let description = try await renderer.webView.callAsyncJavaScript(
                            "return document.querySelector('canvas').getAttribute('aria-label');",
                            arguments: [:], in: nil, contentWorld: .page)
                        #expect((description as? String)?.contains("完成数") == true)
                    }
                }
            }
            if renderer.rendered {
                if ["line", "bar"].contains(renderer.presentation?.type ?? "") {
                    let original = try card.validatedJSON()
                    renderer.chartWindowSize = 7
                    renderer.chartDataOnly = true
                    await renderer.applyChartPresentation()
                    #expect(renderer.failure == nil)
                    #expect(renderer.presentation?.fixtureTaskTotal(windowSize: 7) == 48)
                    let rows = try await renderer.webView.callAsyncJavaScript(
                        "return document.querySelectorAll('.chart-data tbody tr').length;",
                        arguments: [:], in: nil, contentWorld: .page)
                    #expect(rows as? Int == 7)
                    let stale = try await renderer.webView.callAsyncJavaScript("""
                        try { window.devPocketPresentation.setChartView('not-current', 7, true); return false; }
                        catch { return true; }
                        """, arguments: [:], in: nil, contentWorld: .page)
                    #expect(stale as? Bool == true)
                    renderer.chartWindowSize = nil
                    await renderer.applyChartPresentation()
                    let allRows = try await renderer.webView.callAsyncJavaScript(
                        "return document.querySelectorAll('.chart-data tbody tr').length;",
                        arguments: [:], in: nil, contentWorld: .page)
                    #expect(allRows as? Int == 14)
                    #expect(try card.validatedJSON() == original)
                    renderer.chartDataOnly = false
                    await renderer.applyChartPresentation()
                }
                let network = try await renderer.webView.callAsyncJavaScript("""
                    const url = 'https://example.invalid/fixture-must-not-connect';
                    const violations = [];
                    const record = event => {
                        if (event.blockedURI === url) violations.push(event.effectiveDirective);
                    };
                    document.addEventListener('securitypolicyviolation', record);
                    try { await fetch(url); } catch {}
                    await new Promise(resolve => setTimeout(resolve, 100));
                    document.removeEventListener('securitypolicyviolation', record);
                    return violations.includes('connect-src');
                    """, arguments: [:], in: nil, contentWorld: .page)
                #expect(network as? Bool == true)
                renderer.webView.load(URLRequest(url: URL(string: "https://example.invalid/fixture-must-not-navigate")!))
                try await Task.sleep(for: .milliseconds(200))
                #expect(renderer.webView.url == ComponentBoundary.page)
                #expect(renderer.rendered)
            }
            renderer.dispose()
            #expect(!renderer.rendered)
        }
    }
}
