import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollActivityTrackerTests {
    @Test func verticalScrollProducesScrollingSignalWithAxisAndSign() throws {
        var tracker = ScrollActivityTracker()

        tracker.record(.scroll(dx: 0, dy: 27, phase: .changed), nowUptimeNs: 1_000)

        let signal = try #require(tracker.motionSignal(nowUptimeNs: 1_000))
        #expect(signal.axis == .vertical)
        #expect(signal.sign == 1)
    }

    @Test func upwardScrollProducesNegativeSign() throws {
        var tracker = ScrollActivityTracker()

        tracker.record(.scroll(dx: 0, dy: -27, phase: .changed), nowUptimeNs: 1_000)

        let signal = try #require(tracker.motionSignal(nowUptimeNs: 1_000))
        #expect(signal.sign == -1)
    }

    @Test func horizontalDominantProducesHorizontalSignal() throws {
        var tracker = ScrollActivityTracker()

        tracker.record(.scroll(dx: 30, dy: 4, phase: .changed), nowUptimeNs: 1_000)

        let signal = try #require(tracker.motionSignal(nowUptimeNs: 1_000))
        #expect(signal.axis == .horizontal)
        #expect(signal.sign == 1)
    }

    @Test func directionChangeUpdatesSign() throws {
        var tracker = ScrollActivityTracker()

        tracker.record(.scroll(dx: 0, dy: 20, phase: .changed), nowUptimeNs: 1_000)
        tracker.record(.scroll(dx: 0, dy: -20, phase: .changed), nowUptimeNs: 2_000)

        let signal = try #require(tracker.motionSignal(nowUptimeNs: 2_000))
        #expect(signal.sign == -1)
    }

    @Test func motionSignalLapsesToRestAfterActiveWindow() throws {
        var tracker = ScrollActivityTracker(activeWindowMs: 10)

        tracker.record(.scroll(dx: 0, dy: 12, phase: .changed), nowUptimeNs: 5_000_000)

        _ = try #require(tracker.motionSignal(nowUptimeNs: 14_999_999))
        #expect(tracker.motionSignal(nowUptimeNs: 15_000_001) == nil)
    }

    @Test func terminalPhaseStillSettlesThroughGraceWindow() throws {
        var tracker = ScrollActivityTracker(activeWindowMs: 10)

        tracker.record(.scroll(dx: 0, dy: 18, phase: .changed), nowUptimeNs: 1_000_000)
        tracker.record(.scroll(dx: 0, dy: 0, phase: .ended), nowUptimeNs: 6_000_000)

        _ = try #require(tracker.motionSignal(nowUptimeNs: 15_999_999))
        #expect(tracker.motionSignal(nowUptimeNs: 16_000_001) == nil)
    }

    @Test func noInputProducesRestSignal() {
        let tracker = ScrollActivityTracker()
        #expect(tracker.motionSignal(nowUptimeNs: 1_000) == nil)
    }

    @Test func nonScrollInputLeavesRestSignal() {
        var tracker = ScrollActivityTracker()

        tracker.record(.cursorMove(dx: 12, dy: 5), nowUptimeNs: 1_000)
        tracker.record(.click(button: .left), nowUptimeNs: 2_000)
        tracker.record(.key(code: "ansi-A", modifiers: []), nowUptimeNs: 3_000)

        #expect(tracker.motionSignal(nowUptimeNs: 3_000) == nil)
    }

    @Test func storeRoundTripsMotionSignalThroughLock() throws {
        let store = ScrollActivityStore(tracker: ScrollActivityTracker(activeWindowMs: 50))

        store.record(.scroll(dx: 0, dy: -9, phase: .changed), nowUptimeNs: 1_000_000)

        let signal = try #require(store.motionSignal(nowUptimeNs: 1_000_000))
        #expect(signal.axis == .vertical)
        #expect(signal.sign == -1)
    }
}
