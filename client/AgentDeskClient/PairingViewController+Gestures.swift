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
