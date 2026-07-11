import Foundation

/// Minimal accessibility row descriptors the file pane and source-control views expose (ported from
/// the agent-workspace-ide donor). The full donor ShellAccessibilityBridge command surface is not
/// ported; these value types keep FilePane's `accessibilityRows()` intact.
struct ShellAccessibilityFileRow {
    let url: URL
    let name: String
    let isDirectory: Bool
    let level: Int
}

struct ShellAccessibilityChangeRow {
    let url: URL
    let relativePath: String
    let status: GitFileStatus
}
