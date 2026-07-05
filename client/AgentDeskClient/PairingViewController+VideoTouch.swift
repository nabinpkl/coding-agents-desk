import UIKit
import AgentDeskWire

final class RemoteInputModeControl: UIControl {
    var layoutMode: VideoLayoutMode = .asIs {
        didSet { updateAppearance() }
    }

    var videoTouchEnabled: Bool = false {
        didSet { updateAppearance() }
    }

    var autoKeyboardEnabled: Bool = true {
        didSet { updateAppearance() }
    }

    private let fullButton = UIButton(type: .system)
    private let asIsButton = UIButton(type: .system)
    private let touchButton = UIButton(type: .system)
    private let autoKeyButton = UIButton(type: .system)

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

        for button in [fullButton, asIsButton, touchButton, autoKeyButton] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
            button.tintColor = .label
            button.translatesAutoresizingMaskIntoConstraints = false
        }
        fullButton.setTitle("Full", for: .normal)
        asIsButton.setTitle("As Is", for: .normal)
        touchButton.setTitle("Touch", for: .normal)
        autoKeyButton.setTitle("Auto Key", for: .normal)
        fullButton.addTarget(self, action: #selector(fullTapped), for: .touchUpInside)
        asIsButton.addTarget(self, action: #selector(asIsTapped), for: .touchUpInside)
        touchButton.addTarget(self, action: #selector(touchTapped), for: .touchUpInside)
        autoKeyButton.addTarget(self, action: #selector(autoKeyTapped), for: .touchUpInside)

        let topDivider = makeDivider()
        let bottomDivider = makeDivider()
        let rowDivider = makeDivider()
        let topRow = makeRow([fullButton, topDivider, asIsButton])
        let bottomRow = makeRow([touchButton, bottomDivider, autoKeyButton])

        let stack = UIStackView(arrangedSubviews: [topRow, rowDivider, bottomRow])
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
            topDivider.widthAnchor.constraint(equalToConstant: 1),
            bottomDivider.widthAnchor.constraint(equalToConstant: 1),
            rowDivider.heightAnchor.constraint(equalToConstant: 1),
            fullButton.widthAnchor.constraint(equalTo: asIsButton.widthAnchor),
            touchButton.widthAnchor.constraint(equalTo: autoKeyButton.widthAnchor),
            topRow.heightAnchor.constraint(equalToConstant: 24),
            bottomRow.heightAnchor.constraint(equalToConstant: 24)
        ])
        updateAppearance()
    }

    private func makeRow(_ views: [UIView]) -> UIStackView {
        let row = UIStackView(arrangedSubviews: views)
        row.axis = .horizontal
        row.alignment = .fill
        row.distribution = .fill
        row.spacing = 0
        row.translatesAutoresizingMaskIntoConstraints = false
        return row
    }

    private func makeDivider() -> UIView {
        let divider = UIView()
        divider.backgroundColor = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        return divider
    }

    @objc private func fullTapped() {
        guard layoutMode != .full else { return }
        layoutMode = .full
        sendActions(for: .valueChanged)
    }

    @objc private func asIsTapped() {
        guard layoutMode != .asIs else { return }
        layoutMode = .asIs
        sendActions(for: .valueChanged)
    }

    @objc private func touchTapped() {
        videoTouchEnabled.toggle()
        sendActions(for: .valueChanged)
    }

    @objc private func autoKeyTapped() {
        autoKeyboardEnabled.toggle()
        sendActions(for: .valueChanged)
    }

    private func updateAppearance() {
        style(fullButton, selected: layoutMode == .full)
        style(asIsButton, selected: layoutMode == .asIs)
        style(touchButton, selected: videoTouchEnabled)
        style(autoKeyButton, selected: autoKeyboardEnabled)
    }

    private func style(_ button: UIButton, selected: Bool) {
        button.backgroundColor = selected ? UIColor.systemBlue.withAlphaComponent(0.25) : .clear
        button.setTitleColor(selected ? .systemBlue : .label, for: .normal)
    }
}

// Touch mode. A tap on the desktop image retargets the host cursor and clicks;
// a one-finger drag reuses the right-edge scroll strip's exact scroll behavior
// after priming the host cursor at the touched point.
extension PairingViewController {

