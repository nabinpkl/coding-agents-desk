import Foundation
import Testing

struct SignalingFrameRoutingTests {
    @Test func classifyFirstFramePairTypeRoutesToPair() {
        let data = Data(#"{"type":"pair"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .pair)
    }

    @Test func classifyFirstFrameSessionInitTypeRoutesToSessionInit() {
        let data = Data(#"{"t":"session-init"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .sessionInit)
    }

    @Test func classifyFirstFrameMediaOfferBeforeSessionIsMalformed() {
        let data = Data(#"{"t":"media-offer","s":"v=0\r\n"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .malformed)
    }

    @Test func classifyFirstFrameEmptyDataIsMalformed() {
        #expect(SignalingFrameRouter.classifyFirstFrame(Data()) == .malformed)
    }

    @Test func classifyFirstFrameMissingTypeIsMalformed() {
        let data = Data(#"{"foo":"bar"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .malformed)
    }

    @Test func classifyActiveSessionFrameInputCapabilityRefreshDecodes() {
        let request = InputCapabilityRefreshRequest(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123"
        )
        let data = try! JSONEncoder().encode(request)
        #expect(SignalingFrameRouter.classifyActiveSessionFrame(data) == .inputCapabilityRefresh(request))
    }

    @Test func classifyActiveSessionFrameMalformedIsMalformed() {
        let data = Data(#"{"t":"unknown"}"#.utf8)
        #expect(SignalingFrameRouter.classifyActiveSessionFrame(data) == .malformed)
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

    @Test func classifyFirstFrameInputHelloRoutesToInputHello() {
        let data = Data(#"{"t":"input-hello"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .inputHello)
    }

    @Test func classifyFirstFrameMediaHelloIsMalformedOnSessionSocket() {
        let data = Data(#"{"t":"media-hello"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .malformed)
    }

    @Test func inputHelloFrameRoundTripsThroughCodable() throws {
        let hello = InputChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            inputCapability: "capability-abc"
        )
        let data = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(InputChannelHello.self, from: data)
        #expect(decoded == hello)
        #expect(decoded.type == "input-hello")
        #expect(decoded.deviceFingerprint == DeviceFingerprint("device-fp"))
        #expect(decoded.sessionId == "session-123")
        #expect(decoded.inputCapability == "capability-abc")
    }

    @Test func mediaHelloFrameRoundTripsThroughCodable() throws {
        let hello = MediaChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            mediaCapability: "media-capability-abc",
            clientNonce: Data([1, 2, 3])
        )
        let data = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(MediaChannelHello.self, from: data)
        #expect(decoded == hello)
        #expect(decoded.type == "media-hello")
        #expect(decoded.deviceFingerprint == DeviceFingerprint("device-fp"))
        #expect(decoded.sessionId == "session-123")
        #expect(decoded.mediaCapability == "media-capability-abc")
        #expect(decoded.clientNonce == Data([1, 2, 3]))
    }

    @Test func ownedMediaControlMessageRoundTripsThroughCodable() throws {
        let message = OwnedMediaControlMessage(kind: .keyframeRequest, frameId: 42)
        let data = try JSONEncoder().encode(message)
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(decoded.type == "owned-media-control")
        #expect(decoded.kind == .keyframeRequest)
        #expect(decoded.frameId == 42)
        #expect(decoded.packetIndexes.isEmpty)
        #expect(decoded.totalFramesDecoded == nil)
        #expect(decoded.renderGapMs == nil)
        #expect(decoded.clientBacklogFrames == nil)
        #expect(decoded.clientBacklogBytes == nil)
    }

    @Test func ownedMediaPacketResendControlMessageRoundTripsThroughCodable() throws {
        let message = OwnedMediaControlMessage(
            kind: .packetResendRequest,
            frameId: 42,
            packetIndexes: [1, 3]
        )
        let data = try JSONEncoder().encode(message)
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(decoded.type == "owned-media-control")
        #expect(decoded.kind == .packetResendRequest)
        #expect(decoded.frameId == 42)
        #expect(decoded.packetIndexes == [1, 3])
        #expect(decoded.totalFramesDecoded == nil)
        #expect(decoded.renderGapMs == nil)
        #expect(decoded.clientBacklogFrames == nil)
        #expect(decoded.clientBacklogBytes == nil)
    }

    @Test func ownedMediaFrameAckControlMessageRoundTripsThroughCodable() throws {
        let message = OwnedMediaControlMessage(
            kind: .frameAck,
            frameId: 42,
            totalFramesDecoded: 10,
            renderGapMs: 83.5,
            clientBacklogFrames: 1,
            clientBacklogBytes: 180_000
        )
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(decoded.type == "owned-media-control")
        #expect(decoded.kind == .frameAck)
        #expect(decoded.frameId == 42)
        #expect(decoded.totalFramesDecoded == 10)
        #expect(decoded.renderGapMs == 83.5)
        #expect(decoded.clientBacklogFrames == 1)
        #expect(decoded.clientBacklogBytes == 180_000)
        #expect(json.contains("\"td\":10"))
        #expect(json.contains("\"rg\":83.5"))
        #expect(json.contains("\"qf\":1"))
        #expect(json.contains("\"qb\":180000"))
        #expect(!json.contains("\"px\""))
    }

    @Test func sessionReadyDefaultsOldFixturesToNoMediaCapability() throws {
        let data = Data(#"{"t":"session-ready","sid":"session-123","ic":"capability","ie":1800000060}"#.utf8)
        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)

        #expect(decoded.mediaCapability == "")
        #expect(decoded.mediaCapabilityExpiresAt == 0)
    }

    @Test func ownedMediaEnvelopeRoundTripsHeaderAndPayload() throws {
        let header = OwnedMediaFrameHeader(
            frameId: 42,
            codec: .hevc,
            width: 1920,
            height: 1080,
            capturedAtUptimeNs: 100,
            presentationTimeNs: 120,
            isKeyframe: true,
            parameterSets: OwnedMediaParameterSets(
                vps: Data([0x01]),
                sps: Data([0x02, 0x03]),
                pps: Data([0x04])
            )
        )
        let envelope = OwnedMediaFrameEnvelope(header: header, payload: Data([0xaa, 0xbb, 0xcc]))
        let encoded = try envelope.encode()
        let decoded = try OwnedMediaFrameEnvelope.decode(encoded)

        #expect(Array(encoded.prefix(4)) == OwnedMediaFrameEnvelope.magic)
        #expect(decoded == envelope)
    }

    @Test func inputCapabilityGrantRoundTripsThroughCodable() throws {
        let grant = InputCapabilityGrant(
            sessionId: "session-123",
            inputCapability: "capability-def",
            inputCapabilityExpiresAt: 1_800_000_060
        )
        let data = try JSONEncoder().encode(grant)
        let decoded = try JSONDecoder().decode(InputCapabilityGrant.self, from: data)
        #expect(decoded == grant)
        #expect(decoded.type == "input-capability-grant")
        #expect(decoded.sessionId == "session-123")
        #expect(decoded.inputCapability == "capability-def")
        #expect(decoded.inputCapabilityExpiresAt == 1_800_000_060)
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
}
