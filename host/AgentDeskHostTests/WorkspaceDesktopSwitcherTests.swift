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
            currentSpaceID: { _ in 20 },
            commit: { _, _ in true }
        )
        #expect(switcher.currentAssignment() == WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1))
    }

    @Test func switchByExactSpaceIdCommitsTheAssignedDisplayDelta() {
        var committedDelta: Int?
        var committedDisplayID: String?
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 10, spaces: [(10, 0), (20, 1), (30, 2)]) },
            currentSpaceID: { _ in 10 },
            commit: {
                committedDelta = $0
                committedDisplayID = $1
                return true
            }
        )
        #expect(switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 30, displayID: "D1", ordinal: 2)))
        #expect(committedDelta == 2)
        #expect(committedDisplayID == "D1")
    }

    @Test func switchRefusesAStaleSpaceIdEvenWhenItsOldOrdinalStillExists() {
        var committedDelta: Int?
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 11, spaces: [(11, 0), (22, 1), (33, 2)]) },
            currentSpaceID: { _ in 11 },
            commit: { delta, _ in
                committedDelta = delta
                return true
            }
        )
        #expect(!switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 99, displayID: "D1", ordinal: 1)))
        #expect(committedDelta == nil)
    }

    @Test func switchToTheAlreadyActiveDesktopIsANoOp() {
        var committedDelta: Int?
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 20, spaces: [(10, 0), (20, 1)]) },
            currentSpaceID: { _ in 20 },
            commit: { delta, _ in
                committedDelta = delta
                return true
            }
        )
        #expect(switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)))
        #expect(committedDelta == nil)
    }

    @Test func switchToADesktopOnAnotherDisplayUsesThatDisplaysCurrentSpace() {
        let state = DesktopState(
            displays: [],
            spaces: [
                SpaceMetadata(id: 10, displayId: "D1", index: 0, type: 0),
                SpaceMetadata(id: 66, displayId: "D2", index: 0, type: 0),
                SpaceMetadata(id: 77, displayId: "D2", index: 1, type: 0),
            ],
            activeDisplayId: "D1",
            activeSpaceId: 10
        )
        var committedDelta: Int?
        var committedDisplayID: String?
        let switcher = WorkspaceDesktopSwitcher(
            state: { state },
            currentSpaceID: { displayID in displayID == "D2" ? 66 : 10 },
            commit: {
                committedDelta = $0
                committedDisplayID = $1
                return true
            }
        )
        #expect(switcher.switchToDesktop(WorkspaceDesktopAssignment(spaceID: 77, displayID: "D2", ordinal: 1)))
        #expect(committedDelta == 1)
        #expect(committedDisplayID == "D2")
    }

    @Test func confirmedSwitchWaitsForTheExactStableSpaceId() async throws {
        var currentSpaceID: UInt64 = 10
        var waitCalls: [(UInt64, String)] = []
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: currentSpaceID, spaces: [(10, 0), (20, 1)]) },
            currentSpaceID: { _ in currentSpaceID },
            commit: { _, _ in true },
            waitForCurrentSpace: { targetSpaceID, displayID in
                waitCalls.append((targetSpaceID, displayID))
                currentSpaceID = targetSpaceID
                return true
            }
        )

        let result = try await switcher.switchToDesktopAndWait(spaceID: 20, displayID: "D1")

        #expect(result == .reached)
        #expect(waitCalls.count == 1)
        #expect(waitCalls.first?.0 == 20)
        #expect(waitCalls.first?.1 == "D1")
    }

    @Test func confirmedSwitchDistinguishesRejectionAndTimeout() async throws {
        let rejected = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 10, spaces: [(10, 0), (20, 1)]) },
            currentSpaceID: { _ in 10 },
            commit: { _, _ in false },
            waitForCurrentSpace: { _, _ in true }
        )
        let timedOut = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 10, spaces: [(10, 0), (20, 1)]) },
            currentSpaceID: { _ in 10 },
            commit: { _, _ in true },
            waitForCurrentSpace: { _, _ in false }
        )

        #expect(
            try await rejected.switchToDesktopAndWait(spaceID: 20, displayID: "D1") == .rejected
        )
        #expect(
            try await timedOut.switchToDesktopAndWait(spaceID: 20, displayID: "D1") == .timedOut
        )
    }

    @Test func desktopsEnumeratesUserSpacesWithTheActiveFlag() {
        let switcher = WorkspaceDesktopSwitcher(
            state: { self.desktopState(active: 20, spaces: [(10, 0), (20, 1)]) },
            currentSpaceID: { _ in 20 },
            commit: { _, _ in true }
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
        let switcher = WorkspaceDesktopSwitcher(
            state: { state },
            currentSpaceID: { _ in 20 },
            commit: { _, _ in true }
        )

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
        let switcher = WorkspaceDesktopSwitcher(
            state: { state },
            currentSpaceID: { _ in 40 },
            commit: { _, _ in true }
        )

        #expect(switcher.missionControlNumbersBySpaceID() == [10: 1, 20: 2, 30: 3, 40: 4])
    }

    @Test func monitorPresentationsUsePAndSWhenThereIsOneSecondary() {
        let state = DesktopState(
            displays: [
                DisplayMetadata(id: "D1", label: "Studio Display", isMain: true, widthPoints: 1920, heightPoints: 1080),
                DisplayMetadata(id: "D2", label: "Built-in Display", widthPoints: 1512, heightPoints: 982),
            ],
            spaces: [],
            activeDisplayId: "D1",
            activeSpaceId: nil
        )
        let switcher = WorkspaceDesktopSwitcher(
            state: { state },
            currentSpaceID: { _ in nil },
            commit: { _, _ in true }
        )

        let presentations = switcher.monitorPresentationsByDisplayID()

        #expect(presentations["D1"] == WorkspaceMonitorPresentation(badge: "P", accessibilityValue: "primary monitor"))
        #expect(presentations["D2"] == WorkspaceMonitorPresentation(badge: "S", accessibilityValue: "secondary monitor"))
    }

    @Test func monitorPresentationsNumberMultipleSecondariesInDisplayOrder() {
        let state = DesktopState(
            displays: [
                DisplayMetadata(id: "D1", label: "Studio Display", isMain: true, widthPoints: 1920, heightPoints: 1080),
                DisplayMetadata(id: "D2", label: "Left Display", widthPoints: 1512, heightPoints: 982),
                DisplayMetadata(id: "D3", label: "Right Display", widthPoints: 1512, heightPoints: 982),
            ],
            spaces: [],
            activeDisplayId: "D1",
            activeSpaceId: nil
        )
        let switcher = WorkspaceDesktopSwitcher(
            state: { state },
            currentSpaceID: { _ in nil },
            commit: { _, _ in true }
        )

        let presentations = switcher.monitorPresentationsByDisplayID()

        #expect(presentations["D1"]?.badge == "P")
        #expect(presentations["D2"] == WorkspaceMonitorPresentation(badge: "S1", accessibilityValue: "secondary monitor 1"))
        #expect(presentations["D3"] == WorkspaceMonitorPresentation(badge: "S2", accessibilityValue: "secondary monitor 2"))
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
            missionControlNumbersBySpaceID: [40: 4],
            monitorPresentationsByDisplayID: [
                "D2": WorkspaceMonitorPresentation(badge: "S", accessibilityValue: "secondary monitor"),
            ]
        )

        let badge = try #require(descendant(in: switcher.view, identifier: "workspace-desktop-status") as? NSTextField)
        #expect(badge.stringValue == "D4")
        let monitor = try #require(descendant(in: switcher.view, identifier: "workspace-monitor-status") as? NSTextField)
        #expect(monitor.stringValue == "S")
        let row = try #require(descendant(in: switcher.view, identifier: "workspace-\(workspaceID.uuidString)"))
        #expect(row.accessibilityValue() as? String == "active, desktop 4, secondary monitor")
    }

    private func descendant(in root: NSView, identifier: String) -> NSView? {
        if root.accessibilityIdentifier() == identifier { return root }
        return root.subviews.lazy.compactMap { descendant(in: $0, identifier: identifier) }.first
    }
}
