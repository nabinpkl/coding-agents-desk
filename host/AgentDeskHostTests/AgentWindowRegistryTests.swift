import AgentDeskWire
import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
@Suite(.serialized)
struct AgentWindowRegistryTests {
    @Test func eachOpenCreatesAnIndependentWindowAndCascadesOnlyOnThatDesktop() {
        let fixture = AgentWindowRegistryFixture()
        let baseFrame = CGRect(x: 100, y: 200, width: 480, height: 720)

        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        fixture.registry.open(placement(spaceID: 99, frame: baseFrame))

        #expect(fixture.controllers.count == 4)
        #expect(Set(fixture.ids).count == 4)
        #expect(fixture.controllers.map(\.showCount) == [1, 1, 1, 1])
        #expect(fixture.controllers[0].frame == baseFrame)
        #expect(fixture.controllers[1].frame == baseFrame.offsetBy(dx: 24, dy: -24))
        #expect(fixture.controllers[2].frame == baseFrame.offsetBy(dx: 48, dy: -48))
        #expect(fixture.controllers[3].frame == baseFrame)
        #expect(fixture.registry.openWindowCountForTesting == 4)

        fixture.controllers[1].close()
        #expect(fixture.registry.openWindowCountForTesting == 3)

        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        #expect(fixture.controllers[4].frame == baseFrame.offsetBy(dx: 24, dy: -24))
        #expect(fixture.registry.openWindowCountForTesting == 4)
    }

    @Test func terminationStartsEveryWindowCloseOnceAndWaitsForAllOfThem() async {
        let fixture = AgentWindowRegistryFixture(suspendStop: true)
        let placement = placement(
            spaceID: 41,
            frame: CGRect(x: 100, y: 200, width: 480, height: 720)
        )
        fixture.registry.open(placement)
        fixture.registry.open(placement)

        let firstStop = fixture.registry.beginStopAll()
        let repeatedStop = fixture.registry.beginStopAll()
        await Task.yield()

        #expect(fixture.controllers.map(\.stopCount) == [1, 1])
        #expect(fixture.registry.openWindowCountForTesting == 2)

        fixture.registry.open(placement)
        #expect(fixture.controllers.count == 2)

        fixture.controllers.forEach { $0.resumeStop() }
        await firstStop.value
        await repeatedStop.value

        #expect(fixture.registry.openWindowCountForTesting == 0)
    }

