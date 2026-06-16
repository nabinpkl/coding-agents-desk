import Foundation
import WebRTC
import os

// ADR-0004 concrete MediaTransport impl, client side. Mirror of the host
// impl with role typically .answerer: the client doesn't add a local
// video track and instead attaches the remote track from the peer
// connection to the supplied VideoFrameSink.

final class LibWebRTCTransportFactory: MediaTransportFactory {
    let codecs: MediaCodecPreferences
    private let factory: RTCPeerConnectionFactory

    init(codecs: MediaCodecPreferences) {
        self.codecs = codecs
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
        LibWebRTCMediaTransport(factory: factory, codecs: codecs)
    }
}

final class LibWebRTCMediaTransport: NSObject, MediaTransport, RTCPeerConnectionDelegate, RTCVideoViewDelegate, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation

    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "webrtc")
    private let factory: RTCPeerConnectionFactory
    private let codecs: MediaCodecPreferences
    private var peerConnection: RTCPeerConnection?
    private var signaling: SignalingChannel?
    private var videoSink: VideoFrameSink?
    private var inboundTask: Task<Void, Never>?
    private var role: MediaTransportRole = .answerer
    // libwebrtc keeps weak refs from the receiver into renderers; without a
    // strong Swift-side ref the track is deallocated between attach-time and
    // first-frame delivery, and renderFrame: is never invoked. Mirrors the
    // host-side rtcVideoSource retention.
    private var remoteVideoTrack: RTCVideoTrack?
    private var previousInboundStats: [String: InboundRtpSnapshot] = [:]
    // ADR-0005: input no longer rides this transport. The video-only PC
    // doesn't allocate a data channel; the dedicated InputChannel owns
    // its own WebSocket lifecycle.

    init(factory: RTCPeerConnectionFactory, codecs: MediaCodecPreferences) {
        self.factory = factory
        self.codecs = codecs
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
        super.init()
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSource: VideoFrameSource?,
        videoSink: VideoFrameSink?
    ) async throws {
        self.role = role
        self.signaling = signaling
        self.videoSink = videoSink

        let config = RTCConfiguration()
        config.iceServers = []
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

        inboundTask = Task { [weak self, signaling] in
            for await frame in signaling.inbound {
                await self?.handle(frame: frame)
            }
        }
    }

    func stop() {
        inboundTask?.cancel()
        inboundTask = nil
        remoteVideoTrack = nil
        peerConnection?.close()
        peerConnection = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func handle(frame: WebRTCSignalingFrame) async {
        guard let pc = peerConnection, let signaling else { return }
        do {
            switch frame {
            case .offer(let sdp):
                logNegotiatedCodec(from: sdp, label: "remote offer")
                let offer = RTCSessionDescription(type: .offer, sdp: sdp)
                try await pc.setRemoteDescription(offer)
                // Unified-plan: transceivers exist after setRemoteDescription.
                // The legacy `didAdd stream` callback often doesn't fire in
                // newer libwebrtc builds, so enumerate directly.
                attachRemoteTracksFromTransceivers(pc: pc)
                try applyCodecPreferences(on: pc)
                let answerConstraints = RTCMediaConstraints(
                    mandatoryConstraints: nil,
                    optionalConstraints: nil
                )
                let answer = try await pc.answer(for: answerConstraints)
                logNegotiatedCodec(from: answer.sdp, label: "local answer")
                try await pc.setLocalDescription(answer)
                try await signaling.send(.answer(sdp: answer.sdp))
                startStatsLogger()
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

    private func attachRemoteTracksFromTransceivers(pc: RTCPeerConnection) {
        for transceiver in pc.transceivers {
            if transceiver.mediaType == .video,
               let track = transceiver.receiver.track as? RTCVideoTrack {
                logger.notice("attaching remote video track id=\(track.trackId, privacy: .public)")
                attachRemote(track: track)
                return
            }
        }
        logger.error("no remote video transceiver found after setRemoteDescription")
    }

    private let debugProbeRenderer = DebugFrameProbeRenderer()

    private func attachRemote(track: RTCVideoTrack) {
        if remoteVideoTrack === track {
            return
        }
        guard let sink = videoSink as? RTCMTLVideoSink else {
            logger.error("videoSink is not an RTCMTLVideoSink; cannot attach remote track")
            return
        }
        track.isEnabled = true
        remoteVideoTrack = track
        sink.renderer.delegate = self
        track.add(sink.renderer)
        track.add(debugProbeRenderer)
        logger.notice("renderer subscribed to track id=\(track.trackId, privacy: .public) isEnabled=\(track.isEnabled, privacy: .public)")
    }

    // Restrict the answer's video codec list to the configured primary codecs
    // plus matching RTX payloads. The client is the decoder side, so this is
    // where a hardware-decode A/B run rejects software-codec fallbacks.
    private func applyCodecPreferences(on pc: RTCPeerConnection) throws {
        let capabilities = factory.rtpReceiverCapabilities(forKind: kRTCMediaStreamTrackKindVideo)
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
            preferences: codecs
        )
        guard !allowedIndexes.isEmpty else {
            let wanted = codecs.preferredCodecNames.joined(separator: ",")
            logger.error("applyCodecPreferences: no compatible video codecs found for \(wanted, privacy: .public)")
            throw MediaTransportError.unsupportedCodecPreference(wanted)
        }
        let ordered = allowedIndexes.map { capabilities.codecs[$0] }
        guard let transceiver = pc.transceivers.first(where: { $0.mediaType == .video }) else {
            logger.error("applyCodecPreferences: no video transceiver found")
            return
        }
        transceiver.setCodecPreferences(ordered)
        let pickedNames = ordered.map(\.name).joined(separator: ",")
        logger.notice("codec preferences set: \(pickedNames, privacy: .public)")
    }

    private func startStatsLogger() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self else { return }
                await self.logStats()
            }
        }
    }

    private func logStats() async {
        guard let pc = peerConnection else { return }
        let report = await pc.statistics()
        let codecMimeTypes = codecMimeTypes(from: report.statistics)
        for (id, stats) in report.statistics {
            if stats.type == "inbound-rtp" {
                let snapshot = InboundRtpSnapshot(stats: stats)
                let previous = previousInboundStats[id]
                previousInboundStats[id] = snapshot
                let frames = stats.values["framesReceived"].map { "\($0)" } ?? "?"
                let decoded = stats.values["framesDecoded"].map { "\($0)" } ?? "?"
                let bytes = stats.values["bytesReceived"].map { "\($0)" } ?? "?"
                let packetsLost = stats.values["packetsLost"].map { "\($0)" } ?? "?"
                let codecId = stats.values["codecId"].map { "\($0)" } ?? "?"
                let codecMimeType = codecMimeTypes[codecId] ?? "?"
                if codecMimeType != "?", !codecs.allows(statsMimeType: codecMimeType) {
                    logger.error("inbound codec mismatch configured=\(self.codecs.preferredCodecNames.joined(separator: ","), privacy: .public) actual=\(codecMimeType, privacy: .public) codecId=\(codecId, privacy: .public)")
                }
                let decoder = stats.values["decoderImplementation"].map { "\($0)" } ?? "?"
                let dropped = stats.values["framesDropped"].map { "\($0)" } ?? "?"
                let decodeTime = stats.values["totalDecodeTime"].map { "\($0)" } ?? "?"
                let jitterDelay = stats.values["jitterBufferDelay"].map { "\($0)" } ?? "?"
                let jitterFrames = stats.values["jitterBufferEmittedCount"].map { "\($0)" } ?? "?"
                let framesDelta = formatDelta(current: snapshot.framesDecoded, previous: previous?.framesDecoded)
                let decodeMs = MediaTimingMath.formatMilliseconds(
                    MediaTimingMath.millisecondsPerUnit(
                        currentCount: snapshot.framesDecoded,
                        previousCount: previous?.framesDecoded,
                        currentTotalSeconds: snapshot.totalDecodeTime,
                        previousTotalSeconds: previous?.totalDecodeTime
                    )
                )
                let jitterMs = MediaTimingMath.formatMilliseconds(
                    MediaTimingMath.millisecondsPerUnit(
                        currentCount: snapshot.jitterBufferEmittedCount,
                        previousCount: previous?.jitterBufferEmittedCount,
                        currentTotalSeconds: snapshot.jitterBufferDelay,
                        previousTotalSeconds: previous?.jitterBufferDelay
                    )
                )
                let playoutTimestamp = stats.values["estimatedPlayoutTimestamp"].map { "\($0)" } ?? "?"
                logger.notice("inbound-rtp codec=\(codecMimeType, privacy: .public) codecId=\(codecId, privacy: .public) decoder=\(decoder, privacy: .public) framesReceived=\(frames, privacy: .public) framesDecoded=\(decoded, privacy: .public) windowDecoded=\(framesDelta, privacy: .public) decodeMsPerFrame=\(decodeMs, privacy: .public) jitterMsPerFrame=\(jitterMs, privacy: .public) framesDropped=\(dropped, privacy: .public) bytesReceived=\(bytes, privacy: .public) packetsLost=\(packetsLost, privacy: .public) totalDecodeTime=\(decodeTime, privacy: .public) jitterDelay=\(jitterDelay, privacy: .public) jitterFrames=\(jitterFrames, privacy: .public) estimatedPlayoutTimestamp=\(playoutTimestamp, privacy: .public)")
            }
        }
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

    // MARK: - RTCVideoViewDelegate

    func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
        logger.notice("videoView didChangeVideoSize \(Int(size.width), privacy: .public)x\(Int(size.height), privacy: .public)")
    }

    // MARK: - RTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        // Legacy callback kept as a fallback; primary path is
        // attachRemoteTracksFromTransceivers in handle(.offer).
        guard let track = stream.videoTracks.first else { return }
        attachRemote(track: track)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
        if let track = transceiver.receiver.track as? RTCVideoTrack {
            logger.notice("didStartReceivingOn fired for video")
            attachRemote(track: track)
        }
    }

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
        // ADR-0005: video-only PC; the host should not be creating data
        // channels. Log so a regression surfaces.
        logger.notice("ignoring unexpected data channel label=\(dataChannel.label, privacy: .public)")
    }
}

