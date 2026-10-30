import CryptoKit
import Foundation

enum DemoError: LocalizedError {
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message): message
        }
    }
}

struct ComponentReference: Codable, Equatable {
    let componentId: String
    let sha256: String
}

struct ComponentSelection: Codable, Equatable {
    let sessionID: String
    let reference: ComponentReference
    let title: String
}

struct ComponentPresentation: Decodable {
    struct Point: Decodable {
        let tasks: Double?
        let day: String?

        private enum CodingKeys: String, CodingKey { case tasks, day }
        init(from decoder: any Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            // Other charts may use "tasks" as a text category, not a fixture count.
            tasks = try? fields.decode(Double.self, forKey: .tasks)
            day = try? fields.decode(String.self, forKey: .day)
        }
    }
    let type: String
    let source: String?
    let data: [Point]?

    var symbol: String {
        switch type {
        case "line": "chart.xyaxis.line"
        case "bar": "chart.bar"
        case "datagrid": "tablecells"
        default: "text.alignleft"
        }
    }

    var fixtureTaskTotal: Double? { fixtureTaskTotal(windowSize: nil) }

    func fixtureTaskTotal(windowSize: Int?) -> Double? {
        guard ["line", "bar"].contains(type), source?.hasPrefix("本地虚构数据") == true,
              let data, !data.isEmpty else { return nil }
        if let windowSize, !(1...data.count).contains(windowSize) { return nil }
        let points = Array(data.suffix(windowSize ?? data.count))
        let values = points.compactMap(\.tasks)
        guard values.count == points.count,
              values.allSatisfy({ $0.isFinite && $0 >= 0 && $0.rounded() == $0 }) else { return nil }
        let total = values.reduce(0, +)
        return total.isFinite && total <= 9_000_000_000_000_000 ? total : nil
    }
}

struct ComponentRecord: Codable, Equatable, Identifiable {
    struct Failure: Codable, Equatable {
        let code: String
        let message: String
    }

    let componentId: String
    let toolCallId: String
    let version: Int
    let status: String
    let encoding: String?
    let payload: String?
    let sha256: String?
    let redacted: Bool?
    let originatingMessageId: String?
    let error: Failure?

    var id: String { componentId }
    static let maximumBytes = 256 * 1024

    func validatedJSON() throws -> String {
        func identifier(_ value: String) -> Bool {
            !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= 200
        }
        guard version == 1, identifier(componentId), identifier(toolCallId),
              originatingMessageId.map(identifier) != false else {
            throw DemoError.invalid("组件身份或版本无效。")
        }
        guard status == "ready", encoding == "base64-json", error == nil, redacted != nil,
              let payload, payload.utf16.count <= ((Self.maximumBytes + 2) / 3) * 4,
              let sha256, sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let bytes = Data(base64Encoded: payload), bytes.count <= Self.maximumBytes,
              bytes.base64EncodedString() == payload,
              SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == sha256,
              let text = String(data: bytes, encoding: .utf8),
              let spec = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = spec["type"] as? String,
              ["line", "bar", "datagrid", "markdown"].contains(type) else {
            throw DemoError.invalid("组件编码、类型或内容校验失败。原始字节没有被替换。")
        }
        if let title = spec["title"], !((title as? String).map { $0.utf16.count <= 200 } ?? false) {
            throw DemoError.invalid("组件标题无效。")
        }
        if type == "datagrid" {
            guard let rows = spec["rows"] as? [Any], rows.count <= 1000,
                  let columns = spec["columns"] as? [Any], (1...20).contains(columns.count) else {
                throw DemoError.invalid("数据表超过 1,000 行或 20 列上限。")
            }
        }
        if type == "line" || type == "bar" {
            guard let rows = spec["data"] as? [Any], rows.count <= 1000,
                  let series = spec["series"] as? [Any], (1...1000).contains(series.count),
                  rows.count * series.count <= 1000 else {
                throw DemoError.invalid("图表超过 1,000 个数值的上限。")
            }
        }
        // The shared renderer performs full spec validation before enabling native references.
        return text
    }

    func title() -> String {
        displayField("title") ?? "不可用的组件"
    }

    var presentationType: String? { displayField("type") }

    private func displayField(_ name: String) -> String? {
        guard status == "ready", let payload, let bytes = Data(base64Encoded: payload),
              let spec = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
        return spec[name] as? String
    }

    func appended(id: String, origin: String) -> ComponentRecord {
        ComponentRecord(componentId: id, toolCallId: "tool-\(id)", version: version, status: status,
                        encoding: encoding, payload: payload, sha256: sha256, redacted: redacted,
                        originatingMessageId: origin, error: error)
    }
}
