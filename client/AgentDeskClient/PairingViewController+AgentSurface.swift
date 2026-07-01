import OSLog
import UIKit
import WebKit

// Extension: agent-feed surface toggle and lifecycle.
//
// The agent surface sits full-bleed alongside the existing control surfaces
// (trackpad, display rail, keyboard). A segmented control in the safe-area top
// lets the user switch between CONTROL mode and AGENT mode. When agent is shown
// the existing interactive surfaces are hidden so gestures do not conflict;
// when control is shown the webview is hidden.
//
// Lifecycle (state-driven, race-free):
//   - The TOGGLE is added from render()'s .connected case via
//     showSurfaceToggleIfNeeded() (idempotent). render() runs on every state
//     change, so the toggle can never be skipped by a one-shot channel-set race.
//   - The WEBVIEW is created LAZILY the first time the user switches to Agent
//     (ensureAgentSurface), pulling the channel and transport at that moment
//     (both reliably non-nil once connected). This removes any need for a valid
//     channel at toggle-creation time.
//   - teardownAgentSurface() (toggle + surface) runs on every non-connected
//     state, so a reconnect re-shows the toggle cleanly.

extension PairingViewController {
    private static let logger = Logger(subsystem: Config.logSubsystem, category: "agent-surface")

    // MARK: - Properties (stored via objc_associated_objects to avoid modifying the primary file)

    private enum Keys {
        nonisolated(unsafe) static var agentSurface: UInt8 = 0
        nonisolated(unsafe) static var surfaceSegmentedControl: UInt8 = 0
        nonisolated(unsafe) static var agentSurfaceConstraints: UInt8 = 0
    }

    var agentSurface: AgentFeedSurface? {
        get { objc_getAssociatedObject(self, &Keys.agentSurface) as? AgentFeedSurface }
        set { objc_setAssociatedObject(self, &Keys.agentSurface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    var surfaceSegmentedControl: UISegmentedControl? {
        get { objc_getAssociatedObject(self, &Keys.surfaceSegmentedControl) as? UISegmentedControl }
        set { objc_setAssociatedObject(self, &Keys.surfaceSegmentedControl, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }

    // MARK: - Toggle UI (state-driven from render())

    // Idempotent: adds the Control/Agent segmented toggle once, with the
    // safe-area-top constraints. Called from render()'s .connected case, which
    // runs on every state change, so the toggle cannot be skipped by a channel
    // timing race. The webview itself is created lazily on first Agent select.
    func showSurfaceToggleIfNeeded() {
        guard surfaceSegmentedControl == nil else {
            // Already present; keep it on top of any later-added media chrome.
            if let seg = surfaceSegmentedControl {
                view.bringSubviewToFront(seg)
            }
            return
        }

        let seg = UISegmentedControl(items: ["Control", "Agent"])
        seg.selectedSegmentIndex = 0
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
    }

    func teardownAgentSurface() {
        // Detach the push closure so the transport no longer delivers to a dead surface.
        pairingClient.activeSessionTransport?.onAgentPush = nil

        agentSurface?.teardown()
        agentSurface?.removeFromSuperview()
        agentSurface = nil

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

        // Wire inbound: JS requests -> InputChannel sends. The channel is pulled
        // live on each request so a reconnect's fresh channel is used.
        surface.onAgentRequest = { [weak self] request in
            guard let self, let channel = self.pairingClient.activeInputChannel else { return }
            self.forwardAgentRequest(request, on: channel)
        }

        // Wire outbound: OwnedMediaTransport pushes -> surface.deliver.
        if let transport = pairingClient.activeSessionTransport {
            transport.onAgentPush = { [weak surface] json in
                surface?.deliver(rawJSON: json)
            }
        }

        // Keep the toggle above the freshly-added full-bleed surface.
        if let seg = surfaceSegmentedControl {
            view.bringSubviewToFront(seg)
        }

        return surface
    }

    @objc private func surfaceSegmentChanged(_ sender: UISegmentedControl) {
        let showAgent = sender.selectedSegmentIndex == 1
        if showAgent {
            // Create the webview and wire the bridge on first switch to Agent.
            ensureAgentSurface()
        }
        applyAgentSurfaceVisibility(showAgent: showAgent)
    }

    // MARK: - Visibility

    private func applyAgentSurfaceVisibility(showAgent: Bool) {
        agentSurface?.isHidden = !showAgent

        // When agent mode is active, suppress the interactive surfaces so
        // gesture recognizers do not fight the webview scroll.
        trackpadView.isHidden = showAgent
        trackpadHint.isHidden = showAgent
        scrollStripView.isHidden = showAgent
        scrollStripHint.isHidden = showAgent
        buttonRow.isHidden = showAgent
        displayRailView.isHidden = showAgent
        // The keyboard surface is a first-responder helper; just disable it.
        keyboardSurface.isUserInteractionEnabled = !showAgent

        Self.logger.debug("agent surface visible: \(showAgent)")
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
