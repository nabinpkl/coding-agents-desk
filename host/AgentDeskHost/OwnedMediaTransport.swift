import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import Network
import Security
import VideoToolbox
import os

typealias OwnedMediaDatagramAuthorizer = @Sendable (MediaChannelHello) async -> MediaCapabilityValidationResult

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let codec: OwnedMediaCodec
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer
    ) {
        self.codec = codec
        self.configuration = configuration
        self.authorizer = authorizer
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(codec: codec, configuration: configuration, authorizer: authorizer)
    }
}

struct OwnedMediaEncodingConfiguration: Equatable, Sendable {
    let expectedPixelFormat: OSType?
    let hevcProfileLevel: String?
    let maxAllowedFrameQP: Int?
    let targetBitrateKbps: Int
    let expectedFrameRate: Int
    let keyframeIntervalFrames: Int

    static let `default` = OwnedMediaEncodingConfiguration(
        expectedPixelFormat: nil,
        hevcProfileLevel: nil,
        maxAllowedFrameQP: nil,
        targetBitrateKbps: SenderTuning.fromEnvironment(ProcessInfo.processInfo.environment).crispProfile.maxBitrateKbps,
        expectedFrameRate: 30,
        keyframeIntervalFrames: 120
    )

    static func fromConfig() -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(
            expectedPixelFormat: Config.ownedMediaChroma.expectedPixelFormat,
            hevcProfileLevel: Config.ownedMediaHEVCProfile?.profileLevel,
            maxAllowedFrameQP: Config.ownedMediaMaxQP,
            targetBitrateKbps: Config.ownedMediaBitrateKbps,
            expectedFrameRate: Config.ownedMediaExpectedFrameRate,
            keyframeIntervalFrames: Config.ownedMediaKeyframeIntervalFrames
        )
    }
}

final class OwnedMediaTransport: MediaTransport, @unchecked Sendable {
    private static let quicALPN = "agentdesk-owned-media"
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let codec: OwnedMediaCodec
    private let configuration: OwnedMediaEncodingConfiguration
    private let authorizer: OwnedMediaDatagramAuthorizer
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.owned-media-quic")
    private let lock = NSLock()
    private var listener: NWListener?
    private var channel: (any OwnedMediaChannelServing)?
    private var videoSources: VideoPlaneSources?
    private var encoders: [MediaPlane: VideoToolboxOwnedMediaEncoder] = [:]
    private var started = false

    init(
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default,
        authorizer: @escaping OwnedMediaDatagramAuthorizer
    ) {
        self.codec = codec
        self.configuration = configuration
        self.authorizer = authorizer
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSources: VideoPlaneSources?,
        videoSinks: VideoPlaneSinks?
    ) async throws {
        self.videoSources = videoSources
        stateContinuation.yield(.connecting)
        try startQuicDatagramListener()
        try await startIfReady()
    }

    func stop() {
        lock.lock()
        let channel = self.channel
        self.channel = nil
        started = false
        let listener = self.listener
        self.listener = nil
        lock.unlock()
        for source in MediaPlane.allCases.compactMap({ videoSources?[$0] }) {
            source.stop()
        }
        encoders.values.forEach { $0.invalidate() }
        encoders.removeAll()
        listener?.cancel()
        channel?.close()
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    func setVideoInteractive(_ active: Bool) {}

    private func startQuicDatagramListener() throws {
        lock.lock()
        let existing = listener
        lock.unlock()
        guard existing == nil else { return }
        guard let port = NWEndpoint.Port(rawValue: Config.signalingPort) else {
            throw SessionRejected(reason: .malformed)
        }
        let listener = try NWListener(using: Self.makeQuicDatagramParameters(), on: port)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handleQuicDatagramConnection(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media quic listener state=\(String(describing: state), privacy: .public)")
            if case .failed(let error) = state {
                self?.logger.error("owned media quic listener failed: \(String(describing: error), privacy: .public)")
                self?.stateContinuation.yield(.failed)
            }
        }
        lock.lock()
        self.listener = listener
        lock.unlock()
        listener.start(queue: queue)
    }

    private static func makeQuicDatagramParameters() throws -> NWParameters {
        let identity = try TLSIdentityLoader(
            certURL: Config.tlsCertURL,
            keyURL: Config.tlsKeyURL,
            identityURL: Config.tlsIdentityURL
        ).loadIdentity()
        guard let secIdentity = sec_identity_create(identity) else {
            throw TLSIdentityError.noIdentityInBundle
        }
        let options = NWProtocolQUIC.Options(alpn: [Self.quicALPN])
        options.direction = .bidirectional
        options.isDatagram = true
        options.maxDatagramFrameSize = Config.ownedMediaQuicMaxDatagramBytes
        sec_protocol_options_set_local_identity(options.securityProtocolOptions, secIdentity)
        return NWParameters(quic: options)
    }

    private func handleQuicDatagramConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receiveMessage { [weak self, weak connection] data, _, _, error in
            guard let self, let connection else { return }
            if let error {
                self.logger.error("owned media quic hello receive failed: \(String(describing: error), privacy: .public)")
                connection.cancel()
                return
            }
            guard let data else {
                connection.cancel()
                return
            }
            Task { [weak self, weak connection] in
                await self?.acceptDatagramHello(data, on: connection)
            }
        }
    }

