import Foundation
import Observation
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#endif

#if os(macOS)
// Inline WebKit scroll views must not trap the conversation's vertical scrolling.
private final class ConversationWebView: WKWebView {
    var forwardsVerticalScrolling = false

    override func hitTest(_ point: NSPoint) -> NSView? {
        let target = super.hitTest(point)
        guard target != nil, forwardsVerticalScrolling, let event = NSApp.currentEvent,
              event.type == .scrollWheel, !event.modifierFlags.contains(.shift),
              abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX) else { return target }
        return self
    }

    override func scrollWheel(with event: NSEvent) {
        if forwardsVerticalScrolling, let parent = enclosingScrollView {
            parent.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }
}
#endif

enum ComponentBoundary {
    static let scheme = "devpocket-component"
    static let host = "bundle"
    static let page = URL(string: "devpocket-component://bundle/index.html")!
    static let resources = ["index.html", "component.js", "component.css", "component.js.LEGAL.txt", "THIRD-PARTY-NOTICES.txt"]

    static func resource(_ url: URL) -> String? {
        guard url.scheme == scheme, url.host == host, url.port == nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              resources.contains(String(url.path.dropFirst())),
              url.absoluteString == "\(scheme)://\(host)\(url.path)" else { return nil }
        return String(url.path.dropFirst())
    }

    static func externalLink(_ text: String) -> URL? {
        guard text.utf16.count <= 2000,
              !text.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || $0 == "\\" }),
              let url = URL(string: text), ["https", "http"].contains(url.scheme),
              let host = url.host, !host.isEmpty, host != Self.host,
              url.user == nil, url.password == nil, url.absoluteString.utf16.count <= 2000 else { return nil }
        return url
    }

    enum Message: Equatable {
        case ready, rendered, height(Double), link(URL), failure(String), stale
    }

    static func message(_ text: String, requestID: String) throws -> Message {
        guard text.utf8.count <= 4096, let bytes = text.data(using: .utf8),
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let version = value["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let type = value["type"] as? String else { throw DemoError.invalid("渲染器消息无效。") }
        let keys = Set(value.keys)
        if type == "ready" {
            guard keys == ["version", "type"] else { throw DemoError.invalid("渲染器就绪消息无效。") }
            return .ready
        }
        guard let responseID = value["requestId"] as? String, !responseID.isEmpty else {
            throw DemoError.invalid("渲染器缺少请求身份。")
        }
        guard responseID == requestID else { return .stale }
        let common: Set<String> = ["version", "type", "requestId"]
        switch type {
        case "rendered" where keys == common: return .rendered
        case "height" where keys == common.union(["height"]):
            guard let height = value["height"] as? NSNumber, CFGetTypeID(height) != CFBooleanGetTypeID(),
                  height.doubleValue.isFinite, (0...100_000).contains(height.doubleValue) else {
                throw DemoError.invalid("渲染器尺寸无效。")
            }
            return .height(height.doubleValue)
        case "open-link" where keys == common.union(["url"]):
            guard let text = value["url"] as? String, let url = externalLink(text) else {
                throw DemoError.invalid("组件链接不安全，未打开。")
            }
            return .link(url)
        case "error" where keys == common.union(["code"]):
            guard let code = value["code"] as? String,
                  ["COMPONENT_INVALID", "COMPONENT_UNSUPPORTED", "COMPONENT_TOO_LARGE", "COMPONENT_RENDER_FAILED"].contains(code) else {
                throw DemoError.invalid("渲染器错误消息无效。")
            }
            return .failure(code)
        default: throw DemoError.invalid("渲染器消息格式不受支持。")
        }
    }
}

private final class BundledComponentResources: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, let name = ComponentBoundary.resource(url),
              let file = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "Renderer"),
              urlSchemeTask.request.httpMethod == "GET" else {
            urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile))
            return
        }
        do {
            let data = try Data(contentsOf: file)
            let mime = name.hasSuffix(".html") ? "text/html" : name.hasSuffix(".css") ? "text/css"
                : name.hasSuffix(".js") ? "text/javascript" : "text/plain"
            urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}

@MainActor @Observable
final class ComponentWebSession: NSObject, WKNavigationDelegate {
    private static let appearanceCSS = """
        #component {
          --background: #ffffff; --surface: #f4f5f7; --text: #1c2028;
          --muted: #68717d; --line: #e4e7ec; --accent: #0068d9;
          --chart-foreground: #68717d; --chart-grid: #e4e7ec; --chart-y-ticks: 3;
        }
        #component[data-theme="dark"] {
          --background: #21262f; --surface: #2b323e; --text: #edf1f7;
          --muted: #b1bac7; --line: #343c48; --accent: #80baff;
          --chart-foreground: #b1bac7; --chart-grid: #343c48;
        }
        body { background: #ffffff; }
        body:has(#component[data-theme="dark"]) { background: #21262f; }
        #component .chart-box { height: 180px; }
        #component[data-view="detail"] .chart-box { height: clamp(120px, calc(100vh - 60px), 240px); }
        #component[data-view="inline"] > .chart-data { display: none; }
        #component[data-view="detail"] > .chart-data > summary { display: none; }
        #component > .source { display: none; }
        """

