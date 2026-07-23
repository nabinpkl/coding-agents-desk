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

/// Switches the macOS Desktop (Space) to a workspace's assigned Desktop through AgentDesk's existing
/// Dock-gesture control (ADR-0054). Workspace assignments identify an exact display and Space; the
/// switcher reads that display's own current Space and computes the relative gesture within it.
@MainActor
final class WorkspaceDesktopSwitcher {
    private let state: () -> DesktopState?
    private let currentSpaceID: (_ displayID: String) -> UInt64?
    private let commit: (_ delta: Int, _ displayID: String) -> Bool

    init(
        state: @escaping () -> DesktopState?,
        currentSpaceID: @escaping (_ displayID: String) -> UInt64?,
        commit: @escaping (_ delta: Int, _ displayID: String) -> Bool
    ) {
        self.state = state
        self.currentSpaceID = currentSpaceID
        self.commit = commit
    }

    /// Convenience for production wiring over the host's SpacesProvider.
    convenience init(spaces: SpacesProvider) {
        self.init(
            state: { spaces.current() },
            currentSpaceID: { spaces.currentSpaceID(on: $0) },
            commit: { spaces.commitWorkspaceStep(delta: $0, displayId: $1) }
        )
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

    /// Switch to the assignment's exact display and Space through Dock's gesture state machine.
    /// Returns false when the target or that display's current user Desktop cannot be resolved.
    @discardableResult
    func switchToDesktop(_ assignment: WorkspaceDesktopAssignment) -> Bool {
        guard let state = state(),
              let currentSpaceID = currentSpaceID(assignment.displayID)
        else { return false }
        let userSpaces = userSpaces(on: assignment.displayID, in: state)
        guard let currentIndex = userSpaces.firstIndex(where: { $0.id == currentSpaceID }),
              let targetIndex = userSpaces.firstIndex(where: { $0.id == assignment.spaceID })
        else { return false }
        let delta = targetIndex - currentIndex
        guard delta != 0 else { return true }
        return commit(delta, assignment.displayID)
    }

    private func userSpaces(on displayId: String, in state: DesktopState) -> [SpaceMetadata] {
        state.spaces
            .filter { $0.displayId == displayId && $0.type == 0 && $0.index != nil }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
    }
}
