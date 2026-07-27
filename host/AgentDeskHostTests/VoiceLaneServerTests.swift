import Foundation
import Testing
import AgentDeskWire
@testable import AgentDeskHost

@Suite("Voice lane server")
struct VoiceLaneServerTests {
    @Test
    func restChunksRemainInsideTheVoiceFrameBoundary() throws {
        let response = VoiceLaneHostMessage.rest(VoiceRESTResponse(
            requestID: UUID().uuidString,
            status: 200,
            contentType: "audio/wav",
            sequence: 0,
            isFinal: false,
            body: Data(repeating: 0x7f, count: VoiceLaneServer.maximumRESTChunkBytes)
        ))
        #expect(
            try VoiceLaneCodec.encode(response).count
                < VoiceLaneCodec.maximumFrameBytes
        )
    }

    @Test
    func websocketURLForcesIPhoneSource() throws {
        let url = try #require(
            VoiceLaneServer.websocketURL(
                baseURL: URL(string: "http://127.0.0.1:7692")!
            )
        )
        #expect(url.absoluteString == "ws://127.0.0.1:7692/ws/voice?source=iphone")
    }

    @Test(
        arguments: [
            (VoiceRESTMethod.get, "/recordings"),
            (.get, "/recordings/session-20260726-221100-123456"),
            (.get, "/recordings/session-20260726-221100-123456/audio"),
            (.delete, "/recordings/session-20260726-221100-123456"),
            (.post, "/recordings/session-20260726-221100-123456/reanalyze"),
        ]
    )
    func recordingRoutesAreAllowlisted(
        method: VoiceRESTMethod,
        path: String
    ) {
        #expect(VoiceLaneServer.isAllowed(method: method, path: path))
    }

    @Test(
        arguments: [
            (VoiceRESTMethod.get, "https://example.com/recordings"),
            (.post, "/v1/audio/transcriptions"),
            (.get, "/health"),
            (.get, "/recordings/../../secret"),
            (.post, "/recordings/session-20260726-221100-123456/audio"),
            (.get, "/recordings/not-a-recording"),
        ]
    )
    func arbitraryRoutesAreRejected(
        method: VoiceRESTMethod,
        path: String
    ) {
        #expect(!VoiceLaneServer.isAllowed(method: method, path: path))
    }
}
