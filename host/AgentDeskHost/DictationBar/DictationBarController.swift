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
    private var panel: NSPanel?
    private var isCapturing = false
    private var transcribeTask: Task<Void, Never>?

    init(
        transcriber: TranscriptionClient = TranscriptionClient(),
        userDefaults: UserDefaults = .standard
    ) {
        self.transcriber = transcriber
        self.userDefaults = userDefaults
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
        let size = viewController.preferredPanelSize
        let origin = restoredOrigin(size: size) ?? bottomCenterOrigin(size: size)
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
    }

    func stop() {
        transcribeTask?.cancel()
        transcribeTask = nil
        if isCapturing {
            _ = recorder.stop()
            isCapturing = false
        }
        panel?.close()
        panel = nil
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
            viewController.render(.recording)
        } catch {
            logger.error("recorder start failed: \(String(describing: error), privacy: .public)")
            viewController.render(.message("Microphone unavailable"))
        }
    }

    private func endCapture() {
        guard isCapturing else { return }
        isCapturing = false
        let wav = recorder.stop()
        // 44-byte header only means no audio frames were captured.
        guard wav.count > 44 else {
            viewController.render(.idle)
            return
        }
        viewController.render(.transcribing)
        let transcriber = self.transcriber
        transcribeTask = Task { [weak self] in
            do {
                let text = try await transcriber.transcribe(wav: wav)
                guard !Task.isCancelled else { return }
                self?.logger.notice("transcript received chars=\(text.count, privacy: .public)")
                self?.viewController.render(.transcript(text))
            } catch {
                guard !Task.isCancelled else { return }
                self?.logger.error("transcription failed: \(String(describing: error), privacy: .public)")
                self?.viewController.render(.message("Transcription failed"))
            }
        }
    }
}

extension DictationBarController: DictationBarViewControllerDelegate {
    func dictationBarDidPressTalk(_ controller: DictationBarViewController) {
        switch MicRecorder.authorizationStatus() {
        case .authorized:
            beginCapture()
        case .notDetermined:
            controller.render(.message("Allow microphone access\u{2026}"))
            Task { [weak self] in
                let granted = await MicRecorder.requestAccess()
                guard let self else { return }
                if granted {
                    self.beginCapture()
                } else {
                    self.viewController.render(.message("Microphone access denied"))
                }
            }
        default:
            controller.render(.message("Enable mic in System Settings"))
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func dictationBarDidReleaseTalk(_ controller: DictationBarViewController) {
        endCapture()
    }
}

extension DictationBarController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        guard let panel else { return }
        save(origin: panel.frame.origin)
    }
}