    @Test func everyOpenWindowComesBackWhereItWasLeftWithoutTakingFocus() async {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        let baseFrame = CGRect(x: 100, y: 200, width: 480, height: 720)
        before.registry.open(placement(spaceID: 41, frame: baseFrame))
        before.registry.open(placement(spaceID: 41, frame: baseFrame))
        let dragged = CGRect(x: 640, y: 80, width: 520, height: 600)
        before.controllers[0].moveTo(dragged)
        await settleFramePersist(before, contains: dragged)

        // Quitting is not the user putting these windows away, so the placements survive it.
        await before.registry.beginStopAll().value
        #expect(before.storedFrames.count == 2)

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 2)
        #expect(Set(after.ids) == Set(before.ids))
        #expect(Set(after.controllers.map(\.frame)) == [dragged, baseFrame.offsetBy(dx: 24, dy: -24)])
        #expect(after.controllers.map(\.activations) == [[false], [false]])
    }

    @Test func aZoomedWindowComesBackAtTheSizeItWasLeftAt() async {
        // Zoom rides the same descriptor as the frame, so it survives on the same terms: a restart
        // restores it, and the write is on disk as it happens rather than at quit.
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        let placement = placement(
            spaceID: 41,
            frame: CGRect(x: 100, y: 200, width: 480, height: 720)
        )
        before.registry.open(placement)
        before.registry.open(placement)
        before.controllers[0].reportZoom(step: 3)
        await settleZoomPersist(before, contains: 3)

        await before.registry.beginStopAll().value

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 2)
        // The window that was zoomed comes back zoomed; the one that was not comes back at 1.0.
        #expect(Set(after.controllers.map(\.zoomStep)) == [3, 0])
    }

    @Test func aDragAndAZoomInOneWindowLandAsASingleWrite() async {
        // Both describe the same descriptor, so they share one debounce. The bug this pins is one
        // overwriting the other: whichever wrote last used to carry a stale copy of the other field.
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let fixture = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { fixture.remove() }
        fixture.registry.open(placement(
            spaceID: 41,
            frame: CGRect(x: 100, y: 200, width: 480, height: 720)
        ))
        let dragged = CGRect(x: 640, y: 80, width: 520, height: 600)
        fixture.controllers[0].moveTo(dragged)
        fixture.controllers[0].reportZoom(step: -2)
        await settleZoomPersist(fixture, contains: -2)

        #expect(fixture.storedFrames == [dragged])
        #expect(fixture.storedZoomSteps == [-2])
    }

    @Test func aZoomInTheLastMomentBeforeQuittingIsStillThereOnRestart() async {
        // The persist is debounced, and quitting cancels pending tasks. A delay long enough that it
        // cannot have fired proves the flush on the way out is what saves this, not the timer.
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL, presentationPersistDelay: .seconds(30))
        defer { before.remove() }
        before.registry.open(placement(
            spaceID: 41,
            frame: CGRect(x: 100, y: 200, width: 480, height: 720)
        ))
        let dragged = CGRect(x: 640, y: 80, width: 520, height: 600)
        before.controllers[0].moveTo(dragged)
        before.controllers[0].reportZoom(step: 5)

        await before.registry.beginStopAll().value

        #expect(before.storedZoomSteps == [5])
        #expect(before.storedFrames == [dragged])

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])
        #expect(after.controllers.map(\.zoomStep) == [5])
    }

    @Test func aWindowTheUserClosedStaysClosedAcrossRestart() async {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        let placement = placement(
            spaceID: 41,
            frame: CGRect(x: 100, y: 200, width: 480, height: 720)
        )
        before.registry.open(placement)
        before.registry.open(placement)

        before.controllers[0].close()
        await before.registry.beginStopAll().value

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 1)
        #expect(after.ids == [before.ids[1]])
    }

    @Test func aRunningAgentTerminalIsHandedBackToTheWindowItBelongedTo() async {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        let placement = placement(
            spaceID: 7,
            frame: CGRect(x: 40, y: 60, width: 480, height: 720)
        )
        before.registry.open(placement)
        before.registry.open(placement)
        let attachment = AgentWindowTerminalAttachment(
            requestID: "request-1",
            context: AgentResumeTerminalContext(
                projectPath: "/Users/someone/project",
                source: "claude",
                harnessSessionID: "0f4a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b"
            ),
            ptySessionName: "agent-claude-0f4a1b2c"
        )
        before.controllers[0].reportTerminal(attachment)

        await before.registry.beginStopAll().value

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(
            visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)],
            resumeTerminals: false
        )
        #expect(after.controllers.map(\.resumedTerminals) == [[], []])
        after.registry.resumeStoredTerminals()

        let resumedByWindow = zip(after.ids, after.controllers)
            .reduce(into: [UUID: [AgentWindowTerminalAttachment]]()) { result, pair in
                result[pair.0] = pair.1.resumedTerminals
            }
        #expect(resumedByWindow[before.ids[0]] == [attachment])
        #expect(resumedByWindow[before.ids[1]] == [])
    }

    @Test func aTerminalTheAgentEndedIsNotResumedLater() async {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        before.registry.open(placement(
            spaceID: 7,
            frame: CGRect(x: 40, y: 60, width: 480, height: 720)
        ))
        before.controllers[0].reportTerminal(AgentWindowTerminalAttachment(
            requestID: "request-1",
            context: AgentResumeTerminalContext(
                projectPath: "/Users/someone/project",
                source: "codex",
                harnessSessionID: "0f4a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b"
            ),
            ptySessionName: "agent-codex-0f4a1b2c"
        ))
        // The pane closing is the terminal being finished with, and that has to reach the store
        // before the quit, or the next launch reopens something the agent already ended.
        before.controllers[0].reportTerminal(nil)

        await before.registry.beginStopAll().value

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 1)
        #expect(after.controllers[0].resumedTerminals.isEmpty)
    }

    @Test func aTerminalIsRememberedEvenIfTheHostNeverGetsToQuit() {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        before.registry.open(placement(
            spaceID: 7,
            frame: CGRect(x: 40, y: 60, width: 480, height: 720)
        ))
        let attachment = AgentWindowTerminalAttachment(
            requestID: "request-1",
            context: AgentResumeTerminalContext(
                projectPath: "/Users/someone/project",
                source: "claude",
                harnessSessionID: "0f4a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b"
            ),
            ptySessionName: "agent-claude-0f4a1b2c"
        )
        before.controllers[0].reportTerminal(attachment)

        // No beginStopAll: this is the pkill case, which is how the host usually dies in
        // development. The attachment is written when it happens, not on the way out.
        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers[0].resumedTerminals == [attachment])
    }

    @Test func restorationIsIdempotentAndNeverDuplicatesAWindow() {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        before.registry.open(placement(
            spaceID: 7,
            frame: CGRect(x: 10, y: 20, width: 480, height: 720)
        ))

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 1)
    }

    @Test func aFrameRememberedOnAScreenThatIsGoneLandsOnOneThatExists() {
        let detached = CGRect(x: 2_400, y: 1_400, width: 480, height: 720)
        let laptop = CGRect(x: 0, y: 0, width: 1_512, height: 900)

        let placed = DesktopWindowScreenPlacement.constrained(detached, within: [laptop])

        #expect(laptop.contains(placed))
        #expect(placed.size == detached.size)
        #expect(DesktopWindowScreenPlacement.constrained(detached, within: []) == detached)
    }

    @Test func aWindowTallerThanTheScreenIsCutDownToFitIt() {
        let oversized = CGRect(x: -200, y: -100, width: 3_000, height: 2_000)
        let laptop = CGRect(x: 0, y: 0, width: 1_512, height: 900)

        #expect(DesktopWindowScreenPlacement.constrained(oversized, within: [laptop]) == laptop)
    }

    /// The store write is debounced, so a moved window is only remembered once the coalescing
    /// window closes. Polls rather than sleeping a fixed span so the test does not encode a timing
    /// guess about a loaded machine.
    private func settleFramePersist(
        _ fixture: AgentWindowRegistryFixture,
        contains frame: CGRect
    ) async {
        for _ in 0..<200 where !fixture.storedFrames.contains(frame) {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private func settleZoomPersist(
        _ fixture: AgentWindowRegistryFixture,
        contains step: Int
    ) async {
        for _ in 0..<200 where !fixture.storedZoomSteps.contains(step) {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    @Test func openWindowsAreListedInAStableDesktopThenCascadeOrder() {
        let fixture = AgentWindowRegistryFixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame, ordinal: 1))
        fixture.registry.open(placement(spaceID: 41, frame: frame, ordinal: 1))
        fixture.registry.open(placement(spaceID: 99, frame: frame, ordinal: 0))

        // Ordered, because the backing store is a dictionary: a list that reshuffled between
        // openings would move a row out from under the pointer on its way to the close button.
        // Both numbers are shown from one while stored from zero, matching Mission Control.
        #expect(fixture.registry.openWindows.map(\.title) == [
            "Agents 1 · Desktop 1",
            "Agents 1 · Desktop 2",
            "Agents 2 · Desktop 2",
        ])
        #expect(Set(fixture.registry.openWindows.map(\.id)).count == 3)
        #expect(fixture.registry.openWindows == fixture.registry.openWindows)
    }

    @Test func closingFromTheListEndsThatWindowTheWayItsOwnCloseButtonWould() throws {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let fixture = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.last)

        fixture.registry.closeWindow(id: target.id)

        // The user close path, not the termination one: the window forfeits its stored placement and
        // its agent terminal ends, where quitting would preserve both for the next launch.
        #expect(fixture.controllers.map(\.userCloseCount) == [0, 1])
        #expect(fixture.controllers.map(\.stopCount) == [0, 0])
        #expect(fixture.registry.openWindowCountForTesting == 1)
        #expect(fixture.storedFrames.count == 1)
        #expect(fixture.registry.openWindows.count == 1)
    }

    @Test func closingAWindowThatIsAlreadyGoneIsIgnored() throws {
        let fixture = AgentWindowRegistryFixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)
        fixture.controllers[0].close()

        // A chooser can only hold the list as it was when it opened, and the window may have closed
        // from its own titlebar in between. That is an ordinary race, not a programming error.
        fixture.registry.closeWindow(id: target.id)

        #expect(fixture.controllers[0].userCloseCount == 0)
        #expect(fixture.registry.openWindowCountForTesting == 0)
    }

    @Test func goingToAWindowMakesItsDesktopActiveBeforeRaisingIt() async throws {
        let gate = DesktopActivationGate()
        let fixture = AgentWindowRegistryFixture(activateDesktop: { await gate.activate($0) })
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame, ordinal: 0))
        fixture.registry.open(placement(spaceID: 99, frame: frame, ordinal: 1))
        let target = try #require(fixture.registry.openWindows.last)

        fixture.registry.focusWindow(id: target.id)
        await wait { gate.requested.count == 1 }

        #expect(gate.requested.map(\.spaceID) == [99])
        // Still down: a window raised while the Desktop is mid-transition lands behind whatever that
        // transition settles on, which is the failure the wait exists to prevent.
        #expect(fixture.controllers.map(\.focusCount) == [0, 0])

        gate.complete(reached: true)
        await wait { fixture.controllers[1].focusCount == 1 }

        #expect(fixture.controllers.map(\.focusCount) == [0, 1])
        #expect(fixture.controllers.map(\.showCount) == [1, 1])
    }

    @Test func aWindowClosedWhileItsDesktopWasStillArrivingIsNotRaised() async throws {
        let gate = DesktopActivationGate()
        let fixture = AgentWindowRegistryFixture(activateDesktop: { await gate.activate($0) })
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)

        fixture.registry.focusWindow(id: target.id)
        await wait { gate.requested.count == 1 }
        fixture.controllers[0].close()
        gate.complete(reached: true)
        await settle()

        // The Desktop switch is a real wait, so the window can be gone by the time it lands.
        #expect(fixture.controllers[0].focusCount == 0)
    }

    @Test func aDesktopThatRefusesToBecomeActiveStillRaisesTheWindow() async throws {
        let gate = DesktopActivationGate()
        let fixture = AgentWindowRegistryFixture(activateDesktop: { await gate.activate($0) })
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)

        fixture.registry.focusWindow(id: target.id)
        await wait { gate.requested.count == 1 }
        gate.complete(reached: false)
        await wait { fixture.controllers[0].focusCount == 1 }

        // The switch is also refused when Spaces cannot be read at all, and the window may already
        // be reachable. Doing nothing would answer the click with silence.
        #expect(fixture.controllers[0].focusCount == 1)
    }

    @Test func withoutASpacesAuthorityTheWindowIsRaisedWhereItStands() throws {
        let fixture = AgentWindowRegistryFixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)

        fixture.registry.focusWindow(id: target.id)

        #expect(fixture.controllers[0].focusCount == 1)
    }

    @Test func goingToAWindowThatIsAlreadyGoneIsIgnored() throws {
        let fixture = AgentWindowRegistryFixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 480, height: 720)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)
        fixture.controllers[0].close()

        fixture.registry.focusWindow(id: target.id)

        #expect(fixture.controllers[0].focusCount == 0)
    }

    private func wait(until condition: @MainActor () -> Bool) async {
        for _ in 0..<200 where !condition() {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    /// For asserting an absence: there is no state change to poll for, so the raise gets a real
    /// chance to happen before the test says it did not.
    private func settle() async {
        try? await Task.sleep(for: .milliseconds(50))
    }

    private func placement(
        spaceID: UInt64,
        frame: CGRect,
        ordinal: Int = 0
    ) -> WorkspaceWindowPlacement {
        WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(
                spaceID: spaceID,
                displayID: "display-\(spaceID)",
                ordinal: ordinal
            ),
            frame: frame
        )
    }
}

