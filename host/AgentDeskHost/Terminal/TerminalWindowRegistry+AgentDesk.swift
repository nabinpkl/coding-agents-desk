import Foundation
import OSLog
import TerminalEmulator

extension TerminalWindowRegistry {
    @MainActor
    convenience init(placementCoordinator: DesktopWindowPlacementCoordinator) {
        self.init(
            store: TerminalWindowPresentationStore(
                url: Config.terminalWindowPresentationsURL,
                loggerSubsystem: Config.logSubsystem
            ),
            client: PtyManagerSocketClient.makeClient(),
            spawn: WebPtyManagerTerminalSpawn(client: PtyManagerSocketClient.makeClient()),
            desktopPlacer: AgentDeskTerminalWindowDesktopPlacer(
                coordinator: placementCoordinator
            ),
            loggerSubsystem: Config.logSubsystem
        )
    }

    /// The open Terminal windows in the shape the top bar's chooser lists every family in.
    ///
    /// Ordered by Desktop and then by the window's place in that workspace's cascade, because the
    /// registry answers in no particular order and a list that reshuffled between openings would move
    /// the row under the pointer between the moment it is read and the moment it is clicked.
    @MainActor
    var openWorkspaceWindows: [WorkspaceWindowSummary] {
        openWindowPresentations
            .map { descriptor in
                WorkspaceWindowSummary(
                    id: descriptor.id,
                    kind: .terminal,
                    desktopOrdinal: descriptor.placement.desktop.ordinal,
                    cascadeOrdinal: descriptor.cascadeOrdinal
                )
            }
            .sorted { left, right in
                (left.desktopOrdinal, left.cascadeOrdinal, left.id.uuidString)
                    < (right.desktopOrdinal, right.cascadeOrdinal, right.id.uuidString)
            }
    }

    /// Brings one listed Terminal window to the user, through the reveal every family shares. The
    /// Desktop is read here rather than inside the registry, which is host-agnostic and has no Spaces
    /// authority of its own.
    @MainActor
    func focusWorkspaceWindow(id: UUID, activateDesktop: DesktopActivating?) {
        guard let descriptor = openWindowPresentations.first(where: { $0.id == id }) else { return }
        WorkspaceWindowReveal.reveal(
            desktop: descriptor.placement.desktop,
            activateDesktop: activateDesktop,
            logger: Logger(subsystem: Config.logSubsystem, category: "terminal-window"),
            family: "terminal-window"
        ) { [weak self] in
            // Re-resolved rather than captured: the registry drops the window if it closed while the
            // Desktop was still arriving, and raising by id is then a no-op instead of a resurrection.
            self?.raiseWindow(id: id)
        }
    }
}
