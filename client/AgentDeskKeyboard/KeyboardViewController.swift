import KeyboardDictation
import UIKit

/// Development-only custom keyboard used to establish whether a visible,
/// user-initiated transition into the containing app and back is viable on the
/// current iOS release. It intentionally does not own microphone capture.
final class KeyboardViewController: UIInputViewController {
    private let statusLabel = UILabel()
    private let handoffButton = UIButton(type: .system)
    private let insertProbeButton = UIButton(type: .system)
    private let nextKeyboardButton = UIButton(type: .system)
    private var pendingNonce: UUID?

    private lazy var handoffStore: KeyboardHandoffStore? = {
        do {
            return try KeyboardHandoffStore(
                appGroupIdentifier: KeyboardDictationHandoff.appGroupIdentifier()
            )
        } catch {
            return nil
        }
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        configureView()
        refreshHandoffStatus()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refreshHandoffStatus()
    }

    @objc private func beginHandoff() {
        guard let extensionContext else {
            updateStatus("The keyboard has no extension context.", color: .systemRed)
            return
        }
        let nonce = UUID()
        pendingNonce = nonce
        guard let handoffStore else {
            updateStatus("The keyboard App Group is unavailable.", color: .systemRed)
            return
        }
        handoffStore.savePendingNonce(nonce)
        handoffButton.isEnabled = false
        updateStatus("Opening AgentDesk to confirm the handoff…", color: .secondaryLabel)
        extensionContext.open(KeyboardDictationHandoff.handoffURL(nonce: nonce)) { [weak self] didOpen in
            DispatchQueue.main.async {
                guard let self else { return }
                self.handoffButton.isEnabled = true
                if !didOpen {
                    self.updateStatus("iOS did not open AgentDesk for this handoff.", color: .systemRed)
                }
            }
        }
    }

    @objc private func insertProbe() {
        textDocumentProxy.insertText("AgentDesk keyboard handoff confirmed")
        updateStatus("Inserted a return-path probe into this text field.", color: .systemGreen)
    }

    @objc private func advanceKeyboard() {
        advanceToNextInputMode()
    }

    private func configureView() {
        view.backgroundColor = .secondarySystemBackground
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center

        handoffButton.configuration = .filled()
        handoffButton.setTitle("Open AgentDesk", for: .normal)
        handoffButton.addTarget(self, action: #selector(beginHandoff), for: .touchUpInside)

        insertProbeButton.configuration = .tinted()
        insertProbeButton.setTitle("Insert return probe", for: .normal)
        insertProbeButton.addTarget(self, action: #selector(insertProbe), for: .touchUpInside)

        nextKeyboardButton.configuration = .plain()
        nextKeyboardButton.setTitle("Next keyboard", for: .normal)
        nextKeyboardButton.addTarget(self, action: #selector(advanceKeyboard), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            statusLabel,
            handoffButton,
            insertProbeButton,
            nextKeyboardButton
        ])
        stack.axis = .vertical
        stack.spacing = 10
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
            handoffButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            insertProbeButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            nextKeyboardButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 36)
        ])
    }

    private func refreshHandoffStatus() {
        guard hasFullAccess else {
            updateStatus(
                "Enable Allow Full Access in Keyboard Settings before testing the App Group return path.",
                color: .systemOrange
            )
            return
        }
        guard let handoffStore else {
            updateStatus("The keyboard App Group is unavailable.", color: .systemRed)
            return
        }
        guard let receipt = try? handoffStore.latestReceipt() else {
            updateStatus("Ready. Tap Open AgentDesk, then swipe back here.", color: .secondaryLabel)
            return
        }
        let expectedNonce = pendingNonce ?? handoffStore.pendingNonce()
        guard receipt.nonce == expectedNonce else {
            updateStatus("Ready. Tap Open AgentDesk, then swipe back here.", color: .secondaryLabel)
            return
        }
        updateStatus("AgentDesk confirmed this handoff. The keyboard return path works.", color: .systemGreen)
    }

    private func updateStatus(_ message: String, color: UIColor) {
        statusLabel.text = message
        statusLabel.textColor = color
    }
}
