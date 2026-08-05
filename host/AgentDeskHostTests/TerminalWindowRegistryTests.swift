import CoreGraphics
import Foundation
import PtyClientSwift
import TerminalEmulator
import PtyTerminalWebView
import XCTest
@testable import AgentDeskHost

@MainActor
final class TerminalWindowRegistryTests: XCTestCase {
    func testReachableManagerRemovesDescriptorForMissingSession() async throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        try fixture.seed()

        fixture.registry.startRestoration()
        try await waitUntil { fixture.store.descriptors.isEmpty }
    }

    func testUnavailableManagerRetainsDescriptor() async throws {
        let fixture = try RegistryFixture(error: FixtureError.unavailable)
        defer { fixture.remove() }
        try fixture.seed()

        fixture.registry.startRestoration()
        try await Task.sleep(nanoseconds: 50_000_000)
        fixture.registry.prepareForHostTermination()

        XCTAssertEqual(fixture.store.descriptors.map(\.sessionName), ["persistent"])
    }

    func testRunningSessionRestoresWithoutFocusAndShutdownPreservesMetadata() async throws {
        let fixture = try RegistryFixture(sessions: [fixtureSession()])
        defer { fixture.remove() }
        let descriptor = try fixture.seed()

        fixture.registry.startRestoration()
        try await waitUntil { fixture.spawner.window?.orderedWithoutFocus == true }

        XCTAssertEqual(fixture.spawner.window?.workspaceLabel, "Workspace")
        XCTAssertEqual(fixture.spawner.window?.currentFrame, descriptor.placement.frame)
        XCTAssertFalse(fixture.spawner.window?.raised ?? true)
        XCTAssertEqual(fixture.desktopPlacer.presentedPlacements, [descriptor.placement])
        XCTAssertEqual(fixture.desktopPlacer.focusRequests, [false])

        fixture.registry.prepareForHostTermination()
        XCTAssertTrue(fixture.spawner.window?.closedPreservingPresentation ?? false)
        XCTAssertEqual(fixture.store.descriptors.map(\.id), [descriptor.id])
    }

    func testPlacementFailureKeepsDescriptorButNeverRevealsOnActiveDesktop() async throws {
        let fixture = try RegistryFixture(sessions: [fixtureSession()])
        defer { fixture.remove() }
        let descriptor = try fixture.seed()
        fixture.desktopPlacer.shouldFail = true

        fixture.registry.startRestoration()
        try await waitUntil { fixture.spawner.window?.closedPreservingPresentation == true }

        XCTAssertFalse(fixture.spawner.window?.orderedWithoutFocus ?? true)
        XCTAssertFalse(fixture.spawner.window?.raised ?? true)
        XCTAssertEqual(fixture.store.descriptors.map(\.id), [descriptor.id])
    }

    func testRegistrationFailureClosesUnownedWindow() throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let window = FakeTrackedTerminalWindow(frame: .zero)

        fixture.registry.register(
            window,
            sessionName: "persistent",
            workspaceID: UUID(),
            workspaceLabel: "Workspace",
            cascadeOrdinal: 0,
            placement: WorkspaceWindowPlacement(
                desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1),
                frame: .zero
            ),
            focus: true
        )

        XCTAssertTrue(window.closedPreservingPresentation)
        XCTAssertTrue(fixture.store.descriptors.isEmpty)
    }

    // MARK: - The top bar's chooser

    func testOpenWindowsAreListedInAStableOrderAndNamedByWhereTheyAre() throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        // Registered out of order, so an implementation that returned them in registration order or in
        // the store's own last-written order would be caught.
        _ = fixture.register(desktopOrdinal: 1, cascadeOrdinal: 0)
        _ = fixture.register(desktopOrdinal: 0, cascadeOrdinal: 1)
        _ = fixture.register(desktopOrdinal: 0, cascadeOrdinal: 0)

        XCTAssertEqual(
            fixture.registry.openWorkspaceWindows.map(\.title),
            ["Terminal 1 · Desktop 1", "Terminal 2 · Desktop 1", "Terminal 1 · Desktop 2"]
        )
        XCTAssertTrue(fixture.registry.openWorkspaceWindows.allSatisfy { $0.kind == .terminal })
    }

    func testAWindowThatHasNotBeenPutBackYetIsNotOfferedToGoTo() throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        // A descriptor the previous host run left behind. It names a window that does not exist in this
        // one until restoration reaches it, and a chooser row for it would go nowhere.
        try fixture.seed()

        XCTAssertTrue(fixture.registry.openWorkspaceWindows.isEmpty)
    }

    func testClosingFromTheListEndsThatWindowTheWayItsOwnCloseButtonWould() throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let first = fixture.register(desktopOrdinal: 0, cascadeOrdinal: 0)
        let second = fixture.register(desktopOrdinal: 0, cascadeOrdinal: 1)

        fixture.registry.closeWindow(id: first.id)

        XCTAssertFalse(first.window.isOpen)
        XCTAssertFalse(first.window.closedPreservingPresentation)
        XCTAssertTrue(second.window.isOpen)
        // Forfeited, not preserved: a window the user closed must not come back on the next launch.
        XCTAssertEqual(fixture.store.descriptors.map(\.id), [second.id])
    }

    func testClosingAWindowThatIsAlreadyGoneIsIgnored() throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let window = fixture.register(desktopOrdinal: 0, cascadeOrdinal: 0)
        window.window.close()

        fixture.registry.closeWindow(id: window.id)

        XCTAssertTrue(fixture.store.descriptors.isEmpty)
    }

    func testGoingToAWindowMakesItsDesktopActiveBeforeRaisingIt() async throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let gate = DesktopActivationGate()
        let window = fixture.register(desktopOrdinal: 1, cascadeOrdinal: 0)

        fixture.registry.focusWorkspaceWindow(id: window.id, activateDesktop: { await gate.activate($0) })
        try await settle()

        XCTAssertEqual(gate.requested.map(\.ordinal), [1])
        // The order is the whole point: a window raised while the Desktop is still arriving lands
        // behind whatever that Desktop settles on.
        XCTAssertFalse(window.window.raised)

        gate.complete(reached: true)
        try await waitUntil { window.window.raised }
    }

    func testAWindowClosedWhileItsDesktopWasStillArrivingIsNotRaised() async throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let gate = DesktopActivationGate()
        let window = fixture.register(desktopOrdinal: 1, cascadeOrdinal: 0)

        fixture.registry.focusWorkspaceWindow(id: window.id, activateDesktop: { await gate.activate($0) })
        try await settle()
        window.window.close()
        gate.complete(reached: true)
        try await settle()

        XCTAssertFalse(window.window.raised)
    }

    func testADesktopThatRefusesToBecomeActiveStillRaisesTheWindow() async throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let gate = DesktopActivationGate()
        let window = fixture.register(desktopOrdinal: 1, cascadeOrdinal: 0)

        fixture.registry.focusWorkspaceWindow(id: window.id, activateDesktop: { await gate.activate($0) })
        try await settle()
        gate.complete(reached: false)

        // The window may already be reachable, and a silent no-op is worse than a window the user has
        // to look for.
        try await waitUntil { window.window.raised }
    }

    func testWithoutASpacesAuthorityTheWindowIsRaisedWhereItStands() throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let window = fixture.register(desktopOrdinal: 1, cascadeOrdinal: 0)

        fixture.registry.focusWorkspaceWindow(id: window.id, activateDesktop: nil)

        XCTAssertTrue(window.window.raised)
    }

    func testGoingToAWindowThatIsAlreadyGoneIsIgnored() async throws {
        let fixture = try RegistryFixture(sessions: [])
        defer { fixture.remove() }
        let gate = DesktopActivationGate()
        let window = fixture.register(desktopOrdinal: 1, cascadeOrdinal: 0)
        window.window.close()

        fixture.registry.focusWorkspaceWindow(id: window.id, activateDesktop: { await gate.activate($0) })
        try await settle()

        XCTAssertTrue(gate.requested.isEmpty)
    }

    /// Lets the reveal's task run without waiting for anything in particular, so a test can look at
    /// the state between the switch being asked for and it completing.
    private func settle() async throws {
        try await Task.sleep(nanoseconds: 20_000_000)
    }

    private func waitUntil(
        timeout: UInt64 = 1_000_000_000,
        _ predicate: @escaping @MainActor () -> Bool
    ) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeout
        while DispatchTime.now().uptimeNanoseconds < deadline {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(predicate())
    }
}

