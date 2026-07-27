import Foundation
import PtyTerminalWebView

/// Remembers each workspace's terminal layout - its tabs, splits and the session each pane is
/// attached to - so reopening the IDE window or switching back to a workspace restores the
/// terminals that were there, instead of a single fresh shell.
struct WorkspaceIDETerminalWorkspaceStore {
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load(workspaceID: UUID) -> PtyTerminalWorkspaceState? {
        guard let data = defaults.data(forKey: Self.key(workspaceID)),
              let state = try? decoder.decode(PtyTerminalWorkspaceState.self, from: data),
              state.profile == .workspace else { return nil }
        return state
    }

    func save(_ state: PtyTerminalWorkspaceState, workspaceID: UUID) {
        guard let data = try? encoder.encode(state) else { return }
        defaults.set(data, forKey: Self.key(workspaceID))
    }

    private static func key(_ workspaceID: UUID) -> String {
        "agentDesk.workspaceIDE.terminalWorkspace.\(workspaceID.uuidString)"
    }
}
