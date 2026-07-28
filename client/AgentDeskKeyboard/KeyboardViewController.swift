import KeyboardDictation
import SwiftUI
import UIKit

@MainActor
final class KeyboardViewController: UIInputViewController {
    private let voiceToolbar = KeyboardVoiceToolbar()
    private let keyboardView = AgentDeskQWERTYView()
    private let draftEditor = KeyboardDraftTextView()
    private let rootStack = UIStackView()
    private var keyboardHeightConstraint: NSLayoutConstraint?
    private var store: KeyboardDictationStore?
    private var preferences = KeyboardDictationPreferences()
    private var layoutState = KeyboardLayoutState()
    private var snapshot = KeyboardDictationServiceSnapshot.inactive
    private var commandObservation: KeyboardDictationNotificationObservation?
    private var refreshTimer: Timer?
    private var commandTimeout: Timer?
    private var pendingCommandID: UUID?
    private var pendingCommandGenerationID: UUID?
    private var captureContext: KeyboardDocumentContextFingerprint?
    private var captureDocumentIdentifier: UUID?
    private var serviceResponsive = false
    private var linkController: UIViewController?
    private var lastShiftTapAt: TimeInterval?

    override func viewDidLoad() {
        super.viewDidLoad()
        configureStore()
        configureView()
        configureCallbacks()
        installObservation()
        refreshAll()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refreshAll()
        verifyServiceLiveness()
        startRefreshTimer()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        refreshTimer?.invalidate()
        refreshTimer = nil
        commandTimeout?.invalidate()
        commandTimeout = nil
    }

    override func textWillChange(_ textInput: (any UITextInput)?) {
        super.textWillChange(textInput)
        updateTypingTraits()
    }

    override func textDidChange(_ textInput: (any UITextInput)?) {
        super.textDidChange(textInput)
        updateTypingTraits()
    }

    private func configureStore() {
        do {
            store = try KeyboardDictationStore(
                appGroupIdentifier: KeyboardDictationContract
                    .appGroupIdentifier()
            )
        } catch {
            store = nil
        }
    }

    private func configureView() {
        view.backgroundColor = .secondarySystemBackground
        keyboardView.translatesAutoresizingMaskIntoConstraints = false
        voiceToolbar.translatesAutoresizingMaskIntoConstraints = false

        draftEditor.isHidden = true
        draftEditor.translatesAutoresizingMaskIntoConstraints = false
        draftEditor.accessibilityLabel = "Dictation review"
        draftEditor.accessibilityHint =
            "Edit the transcript with the AgentDesk keyboard, then choose Insert."

        rootStack.axis = .vertical
        rootStack.spacing = 6
        rootStack.translatesAutoresizingMaskIntoConstraints = false
        rootStack.addArrangedSubview(voiceToolbar)
        rootStack.addArrangedSubview(draftEditor)
        rootStack.addArrangedSubview(keyboardView)
        view.addSubview(rootStack)

        let height = view.heightAnchor.constraint(equalToConstant: 330)
        height.priority = .required
        height.isActive = true
        keyboardHeightConstraint = height

        NSLayoutConstraint.activate([
            rootStack.topAnchor.constraint(equalTo: view.topAnchor, constant: 6),
            rootStack.leadingAnchor.constraint(
                equalTo: view.leadingAnchor,
                constant: 4
            ),
            rootStack.trailingAnchor.constraint(
                equalTo: view.trailingAnchor,
                constant: -4
            ),
            rootStack.bottomAnchor.constraint(
                equalTo: view.bottomAnchor,
                constant: -6
            ),
            voiceToolbar.heightAnchor.constraint(
                greaterThanOrEqualToConstant: 52
            ),
            draftEditor.heightAnchor.constraint(equalToConstant: 76),
        ])
    }

    private func configureCallbacks() {
        keyboardView.onKey = { [weak self] key in
            self?.handleKey(key)
        }
        keyboardView.onDeleteBegan = { [weak self] in
            self?.deleteBackward()
        }
        keyboardView.onCursorDelta = { [weak self] delta in
            self?.moveCursor(by: delta)
        }
        voiceToolbar.onInsertionModeChanged = { [weak self] mode in
            self?.setInsertionMode(mode)
        }
        voiceToolbar.onVoiceAction = { [weak self] in
            self?.performVoiceAction()
        }
        voiceToolbar.onInsertDraft = { [weak self] in
            self?.insertDraft()
        }
        voiceToolbar.onDismissDraft = { [weak self] in
            self?.dismissDraft()
        }
    }

    private func installObservation() {
        commandObservation = KeyboardDictationNotificationObservation(
            name: KeyboardDictationNotification.service
        ) { [weak self] in
            Task { @MainActor in
                self?.refreshService()
            }
        }
    }

