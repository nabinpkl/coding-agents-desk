import CoreGraphics
import Foundation
import PtyClientSwift
import TerminalEmulator
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
        XCTAssertEqual(fixture.spawner.window?.currentFrame, descriptor.frame.cgRect)
        XCTAssertFalse(fixture.spawner.window?.raised ?? true)

        fixture.registry.prepareForHostTermination()
        XCTAssertTrue(fixture.spawner.window?.closedPreservingPresentation ?? false)
        XCTAssertEqual(fixture.store.descriptors.map(\.id), [descriptor.id])
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
        lifetime: .persistent,
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
            spawn: spawner
        )
    }

    @discardableResult
    func seed() throws -> TerminalWindowPresentationDescriptor {
        let descriptor = TerminalWindowPresentationDescriptor(
            id: UUID(),
            sessionName: "persistent",
            workspaceID: UUID(),
            frame: TerminalWindowFrame(CGRect(x: 40, y: 50, width: 700, height: 460)),
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

    func spawnExistingSession(
        _ session: PtySessionSummary,
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
