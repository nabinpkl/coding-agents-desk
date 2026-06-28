import CryptoKit
import Foundation
import UIKit

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws

    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed(SessionRejected?)
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

enum MediaTransportError: Error {
    case notYetImplemented
}

struct ClientGraphicsConnectionPlan: Equatable {
    let host: String
    let port: UInt16
    let alpn: String
    let usesDatagrams: Bool

    init(
        host: String,
        port: UInt16 = Config.graphicsPort,
        alpn: String = ClientGraphicsChannelHandshake.quicALPN,
        usesDatagrams: Bool = false
    ) {
        self.host = host
        self.port = port
        self.alpn = alpn
        self.usesDatagrams = usesDatagrams
    }
}

struct GraphicsReconnectPolicy: Equatable, Sendable {
    let initialDelayMs: Int
    let maxDelayMs: Int
    let maxAttempts: Int

    func delayMs(forAttempt attempt: Int) -> Int? {
        guard attempt > 0, attempt <= maxAttempts else { return nil }
        let shift = min(attempt - 1, 12)
        let multiplied = initialDelayMs.multipliedReportingOverflow(by: 1 << shift)
        let uncapped = multiplied.overflow ? maxDelayMs : multiplied.partialValue
        return min(max(uncapped, initialDelayMs), maxDelayMs)
    }
}

enum ClientGraphicsChannelHandshake {
    static let quicALPN = "agentdesk-owned-graphics"

    static func graphicsCapability(from mediaCapability: String) -> String {
        mediaCapability
    }

    static func makeHello(
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant,
        clientNonce: Data
    ) -> GraphicsChannelHello {
        GraphicsChannelHello(
            deviceFingerprint: active.deviceFingerprint,
            sessionId: active.sessionId,
            graphicsCapability: graphicsCapability(from: mediaCapability.mediaCapability),
            clientNonce: clientNonce
        )
    }

    static func validateReady(
        _ ready: GraphicsChannelReady,
        expectedSessionId: String
    ) throws -> GraphicsChannelReady {
        guard ready.type == "graphics-ready",
              ready.sessionId == expectedSessionId,
              !ready.serverNonce.isEmpty else {
            throw SessionRejected(reason: .malformed)
        }
        return ready
    }
}

// VideoFrameSource is the host-side capture seam. The client mirror exists
// so MediaTransport.start can carry one signature on both sides; the
// client never instantiates a source.
protocol VideoFrameSource: AnyObject, Sendable {
    func start() async throws
    func stop()
}

protocol VideoFrameSink: AnyObject, Sendable {
    @MainActor var view: UIView { get }
}
