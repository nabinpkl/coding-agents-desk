import Foundation
import os

/// One node in the workspace file tree. A reference type because `NSOutlineView`
/// identifies rows by object identity and holds them across reloads.
///
/// Children load **lazily** on first access and are cached, so an unexpanded folder
/// reads nothing — VS Code's `getChildren` pattern, the thing that keeps large repos
/// cheap. `reconcile()` re-reads loaded folders against disk, keeping the node identity
/// of surviving entries so the outline's expansion survives a live refresh.
public final class FileNode {
    public let url: URL
    public let isDirectory: Bool
    public let name: String

    private var cachedChildren: [FileNode]?

    public init(url: URL, isDirectory: Bool) {
        self.url = url
        self.isDirectory = isDirectory
        self.name = url.lastPathComponent
    }

    /// Visible, sorted child nodes — read from disk on first call, cached after. Files
    /// have no children. Directories that can't be read (permissions) log loudly and
    /// yield no children rather than crashing the whole tree.
    public func children() -> [FileNode] {
        guard isDirectory else { return [] }
        if let cachedChildren { return cachedChildren }
        let nodes = sortedVisibleEntries(readDirectory(url)).map { FileNode(url: $0.url, isDirectory: $0.isDirectory) }
        cachedChildren = nodes
        return nodes
    }

    /// Re-read this folder against disk and reconcile with the cached children: keep the
    /// existing `FileNode` for any entry whose URL still exists (so `NSOutlineView` keeps
    /// its expansion, which is tracked by object identity), insert new entries, drop
    /// vanished ones. Recurses only into already-loaded subtrees — an unexpanded folder
    /// stays lazy and untouched. No-op for files and for folders never expanded.
    public func reconcile() {
        guard isDirectory, let existing = cachedChildren else { return }
        let surviving = Dictionary(existing.map { ($0.url, $0) }, uniquingKeysWith: { first, _ in first })
        cachedChildren = sortedVisibleEntries(readDirectory(url)).map { entry in
            if let kept = surviving[entry.url] {
                kept.reconcile()
                return kept
            }
            return FileNode(url: entry.url, isDirectory: entry.isDirectory)
        }
    }
}

/// A raw directory entry before it becomes a `FileNode`. Splitting this out lets the
/// ordering/filtering decisions be pure and unit-tested without touching the filesystem.
public struct DirectoryEntry: Equatable {
    public let url: URL
    public let isDirectory: Bool

    public init(url: URL, isDirectory: Bool) {
        self.url = url
        self.isDirectory = isDirectory
    }
}

/// Pure: hide only the VCS internal dir (`.git`) — dotfiles like `.env`/`.gitignore` are
/// shown — then sort directories first and within each group by case-insensitive name, the
/// explorer ordering users expect. No I/O, so it tests directly on constructed entries.
public func sortedVisibleEntries(_ entries: [DirectoryEntry]) -> [DirectoryEntry] {
    entries
        .filter { $0.url.lastPathComponent != ".git" }
        .sorted { lhs, rhs in
            if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
            return lhs.url.lastPathComponent.localizedCaseInsensitiveCompare(rhs.url.lastPathComponent) == .orderedAscending
        }
}

private let fileTreeLogger = Logger(subsystem: "com.example.agentdesk.AgentDeskHost", category: "file-tree")

/// The only I/O: read a directory's immediate entries. An unreadable directory surfaces
/// loudly to the log and returns empty (one bad subtree shouldn't take down the pane).
private func readDirectory(_ url: URL) -> [DirectoryEntry] {
    do {
        let items = try FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        )
        return items.map { item in
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            return DirectoryEntry(url: item, isDirectory: isDir)
        }
    } catch {
        fileTreeLogger.error("read \(url.path, privacy: .public) failed: \(String(describing: error), privacy: .public)")
        return []
    }
}