private enum FixtureError: Error { case unavailable }

private func fixtureSession() -> PtySessionSummary {
    PtySessionSummary(
        name: "persistent",
        cwd: "/tmp",
        shell: "/bin/zsh",
        pid: 42,
        state: .running,
        startedAtUnixMilliseconds: 1,
        columns: 80,
        rows: 24,
        revision: 7,
        clients: []
    )
}

@MainActor
private final class RegistryFixture {
    let directory: URL
    let store: TerminalWindowPresentationStore
    let spawner = FakeExistingSessionSpawner()
    let desktopPlacer = FakeTerminalWindowDesktopPlacer()
    let registry: TerminalWindowRegistry

    init(sessions: [PtySessionSummary]? = nil, error: Error? = nil) throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("terminal-registry-\(UUID().uuidString)", isDirectory: true)
        store = TerminalWindowPresentationStore(
            url: directory.appendingPathComponent("presentations.json")
        )
        registry = TerminalWindowRegistry(
            store: store,
            client: FakeSessionLister(sessions: sessions, error: error),
            spawn: spawner,
            desktopPlacer: desktopPlacer
        )
    }

    /// An open window at a known place, which is what the chooser lists windows by. Registered without
    /// focus so a later raise is the only thing that could have raised it.
    func register(desktopOrdinal: Int, cascadeOrdinal: Int) -> (id: UUID, window: FakeTrackedTerminalWindow) {
        let id = UUID()
        let window = FakeTrackedTerminalWindow(frame: CGRect(x: 0, y: 0, width: 700, height: 460))
        registry.register(
            window,
            sessionName: "persistent",
            workspaceID: UUID(),
            workspaceLabel: "Workspace",
            cascadeOrdinal: cascadeOrdinal,
            placement: WorkspaceWindowPlacement(
                desktop: WorkspaceDesktopAssignment(
                    spaceID: UInt64(20 + desktopOrdinal),
                    displayID: "D1",
                    ordinal: desktopOrdinal
                ),
                frame: CGRect(x: 0, y: 0, width: 700, height: 460)
            ),
            focus: false,
            presentationID: id
        )
        return (id, window)
    }

    @discardableResult
    func seed() throws -> TerminalWindowPresentationDescriptor {
        let descriptor = TerminalWindowPresentationDescriptor(
            id: UUID(),
            sessionName: "persistent",
            workspaceID: UUID(),
            placement: WorkspaceWindowPlacement(
                desktop: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1),
                frame: CGRect(x: 40, y: 50, width: 700, height: 460)
            ),
            cascadeOrdinal: 1,
            workspaceLabel: "Workspace"
        )
        try store.upsert(descriptor)
        return descriptor
    }

    func remove() {
        registry.prepareForHostTermination()
        try? FileManager.default.removeItem(at: directory)
    }
}

