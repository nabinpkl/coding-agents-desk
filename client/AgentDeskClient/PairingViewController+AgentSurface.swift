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
        nonisolated(unsafe) static var agentTerminalLifecycleRouter: UInt8 = 0
        nonisolated(unsafe) static var workspaceSurface: UInt8 = 0
        nonisolated(unsafe) static var workspaceBrowser: UInt8 = 0
        nonisolated(unsafe) static var filesTransport: UInt8 = 0
        nonisolated(unsafe) static var workspaceSurfaceLoading: UInt8 = 0
        nonisolated(unsafe) static var workspaceSurfaceTask: UInt8 = 0
        nonisolated(unsafe) static var workspaceSurfaceGeneration: UInt8 = 0
        nonisolated(unsafe) static var workspaceSurfaceBoundSession: UInt8 = 0
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

    var agentTerminalLifecycleRouter: AgentFeedTerminalLifecycleRouter {
        if let router = objc_getAssociatedObject(
            self,
            &Keys.agentTerminalLifecycleRouter
        ) as? AgentFeedTerminalLifecycleRouter {
            return router
        }
        let router = AgentFeedTerminalLifecycleRouter()
        objc_setAssociatedObject(
            self,
            &Keys.agentTerminalLifecycleRouter,
            router,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
        return router
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

    var workspaceSurface: WorkspaceWorkbenchSurface? {
        get { objc_getAssociatedObject(self, &Keys.workspaceSurface) as? WorkspaceWorkbenchSurface }
        set { objc_setAssociatedObject(self, &Keys.workspaceSurface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var workspaceBrowser: WorkspaceFilesBrowser? {
        get { objc_getAssociatedObject(self, &Keys.workspaceBrowser) as? WorkspaceFilesBrowser }
        set { objc_setAssociatedObject(self, &Keys.workspaceBrowser, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var filesTransport: WorkspaceFilesTransport? {
        get { objc_getAssociatedObject(self, &Keys.filesTransport) as? WorkspaceFilesTransport }
        set { objc_setAssociatedObject(self, &Keys.filesTransport, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var workspaceSurfaceTask: Task<Void, Never>? {
        get { objc_getAssociatedObject(self, &Keys.workspaceSurfaceTask) as? Task<Void, Never> }
        set { objc_setAssociatedObject(self, &Keys.workspaceSurfaceTask, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    // Bumped by every teardown/rebuild so an in-flight open Task can tell it has been superseded and
    // must not touch surface state or reset the loading flag.
    private var workspaceSurfaceGeneration: Int {
        get { (objc_getAssociatedObject(self, &Keys.workspaceSurfaceGeneration) as? Int) ?? 0 }
        set { objc_setAssociatedObject(self, &Keys.workspaceSurfaceGeneration, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    // The session transport the mounted Workspace surface was opened from, so a reconnect can detect the
    // transport swap and rebuild (mirrors agentSurfaceBoundTransport).
    private var workspaceSurfaceBoundSession: QuicSessionClientTransport? {
        get { (objc_getAssociatedObject(self, &Keys.workspaceSurfaceBoundSession) as? AgentSurfaceTransportBinding)?.transport }
        set {
            objc_setAssociatedObject(
                self,
                &Keys.workspaceSurfaceBoundSession,
                AgentSurfaceTransportBinding(newValue),
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC
            )
        }
    }

    private var workspaceSurfaceLoading: Bool {
        get { (objc_getAssociatedObject(self, &Keys.workspaceSurfaceLoading) as? Bool) ?? false }
        set { objc_setAssociatedObject(self, &Keys.workspaceSurfaceLoading, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
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
        let seg = UISegmentedControl()
        configureSurfaceSegments(seg)
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

    @discardableResult
    func teardownAgentSurface() -> Task<Void, Never>? {
        activeControlSurface = .control
        // Detach the push sink so no transport delivers to a dead surface.
        pairingClient.onAgentPush = nil

        let surface = agentSurface
        let terminalCloseTask = agentTerminalLifecycleRouter.teardown(surface) { [self] in
            surface?.removeFromSuperview()
            agentSurface = nil
            agentSurfaceBoundTransport = nil
        }

        if #available(iOS 26.0, *) {
            terminalSurface?.detach()
            terminalSurface?.removeFromSuperview()
            terminalSurface = nil
        }

        // The switcher owns all non-control surfaces; tear the browser down too
        // so a reconnect rebuilds all three cleanly from the fresh session.
        teardownDomMirrorSurface()
        teardownWorkspaceSurface()

        surfaceSegmentedControl?.removeFromSuperview()
        surfaceSegmentedControl = nil
        return terminalCloseTask
    }

    // Workspace surface teardown mirrors the other non-control surfaces: sever the model binding, close
    // the .files lane transport (so the old QUIC stream is not leaked), remove the view, and clear
    // every associated handle so a reconnect rebuilds a fresh surface bound to the new session
    // rather than a dead one.
    private func teardownWorkspaceSurface() {
        // Supersede any in-flight open Task so it cannot install a surface bound to the dead session
        // after we tear down, and cancel it for promptness.
        workspaceSurfaceGeneration += 1
        workspaceSurfaceTask?.cancel()
        workspaceSurfaceTask = nil
        workspaceSurface?.teardown()
        workspaceSurface?.removeFromSuperview()
        workspaceSurface = nil
        workspaceBrowser = nil
        workspaceSurfaceBoundSession = nil
        if let transport = filesTransport {
            Task { await transport.close() }
        }
        filesTransport = nil
        workspaceSurfaceLoading = false
    }

    // Rebuilds the Workspace surface when it is mounted but bound to a superseded session transport
    // (e.g. a background/foreground app switch closed the old session and opened a new one). Mirrors
    // rebindAgentSurfaceAfterReconnectIfNeeded; without it the Workspace tab stays bound to a closed
    // transport because the ensureWorkspaceSurface guard sees a non-nil surface and bails.
    func rebindWorkspaceSurfaceAfterReconnectIfNeeded() {
        guard workspaceSurface != nil else { return }
        guard workspaceSurfaceBoundSession !== pairingClient.activeSessionTransport else { return }
        let wasActive = activeControlSurface == .workspace
        teardownWorkspaceSurface()
        if wasActive { ensureWorkspaceSurface() }
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

        let surface = AgentFeedSurface(closeDelivery: agentTerminalLifecycleRouter.closeDelivery)
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
        let transport = pairingClient.activeSessionTransport
        agentSurfaceBoundTransport = transport
        surface.bindTerminalDependencies(coordinator: transport, sessionOpener: transport)

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
        guard let transport = pairingClient.activeSessionTransport else { return }
        agentTerminalLifecycleRouter.bind(transport)
        guard let surface = agentSurface else { return }
        guard agentSurfaceBoundTransport !== transport else {
            return
        }
        agentSurfaceBoundTransport = transport
        surface.bindTerminalDependencies(coordinator: transport, sessionOpener: transport)
        pairingClient.onAgentPush = { [weak surface] json in
            surface?.deliver(rawJSON: json)
        }
        surface.resumeAfterSessionReconnect()
    }

    @objc private func surfaceSegmentChanged(_ sender: UISegmentedControl) {
        let surface = selectedSurface(on: sender)
        if activeControlSurface == .agent, surface != .agent {
            agentTerminalLifecycleRouter.route(.switchAway, to: agentSurface)
        }
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
        case .workspace:
            // Open the .files lane and build the workbench on first switch to Workspace.
            ensureWorkspaceSurface()
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
        rebindWorkspaceSurfaceAfterReconnectIfNeeded()

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
        case .workspace:
            ensureWorkspaceSurface()
        }
        pairingClient.activeDomMirror?.setCapture(activeControlSurface == .browser)
        domMirrorSurface?.setPaused(activeControlSurface != .browser)
    }

    // The ordered surfaces the current toggle offers. Browser is present only with a `.dom` lane;
    // availability is fixed for the session, so the index<->surface mapping is stable between rebuilds.
    private func currentSurfaces() -> [ControlSurface] {
        availableControlSurfaces(browserAvailable: pairingClient.activeDomMirror != nil)
    }

    // Populates the toggle with one icon segment per available surface. Icons (SF Symbols) keep all
    // five segments legible on the narrowest supported iPhone where five text labels would truncate;
    // each segment carries the surface's accessibility label so VoiceOver and the a11y-driven Maestro
    // flows still target it by name.
    private func configureSurfaceSegments(_ seg: UISegmentedControl) {
        seg.removeAllSegments()
        for (index, surface) in currentSurfaces().enumerated() {
            let image = UIImage(systemName: surface.switcherSymbolName)
            image?.accessibilityLabel = surface.switcherAccessibilityLabel
            seg.insertSegment(with: image, at: index, animated: false)
        }
        seg.accessibilityIdentifier = "surface-switcher"
    }

    // Maps the selected segment to a ControlSurface by reading the segment's own image accessibility
    // label — the source of truth for what was actually built — rather than re-deriving the surface
    // list. An unknown/absent label falls back safely to .control instead of silently resolving to a
    // wrong surface if build-time and tap-time availability ever diverged.
    private func selectedSurface(on seg: UISegmentedControl) -> ControlSurface {
        let index = seg.selectedSegmentIndex
        guard index >= 0, index < seg.numberOfSegments,
              let label = seg.imageForSegment(at: index)?.accessibilityLabel,
              let surface = ControlSurface(switcherAccessibilityLabel: label) else {
            return .control
        }
        return surface
    }

    private func segmentIndex(for surface: ControlSurface, in seg: UISegmentedControl) -> Int {
        for index in 0..<seg.numberOfSegments
            where seg.imageForSegment(at: index)?.accessibilityLabel == surface.switcherAccessibilityLabel {
            return index
        }
        activeControlSurface = .control
        return 0
    }

    private func refreshSurfaceToggleSegments(_ seg: UISegmentedControl) {
        let surfaces = currentSurfaces()
        guard surfaces.count != seg.numberOfSegments else { return }

        if !surfaces.contains(.browser) {
            if activeControlSurface == .browser {
                activeControlSurface = .control
            }
            teardownDomMirrorSurface()
        }

        configureSurfaceSegments(seg)
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
        workspaceSurface?.isHidden = v.workspaceHidden

        Self.logger.debug("active surface: \(String(describing: surface))")
    }

    // Idempotent: opens the .files lane, builds the browser + workbench, and loads the workspace list.
    // The browser restores the last valid workspace but deliberately starts with an empty editor;
    // without history it stays on the picker. The lane is available on any active session, so unlike
    // Browser this needs no capability gate. The loading flag guards against rapid segment taps.
    func ensureWorkspaceSurface() {
        guard workspaceSurface == nil, !workspaceSurfaceLoading else { return }
        guard let session = pairingClient.activeSessionTransport else { return }
        workspaceSurfaceLoading = true
        // Capture the generation so this Task can detect if a teardown/rebuild superseded it while
        // it was suspended on the async open (the reconnect/app-switch race).
        let generation = workspaceSurfaceGeneration
        workspaceSurfaceTask = Task { [weak self] in
            guard let self else { return }
            do {
                let transport = try await session.openWorkspaceFilesTransport()
                guard self.workspaceSurfaceGeneration == generation else {
                    await transport.close()
                    return
                }
                let browser = WorkspaceFilesBrowser(transport: transport)
                let surface = WorkspaceWorkbenchSurface(
                    browser: browser,
                    terminalCoordinator: session,
                    terminalSessionOpener: session
                )
                surface.translatesAutoresizingMaskIntoConstraints = false
                surface.isHidden = self.activeControlSurface != .workspace
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
                self.filesTransport = transport
                self.workspaceBrowser = browser
                self.workspaceSurface = surface
                self.workspaceSurfaceBoundSession = session
                self.workspaceSurfaceLoading = false
                self.workspaceSurfaceTask = nil
                await browser.loadWorkspaces()
            } catch {
                Self.logger.error("files surface open failed: \(String(describing: error), privacy: .public)")
                guard self.workspaceSurfaceGeneration == generation else { return }
                self.workspaceSurfaceLoading = false
                self.workspaceSurfaceTask = nil
                // The lane never opened; fall back to Control so the user isn't stranded on a blank
                // Workspace screen with every other surface hidden.
                if self.activeControlSurface == .workspace {
                    self.activeControlSurface = .control
                    if let seg = self.surfaceSegmentedControl {
                        seg.selectedSegmentIndex = self.segmentIndex(for: .control, in: seg)
                    }
                    self.applySurface(.control)
                }
            }
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
                case .rawEvent(let request):
                    try await channel.sendAgentRawEventRequest(request)
                }
            } catch {
                Self.logger.error(
                    "agent request send failed: \(String(describing: error), privacy: .public)"
                )
            }
        }
    }
}
