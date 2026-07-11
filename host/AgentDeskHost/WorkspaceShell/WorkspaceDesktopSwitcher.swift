import AgentDeskWire
import Foundation

/// Switches the macOS Desktop (Space) to a workspace's assigned Desktop by driving AgentDesk's
/// existing Spaces control (ADR-0054). The agent-workspace-ide donor synthesized Dock-swipe CGEvents
/// and polled SkyLight because it had no Spaces provider; AgentDesk already owns one with a verified
/// direct space-set, so this computes the ordinal delta to the target Desktop and reuses its
/// relative-step switch. The `state`/`commit` seams (backed by `SpacesProvider`) keep the pure
/// ordinal math unit-testable.
@MainActor
final class WorkspaceDesktopSwitcher {
    private let state: () -> DesktopState?
    private let commit: (Int) -> Void

    init(state: @escaping () -> DesktopState?, commit: @escaping (Int) -> Void) {
        self.state = state
        self.commit = commit
    }

    /// Convenience for production wiring over the host's SpacesProvider.
    convenience init(spaces: SpacesProvider) {
        self.init(state: { spaces.current() }, commit: { spaces.commitStep(delta: $0) })
    }

    /// The Desktop currently active, as a workspace assignment. Nil when unavailable or the active
    /// Space is not a user Desktop.
    func currentAssignment() -> WorkspaceDesktopAssignment? {
        guard let state = state(),
              let activeDisplayId = state.activeDisplayId,
              let activeSpaceId = state.activeSpaceId
        else { return nil }
        let userSpaces = userSpaces(on: activeDisplayId, in: state)
        guard let ordinal = userSpaces.firstIndex(where: { $0.id == activeSpaceId }) else { return nil }
        return WorkspaceDesktopAssignment(spaceID: activeSpaceId, displayID: activeDisplayId, ordinal: ordinal)
    }

    /// The live user Desktops on the active display, for the switcher / audit.
    func desktops() -> [WorkspaceDesktop] {
        guard let state = state(), let activeDisplayId = state.activeDisplayId else { return [] }
        return userSpaces(on: activeDisplayId, in: state).enumerated().map { ordinal, space in
            WorkspaceDesktop(
                id: space.id, displayID: space.displayId, ordinal: ordinal,
                isActive: space.id == state.activeSpaceId
            )
        }
    }

    /// True when the assignment's Desktop is already the active one (skip the switch).
    func isActive(_ assignment: WorkspaceDesktopAssignment) -> Bool {
        currentAssignment().map { assignment.matches($0) } ?? false
    }

    /// Switch to the assignment's Desktop. Returns false when it can't be resolved on the currently
    /// active display (e.g. the workspace is assigned to a Desktop on another monitor). The switch
    /// itself is async (the Space animates) inside the injected `commit`.
    @discardableResult
    func switchToDesktop(_ assignment: WorkspaceDesktopAssignment) -> Bool {
        guard let state = state(),
              let activeDisplayId = state.activeDisplayId,
              let activeSpaceId = state.activeSpaceId
        else { return false }
        let userSpaces = userSpaces(on: activeDisplayId, in: state)
        guard let activeOrdinal = userSpaces.firstIndex(where: { $0.id == activeSpaceId }) else { return false }
        // Resolve the target ordinal: exact spaceID match wins; else display+ordinal fallback (a
        // reboot can renumber Space ids while positions hold), matching WorkspaceDesktopAssignment.
        let targetOrdinal = userSpaces.firstIndex(where: { $0.id == assignment.spaceID })
            ?? (assignment.displayID == activeDisplayId ? assignment.ordinal : nil)
        guard let targetOrdinal, userSpaces.indices.contains(targetOrdinal) else { return false }
        let delta = targetOrdinal - activeOrdinal
        guard delta != 0 else { return true }
        commit(delta)
        return true
    }

    private func userSpaces(on displayId: String, in state: DesktopState) -> [SpaceMetadata] {
        state.spaces
            .filter { $0.displayId == displayId && $0.type == 0 && $0.index != nil }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
    }
}
