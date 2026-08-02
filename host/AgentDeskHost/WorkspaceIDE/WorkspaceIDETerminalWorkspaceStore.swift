import Foundation
import OSLog
import PtyTerminalWebView

/// Remembers each workspace's terminal layout - its tabs, splits and the session each pane is
/// attached to - so reopening the IDE window or switching back to a workspace restores the
/// terminals that were there, instead of a single fresh shell.
struct WorkspaceIDETerminalWorkspaceStore {
    private let defaults: UserDefaults
    private let windowID: UUID
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window")

    init(windowID: UUID, defaults: UserDefaults = .standard) {
        self.windowID = windowID
        self.defaults = defaults
    }

    func load(workspaceID: UUID) -> PtyTerminalWorkspaceState? {
        guard let data = defaults.data(forKey: key(workspaceID)) else { return nil }
        do {
            let state = try decoder.decode(PtyTerminalWorkspaceState.self, from: data)
            return state.profile == .workspace ? state : nil
        } catch {
            logger.error("Workspace IDE terminal layout did not decode: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    func save(_ state: PtyTerminalWorkspaceState, workspaceID: UUID) {
        do {
            defaults.set(try encoder.encode(state), forKey: key(workspaceID))
        } catch {
            logger.error("Workspace IDE terminal layout did not encode: \(String(describing: error), privacy: .public)")
        }
    }

    func removeAll() {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(keyPrefix) {
            defaults.removeObject(forKey: key)
        }
    }

    private func key(_ workspaceID: UUID) -> String {
        "\(keyPrefix)\(workspaceID.uuidString)"
    }

    private var keyPrefix: String {
        "agentDesk.workspaceIDE.window.\(windowID.uuidString).terminalWorkspace."
    }
}
