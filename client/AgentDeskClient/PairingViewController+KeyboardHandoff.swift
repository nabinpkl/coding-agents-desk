import KeyboardDictation
import UIKit

extension PairingViewController {
    /// Returns false when the URL belongs to an existing AgentDesk route. The
    /// caller can then pass it to pairing without accepting an ambiguous URL.
    @discardableResult
    func handleKeyboardDictationHandoffURL(_ url: URL) -> Bool {
        guard let nonce = KeyboardDictationHandoff.nonce(from: url) else {
            return false
        }
        do {
            let appGroupIdentifier = try KeyboardDictationHandoff.appGroupIdentifier()
            let store = try KeyboardHandoffStore(appGroupIdentifier: appGroupIdentifier)
            let receipt = try store.recordPendingHandoff(nonce: nonce)
            ClientDiagnostics.shared.record(
                type: "keyboardDictationHandoffReceived",
                fields: ["nonce": nonce.uuidString],
                level: .default
            )
            let handoff = KeyboardDictationHandoffViewController(receipt: receipt)
            let navigation = UINavigationController(rootViewController: handoff)
            navigation.modalPresentationStyle = .fullScreen
            present(navigation, animated: true)
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
}
