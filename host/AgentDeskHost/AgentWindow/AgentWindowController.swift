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

/// One macOS Agents window hosted directly on the Mac, backed by the host-owned transcript sidecar
/// through `AgentPanel`. It composes the shared webview above an optional
/// native web terminal pane and routes both through host-owned bridges. Feed requests flow webview ->
/// `AgentPanelBridgeTransport` -> `AgentFeedBridge` -> sidecar. Terminal intent flows through the
/// local Agent-session coordinator and attaches the deterministic leased PTY below the shrinking feed.
@MainActor
final class AgentWindowController: NSObject, NSWindowDelegate, AgentWindowControlling {
    static let windowIdentifier = "agentdesk-agents-window"
    static let webViewAccessibilityIdentifier = "agents-webview"
    static let unavailableAccessibilityIdentifier = "agents-unavailable"

    private let sidecarClient: any SidecarClient
    private let localTerminalEndpoint: AgentSessionTerminalEndpoint?
    private let terminalPtyClient: PtyClient?
    private let terminalControllerForTesting: (any AgentWindowTerminalControlling)?
    private let initialFrame: CGRect?
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window")

    private var onClosed: (@MainActor () -> Void)?
    private var onFrameChanged: ((CGRect) -> Void)?
    private var onTerminalChanged: ((AgentWindowTerminalAttachment?) -> Void)?
    private var onZoomChanged: ((Int) -> Void)?
    private var window: NSWindow?
    private var panelController: AgentPanelWebViewController?
    private var transport: AgentPanelBridgeTransport?
    private var bridge: AgentFeedBridge?
    private var splitView: AgentWindowSplitView?
    private var titlebarLayout: AgentWindowTitlebarLayout?
    private var terminalController: (any AgentWindowTerminalControlling)?
    private var stopTask: Task<Void, Never>?
    /// Restored from `AgentWindowPresentationStore` at launch and reported back on every change, so
    /// a window comes back at the size it was left at. A window the user CLOSED forfeits its whole
    /// stored presentation, zoom with it, exactly as it forfeits its frame.
    private var zoom: AgentWindowZoom

    init(
        sidecarClient: any SidecarClient,
        localTerminalEndpoint: AgentSessionTerminalEndpoint? = nil,
        terminalPtyClient: PtyClient? = nil,
        terminalControllerForTesting: (any AgentWindowTerminalControlling)? = nil,
        initialFrame: CGRect? = nil,
        initialZoomStep: Int = 0,
        onClosed: (@MainActor () -> Void)? = nil
    ) {
        self.sidecarClient = sidecarClient
        self.localTerminalEndpoint = localTerminalEndpoint
        self.terminalPtyClient = terminalPtyClient
        self.terminalControllerForTesting = terminalControllerForTesting
        self.initialFrame = initialFrame
        self.zoom = AgentWindowZoom(step: initialZoomStep)
        self.onClosed = onClosed
        super.init()
    }

    /// Test seam: the constructed window (nil until `show()`, and after close or `stop()`).
    var windowForTesting: NSWindow? { window }

    func observePresentation(
        frameChanged: @escaping (CGRect) -> Void,
        terminalChanged: @escaping (AgentWindowTerminalAttachment?) -> Void,
        zoomChanged: @escaping (Int) -> Void
    ) {
        onFrameChanged = frameChanged
        onTerminalChanged = terminalChanged
        onZoomChanged = zoomChanged
    }

