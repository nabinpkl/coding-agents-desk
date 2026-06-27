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

struct QuicSessionHostMediaStateTests {
    private func controllerConfig() -> VideoBitrateControllerConfig {
        VideoBitrateControllerConfig(
            ceilingKbps: 2500,
            floorKbps: 800,
            survivalFloorKbps: 300,
            downStep: 0.7,
            upStep: 1.15,
            lossDownPermille: 50,
            raiseCleanWindows: 4,
            fpsCeiling: 30,
            fpsFloor: 10,
            fpsDownStep: 0.7,
            fpsUpStep: 1.3
        )
    }

    private func makeState(
        maxInflightFrames: Int = 2,
        maxInflightBytes: Int = 300_000
    ) -> QuicSessionHostMediaState {
        QuicSessionHostMediaState(
            maxInflightFrames: maxInflightFrames,
            maxInflightBytes: maxInflightBytes,
            expectedFrameRate: 30,
            bitrateController: VideoBitrateController(config: controllerConfig()),
            resendRingFrames: 4
        )
    }

    @Test func mediaUpdateIdsStartAboveZeroAndIncrease() throws {
        var state = makeState()

        let reservedFirst = state.reserveUpdateId(nowNs: 0)
        let first = try #require(reservedFirst)
        let reservedSecond = state.reserveUpdateId(nowNs: 1)
        let second = try #require(reservedSecond)

        #expect(first.surfaceGeneration == 1)
        #expect(first.frameId == 1)
        #expect(second.frameId == 2)
    }

    @Test func inFlightAdmissionBlocksUntilAck() throws {
        var state = makeState(maxInflightFrames: 2)
        let reservedFirst = state.reserveUpdateId(nowNs: 0)
        let first = try #require(reservedFirst)
        state.noteSent(frameId: first.frameId, encodedBytes: 10, packets: [Data([1])])
        let reservedSecond = state.reserveUpdateId(nowNs: 1)
        let second = try #require(reservedSecond)
        state.noteSent(frameId: second.frameId, encodedBytes: 10, packets: [Data([2])])

        let blocked = state.reserveUpdateId(nowNs: 2)
        #expect(blocked == nil)
        state.noteAck(frameId: first.frameId)
        let reservedThird = state.reserveUpdateId(nowNs: 3)
        let third = try #require(reservedThird)
        #expect(third.frameId == 3)
    }

    @Test func resendRingServesRememberedPackets() throws {
        var state = makeState()
        let reservedUpdate = state.reserveUpdateId(nowNs: 0)
        let update = try #require(reservedUpdate)
        state.noteSent(
            frameId: update.frameId,
            encodedBytes: 2,
            packets: [Data([0]), Data([1])]
        )

        let served = state.packetsForResend(
            frameId: update.frameId,
            indexes: [0, 1, 9],
            maxCount: 8
        )

        #expect(served.packets.map(\.0) == [0, 1])
        #expect(served.packets.map(\.1) == [Data([0]), Data([1])])
        #expect(served.misses == [9])
    }

    @Test func linkHealthMovesAdaptiveTargets() {
        var state = makeState()

        let outcome = state.observeLinkHealth(completedFrames: 80, expiredFrames: 20)

        #expect(outcome.changed)
        #expect(outcome.reason == "loss-down")
        #expect(state.targetKbps < 2500)
        #expect(state.targetFps == 30)
    }

    @Test func survivalFpsAddsCapacityAdmissionInterval() throws {
        var state = makeState()
        while state.targetFps == 30 {
            _ = state.observeLinkHealth(completedFrames: 80, expiredFrames: 20)
        }
        #expect(state.targetFps < 30)

        let reservedFirst = state.reserveUpdateId(nowNs: 0)
        let first = try #require(reservedFirst)
        #expect(first.frameId == 1)
        let blocked = state.reserveUpdateId(nowNs: 1)
        #expect(blocked == nil)

        let reservedAfterCapacityInterval = state.reserveUpdateId(nowNs: 70_000_000)
        let afterCapacityInterval = try #require(reservedAfterCapacityInterval)
        #expect(afterCapacityInterval.frameId == 2)
    }
}
