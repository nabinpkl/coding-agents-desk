import Foundation

enum WorkspaceShellAccessibilityIdentifier {
    static let sidebar = "agentdesk-workspace-shell-sidebar"
    static let topBar = "agentdesk-workspace-shell-top-bar"
    static let filePane = "agentdesk-workspace-shell-file-pane"

    static func fileRow(workspaceID: UUID, relativePath: WorkspaceShellRelativePath) -> String {
        "agentdesk-workspace-shell-file-row-\(workspaceID.uuidString)-\(relativePath.value)"
    }
}
