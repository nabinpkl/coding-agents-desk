import Foundation
import Testing

@testable import AgentDeskHost

struct VoiceSidecarOutputFramerTests {
    @Test func preservesCompleteLinesAcrossSplitPipeReads() {
        var framer = VoiceSidecarOutputFramer()

        let first = framer.consume(
            Data(#"{"event":"voice-timing","stage":"mlxTranscription"}"#.utf8)
        )
        let second = framer.consume(
            Data("\npartial".utf8)
        )
        let third = framer.consume(
            Data("-line\nsecond\n".utf8)
        )

        #expect(first == [])
        #expect(second == [
            #"{"event":"voice-timing","stage":"mlxTranscription"}"#
        ])
        #expect(third == ["partial-line", "second"])
    }

    @Test func resetDropsAnIncompletePriorGenerationLine() {
        var framer = VoiceSidecarOutputFramer()
        #expect(framer.consume(Data("stale".utf8)) == [])

        framer.reset()

        #expect(framer.consume(Data("fresh\n".utf8)) == ["fresh"])
    }

    @Test func forwardsOnlyParsedTimingEvents() {
        #expect(
            VoiceSidecarOutputFramer.isTimingEvent(
                #"{"event":"voice-timing","stage":"voiceSession"}"#
            )
        )
        #expect(
            !VoiceSidecarOutputFramer.isTimingEvent(
                #"dependency output containing "event":"voice-timing""#
            )
        )
        #expect(
            !VoiceSidecarOutputFramer.isTimingEvent(
                #"{"event":"transcript","text":"voice-timing"}"#
            )
        )
    }
}
