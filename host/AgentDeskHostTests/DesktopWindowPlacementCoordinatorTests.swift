import Foundation
import Testing

@testable import AgentDeskHost

struct DesktopWindowPlacementCoordinatorTests {
    @Test func capturesExactSingleDesktopMembershipAndFrame() throws {
        let frame = CGRect(x: 1_900, y: 120, width: 1_180, height: 760)
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [20]])
        let coordinator = makeCoordinator(mover: mover)

        let placement = try coordinator.capture(windowID: 42, frame: frame)

        #expect(placement == WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1),
            frame: frame
        ))
    }

    @Test func refusesToCaptureUnassignedOrMultiSpaceWindow() throws {
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10, 20], 43: []])
        let coordinator = makeCoordinator(mover: mover)

        #expect(try coordinator.capture(windowID: 42, frame: .zero) == nil)
        #expect(try coordinator.capture(windowID: 43, frame: .zero) == nil)
    }

    @Test func restoresFrameBeforeMovingToExactSavedDesktop() throws {
        let frame = CGRect(x: 1_900, y: 120, width: 1_180, height: 760)
        let placement = WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1),
            frame: frame
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        var events: [String] = []
        mover.onMove = { events.append("move") }
        let coordinator = makeCoordinator(mover: mover)

        let restored = try coordinator.restore(placement, windowID: 42) { restoredFrame in
            #expect(restoredFrame == frame)
            events.append("frame")
        }

        #expect(events == ["frame", "move"])
        #expect(restored == placement)
        #expect(mover.moves == [.init(windowID: 42, spaceID: 20)])
    }

    @Test func repairsStaleSpaceIDUsingDisplayLocalOrdinal() throws {
        let stale = WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 999, displayID: "D1", ordinal: 1),
            frame: .zero
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        let coordinator = makeCoordinator(mover: mover)

        let restored = try coordinator.restore(stale, windowID: 42) { _ in }

        #expect(restored.desktop == WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1))
        #expect(mover.moves == [.init(windowID: 42, spaceID: 20)])
    }

    @Test func stableSpaceIDWinsWhenDisplayTopologyChanged() throws {
        let saved = WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 30, displayID: "D1", ordinal: 1),
            frame: .zero
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        let coordinator = makeCoordinator(mover: mover)

        let restored = try coordinator.restore(saved, windowID: 42) { _ in }

        #expect(restored.desktop == WorkspaceDesktopAssignment(spaceID: 30, displayID: "D2", ordinal: 0))
        #expect(mover.moves == [.init(windowID: 42, spaceID: 30)])
    }

    @Test func missingDisplayFailsWithoutMoving() throws {
        let placement = WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 50, displayID: "missing", ordinal: 0),
            frame: .zero
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        let coordinator = makeCoordinator(mover: mover)

        #expect(throws: DesktopWindowPlacementError.missingTargetDesktop(
            displayID: "missing",
            ordinal: 0
        )) {
            try coordinator.restore(placement, windowID: 42) { _ in }
        }
        #expect(mover.moves.isEmpty)
    }

    @Test func verificationMismatchFailsLoud() throws {
        let placement = WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1),
            frame: .zero
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        mover.membershipAfterMove = [10, 20]
        let coordinator = makeCoordinator(mover: mover)

        #expect(throws: DesktopWindowPlacementError.verificationMismatch(
            windowID: 42,
            targetSpaceID: 20,
            observedSpaceIDs: [10, 20]
        )) {
            try coordinator.restore(placement, windowID: 42) { _ in }
        }
    }

    @Test func membershipCanBeReverifiedAfterAppKitOrdersWindow() throws {
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        let coordinator = makeCoordinator(mover: mover)
        mover.setSpaceIDs([10], for: 42)

        #expect(throws: DesktopWindowPlacementError.verificationMismatch(
            windowID: 42,
            targetSpaceID: 20,
            observedSpaceIDs: [10]
        )) {
            try coordinator.verify(windowID: 42, targetSpaceID: 20)
        }
    }

    private func makeCoordinator(
        mover: RecordingWorkspaceWindowSpaceMover
    ) -> DesktopWindowPlacementCoordinator {
        DesktopWindowPlacementCoordinator(
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )
    }

    private static func snapshot() -> WorkspaceDesktopSnapshot {
        WorkspaceDesktopSnapshot(
            activeSpaceID: 10,
            desktops: [
                WorkspaceDesktop(id: 10, displayID: "D1", ordinal: 0, missionControlOrdinal: 0, isActive: true),
                WorkspaceDesktop(id: 20, displayID: "D1", ordinal: 1, missionControlOrdinal: 1, isActive: false),
                WorkspaceDesktop(id: 30, displayID: "D2", ordinal: 0, missionControlOrdinal: 2, isActive: false),
            ],
            windows: [],
            diagnostic: nil
        )
    }
}

private final class RecordingWorkspaceWindowSpaceMover: WorkspaceWindowSpaceMoving {
    struct Move: Equatable {
        let windowID: UInt32
        let spaceID: UInt64
    }

    private var membership: [UInt32: [UInt64]]
    var membershipAfterMove: [UInt64]?
    var onMove: (() -> Void)?
    private(set) var moves: [Move] = []

    init(spaceIDs: [UInt32: [UInt64]]) {
        membership = spaceIDs
    }

    func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {
        onMove?()
        moves.append(Move(windowID: windowID, spaceID: targetSpaceID))
        membership[windowID] = membershipAfterMove ?? [targetSpaceID]
    }

    func spaceIDs(for windowID: UInt32) throws -> [UInt64] {
        membership[windowID] ?? []
    }

    func setSpaceIDs(_ spaceIDs: [UInt64], for windowID: UInt32) {
        membership[windowID] = spaceIDs
    }
}
