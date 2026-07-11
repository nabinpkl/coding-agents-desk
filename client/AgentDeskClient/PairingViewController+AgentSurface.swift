import OSLog
import UIKit
import WebKit

// Extension: surface switcher (Control | Agent | Terminal | Browser) and lifecycle.
// The ControlSurface enum + visibility(for:) mapping live in ControlSurface.swift.
//
// Each non-control surface sits full-bleed alongside the existing control
// surfaces (trackpad, display rail, keyboard). A segmented control in the
// safe-area top lets the user switch between them. When a non-control surface
// is shown the interactive control surfaces are hidden so gestures do not
// conflict; the inactive surfaces are hidden too.
//
// Lifecycle (state-driven, race-free):
//   - The TOGGLE is added from render()'s .connected case via
//     showSurfaceToggleIfNeeded() (idempotent). render() runs on every state
//     change, so the toggle can never be skipped by a one-shot channel-set race.
//   - The WEBVIEW is created LAZILY the first time the user switches to Agent
//     (ensureAgentSurface), pulling the channel and transport at that moment
//     (both reliably non-nil once connected). This removes any need for a valid
//     channel at toggle-creation time.
//   - teardownAgentSurface() destroys the switcher and surfaces only for
//     explicit teardown. Background suspend keeps them mounted and rebinds
//     their transports on foreground resume.

extension PairingViewController {
    private static let logger = Logger(subsystem: Config.logSubsystem, category: "agent-surface")

    // MARK: - Properties (stored via objc_associated_objects to avoid modifying the primary file)

    private enum Keys {
        nonisolated(unsafe) static var agentSurface: UInt8 = 0
        nonisolated(unsafe) static var terminalSurface: UInt8 = 0
        nonisolated(unsafe) static var surfaceSegmentedControl: UInt8 = 0
        nonisolated(unsafe) static var agentSurfaceConstraints: UInt8 = 0
        nonisolated(unsafe) static var agentSurfaceBoundTransport: UInt8 = 0
        nonisolated(unsafe) static var filesSurface: UInt8 = 0
        nonisolated(unsafe) static var filesBrowser: UInt8 = 0
        nonisolated(unsafe) static var filesSurfaceLoading: UInt8 = 0
    }

    private final class AgentSurfaceTransportBinding {
        weak var transport: QuicSessionClientTransport?

        init(_ transport: QuicSessionClientTransport?) {
            self.transport = transport
        }
    }

