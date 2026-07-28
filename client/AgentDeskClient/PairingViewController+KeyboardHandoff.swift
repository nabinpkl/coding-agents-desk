import KeyboardDictation
import UIKit

extension PairingViewController {
    /// Returns false when the URL belongs to an existing AgentDesk route. The
    /// caller can then pass it to pairing without accepting an ambiguous URL.
    @discardableResult
    func handleKeyboardDictationHandoffURL(_ url: URL) -> Bool {
        guard let requestID = KeyboardDictationContract.requestID(from: url) else {
            return false
        }
        do {
            let store = try KeyboardDictationStore(
                appGroupIdentifier: KeyboardDictationContract
                    .appGroupIdentifier()
            )
            try store.consumeHandoff(requestID: requestID)
            ClientDiagnostics.shared.record(
                type: "keyboardDictationHandoffReceived",
                fields: ["requestID": requestID.uuidString],
                level: .default
            )
            showKeyboardDictationService()
            return true
        } catch {
            ClientDiagnostics.shared.record(
                type: "keyboardDictationHandoffFailed",
                fields: ["error": String(describing: error)],
                level: .error
            )
            let alert = UIAlertController(
                title: "Keyboard handoff unavailable",
                message: error.localizedDescription,
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            present(alert, animated: true)
            return true
        }
    }

    func showKeyboardDictationService() {
        do {
            if activeControlSurface == .voice {
                leaveVoiceSurface()
            }
            let coordinator: KeyboardDictationCoordinator
            if let existing = keyboardDictationCoordinator {
                coordinator = existing
            } else {
                coordinator = try KeyboardDictationCoordinator()
                coordinator.onTurnedOff = { [weak self] in
                    guard let self, !isClientForeground else { return }
                    pairingClient.handleMediaSessionFailed()
                }
                keyboardDictationCoordinator = coordinator
            }
            let screen = KeyboardDictationHandoffViewController(
                coordinator: coordinator
            )
            screen.onRetry = { [weak self, weak coordinator] in
                guard let self, let coordinator else { return }
                triggerSessionIfPaired()
                coordinator.arm { [weak self] in
                    self?.pairingClient.activeSessionTransport
                }
            }
            screen.onTurnOff = { [weak self, weak screen] in
                self?.turnOffKeyboardDictation()
                screen?.dismiss(animated: true)
            }
            let navigation = UINavigationController(rootViewController: screen)
            navigation.modalPresentationStyle = .fullScreen
            if presentedViewController != nil {
                dismiss(animated: false) { [weak self] in
                    self?.present(navigation, animated: true)
                }
            } else {
                present(navigation, animated: true)
            }
            triggerSessionIfPaired()
            coordinator.arm { [weak self] in
                self?.pairingClient.activeSessionTransport
            }
        } catch {
            let alert = UIAlertController(
                title: "Keyboard dictation unavailable",
                message: error.localizedDescription,
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            present(alert, animated: true)
        }
    }

    func turnOffKeyboardDictation() {
        keyboardDictationCoordinator?.turnOff()
        keyboardDictationCoordinator = nil
    }
}
