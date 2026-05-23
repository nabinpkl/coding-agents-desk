import Foundation

// ADR-0004 protocol seam. Mirror of host/AgentDeskHost/MediaTransport.swift.
// The only files that import WebRTC are the LibWebRTC* impls; PairingClient
// holds a MediaTransportFactory by protocol.

protocol MediaTransport: AnyObject {
    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSource: VideoFrameSource?,
        videoSink: VideoFrameSink?
    ) async throws

    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

enum MediaTransportRole {
    case offerer
    case answerer
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

struct MediaCodecPreferences: Equatable {
    var preferred: [VideoCodec]

    enum VideoCodec: String, Equatable, Codable {
        case h264
        case h265
        case vp8
        case vp9
        case av1
    }

    static let h264Only = MediaCodecPreferences(preferred: [.h264])
}

enum MediaTransportError: Error {
    case notYetImplemented
}

// VideoFrameSource is the host-side capture seam. The client mirror exists
// so MediaTransport.start can carry one signature on both sides; the
// client never instantiates a source.
protocol VideoFrameSource: AnyObject {
    func start() async throws
    func stop()
}
