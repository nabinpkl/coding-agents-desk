import AgentDeskWire
import Foundation

/// Switches the macOS Desktop (Space) to a workspace's assigned Desktop by driving AgentDesk's
/// existing `SpacesProvider` (ADR-0054). The agent-workspace-ide donor synthesized Dock-swipe
/// CGEvents and polled SkyLight because it had no Spaces provider; AgentDesk already owns one with a
/// verified direct space-set, so this computes the ordinal delta to the target Desktop and reuses
/// `SpacesProvider.commitStep`. Read-side (`currentAssignment`, `desktops`) reads `current()`.
@MainActor
final class WorkspaceDesktopSwitcher {
    private let spaces: SpacesProvider

    init(spaces: SpacesProvider) {
        self.spaces = spaces
    }

    /// The Desktop currently active, as a workspace assignment. Nil when unavailable or the active
    /// Space is not a user Desktop.
    func currentAssignment() -> WorkspaceDesktopAssignment? {
        guard let state = spaces.current(),
              let activeDisplayId = state.activeDisplayId,
              let activeSpaceId = state.activeSpaceId
        else { return nil }
        let userSpaces = userSpaces(on: activeDisplayId, in: state)
        guard let ordinal = userSpaces.firstIndex(where: { $0.id == activeSpaceId }) else { return nil }
        return WorkspaceDesktopAssignment(spaceID: activeSpaceId, displayID: activeDisplayId, ordinal: ordinal)
    }

    /// The live user Desktops on the active display, for the switcher / audit.
    func desktops() -> [WorkspaceDesktop] {
        guard let state = spaces.current(), let activeDisplayId = state.activeDisplayId else { return [] }
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

    /// Switch to the assignment's Desktop. Returns false when it can't be resolved on the current
    /// display. The switch itself is async (the Space animates) inside `SpacesProvider.commitStep`.
    @discardableResult
    func switchToDesktop(_ assignment: WorkspaceDesktopAssignment) -> Bool {
        guard let state = spaces.current(),
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
        spaces.commitStep(delta: delta)
        return true
    }

    private func userSpaces(on displayId: String, in state: DesktopState) -> [SpaceMetadata] {
        state.spaces
            .filter { $0.displayId == displayId && $0.type == 0 && $0.index != nil }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
    }
}
