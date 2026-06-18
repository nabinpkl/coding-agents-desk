import Foundation
import WebRTC
import os

// ADR-0004 concrete MediaTransport impl, host side. This is the only file
// (alongside WebRTCVideoCapturer) that imports WebRTC on the host. Everything
// outside this file talks to the MediaTransport protocol; swapping the
// WebRTC library replaces this file and no others.

final class LibWebRTCTransportFactory: MediaTransportFactory {
    let planeConfigurations: [MediaPlane: MediaPlaneConfiguration]
    private let factory: RTCPeerConnectionFactory

    init(planeConfigurations: [MediaPlane: MediaPlaneConfiguration]) {
        self.planeConfigurations = planeConfigurations
        self.factory = Self.sharedFactory
    }

    nonisolated(unsafe) private static let sharedFactory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        #if DEBUG
        RTCSetMinDebugLogLevel(.info)
        #endif
        let encoder = RTCDefaultVideoEncoderFactory()
        let decoder = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(
            encoderFactory: encoder,
            decoderFactory: decoder
        )
    }()

    func make() -> MediaTransport {
        LibWebRTCMediaTransport(factory: factory, planeConfigurations: planeConfigurations)
    }
}

final class LibWebRTCMediaTransport: NSObject, MediaTransport, RTCPeerConnectionDelegate, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "webrtc")
    private let factory: RTCPeerConnectionFactory
    private let planeConfigurations: [MediaPlane: MediaPlaneConfiguration]
    private var peerConnection: RTCPeerConnection?
    private var capturers: [MediaPlane: WebRTCVideoCapturer] = [:]
    // RTCVideoCapturer.delegate is weak in libwebrtc, so this video source
    // must be retained on self even though the RTCVideoTrack also holds it.
    // Without this strong reference the capturer's delegate goes nil between
    // start() returning and the first frame being delivered.
    private var rtcVideoSources: [MediaPlane: RTCVideoSource] = [:]
    private var videoTracks: [MediaPlane: RTCVideoTrack] = [:]
    private var videoSenders: [MediaPlane: RTCRtpSender] = [:]
    private var signaling: SignalingChannel?
    private var inboundTask: Task<Void, Never>?
    private var role: MediaTransportRole = .offerer
    private var previousOutboundStats: [String: OutboundRtpSnapshot] = [:]
    private var scrollHintSequence = 0
    private var detailSenderSuppressed = false

    init(factory: RTCPeerConnectionFactory, planeConfigurations: [MediaPlane: MediaPlaneConfiguration]) {
        self.factory = factory
        self.planeConfigurations = planeConfigurations
        var stateCont: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { stateCont = $0 }
        self.stateContinuation = stateCont
        super.init()
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSources: VideoPlaneSources?,
        videoSinks: VideoPlaneSinks?
    ) async throws {
        self.role = role
        self.signaling = signaling

        let config = RTCConfiguration()
        config.iceServers = []   // Tailscale-only, no STUN/TURN per SPEC.
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": kRTCMediaConstraintsValueTrue]
        )
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw MediaTransportError.notYetImplemented
        }
        peerConnection = pc
        stateContinuation.yield(.connecting)

        // ADR-0005: input now flows over a dedicated WSS (InputChannelServer);
        // the WebRTC PC carries only video.

        if let videoSources {
            for plane in MediaPlane.allCases {
                guard let videoSource = videoSources[plane],
                      let planeConfiguration = planeConfigurations[plane] else { continue }
                let rtcSource = factory.videoSource(forScreenCast: planeConfiguration.tuning.screencast)
                rtcVideoSources[plane] = rtcSource
                let capturer = WebRTCVideoCapturer(rtcSource: rtcSource, frameSource: videoSource, plane: plane)
                capturers[plane] = capturer
                let track = factory.videoTrack(with: rtcSource, trackId: plane.trackId)
                videoTracks[plane] = track
                if let sender = pc.add(track, streamIds: [plane.streamId]) {
                    videoSenders[plane] = sender
                    configureSenderForScreenShare(sender, configuration: planeConfiguration)
                    try applyCodecPreferences(on: pc, plane: plane, preferences: planeConfiguration.codecs)
                }
            }
            // Seed libwebrtc's Google Congestion Control bandwidth estimator
            // with our tuning values. Default GCC starts at ~600 kbps and
            // ramps slowly; on a wire we own (loopback or Tailnet) the encoder
            // shouldn't start in compromise mode.
            let bweTuning = planeConfigurations[.detail]?.tuning ?? SenderTuning.default
            pc.setBweMinBitrateBps(
                NSNumber(value: bweTuning.bweMinKbps * 1000),
                currentBitrateBps: NSNumber(value: bweTuning.bweStartKbps * 1000),
                maxBitrateBps: NSNumber(value: bweTuning.bweMaxKbps * 1000)
            )
            for plane in MediaPlane.allCases {
                try await capturers[plane]?.start()
            }
        }

        inboundTask = Task { [weak self, signaling] in
            for await frame in signaling.inbound {
                await self?.handle(frame: frame)
            }
        }

        if role == .offerer {
            try await sendOffer()
        }
    }

    func stop() {
        inboundTask?.cancel()
        inboundTask = nil
        capturers.values.forEach { $0.stop() }
        capturers.removeAll()
        videoSenders.removeAll()
        videoTracks.removeAll()
        rtcVideoSources.removeAll()
        peerConnection?.close()
        peerConnection = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    // Tune the outgoing video sender from the SenderTuning value. Every knob
    // here is configurable; see SenderTuning.fromEnvironment() for the env
    // vars that override individual fields.
    private func configureSenderForScreenShare(_ sender: RTCRtpSender, configuration: MediaPlaneConfiguration) {
        let profile = initialProfile(for: configuration)
        applyEncodingProfile(profile, to: sender, plane: configuration.plane, reason: "startup")
        logger.notice("tuning applied: plane=\(configuration.plane.rawValue, privacy: .public) codecs=\(configuration.codecs.preferred.map(\.rawValue).joined(separator: ","), privacy: .public) screencast=\(configuration.tuning.screencast, privacy: .public) scaleDown=\(profile.scaleResolutionDownBy, privacy: .public) temporalLayers=\(profile.temporalLayers, privacy: .public) degradation=\(profile.degradation.rawValue, privacy: .public) maxBitrate=\(profile.maxBitrateKbps, privacy: .public)kbps")
    }

    private func initialProfile(for configuration: MediaPlaneConfiguration) -> SenderTuning.EncodingProfile {
        configuration.plane == .motion
            ? configuration.tuning.scrollProfile
            : configuration.tuning.crispProfile
    }

    private func applyEncodingProfile(
        _ profile: SenderTuning.EncodingProfile,
        to sender: RTCRtpSender,
        plane: MediaPlane,
        reason: String
    ) {
        let params = sender.parameters
        params.degradationPreference = NSNumber(value: degradationRaw(profile.degradation))
        for encoding in params.encodings {
            encoding.isActive = profile.active
            encoding.scaleResolutionDownBy = NSNumber(value: profile.scaleResolutionDownBy)
            encoding.maxBitrateBps = NSNumber(value: profile.maxBitrateKbps * 1000)
            encoding.minBitrateBps = NSNumber(value: profile.minBitrateKbps * 1000)
            encoding.maxFramerate = NSNumber(value: profile.maxFramerate)
            // Temporal SVC so the scroll profile's bitrate squeeze sheds the
            // top layers instantly instead of forcing a resolution reconfig.
            if profile.temporalLayers > 1 {
                encoding.numTemporalLayers = NSNumber(value: profile.temporalLayers)
            }
        }
        sender.parameters = params
        logger.notice("sender profile applied reason=\(reason, privacy: .public) plane=\(plane.rawValue, privacy: .public) active=\(profile.active, privacy: .public) scaleDown=\(profile.scaleResolutionDownBy, privacy: .public) fps=\(profile.maxFramerate, privacy: .public) maxBitrate=\(profile.maxBitrateKbps, privacy: .public)kbps minBitrate=\(profile.minBitrateKbps, privacy: .public)kbps temporalLayers=\(profile.temporalLayers, privacy: .public) degradation=\(profile.degradation.rawValue, privacy: .public)")
    }

    // Dual-plane mode keeps both tracks warm, but scroll hides the detail
    // plane. Throttle the invisible detail sender so the motion sender does
    // not compete with full-resolution VP9 in libwebrtc's pacer.
    func setVideoInteractive(_ active: Bool) {
        scrollHintSequence += 1
        let phase = active ? "start" : "end"
        let sequence = scrollHintSequence
        applyDetailSuppression(active)
        let detailSender = detailSenderSuppressed ? "throttled" : "crisp"
        logger.notice("scroll-hint phase=\(phase, privacy: .public) sequence=\(sequence, privacy: .public) detailSender=\(detailSender, privacy: .public)")
        Task { [weak self] in
            await self?.logStats(reason: "scroll-\(phase)-\(sequence)")
        }
    }

    private func applyDetailSuppression(_ suppressed: Bool) {
        guard suppressed != detailSenderSuppressed else { return }
        guard let sender = videoSenders[.detail],
              let configuration = planeConfigurations[.detail] else {
            logger.error("detail sender missing; cannot apply scroll suppression=\(suppressed, privacy: .public)")
            return
        }
        let profile = suppressed
            ? configuration.tuning.detailScrollSuppressedProfile
            : configuration.tuning.crispProfile
        let reason = suppressed ? "scroll-detail-suppress" : "scroll-detail-restore"
        applyEncodingProfile(profile, to: sender, plane: .detail, reason: reason)
        detailSenderSuppressed = suppressed
    }

    private func degradationRaw(_ pref: SenderTuning.DegradationPreference) -> Int {
        switch pref {
        case .disabled:           return RTCDegradationPreference.disabled.rawValue
        case .maintainFramerate:  return RTCDegradationPreference.maintainFramerate.rawValue
        case .maintainResolution: return RTCDegradationPreference.maintainResolution.rawValue
        case .balanced:           return RTCDegradationPreference.balanced.rawValue
        }
    }

    // Restrict the video transceiver's codec list to the configured primary
    // codecs plus their matching RTX payloads. Preference-only ordering is
    // not enough for latency A/B runs: libwebrtc can still send a fallback
    // codec that remains in the list.
    private func applyCodecPreferences(on pc: RTCPeerConnection, plane: MediaPlane, preferences: MediaCodecPreferences) throws {
        let capabilities = factory.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo)
        let descriptors = capabilities.codecs.enumerated().map { index, codec in
            CodecCapabilityDescriptor(
                index: index,
                name: codec.name,
                preferredPayloadType: codec.preferredPayloadType?.stringValue,
                aptPayloadType: codec.parameters["apt"]
            )
        }
        let allowedIndexes = CodecPreferencePolicy.orderedAllowedIndexes(
            capabilities: descriptors,
            preferences: preferences
        )
        guard !allowedIndexes.isEmpty else {
            let wanted = preferences.preferredCodecNames.joined(separator: ",")
            logger.error("applyCodecPreferences: no compatible video codecs found plane=\(plane.rawValue, privacy: .public) codecs=\(wanted, privacy: .public)")
            throw MediaTransportError.unsupportedCodecPreference(wanted)
        }
        let ordered = allowedIndexes.map { capabilities.codecs[$0] }
        guard let transceiver = pc.transceivers.last(where: {
            $0.mediaType == .video && $0.sender.track?.trackId == plane.trackId
        }) else {
            logger.error("applyCodecPreferences: no video transceiver found plane=\(plane.rawValue, privacy: .public)")
            return
        }
        transceiver.setCodecPreferences(ordered)
        let pickedNames = ordered.map(\.name).joined(separator: ",")
        logger.notice("codec preferences set plane=\(plane.rawValue, privacy: .public): \(pickedNames, privacy: .public)")
    }

    private func sendOffer() async throws {
        guard let pc = peerConnection, let signaling else { return }
        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: [
                kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueFalse,
                kRTCMediaConstraintsOfferToReceiveVideo: kRTCMediaConstraintsValueTrue
            ],
            optionalConstraints: nil
        )
        let offer = try await pc.offer(for: offerConstraints)
        logger.notice("offer sdp:\n\(offer.sdp, privacy: .public)")
        logNegotiatedCodec(from: offer.sdp, label: "local offer")
        try await pc.setLocalDescription(offer)
        try await signaling.send(.offer(sdp: offer.sdp))
        startStatsLogger()
    }

    private func startStatsLogger() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self else { return }
                await self.logStats(reason: "periodic")
            }
        }
    }

    private func logStats(reason: String) async {
        guard let pc = peerConnection else { return }
        let report = await pc.statistics()
        let codecMimeTypes = codecMimeTypes(from: report.statistics)
        let midPlanes = transceiverMidPlanes(on: pc)
        for (id, stats) in report.statistics {
            if stats.type == "outbound-rtp" {
                let snapshot = OutboundRtpSnapshot(stats: stats)
                let previous = previousOutboundStats[id]
                previousOutboundStats[id] = snapshot
                let frames = stats.values["framesEncoded"].map { "\($0)" } ?? "?"
                let bytes = stats.values["bytesSent"].map { "\($0)" } ?? "?"
                let kbps = stats.values["targetBitrate"].map { "\($0)" } ?? "?"
                let codecId = stats.values["codecId"].map { "\($0)" } ?? "?"
                let codecMimeType = codecMimeTypes[codecId] ?? "?"
                let plane = planeName(fromOutboundStats: stats, midPlanes: midPlanes)
                if let mediaPlane = MediaPlane(rawValue: plane),
                   let preferences = planeConfigurations[mediaPlane]?.codecs,
                   codecMimeType != "?",
                   !preferences.allows(statsMimeType: codecMimeType) {
                    logger.error("outbound codec mismatch plane=\(plane, privacy: .public) configured=\(preferences.preferredCodecNames.joined(separator: ","), privacy: .public) actual=\(codecMimeType, privacy: .public) codecId=\(codecId, privacy: .public)")
                }
                let encoder = stats.values["encoderImplementation"].map { "\($0)" } ?? "?"
                let fps = stats.values["framesPerSecond"].map { "\($0)" } ?? "?"
                let qualityReason = stats.values["qualityLimitationReason"].map { "\($0)" } ?? "?"
                let framesDelta = formatDelta(current: snapshot.framesEncoded, previous: previous?.framesEncoded)
                let encodeMs = MediaTimingMath.formatMilliseconds(
                    MediaTimingMath.millisecondsPerUnit(
                        currentCount: snapshot.framesEncoded,
                        previousCount: previous?.framesEncoded,
                        currentTotalSeconds: snapshot.totalEncodeTime,
                        previousTotalSeconds: previous?.totalEncodeTime
                    )
                )
                let packetSendDelayMs = MediaTimingMath.formatMilliseconds(
                    MediaTimingMath.millisecondsPerUnit(
                        currentCount: snapshot.packetsSent,
                        previousCount: previous?.packetsSent,
                        currentTotalSeconds: snapshot.totalPacketSendDelay,
                        previousTotalSeconds: previous?.totalPacketSendDelay
                    )
                )
                logger.notice("outbound-rtp reason=\(reason, privacy: .public) plane=\(plane, privacy: .public) codec=\(codecMimeType, privacy: .public) codecId=\(codecId, privacy: .public) encoder=\(encoder, privacy: .public) framesEncoded=\(frames, privacy: .public) windowFrames=\(framesDelta, privacy: .public) encodeMsPerFrame=\(encodeMs, privacy: .public) packetSendDelayMsPerPacket=\(packetSendDelayMs, privacy: .public) fps=\(fps, privacy: .public) bytesSent=\(bytes, privacy: .public) targetBitrate=\(kbps, privacy: .public) qualityLimitation=\(qualityReason, privacy: .public)")
            }
        }
    }

    private func planeName(fromOutboundStats stats: RTCStatistics, midPlanes: [String: MediaPlane]) -> String {
        let trackId = stats.values["trackIdentifier"].map { "\($0)" }
        let mid = stats.values["mid"].map { "\($0)" }
        return OutboundRtpPlaneResolver.planeName(
            trackIdentifier: trackId,
            mid: mid,
            midPlanes: midPlanes
        )
    }

    private func transceiverMidPlanes(on pc: RTCPeerConnection) -> [String: MediaPlane] {
        var planes: [String: MediaPlane] = [:]
        for transceiver in pc.transceivers {
            let mid = transceiver.mid
            guard !mid.isEmpty,
                  let trackId = transceiver.sender.track?.trackId,
                  let plane = MediaPlane(trackId: trackId) else {
                continue
            }
            planes[mid] = plane
        }
        return planes
    }

    private func formatDelta(current: Double?, previous: Double?) -> String {
        guard let current, let previous else { return "?" }
        return String(format: "%.0f", current - previous)
    }

    private func codecMimeTypes(from statistics: [String: RTCStatistics]) -> [String: String] {
        var codecMimeTypes: [String: String] = [:]
        for (id, stats) in statistics where stats.type == "codec" {
            if let mimeType = stats.values["mimeType"].map({ "\($0)" }) {
                codecMimeTypes[id] = mimeType
            }
        }
        return codecMimeTypes
    }

    private func logNegotiatedCodec(from sdp: String, label: String) {
        guard let codec = SdpVideoCodecInspector.firstNegotiatedVideoCodec(in: sdp) else {
            logger.notice("\(label, privacy: .public) video codec unavailable")
            return
        }
        logger.notice("\(label, privacy: .public) video codec: \(codec.logSummary, privacy: .public)")
    }

    private func handle(frame: WebRTCSignalingFrame) async {
        guard let pc = peerConnection, let signaling else { return }
        do {
            switch frame {
            case .offer(let sdp):
                logNegotiatedCodec(from: sdp, label: "remote offer")
                let offer = RTCSessionDescription(type: .offer, sdp: sdp)
                try await pc.setRemoteDescription(offer)
                let answerConstraints = RTCMediaConstraints(
                    mandatoryConstraints: [
                        kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueFalse,
                        kRTCMediaConstraintsOfferToReceiveVideo: kRTCMediaConstraintsValueTrue
                    ],
                    optionalConstraints: nil
                )
                let answer = try await pc.answer(for: answerConstraints)
                logNegotiatedCodec(from: answer.sdp, label: "local answer")
                try await pc.setLocalDescription(answer)
                try await signaling.send(.answer(sdp: answer.sdp))
            case .answer(let sdp):
                logNegotiatedCodec(from: sdp, label: "remote answer")
                let answer = RTCSessionDescription(type: .answer, sdp: sdp)
                try await pc.setRemoteDescription(answer)
            case .ice(let sdp, let sdpMid, let sdpMLineIndex):
                let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: sdpMLineIndex, sdpMid: sdpMid)
                try await pc.add(candidate)
            }
        } catch {
            logger.error("webrtc frame handling failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - RTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        switch newState {
        case .new, .checking:
            stateContinuation.yield(.connecting)
        case .connected, .completed:
            stateContinuation.yield(.connected)
        case .disconnected:
            stateContinuation.yield(.disconnected)
        case .failed:
            stateContinuation.yield(.failed)
        case .closed:
            stateContinuation.yield(.closed)
        @unknown default:
            break
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard let signaling else { return }
        let sdp = candidate.sdp
        let sdpMid = candidate.sdpMid
        let sdpMLineIndex = candidate.sdpMLineIndex
        Task {
            try? await signaling.send(.ice(sdp: sdp, sdpMid: sdpMid, sdpMLineIndex: sdpMLineIndex))
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        // ADR-0005: video-only PC; any incoming data channel is unexpected.
        logger.notice("ignoring unexpected data channel label=\(dataChannel.label, privacy: .public)")
    }
}

private struct OutboundRtpSnapshot {
    let framesEncoded: Double?
    let packetsSent: Double?
    let totalEncodeTime: Double?
    let totalPacketSendDelay: Double?

    init(stats: RTCStatistics) {
        framesEncoded = Self.doubleValue(stats.values["framesEncoded"])
        packetsSent = Self.doubleValue(stats.values["packetsSent"])
        totalEncodeTime = Self.doubleValue(stats.values["totalEncodeTime"])
        totalPacketSendDelay = Self.doubleValue(stats.values["totalPacketSendDelay"])
    }

    private static func doubleValue(_ value: NSObject?) -> Double? {
        if let number = value as? NSNumber {
            return number.doubleValue
        }
        if let string = value as? String {
            return Double(string)
        }
        guard let value else { return nil }
        return Double("\(value)")
    }
}
