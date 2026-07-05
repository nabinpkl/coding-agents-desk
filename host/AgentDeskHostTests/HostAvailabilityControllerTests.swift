import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct HostAvailabilityControllerTests {
    @Test func lockPreservesSessionOnInputLaneClose() {
        var controller = HostAvailabilityController()

        let snapshot = controller.noteLock(reason: "session-resigned-active")

        #expect(snapshot?.availability == .locked)
        #expect(controller.preservesSessionOnInputLaneClose)
    }

    @Test func captureUnavailablePreservesSessionOnInputLaneClose() {
        var controller = HostAvailabilityController()

        let snapshot = controller.noteCaptureUnavailable(reason: "media-closed")

        #expect(snapshot?.availability == .captureUnavailable)
        #expect(controller.preservesSessionOnInputLaneClose)
    }

    @Test func activeAndDisconnectedDoNotPreserveInputLaneDeath() {
        var controller = HostAvailabilityController()

        #expect(!controller.preservesSessionOnInputLaneClose)
        _ = controller.noteDisconnected(reason: "session-ended")

        #expect(!controller.preservesSessionOnInputLaneClose)
    }

    @Test func lockWinsOverCaptureUnavailable() {
        var controller = HostAvailabilityController()
        _ = controller.noteLock(reason: "session-resigned-active")

        let snapshot = controller.noteCaptureUnavailable(reason: "media-closed")

        #expect(snapshot?.availability == .locked)
        #expect(controller.snapshot.availability == .locked)
        #expect(controller.snapshot.reason == "media-closed")
    }

    @Test func activeClearsLockPreservation() {
        var controller = HostAvailabilityController()
        _ = controller.noteLock(reason: "session-resigned-active")

        let snapshot = controller.noteActive(reason: "session-became-active")

        #expect(snapshot?.availability == .active)
        #expect(!controller.preservesSessionOnInputLaneClose)
    }
}
