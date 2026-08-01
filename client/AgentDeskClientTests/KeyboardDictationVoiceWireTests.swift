import Foundation
import Testing

struct KeyboardDictationVoiceWireTests {
    @Test func audioAndStopMessagesCarryContinuityFences() throws {
        let frame = KeyboardVoiceAudioFrame(
            sequence: 7,
            pcm: "AAAA",
            sampleCount: 317
        )
        let framePayload = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(frame)
        ) as? [String: Any]
        #expect(framePayload?["sequence"] as? Int == 7)
        #expect(framePayload?["sampleCount"] as? Int == 317)

        let stop = KeyboardVoiceSessionStop(
            finalSequence: 7,
            capturedSampleCount: 14_653
        )
        let stopPayload = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(stop)
        ) as? [String: Any]
        #expect(stopPayload?["finalSequence"] as? Int == 7)
        #expect(stopPayload?["capturedSampleCount"] as? Int == 14_653)
    }

    @Test func sessionCompletePreservesClientSessionCorrelation() throws {
        let sessionID = "11111111-2222-3333-4444-555555555555"
        let data = Data(
            """
            {
              "type": "sessionComplete",
              "recording": {
                "id": "session-20260728-132735-170223",
                "clientSessionID": "\(sessionID)",
                "machineTranscript": "thank"
              }
            }
            """.utf8
        )

        let message = try JSONDecoder().decode(
            KeyboardVoiceServerMessage.self,
            from: data
        )

        #expect(message.recording?.clientSessionID == sessionID)
        #expect(message.recording?.machineTranscript == "thank")
    }
}
