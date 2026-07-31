import AppKit
import WebKit
import os
import InteractionPanel

/// A key-able, nonactivating panel — like `AgentPanelWindow` — so the
/// `LSUIElement` app never steals the menu bar, while the webview can still
/// become key to receive camera permission and interaction.
private final class GesturePanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The macOS gesture window: hosts the shared InteractionPanel webview (camera +
/// MediaPipe + the TS swipe tracker) and applies each detected `spaceStep`
/// in-process via the injected handler. No bridge, no sidecar — the webview does
/// detection and only the resulting Space step crosses into native.
@MainActor
final class GestureWindowController: NSObject, NSWindowDelegate, WKUIDelegate {
    static let windowIdentifier = "agentdesk-gesture-window"
    static let webViewAccessibilityIdentifier = "gesture-webview"
    static let unavailableAccessibilityIdentifier = "gesture-unavailable"

    private let onSpaceStep: (Int) -> Void
    private let logger = Logger(subsystem: Config.logSubsystem, category: "gesture-window")

    private var window: NSWindow?
    private var panelController: InteractionPanelWebViewController?
    private var transport: GesturePanelSpaceStepTransport?
    /// Mirrors the default input device, so a window built later opens with the
    /// current echo-cancellation answer rather than the launch-time one.
    private var echoCancellation = DefaultAudioInput.shouldCancelEcho()

    init(onSpaceStep: @escaping (Int) -> Void) {
        self.onSpaceStep = onSpaceStep
        super.init()
    }

    /// Test seam: the constructed window (nil until the first `show()`, and after `stop()`).
    var windowForTesting: NSWindow? { window }

    func toggle() {
        if let window, window.isVisible {
            window.orderOut(nil)
        } else {
            show()
        }
    }

    func show() {
        if window == nil {
            build(voiceFirst: false)
        }
        // orderFrontRegardless (not makeKeyAndOrderFront) so the LSUIElement app
        // never activates; the nonactivating panel can still become key.
        window?.orderFrontRegardless()
    }

    /// Opens the retained InteractionPanel on Voice and refreshes its host
    /// recording library. A fresh window gets the view as document-start config;
    /// a retained one receives the typed native delivery after it is surfaced.
    func showVoice() {
        let isFresh = window == nil
        if isFresh {
            build(voiceFirst: true)
        }
        window?.orderFrontRegardless()
        if !isFresh {
            panelController?.deliver(
                rawJSON: #"{"type":"interactionView","payload":{"view":"voice","refreshRecordings":true}}"#
            )
        }
    }

    /// The default microphone changed, so the echo-cancellation answer changed
    /// with it. A live run keeps its own capture graph; the next one opens with
    /// the new rule.
    func applyEchoCancellation(_ enabled: Bool) {
        guard echoCancellation != enabled else { return }
        echoCancellation = enabled
        panelController?.deliver(
            rawJSON: InteractionPanelHostConfiguration.audioConfigDelivery(
                echoCancellation: enabled
            )
        )
    }

    func stop() {
        panelController?.teardown()
        window?.orderOut(nil)
        window = nil
        panelController = nil
        transport = nil
    }

    private func build(voiceFirst: Bool) {
        let window = makeWindow()
        self.window = window

        do {
            let transport = GesturePanelSpaceStepTransport(onSpaceStep: onSpaceStep)
            let controller = try InteractionPanelWebViewController(
                transport: transport,
                additionalUserScripts: [
                    InteractionPanelHostConfiguration.voiceConfigScript(
                        voiceFirst: voiceFirst,
                        echoCancellation: echoCancellation
                    )
                ]
            )
            self.transport = transport
            self.panelController = controller

            let webView = controller.webView
            webView.setAccessibilityIdentifier(Self.webViewAccessibilityIdentifier)
            // The gesture UI needs the camera; grant capture requests from the
            // bundled origin (the app must also declare NSCameraUsageDescription
            // and the camera entitlement — see the wiring checklist).
            webView.uiDelegate = self
            window.contentView = webView
        } catch {
            logger.error("gesture-window: InteractionPanel init failed: \(String(describing: error), privacy: .public)")
            window.contentView = makeUnavailableView()
        }
    }

    private func makeWindow() -> NSWindow {
        let window = GesturePanelWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.title = "Gesture"
        window.level = .normal
        // The top bar's Voice command and the gesture surface open this one
        // window, and both are things you reach for while working on whichever
        // Desktop you are on. Parking it on the Desktop that happened to be
        // front when it was built means the next invocation either switches
        // Spaces under you or appears to do nothing.
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hidesOnDeactivate = false
        window.identifier = NSUserInterfaceItemIdentifier(Self.windowIdentifier)
        window.setAccessibilityIdentifier(Self.windowIdentifier)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("AgentDeskGestureWindow")
        window.center()
        return window
    }

    private func makeUnavailableView() -> NSView {
        let label = NSTextField(labelWithString: "Gesture view unavailable")
        label.alignment = .center
        label.textColor = .secondaryLabelColor
        label.setAccessibilityIdentifier(Self.unavailableAccessibilityIdentifier)
        let container = NSView()
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        return container
    }

    // MARK: - WKUIDelegate

    nonisolated static func mediaCaptureDecision(
        originProtocol: String,
        originHost: String,
        type: WKMediaCaptureType
    ) -> WKPermissionDecision {
        guard originProtocol == "interactionfeed", originHost == "app" else {
            return .deny
        }

        switch type {
        case .camera, .microphone, .cameraAndMicrophone:
            return .grant
        @unknown default:
            return .deny
        }
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
        let decision = Self.mediaCaptureDecision(
            originProtocol: origin.protocol,
            originHost: origin.host,
            type: type
        )
        let decisionLabel = decision == .grant ? "grant" : "deny"
        logger.notice(
            "interaction media permission origin=\(origin.protocol, privacy: .public)://\(origin.host, privacy: .public) type=\(type.rawValue, privacy: .public) decision=\(decisionLabel, privacy: .public)"
        )
        decisionHandler(decision)
    }

    // MARK: - NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Hide instead of close so the toggle re-shows the same surface.
        sender.orderOut(nil)
        return false
    }
}
