import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollActivityTrackerTests {
    @Test func verticalNegativeDyProducesNegativePredictedAndCandidateOffsets() throws {
        var tracker = ScrollActivityTracker()

        tracker.record(.scroll(dx: 0, dy: -42, phase: .changed), nowUptimeNs: 1_000)

        let hint = try #require(tracker.hint(nowUptimeNs: 1_000))
        #expect(hint.axis == .vertical)
        #expect(hint.sign == -1)
        #expect(hint.predictedOffsetPx == -42)
        #expect(!hint.candidateOffsets.isEmpty)
        #expect(hint.candidateOffsets.allSatisfy { $0 < 0 })
        #expect(hint.candidateOffsets == [-42, -58, -50, -46, -44, -43, -41, -40, -38, -34, -26])
    }

    @Test func positiveDyProducesPositiveOffsets() throws {
        var tracker = ScrollActivityTracker()

        tracker.record(.scroll(dx: 0, dy: 27, phase: .changed), nowUptimeNs: 1_000)

        let hint = try #require(tracker.hint(nowUptimeNs: 1_000))
        #expect(hint.axis == .vertical)
        #expect(hint.sign == 1)
        #expect(hint.predictedOffsetPx == 27)
        #expect(!hint.candidateOffsets.isEmpty)
        #expect(hint.candidateOffsets.allSatisfy { $0 > 0 })
    }

    @Test func inputPixelScaleMapsSmallGestureDeltaToVisiblePixelOffset() throws {
        var tracker = ScrollActivityTracker(inputPixelScale: 24)

        tracker.record(.scroll(dx: 0, dy: -1, phase: .changed), nowUptimeNs: 1_000)

        let hint = try #require(tracker.hint(nowUptimeNs: 1_000))
        #expect(hint.predictedOffsetPx == -24)
        #expect(hint.candidateOffsets.first == -24)
        #expect(hint.candidateOffsets.contains(-40))
        #expect(hint.candidateOffsets.contains(-8))
        #expect(hint.candidateOffsets.allSatisfy { $0 < 0 })
    }

    @Test func hintExpiresAfterTheActiveWindow() throws {
        var tracker = ScrollActivityTracker(activeWindowMs: 10)

        tracker.record(.scroll(dx: 0, dy: 12, phase: .changed), nowUptimeNs: 5_000_000)

        let activeHint = try #require(tracker.hint(nowUptimeNs: 14_999_999))
        #expect(activeHint.isActive(nowUptimeNs: 14_999_999))
        #expect(tracker.hint(nowUptimeNs: 15_000_001) == nil)
    }

    @Test func endedAndMomentumEndedKeepLastHintOnlyThroughGraceWindow() throws {
        var endedTracker = ScrollActivityTracker(activeWindowMs: 10)
        endedTracker.record(.scroll(dx: 0, dy: 18, phase: .changed), nowUptimeNs: 1_000_000)
        endedTracker.record(.scroll(dx: 0, dy: 0, phase: .ended), nowUptimeNs: 6_000_000)

        let endedHint = try #require(endedTracker.hint(nowUptimeNs: 15_999_999))
        #expect(endedHint.predictedOffsetPx == 18)
        #expect(endedTracker.hint(nowUptimeNs: 16_000_001) == nil)

        var momentumTracker = ScrollActivityTracker(activeWindowMs: 10)
        momentumTracker.record(.scroll(dx: 0, dy: -18, phase: .momentumChanged), nowUptimeNs: 1_000_000)
        momentumTracker.record(.scroll(dx: 0, dy: 0, phase: .momentumEnded), nowUptimeNs: 6_000_000)

        let momentumHint = try #require(momentumTracker.hint(nowUptimeNs: 15_999_999))
        #expect(momentumHint.predictedOffsetPx == -18)
        #expect(momentumTracker.hint(nowUptimeNs: 16_000_001) == nil)
    }

    @Test func candidateListIsUniqueClampedPredictedFirstAndBounded() throws {
        var tracker = ScrollActivityTracker(activeWindowMs: 180, maxOffsetPx: 8)

        tracker.record(.scroll(dx: 0, dy: 100, phase: .changed), nowUptimeNs: 1_000)

        let hint = try #require(tracker.hint(nowUptimeNs: 1_000))
        #expect(hint.predictedOffsetPx == 8)
        #expect(hint.candidateOffsets.first == 8)
        #expect(Set(hint.candidateOffsets).count == hint.candidateOffsets.count)
        #expect(hint.candidateOffsets.allSatisfy { abs($0) >= 1 && abs($0) <= 8 })
        #expect(hint.candidateOffsets.count <= 11)
    }

    @Test func candidateListKeepsLatestDeltaFirstAndCumulativeAsFallback() throws {
        var tracker = ScrollActivityTracker(activeWindowMs: 180, maxOffsetPx: 240)

        tracker.record(.scroll(dx: 0, dy: -10, phase: .changed), nowUptimeNs: 1_000)
        tracker.record(.scroll(dx: 0, dy: -15, phase: .changed), nowUptimeNs: 2_000)

        let hint = try #require(tracker.hint(nowUptimeNs: 2_000))
        #expect(hint.predictedOffsetPx == -15)
        #expect(hint.candidateOffsets.first == -15)
        #expect(hint.candidateOffsets.contains(-25))
        #expect(hint.candidateOffsets.allSatisfy { $0 < 0 })
        #expect(Set(hint.candidateOffsets).count == hint.candidateOffsets.count)
        #expect(hint.candidateOffsets.count <= 24)
    }

    @Test func nonScrollInputLeavesNoActiveHint() {
        var tracker = ScrollActivityTracker()

        tracker.record(.cursorMove(dx: 12, dy: 5), nowUptimeNs: 1_000)
        tracker.record(.click(button: .left), nowUptimeNs: 2_000)
        tracker.record(.key(code: "ansi-A", modifiers: []), nowUptimeNs: 3_000)

        #expect(tracker.hint(nowUptimeNs: 3_000) == nil)
    }

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

    @Test func motionSignalLapsesToRestAfterActiveWindow() throws {
        var tracker = ScrollActivityTracker(activeWindowMs: 10)

        tracker.record(.scroll(dx: 0, dy: 12, phase: .changed), nowUptimeNs: 5_000_000)

        _ = try #require(tracker.motionSignal(nowUptimeNs: 14_999_999))
        #expect(tracker.motionSignal(nowUptimeNs: 15_000_001) == nil)
    }

    @Test func noInputProducesRestSignal() {
        let tracker = ScrollActivityTracker()
        #expect(tracker.motionSignal(nowUptimeNs: 1_000) == nil)
    }

    @Test func nonScrollInputLeavesRestSignal() {
        var tracker = ScrollActivityTracker()

        tracker.record(.cursorMove(dx: 12, dy: 5), nowUptimeNs: 1_000)
        tracker.record(.click(button: .left), nowUptimeNs: 2_000)

        #expect(tracker.motionSignal(nowUptimeNs: 2_000) == nil)
    }
}
