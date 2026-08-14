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
    private let pointerButton = UIButton(type: .system)
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

        for button in [fullButton, asIsButton, pointerButton, touchButton, autoKeyButton] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
            button.tintColor = .label
            button.translatesAutoresizingMaskIntoConstraints = false
        }
        fullButton.setTitle("Full", for: .normal)
        asIsButton.setTitle("As Is", for: .normal)
        pointerButton.setTitle("Pointer", for: .normal)
        touchButton.setTitle("Touch", for: .normal)
        autoKeyButton.setTitle("Auto Key", for: .normal)
        fullButton.addTarget(self, action: #selector(fullTapped), for: .touchUpInside)
        asIsButton.addTarget(self, action: #selector(asIsTapped), for: .touchUpInside)
        pointerButton.addTarget(self, action: #selector(pointerTapped), for: .touchUpInside)
        touchButton.addTarget(self, action: #selector(touchTapped), for: .touchUpInside)
        autoKeyButton.addTarget(self, action: #selector(autoKeyTapped), for: .touchUpInside)

        let topDivider = makeDivider()
        let topDivider2 = makeDivider()
        let bottomDivider = makeDivider()
        let rowDivider = makeDivider()
        let topRow = makeRow([fullButton, topDivider, asIsButton, topDivider2, pointerButton])
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
            topDivider2.widthAnchor.constraint(equalToConstant: 1),
            bottomDivider.widthAnchor.constraint(equalToConstant: 1),
            rowDivider.heightAnchor.constraint(equalToConstant: 1),
            fullButton.widthAnchor.constraint(equalTo: asIsButton.widthAnchor),
            asIsButton.widthAnchor.constraint(equalTo: pointerButton.widthAnchor),
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

    @objc private func pointerTapped() {
        guard layoutMode != .pointer else { return }
        layoutMode = .pointer
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
        style(pointerButton, selected: layoutMode == .pointer)
        // Pointer mode already binds every gesture Touch mode would, so the switch has
        // nothing left to say. Shown as unavailable rather than silently ignored: a control
        // that responds to a tap and changes nothing is worse than one that does not respond.
        let touchApplies = layoutMode != .pointer
        touchButton.isEnabled = touchApplies
        touchButton.alpha = touchApplies ? 1.0 : 0.4
        style(touchButton, selected: touchApplies && videoTouchEnabled)
        style(autoKeyButton, selected: autoKeyboardEnabled)
    }

    private func style(_ button: UIButton, selected: Bool) {
        button.backgroundColor = selected ? UIColor.systemBlue.withAlphaComponent(0.25) : .clear
        button.setTitleColor(selected ? .systemBlue : .label, for: .normal)
    }
}

// What one finger on the desktop image does, which is the difference between the three modes.
//
// - As Is / Full with Touch off: nothing remote. The local viewport pans, as a zoomed picture
//   does anywhere else.
// - As Is / Full with Touch on: a tap retargets the host cursor and clicks; a drag reuses the
//   right-edge scroll strip's exact scroll behavior after priming the cursor at the touch
//   point. The finger IS the pointer, so absolute.
// - Pointer: a drag moves the pointer by the finger's travel and the picture holds still; a
//   tap clicks wherever the pointer was steered to, with no retarget at all. The picture
//   moves only when the pointer reaches the edge of it, which is ADR-0009 edge follow
//   reacting to the same `cursorMove` frames the trackpad has always sent. Relative, so a tap
//   must NOT resolve the touch point -- see `handleVideoTouchTap`.
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
        if let existing = videoTwoFingerScrollRecognizer {
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

        // Pointer mode's scroll surface. One finger is the pointer there and the local
        // viewport pan is off, so this is the only pan left on two fingers -- it contends
        // with the scroll view's pinch, and deliberately does not recognize alongside it:
        // a drag that also zoomed, or a pinch that also scrolled the Mac, is worse than
        // having to lift and start again. Fingers held apart at a steady distance read as a
        // drag; fingers changing distance read as a pinch.
        let twoFingerScroll = UIPanGestureRecognizer(
            target: self,
            action: #selector(handleVideoTwoFingerScroll(_:))
        )
        twoFingerScroll.minimumNumberOfTouches = 2
        twoFingerScroll.maximumNumberOfTouches = 2

        sinkView.isUserInteractionEnabled = true
        sinkView.addGestureRecognizer(pan)
        sinkView.addGestureRecognizer(tap)
        sinkView.addGestureRecognizer(twoFingerScroll)
        videoTouchScrollRecognizer = pan
        videoTouchTapRecognizer = tap
        videoTwoFingerScrollRecognizer = twoFingerScroll
        applyVideoTouchState()
    }

    // One finger on the video. Which of the three things it means is the mode's decision, made
    // once in `videoTouchGestureConfig` rather than re-derived from settings on every frame of
    // a 120Hz drag.
    @objc func handleVideoTouchScroll(_ gesture: UIPanGestureRecognizer) {
        switch videoGestureConfig?.oneFingerPanBinding ?? .none {
        case .none:
            return
        case .pointerMove:
            handleVideoPointerPan(gesture)
        case .remoteScroll:
            handleVideoRemoteScrollPan(gesture)
        }
    }

    // Pointer mode. Each `.changed` reports travel since the last one, because the recognizer's
    // translation is zeroed every time -- a pointer is moved by increments, where a scroll is
    // driven by a cumulative offset. Everything downstream is already built: the frame goes
    // through `sendPointerAwareInput`, which advances the local cursor model and calls
    // `applyEdgeFollow`, which pans the picture when the pointer nears the edge (ADR-0009).
    private func handleVideoPointerPan(_ gesture: UIPanGestureRecognizer) {
        guard let scroll = sinkScrollView else { return }
        switch gesture.state {
        case .began:
            // Whatever slop the recognizer needed before it fired is not pointer travel.
            gesture.setTranslation(.zero, in: scroll)
        case .changed:
            let fingerDelta = gesture.translation(in: scroll)
            gesture.setTranslation(.zero, in: scroll)
            guard let hostDelta = VideoPointerPan.hostDelta(
                fingerDelta: fingerDelta,
                videoSize: sinkVideoSize,
                displayBounds: activeDisplayRect,
                zoomScale: scroll.zoomScale
            ), hostDelta != .zero else { return }
            sendPointerAwareInput(
                .cursorMove(dx: Float(hostDelta.x), dy: Float(hostDelta.y))
            )
        default:
            break
        }
    }

    // Pointer mode's two-finger scroll. Same state machine as the right-edge strip, which is
    // where this job lives in the other modes -- it cannot live there here, because edge
    // follow needs the pointer driven into the right edge and the strip sits on it.
    @objc func handleVideoTwoFingerScroll(_ gesture: UIPanGestureRecognizer) {
        guard let scroll = sinkScrollView else { return }
        gestureTranslator.processScrollPan(
            state: gesture.state,
            translation: gesture.translation(in: scroll),
            velocity: gesture.velocity(in: scroll)
        )
    }

    private func handleVideoRemoteScrollPan(_ gesture: UIPanGestureRecognizer) {
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
        let retargetsCursor = videoGestureConfig?.tapRetargetsCursor ?? true
        // Pointer mode clicks where the pointer is. Resolving the touch point first would
        // move it there, undoing whatever the last drag steered it to -- and the pointer is
        // drawn on screen, so the user would watch it happen.
        let retarget = retargetsCursor
            ? retargetVideoTouchCursor(
                at: gesture.location(in: sinkView),
                contentViewSize: sinkView.bounds.size
            )
            : nil
        pendingCursorRetarget = nil
        let inputs = videoTouchTapInputs(for: retarget, retargetsCursor: retargetsCursor)
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

    // Applies the current mode: gate the recognizers and route the scroll
    // view's own pan so it does not fight ours when the video is an input
    // surface. Full-bleed layout (Full or Pointer) and shown keyboard state
    // independently hide the relative controls. Typing also collapses the
    // bottom control row so the text echo sits next to the keyboard instead
    // of above an empty fixed-height slot.
    // Idempotent; called on attach, on entering the session, and on every
    // settings or keyboard-presentation change.
    func applyVideoTouchState() {
        let enabled = SettingsStore.shared.videoTouchEnabled
        let layoutMode = SettingsStore.shared.videoLayoutMode
        let config = videoTouchGestureConfig(
            videoTouchEnabled: enabled,
            layoutMode: layoutMode,
            keyboardIsShown: keyboardPresentationState == .shown
        )
        // Held so the per-frame handlers read a decision instead of re-deriving one from
        // UserDefaults on every `.changed`.
        videoGestureConfig = config
        videoTouchTapRecognizer?.isEnabled = config.videoTouchTapRecognizerEnabled
        videoTouchScrollRecognizer?.isEnabled = config.oneFingerPanBinding != .none
        videoTwoFingerScrollRecognizer?.isEnabled = config.twoFingerRemoteScrollEnabled
        videoDoubleTapZoomRecognizer?.isEnabled = config.doubleTapZoomRecognizerEnabled
        if let scroll = sinkScrollView {
            // Keep the scroll view zoom-capable at all times (isScrollEnabled =
            // false would also kill pinch). Route by finger count instead:
            // when Touch mode is enabled, minimumNumberOfTouches = 2 means
            // one finger never pans the local view, so the video touch
            // recognizer owns single-finger drags and two fingers drive native
            // pinch + pan-while-pinched.
            //
            // Pointer mode goes further and disables the pan recognizer outright, because
            // there the picture must not move under the finger at any finger count. Disabling
            // the recognizer rather than `isScrollEnabled` is what keeps pinch alive, and
            // `applyEdgeFollow` still moves the picture through `setContentOffset`, which is
            // programmatic and does not go through the pan at all.
            scroll.isScrollEnabled = config.scrollViewScrollEnabled
            scroll.panGestureRecognizer.isEnabled = config.scrollViewPanEnabled
            scroll.panGestureRecognizer.minimumNumberOfTouches = config.scrollViewPanMinimumTouches
        }
        remoteInputModeControl.layoutMode = layoutMode
        remoteInputModeControl.videoTouchEnabled = enabled
        remoteInputModeControl.autoKeyboardEnabled = SettingsStore.shared.autoKeyboardEnabled
        let controlSurfaceIsActive = isControlSurfaceActive()
        let relativeControlsHidden = !controlSurfaceIsActive || config.relativeControlsHidden
        for control in [trackpadView, scrollStripView] {
            control.alpha = CGFloat(config.relativeControlsAlpha)
            control.isUserInteractionEnabled = config.relativeControlsInteractionEnabled
            control.isHidden = relativeControlsHidden
        }
        trackpadHint.isHidden = relativeControlsHidden
        scrollStripHint.isHidden = relativeControlsHidden
        let controlRowPresentation = KeyboardControlRowPresentation.resolve(
            keyboardIsShown: keyboardPresentationState == .shown,
            controlSurfaceIsActive: controlSurfaceIsActive
        )
        buttonRow.isHidden = controlRowPresentation.isHidden
        buttonRowHeightConstraint?.constant = controlRowPresentation.height
        applyOrientationConstraints(forLandscape: view.bounds.width > view.bounds.height)
        refreshThumbnailStripVisibility()
    }

    func isControlSurfaceActive() -> Bool {
        // Use the authoritative selected surface, kept in sync by the control rail. Deriving this
        // state from button presentation would couple video input to the rail's current icon and
        // accessibility treatment.
        activeControlSurface == .control
    }

    @objc func remoteInputModeControlChanged(_ control: RemoteInputModeControl) {
        SettingsStore.shared.setRemoteInputModes(
            layoutMode: control.layoutMode,
            videoTouchEnabled: control.videoTouchEnabled,
            autoKeyboardEnabled: control.autoKeyboardEnabled
        )
    }
}
