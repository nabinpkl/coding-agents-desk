import AVFoundation
import Foundation
import OSLog
import UIKit
import WebKit
import InteractionPanel
import AgentDeskWire

/// The iOS gesture surface hosts the shared InteractionPanel webview full-bleed.
/// Space steps use the input lane; voice requests use a lazy, authenticated
/// voice lane that the Mac proxies to its loopback Python sidecar.
@MainActor
final class GestureSurface: UIView, InteractionPanelTransport, WKUIDelegate {
    /// Injected by PairingViewController to forward the Space step to the input lane.
    var onSpaceStep: ((Int) -> Void)?
    var voiceTransportProvider: (() -> QuicSessionClientTransport?)?
    /// Test seam: when set, receives requests instead of the injected handler.
    var onRequestForTesting: ((InteractionPanelRequest) -> Void)?

    private let logger = Logger(subsystem: Config.logSubsystem, category: "gesture-surface")
    private var panelController: InteractionPanelWebViewController?
    private var voiceLane: VoiceLaneClient?
    private var voiceLaneOpeningTask: Task<VoiceLaneClient, Error>?
    private weak var voiceLaneTransport: QuicSessionClientTransport?
    private var panelContentView = UIView()
    private let referenceSpeechSynthesizer = AVSpeechSynthesizer()
    private var referenceSpeechSessionActive = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        setUpPanel()
        configureContainer()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUpPanel()
        configureContainer()
    }

    private func setUpPanel() {
        referenceSpeechSynthesizer.delegate = self
        do {
            let config = WKUserScript(
                source: #"window.__interactionConfig = {"voiceTransport":"native"};"#,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            let controller = try InteractionPanelWebViewController(
                transport: self,
                additionalUserScripts: [config]
            )
            // The gesture UI needs the camera; grant capture from the bundled
            // origin (the app must also declare NSCameraUsageDescription).
            controller.webView.uiDelegate = self
            panelController = controller
            panelContentView = controller.webView
        } catch {
            logger.error("gesture-surface: InteractionPanel init failed: \(String(describing: error), privacy: .public)")
            panelContentView = unavailableFallback()
        }
    }

    /// Visible placeholder when the panel could not be constructed (missing or
    /// misconfigured bundled web assets), so the surface is never a mute blank.
    private func unavailableFallback() -> UIView {
        let label = UILabel()
        label.text = "Gesture view unavailable"
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.accessibilityIdentifier = "gesture-surface-unavailable"
        return label
    }

    private func configureContainer() {
        backgroundColor = .systemBackground
        panelContentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(panelContentView)
        NSLayoutConstraint.activate([
            panelContentView.topAnchor.constraint(equalTo: topAnchor),
            panelContentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            panelContentView.trailingAnchor.constraint(equalTo: trailingAnchor),
            panelContentView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    func teardown() {
        stopReferenceSpeech()
        voiceLane?.close()
        voiceLane = nil
        voiceLaneOpeningTask?.cancel()
        voiceLaneOpeningTask = nil
        panelController?.teardown()
        panelController = nil
    }

    // MARK: - InteractionPanelTransport

    func sendInteractionRequest(_ request: InteractionPanelRequest) {
        if let onRequestForTesting {
            onRequestForTesting(request)
            return
        }
        switch request {
        case .spaceStep(let delta):
            onSpaceStep?(delta)
        case .referenceSpeech(let text, let language):
            speakReference(text: text, language: language)
        case .referenceSpeechStop:
            stopReferenceSpeech()
        case .voiceSocketOpen(let requestID, let sessionID):
            forwardVoice(.socketOpen(
                requestID: requestID,
                recordingSessionID: sessionID
            ))
        case .voiceSocketMessage(let sessionID, let json):
            forwardVoice(.socketMessage(
                recordingSessionID: sessionID,
                json: json
            ))
        case .voiceSocketClose(let sessionID):
            forwardVoice(.socketClose(recordingSessionID: sessionID))
        case .voiceREST(let request):
            guard let method = VoiceRESTMethod(rawValue: request.method) else {
                deliverVoice(.error(
                    requestID: request.requestID,
                    recordingSessionID: nil,
                    code: .invalidRequest,
                    message: "Unsupported REST method."
                ))
                return
            }
            forwardVoice(.rest(VoiceRESTRequest(
                requestID: request.requestID,
                method: method,
                path: request.path,
                body: request.body
            )))
        }
    }

    private func speakReference(text: String, language: String) {
        referenceSpeechSynthesizer.stopSpeaking(at: .immediate)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            referenceSpeechSessionActive = true
        } catch {
            logger.error(
                "reference speech audio session failed: \(error.localizedDescription, privacy: .public)"
            )
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: language)
        referenceSpeechSynthesizer.speak(utterance)
    }

    private func stopReferenceSpeech() {
        referenceSpeechSynthesizer.stopSpeaking(at: .immediate)
        deactivateReferenceSpeechSession()
    }

    private func deactivateReferenceSpeechSession() {
        guard referenceSpeechSessionActive else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(
                false,
                options: [.notifyOthersOnDeactivation]
            )
            referenceSpeechSessionActive = false
        } catch {
            logger.error(
                "reference speech cleanup failed: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    private func forwardVoice(_ message: VoiceLaneClientMessage) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let lane = try await ensureVoiceLane()
                try await lane.send(message)
            } catch {
                deliverVoice(.error(
                    requestID: message.requestID,
                    recordingSessionID: message.recordingSessionID,
                    code: .transportLost,
                    message: error.localizedDescription
                ))
            }
        }
    }

    private func ensureVoiceLane() async throws -> VoiceLaneClient {
        guard let transport = voiceTransportProvider?() else {
            throw VoiceLaneClientError.closed
        }
        if transport !== voiceLaneTransport {
            voiceLane?.close()
            voiceLane = nil
            voiceLaneOpeningTask?.cancel()
            voiceLaneOpeningTask = nil
            voiceLaneTransport = transport
        }
        if let voiceLane { return voiceLane }
        if let voiceLaneOpeningTask {
            return try await voiceLaneOpeningTask.value
        }
        let openingTask = Task { [weak self, weak transport] in
            guard let self, let transport else { throw VoiceLaneClientError.closed }
            return try await transport.openVoiceLane { [weak self] message in
                self?.handleVoiceLaneDelivery(message)
            }
        }
        voiceLaneOpeningTask = openingTask
        do {
            let lane = try await openingTask.value
            guard transport === voiceLaneTransport else {
                lane.close()
                throw VoiceLaneClientError.closed
            }
            voiceLane = lane
            voiceLaneOpeningTask = nil
            return lane
        } catch {
            if transport === voiceLaneTransport {
                voiceLaneOpeningTask = nil
            }
            throw error
        }
    }

    private func handleVoiceLaneDelivery(_ message: VoiceLaneHostMessage) {
        if case .error(_, _, .transportLost, _) = message {
            voiceLane?.close()
            voiceLane = nil
        }
        deliverVoice(message)
    }

    private func deliverVoice(_ message: VoiceLaneHostMessage) {
        do {
            let payload = try JSONEncoder().encode(message)
            guard let payloadJSON = String(data: payload, encoding: .utf8) else {
                logger.error("voice-lane delivery was not valid UTF-8")
                return
            }
            panelController?.deliver(
                rawJSON: #"{"type":"voiceLane","payload":\#(payloadJSON)}"#
            )
        } catch {
            logger.error(
                "voice-lane delivery encode failed: \(String(describing: error), privacy: .public)"
            )
        }
    }

    // MARK: - WKUIDelegate

    nonisolated func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }
}

extension GestureSurface: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in
            guard let self, !self.referenceSpeechSynthesizer.isSpeaking else {
                return
            }
            self.deactivateReferenceSpeechSession()
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in
            guard let self, !self.referenceSpeechSynthesizer.isSpeaking else {
                return
            }
            self.deactivateReferenceSpeechSession()
        }
    }
}

private extension VoiceLaneClientMessage {
    var requestID: String? {
        switch self {
        case .socketOpen(let requestID, _):
            requestID
        case .rest(let request):
            request.requestID
        case .socketMessage, .socketClose:
            nil
        }
    }

    var recordingSessionID: String? {
        switch self {
        case .socketOpen(_, let sessionID),
             .socketMessage(let sessionID, _),
             .socketClose(let sessionID):
            sessionID
        case .rest:
            nil
        }
    }
}