@MainActor
private final class AgentWindowRegistryFixture {
    let coordinator: AgentWindowRegistryTerminalCoordinator
    private let recorder: AgentWindowRegistryRecorder
    let storeURL: URL
    let registry: AgentWindowRegistry

    var ids: [UUID] { recorder.ids }
    var controllers: [FakeManagedAgentWindow] { recorder.controllers }
    var storedFrames: [CGRect] {
        AgentWindowPresentationStore(url: storeURL).descriptors.map(\.placement.frame)
    }
    var storedZoomSteps: [Int] {
        AgentWindowPresentationStore(url: storeURL).descriptors.map(\.zoomStep)
    }

    static func makeStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-presentations-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("presentations.json")
    }

    init(
        suspendStop: Bool = false,
        storeURL: URL = AgentWindowRegistryFixture.makeStoreURL(),
        presentationPersistDelay: Duration = .milliseconds(1),
        activateDesktop: AgentWindowRegistry.DesktopActivating? = nil
    ) {
        let coordinator = AgentWindowRegistryTerminalCoordinator()
        let recorder = AgentWindowRegistryRecorder()
        self.coordinator = coordinator
        self.recorder = recorder
        self.storeURL = storeURL
        registry = AgentWindowRegistry(
            store: AgentWindowPresentationStore(url: storeURL),
            presentationPersistDelay: presentationPersistDelay,
            activateDesktop: activateDesktop,
            endpointFactory: { id in
                AgentSessionTerminalEndpoint(
                    coordinator: coordinator,
                    platform: .macOS,
                    requestNamespace: "test-agent-window-\(id.uuidString)",
                    tombstoneLimit: 8
                )
            },
            controllerFactory: { id, placement, zoomStep, _, onClosed in
                let controller = FakeManagedAgentWindow(
                    placement: placement,
                    zoomStep: zoomStep,
                    suspendStop: suspendStop,
                    onClosed: onClosed
                )
                recorder.ids.append(id)
                recorder.controllers.append(controller)
                return controller
            }
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent())
    }
}

