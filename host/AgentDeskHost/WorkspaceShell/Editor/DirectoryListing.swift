import Foundation

/// One row of a directory listing for the viewer's breadcrumb navigator: the entry's URL, whether
/// it's a folder, and its git status (`nil` when undecorated).
///
/// `WorkspaceShellSession` builds these from the same sources the sidebar tree uses —
/// `FileNode.children()` and the live `GitStatus` — so the dropdown and the tree never drift.
/// Pure value type.
public struct DirectoryListingEntry: Equatable {
    public let url: URL
    public let isDirectory: Bool
    public let git: GitFileStatus?

    public init(url: URL, isDirectory: Bool, git: GitFileStatus?) {
        self.url = url
        self.isDirectory = isDirectory
        self.git = git
    }
}

/// List one breadcrumb directory from the active workspace, using the same `FileNode` ordering and
/// Git snapshot as the Explorer tree. A stale or forged directory outside the workspace is rejected
/// before touching the filesystem.
public func directoryListing(
    directory: URL,
    workspaceRoot: URL,
    gitStatus: GitStatus
) -> [DirectoryListingEntry] {
    let root = workspaceRoot.standardizedFileURL.resolvingSymlinksInPath()
    let requested = directory.standardizedFileURL.resolvingSymlinksInPath()
    let rootPath = root.path
    let requestedPath = requested.path
    guard requestedPath == rootPath || requestedPath.hasPrefix(rootPath + "/") else { return [] }

    return FileNode(url: requested, isDirectory: true).children().map { node in
        DirectoryListingEntry(
            url: node.url,
            isDirectory: node.isDirectory,
            git: gitStatus.decoration(for: node.url, isDirectory: node.isDirectory)
        )
    }
}
