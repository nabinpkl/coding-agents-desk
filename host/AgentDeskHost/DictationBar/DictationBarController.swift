import AppKit
import AVFoundation
import os

// Host-local push-to-talk dictation overlay. A borderless non-activating
// NSPanel pinned to the bottom-centre of the main screen, joining all
// Spaces. Holding the mic records into memory (MicRecorder); releasing
// stops and POSTs the clip to the transcription service, then shows the
// returned text in the bar. Independent of the iPhone remote pipeline.
@MainActor
final class DictationBarController: NSObject {
    private enum DefaultsKey {
        static let originX = "DictationBar.origin.x"
        static let originY = "DictationBar.origin.y"
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "dictation")
    private let viewController = DictationBarViewController()
    private let recorder = MicRecorder()
    private let transcriber: TranscriptionClient
    private let userDefaults: UserDefaults
    private let typeText: (String) -> Void
    // Supplies the SpaceAgent handle's screen rect so the bar can stay clear of
    // it. Without this the two floating panels can overlap and a press meant
    // for the spaceship lands on the bar's mic button, starting a recording.
    var spaceAgentHandleFrame: (() -> CGRect?)?
    // Fired whenever the bar's screen frame changes (user drag, state resize,
    // dodge), so a sibling overlay can keep clear of it.
    var onFrameDidChange: (() -> Void)?
    private var panel: NSPanel?
    private var isCapturing = false
    private var transcribeTask: Task<Void, Never>?
    private var fnKeyMonitor: Any?
    private var fnDown = false
    private var autoDismissTask: Task<Void, Never>?
    private static let transcriptDismissDelay: UInt64 = 4_000_000_000

    init(
        transcriber: TranscriptionClient = TranscriptionClient(),
        userDefaults: UserDefaults = .standard,
        typeText: @escaping (String) -> Void = { _ in }
    ) {
        self.transcriber = transcriber
        self.userDefaults = userDefaults
        self.typeText = typeText
        super.init()
        viewController.delegate = self
        // Fires on the audio thread; hop to the main actor for the meter.
        // Only meaningful while capturing (the meter is hidden otherwise).
        recorder.onLevel = { [weak self] level in
            Task { @MainActor in
                guard let self, self.isCapturing else { return }
                self.viewController.updateLevel(level)
            }
        }
    }

