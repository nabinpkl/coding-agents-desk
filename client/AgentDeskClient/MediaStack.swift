import Foundation
import UIKit

enum MediaStack {
    static func makeFactory(
        host: String?,
        active: ActiveSession?,
        mediaCapability: MediaCapabilityGrant?,
        mediaCapabilityRefresher: MediaCapabilityRefreshing?
    ) -> MediaTransportFactory {
        guard let host, let active, let mediaCapability else {
            return MissingOwnedMediaTransportFactory()
        }
        return OwnedMediaTransportFactory(
            host: host,
            active: active,
            mediaCapability: mediaCapability,
            mediaCapabilityRefresher: mediaCapabilityRefresher
        )
    }

    @MainActor
    static func makeVideoSink() -> VideoFrameSink {
        OwnedMediaVideoSink()
    }
}

private struct MissingOwnedMediaTransportFactory: MediaTransportFactory {
    func make() -> MediaTransport {
        MissingOwnedMediaTransport()
    }
}

private final class MissingOwnedMediaTransport: MediaTransport, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState> = AsyncStream { continuation in
        continuation.yield(.failed(nil))
        continuation.finish()
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        throw MediaTransportError.notYetImplemented
    }

    func stop() {}
}
