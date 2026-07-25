import AVFoundation
import UIKit
import AgentDeskWire

// Forwarding seam between the in-app gesture surfaces (trackpad,
// scroll strip, Spaces band) and the input-channel wire. Owns the
// GestureTranslator and ThumbnailStripView delegate methods, the
// settings-changed responder, and the two background Tasks that drain
// DesktopState / Thumbnails from the input channel into the views.

extension PairingViewController: GestureTranslatorDelegate, ThumbnailStripViewDelegate, DisplayRailViewDelegate {
    @objc func settingsChanged() {
        applySettingsToTranslator()
        applyVideoTouchState()
        if !SettingsStore.shared.autoKeyboardEnabled,
           keyboardPresentationState == .pendingTextFocus {
            applyKeyboardPresentationIntent(.hide)
        }
        // R20: settings toggle is the only source of truth for whether
        // thumbnails capture should run host-side. On every change we
        // resend the current ClientConfig and refresh strip visibility.
        sendCurrentClientConfig()
        if let state = lastDesktopState {
            thumbnailStripView.apply(state: state)
        }
        refreshThumbnailStripVisibility()
    }

    func applySettingsToTranslator() {
        gestureTranslator.tuning = SettingsStore.shared.tuning
        thumbnailStripView.useMacOSDirection = SettingsStore.shared.useMacOSSpacesDirection
    }

    // R11: drains the InputChannel's host-pushed DesktopState frames
    // into the dots band. Restarted on each showTrackpad because
    // activeInputChannel may have been replaced by a reconnect during
    // foreground (D13.1 + D13.2 lifecycle).
    func startDesktopStateObservation() {
        desktopStateTask?.cancel()
        guard let channel = pairingClient.activeInputChannel else { return }
        displayRailView.renderEmpty()
        thumbnailStripView.renderEmpty()
        desktopStateTask = Task { [weak self, channel] in
            for await state in channel.desktopStateUpdates {
                await MainActor.run {
                    self?.lastDesktopState = state
                    self?.selectedDisplayIdForClientConfig = state.selectedDisplayId
                        ?? state.activeDisplayId
                        ?? state.displays.first?.id
                    self?.displayRailView.apply(state: state)
                    self?.thumbnailStripView.apply(state: state)
                    self?.refreshThumbnailStripVisibility()
                    self?.applyDesktopStateForCursorModel(state)
                    self?.sendCurrentClientConfig()
                }
            }
        }
    }

    // ADR-0006: drains the ThumbnailsPush stream into the strip view.
    // Independent from DesktopState because thumbnails refresh on
    // their own cadence; merging into desktopStateTask would force a
    // synthetic state push per timer tick (rejected in ADR-0006).
    func startThumbnailsObservation() {
        thumbnailsTask?.cancel()
        topWindowsTask?.cancel()
        guard let channel = pairingClient.activeInputChannel else { return }
        thumbnailsTask = Task { [weak self, channel] in
            for await thumbnails in channel.thumbnailsUpdates {
                await MainActor.run {
                    ClientDiagnostics.shared.record(
                        type: "thumbnailPushReceived",
                        fields: [
                            "count": String(thumbnails.count),
                            "ids": thumbnails.keys.sorted().joined(separator: ",")
                        ],
                        level: .info
                    )
                    self?.thumbnailStripView.apply(thumbnails: thumbnails)
                    self?.refreshThumbnailStripVisibility()
                }
            }
        }
        topWindowsTask = Task { [weak self, channel] in
            for await topWindows in channel.topWindowsUpdates {
                await MainActor.run {
                    self?.thumbnailStripView.apply(topWindows: topWindows)
                }
            }
        }
    }

    func startAgentSayObservation() {
        agentSayTask?.cancel()
        guard let channel = pairingClient.activeInputChannel else { return }
        agentSayTask = Task { [weak self, channel] in
            for await push in channel.agentSayUpdates {
                await MainActor.run {
                    self?.handleAgentSay(push)
                }
            }
        }
    }