    func show(activating: Bool = true) {
        guard stopTask == nil else { return }
        if window == nil {
            build()
        }
        if activating, Config.axAutomationEnabled {
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

    /// Host termination. The terminal lets go of its PTY without ending the agent's session, so a
    /// restarting host can pick it back up; only a window the user closed ends its terminal.
    @discardableResult
    func beginStop() -> Task<Void, Never> {
        if let stopTask { return stopTask }
        terminalController?.beginPreservingDetach()
        let task = Task { @MainActor [self] in
            finishStop()
        }
        stopTask = task
        return task
    }

    func resumeTerminal(_ attachment: AgentWindowTerminalAttachment) {
        guard stopTask == nil else { return }
        if window == nil {
            build()
        }
        terminalController?.resume(attachment)
    }

    private func finishStop() {
        bridge?.reset()
        panelController?.teardown()
        window?.orderOut(nil)
        window = nil
        panelController = nil
        transport = nil
        bridge = nil
        splitView = nil
        titlebarLayout = nil
        terminalController = nil
        stopTask = nil
        onFrameChanged = nil
        onTerminalChanged = nil
        onZoomChanged = nil
        let onClosed = onClosed
        self.onClosed = nil
        onClosed?()
    }

    private func build() {
        let window = makeWindow()
        self.window = window
        let titlebarLayout = AgentWindowTitlebarLayout.measure(in: window)
        self.titlebarLayout = titlebarLayout

        do {
            let controller = try AgentPanelWebViewController(
                transport: nil,
                additionalUserScripts: [
                    AgentWindowPanelAccessibility.userScript,
                    AgentWindowPanelChrome.userScript(
                        leadingInset: titlebarLayout.webLeadingInset,
                        zoomScale: zoom.scale
                    ),
                ]
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
            // Set here as well as on the keystroke so "the webview is at the controller's zoom" holds
            // however many times this runs, rather than only for a webview that existed when the key
            // was pressed.
            webView.pageZoom = zoom.scale

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
                        guard let self else { return }
                        self.splitView?.setTerminalOpen(open)
                        // Re-sent on open rather than relied on from the keystroke: a pane opened
                        // after the window was zoomed has a renderer that never saw that level, and
                        // a renderer recovery clears anything still queued for it.
                        if open { self.terminalController?.setZoomScale(self.zoom.scale) }
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
                terminalController.observeAttachment { [weak self] attachment in
                    self?.onTerminalChanged?(attachment)
                }
                window.contentView = makeContentView(splitView)
            } else {
                window.contentView = makeContentView(webView)
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
            window.contentView = makeContentView(makeUnavailableView())
        }
    }

    private func makeContentView(_ content: NSView) -> AgentWindowContentView {
        guard let layout = titlebarLayout else {
            preconditionFailure("Agents title-bar layout must exist before content is installed")
        }
        let view = AgentWindowContentView(content: content, titlebarLayout: layout)
        view.onZoomCommand = { [weak self] command in
            self?.applyZoom(command)
        }
        return view
    }

    /// Scales both halves of the window by one level, through the mechanism each one wants: page
    /// zoom for the feed, font size for the terminal, whose character grid page zoom would blur.
    private func applyZoom(_ command: AgentWindowZoomCommand) {
        let previous = zoom
        zoom.apply(command)
        guard zoom != previous else { return }
        panelController?.webView.pageZoom = zoom.scale
        if let titlebarLayout, let webView = panelController?.webView {
            webView.evaluateJavaScript(
                AgentWindowPanelChrome.updateScript(
                    leadingInset: titlebarLayout.webLeadingInset,
                    zoomScale: zoom.scale
                ),
                completionHandler: nil
            )
        }
        terminalController?.setZoomScale(zoom.scale)
        onZoomChanged?(zoom.step)
    }

    /// Test seam: the level the next webview would be built at.
    var zoomScaleForTesting: Double { zoom.scale }

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
            ? [.titled, .closable, .resizable, .fullSizeContentView]
            : [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel]
        let contentRect = NSRect(x: 0, y: 0, width: 480, height: 720)
        let window: NSWindow
        if Config.axAutomationEnabled {
            window = NSWindow(
                contentRect: contentRect,
                styleMask: styleMask,
                backing: .buffered,
                defer: false
            )
        } else {
            window = AgentPanelWindow(
                contentRect: contentRect,
                styleMask: styleMask,
                backing: .buffered,
                defer: false
            )
        }
        window.title = "Agents"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        // A normal utility window, not an always-on-top HUD, matching the shell panel's level so it
        // can be covered when another app is frontmost.
        window.level = .normal
        window.hidesOnDeactivate = false
        window.identifier = NSUserInterfaceItemIdentifier(Self.windowIdentifier)
        window.setAccessibilityIdentifier(Self.windowIdentifier)
        window.isReleasedWhenClosed = false
        window.delegate = self
        if let initialFrame {
            window.setFrame(initialFrame, display: false)
        } else {
            window.center()
        }
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

    func windowDidMove(_ notification: Notification) {
        reportFrame()
    }

    func windowDidResize(_ notification: Notification) {
        reportFrame()
    }

    private func reportFrame() {
        guard let window, stopTask == nil else { return }
        onFrameChanged?(window.frame)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard stopTask == nil else { return false }
        let terminalClose = terminalController?.beginExplicitClose(reason: .windowShouldClose)
        let task = Task { @MainActor [self] in
            await terminalClose?.value
            finishStop()
        }
        stopTask = task
        return false
    }
}
