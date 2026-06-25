import Foundation
import Testing

@testable import AgentDeskHost

struct MotionGovernorTests {
    private static let config = MotionGovernorConfig(
        restQuality: 0.85,
        scrollReadableQuality: 0.5,
        frameIntervalStepNs: 33_000_000,
        frameIntervalMaxNs: 120_000_000,
        busyResolutionScaleFloor: 0.5
    )

    private static func governor() -> MotionGovernor {
        MotionGovernor(config: config)
    }

    @Test func restPolicyUsesRestQuality() {
        let policy = Self.governor().policy(state: .rest, heldCount: 0)
        #expect(policy.exposedStripQuality == 0.85)
        #expect(policy.minFrameIntervalNs == 0)
        #expect(policy.busyResolutionScale == 1.0)
    }

    @Test func scrollingPolicyUsesReadableFloor() {
        let policy = Self.governor().policy(state: .scrolling, heldCount: 0)
        #expect(policy.exposedStripQuality == 0.5)
    }

    @Test func noBackpressureImposesNoInterval() {
        #expect(Self.governor().policy(state: .scrolling, heldCount: 0).minFrameIntervalNs == 0)
    }

    @Test func intervalWidensMonotonicallyWithHeld() {
        let governor = Self.governor()
        var previous: UInt64 = 0
        for held in 0...3 {
            let interval = governor.policy(state: .scrolling, heldCount: held).minFrameIntervalNs
            #expect(interval >= previous)
            previous = interval
        }
        #expect(governor.policy(state: .scrolling, heldCount: 1).minFrameIntervalNs == 33_000_000)
        #expect(governor.policy(state: .scrolling, heldCount: 2).minFrameIntervalNs == 66_000_000)
    }

    @Test func intervalCapsAtMax() {
        // 10 * 33ms = 330ms, capped at 120ms.
        let interval = Self.governor().policy(state: .scrolling, heldCount: 10).minFrameIntervalNs
        #expect(interval == 120_000_000)
    }

    @Test func busyScaleFullWithoutBackpressure() {
        #expect(Self.governor().policy(state: .scrolling, heldCount: 0).busyResolutionScale == 1.0)
    }

    @Test func busyScaleDropsToFloorUnderBackpressure() {
        #expect(Self.governor().policy(state: .scrolling, heldCount: 1).busyResolutionScale == 0.5)
    }

    @Test func qualityNeverBelowReadableFloorAsHeldRises() {
        let governor = Self.governor()
        for held in 0...8 {
            let quality = governor.policy(state: .scrolling, heldCount: held).exposedStripQuality
            #expect(quality >= 0.5)
            #expect(quality == 0.5)
        }
    }

    @Test func negativeHeldIsClampedToZero() {
        let policy = Self.governor().policy(state: .scrolling, heldCount: -3)
        #expect(policy.minFrameIntervalNs == 0)
        #expect(policy.busyResolutionScale == 1.0)
    }
}
