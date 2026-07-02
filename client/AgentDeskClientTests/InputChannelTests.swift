import Foundation
import Compression
import CryptoKit
import OSLog
import Testing
import UIKit

struct InputChannelTests {
    @Test func quicSessionFrameRoundTripsInputPayload() throws {
        let event = InputChannelEvent(event: .key(code: "ansi-A", modifiers: [.cmd]))
        let payload = try JSONEncoder().encode(event)
        let encoded = try QuicSessionStreamFrame.encode(role: .input, payload: payload)
        let frame = try QuicSessionStreamFrame.decode(encoded)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: frame.payload)

        #expect(frame.role == .input)
        #expect(decoded == event)
    }

    @Test func quicSessionFrameRejectsMalformedFrames() throws {
        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(Data())
        }
        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(Data([0xff, 0, 0, 0, 0]))
        }
    }

    @Test func sessionReadyCarriesResumeAndMediaKeySalt() throws {
        let ready = SessionReady(
            sessionId: "session-123",
            resumeId: Data([1, 2, 3]),
            resumeSecret: Data([7, 8, 9]),
            resumeExpiresAt: 1_800_000_020,
            mediaKeySalt: Data([4, 5, 6]),
            hostSignature: Data([10, 11, 12])
        )
        let data = try JSONEncoder().encode(ready)
        let json = String(data: data, encoding: .utf8) ?? ""

        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)
        #expect(decoded == ready)
        #expect(json.contains("\"sid\":\"session-123\""))
        #expect(json.contains("\"rid\":\"AQID\""))
        #expect(json.contains("\"rs\":\"BwgJ\""))
        #expect(json.contains("\"mk\":\"BAUG\""))
        #expect(json.contains("\"hs\":\"CgsM\""))
    }

    @Test func sessionResumeProofRejectsUnexpectedType() {
        let data = Data(#"{"t":"session-ready","p":"AQID"}"#.utf8)

        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(SessionResumeProof.self, from: data)
        }
    }

    @Test func sessionReadyHostSignatureRejectsTamperedMaterial() throws {
        let hostKey = P256.Signing.PrivateKey()
        let hostFingerprint = hostKey.publicKey.agentDeskFingerprint
        let deviceFingerprint = DeviceFingerprint("device-fp")
        let clientNonce = Data(repeating: 4, count: 32)
        let hostNonce = Data(repeating: 5, count: 32)
        let unsignedReady = SessionReady(
            sessionId: "session-123",
            resumeId: Data(repeating: 6, count: 32),
            resumeSecret: Data(repeating: 7, count: 32),
            resumeExpiresAt: 1_800_000_020,
            mediaKeySalt: Data(repeating: 8, count: 32),
            hostSignature: Data()
        )
        let signature = try hostKey.signature(for: SessionResumeSigning.readyInput(
            ready: unsignedReady,
            deviceFingerprint: deviceFingerprint,
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            protocolVersion: Config.protocolVersion,
            hostFingerprint: hostFingerprint
        )).rawRepresentation
        let signedReady = SessionReady(
            sessionId: unsignedReady.sessionId,
            resumeId: unsignedReady.resumeId,
            resumeSecret: unsignedReady.resumeSecret,
            resumeExpiresAt: unsignedReady.resumeExpiresAt,
            mediaKeySalt: unsignedReady.mediaKeySalt,
            hostSignature: signature
        )
        let tamperedReady = SessionReady(
            sessionId: unsignedReady.sessionId,
            resumeId: unsignedReady.resumeId,
            resumeSecret: Data(repeating: 9, count: 32),
            resumeExpiresAt: unsignedReady.resumeExpiresAt,
            mediaKeySalt: unsignedReady.mediaKeySalt,
            hostSignature: signature
        )

        try SessionHostSignatureVerifier.verifyReadySignature(
            signedReady,
            hostPublicKey: hostKey.publicKey,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            protocolVersion: Config.protocolVersion
        )
        #expect(throws: SessionRejected(reason: .badSignature)) {
            try SessionHostSignatureVerifier.verifyReadySignature(
                tamperedReady,
                hostPublicKey: hostKey.publicKey,
                hostFingerprint: hostFingerprint,
                deviceFingerprint: deviceFingerprint,
                clientNonce: clientNonce,
                hostNonce: hostNonce,
                protocolVersion: Config.protocolVersion
            )
        }
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
            _ = try compositor.applyGraphicsFrame(failing)
        }
        #expect(compositor.committedUpdateId == OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 1))
    }

    // ADR-0022: the client tags each QUIC connection with a 1-byte role. Pin the
    // values so they match the host's routing ('G' graphics, 'I' interactive).
    @Test func graphicsStreamRoleTagBytesMatchHost() {
        #expect(OwnedGraphicsStreamRole.graphics.rawValue == 0x47)
        #expect(OwnedGraphicsStreamRole.interactive.rawValue == 0x49)
    }

    @Test func sessionConnectionReadinessKeepsWaitingTransient() {
        #expect(SessionConnectionReadiness.decision(for: .setup) == .keepWaiting)
        #expect(SessionConnectionReadiness.decision(for: .preparing) == .keepWaiting)
        #expect(SessionConnectionReadiness.decision(for: .waiting("Network is down")) == .keepWaiting)
        #expect(SessionConnectionReadiness.decision(for: .ready) == .ready)
        #expect(SessionConnectionReadiness.decision(for: .failed("Socket is not connected")) == .fail("Socket is not connected"))
        #expect(SessionConnectionReadiness.decision(for: .cancelled) == .fail(String(describing: CancellationError())))
    }

    @Test func ownedMediaStatusLabelsStayConcise() {
        #expect(OwnedMediaStatus.connecting.labelText == "media connecting")
        #expect(OwnedMediaStatus.connected.labelText == "media connected")
        #expect(OwnedMediaStatus.video(OwnedMediaVideoStatusSnapshot(
            fps: 30,
            expectedFps: 30,
            fpsDeficit: 0,
            receivedKbps: 1_250,
            width: 1280,
            height: 720,
            gapMs: 33,
            maxGapMs: 33,
            droppedFrames: 0,
            renderStallCount: 0,
            decodeDropCount: 0,
            repairRequestedCount: 0,
            repairExpiredCount: 0,
            windowMs: 1_000
        )).labelText == "30/30fps rx1250kbps 1280x720 gap33 d0")
        #expect(OwnedMediaStatus.videoRepairing.labelText == "video repairing")
        #expect(OwnedMediaStatus.videoWaitingKeyframe.labelText == "video waiting keyframe")
        #expect(OwnedMediaStatus.videoDropped.labelText == "video dropped")
        #expect(OwnedMediaStatus.tilesLive.labelText == "tiles live")
    }

    @Test func ownedMediaVideoStatusTrackerPublishesBoundedReceiveDiagnostics() {
        var tracker = OwnedMediaVideoStatusTracker(publishIntervalNs: 1_000_000_000)

        #expect(tracker.noteEnqueuedFrame(bytes: 125_000, width: 1280, height: 720, nowNs: 0) == nil)
        tracker.noteDroppedFrames(2)
        tracker.noteRepairRequested(3)
        tracker.noteRepairExpired(1)
        tracker.noteRenderStall()
        tracker.noteDecodeDrop()
        #expect(tracker.noteEnqueuedFrame(bytes: 125_000, width: 1280, height: 720, nowNs: 500_000_000) == nil)
        let snapshot = tracker.noteEnqueuedFrame(bytes: 125_000, width: 960, height: 540, nowNs: 1_000_000_000)

        #expect(snapshot == OwnedMediaVideoStatusSnapshot(
            fps: 3,
            expectedFps: 30,
            fpsDeficit: 27,
            receivedKbps: 3_000,
            width: 960,
            height: 540,
            gapMs: 500,
            maxGapMs: 500,
            droppedFrames: 2,
            renderStallCount: 1,
            decodeDropCount: 1,
            repairRequestedCount: 3,
            repairExpiredCount: 1,
            windowMs: 1_000
        ))
        #expect(snapshot?.diagnosticsFields["maxGapMs"] == "500")
        #expect(snapshot?.diagnosticsFields["renderStallCount"] == "1")
    }

    @MainActor
    @Test func ownedMediaVideoSinkPublishesStatusToObserver() {
        let sink = OwnedMediaVideoSink()
        var observed: [String] = []
        sink.onOwnedMediaStatusChange = { observed.append($0.labelText) }

        // No status published until one is set; the initial "connecting" seed now lives on
        // the controller's fixed-chrome label, not the sink.
        #expect(sink.lastPublishedStatusTextForTesting() == nil)

        sink.setOwnedMediaStatus(.connected)
        #expect(sink.lastPublishedStatusTextForTesting() == "media connected")
        #expect(observed == ["media connected"])

        // Unchanged status does not re-publish.
        sink.setOwnedMediaStatus(.connected)
        #expect(observed == ["media connected"])
    }

    // R8: the host reads this raw stream-role byte to route the reliable graphics lane;
    // it must stay pinned so the host and client cannot disagree on which stream is which.
    // ADR-0038 added the .dom lane at 4, so 4 is now valid and 5 is the first unused byte.
    @Test func streamRoleGraphicsByteIsPinned() {
        #expect(QuicSessionStreamRole.graphics.rawValue == 3)
        #expect(QuicSessionStreamRole(rawValue: 3) == .graphics)
        #expect(QuicSessionStreamRole.dom.rawValue == 4)
        #expect(QuicSessionStreamRole(rawValue: 4) == .dom)
        #expect(QuicSessionStreamRole(rawValue: 5) == nil)
    }

    // ADR-0045: the DOM capture pause/resume frame the client sends UP the .dom lane. The host guard
    // and the extension both key on `t` == "dom-capture" and the boolean `on`, so the wire shape
    // must stay pinned across all three layers.
    @Test func domCaptureCommandEncodesToPinnedWireShape() throws {
        let paused = try JSONEncoder().encode(DomCaptureCommand(on: false))
        let obj = try JSONSerialization.jsonObject(with: paused) as? [String: Any]
        #expect(obj?["t"] as? String == "dom-capture")
        #expect(obj?["on"] as? Bool == false)

        let resumed = try JSONEncoder().encode(DomCaptureCommand(on: true))
        let robj = try JSONSerialization.jsonObject(with: resumed) as? [String: Any]
        #expect(robj?["on"] as? Bool == true)

        #expect(try JSONDecoder().decode(DomCaptureCommand.self, from: paused) == DomCaptureCommand(on: false))
    }

    // ADR-0046: host-pushed diagnostic status decodes from the .dom lane frame; `tab` is optional.
    @Test func domStatusDecodesFromWire() throws {
        let recording = try JSONDecoder().decode(
            DomStatus.self, from: Data(#"{"t":"dom-status","ext":true,"tab":5}"#.utf8))
        #expect(recording.ext == true)
        #expect(recording.tab == 5)

        let idle = try JSONDecoder().decode(
            DomStatus.self, from: Data(#"{"t":"dom-status","ext":false}"#.utf8))
        #expect(idle.ext == false)
        #expect(idle.tab == nil)
    }

    // ADR-0046: the pure status -> chip mapping that drives the Browser status line.
    @Test func statusChipsReflectHealthyMirror() {
        let chips = statusChips(DomMirrorStatus(
            mirroringOn: true, extReachable: true, recordingTab: 3,
            lastBatchAgeMs: 500, nodeCount: 142, paused: false))
        let texts = chips.map(\.text)
        #expect(texts.contains("mirror ON"))
        #expect(texts.contains("ext \u{2713}"))
        #expect(texts.contains("rec tab 3"))
        #expect(texts.contains("142 nodes"))
        #expect(texts.contains("just now"))
        #expect(!texts.contains("paused"))
    }

    @Test func statusChipsFlagUnreachableAndPausedAndStale() {
        let chips = statusChips(DomMirrorStatus(
            mirroringOn: true, extReachable: false, recordingTab: nil,
            lastBatchAgeMs: 8000, nodeCount: nil, paused: true))
        let byText = Dictionary(uniqueKeysWithValues: chips.map { ($0.text, $0.severity) })
        #expect(byText["ext \u{2717}"] == .warn)
        #expect(byText["no rec"] == .warn)
        #expect(byText["paused"] == .warn)
        #expect(byText["8s ago"] == .warn) // stale (>= 5s)
    }

    // R7: crisp-repair composites the crisp overlay over the live video floor with NO
    // whole-surface swap. A crisp frame reveals the overlay; a later video frame reveals
    // the floor without hiding the overlay (the retired ADR-0025 swap would have hidden
    // one to show the other).
    @MainActor
    @Test func ownedMediaVideoSinkCompositesCrispOverlayOverVideoFloorWithoutSwap() {
        let sink = OwnedMediaVideoSink()
        #expect(sink.crispOverlayVisibleForTesting() == false)
        #expect(sink.videoFloorVisibleForTesting() == false)

        _ = sink.renderOwnedGraphicsFrame(Self.makeResetSurfaceEnvelope(surfaceGeneration: 1, frameId: 1))
        #expect(sink.crispOverlayVisibleForTesting() == true)
        #expect(sink.videoFloorVisibleForTesting() == false)

        sink.renderOwnedVideoFrame(Self.makeVideoEnvelope(frameId: 1), frameBytes: 4)
        #expect(sink.videoFloorVisibleForTesting() == true)
        #expect(sink.crispOverlayVisibleForTesting() == true, "revealing the video floor must not hide the crisp overlay")
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
                .bitmapTile(x: 0, y: 0, width: 1, height: 1, compression: .lzfse,
                            byteRange: OwnedGraphicsByteRange(offset: 0, length: 0))
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
                .drawCachedTile(slot: 0, x: 0, y: 0, width: 100, height: 92),
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
                .drawCachedTile(slot: 0, x: -1, y: 0, width: 1, height: 1)
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

    @Test func graphicsCommandsRoundTrip() throws {
        let commands: [OwnedGraphicsCommand] = [
            .resetSurface(surfaceGeneration: 3, width: 1920, height: 1080, pixelFormat: .bgra),
            .drawCachedTile(slot: 1, x: 0, y: 0, width: 1920, height: 1072),
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

    @Test func eventFramePreservesNormalizedInput() throws {
        let event = NormalizedInput.cursorMove(dx: 1.5, dy: -2.25)
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)
        #expect(decoded.event == event)
    }

    @Test func cursorSetEventFramePreservesNormalizedInput() throws {
        let event = NormalizedInput.cursorSet(displayId: "display-a", x: 250.5, y: 500.75)
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)

        #expect(decoded.event == event)
    }

    @Test func protocolVersionIsThreeForCursorSetWireBreak() {
        #expect(Config.protocolVersion == 3)
        #expect(Config.minCompatibleProtocolVersion == 3)
    }

    @Test func eventFrameRoundTripPreservesKeyWithModifiers() throws {
        let event = NormalizedInput.key(code: "ansi-K", modifiers: [.cmd, .ctrl, .option, .shift])
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)
        #expect(decoded.event == event)
    }

    @Test func agentSayFrameSerializesWithCompactKeys() throws {
        let push = AgentSayPush(id: "utterance-1", phase: "chunk", sequence: 0, text: "hello")
        let data = try JSONEncoder().encode(push)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentSayPush.self, from: data)

        #expect(json.contains("\"t\":\"agent-say\""))
        #expect(json.contains("\"p\":\"chunk\""))
        #expect(json.contains("\"q\":0"))
        #expect(json.contains("\"x\":\"hello\""))
        #expect(decoded == push)
    }

    @Test func cursorFrameDecodes() throws {
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
        let decoded = try JSONDecoder().decode(CursorImagePush.self, from: data)

        #expect(json.contains("\"t\":\"cursor\""))
        #expect(decoded == push)
    }

    @Test func cursorPositionFrameDecodes() throws {
        let push = CursorPositionPush(
            displayId: "display-1",
            cursorX: 1499,
            cursorY: 480
        )
        let data = try JSONEncoder().encode(push)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(CursorPositionPush.self, from: data)

        #expect(json.contains("\"t\":\"cursor-position\""))
        #expect(json.contains("\"d\":\"display-1\""))
        #expect(json.contains("\"x\":1499"))
        #expect(decoded == push)
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

    @Test func diagnosticsWireTypesRoundTripAndOfferPortClassifierRoutesMessages() throws {
        let request = SignedDiagnosticsRequest(
            requestId: "req-1",
            sinceRunId: "run-0",
            includePreviousRuns: true,
            maxBytes: 8_192,
            hostFingerprint: "host-fp",
            issuedAt: 1_800_000_000,
            nonce: Data([1, 2, 3]),
            hostSignature: Data([4, 5, 6])
        )
        let summary = DiagnosticsSummary(
            requestId: "req-1",
            runs: [
                DiagnosticsRunSummary(
                    runId: "run-1",
                    startedAt: 1_800_000_001,
                    endedAt: 1_800_000_010,
                    cleanShutdown: false,
                    byteCount: 512,
                    eventCount: 3
                )
            ],
            droppedEvents: 2,
            droppedBytes: 128,
            latestMetricKitPayloadAt: 1_800_000_020
        )
        let chunk = DiagnosticsChunk(
            requestId: "req-1",
            sequence: 0,
            isFinal: true,
            runId: "run-1",
            uncompressedBytes: 512,
            payloadBase64: Data("hello".utf8).base64EncodedString()
        )
        let error = DiagnosticsError(requestId: "req-1", reason: "unavailable")

        #expect(try JSONDecoder().decode(SignedDiagnosticsRequest.self, from: JSONEncoder().encode(request)) == request)
        #expect(try JSONDecoder().decode(DiagnosticsSummary.self, from: JSONEncoder().encode(summary)) == summary)
        #expect(try JSONDecoder().decode(DiagnosticsChunk.self, from: JSONEncoder().encode(chunk)) == chunk)
        #expect(try JSONDecoder().decode(DiagnosticsError.self, from: JSONEncoder().encode(error)) == error)

        switch OfferPortMessage.classify(try JSONEncoder().encode(request)) {
        case .diagnosticsRequest(let decoded):
            #expect(decoded == request)
        default:
            Issue.record("expected diagnostics request")
        }
        switch OfferPortMessage.classify(try JSONEncoder().encode(summary)) {
        case .diagnosticsSummary(let decoded):
            #expect(decoded == summary)
        default:
            Issue.record("expected diagnostics summary")
        }
        switch OfferPortMessage.classify(try JSONEncoder().encode(chunk)) {
        case .diagnosticsChunk(let decoded):
            #expect(decoded == chunk)
        default:
            Issue.record("expected diagnostics chunk")
        }
        switch OfferPortMessage.classify(try JSONEncoder().encode(error)) {
        case .diagnosticsError(let decoded):
            #expect(decoded == error)
        default:
            Issue.record("expected diagnostics error")
        }
    }

    @Test func clientDiagnosticsStoreRedactsSecretsAndTruncatesOversizedEvents() throws {
        let harness = try Self.makeDiagnosticsHarness(name: #function, maxEventBytes: 256)
        defer { harness.cleanup() }

        let counter = Counter(value: 10)
        let store = ClientDiagnosticsStore(
            configuration: harness.configuration,
            nowProvider: { counter.next() }
        )
        store.bootstrap()
        store.record(
            type: "pairingLifecycle",
            fields: [
                "pairingURL": "agentdesk://pair?p=secret",
                "token": "top-secret-token",
                "note": "safe"
            ],
            level: OSLogType.info
        )
        store.record(
            type: "oversizedEvent",
            fields: ["message": String(repeating: "x", count: 2_048)],
            level: OSLogType.error
        )

        let lines = try Self.readNDJSONLines(at: harness.configuration.currentRunURL)
        #expect(lines.contains { $0.contains("\"type\":\"pairingLifecycle\"") && $0.contains("[redacted]") })
        #expect(!lines.joined(separator: "\n").contains("top-secret-token"))
        #expect(!lines.joined(separator: "\n").contains("agentdesk://pair?p=secret"))
        #expect(lines.contains { $0.contains("\"type\":\"oversizedEvent\"") && $0.contains("\"truncated\":\"true\"") })
    }

    @Test func clientDiagnosticsStoreFlagsUncleanReopenAndSuppressesFalsePositiveAfterCleanShutdown() throws {
        let uncleanHarness = try Self.makeDiagnosticsHarness(name: "\(#function)-unclean")
        defer { uncleanHarness.cleanup() }

        let firstCounter = Counter(value: 100)
        let firstStore = ClientDiagnosticsStore(
            configuration: uncleanHarness.configuration,
            nowProvider: { firstCounter.next() }
        )
        firstStore.bootstrap()
        firstStore.record(type: "mediaReceive", fields: ["state": "active"], level: .info)

        let secondCounter = Counter(value: 200)
        let reopenedStore = ClientDiagnosticsStore(
            configuration: uncleanHarness.configuration,
            nowProvider: { secondCounter.next() }
        )
        reopenedStore.bootstrap()

        let reopenLines = try Self.readNDJSONLines(at: uncleanHarness.configuration.currentRunURL)
        #expect(reopenLines.contains { $0.contains("\"type\":\"previousRunUncleanExit\"") })
        let reconnectSummary = reopenedStore.reconnectAnnouncementSummary()
        #expect(reconnectSummary?.runs.count == 1)
        #expect(reconnectSummary?.runs.first?.cleanShutdown == false)

        let cleanHarness = try Self.makeDiagnosticsHarness(name: "\(#function)-clean")
        defer { cleanHarness.cleanup() }

        let cleanCounter = Counter(value: 300)
        let cleanStore = ClientDiagnosticsStore(
            configuration: cleanHarness.configuration,
            nowProvider: { cleanCounter.next() }
        )
        cleanStore.bootstrap()
        cleanStore.record(type: "sessionConnected", fields: ["host": "mac"], level: .info)
        cleanStore.markCleanShutdown(reason: "test")

        let cleanReopenCounter = Counter(value: 400)
        let cleanReopenedStore = ClientDiagnosticsStore(
            configuration: cleanHarness.configuration,
            nowProvider: { cleanReopenCounter.next() }
        )
        cleanReopenedStore.bootstrap()

        let cleanLines = try Self.readNDJSONLines(at: cleanHarness.configuration.currentRunURL)
        #expect(!cleanLines.contains { $0.contains("\"type\":\"previousRunUncleanExit\"") })
        #expect(cleanReopenedStore.reconnectAnnouncementSummary() == nil)
    }

    @Test func clientDiagnosticsStoreRetainsCurrentPlusTwoPreviousRuns() throws {
        let harness = try Self.makeDiagnosticsHarness(
            name: #function,
            maxEventBytes: 512,
            maxRunBytes: 1_024,
            maxTotalBytes: 3_072,
            maxRuns: 3
        )
        defer { harness.cleanup() }

        for run in 0..<4 {
            let counter = Counter(value: 1_000 + run * 100)
            let store = ClientDiagnosticsStore(
                configuration: harness.configuration,
                nowProvider: { counter.next() }
            )
            store.bootstrap()
            store.record(
                type: "mediaSummary",
                fields: ["payload": String(repeating: "\(run)", count: 400)],
                level: .info
            )
            store.markCleanShutdown(reason: "rotate")
        }

        let manifest = try Self.readManifest(at: harness.configuration.manifestURL)
        #expect(manifest.archives.count == 2)
        if manifest.current == nil {
            Issue.record("expected a current diagnostics run")
        }
        #expect(!manifest.archives.contains(where: { !$0.cleanShutdown }))
        #expect(manifest.droppedEvents > 0)
        let oldestArchivePath = harness.configuration.diagnosticsDirectory
            .appendingPathComponent("run-\(manifest.archives.first!.runId).ndjson")
        #expect(FileManager.default.fileExists(atPath: oldestArchivePath.path))
    }

    @Test func clientDiagnosticsPrepareResponseFailsWhenRunFileIsUnreadable() throws {
        let harness = try Self.makeDiagnosticsHarness(name: #function)
        defer { harness.cleanup() }

        let counter = Counter(value: 500)
        let store = ClientDiagnosticsStore(
            configuration: harness.configuration,
            nowProvider: { counter.next() }
        )
        store.bootstrap()
        try FileManager.default.removeItem(at: harness.configuration.currentRunURL)

        let result = store.prepareResponse(for: DiagnosticsRequest(
            requestId: "req-missing",
            includePreviousRuns: false
        ))

        switch result {
        case .failure(let error):
            #expect(error.reason == "diagnostics-read-failed")
        case .success:
            Issue.record("expected diagnostics-read-failed")
        }
    }

    @Test func clientDiagnosticsPrepareResponseEmitsTerminalChunkForEmptyRunData() throws {
        let harness = try Self.makeDiagnosticsHarness(name: #function)
        defer { harness.cleanup() }

        let counter = Counter(value: 600)
        let store = ClientDiagnosticsStore(
            configuration: harness.configuration,
            nowProvider: { counter.next() }
        )
        store.bootstrap()
        try Data().write(to: harness.configuration.currentRunURL, options: .atomic)

        let result = store.prepareResponse(for: DiagnosticsRequest(
            requestId: "req-empty",
            includePreviousRuns: false
        ))

        switch result {
        case .failure(let error):
            Issue.record("unexpected failure \(error.reason)")
        case .success(let prepared):
            #expect(prepared.summary.requestId == "req-empty")
            #expect(prepared.summary.runs.count == 1)
            #expect(prepared.chunks.count == 1)
            #expect(prepared.chunks[0].isFinal)
            #expect(prepared.chunks[0].runId == prepared.summary.runs[0].runId)
            #expect(prepared.chunks[0].payloadBase64.isEmpty == false)
        }
    }

    // A minimal HEVC video envelope. The decoder cannot present it (no real bitstream),
    // but the sink still reveals the video floor on arrival, which is what the
    // compositing test asserts.
    private static func makeVideoEnvelope(frameId: UInt64) -> OwnedMediaFrameEnvelope {
        let header = OwnedMediaFrameHeader(
            surfaceGeneration: 1, frameId: frameId, codec: .hevc, width: 2, height: 1,
            capturedAtUptimeNs: frameId * 100, presentationTimeNs: frameId * 1_000,
            isKeyframe: true,
            parameterSets: OwnedMediaParameterSets(vps: Data([1]), sps: Data([2]), pps: Data([3])),
            refreshReason: .initial
        )
        return OwnedMediaFrameEnvelope(header: header, payload: Data([1, 2, 3, 4]))
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

    private struct DiagnosticsHarness {
        let configuration: ClientDiagnosticsStoreConfiguration
        let rootDirectory: URL

        func cleanup() {
            try? FileManager.default.removeItem(at: rootDirectory)
        }
    }

    private struct DiagnosticsManifestSnapshot: Decodable {
        let current: DiagnosticsRunSnapshot?
        let archives: [DiagnosticsRunSnapshot]
        let droppedEvents: Int
        let droppedBytes: Int
    }

    private struct DiagnosticsRunSnapshot: Decodable, Equatable {
        let runId: String
        let fileName: String
        let startedAt: Int
        let endedAt: Int?
        let cleanShutdown: Bool
        let retrievedAt: Int?
        let byteCount: Int
        let eventCount: Int
    }

    private final class Counter: @unchecked Sendable {
        private var value: Int

        init(value: Int) {
            self.value = value
        }

        func next() -> Int {
            value += 1
            return value
        }
    }

    private static func makeDiagnosticsHarness(
        name: String,
        maxEventBytes: Int = 8 * 1024,
        maxRunBytes: Int = 2 * 1024 * 1024,
        maxTotalBytes: Int = 6 * 1024 * 1024,
        maxRuns: Int = 3
    ) throws -> DiagnosticsHarness {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-diagnostics-\(name)-\(UUID().uuidString)", isDirectory: true)
        let diagnosticsDirectory = root.appendingPathComponent("Diagnostics", isDirectory: true)
        try FileManager.default.createDirectory(at: diagnosticsDirectory, withIntermediateDirectories: true)
        let configuration = ClientDiagnosticsStoreConfiguration(
            diagnosticsDirectory: diagnosticsDirectory,
            manifestURL: diagnosticsDirectory.appendingPathComponent("manifest.json", isDirectory: false),
            currentRunURL: diagnosticsDirectory.appendingPathComponent("current.ndjson", isDirectory: false),
            maxEventBytes: maxEventBytes,
            maxRunBytes: maxRunBytes,
            maxTotalBytes: maxTotalBytes,
            maxRuns: maxRuns,
            maxResponseBytes: 768 * 1024,
            maxChunkEncodedBytes: 48 * 1024,
            authMaxSkewSeconds: 60
        )
        return DiagnosticsHarness(configuration: configuration, rootDirectory: root)
    }

    private static func readNDJSONLines(at url: URL) throws -> [String] {
        try String(decoding: Data(contentsOf: url), as: UTF8.self)
            .split(separator: "\n")
            .map(String.init)
    }

    private static func readManifest(at url: URL) throws -> DiagnosticsManifestSnapshot {
        try JSONDecoder().decode(DiagnosticsManifestSnapshot.self, from: Data(contentsOf: url))
    }
}
