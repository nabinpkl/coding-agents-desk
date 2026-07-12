import AppKit
import os
import AgentDeskWire
import AgentPanel

/// A key-able panel that hosts the agent webview without the `LSUIElement` app ever activating. Like
/// `WorkspaceShellPanel`, it is nonactivating so the menu bar stays with the frontmost app, but can
/// become key so the webview receives clicks, scrolls, and text input. A plain `NSWindow` shown via
/// `makeKeyAndOrderFront` would activate the app and swap the menu bar on every toggle-to-show — the
/// exact behavior the shell panel is engineered to avoid.
private final class AgentPanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The macOS Agents window (R24): one reusable Agent surface hosted directly on the Mac, backed by
/// the host-owned ATC sidecar through `AgentPanel`. It wraps an `AgentPanelWebViewController` (the
/// same surface the iOS feed uses) and an `AgentFeedBridge` whose push closure delivers straight
/// into the local webview instead of down a QUIC lane. Requests flow webview -> `AgentPanelBridge
/// Transport` -> `bridge.handle*` -> sidecar, and pushes flow sidecar -> `bridge.send` -> webview,
/// so the Mac window and the phone share one bridge and one wire contract.
@MainActor
final class AgentWindowController: NSObject, NSWindowDelegate {
    static let windowIdentifier = "agentdesk-agents-window"
    static let webViewAccessibilityIdentifier = "agents-webview"
    static let unavailableAccessibilityIdentifier = "agents-unavailable"

    private let sidecarClient: any SidecarClient
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window")

    private var window: NSWindow?
    private var panelController: AgentPanelWebViewController?
    private var transport: AgentPanelBridgeTransport?
    private var bridge: AgentFeedBridge?

    init(sidecarClient: any SidecarClient) {
        self.sidecarClient = sidecarClient
        super.init()
    }

    /// Test seam: the constructed window (nil until the first `show()`/`toggle()`, and after `stop()`).
    var windowForTesting: NSWindow? { window }

    /// Shows the window if hidden, hides it if visible. Wired to the shell's top-bar "Agents"
    /// command so the button toggles the surface.
    func toggle() {
        if let window, window.isVisible {
            window.orderOut(nil)
        } else {
            show()
        }
    }

    func show() {
        if window == nil {
            build()
        }
        // orderFrontRegardless (not makeKeyAndOrderFront) so the LSUIElement app never activates; the
        // nonactivating panel can still become key for webview interaction.
        window?.orderFrontRegardless()
    }

    /// Tears down the bridge streams and webview. Call on app termination so the sidecar SSE Tasks
    /// stop and the webview releases.
    func stop() {
        bridge?.reset()
        panelController?.teardown()
        window?.orderOut(nil)
        window = nil
        panelController = nil
        transport = nil
        bridge = nil
    }

    private func build() {
        let window = makeWindow()
        self.window = window

        do {
            let controller = try AgentPanelWebViewController(transport: nil)
            // The bridge pushes already-encoded agent-feed JSON; deliver it into the webview on the
            // main actor. The closure is @Sendable and may fire on a sidecar background Task, so it
            // hops to MainActor before touching the controller.
            let bridge = AgentFeedBridge(client: sidecarClient, send: { [weak self] data in
                let json = String(decoding: data, as: UTF8.self)
                Task { @MainActor [weak self] in
                    self?.panelController?.deliver(rawJSON: json)
                }
            })
            let transport = AgentPanelBridgeTransport(bridge: bridge)
            controller.transport = transport

            self.panelController = controller
            self.bridge = bridge
            self.transport = transport

            let webView = controller.webView
            webView.setAccessibilityIdentifier(Self.webViewAccessibilityIdentifier)
            window.contentView = webView
        } catch {
            logger.error("agents-window: AgentPanel init failed: \(String(describing: error), privacy: .public)")
            window.contentView = makeUnavailableView()
        }
    }

    private func makeWindow() -> NSWindow {
        let window = AgentPanelWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 720),
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.title = "Agents"
        // A normal utility window, not an always-on-top HUD, matching the shell panel's level so it
        // can be covered when another app is frontmost.
        window.level = .normal
        window.hidesOnDeactivate = false
        window.identifier = NSUserInterfaceItemIdentifier(Self.windowIdentifier)
        window.setAccessibilityIdentifier(Self.windowIdentifier)
        // Closing hides rather than destroys, so the toggle can re-show the same surface without
        // re-fetching the whole feed.
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("AgentDeskAgentsWindow")
        window.center()
        return window
    }

    private func makeUnavailableView() -> NSView {
        let label = NSTextField(labelWithString: "Agents view unavailable")
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

    // MARK: - NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Hide instead of close so `isReleasedWhenClosed = false` keeps the surface alive.
        sender.orderOut(nil)
        return false
    }
}
