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

final class LibWebRTCMediaTransport: NSObject, MediaTransport, RTCPeerConnectionDelegate, RTCVideoViewDelegate, RTCDataChannelDelegate, @unchecked Sendable {
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
    // R9.1: host-created input data channel. Same weak-delegate caution as
    // the video track applies. Strong ref keeps the channel alive between
    // didOpen and the first send.
    private var inputDataChannel: RTCDataChannel?
    private let inputEncoder = JSONEncoder()

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
        inputDataChannel?.close()
        inputDataChannel = nil
        peerConnection?.close()
        peerConnection = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    func send(_ input: NormalizedInput) throws {
        guard let channel = inputDataChannel, channel.readyState == .open else {
            throw MediaTransportError.inputChannelNotOpen
        }
        let payload: Data
        do {
            payload = try inputEncoder.encode(input)
        } catch {
            throw MediaTransportError.inputEncodeFailed
        }
        let buffer = RTCDataBuffer(data: payload, isBinary: false)
        if !channel.sendData(buffer) {
            throw MediaTransportError.inputChannelNotOpen
        }
    }

    private func handle(frame: WebRTCSignalingFrame) async {
        guard let pc = peerConnection, let signaling else { return }
        do {
            switch frame {
            case .offer(let sdp):
                let offer = RTCSessionDescription(type: .offer, sdp: sdp)
                try await pc.setRemoteDescription(offer)
                // Unified-plan: transceivers exist after setRemoteDescription.
                // The legacy `didAdd stream` callback often doesn't fire in
                // newer libwebrtc builds, so enumerate directly.
                attachRemoteTracksFromTransceivers(pc: pc)
                let answerConstraints = RTCMediaConstraints(
                    mandatoryConstraints: nil,
                    optionalConstraints: nil
                )
                let answer = try await pc.answer(for: answerConstraints)
                try await pc.setLocalDescription(answer)
                try await signaling.send(.answer(sdp: answer.sdp))
                startStatsLogger()
            case .answer(let sdp):
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
        for (_, stats) in report.statistics {
            if stats.type == "inbound-rtp" {
                let frames = stats.values["framesReceived"].map { "\($0)" } ?? "?"
                let decoded = stats.values["framesDecoded"].map { "\($0)" } ?? "?"
                let bytes = stats.values["bytesReceived"].map { "\($0)" } ?? "?"
                let packetsLost = stats.values["packetsLost"].map { "\($0)" } ?? "?"
                logger.notice("inbound-rtp framesReceived=\(frames, privacy: .public) framesDecoded=\(decoded, privacy: .public) bytesReceived=\(bytes, privacy: .public) packetsLost=\(packetsLost, privacy: .public)")
            }
        }
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
        // R9.1: the host creates a single "input" data channel in its offer.
        // We retain a strong ref and become its delegate so the state log
        // tells us when send() will start working.
        guard dataChannel.label == "input" else {
            logger.notice("ignoring unexpected data channel label=\(dataChannel.label, privacy: .public)")
            return
        }
        dataChannel.delegate = self
        inputDataChannel = dataChannel
        logger.notice("input data channel attached; readyState=\(String(describing: dataChannel.readyState), privacy: .public)")
    }

    // MARK: - RTCDataChannelDelegate

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        logger.notice("input data channel state=\(String(describing: dataChannel.readyState), privacy: .public)")
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        // No server-to-client traffic on the input channel in v0.
    }
}

final class DebugFrameProbeRenderer: NSObject, RTCVideoRenderer, @unchecked Sendable {
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "webrtc")
    private var count = 0
    private var lastSize: CGSize = .zero

    func setSize(_ size: CGSize) {
        lastSize = size
        logger.notice("probe setSize \(Int(size.width), privacy: .public)x\(Int(size.height), privacy: .public)")
    }

    func renderFrame(_ frame: RTCVideoFrame?) {
        count += 1
        if count % 30 == 1 {
            let w = frame?.width ?? 0
            let h = frame?.height ?? 0
            logger.notice("probe renderFrame #\(self.count, privacy: .public) size=\(w, privacy: .public)x\(h, privacy: .public)")
        }
    }
}
