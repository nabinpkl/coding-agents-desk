import UIKit
import AgentDeskWire

final class TouchScrollControl: UIControl {
    var layoutMode: TouchScrollLayoutMode = .asIs {
        didSet { updateAppearance() }
    }

    var touchScrollEnabled: Bool = false {
        didSet { updateAppearance() }
    }

    private let fullButton = UIButton(type: .system)
    private let asIsButton = UIButton(type: .system)
    private let label = UILabel()
    private let enabledSwitch = UISwitch()

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 52)
    }

    private func configure() {
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 8
        layer.borderColor = UIColor.separator.cgColor
        layer.borderWidth = 0.5
        clipsToBounds = true

        let divider = UIView()
        divider.backgroundColor = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false

        for button in [fullButton, asIsButton] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
            button.tintColor = .label
            button.translatesAutoresizingMaskIntoConstraints = false
        }
        fullButton.setTitle("Full", for: .normal)
        asIsButton.setTitle("As Is", for: .normal)
        fullButton.addTarget(self, action: #selector(fullTapped), for: .touchUpInside)
        asIsButton.addTarget(self, action: #selector(asIsTapped), for: .touchUpInside)

        let choiceRow = UIStackView(arrangedSubviews: [fullButton, divider, asIsButton])
        choiceRow.axis = .horizontal
        choiceRow.alignment = .fill
        choiceRow.distribution = .fill
        choiceRow.spacing = 0
        choiceRow.translatesAutoresizingMaskIntoConstraints = false

        label.text = "Touch scroll"
        label.font = .preferredFont(forTextStyle: .caption2)
        label.textColor = .secondaryLabel
        label.textAlignment = .left
        label.translatesAutoresizingMaskIntoConstraints = false

        enabledSwitch.transform = CGAffineTransform(scaleX: 0.68, y: 0.68)
        enabledSwitch.addTarget(self, action: #selector(enabledChanged), for: .valueChanged)
        enabledSwitch.translatesAutoresizingMaskIntoConstraints = false

        let switchRow = UIStackView(arrangedSubviews: [label, enabledSwitch])
        switchRow.axis = .horizontal
        switchRow.alignment = .center
        switchRow.distribution = .fill
        switchRow.spacing = 4
        switchRow.translatesAutoresizingMaskIntoConstraints = false

        let stack = UIStackView(arrangedSubviews: [choiceRow, switchRow])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
            divider.widthAnchor.constraint(equalToConstant: 1),
            fullButton.widthAnchor.constraint(equalTo: asIsButton.widthAnchor),
            choiceRow.heightAnchor.constraint(equalToConstant: 24),
            switchRow.heightAnchor.constraint(equalToConstant: 24)
        ])
        updateAppearance()
    }

    @objc private func fullTapped() {
        layoutMode = .full
        sendActions(for: .valueChanged)
    }

    @objc private func asIsTapped() {
        layoutMode = .asIs
        sendActions(for: .valueChanged)
    }

    @objc private func enabledChanged() {
        touchScrollEnabled = enabledSwitch.isOn
        sendActions(for: .valueChanged)
    }

    private func updateAppearance() {
        style(fullButton, selected: layoutMode == .full)
        style(asIsButton, selected: layoutMode == .asIs)
        if enabledSwitch.isOn != touchScrollEnabled {
            enabledSwitch.setOn(touchScrollEnabled, animated: false)
        }
    }

    private func style(_ button: UIButton, selected: Bool) {
        button.backgroundColor = selected ? UIColor.systemBlue.withAlphaComponent(0.25) : .clear
        button.setTitleColor(selected ? .systemBlue : .label, for: .normal)
    }
}

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
        applyTouchScrollState()
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

    // Applies the current touch-scroll state: gate the recognizer and route the
    // scroll view's own pan so it does not fight ours when touch-scroll input
    // is enabled. Full layout independently hides the relative controls.
    // Idempotent; called on attach, on entering the session, and on every
    // settings change.
    func applyTouchScrollState() {
        let enabled = SettingsStore.shared.touchScrollEnabled
        let layoutMode = SettingsStore.shared.touchScrollLayoutMode
        let config = touchScrollGestureConfig(
            touchScrollEnabled: enabled,
            layoutMode: layoutMode
        )
        touchScrollRecognizer?.isEnabled = config.touchScrollRecognizerEnabled
        if let scroll = sinkScrollView {
            // Keep the scroll view zoom-capable at all times (isScrollEnabled =
            // false would also kill pinch). Route by finger count instead:
            // when touch scroll is enabled, minimumNumberOfTouches = 2 means
            // one finger never pans the local view, so the touch-scroll
            // recognizer owns single-finger drags and two fingers drive native
            // pinch + pan-while-pinched.
            scroll.isScrollEnabled = config.scrollViewScrollEnabled
            scroll.panGestureRecognizer.minimumNumberOfTouches = config.scrollViewPanMinimumTouches
        }
        touchScrollControl.layoutMode = layoutMode
        touchScrollControl.touchScrollEnabled = enabled
        let controlSurfaceActive = isControlSurfaceActive()
        let relativeControlsHidden = !controlSurfaceActive || config.relativeControlsHidden
        for control in [trackpadView, scrollStripView] {
            control.alpha = CGFloat(config.relativeControlsAlpha)
            control.isUserInteractionEnabled = config.relativeControlsInteractionEnabled
            control.isHidden = relativeControlsHidden
        }
        trackpadHint.isHidden = relativeControlsHidden
        scrollStripHint.isHidden = relativeControlsHidden
        applyOrientationConstraints(forLandscape: view.bounds.width > view.bounds.height)
        refreshThumbnailStripVisibility()
    }

    func isControlSurfaceActive() -> Bool {
        guard let seg = surfaceSegmentedControl else { return true }
        return seg.titleForSegment(at: seg.selectedSegmentIndex) == "Control"
    }

    @objc func touchScrollControlChanged(_ control: TouchScrollControl) {
        SettingsStore.shared.setTouchScroll(
            layoutMode: control.layoutMode,
            enabled: control.touchScrollEnabled
        )
        // postChange() also drives settingsChanged -> applyTouchScrollState, but
        // apply immediately too so the control feels instant.
        applyTouchScrollState()
    }
}