    // Drains host-pushed cursor-image frames so the overlay mirrors the
    // real Mac cursor shape. Restarted alongside the other observations
    // because activeInputChannel may be replaced by a reconnect.
    func startCursorObservation() {
        cursorTask?.cancel()
        cursorTask = nil
        cursorReconciliationTask?.cancel()
        cursorReconciliationTask = nil
        cursorConfirmationTask?.cancel()
        cursorConfirmationTask = nil
        inputSendTailTask?.cancel()
        inputSendTailTask = nil
        cursorReconciliation.reset()
        applyCursorConfidencePresentation()
        guard let channel = pairingClient.activeInputChannel else { return }
        cursorTask = Task { [weak self, channel] in
            for await push in channel.cursorUpdates {
                await MainActor.run {
                    guard let self else { return }
                    self.lastCursorKind = push.cursorKind
                    self.applyCursorImage(push)
                }
            }
        }
        cursorReconciliationTask = Task { [weak self, channel] in
            for await update in channel.cursorReconciliationUpdates {
                await MainActor.run {
                    switch update {
                    case .applied(let push):
                        self?.applyCursorApplied(push)
                    case .hostMoved(let push):
                        self?.applyHostCursorMoved(push)
                    }
                }
            }
        }
    }

    func startTextInputFocusObservation() {
        textInputFocusTask?.cancel()
        textInputFocusTask = nil
        guard let channel = pairingClient.activeInputChannel else { return }
        textInputFocusTask = Task { [weak self, channel] in
            for await push in channel.textInputFocusUpdates {
                await MainActor.run {
                    self?.applyHostTextInputFocus(push)
                }
            }
        }
    }

    func startHostAvailabilityObservation() {
        hostAvailabilityTask?.cancel()
        hostAvailabilityTask = nil
        guard let channel = pairingClient.activeInputChannel else { return }
        hostAvailabilityTask = Task { [weak self, channel] in
            for await push in channel.hostAvailabilityUpdates {
                await MainActor.run {
                    self?.applyHostAvailability(push)
                }
            }
        }
    }

    func applyHostTextInputFocus(_ push: HostTextInputFocusPush) {
        lastHostTextInputFocus = push
        guard SettingsStore.shared.autoKeyboardEnabled else { return }
        applyKeyboardPresentationIntent(HostTextInputKeyboardPolicy.intent(for: push))
    }

    func applyHostAvailability(_ push: HostAvailabilityPush) {
        ClientDiagnostics.shared.record(
            type: "hostAvailability",
            fields: [
                "availability": push.availability.rawValue,
                "reason": push.reason ?? "nil"
            ],
            level: .info
        )
        guard let label = hostAvailabilityLabel else { return }
        switch push.availability {
        case .active:
            label.isHidden = true
            label.text = nil
        case .locked:
            label.text = "Mac locked\nKeyboard input stays available"
            label.isHidden = false
            hostContentView.bringSubviewToFront(label)
            view.bringSubviewToFront(surfaceControlRail)
        case .captureUnavailable:
            label.text = "Mac display unavailable\nInput stays connected"
            label.isHidden = false
            hostContentView.bringSubviewToFront(label)
            view.bringSubviewToFront(surfaceControlRail)
        case .disconnected:
            label.isHidden = true
            label.text = nil
        }
    }

    func stopAgentSayForegroundPresentation() {
        agentSayTask?.cancel()
        agentSayTask = nil
        agentSaySpeechTask?.cancel()
        agentSaySpeechTask = nil
        agentSayHideTask?.cancel()
        agentSayHideTask = nil
        agentSaySynthesizer.stopSpeaking(at: .immediate)
        agentSayIncomingBuffer = ""
        agentSaySpeechQueue.removeAll()
        agentSayIsSpeaking = false
        agentSayStreamEnded = false
        agentSayBanner.text = nil
        agentSayBanner.isHidden = true
        agentSayBanner.alpha = 0
    }

