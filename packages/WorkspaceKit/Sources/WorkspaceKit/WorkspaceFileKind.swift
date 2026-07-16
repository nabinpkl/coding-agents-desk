import Foundation

public enum WorkspaceFileKind: String, Equatable, Sendable {
    case docx
    case html
    case markdown
    case notebook
    case text

    public init(path: String) {
        switch (path as NSString).pathExtension.lowercased() {
        case "docx": self = .docx
        case "html", "htm": self = .html
        case "md", "markdown": self = .markdown
        case "ipynb": self = .notebook
        default: self = .text
        }
    }

    public var isReadOnly: Bool {
        self == .docx || self == .notebook
    }
}
