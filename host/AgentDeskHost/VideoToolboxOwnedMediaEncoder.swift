import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import os
import AgentDeskWire

// Why this exists: the mixed-mode renderer (ADR-0025) carries scrolling motion on
// a hardware HEVC stream while rest stays on retained tiles. This is the host
// encoder, revived from the pre-ADR-0022 owned-media path (commit be6a6ba^) and
// trimmed to the surviving OwnedMediaEncodingConfiguration. The dynamic encode
// budget, pixel-format gate, profile, and QP knobs from the old path are dropped
// here; bitrate and frame rate apply once from configuration. Motion-driven
// bitrate mapping returns with the datagram carrier, not in this unit.

// Why a keyframe happened, for logging and refresh-reason classification. Host
// only; never crosses the wire.
// ADR-0087: every value here is a keyframe WE forced, and each names a distinct cause.
// There is deliberately no `periodic` case: periodic placement belongs to the encoder's
// interval properties, and a keyframe it placed has no reason we can name (the log records
// those as `source=encoder`).
//
// These were previously collapsed to `clientRequest` at the call site, so a resolution
// change and a stall recovery both logged as a client request. That mattered more once
// stall recovery arrived, since being observable is the whole point of it.
enum OwnedMediaKeyframeReason: String, Equatable, Sendable {
    case initial
    case clientRequest = "client-request"
    case resolutionChange = "resolution-change"
    case stallRecovery = "stall-recovery"
    case resumeWatching = "resume-watching"
    case captureRequested = "capture-requested"
}

extension OwnedMediaRefreshReason {
    // Classify the wire refresh reason from what the encoder actually produced.
    // The first frame is always a fresh start; a keyframe the host deliberately forced is
    // a reset, and one the encoder placed on its own interval is a rest refresh.
    //
    // Any forced reason means reset, not just a client request. That is not a change of
    // behavior: until the reasons were split apart every forced keyframe reported itself as
    // `clientRequest`, so this keeps the wire values identical while the log stops lying
    // about the cause.
    static func fromEncodedFrame(
        encodedFrameId: UInt64,
        isKeyframe: Bool,
        requestedKeyframeReason: OwnedMediaKeyframeReason?,
        expectedKeyframeReason: OwnedMediaKeyframeReason?
    ) -> OwnedMediaRefreshReason {
        if encodedFrameId == 1 {
            return .initial
        }
        guard isKeyframe else {
            return .rest
        }
        let forced = requestedKeyframeReason ?? expectedKeyframeReason
        guard let forced, forced != .initial else { return .rest }
        return .reset
    }
}

private extension OwnedMediaCodec {
    var codecType: CMVideoCodecType {
        switch self {
        case .hevc: return kCMVideoCodecType_HEVC
        case .h264: return kCMVideoCodecType_H264
        }
    }
}

// Lives here, not in OwnedMediaTransport, so the encoder and its tests compile as
// a self-contained unit. OwnedMediaTransport and its factory still consume it.
struct OwnedMediaEncodingConfiguration: Equatable, Sendable {
    let targetBitrateKbps: Int
    let expectedFrameRate: Int
    // ADR-0087: both intervals are handed to the encoder as session properties, which
    // enforces them together (whichever comes first). Neither is consulted by our code.
    let keyframeIntervalFrames: Int
    // The wall-clock half, and the load-bearing one: the frame count above is unbounded in
    // TIME on a change-driven capture. See Config for the bandwidth arithmetic.
    let keyframeMaxIntervalMs: Int
    // ADR-0098: the longest the periodic refresh may be stretched to on a slow link. The pair
    // above describes a link at `targetBitrateKbps`; this bounds what happens below it.
    let keyframeMaxIntervalCeilingMs: Int
    // ADR-0027: multiple of the average bitrate used for the encoder's hard
    // DataRateLimits window. Threaded through config so it tracks the bitrate and is
    // injectable in tests; defaults to the Config knob so existing call sites are
    // unchanged.
    let dataRateLimitRatio: Double

    init(
        targetBitrateKbps: Int,
        expectedFrameRate: Int,
        keyframeIntervalFrames: Int,
        keyframeMaxIntervalMs: Int = Config.ownedMediaKeyframeMaxIntervalMs,
        keyframeMaxIntervalCeilingMs: Int = Config.ownedMediaKeyframeMaxIntervalCeilingMs,
        dataRateLimitRatio: Double = Config.ownedMediaDataRateLimitRatio
    ) {
        self.targetBitrateKbps = targetBitrateKbps
        self.expectedFrameRate = expectedFrameRate
        self.keyframeIntervalFrames = keyframeIntervalFrames
        self.keyframeMaxIntervalMs = keyframeMaxIntervalMs
        self.keyframeMaxIntervalCeilingMs = max(keyframeMaxIntervalMs, keyframeMaxIntervalCeilingMs)
        self.dataRateLimitRatio = dataRateLimitRatio
    }

    static let `default` = OwnedMediaEncodingConfiguration(
        targetBitrateKbps: Config.ownedMediaBitrateKbps,
        expectedFrameRate: 30,
        keyframeIntervalFrames: 120
    )

