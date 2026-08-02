import Foundation
import WebPanelKit

extension WebPanelContract {
    /// The gesture/voice interaction panel's JS contract. Distinct scheme and
    /// handler names from AgentPanel so the two bundles never collide.
    public static let interaction = WebPanelContract(
        scheme: "interactionfeed",
        host: "app",
        indexPath: "index.html",
        messageHandlerName: "interaction",
        deliveryFunctionName: "__interactionDeliver",
        bridgeGlobalName: "__interactionBridge"
    )

    /// The compact macOS all-Spaces dictation panel. It deliberately uses the
    /// same bridge namespace as the full interaction panel, but has an
    /// independent HTML entry so it never mounts gesture or library UI.
    public static let dictation = WebPanelContract(
        scheme: "interactionfeed",
        host: "app",
        indexPath: "dictation.html",
        messageHandlerName: "interaction",
        deliveryFunctionName: "__interactionDeliver",
        bridgeGlobalName: "__interactionBridge"
    )
}

public enum InteractionPanelResources {
    public static let webviewDirectoryName = "InteractionPanelWebview"
    public static let fixtureDirectoryName = "InteractionPanelFixture"
}
