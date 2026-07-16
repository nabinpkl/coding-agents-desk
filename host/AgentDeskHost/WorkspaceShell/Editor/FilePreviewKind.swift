import Foundation
import WorkspaceKit

public typealias FilePreviewKind = WorkspaceFileKind

extension WorkspaceFileKind {
    public static func classify(_ url: URL) -> WorkspaceFileKind {
        WorkspaceFileKind(path: url.path)
    }
}
