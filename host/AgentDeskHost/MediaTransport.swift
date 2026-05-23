import Foundation

// ADR-0004 protocol seam. Anything that wants to swap WebRTC stacks, codecs,
// renderers, or capturers does it behind this surface. The only files that
// import WebRTC are the LibWebRTC* impls; AppDelegate holds a
// MediaTransportFactory by protocol.

protocol MediaTransport: AnyObject, Sendable {
    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSource: VideoFrameSource?,
        videoSink: VideoFrameSink?
    ) async throws

    func stop()

    // Single-consumer stream. Impls construct one continuation per instance.
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

// Codec choice is data, not code. v0 ships [.h264]; HEVC flip is one line in
// MediaStack. Order is preference; the underlying impl negotiates the first
// supported case.
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

// Marker protocol so MediaTransport.start carries one signature on both
// sides. The concrete view type is platform-specific and accessed via the
// impl, not the protocol; the host never instantiates a sink.
protocol VideoFrameSink: AnyObject {}
