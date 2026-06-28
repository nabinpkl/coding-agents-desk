import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import os

// Why this exists: the mixed-mode renderer (ADR-0025) carries scrolling motion on
// a hardware HEVC stream while rest stays on retained tiles. This is the host
// encoder, revived from the pre-ADR-0022 owned-media path (commit be6a6ba^) and
// trimmed to the surviving OwnedMediaEncodingConfiguration. The dynamic encode
// budget, pixel-format gate, profile, and QP knobs from the old path are dropped
// here; bitrate and frame rate apply once from configuration. Motion-driven
// bitrate mapping returns with the datagram carrier, not in this unit.

// Why a keyframe happened, for logging and refresh-reason classification. Host
// only; never crosses the wire.
enum OwnedMediaKeyframeReason: String, Equatable, Sendable {
    case initial
    case periodic
    case clientRequest = "client-request"
    case transportRecovery = "transport-recovery"
}

extension OwnedMediaRefreshReason {
    // Classify the wire refresh reason from what the encoder actually produced.
    // The first frame is always a fresh start; a keyframe asked for by the client
    // is a reset, any other keyframe is a periodic rest refresh.
    static func fromEncodedFrame(
        frameId: UInt64,
        isKeyframe: Bool,
        requestedKeyframeReason: OwnedMediaKeyframeReason?,
        expectedKeyframeReason: OwnedMediaKeyframeReason?
    ) -> OwnedMediaRefreshReason {
        if frameId == 1 {
            return .initial
        }
        guard isKeyframe else {
            return .rest
        }
        if requestedKeyframeReason == .clientRequest ||
            requestedKeyframeReason == .transportRecovery ||
            expectedKeyframeReason == .clientRequest ||
            expectedKeyframeReason == .transportRecovery {
            return .reset
        }
        return .rest
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
    let keyframeIntervalFrames: Int
    // ADR-0027: multiple of the average bitrate used for the encoder's hard
    // DataRateLimits window. Threaded through config so it tracks the bitrate and is
    // injectable in tests; defaults to the Config knob so existing call sites are
    // unchanged.
    let dataRateLimitRatio: Double

    init(
        targetBitrateKbps: Int,
        expectedFrameRate: Int,
        keyframeIntervalFrames: Int,
        dataRateLimitRatio: Double = Config.ownedMediaDataRateLimitRatio
    ) {
        self.targetBitrateKbps = targetBitrateKbps
        self.expectedFrameRate = expectedFrameRate
        self.keyframeIntervalFrames = keyframeIntervalFrames
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
            keyframeIntervalFrames: Config.ownedMediaKeyframeIntervalFrames
        )
    }
}

final class VideoToolboxOwnedMediaEncoder: @unchecked Sendable {
    private struct PendingEncodedFrame {
        let updateId: OwnedSurfaceUpdateId
        let capturedAtUptimeNs: UInt64
        let requestedKeyframeReason: OwnedMediaKeyframeReason?
        let expectedKeyframeReason: OwnedMediaKeyframeReason?
        let completion: @Sendable (OwnedMediaFrameEnvelope?) -> Void
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
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
    private let configuration: OwnedMediaEncodingConfiguration
    private let lock = NSLock()
    private var session: VTCompressionSession?
    private var size: (width: Int, height: Int)?
    private var frameId: UInt64 = 0
    private var forceNextKeyframe = false
    private var loggedFirstEncodedFrame = false
    private var pendingFrames: [UInt64: PendingEncodedFrame] = [:]

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default
    ) {
        self.codec = codec
        self.currentBitrateKbps = configuration.targetBitrateKbps
        self.expectedFrameRate = configuration.expectedFrameRate
        self.configuration = configuration
    }

