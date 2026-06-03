import Foundation
import Testing

struct VoiceChildControllerTests {
    @Test func parsesTranscript() throws {
        let transcript = try #require(try VoiceChildController.transcript(
            from: #"{"type":"transcript","id":"request-1","text":"hello world"}"#
        ))

        #expect(transcript.id == "request-1")
        #expect(transcript.text == "hello world")
    }

    @Test func ignoresLifecycleForTranscriptParsing() throws {
        let transcript = try VoiceChildController.transcript(
            from: #"{"type":"ready","protocol":1}"#
        )

        #expect(transcript == nil)
    }

    @Test func rejectsEmptyTranscript() {
        #expect(throws: VoiceChildControllerError.emptyTranscript) {
            _ = try VoiceChildController.transcript(
                from: #"{"type":"transcript","id":"request-1","text":"   "}"#
            )
        }
    }

    @Test func rejectsTranscriptWithoutID() {
        #expect(throws: VoiceChildControllerError.missingID) {
            _ = try VoiceChildController.transcript(
                from: #"{"type":"transcript","text":"hello"}"#
            )
        }
    }
}
