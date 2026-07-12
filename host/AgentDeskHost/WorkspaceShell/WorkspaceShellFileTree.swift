import Foundation

struct WorkspaceShellRelativePath: Equatable, Hashable {
    let value: String

    init(_ value: String) throws {
        if value.hasPrefix("/") {
            throw WorkspaceShellFileTreePathError.absolutePath(value)
        }

        let components = value.split(separator: "/", omittingEmptySubsequences: true)
        if components.contains("..") {
            throw WorkspaceShellFileTreePathError.escapesRoot(value)
        }

        self.value = components.filter { $0 != "." }.joined(separator: "/")
    }

    var lastPathComponent: String {
        value.split(separator: "/").last.map(String.init) ?? ""
    }
}

enum WorkspaceShellFileTreePathError: Error, Equatable {
    case absolutePath(String)
    case escapesRoot(String)
}

struct WorkspaceShellDirectoryEntry: Equatable {
    let url: URL
    let isDirectory: Bool
    let isSymbolicLink: Bool

    init(url: URL, isDirectory: Bool, isSymbolicLink: Bool = false) {
        self.url = url
        self.isDirectory = isDirectory
        self.isSymbolicLink = isSymbolicLink
    }
}

protocol WorkspaceShellDirectoryReading: AnyObject {
    func entries(at url: URL) throws -> [WorkspaceShellDirectoryEntry]
}

final class FileManagerWorkspaceShellDirectoryReader: WorkspaceShellDirectoryReading {
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    func entries(at url: URL) throws -> [WorkspaceShellDirectoryEntry] {
        try fileManager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: []
        ).map { item in
            let values = try? item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let isSymbolicLink = values?.isSymbolicLink ?? false
            return WorkspaceShellDirectoryEntry(
                url: item.standardizedFileURL,
                isDirectory: !isSymbolicLink && (values?.isDirectory ?? false),
                isSymbolicLink: isSymbolicLink
            )
        }
    }
}

enum WorkspaceShellFileTreeEntryRejection: Equatable {
    case outsideRoot(URL)
    case notDirectChild(URL)
}

final class WorkspaceShellFileTree {
    let workspaceID: UUID

    private let rootURL: URL
    private let reader: WorkspaceShellDirectoryReading
    private let onReadFailure: (WorkspaceShellRelativePath, Error) -> Void
    private let onRejectedEntry: (WorkspaceShellFileTreeEntryRejection) -> Void
    lazy var rootNode: WorkspaceShellFileNode = WorkspaceShellFileNode(
        tree: self,
        // safe: the empty string is the root's relative path and can never trip the
        // absolute-prefix or `..` checks in WorkspaceShellRelativePath.
        relativePath: try! WorkspaceShellRelativePath(""),
        name: rootURL.lastPathComponent,
        isDirectory: true,
        isSymbolicLink: false
    )

    init(
        workspaceID: UUID,
        root: URL,
        reader: WorkspaceShellDirectoryReading,
        onReadFailure: @escaping (WorkspaceShellRelativePath, Error) -> Void = { _, _ in },
        onRejectedEntry: @escaping (WorkspaceShellFileTreeEntryRejection) -> Void = { _ in }
    ) {
        self.workspaceID = workspaceID
        rootURL = root.standardizedFileURL
        self.reader = reader
        self.onReadFailure = onReadFailure
        self.onRejectedEntry = onRejectedEntry
    }

    func relativePath(for value: String) throws -> WorkspaceShellRelativePath {
        try WorkspaceShellRelativePath(value)
    }

    fileprivate func children(of parent: WorkspaceShellFileNode) -> [WorkspaceShellFileNode] {
        guard parent.isDirectory else { return [] }
        let parentURL = url(for: parent.relativePath)
        let entries: [WorkspaceShellDirectoryEntry]
        do {
            entries = try reader.entries(at: parentURL)
        } catch {
            onReadFailure(parent.relativePath, error)
            return []
        }

        return entries.compactMap { entry in
            guard let relativePath = relativePath(forEntryURL: entry.url) else {
                onRejectedEntry(.outsideRoot(entry.url.standardizedFileURL))
                return nil
            }
            guard relativePath.parent == parent.relativePath, !relativePath.value.isEmpty else {
                onRejectedEntry(.notDirectChild(entry.url.standardizedFileURL))
                return nil
            }
            guard relativePath.lastPathComponent != ".git" else { return nil }
            return WorkspaceShellFileNode(
                tree: self,
                relativePath: relativePath,
                name: relativePath.lastPathComponent,
                isDirectory: entry.isDirectory && !entry.isSymbolicLink,
                isSymbolicLink: entry.isSymbolicLink
            )
        }.sorted(by: Self.isOrderedBefore)
    }

