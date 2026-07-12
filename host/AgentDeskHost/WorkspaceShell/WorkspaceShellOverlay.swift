import AppKit

/// A key-able, non-activating overlay panel. Borderless so it reads as chrome, `.nonactivatingPanel`
/// so the `LSUIElement` host never activates on hover, but `canBecomeKey` so the file tree and editor
/// inside the sidebar can take keyboard focus without stealing the menu bar from the frontmost app.
final class FocusableOverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The macOS workspace-shell overlay (ADR-0054): a left-edge sidebar and a top-edge bar, ported from
/// the agent-workspace-ide donor and narrowed to those two surfaces (the donor's third dock panel is
/// dropped). Both are borderless, non-activating, floating, all-Spaces `FocusableOverlayPanel`s.
///
/// Reveal is alpha + mouse-transparency, never order-out: a hidden panel keeps `alphaValue = 0` and
/// `ignoresMouseEvents = true` but stays ordered in, so it retains its all-Spaces membership and can
/// slide in instantly on any Desktop. The presenter drives `setReveal` from the edge-reveal state
/// machine (hover) or pins both surfaces visible when Input Monitoring is unavailable.
@MainActor
final class WorkspaceShellOverlay {
    /// The region each panel hosts. The presenter installs shell content (switcher, tree, editor,
    /// top-bar controls) into these once; `apply(layout:)` only moves the panels.
    let sidebarContentView = NSView()
    let topBarContentView = NSView()
    let dockContentView = NSView()

    private let sidebarPanel: FocusableOverlayPanel
    private let topBarPanel: FocusableOverlayPanel
    private let dockPanel: FocusableOverlayPanel
    /// Points inside a revealed panel keep it revealed even when the pointer leaves the trigger edge;
    /// this tolerance widens the hit test slightly so a pointer skimming the panel border does not
    /// flicker it closed. Matches the donor's surface tolerance.
    private static let surfaceTolerance: CGFloat = 12
    private var revealed: Set<WorkspaceShellSurface> = []

    init() {
        // Titles let the dock-enrichment reader recognize and hide the shell's own overlay windows.
        sidebarPanel = WorkspaceShellOverlay.makePanel(title: WorkspaceShellControlWindow.sidebar)
        topBarPanel = WorkspaceShellOverlay.makePanel(title: WorkspaceShellControlWindow.topBar)
        dockPanel = WorkspaceShellOverlay.makePanel(title: WorkspaceShellControlWindow.dockEnrichment)

        let sidebarBackground = WorkspaceShellOverlay.makeBackground()
        sidebarBackground.addSubview(sidebarContentView)
        WorkspaceShellOverlay.pin(sidebarContentView, to: sidebarBackground)
        sidebarPanel.contentView = sidebarBackground

        let topBarBackground = WorkspaceShellOverlay.makeBackground()
        topBarBackground.addSubview(topBarContentView)
        WorkspaceShellOverlay.pin(topBarContentView, to: topBarBackground)
        topBarPanel.contentView = topBarBackground

        let dockBackground = WorkspaceShellOverlay.makeBackground()
        dockBackground.addSubview(dockContentView)
        WorkspaceShellOverlay.pin(dockContentView, to: dockBackground)
        dockPanel.contentView = dockBackground
    }

    private static func makePanel(title: String) -> FocusableOverlayPanel {
        let panel = FocusableOverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: 240, height: 480),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = title
        panel.level = .floating
        // Appear on every Space (the reveal must work after a Desktop switch) and stay out of the
        // Cmd-` window cycle. Mirrors the host's other floating overlays (SpaceAgent, dictation).
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.hasShadow = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // Hidden at rest: transparent and click-through, but ordered in so it keeps its Space
        // membership and can reveal instantly.
        panel.alphaValue = 0
        panel.ignoresMouseEvents = true
        return panel
    }

    private static func makeBackground() -> NSView {
        let view = NSVisualEffectView()
        view.material = .sidebar
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    private static func pin(_ inner: NSView, to outer: NSView) {
        inner.translatesAutoresizingMaskIntoConstraints = false
        outer.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.leadingAnchor.constraint(equalTo: outer.leadingAnchor),
            inner.trailingAnchor.constraint(equalTo: outer.trailingAnchor),
            inner.topAnchor.constraint(equalTo: outer.topAnchor),
            inner.bottomAnchor.constraint(equalTo: outer.bottomAnchor),
        ])
    }

    /// Orders both panels in (transparent, at rest) so they hold their Space membership from launch.
    func show() {
        sidebarPanel.orderFrontRegardless()
        topBarPanel.orderFrontRegardless()
        dockPanel.orderFrontRegardless()
    }

    func stop() {
        sidebarPanel.orderOut(nil)
        topBarPanel.orderOut(nil)
        dockPanel.orderOut(nil)
    }

    /// Positions each panel from the layout. Frames are the full edge strip whether revealed or not,
    /// so an edge hover anywhere along the strip triggers a reveal.
    func apply(layout: WorkspaceShellLayout) {
        sidebarPanel.setFrame(layout.sidebar, display: true)
        topBarPanel.setFrame(layout.topBar, display: true)
        dockPanel.setFrame(layout.dockEnrichment, display: true)
        applyReveal()
    }

    /// Shows exactly the given surfaces (alpha 1, mouse-enabled) and hides the rest (alpha 0,
    /// click-through). Never orders a panel out, to keep its all-Spaces membership warm.
    func setReveal(_ revealed: Set<WorkspaceShellSurface>) {
        guard revealed != self.revealed else { return }
        self.revealed = revealed
        applyReveal()
    }

    private func applyReveal() {
        applyPanelReveal(sidebarPanel, revealed: revealed.contains(.sidebar))
        applyPanelReveal(topBarPanel, revealed: revealed.contains(.topBar))
        applyPanelReveal(dockPanel, revealed: revealed.contains(.dockEnrichment))
    }

    private func applyPanelReveal(_ panel: FocusableOverlayPanel, revealed: Bool) {
        panel.alphaValue = revealed ? 1 : 0
        panel.ignoresMouseEvents = !revealed
        panel.setAccessibilityHidden(!revealed)
        if revealed { panel.orderFrontRegardless() }
    }

    /// Whether `point` (AppKit global coordinates) is inside a surface's panel frame, inset by the
    /// tolerance. The presenter feeds this to the reveal state machine's hysteresis so a pointer over
    /// a revealed panel keeps it open.
    func containsSurface(_ surface: WorkspaceShellSurface, point: CGPoint) -> Bool {
        let frame: CGRect
        switch surface {
        case .sidebar: frame = sidebarPanel.frame
        case .topBar: frame = topBarPanel.frame
        case .dockEnrichment: frame = dockPanel.frame
        }
        return frame.insetBy(dx: -Self.surfaceTolerance, dy: -Self.surfaceTolerance).contains(point)
    }

    /// True when a surface is currently revealed and AX-reachable (used by the presenter's self-report
    /// and by the pinned-degrade path to confirm the bars are visible).
    func isRevealed(_ surface: WorkspaceShellSurface) -> Bool {
        revealed.contains(surface)
    }

    /// Makes the sidebar panel key so the file tree/editor can receive input, without activating the
    /// app. Called when the user clicks into the sidebar.
    func focusSidebar() {
        sidebarPanel.makeKeyAndOrderFront(nil)
    }

    /// A grey that resolves light in light mode and dark in dark mode (ported from the donor
    /// ShellOverlay). Used by the dock-enrichment panel's surfaces.
    nonisolated static func adaptiveWhite(light: CGFloat, dark: CGFloat) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(white: isDark ? dark : light, alpha: 1)
        }
    }
}
