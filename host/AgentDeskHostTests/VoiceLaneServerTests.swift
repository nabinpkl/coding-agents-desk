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
                baseURL: URL(string: "http://127.0.0.1:7692")!,
                recordingSessionID: "11111111-2222-3333-4444-555555555555"
            )
        )
        #expect(
            url.absoluteString
                == "ws://127.0.0.1:7692/ws/voice?source=iphone&clientSessionID=11111111-2222-3333-4444-555555555555"
        )
    }

    @Test(
        arguments: [
            (VoiceRESTMethod.get, "/recordings"),
            (
                .get,
                "/recordings/client-session/"
                    + "11111111-2222-3333-4444-555555555555"
            ),
            (.get, "/recordings/session-20260726-221100-123456"),
            (.get, "/recordings/session-20260726-221100-123456/audio"),
            (.delete, "/recordings/session-20260726-221100-123456"),
            (.post, "/recordings/session-20260726-221100-123456/reanalyze"),
            (.get, "/reference-speech/state"),
            (.post, "/reference-speech/artifacts"),
            (
                .get,
                "/reference-speech/artifacts/"
                    + String(repeating: "a", count: 64)
                    + "/audio"
            ),
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
            (.post, "/reference-speech/state"),
            (.get, "/reference-speech/artifacts/not-a-hash/audio"),
            (
                .delete,
                "/reference-speech/artifacts/"
                    + String(repeating: "a", count: 64)
                    + "/audio"
            ),
        ]
    )
    func arbitraryRoutesAreRejected(
        method: VoiceRESTMethod,
        path: String
    ) {
        #expect(!VoiceLaneServer.isAllowed(method: method, path: path))
    }

    @Test
    func practicePassageRoutesAreNarrowlyAllowlisted() {
        let passage = "/practice-passages/passage-"
            + String(repeating: "1", count: 32)
        let allowed: [(VoiceRESTMethod, String)] = [
            (.get, "/practice-passages?limit=50"),
            (
                .get,
                "/practice-passages?cursor=passage-"
                    + String(repeating: "1", count: 32)
                    + "&limit=20"
            ),
            (.get, passage),
            (.delete, passage),
            (.post, passage + "/intended-text"),
            (.post, passage + "/baseline"),
            (.get, passage + "/attempts?limit=20"),
            (
                .delete,
                passage + "/attempts/session-20260726-221100-123456"
            ),
        ]
        for (method, path) in allowed {
            #expect(VoiceLaneServer.isAllowed(method: method, path: path))
        }

        let rejected = [
            "/practice-passages?limit=0",
            "/practice-passages?unknown=true",
            "/practice-passages?limit=20&limit=21",
            "/practice-passages/not-a-passage",
        ]
        for path in rejected {
            #expect(!VoiceLaneServer.isAllowed(method: .get, path: path))
        }
    }
}
