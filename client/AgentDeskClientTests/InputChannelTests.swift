import Foundation
import Testing

// ADR-0005 input channel: schema and close-gating tests. The
// WebSocket-transport happy path is exercised by the Maestro flow
// (just ui-flow type-tap-keys) since URLSessionWebSocketTask isn't
// cleanly mockable without a live socket.

struct InputChannelTests {
    @Test func helloFrameSerializesWithCompactKeysAndCorrectType() throws {
        let token = SessionToken(
            hostFingerprint: "host-fp-abc",
            deviceFingerprint: DeviceFingerprint("device-fp-xyz"),
            issuedAt: 1700000000,
            signature: Data([0x01, 0x02, 0x03])
        )
        let hello = InputChannelHello(sessionToken: token)
        let data = try JSONEncoder().encode(hello)
        let json = String(data: data, encoding: .utf8) ?? ""
        // Compact key for type, compact key for sessionToken.
        #expect(json.contains("\"t\":\"input-hello\""))
        #expect(json.contains("\"tk\""))
    }

    @Test func eventFramePreservesNormalizedInput() throws {
        let event = NormalizedInput.cursorMove(dx: 1.5, dy: -2.25)
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)
        #expect(decoded.event == event)
    }

    @Test func eventFrameRoundTripPreservesKeyWithModifiers() throws {
        let event = NormalizedInput.key(code: "ansi-K", modifiers: [.cmd, .ctrl, .option, .shift])
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)
        #expect(decoded.event == event)
    }
}