    fileprivate func url(for relativePath: WorkspaceShellRelativePath) -> URL {
        guard !relativePath.value.isEmpty else { return rootURL }
        return rootURL.appendingPathComponent(relativePath.value, isDirectory: false)
    }

    private func relativePath(forEntryURL url: URL) -> WorkspaceShellRelativePath? {
        let entryURL = url.standardizedFileURL
        let rootPath = rootURL.path.hasSuffix("/") ? String(rootURL.path.dropLast()) : rootURL.path
        let entryPath = entryURL.path
        guard entryPath.hasPrefix(rootPath + "/") else { return nil }
        return try? WorkspaceShellRelativePath(String(entryPath.dropFirst(rootPath.count + 1)))
    }

    private static func isOrderedBefore(_ lhs: WorkspaceShellFileNode, _ rhs: WorkspaceShellFileNode) -> Bool {
        if lhs.isDirectory != rhs.isDirectory {
            return lhs.isDirectory
        }
        // Case-insensitive and locale-independent: a POSIX locale here forces C-collation that
        // defeats the case-insensitive flag (uppercase would sort before lowercase). Directories
        // and files are ordered the same way as the POSIX directory listing.
        let names = lhs.name.caseInsensitiveCompare(rhs.name)
        if names != .orderedSame {
            return names == .orderedAscending
        }
        return lhs.relativePath.value < rhs.relativePath.value
    }
}

final class WorkspaceShellFileNode {
    let relativePath: WorkspaceShellRelativePath
    let name: String
    let isDirectory: Bool
    let isSymbolicLink: Bool

    private weak var tree: WorkspaceShellFileTree?
    private var cachedChildren: [WorkspaceShellFileNode]?

    fileprivate init(
        tree: WorkspaceShellFileTree,
        relativePath: WorkspaceShellRelativePath,
        name: String,
        isDirectory: Bool,
        isSymbolicLink: Bool
    ) {
        self.tree = tree
        self.relativePath = relativePath
        self.name = name
        self.isDirectory = isDirectory
        self.isSymbolicLink = isSymbolicLink
    }

    func children() -> [WorkspaceShellFileNode] {
        guard isDirectory else { return [] }
        guard let tree else {
            // The owning WorkspaceShellFileTree was released while a node from it is still in use.
            // `tree` is weak to avoid a tree<->node cycle, so a caller that keeps only the rootNode
            // (not the tree) hits this and would otherwise see a silently-empty tree. Fail loud in
            // debug so the retention mistake is caught, not shipped as a blank file pane.
            assertionFailure("WorkspaceShellFileNode.children() after its owning WorkspaceShellFileTree was released; retain the tree, not just its rootNode")
            return []
        }
        if let cachedChildren { return cachedChildren }
        let children = tree.children(of: self)
        cachedChildren = children
        return children
    }

    func refreshLoadedChildren() {
        guard isDirectory, let tree, let existingChildren = cachedChildren else { return }
        let existingByPath = Dictionary(existingChildren.map { ($0.relativePath, $0) }, uniquingKeysWith: { first, _ in first })
        cachedChildren = tree.children(of: self).map { child in
            if let existing = existingByPath[child.relativePath], existing.isDirectory == child.isDirectory,
               existing.isSymbolicLink == child.isSymbolicLink {
                existing.refreshLoadedChildren()
                return existing
            }
            return child
        }
    }

}

private extension WorkspaceShellRelativePath {
    var parent: WorkspaceShellRelativePath {
        let components = value.split(separator: "/", omittingEmptySubsequences: true)
        // safe: dropping a trailing component from an already-validated relative path yields a
        // shorter relative path, which cannot introduce an absolute prefix or a `..` segment.
        return try! WorkspaceShellRelativePath(components.dropLast().joined(separator: "/"))
    }
}