/// Stands in for the Desktop switch, held open so a test can look at the world between "asked to
/// switch" and "arrived" -- the window in that gap is the whole point of ordering the two.
@MainActor
private final class DesktopActivationGate {
    private(set) var requested: [WorkspaceDesktopAssignment] = []
    private var continuation: CheckedContinuation<Bool, Never>?

    func activate(_ desktop: WorkspaceDesktopAssignment) async -> Bool {
        requested.append(desktop)
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func complete(reached: Bool) {
        continuation?.resume(returning: reached)
        continuation = nil
    }
}

@MainActor
private final class AgentWindowRegistryRecorder {
    var ids: [UUID] = []
    var controllers: [FakeManagedAgentWindow] = []
}

@MainActor
private final class FakeManagedAgentWindow: AgentWindowControlling {
    private(set) var placement: WorkspaceWindowPlacement
    var frame: CGRect { placement.frame }
    /// The level the registry restored this window at, so a test can assert the round trip.
    let zoomStep: Int
    private let suspendStop: Bool
    private var onClosed: (@MainActor () -> Void)?
    private var onPlacementChanged: ((WorkspaceWindowPlacement) -> Void)?
    private var onTerminalChanged: ((AgentWindowTerminalAttachment?) -> Void)?
    private var onZoomChanged: ((Int) -> Void)?
    private var stopTask: Task<Void, Never>?
    private var stopContinuation: CheckedContinuation<Void, Never>?
    private(set) var showCount = 0
    private(set) var focusCount = 0
    private(set) var stopCount = 0
    private(set) var userCloseCount = 0
    private(set) var activations: [Bool] = []
    private(set) var resumedTerminals: [AgentWindowTerminalAttachment] = []