    private func acceptDatagramHello(_ data: Data, on connection: NWConnection?) async {
        guard let connection else { return }
        do {
            let hello = try JSONDecoder().decode(MediaChannelHello.self, from: data)
            guard !hello.clientNonce.isEmpty else {
                throw SessionRejected(reason: .malformed)
            }
            let result = await authorizer(hello)
            switch result {
            case .accepted(let fingerprint):
                let serverNonce = try Self.randomBytes(count: 32)
                let key = MediaDatagramCrypto.key(
                    mediaCapability: hello.mediaCapability,
                    clientNonce: hello.clientNonce,
                    serverNonce: serverNonce
                )
                let ready = MediaChannelReady(sessionId: hello.sessionId, serverNonce: serverNonce)
                let readyData = try JSONEncoder().encode(ready)
                try await sendReady(readyData, on: connection)
                let channel = OwnedMediaChannelServer(
                    connection: connection,
                    fingerprint: fingerprint,
                    key: key,
                    onControlMessage: { [weak self] message in
                        self?.handleControlMessage(message)
                    }
                )
                installChannel(channel)
                logger.notice("owned media quic accepted fp=\(fingerprint.rawValue, privacy: .public)")
                try await startIfReady()
            case .rejected(let reason):
                logger.error("owned media quic rejected reason=\(reason.rawValue, privacy: .public) fp=\(hello.deviceFingerprint.rawValue, privacy: .public)")
                connection.cancel()
            }
        } catch {
            logger.error("owned media quic hello failed: \(String(describing: error), privacy: .public)")
            connection.cancel()
            stateContinuation.yield(.failed)
        }
    }

    private func installChannel(_ channel: any OwnedMediaChannelServing) {
        lock.lock()
        self.channel?.close()
        self.channel = channel
        lock.unlock()
    }

    private func sendReady(_ data: Data, on connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }

    private func startIfReady() async throws {
        guard let (channel, sources) = claimStartIfReady() else { return }

        for plane in [MediaPlane.detail] {
            guard let source = sources[plane] else { continue }
            let encoder = VideoToolboxOwnedMediaEncoder(
                plane: plane,
                codec: codec,
                configuration: configuration,
                onEncoded: { [weak self, weak channel] envelope in
                    guard let channel else { return }
                    Task {
                        do {
                            try await channel.send(envelope)
                        } catch {
                            self?.logger.error("owned media frame send failed plane=\(plane.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
                        }
                    }
                }
            )
            encoders[plane] = encoder
            try await source.start { [weak encoder] frame in
                encoder?.encode(frame)
            }
        }
        stateContinuation.yield(.connected)
    }

    private func claimStartIfReady() -> ((any OwnedMediaChannelServing), VideoPlaneSources)? {
        lock.lock()
        let channel = self.channel
        let sources = self.videoSources
        let alreadyStarted = started
        if channel != nil, sources != nil, !started {
            started = true
        }
        lock.unlock()
        guard let channel, let sources, !alreadyStarted else { return nil }
        return (channel, sources)
    }

    private func handleControlMessage(_ message: OwnedMediaControlMessage) {
        switch message.kind {
        case .keyframeRequest:
            logger.notice("owned media keyframe requested after client frame=\(message.frameId, privacy: .public)")
            requestKeyframe()
        case .packetResendRequest:
            break
        }
    }

    private func requestKeyframe() {
        lock.lock()
        let encoders = Array(self.encoders.values)
        lock.unlock()
        encoders.forEach { $0.requestKeyframe() }
    }

}

final class VideoToolboxOwnedMediaEncoder: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media")
    private let plane: MediaPlane
    private let codec: OwnedMediaCodec
    private let targetBitrateKbps: Int
    private let expectedFrameRate: Int
    private let configuration: OwnedMediaEncodingConfiguration
    private let onEncoded: @Sendable (OwnedMediaFrameEnvelope) -> Void
    private let lock = NSLock()
    private var session: VTCompressionSession?
    private var size: (width: Int, height: Int)?
    private var frameId: UInt64 = 0
    private var forceNextKeyframe = false
    private var loggedFirstEncodedFrame = false

