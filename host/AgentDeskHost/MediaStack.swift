import Foundation

// ADR-0004 composition root. The only file that names concrete impls.
// Swapping the WebRTC library, codec, or capturer is editing this file and
// no other. R8.6.1 ships stub factories that throw; real impls land in
// R8.6.3+.

enum MediaStack {
    static func makeFactory() -> MediaTransportFactory {
        StubMediaTransportFactory(codecs: .h264Only)
    }

    static func makeFrameSource() -> VideoFrameSource {
        StubVideoFrameSource()
    }
}

private struct StubMediaTransportFactory: MediaTransportFactory {
    let codecs: MediaCodecPreferences

    func make() -> MediaTransport {
        StubMediaTransport()
    }
}

private final class StubMediaTransport: MediaTransport {
    let connectionState: AsyncStream<MediaConnectionState>
    private let continuation: AsyncStream<MediaConnectionState>.Continuation

    init() {
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSource: VideoFrameSource?,
        videoSink: VideoFrameSink?
    ) async throws {
        throw MediaTransportError.notYetImplemented
    }

    func stop() {
        continuation.finish()
    }
}

private final class StubVideoFrameSource: VideoFrameSource {
    let frames: AsyncStream<CapturedVideoFrame>
    private let continuation: AsyncStream<CapturedVideoFrame>.Continuation

    init() {
        var continuation: AsyncStream<CapturedVideoFrame>.Continuation!
        frames = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func start() async throws {
        throw MediaTransportError.notYetImplemented
    }

    func stop() {
        continuation.finish()
    }
}