    init(
        placement: WorkspaceWindowPlacement,
        zoomStep: Int,
        suspendStop: Bool,
        onClosed: @escaping @MainActor () -> Void
    ) {
        self.placement = placement
        self.zoomStep = zoomStep
        self.suspendStop = suspendStop
        self.onClosed = onClosed
    }

    func show(activating: Bool) {
        showCount += 1
        activations.append(activating)
    }

    func observePresentation(
        placementChanged: @escaping (WorkspaceWindowPlacement) -> Void,
        terminalChanged: @escaping (AgentWindowTerminalAttachment?) -> Void,
        zoomChanged: @escaping (Int) -> Void
    ) {
        onPlacementChanged = placementChanged
        onTerminalChanged = terminalChanged
        onZoomChanged = zoomChanged
    }

    func resumeTerminal(_ attachment: AgentWindowTerminalAttachment) {
        resumedTerminals.append(attachment)
    }

    func focus() {
        focusCount += 1
    }

    /// Stands in for the user dragging the window.
    func moveTo(_ frame: CGRect) {
        placement.frame = frame
        onPlacementChanged?(placement)
    }

    /// Stands in for the panel opening or ending a terminal in this window.
    func reportTerminal(_ attachment: AgentWindowTerminalAttachment?) {
        onTerminalChanged?(attachment)
    }

    /// Stands in for the user pressing Command+minus or Command+equals in this window.
    func reportZoom(step: Int) {
        onZoomChanged?(step)
    }

    func close() {
        finishClose()
    }

    /// Stands in for the real controller's user-initiated close, which ends the terminal and then
    /// reports the window closed. Counted separately from `beginStop` because the registry treats
    /// the two differently: only this one forfeits the stored placement.
    func beginUserClose() {
        userCloseCount += 1
        finishClose()
    }

    @discardableResult
    func beginStop() -> Task<Void, Never> {
        if let stopTask { return stopTask }
        stopCount += 1
        let task = Task { @MainActor [self] in
            if suspendStop {
                await withCheckedContinuation { continuation in
                    stopContinuation = continuation
                }
            }
            finishClose()
        }
        stopTask = task
        return task
    }

    func resumeStop() {
        stopContinuation?.resume()
        stopContinuation = nil
    }

    private func finishClose() {
        let onClosed = onClosed
        self.onClosed = nil
        onClosed?()
    }
}

private actor AgentWindowRegistryTerminalCoordinator: AgentSessionTerminalCoordinating {
    func open(
        _ request: AgentSessionTerminalOpenRequest
    ) async throws -> AgentSessionTerminalReady {
        throw AgentWindowRegistryTerminalError.unexpectedOpen
    }

    func acknowledgeAttachment(requestID: String, ptySessionName: String) async {}

    func transferRequest(
        from oldRequestID: String,
        to newRequestID: String,
        ptySessionName: String
    ) async -> Bool {
        false
    }

    func close(requestID: String, ptySessionName: String?) async {}
}

private enum AgentWindowRegistryTerminalError: Error {
    case unexpectedOpen
}
