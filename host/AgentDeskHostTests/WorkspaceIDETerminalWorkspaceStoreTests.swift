import Foundation
import PtyTerminalWebView
import Testing

@testable import AgentDeskHost

struct WorkspaceIDETerminalWorkspaceStoreTests {
    @Test func eachWorkspaceRestoresItsOwnTabsAndSplits() throws {
        let suite = "workspace-ide-terminal-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WorkspaceIDETerminalWorkspaceStore(windowID: UUID(), defaults: defaults)
        let workspaceID = UUID()
        var state = PtyTerminalWorkspaceState(profile: .workspace)
        #expect(state.addTab() != nil)
        #expect(state.splitFocusedPane(axis: .horizontal) != nil)

        store.save(state, workspaceID: workspaceID)

        #expect(store.load(workspaceID: workspaceID) == state)
        #expect(store.load(workspaceID: UUID()) == nil)
    }

    @Test func aSingleSessionLayoutIsNeverRestoredIntoTheWorkspacePane() throws {
        let suite = "workspace-ide-terminal-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WorkspaceIDETerminalWorkspaceStore(windowID: UUID(), defaults: defaults)
        let workspaceID = UUID()

        store.save(PtyTerminalWorkspaceState(profile: .singleSession), workspaceID: workspaceID)

        // `restoreWorkspaceState` drops a non-workspace profile on the floor, which would leave the
        // pane with no layout at all; treat it as absent so a fresh workspace is built instead.
        #expect(store.load(workspaceID: workspaceID) == nil)
    }

    @Test func separateIDEWindowsKeepIndependentLayoutsForSameWorkspace() throws {
        let suite = "workspace-ide-terminal-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let workspaceID = UUID()
        let first = WorkspaceIDETerminalWorkspaceStore(windowID: UUID(), defaults: defaults)
        let second = WorkspaceIDETerminalWorkspaceStore(windowID: UUID(), defaults: defaults)
        var firstState = PtyTerminalWorkspaceState(profile: .workspace)
        #expect(firstState.addTab() != nil)
        let secondState = PtyTerminalWorkspaceState(profile: .workspace)

        first.save(firstState, workspaceID: workspaceID)
        second.save(secondState, workspaceID: workspaceID)

        #expect(first.load(workspaceID: workspaceID) == firstState)
        #expect(second.load(workspaceID: workspaceID) == secondState)

        first.removeAll()

        #expect(first.load(workspaceID: workspaceID) == nil)
        #expect(second.load(workspaceID: workspaceID) == secondState)
    }
}
