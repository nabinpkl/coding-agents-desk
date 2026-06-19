import Foundation
import UIKit

// ADR-0004 composition root, client side. Mirror of
// host/AgentDeskHost/MediaStack.swift. The only file that names concrete
// impls. R8.6.1 ships stub factories that throw; real impls land in
// R8.6.4+.

enum MediaStack {
    static func makeFactory() -> MediaTransportFactory {
        LibWebRTCTransportFactory(planeCodecs: MediaCodecPreferences.defaultPlanes)
    }

    static func makeFactory(
        mode: MediaMode,
        host: String?,
        port: UInt16,
        active: ActiveSession?,
        mediaCapability: MediaCapabilityGrant?,
        urlSession: URLSession
    ) -> MediaTransportFactory {
        switch mode {
        case .webrtc:
            return makeFactory()
        case .owned:
            guard let host, let active, let mediaCapability else {
                return makeFactory()
            }
            return OwnedMediaTransportFactory(
                host: host,
                port: port,
                active: active,
                mediaCapability: mediaCapability
            )
        }
    }

    @MainActor
    static func makeVideoSink(mode: MediaMode = .webrtc, activePlanes: [MediaPlane] = MediaPlane.allCases) -> VideoFrameSink {
        switch mode {
        case .webrtc:
            return DualPlaneVideoSink()
        case .owned:
            return OwnedMediaVideoSink()
        }
    }
}
