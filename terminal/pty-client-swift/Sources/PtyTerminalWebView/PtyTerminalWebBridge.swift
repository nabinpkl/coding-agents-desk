import Foundation

enum PtyTerminalWebBridgeLimits {
    static let maximumTerminalIDBytes = 128
    static let maximumStringBytes = 1 * 1024 * 1024
    static let maximumInputBytes = 64 * 1024
    static let maximumLiveOutputBytesPerTerminal = 1 * 1024 * 1024
    static let maximumQueuedBytes = 32 * 1024 * 1024
    static let maximumDimension: UInt32 = 512
    static let maximumRows: UInt32 = 256
}

enum PtyTerminalWebIntent: Equatable {
    case booted
    case ready
    case fontReady
    case viewport(terminalID: String, active: Bool, claim: Bool, columns: UInt32, rows: UInt32)
    case focus(paneID: String, claim: Bool)
    case input(terminalID: String, data: Data)
    case workspace(name: String, paneID: String?, tabID: String?, sessionName: String?)
    case clipboardWrite(String)
    case openLink(URL)
    case title(terminalID: String, title: String)
    case rendererFailure(terminalID: String)
    case diagnostic(code: String)
    case presentation(terminalID: String, scale: Double, cropped: Bool)

    static func decode(_ body: Any) -> Self? {
        guard let object = body as? [String: Any], exactInteger(object["version"]) == 1,
              let type = boundedString(object["type"], maximumBytes: 64) else { return nil }
        switch type {
        case "booted": return .booted
        case "ready": return .ready
        case "fontReady": return .fontReady
        case "viewport":
            guard let terminalID = identifier(object["terminalId"]),
                  let columns = dimension(object["columns"], maximum: PtyTerminalWebBridgeLimits.maximumDimension),
                  let rows = dimension(object["rows"], maximum: PtyTerminalWebBridgeLimits.maximumRows),
                  let active = object["active"] as? Bool, let claim = object["claim"] as? Bool,
                  !claim || active else { return nil }
            return .viewport(terminalID: terminalID, active: active, claim: claim, columns: columns, rows: rows)
        case "focus":
            guard let paneID = identifier(object["paneId"]), let claim = object["claim"] as? Bool else { return nil }
            return .focus(paneID: paneID, claim: claim)
        case "input":
            guard let terminalID = identifier(object["terminalId"]),
                  let text = boundedString(object["data"], maximumBytes: PtyTerminalWebBridgeLimits.maximumInputBytes) else { return nil }
            return .input(terminalID: terminalID, data: Data(text.utf8))
        case "inputBinary":
            guard let terminalID = identifier(object["terminalId"]), let encoded = object["data"] as? String,
                  encoded.utf8.count <= ((PtyTerminalWebBridgeLimits.maximumInputBytes + 2) / 3) * 4,
                  let data = Data(base64Encoded: encoded), data.count <= PtyTerminalWebBridgeLimits.maximumInputBytes else { return nil }
            return .input(terminalID: terminalID, data: data)
        case "workspaceIntent":
            guard let name = boundedString(object["intent"], maximumBytes: 64),
                  let paneID = validatedOptionalString(object["paneId"], maximumBytes: PtyTerminalWebBridgeLimits.maximumTerminalIDBytes),
                  let tabID = validatedOptionalString(object["tabId"], maximumBytes: PtyTerminalWebBridgeLimits.maximumTerminalIDBytes),
                  let sessionName = validatedOptionalString(object["sessionName"], maximumBytes: 256) else { return nil }
            return .workspace(
                name: name, paneID: paneID, tabID: tabID, sessionName: sessionName
            )
        case "clipboardWrite":
            guard let text = boundedString(object["text"], maximumBytes: PtyTerminalWebBridgeLimits.maximumStringBytes) else { return nil }
            return .clipboardWrite(text)
        case "openLink":
            guard let raw = boundedString(object["url"], maximumBytes: 4_096), let url = URL(string: raw),
                  url.scheme == "http" || url.scheme == "https" else { return nil }
            return .openLink(url)
        case "title":
            guard let terminalID = identifier(object["terminalId"]), let title = boundedString(object["title"], maximumBytes: 512) else { return nil }
            return .title(terminalID: terminalID, title: title)
        case "rendererFailure":
            guard let terminalID = identifier(object["terminalId"]) else { return nil }
            return .rendererFailure(terminalID: terminalID)
        case "diagnostic":
            guard let code = boundedString(object["code"], maximumBytes: 128) else { return nil }
            return .diagnostic(code: code)
        case "presentation":
            guard let terminalID = identifier(object["terminalId"]),
                  let scale = (object["scale"] as? NSNumber)?.doubleValue,
                  scale.isFinite, (0.1...1).contains(scale),
                  let cropped = object["cropped"] as? Bool else { return nil }
            return .presentation(terminalID: terminalID, scale: scale, cropped: cropped)
        default: return nil
        }
    }

