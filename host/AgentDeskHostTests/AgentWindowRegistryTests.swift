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

        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 99, frame: baseFrame))

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

        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        #expect(fixture.controllers[4].frame == baseFrame.offsetBy(dx: 24, dy: -24))
        #expect(fixture.registry.openWindowCountForTesting == 4)
    }

    @Test func terminationStartsEveryWindowCloseOnceAndWaitsForAllOfThem() async {
        let fixture = AgentWindowRegistryFixture(suspendStop: true)
        let placement = AgentWindowPlacement(
            desktopSpaceID: 41,
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
        before.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        before.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
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
        let placement = AgentWindowPlacement(
            desktopSpaceID: 41,
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
        fixture.registry.open(AgentWindowPlacement(
            desktopSpaceID: 41,
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
        before.registry.open(AgentWindowPlacement(
            desktopSpaceID: 41,
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

    @Test func windowsWrittenBeforeZoomExistedStillComeBack() async {
        // The literal document a pre-zoom host left on disk. Adding `zoomStep` as a required key
        // made the whole file fail to decode, so the launch after it restored NOTHING and said
        // nothing about why -- two remembered windows gone with no log line. This is that file.
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        try? FileManager.default.createDirectory(
            at: storeURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let legacy = """
        {"presentations":[
          {"desktopSpaceID":3,"cascadeOrdinal":1,
           "frame":{"height":720,"x":1320,"width":480,"y":384},
           "id":"A2435C33-98D5-4B10-9982-0AF4F5985C34"},
          {"desktopSpaceID":74,"cascadeOrdinal":0,
           "frame":{"height":720,"y":254,"width":480,"x":2520},
           "id":"9310FA2E-22E5-43D0-AB0E-DF9D5DB10090"}
        ]}
        """
        try? Data(legacy.utf8).write(to: storeURL)

        let fixture = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { fixture.remove() }
        fixture.registry.startRestoration(
            visibleFrames: [CGRect(x: 0, y: 0, width: 3_840, height: 2_160)]
        )

        #expect(fixture.controllers.count == 2)
        #expect(Set(fixture.controllers.map(\.frame)) == [
            CGRect(x: 1_320, y: 384, width: 480, height: 720),
            CGRect(x: 2_520, y: 254, width: 480, height: 720),
        ])
        // A window from before zoom existed comes back at 1.0, which is where it was.
        #expect(fixture.controllers.map(\.zoomStep) == [0, 0])
    }

    @Test func aWindowTheUserClosedStaysClosedAcrossRestart() async {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        let placement = AgentWindowPlacement(
            desktopSpaceID: 41,
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
        let placement = AgentWindowPlacement(
            desktopSpaceID: 7,
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
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

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
        before.registry.open(AgentWindowPlacement(
            desktopSpaceID: nil,
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
        before.registry.open(AgentWindowPlacement(
            desktopSpaceID: nil,
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
        before.registry.open(AgentWindowPlacement(
            desktopSpaceID: nil,
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

        let placed = AgentWindowScreenPlacement.constrained(detached, within: [laptop])

        #expect(laptop.contains(placed))
        #expect(placed.size == detached.size)
        #expect(AgentWindowScreenPlacement.constrained(detached, within: []) == detached)
    }

    @Test func aWindowTallerThanTheScreenIsCutDownToFitIt() {
        let oversized = CGRect(x: -200, y: -100, width: 3_000, height: 2_000)
        let laptop = CGRect(x: 0, y: 0, width: 1_512, height: 900)

        #expect(AgentWindowScreenPlacement.constrained(oversized, within: [laptop]) == laptop)
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
        AgentWindowPresentationStore(url: storeURL).descriptors.map(\.frame.cgRect)
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
        presentationPersistDelay: Duration = .milliseconds(1)
    ) {
        let coordinator = AgentWindowRegistryTerminalCoordinator()
        let recorder = AgentWindowRegistryRecorder()
        self.coordinator = coordinator
        self.recorder = recorder
        self.storeURL = storeURL
        registry = AgentWindowRegistry(
            store: AgentWindowPresentationStore(url: storeURL),
            presentationPersistDelay: presentationPersistDelay,
            endpointFactory: { id in
                AgentSessionTerminalEndpoint(
                    coordinator: coordinator,
                    platform: .macOS,
                    requestNamespace: "test-agent-window-\(id.uuidString)",
                    tombstoneLimit: 8
                )
            },
            controllerFactory: { id, frame, zoomStep, _, onClosed in
                let controller = FakeManagedAgentWindow(
                    frame: frame,
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

@MainActor
private final class AgentWindowRegistryRecorder {
    var ids: [UUID] = []
    var controllers: [FakeManagedAgentWindow] = []
}

@MainActor
private final class FakeManagedAgentWindow: AgentWindowControlling {
    let frame: CGRect
    /// The level the registry restored this window at, so a test can assert the round trip.
    let zoomStep: Int
    private let suspendStop: Bool
    private var onClosed: (@MainActor () -> Void)?
    private var onFrameChanged: ((CGRect) -> Void)?
    private var onTerminalChanged: ((AgentWindowTerminalAttachment?) -> Void)?
    private var onZoomChanged: ((Int) -> Void)?
    private var stopTask: Task<Void, Never>?
    private var stopContinuation: CheckedContinuation<Void, Never>?
    private(set) var showCount = 0
    private(set) var stopCount = 0
    private(set) var activations: [Bool] = []
    private(set) var resumedTerminals: [AgentWindowTerminalAttachment] = []

    init(
        frame: CGRect,
        zoomStep: Int,
        suspendStop: Bool,
        onClosed: @escaping @MainActor () -> Void
    ) {
        self.frame = frame
        self.zoomStep = zoomStep
        self.suspendStop = suspendStop
        self.onClosed = onClosed
    }

    func show(activating: Bool) {
        showCount += 1
        activations.append(activating)
    }

    func observePresentation(
        frameChanged: @escaping (CGRect) -> Void,
        terminalChanged: @escaping (AgentWindowTerminalAttachment?) -> Void,
        zoomChanged: @escaping (Int) -> Void
    ) {
        onFrameChanged = frameChanged
        onTerminalChanged = terminalChanged
        onZoomChanged = zoomChanged
    }

    func resumeTerminal(_ attachment: AgentWindowTerminalAttachment) {
        resumedTerminals.append(attachment)
    }

    /// Stands in for the user dragging the window.
    func moveTo(_ frame: CGRect) {
        onFrameChanged?(frame)
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
