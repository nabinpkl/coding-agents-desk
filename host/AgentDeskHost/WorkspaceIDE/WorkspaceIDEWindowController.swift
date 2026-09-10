import AppKit
import AgentPanel
import OSLog
import WebKit

/// One `＋ IDE` window.
///
/// It used to own the IDE: a `WorkspaceIDEController` holding two webviews, an AppKit split view
/// measuring them, a PTY terminal in the third pane, and a lane bridge carrying files and git in
/// from the host's own services. All of that is the Agent Panel and the sidecar now (ADR-0115), so
/// what is left here is the part that genuinely needs AppKit: a window, where it sits, which
/// Desktop it belongs to, and what closing it means.
///
/// The surface is chosen the way the iOS client chooses the desktop viewer -- a user script setting
/// `window.__agentPanelEntry` before the page's first script runs -- rather than by a query on the
/// URL, because the panel's dev origin is loaded verbatim and the bundled build has no query to
/// carry one.
@MainActor
final class WorkspaceIDEWindowController: NSWindowController,
    NSWindowDelegate,
    WorkspaceIDEWindowControlling
{
    private static let entryScript = WKUserScript(
        source: "window.__agentPanelEntry = 'ide';",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    private let placementSession: DesktopWindowPlacementSession
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window")
    private var panelController: AgentPanelWebViewController?
    private var onClosed: (@MainActor () -> Void)?
    private var isStopping = false

    init(
        initialPlacement: WorkspaceWindowPlacement,
        placementCoordinator: DesktopWindowPlacementCoordinator,
        onClosed: @escaping @MainActor () -> Void
    ) {
        placementSession = DesktopWindowPlacementSession(
            placement: initialPlacement,
            coordinator: placementCoordinator,
            logger: Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window-placement")
        )
        self.onClosed = onClosed

        let window = NSWindow(
            contentRect: initialPlacement.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Workspace IDE"
        window.minSize = NSSize(width: 720, height: 480)
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self

        do {
            let controller = try AgentPanelWebViewController(
                transport: nil,
                additionalUserScripts: [Self.entryScript]
            )
            controller.webView.setAccessibilityIdentifier("workspace-ide-panel")
            panelController = controller
            window.contentView = controller.webView
        } catch {
            // Loud, and visible: a window that opened onto nothing is indistinguishable from a
            // window that opened onto a panel which failed to render.
            logger.error(
                "Workspace IDE panel could not be created: \(String(describing: error), privacy: .public)"
            )
            window.contentView = Self.unavailableView()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("WorkspaceIDEWindowController is code-only") }

    func observePlacement(_ changed: @escaping (WorkspaceWindowPlacement) -> Void) {
        placementSession.onPlacementChanged = changed
    }

    func show(activating: Bool) {
        guard let window, !isStopping else { return }
        _ = placementSession.present(window, focus: activating)
    }

    /// Raises this window and gives it key status, without re-running the placement restore `show`
    /// performs. A window that is already on screen has already been placed, and repeating the
    /// restore would hide it again on any Desktop-audit hiccup -- an unacceptable answer to a click
    /// that asked to SEE it.
    func focus() {
        guard let window, !isStopping else { return }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func stop() {
        guard !isStopping else { return }
        isStopping = true
        placementSession.stop()
        panelController?.teardown()
        panelController = nil
        window?.delegate = nil
        window?.orderOut(nil)
        window?.close()
        onClosed = nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        beginUserClose()
        return false
    }

    /// The one user-initiated close, whether it came from the window's own close button or from the
    /// top bar's list of open windows. Reporting the close is what makes the registry forfeit the
    /// stored placement, which is what closing a window means and quitting does not.
    func beginUserClose() {
        guard !isStopping else { return }
        let closed = onClosed
        stop()
        closed?()
    }

    func windowDidEndLiveResize(_ notification: Notification) { reportPlacementChange() }
    func windowDidMove(_ notification: Notification) { reportPlacementChange() }
    func windowDidResize(_ notification: Notification) { reportPlacementChange() }
    func windowDidChangeScreen(_ notification: Notification) { reportPlacementChange() }

    private func reportPlacementChange() {
        guard let window, !isStopping else { return }
        placementSession.windowDidChange(window)
    }

    private static func unavailableView() -> NSView {
        let container = NSView()
        let label = NSTextField(labelWithString: "The workspace IDE panel is unavailable.")
        label.translatesAutoresizingMaskIntoConstraints = false
        label.textColor = .secondaryLabelColor
        container.addSubview(label)
        container.setAccessibilityIdentifier("workspace-ide-unavailable")
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        return container
    }
}
