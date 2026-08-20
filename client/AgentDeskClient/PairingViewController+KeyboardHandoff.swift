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

    @objc func openKeyboardDictationService() {
        showKeyboardDictationService()
    }

    func showKeyboardDictationService() {
        do {
            if activeControlSurface == .voice {
                leaveVoiceSurface()
            }
            let coordinator = try ensureKeyboardDictationCoordinator()
            if keyboardDictationServiceViewController?
                .navigationController?.presentingViewController != nil {
                return
            }
            let screen = KeyboardDictationHandoffViewController(
                coordinator: coordinator
            )
            keyboardDictationServiceViewController = screen
            screen.onRetry = { [weak self, weak coordinator] in
                guard let self, let coordinator else { return }
                sessionSupervisor?.requestImmediateDial()
                coordinator.arm { [weak self] in
                    self?.pairingClient.activeSessionTransport
                }
            }
            screen.onClose = { [weak self] in
                self?.dismissKeyboardDictationService()
            }
            screen.onUseInAgentDesk = { [weak self] in
                self?.useKeyboardDictationInAgentDesk()
            }
            screen.onTurnOff = { [weak self] in
                self?.turnOffKeyboardDictation()
                self?.dismissKeyboardDictationService()
            }
            let navigation = UINavigationController(rootViewController: screen)
            navigation.modalPresentationStyle = .fullScreen
            topmostPresentedViewController.present(navigation, animated: true)
            sessionSupervisor?.requestImmediateDial()
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

    private func ensureKeyboardDictationCoordinator() throws
        -> KeyboardDictationCoordinator
    {
        if let existing = keyboardDictationCoordinator {
            observeKeyboardDictationSnapshotsIfNeeded(from: existing)
            return existing
        }
        let coordinator = try KeyboardDictationCoordinator()
        coordinator.onTurnedOff = { [weak self] in
            guard let self, !isClientForeground else { return }
            pairingClient.handleMediaSessionFailed()
        }
        keyboardDictationCoordinator = coordinator
        observeKeyboardDictationSnapshotsIfNeeded(from: coordinator)
        return coordinator
    }

    private func observeKeyboardDictationSnapshotsIfNeeded(
        from coordinator: KeyboardDictationCoordinator
    ) {
        guard keyboardDictationSnapshotObservationID == nil else { return }
        keyboardDictationSnapshotObservationID =
            coordinator.observeSnapshots { [weak self] snapshot in
                self?.renderKeyboardDictationStatus(snapshot)
            }
    }

    private var topmostPresentedViewController: UIViewController {
        var presenter: UIViewController = self
        while let presented = presenter.presentedViewController,
              !presented.isBeingDismissed {
            presenter = presented
        }
        return presenter
    }

    private func dismissKeyboardDictationService(
        completion: (() -> Void)? = nil
    ) {
        guard let navigation =
            keyboardDictationServiceViewController?.navigationController,
              navigation.presentingViewController != nil
        else {
            completion?()
            return
        }
        navigation.dismiss(animated: true, completion: completion)
    }

    private func useKeyboardDictationInAgentDesk() {
        let showKeyboard = { [weak self] in
            guard let self else { return }
            surfaceSelectionChanged(.control)
            applyKeyboardPresentationIntent(.show)
        }
        guard let root = view.window?.rootViewController,
              root.presentedViewController != nil
        else {
            showKeyboard()
            return
        }
        // This action explicitly means leaving any stacked setup or settings
        // sheets and returning to AgentDesk's own remote-input field.
        root.dismiss(animated: true, completion: showKeyboard)
    }

    func renderKeyboardDictationStatus(
        _ snapshot: KeyboardDictationServiceSnapshot
    ) {
        let state = KeyboardDictationContainingAppState(snapshot: snapshot)
        keyboardDictationServiceButton.setImage(
            UIImage(systemName: state.railSymbolName),
            for: .normal
        )
        keyboardDictationServiceButton.accessibilityLabel =
            state.accessibilityLabel
        keyboardDictationServiceButton.accessibilityHint =
            state == .inactive
                ? "Connects the AgentDesk keyboard to Mac transcription."
                : "Opens Keyboard Dictation status and controls."
        surfaceControlRail.setUtilityButton(
            keyboardDictationServiceButton,
            selected: state.isHighlighted
        )
    }

    func turnOffKeyboardDictation() {
        let coordinator = keyboardDictationCoordinator
        coordinator?.turnOff()
        coordinator?.removeSnapshotObserver(
            keyboardDictationSnapshotObservationID
        )
        keyboardDictationSnapshotObservationID = nil
        keyboardDictationCoordinator = nil
        renderKeyboardDictationStatus(.inactive)
    }
}