    func start() {
        guard panel == nil else { return }
        let size = viewController.compactSize
        let origin = avoiding(
            origin: restoredOrigin(size: size) ?? bottomCenterOrigin(size: size),
            size: size
        )
        let panel = NSPanel(
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
        // Drag the bar anywhere except the push-to-talk control, which
        // swallows its own mouse events for record start/stop.
        panel.isMovableByWindowBackground = true
        panel.contentViewController = viewController
        panel.delegate = self
        self.panel = panel
        panel.orderFrontRegardless()
        installFnKeyMonitor()
    }

    // This bar's current rect in screen coordinates, for a sibling overlay to
    // avoid. Nil before the panel is on screen.
    func currentScreenFrame() -> CGRect? {
        panel?.frame
    }

    func stop() {
        uninstallFnKeyMonitor()
        autoDismissTask?.cancel()
        autoDismissTask = nil
        transcribeTask?.cancel()
        transcribeTask = nil
        if isCapturing {
            _ = recorder.stop()
            isCapturing = false
        }
        panel?.close()
        panel = nil
    }

    // Hold-to-talk via the Fn / Globe key. It surfaces as the .function
    // modifier on flagsChanged events; a global monitor catches it while
    // another app is frontmost (the host is an accessory and the bar is a
    // non-activating panel, so it is never the active app). Requires
    // Accessibility, which the host already holds for input dispatch.
    private func installFnKeyMonitor() {
        guard fnKeyMonitor == nil else { return }
        fnKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { [weak self] event in
            let pressed = event.modifierFlags.contains(.function)
            Task { @MainActor in
                self?.handleFnState(pressed)
            }
        }
    }

    private func uninstallFnKeyMonitor() {
        if let fnKeyMonitor {
            NSEvent.removeMonitor(fnKeyMonitor)
            self.fnKeyMonitor = nil
        }
        fnDown = false
    }

    private func handleFnState(_ pressed: Bool) {
        guard pressed != fnDown else { return }
        fnDown = pressed
        if pressed {
            handleTalkPressed()
        } else {
            handleTalkReleased()
        }
    }

    // Single entry point for state changes: resize the panel (compact when
    // idle, widened otherwise), render, and auto-collapse back to compact a
    // few seconds after a transcript or message is shown.
    private func show(_ state: DictationBarViewController.State) {
        autoDismissTask?.cancel()
        autoDismissTask = nil
        resizePanel(expanded: DictationBarViewController.isExpanded(state))
        viewController.render(state)
        switch state {
        case .transcript, .message:
            autoDismissTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.transcriptDismissDelay)
                guard !Task.isCancelled else { return }
                self?.show(.idle)
            }
        default:
            break
        }
    }

    // Resize keeping the bar's horizontal centre and bottom edge fixed so it
    // grows and shrinks in place, clamped to the visible screens.
    private func resizePanel(expanded: Bool) {
        guard let panel else { return }
        let size = expanded ? viewController.expandedSize : viewController.compactSize
        guard panel.frame.size != size else { return }
        let old = panel.frame
        let proposed = CGPoint(x: old.midX - size.width / 2, y: old.minY)
        let clamped = SpaceAgentPanelPlacement.clampedOrigin(
            proposed: proposed,
            size: size,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        )
        panel.setFrame(CGRect(origin: avoiding(origin: clamped, size: size), size: size), display: true)
        onFrameDidChange?()
    }

    // Nudge a proposed origin out from under the SpaceAgent handle, if one is
    // present. No-op when nothing supplies the handle frame or they do not
    // overlap.
    private func avoiding(origin: CGPoint, size: CGSize) -> CGPoint {
        guard let handle = spaceAgentHandleFrame?() else { return origin }
        return SpaceAgentPanelPlacement.nonOverlappingOrigin(
            proposed: origin,
            size: size,
            avoid: handle,
            visibleFrames: NSScreen.screens.map(\.visibleFrame)
        )
    }

    // Re-run avoidance when the SpaceAgent handle moves under the bar. Skipped
    // mid-capture so a recording is never interrupted by the bar relocating.
    func keepClearOfSpaceAgentHandle() {
        guard let panel, !isCapturing else { return }
        let size = panel.frame.size
        let placed = avoiding(origin: panel.frame.origin, size: size)
        guard placed != panel.frame.origin else { return }
        panel.setFrame(CGRect(origin: placed, size: size), display: true)
        onFrameDidChange?()
    }

    private func bottomCenterOrigin(size: CGSize) -> CGPoint {
        let frame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGPoint(
            x: frame.midX - size.width / 2,
            y: frame.minY + 24
        )
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

    private func beginCapture() {
        guard !isCapturing else { return }
        transcribeTask?.cancel()
        do {
            try recorder.start()
            isCapturing = true
            show(.recording)
        } catch {
            logger.error("recorder start failed: \(String(describing: error), privacy: .public)")
            show(.message("Microphone unavailable"))
        }
    }

    private func endCapture() {
        guard isCapturing else { return }
        isCapturing = false
        let wav = recorder.stop()
        // 44-byte header only means no audio frames were captured.
        guard wav.count > 44 else {
            show(.idle)
            return
        }
        show(.transcribing)
        let transcriber = self.transcriber
        transcribeTask = Task { [weak self] in
            do {
                let text = try await transcriber.transcribe(wav: wav)
                guard !Task.isCancelled else { return }
                self?.logger.notice("transcript received chars=\(text.count, privacy: .public)")
                // Type into the frontmost app. The bar is a non-activating
                // panel, so focus never left that app while recording. The
                // trailing space keeps back-to-back dictations from butting
                // together.
                self?.typeText(text + " ")
                self?.show(.transcript(text))
            } catch TranscriptionClient.TranscriptionError.notConfigured {
                guard !Task.isCancelled else { return }
                self?.logger.error("transcription endpoint not configured (set AGENTDESK_TRANSCRIBE_URL)")
                self?.show(.message("Set AGENTDESK_TRANSCRIBE_URL"))
            } catch {
                guard !Task.isCancelled else { return }
                self?.logger.error("transcription failed: \(String(describing: error), privacy: .public)")
                self?.show(.message("Transcription failed"))
            }
        }
    }
}

extension DictationBarController {
    // Shared by the mic button and the Fn-key monitor.
    private func handleTalkPressed() {
        switch MicRecorder.authorizationStatus() {
        case .authorized:
            beginCapture()
        case .notDetermined:
            show(.message("Allow microphone access\u{2026}"))
            Task { [weak self] in
                let granted = await MicRecorder.requestAccess()
                guard let self else { return }
                if granted {
                    self.beginCapture()
                } else {
                    self.show(.message("Microphone access denied"))
                }
            }
        default:
            show(.message("Enable mic in System Settings"))
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private func handleTalkReleased() {
        endCapture()
    }
}

extension DictationBarController: DictationBarViewControllerDelegate {
    func dictationBarDidPressTalk(_ controller: DictationBarViewController) {
        handleTalkPressed()
    }

    func dictationBarDidReleaseTalk(_ controller: DictationBarViewController) {
        handleTalkReleased()
    }
}

extension DictationBarController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        guard let panel else { return }
        save(origin: panel.frame.origin)
        onFrameDidChange?()
    }
}
