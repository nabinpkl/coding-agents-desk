import AppKit
import os
import AgentDeskWire
import AgentPanel
import PtyClientSwift

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
/// the host-owned transcript sidecar through `AgentPanel`. It composes the shared webview above an optional
/// native web terminal pane and routes both through host-owned bridges. Feed requests flow webview ->
/// `AgentPanelBridgeTransport` -> `AgentFeedBridge` -> sidecar. Terminal intent flows through the
/// local Agent-session coordinator and attaches the deterministic leased PTY below the shrinking feed.
@MainActor
final class AgentWindowController: NSObject, NSWindowDelegate {
    static let windowIdentifier = "agentdesk-agents-window"
    static let webViewAccessibilityIdentifier = "agents-webview"
    static let unavailableAccessibilityIdentifier = "agents-unavailable"

    private let sidecarClient: any SidecarClient
    private let localTerminalEndpoint: AgentSessionTerminalEndpoint?
    private let terminalPtyClient: PtyClient?
    private let terminalControllerForTesting: (any AgentWindowTerminalControlling)?
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window")

    private var window: NSWindow?
    private var panelController: AgentPanelWebViewController?
    private var transport: AgentPanelBridgeTransport?
    private var bridge: AgentFeedBridge?
    private var splitView: AgentWindowSplitView?
    private var terminalController: (any AgentWindowTerminalControlling)?
    private var hideTask: Task<Void, Never>?
    private var stopTask: Task<Void, Never>?

    init(
        sidecarClient: any SidecarClient,
        localTerminalEndpoint: AgentSessionTerminalEndpoint? = nil,
        terminalPtyClient: PtyClient? = nil,
        terminalControllerForTesting: (any AgentWindowTerminalControlling)? = nil
    ) {
        self.sidecarClient = sidecarClient
        self.localTerminalEndpoint = localTerminalEndpoint
        self.terminalPtyClient = terminalPtyClient
        self.terminalControllerForTesting = terminalControllerForTesting
        super.init()
    }

    /// Test seam: the constructed window (nil until the first `show()`/`toggle()`, and after `stop()`).
    var windowForTesting: NSWindow? { window }

    /// Shows the window if hidden, hides it if visible. Wired to the shell's top-bar "Agents"
    /// command so the button toggles the surface.
    func toggle() {
        if let window, window.isVisible {
            beginHide(window, reason: .windowHidden)
        } else {
            show()
        }
    }

    func show() {
        if window == nil {
            build()
        }
        if Config.axAutomationEnabled {
            NSApp.activate(ignoringOtherApps: true)
            window?.makeKeyAndOrderFront(nil)
        } else {
            // orderFrontRegardless (not makeKeyAndOrderFront) so the LSUIElement app never activates; the
            // nonactivating panel can still become key for webview interaction.
            window?.orderFrontRegardless()
        }
        logAXSelfReport()
    }

    /// Logs the window's accessibility-tree state after a show, so the AX wiring is observable from
    /// the host's own os_log (category agent-window) without an out-of-process AX client or screen
    /// capture. Reports the window identifier, visibility, and whether the live webview or the
    /// unavailable fallback is the reachable content surface.
    private func logAXSelfReport() {
        guard let window else {
            logger.notice("agents-window AX: no window")
            return
        }
        let ids = axIdentifiers(in: window.contentView)
        let surface: String
        if ids.contains(Self.webViewAccessibilityIdentifier) {
            surface = "webview:\(Self.webViewAccessibilityIdentifier)"
        } else if ids.contains(Self.unavailableAccessibilityIdentifier) {
            surface = "fallback:\(Self.unavailableAccessibilityIdentifier)"
        } else {
            surface = "MISSING"
        }
        logger.notice(
            "agents-window AX: window=\(window.identifier?.rawValue ?? "nil", privacy: .public) title=\(window.title, privacy: .public) visible=\(window.isVisible, privacy: .public) surface=\(surface, privacy: .public)"
        )
    }

    private func axIdentifiers(in view: NSView?) -> Set<String> {
        guard let view else { return [] }
        var result: Set<String> = []
        let identifier = view.accessibilityIdentifier()
        if !identifier.isEmpty { result.insert(identifier) }
        for subview in view.subviews {
            result.formUnion(axIdentifiers(in: subview))
        }
        return result
    }

    /// Establishes terminal close synchronously, then tears down the retained feed only after the
    /// endpoint close barrier commits. The returned task keeps this controller alive through commit.
    @discardableResult
    func beginStop() -> Task<Void, Never> {
        if let stopTask { return stopTask }
        let terminalClose = terminalController?.beginExplicitClose(reason: .appTermination)
        let task = Task { @MainActor [self] in
            await terminalClose?.value
            finishStop()
        }
        stopTask = task
        return task
    }

