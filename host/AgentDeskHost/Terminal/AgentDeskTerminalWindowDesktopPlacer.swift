import TerminalEmulator
import WindowPlacement

@MainActor
final class AgentDeskTerminalWindowDesktopPlacer: TerminalWindowDesktopPlacing {
    private let coordinator: DesktopWindowPlacementCoordinator

    init(coordinator: DesktopWindowPlacementCoordinator) {
        self.coordinator = coordinator
    }

    func present(
        _ window: any TerminalWindowPresentationTrackable,
        at placement: DesktopWindowPlacement,
        focus: Bool
    ) throws -> DesktopWindowPlacement {
        window.prepareForAssignedDesktop(into: placement.frame)
        guard let windowID = window.assignedDesktopWindowID else {
            throw DesktopWindowPlacementError.windowNumberUnavailable
        }
        let resolved = try coordinator.restore(
            placement,
            windowID: windowID,
            applyFrame: { window.place(into: $0) }
        )
        window.revealAfterAssignedDesktop(into: resolved.frame, focus: focus)
        try coordinator.verify(windowID: windowID, targetSpaceID: resolved.desktop.spaceID)
        return resolved
    }

    func capture(
        _ window: any TerminalWindowPresentationTrackable,
        preserving _: DesktopWindowPlacement
    ) throws -> DesktopWindowPlacement? {
        guard let windowID = window.assignedDesktopWindowID else {
            throw DesktopWindowPlacementError.windowNumberUnavailable
        }
        return try coordinator.capture(windowID: windowID, frame: window.currentFrame)
    }
}
