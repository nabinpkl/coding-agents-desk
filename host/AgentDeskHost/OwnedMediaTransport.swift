import CoreImage
import CoreVideo
import CryptoKit
import Foundation
import Network
import os

@available(macOS 26.0, *)
final class QuicSessionHostMediaTransport: MediaTransport, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let source: VideoFrameSource
    private let datagrams: QUIC.Datagrams<QUICDatagram>
    private let mediaKey: SymmetricKey
    private let encoder = VideoToolboxOwnedMediaEncoder(
        codec: .hevc,
        configuration: .fromConfig()
    )
    // ADR-0033 + ADR-0034: capture always runs at native resolution. The quality
    // ladder's resolutionScale is applied here, downscaling the frame the video
    // encoder sees, while crisp taps the untouched native buffer so settled text
    // is restored at full resolution regardless of the video rung. One reusable
    // scaler (owns its own CIContext).
    private let videoScaler = OwnedMediaFrameScaler()
    private let pacer = OwnedMediaDatagramSendPacer(
        burstPacketCount: Config.ownedMediaDatagramBurstPacketCount,
        burstPauseUs: Config.ownedMediaDatagramBurstPauseUs
    )
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    let connectionState: AsyncStream<MediaConnectionState>
    private let encodeGate = OSAllocatedUnfairLock<EncodeState>(initialState: EncodeState())
    private let sendQueueGate = OSAllocatedUnfairLock<MediaSendQueueState>(
        initialState: MediaSendQueueState()
    )
    private var controlTask: Task<Void, Never>?
    // ADR-0034 crisp-repair: per-tile crisp emitter and its reliable lane. Guarded by
    // its own lock because crisp runs alongside the video encode in the drain loop.
    private struct CrispState {
        var controller = RegionCrispController(config: .fromConfig())
        var lane: GraphicsLaneServer?
        var surfaceGeneration: UInt32 = 0
        var crispFrameId: UInt64 = 0
        var surfaceInitialized = false
        var lastCrispNs: UInt64 = 0
        var lastConvertWarnNs: UInt64 = 0
        // Caps crisp's sustained link share at the per-second byte budget (see
        // CrispPacingGate) so a large settle cannot flood the QUIC link it shares with the
        // video datagrams. Which regions crisp is decided per-tile by the controller.
        var pacing = CrispPacingGate(maxBytesPerSecond: Config.ownedMediaCrispMaxBytesPerSecond)
    }
    private let crispGate = OSAllocatedUnfairLock<CrispState>(initialState: CrispState())

    init(
        source: VideoFrameSource,
        datagrams: QUIC.Datagrams<QUICDatagram>,
        mediaKey: SymmetricKey
    ) {
        self.source = source
        self.datagrams = datagrams
        self.mediaKey = mediaKey
        var stateCont: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { stateCont = $0 }
        stateContinuation = stateCont
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        stateContinuation.yield(.connected)
        try await source.start { [weak self] frame in
            self?.enqueue(frame)
        }
        startControlReceiveLoop()
    }

    func stop() {
        controlTask?.cancel()
        controlTask = nil
        source.stop()
        crispGate.withLock { state in
            state.lane?.close()
            state.lane = nil
        }
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    // ADR-0034: the reliable graphics lane attaches after the client opens it (later than
    // session-ready). Reset the crisp controller so the fresh client re-establishes a
    // baseline rather than referencing slots it never got. The surface generation bump and
    // the resetSurface emission happen together when the next crisp window initializes the
    // surface (see processCrisp), so attach and resize share one baseline-establish point.
    func attachGraphicsLane(_ lane: GraphicsLaneServer) {
        crispGate.withLock { state in
            state.lane?.close()
            state.lane = lane
            state.controller.reset()
            state.surfaceInitialized = false
        }
        logger.notice("graphics lane attached")
    }

    private func enqueue(_ frame: CapturedVideoFrame) {
        let shouldStart = encodeGate.withLock { state -> Bool in
            state.latest = frame
            if frame.forceKeyframe {
                state.forceKeyframe = true
            }
            if state.encoding { return false }
            state.encoding = true
            return true
        }
        guard shouldStart else { return }
        Task { [weak self] in
            await self?.drainEncodeQueue()
        }
    }

    private func drainEncodeQueue() async {
        while true {
            let step = encodeGate.withLock { state -> DrainStep in
                guard let frame = state.latest else {
                    state.encoding = false
                    return .idle
                }
                switch state.mediaState.reserveUpdateId(
                    nowNs: DispatchTime.now().uptimeNanoseconds
                ) {
                case .ready(let updateId):
                    state.latest = nil
                    let clientKeyframe = state.mediaState.takeClientKeyframeRequest()
                    let forceKeyframe = state.forceKeyframe || clientKeyframe
                    state.forceKeyframe = false
                    return .job(
                        EncodeJob(
                            frame: frame,
                            updateId: updateId,
                            forceKeyframe: forceKeyframe,
                            clientKeyframe: clientKeyframe
                        )
                    )
                case .retry(let afterNs, let reason):
                    state.encoding = false
                    return .retry(afterNs: afterNs, reason: reason)
                }
            }
            switch step {
            case .idle:
                return
            case .retry(let afterNs, _):
                scheduleDrainRetry(afterNs: afterNs)
                return
            case .job(let job):
                if job.clientKeyframe {
                    logger.notice("owned media transport accepted client keyframe request")
                }
                let videoFrame = videoFrameForEncode(job.frame)
                guard let envelope = await encoder.encode(
                    videoFrame,
                    updateId: job.updateId,
                    forceKeyframe: job.forceKeyframe,
                    requestedKeyframeReason: job.forceKeyframe
                        ? .clientRequest
                        : nil
                ) else {
                    continue
                }
                await send(envelope)
                // Eager-revert any crisp tile over a region that changed this frame, on the
                // video cadence, so a live update is never masked by a stale crisp tile while
                // it waits for the next time-gated crisp pass.
                processCrispDamage(job.frame)
                // Crisp runs on the native capture, never the downscaled video frame.
                processCrisp(job.frame)
            }
        }
    }

    // Downscale the native capture to the quality ladder's current resolutionScale
    // for the video encoder. At scale 1.0 (native rung) the frame passes through
    // untouched. A scale failure falls back to the native frame: a full-resolution
    // encode is always correct, just heavier, never a dropped frame.
    private func videoFrameForEncode(_ native: CapturedVideoFrame) -> CapturedVideoFrame {
        let scale = encodeGate.withLock { $0.mediaState.targetResolutionScale }
        guard scale < 0.999 else { return native }
        do {
            return try videoScaler.scaledFrame(native, scaleDown: 1.0 / scale)
        } catch {
            logger.error("video downscale failed scale=\(scale, privacy: .public) error=\(String(describing: error), privacy: .public)")
            return native
        }
    }

    // ADR-0034 eager revert: on the video cadence (not the time-gated crisp pass), clear any
    // crisp tile that overlaps this frame's OS damage, so the live video update is shown at
    // once instead of being masked by a stale crisp tile for up to a crisp interval. Cheap:
    // rect overlap only, no hashing, no payload. Runs only once a lane is attached and the
    // surface baseline (resetSurface) has been sent.
    private func processCrispDamage(_ frame: CapturedVideoFrame) {
        guard !frame.damageRects.isEmpty else { return }
        let nowMs = Int(frame.capturedAtUptimeNs / 1_000_000)
        crispGate.withLock { state in
            guard let lane = state.lane, state.surfaceInitialized else { return }
            let reverts = state.controller.reactToDamage(frame.damageRects, nowMs: nowMs)
            guard !reverts.isEmpty else { return }
            state.crispFrameId &+= 1
            lane.send(OwnedGraphicsFrameEnvelope(
                header: OwnedGraphicsFrameHeader(
                    surfaceGeneration: state.surfaceGeneration,
                    frameId: state.crispFrameId,
                    capturedAtUptimeNs: frame.capturedAtUptimeNs,
                    commandCount: reverts.count,
                    payloadLength: 0
                ),
                commands: reverts,
                payload: Data()
            ))
        }
    }

    // ADR-0034 crisp-repair: run the per-tile crisp policy on the full-resolution capture
    // (independent of the video's downscale) and push crisp tiles over the reliable lane.
    // Time-gated so the full-surface rehash does not load the CPU at video frame rate.
    // Runs (and logs) even before a lane attaches so the host can be verified alone.
    private func processCrisp(_ frame: CapturedVideoFrame) {
        let nowNs = frame.capturedAtUptimeNs
        let intervalNs = UInt64(Config.ownedMediaCrispMinIntervalMs) * 1_000_000
        let shouldRun = crispGate.withLock { state -> Bool in
            if nowNs &- state.lastCrispNs < intervalNs { return false }
            state.lastCrispNs = nowNs
            return true
        }
        guard shouldRun else { return }
        // Pace crisp against its per-second byte budget; skip this window if the budget for
        // the current second is spent. This bounds crisp's sustained link share so a large
        // settle trickles out instead of bursting. It is NOT a motion gate: which regions
        // crisp is decided per-tile by the controller (a moving region never settles, so it
        // never emits), and checking the budget before extractBGRA also avoids the
        // full-surface hash when nothing can be sent. Eager reverts (processCrispDamage)
        // carry no payload and are unaffected.
        let mayEmit = crispGate.withLock { state in
            state.pacing.mayEmit(nowNs: nowNs)
        }
        guard mayEmit else { return }
        guard let surface = Self.extractBGRA(frame.pixelBuffer) else {
            // The capture buffer could not be turned into BGRA (unsupported pixel format or
            // a failed conversion). Crisp cannot run this frame; the video floor still
            // covers the region. Log it throttled so this can never be a silent no-op (a
            // YUV-vs-BGRA mismatch is exactly what once made the whole pump inert).
            let format = CVPixelBufferGetPixelFormatType(frame.pixelBuffer)
            let warn = crispGate.withLock { state -> Bool in
                guard nowNs &- state.lastConvertWarnNs >= 5_000_000_000 else { return false }
                state.lastConvertWarnNs = nowNs
                return true
            }
            if warn {
                logger.error("crisp surface unavailable; not BGRA-convertible pixelFormat=\(format, privacy: .public)")
            }
            return
        }
        let nowMs = Int(nowNs / 1_000_000)
        crispGate.withLock { state in
            // Interim: the full-surface reconciliation pass, byte-for-byte today's
            // behavior. Wiring the damage-gated observe(changedRects:) here is a later
            // transport unit (Unit A split only the controller). healScan preserves the
            // exact pre-split semantics until then.
            let emission = state.controller.healScan(
                pixels: surface.data,
                width: surface.width,
                height: surface.height,
                bytesPerRow: surface.bytesPerRow,
                nowMs: nowMs
            )
            // A geometry change resets the controller's tile state and slot cache; the
            // client must be told before any tile for the new surface lands, so force a
            // fresh resetSurface this window (see RegionCrispEmission.surfaceDidReset).
            if emission.surfaceDidReset {
                state.surfaceInitialized = false
            }
            if !emission.isEmpty || emission.surfaceDidReset {
                let tiles = emission.commands.count
                let payloadBytes = emission.payload.count
                let dropped = state.controller.droppedCrispTileCount
                let throttled = state.controller.throttledCrispTileCount
                let laneAttached = state.lane != nil
                logger.notice("crisp window tiles=\(tiles, privacy: .public) payloadBytes=\(payloadBytes, privacy: .public) dropped=\(dropped, privacy: .public) throttled=\(throttled, privacy: .public) resized=\(emission.surfaceDidReset, privacy: .public) laneAttached=\(laneAttached, privacy: .public)")
            }
            guard let lane = state.lane else {
                // No lane to receive these assignments: discard the staged slot commits so
                // the host's cache does not get ahead of the client (it would later emit a
                // drawCachedTile for a slot the client never got). This is the pre-attach
                // window only; attachGraphicsLane calls reset() before any resume, so the
                // optimistic per-tile crispHash state is cleared too.
                state.controller.discardEmission()
                return
            }
            // Both lane.send calls below MUST stay within this single crispGate scope: the
            // resetSurface and the tile frame are enqueued on the lane in call order, and a
            // tile frame ahead of its resetSurface would composite against stale geometry.
            if !state.surfaceInitialized {
                // Bump the surface generation and reset the frame counter together with the
                // resetSurface emission so a reconnected or resized client cleanly discards
                // prior-generation slot state.
                state.surfaceGeneration &+= 1
                state.crispFrameId = 0
                state.crispFrameId &+= 1
                lane.send(OwnedGraphicsFrameEnvelope(
                    header: OwnedGraphicsFrameHeader(
                        surfaceGeneration: state.surfaceGeneration,
                        frameId: state.crispFrameId,
                        capturedAtUptimeNs: nowNs,
                        commandCount: 1,
                        payloadLength: 0
                    ),
                    commands: [.resetSurface(
                        surfaceGeneration: state.surfaceGeneration,
                        width: surface.width,
                        height: surface.height,
                        pixelFormat: .bgra
                    )],
                    payload: Data()
                ))
                state.surfaceInitialized = true
            }
            if !emission.isEmpty {
                state.crispFrameId &+= 1
                lane.send(OwnedGraphicsFrameEnvelope(
                    header: OwnedGraphicsFrameHeader(
                        surfaceGeneration: state.surfaceGeneration,
                        frameId: state.crispFrameId,
                        capturedAtUptimeNs: nowNs,
                        commandCount: emission.commands.count,
                        payloadLength: emission.payload.count
                    ),
                    commands: emission.commands,
                    payload: emission.payload
                ))
                // Charge the fresh crisp payload against this second's pacing budget so a
                // large settle keeps trickling out at the capped rate, not all at once.
                state.pacing.recordSent(payloadBytes: emission.payload.count)
            }
            // The emission was handed to the (reliable, ordered) lane: commit the staged
            // slot assignments so the host's cache matches what the client now holds.
            state.controller.commitEmission()
        }
    }

    // ADR-0034: the client lost graphics-stream sync (a gap or discontinuity it could not
    // repair) and asked for a fresh baseline. Drop the host's view of what the client holds
    // and force the next crisp window to re-send a resetSurface plus fresh tiles, so no
    // drawCachedTile references a slot the client has discarded. Mirrors the lane-attach
    // baseline reset, minus the lane swap (the same lane stays open).
    //
    // The same lane stays open, so any tile frames already queued on it (with the old
    // generation) deliver before the new resetSurface. On the reliable ordered stream the
    // client therefore observes: old-generation tiles, then resetSurface (new generation),
    // then fresh tiles. That is a coherent sequence because the client discards prior
    // surfaceGeneration state on resetSurface, so any old tile that rendered is overwritten.
    private func handleGraphicsResetRequest() {
        crispGate.withLock { state in
            state.controller.reset()
            state.surfaceInitialized = false
        }
        logger.notice("graphics reset requested by client")
    }

    // Reused across crisp windows; CIContext is thread-safe for rendering and the crisp tap
    // is the only caller. cacheIntermediates off keeps it from holding frame-sized buffers.
    private static let crispCIContext = CIContext(options: [.cacheIntermediates: false])

    // Produce a BGRA copy of the captured frame plus its geometry for the crisp emitter.
    // The capture is YUV 4:2:0 by default (the H.264 encoder's native format), but the
    // crisp toolchain (hash, LZFSE, wire, client compositor) is BGRA end to end, so a
    // non-BGRA buffer is converted here. Returns nil only for a degenerate or
    // unconvertible buffer; crisp simply does not run that frame.
    private static func extractBGRA(_ pixelBuffer: CVPixelBuffer) -> (data: Data, width: Int, height: Int, bytesPerRow: Int)? {
        if CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA {
            return copyContiguousBGRA(pixelBuffer)
        }
        return convertToBGRA(pixelBuffer)
    }

    // Lock and copy an already-BGRA buffer into contiguous Data, preserving its bytesPerRow
    // (which may carry row padding; OwnedTileCodec extracts sub-rects with that stride).
    private static func copyContiguousBGRA(_ pixelBuffer: CVPixelBuffer) -> (data: Data, width: Int, height: Int, bytesPerRow: Int)? {
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard width > 0, height > 0, bytesPerRow >= width * 4 else { return nil }
        return (Data(bytes: base, count: bytesPerRow * height), width, height, bytesPerRow)
    }

    // Convert a non-BGRA (YUV) capture buffer to BGRA via CoreImage. Rendering into a BGRA
    // CVPixelBuffer (rather than a raw bitmap) keeps the top-down row order of the source,
    // so a tile at (x, y) lines up with the same region of the video floor on the client.
    // YUV 4:2:0 keeps luma full-resolution, so text stays sharp; only fine chroma detail is
    // softened by the subsampling the capture already applied. Runs outside crispGate (per
    // the encode-pump call site), so the GPU round-trip does not extend the crisp lock.
    private static func convertToBGRA(_ pixelBuffer: CVPixelBuffer) -> (data: Data, width: Int, height: Int, bytesPerRow: Int)? {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0 else { return nil }
        let attrs: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
        ]
        var dest: CVPixelBuffer?
        guard CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
            attrs as CFDictionary, &dest
        ) == kCVReturnSuccess, let dest else { return nil }
        crispCIContext.render(CIImage(cvPixelBuffer: pixelBuffer), to: dest)
        return copyContiguousBGRA(dest)
    }

    private func scheduleDrainRetry(afterNs: UInt64) {
        let shouldSchedule = encodeGate.withLock { state -> Bool in
            guard state.latest != nil, !state.retryScheduled else { return false }
            state.retryScheduled = true
            return true
        }
        guard shouldSchedule else { return }
        Task { [weak self] in
            if afterNs > 0 {
                try? await Task.sleep(nanoseconds: afterNs)
            }
            guard let self else { return }
            self.encodeGate.withLock { state in
                state.retryScheduled = false
            }
            self.startDrainIfNeeded()
        }
    }

    private func send(_ envelope: OwnedMediaFrameEnvelope) async {
        let payload: Data
        do {
            payload = try envelope.encode()
        } catch {
            logger.error("frame envelope encode failed: \(String(describing: error), privacy: .public)")
            return
        }
        let packets: [Data]
        do {
            packets = try MediaDatagramFramePacket.packetize(
                frameId: envelope.header.frameId,
                isKeyframe: envelope.header.isKeyframe,
                sentAtUptimeNs: DispatchTime.now().uptimeNanoseconds,
                payload: payload,
                key: mediaKey
            )
        } catch {
            logger.error("packetize failed: \(String(describing: error), privacy: .public)")
            return
        }
        let sentAtUptimeNs = DispatchTime.now().uptimeNanoseconds
        encodeGate.withLock { state in
            state.mediaState.noteSent(
                frameId: envelope.header.frameId,
                encodedBytes: payload.count,
                packets: packets,
                isKeyframe: envelope.header.isKeyframe,
                sentAtUptimeNs: sentAtUptimeNs
            )
        }
        let sent = await enqueuePackets(packets).value
        guard sent else { return }
        let liveTargets = encodeGate.withLock { state in
            let summary = state.productionDiagnostics.noteSent(
                bytes: payload.count,
                isKeyframe: envelope.header.isKeyframe,
                targetKbps: state.mediaState.targetKbps,
                targetFps: state.mediaState.targetFps,
                resolutionScale: state.mediaState.targetResolutionScale,
                nowNs: sentAtUptimeNs
            )
            if let summary {
                state.latestProductionSummary = summary
            }
            return (
                kbps: state.mediaState.targetKbps,
                fps: state.mediaState.targetFps,
                scale: state.mediaState.targetResolutionScale,
                productionSummary: summary
            )
        }
        if envelope.header.isKeyframe || envelope.header.frameId.isMultiple(of: 30) {
            logger.notice("owned media video sent frame=\(envelope.header.frameId, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) bytes=\(payload.count, privacy: .public) packets=\(packets.count, privacy: .public) bitrateKbps=\(liveTargets.kbps, privacy: .public) fps=\(liveTargets.fps, privacy: .public) resolutionScale=\(liveTargets.scale, privacy: .public)")
        }
        if let summary = liveTargets.productionSummary {
            logger.notice(
                "owned media production summary actualFps=\(summary.actualFps, privacy: .public) targetFps=\(summary.targetFps, privacy: .public) fpsDeficit=\(summary.fpsDeficit, privacy: .public) frames=\(summary.frames, privacy: .public) keyframes=\(summary.keyframes, privacy: .public) sentKbps=\(summary.sentKbps, privacy: .public) targetKbps=\(summary.targetKbps, privacy: .public) maxGapMs=\(summary.maxGapMs, privacy: .public) resolutionScale=\(summary.resolutionScale, privacy: .public) windowMs=\(summary.windowMs, privacy: .public)"
            )
        }
    }

    private func enqueuePackets(_ packets: [Data]) -> Task<Bool, Never> {
        sendQueueGate.withLock { state -> Task<Bool, Never> in
            let prior = state.tail
            let task = Task { [weak self] in
                _ = await prior?.value
                guard let self else { return false }
                return await self.sendPacketsSerial(packets)
            }
            state.tail = task
            return task
        }
    }

    private func sendPacketsSerial(_ packets: [Data]) async -> Bool {
        let bursts = pacer.bursts(packetCount: packets.count)
        for (burstIndex, range) in bursts.enumerated() {
            if burstIndex > 0, pacer.pauseNanos > 0 {
                try? await Task.sleep(nanoseconds: pacer.pauseNanos)
            }
            for packet in packets[range] {
                guard await sendPacket(packet) else { return false }
            }
        }
        return true
    }

    private func sendPacket(_ packet: Data) async -> Bool {
        do {
            try await datagrams.send(packet)
            return true
        } catch {
            logger.error("video datagram send failed: \(String(describing: error), privacy: .public)")
            stateContinuation.yield(.failed)
            return false
        }
    }

    private func startDrainIfNeeded() {
        let shouldStart = encodeGate.withLock { state -> Bool in
            guard state.latest != nil, !state.encoding else { return false }
            state.encoding = true
            return true
        }
        guard shouldStart else { return }
        Task { [weak self] in
            await self?.drainEncodeQueue()
        }
    }

    private func sendResendPackets(_ packets: [Data]) {
        _ = enqueuePackets(packets)
    }

    private func handleFrameAck(_ frameId: UInt64) {
        encodeGate.withLock { state in
            _ = state.mediaState.noteAck(frameId: frameId)
        }
        startDrainIfNeeded()
    }

    private func handleLinkHealth(_ message: OwnedMediaControlMessage) {
        let completed = message.linkHealthCompletedFrames ?? 0
        let expired = message.linkHealthExpiredFrames ?? 0
        let decision = encodeGate.withLock { state in
            let productionSummary = state.latestProductionSummary
            state.latestProductionSummary = nil
            return state.mediaState.observeLinkHealth(
                completedFrames: completed,
                expiredFrames: expired,
                productionSummary: productionSummary
            )
        }
        logQualityDecision(decision)
        applyQualityDecision(decision, completed: completed, expired: expired)
    }

    private func applyQualityDecision(
        _ decision: MediaQualityDecision,
        completed: Int,
        expired: Int
    ) {
        let outcome = decision.outcome
        guard outcome.changed else { return }
        if outcome.bitrateChanged {
            encoder.updateBitrate(outcome.target.bitrateKbps)
            logger.notice("owned media video bitrate-step windowId=\(decision.observation.windowId, privacy: .public) target=\(outcome.target.bitrateKbps, privacy: .public)kbps rung=\(outcome.target.rung.rawValue, privacy: .public) reason=\(outcome.reason, privacy: .public) completed=\(completed, privacy: .public) expired=\(expired, privacy: .public)")
        }
        if outcome.resolutionChanged {
            // The downscale now happens in the encode pump (videoFrameForEncode), not
            // by restarting capture, so capture stays native and crisp keeps full
            // pixels. The encoder recreates its session when the scaled dims change;
            // force a keyframe so the client decoder transitions cleanly.
            encodeGate.withLock { state in
                state.forceKeyframe = true
                state.mediaState.resetForQualityChange()
            }
            logger.notice("owned media video resolution-step windowId=\(decision.observation.windowId, privacy: .public) scale=\(outcome.target.resolutionScale, privacy: .public) bitrate=\(outcome.target.bitrateKbps, privacy: .public)kbps fps=\(outcome.target.fps, privacy: .public) rung=\(outcome.target.rung.rawValue, privacy: .public) reason=\(outcome.reason, privacy: .public) downscale=encode-pump")
        }
        if outcome.fpsChanged {
            encoder.updateExpectedFrameRate(outcome.target.fps)
            logger.notice("owned media video fps-step windowId=\(decision.observation.windowId, privacy: .public) target=\(outcome.target.fps, privacy: .public)fps bitrate=\(outcome.target.bitrateKbps, privacy: .public)kbps rung=\(outcome.target.rung.rawValue, privacy: .public) reason=\(outcome.reason, privacy: .public) completed=\(completed, privacy: .public) expired=\(expired, privacy: .public)")
        }
        logger.notice("mediaQualityTargetApplied windowId=\(decision.observation.windowId, privacy: .public) rung=\(outcome.target.rung.rawValue, privacy: .public) bitrateKbps=\(outcome.target.bitrateKbps, privacy: .public) fps=\(outcome.target.fps, privacy: .public) resolutionScale=\(outcome.target.resolutionScale, privacy: .public) bitrateApplied=\(outcome.bitrateChanged, privacy: .public) fpsApplied=\(outcome.fpsChanged, privacy: .public) resolutionApplied=\(outcome.resolutionChanged, privacy: .public) forcedKeyframe=\(outcome.resolutionChanged, privacy: .public) reason=\(outcome.reason, privacy: .public)")
        startDrainIfNeeded()
    }

    private func logQualityDecision(_ decision: MediaQualityDecision) {
        let observation = decision.observation
        let sample = observation.sample
        let production = observation.productionSummary
        let recovery = observation.recoveryStatus
        logger.notice(
            "mediaQualityWindow windowId=\(observation.windowId, privacy: .public) currentRung=\(observation.previousTarget.rung.rawValue, privacy: .public) currentBitrateKbps=\(observation.previousTarget.bitrateKbps, privacy: .public) currentFps=\(observation.previousTarget.fps, privacy: .public) currentResolutionScale=\(observation.previousTarget.resolutionScale, privacy: .public) actualFps=\(production?.actualFps ?? -1, privacy: .public) fpsDeficit=\(production?.fpsDeficit ?? -1, privacy: .public) sentKbps=\(production?.sentKbps ?? -1, privacy: .public) frames=\(production?.frames ?? -1, privacy: .public) keyframes=\(production?.keyframes ?? -1, privacy: .public) maxSendGapMs=\(production?.maxGapMs ?? -1, privacy: .public) productionWindowMs=\(production?.windowMs ?? -1, privacy: .public) ackCount=\(observation.ackCount, privacy: .public) ackAgeP50Ms=\(self.formatMs(sample.ackAgeP50Ms), privacy: .public) ackAgeP95Ms=\(self.formatMs(sample.ackAgeP95Ms), privacy: .public) ackAgeMaxMs=\(self.formatMs(observation.ackAgeMaxMs), privacy: .public) inFlightFrames=\(observation.inFlightFrames, privacy: .public) inFlightBytes=\(observation.inFlightBytes, privacy: .public) oldestInflightMs=\(self.formatMs(observation.oldestInflightMs), privacy: .public) staleRecoveryCount=\(observation.staleRecoveryCount, privacy: .public) completedFrames=\(sample.completedFrames, privacy: .public) expiredFrames=\(sample.expiredFrames, privacy: .public) resendRequests=\(sample.resendRequests, privacy: .public) keyframeRequests=\(sample.keyframeRequests, privacy: .public) lossPermille=\(observation.signals.lossPermille, privacy: .public) recoveryCleanMs=\(recovery.cleanMs, privacy: .public) requiredRecoveryMs=\(recovery.requiredMs, privacy: .public) recoveryBlocker=\(recovery.blocker, privacy: .public) recoveryPhase=\(recovery.phase.rawValue, privacy: .public) recoveryProbeAxis=\(recovery.probeAxis.rawValue, privacy: .public) recoveryWarmupWindows=\(recovery.warmupWindowsRemaining, privacy: .public) recoveryProbeWindows=\(recovery.probeWindowsRemaining, privacy: .public) stableRung=\(recovery.stableTarget.rung.rawValue, privacy: .public) stableBitrateKbps=\(recovery.stableTarget.bitrateKbps, privacy: .public) stableFps=\(recovery.stableTarget.fps, privacy: .public) stableResolutionScale=\(recovery.stableTarget.resolutionScale, privacy: .public)"
        )
        logger.notice(
            "mediaQualityDecision windowId=\(observation.windowId, privacy: .public) previousRung=\(decision.outcome.previousTarget.rung.rawValue, privacy: .public) previousBitrateKbps=\(decision.outcome.previousTarget.bitrateKbps, privacy: .public) previousFps=\(decision.outcome.previousTarget.fps, privacy: .public) previousResolutionScale=\(decision.outcome.previousTarget.resolutionScale, privacy: .public) nextRung=\(decision.outcome.target.rung.rawValue, privacy: .public) nextBitrateKbps=\(decision.outcome.target.bitrateKbps, privacy: .public) nextFps=\(decision.outcome.target.fps, privacy: .public) nextResolutionScale=\(decision.outcome.target.resolutionScale, privacy: .public) reason=\(decision.outcome.reason, privacy: .public) changedAxes=\(decision.changedAxes, privacy: .public) lossPressure=\(observation.signals.lossPressure, privacy: .public) repairPressure=\(observation.signals.repairPressure, privacy: .public) queuePressure=\(observation.signals.queuePressure, privacy: .public) cadencePressure=\(observation.signals.cadencePressure, privacy: .public) stalePressure=\(observation.signals.stalePressure, privacy: .public) freezePressure=\(observation.signals.freezePressure, privacy: .public) expiredFrames=\(sample.expiredFrames, privacy: .public) lossPermille=\(observation.signals.lossPermille, privacy: .public) ackAgeP95Ms=\(self.formatMs(sample.ackAgeP95Ms), privacy: .public) fpsDeficit=\(production?.fpsDeficit ?? -1, privacy: .public) maxSendGapMs=\(production?.maxGapMs ?? -1, privacy: .public) staleRecoveryCount=\(observation.staleRecoveryCount, privacy: .public) recoveryCleanMs=\(recovery.cleanMs, privacy: .public) requiredRecoveryMs=\(recovery.requiredMs, privacy: .public) recoveryBlocker=\(recovery.blocker, privacy: .public) recoveryPhase=\(recovery.phase.rawValue, privacy: .public) recoveryProbeAxis=\(recovery.probeAxis.rawValue, privacy: .public) recoveryWarmupWindows=\(recovery.warmupWindowsRemaining, privacy: .public) recoveryProbeWindows=\(recovery.probeWindowsRemaining, privacy: .public) stableRung=\(recovery.stableTarget.rung.rawValue, privacy: .public) stableBitrateKbps=\(recovery.stableTarget.bitrateKbps, privacy: .public) stableFps=\(recovery.stableTarget.fps, privacy: .public) stableResolutionScale=\(recovery.stableTarget.resolutionScale, privacy: .public)"
        )
    }

    private func formatMs(_ value: Double?) -> String {
        guard let value else { return "nil" }
        return String(format: "%.1f", value)
    }

    private struct EncodeJob {
        let frame: CapturedVideoFrame
        let updateId: OwnedSurfaceUpdateId
        let forceKeyframe: Bool
        let clientKeyframe: Bool
    }

    private enum DrainStep {
        case idle
        case retry(afterNs: UInt64, reason: QuicSessionHostMediaState.RetryReason)
        case job(EncodeJob)
    }

    private func startControlReceiveLoop() {
        controlTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let message = try await datagrams.receive()
                    handleControlDatagram(message.content)
                } catch {
                    logger.notice("media control datagram receive ended: \(String(describing: error), privacy: .public)")
                    return
                }
            }
        }
    }

    private func handleControlDatagram(_ data: Data) {
        guard let message = try? JSONDecoder().decode(OwnedMediaControlMessage.self, from: data) else {
            return
        }
        switch message.kind {
        case .keyframeRequest:
            let admission = encodeGate.withLock { state in
                state.mediaState.noteKeyframeRequest()
            }
            switch admission {
            case .queued:
                logger.notice("owned media client keyframe request queued")
            case .suppressedInFlight(let frameId):
                logger.notice("owned media client keyframe request suppressed inFlightKeyframe=\(frameId, privacy: .public)")
            }
            startDrainIfNeeded()
        case .packetResendRequest:
            let packets = encodeGate.withLock { state in
                state.mediaState.noteResendRequest()
                return state.mediaState.packetsForResend(
                    frameId: message.frameId,
                    indexes: message.packetIndexes,
                    maxCount: Config.ownedMediaMaxResendPackets
                ).packets.map { $0.1 }
            }
            sendResendPackets(packets)
        case .frameAck:
            handleFrameAck(message.frameId)
        case .graphicsResetRequest:
            handleGraphicsResetRequest()
        case .keepalive:
            break
        case .linkHealth:
            handleLinkHealth(message)
        }
    }

    private struct EncodeState {
        var latest: CapturedVideoFrame?
        var encoding = false
        var retryScheduled = false
        var forceKeyframe = false
        var mediaState = QuicSessionHostMediaState()
        var productionDiagnostics = MediaProductionDiagnosticsTracker()
        var latestProductionSummary: MediaProductionSummary?
    }

    private struct MediaSendQueueState {
        var tail: Task<Bool, Never>?
    }
}