    static func fromConfig() -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(
            targetBitrateKbps: Config.ownedMediaBitrateKbps,
            expectedFrameRate: Config.ownedMediaExpectedFrameRate,
            keyframeIntervalFrames: Config.ownedMediaKeyframeIntervalFrames,
            keyframeMaxIntervalMs: Config.ownedMediaKeyframeMaxIntervalMs
        )
    }
}

final class VideoToolboxOwnedMediaEncoder: @unchecked Sendable {
    private struct PendingEncodedFrame {
        let updateId: OwnedSurfaceUpdateId
        let capturedAtUptimeNs: UInt64
        let requestedKeyframeReason: OwnedMediaKeyframeReason?
        let expectedKeyframeReason: OwnedMediaKeyframeReason?
        /// We asked VideoToolbox for a long-term-reference refresh on this frame. Carried
        /// through so the output callback can report what came back: the encoder silently
        /// substitutes an IDR when it has no acknowledged reference to build a delta against,
        /// and that substitution is the whole failure mode worth watching.
        let requestedLtrRefresh: Bool
        let completion: @Sendable (OwnedMediaFrameEnvelope?) -> Void
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "owned-media")
    private let codec: OwnedMediaCodec
    // ADR-0027: the live bitrate target. Starts at the configured value and the
    // adaptive controller updates it via updateBitrate; ensureSession applies the
    // current value so a session recreate (resize) keeps the adapted rate.
    private var currentBitrateKbps: Int
    // ADR-0029: the live expected frame rate. Starts at the configured value; the
    // adaptive controller lowers it via updateExpectedFrameRate when the link cannot
    // carry full cadence, and ensureSession applies the current value so a session
    // recreate keeps the adapted rate. Matches the encoder's bit allocation to the
    // produce-loop cadence cap.
    private var expectedFrameRate: Int
    /// ADR-0098: the live periodic-refresh interval, scaled to the rung's budget.
    ///
    /// The configured pair is the interval for a link at the ceiling. Held at that value on a
    /// 300kbps link it cost 51kbps -- a 96KB keyframe every 15.1s, 17% of the whole budget,
    /// delivered as a lump -- and it was the single largest keyframe source in a measured
    /// 45-minute session: 25 of 53, none of them requested by anything.
    ///
    /// Recomputed on every bitrate change and re-applied on session recreate, exactly as the
    /// bitrate and frame rate above are, so a resolution change cannot silently restore the
    /// ceiling's cadence on a link that cannot afford it.
    private var currentKeyframeIntervalFrames: Int
    private var currentKeyframeMaxIntervalMs: Int
    private let configuration: OwnedMediaEncodingConfiguration
    private let lock = NSLock()
    private var session: VTCompressionSession?
    private var size: (width: Int, height: Int)?
    /// How many frames THIS encoder has compressed. Deliberately not called `frameId`: it is a
    /// different number from the `frameId` on the wire, which is the surface update counter
    /// (`OwnedSurfaceUpdateId.frameId`) and restarts with each new media transport. This one
    /// restarts only when the encoder itself is replaced, which is what makes it the right
    /// thing to test for "first frame of this stream". Reading a transport-side `frame=` as
    /// this counter cost a wrong diagnosis once: a resume looked like it had built a fresh
    /// encoder when the log was only showing a fresh surface.
    private var encodedFrameCount: UInt64 = 0
    private var forceNextKeyframe = false
    private var loggedFirstEncodedFrame = false
    // ADR-0090 long-term references.
    private var ltrEnabled = false
    /// Tokens the client has confirmed it decoded, not yet handed to the encoder. Drained onto
    /// the next encode: the encoder only references frames that appear here.
    private var pendingLtrAcknowledgements: Set<UInt64> = []
    /// The client told us it threw its decoder away, so the next resync must be a real keyframe.
    ///
    /// VideoToolbox has no way to un-acknowledge an LTR: once told the client holds a frame, it
    /// will happily encode against it forever. The client is the only party that knows its
    /// decoder was flushed, so it has to say so, or a keyframe request answered with a delta
    /// produces a frame it cannot decode, another request, and the same answer -- a livelock,
    /// which is how the client's own render-stall recovery behaved.
    private var clientHasNoReferences = false
    /// Long-term references the encoder has handed us a token for, cumulative. Zero here means
    /// the encoder never nominated a frame as referenceable, so nothing could ever be
    /// acknowledged and every refresh must degrade to an IDR.
    private var ltrTokensEmitted = 0
    /// Tokens the client confirmed and we passed back to VideoToolbox, cumulative. The pair of
    /// counters is what makes a broken round trip readable: emitted-but-never-acknowledged is a
    /// client or wire fault, both zero is an encoder that is not producing references at all.
    private var ltrTokensAcknowledged = 0
    private var pendingFrames: [UInt64: PendingEncodedFrame] = [:]

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default
    ) {
        self.codec = codec
        self.currentBitrateKbps = configuration.targetBitrateKbps
        self.expectedFrameRate = configuration.expectedFrameRate
        let interval = Self.keyframeInterval(
            forBitrateKbps: configuration.targetBitrateKbps,
            configuration: configuration
        )
        self.currentKeyframeIntervalFrames = interval.frames
        self.currentKeyframeMaxIntervalMs = interval.maxIntervalMs
        self.configuration = configuration
    }

    /// How often the encoder may place a keyframe nobody asked for, given what the link can carry.
    ///
    /// The periodic refresh is a safety net: it exists so a client that lost sync recovers even
    /// if no explicit request reaches us. How long "eventually" is allowed to be should scale
    /// with how expensive that recovery is, and on a slow link it is very expensive. So the
    /// configured interval is treated as the interval for a link at the CEILING, and stretched
    /// in proportion as the budget falls, which keeps the refresh at a roughly constant share of
    /// the link instead of a constant share of the clock.
    ///
    /// Both properties move together because "whichever comes first wins": at the emergency
    /// rung's 6fps the configured 120 frames is 20s, so stretching only the duration would be
    /// inert. Scaling both by the same factor leaves the ceiling's behaviour exactly as it was
    /// (factor 1) rather than retuning a rung that was never the problem.
    ///
    /// Bounded by `ownedMediaKeyframeMaxIntervalCeilingMs`, because a net with no bottom is not
    /// a net: a client that misses every explicit resync still has to come back on its own.
    static func keyframeInterval(
        forBitrateKbps kbps: Int,
        configuration: OwnedMediaEncodingConfiguration
    ) -> (frames: Int, maxIntervalMs: Int) {
        // The encoder's OWN configured target, not the global ceiling: this has to be a function
        // of its arguments alone, or an encoder built for a different budget silently inherits
        // the daily driver's idea of what "at the ceiling" means.
        let ceilingKbps = max(1, configuration.targetBitrateKbps)
        let factor = max(1.0, Double(ceilingKbps) / Double(max(1, kbps)))
        let stretchedMs = Double(configuration.keyframeMaxIntervalMs) * factor
        let cappedMs = min(Double(configuration.keyframeMaxIntervalCeilingMs), stretchedMs)
        // Re-derive the applied factor from the capped duration so the frame count never implies
        // a shorter interval than the duration allows, which would put the cap back to no effect.
        let appliedFactor = max(1.0, cappedMs / Double(max(1, configuration.keyframeMaxIntervalMs)))
        return (
            frames: Int((Double(configuration.keyframeIntervalFrames) * appliedFactor).rounded()),
            maxIntervalMs: Int(cappedMs.rounded())
        )
    }

    func encode(
        _ frame: CapturedVideoFrame,
        updateId: OwnedSurfaceUpdateId,
        forceKeyframe: Bool = false,
        requestedKeyframeReason: OwnedMediaKeyframeReason? = nil
    ) async -> OwnedMediaFrameEnvelope? {
        await withCheckedContinuation { continuation in
            encode(
                frame,
                updateId: updateId,
                forceKeyframe: forceKeyframe,
                requestedKeyframeReason: requestedKeyframeReason
            ) { envelope in
                continuation.resume(returning: envelope)
            }
        }
    }

    private func encode(
        _ frame: CapturedVideoFrame,
        updateId: OwnedSurfaceUpdateId,
        forceKeyframe requestedAdmissionKeyframe: Bool,
        requestedKeyframeReason: OwnedMediaKeyframeReason?,
        completion: @escaping @Sendable (OwnedMediaFrameEnvelope?) -> Void
    ) {
        lock.lock()
        let sessionToEncode: VTCompressionSession
        let encodedFrameId: UInt64
        let frameProperties: CFDictionary?
        do {
            try ensureSession(for: frame.pixelBuffer)
            guard let session else {
                lock.unlock()
                completion(nil)
                return
            }
            sessionToEncode = session
            encodedFrameCount &+= 1
            encodedFrameId = encodedFrameCount
            let requestedKeyframe = forceNextKeyframe || requestedAdmissionKeyframe
            forceNextKeyframe = false
            // ADR-0087: we force keyframes only for events we own (client request, stall
            // recovery, resolution change) plus the stream's first frame. Periodic
            // placement belongs to the encoder now, via the two interval properties set on
            // the session, so there is no frame counter or wall clock to consult here.
            let forceKeyframe = requestedKeyframe || encodedFrameId == 1
            let expectedKeyframeReason: OwnedMediaKeyframeReason? = forceKeyframe
                ? Self.resolveKeyframeReason(
                    encodedFrameId: encodedFrameId,
                    requestedReason: requestedKeyframe ? requestedKeyframeReason : nil
                )
                : nil
            // ADR-0090: an LTR refresh REPLACES the forced keyframe, it does not accompany it.
            //
            // Every path that wants a refresh -- client keyframe request, stall recovery -- also
            // sets a keyframe reason, because that is how a resync has always been expressed
            // here. Treating the keyframe as the winner would mean the refresh never fired at
            // all, and the whole change would be inert while looking wired up.
            //
            // The eligibility rule is an exclusion list rather than an opt-in, because opt-in
            // was measured getting it wrong. Only two of the five reasons that force a keyframe
            // ever asked for a refresh, so a resume answered its first frame with a 171KB
            // keyframe while the phone was mid-handover -- the exact moment the cheap path was
            // built for. A rule that new resync paths have to remember to join is a rule that
            // silently stops applying.
            //
            // Two reasons are not eligible and keep their true keyframe. `initial` has nothing
            // to reference yet. `resolutionChange` invalidates every existing reference, so a
            // delta against one would be garbage even if the client still held it. `clientHasNo
            // References` is the client saying it discarded its decoder, which it is the only
            // party that can know.
            //
            // Asking for a refresh is safe regardless: with LTR off or nothing acknowledged,
            // VideoToolbox emits an IDR anyway, so the client is never handed a frame it cannot
            // decode. That is why this can prefer the cheap path without a fallback of its own.
            let resyncReason = requestedKeyframe ? requestedKeyframeReason : nil
            let requiresTrueKeyframe = encodedFrameId == 1
                || resyncReason == .initial
                || resyncReason == .resolutionChange
                || clientHasNoReferences
            let refreshWithLtr = forceKeyframe && ltrEnabled && !requiresTrueKeyframe
            clientHasNoReferences = false
            var options: [CFString: Any] = [:]
            if forceKeyframe, !refreshWithLtr {
                options[kVTEncodeFrameOptionKey_ForceKeyFrame] = kCFBooleanTrue
            }
            if refreshWithLtr {
                options[kVTEncodeFrameOptionKey_ForceLTRRefresh] = kCFBooleanTrue
            }
            if ltrEnabled, !pendingLtrAcknowledgements.isEmpty {
                options[kVTEncodeFrameOptionKey_AcknowledgedLTRTokens] =
                    pendingLtrAcknowledgements.sorted().map { NSNumber(value: $0) } as CFArray
                ltrTokensAcknowledged += pendingLtrAcknowledgements.count
                pendingLtrAcknowledgements.removeAll(keepingCapacity: true)
            }
            frameProperties = options.isEmpty ? nil : options as CFDictionary
            if forceKeyframe, !refreshWithLtr {
                // The expensive branch, and until now the silent one. `ltr-refresh-requested`
                // below only fires when the CHEAP path is taken, so every true keyframe left no
                // record of why it was unavoidable -- which reads, when you count reasons in the
                // log, as though those causes never happen. Measured on a 208kbps link a median
                // keyframe is 57KB, or 2.2 seconds of wire time, so this is the single most
                // expensive decision in the media path and it deserves to say its name.
                let cause = requiresTrueKeyframe
                    ? (encodedFrameId == 1 ? "first-frame"
                        : resyncReason == .initial ? "initial"
                        : resyncReason == .resolutionChange ? "resolution-change"
                        : "client-has-no-references")
                    : "ltr-disabled"
                logger.notice("owned encoder true-keyframe encFrame=\(encodedFrameId, privacy: .public) cause=\(cause, privacy: .public) requested=\(resyncReason?.rawValue ?? "none", privacy: .public) ltrEnabled=\(self.ltrEnabled, privacy: .public) emitted=\(self.ltrTokensEmitted, privacy: .public) acked=\(self.ltrTokensAcknowledged, privacy: .public)")
            }
            if refreshWithLtr {
                // `acked` is the decisive number when a refresh comes back as an IDR: the
                // encoder falls back when it holds no acknowledged reference, so a zero here
                // says the round trip never closed rather than that the refresh misfired.
                logger.notice("owned encoder ltr-refresh-requested encFrame=\(encodedFrameId, privacy: .public) reason=\(resyncReason?.rawValue ?? "unknown", privacy: .public) emitted=\(self.ltrTokensEmitted, privacy: .public) acked=\(self.ltrTokensAcknowledged, privacy: .public)")
            }
            pendingFrames[encodedFrameId] = PendingEncodedFrame(
                updateId: updateId,
                capturedAtUptimeNs: frame.capturedAtUptimeNs,
                requestedKeyframeReason: requestedKeyframe ? requestedKeyframeReason : nil,
                expectedKeyframeReason: expectedKeyframeReason,
                requestedLtrRefresh: refreshWithLtr,
                completion: completion
            )
            if requestedKeyframe {
                logger.notice("owned encoder forcing requested keyframe encFrame=\(encodedFrameId, privacy: .public) reason=\(requestedKeyframeReason?.rawValue ?? "unknown", privacy: .public)")
            }
        } catch {
            if let session {
                VTCompressionSessionInvalidate(session)
            }
            session = nil
            size = nil
            lock.unlock()
            completion(nil)
            return
        }
        lock.unlock()

        let pts = CMTime(value: frame.presentationTimeNs, timescale: 1_000_000_000)
        let status = VTCompressionSessionEncodeFrame(
            sessionToEncode,
            imageBuffer: frame.pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: frameProperties,
            sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: UInt(encodedFrameId)),
            infoFlagsOut: nil
        )
        if status != noErr {
            lock.lock()
            let pending = pendingFrames.removeValue(forKey: encodedFrameId)
            lock.unlock()
            pending?.completion(nil)
        }
    }

    func invalidate() {
        lock.lock()
        let pending = pendingFrames.values
        pendingFrames.removeAll()
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        size = nil
        lock.unlock()
        pending.forEach { $0.completion(nil) }
    }

    func requestKeyframe() {
        lock.lock()
        forceNextKeyframe = true
        lock.unlock()
    }

    // ADR-0027: retarget the live session's bitrate (and its derived burst cap) without
    // recreating it, so the adaptive controller can step it under loss. A no-op if no
    // session yet; the new value is remembered so the next ensureSession applies it.
    func updateBitrate(_ kbps: Int) {
        lock.lock()
        currentBitrateKbps = kbps
        // ADR-0098: the periodic-refresh interval is a function of the budget, so it moves with
        // it here rather than being a separate thing a caller has to remember to update.
        let interval = Self.keyframeInterval(forBitrateKbps: kbps, configuration: configuration)
        let intervalChanged = interval.frames != currentKeyframeIntervalFrames
            || interval.maxIntervalMs != currentKeyframeMaxIntervalMs
        currentKeyframeIntervalFrames = interval.frames
        currentKeyframeMaxIntervalMs = interval.maxIntervalMs
        let session = self.session
        let ratio = configuration.dataRateLimitRatio
        lock.unlock()
        guard let session else { return }
        let limits = Self.dataRateLimits(targetBitrateKbps: kbps, ratio: ratio)
        let limitsValue = [
            NSNumber(value: Int(limits.bytesPerWindow)),
            NSNumber(value: limits.windowSeconds)
        ] as CFArray
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: kbps * 1000))
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limitsValue)
        logger.notice("owned encoder bitrate-updated kbps=\(kbps, privacy: .public) dataRateCapBytes=\(Int(limits.bytesPerWindow), privacy: .public)")
        guard intervalChanged else { return }
        _ = VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
            value: NSNumber(value: interval.frames)
        )
        _ = VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
            value: NSNumber(value: Double(interval.maxIntervalMs) / 1000.0)
        )
        logger.notice("owned encoder keyframe-interval-updated frames=\(interval.frames, privacy: .public) maxIntervalMs=\(interval.maxIntervalMs, privacy: .public) kbps=\(kbps, privacy: .public)")
    }

    // ADR-0029: retarget the live session's expected frame rate without recreating it,
    // so the adaptive controller can lower cadence on a slow link and the encoder's bit
    // allocation tracks it. A no-op if no session yet; the new value is remembered so
    // the next ensureSession applies it.
    func updateExpectedFrameRate(_ fps: Int) {
        lock.lock()
        expectedFrameRate = fps
        let session = self.session
        lock.unlock()
        guard let session else { return }
        _ = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        logger.notice("owned encoder fps-updated fps=\(fps, privacy: .public)")
    }

    /// ADR-0090: the client decoded these long-term reference frames, so the encoder may
    /// reference them. Accumulated rather than applied immediately -- properties attach to a
    /// frame, and the next encode drains whatever has arrived.
    func acknowledgeLtrTokens(_ tokens: [UInt64]) {
        guard !tokens.isEmpty else { return }
        lock.lock()
        let enabled = ltrEnabled
        if enabled {
            pendingLtrAcknowledgements.formUnion(tokens)
        }
        let queued = pendingLtrAcknowledgements.count
        lock.unlock()
        // The client half of the round trip closing. Logged rather than counted silently
        // because its absence is indistinguishable from a working system without it: the whole
        // mechanism degrades to the keyframe behaviour it replaced, which looks like nothing
        // is wrong.
        logger.notice("owned encoder ltr-ack-received tokens=\(tokens.map(String.init).joined(separator: ","), privacy: .public) enabled=\(enabled, privacy: .public) queued=\(queued, privacy: .public)")
    }

    /// The client discarded its decoder, so the next resync must be a real keyframe rather than
    /// a delta against a reference it no longer holds.
    func noteClientHasNoReferences() {
        lock.lock()
        clientHasNoReferences = true
        pendingLtrAcknowledgements.removeAll(keepingCapacity: true)
        lock.unlock()
    }

    /// The encoder's handle for a frame it is willing to reference later. Absent on frames that
    /// are not long-term references, which is most of them.
    private static func ltrAcknowledgementToken(_ sampleBuffer: CMSampleBuffer) -> UInt64? {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[CFString: Any]],
            let first = attachments.first,
            let token = first[kVTSampleAttachmentKey_RequireLTRAcknowledgementToken] as? NSNumber
        else { return nil }
        return token.uint64Value
    }

    private func ensureSession(for pixelBuffer: CVPixelBuffer) throws {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let actualPixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
        if let size, size.width == width, size.height == height, session != nil {
            return
        }
        if let session {
            VTCompressionSessionInvalidate(session)
            // Every long-term reference lived inside that session and died with it. Three
            // pieces of state have to go too, or they describe a session that no longer
            // exists: queued acknowledgements would be handed to a session that never issued
            // those tokens, and the counters would report references the new session does not
            // hold -- which is exactly the number the refresh telemetry is read for.
            //
            // This is also the explanation for an `outcome=idr-fallback` that is nobody's bug:
            // a rescale resets the reference set, so the first resync after one CANNOT be a
            // delta. The ladder resetting on reconnect is what puts a rescale directly in the
            // path of a resume, which is the case ADR-0090 exists to make cheap.
            if ltrTokensEmitted > 0 || !pendingLtrAcknowledgements.isEmpty {
                logger.notice("owned encoder ltr-state-dropped reason=session-recreate emitted=\(self.ltrTokensEmitted, privacy: .public) acked=\(self.ltrTokensAcknowledged, privacy: .public)")
            }
            pendingLtrAcknowledgements.removeAll(keepingCapacity: true)
            ltrTokensEmitted = 0
            ltrTokensAcknowledged = 0
        }
        var newSession: VTCompressionSession?
        let encoderSpecification = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue as Any,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue as Any
        ] as CFDictionary
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: codec.codecType,
            encoderSpecification: encoderSpecification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: Self.outputCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &newSession
        )
        guard status == noErr, let newSession else {
            throw SessionRejected(reason: .malformed)
        }
        try setProperty(kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue, on: newSession)
        // ADR-0090: long-term references, so a resync can cost a delta instead of a keyframe.
        // On a mostly unchanged desktop that is ~264 bytes against ~250KB, which on a cellular
        // link is the difference between milliseconds and about four seconds.
        //
        // Only available on the low-latency encoder path, which this session already requests.
        // Not fatal if the encoder refuses: without it every resync stays a keyframe, which is
        // exactly the behaviour this replaces, so it degrades to the status quo rather than
        // failing the session.
        let ltrStatus = VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_EnableLTR, value: kCFBooleanTrue)
        ltrEnabled = ltrStatus == noErr
        if !ltrEnabled {
            logger.notice("owned encoder LTR unavailable status=\(ltrStatus, privacy: .public); resync stays keyframe-only")
        }
        try setProperty(kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse, on: newSession)
        try setProperty(kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: expectedFrameRate), on: newSession)
        try setProperty(kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: currentBitrateKbps * 1000), on: newSession)
        // ADR-0027: hard windowed ceiling so a keyframe cannot burst past the link
        // budget. AverageBitRate above only bounds the long-run average; this bounds
        // the instantaneous burst that froze constrained links. VideoToolbox wants the
        // byte count as an integer CFNumber and the window as a seconds CFNumber.
        let dataRateLimits = Self.dataRateLimits(targetBitrateKbps: currentBitrateKbps, ratio: configuration.dataRateLimitRatio)
        let dataRateLimitsValue = [
            NSNumber(value: Int(dataRateLimits.bytesPerWindow)),
            NSNumber(value: dataRateLimits.windowSeconds)
        ] as CFArray
        try setProperty(kVTCompressionPropertyKey_DataRateLimits, value: dataRateLimitsValue, on: newSession)
        // ADR-0087: the encoder owns periodic keyframe placement. Both limits are enforced
        // together -- a keyframe every X frames or every Y seconds, whichever comes first --
        // which is the whole policy, so we no longer count frames or clock-watch ourselves.
        //
        // The duration key is the load-bearing one: capture is change-driven, so a frame
        // count alone is unbounded in TIME (~21s at the 4-6fps a quiet screen produced, two
        // minutes at ADR-0073's 1fps validation profile). Apple documents it as being for
        // exactly this, a variable frame rate.
        //
        // Strict, not tolerant: `setProperty` accepts kVTPropertyNotSupportedErr, which for
        // these two would silently leave the stream with no ceiling at all. R189 asserts
        // both are supported and read back on real hardware; this is the runtime half of
        // that guarantee.
        // ADR-0098: the LIVE interval, not the configured one, for the same reason the bitrate
        // above is live. A resolution change recreates this session, and restoring the ceiling's
        // refresh cadence on a link at the emergency rung would undo the stretch at exactly the
        // moment it is most needed -- a rescale only happens because the link is in trouble.
        try setRequiredProperty(
            kVTCompressionPropertyKey_MaxKeyFrameInterval,
            value: NSNumber(value: currentKeyframeIntervalFrames),
            on: newSession
        )
        try setRequiredProperty(
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
            value: NSNumber(value: Double(currentKeyframeMaxIntervalMs) / 1000.0),
            on: newSession
        )
        VTCompressionSessionPrepareToEncodeFrames(newSession)
        session = newSession
        size = (width, height)
        logger.notice("owned encoder session codec=\(self.codec.rawValue, privacy: .public) size=\(width, privacy: .public)x\(height, privacy: .public) pixelFormat=\(Self.fourCC(actualPixelFormat), privacy: .public) bitrate=\(self.currentBitrateKbps, privacy: .public)kbps fps=\(self.expectedFrameRate, privacy: .public) keyframeInterval=\(self.configuration.keyframeIntervalFrames, privacy: .public) dataRateCapBytes=\(Int(dataRateLimits.bytesPerWindow), privacy: .public) dataRateWindowSec=\(dataRateLimits.windowSeconds, privacy: .public)")
    }

    private func setProperty(_ key: CFString, value: CFTypeRef, on session: VTCompressionSession) throws {
        let status = VTSessionSetProperty(session, key: key, value: value)
        guard status == noErr || status == kVTPropertyNotSupportedErr else {
            throw SessionRejected(reason: .malformed)
        }
    }

    /// A property the stream's correctness depends on, so an unsupported one is a failed
    /// session rather than a tolerated no-op.
    ///
    /// The permissive variant above is right for tuning hints, where an encoder that
    /// declines still produces a correct stream. It is wrong for the keyframe intervals:
    /// declining those means no keyframe ceiling, which is invisible until a client is
    /// stuck on a frozen image waiting for a sync point that is not coming.
    private func setRequiredProperty(
        _ key: CFString,
        value: CFTypeRef,
        on session: VTCompressionSession
    ) throws {
        let status = VTSessionSetProperty(session, key: key, value: value)
        guard status == noErr else {
            logger.error("owned encoder required property rejected key=\(key as String, privacy: .public) status=\(status, privacy: .public)")
            throw SessionRejected(reason: .malformed)
        }
    }

    // kVTCompressionPropertyKey_DataRateLimits bounds the AVERAGE over a sliding window, which
    // is not the same as bounding the frame. ADR-0027 recorded it as "a hard cap: the encoder
    // emits at most `bytesPerWindow` over any `windowSeconds` window"; ADR-0098 measured
    // otherwise. Three keyframes against the cap in force at the time: 43,441 vs 33,750 (1.29x),
    // 96,408 vs 56,250 (1.71x), 132,831 vs 99,188 (1.34x). VideoToolbox honours the window by
    // STARVING the frames after the IDR -- `sentKbps` went 768, then 13, then 14 across the three
    // windows around one of them -- not by making the IDR fit. At the emergency rung's 6fps a
    // one-second window holds six frames, so there is almost nothing to amortise across.
    //
    // It is still worth setting: the keyframes do scale with it, which is why the sizes above
    // track their caps at a roughly constant multiple. But the thing that actually bounds what
    // reaches the link is `LinkSendPacer`, and the interval stretch above is what bounds how
    // often this cost is paid at all. Pure so the contract is unit-testable without a live
    // session.
    static func dataRateLimits(
        targetBitrateKbps: Int,
        ratio: Double
    ) -> (bytesPerWindow: Double, windowSeconds: Double) {
        let averageBytesPerSecond = Double(targetBitrateKbps) * 1000.0 / 8.0
        let windowSeconds = 1.0
        let bytesPerWindow = (averageBytesPerSecond * ratio * windowSeconds).rounded()
        return (bytesPerWindow, windowSeconds)
    }

    private static func fourCC(_ value: OSType) -> String {
        let bytes: [UInt8] = [
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff)
        ]
        return String(bytes: bytes, encoding: .macOSRoman) ?? "????"
    }

    private static let outputCallback: VTCompressionOutputCallback = { refcon, sourceFrameRefcon, status, _, sampleBuffer in
        guard let refcon else {
            return
        }
        let encoder = Unmanaged<VideoToolboxOwnedMediaEncoder>.fromOpaque(refcon).takeUnretainedValue()
        guard status == noErr,
              let sampleBuffer else {
            encoder.handleEncodeFailed(sourceFrameRefcon: sourceFrameRefcon)
            return
        }
        encoder.handleEncoded(sampleBuffer: sampleBuffer, sourceFrameRefcon: sourceFrameRefcon)
    }

    private func handleEncodeFailed(sourceFrameRefcon: UnsafeMutableRawPointer?) {
        guard let sourceFrameRefcon else { return }
        let encodedFrameId = UInt64(UInt(bitPattern: sourceFrameRefcon))
        let pending: PendingEncodedFrame?
        lock.lock()
        pending = pendingFrames.removeValue(forKey: encodedFrameId)
        lock.unlock()
        pending?.completion(nil)
    }

    private func handleEncoded(sampleBuffer: CMSampleBuffer, sourceFrameRefcon: UnsafeMutableRawPointer?) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer),
              let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let sourceFrameRefcon else {
            return
        }
        let encodedFrameId = UInt64(UInt(bitPattern: sourceFrameRefcon))
        let pending: PendingEncodedFrame?
        let encodedSize: (width: Int, height: Int)?
        lock.lock()
        pending = pendingFrames.removeValue(forKey: encodedFrameId)
        encodedSize = size
        lock.unlock()
        guard let pending,
              let encodedSize else {
            return
        }
        let payload: Data
        do {
            payload = try Self.copyData(from: dataBuffer)
        } catch {
            pending.completion(nil)
            return
        }
        let isKeyframe = Self.isKeyframe(sampleBuffer)
        let parameterSets = isKeyframe ? Self.parameterSets(codec: codec, formatDescription: formatDescription) : nil
        let refreshReason = OwnedMediaRefreshReason.fromEncodedFrame(
            encodedFrameId: encodedFrameId,
            isKeyframe: isKeyframe,
            requestedKeyframeReason: pending.requestedKeyframeReason,
            expectedKeyframeReason: pending.expectedKeyframeReason
        )
        let ltrToken = Self.ltrAcknowledgementToken(sampleBuffer)
        if let ltrToken {
            lock.lock()
            ltrTokensEmitted += 1
            let emitted = ltrTokensEmitted
            lock.unlock()
            // The encoder nominating a frame as referenceable. Nothing downstream can work
            // without this, so its absence has to be visible: no token means no acknowledgement
            // is even possible, and every refresh is an IDR for a reason that is not the
            // client's fault.
            logger.notice("owned encoder ltr-token-emitted encFrame=\(encodedFrameId, privacy: .public) frame=\(pending.updateId.frameId, privacy: .public) token=\(ltrToken, privacy: .public) emitted=\(emitted, privacy: .public) keyframe=\(isKeyframe, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        if pending.requestedLtrRefresh {
            // What the refresh actually bought. `outcome=idr-fallback` is the failure this
            // telemetry exists for: we asked for a delta against an acknowledged reference and
            // VideoToolbox had none, so it sent a full frame instead and said nothing.
            let outcome = isKeyframe ? "idr-fallback" : "ltr-delta"
            logger.notice("owned encoder ltr-refresh-result encFrame=\(encodedFrameId, privacy: .public) outcome=\(outcome, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        let header = OwnedMediaFrameHeader(
            surfaceGeneration: pending.updateId.surfaceGeneration,
            frameId: pending.updateId.frameId,
            codec: codec,
            width: encodedSize.width,
            height: encodedSize.height,
            capturedAtUptimeNs: pending.capturedAtUptimeNs,
            presentationTimeNs: UInt64(CMSampleBufferGetPresentationTimeStamp(sampleBuffer).value),
            isKeyframe: isKeyframe,
            parameterSets: parameterSets,
            refreshReason: refreshReason,
            ltrToken: ltrToken
        )
        if !loggedFirstEncodedFrame {
            loggedFirstEncodedFrame = true
            logger.notice("owned first encoded frame codec=\(self.codec.rawValue, privacy: .public) size=\(encodedSize.width, privacy: .public)x\(encodedSize.height, privacy: .public) keyframe=\(isKeyframe, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        if isKeyframe {
            // ADR-0087: `source` replaced an `expected` flag that meant "we predicted this
            // keyframe". Once the encoder owns periodic placement we cannot predict those,
            // so `expected=false` would have become the normal case and read as an anomaly.
            // What is worth knowing is who caused it: an event we forced, or the encoder's
            // own interval. A rising `source=encoder` rate against a steady `requested` one
            // is the signal that the GOP properties are doing the work.
            let source = pending.expectedKeyframeReason != nil ? "requested" : "encoder"
            // Both counters, because they answer different questions and reading one as the
            // other is a mistake this log invited: `encFrame` is this encoder's lifetime count
            // (so it shows whether the encoder survived a reconnect), `frame` is the wire id
            // that the transport's `video sent frame=` line and the client's acks both use.
            logger.notice("owned encoder keyframe-result encFrame=\(encodedFrameId, privacy: .public) frame=\(pending.updateId.frameId, privacy: .public) source=\(source, privacy: .public) requestedReason=\(pending.requestedKeyframeReason?.rawValue ?? "none", privacy: .public) forcedReason=\(pending.expectedKeyframeReason?.rawValue ?? "none", privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        pending.completion(OwnedMediaFrameEnvelope(header: header, payload: payload))
    }

    /// Why WE forced this keyframe. Only reached when we did; a keyframe the encoder chose
    /// on its own has no reason we can name, which is what `source=encoder` records.
    private static func resolveKeyframeReason(
        encodedFrameId: UInt64,
        requestedReason: OwnedMediaKeyframeReason?
    ) -> OwnedMediaKeyframeReason {
        if encodedFrameId == 1 {
            return .initial
        }
        // The stream's first frame aside, we never force a keyframe without a cause, so a
        // missing reason is a caller that forgot to name one rather than a category.
        return requestedReason ?? .captureRequested
    }

    private static func copyData(from blockBuffer: CMBlockBuffer) throws -> Data {
        var totalLength = 0
        let lengthStatus = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: nil
        )
        guard lengthStatus == noErr else {
            throw SessionRejected(reason: .malformed)
        }
        var data = Data(count: totalLength)
        let copyStatus = data.withUnsafeMutableBytes { buffer in
            CMBlockBufferCopyDataBytes(
                blockBuffer,
                atOffset: 0,
                dataLength: totalLength,
                destination: buffer.baseAddress!
            )
        }
        guard copyStatus == noErr else {
            throw SessionRejected(reason: .malformed)
        }
        return data
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0 else {
            return true
        }
        let attachment = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
        return !CFDictionaryContainsKey(
            attachment,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
        )
    }

    private static func parameterSets(
        codec: OwnedMediaCodec,
        formatDescription: CMFormatDescription
    ) -> OwnedMediaParameterSets? {
        switch codec {
        case .h264:
            guard let sps = parameterSet(formatDescription, index: 0, hevc: false),
                  let pps = parameterSet(formatDescription, index: 1, hevc: false) else {
                return nil
            }
            return OwnedMediaParameterSets(sps: sps, pps: pps)
        case .hevc:
            guard let vps = parameterSet(formatDescription, index: 0, hevc: true),
                  let sps = parameterSet(formatDescription, index: 1, hevc: true),
                  let pps = parameterSet(formatDescription, index: 2, hevc: true) else {
                return nil
            }
            return OwnedMediaParameterSets(vps: vps, sps: sps, pps: pps)
        }
    }

    private static func parameterSet(
        _ formatDescription: CMFormatDescription,
        index: Int,
        hevc: Bool
    ) -> Data? {
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        let status: OSStatus
        if hevc {
            status = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: index,
                parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            )
        } else {
            status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDescription,
                parameterSetIndex: index,
                parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size,
                parameterSetCountOut: nil,
                nalUnitHeaderLengthOut: nil
            )
        }
        guard status == noErr, let pointer else { return nil }
        return Data(bytes: pointer, count: size)
    }
}
