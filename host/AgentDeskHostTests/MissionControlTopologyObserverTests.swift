import AgentDeskWire
import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
struct MissionControlTopologyObserverTests {
    private final class ManualScheduler {
        private(set) var pending: [() -> Void] = []
        private(set) var delays: [TimeInterval] = []

        func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) {
            delays.append(delay)
            pending.append(work)
        }

        func runNext() {
            guard !pending.isEmpty else { return }
            pending.removeFirst()()
        }
    }

    private func state(
        displays: [String] = ["D1"],
        spaces: [(id: UInt64, display: String, index: Int?, type: Int)]
    ) -> DesktopState {
        DesktopState(
            displays: displays.enumerated().map { index, id in
                DisplayMetadata(
                    id: id,
                    label: id,
                    isMain: index == 0,
                    widthPoints: 1_920,
                    heightPoints: 1_080
                )
            },
            spaces: spaces.map {
                SpaceMetadata(id: $0.id, displayId: $0.display, index: $0.index, type: $0.type)
            },
            activeDisplayId: displays.first,
            activeSpaceId: spaces.first?.id
        )
    }

    @Test func topologyIgnoresNonUserSpacesAndPreservesDisplayLocalOrder() {
        let topology = MissionControlTopology(state: state(
            displays: ["D1", "D2"],
            spaces: [
                (10, "D1", 1, 0),
                (99, "D1", nil, 4),
                (20, "D1", 0, 0),
                (30, "D2", 0, 0),
            ]
        ))

        #expect(topology.displays == [
            MissionControlDisplayTopology(displayID: "D1", spaceIDs: [20, 10]),
            MissionControlDisplayTopology(displayID: "D2", spaceIDs: [30]),
        ])
        #expect(topology.assignment(for: 10) == WorkspaceDesktopAssignment(
            spaceID: 10,
            displayID: "D1",
            ordinal: 1
        ))
        #expect(topology.assignment(for: 99) == nil)
    }

    @Test func topologyComparisonDetectsReorderMoveCreationAndDeletion() {
        let original = MissionControlTopology(state: state(
            displays: ["D1", "D2"],
            spaces: [
                (10, "D1", 0, 0),
                (20, "D1", 1, 0),
                (30, "D2", 0, 0),
            ]
        ))

        #expect(original != MissionControlTopology(state: state(
            displays: ["D1", "D2"],
            spaces: [
                (20, "D1", 0, 0),
                (10, "D1", 1, 0),
                (30, "D2", 0, 0),
            ]
        )))
        #expect(original != MissionControlTopology(state: state(
            displays: ["D1", "D2"],
            spaces: [
                (10, "D1", 0, 0),
                (20, "D2", 1, 0),
                (30, "D2", 0, 0),
            ]
        )))
        #expect(original != MissionControlTopology(state: state(
            displays: ["D1", "D2"],
            spaces: [
                (10, "D1", 0, 0),
                (20, "D1", 1, 0),
                (30, "D2", 0, 0),
                (40, "D2", 1, 0),
            ]
        )))
        #expect(original != MissionControlTopology(state: state(
            displays: ["D1", "D2"],
            spaces: [
                (10, "D1", 0, 0),
                (30, "D2", 0, 0),
            ]
        )))
    }

    @Test func startFailureDoesNotSchedulePolling() {
        let scheduler = ManualScheduler()
        let observer = MissionControlTopologyObserver(
            registerEntry: { _ in false },
            isMissionControlVisible: { false },
            readTopology: { nil },
            scheduleExitCheck: scheduler.schedule
        )

        #expect(observer.start() == false)
        #expect(scheduler.pending.isEmpty)
    }

    @Test func entryCoalescesAndPollingExistsOnlyUntilExit() throws {
        let scheduler = ManualScheduler()
        var entry: (() -> Void)?
        var visible = true
        var current = MissionControlTopology(state: state(spaces: [
            (10, "D1", 0, 0),
            (20, "D1", 1, 0),
        ]))
        var changes: [MissionControlTopology] = []
        let observer = MissionControlTopologyObserver(
            registerEntry: {
                entry = $0
                return true
            },
            isMissionControlVisible: { visible },
            readTopology: { current },
            scheduleExitCheck: scheduler.schedule
        )
        observer.onTopologyChanged = { changes.append($0) }

        #expect(observer.start())
        #expect(scheduler.pending.isEmpty)

        let entryHandler = try #require(entry)
        entryHandler()
        entryHandler()
        #expect(scheduler.pending.count == 1)
        #expect(scheduler.delays == [0.1])

        scheduler.runNext()
        #expect(scheduler.pending.count == 1)
        #expect(scheduler.delays == [0.1, 0.1])
        #expect(changes.isEmpty)

        current = MissionControlTopology(state: state(spaces: [
            (20, "D1", 0, 0),
            (10, "D1", 1, 0),
        ]))
        visible = false
        scheduler.runNext()

        #expect(scheduler.pending.isEmpty)
        #expect(changes == [current])
    }

    @Test func unchangedTopologyDoesNotEmit() throws {
        let scheduler = ManualScheduler()
        var entry: (() -> Void)?
        let topology = MissionControlTopology(state: state(spaces: [(10, "D1", 0, 0)]))
        var changes = 0
        let observer = MissionControlTopologyObserver(
            registerEntry: {
                entry = $0
                return true
            },
            isMissionControlVisible: { false },
            readTopology: { topology },
            scheduleExitCheck: scheduler.schedule
        )
        observer.onTopologyChanged = { _ in changes += 1 }

        #expect(observer.start())
        let entryHandler = try #require(entry)
        entryHandler()
        scheduler.runNext()

        #expect(changes == 0)
        #expect(scheduler.pending.isEmpty)
    }

    @Test func stoppingInvalidatesAnAlreadyScheduledCheck() throws {
        let scheduler = ManualScheduler()
        var entry: (() -> Void)?
        let topology = MissionControlTopology(state: state(spaces: [(10, "D1", 0, 0)]))
        let observer = MissionControlTopologyObserver(
            registerEntry: {
                entry = $0
                return true
            },
            isMissionControlVisible: { true },
            readTopology: { topology },
            scheduleExitCheck: scheduler.schedule
        )

        #expect(observer.start())
        let entryHandler = try #require(entry)
        entryHandler()
        #expect(scheduler.pending.count == 1)

        observer.stop()
        scheduler.runNext()

        #expect(scheduler.pending.isEmpty)
    }

    @Test func restartReusesTheProcessRegistration() {
        var registrations = 0
        let observer = MissionControlTopologyObserver(
            registerEntry: { _ in
                registrations += 1
                return true
            },
            isMissionControlVisible: { false },
            readTopology: { nil },
            scheduleExitCheck: { _, _ in }
        )

        #expect(observer.start())
        observer.stop()
        #expect(observer.start())
        #expect(registrations == 1)
    }
}