    func handleAgentSay(_ push: AgentSayPush) {
        guard UIApplication.shared.applicationState == .active else { return }
        switch push.phase {
        case "start":
            agentSaySynthesizer.stopSpeaking(at: .immediate)
            agentSayIncomingBuffer = ""
            agentSaySpeechQueue.removeAll()
            agentSayIsSpeaking = false
            agentSayStreamEnded = false
            agentSayBanner.text = nil
            agentSayBanner.isHidden = true
            agentSayBanner.alpha = 0
        case "chunk":
            guard let text = push.text, !text.isEmpty else { return }
            agentSayIncomingBuffer += text
            enqueueAgentSaySegments(final: false)
            speakNextAgentSaySegmentIfNeeded()
        case "end":
            agentSayStreamEnded = true
            enqueueAgentSaySegments(final: true)
            speakNextAgentSaySegmentIfNeeded()
            if !agentSayIsSpeaking && agentSaySpeechQueue.isEmpty {
                scheduleAgentSayBannerHide()
            }
        default:
            break
        }
    }

    private func showAgentSayBanner(text: String) {
        agentSayHideTask?.cancel()
        agentSayBanner.text = text.isEmpty ? " " : text
        agentSayBanner.isHidden = false
        hostContentView.bringSubviewToFront(agentSayBanner)
        UIView.animate(withDuration: 0.12) {
            self.agentSayBanner.alpha = 1
        }
    }

