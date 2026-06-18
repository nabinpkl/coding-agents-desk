import AVFoundation
import UIKit

// Forwarding seam between the in-app gesture surfaces (trackpad,
// scroll strip, Spaces band) and the input-channel wire. Owns the
// GestureTranslator and ThumbnailStripView delegate methods, the
// settings-changed responder, and the two background Tasks that drain
// DesktopState / Thumbnails from the input channel into the views.

extension PairingViewController: GestureTranslatorDelegate, ThumbnailStripViewDelegate {
    @objc func settingsChanged() {
        applySettingsToTranslator()
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
        refreshInputSurfaceMode()
    }

    func refreshInputSurfaceMode() {
        let screenActive = SettingsStore.shared.inputSurfaceMode == .screenTrackpad
        let blockedByKeyboard = keyboardSurface.isFirstResponder
        screenTrackpadOverlay.isHidden = !screenActive || blockedByKeyboard
        screenTrackpadOverlay.isUserInteractionEnabled = screenActive && !blockedByKeyboard
        sinkDoubleTapRecognizer?.isEnabled = !screenActive
    }

    // R11: drains the InputChannel's host-pushed DesktopState frames
    // into the dots band. Restarted on each showTrackpad because
    // activeInputChannel may have been replaced by a reconnect during
    // foreground (D13.1 + D13.2 lifecycle).
    func startDesktopStateObservation() {
        desktopStateTask?.cancel()
        guard let channel = pairingClient.activeInputChannel else { return }
        thumbnailStripView.renderEmpty()
        desktopStateTask = Task { [weak self, channel] in
            for await state in channel.desktopStateUpdates {
                await MainActor.run {
                    self?.lastDesktopState = state
                    self?.thumbnailStripView.apply(state: state)
                    self?.refreshThumbnailStripVisibility()
                    self?.applyDesktopStateForCursorModel(state)
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
        guard let channel = pairingClient.activeInputChannel else { return }
        cursorTask = Task { [weak self, channel] in
            for await push in channel.cursorUpdates {
                await MainActor.run {
                    self?.applyCursorImage(push)
                }
            }
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
        view.bringSubviewToFront(agentSayBanner)
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
        thumbnailStripView.isHidden = thumbnailStripView.userSpaceCount <= 1
    }

    // ADR-0006: send the current client-config on input-channel open
    // and on every settings toggle change. The host is the source of
    // truth on capture state; this is the only path that turns it on
    // or off.
    func sendCurrentClientConfig() {
        guard let channel = pairingClient.activeInputChannel else { return }
        let config = ClientConfig(thumbnailsEnabled: SettingsStore.shared.showSpacePreviews)
        Task { [channel, config] in
            try? await channel.sendConfig(config)
        }
    }

    // MARK: - GestureTranslatorDelegate

    func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput) {
        if case let .cursorMove(dx, dy) = input {
            advanceCursorModel(dx: CGFloat(dx), dy: CGFloat(dy))
        }
        sendInput(input)
    }

    // Touch-down on the scroll strip (active=true) primes media before
    // motion; settle (active=false) lets it restore.
    func gestureTranslator(_ translator: GestureTranslator, scrollInteractionActive active: Bool) {
        if let dualSink = videoSink as? DualPlaneVideoSink {
            dualSink.setMotionActive(active)
        } else if let ownedSink = videoSink as? any OwnedMediaFrameSink {
            ownedSink.setMotionActive(active)
        }
        sendInteractionHint(InteractionHint(kind: "scroll", active: active))
    }

    func sendInteractionHint(_ hint: InteractionHint) {
        guard let channel = pairingClient.activeInputChannel else { return }
        Task { [channel, hint] in
            try? await channel.sendInteractionHint(hint)
        }
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
        let config = ClientConfig(
            thumbnailsEnabled: SettingsStore.shared.showSpacePreviews,
            thumbnailRefresh: spaceId
        )
        Task { [channel, config] in
            try? await channel.sendConfig(config)
        }
    }

    // ADR-0005: input rides its own WebSocket Secure channel,
    // independent of the WebRTC video PC. The channel send is async;
    // fire-and-forget into a detached Task so the trackpad / keyboard
    // caller stays synchronous and main-thread.
    func sendInput(_ input: NormalizedInput) {
        guard let channel = pairingClient.activeInputChannel else { return }
        Task { [channel, input] in
            try? await channel.send(input)
        }
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
