import AgentDeskWire
import Foundation

public struct WorkspaceMonitorPresentation: Equatable {
    public let badge: String
    public let accessibilityValue: String

    public init(badge: String, accessibilityValue: String) {
        self.badge = badge
        self.accessibilityValue = accessibilityValue
    }
}

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

    /// Live, human-facing Desktop numbers in Mission Control order. These are deliberately derived
    /// for each render instead of persisted because display topology and Space ordering can change.
    func missionControlNumbersBySpaceID() -> [UInt64: Int] {
        guard let state = state() else { return [:] }
        var numbers: [UInt64: Int] = [:]
        var nextNumber = 1
        for space in state.spaces where space.type == 0 {
            numbers[space.id] = nextNumber
            nextNumber += 1
        }
        return numbers
    }

    /// Live monitor markers for workspace rows. The primary monitor is always P. A single
    /// secondary is S; multiple secondaries are numbered in the display order reported by SkyLight.
    func monitorPresentationsByDisplayID() -> [String: WorkspaceMonitorPresentation] {
        guard let state = state() else { return [:] }
        let secondaryCount = state.displays.filter { !$0.isMain }.count
        var secondaryNumber = 0
        var presentations: [String: WorkspaceMonitorPresentation] = [:]
        for display in state.displays {
            if display.isMain {
                presentations[display.id] = WorkspaceMonitorPresentation(
                    badge: "P",
                    accessibilityValue: "primary monitor"
                )
                continue
            }
            secondaryNumber += 1
            let suffix = secondaryCount > 1 ? "\(secondaryNumber)" : ""
            presentations[display.id] = WorkspaceMonitorPresentation(
                badge: "S\(suffix)",
                accessibilityValue: secondaryCount > 1
                    ? "secondary monitor \(secondaryNumber)"
                    : "secondary monitor"
            )
        }
        return presentations
    }

    /// The live user Desktops on the active display, for the switcher / audit.
    func desktops() -> [WorkspaceDesktop] {
        guard let state = state(), let activeDisplayId = state.activeDisplayId else { return [] }
        let userSpaces = userSpaces(on: activeDisplayId, in: state)
        let missionControlOrdinals = Dictionary(uniqueKeysWithValues:
            state.spaces
                .filter { $0.type == 0 }
                .enumerated()
                .map { ($0.element.id, $0.offset) }
        )
        guard userSpaces.allSatisfy({ missionControlOrdinals[$0.id] != nil }) else { return [] }
        return userSpaces.enumerated().map { ordinal, space in
            WorkspaceDesktop(
                id: space.id,
                displayID: space.displayId,
                ordinal: ordinal,
                missionControlOrdinal: missionControlOrdinals[space.id]!,
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
        // Space id64 is the identity. Display and ordinal are presentation coordinates only; using
        // them as a fallback can silently route an unresolved assignment to a different Desktop.
        let targetOrdinal = userSpaces.firstIndex(where: { $0.id == assignment.spaceID })
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
