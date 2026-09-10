import AgentDeskWire
import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
@Suite(.serialized)
struct WorkspaceIDEWindowRegistryTests {
    @Test func eachPlusClickCreatesAnIndependentWindowAndCascadesPerDesktop() {
        let fixture = Fixture()
        defer { fixture.remove() }
        let baseFrame = CGRect(x: 100, y: 200, width: 1_180, height: 760)

        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        fixture.registry.open(placement(spaceID: 99, frame: baseFrame))

        #expect(fixture.controllers.count == 3)
        #expect(Set(fixture.ids).count == 3)
        #expect(fixture.controllers.map(\.placement.frame) == [
            baseFrame,
            baseFrame.offsetBy(dx: 28, dy: -28),
            baseFrame,
        ])
        #expect(fixture.controllers.map(\.activations) == [[true], [true], [true]])
    }

    @Test func restartRestoresEveryWindowPlacementAndIdentityWithoutFocus() async {
        let url = Fixture.makeStoreURL()
        let before = Fixture(storeURL: url)
        defer { before.remove() }
        let originalFrame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        before.registry.open(placement(spaceID: 41, frame: originalFrame))
        before.registry.open(placement(spaceID: 99, frame: originalFrame))
        let moved = CGRect(x: 620, y: 80, width: 1_000, height: 680)
        before.controllers[0].move(to: moved)
        await before.registry.beginStopAll().value

        let after = Fixture(storeURL: url)
        after.registry.startRestoration(
            visibleFrames: [CGRect(x: 0, y: 0, width: 2_560, height: 1_440)]
        )

        #expect(Set(after.ids) == Set(before.ids))
        #expect(Set(after.controllers.map(\.placement.frame)) == [moved, originalFrame])
        #expect(after.controllers.map(\.activations) == [[false], [false]])
    }

    @Test func userCloseDeletesOnlyThatWindowButHostTerminationPreservesTheRest() async {
        let url = Fixture.makeStoreURL()
        let fixture = Fixture(storeURL: url)
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let survivingID = fixture.ids[1]

        fixture.controllers[0].beginUserClose()
        await fixture.registry.beginStopAll().value

        #expect(WorkspaceIDEWindowPresentationStore(url: url).descriptors.map(\.id) == [survivingID])
    }

    @Test func theOpenWindowsAreListedInAStableOrderAndNamedByWhereTheyAre() {
        let fixture = Fixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame, ordinal: 1))
        fixture.registry.open(placement(spaceID: 41, frame: frame, ordinal: 1))
        fixture.registry.open(placement(spaceID: 99, frame: frame, ordinal: 0))

        // Ordered, because the backing store is a dictionary: a list that reshuffled between
        // openings would move a row out from under the pointer on its way to the close button.
        // Both numbers are shown from one while stored from zero, matching Mission Control.
        #expect(fixture.registry.openWindows.map(\.title) == [
            "IDE 1 · Desktop 1",
            "IDE 1 · Desktop 2",
            "IDE 2 · Desktop 2",
        ])
        #expect(fixture.registry.openWindows.allSatisfy { $0.kind == .ide })
        #expect(Set(fixture.registry.openWindows.map(\.id)).count == 3)
    }

    @Test func closingFromTheListEndsThatWindowTheWayItsOwnCloseButtonWould() throws {
        let storeURL = Fixture.makeStoreURL()
        let fixture = Fixture(storeURL: storeURL)
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.last)

        fixture.registry.closeWindow(id: target.id)

        // The user close path, not the termination one: the window forfeits its stored placement and
        // its local IDE state, where quitting would preserve both for the next launch.
        #expect(fixture.controllers.map(\.userCloseCount) == [0, 1])
        #expect(fixture.controllers.map(\.stopCount) == [0, 0])
        #expect(fixture.registry.openWindowCountForTesting == 1)
        #expect(WorkspaceIDEWindowPresentationStore(url: storeURL).descriptors.count == 1)
    }

    @Test func closingAWindowThatIsAlreadyGoneIsIgnored() throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)
        fixture.controllers[0].beginUserClose()

        // A chooser can only hold the list as it was when it opened, and the window may have closed
        // from its own titlebar in between. That is an ordinary race, not a programming error.
        fixture.registry.closeWindow(id: target.id)

        #expect(fixture.controllers[0].userCloseCount == 1)
        #expect(fixture.registry.openWindowCountForTesting == 0)
    }

    @Test func goingToAWindowMakesItsDesktopActiveBeforeRaisingIt() async throws {
        let gate = DesktopActivationGate()
        let fixture = Fixture(activateDesktop: { await gate.activate($0) })
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
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
        #expect(fixture.controllers.map(\.activations) == [[true], [true]])
    }

    @Test func aWindowClosedWhileItsDesktopWasStillArrivingIsNotRaised() async throws {
        let gate = DesktopActivationGate()
        let fixture = Fixture(activateDesktop: { await gate.activate($0) })
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)

        fixture.registry.focusWindow(id: target.id)
        await wait { gate.requested.count == 1 }
        fixture.controllers[0].beginUserClose()
        gate.complete(reached: true)
        await settle()

        // The Desktop switch is a real wait, so the window can be gone by the time it lands.
        #expect(fixture.controllers[0].focusCount == 0)
    }

    @Test func aDesktopThatRefusesToBecomeActiveStillRaisesTheWindow() async throws {
        let gate = DesktopActivationGate()
        let fixture = Fixture(activateDesktop: { await gate.activate($0) })
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
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
        let fixture = Fixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)

        fixture.registry.focusWindow(id: target.id)

        #expect(fixture.controllers[0].focusCount == 1)
    }

    @Test func goingToAWindowThatIsAlreadyGoneIsIgnored() throws {
        let fixture = Fixture()
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let target = try #require(fixture.registry.openWindows.first)
        fixture.controllers[0].beginUserClose()

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

    private func placement(spaceID: UInt64, frame: CGRect, ordinal: Int = 0) -> WorkspaceWindowPlacement {
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
private final class Fixture {
    let storeURL: URL
    let registry: WorkspaceIDEWindowRegistry
    private let recorder: Recorder

    var ids: [UUID] { recorder.ids }
    var controllers: [FakeWorkspaceIDEWindow] { recorder.controllers }

    static func makeStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-ide-presentations-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("presentations.json")
    }

    init(
        storeURL: URL = Fixture.makeStoreURL(),
        activateDesktop: DesktopActivating? = nil
    ) {
        self.storeURL = storeURL
        let recorder = Recorder()
        self.recorder = recorder
        registry = WorkspaceIDEWindowRegistry(
            store: WorkspaceIDEWindowPresentationStore(url: storeURL),
            persistDelay: .milliseconds(1),
            activateDesktop: activateDesktop,
            controllerFactory: { id, placement, onClosed in
                let controller = FakeWorkspaceIDEWindow(placement: placement, onClosed: onClosed)
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
private final class Recorder {
    var ids: [UUID] = []
    var controllers: [FakeWorkspaceIDEWindow] = []
}

@MainActor
private final class FakeWorkspaceIDEWindow: WorkspaceIDEWindowControlling {
    private(set) var placement: WorkspaceWindowPlacement
    private var placementChanged: ((WorkspaceWindowPlacement) -> Void)?
    private var onClosed: (@MainActor () -> Void)?
    private(set) var activations: [Bool] = []
    private(set) var focusCount = 0
    private(set) var userCloseCount = 0
    private(set) var stopCount = 0

    init(placement: WorkspaceWindowPlacement, onClosed: @escaping @MainActor () -> Void) {
        self.placement = placement
        self.onClosed = onClosed
    }

    func show(activating: Bool) {
        activations.append(activating)
    }

    func observePlacement(_ changed: @escaping (WorkspaceWindowPlacement) -> Void) {
        placementChanged = changed
    }

    func move(to frame: CGRect) {
        placement.frame = frame
        placementChanged?(placement)
    }

    func focus() {
        focusCount += 1
    }

    func beginUserClose() {
        userCloseCount += 1
        let closed = onClosed
        onClosed = nil
        closed?()
    }

    func stop() {
        stopCount += 1
        onClosed = nil
    }
}

