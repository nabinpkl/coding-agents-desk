import AgentDeskWire
import UIKit

/// A short-lived iPhone sheet for remote dictation. It intentionally hosts the
/// shared browser capture surface so audio follows the same authenticated voice
/// lane and Python recording pipeline as the full Voice panel.
@MainActor
final class ClientDictationViewController: UIViewController {
    var voiceTransportProvider: (() -> QuicSessionClientTransport?)?
    var submitText: ((String) async throws -> Void)?

    private let dictationSurface = GestureSurface(presentation: .dictation)
    private var committedRecordingIDs = Set<String>()
    private var submissionTask: Task<Void, Never>?
    private var isClosing = false

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Dictate to Mac"
        view.backgroundColor = .systemBackground

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel,
            target: self,
            action: #selector(cancel)
        )
        navigationItem.leftBarButtonItem?.accessibilityLabel = "Cancel dictation"

        dictationSurface.voiceTransportProvider = { [weak self] in
            self?.voiceTransportProvider?()
        }
        dictationSurface.onDictationCommit = { [weak self] recordingID, transcript in
            self?.commit(recordingID: recordingID, transcript: transcript)
        }
        dictationSurface.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(dictationSurface)
        NSLayoutConstraint.activate([
            dictationSurface.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            dictationSurface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            dictationSurface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            dictationSurface.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true {
            isClosing = true
            submissionTask?.cancel()
            submissionTask = nil
            dictationSurface.stopDictation()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true {
            dictationSurface.teardown()
        }
    }

    @objc private func cancel() {
        dismiss(animated: true)
    }

    private func commit(recordingID: String, transcript: String) {
        guard submissionTask == nil else { return }
        guard committedRecordingIDs.insert(recordingID).inserted else { return }
        guard let submitText else {
            committedRecordingIDs.remove(recordingID)
            presentSubmissionError(
                "The keyboard input path is unavailable. Keep this sheet open and try again."
            )
            return
        }
        ClientDiagnostics.shared.record(
            type: "dictationSubmissionStarted",
            fields: [
                "recordingID": recordingID,
                "characterCount": String(transcript.count)
            ],
            level: .default
        )
        submissionTask = Task { @MainActor [weak self, submitText] in
            do {
                try await submitText(transcript)
                guard !Task.isCancelled else { return }
                ClientDiagnostics.shared.record(
                    type: "dictationSubmissionCompleted",
                    fields: ["recordingID": recordingID],
                    level: .default
                )
                self?.dismiss(animated: true)
            } catch is CancellationError {
                guard let self, !self.isClosing else { return }
                self.committedRecordingIDs.remove(recordingID)
                ClientDiagnostics.shared.record(
                    type: "dictationSubmissionCancelled",
                    fields: ["recordingID": recordingID],
                    level: .error
                )
                self.presentSubmissionError(
                    "The Mac input connection changed before dictation was delivered. Reconnect, then send again."
                )
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.committedRecordingIDs.remove(recordingID)
                ClientDiagnostics.shared.record(
                    type: "dictationSubmissionFailed",
                    fields: [
                        "recordingID": recordingID,
                        "error": String(describing: error)
                    ],
                    level: .error
                )
                self.presentSubmissionError(error.localizedDescription)
            }
            self?.submissionTask = nil
        }
    }

    private func presentSubmissionError(_ message: String) {
        let alert = UIAlertController(
            title: "Couldn’t send dictation",
            message: message,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
