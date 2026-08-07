import OSLog
import UIKit
import WebKit
import AgentDeskWire
import AgentPanel

// Extension: host-backed surface switcher and lifecycle for Control, Agent,
// Terminal, Browser, Workspace, and IDE.
// The ControlSurface enum + visibility(for:) mapping live in ControlSurface.swift.
//
// Each non-control surface fills the screen and the shared right-side control
// rail overlays it, so switching between them costs no width. When a non-control
// surface is shown the interactive control surfaces are hidden so gestures do
// not conflict; the inactive surfaces are hidden too.
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

    var workspaceSurface: WorkspaceWorkbenchSurface? {
        get { objc_getAssociatedObject(self, &Keys.workspaceSurface) as? WorkspaceWorkbenchSurface }
        set { objc_setAssociatedObject(self, &Keys.workspaceSurface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var workspaceBrowser: WorkspaceFilesBrowser? {
        get { objc_getAssociatedObject(self, &Keys.workspaceBrowser) as? WorkspaceFilesBrowser }
        set { objc_setAssociatedObject(self, &Keys.workspaceBrowser, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    private var filesTransport: WorkspaceTransport? {
        get { objc_getAssociatedObject(self, &Keys.filesTransport) as? WorkspaceTransport }
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

    // Idempotent: populates the surface section of the shared right-side rail.
    // Called from render()'s .connected case, which runs on every state change,
    // so the switcher cannot be skipped by a channel timing race. Webviews are
    // still created lazily on first selection.
    func showSurfaceToggleIfNeeded() {
        let wasConfigured = !surfaceControlRail.surfaceButtons.isEmpty
        let previousSurface = activeControlSurface
        refreshSurfaceToggle()
        surfaceControlRail.select(activeControlSurface)
        view.bringSubviewToFront(surfaceControlRail)
        if !wasConfigured || previousSurface != activeControlSurface {
            applySurface(activeControlSurface)
        }
    }

    @discardableResult
    func teardownAgentSurface() -> Task<Void, Never>? {
        if activeControlSurface != .voice {
            activeControlSurface = .control
        }
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

        // Tear down only session-owned surfaces. Voice is a local utility and
        // remains mounted when the host is absent or disconnects.
        teardownDomMirrorSurface()
        teardownWorkspaceSurface()
        teardownIDESurface()

        // The buttons outlive the session they open. Emptying the rail on
        // disconnect made the app look like it had lost features rather than a
        // connection; refreshing leaves the list intact and dims what a dead
        // session can no longer serve.
        refreshSurfaceToggle()
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

    // Creates the hidden AgentFeedSurface (full-bleed under the overlaid control
    // rail, starting at the top safe area) and wires both bridge directions,
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
        hostContentView.addSubview(surface)
        constrainSurfaceUnderControlRail(surface, bottomAnchor: view.bottomAnchor)
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

        // Composer sync takes the same live-channel path but bypasses `AgentFeedRequest`: the host
        // answers it from its own Accessibility stack rather than the transcript sidecar, so it never
        // enters the agent-feed envelope. Dropping when no channel is attached is correct here -- the
        // panel keeps its field disabled until a status arrives, so a dropped watch reads as
        // unavailable rather than as a write that silently did not happen.
        surface.onWindowInput = { [weak self] request in
            guard let self else { return }
            guard let channel = self.pairingClient.activeInputChannel else {
                Self.logger.notice("agent-feed: window input dropped, no active input channel")
                return
            }
            self.forwardWindowInput(request, on: channel)
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

        view.bringSubviewToFront(surfaceControlRail)

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

    func surfaceSelectionChanged(_ surface: ControlSurface) {
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
        case .ide:
            ensureIDESurface()
        case .voice:
            ensureVoiceSurface()
        }
        if surface != .voice {
            suspendVoiceSurfaceIfNeeded()
            surfaceControlRail.setUtilityButton(
                voiceToggleButton,
                selected: false
            )
            // A host may connect while Voice is active. Voice deliberately
            // skips media startup, so the first host-backed selection owns
            // starting it instead.
            if case .connected = pairingClient.state {
                scheduleMediaTransportStartIfNeeded()
            }
        }
        applySurface(surface)
        pushMediaViewerState()

        // Release this viewer whenever Browser is not the active surface. The host keeps capture
        // alive if another viewer remains active and restores native Chrome when the last releases.
        domMirrorSurface?.setPaused(surface != .browser)
    }

    func rebindActiveSurfaceAfterReconnect() {
        rebindAgentSurfaceAfterReconnectIfNeeded()
        rebindWorkspaceSurfaceAfterReconnectIfNeeded()
        rebindIDESurfaceAfterReconnectIfNeeded()

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
                surfaceControlRail.select(.control)
            }
        case .workspace:
            ensureWorkspaceSurface()
        case .ide:
            ensureIDESurface()
        case .voice:
            // Nothing to rebind: the probe holds no session lane.
            ensureVoiceSurface()
        }
        domMirrorSurface?.setPaused(activeControlSurface != .browser)
    }

    // The ordered host-backed surfaces the current rail offers. Browser is
    // present only with a `.dom` lane; availability is fixed for the session,
    // so the index<->surface mapping is stable between rebuilds.
    private func currentSurfaces() -> [ControlSurface] {
        availableControlSurfaces(browserAvailable: pairingClient.activeDomMirror != nil)
    }

    private func refreshSurfaceToggle() {
        let surfaces = currentSurfaces()
        if !surfaces.contains(.browser) {
            if activeControlSurface == .browser {
                activeControlSurface = .control
            }
            teardownDomMirrorSurface()
        }

        surfaceControlRail.setSurfaces(
            surfaces,
            selected: activeControlSurface,
            onSelection: { [weak self] surface in
                self?.surfaceSelectionChanged(surface)
            }
        )
        surfaceControlRail.setEnabledSurfaces(openableSurfaces())
    }

    /// Control is this app's own screen and works with no Mac at all. Every other
    /// surface reads a lane off the session, so before the handshake they are
    /// listed but not openable.
    private func openableSurfaces() -> Set<ControlSurface> {
        let hasSession: Bool
        if case .connected = pairingClient.state {
            hasSession = true
        } else {
            hasSession = preservesSuspendedSessionSurfaces
        }
        return hasSession ? Set(currentSurfaces()) : [.control]
    }

    // MARK: - Visibility

    /// Gives a surface the whole width and lets the control rail overlay it.
    ///
    /// Reserving a column for the rail cost every surface ~68pt of width for a
    /// panel that is idle most of the time, and a terminal pays that in columns
    /// of text. The rail is a sibling of `hostContentView` on `view` and is kept
    /// in front, so it floats over the surface the way it already floats over the
    /// gesture webview; its chevron closes it down to a single button when the
    /// surface needs the full screen.
    func constrainSurfaceUnderControlRail(
        _ surface: UIView,
        bottomAnchor: NSLayoutYAxisAnchor
    ) {
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            surface.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    func applySurface(_ surface: ControlSurface) {
        let v = visibility(for: surface)
        hostContentView.isHidden = v.hostContentHidden
        if !v.keyboardInteractive {
            applyKeyboardPresentationIntent(.hide)
        }

        agentSurface?.isHidden = v.agentHidden
        agentSurface?.setViewportPresented(!v.agentHidden)
        domMirrorSurface?.isHidden = v.browserHidden
        if #available(iOS 26.0, *) {
            terminalSurface?.isHidden = v.terminalHidden
            terminalSurface?.setViewportPresented(!v.terminalHidden)
        }

        // The combined selected-surface, layout-mode, and keyboard policy
        // below owns relative-control and bottom-row presentation.
        displayRailView.isHidden = v.controlChromeHidden
        // The keyboard surface is a first-responder helper; just disable it.
        keyboardSurface.isUserInteractionEnabled = v.keyboardInteractive
        applyVideoTouchState()
        workspaceSurface?.isHidden = v.workspaceHidden
        workspaceSurface?.setViewportPresented(!v.workspaceHidden)
        ideSurface?.isHidden = v.ideHidden
        ideSurface?.setViewportPresented(!v.ideHidden)
        voiceSurface?.isHidden = v.voiceHidden

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
                let transport = try await session.openWorkspaceTransport()
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
                self.hostContentView.addSubview(surface)
                self.constrainSurfaceUnderControlRail(
                    surface,
                    bottomAnchor: self.view.bottomAnchor
                )
                self.view.bringSubviewToFront(self.surfaceControlRail)
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
                    self.surfaceControlRail.select(.control)
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
        hostContentView.addSubview(surface)
        constrainSurfaceUnderControlRail(
            surface,
            bottomAnchor: view.keyboardLayoutGuide.topAnchor
        )
        terminalSurface = surface
        surface.connect(using: pairingClient.activeSessionTransport)
        view.bringSubviewToFront(surfaceControlRail)
        return surface
    }

    // MARK: - Request forwarding

    /// Encodes one composer-sync request onto the input lane.
    ///
    /// Takes `AgentPanelRequest` rather than a client-side enum because these four requests carry no
    /// client-side behavior at all: unlike a terminal intent, which also drives the local PTY view, the
    /// phone's only part here is transport. The panel's own decoder already bounded these fields, and the
    /// host bounds them again on arrival because this side is remote.
    private func forwardWindowInput(_ request: AgentPanelRequest, on channel: InputChannel) {
        Task {
            do {
                switch request {
                case .windowInputWatch(let subscriptionId, let sessionId):
                    try await channel.sendAgentWindowInputWatch(AgentWindowInputWatch(
                        subscriptionId: subscriptionId,
                        sessionId: sessionId
                    ))
                case .windowInputUnwatch(let subscriptionId):
                    try await channel.sendAgentWindowInputUnwatch(AgentWindowInputUnwatch(
                        subscriptionId: subscriptionId
                    ))
                case .windowInputSync(let requestId, let sessionId, let text):
                    try await channel.sendAgentWindowInputSync(AgentWindowInputSync(
                        requestId: requestId,
                        sessionId: sessionId,
                        text: text
                    ))
                case .windowInputRead(let requestId, let sessionId):
                    try await channel.sendAgentWindowInputRead(AgentWindowInputRead(
                        requestId: requestId,
                        sessionId: sessionId
                    ))
                case .windowInputSubmit(let requestId, let sessionId, let text):
                    try await channel.sendAgentWindowInputSubmit(AgentWindowInputSubmit(
                        requestId: requestId,
                        sessionId: sessionId,
                        text: text
                    ))
                default:
                    preconditionFailure("Only composer-sync requests route through forwardWindowInput")
                }
            } catch {
                Self.logger.error(
                    "window input send failed: \(String(describing: error), privacy: .public)"
                )
            }
        }
    }

    private func forwardAgentRequest(_ request: AgentFeedRequest, on channel: InputChannel) {
        Task {
            do {
                switch request {
                case .projectsWatch(let request):
                    try await channel.sendAgentProjectsWatch(request)
                case .projectsUnwatch(let request):
                    try await channel.sendAgentProjectsUnwatch(request)
                case .projectSessionsWatch(let request):
                    try await channel.sendAgentProjectSessionsWatch(request)
                case .projectSessionsUnwatch(let request):
                    try await channel.sendAgentProjectSessionsUnwatch(request)
                case .threadSubscribe(let sub):
                    try await channel.sendAgentThreadSubscribe(sub)
                case .threadLoadOlder(let older):
                    try await channel.sendAgentThreadLoadOlder(older)
                case .threadUnsubscribe(let unsub):
                    try await channel.sendAgentThreadUnsubscribe(unsub)
                case .rawEvent(let request):
                    try await channel.sendAgentRawEventRequest(request)
                case .sessionCreate(let request):
                    try await channel.sendAgentSessionCreate(request)
                case .sessionSend(let request):
                    try await channel.sendAgentSessionSend(request)
                case .sessionAbort(let request):
                    try await channel.sendAgentSessionAbort(request)
                case .extensionUIResponse(let response):
                    try await channel.sendAgentExtensionUIResponse(response)
                }
            } catch {
                Self.logger.error(
                    "agent request send failed: \(String(describing: error), privacy: .public)"
                )
            }
        }
    }
}
