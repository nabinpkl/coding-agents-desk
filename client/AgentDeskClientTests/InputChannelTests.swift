import Foundation
import Compression
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

    @Test func mediaCapabilityRefreshFrameSerializesWithCompactKeys() throws {
        let request = MediaCapabilityRefreshRequest(
            deviceFingerprint: DeviceFingerprint("device-fp-xyz"),
            sessionId: "session-123"
        )
        let data = try JSONEncoder().encode(request)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(MediaCapabilityRefreshRequest.self, from: data)

        #expect(decoded == request)
        #expect(json.contains("\"t\":\"media-capability-refresh\""))
        #expect(json.contains("\"d\""))
        #expect(json.contains("device-fp-xyz"))
        #expect(json.contains("\"sid\":\"session-123\""))
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

    @Test func ownedMediaKeepaliveControlSerializesWithoutPayloadFields() throws {
        let message = OwnedMediaControlMessage(kind: .keepalive, frameId: 0)
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"k\":\"keepalive\""))
        #expect(json.contains("\"id\":0"))
        #expect(!json.contains("\"px\""))
        #expect(!json.contains("\"td\""))
        #expect(!json.contains("\"rg\""))
        #expect(!json.contains("\"qf\""))
        #expect(!json.contains("\"qb\""))
        #expect(!json.contains("\"sg\""))
        #expect(!json.contains("\"r\""))
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

    @Test func ownedMediaGraphicsResetFallbackControlSerializesWithCompactFields() throws {
        let message = OwnedMediaControlMessage(
            kind: .graphicsResetRequest,
            frameId: 21,
            graphicsSurfaceGeneration: 4,
            reason: "graphics-frame-badRange"
        )
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"k\":\"graphics-reset-request\""))
        #expect(json.contains("\"id\":21"))
        #expect(json.contains("\"sg\":4"))
        #expect(json.contains("\"r\":\"graphics-frame-badRange\""))
        #expect(!json.contains("\"px\""))
        #expect(!json.contains("\"td\""))
        #expect(!json.contains("\"rg\""))
        #expect(!json.contains("\"qf\""))
        #expect(!json.contains("\"qb\""))
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

    @Test func ownedSurfaceCompositorRejectsStaleResetGeneration() throws {
        var compositor = OwnedSurfaceCompositor()

        _ = try compositor.applyGraphicsFrame(Self.makeResetSurfaceEnvelope(surfaceGeneration: 1, frameId: 1))
        let stats = try compositor.applyGraphicsFrame(Self.makeResetSurfaceEnvelope(surfaceGeneration: 1, frameId: 2))

        #expect(stats.action == "stale-reset")
        #expect(compositor.committedUpdateId == OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 1))
        #expect(compositor.staleDiscardCount == 1)
        #expect(compositor.totalGraphicsFramesApplied == 1)
    }

    @Test func ownedSurfaceCompositorKeepsPreviousSurfaceWhenFrameFails() throws {
        var compositor = OwnedSurfaceCompositor()

        _ = try compositor.applyGraphicsFrame(Self.makeResetSurfaceEnvelope(surfaceGeneration: 1, frameId: 1))
        let failing = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 2,
                capturedAtUptimeNs: 200,
                commandCount: 2,
                payloadLength: 0
            ),
            commands: [
                .copyRect(srcX: 0, srcY: 0, dstX: 1, dstY: 0, width: 1, height: 1),
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: 0)
                )
            ],
            payload: Data()
        )

        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try compositor.applyGraphicsFrame(failing)
        }
        #expect(compositor.committedUpdateId == OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 1))
    }

    @Test func ownedSurfaceCompositorCopiesFullWidthVerticalScrollUpAndDown() throws {
        let width = 4
        let height = 4
        let pixels = Self.makeDiagnosticPixels(width: width, height: height)

        var upCompositor = OwnedSurfaceCompositor()
        _ = try upCompositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: width,
            height: height,
            pixels: pixels
        ))
        let upStats = try upCompositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            srcX: 0,
            srcY: 1,
            dstX: 0,
            dstY: 0,
            width: width,
            height: 3
        ))
        let upPixels = upCompositor.pixelBytesForDiagnostics()

        #expect(upStats.copyRectCount == 1)
        #expect(upStats.copyRectMs >= 0)
        #expect(Self.row(upPixels, width: width, y: 0) == Self.row(pixels, width: width, y: 1))
        #expect(Self.row(upPixels, width: width, y: 1) == Self.row(pixels, width: width, y: 2))
        #expect(Self.row(upPixels, width: width, y: 2) == Self.row(pixels, width: width, y: 3))

        var downCompositor = OwnedSurfaceCompositor()
        _ = try downCompositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: width,
            height: height,
            pixels: pixels
        ))
        let downStats = try downCompositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            srcX: 0,
            srcY: 0,
            dstX: 0,
            dstY: 1,
            width: width,
            height: 3
        ))
        let downPixels = downCompositor.pixelBytesForDiagnostics()

        #expect(downStats.copyRectCount == 1)
        #expect(downStats.copyRectMs >= 0)
        #expect(Self.row(downPixels, width: width, y: 1) == Self.row(pixels, width: width, y: 0))
        #expect(Self.row(downPixels, width: width, y: 2) == Self.row(pixels, width: width, y: 1))
        #expect(Self.row(downPixels, width: width, y: 3) == Self.row(pixels, width: width, y: 2))
    }

    @Test func ownedSurfaceCompositorCopiesVerticalScrollInsideRegionOnly() throws {
        let width = 6
        let height = 5
        let pixels = Self.makeDiagnosticPixels(width: width, height: height)
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: width,
            height: height,
            pixels: pixels
        ))

        _ = try compositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            srcX: 2,
            srcY: 2,
            dstX: 2,
            dstY: 1,
            width: 3,
            height: 2
        ))

        let updated = compositor.pixelBytesForDiagnostics()
        #expect(Self.pixel(updated, width: width, x: 0, y: 0) == Self.pixel(pixels, width: width, x: 0, y: 0))
        #expect(Self.pixel(updated, width: width, x: 1, y: 1) == Self.pixel(pixels, width: width, x: 1, y: 1))
        #expect(Self.pixel(updated, width: width, x: 5, y: 2) == Self.pixel(pixels, width: width, x: 5, y: 2))
        #expect(Self.pixel(updated, width: width, x: 2, y: 1) == Self.pixel(pixels, width: width, x: 2, y: 2))
        #expect(Self.pixel(updated, width: width, x: 4, y: 2) == Self.pixel(pixels, width: width, x: 4, y: 3))
    }

    @Test func ownedSurfaceCompositorCopiesHorizontalPartialOverlap() throws {
        let width = 6
        let height = 2
        let pixels = Self.makeDiagnosticPixels(width: width, height: height)

        var rightCompositor = OwnedSurfaceCompositor()
        _ = try rightCompositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: width,
            height: height,
            pixels: pixels
        ))
        _ = try rightCompositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            srcX: 0,
            srcY: 0,
            dstX: 1,
            dstY: 0,
            width: 5,
            height: 1
        ))
        let rightPixels = rightCompositor.pixelBytesForDiagnostics()

        for x in 0..<5 {
            #expect(Self.pixel(rightPixels, width: width, x: x + 1, y: 0) == Self.pixel(pixels, width: width, x: x, y: 0))
        }

        var leftCompositor = OwnedSurfaceCompositor()
        _ = try leftCompositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: width,
            height: height,
            pixels: pixels
        ))
        _ = try leftCompositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            srcX: 1,
            srcY: 0,
            dstX: 0,
            dstY: 0,
            width: 5,
            height: 1
        ))
        let leftPixels = leftCompositor.pixelBytesForDiagnostics()

        for x in 0..<5 {
            #expect(Self.pixel(leftPixels, width: width, x: x, y: 0) == Self.pixel(pixels, width: width, x: x + 1, y: 0))
        }
    }

    @Test func ownedSurfaceCompositorStatsExposeTimingBuckets() throws {
        let pixels = Self.makeDiagnosticPixels(width: 2, height: 2)
        var compositor = OwnedSurfaceCompositor()

        let seedStats = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: 2,
            height: 2,
            pixels: pixels
        ))
        let copyStats = try compositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            srcX: 0,
            srcY: 1,
            dstX: 0,
            dstY: 0,
            width: 2,
            height: 1
        ))

        #expect(seedStats.tileDecodeMs >= 0)
        #expect(seedStats.tilePaintMs >= 0)
        #expect(seedStats.copyRectMs == 0)
        #expect(copyStats.copyRectMs >= 0)
        #expect(copyStats.tileDecodeMs == 0)
        #expect(copyStats.tilePaintMs == 0)
    }

    @MainActor
    @Test func ownedMediaVideoSinkQueuesResetRequestWhenGraphicsFrameFails() {
        let sink = OwnedMediaVideoSink()
        let ack = sink.renderOwnedGraphicsFrame(OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 1,
                capturedAtUptimeNs: 100,
                commandCount: 1,
                payloadLength: 0
            ),
            commands: [
                .copyRect(srcX: 0, srcY: 0, dstX: 0, dstY: 0, width: 1, height: 1)
            ],
            payload: Data()
        ))

        let request = sink.consumePendingGraphicsResetRequest()
        #expect(ack == OwnedGraphicsFrameAck(
            surfaceGeneration: 0,
            frameId: 0,
            compositorMs: 0,
            staleDiscardCount: 0
        ))
        #expect(request?.lastCommittedSurfaceGeneration == 0)
        #expect(request?.lastCommittedFrameId == 0)
        #expect(request?.reason.contains("graphics-frame-") == true)
        #expect(sink.consumePendingGraphicsResetRequest() == nil)
    }

    @MainActor
    @Test func ownedMediaVideoSinkGraphicsAckIncludesQueueDepthAndAppliedTotal() {
        let sink = OwnedMediaVideoSink()
        let ack = sink.renderOwnedGraphicsFrame(
            Self.makeResetSurfaceEnvelope(surfaceGeneration: 1, frameId: 1),
            queueDepth: OwnedGraphicsQueueDepth(queuedFrames: 2, queueDepthBytes: 4_096)
        )

        #expect(ack.surfaceGeneration == 1)
        #expect(ack.frameId == 1)
        #expect(ack.queuedFrames == 2)
        #expect(ack.queueDepthBytes == 4_096)
        #expect(ack.totalGraphicsFramesApplied == 1)
        #expect(ack.compositorMs >= 0)
        #expect(ack.staleDiscardCount == 0)
    }

    @MainActor
    @Test func graphicsOnlyClientRendersResetAndTile() throws {
        // With the HEVC decode path and datagram channel deleted, a graphics
        // envelope (reset + one bitmap tile) is the only thing that paints the
        // surface. It must ack the frame and produce a non-nil composited image.
        let sink = OwnedMediaVideoSink()
        let pixels = Data(repeating: 0x7F, count: 64 * 64 * 4)
        let envelope = try Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 7,
            width: 64,
            height: 64,
            pixels: pixels
        )

        let ack = sink.renderOwnedGraphicsFrame(envelope)

        #expect(ack.frameId == 7)
        #expect(ack.surfaceGeneration == 1)
        #expect(ack.totalGraphicsFramesApplied == 1)
        #expect(sink.debugCurrentImage() != nil)
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

    @Test func graphicsReconnectPolicyBacksOffAndStopsAtConfiguredAttemptLimit() {
        let policy = GraphicsReconnectPolicy(initialDelayMs: 250, maxDelayMs: 2_000, maxAttempts: 5)

        #expect(policy.delayMs(forAttempt: 0) == nil)
        #expect(policy.delayMs(forAttempt: 1) == 250)
        #expect(policy.delayMs(forAttempt: 2) == 500)
        #expect(policy.delayMs(forAttempt: 3) == 1_000)
        #expect(policy.delayMs(forAttempt: 4) == 2_000)
        #expect(policy.delayMs(forAttempt: 5) == 2_000)
        #expect(policy.delayMs(forAttempt: 6) == nil)
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
        #expect(decoded.payload.startIndex == 0)
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

        let emptyTile = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 6,
                capturedAtUptimeNs: 60,
                commandCount: 1,
                payloadLength: 0
            ),
            commands: [
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: 0)
                )
            ],
            payload: Data()
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try emptyTile.encode()
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

    @Test func graphicsStreamParserHandlesPartialAndCoalescedFrames() throws {
        let first = try makeGraphicsEnvelope(frameId: 1).encode()
        let secondEnvelope = makeGraphicsEnvelope(frameId: 2)
        let second = try secondEnvelope.encode()
        var parser = OwnedGraphicsStreamFrameParser()

        #expect(try parser.append(Data(first.prefix(7))).isEmpty)
        #expect(try parser.append(Data(first.dropFirst(7))).map(\.header.frameId) == [1])
        #expect(try parser.append(second + second) == [secondEnvelope, secondEnvelope])
    }

    @Test func graphicsStreamParserAcceptsNearLimitFrameWithCoalescedNextFrame() throws {
        let secondEnvelope = makeGraphicsEnvelope(frameId: 2)
        let second = try secondEnvelope.encode()
        let first = try makeNearMaximumGraphicsFrame(frameId: 1, followingFrameByteCount: second.count)
        #expect(first.count <= OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        #expect(first.count + second.count > OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        var parser = OwnedGraphicsStreamFrameParser()

        let frames = try parser.append(first + second)

        #expect(frames.map(\.header.frameId) == [1, 2])
    }

    @Test func graphicsStreamParserRejectsOversizedFrameLength() throws {
        var parser = OwnedGraphicsStreamFrameParser()
        var header = Data(OwnedGraphicsFrameEnvelope.magic)
        header.append(OwnedGraphicsFrameEnvelope.version)
        var metadataLength = UInt32(OwnedGraphicsStreamFrameParser.maxFrameByteCount + 1).bigEndian
        var payloadLength = UInt32(0).bigEndian
        withUnsafeBytes(of: &metadataLength) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: &payloadLength) { header.append(contentsOf: $0) }

        #expect(throws: OwnedGraphicsTransportError.frameMalformed) {
            _ = try parser.append(header)
        }
    }

    @Test func graphicsStreamEmptyReadReportsEOF() throws {
        #expect(throws: OwnedGraphicsTransportError.streamEOF) {
            _ = try OwnedGraphicsStreamRead.unwrap(data: Data(), error: nil)
        }
        #expect(String(describing: OwnedGraphicsTransportError.streamEOF) == "graphics-stream-eof")
    }

    @Test func graphicsStreamParserReportsMalformedAdgcFrame() throws {
        var parser = OwnedGraphicsStreamFrameParser()

        #expect(throws: OwnedGraphicsTransportError.frameMalformed) {
            _ = try parser.append(Data([0x42, 0x41, 0x44, 0x21, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
        }
        #expect(String(describing: OwnedGraphicsTransportError.frameMalformed) == "graphics-frame-malformed")
    }

    @Test func graphicsControlStreamFramesRoundTripSplitAndCoalescedMessages() throws {
        let ack = OwnedGraphicsFrameAck(
            surfaceGeneration: 4,
            frameId: 22,
            queueDepthBytes: 16_384,
            queuedFrames: 2,
            totalGraphicsFramesApplied: 9,
            compositorMs: 1.75,
            staleDiscardCount: 3
        )
        let request = OwnedGraphicsResetRequest(
            reason: "malformed-frame",
            lastCommittedSurfaceGeneration: 4,
            lastCommittedFrameId: 21
        )
        let ackFrame = try OwnedGraphicsControlStreamFrame.encode(ack)
        let requestFrame = try OwnedGraphicsControlStreamFrame.encode(request)
        var parser = OwnedGraphicsControlStreamFrameParser()

        #expect(try parser.append(Data(ackFrame.prefix(2))).isEmpty)
        let ackPayloads = try parser.append(Data(ackFrame.dropFirst(2)))
        #expect(try JSONDecoder().decode(OwnedGraphicsFrameAck.self, from: try #require(ackPayloads.first)) == ack)

        let payloads = try parser.append(requestFrame + ackFrame)
        #expect(payloads.count == 2)
        #expect(try JSONDecoder().decode(OwnedGraphicsResetRequest.self, from: payloads[0]) == request)
        #expect(try JSONDecoder().decode(OwnedGraphicsFrameAck.self, from: payloads[1]) == ack)
    }

    @Test func graphicsControlStreamRejectsEmptyPayload() throws {
        var parser = OwnedGraphicsControlStreamFrameParser()
        let frame = Data([0, 0, 0, 0])

        #expect(throws: OwnedGraphicsTransportError.controlMalformed) {
            _ = try parser.append(frame)
        }
        #expect(String(describing: OwnedGraphicsTransportError.controlMalformed) == "graphics-control-malformed")
    }

    @Test func graphicsResetFallbackGateDoesNotLoopSameFailedGenerationUntilReconnect() {
        var gate = OwnedGraphicsResetFallbackGate()
        let request = OwnedGraphicsResetRequest(
            reason: "graphics-stream-eof",
            lastCommittedSurfaceGeneration: 7,
            lastCommittedFrameId: 11
        )

        gate.startConnection()
        #expect(gate.beginFallbackIfAllowed(for: request) == .send)
        gate.noteFallbackFailed(for: request)
        #expect(gate.beginFallbackIfAllowed(for: request) == .suppress(reason: "already-failed-generation"))

        gate.startConnection()
        #expect(gate.beginFallbackIfAllowed(for: request) == .send)
    }

    @Test func graphicsResetFallbackGateAllowsOnlyOneActiveResetPerConnection() {
        var gate = OwnedGraphicsResetFallbackGate()
        let first = OwnedGraphicsResetRequest(
            reason: "graphics-frame-malformed",
            lastCommittedSurfaceGeneration: 3,
            lastCommittedFrameId: 8
        )
        let second = OwnedGraphicsResetRequest(
            reason: "graphics-control-malformed",
            lastCommittedSurfaceGeneration: 4,
            lastCommittedFrameId: 1
        )

        gate.startConnection()
        #expect(gate.beginFallbackIfAllowed(for: first) == .send)
        #expect(gate.beginFallbackIfAllowed(for: second) == .suppress(reason: "reset-already-active"))
        gate.noteFallbackCompleted(for: first)
        #expect(gate.beginFallbackIfAllowed(for: second) == .send)
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

    private func makeGraphicsEnvelope(frameId: UInt64) -> OwnedGraphicsFrameEnvelope {
        let payload = Data([1, 2, 3])
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: frameId,
                capturedAtUptimeNs: 100,
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
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                )
            ],
            payload: payload
        )
    }

    private func makeNearMaximumGraphicsFrame(frameId: UInt64, followingFrameByteCount: Int) throws -> Data {
        var payloadCount = OwnedGraphicsStreamFrameParser.maxFrameByteCount
            - OwnedGraphicsFrameEnvelope.fixedHeaderByteCount
        while payloadCount > 0 {
            let payload = Data(repeating: 0x5a, count: payloadCount)
            let envelope = OwnedGraphicsFrameEnvelope(
                header: OwnedGraphicsFrameHeader(
                    surfaceGeneration: 1,
                    frameId: frameId,
                    capturedAtUptimeNs: 100,
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
                        byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                    )
                ],
                payload: payload
            )
            let encoded = try envelope.encode()
            if encoded.count <= OwnedGraphicsStreamFrameParser.maxFrameByteCount {
                guard encoded.count + followingFrameByteCount > OwnedGraphicsStreamFrameParser.maxFrameByteCount else {
                    throw SessionRejected(reason: .malformed)
                }
                return encoded
            }
            payloadCount -= max(1, encoded.count - OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        }
        throw SessionRejected(reason: .malformed)
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
            queueDepthBytes: 16_384,
            queuedFrames: 2,
            totalGraphicsFramesApplied: 9,
            compositorMs: 1.75,
            staleDiscardCount: 3
        )
        let ackData = try JSONEncoder().encode(ack)
        let ackJson = String(data: ackData, encoding: .utf8) ?? ""
        let decodedAck = try JSONDecoder().decode(OwnedGraphicsFrameAck.self, from: ackData)
        #expect(decodedAck == ack)
        #expect(decodedAck.updateId == OwnedSurfaceUpdateId(surfaceGeneration: 4, frameId: 22))
        #expect(ackJson.contains("\"qb\":16384"))
        #expect(ackJson.contains("\"qf\":2"))
        #expect(ackJson.contains("\"tg\":9"))
        #expect(ackJson.contains("\"cm\":1.75"))
        #expect(ackJson.contains("\"sd\":3"))

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

    @Test func graphicsAckDefaultsMissingDiagnosticFieldsOnDecode() throws {
        let data = Data(#"{"t":"graphics-frame-ack","sg":4,"id":22,"cm":1.75,"sd":3}"#.utf8)
        let decoded = try JSONDecoder().decode(OwnedGraphicsFrameAck.self, from: data)

        #expect(decoded.surfaceGeneration == 4)
        #expect(decoded.frameId == 22)
        #expect(decoded.queueDepthBytes == 0)
        #expect(decoded.queuedFrames == 0)
        #expect(decoded.totalGraphicsFramesApplied == 0)
        #expect(decoded.compositorMs == 1.75)
        #expect(decoded.staleDiscardCount == 3)
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

    private static func makeResetSurfaceEnvelope(
        surfaceGeneration: UInt32,
        frameId: UInt64
    ) -> OwnedGraphicsFrameEnvelope {
        OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: 0
            ),
            commands: [
                .resetSurface(
                    surfaceGeneration: surfaceGeneration,
                    width: 2,
                    height: 1,
                    pixelFormat: .bgra
                )
            ],
            payload: Data()
        )
    }

    private static func makeSeedSurfaceEnvelope(
        surfaceGeneration: UInt32,
        frameId: UInt64,
        width: Int,
        height: Int,
        pixels: Data
    ) throws -> OwnedGraphicsFrameEnvelope {
        let payload = try compressLZFSE(pixels)
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 2,
                payloadLength: payload.count
            ),
            commands: [
                .resetSurface(
                    surfaceGeneration: surfaceGeneration,
                    width: width,
                    height: height,
                    pixelFormat: .bgra
                ),
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: width,
                    height: height,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                )
            ],
            payload: payload
        )
    }

    private static func makeCopyRectEnvelope(
        surfaceGeneration: UInt32,
        frameId: UInt64,
        srcX: Int,
        srcY: Int,
        dstX: Int,
        dstY: Int,
        width: Int,
        height: Int
    ) -> OwnedGraphicsFrameEnvelope {
        OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: 0
            ),
            commands: [
                .copyRect(srcX: srcX, srcY: srcY, dstX: dstX, dstY: dstY, width: width, height: height)
            ],
            payload: Data()
        )
    }

    private static func makeDiagnosticPixels(width: Int, height: Int) -> Data {
        var pixels = Data()
        pixels.reserveCapacity(width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                pixels.append(UInt8((y * width + x) & 0xff))
                pixels.append(UInt8((x * 17) & 0xff))
                pixels.append(UInt8((y * 29) & 0xff))
                pixels.append(0xff)
            }
        }
        return pixels
    }

    private static func row(_ pixels: Data, width: Int, y: Int) -> Data {
        let rowBytes = width * 4
        return pixels.subdata(in: (y * rowBytes)..<((y + 1) * rowBytes))
    }

    private static func pixel(_ pixels: Data, width: Int, x: Int, y: Int) -> Data {
        let offset = (y * width + x) * 4
        return pixels.subdata(in: offset..<(offset + 4))
    }

    private static func compressLZFSE(_ data: Data) throws -> Data {
        var outputSize = max(data.count + 1024, 1024)
        while outputSize <= max(data.count * 8, 4096) {
            var output = Data(count: outputSize)
            let encodedCount = output.withUnsafeMutableBytes { outputBytes in
                data.withUnsafeBytes { inputBytes in
                    compression_encode_buffer(
                        outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                        outputSize,
                        inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                        data.count,
                        nil,
                        COMPRESSION_LZFSE
                    )
                }
            }
            if encodedCount > 0 {
                output.removeSubrange(encodedCount..<output.count)
                return output
            }
            outputSize *= 2
        }
        throw SessionRejected(reason: .malformed)
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
