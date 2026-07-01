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
// The surface is created at session-start and torn down at session-end, matching
// the mediaTransport lifecycle. It is NOT created when unpaired.

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

    // MARK: - Mount / tear down

    func mountAgentSurface(channel: InputChannel) {
        guard agentSurface == nil else { return }

        let surface = AgentFeedSurface()
        surface.translatesAutoresizingMaskIntoConstraints = false
        surface.isHidden = true
        view.addSubview(surface)
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: view.topAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            surface.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        agentSurface = surface

        // Wire inbound: JS requests -> InputChannel sends.
        surface.onAgentRequest = { [weak self, weak channel] request in
            guard let channel else { return }
            self?.forwardAgentRequest(request, on: channel)
        }

        // Wire outbound: OwnedMediaTransport pushes -> surface.deliver.
        if let transport = pairingClient.activeSessionTransport {
            transport.onAgentPush = { [weak surface] json in
                surface?.deliver(rawJSON: json)
            }
        }

        // Add the segmented surface toggle.
        addSurfaceToggle()
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

    // MARK: - Toggle UI

    private func addSurfaceToggle() {
        guard surfaceSegmentedControl == nil else { return }

        let seg = UISegmentedControl(items: ["Control", "Agent"])
        seg.selectedSegmentIndex = 0
        seg.translatesAutoresizingMaskIntoConstraints = false
        seg.addTarget(self, action: #selector(surfaceSegmentChanged(_:)), for: .valueChanged)
        view.addSubview(seg)
        NSLayoutConstraint.activate([
            seg.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            seg.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8)
        ])
        surfaceSegmentedControl = seg
    }

    @objc private func surfaceSegmentChanged(_ sender: UISegmentedControl) {
        let showAgent = sender.selectedSegmentIndex == 1
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
