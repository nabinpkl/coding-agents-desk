import AVFoundation
import UIKit

final class PairingViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate, GestureTranslatorDelegate, KeyboardSurfaceDelegate, SpacesDotsViewDelegate, ThumbnailStripViewDelegate, UIGestureRecognizerDelegate, UIScrollViewDelegate {
    private let pairingClient = PairingClient()
    private let statusLabel = UILabel()
    private let actionButton = UIButton(type: .system)
    private let forgetButton = UIButton(type: .system)
    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var handshakeTask: Task<Void, Never>?
    private var sessionTask: Task<Void, Never>?
    private let mediaFactory: MediaTransportFactory = MediaStack.makeFactory()
    private var mediaTransport: MediaTransport?
    private var videoSink: VideoFrameSink?
    // R21: pinch-zoom container around the WebRTC sink. Local-only zoom
    // (no host-side sourceRect crop); see ADR notes in TASKS.md. Held
    // weakly past mount so teardownMediaTransport can clean it up.
    private var sinkScrollView: UIScrollView?
    // Cap chosen at 4x. Pixels are visibly soft past ~2x in local-only
    // mode; with ADR-0007 host-side crop active, effective sharpness
    // is local x crop, so 4x local + 2x crop = 8x effective at high
    // density.
    private static let sinkMaxZoomScale: CGFloat = 4.0
    private static let sinkDoubleTapZoomScale: CGFloat = 2.0
    // ADR-0007: send a viewport crop only when the user has finally
    // settled above this zoom level. Lower threshold causes pointless
    // keyframe storms when the user pinches and releases at ~1.05x.
    private static let viewportZoomTrigger: CGFloat = 1.5
    // Mirror of the last viewport rect we sent to the host. nil = host
    // is at full display. Used to (a) decide whether active prefill
    // fires on the next pinch start, (b) re-send on session reconnect.
    private var currentRemoteViewport: ViewportRect?
    private var mediaStateTask: Task<Void, Never>?
    private var iceGraceTask: Task<Void, Never>?
    // R11: observes the input channel's desktopStateUpdates stream and
    // pushes each DesktopState into the dots band. Lifecycle matches
    // sessionTask: cancelled on background, restarted on the next
    // attemptSession.
    private var desktopStateTask: Task<Void, Never>?
    // R9.2: trackpad surface in the bottom region. The translator owns the
    // recognizers and emits NormalizedInput; we forward to the input channel.
    // Hit-area extended 12pt past its left edge so thumb drags that
    // start in the leading safe-area gutter still register as cursor
    // input. Visible width is unchanged.
    private let trackpadView: HitOutsetView = {
        let v = HitOutsetView()
        v.hitOutsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 0)
        return v
    }()
    private let trackpadHint = UILabel()
    // Hit-area extended 12pt past its right edge so swipes that land in
    // the trailing safe-area gutter still register as scroll. The card's
    // visible width stays 60pt; only point(inside:) sees the wider zone.
    private let scrollStripView: HitOutsetView = {
        let v = HitOutsetView()
        v.hitOutsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 12)
        return v
    }()
    private let scrollStripHint = UIImageView()
    private let settingsButton = UIButton(type: .system)
    // MARK: - One-handed affordances
    //
    // Issue #6 originally called for two-finger right-click and two-finger
    // scroll. Both dropped: the v0 target user holds the phone one-handed
    // and cannot reach two fingers on the trackpad with the thumb of the
    // same hand. Substitutions all funnel back into the existing wire
    // shapes (NormalizedInput.click(.right), NormalizedInput.scroll), so
    // the Mac is unaware of the affordance change. See GestureTranslator
    // for the matching note on the gesture side.
    //
    // bottom button row -> right-click (R10.1) and Show-keyboard (R12.3)
    // right-edge strip  -> scroll with momentum (attached via GestureTranslator)
    // press-and-hold    -> drag (UILongPressGestureRecognizer in GestureTranslator)
    // spaces dots band  -> single-finger horizontal swipe on a dots
    //                      indicator mounted between the screen-share
    //                      video and the trackpad (R11, SpacesDotsView).
    //                      Substitutes the canonical three-finger
    //                      horizontal swipe (not reachable one-handed)
    //                      and visually couples the Space indicator
    //                      with the screen content it switches.
    private let buttonRow = UIStackView()
    private let rightClickButton = UIButton(type: .system)
    private let showKeyboardButton = UIButton(type: .system)
    private let spacesDotsView = SpacesDotsView()
    // R20: thumbnail preview strip. Mounted between the sink container
    // and the dots band; off by default and hidden until settings opt in.
    private let thumbnailStripView = ThumbnailStripView()
    private var thumbnailsTask: Task<Void, Never>?
    private weak var topBandStackRef: UIStackView?
    // Most-recent DesktopState mirrored so the strip can re-render when
    // a thumbnails-push arrives without DesktopState changing, or when
    // the settings toggle flips after a state has already landed.
    private var lastDesktopState: DesktopState?
    // R12.3: hidden first-responder that backs the iOS soft keyboard.
    // Lives as a permanent zero-size subview so becomeFirstResponder /
    // resignFirstResponder route correctly through the responder chain.
    private let keyboardSurface = KeyboardSurface()
    private var buttonRowBottomConstraint: NSLayoutConstraint?
    private var dismissKeyboardTap: UITapGestureRecognizer?
    // CGEvent posts at the userspace layer don't actually trigger macOS
    // pointer accel (that lives in IOKit, below CGEvent), so we apply our
    // own approximation client-side. The .mac curve keeps the standard
    // UIPan slop intact for tremor filtering and uses a steeper top end
    // so flicks travel across the Mac display.
    private let gestureTranslator = GestureTranslator(acceleration: .mac, scrollAcceleration: .scroll)

    override func viewDidLoad() {
        super.viewDidLoad()
        // Plain system palette so the cards and canvas live in the same
        // tonal family in both modes: white canvas + soft grey cards in
        // light, near-black canvas + slightly-elevated dark grey cards
        // in dark. The earlier grouped palette inverted this in light
        // mode (grey canvas, white cards) which read as "sheets of paper
        // pasted on a grey wall" -- visually busy and asymmetric with
        // dark mode's unified look. Card definition in light mode comes
        // from the .separator hairlines below, not from luminance jump.
        view.backgroundColor = .systemBackground
        configureViews()
        configureSettingsButton()
        configureKeyboardSurface()
        applySettingsToTranslator()
        pairingClient.loadStoredPairingMaterial()
        render()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(settingsChanged),
            name: SettingsStore.changedNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
    }

    private func configureKeyboardSurface() {
        keyboardSurface.keyboardDelegate = self
        keyboardSurface.translatesAutoresizingMaskIntoConstraints = false
        // Sits just above the bottom button row so the user sees what
        // they typed locally as confirmation while wire events go to
        // the Mac. Hidden until the user summons it.
        keyboardSurface.isHidden = true
        view.addSubview(keyboardSurface)
        NSLayoutConstraint.activate([
            keyboardSurface.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            keyboardSurface.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            keyboardSurface.heightAnchor.constraint(equalToConstant: 36)
        ])
        // Any tap on the app's main view dismisses the keyboard. The
        // iOS soft keyboard and its inputAccessoryView render in a
        // separate UIWindow, so this recognizer doesn't see touches
        // on the keys themselves.
        //
        // cancelsTouchesInView=false so button taps and trackpad
        // gestures still reach their own handlers.
        //
        // delaysTouchesEnded defaults to true on UITapGestureRecognizer,
        // which would hold back the trackpad pan's touchesEnded by
        // ~150ms (the iOS tap timeout) waiting to confirm this isn't a
        // tap — that was the source of the cursor lag regression after
        // the keyboard slice landed. Force both delay flags off so the
        // pan path is never blocked by tap arbitration.
        //
        // gestureRecognizerShouldBegin further restricts the tap to
        // fire only when the keyboard is up, so when there's no
        // keyboard to dismiss the recognizer doesn't even compete with
        // the trackpad's pan for the touch sequence.
        let dismissTap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboardIfShown))
        dismissTap.cancelsTouchesInView = false
        dismissTap.delaysTouchesBegan = false
        dismissTap.delaysTouchesEnded = false
        dismissTap.delegate = self
        view.addGestureRecognizer(dismissTap)
        dismissKeyboardTap = dismissTap
    }

    // MARK: - UIGestureRecognizerDelegate

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === dismissKeyboardTap {
            return keyboardSurface.isFirstResponder
        }
        return true
    }

    private func configureSettingsButton() {
        let image = UIImage(systemName: "gearshape")
        settingsButton.setImage(image, for: .normal)
        settingsButton.tintColor = .label
        // Sits on top of the live screen-share video, whose colour we
        // cannot predict (a dark editor blends with a .label-coloured icon
        // in light mode). The translucent system-background pill keeps the
        // icon legible against arbitrary video content in both appearances.
        settingsButton.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.7)
        settingsButton.layer.cornerRadius = 18
        settingsButton.layer.masksToBounds = true
        settingsButton.accessibilityLabel = "Settings"
        settingsButton.accessibilityIdentifier = "settings-button"
        settingsButton.addTarget(self, action: #selector(openSettings), for: .touchUpInside)
        settingsButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(settingsButton)
        NSLayoutConstraint.activate([
            settingsButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            settingsButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            settingsButton.widthAnchor.constraint(equalToConstant: 36),
            settingsButton.heightAnchor.constraint(equalToConstant: 36)
        ])
    }

    @objc private func openSettings() {
        let settings = SettingsViewController()
        let nav = UINavigationController(rootViewController: settings)
        present(nav, animated: true)
    }

    @objc private func settingsChanged() {
        applySettingsToTranslator()
        // R20: settings toggle is the only source of truth for whether
        // thumbnails capture should run host-side. On every change we
        // resend the current ClientConfig and refresh strip visibility.
        // Re-applying the last DesktopState ensures the strip's tile
        // lineup matches the active display before un-hiding.
        sendCurrentClientConfig()
        if let state = lastDesktopState {
            thumbnailStripView.apply(state: state)
        }
        refreshThumbnailStripVisibility()
    }

    private func applySettingsToTranslator() {
        gestureTranslator.tuning = SettingsStore.shared.tuning
        spacesDotsView.useMacOSDirection = SettingsStore.shared.useMacOSSpacesDirection
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        triggerSessionIfPaired()
    }

    @objc private func applicationWillEnterForeground() {
        triggerSessionIfPaired()
    }

    // R13.1: on background, tear down both transports explicitly.
    // iOS suspends the app and the WebRTC PC / input WS quietly die in
    // some network conditions; if we don't flip state here, foreground
    // sees state=.connected and triggerSessionIfPaired short-circuits,
    // leaving the user with a zombie session that produces no input
    // and no video. Closing here forces state to .pairedDisconnected
    // so the next foreground reliably re-attempts.
    @objc private func applicationDidEnterBackground() {
        sessionTask?.cancel()
        sessionTask = nil
        handshakeTask?.cancel()
        handshakeTask = nil
        iceGraceTask?.cancel()
        iceGraceTask = nil
        mediaStateTask?.cancel()
        mediaStateTask = nil
        desktopStateTask?.cancel()
        desktopStateTask = nil
        teardownMediaTransport()
        // Closes activeSignaling + activeInputChannel and flips state
        // .connected -> .pairedDisconnected. Idempotent for other states.
        pairingClient.handleMediaSessionFailed()
        render()
    }

    private func triggerSessionIfPaired() {
        guard case .pairedDisconnected = pairingClient.state else { return }
        sessionTask?.cancel()
        sessionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.pairingClient.attemptSession()
            } catch {
                // PairingClient.attemptSession already set the state; nothing extra.
            }
            self.render()
        }
    }

    deinit {
        handshakeTask?.cancel()
        sessionTask?.cancel()
        mediaStateTask?.cancel()
        iceGraceTask?.cancel()
        desktopStateTask?.cancel()
        mediaTransport?.stop()
    }

    private func startMediaTransportIfNeeded() {
        guard mediaTransport == nil,
              let signaling = pairingClient.activeSignaling else { return }
        let sink = MediaStack.makeVideoSink()
        let transport = mediaFactory.make()
        videoSink = sink
        mediaTransport = transport
        mountSinkView(sink.view)
        showTrackpad()

        mediaStateTask?.cancel()
        mediaStateTask = Task { [weak self, transport] in
            for await state in transport.connectionState {
                await MainActor.run {
                    self?.handleMediaConnectionState(state)
                }
            }
        }

        Task { [transport, signaling, sink] in
            try? await transport.start(
                role: .answerer,
                signaling: signaling,
                videoSource: nil,
                videoSink: sink
            )
        }
    }

    private func handleMediaConnectionState(_ state: MediaConnectionState) {
        switch state {
        case .connecting:
            break
        case .connected:
            iceGraceTask?.cancel()
            iceGraceTask = nil
        case .disconnected:
            iceGraceTask?.cancel()
            iceGraceTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self?.failMediaSession()
                }
            }
        case .failed, .closed:
            iceGraceTask?.cancel()
            iceGraceTask = nil
            failMediaSession()
        }
    }

    private func failMediaSession() {
        teardownMediaTransport()
        pairingClient.handleMediaSessionFailed()
        render()
    }

    private func mountSinkView(_ sinkView: UIView) {
        // Top portion shows the Mac display, bottom is the trackpad zone.
        // 55/45 leaves plenty of trackpad real estate without making the
        // video unreadable; the Mac display is landscape so it aspect-fits
        // comfortably in the top half.
        //
        // R21: the sink is wrapped in a UIScrollView so pinch and pan
        // zoom the visible slice of the Mac display. UIScrollView is
        // the canonical iOS path for zoom-and-pan (per the hackingwithswift
        // recipe and the libwebrtc-iOS community pattern for
        // RTCMTLVideoView, which is a plain MTKView). Local-only zoom
        // in v0; cursor wire shape is unchanged.
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.minimumZoomScale = 1.0
        scroll.maximumZoomScale = Self.sinkMaxZoomScale
        scroll.zoomScale = 1.0
        scroll.bouncesZoom = true
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.decelerationRate = .fast
        scroll.delegate = self
        scroll.clipsToBounds = true
        // Insets-by-content-area is iOS 11+ default; keep off so the
        // zoomed pixels go edge to edge.
        scroll.contentInsetAdjustmentBehavior = .never

        sinkView.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(sinkView)
        view.insertSubview(scroll, at: 0)

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.55),

            // The sink fills the scroll view's content area exactly at
            // zoomScale = 1. As the user pinches, UIScrollView scales
            // its zoom subview's transform, the content size grows, and
            // the leftover area becomes pannable.
            sinkView.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            sinkView.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            sinkView.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            sinkView.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            sinkView.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            sinkView.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
        ])

        // Double-tap zoom toggle: 1.0 ↔ 2.0, animated, centered on the
        // tap point. The single-tap path stays open for any future use
        // (currently nothing); we don't need require-to-fail because
        // UIScrollView's pinch is a pinch recognizer, not a tap.
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleSinkDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)

        sinkScrollView = scroll
    }

    @objc private func handleSinkDoubleTap(_ gr: UITapGestureRecognizer) {
        guard let scroll = sinkScrollView else { return }
        let target: CGFloat = scroll.zoomScale > 1.0 ? 1.0 : Self.sinkDoubleTapZoomScale
        let point = gr.location(in: gr.view)
        // Convert the visible-frame tap point to a content-coords rect
        // so iOS zooms centered on the user's finger, not the origin.
        let scale = target
        let rectWidth = scroll.bounds.width / scale
        let rectHeight = scroll.bounds.height / scale
        let rect = CGRect(
            x: point.x - rectWidth / 2,
            y: point.y - rectHeight / 2,
            width: rectWidth,
            height: rectHeight
        )
        scroll.zoom(to: rect, animated: true)
    }

    // MARK: - UIScrollViewDelegate

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        // Only one subview at content level: the sink view. UIScrollView
        // applies the zoom transform to whatever this returns.
        guard scrollView === sinkScrollView else { return nil }
        return scrollView.subviews.first
    }

    // ADR-0007 active prefill. Pinch is starting and the host currently
    // has an active crop. Whatever the user does next (pinch in or
    // out), they'll need a wider stream available, so kick a
    // viewport=nil now and let the host snap back to full display
    // before the gesture even finishes. Pinch in just re-crops on
    // settle; pinch out gets the wider area pre-staged.
    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        guard scrollView === sinkScrollView else { return }
        guard currentRemoteViewport != nil else { return }
        currentRemoteViewport = nil
        sendClientConfig(viewport: nil)
    }

    // Gesture settled. If the user is still zoomed past the trigger,
    // compute the visible normalized rect and send it to the host;
    // future frames carry that sub-region at native source density.
    // Below the trigger we keep the full-display stream (active prefill
    // already sent that on pinch start; this is the same value, so the
    // de-dup in sendClientConfig drops it).
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        guard scrollView === sinkScrollView else { return }
        applyZoomSettleViewport(scrollView)
    }

    // Pan landed (after a deceleration or a non-decelerating finger
    // lift). If the user is in cropped mode, we re-snapshot so the
    // host's crop tracks the new visible region. Throttled
    // accidentally via the scrollViewDidEnd* lifecycle: these only
    // fire on settle, not per-frame.
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        guard scrollView === sinkScrollView else { return }
        applyPanSettleViewport(scrollView)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        guard scrollView === sinkScrollView else { return }
        if !decelerate {
            applyPanSettleViewport(scrollView)
        }
    }

    // MARK: - Viewport plumbing

    private func applyZoomSettleViewport(_ scrollView: UIScrollView) {
        let zoom = scrollView.zoomScale
        if zoom >= Self.viewportZoomTrigger {
            sendViewportFromCurrentScrollState(scrollView)
        } else {
            // Below the trigger: keep host at full display.
            if currentRemoteViewport != nil {
                currentRemoteViewport = nil
                sendClientConfig(viewport: nil)
            }
        }
    }

    private func applyPanSettleViewport(_ scrollView: UIScrollView) {
        // Only re-send when zoom is past the trigger; otherwise the
        // host should stay at full display and the pan is purely
        // local (within an at-fit view).
        guard scrollView.zoomScale >= Self.viewportZoomTrigger else { return }
        sendViewportFromCurrentScrollState(scrollView)
    }

    private func sendViewportFromCurrentScrollState(_ scrollView: UIScrollView) {
        guard let rect = normalizedVisibleRect(scrollView) else { return }
        // De-dup nearly-identical sends so a small pan correction
        // doesn't burn a keyframe. 1.5% threshold is below the user's
        // perceptual delta on a phone-sized viewport.
        if let prev = currentRemoteViewport,
           abs(prev.x - rect.x) < 0.015,
           abs(prev.y - rect.y) < 0.015,
           abs(prev.w - rect.w) < 0.015,
           abs(prev.h - rect.h) < 0.015 {
            return
        }
        currentRemoteViewport = rect
        sendClientConfig(viewport: rect)
    }

    // Convert the scroll view's current visible region (in zoomed
    // content coords) into a normalized rect over the underlying
    // full-content area. The full content area corresponds to the
    // active display because at zoomScale=1 the sink view fills the
    // visible bounds with the host's encoded frame.
    private func normalizedVisibleRect(_ scrollView: UIScrollView) -> ViewportRect? {
        let zoom = scrollView.zoomScale
        guard zoom > 0 else { return nil }
        let contentW = scrollView.contentSize.width
        let contentH = scrollView.contentSize.height
        guard contentW > 0, contentH > 0 else { return nil }
        let visibleW = scrollView.bounds.width
        let visibleH = scrollView.bounds.height
        let x = scrollView.contentOffset.x / contentW
        let y = scrollView.contentOffset.y / contentH
        let w = visibleW / contentW
        let h = visibleH / contentH
        // Clamp into [0, 1] in case bounce / overscroll briefly
        // produced a slightly out-of-range offset.
        let cx = max(0, min(1 - 0.01, Float(x)))
        let cy = max(0, min(1 - 0.01, Float(y)))
        let cw = max(0.01, min(1 - cx, Float(w)))
        let ch = max(0.01, min(1 - cy, Float(h)))
        return ViewportRect(x: cx, y: cy, w: cw, h: ch)
    }

    private func sendClientConfig(viewport: ViewportRect?) {
        guard let channel = pairingClient.activeInputChannel else { return }
        let config = ClientConfig(
            thumbnailsEnabled: SettingsStore.shared.showSpacePreviews,
            viewport: viewport
        )
        Task { [channel, config] in
            try? await channel.sendConfig(config)
        }
    }

    @objc private func dismissKeyboardIfShown() {
        if keyboardSurface.isFirstResponder {
            toggleKeyboard()
        }
    }

    private func showTrackpad() {
        if trackpadView.superview != nil { return }
        trackpadView.translatesAutoresizingMaskIntoConstraints = false
        // Soft grey card in light, slightly-elevated dark grey in dark.
        // .separator gives a hairline edge that defines the surface; in
        // light mode the colour contrast alone is intentionally subtle,
        // so the hairline does the boundary work.
        trackpadView.backgroundColor = UIColor.secondarySystemBackground
        trackpadView.layer.cornerRadius = 16
        trackpadView.layer.borderColor = UIColor.separator.cgColor
        trackpadView.layer.borderWidth = 0.5
        trackpadView.isUserInteractionEnabled = true
        view.addSubview(trackpadView)

        trackpadHint.text = "Trackpad"
        // .tertiaryLabel reads as near-invisible grey-on-grey in light mode.
        // .secondaryLabel keeps the hint subordinate to the screen-share
        // but actually legible in both appearances.
        trackpadHint.textColor = .secondaryLabel
        trackpadHint.font = .preferredFont(forTextStyle: .footnote)
        trackpadHint.textAlignment = .center
        trackpadHint.translatesAutoresizingMaskIntoConstraints = false
        trackpadView.addSubview(trackpadHint)

        scrollStripView.translatesAutoresizingMaskIntoConstraints = false
        scrollStripView.backgroundColor = UIColor.secondarySystemBackground
        scrollStripView.layer.cornerRadius = 16
        scrollStripView.layer.borderColor = UIColor.separator.cgColor
        scrollStripView.layer.borderWidth = 0.5
        scrollStripView.isUserInteractionEnabled = true
        view.addSubview(scrollStripView)

        // SF Symbol instead of the "↕" character: iOS auto-emojifies arrow
        // codepoints and renders them as a dark blue tile, which reads as
        // a foreign UI element in light mode. The symbol image is template
        // tinted, so it tracks .secondaryLabel in both appearances.
        scrollStripHint.image = UIImage(systemName: "arrow.up.arrow.down")
        scrollStripHint.tintColor = .secondaryLabel
        scrollStripHint.contentMode = .scaleAspectFit
        scrollStripHint.translatesAutoresizingMaskIntoConstraints = false
        scrollStripView.addSubview(scrollStripHint)

        buttonRow.axis = .horizontal
        buttonRow.spacing = 12
        buttonRow.distribution = .fillEqually
        buttonRow.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(buttonRow)

        styleActionButton(rightClickButton, title: "Right-click")
        rightClickButton.addTarget(self, action: #selector(rightClickTapped), for: .touchUpInside)
        buttonRow.addArrangedSubview(rightClickButton)

        styleActionButton(showKeyboardButton, title: "Show keyboard")
        showKeyboardButton.addTarget(self, action: #selector(toggleKeyboard), for: .touchUpInside)
        buttonRow.addArrangedSubview(showKeyboardButton)

        spacesDotsView.translatesAutoresizingMaskIntoConstraints = false
        spacesDotsView.delegate = self

        // R20: dots band and thumbnail strip share a vertical stack
        // pinned at view.bottom * 0.55. Stacking them means the strip's
        // isHidden = true (settings off OR single-Space state) collapses
        // its layout space; the dots band slides up to the original
        // 0.55 position and the trackpad takes back the height the
        // strip would have occupied. No second set of constraints.
        thumbnailStripView.translatesAutoresizingMaskIntoConstraints = false
        thumbnailStripView.delegate = self
        thumbnailStripView.isHidden = true
        let topBandStack = UIStackView(arrangedSubviews: [spacesDotsView, thumbnailStripView])
        topBandStack.axis = .vertical
        topBandStack.spacing = 4
        topBandStack.alignment = .fill
        topBandStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBandStack)
        topBandStackRef = topBandStack

        let bottomConstraint = buttonRow.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12)
        buttonRowBottomConstraint = bottomConstraint

        // Stack's top aligns with the video sink's bottom edge (sink
        // occupies the top 0.55 of the view height; see mountSinkView).
        // Multiplier on view.bottom keeps the band's position
        // independent of when the sink mounts.
        let bandTopAtVideoBottom = NSLayoutConstraint(
            item: topBandStack,
            attribute: .top,
            relatedBy: .equal,
            toItem: view,
            attribute: .bottom,
            multiplier: 0.55,
            constant: 0
        )

        NSLayoutConstraint.activate([
            buttonRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bottomConstraint,
            buttonRow.heightAnchor.constraint(equalToConstant: 44),

            topBandStack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            topBandStack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bandTopAtVideoBottom,
            spacesDotsView.heightAnchor.constraint(equalToConstant: 32),
            thumbnailStripView.heightAnchor.constraint(equalToConstant: 56),

            keyboardSurface.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            trackpadView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            trackpadView.topAnchor.constraint(equalTo: topBandStack.bottomAnchor, constant: 4),
            trackpadView.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),
            trackpadHint.centerXAnchor.constraint(equalTo: trackpadView.centerXAnchor),
            trackpadHint.bottomAnchor.constraint(equalTo: trackpadView.bottomAnchor, constant: -10),

            scrollStripView.widthAnchor.constraint(equalToConstant: 60),
            scrollStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            scrollStripView.topAnchor.constraint(equalTo: trackpadView.topAnchor),
            scrollStripView.bottomAnchor.constraint(equalTo: trackpadView.bottomAnchor),
            scrollStripHint.centerXAnchor.constraint(equalTo: scrollStripView.centerXAnchor),
            scrollStripHint.centerYAnchor.constraint(equalTo: scrollStripView.centerYAnchor)
        ])

        gestureTranslator.delegate = self
        gestureTranslator.attach(to: trackpadView)
        gestureTranslator.attachScrollStrip(to: scrollStripView)

        startDesktopStateObservation()
        startThumbnailsObservation()
        sendCurrentClientConfig()
    }

    // R11: drains the InputChannel's host-pushed DesktopState frames
    // into the dots band. Restarted on each showTrackpad because
    // activeInputChannel may have been replaced by a reconnect during
    // foreground (D13.1 + D13.2 lifecycle).
    private func startDesktopStateObservation() {
        desktopStateTask?.cancel()
        guard let channel = pairingClient.activeInputChannel else { return }
        spacesDotsView.renderEmpty()
        thumbnailStripView.renderEmpty()
        desktopStateTask = Task { [weak self, channel] in
            for await state in channel.desktopStateUpdates {
                await MainActor.run {
                    self?.lastDesktopState = state
                    self?.spacesDotsView.apply(state: state)
                    self?.thumbnailStripView.apply(state: state)
                    self?.refreshThumbnailStripVisibility()
                }
            }
        }
    }

    // ADR-0006: drains the ThumbnailsPush stream into the strip view.
    // Independent from DesktopState because thumbnails refresh on
    // their own cadence; merging into desktopStateTask would force a
    // synthetic state push per timer tick (rejected in ADR-0006).
    private func startThumbnailsObservation() {
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

    // The strip is visible when (a) the user has opted in via settings,
    // and (b) the active display has more than one user Space (a single
    // Space has no "switch to" target). Centralised here so the dots-
    // band hide rule (count <= 1) and the settings toggle compose
    // cleanly without each owning a piece of the decision.
    private func refreshThumbnailStripVisibility() {
        let countOk = thumbnailStripView.userSpaceCount > 1
        let optIn = SettingsStore.shared.showSpacePreviews
        thumbnailStripView.isHidden = !(optIn && countOk)
    }

    // ADR-0006: send the current client-config on input-channel open
    // and on every settings toggle change. The host is the source of
    // truth on capture state; this is the only path that turns it on
    // or off.
    private func sendCurrentClientConfig() {
        guard let channel = pairingClient.activeInputChannel else { return }
        let config = ClientConfig(thumbnailsEnabled: SettingsStore.shared.showSpacePreviews)
        Task { [channel, config] in
            try? await channel.sendConfig(config)
        }
    }

    private func hideTrackpad() {
        trackpadView.removeFromSuperview()
        scrollStripView.removeFromSuperview()
        buttonRow.removeFromSuperview()
        rightClickButton.removeFromSuperview()
        showKeyboardButton.removeFromSuperview()
        topBandStackRef?.removeFromSuperview()
        topBandStackRef = nil
        spacesDotsView.removeFromSuperview()
        thumbnailStripView.removeFromSuperview()
        spacesDotsView.renderEmpty()
        thumbnailStripView.renderEmpty()
        desktopStateTask?.cancel()
        desktopStateTask = nil
        thumbnailsTask?.cancel()
        thumbnailsTask = nil
        lastDesktopState = nil
        keyboardSurface.setVisible(false)
        buttonRowBottomConstraint = nil
    }

    @objc private func rightClickTapped() {
        sendInput(.click(button: .right))
    }

    @objc private func toggleKeyboard() {
        if keyboardSurface.isFirstResponder {
            keyboardSurface.setVisible(false)
            keyboardSurface.isHidden = true
            keyboardSurface.text = ""
            setTrackpadHidden(false)
            showKeyboardButton.setTitle("Show keyboard", for: .normal)
        } else {
            keyboardSurface.isHidden = false
            setTrackpadHidden(true)
            keyboardSurface.setVisible(true)
            showKeyboardButton.setTitle("Hide keyboard", for: .normal)
        }
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        guard traitCollection.userInterfaceStyle != previousTraitCollection?.userInterfaceStyle else { return }
        // CALayer.borderColor is a CGColor and does not auto-resolve dynamic
        // UIColors on appearance changes the way UIView.backgroundColor
        // does. Re-resolve each card border so toggling Light/Dark updates
        // them instantly instead of leaving stale hairlines from the
        // previous mode.
        let resolved = UIColor.separator.cgColor
        for layer in [trackpadView.layer, scrollStripView.layer, rightClickButton.layer, showKeyboardButton.layer, keyboardSurface.layer, spacesDotsView.layer] {
            if layer.borderWidth > 0 {
                layer.borderColor = resolved
            }
        }
    }

    // Match the trackpad / scroll-strip card treatment so the button row
    // reads as part of the same surface family rather than floating tinted
    // pills on a grey ground.
    private func styleActionButton(_ button: UIButton, title: String) {
        button.setTitle(title, for: .normal)
        button.backgroundColor = .secondarySystemBackground
        button.layer.cornerRadius = 12
        button.layer.borderColor = UIColor.separator.cgColor
        button.layer.borderWidth = 0.5
        button.titleLabel?.font = .preferredFont(forTextStyle: .body)
    }

    // Trackpad and scroll-strip serve no purpose while the keyboard is up
    // (the user is typing, not pointing). Leaving them visible caused the
    // trackpad's "Trackpad" hint and the scroll strip's chevron to bleed
    // through behind the text-echo field, since both views and the field
    // were anchored to the same vertical band above the button row.
    private func setTrackpadHidden(_ hidden: Bool) {
        trackpadView.isHidden = hidden
        scrollStripView.isHidden = hidden
        spacesDotsView.isHidden = hidden
    }

    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard
            let endFrame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
            let bottom = buttonRowBottomConstraint
        else { return }
        // Convert from screen coords to view coords so multi-window /
        // split-view setups don't double-count safe area. overlap is the
        // y-distance the keyboard hides from the bottom of our view.
        let endInView = view.convert(endFrame, from: nil)
        let overlap = max(0, view.bounds.maxY - endInView.minY)
        let safeBottom = view.safeAreaInsets.bottom
        // The safe-area anchor already accounts for safeBottom, so add
        // only the extra that the keyboard hides on top of it.
        let extra = max(0, overlap - safeBottom)
        animateButtonRow(to: -(extra + 12), with: note)
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        animateButtonRow(to: -12, with: note)
    }

    private func animateButtonRow(to constant: CGFloat, with note: Notification) {
        guard let bottom = buttonRowBottomConstraint else { return }
        bottom.constant = constant
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? TimeInterval) ?? 0.25
        UIView.animate(withDuration: duration) {
            self.view.layoutIfNeeded()
        }
    }

    // MARK: - KeyboardSurfaceDelegate

    func keyboardSurface(_ surface: KeyboardSurface, didProduce input: NormalizedInput) {
        sendInput(input)
    }

    // MARK: - SpacesDotsViewDelegate

    func spacesDots(_ view: SpacesDotsView, didProduce input: NormalizedInput) {
        sendInput(input)
    }

    // MARK: - ThumbnailStripViewDelegate

    // R20: a tap on a non-active tile emits one step-direction swipe
    // per signed index delta. The host's dock-swipe synthesis already
    // commits one Space per Began-Changed-Ended cycle; we just chain
    // |delta| of them. Each chained gesture mimics the dots band's
    // emit() so the host can't tell whether the user dragged or tapped.
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int) {
        guard delta != 0 else { return }
        let steps = abs(delta)
        let direction: Float = delta > 0 ? 1.0 : -1.0
        for _ in 0..<steps {
            sendInput(.switchSpaceGesture(phase: .began, progress: 0, velocityX: 0))
            sendInput(.switchSpaceGesture(phase: .changed, progress: direction * 0.5, velocityX: direction * 1500))
            sendInput(.switchSpaceGesture(phase: .ended, progress: direction, velocityX: direction * 2000))
        }
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

    private func sendInput(_ input: NormalizedInput) {
        // ADR-0005: input rides its own WebSocket Secure channel,
        // independent of the WebRTC video PC. The channel send is
        // async; fire-and-forget into a detached Task so the trackpad
        // / keyboard caller stays synchronous and main-thread.
        guard let channel = pairingClient.activeInputChannel else { return }
        Task { [channel, input] in
            try? await channel.send(input)
        }
    }

    private func teardownMediaTransport() {
        mediaTransport?.stop()
        mediaTransport = nil
        videoSink?.view.removeFromSuperview()
        videoSink = nil
        sinkScrollView?.removeFromSuperview()
        sinkScrollView = nil
        // ADR-0007: forget the remote crop on session teardown. The
        // host process may persist (long-lived) but a fresh transport
        // resets its frame source's stream state; we want to start
        // from full display on the next session.
        currentRemoteViewport = nil
        hideTrackpad()
    }

    // MARK: - GestureTranslatorDelegate

    func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput) {
        sendInput(input)
    }

    private func configureViews() {
        statusLabel.font = .preferredFont(forTextStyle: .headline)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        actionButton.setTitle("Scan QR", for: .normal)
        actionButton.addTarget(self, action: #selector(startScanning), for: .touchUpInside)
        actionButton.translatesAutoresizingMaskIntoConstraints = false

        forgetButton.setTitle("Forget host", for: .normal)
        forgetButton.setTitleColor(.systemRed, for: .normal)
        forgetButton.addTarget(self, action: #selector(forgetHost), for: .touchUpInside)
        forgetButton.translatesAutoresizingMaskIntoConstraints = false
        forgetButton.isHidden = true

        view.addSubview(statusLabel)
        view.addSubview(actionButton)
        view.addSubview(forgetButton)

        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            actionButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 18),
            actionButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            forgetButton.topAnchor.constraint(equalTo: actionButton.bottomAnchor, constant: 12),
            forgetButton.centerXAnchor.constraint(equalTo: view.centerXAnchor)
        ])
    }

    @objc private func forgetHost() {
        sessionTask?.cancel()
        handshakeTask?.cancel()
        stopCamera()
        teardownMediaTransport()
        pairingClient.clearStoredCredentials()
        render()
    }

    private func render() {
        forgetButton.isHidden = true
        statusLabel.isHidden = false
        switch pairingClient.state {
        case .unpaired:
            statusLabel.text = "AgentDesk"
            actionButton.isHidden = false
        case .scanning:
            statusLabel.text = "Scanning"
            actionButton.isHidden = true
        case .pairing:
            statusLabel.text = "Connecting to Mac"
            actionButton.isHidden = true
        case .awaitingApproval:
            statusLabel.text = "Waiting for approval on Mac"
            actionButton.isHidden = true
        case .approved(let token):
            statusLabel.text = "Approved by \(token.hostFingerprint)"
            actionButton.isHidden = true
            stopCamera()
        case .pairedDisconnected:
            statusLabel.text = "Paired (reconnecting)"
            actionButton.isHidden = true
            forgetButton.isHidden = false
            stopCamera()
        case .sessionConnecting:
            statusLabel.text = "Connecting"
            actionButton.isHidden = true
            stopCamera()
        case .connected(let active):
            statusLabel.text = "Connected (device \(active.deviceFingerprint))"
            statusLabel.isHidden = true
            actionButton.isHidden = true
            stopCamera()
            startMediaTransportIfNeeded()
        case .revoked:
            statusLabel.text = "Revoked by host"
            actionButton.isHidden = false
            forgetButton.isHidden = false
            stopCamera()
        case .rejected(let reason):
            statusLabel.text = "Pairing rejected: \(reason)"
            actionButton.isHidden = false
            stopCamera()
        }
    }

    func handleIncomingPairingURL(_ url: URL) {
        // A fresh pair URL supersedes whatever state we're in: stale token
        // from a prior session, in-flight session attempt, or a rejection.
        sessionTask?.cancel()
        handshakeTask?.cancel()
        stopCamera()
        pairingClient.clearStoredCredentials()
        do {
            try pairingClient.startScanning()
        } catch {
            pairingClient.reject("\(error)")
            render()
            return
        }
        do {
            let payload = try pairingClient.acceptScannedCode(url.absoluteString)
            render()
            handshakeTask?.cancel()
            handshakeTask = Task { @MainActor [weak self] in
                do {
                    try await self?.pairingClient.performHandshake(for: payload)
                } catch {
                    self?.pairingClient.reject("\(error)")
                }
                self?.render()
                self?.triggerSessionIfPaired()
            }
        } catch {
            pairingClient.reject("\(error)")
            render()
        }
    }

    @objc private func startScanning() {
        do {
            try pairingClient.startScanning()
            try startCamera()
            render()
        } catch {
            pairingClient.reject("\(error)")
            render()
        }
    }

    private func startCamera() throws {
        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video) else {
            throw PairingClientError.malformedURL
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw PairingClientError.malformedURL
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            throw PairingClientError.malformedURL
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        captureSession = session
        previewLayer = preview
        session.startRunning()
    }

    private func stopCamera() {
        captureSession?.stopRunning()
        captureSession = nil
        previewLayer?.removeFromSuperlayer()
        previewLayer = nil
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let code = metadataObjects
            .compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
            .first(where: { $0.type == .qr })?
            .stringValue else {
            return
        }

        stopCamera()
        do {
            let payload = try pairingClient.acceptScannedCode(code)
            render()
            handshakeTask?.cancel()
            handshakeTask = Task { @MainActor [weak self] in
                do {
                    try await self?.pairingClient.performHandshake(for: payload)
                } catch {
                    self?.pairingClient.reject("\(error)")
                }
                self?.render()
                self?.triggerSessionIfPaired()
            }
        } catch {
            pairingClient.reject("\(error)")
            render()
        }
    }
}

// UIView that reports points up to `hitOutsets` outside its bounds as
// inside, so touches in the surrounding padding still hit-test to this
// view and reach its gesture recognizers. Visual layout is unchanged.
final class HitOutsetView: UIView {
    var hitOutsets: UIEdgeInsets = .zero

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let expanded = bounds.inset(by: UIEdgeInsets(
            top: -hitOutsets.top,
            left: -hitOutsets.left,
            bottom: -hitOutsets.bottom,
            right: -hitOutsets.right
        ))
        return expanded.contains(point)
    }
}
