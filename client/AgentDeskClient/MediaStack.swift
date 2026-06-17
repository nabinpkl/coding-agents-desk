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

    @MainActor
    static func makeVideoSink() -> VideoFrameSink {
        DualPlaneVideoSink()
    }
}
