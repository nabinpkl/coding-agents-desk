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
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "dictation")
    private let viewController = DictationBarViewController()
    private let recorder = MicRecorder()
    private let transcriber: TranscriptionClient
    private var panel: NSPanel?
    private var isCapturing = false
    private var transcribeTask: Task<Void, Never>?

    init(transcriber: TranscriptionClient = TranscriptionClient()) {
        self.transcriber = transcriber
        super.init()
        viewController.delegate = self
    }

    func start() {
        guard panel == nil else { return }
        let size = viewController.preferredPanelSize
        let panel = NSPanel(
            contentRect: CGRect(origin: bottomCenterOrigin(size: size), size: size),
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
        panel.contentViewController = viewController
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
