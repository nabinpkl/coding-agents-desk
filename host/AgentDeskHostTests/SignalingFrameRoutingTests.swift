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
        #expect(decoded.frameAgeMs == nil)
        #expect(decoded.clientBacklogFrames == nil)
        #expect(decoded.clientBacklogBytes == nil)
    }

    @Test func ownedSurfaceUpdateIdOrdersOnlyGenerationThenFrame() {
        let committed = OwnedSurfaceUpdateId(surfaceGeneration: 2, frameId: 10)

        #expect(OwnedSurfaceUpdateId(surfaceGeneration: 2, frameId: 11).isStrictlyNewer(than: committed))
        #expect(OwnedSurfaceUpdateId(surfaceGeneration: 3, frameId: 0).isStrictlyNewer(than: committed))
        #expect(!OwnedSurfaceUpdateId(surfaceGeneration: 2, frameId: 10).isStrictlyNewer(than: committed))
        #expect(!OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 99).isStrictlyNewer(than: committed))
        #expect(OwnedSurfaceUpdateId(surfaceGeneration: 2, frameId: 9) < committed)
    }

    @Test func ownedSurfaceResetAcceptsOnlyNewerGenerationAndBuildsBaseline() {
        #expect(OwnedSurfaceUpdateId.canAcceptReset(surfaceGeneration: 4, committedSurfaceGeneration: 3))
        #expect(!OwnedSurfaceUpdateId.canAcceptReset(surfaceGeneration: 3, committedSurfaceGeneration: 3))
        #expect(!OwnedSurfaceUpdateId.canAcceptReset(surfaceGeneration: 2, committedSurfaceGeneration: 3))

        #expect(OwnedSurfaceUpdateId.acceptedResetBaseline(
            surfaceGeneration: 4,
            committedSurfaceGeneration: 3
        ) == OwnedSurfaceUpdateId(surfaceGeneration: 4, frameId: 0))
        #expect(OwnedSurfaceUpdateId.acceptedResetBaseline(
            surfaceGeneration: 3,
            committedSurfaceGeneration: 3
        ) == nil)
    }

    @Test func ownedMediaUpdateOrderingIgnoresCaptureTimestampDiagnostics() {
        let committed = OwnedSurfaceUpdateId(surfaceGeneration: 5, frameId: 10)
        let staleCaptureNewerFrame = OwnedMediaFrameHeader(
            surfaceGeneration: 5,
            frameId: 11,
            codec: .hevc,
            width: 1920,
            height: 1080,
            capturedAtUptimeNs: 1,
            presentationTimeNs: 120,
            isKeyframe: false,
            parameterSets: nil,
            refreshReason: .rest
        )
        let newerCaptureStaleFrame = OwnedMediaFrameHeader(
            surfaceGeneration: 5,
            frameId: 9,
            codec: .hevc,
            width: 1920,
            height: 1080,
            capturedAtUptimeNs: 9_999,
            presentationTimeNs: 120,
            isKeyframe: false,
            parameterSets: nil,
            refreshReason: .rest
        )

        #expect(staleCaptureNewerFrame.updateId.isStrictlyNewer(than: committed))
        #expect(!newerCaptureStaleFrame.updateId.isStrictlyNewer(than: committed))
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
        #expect(decoded.frameAgeMs == nil)
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
        #expect(decoded.frameAgeMs == nil)
        #expect(decoded.clientBacklogFrames == 1)
        #expect(decoded.clientBacklogBytes == 180_000)
        #expect(json.contains("\"td\":10"))
        #expect(json.contains("\"rg\":83.5"))
        #expect(!json.contains("\"fa\""))
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
            surfaceGeneration: 7,
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
            ),
            refreshReason: .scrollCorrectness
        )
        let envelope = OwnedMediaFrameEnvelope(header: header, payload: Data([0xaa, 0xbb, 0xcc]))
        let encoded = try envelope.encode()
        let decoded = try OwnedMediaFrameEnvelope.decode(encoded)

        #expect(Array(encoded.prefix(4)) == OwnedMediaFrameEnvelope.magic)
        #expect(decoded == envelope)
        #expect(decoded.header.surfaceGeneration == 7)
        #expect(decoded.header.refreshReason == .scrollCorrectness)
    }

    @Test func graphicsHelloAndReadyRoundTripWithCompactKeys() throws {
        let hello = GraphicsChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            graphicsCapability: "graphics-capability",
            clientNonce: Data([1, 2, 3])
        )
        let helloData = try JSONEncoder().encode(hello)
        let helloJson = String(data: helloData, encoding: .utf8) ?? ""
        let decodedHello = try JSONDecoder().decode(GraphicsChannelHello.self, from: helloData)
        #expect(decodedHello == hello)
        #expect(helloJson.contains("\"t\":\"graphics-hello\""))
        #expect(helloJson.contains("\"gc\":\"graphics-capability\""))

        let ready = GraphicsChannelReady(sessionId: "session-123", serverNonce: Data([4, 5, 6]))
        let readyData = try JSONEncoder().encode(ready)
        let readyJson = String(data: readyData, encoding: .utf8) ?? ""
        let decodedReady = try JSONDecoder().decode(GraphicsChannelReady.self, from: readyData)
        #expect(decodedReady == ready)
        #expect(readyJson.contains("\"t\":\"graphics-ready\""))
        #expect(readyJson.contains("\"sn\""))
    }

    @Test func graphicsFrameHeaderRoundTripsThroughCodable() throws {
        let header = OwnedGraphicsFrameHeader(
            surfaceGeneration: 9,
            frameId: 44,
            capturedAtUptimeNs: 123,
            commandCount: 3,
            payloadLength: 4096
        )
        let data = try JSONEncoder().encode(header)
        let decoded = try JSONDecoder().decode(OwnedGraphicsFrameHeader.self, from: data)

        #expect(decoded == header)
        #expect(header.updateId == OwnedSurfaceUpdateId(surfaceGeneration: 9, frameId: 44))
    }

    @Test func graphicsFrameEnvelopeRoundTripsWithAdgcFraming() throws {
        let payload = Data([1, 2, 3, 4, 5, 6])
        let envelope = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 2,
                frameId: 11,
                capturedAtUptimeNs: 987_654,
                commandCount: 2,
                payloadLength: payload.count
            ),
            commands: [
                .copyRect(srcX: 0, srcY: 8, dstX: 0, dstY: 0, width: 100, height: 92),
                .bitmapTile(
                    x: 0,
                    y: 92,
                    width: 100,
                    height: 8,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                )
            ],
            payload: payload
        )

        let encoded = try envelope.encode()
        #expect(Array(encoded.prefix(4)) == OwnedGraphicsFrameEnvelope.magic)
        #expect(encoded[4] == OwnedGraphicsFrameEnvelope.version)

        let decoded = try OwnedGraphicsFrameEnvelope.decode(encoded)
        #expect(decoded == envelope)
        #expect(decoded.header.updateId == OwnedSurfaceUpdateId(surfaceGeneration: 2, frameId: 11))
    }

    @Test func graphicsFrameEnvelopeRejectsMalformedAdgcFrames() throws {
        let payload = Data([1, 2, 3])
        let envelope = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 1,
                capturedAtUptimeNs: 10,
                commandCount: 0,
                payloadLength: payload.count
            ),
            commands: [],
            payload: payload
        )
        let encoded = try envelope.encode()

        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsFrameEnvelope.decode(Data(encoded.prefix(OwnedGraphicsFrameEnvelope.fixedHeaderByteCount - 1)))
        }

        var badMagic = encoded
        badMagic.replaceSubrange(0..<4, with: Data([0x42, 0x41, 0x44, 0x21]))
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsFrameEnvelope.decode(badMagic)
        }

        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsFrameEnvelope.decode(Data(encoded.dropLast()))
        }

        var withTrailingBytes = encoded
        withTrailingBytes.append(0xff)
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsFrameEnvelope.decode(withTrailingBytes)
        }

        let mismatched = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 2,
                capturedAtUptimeNs: 20,
                commandCount: 0,
                payloadLength: payload.count + 1
            ),
            commands: [],
            payload: payload
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try mismatched.encode()
        }

        struct TestMetadata: Codable {
            let header: OwnedGraphicsFrameHeader
            let commands: [OwnedGraphicsCommand]

            enum CodingKeys: String, CodingKey {
                case header = "h"
                case commands = "c"
            }
        }

        let codecTileHeader = OwnedGraphicsFrameHeader(
            surfaceGeneration: 1,
            frameId: 3,
            capturedAtUptimeNs: 30,
            commandCount: 1,
            payloadLength: 0
        )
        let codecTileMetadata = try JSONEncoder().encode(TestMetadata(
            header: codecTileHeader,
            commands: [.codecTile]
        ))
        var codecTileFrame = Data(OwnedGraphicsFrameEnvelope.magic)
        codecTileFrame.append(OwnedGraphicsFrameEnvelope.version)
        var metadataLength = UInt32(codecTileMetadata.count).bigEndian
        var payloadLength = UInt32(0).bigEndian
        withUnsafeBytes(of: &metadataLength) { codecTileFrame.append(contentsOf: $0) }
        withUnsafeBytes(of: &payloadLength) { codecTileFrame.append(contentsOf: $0) }
        codecTileFrame.append(codecTileMetadata)
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsFrameEnvelope.decode(codecTileFrame)
        }

        let invalidTile = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 4,
                capturedAtUptimeNs: 40,
                commandCount: 1,
                payloadLength: payload.count
            ),
            commands: [
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: payload.count, length: 1)
                )
            ],
            payload: payload
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try invalidTile.encode()
        }

        let invalidRect = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 5,
                capturedAtUptimeNs: 50,
                commandCount: 1,
                payloadLength: payload.count
            ),
            commands: [
                .copyRect(srcX: -1, srcY: 0, dstX: 0, dstY: 0, width: 1, height: 1)
            ],
            payload: payload
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try invalidRect.encode()
        }
    }

    @Test func staleGraphicsUpdateUsesSharedTimelineOrdering() {
        let committed = OwnedSurfaceUpdateId(surfaceGeneration: 3, frameId: 20)
        let staleGraphics = OwnedGraphicsFrameHeader(
            surfaceGeneration: 3,
            frameId: 19,
            capturedAtUptimeNs: 9_999,
            commandCount: 1,
            payloadLength: 128
        )

        #expect(!staleGraphics.updateId.isStrictlyNewer(than: committed))
    }

    @Test func graphicsCommandsRoundTripAndRejectReservedCodecTile() throws {
        let commands: [OwnedGraphicsCommand] = [
            .resetSurface(surfaceGeneration: 3, width: 1920, height: 1080, pixelFormat: .bgra),
            .copyRect(srcX: 0, srcY: 8, dstX: 0, dstY: 0, width: 1920, height: 1072),
            .bitmapTile(
                x: 0,
                y: 1072,
                width: 1920,
                height: 8,
                compression: .lzfse,
                byteRange: OwnedGraphicsByteRange(offset: 64, length: 1024)
            )
        ]

        for command in commands {
            let data = try JSONEncoder().encode(command)
            let decoded = try JSONDecoder().decode(OwnedGraphicsCommand.self, from: data)
            #expect(decoded == command)
        }

        try commands[0].validateForCurrentScope()
        try commands[1].validateForCurrentScope()
        try commands[2].validateForCurrentScope()

        let codecTileData = try JSONEncoder().encode(OwnedGraphicsCommand.codecTile)
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try JSONDecoder().decode(OwnedGraphicsCommand.self, from: codecTileData)
        }
    }

    @Test func graphicsAckAndResetRequestRoundTripThroughCodable() throws {
        let ack = OwnedGraphicsFrameAck(
            surfaceGeneration: 4,
            frameId: 22,
            compositorMs: 1.75,
            staleDiscardCount: 3
        )
        let ackData = try JSONEncoder().encode(ack)
        let decodedAck = try JSONDecoder().decode(OwnedGraphicsFrameAck.self, from: ackData)
        #expect(decodedAck == ack)
        #expect(decodedAck.updateId == OwnedSurfaceUpdateId(surfaceGeneration: 4, frameId: 22))

        let request = OwnedGraphicsResetRequest(
            reason: "malformed-frame",
            lastCommittedSurfaceGeneration: 4,
            lastCommittedFrameId: 21
        )
        let requestData = try JSONEncoder().encode(request)
        let decodedRequest = try JSONDecoder().decode(OwnedGraphicsResetRequest.self, from: requestData)
        #expect(decodedRequest == request)
        #expect(decodedRequest.lastCommittedUpdateId == OwnedSurfaceUpdateId(surfaceGeneration: 4, frameId: 21))
    }

    @Test func ownedGraphicsHelloValidationRejectsMalformedWrongTypeAndEmptyNonce() throws {
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsHandshake.validateHelloData(Data())
        }

        let mediaHello = MediaChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            mediaCapability: "media-capability",
            clientNonce: Data([1, 2, 3])
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsHandshake.validateHelloData(try JSONEncoder().encode(mediaHello))
        }

        let emptyNonce = GraphicsChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            graphicsCapability: "graphics-capability",
            clientNonce: Data()
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try OwnedGraphicsHandshake.validateHelloData(try JSONEncoder().encode(emptyNonce))
        }
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