    func stop() async {
        await beginStop().value
    }

    private func finishStop() {
        hideTask = nil
        bridge?.reset()
        panelController?.teardown()
        window?.orderOut(nil)
        window = nil
        panelController = nil
        transport = nil
        bridge = nil
        splitView = nil
        terminalController = nil
        stopTask = nil
    }

    @discardableResult
    private func beginHide(
        _ window: NSWindow,
        reason: AgentWindowTerminalExplicitCloseReason
    ) -> Task<Void, Never>? {
        if let hideTask { return hideTask }
        guard let terminalClose = terminalController?.beginExplicitClose(reason: reason) else {
            window.orderOut(nil)
            return nil
        }
        let task = Task { @MainActor [weak self, weak window] in
            await terminalClose.value
            guard let self else { return }
            if let window, self.window === window {
                window.orderOut(nil)
            }
            self.hideTask = nil
        }
        hideTask = task
        return task
    }

    private func build() {
        let window = makeWindow()
        self.window = window

        do {
            let controller = try AgentPanelWebViewController(
                transport: nil,
                additionalUserScripts: [AgentWindowPanelAccessibility.userScript]
            )
            // The bridge pushes already-encoded agent-feed JSON; deliver it into the webview on the
            // main actor. The closure is @Sendable and may fire on a sidecar background Task, so it
            // hops to MainActor before touching the controller.
            let bridge = AgentFeedBridge(client: sidecarClient, rawEventDeliveryMode: .direct, send: { [weak self] data in
                let json = String(decoding: data, as: UTF8.self)
                Task { @MainActor [weak self] in
                    self?.panelController?.deliver(rawJSON: json)
                }
            })
            self.panelController = controller
            self.bridge = bridge

            let webView = controller.webView
            webView.setAccessibilityIdentifier(Self.webViewAccessibilityIdentifier)

            let terminalController: (any AgentWindowTerminalControlling)?
            if let terminalControllerForTesting {
                terminalController = terminalControllerForTesting
            } else if let localTerminalEndpoint, let terminalPtyClient {
                terminalController = AgentWindowTerminalController(
                    endpoint: LocalAgentSessionTerminalEndpointRouter(
                        endpoint: localTerminalEndpoint
                    ),
                    attacher: PtyClientAgentWindowTerminalAttacher(client: terminalPtyClient),
                    setTerminalOpen: { [weak self] open in
                        self?.splitView?.setTerminalOpen(open)
                    },
                    deliverStatus: { [weak self] message in
                        self?.deliverTerminalStatus(message)
                    }
                )
            } else {
                terminalController = nil
            }

            if let terminalController {
                let splitView = AgentWindowSplitView(
                    feedView: webView,
                    terminalView: terminalController.terminalView
                )
                self.splitView = splitView
                self.terminalController = terminalController
                window.contentView = splitView
            } else {
                window.contentView = webView
            }

            let transport = AgentPanelBridgeTransport(
                bridge: bridge,
                onTerminalIntent: { [weak self] intent in
                    self?.terminalController?.handle(intent)
                }
            )
            controller.transport = transport
            self.transport = transport
        } catch {
            logger.error("agents-window: AgentPanel init failed: \(String(describing: error), privacy: .public)")
            window.contentView = makeUnavailableView()
        }
    }

    private func deliverTerminalStatus(_ message: AgentTerminalHostMessage) {
        do {
            let data = try JSONEncoder().encode(message)
            panelController?.deliver(rawJSON: String(decoding: data, as: UTF8.self))
        } catch {
            logger.error(
                "agents-window terminal status encode failed: \(String(describing: error), privacy: .public)"
            )
        }
    }

    private func makeWindow() -> NSWindow {
        let styleMask: NSWindow.StyleMask = Config.axAutomationEnabled
            ? [.titled, .closable, .resizable]
            : [.titled, .closable, .resizable, .nonactivatingPanel]
        let window: NSWindow
        if Config.axAutomationEnabled {
            window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 720),
                styleMask: styleMask,
                backing: .buffered,
                defer: false
            )
        } else {
            window = AgentPanelWindow(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 720),
                styleMask: styleMask,
                backing: .buffered,
                defer: false
            )
        }
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

    func windowDidBecomeKey(_ notification: Notification) {
        terminalController?.claimViewportOwnership()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Hide instead of close so `isReleasedWhenClosed = false` keeps the surface alive.
        beginHide(sender, reason: .windowShouldClose)
        return false
    }
}
