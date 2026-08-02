import AgentDeskWire
import UIKit

/// A short-lived iPhone sheet for remote dictation. It intentionally hosts the
/// shared browser capture surface so audio follows the same authenticated voice
/// lane and Python recording pipeline as the full Voice panel.
@MainActor
final class ClientDictationViewController: UIViewController {
    var voiceTransportProvider: (() -> QuicSessionClientTransport?)?
    var submitText: ((String) throws -> Void)?

    private let dictationSurface = GestureSurface(presentation: .dictation)
    private var committedRecordingIDs = Set<String>()

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
        guard committedRecordingIDs.insert(recordingID).inserted else { return }
        guard let submitText else {
            committedRecordingIDs.remove(recordingID)
            presentSubmissionError(
                "The keyboard input path is unavailable. Keep this sheet open and try again."
            )
            return
        }
        do {
            try submitText(transcript)
            dismiss(animated: true)
        } catch {
            committedRecordingIDs.remove(recordingID)
            presentSubmissionError(error.localizedDescription)
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
