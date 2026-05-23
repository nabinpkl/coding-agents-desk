import Foundation
import UIKit

// ADR-0004 composition root, client side. Mirror of
// host/AgentDeskHost/MediaStack.swift. The only file that names concrete
// impls. R8.6.1 ships stub factories that throw; real impls land in
// R8.6.4+.

enum MediaStack {
    static func makeFactory() -> MediaTransportFactory {
        StubMediaTransportFactory(codecs: .h264Only)
    }

    @MainActor
    static func makeVideoSink() -> VideoFrameSink {
        StubVideoFrameSink()
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

@MainActor
private final class StubVideoFrameSink: VideoFrameSink {
    let view: UIView

    init() {
        self.view = UIView()
    }
}
