import UIKit
import AgentDeskWire

// Touch-scroll mode. Relocates the right-edge scroll strip's exact scroll
// behavior onto the video surface: a one-finger drag on the desktop image
// primes the host cursor at the touched point (.cursorSet) and then scrolls
// it, reusing GestureTranslator.processScrollPan (acceleration + momentum)
// unchanged. Design: docs/superpowers/specs/2026-07-03-touch-scroll-mode-design.md
extension PairingViewController {

    // Installs the touch-scroll pan recognizer on the video sink content view.
    // Called from showTrackpad after the sink is mounted. Idempotent: removes
    // any prior instance first so a reconnect re-attaches cleanly.
    func attachTouchScrollRecognizer() {
        guard let sinkView = videoSink?.view else { return }
        if let existing = touchScrollRecognizer {
            existing.view?.removeGestureRecognizer(existing)
        }
        // Standard pan (NOT InstantPanGestureRecognizer): it waits for a few px
        // of one-finger slop before .began. That wait is what distinguishes a
        // one-finger scroll from a pinch — a two-finger pinch lands its second
        // finger before the first crosses the slop, so maximumNumberOfTouches=1
        // fails this recognizer before it primes (no spurious .cursorSet, no
        // phantom scroll). A finger added mid-scroll cancels it, and the
        // existing .cancelled path emits scroll(phase:.ended).
        let pan = UIPanGestureRecognizer(
            target: self,
            action: #selector(handleVideoTouchScroll(_:))
        )
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        sinkView.isUserInteractionEnabled = true
        sinkView.addGestureRecognizer(pan)
        touchScrollRecognizer = pan
        applyTouchScrollMode()
    }

    @objc func handleVideoTouchScroll(_ gesture: UIPanGestureRecognizer) {
        guard let scroll = sinkScrollView else { return }
        if gesture.state == .began, let sinkView = videoSink?.view {
            // Prime from the content view's own coordinate space, which is
            // already zoom/scroll-independent.
            primeTouchScrollCursor(
                at: gesture.location(in: sinkView),
                contentViewSize: sinkView.bounds.size
            )
            // Drop any leftover viewport retarget so the scroll events that
            // follow (routed through sendPointerAwareInput) do not consume a
            // stale cursorSet and override the prime we just sent.
            pendingCursorRetarget = nil
        }
        // Reuse the strip's scroll state machine verbatim: identical
        // acceleration curve, phases, and momentum tail.
        gestureTranslator.processScrollPan(
            state: gesture.state,
            translation: gesture.translation(in: scroll),
            velocity: gesture.velocity(in: scroll)
        )
    }

    // Map the touch point to a host coordinate and move the host cursor there
    // so the scroll lands on the window under the finger. `loc` is in the
    // content view's own coordinate space; swallows the touch when geometry is
    // unavailable (no DesktopState / zero display bounds).
    private func primeTouchScrollCursor(at loc: CGPoint, contentViewSize: CGSize) {
        let displayId = activeDisplayIdMirror
            ?? lastDesktopState?.selectedDisplayId
            ?? lastDesktopState?.activeDisplayId
        guard let retarget = PointerRetargeting.hostPoint(
            forContentViewLocation: loc,
            state: lastDesktopState,
            displayId: displayId,
            displayBounds: activeDisplayRect,
            contentViewSize: contentViewSize
        ) else { return }
        // Move the local cursor model + overlay dot to the touched point so the
        // priming is visible, matching the pointer-retarget branch's behavior.
        cursorSourcePos = retarget.sourcePoint
        updateCursorDot()
        sendInput(.cursorSet(
            displayId: retarget.displayId,
            x: Float(retarget.hostPoint.x),
            y: Float(retarget.hostPoint.y)
        ))
    }

    // Applies the current touch-scroll mode: gate the recognizer, disable the
    // scroll view's own pan so it does not fight ours when zoomed, and dim the
    // relative controls so nothing double-drives input. Idempotent; called on
    // attach, on entering the session, and on every settings change.
    func applyTouchScrollMode() {
        let on = SettingsStore.shared.touchScrollMode
        let config = touchScrollGestureConfig(touchScrollMode: on)
        touchScrollRecognizer?.isEnabled = config.touchScrollRecognizerEnabled
        if let scroll = sinkScrollView {
            // Keep the scroll view zoom-capable at all times (isScrollEnabled =
            // false would also kill pinch). Route by finger count instead:
            // minimumNumberOfTouches = 2 means one finger never pans the local
            // view, so the touch-scroll recognizer owns single-finger drags and
            // two fingers drive native pinch + pan-while-pinched.
            scroll.isScrollEnabled = config.scrollViewScrollEnabled
            scroll.panGestureRecognizer.minimumNumberOfTouches = config.scrollViewPanMinimumTouches
        }
        for control in [trackpadView, scrollStripView] {
            control.alpha = on ? 0.4 : 1.0
            control.isUserInteractionEnabled = !on
        }
        updateTouchScrollButtonAppearance()
    }

    private func updateTouchScrollButtonAppearance() {
        let on = SettingsStore.shared.touchScrollMode
        touchScrollToggleButton.isSelected = on
        touchScrollToggleButton.backgroundColor = on
            ? UIColor.systemBlue.withAlphaComponent(0.25)
            : .secondarySystemBackground
    }

    @objc func touchScrollToggleTapped() {
        SettingsStore.shared.touchScrollMode.toggle()
        // postChange() also drives settingsChanged -> applyTouchScrollMode, but
        // apply immediately too so the button feels instant.
        applyTouchScrollMode()
    }
}
