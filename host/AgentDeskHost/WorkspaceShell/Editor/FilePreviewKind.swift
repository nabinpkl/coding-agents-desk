import Foundation

public enum FilePreviewKind: Equatable {
    case html
    case markdown
    case notebook
    case text

    public static func classify(_ url: URL) -> FilePreviewKind {
        switch url.pathExtension.lowercased() {
        case "html", "htm":
            return .html
        case "md", "markdown":
            return .markdown
        case "ipynb":
            return .notebook
        default:
            return .text
        }
    }
}
