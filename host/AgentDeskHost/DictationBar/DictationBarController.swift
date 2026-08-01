import AppKit
import AVFoundation
import CoreGraphics
import InteractionPanel
import os
import WebKit

/// A focus-less nonactivating all-Spaces panel.
///
/// This panel must never hold the keyboard, because the transcript it produces
/// is delivered as synthesized key events to whatever holds it. Taking key on
/// the click that starts a run points that delivery back at our own webview,
/// so the dictation lands nowhere and the field the user was typing in stays
/// empty. The webview still receives the click WebKit needs before it grants
/// microphone capture: `WebPanelWebView` accepts first mouse, which delivers
/// the press without moving focus.
private final class DictationBarPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// WebKit owns the visual shell, so `NSPanel.isMovableByWindowBackground`
/// cannot see clicks behind the webview. This narrow native hit target keeps a
/// real macOS drag affordance without intercepting the microphone control.
private final class DictationPanelDragHandleView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

private final class DictationPanelContentView: NSView {
    init(webView: WKWebView) {
        super.init(frame: .zero)
        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)

        let dragHandle = DictationPanelDragHandleView()
        dragHandle.translatesAutoresizingMaskIntoConstraints = false
        dragHandle.toolTip = "Drag dictation"
        dragHandle.setAccessibilityLabel("Drag dictation")
        addSubview(dragHandle)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            dragHandle.leadingAnchor.constraint(equalTo: leadingAnchor),
            dragHandle.trailingAnchor.constraint(equalTo: trailingAnchor),
            dragHandle.topAnchor.constraint(equalTo: topAnchor),
            dragHandle.heightAnchor.constraint(equalToConstant: 14),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
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
    /// Mirrors the default input device. A panel built later must open with the
    /// current answer, not the one that was true when the app launched.
    private var echoCancellation = DefaultAudioInput.shouldCancelEcho()

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
        transport.onReady = { [weak self] in self?.markWebReady() }
        transport.onLayout = { [weak self] layout in self?.resizePanel(to: layout) }
        transport.onRunState = { [weak self] status, message in
            self?.applyRunState(status, message: message)
        }
        transport.onCommit = { [weak self] recordingID, transcript in
            self?.commit(recordingID: recordingID, transcript: transcript)
        }
    }

    func start() {
        guard panel == nil else {
            logger.notice("dictation start ignored: panel already open")
            return
        }
        let size = DictationBarState.compactSize
        let restored = restoredOrigin(size: size)
        let origin = avoiding(
            origin: restored ?? bottomCenterOrigin(size: size),
            size: size
        )
        logger.notice(
            "dictation panel opening origin=\(Int(origin.x), privacy: .public),\(Int(origin.y), privacy: .public) size=\(Int(size.width), privacy: .public)x\(Int(size.height), privacy: .public) placement=\(restored == nil ? "default" : "restored", privacy: .public) screens=\(NSScreen.screens.count, privacy: .public)"
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
        // One step above the app's other floating panels. They are surfaces the
        // user opens and dismisses; this is a control that must answer a click
        // whenever it is on screen. Siblings at the same level order themselves
        // front as they work (SpaceAgent on every reveal, the shell overlays on
        // every reveal), and the front panel swallows the press wherever the two
        // overlap - even where the front one is fully transparent, which leaves
        // the mini plainly visible and completely dead to the pointer.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = false
        panel.delegate = self
        self.panel = panel

        do {
            let controller = try InteractionPanelWebViewController(
                transport: transport,
                contract: .dictation,
                additionalUserScripts: [
                    InteractionPanelHostConfiguration.voiceConfigScript(
                        echoCancellation: echoCancellation
                    )
                ]
            )
            panelController = controller
            let webView = controller.webView
            // The web mini paints its own rounded gray surface. WebKit's
            // default white page canvas would otherwise leak into the corners
            // of this transparent borderless panel and make it look clipped.
            webView.setValue(false, forKey: "drawsBackground")
            webView.wantsLayer = true
            webView.layer?.cornerRadius = 22
            webView.layer?.masksToBounds = true
            webView.uiDelegate = self
            panel.contentView = DictationPanelContentView(webView: webView)
            logger.notice("dictation webview created; awaiting web ready")
        } catch {
            logger.error("dictation mini init failed: \(String(describing: error), privacy: .public)")
            panel.contentView = makeUnavailableView()
        }

        panel.orderFrontRegardless()
        installFnKeyMonitor()
    }

    private func markWebReady() {
        // The mini announces itself once per load. A repeat means it remounted,
        // which is worth a line but not the notice-level one that reads as a
        // fresh panel.
        guard !state.isWebReady else {
            logger.debug("dictation web re-announced readiness")
            return
        }
        state.markWebReady()
        logger.notice("dictation web ready; Fn capture armed")
    }

    /// The default microphone changed, so the echo-cancellation answer changed
    /// with it. A live run keeps its own capture graph; the next one opens with
    /// the new rule.
    func applyEchoCancellation(_ enabled: Bool) {
        guard echoCancellation != enabled else { return }
        echoCancellation = enabled
        panelController?.deliver(
            rawJSON: InteractionPanelHostConfiguration.audioConfigDelivery(
                echoCancellation: enabled
            )
        )
        logger.notice("dictation echo cancellation now \(enabled, privacy: .public)")
    }

    func currentScreenFrame() -> CGRect? { panel?.frame }

    func stop() {
        logger.notice(
            "dictation panel closing busy=\(self.isBusy, privacy: .public) status=\(self.state.runStatus.rawValue, privacy: .public)"
        )
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

    private func applyRunState(_ status: InteractionDictationRunStatus, message: String?) {
        let previous = state.runStatus
        state.applyRunStatus(status)
        if status == .error {
            logger.error(
                "dictation run \(previous.rawValue, privacy: .public) -> error message=\(message ?? "(none reported)", privacy: .public)"
            )
        } else if previous != status {
            logger.notice(
                "dictation run \(previous.rawValue, privacy: .public) -> \(status.rawValue, privacy: .public) busy=\(self.isBusy, privacy: .public)"
            )
        }
        onBusyChanged?(isBusy)
    }

    private func commit(recordingID: String, transcript: String) {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard state.shouldCommit(recordingID: recordingID, transcript: trimmed) else {
            logger.notice(
                "dictation commit skipped recording=\(recordingID, privacy: .public) reason=\(trimmed.isEmpty ? "empty-transcript" : "already-committed", privacy: .public)"
            )
            return
        }
        // Name the delivery target. A committed transcript that never appears
        // is a question about who holds the keyboard, and the answer has to be
        // in the log next to the commit that assumed it.
        logger.notice(
            "dictation transcript committed recording=\(recordingID, privacy: .public) chars=\(trimmed.count, privacy: .public) panelKey=\(self.panel?.isKeyWindow == true, privacy: .public) frontmost=\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "(none)", privacy: .public)"
        )
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
        // A global monitor silently delivers nothing without Input Monitoring,
        // which looks exactly like "Fn does nothing". Say which case this is.
        logger.notice(
            "dictation Fn monitor installed=\(self.fnKeyMonitor != nil, privacy: .public) inputMonitoring=\(CGPreflightListenEventAccess(), privacy: .public)"
        )
    }

    private func uninstallFnKeyMonitor() {
        if let fnKeyMonitor {
            NSEvent.removeMonitor(fnKeyMonitor)
            self.fnKeyMonitor = nil
        }
    }

    private func handleFnState(_ pressed: Bool) {
        switch state.captureDecision(functionPressed: pressed) {
        case .deliver(let command):
            logger.notice(
                "dictation Fn edge pressed=\(pressed, privacy: .public) command=\(command.rawValue, privacy: .public)"
            )
            deliverCapture(command)
        case .ignoredWebNotReady:
            logger.notice(
                "dictation Fn edge ignored pressed=\(pressed, privacy: .public) reason=web-not-ready"
            )
        case .ignoredRepeatedFnState:
            // flagsChanged fires for every modifier, so this is the common,
            // uninteresting case. Debug keeps the timeline without the noise.
            logger.debug("dictation Fn event carried no edge pressed=\(pressed, privacy: .public)")
        }
    }

    private func deliverCapture(_ command: DictationBarState.CaptureCommand) {
        let payload = #"{"type":"dictationCapture","payload":{"command":"\#(command.rawValue)"}}"#
        guard let panelController else {
            logger.error(
                "dictation capture \(command.rawValue, privacy: .public) dropped: no webview"
            )
            return
        }
        logger.notice("dictation capture \(command.rawValue, privacy: .public) sent to webview")
        panelController.deliver(rawJSON: payload)
    }

    private func resizePanel(to layout: InteractionDictationPanelLayout) {
        guard let panel else { return }
        let size = CGSize(width: layout.width, height: layout.height)
        guard panel.frame.size != size else { return }
        let old = panel.frame
        let proposed = CGPoint(x: old.midX - size.width / 2, y: old.minY)
        let clamped = SpaceAgentPanelPlacement.clampedOrigin(
            proposed: proposed,
            size: size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        )
        let placed = avoiding(origin: clamped, size: size)
        logger.debug(
            "dictation panel resize \(Int(old.width), privacy: .public)x\(Int(old.height), privacy: .public) -> \(Int(size.width), privacy: .public)x\(Int(size.height), privacy: .public) origin=\(Int(placed.x), privacy: .public),\(Int(placed.y), privacy: .public)"
        )
        panel.setFrame(CGRect(origin: placed, size: size), display: true)
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
        let granted = isBundledOrigin && type == .microphone
        logger.notice(
            "dictation mic permission origin=\(origin.protocol, privacy: .public)://\(origin.host, privacy: .public) microphone=\(type == .microphone, privacy: .public) decision=\(granted ? "grant" : "deny", privacy: .public) systemMic=\(AVCaptureDevice.authorizationStatus(for: .audio).rawValue, privacy: .public)"
        )
        decisionHandler(granted ? .grant : .deny)
    }
}

extension DictationBarController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        guard let panel else { return }
        save(origin: panel.frame.origin)
        onFrameDidChange?()
    }
}
