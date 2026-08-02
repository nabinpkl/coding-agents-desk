import AppKit
import InteractionPanel
import os
import WebKit

/// A key-able nonactivating all-Spaces panel. The host remains an accessory app
/// while the bundled webview can receive the explicit click that WebKit needs
/// before it grants microphone capture.
private final class DictationBarPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// All-Spaces dictation chrome. This intentionally owns no audio pipeline: the
/// embedded DictationMini records through the shared browser voice session and
/// the Python sidecar. Native code owns only placement, Fn routing, permission,
/// and final focused-app text insertion.
@MainActor
final class DictationBarController: NSObject {
    private enum DefaultsKey {
        static let originX = "DictationBar.origin.x"
        static let originY = "DictationBar.origin.y"
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "dictation")
    private let transport = DictationPanelTransport()
    private let userDefaults: UserDefaults
    private let typeText: (String) -> Void
    private var panel: NSPanel?
    private var panelController: InteractionPanelWebViewController?
    private var fnKeyMonitor: Any?
    private var state = DictationBarState()

    /// Supplies the SpaceAgent handle's screen rect so the bar can stay clear
    /// of it, including after the mini expands for capture/finalization.
    var spaceAgentHandleFrame: (() -> CGRect?)?
    var onFrameDidChange: (() -> Void)?
    /// Drives the top-bar Voice command. A second full Voice surface may open
    /// only after the current mini session reaches a terminal state.
    var onBusyChanged: ((Bool) -> Void)?

    init(
        userDefaults: UserDefaults = .standard,
        typeText: @escaping (String) -> Void = { _ in }
    ) {
        self.userDefaults = userDefaults
        self.typeText = typeText
        super.init()
        transport.onReady = { [weak self] in self?.state.markWebReady() }
        transport.onLayout = { [weak self] expanded in self?.resizePanel(expanded: expanded) }
        transport.onRunState = { [weak self] status in self?.applyRunState(status) }
        transport.onCommit = { [weak self] recordingID, transcript in
            self?.commit(recordingID: recordingID, transcript: transcript)
        }
    }

    func start() {
        guard panel == nil else { return }
        let size = DictationBarState.compactSize
        let origin = avoiding(
            origin: restoredOrigin(size: size) ?? bottomCenterOrigin(size: size),
            size: size
        )
        let panel = DictationBarPanel(
            contentRect: CGRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.delegate = self
        self.panel = panel

        do {
            let controller = try InteractionPanelWebViewController(
                transport: transport,
                contract: .dictation,
                additionalUserScripts: [InteractionPanelHostConfiguration.voiceConfigScript()]
            )
            panelController = controller
            controller.webView.uiDelegate = self
            panel.contentView = controller.webView
        } catch {
            logger.error("dictation mini init failed: \(String(describing: error), privacy: .public)")
            panel.contentView = makeUnavailableView()
        }

        panel.orderFrontRegardless()
        installFnKeyMonitor()
    }

    func currentScreenFrame() -> CGRect? { panel?.frame }

    func stop() {
        uninstallFnKeyMonitor()
        // Closing the webview during a live run drops the loopback socket. The
        // sidecar finalizes nonempty audio as an interrupted recording.
        if isBusy { deliverCapture(.stop) }
        panelController?.teardown()
        panelController = nil
        panel?.close()
        panel = nil
        state.resetForTeardown()
        onBusyChanged?(false)
    }

    func keepClearOfSpaceAgentHandle() {
        guard let panel, !isBusy else { return }
        let size = panel.frame.size
        let placed = avoiding(origin: panel.frame.origin, size: size)
        guard placed != panel.frame.origin else { return }
        panel.setFrame(CGRect(origin: placed, size: size), display: true)
        onFrameDidChange?()
    }

    private var isBusy: Bool {
        state.isBusy
    }

    private func applyRunState(_ status: InteractionDictationRunStatus) {
        state.applyRunStatus(status)
        onBusyChanged?(isBusy)
    }

    private func commit(recordingID: String, transcript: String) {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard state.shouldCommit(recordingID: recordingID, transcript: trimmed) else { return }
        logger.notice("dictation transcript committed recording=\(recordingID, privacy: .public) chars=\(trimmed.count, privacy: .public)")
        // This panel never activates the host app, so the focused external app
        // remains the insertion target while capture and finalization happen.
        typeText(trimmed + " ")
    }

    private func installFnKeyMonitor() {
        guard fnKeyMonitor == nil else { return }
        fnKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { [weak self] event in
            let pressed = event.modifierFlags.contains(.function)
            Task { @MainActor in self?.handleFnState(pressed) }
        }
    }

    private func uninstallFnKeyMonitor() {
        if let fnKeyMonitor {
            NSEvent.removeMonitor(fnKeyMonitor)
            self.fnKeyMonitor = nil
        }
    }

    private func handleFnState(_ pressed: Bool) {
        guard let command = state.captureCommand(functionPressed: pressed) else { return }
        deliverCapture(command)
    }

    private func deliverCapture(_ command: DictationBarState.CaptureCommand) {
        let payload = #"{"type":"dictationCapture","payload":{"command":"\#(command.rawValue)"}}"#
        panelController?.deliver(rawJSON: payload)
    }

    private func resizePanel(expanded: Bool) {
        guard let panel else { return }
        let size = DictationBarState.panelSize(expanded: expanded)
        guard panel.frame.size != size else { return }
        let old = panel.frame
        let proposed = CGPoint(x: old.midX - size.width / 2, y: old.minY)
        let clamped = SpaceAgentPanelPlacement.clampedOrigin(
            proposed: proposed,
            size: size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        )
        panel.setFrame(
            CGRect(origin: avoiding(origin: clamped, size: size), size: size),
            display: true
        )
        onFrameDidChange?()
    }

    private func avoiding(origin: CGPoint, size: CGSize) -> CGPoint {
        guard let handle = spaceAgentHandleFrame?() else { return origin }
        return SpaceAgentPanelPlacement.nonOverlappingOrigin(
            proposed: origin,
            size: size,
            avoid: handle,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        )
    }

    private func bottomCenterOrigin(size: CGSize) -> CGPoint {
        let frame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGPoint(x: frame.midX - size.width / 2, y: frame.minY + 24)
    }

    private func restoredOrigin(size: CGSize) -> CGPoint? {
        guard userDefaults.object(forKey: DefaultsKey.originX) != nil,
              userDefaults.object(forKey: DefaultsKey.originY) != nil
        else { return nil }
        return SpaceAgentPanelPlacement.clampedOrigin(
            proposed: CGPoint(
                x: userDefaults.double(forKey: DefaultsKey.originX),
                y: userDefaults.double(forKey: DefaultsKey.originY)
            ),
            size: size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        )
    }

    private func save(origin: CGPoint) {
        userDefaults.set(Double(origin.x), forKey: DefaultsKey.originX)
        userDefaults.set(Double(origin.y), forKey: DefaultsKey.originY)
    }

    private func makeUnavailableView() -> NSView {
        let label = NSTextField(labelWithString: "Dictation unavailable")
        label.alignment = .center
        label.textColor = .secondaryLabelColor
        let view = NSView()
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        return view
    }
}

extension DictationBarController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
        let isBundledOrigin = origin.protocol == "interactionfeed" && origin.host == "app"
        decisionHandler(isBundledOrigin && type == .microphone ? .grant : .deny)
    }
}

extension DictationBarController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        guard let panel else { return }
        save(origin: panel.frame.origin)
        onFrameDidChange?()
    }
}
