import Foundation
import Testing

@testable import AgentDeskHost

struct QuicSessionStreamFrameTests {
    @Test func quicSessionFrameRoundTripsRoleAndPayload() throws {
        let payload = Data(#"{"t":"input-event"}"#.utf8)
        let encoded = try QuicSessionStreamFrame.encode(role: .input, payload: payload)
        let decoded = try QuicSessionStreamFrame.decode(encoded)

        #expect(decoded.role == .input)
        #expect(decoded.payload == payload)
        #expect(encoded[encoded.startIndex] == QuicSessionStreamRole.input.rawValue)
        #expect(try encoded.readUInt32BE(at: 1) == UInt32(payload.count))
    }

    @Test func quicSessionFrameRejectsMalformedFrames() throws {
        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(Data())
        }

        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(Data([0xff, 0, 0, 0, 0]))
        }

        let shortPayload = Data([QuicSessionStreamRole.control.rawValue, 0, 0, 0, 2, 0xaa])
        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(shortPayload)
        }
    }

    @Test func quicSessionFrameRejectsOversizedPayloads() throws {
        let payload = Data(repeating: 0xab, count: QuicSessionStreamFrame.maxFrameLength + 1)

        #expect(throws: QuicSessionFrameError.frameTooLarge) {
            _ = try QuicSessionStreamFrame.encode(role: .control, payload: payload)
        }
    }

    @Test func streamRoleBytesArePinned() {
        #expect(QuicSessionStreamRole.control.rawValue == 1)
        #expect(QuicSessionStreamRole.input.rawValue == 2)
        #expect(QuicSessionStreamRole(rawValue: 1) == .control)
        #expect(QuicSessionStreamRole(rawValue: 2) == .input)
        #expect(QuicSessionStreamRole(rawValue: 3) == nil)
    }

    @Test func sessionReadyCarriesResumeAndMediaKeySalt() throws {
        let ready = SessionReady(
            sessionId: "session-123",
            resumeToken: Data([1, 2, 3]),
            resumeExpiresAt: 1_800_000_020,
            mediaKeySalt: Data([4, 5, 6])
        )

        let data = try JSONEncoder().encode(ready)
        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)
        let json = String(data: data, encoding: .utf8) ?? ""

        #expect(decoded == ready)
        #expect(json.contains("\"t\":\"session-ready\""))
        #expect(json.contains("\"sid\":\"session-123\""))
        #expect(json.contains("\"rt\":\"AQID\""))
        #expect(json.contains("\"mk\":\"BAUG\""))
    }

    @Test func sessionResumeInitRoundTripsWithCompactKeys() throws {
        let resume = SessionResumeInit(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            resumeToken: Data([1, 2, 3]),
            protocolVersion: 2
        )

        let data = try JSONEncoder().encode(resume)
        let decoded = try JSONDecoder().decode(SessionResumeInit.self, from: data)
        let json = String(data: data, encoding: .utf8) ?? ""

        #expect(decoded == resume)
        #expect(json.contains("\"t\":\"session-resume\""))
        #expect(decoded.deviceFingerprint == DeviceFingerprint("device-fp"))
        #expect(decoded.protocolVersion == 2)
    }

    @Test func inputEventFrameRoundTripsThroughCodable() throws {
        let event = NormalizedInput.key(code: "ansi-A", modifiers: [.cmd, .shift])
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)

        #expect(decoded == frame)
        #expect(decoded.type == "input-event")
        #expect(decoded.event == event)
    }

    @Test func inputCloseFrameRoundTripsThroughCodable() throws {
        let close = InputChannelClose(reason: "revoked")
        let data = try JSONEncoder().encode(close)
        let decoded = try JSONDecoder().decode(InputChannelClose.self, from: data)

        #expect(decoded == close)
        #expect(decoded.type == "input-close")
        #expect(decoded.reason == "revoked")
    }

    @Test func mediaTimingMathReportsMillisecondsPerAdvancedUnit() {
        let value = MediaTimingMath.millisecondsPerUnit(
            currentCount: 130,
            previousCount: 100,
            currentTotalSeconds: 2.2,
            previousTotalSeconds: 2.0
        )
        #expect(abs((value ?? 0) - 6.666) < 0.01)
    }

    @Test func mediaTimingMathReturnsNilWithoutUnitProgress() {
        let value = MediaTimingMath.millisecondsPerUnit(
            currentCount: 100,
            previousCount: 100,
            currentTotalSeconds: 2.2,
            previousTotalSeconds: 2.0
        )
        #expect(value == nil)
    }

    @Test func mediaTimingMathFormatsMillisecondsForLogs() {
        #expect(MediaTimingMath.millisecondsBetween(currentNs: 1_250_000, previousNs: 1_000_000) == 0.25)
        #expect(MediaTimingMath.formatMilliseconds(1.234) == "1.23")
        #expect(MediaTimingMath.formatMilliseconds(nil) == "?")
    }
}
