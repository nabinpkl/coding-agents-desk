import Foundation
import Testing
import UIKit

// ADR-0005 input channel: schema and close-gating tests. The
// WebSocket-transport happy path is exercised by the Maestro flow
// (just ui-flow type-tap-keys) since URLSessionWebSocketTask isn't
// cleanly mockable without a live socket.

struct InputChannelTests {
    @Test func helloFrameSerializesWithCompactKeysAndCorrectType() throws {
        let hello = InputChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp-xyz"),
            sessionId: "session-123",
            inputCapability: "capability-abc"
        )
        let data = try JSONEncoder().encode(hello)
        let json = String(data: data, encoding: .utf8) ?? ""
        // Compact keys for type, device fingerprint, session id, and capability.
        #expect(json.contains("\"t\":\"input-hello\""))
        #expect(json.contains("\"d\""))
        #expect(json.contains("device-fp-xyz"))
        #expect(json.contains("\"sid\":\"session-123\""))
        #expect(json.contains("\"ic\":\"capability-abc\""))
    }

    @Test func readyFrameSerializesWithCompactKeysAndCorrectType() throws {
        let ready = InputChannelReady(sessionId: "session-123")
        let data = try JSONEncoder().encode(ready)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"input-ready\""))
        #expect(json.contains("\"sid\":\"session-123\""))

        let decoded = try JSONDecoder().decode(InputChannelReady.self, from: data)
        #expect(decoded == ready)
    }

    @Test func sessionReadyCarriesOwnedMediaCapability() throws {
        let ready = SessionReady(
            sessionId: "session-123",
            inputCapability: "input-capability",
            inputCapabilityExpiresAt: 1_800_000_060,
            mediaCapability: "media-capability",
            mediaCapabilityExpiresAt: 1_800_000_060
        )
        let data = try JSONEncoder().encode(ready)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"mc\":\"media-capability\""))
        #expect(json.contains("\"me\":1800000060"))
        #expect(!json.contains("\"mm\""))
        #expect(!json.contains("\"mp\""))

        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)
        #expect(decoded == ready)
    }

    @Test func oldSessionReadyFixturesDefaultToNoMediaCapability() throws {
        let data = Data(#"{"t":"session-ready","sid":"session-123","ic":"capability","ie":1800000060}"#.utf8)
        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)

        #expect(decoded.mediaCapability == "")
        #expect(decoded.mediaCapabilityExpiresAt == 0)
    }

    @Test func mediaHelloFrameSerializesWithCompactKeys() throws {
        let hello = MediaChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp-xyz"),
            sessionId: "session-123",
            mediaCapability: "media-capability",
            clientNonce: Data([1, 2, 3])
        )
        let data = try JSONEncoder().encode(hello)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"media-hello\""))
        #expect(json.contains("\"d\""))
        #expect(json.contains("device-fp-xyz"))
        #expect(json.contains("\"sid\":\"session-123\""))
        #expect(json.contains("\"mc\":\"media-capability\""))
        #expect(json.contains("\"cn\""))
    }

    @Test func ownedMediaControlFrameSerializesWithCompactKeys() throws {
        let message = OwnedMediaControlMessage(kind: .keyframeRequest, frameId: 42)
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"t\":\"owned-media-control\""))
        #expect(json.contains("\"k\":\"keyframe-request\""))
        #expect(json.contains("\"id\":42"))
        #expect(!json.contains("\"px\""))
        #expect(!json.contains("\"td\""))
        #expect(!json.contains("\"rg\""))
        #expect(!json.contains("\"fa\""))
        #expect(!json.contains("\"qf\""))
        #expect(!json.contains("\"qb\""))
    }

    @Test func ownedMediaPacketResendControlSerializesWithCompactIndexes() throws {
        let message = OwnedMediaControlMessage(
            kind: .packetResendRequest,
            frameId: 42,
            packetIndexes: [1, 3]
        )
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"k\":\"packet-resend-request\""))
        #expect(json.contains("\"px\":[1,3]"))
        #expect(!json.contains("\"td\""))
        #expect(!json.contains("\"rg\""))
        #expect(!json.contains("\"fa\""))
        #expect(!json.contains("\"qf\""))
        #expect(!json.contains("\"qb\""))
    }

    @Test func ownedMediaFrameAckControlSerializesWithCompactRenderStats() throws {
        let message = OwnedMediaControlMessage(
            kind: .frameAck,
            frameId: 42,
            totalFramesDecoded: 9,
            renderGapMs: 83.5,
            clientBacklogFrames: 1,
            clientBacklogBytes: 180_000
        )
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"k\":\"frame-ack\""))
        #expect(json.contains("\"id\":42"))
        #expect(json.contains("\"td\":9"))
        #expect(json.contains("\"rg\":83.5"))
        #expect(!json.contains("\"fa\""))
        #expect(json.contains("\"qf\":1"))
        #expect(json.contains("\"qb\":180000"))
        #expect(!json.contains("\"px\""))
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

    @Test func ownedMediaFlushPolicyDoesNotFlushHealthyKeyframesEvenAfterLongGap() {
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: false,
            isKeyframe: true,
            renderGapMs: 40
        ) == .none)
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "unknown",
            requiresFlushToResumeDecoding: false,
            isKeyframe: false,
            renderGapMs: 300
        ) == .none)
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: false,
            isKeyframe: true,
            renderGapMs: 1_000
        ) == .none)
    }

    @Test func ownedMediaFlushPolicyFlushesOnlyFailedDisplayLayer() {
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "failed",
            requiresFlushToResumeDecoding: false,
            isKeyframe: false,
            renderGapMs: 40
        ) == .flushAndRemoveImage)
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: true,
            isKeyframe: false,
            renderGapMs: 40
        ) == .flushAndRemoveImage)
    }

    @Test func ownedMediaRenderTimingReportsMilliseconds() {
        #expect(OwnedMediaRenderTiming.elapsedMs(from: 1_000_000, to: 3_500_000) == 2.5)
    }

    @Test func ownedMediaBacklogEstimateReportsBacklogAfterLargeRenderGap() {
        let underOneFrame = OwnedMediaRenderBacklog.estimate(renderGapMs: 32.0, payloadBytes: 200_000)
        let overBudget = OwnedMediaRenderBacklog.estimate(renderGapMs: 83.5, payloadBytes: 200_000)

        #expect(underOneFrame.frames == 0)
        #expect(underOneFrame.bytes == 0)
        #expect(overBudget.frames == 1)
        #expect(overBudget.bytes == 200_000)
    }

    @Test func ownedMediaRenderStatsMapsToFrameAckPayload() throws {
        let stats = OwnedMediaRenderStats(
            frameId: 55,
            totalFramesDecoded: 13,
            renderGapMs: 120.0,
            renderStartUptimeNs: 2_000_000,
            renderEndUptimeNs: 4_000_000,
            payloadBytes: 210_000,
            flushCount: 0,
            displayStatus: "rendering",
            displayReadyBeforeEnqueue: true,
            requiresFlushToResumeDecoding: false,
            displayStatusAfterEnqueue: "rendering",
            displayReadyAfterEnqueue: false,
            requiresFlushAfterEnqueue: false,
            displayPresentation: "estimated",
            sampleBuildMs: 1.5,
            enqueueMs: 0.25,
            renderWorkMs: 2.0,
            displayQueueAction: .none,
            clientBacklogFrames: 2,
            clientBacklogBytes: 210_000
        )
        let message = OwnedMediaControlMessage(
            kind: .frameAck,
            frameId: stats.frameId,
            totalFramesDecoded: stats.totalFramesDecoded,
            renderGapMs: stats.renderGapMs,
            clientBacklogFrames: stats.clientBacklogFrames,
            clientBacklogBytes: stats.clientBacklogBytes
        )
        let data = try JSONEncoder().encode(message)
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded.kind == .frameAck)
        #expect(decoded.frameId == stats.frameId)
        #expect(decoded.totalFramesDecoded == stats.totalFramesDecoded)
        #expect(decoded.renderGapMs == stats.renderGapMs)
        #expect(decoded.clientBacklogFrames == stats.clientBacklogFrames)
        #expect(decoded.clientBacklogBytes == stats.clientBacklogBytes)
    }

    @Test func ownedMediaFrameTimelineFormatsCompleteToAckPath() {
        let timeline = OwnedMediaFrameTimeline(
            frameId: 55,
            isKeyframe: false,
            wasRepaired: true,
            packetCount: 42,
            payloadBytes: 210_000,
            firstPacketToCompleteMs: 18.24,
            completeToRenderStartMs: 2.0,
            mainActorWaitMs: 1.5,
            sampleBuildMs: 0.76,
            enqueueMs: 0.24,
            renderWorkMs: 1.25,
            ackSendMs: 0.5,
            completeToAckSentMs: 4.0,
            displayReadyBeforeEnqueue: true,
            requiresFlushToResumeDecoding: false,
            displayReadyAfterEnqueue: false,
            requiresFlushAfterEnqueue: false,
            displayQueueAction: .none,
            displayStatus: "rendering",
            displayStatusAfterEnqueue: "rendering",
            displayPresentation: "estimated",
            completedNotRenderedFrames: 2,
            completedNotRenderedBytes: 420_000
        )

        #expect(timeline.traceLine.contains("timeline frame=55 key=false repaired=true"))
        #expect(timeline.traceLine.contains("firstToCompleteMs=18.2"))
        #expect(timeline.traceLine.contains("completeToRenderStartMs=2.0"))
        #expect(timeline.traceLine.contains("mainActorWaitMs=1.5"))
        #expect(timeline.traceLine.contains("sampleMs=0.8"))
        #expect(timeline.traceLine.contains("enqueueMs=0.2"))
        #expect(timeline.traceLine.contains("ackSendMs=0.5"))
        #expect(timeline.traceLine.contains("completeToAckMs=4.0"))
        #expect(timeline.traceLine.contains("ready=true requiresFlush=false postReady=false postRequiresFlush=false action=none display=rendering postDisplay=rendering displayPresentation=estimated"))
        #expect(timeline.traceLine.contains("completedQueueFrames=2 completedQueueBytes=420000"))
    }

    @Test func ownedMediaEnvelopeRoundTripsHeaderAndPayload() throws {
        let header = OwnedMediaFrameHeader(
            surfaceGeneration: 7,
            frameId: 1,
            codec: .h264,
            width: 1280,
            height: 720,
            capturedAtUptimeNs: 10,
            presentationTimeNs: 20,
            isKeyframe: false,
            parameterSets: nil,
            refreshReason: .reset
        )
        let envelope = OwnedMediaFrameEnvelope(header: header, payload: Data([0x10, 0x20]))
        let decoded = try OwnedMediaFrameEnvelope.decode(envelope.encode())

        #expect(decoded == envelope)
        #expect(decoded.header.surfaceGeneration == 7)
        #expect(decoded.header.refreshReason == .reset)
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

    @Test func graphicsConnectionPlanUsesGraphicsPortAndReliableQuic() {
        let plan = ClientGraphicsConnectionPlan(host: "mac.tailnet.test")

        #expect(plan.host == "mac.tailnet.test")
        #expect(plan.port == Config.graphicsPort)
        #expect(plan.port != Config.signalingPort)
        #expect(plan.alpn == ClientGraphicsChannelHandshake.quicALPN)
        #expect(!plan.usesDatagrams)
    }

    @Test func graphicsHelloUsesActiveSessionAndMediaCapability() {
        let active = ActiveSession(
            sessionId: "session-123",
            deviceFingerprint: DeviceFingerprint("device-fp"),
            establishedAt: 1_800_000_000
        )
        let mediaCapability = MediaCapabilityGrant(
            sessionId: "session-123",
            mediaCapability: "media-capability",
            mediaCapabilityExpiresAt: 1_800_000_060
        )
        let hello = ClientGraphicsChannelHandshake.makeHello(
            active: active,
            mediaCapability: mediaCapability,
            clientNonce: Data([1, 2, 3, 4])
        )

        #expect(hello.deviceFingerprint == active.deviceFingerprint)
        #expect(hello.sessionId == active.sessionId)
        #expect(hello.graphicsCapability == "media-capability")
        #expect(hello.clientNonce == Data([1, 2, 3, 4]))
    }

    @Test func graphicsReadyValidationRejectsWrongSessionOrEmptyNonce() throws {
        let ready = GraphicsChannelReady(sessionId: "session-123", serverNonce: Data([4, 5, 6]))
        #expect(try ClientGraphicsChannelHandshake.validateReady(ready, expectedSessionId: "session-123") == ready)

        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try ClientGraphicsChannelHandshake.validateReady(
                GraphicsChannelReady(sessionId: "other-session", serverNonce: Data([4, 5, 6])),
                expectedSessionId: "session-123"
            )
        }
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try ClientGraphicsChannelHandshake.validateReady(
                GraphicsChannelReady(sessionId: "session-123", serverNonce: Data()),
                expectedSessionId: "session-123"
            )
        }

        let wrongTypeData = """
        {"t":"media-ready","sid":"session-123","sn":"BAUG"}
        """.data(using: .utf8) ?? Data()
        let wrongType = try JSONDecoder().decode(GraphicsChannelReady.self, from: wrongTypeData)
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try ClientGraphicsChannelHandshake.validateReady(wrongType, expectedSessionId: "session-123")
        }
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

    @Test func ownedMediaKeyframeRequestsAreDebouncedDuringRecovery() {
        var throttle = OwnedMediaKeyframeRequestThrottle()

        let firstRequest = throttle.noteIncompleteFrame(now: 1_000)
        #expect(firstRequest)
        #expect(throttle.isAwaitingKeyframe)
        let immediateRetry = throttle.noteIncompleteFrame(now: 1_000 + 100_000_000)
        let earlyDeltaRetry = throttle.noteSkippedDelta(now: 1_000 + 499_000_000)
        let dueDeltaRetry = throttle.noteSkippedDelta(now: 1_000 + 500_000_000)
        #expect(!immediateRetry)
        #expect(!earlyDeltaRetry)
        #expect(dueDeltaRetry)

        throttle.noteKeyframe()

        #expect(!throttle.isAwaitingKeyframe)
        let postKeyframeRequest = throttle.noteIncompleteFrame(now: 2_000_000_000)
        #expect(postKeyframeRequest)
    }

    @Test func repairBufferRequestsMissingIndexesWhenNewerFrameExposesGap() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3), now: 1)
        let result = buffer.accept(packet(frameId: 2, index: 0, count: 1), now: 2)

        #expect(result.resendRequests == [
            MediaDatagramRepairRequest(
                frameId: 1,
                packetIndexes: [1, 2],
                requestedAtNs: 2,
                firstSeenAgeNs: 1
            )
        ])
        #expect(result.completedFrames.isEmpty)
        #expect(result.expiredFrames.isEmpty)
    }

    @Test func repairBufferSuppressesDuplicateRequestsDuringRepairWindow() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 2), now: 2)
        let duplicate = buffer.accept(packet(frameId: 2, index: 1, count: 2), now: 3)

        #expect(duplicate.resendRequests.isEmpty)
    }

    @Test func repairBufferDebugSnapshotReportsTrackedBytesAndMissingPackets() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, payload: [0x10, 0x11]), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 2, payload: [0x20]), now: 2)
        let snapshot = buffer.debugSnapshot

        #expect(snapshot.trackedFrameCount == 2)
        #expect(snapshot.trackedBytes == 3)
        #expect(snapshot.newestFrameId == 2)
        #expect(snapshot.deliveredFrameId == 0)
        #expect(snapshot.missingPacketTotal == 3)
        #expect(snapshot.traceFields.contains("trackedFrames=2"))
        #expect(snapshot.traceFields.contains("missingPackets=3"))
    }

    @Test func repairBufferCompletesFrameAfterResendBeforeDeadline() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, payload: [0x10]), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        _ = buffer.accept(packet(frameId: 1, index: 1, count: 3, payload: [0x11]), now: 10)
        let repaired = buffer.accept(packet(frameId: 1, index: 2, count: 3, payload: [0x12]), now: 20)

        #expect(repaired.expiredFrames.isEmpty)
        #expect(repaired.repairedFrameCount == 1)
        #expect(repaired.completedFrames.map(\.frameId) == [1, 2])
        #expect(repaired.completedFrames.first?.data == Data([0x10, 0x11, 0x12]))
        #expect(repaired.completedFrames.first?.wasRepaired == true)
        #expect(repaired.completedFrames.first?.firstSeenAgeNs == 19)
        #expect(repaired.completedFrames.first?.repairedAfterNs == 18)
    }

    @Test func repairBufferSkipsLateRepairedDeltaAfterDeadline() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, payload: [0x10]), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        _ = buffer.accept(packet(frameId: 1, index: 1, count: 3, payload: [0x11]), now: 10)
        let late = buffer.accept(packet(frameId: 1, index: 2, count: 3, payload: [0x12]), now: 53)

        #expect(late.expiredFrames.isEmpty)
        #expect(late.repairedFrameCount == 0)
        #expect(late.completedFrames.map(\.frameId) == [2])
        #expect(late.skippedStaleFrames == [
            IncompleteFrame(
                frameId: 1,
                isKeyframe: false,
                received: 3,
                expected: 3,
                missingIndexes: [],
                firstSeenAgeNs: 52,
                repairAgeNs: 51
            )
        ])
    }

    @Test func repairBufferAllowsLateRepairedKeyframeToComplete() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, isKeyframe: true, payload: [0x10]), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        _ = buffer.accept(packet(frameId: 1, index: 1, count: 3, isKeyframe: true, payload: [0x11]), now: 10)
        let late = buffer.accept(packet(frameId: 1, index: 2, count: 3, isKeyframe: true, payload: [0x12]), now: 53)

        #expect(late.expiredFrames.isEmpty)
        #expect(late.skippedStaleFrames.isEmpty)
        #expect(late.repairedFrameCount == 1)
        #expect(late.completedFrames.map(\.frameId) == [1, 2])
        #expect(late.completedFrames.first?.data == Data([0x10, 0x11, 0x12]))
        #expect(late.completedFrames.first?.wasRepaired == true)
    }

    @Test func repairBufferSkipsStaleDeltaAfterRepairDeadline() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1), now: 2)
        let skipped = buffer.accept(packet(frameId: 3, index: 0, count: 1), now: 52)

        #expect(skipped.expiredFrames.isEmpty)
        #expect(skipped.skippedStaleFrames == [
            IncompleteFrame(
                frameId: 1,
                isKeyframe: false,
                received: 1,
                expected: 3,
                missingIndexes: [1, 2],
                firstSeenAgeNs: 51,
                repairAgeNs: 50
            )
        ])
        #expect(skipped.completedFrames.map(\.frameId) == [2, 3])
    }

    @Test func repairBufferFallsBackWhenKeyframeExpires() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, isKeyframe: true), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        let expired = buffer.accept(packet(frameId: 3, index: 0, count: 1, payload: [0x30]), now: 52)

        #expect(expired.expiredFrames == [
            IncompleteFrame(
                frameId: 1,
                isKeyframe: true,
                received: 1,
                expected: 3,
                missingIndexes: [1, 2],
                firstSeenAgeNs: 51,
                repairAgeNs: 50
            )
        ])
        #expect(expired.skippedStaleFrames.isEmpty)
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

    @Test func agentSayFrameSerializesWithCompactKeysAndChannelYieldsIt() async throws {
        let push = AgentSayPush(id: "utterance-1", phase: "chunk", sequence: 0, text: "hello")
        let data = try JSONEncoder().encode(push)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"agent-say\""))
        #expect(json.contains("\"p\":\"chunk\""))
        #expect(json.contains("\"q\":0"))
        #expect(json.contains("\"x\":\"hello\""))

        let task = FakeInputWebSocketTask()
        let channel = WebSocketInputChannel(task: task)
        var iterator = channel.agentSayUpdates.makeAsyncIterator()
        try task.enqueueReceive(.string(json))
        let received = await iterator.next()
        #expect(received == push)
        channel.close()
    }

    @Test func cursorFrameDecodesAndChannelYieldsIt() async throws {
        let push = CursorImagePush(
            hash: "abc123",
            png: "Zm9v",
            hotspotXFrac: 0.5,
            hotspotYFrac: 0.25,
            widthPoints: 16,
            heightPoints: 24,
            hidden: false
        )
        let data = try JSONEncoder().encode(push)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"cursor\""))

        let task = FakeInputWebSocketTask()
        let channel = WebSocketInputChannel(task: task)
        var iterator = channel.cursorUpdates.makeAsyncIterator()
        try task.enqueueReceive(.string(json))
        let received = await iterator.next()
        #expect(received == push)
        channel.close()
    }

    @Test func cursorImageStoreCachesByHashAndServesNilPayloadFromCache() {
        // 1x1 PNG, enough for UIImage(data:) to succeed.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC"
        let store = CursorImageStore()
        let withBytes = CursorImagePush(
            hash: "h1", png: png,
            hotspotXFrac: 0, hotspotYFrac: 0,
            widthPoints: 1, heightPoints: 1, hidden: false
        )
        #expect(store.resolve(withBytes) != nil)

        // Same hash, no bytes: served from cache.
        let hashOnly = CursorImagePush(
            hash: "h1", png: nil,
            hotspotXFrac: 0, hotspotYFrac: 0,
            widthPoints: 1, heightPoints: 1, hidden: false
        )
        #expect(store.resolve(hashOnly) != nil)

        // Unknown hash, no bytes: nothing to render.
        let unknown = CursorImagePush(
            hash: "h2", png: nil,
            hotspotXFrac: 0, hotspotYFrac: 0,
            widthPoints: 1, heightPoints: 1, hidden: false
        )
        #expect(store.resolve(unknown) == nil)
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

    @Test func openerReturnsOnlyAfterInputReady() async throws {
        let task = FakeInputWebSocketTask()
        let completed = LockedBool(false)
        let openTask = Task {
            let channel = try await InputChannelOpener.open(
                host: "mac.tailnet.ts.net",
                port: 41888,
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123",
                inputCapability: "capability-abc",
                taskFactory: FakeInputWebSocketTaskFactory(task: task)
            )
            completed.set(true)
            return channel
        }

        try await waitUntil { task.sentTexts.count == 1 }
        #expect(task.didResume)
        #expect(task.sentTexts.count == 1)
        #expect(task.receiveWaiterCount == 1)
        #expect(completed.value == false)

        try task.enqueueReceive(.string(String(data: JSONEncoder().encode(InputChannelReady(sessionId: "session-123")), encoding: .utf8)!))
        let channel = try await openTask.value
        #expect(completed.value)
        channel.close()
    }

    @Test func openerThrowsDecodedSessionRejectedBeforeReady() async throws {
        let task = FakeInputWebSocketTask()
        try task.enqueueReceive(.string(String(data: JSONEncoder().encode(SessionRejected(reason: .revoked)), encoding: .utf8)!))

        do {
            _ = try await InputChannelOpener.open(
                host: "mac.tailnet.ts.net",
                port: 41888,
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123",
                inputCapability: "capability-abc",
                taskFactory: FakeInputWebSocketTaskFactory(task: task)
            )
            Issue.record("input opener unexpectedly returned a channel")
        } catch let rejection as SessionRejected {
            #expect(rejection.reason == .revoked)
        }
        #expect(task.cancelCode == .protocolError)
    }

    @Test func openerTreatsUnknownPreReadyFrameAsMalformedAndCloses() async throws {
        let task = FakeInputWebSocketTask()
        try task.enqueueReceive(.string(#"{"t":"desktop-state"}"#))

        do {
            _ = try await InputChannelOpener.open(
                host: "mac.tailnet.ts.net",
                port: 41888,
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123",
                inputCapability: "capability-abc",
                taskFactory: FakeInputWebSocketTaskFactory(task: task)
            )
            Issue.record("input opener unexpectedly returned a channel")
        } catch let rejection as SessionRejected {
            #expect(rejection.reason == .malformed)
        }
        #expect(task.cancelCode == .protocolError)
    }

    private func packet(
        frameId: UInt64,
        index: UInt16,
        count: UInt16,
        isKeyframe: Bool = false,
        payload: [UInt8] = [0xff]
    ) -> MediaDatagramFramePacket {
        MediaDatagramFramePacket(
            frameId: frameId,
            packetIndex: index,
            packetCount: count,
            isKeyframe: isKeyframe,
            sentAtUptimeNs: 0,
            payload: Data(payload)
        )
    }
}

private struct FakeInputWebSocketTaskFactory: InputWebSocketTaskFactory {
    let task: FakeInputWebSocketTask

    func makeTask(url: URL) -> InputWebSocketTask {
        task
    }
}

private final class FakeInputWebSocketTask: InputWebSocketTask, @unchecked Sendable {
    private let lock = NSLock()
    private var receiveResults: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var receiveContinuations: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
    private var cancelled = false
    private var _didResume = false
    private var _sentTexts: [String] = []
    private var _cancelCode: URLSessionWebSocketTask.CloseCode?

    var didResume: Bool { lock.withLock { _didResume } }
    var sentTexts: [String] { lock.withLock { _sentTexts } }
    var receiveWaiterCount: Int { lock.withLock { receiveContinuations.count } }
    var cancelCode: URLSessionWebSocketTask.CloseCode? { lock.withLock { _cancelCode } }

    func resume() {
        lock.withLock { _didResume = true }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        lock.withLock {
            switch message {
            case .string(let text):
                _sentTexts.append(text)
            case .data(let data):
                _sentTexts.append(String(data: data, encoding: .utf8) ?? "")
            @unknown default:
                break
            }
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            if let immediate = takeReceiveOrStore(continuation) {
                continuation.resume(with: immediate)
            }
        }
    }

    private func takeReceiveOrStore(
        _ continuation: CheckedContinuation<URLSessionWebSocketTask.Message, Error>
    ) -> Result<URLSessionWebSocketTask.Message, Error>? {
        lock.withLock {
            if cancelled {
                return .failure(CancellationError())
            }
            if !receiveResults.isEmpty {
                return receiveResults.removeFirst()
            }
            receiveContinuations.append(continuation)
            return nil
        }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let continuations: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>]
        lock.lock()
        cancelled = true
        _cancelCode = closeCode
        continuations = receiveContinuations
        receiveContinuations.removeAll()
        lock.unlock()

        for continuation in continuations {
            continuation.resume(throwing: CancellationError())
        }
    }

    func enqueueReceive(_ message: URLSessionWebSocketTask.Message) throws {
        enqueueReceive(.success(message))
    }

    private func enqueueReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        if let continuation = takeContinuationOrStore(result) {
            continuation.resume(with: result)
        }
    }

    private func takeContinuationOrStore(
        _ result: Result<URLSessionWebSocketTask.Message, Error>
    ) -> CheckedContinuation<URLSessionWebSocketTask.Message, Error>? {
        lock.withLock {
            if receiveContinuations.isEmpty {
                receiveResults.append(result)
                return nil
            }
            return receiveContinuations.removeFirst()
        }
    }
}

private final class LockedBool: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool

    init(_ value: Bool) {
        stored = value
    }

    var value: Bool {
        lock.withLock { stored }
    }

    func set(_ value: Bool) {
        lock.withLock { stored = value }
    }
}

private func waitUntil(
    timeoutNanoseconds: UInt64 = 1_000_000_000,
    _ predicate: @escaping @Sendable () -> Bool
) async throws {
    let deadline = ContinuousClock.now + .nanoseconds(Int(timeoutNanoseconds))
    while !predicate() {
        if ContinuousClock.now >= deadline { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
}
