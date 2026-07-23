import Foundation

/// Requests the interaction webview posts to native. The first gesture slice
/// carries only a Space step; voice/pronunciation cases are added in a later
/// phase. Never crosses the QUIC wire — on iOS the surface translates it to the
/// existing `NormalizedInput.switchSpaceStep` frame.
public enum InteractionPanelRequest: Equatable, Sendable {
    case spaceStep(delta: Int)

    public static func decode(tag: String, body: [String: Any]) -> InteractionPanelRequest? {
        switch tag {
        case "spaceStep":
            guard let delta = body["delta"] as? Int, delta == -1 || delta == 1 else {
                return nil
            }
            return .spaceStep(delta: delta)
        default:
            return nil
        }
    }
}

@MainActor
public protocol InteractionPanelTransport: AnyObject {
    func sendInteractionRequest(_ request: InteractionPanelRequest)
}
