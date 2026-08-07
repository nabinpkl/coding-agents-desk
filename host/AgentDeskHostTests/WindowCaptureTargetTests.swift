import CoreGraphics
import Testing
import AgentDeskWire
@testable import AgentDeskHost

// The view-only guarantee and the store the input loop reads it from. Both are exercised
// here rather than through a device run because the failure mode is silent: a leaked click
// lands on a display the viewer cannot see, and nothing on the phone shows it happened.
struct WindowCaptureTargetTests {
    @Test func inputGateDropsEverythingThatActsOnTheWatchedMac() {
        let denied: [NormalizedInput] = [
            .cursorSet(displayId: "d1", x: 10, y: 10),
            .cursorMove(dx: 3, dy: -3),
            .click(button: .left),
            .click(button: .right),
            .scroll(dx: 0, dy: -4, phase: .changed),
            .dragStart,
            .dragEnd,
            .systemCommand(.missionControl),
            .key(code: "a", modifiers: []),
            .modifierArm(mod: .cmd)
        ]

        for input in denied {
            #expect(!WindowCaptureInputGate.allowsWhileWatchingWindow(input))
        }
    }

    // The Spaces strip stays visible above the window picker and its tiles promise to switch
    // the Mac's Desktop. Gating those would break a surface the window feature never touched.
    @Test func inputGateStillAllowsSpaceNavigation() {
        #expect(WindowCaptureInputGate.allowsWhileWatchingWindow(.switchSpaceStep(delta: 1)))
        #expect(WindowCaptureInputGate.allowsWhileWatchingWindow(
            .switchSpaceGesture(phase: .changed, progress: 0.5, velocityX: -2)
        ))
    }

    @Test func captureTargetStoreReportsOnlyRealChanges() {
        let store = CaptureTargetStore()
        #expect(store.selectedWindowId == nil)
        #expect(!store.isWatchingWindow)

        #expect(store.select(windowId: CGWindowID(42)))
        #expect(store.selectedWindowId == 42)
        #expect(store.isWatchingWindow)

        // A repeated config push must not restart capture, which would cost a keyframe.
        #expect(!store.select(windowId: CGWindowID(42)))

        #expect(store.select(windowId: CGWindowID(43)))
        #expect(store.select(windowId: nil))
        #expect(store.selectedWindowId == nil)
        #expect(!store.select(windowId: nil))
    }
}
