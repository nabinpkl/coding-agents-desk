import Foundation

public struct NotebookRunRequest {
    let workspaceRoot: URL
    let notebookURL: URL
    let cellIndex: Int
    let source: String
    let kernelName: String?

    public init(
        workspaceRoot: URL,
        notebookURL: URL,
        cellIndex: Int,
        source: String,
        kernelName: String? = nil
    ) {
        self.workspaceRoot = workspaceRoot
        self.notebookURL = notebookURL
        self.cellIndex = cellIndex
        self.source = source
        self.kernelName = kernelName
    }
}

public enum NotebookRunEvent {
    case started(cellIndex: Int)
    case stream(cellIndex: Int, name: String, text: String)
    case executeResult(cellIndex: Int, data: [String: Any], metadata: [String: Any], executionCount: Int?)
    case displayData(cellIndex: Int, data: [String: Any], metadata: [String: Any])
    case error(cellIndex: Int, ename: String, evalue: String, traceback: [String])
    case finished(cellIndex: Int, executionCount: Int?, ok: Bool)

    var cellIndex: Int {
        switch self {
        case .started(let cellIndex),
             .stream(let cellIndex, _, _),
             .executeResult(let cellIndex, _, _, _),
             .displayData(let cellIndex, _, _),
             .error(let cellIndex, _, _, _),
             .finished(let cellIndex, _, _):
            cellIndex
        }
    }

    var webDictionary: [String: Any] {
        switch self {
        case .started(let cellIndex):
            return ["type": "started", "cellIndex": cellIndex]
        case .stream(let cellIndex, let name, let text):
            return ["type": "stream", "cellIndex": cellIndex, "name": name, "text": text]
        case .executeResult(let cellIndex, let data, _, let executionCount):
            var dictionary: [String: Any] = [
                "type": "executeResult",
                "cellIndex": cellIndex,
            ]
            if let executionCount { dictionary["executionCount"] = executionCount }
            dictionary["output"] = Self.webOutput(from: data)
            return dictionary
        case .displayData(let cellIndex, let data, _):
            return [
                "type": "displayData",
                "cellIndex": cellIndex,
                "output": Self.webOutput(from: data),
            ]
        case .error(let cellIndex, let ename, let evalue, let traceback):
            return [
                "type": "error",
                "cellIndex": cellIndex,
                "ename": ename,
                "evalue": evalue,
                "text": traceback.joined(separator: "\n"),
            ]
        case .finished(let cellIndex, let executionCount, let ok):
            var dictionary: [String: Any] = [
                "type": "finished",
                "cellIndex": cellIndex,
                "ok": ok,
            ]
            if let executionCount { dictionary["executionCount"] = executionCount }
            return dictionary
        }
    }

    private static func webOutput(from data: [String: Any]) -> [String: Any] {
        for mime in ["image/png", "image/jpeg", "image/gif"] where data[mime] != nil {
            return [
                "kind": "image",
                "mime": mime,
                "dataUri": "data:\(mime);base64,\(joinedText(data[mime]).replacingOccurrences(of: "\\s+", with: "", options: .regularExpression))",
            ]
        }
        if let markdown = data["text/markdown"] {
            return ["kind": "markdown", "text": joinedText(markdown)]
        }
        if let text = data["text/plain"] {
            return ["kind": "text", "text": joinedText(text)]
        }
        if let html = data["text/html"] {
            return ["kind": "html-deferred", "text": joinedText(data["text/plain"] ?? html)]
        }
        return ["kind": "text", "text": String(describing: data)]
    }

    static func joinedText(_ value: Any?) -> String {
        if let string = value as? String { return string }
        if let strings = value as? [String] { return strings.joined() }
        if let value { return String(describing: value) }
        return ""
    }
}
