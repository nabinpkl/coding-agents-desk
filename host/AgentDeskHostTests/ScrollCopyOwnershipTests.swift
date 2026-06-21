import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollCopyOwnershipTests {
    @Test func ownershipHintExpiresAfterConfiguredTTL() throws {
        var ownership = ScrollCopyOwnership(config: ScrollCopyOwnershipConfig(ownershipTTLMs: 500))

        ownership.observeAccepted(
            axis: .vertical,
            sign: -1,
            offsetPx: -24,
            frameId: 10,
            nowUptimeNs: 1_000_000_000
        )

        let activeHint = try #require(ownership.hint(nowUptimeNs: 1_499_999_999))
        #expect(activeHint.source == .scrollCopyOwnership)
        #expect(activeHint.axis == .vertical)
        #expect(activeHint.sign == -1)
        #expect(activeHint.predictedOffsetPx == -24)
        #expect(activeHint.candidateOffsets == [-24])
        #expect(ownership.hint(nowUptimeNs: 1_500_000_001) == nil)
    }

    @Test func activeInputHintWinsUntilItExpiresThenOwnershipHintTakesOver() throws {
        var ownership = ScrollCopyOwnership()
        let inputHint = ScrollActivityHint(
            axis: .horizontal,
            sign: 1,
            predictedOffsetPx: 12,
            candidateOffsets: [12, 13],
            activeUntilUptimeNs: 1_100_000_000,
            eventCount: 7
        )

        ownership.observeInputHint(inputHint)
        ownership.observeAccepted(
            axis: .vertical,
            sign: -1,
            offsetPx: -18,
            frameId: 20,
            nowUptimeNs: 1_000_000_000
        )

        #expect(ownership.hint(nowUptimeNs: 1_050_000_000) == inputHint)

        let ownershipHint = try #require(ownership.hint(nowUptimeNs: 1_100_000_001))
        #expect(ownershipHint.source == .scrollCopyOwnership)
        #expect(ownershipHint.axis == .vertical)
        #expect(ownershipHint.predictedOffsetPx == -18)
    }

    @Test func acceptedCopyRectRefreshesOwnershipWindowAndResetsMisses() throws {
        var ownership = ScrollCopyOwnership(config: ScrollCopyOwnershipConfig(ownershipTTLMs: 500))

        ownership.observeAccepted(
            axis: .vertical,
            sign: -1,
            offsetPx: -12,
            frameId: 30,
            nowUptimeNs: 1_000_000_000
        )
        ownership.observeMiss(nowUptimeNs: 1_100_000_000)
        ownership.observeAccepted(
            axis: .vertical,
            sign: -1,
            offsetPx: -20,
            frameId: 31,
            nowUptimeNs: 1_490_000_000
        )

        #expect(ownership.latestAcceptedFrameId == 31)
        #expect(ownership.latestAcceptedOffsetPx == -20)
        #expect(ownership.missCount == 0)
        #expect(ownership.activeUntilUptimeNs == 1_990_000_000)
        #expect(ownership.hint(nowUptimeNs: 1_500_000_001)?.predictedOffsetPx == -20)
    }

    @Test func missCountGatesOwnershipHintAtConfiguredLimit() throws {
        var ownership = ScrollCopyOwnership(config: ScrollCopyOwnershipConfig(maxMisses: 2))

        ownership.observeAccepted(
            axis: .horizontal,
            sign: 1,
            offsetPx: 9,
            frameId: 40,
            nowUptimeNs: 1_000_000_000
        )
        ownership.observeMiss(nowUptimeNs: 1_100_000_000)

        #expect(ownership.hint(nowUptimeNs: 1_100_000_000)?.source == .scrollCopyOwnership)
        #expect(!ownership.allowsHevcFallback(nowUptimeNs: 1_100_000_000))

        ownership.observeMiss(nowUptimeNs: 1_120_000_000)

        #expect(ownership.missCount == 2)
        #expect(ownership.hint(nowUptimeNs: 1_120_000_000) == nil)
        #expect(ownership.allowsHevcFallback(nowUptimeNs: 1_120_000_000))
    }

    @Test func hevcFallbackIsAllowedAfterConfiguredWindowWithoutAcceptedGraphics() {
        var ownership = ScrollCopyOwnership(config: ScrollCopyOwnershipConfig(fallbackAfterMs: 300))

        #expect(ownership.allowsHevcFallback(nowUptimeNs: 1_000_000_000))

        ownership.observeAccepted(
            axis: .vertical,
            sign: 1,
            offsetPx: 16,
            frameId: 50,
            nowUptimeNs: 1_000_000_000
        )

        #expect(!ownership.allowsHevcFallback(nowUptimeNs: 1_299_999_999))
        #expect(ownership.allowsHevcFallback(nowUptimeNs: 1_300_000_000))

        ownership.observeAccepted(
            axis: .vertical,
            sign: 1,
            offsetPx: 18,
            frameId: 51,
            nowUptimeNs: 1_290_000_000
        )

        #expect(!ownership.allowsHevcFallback(nowUptimeNs: 1_589_999_999))
        #expect(ownership.allowsHevcFallback(nowUptimeNs: 1_590_000_000))
    }

    @Test func releaseClearsOwnershipAndStoredInputHint() {
        var ownership = ScrollCopyOwnership()
        ownership.observeInputHint(ScrollActivityHint(
            axis: .vertical,
            sign: 1,
            predictedOffsetPx: 10,
            candidateOffsets: [10],
            activeUntilUptimeNs: UInt64.max,
            eventCount: 1
        ))
        ownership.observeAccepted(
            axis: .vertical,
            sign: 1,
            offsetPx: 10,
            frameId: 60,
            nowUptimeNs: 1_000_000_000
        )

        ownership.release()

        #expect(ownership.latestInputHint == nil)
        #expect(ownership.latestAcceptedFrameId == nil)
        #expect(ownership.missCount == 0)
        #expect(ownership.hint(nowUptimeNs: 1_000_000_000) == nil)
        #expect(ownership.allowsHevcFallback(nowUptimeNs: 1_000_000_000))
    }
}