    // Installs Touch mode recognizers on the video sink content view. Called
    // from showTrackpad after the sink is mounted. Idempotent: removes any
    // prior instances first so a reconnect re-attaches cleanly.
    func attachVideoTouchRecognizers() {
        guard let sinkView = videoSink?.view else { return }
        if let existing = videoTouchScrollRecognizer {
            existing.view?.removeGestureRecognizer(existing)
        }
        if let existing = videoTouchTapRecognizer {
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

        let tap = UITapGestureRecognizer(
            target: self,
            action: #selector(handleVideoTouchTap(_:))
        )
        tap.numberOfTouchesRequired = 1
        tap.numberOfTapsRequired = 1
        tap.delaysTouchesBegan = false
        tap.delaysTouchesEnded = false
        if let dismissKeyboardTap {
            tap.require(toFail: dismissKeyboardTap)
        }
        if let doubleTap = videoDoubleTapZoomRecognizer {
            tap.require(toFail: doubleTap)
        }

        sinkView.isUserInteractionEnabled = true
        sinkView.addGestureRecognizer(pan)
        sinkView.addGestureRecognizer(tap)
        videoTouchScrollRecognizer = pan
        videoTouchTapRecognizer = tap
        applyVideoTouchState()
    }

    @objc func handleVideoTouchScroll(_ gesture: UIPanGestureRecognizer) {
        guard let scroll = sinkScrollView else { return }
        if gesture.state == .began, let sinkView = videoSink?.view {
            // Prime from the content view's own coordinate space, which is
            // already zoom/scroll-independent.
            if let retarget = retargetVideoTouchCursor(
                at: gesture.location(in: sinkView),
                contentViewSize: sinkView.bounds.size
            ) {
                sendInput(.cursorSet(
                    displayId: retarget.displayId,
                    x: Float(retarget.hostPoint.x),
                    y: Float(retarget.hostPoint.y)
                ))
            }
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

    @objc func handleVideoTouchTap(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended, let sinkView = videoSink?.view else { return }
        let tapLocation = gesture.location(in: sinkView)
        let retarget = retargetVideoTouchCursor(
            at: tapLocation,
            contentViewSize: sinkView.bounds.size
        )
        pendingCursorRetarget = nil
        let inputs = videoTouchTapInputs(for: retarget)
        for input in inputs {
            sendInput(input)
        }
    }

    // Map the touch point to a host coordinate and move the local cursor model
    // there so tap and scroll both land on the window under the finger. `loc`
    // is in the content view's own coordinate space; returns nil when geometry
    // is unavailable (no DesktopState / zero display bounds).
    private func retargetVideoTouchCursor(at loc: CGPoint, contentViewSize: CGSize) -> CursorViewportRetarget? {
        let displayId = activeDisplayIdMirror
            ?? lastDesktopState?.selectedDisplayId
            ?? lastDesktopState?.activeDisplayId
        guard let retarget = PointerRetargeting.hostPoint(
            forContentViewLocation: loc,
            state: lastDesktopState,
            displayId: displayId,
            displayBounds: activeDisplayRect,
            contentViewSize: contentViewSize
        ) else { return nil }
        // Move the local cursor model + overlay dot to the touched point so the
        // priming is visible, matching the pointer-retarget branch's behavior.
        cursorSourcePos = retarget.sourcePoint
        updateCursorDot()
        return retarget
    }

    // Applies the current Touch mode state: gate the recognizers and route the
    // scroll view's own pan so it does not fight ours when video touch input
    // is enabled. Full layout independently hides the relative controls.
    // Idempotent; called on attach, on entering the session, and on every
    // settings change.
    func applyVideoTouchState() {
        let enabled = SettingsStore.shared.videoTouchEnabled
        let layoutMode = SettingsStore.shared.videoLayoutMode
        let config = videoTouchGestureConfig(
            videoTouchEnabled: enabled,
            layoutMode: layoutMode
        )
        videoTouchTapRecognizer?.isEnabled = config.videoTouchTapRecognizerEnabled
        videoTouchScrollRecognizer?.isEnabled = config.videoTouchScrollRecognizerEnabled
        videoDoubleTapZoomRecognizer?.isEnabled = config.doubleTapZoomRecognizerEnabled
        if let scroll = sinkScrollView {
            // Keep the scroll view zoom-capable at all times (isScrollEnabled =
            // false would also kill pinch). Route by finger count instead:
            // when Touch mode is enabled, minimumNumberOfTouches = 2 means
            // one finger never pans the local view, so the video touch
            // recognizer owns single-finger drags and two fingers drive native
            // pinch + pan-while-pinched.
            scroll.isScrollEnabled = config.scrollViewScrollEnabled
            scroll.panGestureRecognizer.minimumNumberOfTouches = config.scrollViewPanMinimumTouches
        }
        remoteInputModeControl.layoutMode = layoutMode
        remoteInputModeControl.videoTouchEnabled = enabled
        remoteInputModeControl.autoKeyboardEnabled = SettingsStore.shared.autoKeyboardEnabled
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

    @objc func remoteInputModeControlChanged(_ control: RemoteInputModeControl) {
        SettingsStore.shared.setRemoteInputModes(
            layoutMode: control.layoutMode,
            videoTouchEnabled: control.videoTouchEnabled,
            autoKeyboardEnabled: control.autoKeyboardEnabled
        )
    }
}
