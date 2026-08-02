import Foundation
import Testing

@testable import AgentDeskHost

struct WorkspaceIDEWindowPlacementTests {
    @Test func firstOpenWithoutSavedPlacementNeedsNoMove() throws {
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: MemoryWorkspaceIDEWindowPlacementStore(),
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        #expect(try coordinator.restore(windowID: 42) == .noSavedPlacement)
        #expect(mover.moves.isEmpty)
    }

    @Test func recordsExactSingleDesktopMembership() throws {
        let frame = CGRect(x: 1_900, y: 120, width: 1_180, height: 760)
        let store = MemoryWorkspaceIDEWindowPlacementStore()
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [20]])
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: store,
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        let recorded = try coordinator.record(windowID: 42, frame: frame)

        #expect(recorded == WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1))
        #expect(store.placement?.desktop == recorded)
        #expect(store.placement?.frame == frame)
    }

    @Test func doesNotReplacePlacementForUnassignedOrMultiSpaceWindow() throws {
        let original = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 10, displayID: "D1", ordinal: 0)
        )
        let store = MemoryWorkspaceIDEWindowPlacementStore(placement: original)
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10, 20], 43: []])
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: store,
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        #expect(try coordinator.record(windowID: 42, frame: .zero) == nil)
        #expect(try coordinator.record(windowID: 43, frame: .zero) == nil)
        #expect(store.placement == original)
    }

    @Test func restoresSavedFrameBeforeMovingToDesktop() throws {
        let frame = CGRect(x: 1_900, y: 120, width: 1_180, height: 760)
        let placement = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1),
            frame: frame
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        var events: [String] = []
        mover.onMove = { events.append("move") }
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: MemoryWorkspaceIDEWindowPlacementStore(placement: placement),
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        _ = try coordinator.restore(windowID: 42) { restoredFrame in
            #expect(restoredFrame == frame)
            events.append("frame")
        }

        #expect(events == ["frame", "move"])
    }

    @Test func restoresExactSavedSpaceAndVerifiesMembership() throws {
        let placement = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1),
            frame: CGRect(x: 1_900, y: 120, width: 1_180, height: 760)
        )
        let store = MemoryWorkspaceIDEWindowPlacementStore(placement: placement)
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        mover.membershipAfterMove = [20]
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: store,
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        let result = try coordinator.restore(windowID: 42)

        #expect(result == .restored(placement.desktop))
        #expect(mover.moves == [.init(windowID: 42, spaceID: 20)])
    }

    @Test func repairsMissingSpaceIDFromDisplayLocalOrdinal() throws {
        let stale = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 999, displayID: "D1", ordinal: 1)
        )
        let store = MemoryWorkspaceIDEWindowPlacementStore(placement: stale)
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        mover.membershipAfterMove = [20]
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: store,
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        let result = try coordinator.restore(windowID: 42)

        let resolved = WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)
        #expect(result == .restored(resolved))
        #expect(store.placement?.desktop == resolved)
    }

    @Test func missingDisplayFailsWithoutOverwritingIntendedPlacement() throws {
        let placement = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 50, displayID: "missing", ordinal: 0)
        )
        let store = MemoryWorkspaceIDEWindowPlacementStore(placement: placement)
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: store,
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        #expect(throws: WorkspaceIDEWindowPlacementError.missingTargetDesktop(
            displayID: "missing",
            ordinal: 0
        )) {
            try coordinator.restore(windowID: 42)
        }
        #expect(store.placement == placement)
        #expect(mover.moves.isEmpty)
    }

    @Test func verificationMismatchFailsLoud() throws {
        let placement = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        mover.membershipAfterMove = [10, 20]
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: MemoryWorkspaceIDEWindowPlacementStore(placement: placement),
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        #expect(throws: WorkspaceIDEWindowPlacementError.verificationMismatch(
            windowID: 42,
            targetSpaceID: 20,
            observedSpaceIDs: [10, 20]
        )) {
            try coordinator.restore(windowID: 42)
        }
    }

    @Test func membershipCanBeReverifiedAfterAppKitOrdersTheWindow() throws {
        let placement = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)
        )
        let mover = RecordingWorkspaceWindowSpaceMover(spaceIDs: [42: [10]])
        let coordinator = WorkspaceIDEWindowPlacementCoordinator(
            store: MemoryWorkspaceIDEWindowPlacementStore(placement: placement),
            desktopAudit: StaticWorkspaceDesktopAudit(Self.snapshot()),
            mover: mover
        )

        _ = try coordinator.restore(windowID: 42)
        mover.setSpaceIDs([10], for: 42)

        #expect(throws: WorkspaceIDEWindowPlacementError.verificationMismatch(
            windowID: 42,
            targetSpaceID: 20,
            observedSpaceIDs: [10]
        )) {
            try coordinator.verify(windowID: 42, targetSpaceID: 20)
        }
    }

    @Test func fileStoreRoundTripsPlacementAtomically() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = WorkspaceIDEWindowPlacementFileStore(
            url: directory.appendingPathComponent("placement.json")
        )
        let placement = WorkspaceIDEWindowPlacement(
            desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)
        )

        #expect(try store.load() == nil)
        try store.save(placement)
        #expect(try store.load() == placement)
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

private final class MemoryWorkspaceIDEWindowPlacementStore: WorkspaceIDEWindowPlacementStoring {
    var placement: WorkspaceIDEWindowPlacement?

    init(placement: WorkspaceIDEWindowPlacement? = nil) {
        self.placement = placement
    }

    func load() throws -> WorkspaceIDEWindowPlacement? { placement }
    func save(_ placement: WorkspaceIDEWindowPlacement) throws { self.placement = placement }
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
