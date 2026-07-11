import AgentDeskWire
import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
struct WorkspaceDesktopSwitcherTests {
    /// Builds a DesktopState of user Desktops (type 0) on one display, with `active` current.
    private func desktopState(active: UInt64, display: String = "D1", spaces: [(UInt64, Int)]) -> DesktopState {
        DesktopState(
            displays: [],
            spaces: spaces.map { SpaceMetadata(id: $0.0, displayId: display, index: $0.1, type: 0) },
            activeDisplayId: display,
            activeSpaceId: active
        )
    }

    @Test func currentAssignmentReadsTheActiveUserDesktop() {
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 20, spaces: [(10, 0), (20, 1), (30, 2)]) },
            commit: { _ in }
        )
        #expect(switcher.currentAssignment() == WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1))
    }

    @Test func switchByExactSpaceIdCommitsTheOrdinalDelta() {
        var committed: [Int] = []
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 10, spaces: [(10, 0), (20, 1), (30, 2)]) },
            commit: { committed.append($0) }
        )
        #expect(switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 30, displayID: "D1", ordinal: 2)))
        #expect(committed == [2]) // target ordinal 2 - active ordinal 0
    }

    /// A reboot can renumber Space ids while positions hold; the assignment falls back to display+ordinal.
    @Test func switchFallsBackToDisplayAndOrdinalWhenSpaceIdIsStale() {
        var committed: [Int] = []
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 11, spaces: [(11, 0), (22, 1), (33, 2)]) },
            commit: { committed.append($0) }
        )
        #expect(switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 99, displayID: "D1", ordinal: 1)))
        #expect(committed == [1])
    }

    @Test func switchToTheAlreadyActiveDesktopIsANoOp() {
        var committed: [Int] = []
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 20, spaces: [(10, 0), (20, 1)]) },
            commit: { committed.append($0) }
        )
        #expect(switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)))
        #expect(committed.isEmpty)
    }

    @Test func switchToADesktopOnAnotherDisplayFailsWithoutCommitting() {
        var committed: [Int] = []
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 10, display: "D1", spaces: [(10, 0), (20, 1)]) },
            commit: { committed.append($0) }
        )
        // Assignment targets display D2, but D1 is active: not resolvable, so no switch and no commit.
        #expect(!switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 77, displayID: "D2", ordinal: 0)))
        #expect(committed.isEmpty)
    }

    @Test func desktopsEnumeratesUserSpacesWithTheActiveFlag() {
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 20, spaces: [(10, 0), (20, 1)]) },
            commit: { _ in }
        )
        let desktops = switcher.desktops()
        #expect(desktops.map(\.id) == [10, 20])
        #expect(desktops.first { $0.isActive }?.id == 20)
    }
}