    init(
        plane: MediaPlane,
        codec: OwnedMediaCodec,
        configuration: OwnedMediaEncodingConfiguration = .default,
        onEncoded: @escaping @Sendable (OwnedMediaFrameEnvelope) -> Void
    ) {
        self.plane = plane
        self.codec = codec
        self.targetBitrateKbps = configuration.targetBitrateKbps
        self.expectedFrameRate = configuration.expectedFrameRate
        self.configuration = configuration
        self.onEncoded = onEncoded
    }

    func encode(_ frame: CapturedVideoFrame) {
        lock.lock()
        defer { lock.unlock() }
        do {
            try ensureSession(for: frame.pixelBuffer)
            guard let session else { return }
            frameId &+= 1
            let requestedKeyframe = forceNextKeyframe
            forceNextKeyframe = false
            let forceKeyframe = requestedKeyframe || frameId == 1 || frameId.isMultiple(of: UInt64(configuration.keyframeIntervalFrames))
            let pts = CMTime(value: frame.presentationTimeNs, timescale: 1_000_000_000)
            let frameProperties = forceKeyframe
                ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
                : nil
            if requestedKeyframe {
                logger.notice("owned encoder forcing requested keyframe plane=\(self.plane.rawValue, privacy: .public) frame=\(self.frameId, privacy: .public)")
            }
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: frame.pixelBuffer,
                presentationTimeStamp: pts,
                duration: .invalid,
                frameProperties: frameProperties,
                sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: UInt(frame.capturedAtUptimeNs)),
                infoFlagsOut: nil
            )
            if status != noErr {
                throw SessionRejected(reason: .malformed)
            }
        } catch {
            if let session {
                VTCompressionSessionInvalidate(session)
            }
            session = nil
            size = nil
        }
    }

    func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        size = nil
    }

    func requestKeyframe() {
        lock.lock()
        forceNextKeyframe = true
        lock.unlock()
    }

    private func ensureSession(for pixelBuffer: CVPixelBuffer) throws {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let actualPixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
        if let expectedPixelFormat = configuration.expectedPixelFormat,
           actualPixelFormat != expectedPixelFormat {
            logger.error("owned capture pixel format mismatch plane=\(self.plane.rawValue, privacy: .public) expected=\(Self.fourCC(expectedPixelFormat), privacy: .public) actual=\(Self.fourCC(actualPixelFormat), privacy: .public)")
            throw SessionRejected(reason: .malformed)
        }
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
        try setProperty(kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: targetBitrateKbps * 1000), on: newSession)
        if codec == .hevc, let hevcProfileLevel = configuration.hevcProfileLevel {
            try setRequiredProperty(kVTCompressionPropertyKey_ProfileLevel, value: hevcProfileLevel as CFString, on: newSession)
        }
        if let maxAllowedFrameQP = configuration.maxAllowedFrameQP {
            try setRequiredProperty(kVTCompressionPropertyKey_MaxAllowedFrameQP, value: NSNumber(value: maxAllowedFrameQP), on: newSession)
        }
        VTCompressionSessionPrepareToEncodeFrames(newSession)
        session = newSession
        size = (width, height)
        logger.notice("owned encoder session plane=\(self.plane.rawValue, privacy: .public) codec=\(self.codec.rawValue, privacy: .public) size=\(width, privacy: .public)x\(height, privacy: .public) pixelFormat=\(Self.fourCC(actualPixelFormat), privacy: .public) profile=\(String(describing: self.configuration.hevcProfileLevel), privacy: .public) maxQP=\(String(describing: self.configuration.maxAllowedFrameQP), privacy: .public) bitrate=\(self.targetBitrateKbps, privacy: .public)kbps fps=\(self.expectedFrameRate, privacy: .public) keyframeInterval=\(self.configuration.keyframeIntervalFrames, privacy: .public)")
    }

    private func setProperty(_ key: CFString, value: CFTypeRef, on session: VTCompressionSession) throws {
        let status = VTSessionSetProperty(session, key: key, value: value)
        guard status == noErr || status == kVTPropertyNotSupportedErr else {
            throw SessionRejected(reason: .malformed)
        }
    }

    private func setRequiredProperty(_ key: CFString, value: CFTypeRef, on session: VTCompressionSession) throws {
        let status = VTSessionSetProperty(session, key: key, value: value)
        guard status == noErr else {
            logger.error("owned required encoder property failed plane=\(self.plane.rawValue, privacy: .public) key=\(key, privacy: .public) status=\(status, privacy: .public)")
            throw SessionRejected(reason: .malformed)
        }
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
        guard status == noErr,
              let refcon,
              let sampleBuffer else {
            return
        }
        let encoder = Unmanaged<VideoToolboxOwnedMediaEncoder>.fromOpaque(refcon).takeUnretainedValue()
        encoder.handleEncoded(sampleBuffer: sampleBuffer, sourceFrameRefcon: sourceFrameRefcon)
    }

    private func handleEncoded(sampleBuffer: CMSampleBuffer, sourceFrameRefcon: UnsafeMutableRawPointer?) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer),
              let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let size else {
            return
        }
        let payload: Data
        do {
            payload = try Self.copyData(from: dataBuffer)
        } catch {
            return
        }
        let isKeyframe = Self.isKeyframe(sampleBuffer)
        let parameterSets = isKeyframe ? Self.parameterSets(codec: codec, formatDescription: formatDescription) : nil
        let capturedAt = UInt64(bitPattern: Int64(Int(bitPattern: sourceFrameRefcon)))
        let header = OwnedMediaFrameHeader(
            frameId: frameId,
            plane: plane,
            codec: codec,
            width: size.width,
            height: size.height,
            capturedAtUptimeNs: capturedAt,
            presentationTimeNs: UInt64(CMSampleBufferGetPresentationTimeStamp(sampleBuffer).value),
            isKeyframe: isKeyframe,
            parameterSets: parameterSets
        )
        if !loggedFirstEncodedFrame {
            loggedFirstEncodedFrame = true
            logger.notice("owned first encoded frame plane=\(self.plane.rawValue, privacy: .public) codec=\(self.codec.rawValue, privacy: .public) size=\(size.width, privacy: .public)x\(size.height, privacy: .public) keyframe=\(isKeyframe, privacy: .public) bytes=\(payload.count, privacy: .public)")
        }
        onEncoded(OwnedMediaFrameEnvelope(header: header, payload: payload))
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

private extension OwnedMediaCodec {
    var codecType: CMVideoCodecType {
        switch self {
        case .hevc: return kCMVideoCodecType_HEVC
        case .h264: return kCMVideoCodecType_H264
        }
    }
}

private extension Config.OwnedMediaChroma {
    var expectedPixelFormat: OSType {
        switch self {
        case .yuv420:
            return kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        case .yuv444:
            return kCVPixelFormatType_444YpCbCr8BiPlanarFullRange
        case .bgra:
            return kCVPixelFormatType_32BGRA
        }
    }
}

private extension Config.OwnedMediaHEVCProfile {
    var profileLevel: String {
        switch self {
        case .main:
            return kVTProfileLevel_HEVC_Main_AutoLevel as String
        case .main10:
            return kVTProfileLevel_HEVC_Main10_AutoLevel as String
        case .main42210:
            return kVTProfileLevel_HEVC_Main42210_AutoLevel as String
        case .main444:
            return "HEVC_Main444_AutoLevel"
        case .main44410:
            return "HEVC_Main44410_AutoLevel"
        }
    }
}