    func encode(
        _ frame: CapturedVideoFrame,
        updateId: OwnedSurfaceUpdateId,
        forceKeyframe: Bool = false,
        allowPeriodicKeyframe: Bool = true,
        requestedKeyframeReason: OwnedMediaKeyframeReason? = nil
    ) async -> OwnedMediaFrameEnvelope? {
        await withCheckedContinuation { continuation in
            encode(
                frame,
                updateId: updateId,
                forceKeyframe: forceKeyframe,
                allowPeriodicKeyframe: allowPeriodicKeyframe,
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
        allowPeriodicKeyframe: Bool,
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
            frameId &+= 1
            encodedFrameId = frameId
            let requestedKeyframe = forceNextKeyframe || requestedAdmissionKeyframe
            forceNextKeyframe = false
            let periodicKeyframe = allowPeriodicKeyframe &&
                encodedFrameId.isMultiple(of: UInt64(configuration.keyframeIntervalFrames))
            let forceKeyframe = requestedKeyframe || encodedFrameId == 1 || periodicKeyframe
            let expectedKeyframeReason: OwnedMediaKeyframeReason? = forceKeyframe
                ? Self.resolveKeyframeReason(
                    frameId: encodedFrameId,
                    requestedReason: requestedKeyframe ? requestedKeyframeReason : nil,
                    periodicKeyframe: periodicKeyframe
                )
                : nil
            frameProperties = forceKeyframe
                ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
                : nil
            pendingFrames[encodedFrameId] = PendingEncodedFrame(
                updateId: updateId,
                capturedAtUptimeNs: frame.capturedAtUptimeNs,
                requestedKeyframeReason: requestedKeyframe ? requestedKeyframeReason : nil,
                expectedKeyframeReason: expectedKeyframeReason,
                completion: completion
            )
            if requestedKeyframe {
                logger.notice("owned encoder forcing requested keyframe frame=\(self.frameId, privacy: .public) reason=\(requestedKeyframeReason?.rawValue ?? "unknown", privacy: .public)")
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

    private func ensureSession(for pixelBuffer: CVPixelBuffer) throws {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let actualPixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
        if let size, size.width == width, size.height == height, session != nil {
            return
        }
        if let session {
            VTCompressionSessionInvalidate(session)
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

    // kVTCompressionPropertyKey_DataRateLimits is a hard cap: the encoder emits at
    // most `bytesPerWindow` over any `windowSeconds` window. One one-second window
    // sized at `ratio` times the average byte-rate gives a keyframe bounded headroom
    // over the nominal bitrate instead of the unbounded burst AverageBitRate allows.
    // Pure so the ceiling contract is unit-testable without a live session. See ADR-0027.
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
            frameId: encodedFrameId,
            isKeyframe: isKeyframe,
            requestedKeyframeReason: pending.requestedKeyframeReason,
            expectedKeyframeReason: pending.expectedKeyframeReason
        )
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
            refreshReason: refreshReason
        )
        if !loggedFirstEncodedFrame {
            loggedFirstEncodedFrame = true
            logger.notice("owned first encoded frame codec=\(self.codec.rawValue, privacy: .public) size=\(encodedSize.width, privacy: .public)x\(encodedSize.height, privacy: .public) keyframe=\(isKeyframe, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        if isKeyframe {
            logger.notice("owned encoder keyframe-result frame=\(encodedFrameId, privacy: .public) requestedReason=\(pending.requestedKeyframeReason?.rawValue ?? "none", privacy: .public) actualReason=\(pending.expectedKeyframeReason?.rawValue ?? "unknown", privacy: .public) expected=\(pending.expectedKeyframeReason != nil, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        pending.completion(OwnedMediaFrameEnvelope(header: header, payload: payload))
    }

    private static func resolveKeyframeReason(
        frameId: UInt64,
        requestedReason: OwnedMediaKeyframeReason?,
        periodicKeyframe: Bool
    ) -> OwnedMediaKeyframeReason {
        if frameId == 1 {
            return .initial
        }
        if let requestedReason {
            return requestedReason
        }
        if periodicKeyframe {
            return .periodic
        }
        return .periodic
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

// ADR-0033: one host-owned media-quality controller chooses bitrate, fps, and
// capture resolution together from link-health heuristics. The client reports
// observations; the host owns the quality target.
enum MediaQualityRung: Int, Equatable, Comparable {
    case native = 0
    case lossControl = 1
    case capacity1 = 2
    case capacity2 = 3
    case survival = 4

    static func < (lhs: MediaQualityRung, rhs: MediaQualityRung) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

struct MediaQualityTarget: Equatable {
    let bitrateKbps: Int
    let fps: Int
    let resolutionScale: Double
    let rung: MediaQualityRung
    let reason: String

    func with(
        bitrateKbps: Int? = nil,
        fps: Int? = nil,
        resolutionScale: Double? = nil,
        rung: MediaQualityRung? = nil,
        reason: String
    ) -> MediaQualityTarget {
        MediaQualityTarget(
            bitrateKbps: bitrateKbps ?? self.bitrateKbps,
            fps: fps ?? self.fps,
            resolutionScale: resolutionScale ?? self.resolutionScale,
            rung: rung ?? self.rung,
            reason: reason
        )
    }
}

struct MediaQualitySample: Equatable {
    let completedFrames: Int
    let expiredFrames: Int
    let resendRequests: Int
    let keyframeRequests: Int
    let ackAgeP50Ms: Double?
    let ackAgeP95Ms: Double?

    init(
        completedFrames: Int,
        expiredFrames: Int,
        resendRequests: Int = 0,
        keyframeRequests: Int = 0,
        ackAgeP50Ms: Double? = nil,
        ackAgeP95Ms: Double? = nil
    ) {
        self.completedFrames = max(0, completedFrames)
        self.expiredFrames = max(0, expiredFrames)
        self.resendRequests = max(0, resendRequests)
        self.keyframeRequests = max(0, keyframeRequests)
        self.ackAgeP50Ms = ackAgeP50Ms
        self.ackAgeP95Ms = ackAgeP95Ms
    }
}

struct MediaQualityOutcome: Equatable {
    let target: MediaQualityTarget
    let previousTarget: MediaQualityTarget
    let reason: String

    var changed: Bool {
        bitrateChanged || fpsChanged || resolutionChanged || target.rung != previousTarget.rung
    }
    var bitrateChanged: Bool { target.bitrateKbps != previousTarget.bitrateKbps }
    var fpsChanged: Bool { target.fps != previousTarget.fps }
    var resolutionChanged: Bool { target.resolutionScale != previousTarget.resolutionScale }
}

struct MediaQualityControllerConfig: Equatable {
    let ceilingKbps: Int
    let floorKbps: Int
    let survivalFloorKbps: Int
    let downStep: Double
    let upStep: Double
    let lossDownPermille: Int
    let raiseCleanWindows: Int
    let fpsCeiling: Int
    let fpsFloor: Int
    let ackHoldP95Ms: Double
    let ackDownP95Ms: Double
    let capacity1Kbps: Int
    let capacity1Fps: Int
    let capacity1Scale: Double
    let capacity2Kbps: Int
    let capacity2Fps: Int
    let capacity2Scale: Double
    let survivalScale: Double

    init(
        ceilingKbps: Int,
        floorKbps: Int,
        survivalFloorKbps: Int,
        downStep: Double,
        upStep: Double,
        lossDownPermille: Int,
        raiseCleanWindows: Int,
        fpsCeiling: Int,
        fpsFloor: Int,
        ackHoldP95Ms: Double,
        ackDownP95Ms: Double,
        capacity1Kbps: Int,
        capacity1Fps: Int,
        capacity1Scale: Double,
        capacity2Kbps: Int,
        capacity2Fps: Int,
        capacity2Scale: Double,
        survivalScale: Double
    ) {
        self.ceilingKbps = max(1, ceilingKbps)
        self.floorKbps = min(max(1, floorKbps), self.ceilingKbps)
        self.survivalFloorKbps = min(max(1, survivalFloorKbps), self.floorKbps)
        self.downStep = min(max(downStep, 0.01), 0.99)
        self.upStep = max(upStep, 1.01)
        self.lossDownPermille = max(1, lossDownPermille)
        self.raiseCleanWindows = max(1, raiseCleanWindows)
        self.fpsCeiling = max(1, fpsCeiling)
        self.fpsFloor = min(max(1, fpsFloor), self.fpsCeiling)
        self.ackHoldP95Ms = max(1, ackHoldP95Ms)
        self.ackDownP95Ms = max(self.ackHoldP95Ms, ackDownP95Ms)
        self.capacity1Kbps = min(max(1, capacity1Kbps), self.floorKbps)
        self.capacity1Fps = min(max(1, capacity1Fps), self.fpsCeiling)
        self.capacity1Scale = Self.normalizedScale(capacity1Scale)
        self.capacity2Kbps = min(max(1, capacity2Kbps), self.capacity1Kbps)
        self.capacity2Fps = min(max(1, capacity2Fps), self.capacity1Fps)
        self.capacity2Scale = min(Self.normalizedScale(capacity2Scale), self.capacity1Scale)
        self.survivalScale = min(Self.normalizedScale(survivalScale), self.capacity2Scale)
    }

    static func fromConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: Config.ownedMediaBitrateKbps,
            floorKbps: Config.ownedMediaBitrateFloorKbps,
            survivalFloorKbps: Config.ownedMediaSurvivalBitrateFloorKbps,
            downStep: Config.ownedMediaBitrateDownStep,
            upStep: Config.ownedMediaBitrateUpStep,
            lossDownPermille: Config.ownedMediaBitrateLossDownPermille,
            raiseCleanWindows: Config.ownedMediaBitrateRaiseCleanWindows,
            fpsCeiling: Config.ownedMediaExpectedFrameRate,
            fpsFloor: Config.ownedMediaFpsFloor,
            ackHoldP95Ms: Config.ownedMediaAckHoldP95Ms,
            ackDownP95Ms: Config.ownedMediaAckDownP95Ms,
            capacity1Kbps: Config.ownedMediaCapacity1BitrateKbps,
            capacity1Fps: Config.ownedMediaCapacity1Fps,
            capacity1Scale: Config.ownedMediaCapacity1ResolutionScale,
            capacity2Kbps: Config.ownedMediaCapacity2BitrateKbps,
            capacity2Fps: Config.ownedMediaCapacity2Fps,
            capacity2Scale: Config.ownedMediaCapacity2ResolutionScale,
            survivalScale: Config.ownedMediaSurvivalResolutionScale
        )
    }

    static func normalizedScale(_ scale: Double) -> Double {
        min(max(scale, 0.1), 1.0)
    }
}

struct MediaQualityController {
    private let config: MediaQualityControllerConfig
    private(set) var target: MediaQualityTarget
    private var cleanStreak = 0

    init(config: MediaQualityControllerConfig) {
        self.config = config
        self.target = MediaQualityTarget(
            bitrateKbps: config.ceilingKbps,
            fps: config.fpsCeiling,
            resolutionScale: 1.0,
            rung: .native,
            reason: "initial"
        )
    }

    var targetKbps: Int { target.bitrateKbps }
    var targetFps: Int { target.fps }
    var targetResolutionScale: Double { target.resolutionScale }

    func signals(
        for sample: MediaQualitySample,
        productionSummary: MediaProductionSummary?,
        staleRecoveryCount: Int
    ) -> MediaQualityObservationSignals {
        let total = sample.completedFrames + sample.expiredFrames
        let lossPermille = total > 0 ? (sample.expiredFrames * 1000) / total : 0
        let loss = lossPermille >= config.lossDownPermille ||
            sample.expiredFrames > 0 ||
            sample.keyframeRequests > 0
        let repairPressure = sample.resendRequests > 0
        let ackQueued = (sample.ackAgeP95Ms ?? 0) >= config.ackDownP95Ms
        let cadencePressure = productionSummary.map { summary in
            summary.fpsDeficit * 2 >= max(summary.targetFps, 1) ||
                summary.maxGapMs >= summary.windowMs
        } ?? false
        return MediaQualityObservationSignals(
            loss: loss,
            repairPressure: repairPressure,
            ackQueued: ackQueued,
            cadencePressure: cadencePressure,
            backpressureStale: staleRecoveryCount > 0,
            lossPermille: lossPermille
        )
    }

    mutating func observe(_ sample: MediaQualitySample) -> MediaQualityOutcome {
        let previous = target
        let total = sample.completedFrames + sample.expiredFrames
        guard total > 0 else {
            return outcome(previous: previous, reason: "idle")
        }
        let lossPermille = (sample.expiredFrames * 1000) / total
        let hasLoss = lossPermille >= config.lossDownPermille ||
            sample.expiredFrames > 0 ||
            sample.keyframeRequests > 0
        let hasRepairPressure = sample.resendRequests > 0
        let ackP95 = sample.ackAgeP95Ms ?? 0
        let queued = ackP95 >= config.ackDownP95Ms
        if queued && !hasLoss && !hasRepairPressure {
            cleanStreak = 0
            return outcome(previous: previous, reason: "latency-hold")
        }
        if hasLoss || (queued && hasRepairPressure) {
            cleanStreak = 0
            downshift(reason: hasLoss ? "loss-down" : "queue-loss-down")
            return outcome(previous: previous, reason: target == previous ? "at-survival-floor" : target.reason)
        }
        if ackP95 >= config.ackHoldP95Ms {
            cleanStreak = 0
            return outcome(previous: previous, reason: "latency-hold")
        }
        cleanStreak += 1
        if cleanStreak >= config.raiseCleanWindows {
            cleanStreak = 0
            recover()
            return outcome(previous: previous, reason: target == previous ? "at-native" : target.reason)
        }
        return outcome(previous: previous, reason: "clean-hold")
    }

    private mutating func downshift(reason: String) {
        if target.bitrateKbps > config.floorKbps && target.rung <= .lossControl {
            let bitrate = max(config.floorKbps, Int((Double(target.bitrateKbps) * config.downStep).rounded()))
            let rung: MediaQualityRung = bitrate == config.ceilingKbps ? .native : .lossControl
            target = target.with(bitrateKbps: bitrate, fps: config.fpsCeiling, resolutionScale: 1.0, rung: rung, reason: reason)
            return
        }
        switch target.rung {
        case .native, .lossControl:
            target = fixedTarget(for: .capacity1, reason: "capacity-down")
        case .capacity1:
            target = fixedTarget(for: .capacity2, reason: "capacity-down")
        case .capacity2:
            target = fixedTarget(for: .survival, reason: "survival-down")
        case .survival:
            target = fixedTarget(for: .survival, reason: "at-survival-floor")
        }
    }

    private mutating func recover() {
        if target.rung == .native {
            return
        }
        let next = recoveryTarget(for: target.rung)
        if target.bitrateKbps < next.bitrateKbps {
            let bitrate = min(next.bitrateKbps, Int((Double(target.bitrateKbps) * config.upStep).rounded()))
            target = target.with(bitrateKbps: bitrate, reason: "clean-up")
            return
        }
        target = next.with(reason: "quality-up")
    }

    private func fixedTarget(for rung: MediaQualityRung, reason: String) -> MediaQualityTarget {
        switch rung {
        case .native:
            MediaQualityTarget(bitrateKbps: config.ceilingKbps, fps: config.fpsCeiling, resolutionScale: 1.0, rung: .native, reason: reason)
        case .lossControl:
            MediaQualityTarget(bitrateKbps: config.floorKbps, fps: config.fpsCeiling, resolutionScale: 1.0, rung: .lossControl, reason: reason)
        case .capacity1:
            MediaQualityTarget(bitrateKbps: config.capacity1Kbps, fps: config.capacity1Fps, resolutionScale: config.capacity1Scale, rung: .capacity1, reason: reason)
        case .capacity2:
            MediaQualityTarget(bitrateKbps: config.capacity2Kbps, fps: config.capacity2Fps, resolutionScale: config.capacity2Scale, rung: .capacity2, reason: reason)
        case .survival:
            MediaQualityTarget(bitrateKbps: config.survivalFloorKbps, fps: config.fpsFloor, resolutionScale: config.survivalScale, rung: .survival, reason: reason)
        }
    }

    private func recoveryTarget(for rung: MediaQualityRung) -> MediaQualityTarget {
        switch rung {
        case .survival:
            fixedTarget(for: .capacity2, reason: "quality-up")
        case .capacity2:
            fixedTarget(for: .capacity1, reason: "quality-up")
        case .capacity1:
            fixedTarget(for: .lossControl, reason: "quality-up")
        case .lossControl:
            fixedTarget(for: .native, reason: "quality-up")
        case .native:
            fixedTarget(for: .native, reason: "quality-up")
        }
    }

    private func outcome(previous: MediaQualityTarget, reason: String) -> MediaQualityOutcome {
        MediaQualityOutcome(
            target: target.with(reason: reason),
            previousTarget: previous,
            reason: reason
        )
    }
}

struct QuicSessionHostMediaState {
    enum Admission: Equatable {
        case ready(OwnedSurfaceUpdateId)
        case retry(afterNs: UInt64, reason: RetryReason)
    }

    enum RetryReason: String, Equatable {
        case capacity
        case backpressure
    }

    private var nextFrameId: UInt64 = 0
    private var lastProduceUptimeNs: UInt64?
    private var backpressure: GraphicsBackpressure
    private var qualityController: MediaQualityController
    private var resendRing: OwnedMediaResendRing
    private let expectedFrameRate: Int
    private let retryIntervalNs: UInt64
    private let staleInflightTimeoutNs: UInt64
    private var forceRecoveryKeyframeOnNextAdmission = false
    private var resendRequestsInWindow = 0
    private var keyframeRequestsInWindow = 0
    private var ackAgesMs: [Double] = []
    private var staleRecoveryCountInWindow = 0
    private var qualityWindowId: UInt64 = 0

    init(
        maxInflightFrames: Int = Config.ownedMediaBackpressureMaxInflightFrames,
        maxInflightBytes: Int = Config.ownedMediaBackpressureMaxInflightBytes,
        expectedFrameRate: Int = Config.ownedMediaExpectedFrameRate,
        qualityController: MediaQualityController = MediaQualityController(config: .fromConfig()),
        resendRingFrames: Int = Config.ownedMediaResendRingFrames,
        retryIntervalNs: UInt64 = UInt64(Config.ownedMediaDrainRetryIntervalMs) * 1_000_000,
        staleInflightTimeoutNs: UInt64 = UInt64(Config.ownedMediaBackpressureStaleTimeoutMs) * 1_000_000
    ) {
        self.backpressure = GraphicsBackpressure(
            maxUnacked: maxInflightFrames,
            maxUnackedBytes: maxInflightBytes
        )
        self.expectedFrameRate = max(1, expectedFrameRate)
        self.qualityController = qualityController
        self.resendRing = OwnedMediaResendRing(capacityFrames: resendRingFrames)
        self.retryIntervalNs = max(1, retryIntervalNs)
        self.staleInflightTimeoutNs = max(1, staleInflightTimeoutNs)
    }

    var targetKbps: Int { qualityController.targetKbps }
    var targetFps: Int { qualityController.targetFps }
    var targetResolutionScale: Double { qualityController.targetResolutionScale }
    var inFlightFrames: Int { backpressure.inFlight }
    var inFlightBytes: Int { backpressure.bytesInFlight }

    mutating func reserveUpdateId(nowNs: UInt64) -> Admission {
        if !backpressure.canProduce() {
            if let oldestSentUptimeNs = backpressure.oldestSentUptimeNs {
                let ageNs = nowNs >= oldestSentUptimeNs ? nowNs - oldestSentUptimeNs : 0
                if ageNs >= staleInflightTimeoutNs {
                    backpressure.reset()
                    forceRecoveryKeyframeOnNextAdmission = true
                    staleRecoveryCountInWindow += 1
                } else {
                    return .retry(
                        afterNs: min(retryIntervalNs, staleInflightTimeoutNs - ageNs),
                        reason: .backpressure
                    )
                }
            } else {
                return .retry(afterNs: retryIntervalNs, reason: .backpressure)
            }
        }
        if let last = lastProduceUptimeNs {
            let interval = capacityIntervalNs()
            if interval > 0, nowNs &- last < interval {
                return .retry(afterNs: interval - (nowNs &- last), reason: .capacity)
            }
        }
        nextFrameId &+= 1
        lastProduceUptimeNs = nowNs
        return .ready(OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: nextFrameId))
    }

    mutating func noteSent(
        frameId: UInt64,
        encodedBytes: Int,
        packets: [Data],
        sentAtUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) {
        backpressure.noteSent(frameId: frameId, bytes: encodedBytes, sentAtUptimeNs: sentAtUptimeNs)
        resendRing.remember(frameId: frameId, packets: packets)
    }

    @discardableResult
    mutating func noteAck(frameId: UInt64, nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> Double? {
        guard let sentAtUptimeNs = backpressure.noteAck(frameId: frameId) else { return nil }
        let ageNs = nowNs >= sentAtUptimeNs ? nowNs - sentAtUptimeNs : 0
        let ageMs = Double(ageNs) / 1_000_000.0
        ackAgesMs.append(ageMs)
        return ageMs
    }

    mutating func packetsForResend(
        frameId: UInt64,
        indexes: [UInt16],
        maxCount: Int
    ) -> (packets: [(UInt16, Data)], misses: [UInt16]) {
        resendRing.packets(frameId: frameId, indexes: indexes, maxCount: maxCount)
    }

    mutating func noteResendRequest() {
        resendRequestsInWindow += 1
    }

    mutating func noteKeyframeRequest() {
        keyframeRequestsInWindow += 1
    }

    mutating func resetForQualityChange() {
        backpressure.reset()
        forceRecoveryKeyframeOnNextAdmission = false
    }

    mutating func observeLinkHealth(
        completedFrames: Int,
        expiredFrames: Int,
        productionSummary: MediaProductionSummary?,
        nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> MediaQualityDecision {
        qualityWindowId &+= 1
        let ackStats = ackAgeStats()
        let sample = MediaQualitySample(
            completedFrames: completedFrames,
            expiredFrames: expiredFrames,
            resendRequests: resendRequestsInWindow,
            keyframeRequests: keyframeRequestsInWindow,
            ackAgeP50Ms: ackStats.p50,
            ackAgeP95Ms: ackStats.p95
        )
        let oldestInflightMs = backpressure.oldestSentUptimeNs.map { sentNs in
            Double(nowNs >= sentNs ? nowNs - sentNs : 0) / 1_000_000.0
        }
        let staleRecoveryCount = staleRecoveryCountInWindow
        let signals = qualityController.signals(
            for: sample,
            productionSummary: productionSummary,
            staleRecoveryCount: staleRecoveryCount
        )
        let observation = MediaQualityObservation(
            windowId: qualityWindowId,
            sample: sample,
            previousTarget: qualityController.target,
            productionSummary: productionSummary,
            ackCount: ackStats.count,
            ackAgeMaxMs: ackStats.max,
            inFlightFrames: backpressure.inFlight,
            inFlightBytes: backpressure.bytesInFlight,
            oldestInflightMs: oldestInflightMs,
            staleRecoveryCount: staleRecoveryCount,
            signals: signals
        )
        resendRequestsInWindow = 0
        keyframeRequestsInWindow = 0
        staleRecoveryCountInWindow = 0
        ackAgesMs.removeAll(keepingCapacity: true)
        return MediaQualityDecision(
            observation: observation,
            outcome: qualityController.observe(sample)
        )
    }

    mutating func takeRecoveryKeyframeRequest() -> Bool {
        let shouldForceKeyframe = forceRecoveryKeyframeOnNextAdmission
        forceRecoveryKeyframeOnNextAdmission = false
        return shouldForceKeyframe
    }

    private func capacityIntervalNs() -> UInt64 {
        let fps = qualityController.targetFps
        guard fps > 0, fps < expectedFrameRate else { return 0 }
        return UInt64(1_000_000_000 / fps)
    }

    private func percentile(_ fraction: Double) -> Double? {
        guard !ackAgesMs.isEmpty else { return nil }
        let sorted = ackAgesMs.sorted()
        let clamped = min(max(fraction, 0), 1)
        let index = min(sorted.count - 1, Int((Double(sorted.count - 1) * clamped).rounded(.up)))
        return sorted[index]
    }

    private func ackAgeStats() -> (count: Int, p50: Double?, p95: Double?, max: Double?) {
        guard !ackAgesMs.isEmpty else {
            return (0, nil, nil, nil)
        }
        return (
            ackAgesMs.count,
            percentile(0.50),
            percentile(0.95),
            ackAgesMs.max()
        )
    }
}