final class DebugFrameProbeRenderer: NSObject, RTCVideoRenderer, @unchecked Sendable {
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "webrtc")
    private var count = 0
    private var lastSize: CGSize = .zero
    private var lastRenderUptimeNs: UInt64?
    private var lastFrameTimestampNs: Int64?

    func setSize(_ size: CGSize) {
        lastSize = size
        logger.notice("probe setSize \(Int(size.width), privacy: .public)x\(Int(size.height), privacy: .public)")
    }

    func renderFrame(_ frame: RTCVideoFrame?) {
        count += 1
        if count % 30 == 1 {
            let nowNs = DispatchTime.now().uptimeNanoseconds
            let callbackWindowMs = MediaTimingMath.formatMilliseconds(
                MediaTimingMath.millisecondsBetween(currentNs: nowNs, previousNs: lastRenderUptimeNs)
            )
            let mediaWindowMs: String
            if let frame, let lastFrameTimestampNs, frame.timeStampNs >= lastFrameTimestampNs {
                mediaWindowMs = MediaTimingMath.formatMilliseconds(
                    Double(frame.timeStampNs - lastFrameTimestampNs) / 1_000_000.0
                )
            } else {
                mediaWindowMs = "?"
            }
            let w = frame?.width ?? 0
            let h = frame?.height ?? 0
            logger.notice("render-callback frame=\(self.count, privacy: .public) callbackWindowMs=\(callbackWindowMs, privacy: .public) mediaWindowMs=\(mediaWindowMs, privacy: .public) size=\(w, privacy: .public)x\(h, privacy: .public)")
            lastRenderUptimeNs = nowNs
            lastFrameTimestampNs = frame?.timeStampNs
        }
    }
}

private struct InboundRtpSnapshot {
    let framesDecoded: Double?
    let totalDecodeTime: Double?
    let jitterBufferDelay: Double?
    let jitterBufferEmittedCount: Double?

    init(stats: RTCStatistics) {
        framesDecoded = Self.doubleValue(stats.values["framesDecoded"])
        totalDecodeTime = Self.doubleValue(stats.values["totalDecodeTime"])
        jitterBufferDelay = Self.doubleValue(stats.values["jitterBufferDelay"])
        jitterBufferEmittedCount = Self.doubleValue(stats.values["jitterBufferEmittedCount"])
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
