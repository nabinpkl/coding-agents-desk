import AgentDeskWire
import Foundation
import Testing

@testable import AgentDeskClient

struct ReferenceAudioPlaybackTests {
    @Test func downloadReassemblesOrderedVoiceLaneChunks() throws {
        var download = ReferenceAudioDownload(
            artifactID: String(repeating: "a", count: 64),
            expectedAudioHash: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            requestID: "reference-audio-1"
        )
        let first = try download.append(VoiceRESTResponse(
            requestID: "reference-audio-1",
            status: 200,
            contentType: "audio/wav",
            sequence: 0,
            isFinal: false,
            body: Data([1, 2])
        ))
        #expect(first == nil)
        let completed = try download.append(VoiceRESTResponse(
            requestID: "reference-audio-1",
            status: 200,
            contentType: "audio/wav",
            sequence: 1,
            isFinal: true,
            body: Data([3, 4])
        ))
        #expect(completed == Data([1, 2, 3, 4]))
    }

    @Test func downloadRejectsStaleSequenceAndHTTPFailure() throws {
        var outOfOrder = ReferenceAudioDownload(
            artifactID: String(repeating: "a", count: 64),
            expectedAudioHash: String(repeating: "0", count: 64),
            requestID: "reference-audio-1"
        )
        #expect(throws: ReferenceAudioDownloadError.invalidSequence) {
            try outOfOrder.append(VoiceRESTResponse(
                requestID: "reference-audio-1",
                status: 200,
                contentType: "audio/wav",
                sequence: 1,
                isFinal: true,
                body: Data()
            ))
        }

        var failed = ReferenceAudioDownload(
            artifactID: String(repeating: "b", count: 64),
            expectedAudioHash: String(repeating: "0", count: 64),
            requestID: "reference-audio-2"
        )
        #expect(throws: ReferenceAudioDownloadError.self) {
            try failed.append(VoiceRESTResponse(
                requestID: "reference-audio-2",
                status: 404,
                contentType: "application/json",
                body: Data(#"{"detail":"missing"}"#.utf8)
            ))
        }

        var corrupt = ReferenceAudioDownload(
            artifactID: String(repeating: "c", count: 64),
            expectedAudioHash: String(repeating: "0", count: 64),
            requestID: "reference-audio-3"
        )
        #expect(throws: ReferenceAudioDownloadError.hashMismatch) {
            try corrupt.append(VoiceRESTResponse(
                requestID: "reference-audio-3",
                status: 200,
                contentType: "audio/wav",
                body: Data([1, 2, 3, 4])
            ))
        }
    }
}
