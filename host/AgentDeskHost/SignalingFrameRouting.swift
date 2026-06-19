import Foundation

// Pure routing helpers for the post-SessionReady dispatcher. Extracted from
// PairingSignalingServer so the host test target can exercise the routing
// logic without compiling the NWListener machinery.

enum FirstFrameRoute: Equatable {
    case pair
    case sessionInit
    case inputHello
    case malformed
}

enum ActiveSessionFrameRoute: Equatable {
    case webrtc(WebRTCSignalingFrame)
    case inputCapabilityRefresh(InputCapabilityRefreshRequest)
    case malformed
}

struct FirstFrameEnvelope: Decodable {
    let type: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case typeLong = "type"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let t = try container.decodeIfPresent(String.self, forKey: .type) {
            self.type = t
        } else if let t = try container.decodeIfPresent(String.self, forKey: .typeLong) {
            self.type = t
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "no type field"))
        }
    }
}

enum SignalingFrameRouter {
    static func classifyFirstFrame(_ data: Data) -> FirstFrameRoute {
        guard let envelope = try? JSONDecoder().decode(FirstFrameEnvelope.self, from: data) else {
            return .malformed
        }
        switch envelope.type {
        case "pair": return .pair
        case "session-init": return .sessionInit
        case "input-hello": return .inputHello
        default: return .malformed
        }
    }

    static func classifyActiveSessionFrame(_ data: Data) -> ActiveSessionFrameRoute {
        if let frame = try? JSONDecoder().decode(WebRTCSignalingFrame.self, from: data) {
            return .webrtc(frame)
        }
        if let request = try? JSONDecoder().decode(InputCapabilityRefreshRequest.self, from: data),
           request.type == "input-capability-refresh" {
            return .inputCapabilityRefresh(request)
        }
        return .malformed
    }
}
