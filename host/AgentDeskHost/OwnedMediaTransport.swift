import CoreImage
import CoreVideo
import CryptoKit
import Foundation
import Network
import os
import AgentDeskWire

@available(macOS 26.0, *)
final class QuicSessionHostMediaTransport: MediaTransport, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "owned-media")
    private let source: VideoFrameSource
    private let datagrams: QUIC.Datagrams<QUICDatagram>
    private let mediaKey: SymmetricKey
    private let onFirstFrameSent: @Sendable (UInt64) -> Void
    private let onFirstFrameAcknowledged: @Sendable (UInt64) -> Void
    /// Reported so the rung outlives this transport. The ladder itself must not: its
    /// backpressure and round-trip state describe one connection, but the rung it arrived at
    /// describes the LINK, which a four-second drop rarely changes.
    private let onQualityTargetChanged: @Sendable (MediaQualityTarget) -> Void
    // ADR-0090: injected, not owned, so it can outlive this transport.
    //
    // A reconnect builds a new transport. When the encoder was a stored property here that
    // meant a new encoder with no reference state, so the first frame after a handover was
    // always a full keyframe no matter what the client still held -- which made long-term
    // references useless for exactly the case they were introduced for.
    //
    // Per device, never shared: one client acknowledging a reference must not authorise the
    // host to encode a delta against it for a different client that never received it.
    private let encoder: VideoToolboxOwnedMediaEncoder
    // ADR-0033 + ADR-0034: capture always runs at native resolution. The quality
    // ladder's resolutionScale is applied here, downscaling the frame the video
    // encoder sees, while crisp taps the untouched native buffer so settled text
    // is restored at full resolution regardless of the video rung. One reusable
    // scaler (owns its own CIContext).
    private let videoScaler = OwnedMediaFrameScaler()
    // ADR-0098: the wire's rate governor. Built in `init` rather than lazily because it is
    // touched from the encode drain and from the control-message path, and a lazy var's
    // initialisation is not atomic; the closure captures the carrier directly so it needs no
    // reference to a half-built self.
    private let sendScheduler: OwnedMediaSendScheduler
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    let connectionState: AsyncStream<MediaConnectionState>
    private let encodeGate = OSAllocatedUnfairLock<EncodeState>(initialState: EncodeState())
    private var controlTask: Task<Void, Never>?
    // ADR-0087: uptime of the last client link-health report, and the timer that notices
    // when one stops arriving. Its own lock, not encodeGate: the receive path stamps it on
    // every report and must not contend with the encode drain for that.
    private let lastLinkHealthGate = OSAllocatedUnfairLock<UInt64?>(initialState: nil)
    private var linkHealthTickTask: Task<Void, Never>?
    // ADR-0088: the host's own view of its path, so a client-reported change can be checked
    // against whether the Mac saw anything move at the same moment.
    //
    // A plain `let`, not `lazy var`: it is read from `logLinkTelemetry` on whichever thread
    // delivered the client's control message, and lazy initialisation is not atomic. It
    // builds its own Logger rather than capturing this type's, so the initialiser needs no
    // reference to self.
    private let pathObserver = LinkPathObserver { snapshot in
        Logger(subsystem: Config.logSubsystem, category: "owned-media")
            .notice("owned media host path changed \(snapshot.logDescription, privacy: .public)")
    }
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
        // ADR-0036: crisp windows since the last full-surface heal. Advances on every
        // window that clears the interval gate (including gated windows that early-out),
        // so the periodic heal that reconciles trusted crisp tiles against OS damage
        // under-reporting fires on schedule regardless of how many gated windows ran.
        var crispWindowsSinceHeal: Int = 0
        // Caps crisp's sustained link share at the per-second byte budget (see
        // CrispPacingGate) so a large settle cannot flood the QUIC link it shares with the
        // video datagrams. Which regions crisp is decided per-tile by the controller.
        var pacing = CrispPacingGate(maxBytesPerSecond: Config.ownedMediaCrispMaxBytesPerSecond)
    }
    private let crispGate = OSAllocatedUnfairLock<CrispState>(initialState: CrispState())

    // ADR-0036: the persistent FAST (malloc, CPU-cached) BGRA buffer the crisp controller
    // hashes from. Reused across crisp windows, reallocated only when the source geometry
    // changes. Each window renders only the region it needs into this buffer (the whole
    // frame on a heal, just the grid-aligned damage bbox on a gated window), so both the
    // GPU->CPU readback AND the controller's per-tile hash reads are damage-proportional and
    // hit cached memory — unlike hashing straight from a CIContext IOSurface (GPU memory,
    // slow per-byte), which Unit C did. Guarded by its own lock (never nested under
    // crispGate; only processCrisp and deinit touch it) because the class is @unchecked
    // Sendable and this is mutated across the drain loop's frames. `base` is owned here and
    // freed on realloc and in deinit.
    private struct CrispBufferState {
        var base: UnsafeMutableRawPointer?
        var byteCount = 0
        var width = 0
        var height = 0
        var bytesPerRow = 0
    }
    // uncheckedState: CrispBufferState holds a raw pointer (not Sendable); the lock is the
    // synchronization, and only the single serialized drain loop (plus deinit) touches it.
    private let crispBufferGate = OSAllocatedUnfairLock<CrispBufferState>(
        uncheckedState: CrispBufferState()
    )

    // ADR-0006 client-config: the client's crisp-overlay preference for this session.
    // Defaults true (crisp on until the client says otherwise, matching the client default).
    // Composed with Config.ownedMediaCrispEnabled as an AND at the drain-loop gate, and read
    // live each frame so a settings toggle takes effect on the next frame with no restart.
    private let clientCrispEnabledGate = OSAllocatedUnfairLock<Bool>(initialState: true)

    // ADR-0036: which reconciliation a crisp window runs. `heal` is the periodic
    // full-surface pass (also forced before the first baseline); `gated` visits only the
    // damage rects plus tiles due for promotion. A window with neither (no work) never
    // reaches here: it early-outs before the BGRA convert.
    private enum CrispWindowMode { case heal, gated }

    init(
        source: VideoFrameSource,
        datagrams: QUIC.Datagrams<QUICDatagram>,
        mediaKey: SymmetricKey,
        encoder: VideoToolboxOwnedMediaEncoder,
        resumeQualityTarget: MediaQualityTarget? = nil,
        onFirstFrameSent: @escaping @Sendable (UInt64) -> Void = { _ in },
        onFirstFrameAcknowledged: @escaping @Sendable (UInt64) -> Void = { _ in },
        onQualityTargetChanged: @escaping @Sendable (MediaQualityTarget) -> Void = { _ in }
    ) {
        self.encoder = encoder
        self.source = source
        self.datagrams = datagrams
        self.mediaKey = mediaKey
        self.onFirstFrameSent = onFirstFrameSent
        self.onFirstFrameAcknowledged = onFirstFrameAcknowledged
        self.onQualityTargetChanged = onQualityTargetChanged
        var stateCont: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { stateCont = $0 }
        stateContinuation = stateCont
        // ADR-0098: the wire opens at the rung this connection will actually encode at, so a
        // resumed connection's first frame is paced for the link it is resuming onto rather
        // than for the ceiling it is not using. Builds its own Logger, as `pathObserver` does,
        // because a class initialiser cannot hand `self` to a closure it is still building.
        let sendLogger = Logger(subsystem: Config.logSubsystem, category: "owned-media")
        // An immutable binding of the continuation: the `var` above cannot cross into the
        // concurrent closure, and reading the stored property would need a `self` that does not
        // exist until this assignment completes.
        let sendFailure = stateCont!
        sendScheduler = OwnedMediaSendScheduler(
            pacer: LinkSendPacer(
                bytesPerSecond: LinkSendPacer.bytesPerSecond(
                    forKbps: resumeQualityTarget?.bitrateKbps ?? Config.ownedMediaBitrateKbps,
                    headroom: Config.ownedMediaDataRateLimitRatio
                ),
                burstBytes: Double(Config.ownedMediaSendPacerBurstBytes)
            )
        ) { [datagrams] packet in
            do {
                try await datagrams.send(packet)
                return true
            } catch {
                sendLogger.error("video datagram send failed: \(String(describing: error), privacy: .public)")
                sendFailure.yield(.failed)
                return false
            }
        }
        if let resumeQualityTarget {
            encodeGate.withLock { $0.mediaState.resumeQualityTarget(resumeQualityTarget) }
            // The reused encoder already holds these values, since it is the same object that
            // was encoding at this rung before the drop. Pushing them anyway keeps the ladder
            // and the encoder in agreement by construction rather than by coincidence: a fresh
            // encoder paired with a carried target would otherwise silently disagree.
            encoder.updateBitrate(resumeQualityTarget.bitrateKbps)
            encoder.updateExpectedFrameRate(resumeQualityTarget.fps)
            // The pacer was already opened at this rung above, so there is nothing to retarget
            // here -- and `applyBitrate` is unavailable to an initialiser anyway.
            logger.notice("owned media quality resumed rung=\(resumeQualityTarget.rung.rawValue, privacy: .public) bitrateKbps=\(resumeQualityTarget.bitrateKbps, privacy: .public) fps=\(resumeQualityTarget.fps, privacy: .public) resolutionScale=\(resumeQualityTarget.resolutionScale, privacy: .public)")
        }
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        stateContinuation.yield(.connected)
        try await source.start { [weak self] frame in
            self?.enqueue(frame)
        }
        startControlReceiveLoop()
        startLinkHealthTickLoop()
    }

    private func startLinkHealthTickLoop() {
        pathObserver.start(queue: DispatchQueue(label: "\(Config.dispatchQueuePrefix).link-telemetry"))
        let intervalNs = UInt64(Config.ownedMediaLinkHealthTickMs) * 1_000_000
        linkHealthTickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: intervalNs)
                guard !Task.isCancelled, let self else { return }
                self.tickLinkHealthIfClientSilent()
            }
        }
    }

    func setClientCrispEnabled(_ enabled: Bool) {
        clientCrispEnabledGate.withLock { $0 = enabled }
    }

    /// The client covered the video with a full-screen surface, or uncovered it.
    ///
    /// Gated here, at this client's encode queue, rather than by stopping the
    /// capture source: the source is shared by every session, so stopping it
    /// would blind any other connected viewer, and restarting it would cost a
    /// capture warm-up on the way back. Dropping frames before the encoder still
    /// saves the encode and the whole downlink, which is what a slow link is
    /// short of.
    ///
    /// Coming back forces a keyframe. The client's decoder has been starved for
    /// however long the surface was open, so waiting for the next natural IDR
    /// would leave it black well past the moment the user asked for video.
    func setWatchingVideo(_ watching: Bool) {
        let resumed = encodeGate.withLock { state -> Bool in
            guard state.isWatchingVideo != watching else { return false }
            state.isWatchingVideo = watching
            guard watching else {
                // Anything captured while away is stale by definition.
                state.latest = nil
                return false
            }
            state.forceKeyframeReason = .resumeWatching
            return true
        }
        logger.notice("client watching video=\(watching, privacy: .public)")
        guard resumed else { return }
        startDrainIfNeeded()
    }

    func setClientMediaQuality(_ config: ClientMediaQualityConfig) {
        let outcome = encodeGate.withLock { state -> MediaQualityOutcome? in
            guard let outcome = state.mediaState.applyClientMediaQuality(config) else {
                return nil
            }
            if outcome.resolutionChanged {
                state.forceKeyframeReason = .resolutionChange
            }
            return outcome
        }
        guard let outcome else { return }
        if outcome.bitrateChanged {
            applyBitrate(outcome.target.bitrateKbps)
        }
        if outcome.fpsChanged {
            encoder.updateExpectedFrameRate(outcome.target.fps)
        }
        logger.notice("client media quality setting applied adaptive=\(config.adaptiveEnabled, privacy: .public) fixed=\((config.fixedTarget != nil), privacy: .public) bitrateKbps=\(outcome.target.bitrateKbps, privacy: .public) fps=\(outcome.target.fps, privacy: .public) resolutionScale=\(outcome.target.resolutionScale, privacy: .public) changedAxes=\(Self.changedAxes(for: outcome), privacy: .public) reason=\(outcome.reason, privacy: .public)")
        startDrainIfNeeded()
    }

    func stop() {
        controlTask?.cancel()
        controlTask = nil
        linkHealthTickTask?.cancel()
        linkHealthTickTask = nil
        pathObserver.stop()
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
            // Dropped before the encoder, so a covered video costs nothing.
            guard state.isWatchingVideo else { return false }
            if state.latest != nil {
                state.mediaState.noteCaptureReplaced()
            }
            state.latest = frame
            if frame.forceKeyframe {
                state.forceKeyframeReason = .captureRequested
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
                case .ready(let updateId, let abandoned):
                    state.latest = nil
                    let clientKeyframe = state.mediaState.takeClientKeyframeRequest()
                    // A client asking outranks our own cause when both are pending: it is
                    // the more actionable signal, and ours will be re-satisfied by the same
                    // keyframe anyway.
                    let forceKeyframeReason = clientKeyframe ? .clientRequest : state.forceKeyframeReason
                    state.forceKeyframeReason = nil
                    return .job(
                        EncodeJob(
                            frame: frame,
                            updateId: updateId,
                            forceKeyframeReason: forceKeyframeReason,
                            clientKeyframe: clientKeyframe,
                            abandoned: abandoned
                        )
                    )
                case .retry(let afterNs, let reason):
                    state.encoding = false
                    // Counted inside the same lock that made the decision, so the tally cannot
                    // drift from the refusals it is counting.
                    state.capacityDeferrals += 1
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
                if !job.abandoned.isEmpty {
                    let abandonedBytes = job.abandoned.reduce(0) { $0 + $1.bytes }
                    logger.notice(
                        "owned media abandoned obsolete in-flight video frames=\(job.abandoned.count, privacy: .public) bytes=\(abandonedBytes, privacy: .public) oldestFrameId=\(job.abandoned[0].id, privacy: .public) newestFrameId=\(job.abandoned[job.abandoned.count - 1].id, privacy: .public)"
                    )
                }
                if job.clientKeyframe {
                    logger.notice("owned media transport accepted client keyframe request")
                }
                let videoFrame = videoFrameForEncode(job.frame)
                guard let envelope = await encoder.encode(
                    videoFrame,
                    updateId: job.updateId,
                    forceKeyframe: job.forceKeyframeReason != nil,
                    requestedKeyframeReason: job.forceKeyframeReason
                ) else {
                    continue
                }
                await send(envelope)
                // The crisp text layer is a coarse-gated add-on to the video floor; when
                // disabled the video stream above is fully functional on its own. Skipping
                // both calls here means no eager-revert, no convert, no hash, no crisp lane
                // sends -- the clean video-only path (and the isolation gate for crisp CPU).
                // Gate = host env (hard kill switch) AND the client's per-session preference.
                let clientCrispEnabled = clientCrispEnabledGate.withLock { $0 }
                if Config.ownedMediaCrispEnabled, clientCrispEnabled {
                    // Eager-revert any crisp tile over a region that changed this frame, on the
                    // video cadence, so a live update is never masked by a stale crisp tile while
                    // it waits for the next time-gated crisp pass.
                    processCrispDamage(job.frame)
                    // Crisp runs on the native capture, never the downscaled video frame.
                    processCrisp(job.frame)
                }
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
            // A new crisp window started: advance the heal counter here, before the pacing
            // gate, so it counts every interval-clearing window. Incrementing after the
            // pacing gate would freeze it during a pacing-saturated settle (the byte budget
            // spent across consecutive windows) and defer the heal indefinitely.
            state.crispWindowsSinceHeal += 1
            return true
        }
        guard shouldRun else { return }
        // Pace crisp against its per-second byte budget; skip this window if the budget for
        // the current second is spent. This bounds crisp's sustained link share so a large
        // settle trickles out instead of bursting. It is NOT a motion gate: which regions
        // crisp is decided per-tile by the controller (a moving region never settles, so it
        // never emits), and checking the budget before the BGRA render also avoids the GPU
        // convert and hash when nothing can be sent. Eager reverts (processCrispDamage)
        // carry no payload and are unaffected.
        let mayEmit = crispGate.withLock { state in
            state.pacing.mayEmit(nowNs: nowNs)
        }
        guard mayEmit else { return }
        let nowMs = Int(nowNs / 1_000_000)
        // ADR-0036: decide this window's mode and possibly early-out before the expensive
        // YUV->BGRA convert and full-surface hash. The heal counter was already advanced in
        // the interval-gate lock above (it counts every interval-clearing window); here we
        // only read it.
        //
        // A full heal is due when the surface has no baseline yet, gating is disabled
        // (healInterval == 0), or the counter has reached the interval. Otherwise this is a
        // damage-gated window: if it has no damage AND no settled tile due for promotion,
        // there is nothing to do, so skip the convert and hash entirely.
        //
        // Staleness bound: the counter advances per interval-window, but the heal RUN (like
        // all crisp emission) is still behind the per-second pacing gate above, so a
        // pacing-saturated stretch defers the heal until the byte budget rolls over (~1s).
        // During that stretch, changed crisp tiles are still reverted via processCrispDamage
        // on any non-empty damage. So the worst-case staleness of an OS-under-reported change
        // to a crisp tile is roughly healInterval windows plus up to ~1s of pacing rollover,
        // and is self-bounded.
        let mode: CrispWindowMode? = crispGate.withLock { state in
            let healInterval = Config.ownedMediaCrispHealIntervalWindows
            let healDue = !state.surfaceInitialized
                || healInterval == 0
                || state.crispWindowsSinceHeal >= healInterval
            if healDue { return .heal }
            let hasWork = !frame.damageRects.isEmpty
                || state.controller.hasDueCandidates(nowMs: nowMs)
            return hasWork ? .gated : nil
        }
        // Gated window with no work: nothing was staged, so no commit/discard is needed and
        // the heal counter (already incremented) still fires the next heal on time.
        guard let mode else { return }
        let width = CVPixelBufferGetWidth(frame.pixelBuffer)
        let height = CVPixelBufferGetHeight(frame.pixelBuffer)
        guard width > 0, height > 0 else { return }
        let bytesPerRow = width * 4 // the persistent buffer is tightly packed BGRA

        // Ensure the persistent FAST buffer matches the source geometry; realloc only on a
        // size change. A realloc yields uninitialized memory, so this window must do a FULL
        // render regardless of mode, or a gated sub-region render would leave the rest of
        // the buffer garbage that the controller could hash for a due candidate.
        let ensured: (base: UnsafeMutableRawPointer, reallocated: Bool)? =
            crispBufferGate.withLockUnchecked { buf in
                if buf.base == nil || buf.width != width || buf.height != height {
                    if let old = buf.base { old.deallocate() }
                    let count = bytesPerRow * height
                    let fresh = UnsafeMutableRawPointer.allocate(
                        byteCount: count, alignment: MemoryLayout<UInt8>.alignment
                    )
                    buf.base = fresh
                    buf.byteCount = count
                    buf.width = width
                    buf.height = height
                    buf.bytesPerRow = bytesPerRow
                    return (fresh, true)
                }
                return (buf.base!, false)
            }
        guard let ensured else { return }
        let base = ensured.base

        // The region to render this window: the whole frame on a heal (or a just-realloc'd
        // buffer), else only the grid-aligned union bbox of this frame's damage. An empty
        // damage bbox on a gated window renders nothing — the controller then reads STALE
        // buffer bytes for its due candidates, which is correct: a due candidate is stable
        // (unchanged since its settle timer started), so its last-rendered bytes still equal
        // its current pixels (the ADR-0036 bounded-staleness contract). Every tracked cell
        // was rendered at the last heal, so the buffer is always populated for it.
        let grid = Config.hybridTileGridPx
        let fullFrame = PixelRect(x: 0, y: 0, width: width, height: height)
        let region: PixelRect?
        switch mode {
        case .heal:
            region = fullFrame
        case .gated:
            region = ensured.reallocated
                ? fullFrame
                : OwnedMediaCrispConvert.gridAlignedDamageBounds(
                    frame.damageRects, grid: grid, width: width, height: height
                )
        }
        if let region, region.area > 0 {
            let ok = OwnedMediaCrispConvert.renderRegion(
                source: frame.pixelBuffer, into: base, destRowBytes: bytesPerRow,
                region: region, fullWidth: width, fullHeight: height, context: Self.crispCIContext
            )
            guard ok else {
                // The capture buffer could not be turned into BGRA (unsupported pixel format
                // or a failed render). Crisp cannot run this frame; the video floor still
                // covers the region. Log it throttled so this is never a silent no-op.
                let format = CVPixelBufferGetPixelFormatType(frame.pixelBuffer)
                let warn = crispGate.withLock { state -> Bool in
                    guard nowNs &- state.lastConvertWarnNs >= 5_000_000_000 else { return false }
                    state.lastConvertWarnNs = nowNs
                    return true
                }
                if warn {
                    logger.error("crisp surface unavailable; not BGRA-renderable pixelFormat=\(format, privacy: .public)")
                }
                return
            }
        }

        // No-copy view of the persistent FAST buffer. deallocator .none: the memory is owned
        // by crispBufferState (freed on realloc / in deinit), not by Data. Fast to hash: it
        // is malloc/CPU-cached, not IOSurface/GPU memory. The controller copies each visited
        // tile into its own Data and never retains `pixels`, and the buffer is only rewritten
        // by the next processCrisp on the same serialized drain loop, so the alias is safe.
        let pixels = Data(
            bytesNoCopy: base,
            count: bytesPerRow * height,
            deallocator: .none
        )
        crispGate.withLock { state in
            // A heal window fully reconciles every tile and resets the counter; a gated
            // window visits only the damage rects plus tiles due for promotion. Between the
            // mode-decision lock and here only a lane attach/reset can intervene (a rare,
            // pre-existing window); running either pass on a just-reset controller is safe
            // because it re-baselines from the passed pixels.
            let emission: RegionCrispEmission
            switch mode {
            case .heal:
                emission = state.controller.healScan(
                    pixels: pixels,
                    width: width,
                    height: height,
                    bytesPerRow: bytesPerRow,
                    nowMs: nowMs
                )
                state.crispWindowsSinceHeal = 0
            case .gated:
                emission = state.controller.observe(
                    pixels: pixels,
                    width: width,
                    height: height,
                    bytesPerRow: bytesPerRow,
                    nowMs: nowMs,
                    changedRects: frame.damageRects
                )
            }
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
                        width: width,
                        height: height,
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

    deinit {
        // Free the persistent FAST crisp buffer. Safe outside the lock: deinit runs when the
        // last reference is gone, so no drain-loop window can be concurrently touching it.
        crispBufferGate.withLockUnchecked { buf in
            buf.base?.deallocate()
            buf.base = nil
        }
    }

    // Reused across crisp windows; CIContext is thread-safe for rendering and the crisp tap
    // is the only caller. cacheIntermediates off keeps it from holding frame-sized buffers.
    private static let crispCIContext = CIContext(options: [.cacheIntermediates: false])

    // The region-render helpers (gridAlignedDamageBounds, renderRegion) live in
    // OwnedMediaCrispConvert so they are unit-testable without the transport. See that file
    // and OwnedMediaCrispConvertTests (which pins the sub-region offset + y-flip).

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
                isLtrResync: envelope.header.ltrResync == true,
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
        let sent = await sendScheduler.sendLive(packets)
        guard sent else { return }
        let shouldRecordFirstSent = encodeGate.withLock { state in
            guard !state.recordedFirstFrameSent else { return false }
            state.recordedFirstFrameSent = true
            return true
        }
        if shouldRecordFirstSent {
            onFirstFrameSent(envelope.header.frameId)
        }
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
        if envelope.header.ltrResync == true {
            // Rare by construction -- one per answered resync request -- and the host half of
            // the new contract: the client should log accepting this same frame, so a resync
            // that leaves here and never resolves the client's gate is visible as a pair with
            // a missing half.
            logger.notice("owned media resync delta sent frame=\(envelope.header.frameId, privacy: .public) bytes=\(payload.count, privacy: .public) packets=\(packets.count, privacy: .public)")
        }
        if envelope.header.isKeyframe || envelope.header.frameId.isMultiple(of: 30) {
            // `frame` here is the WIRE id (the surface update counter), which restarts whenever
            // a reconnect builds a new transport. It is not the encoder's lifetime frame count
            // -- the encoder logs that as `encFrame`, and the two diverge by design now that an
            // encoder outlives the transports using it. Reading a `frame=1` here as a fresh
            // encoder produced a wrong diagnosis of a resume once; `ltr=` is included so a
            // frame's reference role is visible on the same line as its cost. `gen` is the
            // surface generation, logged so a host frame can be matched to what the client says
            // it rendered; note the client's VIDEO path ignores it (only the crisp/graphics path
            // reads it), so a mismatch here is a correlation aid, not a discard reason.
            logger.notice("owned media video sent frame=\(envelope.header.frameId, privacy: .public) gen=\(envelope.header.surfaceGeneration, privacy: .public) keyframe=\(envelope.header.isKeyframe, privacy: .public) refresh=\(envelope.header.refreshReason.rawValue, privacy: .public) ltr=\(envelope.header.ltrToken.map(String.init) ?? "none", privacy: .public) bytes=\(payload.count, privacy: .public) packets=\(packets.count, privacy: .public) bitrateKbps=\(liveTargets.kbps, privacy: .public) fps=\(liveTargets.fps, privacy: .public) resolutionScale=\(liveTargets.scale, privacy: .public)")
        }
        if let summary = liveTargets.productionSummary {
            // Read and cleared with the window it belongs to. `fpsDeficit` says cadence fell
            // short; this says whether the host was refused or had nothing to offer, which is
            // the difference between a link that cannot take frames and a screen that is not
            // changing -- indistinguishable in every other field on this line.
            let deferrals = encodeGate.withLock { state -> Int in
                let count = state.capacityDeferrals
                state.capacityDeferrals = 0
                return count
            }
            logger.notice(
                "owned media production summary actualFps=\(summary.actualFps, privacy: .public) targetFps=\(summary.targetFps, privacy: .public) fpsDeficit=\(summary.fpsDeficit, privacy: .public) frames=\(summary.frames, privacy: .public) keyframes=\(summary.keyframes, privacy: .public) sentKbps=\(summary.sentKbps, privacy: .public) targetKbps=\(summary.targetKbps, privacy: .public) maxGapMs=\(summary.maxGapMs, privacy: .public) capacityDeferrals=\(deferrals, privacy: .public) resolutionScale=\(summary.resolutionScale, privacy: .public) windowMs=\(summary.windowMs, privacy: .public)"
            )
        }
    }

    /// ADR-0098: the encoder's budget and the wire's budget are one decision, so they are made
    /// in one place.
    ///
    /// They were three call sites setting only the encoder, which is how the wire ended up with
    /// no budget at all: nothing named the omission, because there was nothing to omit from.
    /// Routing both through here means a future rung change cannot move one without the other.
    private func applyBitrate(_ kbps: Int) {
        encoder.updateBitrate(kbps)
        retargetSendPacer(kbps)
    }

    /// ADR-0098: re-derive the wire budget from the rung AND the link's measured capacity.
    ///
    /// Separate from `applyBitrate` because the two move on different clocks. The encoder's
    /// budget changes only when the ladder steps; the measurement changes continuously, and it is
    /// during the stretch where the ladder has NOT yet stepped that pacing to the rung alone
    /// leaves the original defect intact.
    private func retargetSendPacer(_ kbps: Int) {
        let delivered = encodeGate.withLock {
            $0.mediaState.deliveryEstimator.deliveredBytesPerSecond
        }
        let bytesPerSecond = LinkSendPacer.bytesPerSecond(
            forKbps: kbps,
            headroom: Config.ownedMediaDataRateLimitRatio,
            deliveredBytesPerSecond: delivered,
            floorKbps: Config.ownedMediaEmergencyBitrateKbps,
            deliveryHeadroom: Config.ownedMediaDeliveryPacerHeadroom
        )
        Task { [sendScheduler] in
            await sendScheduler.retarget(bytesPerSecond: bytesPerSecond)
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
        Task { [sendScheduler] in
            await sendScheduler.enqueueRepair(packets)
        }
    }

    private func handleFrameAck(_ frameId: UInt64) {
        let shouldRecordFirstAck = encodeGate.withLock { state in
            _ = state.mediaState.noteAck(frameId: frameId)
            guard !state.recordedFirstFrameAcknowledged else { return false }
            state.recordedFirstFrameAcknowledged = true
            return true
        }
        if shouldRecordFirstAck {
            onFirstFrameAcknowledged(frameId)
        }
        startDrainIfNeeded()
    }

    private func handleLinkHealth(_ message: OwnedMediaControlMessage) {
        let completed = message.linkHealthCompletedFrames ?? 0
        let expired = message.linkHealthExpiredFrames ?? 0
        lastLinkHealthGate.withLock { $0 = DispatchTime.now().uptimeNanoseconds }
        let decision = encodeGate.withLock { state in
            let productionSummary = state.latestProductionSummary
            state.latestProductionSummary = nil
            return state.mediaState.observeLinkHealth(
                completedFrames: completed,
                expiredFrames: expired,
                productionSummary: productionSummary,
                clientTelemetry: message.linkTelemetry
            )
        }
        logQualityDecision(decision)
        logLinkTelemetry(decision, clientTelemetry: message.linkTelemetry)
        applyQualityDecision(decision, completed: completed, expired: expired)
    }

    /// ADR-0088: one line carrying BOTH ends' view of the link for this window.
    ///
    /// Both sides are on the same line on purpose. The freeze signatures are differences
    /// between the ends -- host path satisfied while the client's is not, or the client's
    /// receive loop alive while nothing arrives -- and a reader correlating two log streams
    /// by timestamp during an incident will not spot those.
    private func logLinkTelemetry(
        _ decision: MediaQualityDecision,
        clientTelemetry: OwnedMediaLinkTelemetry?
    ) {
        let hostPath = pathObserver.reportSnapshot()
        let (roundTrip, delivered) = encodeGate.withLock {
            ($0.mediaState.roundTrip, $0.mediaState.deliveryEstimator.deliveredBytesPerSecond)
        }
        let inflation = roundTrip.inflationRatio.map { String(format: "%.1f", $0) } ?? "n/a"
        let smoothed = roundTrip.smoothedMs.map { String(format: "%.1f", $0) } ?? "n/a"
        let minimum = roundTrip.minimumMs.map { String(format: "%.1f", $0) } ?? "n/a"
        // Both, because their divergence is the diagnosis. `rttInflation` divides by the floor,
        // not the minimum, and a path where those two disagree is one where the luckiest packet
        // in the window was about to be mistaken for the path's resting level.
        let floor = roundTrip.floorMs.map { String(format: "%.1f", $0) } ?? "n/a"
        // ADR-0098: next to the rung it is being compared against, because the finding is the
        // gap between them. `n/a` is a distinct reading from a low one and means no backlogged
        // slice completed -- nothing was asked of the link, so nothing was learned about it.
        let deliveredKbps = delivered.map { String(Int(($0 * 8.0 / 1_000.0).rounded())) } ?? "n/a"
        logger.notice("owned media link telemetry windowId=\(decision.observation.windowId, privacy: .public) deliveredKbps=\(deliveredKbps, privacy: .public) rungKbps=\(decision.outcome.target.bitrateKbps, privacy: .public) rttSmoothedMs=\(smoothed, privacy: .public) rttMinMs=\(minimum, privacy: .public) rttFloorMs=\(floor, privacy: .public) rttInflation=\(inflation, privacy: .public) rttSamples=\(roundTrip.sampleCount, privacy: .public) host[\(hostPath.snapshot?.logDescription ?? "unknown", privacy: .public) pathChanges=\(hostPath.total, privacy: .public)] client[\(clientTelemetry?.logDescription ?? "absent", privacy: .public)]")
    }

    /// ADR-0087: flush the jammed in-flight accounting and, when the rate limit allows,
    /// push one keyframe so the client has something to resync from.
    ///
    /// The state's own `recoverFromStall` already performed the flush (it owns the
    /// backpressure); what is left here is the encoder-facing half.
    private func applyStallRecovery(_ decision: MediaQualityDecision) {
        guard let recovery = decision.stallRecovery else { return }
        logger.notice("owned media stall recovery windowId=\(decision.observation.windowId, privacy: .public) reason=\(recovery.reason, privacy: .public) flushedFrames=\(recovery.flushedFrames, privacy: .public) flushedBytes=\(recovery.flushedBytes, privacy: .public) forcedKeyframe=\(recovery.forcedKeyframe, privacy: .public) inFlightBeforeFlush=\(decision.observation.inFlightFrames, privacy: .public) oldestInflightMs=\(self.formatMs(decision.observation.oldestInflightMs), privacy: .public) ackCount=\(decision.observation.ackCount, privacy: .public)")
        guard recovery.forcedKeyframe else { return }
        // ADR-0090: a stall recovery is a resync, and resyncs are what long-term references
        // exist for. The client lost frames but usually still holds an acknowledged reference,
        // so the honest cost is the delta since that frame rather than a fresh 250KB keyframe.
        // Measured on one session, stall recovery forced 30 keyframes against 5 from explicit
        // client requests, so this is where most of the resync cost actually sits.
        //
        // The reason stays `.stallRecovery` regardless of which the encoder produces: it names
        // why we resynced, not what came out. Whether it ended up a delta or a keyframe is
        // already visible on the frame itself.
        encodeGate.withLock { state in
            state.forceKeyframeReason = .stallRecovery
        }
        startDrainIfNeeded()
    }

    /// ADR-0087: raise a quality window on the host's own clock when the client has gone
    /// quiet.
    ///
    /// `handleLinkHealth` is driven entirely by inbound client messages, so the one event
    /// the governor most needs to see — a client that stopped responding — is also the
    /// event that stops it being called. During a measured 12.79s freeze not one window
    /// was evaluated. The synthetic window carries no completed/expired counts because the
    /// client reported none; `clientReportMissing` is what keeps that from being read as a
    /// calm screen.
    private func tickLinkHealthIfClientSilent() {
        let nowNs = DispatchTime.now().uptimeNanoseconds
        let thresholdNs = UInt64(Config.ownedMediaLinkHealthTickMs) * 1_000_000
        let silent = lastLinkHealthGate.withLock { last -> Bool in
            // No report yet at all (session just opened) is not silence to act on: there
            // is nothing in flight to unjam and no baseline to measure against.
            guard let last else { return false }
            return nowNs &- last >= thresholdNs
        }
        guard silent else { return }
        let decision = encodeGate.withLock { state -> MediaQualityDecision? in
            guard state.isWatchingVideo else { return nil }
            // Consumes the same single production-summary slot the client-driven path
            // does, so a synthetic window can take a summary the next real report would
            // have carried. Acceptable because this only runs after the client has been
            // silent for a full tick, when there is no imminent real report to take it
            // from — and a stalled window is worth more with production evidence than the
            // report that is not arriving.
            let productionSummary = state.latestProductionSummary
            state.latestProductionSummary = nil
            return state.mediaState.observeLinkHealth(
                completedFrames: 0,
                expiredFrames: 0,
                productionSummary: productionSummary,
                clientReportMissing: true,
                nowNs: nowNs
            )
        }
        guard let decision else { return }
        logQualityDecision(decision)
        // ADR-0088: a host-raised window is the MOST important one to log telemetry for. The
        // client is silent, so its half reads `absent` -- and that absence next to a host path
        // that is still satisfied is itself the finding: the Mac's link is fine and the phone
        // has stopped speaking.
        logLinkTelemetry(decision, clientTelemetry: nil)
        applyQualityDecision(decision, completed: 0, expired: 0)
    }

    private func applyQualityDecision(
        _ decision: MediaQualityDecision,
        completed: Int,
        expired: Int
    ) {
        // ADR-0087: stall recovery is applied BEFORE the `outcome.changed` gate below,
        // because it is not a quality change. It used to reach the wire only as a side
        // effect of `outcome.resolutionChanged`, so a manually pinned stream — whose
        // outcome never changes, by construction — could never recover: 240 frames were
        // abandoned across 42s of freezing in one measured session with the flush and the
        // keyframe both unreachable.
        applyStallRecovery(decision)
        let outcome = decision.outcome
        // ADR-0098: every window, not only the ones that move the ladder. The measured capacity
        // is what the wire is paced to and it changes on its own schedule; gating this behind
        // `outcome.changed` would mean a link that halved while the rung held kept its old
        // budget, which is precisely the window the freeze lives in.
        //
        // A window that also moves the bitrate re-derives the same value through `applyBitrate`
        // below. That is left alone rather than special-cased: `applyBitrate` setting both the
        // encoder's budget and the wire's is the invariant that stopped them drifting, and it is
        // worth more than avoiding one idempotent call.
        retargetSendPacer(outcome.target.bitrateKbps)
        guard outcome.changed else { return }
        onQualityTargetChanged(outcome.target)
        if outcome.bitrateChanged {
            applyBitrate(outcome.target.bitrateKbps)
            logger.notice("owned media video bitrate-step windowId=\(decision.observation.windowId, privacy: .public) target=\(outcome.target.bitrateKbps, privacy: .public)kbps rung=\(outcome.target.rung.rawValue, privacy: .public) reason=\(outcome.reason, privacy: .public) completed=\(completed, privacy: .public) expired=\(expired, privacy: .public)")
        }
        if outcome.resolutionChanged {
            // The downscale now happens in the encode pump (videoFrameForEncode), not
            // by restarting capture, so capture stays native and crisp keeps full
            // pixels. The encoder recreates its session when the scaled dims change;
            // force a keyframe so the client decoder transitions cleanly.
            encodeGate.withLock { state in
                state.forceKeyframeReason = .resolutionChange
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
            "mediaQualityWindow windowId=\(observation.windowId, privacy: .public) currentRung=\(observation.previousTarget.rung.rawValue, privacy: .public) currentBitrateKbps=\(observation.previousTarget.bitrateKbps, privacy: .public) currentFps=\(observation.previousTarget.fps, privacy: .public) currentResolutionScale=\(observation.previousTarget.resolutionScale, privacy: .public) actualFps=\(production?.actualFps ?? -1, privacy: .public) fpsDeficit=\(production?.fpsDeficit ?? -1, privacy: .public) sentKbps=\(production?.sentKbps ?? -1, privacy: .public) frames=\(production?.frames ?? -1, privacy: .public) keyframes=\(production?.keyframes ?? -1, privacy: .public) maxSendGapMs=\(production?.maxGapMs ?? -1, privacy: .public) productionWindowMs=\(production?.windowMs ?? -1, privacy: .public) ackCount=\(observation.ackCount, privacy: .public) ackAgeP50Ms=\(self.formatMs(sample.ackAgeP50Ms), privacy: .public) ackAgeP95Ms=\(self.formatMs(sample.ackAgeP95Ms), privacy: .public) ackAgeMaxMs=\(self.formatMs(observation.ackAgeMaxMs), privacy: .public) inFlightFrames=\(observation.inFlightFrames, privacy: .public) inFlightBytes=\(observation.inFlightBytes, privacy: .public) oldestInflightMs=\(self.formatMs(observation.oldestInflightMs), privacy: .public) replacedCaptures=\(observation.freshness.replacedCaptures, privacy: .public) abandonedFrames=\(observation.freshness.abandonedFrames, privacy: .public) abandonedBytes=\(observation.freshness.abandonedBytes, privacy: .public) resendPacketsServed=\(observation.freshness.resendPacketsServed, privacy: .public) resendPacketsMissed=\(observation.freshness.resendPacketsMissed, privacy: .public) completedFrames=\(sample.completedFrames, privacy: .public) gapSkips=\(sample.expiredFrames, privacy: .public) resendRequests=\(sample.resendRequests, privacy: .public) keyframeRequests=\(sample.keyframeRequests, privacy: .public) lossPermille=\(observation.signals.lossPermille, privacy: .public) recoveryCleanMs=\(recovery.cleanMs, privacy: .public) requiredRecoveryMs=\(recovery.requiredMs, privacy: .public) recoveryBlocker=\(recovery.blocker, privacy: .public) recoveryPhase=\(recovery.phase.rawValue, privacy: .public) recoveryProbeAxis=\(recovery.probeAxis.rawValue, privacy: .public) recoveryWarmupWindows=\(recovery.warmupWindowsRemaining, privacy: .public) recoveryProbeWindows=\(recovery.probeWindowsRemaining, privacy: .public) stableRung=\(recovery.stableTarget.rung.rawValue, privacy: .public) stableBitrateKbps=\(recovery.stableTarget.bitrateKbps, privacy: .public) stableFps=\(recovery.stableTarget.fps, privacy: .public) stableResolutionScale=\(recovery.stableTarget.resolutionScale, privacy: .public)"
        )
        logger.notice(
            "mediaQualityDecision windowId=\(observation.windowId, privacy: .public) previousRung=\(decision.outcome.previousTarget.rung.rawValue, privacy: .public) previousBitrateKbps=\(decision.outcome.previousTarget.bitrateKbps, privacy: .public) previousFps=\(decision.outcome.previousTarget.fps, privacy: .public) previousResolutionScale=\(decision.outcome.previousTarget.resolutionScale, privacy: .public) nextRung=\(decision.outcome.target.rung.rawValue, privacy: .public) nextBitrateKbps=\(decision.outcome.target.bitrateKbps, privacy: .public) nextFps=\(decision.outcome.target.fps, privacy: .public) nextResolutionScale=\(decision.outcome.target.resolutionScale, privacy: .public) reason=\(decision.outcome.reason, privacy: .public) changedAxes=\(decision.changedAxes, privacy: .public) lossPressure=\(observation.signals.lossPressure, privacy: .public) repairPressure=\(observation.signals.repairPressure, privacy: .public) queuePressure=\(observation.signals.queuePressure, privacy: .public) cadencePressure=\(observation.signals.cadencePressure, privacy: .public) stalePressure=\(observation.signals.stalePressure, privacy: .public) freezePressure=\(observation.signals.freezePressure, privacy: .public) expiredFrames=\(sample.expiredFrames, privacy: .public) lossPermille=\(observation.signals.lossPermille, privacy: .public) ackAgeP95Ms=\(self.formatMs(sample.ackAgeP95Ms), privacy: .public) fpsDeficit=\(production?.fpsDeficit ?? -1, privacy: .public) maxSendGapMs=\(production?.maxGapMs ?? -1, privacy: .public) staleRecoveryCount=\(observation.staleRecoveryCount, privacy: .public) recoveryCleanMs=\(recovery.cleanMs, privacy: .public) requiredRecoveryMs=\(recovery.requiredMs, privacy: .public) recoveryBlocker=\(recovery.blocker, privacy: .public) recoveryPhase=\(recovery.phase.rawValue, privacy: .public) recoveryProbeAxis=\(recovery.probeAxis.rawValue, privacy: .public) recoveryWarmupWindows=\(recovery.warmupWindowsRemaining, privacy: .public) recoveryProbeWindows=\(recovery.probeWindowsRemaining, privacy: .public) stableRung=\(recovery.stableTarget.rung.rawValue, privacy: .public) stableBitrateKbps=\(recovery.stableTarget.bitrateKbps, privacy: .public) stableFps=\(recovery.stableTarget.fps, privacy: .public) stableResolutionScale=\(recovery.stableTarget.resolutionScale, privacy: .public)"
        )
    }

    private func formatMs(_ value: Double?) -> String {
        guard let value else { return "nil" }
        return String(format: "%.1f", value)
    }

    private static func changedAxes(for outcome: MediaQualityOutcome) -> String {
        var axes: [String] = []
        if outcome.bitrateChanged { axes.append("bitrate") }
        if outcome.fpsChanged { axes.append("fps") }
        if outcome.resolutionChanged { axes.append("resolution") }
        if outcome.target.rung != outcome.previousTarget.rung { axes.append("rung") }
        return axes.isEmpty ? "none" : axes.joined(separator: ",")
    }

    private struct EncodeJob {
        let frame: CapturedVideoFrame
        let updateId: OwnedSurfaceUpdateId
        let forceKeyframeReason: OwnedMediaKeyframeReason?
        let clientKeyframe: Bool
        let abandoned: [GraphicsBackpressure.InFlightFrame]
    }

    private enum DrainStep {
        case idle
        case retry(afterNs: UInt64, reason: QuicSessionHostMediaState.RetryReason)
        case job(EncodeJob)
    }

    /// Read control datagrams for as long as the session lives, surviving transient errors.
    ///
    /// This loop used to `return` on any throw, and that one line is what made a six-second LTE
    /// stall unrecoverable: `POSIXErrorCode(22)` ended it on four consecutive teardowns, after
    /// which no keyframe request, frame ack or liveness probe could reach the host on that
    /// connection again. Cancellation stays terminal -- `stop()` cancels this task, so it is the
    /// signal that the session really is over -- but a network error is not, and treating the two
    /// alike cost the session every time.
    private func startControlReceiveLoop() {
        controlTask = Task { [weak self] in
            guard let self else { return }
            var retry = DatagramReceiveRetry()
            let budgetMs = Double(Config.ownedMediaReceiveRetryBudgetMs)
            while !Task.isCancelled {
                do {
                    let message = try await datagrams.receive()
                    if let recovered = retry.noteSuccess(nowNs: DispatchTime.now().uptimeNanoseconds) {
                        logger.notice(
                            """
                            media control datagram receive recovered \
                            failures=\(recovered.failures, privacy: .public) \
                            outageMs=\(Int(recovered.outageMs), privacy: .public)
                            """
                        )
                    }
                    handleControlDatagram(message.content)
                } catch {
                    if Task.isCancelled || error is CancellationError { return }
                    // Edge-triggered: one line when the run opens, one when it closes. Logging
                    // every retry would emit twenty lines a second into the log written to
                    // diagnose the freeze.
                    let isFirst = !retry.isFailing
                    let outcome = retry.noteFailure(
                        nowNs: DispatchTime.now().uptimeNanoseconds,
                        budgetMs: budgetMs
                    )
                    if isFirst {
                        logger.notice("media control datagram receive failing: \(String(describing: error), privacy: .public)")
                    }
                    switch outcome {
                    case .retry(let backoffMs):
                        try? await Task.sleep(nanoseconds: UInt64(backoffMs * 1_000_000))
                    case .giveUp(let failures, let elapsedMs):
                        logger.error(
                            """
                            media control datagram receive ended \
                            failures=\(failures, privacy: .public) \
                            elapsedMs=\(Int(elapsedMs), privacy: .public) \
                            last=\(String(describing: error), privacy: .public)
                            """
                        )
                        return
                    }
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
            // ADR-0090: the encoder answers a resync with a long-term-reference delta by
            // default, which on a barely-changed desktop is a few hundred bytes rather than a
            // quarter of a megabyte. The one case it cannot is a client that threw its decoder
            // away: there is no way to un-acknowledge a reference, so unless the client says so
            // the encoder would keep answering with a delta the client cannot decode, and the
            // client would keep asking.
            // The reason is client-authored attribution, logged verbatim: 857 requests reached
            // this switch in one measured session while the client's own diagnostics recorded
            // 3, so the host log is the only surface that sees every request and it has to say
            // who asked.
            let requestReason = message.reason ?? "unspecified"
            if message.clientHasNoReferences == true {
                logger.notice("owned media client keyframe request declares no references reason=\(requestReason, privacy: .public)")
                encoder.noteClientHasNoReferences()
            }
            let admission = encodeGate.withLock { state in
                state.mediaState.noteKeyframeRequest()
            }
            switch admission {
            case .queued:
                logger.notice("owned media client keyframe request queued reason=\(requestReason, privacy: .public)")
            case .suppressedInFlight(let frameId):
                logger.notice("owned media client keyframe request suppressed inFlightKeyframe=\(frameId, privacy: .public) reason=\(requestReason, privacy: .public)")
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
            // ADR-0090: the client confirms which long-term references it decoded, which is
            // what lets a later resync be a delta instead of a keyframe. Rides the frame ack
            // because that is already the "I have this frame" signal.
            if let tokens = message.acknowledgedLtrTokens, !tokens.isEmpty {
                encoder.acknowledgeLtrTokens(tokens)
            }
        case .graphicsResetRequest:
            handleGraphicsResetRequest()
        case .keepalive:
            break
        case .linkHealth:
            handleLinkHealth(message)
        case .livenessProbe:
            // Logged on arrival, separately from the send below, because those are the two
            // different failures: a probe that never reached us and an echo that never left.
            // Cheap by construction -- the client only probes while nothing is arriving, so
            // this is at most one line per probe interval and zero on a session carrying video.
            logger.notice("liveness probe received probe=\(message.frameId, privacy: .public)")
            sendLivenessEcho(probeId: message.frameId)
        case .livenessEcho:
            // Host-to-client only. A client sending one is confused, not dangerous.
            break
        }
    }

    /// Answer a liveness probe immediately, deliberately bypassing the burst scheduler.
    ///
    /// Queueing it behind video would defeat the point: the client probes precisely when frames
    /// have stopped arriving, so an echo stuck behind a backlog of undeliverable video packets
    /// would report the link dead exactly as slowly as the thing it is measuring. A failed send
    /// still does not fail the session -- the client's unanswered-probe count is the verdict, and
    /// yielding `.failed` on a dropped echo would let one lost datagram tear down the session.
    ///
    /// It is no longer *silent*, though, and that distinction cost a night of measurement. The
    /// client declared `hostSilent` eight times in five minutes while the host logged one liveness
    /// line in thirty, so an echo that never left was indistinguishable from one never asked for
    /// and from one lost in flight -- three causes with three different fixes. Both outcomes are
    /// logged here for that reason, at the same negligible rate as the probes that drive them.
    private func sendLivenessEcho(probeId: UInt64) {
        Task { [datagrams, logger] in
            let echo = OwnedMediaControlMessage(kind: .livenessEcho, frameId: probeId)
            guard let data = try? JSONEncoder().encode(echo) else { return }
            do {
                try await datagrams.send(data)
                logger.notice("liveness echo sent probe=\(probeId, privacy: .public)")
            } catch {
                logger.notice("liveness echo send failed probe=\(probeId, privacy: .public) reason=\(String(describing: error), privacy: .public)")
            }
        }
    }

    private struct EncodeState {
        var recordedFirstFrameSent = false
        var recordedFirstFrameAcknowledged = false
        var latest: CapturedVideoFrame?
        // Starts true: a client that never sends the message is watching video,
        // which is what every client did before the message existed.
        var isWatchingVideo = true
        var encoding = false
        var retryScheduled = false
        // ADR-0087: carries WHY, not just whether. Five distinct causes used to collapse
        // to `client-request` in the log, which made a stall-recovery keyframe -- whose
        // whole point is being observable -- indistinguishable from a client asking.
        var forceKeyframeReason: OwnedMediaKeyframeReason?
        var mediaState = QuicSessionHostMediaState()
        var productionDiagnostics = MediaProductionDiagnosticsTracker()
        var latestProductionSummary: MediaProductionSummary?
        /// How many times in the current production window a captured frame was ready to encode
        /// and admission refused it for capacity.
        ///
        /// The production summary can only be built when a frame is SENT, so it reports that
        /// cadence collapsed without ever saying why. Measured on LTE, windows with a freeze of
        /// a second or more ran 1.5fps against 5.9 in clean ones -- and nothing distinguished
        /// "the screen had nothing to send" from "we had a frame and the link would not take
        /// it". Those want opposite responses, so the difference has to be recorded where the
        /// refusal happens rather than inferred from the gap afterwards.
        var capacityDeferrals = 0
    }

}
