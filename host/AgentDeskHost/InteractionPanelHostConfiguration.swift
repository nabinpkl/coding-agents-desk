import Foundation
import WebKit

/// The one macOS-side configuration injected into every InteractionPanel
/// webview. Keeping this here prevents the full panel and dictation mini from
/// drifting to different loopback sidecar endpoints.
@MainActor
enum InteractionPanelHostConfiguration {
    static func voiceConfigScript(voiceFirst: Bool = false) -> WKUserScript {
        let port = Config.voiceSidecarPort
        let config: [String: Any] = [
            "voiceTransport": "websocket",
            "voiceWsUrl": "ws://127.0.0.1:\(port)/ws/voice?source=macos",
            "apiBaseUrl": "http://127.0.0.1:\(port)",
            "flags": ["voiceFirst": voiceFirst],
        ]
        let json =
            (try? JSONSerialization.data(withJSONObject: config))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return WKUserScript(
            source: "window.__interactionConfig = \(json);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }
}
