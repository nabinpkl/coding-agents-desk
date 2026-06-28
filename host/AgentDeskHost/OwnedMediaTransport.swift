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
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    let connectionState: AsyncStream<MediaConnectionState>
    private let encodeGate = OSAllocatedUnfairLock<EncodeState>(initialState: EncodeState())
    private var controlTask: Task<Void, Never>?
    private var forceNextKeyframe = false

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
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func enqueue(_ frame: CapturedVideoFrame) {
        let shouldStart = encodeGate.withLock { state -> Bool in
            state.latest = frame
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
            let frame = encodeGate.withLock { state -> CapturedVideoFrame? in
                let frame = state.latest
                state.latest = nil
                if frame == nil {
                    state.encoding = false
                }
                return frame
            }
            guard let frame else { return }
            let forceKeyframe = encodeGate.withLock { state -> Bool in
                defer { state.forceKeyframe = false }
                return state.forceKeyframe
            }
            guard let envelope = await encoder.encode(
                frame,
                updateId: OwnedSurfaceUpdateId(surfaceGeneration: 0, frameId: 0),
                forceKeyframe: forceKeyframe,
                requestedKeyframeReason: forceKeyframe ? OwnedMediaKeyframeReason.clientRequest : nil
            ) else {
                continue
            }
            await send(envelope)
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
        encodeGate.withLock { state in
            state.resendRing.remember(frameId: envelope.header.frameId, packets: packets)
        }
        for packet in packets {
            do {
                try await datagrams.send(packet)
            } catch {
                logger.error("video datagram send failed: \(String(describing: error), privacy: .public)")
                stateContinuation.yield(.failed)
                return
            }
        }
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
            encodeGate.withLock { state in
                state.forceKeyframe = true
            }
        case .packetResendRequest:
            let packets = encodeGate.withLock { state in
                state.resendRing.packets(
                    frameId: message.frameId,
                    indexes: message.packetIndexes,
                    maxCount: Config.ownedMediaMaxResendPackets
                ).packets.map { $0.1 }
            }
            Task { [datagrams] in
                for packet in packets {
                    try? await datagrams.send(packet)
                }
            }
        case .frameAck:
            break
        case .graphicsResetRequest:
            break
        case .keepalive:
            break
        case .linkHealth:
            logger.debug("link health completed=\(message.linkHealthCompletedFrames ?? 0, privacy: .public) expired=\(message.linkHealthExpiredFrames ?? 0, privacy: .public)")
        }
    }

    private struct EncodeState {
        var latest: CapturedVideoFrame?
        var encoding = false
        var forceKeyframe = false
        var resendRing = OwnedMediaResendRing(capacityFrames: Config.ownedMediaResendRingFrames)
    }
}
