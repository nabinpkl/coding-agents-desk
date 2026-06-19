import Foundation
import UIKit

enum MediaStack {
    static func makeFactory(
        host: String?,
        port: UInt16,
        active: ActiveSession?,
        mediaCapability: MediaCapabilityGrant?
    ) -> MediaTransportFactory {
        guard let host, let active, let mediaCapability else {
            return MissingOwnedMediaTransportFactory()
        }
        return OwnedMediaTransportFactory(
            host: host,
            port: port,
            active: active,
            mediaCapability: mediaCapability
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
        continuation.yield(.failed)
        continuation.finish()
    }

    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws {
        throw MediaTransportError.notYetImplemented
    }

    func stop() {}
}
