import Foundation

/// One row of a directory listing for the viewer's breadcrumb navigator: the entry's URL, whether
/// it's a folder, and its git status (`nil` when undecorated).
///
/// The owner (`AppDelegate`) builds these from the same sources the sidebar tree uses —
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
