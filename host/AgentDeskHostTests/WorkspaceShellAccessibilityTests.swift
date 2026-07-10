import Foundation
import Testing

@testable import AgentDeskHost

struct WorkspaceShellAccessibilityTests {
    @Test func identifiersAreStableAndNamespaced() {
        let workspaceID = UUID(uuidString: "6CE4FD88-46A2-41C0-985A-6B5ED1E7F0F0")!
        let relativePath = try! WorkspaceShellRelativePath("Sources/App.swift")

        #expect(WorkspaceShellAccessibilityIdentifier.sidebar == "agentdesk-workspace-shell-sidebar")
        #expect(WorkspaceShellAccessibilityIdentifier.topBar == "agentdesk-workspace-shell-top-bar")
        #expect(WorkspaceShellAccessibilityIdentifier.filePane == "agentdesk-workspace-shell-file-pane")
        #expect(
            WorkspaceShellAccessibilityIdentifier.fileRow(workspaceID: workspaceID, relativePath: relativePath)
                == "agentdesk-workspace-shell-file-row-6CE4FD88-46A2-41C0-985A-6B5ED1E7F0F0-Sources/App.swift"
        )
    }
}
