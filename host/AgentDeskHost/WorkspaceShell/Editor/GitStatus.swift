import Foundation

/// The git state of a single path, in the form the sidebar decorates with. A separate
/// layer from `FileNode` (VS Code's model): the filesystem tree stays pure, and this
/// overlays colour/badge on top, so neither owns the other's concern.
public enum GitFileStatus: Sendable {
    case conflicted
    case modified
    case added
    case deleted
    case untracked
    case ignored

    /// Rank used to pick one status for a folder from its descendants (highest wins) and
    /// to collapse a two-letter porcelain code (`MM`, ` D`) to its strongest meaning.
    var severity: Int {
        switch self {
        case .conflicted: return 5
        case .modified: return 4
        case .added: return 3
        case .deleted: return 2
        case .untracked: return 1
        case .ignored: return 0
        }
    }
}

/// A snapshot of a repo's working-tree status: every changed path mapped to its status.
/// `Sendable` so the reader can compute it off-main and hand it to the UI. Keys are
/// symlink-resolved absolute URLs so they match the `FileNode` URLs the tree was built
/// from (on macOS `/tmp` vs `/private/tmp` would otherwise miss).
public struct GitStatus: Sendable {
    public let byPath: [URL: GitFileStatus]

    /// Path prefixes of ignored entries (each ignored path + "/"), so an ignored folder's
    /// descendants inherit the ignored decoration even though git collapses the folder to a
    /// single entry. Precomputed once so per-row decoration stays cheap.
    private let ignoredPrefixes: [String]

    public init(byPath: [URL: GitFileStatus]) {
        self.byPath = byPath
        self.ignoredPrefixes = byPath.compactMap { $0.value == .ignored ? $0.key.path + "/" : nil }
    }

    public static let empty = GitStatus(byPath: [:])

    /// Working-tree **changes** only — everything except ignored. The Source Control list
    /// and its count show these; ignored paths live in `byPath` solely to grey the tree.
    public var changes: [URL: GitFileStatus] {
        byPath.filter { $0.value != .ignored }
    }

    /// The decoration for a tree row. Ignored propagates **down**: an ignored path, or
    /// anything inside an ignored folder, reads ignored (greyed). Otherwise a file gets its
    /// own status and a folder gets the **highest-severity** status among its (non-ignored)
    /// descendants — propagating up to a collapsed parent, as in VS Code. `nil` when nothing
    /// under it changed.
    public func decoration(for url: URL, isDirectory: Bool) -> GitFileStatus? {
        let key = url.resolvingSymlinksInPath()
        if byPath[key] == .ignored || ignoredPrefixes.contains(where: { key.path.hasPrefix($0) }) {
            return .ignored
        }
        if !isDirectory { return byPath[key] }
        let prefix = key.path.hasSuffix("/") ? key.path : key.path + "/"
        return byPath
            .filter { $0.value != .ignored && $0.key.path.hasPrefix(prefix) }
            .map(\.value)
            .max { $0.severity < $1.severity }
    }
}

/// Pure: parse `git status --porcelain=v1 -z --untracked-files=all` into path → status.
/// `-z` is NUL-delimited (no quoting/escaping of odd filenames) and renames emit the new
/// path then the original as a second field — we keep the new, skip the original. Paths
/// are repo-relative, resolved against `repoRoot`. No I/O, so it unit-tests on canned text.
public func parsePorcelain(_ output: String, repoRoot: URL) -> [URL: GitFileStatus] {
    var byPath: [URL: GitFileStatus] = [:]
    let fields = output.split(separator: "\0", omittingEmptySubsequences: true).map(String.init)
    var index = 0
    while index < fields.count {
        let field = fields[index]
        index += 1
        guard field.count >= 3 else { continue }
        let code = String(field.prefix(2))
        var path = String(field.dropFirst(3))  // 2 status chars + 1 space
        // An ignored directory is reported collapsed with a trailing slash (`.build/`);
        // drop it so the key matches the slash-free FileNode URL for the same folder.
        if path.hasSuffix("/") { path.removeLast() }
        // A rename/copy carries the original path as the next NUL field; consume it.
        if code.contains("R") || code.contains("C") { index += 1 }
        guard let status = gitFileStatus(forCode: code) else { continue }
        let url = repoRoot.appendingPathComponent(path).resolvingSymlinksInPath()
        byPath[url] = status
    }
    return byPath
}

/// Collapse a porcelain XY code to a single status. Unmerged combinations are conflicts;
/// otherwise the stronger of the index (X) and worktree (Y) letters wins.
func gitFileStatus(forCode code: String) -> GitFileStatus? {
    switch code {
    case "??": return .untracked
    case "!!": return .ignored
    case "DD", "AU", "UD", "UA", "DU", "AA", "UU": return .conflicted
    default:
        return code.compactMap(status(forLetter:)).max { $0.severity < $1.severity }
    }
}

private func status(forLetter letter: Character) -> GitFileStatus? {
    switch letter {
    case "M", "R", "C", "T": return .modified
    case "A": return .added
    case "D": return .deleted
    case "U": return .conflicted
    default: return nil  // ' ', '?', '!' handled by the code-level switch
    }
}
