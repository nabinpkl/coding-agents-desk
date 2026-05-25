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
        guard let channel = pairingClient.activeInputChannel else { return }
        thumbnailsTask = Task { [weak self, channel] in
            for await thumbnails in channel.thumbnailsUpdates {
                await MainActor.run {
                    self?.thumbnailStripView.apply(thumbnails: thumbnails)
                    self?.refreshThumbnailStripVisibility()
                }
            }
        }
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

    // MARK: - ThumbnailStripViewDelegate

    // R20: a tap on a non-active tile emits one step-direction swipe
    // per signed index delta. The host's dock-swipe synthesis already
    // commits one Space per Began-Changed-Ended cycle; we chain
    // |delta| of them.
    //
    // The chain MUST run inside a single Task. Previously each frame
    // went through sendInput, which wraps the channel write in its own
    // detached Task; for |delta|>=2 the six resulting tasks raced
    // through Swift's cooperative scheduler and arrived at the host in
    // arbitrary order. Dock's gesture synthesis is strictly began ->
    // changed -> ended; scrambled frames produced "tap Desktop 4 from
    // Desktop 2, land on Desktop 3 (or somewhere else entirely)".
    //
    // Sign convention mirrors the strip's swipe path
    // (scrollViewWillEndDragging emits rawProgress=-1 for a right-
    // neighbour step, then emitSwipeFrame inverts under the default
    // direction toggle). Tap-to-jump now honors useMacOSDirection too,
    // so tap and swipe stay in agreement under either setting.
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int) {
        guard delta != 0 else { return }
        guard let channel = pairingClient.activeInputChannel else { return }
        let steps = abs(delta)
        let rawForEmit: Float = delta > 0 ? -1.0 : 1.0
        let wireSign: Float = view.useMacOSDirection ? rawForEmit : -rawForEmit
        let changedProgress = wireSign * 0.5
        let endedProgress = wireSign
        let changedVelocity = wireSign * 1500
        let endedVelocity = wireSign * 2000
        Task { [channel, steps, changedProgress, endedProgress, changedVelocity, endedVelocity] in
            for i in 0..<steps {
                try? await channel.send(.switchSpaceGesture(phase: .began, progress: 0, velocityX: 0))
                try? await channel.send(.switchSpaceGesture(phase: .changed, progress: changedProgress, velocityX: changedVelocity))
                try? await channel.send(.switchSpaceGesture(phase: .ended, progress: endedProgress, velocityX: endedVelocity))
                // Pace cycles so Dock can animate the prior commit
                // before the next .began opens a fresh gesture. Without
                // this gap the second cycle arrives mid-animation and
                // Dock either merges the two into one Space transition
                // or drops the second outright. 200ms matches the feel
                // of a deliberate trackpad swipe chain. Skip after the
                // last cycle so we don't tail-pad the chain.
                if i < steps - 1 {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
            }
        }
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
