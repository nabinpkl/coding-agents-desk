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
