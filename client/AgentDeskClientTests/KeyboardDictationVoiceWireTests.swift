import Foundation
import Testing

struct KeyboardDictationVoiceWireTests {
    @Test func sessionCompletePreservesClientSessionCorrelation() throws {
        let sessionID = "11111111-2222-3333-4444-555555555555"
        let data = Data(
            """
            {
              "type": "sessionComplete",
              "recording": {
                "id": "session-20260728-132735-170223",
                "clientSessionID": "\(sessionID)",
                "transcript": "thank"
              }
            }
            """.utf8
        )

        let message = try JSONDecoder().decode(
            KeyboardVoiceServerMessage.self,
            from: data
        )

        #expect(message.recording?.clientSessionID == sessionID)
        #expect(message.recording?.transcript == "thank")
    }
}