    private func startRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(
            withTimeInterval: 0.5,
            repeats: true
        ) { [weak self] _ in
            Task { @MainActor in
                self?.refreshService()
            }
        }
    }

    private func refreshAll() {
        guard let store else {
            voiceToolbar.render(.unavailable(
                "AgentDesk keyboard storage is unavailable."
            ))
            return
        }
        do {
            try store.purgeExpiredResult()
            preferences = try store.preferences()
            snapshot = try store.serviceSnapshot()
            voiceToolbar.insertionMode = preferences.insertionMode
            updateTypingTraits()
            render()
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func refreshService() {
        guard let store else { return }
        do {
            let updated = try store.serviceSnapshot()
            var shouldVerifyReplacement = false
            if let pendingCommandID,
               let pendingCommandGenerationID,
               updated.generationID != pendingCommandGenerationID {
                try store.clearCommand(ifMatching: pendingCommandID)
                self.pendingCommandID = nil
                self.pendingCommandGenerationID = nil
                commandTimeout?.invalidate()
                commandTimeout = nil
                serviceResponsive = false
                captureContext = nil
                captureDocumentIdentifier = nil
                shouldVerifyReplacement = updated.isArmed
            }
            if let pendingCommandID,
               updated.acknowledgedCommandID == pendingCommandID {
                self.pendingCommandID = nil
                pendingCommandGenerationID = nil
                commandTimeout?.invalidate()
                commandTimeout = nil
                serviceResponsive = true
                try store.clearCommand(ifMatching: pendingCommandID)
            }
            snapshot = updated
            if shouldVerifyReplacement {
                verifyServiceLiveness()
            }
            if updated.phase == .completed,
               updated.recordingID != nil {
                handleCompletedResultIfNeeded()
            }
            render()
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func verifyServiceLiveness() {
        guard snapshot.isArmed, pendingCommandID == nil else { return }
        sendCommand(.ping)
    }

    private func sendCommand(_ kind: KeyboardDictationCommandKind) {
        guard let store,
              let generationID = snapshot.generationID,
              pendingCommandID == nil
        else {
            return
        }
        let command = KeyboardDictationCommand(
            generationID: generationID,
            kind: kind
        )
        do {
            try store.saveCommand(command)
            pendingCommandID = command.id
            pendingCommandGenerationID = generationID
            KeyboardDictationNotification.post(
                KeyboardDictationNotification.command
            )
            commandTimeout?.invalidate()
            commandTimeout = Timer.scheduledTimer(
                withTimeInterval:
                    KeyboardDictationContract.commandAcknowledgementTimeout,
                repeats: false
            ) { [weak self] _ in
                Task { @MainActor in
                    guard self?.pendingCommandID == command.id else { return }
                    self?.serviceResponsive = false
                    self?.render()
                    let action = KeyboardDictationInteractionPolicy
                        .commandTimeoutAction(
                            hasUnacknowledgedCommand:
                                self?.pendingCommandID == command.id
                        )
                    if action == .probeLiveness {
                        self?.verifyServiceLiveness()
                    }
                }
            }
            render()
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func performVoiceAction() {
        switch snapshot.phase {
        case .ready, .completed, .failed:
            captureContext = currentDocumentFingerprint()
            captureDocumentIdentifier = textDocumentProxy.documentIdentifier
            sendCommand(.start)
        case .recording:
            sendCommand(.stop)
        case .inactive, .arming, .saving, .transcribing, .analyzing:
            break
        }
    }

    private func setInsertionMode(_ mode: KeyboardDictationInsertionMode) {
        preferences.insertionMode = mode
        do {
            try store?.savePreferences(preferences)
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func handleCompletedResultIfNeeded() {
        guard let store,
              let recordingID = snapshot.recordingID,
              let transcript = snapshot.finalTranscript,
              !transcript.isEmpty
        else {
            return
        }
        do {
            let log = try store.consumptionLog()
            guard !log.contains(recordingID: recordingID) else {
                sendCommand(.dismissResult)
                return
            }
            if preferences.insertionMode == .automatic,
               KeyboardAutomaticInsertionGuard.allowsInsertion(
                   captureContext: captureContext,
                   currentContext: currentDocumentFingerprint(),
                   captureDocumentIdentifier: captureDocumentIdentifier,
                   currentDocumentIdentifier:
                       textDocumentProxy.documentIdentifier,
                   keyboardControllerIsActive: view.window != nil
               ) {
                consumeAndInsert(
                    recordingID: recordingID,
                    text: transcript
                )
                return
            }
            captureContext = nil
            captureDocumentIdentifier = nil
            guard KeyboardDictationInteractionPolicy.shouldPresentDraft(
                recordingID: recordingID,
                typingTarget: layoutState.typingTarget
            ) else {
                return
            }
            try showDraft(recordingID: recordingID, transcript: transcript)
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func showDraft(
        recordingID: String,
        transcript: String
    ) throws {
        let existing = try store?.draft()
        let text = existing?.recordingID == recordingID
            ? existing?.text ?? transcript
            : transcript
        try store?.saveDraft(KeyboardDictationDraft(
            recordingID: recordingID,
            text: text
        ))
        draftEditor.text = text
        draftEditor.setSelectionToEnd()
        draftEditor.isHidden = false
        layoutState.typingTarget = .draft(recordingID: recordingID)
        keyboardHeightConstraint?.constant = 412
        voiceToolbar.showDraftActions(true)
        UIAccessibility.post(
            notification: .layoutChanged,
            argument: draftEditor
        )
    }

    private func insertDraft() {
        guard case .draft(let recordingID) = layoutState.typingTarget else {
            return
        }
        let text = draftEditor.text ?? ""
        guard !text.isEmpty else { return }
        consumeAndInsert(recordingID: recordingID, text: text)
    }

    private func dismissDraft() {
        guard case .draft(let recordingID) = layoutState.typingTarget else {
            return
        }
        do {
            var log = try store?.consumptionLog()
                ?? KeyboardDictationConsumptionLog()
            log.record(recordingID: recordingID)
            try store?.saveConsumptionLog(log)
            try store?.clearDraft()
            closeDraft()
            captureContext = nil
            captureDocumentIdentifier = nil
            sendCommand(.dismissResult)
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func consumeAndInsert(recordingID: String, text: String) {
        guard !text.isEmpty else { return }
        do {
            var log = try store?.consumptionLog()
                ?? KeyboardDictationConsumptionLog()
            log.record(recordingID: recordingID)
            try store?.saveConsumptionLog(log)
            textDocumentProxy.insertText(text)
            try store?.clearDraft()
            closeDraft()
            captureContext = nil
            captureDocumentIdentifier = nil
            sendCommand(.dismissResult)
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func closeDraft() {
        draftEditor.resignFirstResponder()
        draftEditor.isHidden = true
        draftEditor.text = ""
        layoutState.typingTarget = .document
        keyboardHeightConstraint?.constant = 330
        voiceToolbar.showDraftActions(false)
        UIAccessibility.post(notification: .layoutChanged, argument: voiceToolbar)
    }

    private func handleKey(_ key: KeyboardKey) {
        switch key {
        case .shift:
            let now = ProcessInfo.processInfo.systemUptime
            let isDoubleTap = layoutState.shift == .on
                && lastShiftTapAt.map { now - $0 <= 0.35 } == true
            layoutState.handleShiftTap(isDoubleTap: isDoubleTap)
            lastShiftTapAt = layoutState.shift == .on ? now : nil
            keyboardView.render(layoutState)
            return
        case .delete:
            deleteBackward()
            return
        case .globe:
            advanceToNextInputMode()
            return
        default:
            lastShiftTapAt = nil
            break
        }
        let text = layoutState.handle(key)
        keyboardView.render(layoutState)
        guard let text else { return }
        switch layoutState.typingTarget {
        case .document:
            textDocumentProxy.insertText(text)
            updateTypingTraits()
        case .draft:
            draftEditor.insertFromKeyboard(text)
            persistDraft()
        }
    }

    private func deleteBackward() {
        switch layoutState.typingTarget {
        case .document:
            textDocumentProxy.deleteBackward()
            updateTypingTraits()
        case .draft:
            draftEditor.deleteFromKeyboard()
            persistDraft()
        }
    }

    private func moveCursor(by delta: Int) {
        guard delta != 0 else { return }
        switch layoutState.typingTarget {
        case .document:
            textDocumentProxy.adjustTextPosition(
                byCharacterOffset: delta
            )
        case .draft:
            draftEditor.moveSelection(by: delta)
        }
    }

    private func persistDraft() {
        guard case .draft(let recordingID) = layoutState.typingTarget else {
            return
        }
        do {
            try store?.saveDraft(KeyboardDictationDraft(
                recordingID: recordingID,
                text: draftEditor.text ?? ""
            ))
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func updateTypingTraits() {
        keyboardView.returnKeyTitle = returnKeyTitle()
        if case .document = layoutState.typingTarget {
            switch textDocumentProxy.keyboardType {
            case .some(.emailAddress):
                layoutState.fieldKind = .email
            case .some(.URL):
                layoutState.fieldKind = .url
            default:
                layoutState.fieldKind = .standard
            }
        } else {
            layoutState.fieldKind = .standard
        }
        guard layoutState.page == .alphabet,
              layoutState.shift != .locked
        else {
            keyboardView.render(layoutState)
            return
        }
        let shouldCapitalize: Bool
        switch textDocumentProxy.autocapitalizationType {
        case .allCharacters:
            shouldCapitalize = true
        case .words:
            let context = textDocumentProxy.documentContextBeforeInput ?? ""
            shouldCapitalize = context.isEmpty
                || context.last?.isWhitespace == true
        case .sentences:
            let context = textDocumentProxy.documentContextBeforeInput ?? ""
            let trimmed = context.trimmingCharacters(
                in: .whitespacesAndNewlines
            )
            shouldCapitalize = trimmed.isEmpty
                || ".!?".contains(trimmed.last ?? " ")
        case .some(.none), nil:
            shouldCapitalize = false
        @unknown default:
            shouldCapitalize = false
        }
        layoutState.setAutomaticShift(shouldCapitalize)
        keyboardView.render(layoutState)
    }

    private func returnKeyTitle() -> String {
        switch textDocumentProxy.returnKeyType {
        case .done: "Done"
        case .go: "Go"
        case .next: "Next"
        case .search: "Search"
        case .send: "Send"
        case .join: "Join"
        case .continue: "Continue"
        default: "return"
        }
    }

    private func currentDocumentFingerprint()
        -> KeyboardDocumentContextFingerprint
    {
        KeyboardDocumentContextFingerprint(
            beforeInput: textDocumentProxy.documentContextBeforeInput,
            afterInput: textDocumentProxy.documentContextAfterInput,
            selectedText: textDocumentProxy.selectedText
        )
    }

    private func render() {
        voiceToolbar.insertionMode = preferences.insertionMode
        voiceToolbar.isInteractionEnabled = pendingCommandID == nil
        keyboardView.render(layoutState)

        guard hasFullAccess else {
            removeLink()
            voiceToolbar.render(.unavailable(
                "Full Access is required for voice. Typing remains local."
            ))
            return
        }
        guard store != nil else {
            removeLink()
            voiceToolbar.render(.unavailable(
                "AgentDesk keyboard storage is unavailable."
            ))
            return
        }
        if snapshot.phase == .failed, !snapshot.isArmed {
            voiceToolbar.render(.unavailable(
                snapshot.errorMessage ?? "Keyboard dictation is unavailable."
            ))
            installLinkIfNeeded()
            return
        }
        if !snapshot.isArmed || !serviceResponsive && snapshot.phase != .arming {
            voiceToolbar.render(.inactive)
            installLinkIfNeeded()
            return
        }
        removeLink()
        switch snapshot.phase {
        case .inactive:
            voiceToolbar.render(.inactive)
        case .arming:
            voiceToolbar.render(.working("Starting AgentDesk…"))
        case .ready:
            voiceToolbar.render(.ready)
        case .recording:
            voiceToolbar.render(.recording(
                partialTranscript: snapshot.partialTranscript,
                meter: snapshot.meterLevel
            ))
        case .saving:
            voiceToolbar.render(.working("Saving…"))
        case .transcribing:
            voiceToolbar.render(.working("Transcribing…"))
        case .analyzing:
            voiceToolbar.render(.working("Analyzing pronunciation…"))
        case .completed:
            if snapshot.finalTranscript?.isEmpty != false {
                voiceToolbar.render(.failed(
                    "The Mac saved the recording but returned no transcript."
                ))
            } else if draftEditor.isHidden {
                voiceToolbar.render(.working("Transcript ready"))
            } else {
                voiceToolbar.render(.reviewing)
            }
        case .failed:
            voiceToolbar.render(.failed(
                snapshot.errorMessage ?? "Dictation failed."
            ))
        }
    }

    private func installLinkIfNeeded() {
        guard linkController == nil, let store else { return }
        do {
            let request = try store.prepareHandoff()
            let link = Link(
                "Start AgentDesk",
                destination: KeyboardDictationContract.handoffURL(
                    requestID: request.id
                )
            )
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(.white)
            .background(Color.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .accessibilityHint(
                "Opens AgentDesk to activate background dictation."
            )
            let controller = UIHostingController(rootView: link)
            controller.view.backgroundColor = .clear
            addChild(controller)
            voiceToolbar.installLinkView(controller.view)
            controller.didMove(toParent: self)
            linkController = controller
        } catch {
            voiceToolbar.render(.unavailable(error.localizedDescription))
        }
    }

    private func removeLink() {
        guard let linkController else { return }
        linkController.willMove(toParent: nil)
        linkController.view.removeFromSuperview()
        linkController.removeFromParent()
        self.linkController = nil
        voiceToolbar.installLinkView(nil)
    }
}