    private static func identifier(_ value: Any?) -> String? {
        boundedString(value, maximumBytes: PtyTerminalWebBridgeLimits.maximumTerminalIDBytes)
    }

    private static func validatedOptionalString(_ value: Any?, maximumBytes: Int) -> String?? {
        guard let value else { return .some(nil) }
        guard let string = boundedString(value, maximumBytes: maximumBytes) else { return nil }
        return .some(string)
    }

    private static func boundedString(_ value: Any?, maximumBytes: Int) -> String? {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= maximumBytes else { return nil }
        return value
    }

    private static func dimension(_ value: Any?, maximum: UInt32) -> UInt32? {
        guard let integer = exactInteger(value) else { return nil }
        guard integer > 0, integer <= Int64(maximum) else { return nil }
        return UInt32(integer)
    }

    private static func exactInteger(_ value: Any?) -> Int64? {
        guard !(value is Bool), let number = value as? NSNumber else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded(.towardZero) == double else { return nil }
        return Int64(exactly: double)
    }
}

struct PtyTerminalWebDelivery: Equatable {
    let terminalID: String?
    let json: String
    let byteCount: Int
    let liveOutput: Bool
}

struct PtyTerminalWebDeliveryQueue {
    private(set) var deliveries: [PtyTerminalWebDelivery] = []
    private(set) var totalBytes = 0
    private var liveBytes: [String: Int] = [:]

    mutating func append(_ delivery: PtyTerminalWebDelivery) -> Bool {
        guard delivery.byteCount > 0,
              totalBytes <= PtyTerminalWebBridgeLimits.maximumQueuedBytes - delivery.byteCount else { return false }
        if delivery.liveOutput, let terminalID = delivery.terminalID {
            let current = liveBytes[terminalID, default: 0]
            guard current <= PtyTerminalWebBridgeLimits.maximumLiveOutputBytesPerTerminal - delivery.byteCount else { return false }
            liveBytes[terminalID] = current + delivery.byteCount
        }
        deliveries.append(delivery)
        totalBytes += delivery.byteCount
        return true
    }

    mutating func popFirst() -> PtyTerminalWebDelivery? {
        guard !deliveries.isEmpty else { return nil }
        let delivery = deliveries.removeFirst()
        totalBytes -= delivery.byteCount
        if delivery.liveOutput, let terminalID = delivery.terminalID {
            liveBytes[terminalID] = max(0, liveBytes[terminalID, default: 0] - delivery.byteCount)
        }
        return delivery
    }

    mutating func remove(terminalID: String) {
        deliveries.removeAll { delivery in
            guard delivery.terminalID == terminalID else { return false }
            totalBytes -= delivery.byteCount
            return true
        }
        liveBytes[terminalID] = nil
    }

    mutating func removeAll() {
        deliveries.removeAll(keepingCapacity: false)
        liveBytes.removeAll(keepingCapacity: false)
        totalBytes = 0
    }
}