    var agentSurface: AgentFeedSurface? {
        get { objc_getAssociatedObject(self, &Keys.agentSurface) as? AgentFeedSurface }
        set { objc_setAssociatedObject(self, &Keys.agentSurface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    @available(iOS 26.0, *)
    var terminalSurface: TerminalSurface? {
        get { objc_getAssociatedObject(self, &Keys.terminalSurface) as? TerminalSurface }
        set { objc_setAssociatedObject(self, &Keys.terminalSurface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    var surfaceSegmentedControl: UISegmentedControl? {
        get { objc_getAssociatedObject(self, &Keys.surfaceSegmentedControl) as? UISegmentedControl }
        set { objc_setAssociatedObject(self, &Keys.surfaceSegmentedControl, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    var filesSurface: WorkspaceFilesSurface? {
        get { objc_getAssociatedObject(self, &Keys.filesSurface) as? WorkspaceFilesSurface }
        set { objc_setAssociatedObject(self, &Keys.filesSurface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var filesBrowser: WorkspaceFilesBrowser? {
        get { objc_getAssociatedObject(self, &Keys.filesBrowser) as? WorkspaceFilesBrowser }
        set { objc_setAssociatedObject(self, &Keys.filesBrowser, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var filesSurfaceLoading: Bool {
        get { (objc_getAssociatedObject(self, &Keys.filesSurfaceLoading) as? Bool) ?? false }
        set { objc_setAssociatedObject(self, &Keys.filesSurfaceLoading, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var agentSurfaceBoundTransport: QuicSessionClientTransport? {
        get { (objc_getAssociatedObject(self, &Keys.agentSurfaceBoundTransport) as? AgentSurfaceTransportBinding)?.transport }
        set {
            objc_setAssociatedObject(
                self,
                &Keys.agentSurfaceBoundTransport,
                AgentSurfaceTransportBinding(newValue),
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC
            )
        }
    }

    // MARK: - Toggle UI (state-driven from render())

    // Idempotent: adds the Control/Agent/Terminal segmented toggle once, with the
    // safe-area-top constraints. Called from render()'s .connected case, which
    // runs on every state change, so the toggle cannot be skipped by a channel
    // timing race. The webview itself is created lazily on first Agent select.
    func showSurfaceToggleIfNeeded() {
        guard surfaceSegmentedControl == nil else {
            if let seg = surfaceSegmentedControl {
                if case .connected = pairingClient.state {
                    refreshSurfaceToggleSegments(seg)
                }
                seg.selectedSegmentIndex = segmentIndex(for: activeControlSurface, in: seg)
                // Already present; keep it on top of any later-added media chrome.
                view.bringSubviewToFront(seg)
            }
            return
        }

        // Browser is offered only when this session opened a .dom lane.
        // Availability is fixed for the session's lifetime (decided at the
        // handshake) and the toggle is torn down + rebuilt on every
        // non-connected state, so reading it once here is race-free.
        let items = surfaceToggleItems()
        let seg = UISegmentedControl(items: items)
        seg.selectedSegmentIndex = segmentIndex(for: activeControlSurface, in: seg)
        seg.translatesAutoresizingMaskIntoConstraints = false
        seg.addTarget(self, action: #selector(surfaceSegmentChanged(_:)), for: .valueChanged)
        view.addSubview(seg)
        NSLayoutConstraint.activate([
            seg.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            seg.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8)
        ])
        // Cheap z-order safety: keep the toggle above the media sink / surfaces.
        view.bringSubviewToFront(seg)
        surfaceSegmentedControl = seg
        applySurface(activeControlSurface)
    }

    func teardownAgentSurface() {
        activeControlSurface = .control
        // Detach the push sink so no transport delivers to a dead surface.
        pairingClient.onAgentPush = nil

        agentSurface?.teardown()
        agentSurface?.removeFromSuperview()
        agentSurface = nil
        agentSurfaceBoundTransport = nil

        if #available(iOS 26.0, *) {
            terminalSurface?.detach()
            terminalSurface?.removeFromSuperview()
            terminalSurface = nil
        }

        // The switcher owns all non-control surfaces; tear the browser down too
        // so a reconnect rebuilds all three cleanly from the fresh session.
        teardownDomMirrorSurface()

        surfaceSegmentedControl?.removeFromSuperview()
        surfaceSegmentedControl = nil
    }

    // MARK: - Lazy webview creation

    // Creates the hidden AgentFeedSurface (inset below the Control/Agent toggle,
    // full-bleed on the other three edges) and wires both bridge directions,
    // pulling the live channel and transport at call time. A nil
    // channel (not yet connected) is tolerated: the surface is still created so
    // the UI does not crash, and the inbound closure no-ops until a channel is
    // available. Idempotent.
    @discardableResult
    func ensureAgentSurface() -> AgentFeedSurface {
        if let existing = agentSurface {
            return existing
        }

        let surface = AgentFeedSurface()
        surface.translatesAutoresizingMaskIntoConstraints = false
        surface.isHidden = true
        view.addSubview(surface)
        // Top-anchor to the toggle's bottom (not view.top) so the webview's own
        // header sits BELOW the native Control/Agent switcher instead of behind
        // it. The toggle is created before any Agent select, so it is present
        // here; the safe-area fallback only guards a defensive nil.
        let surfaceTop = surfaceSegmentedControl.map {
            surface.topAnchor.constraint(equalTo: $0.bottomAnchor, constant: 8)
        } ?? surface.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        NSLayoutConstraint.activate([
            surfaceTop,
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            surface.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        agentSurface = surface
        agentSurfaceBoundTransport = pairingClient.activeSessionTransport

        // Wire inbound: JS requests -> InputChannel sends. The channel is pulled
        // live on each request so a reconnect's fresh channel is used.
        surface.onAgentRequest = { [weak self] request in
            guard let self else { return }
            guard let channel = self.pairingClient.activeInputChannel else {
                Self.logger.notice("agent-feed: request dropped, no active input channel")
                return
            }
            Self.logger.notice("agent-feed: forwarding agent request on input channel")
            self.forwardAgentRequest(request, on: channel)
        }

        // Wire outbound: host pushes -> surface.deliver, via the pairing client's
        // stable sink rather than a captured transport. A reconnect/resume
        // replaces activeSessionTransport; binding a specific transport here
        // would silently drop every push after that swap (feed stuck on
        // "waiting", unfixable by re-subscribing) until the surface is recreated.
        // The sink is symmetric with the onAgentRequest closure above, which
        // reads activeInputChannel live on each send.
        pairingClient.onAgentPush = { [weak surface] json in
            surface?.deliver(rawJSON: json)
        }

        // Keep the toggle above the freshly-added full-bleed surface.
        if let seg = surfaceSegmentedControl {
            view.bringSubviewToFront(seg)
        }

        return surface
    }

    func rebindAgentSurfaceAfterReconnectIfNeeded() {
        guard let surface = agentSurface,
              let transport = pairingClient.activeSessionTransport
        else {
            return
        }
        guard agentSurfaceBoundTransport !== transport else {
            return
        }
        agentSurfaceBoundTransport = transport
        pairingClient.onAgentPush = { [weak surface] json in
            surface?.deliver(rawJSON: json)
        }
        surface.resumeAfterSessionReconnect()
    }

    @objc private func surfaceSegmentChanged(_ sender: UISegmentedControl) {
        let surface = selectedSurface(on: sender)
        activeControlSurface = surface
        switch surface {
        case .control:
            break
        case .agent:
            // Create the webview and wire the bridge on first switch to Agent.
            ensureAgentSurface()
        case .terminal:
            if #available(iOS 26.0, *) {
                ensureTerminalSurface()
            }
        case .browser:
            // Create the replay surface and start the .dom lane on first switch
            // to Browser (lazy, so the mirror does not run unless viewed).
            ensureDomMirrorSurface()
        case .files:
            // Open the .files lane and build the browser on first switch to Files.
            ensureFilesSurface()
        }
        applySurface(surface)

        // ADR-0045: pause DOM capture at the source whenever Browser is not the
        // active surface, resume it when it is. setCapture no-ops until the lane
        // is started, so a pause before Browser is ever opened is a safe no-op.
        pairingClient.activeDomMirror?.setCapture(surface == .browser)
        // ADR-0046: reflect the paused state in the Browser status line.
        domMirrorSurface?.setPaused(surface != .browser)
    }

    func rebindActiveSurfaceAfterReconnect() {
        rebindAgentSurfaceAfterReconnectIfNeeded()

        switch activeControlSurface {
        case .control:
            break
        case .agent:
            ensureAgentSurface()
        case .terminal:
            if #available(iOS 26.0, *) {
                ensureTerminalSurface()
            }
        case .browser:
            if ensureDomMirrorSurface() == nil {
                activeControlSurface = .control
                if let seg = surfaceSegmentedControl {
                    seg.selectedSegmentIndex = segmentIndex(for: .control, in: seg)
                }
            }
        case .files:
            ensureFilesSurface()
        }
        pairingClient.activeDomMirror?.setCapture(activeControlSurface == .browser)
        domMirrorSurface?.setPaused(activeControlSurface != .browser)
    }

    // Maps the selected segment to a ControlSurface by title, robust to the
    // 2-vs-3 segment layout (Browser present only with a .dom lane).
    private func selectedSurface(on seg: UISegmentedControl) -> ControlSurface {
        switch seg.titleForSegment(at: seg.selectedSegmentIndex) {
        case "Agent": return .agent
        case "Terminal": return .terminal
        case "Browser": return .browser
        case "Files": return .files
        default: return .control
        }
    }

    private func segmentIndex(for surface: ControlSurface, in seg: UISegmentedControl) -> Int {
        let title: String
        switch surface {
        case .control: title = "Control"
        case .agent: title = "Agent"
        case .terminal: title = "Terminal"
        case .browser: title = "Browser"
        case .files: title = "Files"
        }
        for index in 0..<seg.numberOfSegments where seg.titleForSegment(at: index) == title {
            return index
        }
        activeControlSurface = .control
        return 0
    }

    private func surfaceToggleItems() -> [String] {
        var items = ["Control", "Agent", "Terminal"]
        if pairingClient.activeDomMirror != nil {
            items.append("Browser")
        }
        // The .files lane is available on any active session, so Files is always offered.
        items.append("Files")
        return items
    }

    private func refreshSurfaceToggleSegments(_ seg: UISegmentedControl) {
        let items = surfaceToggleItems()
        let current = (0..<seg.numberOfSegments).compactMap { seg.titleForSegment(at: $0) }
        guard current != items else { return }

        if !items.contains("Browser") {
            if activeControlSurface == .browser {
                activeControlSurface = .control
            }
            teardownDomMirrorSurface()
        }

        seg.removeAllSegments()
        for (index, title) in items.enumerated() {
            seg.insertSegment(withTitle: title, at: index, animated: false)
        }
    }

    // MARK: - Visibility

    func applySurface(_ surface: ControlSurface) {
        let v = visibility(for: surface)
        if !v.keyboardInteractive {
            applyKeyboardPresentationIntent(.hide)
        }

        agentSurface?.isHidden = v.agentHidden
        domMirrorSurface?.isHidden = v.browserHidden
        if #available(iOS 26.0, *) {
            terminalSurface?.isHidden = v.terminalHidden
        }

        // Suppress the interactive control surfaces when a non-control surface
        // is active so gesture recognizers do not fight the webview scroll.
        trackpadView.isHidden = v.controlChromeHidden
        trackpadHint.isHidden = v.controlChromeHidden
        scrollStripView.isHidden = v.controlChromeHidden
        scrollStripHint.isHidden = v.controlChromeHidden
        buttonRow.isHidden = v.controlChromeHidden
        displayRailView.isHidden = v.controlChromeHidden
        // The keyboard surface is a first-responder helper; just disable it.
        keyboardSurface.isUserInteractionEnabled = v.keyboardInteractive
        applyVideoTouchState()
        filesSurface?.isHidden = v.filesHidden

        Self.logger.debug("active surface: \(String(describing: surface))")
    }

    // Idempotent: opens the .files lane, builds the browser + surface, and auto-selects the first
    // workspace so the surface shows content on open. The lane is available on any active session,
    // so unlike Browser this needs no capability gate. Runs its async open in a Task; the loading
    // flag guards against a double open from rapid segment taps.
    func ensureFilesSurface() {
        guard filesSurface == nil, !filesSurfaceLoading else { return }
        guard let session = pairingClient.activeSessionTransport else { return }
        filesSurfaceLoading = true
        Task { [weak self] in
            guard let self else { return }
            do {
                let transport = try await session.openWorkspaceFilesTransport()
                let browser = WorkspaceFilesBrowser(transport: transport)
                let surface = WorkspaceFilesSurface(browser: browser)
                surface.translatesAutoresizingMaskIntoConstraints = false
                surface.isHidden = self.activeControlSurface != .files
                self.view.addSubview(surface)
                let top = self.surfaceSegmentedControl.map {
                    surface.topAnchor.constraint(equalTo: $0.bottomAnchor, constant: 8)
                } ?? surface.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor)
                NSLayoutConstraint.activate([
                    top,
                    surface.leadingAnchor.constraint(equalTo: self.view.leadingAnchor),
                    surface.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
                    surface.bottomAnchor.constraint(equalTo: self.view.bottomAnchor),
                ])
                if let seg = self.surfaceSegmentedControl { self.view.bringSubviewToFront(seg) }
                self.filesBrowser = browser
                self.filesSurface = surface
                await browser.loadWorkspaces()
                if let first = browser.model.workspaces.first {
                    await browser.selectWorkspace(first.id)
                }
            } catch {
                Self.logger.error("files surface open failed: \(String(describing: error), privacy: .public)")
            }
            self.filesSurfaceLoading = false
        }
    }

    @available(iOS 26.0, *)
    @discardableResult
    private func ensureTerminalSurface() -> TerminalSurface {
        if let existing = terminalSurface {
            return existing
        }

        let surface = TerminalSurface()
        surface.translatesAutoresizingMaskIntoConstraints = false
        surface.isHidden = true
        view.addSubview(surface)
        let surfaceTop = surfaceSegmentedControl.map {
            surface.topAnchor.constraint(equalTo: $0.bottomAnchor, constant: 8)
        } ?? surface.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        NSLayoutConstraint.activate([
            surfaceTop,
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            surface.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        terminalSurface = surface
        surface.connect(using: pairingClient.activeSessionTransport)
        if let seg = surfaceSegmentedControl {
            view.bringSubviewToFront(seg)
        }
        return surface
    }

    // MARK: - Request forwarding

    private func forwardAgentRequest(_ request: AgentFeedRequest, on channel: InputChannel) {
        Task {
            do {
                switch request {
                case .projectsSubscribe:
                    try await channel.sendAgentProjectsSubscribe()
                case .threadSubscribe(let sub):
                    try await channel.sendAgentThreadSubscribe(sub)
                case .threadLoadOlder(let older):
                    try await channel.sendAgentThreadLoadOlder(older)
                case .threadUnsubscribe(let unsub):
                    try await channel.sendAgentThreadUnsubscribe(unsub)
                }
            } catch {
                Self.logger.error(
                    "agent request send failed: \(String(describing: error), privacy: .public)"
                )
            }
        }
    }
}
