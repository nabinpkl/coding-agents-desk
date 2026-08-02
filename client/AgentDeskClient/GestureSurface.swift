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
    private var referenceAudioDownload: ReferenceAudioDownload?
    private lazy var referenceAudioPlayback = ReferenceAudioPlayback {
        [weak self] event in
        self?.deliverReferenceAudio(event)
    }

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
        stopReferenceAudio(deliverStopped: false)
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
        case .referenceAudioPlay(let artifactID, let audioHash):
            startReferenceAudio(
                artifactID: artifactID,
                audioHash: audioHash
            )
        case .referenceAudioStop:
            stopReferenceAudio()
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
        case .dictationReady, .dictationLayout, .dictationRunState, .dictationCommit:
            // The all-Spaces mini dictation window exists only on macOS. Keep
            // the shared contract additive without making the iPhone surface
            // invent a second recorder ownership path.
            break
        }
    }

    private func startReferenceAudio(
        artifactID: String,
        audioHash: String
    ) {
        stopReferenceAudio(deliverStopped: false)
        let requestID = "reference-audio-\(UUID().uuidString)"
        referenceAudioDownload = ReferenceAudioDownload(
            artifactID: artifactID,
            expectedAudioHash: audioHash,
            requestID: requestID
        )
        referenceAudioPlayback.preparing(artifactID: artifactID)
        forwardVoice(.rest(VoiceRESTRequest(
            requestID: requestID,
            method: .get,
            path: "/reference-speech/artifacts/\(artifactID)/audio"
        )))
    }

    private func stopReferenceAudio(deliverStopped: Bool = true) {
        referenceAudioDownload = nil
        referenceAudioPlayback.stop(deliverStopped: deliverStopped)
    }

    private func handleReferenceAudioDelivery(
        _ message: VoiceLaneHostMessage
    ) -> Bool {
        guard var download = referenceAudioDownload else { return false }
        switch message {
        case .rest(let response) where response.requestID == download.requestID:
            do {
                let completed = try download.append(response)
                referenceAudioDownload = completed == nil ? download : nil
                if let completed {
                    try referenceAudioPlayback.play(
                        data: completed,
                        artifactID: download.artifactID
                    )
                }
            } catch {
                referenceAudioDownload = nil
                referenceAudioPlayback.fail(
                    artifactID: download.artifactID,
                    message: error.localizedDescription
                )
            }
            return true
        case .error(let requestID, _, _, let message)
            where requestID == download.requestID:
            referenceAudioDownload = nil
            referenceAudioPlayback.fail(
                artifactID: download.artifactID,
                message: message
            )
            return true
        default:
            return false
        }
    }

    private func deliverReferenceAudio(_ event: ReferenceAudioPlaybackEvent) {
        do {
            let payload = try JSONEncoder().encode(event)
            guard let payloadJSON = String(data: payload, encoding: .utf8) else {
                return
            }
            panelController?.deliver(
                rawJSON: #"{"type":"referenceAudioState","payload":\#(payloadJSON)}"#
            )
        } catch {
            logger.error(
                "reference audio delivery encode failed: \(String(describing: error), privacy: .public)"
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
            stopReferenceAudio()
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
        let handledReferenceAudio = handleReferenceAudioDelivery(message)
        if case .error(_, _, .transportLost, _) = message {
            stopReferenceAudio()
            voiceLane?.close()
            voiceLane = nil
        }
        if handledReferenceAudio {
            return
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