@MainActor
private final class FakeTerminalWindowDesktopPlacer: TerminalWindowDesktopPlacing {
    private(set) var presentedPlacements: [WorkspaceWindowPlacement] = []
    private(set) var focusRequests: [Bool] = []
    var shouldFail = false

    func present(
        _ window: any TerminalWindowPresentationTrackable,
        at placement: WorkspaceWindowPlacement,
        focus: Bool
    ) throws -> WorkspaceWindowPlacement {
        presentedPlacements.append(placement)
        focusRequests.append(focus)
        if shouldFail { throw FixtureError.unavailable }
        window.place(into: placement.frame)
        if focus { window.raise() } else { window.orderWithoutFocus() }
        return placement
    }

    func capture(
        _ window: any TerminalWindowPresentationTrackable,
        preserving placement: WorkspaceWindowPlacement
    ) throws -> WorkspaceWindowPlacement? {
        var captured = placement
        captured.frame = window.currentFrame
        return captured
    }
}

private struct FakeSessionLister: TerminalSessionListing {
    let sessions: [PtySessionSummary]?
    let errorDescription: String?

    init(sessions: [PtySessionSummary]?, error: Error?) {
        self.sessions = sessions
        errorDescription = error.map(String.init(describing:))
    }

    func listSessions() async throws -> [PtySessionSummary] {
        if errorDescription != nil { throw FixtureError.unavailable }
        return sessions ?? []
    }
}

@MainActor
private final class FakeExistingSessionSpawner: TerminalExistingSessionSpawning {
    var window: FakeTrackedTerminalWindow?

    func spawnExistingWorkspace(
        sessions: [PtySessionSummary],
        state: PtyTerminalWorkspaceState,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    ) {
        let window = FakeTrackedTerminalWindow(frame: frame)
        self.window = window
        completion(.success(window))
    }
}

@MainActor
private final class FakeTrackedTerminalWindow: TerminalWindowPresentationTrackable {
    var isOpen = true
    var assignedDesktopWindowID: UInt32?
    var currentFrame: CGRect
    var workspaceLabel = ""
    var orderedWithoutFocus = false
    var closedPreservingPresentation = false
    var raised = false
    var terminalWorkspaceState = PtyTerminalWorkspaceState(restoringSessionName: "persistent")
    private var frameChanged: ((CGRect) -> Void)?
    private var closed: ((TerminalWindowCloseReason) -> Void)?

    init(frame: CGRect) { currentFrame = frame }
    func place(into frame: CGRect) { currentFrame = frame }
    func park() {}
    func unpark(into frame: CGRect) { currentFrame = frame }
    func raise() { raised = true }
    func prepareForAssignedDesktop(into frame: CGRect) { currentFrame = frame }
    func revealAfterAssignedDesktop(into frame: CGRect, focus: Bool) { currentFrame = frame }
    func close() { isOpen = false; closed?(.user) }
    func setTerminalFontSize(_ pointSize: CGFloat) {}
    func setWorkspaceLabel(_ workspaceName: String) { workspaceLabel = workspaceName }
    func focusForAccessibility() { raised = true }
    func observePresentation(
        frameChanged: @escaping (CGRect) -> Void,
        workspaceChanged: @escaping (PtyTerminalWorkspaceState) -> Void,
        closed: @escaping (TerminalWindowCloseReason) -> Void
    ) {
        self.frameChanged = frameChanged
        self.closed = closed
    }
    func orderWithoutFocus() { orderedWithoutFocus = true }
    func closePreservingPresentation() {
        isOpen = false
        closedPreservingPresentation = true
    }
}
