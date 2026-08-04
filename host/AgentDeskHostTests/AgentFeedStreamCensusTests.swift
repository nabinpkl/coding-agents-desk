import Foundation
import Testing

@testable import AgentDeskHost

/// The census exists to make a leaked stream visible while the pool still has headroom, so what is
/// under test is when it SPEAKS, not what it counts: a level that reprints on every open would be
/// noise nobody reads, and one that never re-arms would report the first leak and stay silent for
/// the rest of the host's life.
struct AgentFeedStreamCensusTests {
    @Test func staysSilentUntilLiveStreamsReachTheWatermark() {
        let census = AgentFeedStreamCensus(limit: 8, watermark: 3)

        #expect(census.opened() == .quiet)
        #expect(census.opened() == .quiet)
        #expect(census.opened() == .reachedWatermark(live: 3, watermark: 3, limit: 8))
        #expect(census.liveCount == 3)
    }

    @Test func warnsOnceWhileTheCountStaysAtOrAboveTheMark() {
        let census = AgentFeedStreamCensus(limit: 8, watermark: 2)
        _ = census.opened()
        #expect(census.opened() == .reachedWatermark(live: 2, watermark: 2, limit: 8))

        // Ordinary multi-window use sits above the mark for as long as those windows are open. One
        // line describes that; a line per stream would bury the one that mattered.
        #expect(census.opened() == .quiet)
        #expect(census.opened() == .quiet)
        #expect(census.closed() == .quiet)
    }

    @Test func rearmsAfterTheCountFallsBackBelowTheMark() {
        let census = AgentFeedStreamCensus(limit: 8, watermark: 2)
        _ = census.opened()
        _ = census.opened()

        #expect(census.closed() == .recovered(live: 1, watermark: 2))
        // Re-armed: the next climb has to be reported, or a host that oscillates around the mark
        // would announce its first crossing and never mention any that followed.
        #expect(census.opened() == .reachedWatermark(live: 2, watermark: 2, limit: 8))
    }

    @Test func aCloseWithoutAnOpenCannotInventHeadroom() {
        let census = AgentFeedStreamCensus(limit: 8, watermark: 2)

        #expect(census.closed() == .quiet)
        #expect(census.liveCount == 0)
        // Floored at zero rather than left negative: a negative count would hand back capacity the
        // pool does not have and hide the very exhaustion this watches for.
        _ = census.opened()
        #expect(census.liveCount == 1)
    }

    @Test func defaultsToThreeQuartersOfThePoolItDrawsFrom() {
        let census = AgentFeedStreamCensus(limit: 8)

        for _ in 0..<5 { #expect(census.opened() == .quiet) }
        #expect(census.opened() == .reachedWatermark(live: 6, watermark: 6, limit: 8))
    }

    @Test func countsRemainCoherentUnderConcurrentOpensAndCloses() async {
        // Streams open and close from many tasks at once; a torn count would make the warning fire
        // at the wrong level or not at all.
        let census = AgentFeedStreamCensus(limit: 1_000, watermark: 999)
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<200 {
                group.addTask {
                    _ = census.opened()
                    _ = census.closed()
                }
            }
        }

        #expect(census.liveCount == 0)
    }
}
