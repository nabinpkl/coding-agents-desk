import AppKit
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

    @Test func desktopsUsesGlobalMissionControlOrderWithoutChangingDisplayOrdinal() {
        let state = DesktopState(
            displays: [],
            spaces: [
                SpaceMetadata(id: 10, displayId: "D1", index: 0, type: 0),
                SpaceMetadata(id: 11, displayId: "D1", index: 1, type: 0),
                SpaceMetadata(id: 99, displayId: "D1", index: nil, type: 4),
                SpaceMetadata(id: 20, displayId: "D2", index: 0, type: 0),
            ],
            activeDisplayId: "D2",
            activeSpaceId: 20
        )
        let switcher = WorkspaceDesktopSwitcher(state: { state }, commit: { _ in })

        let desktops = switcher.desktops()

        #expect(desktops.map(\.ordinal) == [0])
        #expect(desktops.map(\.missionControlOrdinal) == [2])
    }

    @Test func missionControlNumbersAreGlobalAndOneBasedAcrossDisplays() {
        let state = DesktopState(
            displays: [],
            spaces: [
                SpaceMetadata(id: 10, displayId: "D1", index: 0, type: 0),
                SpaceMetadata(id: 20, displayId: "D1", index: 1, type: 0),
                SpaceMetadata(id: 30, displayId: "D1", index: 2, type: 0),
                SpaceMetadata(id: 40, displayId: "D2", index: 0, type: 0),
            ],
            activeDisplayId: "D2",
            activeSpaceId: 40
        )
        let switcher = WorkspaceDesktopSwitcher(state: { state }, commit: { _ in })

        #expect(switcher.missionControlNumbersBySpaceID() == [10: 1, 20: 2, 30: 3, 40: 4])
    }

    @Test func sidebarBadgeUsesLiveMissionControlNumberInsteadOfInternalOrdinal() throws {
        let workspaceID = UUID()
        let workspace = Workspace(
            id: workspaceID,
            root: URL(fileURLWithPath: "/tmp/project", isDirectory: true),
            name: "Project",
            desktopAssignment: WorkspaceDesktopAssignment(spaceID: 40, displayID: "D2", ordinal: 0)
        )
        let switcher = WorkspaceSwitcher()

        switcher.render(
            workspaces: [workspace],
            activeID: workspaceID,
            missionControlNumbersBySpaceID: [40: 4]
        )

        let badge = try #require(descendant(in: switcher.view, identifier: "workspace-desktop-status") as? NSTextField)
        #expect(badge.stringValue == "D4")
        let row = try #require(descendant(in: switcher.view, identifier: "workspace-\(workspaceID.uuidString)"))
        #expect(row.accessibilityValue() as? String == "active, desktop 4")
    }

    private func descendant(in root: NSView, identifier: String) -> NSView? {
        if root.accessibilityIdentifier() == identifier { return root }
        return root.subviews.lazy.compactMap { descendant(in: $0, identifier: identifier) }.first
    }
}