    private func scheduleAgentSayBannerHide() {
        agentSayHideTask?.cancel()
        agentSayHideTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                UIView.animate(withDuration: 0.18, animations: {
                    self?.agentSayBanner.alpha = 0
                }, completion: { _ in
                    self?.agentSayBanner.isHidden = true
                    self?.agentSayBanner.text = nil
                })
            }
        }
    }

    private func enqueueAgentSaySegments(final: Bool) {
        while let segment = nextAgentSaySegment(final: final) {
            agentSaySpeechQueue.append(segment)
        }
    }

    private func nextAgentSaySegment(final: Bool) -> String? {
        let trimmed = agentSayIncomingBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
        if final {
            agentSayIncomingBuffer = ""
            return trimmed.isEmpty ? nil : trimmed
        }

        if let end = agentSayIncomingBuffer.firstIndex(where: { ".!?\n".contains($0) }) {
            let afterEnd = agentSayIncomingBuffer.index(after: end)
            let segment = String(agentSayIncomingBuffer[..<afterEnd])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            agentSayIncomingBuffer.removeSubrange(..<afterEnd)
            return segment.isEmpty ? nil : segment
        }

        let maxSubtitleLength = 96
        guard agentSayIncomingBuffer.count > maxSubtitleLength else { return nil }
        let limit = agentSayIncomingBuffer.index(agentSayIncomingBuffer.startIndex, offsetBy: maxSubtitleLength)
        let prefix = agentSayIncomingBuffer[..<limit]
        let split = prefix.lastIndex(where: { $0 == " " }) ?? limit
        let segment = String(agentSayIncomingBuffer[..<split])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        agentSayIncomingBuffer.removeSubrange(..<split)
        return segment.isEmpty ? nil : segment
    }

    func speakNextAgentSaySegmentIfNeeded() {
        guard !agentSayIsSpeaking else { return }
        guard !agentSaySpeechQueue.isEmpty else {
            if agentSayStreamEnded {
                scheduleAgentSayBannerHide()
            }
            return
        }
        let text = agentSaySpeechQueue.removeFirst()
        agentSayIsSpeaking = true
        showAgentSayBanner(text: text)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            // Speech can still succeed with the default session; keep the
            // foreground banner path alive if audio routing setup fails.
        }
        let utterance = AVSpeechUtterance(string: text)
        let settings = SettingsStore.shared
        if let identifier = settings.agentSayVoiceIdentifier,
           let selectedVoice = AVSpeechSynthesisVoice(identifier: identifier) {
            utterance.voice = selectedVoice
        } else if let language = settings.agentSayVoiceLanguage,
                  let languageVoice = AVSpeechSynthesisVoice(language: language) {
            utterance.voice = languageVoice
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
                ?? AVSpeechSynthesisVoice(language: "en-US")
        }
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        agentSaySynthesizer.speak(utterance)
    }

    // R25: the strip is the only Spaces UI now, so visibility depends
    // solely on whether there's a Space to switch to. The Show-Space-
    // previews setting still gates host-side thumbnail capture (see
    // sendCurrentClientConfig) but no longer hides the strip.
    func refreshThumbnailStripVisibility() {
        guard isControlSurfaceActive(), SettingsStore.shared.videoLayoutMode != .full else {
            displayRailView.isHidden = true
            thumbnailStripView.isHidden = true
            return
        }
        displayRailView.isHidden = displayRailView.displayCount <= 1
        thumbnailStripView.isHidden = thumbnailStripView.userSpaceCount <= 1
    }

    // ADR-0006: send the current client-config on input-channel open
    // and on every settings toggle change. The host is the source of
    // truth on capture state; this is the only path that turns it on
    // or off.
    func sendCurrentClientConfig() {
        guard let channel = pairingClient.activeInputChannel else { return }
        let config = currentClientConfig()
        if let owned = videoSink as? any OwnedMediaFrameSink {
            let expectedFps = config.mediaQuality.flatMap { quality in
                quality.adaptiveEnabled ? nil : quality.fixedTarget?.fps
            } ?? Config.ownedMediaExpectedFrameRate
            owned.setOwnedMediaExpectedFrameRate(expectedFps)
        }
        ClientDiagnostics.shared.record(
            type: "clientConfigSendStarted",
            fields: [
                "thumbnailsEnabled": String(config.thumbnailsEnabled),
                "selectedDisplayId": config.selectedDisplayId ?? "nil",
                "autoKeyboardEnabled": String(config.autoKeyboardEnabled)
            ],
            level: .info
        )
        Task { [channel, config] in
            do {
                try await channel.sendConfig(config)
                ClientDiagnostics.shared.record(
                    type: "clientConfigSendSucceeded",
                    fields: [
                        "thumbnailsEnabled": String(config.thumbnailsEnabled),
                        "selectedDisplayId": config.selectedDisplayId ?? "nil",
                        "autoKeyboardEnabled": String(config.autoKeyboardEnabled)
                    ],
                    level: .info
                )
            } catch {
                ClientDiagnostics.shared.record(
                    type: "clientConfigSendFailed",
                    fields: ["error": String(describing: error)],
                    level: .error
                )
            }
        }
    }

    // MARK: - GestureTranslatorDelegate

    func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput) {
        sendPointerAwareInput(input)
    }

    // MARK: - ThumbnailStripViewDelegate

    // R20: a tap on a non-active tile sends one .switchSpaceStep frame
    // carrying the full signed jump. The host expands it into |delta|
    // dock-swipe cycles on its own serial queue, much tighter than the
    // WSS round-trip the client could afford between cycles. The
    // previous client-side chain (one wire frame per phase) had two
    // problems this replaces: detached-Task ordering races for
    // |delta|>=2, and a 200ms inter-cycle floor dictated by per-frame
    // round-trip latency. With the chain on the host, the local Dock
    // accepts ~90ms cycle gaps cleanly.
    //
    // Sign convention: delta carries the wire-space direction sign,
    // i.e. positive = same direction a positive switchSpaceGesture
    // progress would commit. Computed from the iPhone's tap intent
    // (advance N tiles toward higher index) folded with the user's
    // direction toggle so tap-to-jump and swipe-to-jump agree.
    //
    // The indicator glide stays client-side via previewActiveTransition
    // and is independent of the wire send.
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int) {
        guard delta != 0 else { return }
        let steps = abs(delta)
        let stepDirRaw: Float = delta > 0 ? -1.0 : 1.0
        let wireSign: Float = view.useMacOSDirection ? stepDirRaw : -stepDirRaw
        let wireDelta = Int(wireSign) * steps

        if let activeIdx = view.activeIndex {
            let target = max(0, min(view.userSpaceCount - 1, activeIdx + delta))
            let duration = min(0.5, 0.18 + Double(steps - 1) * 0.10)
            view.previewActiveTransition(toIndex: target, duration: duration)
        }
        sendInput(.switchSpaceStep(delta: wireDelta))
    }

    // R25: continuous swipe-to-switch frames produced by the strip's
    // pan recognizer. Forward unchanged; the host's InputDispatcher
    // synthesises one dock-swipe CGEvent per frame.
    func thumbnailStrip(_ view: ThumbnailStripView, didProduce input: NormalizedInput) {
        sendInput(input)
    }

    func thumbnailStrip(_ view: ThumbnailStripView, didLongPressSpaceId spaceId: UInt64) {
        guard let channel = pairingClient.activeInputChannel else { return }
        let config = currentClientConfig(thumbnailRefresh: spaceId)
        Task { [channel, config] in
            try? await channel.sendConfig(config)
        }
    }

    func displayRail(_ view: DisplayRailView, didSelectDisplayId displayId: String) {
        guard let channel = pairingClient.activeInputChannel else { return }
        selectedDisplayIdForClientConfig = displayId
        let config = currentClientConfig(selectedDisplayId: displayId)
        Task { [channel, config] in
            try? await channel.sendConfig(config)
        }
    }

    private func currentClientConfig(
        thumbnailRefresh: UInt64? = nil,
        selectedDisplayId explicitSelectedDisplayId: String? = nil
    ) -> ClientConfig {
        ClientConfig(
            thumbnailsEnabled: SettingsStore.shared.showSpacePreviews,
            thumbnailRefresh: thumbnailRefresh,
            selectedDisplayId: explicitSelectedDisplayId ?? selectedDisplayIdForConfig(),
            crispTextOverlayEnabled: SettingsStore.shared.crispTextOverlayEnabled,
            showHostCursorInVideo: SettingsStore.shared.showHostCursorInVideo,
            mediaQuality: Config.launchMediaQualityOverride ?? SettingsStore.shared.mediaQualityConfig,
            autoKeyboardEnabled: SettingsStore.shared.autoKeyboardEnabled,
            diagnosticScreenshotsEnabled: SettingsStore.shared.diagnosticScreenshotsEnabled
        )
    }

    private func selectedDisplayIdForConfig() -> String? {
        selectedDisplayIdForClientConfig
            ?? lastDesktopState?.selectedDisplayId
            ?? lastDesktopState?.activeDisplayId
            ?? lastDesktopState?.displays.first?.id
    }

    // ADR-0030: input rides its own ordered stream inside the authenticated
    // session QUIC connection. The channel send is async; main-actor task
    // chaining keeps call order identical to cursor revision order while the
    // trackpad / keyboard caller remains synchronous.
    func sendInput(_ input: NormalizedInput) {
        applyKeyboardPresentationIntentForRemoteInput(input)
        let now = cursorConfirmationClock()
        let cursorRevision: UInt64?
        switch input {
        case .cursorSet, .cursorMove:
            guard let operation = cursorOperation(for: input) else {
                ClientDiagnostics.shared.record(
                    type: "cursorInputDropped",
                    fields: ["reason": "missing-local-cursor-geometry"],
                    level: .error
                )
                return
            }
            guard let revision = cursorReconciliation.record(operation, sentAt: now) else {
                applyCursorConfidencePresentation()
                ClientDiagnostics.shared.record(
                    type: "cursorInputDropped",
                    fields: ["reason": "pending-window-full"],
                    level: .error
                )
                return
            }
            cursorRevision = revision
        default:
            cursorRevision = nil
        }
        let event = InputChannelEvent(event: input, cursorRevision: cursorRevision)
        applyCursorConfidencePresentation()
        scheduleCursorConfirmationDeadline(now: now)
        guard let channel = pairingClient.activeInputChannel else {
            if let cursorRevision {
                cursorReconciliation.markSendFailed(revision: cursorRevision)
                applyCursorConfidencePresentation()
                scheduleCursorConfirmationDeadline()
            }
            if panFollowActive || !panFollowEdgeAxes.isEmpty {
                PanFollowDiagnostics.log("drop-no-input-channel input=\(input)")
            }
            return
        }
        let priorSend = inputSendTailTask
        let sendTask = Task { @MainActor [weak self, channel, event, cursorRevision, priorSend] in
            await priorSend?.value
            guard !Task.isCancelled else { return }
            do {
                try await channel.send(event)
            } catch {
                if let cursorRevision {
                    self?.cursorReconciliation.markSendFailed(revision: cursorRevision)
                    self?.applyCursorConfidencePresentation()
                    self?.scheduleCursorConfirmationDeadline()
                }
                ClientDiagnostics.shared.record(
                    type: "inputSendFailed",
                    fields: ["error": String(describing: error)],
                    level: .error
                )
            }
        }
        inputSendTailTask = sendTask
    }

    private func cursorOperation(
        for input: NormalizedInput
    ) -> CursorReconciliationStateMachine.Operation? {
        switch input {
        case .cursorMove(let dx, let dy):
            return .move(CGPoint(x: CGFloat(dx), y: CGFloat(dy)))
        case .cursorSet(let displayId, let x, let y):
            guard let point = cursorSourcePos ?? cursorSourcePoint(
                displayId: displayId,
                hostX: x,
                hostY: y
            ) else { return nil }
            return .set(point)
        default:
            return nil
        }
    }

    func cursorConfirmationClock() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    func applyCursorConfidencePresentation() {
        let presentation: CursorPointerView.Presentation = cursorReconciliation.confidence == .ghost
            ? .ghost
            : .confirmed
        cursorDotView?.setPresentation(presentation)
    }

    func scheduleCursorConfirmationDeadline(now: TimeInterval? = nil) {
        cursorConfirmationTask?.cancel()
        cursorConfirmationTask = nil
        guard cursorReconciliation.confidence != .ghost,
              let deadline = cursorReconciliation.ghostDeadline else { return }
        let current = now ?? cursorConfirmationClock()
        let delay = max(0, deadline - current)
        cursorConfirmationTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
            guard let self else { return }
            let wakeTime = self.cursorConfirmationClock()
            self.cursorReconciliation.advance(now: wakeTime)
            self.applyCursorConfidencePresentation()
            self.scheduleCursorConfirmationDeadline(now: wakeTime)
        }
    }

    func sendPointerAwareInput(_ input: NormalizedInput) {
        if let retarget = PointerRetargeting.retargetInput(
            pending: &pendingCursorRetarget,
            before: input
        ) {
            cursorSourcePos = retarget.sourcePoint
            applyEdgeFollow()
            updateCursorDot()
            sendInput(.cursorSet(
                displayId: retarget.displayId,
                x: Float(retarget.hostPoint.x),
                y: Float(retarget.hostPoint.y)
            ))
        }
        if case let .cursorMove(dx, dy) = input {
            if panFollowActive || !panFollowEdgeAxes.isEmpty {
                PanFollowDiagnostics.log(
                    "delegate cursorMove dx=\(dx) dy=\(dy) panFollowActive=\(panFollowActive) edgeAxes=\(panFollowEdgeAxes.rawValue)"
                )
            }
            advanceCursorModel(dx: CGFloat(dx), dy: CGFloat(dy))
        }
        sendInput(input)
    }
}

extension PairingViewController: @preconcurrency AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.agentSayIsSpeaking = false
            self?.speakNextAgentSaySegmentIfNeeded()
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.agentSayIsSpeaking = false
        }
    }
}
