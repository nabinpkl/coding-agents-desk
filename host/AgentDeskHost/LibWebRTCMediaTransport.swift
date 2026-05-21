import Foundation
import WebRTC
import os

// ADR-0004 concrete MediaTransport impl, host side. This is the only file
// (alongside WebRTCVideoCapturer) that imports WebRTC on the host. Everything
// outside this file talks to the MediaTransport protocol; swapping the
// WebRTC library replaces this file and no others.

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

final class LibWebRTCMediaTransport: NSObject, MediaTransport, RTCPeerConnectionDelegate, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "webrtc")
    private let factory: RTCPeerConnectionFactory
    private let codecs: MediaCodecPreferences
    private var peerConnection: RTCPeerConnection?
    private var capturer: WebRTCVideoCapturer?
    // RTCVideoCapturer.delegate is weak in libwebrtc, so this video source
    // must be retained on self even though the RTCVideoTrack also holds it.
    // Without this strong reference the capturer's delegate goes nil between
    // start() returning and the first frame being delivered.
    private var rtcVideoSource: RTCVideoSource?
    private var videoTrack: RTCVideoTrack?
    private var signaling: SignalingChannel?
    private var inboundTask: Task<Void, Never>?
    private var role: MediaTransportRole = .offerer

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

        if let videoSource {
            let rtcSource = factory.videoSource()
            self.rtcVideoSource = rtcSource
            let capturer = WebRTCVideoCapturer(rtcSource: rtcSource, frameSource: videoSource)
            self.capturer = capturer
            let track = factory.videoTrack(with: rtcSource, trackId: "video0")
            self.videoTrack = track
            pc.add(track, streamIds: ["stream0"])
            try await capturer.start()
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
        capturer?.stop()
        capturer = nil
        videoTrack = nil
        rtcVideoSource = nil
        peerConnection?.close()
        peerConnection = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
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
        try await pc.setLocalDescription(offer)
        try await signaling.send(.offer(sdp: offer.sdp))
        startStatsLogger()
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
            if stats.type == "outbound-rtp" {
                let frames = stats.values["framesEncoded"].map { "\($0)" } ?? "?"
                let bytes = stats.values["bytesSent"].map { "\($0)" } ?? "?"
                let kbps = stats.values["targetBitrate"].map { "\($0)" } ?? "?"
                logger.notice("outbound-rtp framesEncoded=\(frames, privacy: .public) bytesSent=\(bytes, privacy: .public) targetBitrate=\(kbps, privacy: .public)")
            }
        }
    }

    private func handle(frame: WebRTCSignalingFrame) async {
        guard let pc = peerConnection, let signaling else { return }
        do {
            switch frame {
            case .offer(let sdp):
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
                try await pc.setLocalDescription(answer)
                try await signaling.send(.answer(sdp: answer.sdp))
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
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