    let card: ComponentRecord
    let detail: Bool
    var rendered = false
    var failure: String?
    var height = 280.0
    var pendingLink: URL?
    var presentation: ComponentPresentation?
    var chartWindowSize: Int?
    var chartDataOnly = false
    private(set) var requestID = UUID().uuidString
    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private var started = false
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var active = true
    @ObservationIgnored private var navigated = false
    @ObservationIgnored private var theme = ""
    @ObservationIgnored private var json = ""

    init(card: ComponentRecord, detail: Bool) {
        self.card = card
        self.detail = detail
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.setURLSchemeHandler(BundledComponentResources(), forURLScheme: ComponentBoundary.scheme)
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        #if os(macOS)
        let surface = ConversationWebView(frame: .zero, configuration: configuration)
        surface.forwardsVerticalScrolling = !detail
        webView = surface
        #else
        webView = WKWebView(frame: .zero, configuration: configuration)
        #endif
        super.init()
        webView.navigationDelegate = self
        #if os(iOS)
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = detail
        #endif
        let controller = configuration.userContentController
        controller.add(WeakComponentMessageHandler(self), name: "devPocket")
        controller.addUserScript(WKUserScript(source: """
            Object.defineProperty(window, 'devPocketHost', {
              value: Object.freeze({postMessage: message => window.webkit.messageHandlers.devPocket.postMessage(message)}),
              writable: false, configurable: false
            });
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func start(theme: String, scale: Double) async {
        guard active else { return }
        webView.pageZoom = max(1, scale)
        if self.theme != theme {
            self.theme = theme
            requestID = UUID().uuidString
            rendered = false
            if ready { await send() }
        }
        guard !started else { return }
        started = true
        do {
            json = try card.validatedJSON()
            presentation = try JSONDecoder().decode(ComponentPresentation.self, from: Data(json.utf8))
            // This blocks resource loads independently of both navigation delegates and the page CSP.
            // WebKit's rule compiler does not support regex alternation.
            let rules = [["trigger": ["url-filter": ".*"], "action": ["type": "block"]]]
                + ComponentBoundary.resources.map { name in
                    ["trigger": ["url-filter": "^devpocket-component://bundle/\(name.replacingOccurrences(of: ".", with: "\\."))$"],
                     "action": ["type": "ignore-previous-rules"]]
                }
            let list = try await WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "DevPocketOfflineComponentsV1",
                encodedContentRuleList: String(decoding: try JSONEncoder().encode(rules), as: UTF8.self))
            guard active, let list else { throw DemoError.invalid("离线资源隔离规则不可用。") }
            webView.configuration.userContentController.add(list)
            webView.load(URLRequest(url: ComponentBoundary.page))
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard let self, self.active, !self.rendered, self.failure == nil else { return }
                self.fail("离线渲染器超时。内容和草稿仍保留，引用已禁用。")
            }
        } catch {
            let reason = (error as NSError).userInfo[NSDebugDescriptionErrorKey] as? String ?? error.localizedDescription
            fail("离线组件加载失败：\(reason)")
        }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard active else { return }
        let origin = message.frameInfo.securityOrigin
        guard message.webView === webView, message.frameInfo.isMainFrame,
              origin.protocol == ComponentBoundary.scheme, origin.host == ComponentBoundary.host, origin.port == 0,
              message.frameInfo.request.url == ComponentBoundary.page,
              let text = message.body as? String else {
            fail("已拒绝非当前主文档的渲染器消息。")
            return
        }
        do {
            switch try ComponentBoundary.message(text, requestID: requestID) {
            case .ready:
                guard !ready else { throw DemoError.invalid("渲染器重复初始化。") }
                ready = true
                Task { await send() }
            case .rendered: rendered = failure == nil
            case .height(let value): height = min(440, max(100, value))
            case .link(let url):
                guard rendered else { throw DemoError.invalid("未成功显示的组件不能打开链接。") }
                pendingLink = url
            case .failure(let code): fail("组件显示失败（\(code)）。不能引用未显示的内容。")
            case .stale: break
            }
        } catch {
            fail(error.localizedDescription)
        }
    }

    private func send() async {
        guard active, ready, failure == nil else { return }
        do {
            let quote: (String) throws -> String = { String(decoding: try JSONEncoder().encode($0), as: UTF8.self) }
            let message = """
                {"version":1,"type":"render","requestId":\(try quote(requestID)),"view":\(try quote(detail ? "detail" : "inline")),"theme":\(try quote(theme)),"spec":\(json)}
                """
            _ = try await webView.callAsyncJavaScript(
                """
                if (!document.getElementById('apple-component-appearance')) {
                  const style = document.createElement('style');
                  style.id = 'apple-component-appearance';
                  style.textContent = appearance;
                  document.head.append(style);
                }
                window.dispatchEvent(new MessageEvent('message', {data: message}));
                """,
                arguments: ["message": message, "appearance": Self.appearanceCSS], in: nil, contentWorld: .page)
        } catch {
            fail("无法发送本地渲染请求：\(error.localizedDescription)")
        }
    }

    func dispose() {
        active = false
        rendered = false
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "devPocket")
        webView.navigationDelegate = nil
    }

    func applyChartPresentation() async {
        guard active, rendered, failure == nil, let count = presentation?.data?.count, count > 0 else { return }
        let identity = requestID
        let windowSize = chartWindowSize
        var arguments: [String: Any] = ["requestId": identity, "windowSize": NSNull(), "dataOnly": chartDataOnly]
        if let windowSize { arguments["windowSize"] = windowSize }
        do {
            let result = try await webView.callAsyncJavaScript(
                "return window.devPocketPresentation.setChartView(requestId, windowSize, dataOnly);",
                arguments: arguments, in: nil, contentWorld: .page)
            guard active, identity == requestID, !Task.isCancelled else { return }
            guard let value = result as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                  value.intValue == (windowSize ?? count) else {
                throw DemoError.invalid("查看范围没有得到当前图表的确认。")
            }
        } catch {
            guard active, identity == requestID, !Task.isCancelled else { return }
            fail("无法切换本地查看状态：\(error.localizedDescription)")
        }
    }

    private func fail(_ message: String) {
        rendered = false
        failure = message
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard active, !navigated, navigationAction.targetFrame?.isMainFrame == true,
              navigationAction.navigationType == .other, navigationAction.request.url == ComponentBoundary.page else {
            return .cancel
        }
        navigated = true
        return .allow
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        fail("组件导航失败：\(error.localizedDescription)")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        fail("组件资源加载失败：\(error.localizedDescription)")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail("组件进程已退出。引用已禁用，草稿和历史没有被清除。")
    }
}

private final class WeakComponentMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: ComponentWebSession?
    init(_ owner: ComponentWebSession) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}

@MainActor
final class ComponentRendererPool {
    private var sessions: [String: ComponentWebSession] = [:]
    private var recent: [String] = []
    func session(sessionID: String, card: ComponentRecord, detail: Bool) -> ComponentWebSession {
        let key = "\(sessionID)/\(card.id)/\(card.sha256 ?? "")/\(detail)"
        let value = sessions[key] ?? ComponentWebSession(card: card, detail: detail)
        sessions[key] = value
        recent.removeAll { $0 == key }
        recent.append(key)
        while sessions.count > 16, let unused = recent.first(where: {
            $0 != key && sessions[$0]?.webView.superview == nil
        }) {
            sessions.removeValue(forKey: unused)?.dispose()
            recent.removeAll { $0 == unused }
        }
        return value
    }
    func reset() {
        sessions.values.forEach { $0.dispose() }
        sessions.removeAll()
        recent.removeAll()
    }
}

#if os(iOS)
private struct BundledWebView: UIViewRepresentable {
    let session: ComponentWebSession
    func makeUIView(context: Context) -> WKWebView { session.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#else
private struct BundledWebView: NSViewRepresentable {
    let session: ComponentWebSession
    func makeNSView(context: Context) -> WKWebView { session.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#endif

struct ComponentSurface: View {
    @Bindable var session: ComponentWebSession
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    @ScaledMetric(relativeTo: .body) private var textSize = 16.0
    var body: some View {
        VStack(alignment: .leading) {
            if let failure = session.failure {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red).padding()
                    .accessibilityIdentifier("component-error")
            } else {
                BundledWebView(session: session)
                    .frame(height: session.detail ? nil : session.height)
                    .frame(minHeight: 100)
                    .accessibilityIdentifier("component-web-\(session.card.id)")
                if !session.rendered {
                    ProgressView("正在打开离线组件…").font(.caption)
                }
            }
        }
        .task(id: "\(colorScheme)-\(textSize)") {
            await session.start(theme: colorScheme == .dark ? "dark" : "light", scale: textSize / 16)
        }
        .alert("在外部浏览器打开？", isPresented: Binding(
            get: { session.pendingLink != nil }, set: { if !$0 { session.pendingLink = nil } })) {
            Button("取消", role: .cancel) { session.pendingLink = nil }
            Button("打开链接") {
                guard let url = session.pendingLink else { return }
                session.pendingLink = nil
                openURL(url) { accepted in
                    if !accepted { session.failure = "系统未能打开链接。"; session.rendered = false }
                }
            }
        } message: {
            Text(session.pendingLink?.absoluteString ?? "")
        }
    }
}
