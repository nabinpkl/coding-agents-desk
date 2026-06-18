import AVFoundation
import UIKit

// Pairing + session lifecycle owner. The view controller threads three
// concerns: the pairing screen (status label, action button, QR camera),
// the state-machine render, and the WebRTC session start/teardown.
// Layout / orientation, keyboard, edge-follow, and gesture forwarding
// live in companion extensions under PairingViewController+*.swift. All
// stored properties stay here; extensions reach them as same-module
// internal access.

final class PairingViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    let pairingClient = PairingClient()
    private let statusLabel = UILabel()
    private let actionButton = UIButton(type: .system)
    private let forgetButton = UIButton(type: .system)
    var captureSession: AVCaptureSession?
    var previewLayer: AVCaptureVideoPreviewLayer?
    var handshakeTask: Task<Void, Never>?
    var sessionTask: Task<Void, Never>?
    var mediaTransport: MediaTransport?
    var videoSink: VideoFrameSink?
    // R21: pinch-zoom container around the WebRTC sink. Local-only zoom
    // via UIScrollView transform; ADR-0008 dropped the host-side
    // sourceRect crop path in favour of native-pixel encoder density.
    var sinkScrollView: UIScrollView?
    var sinkDoubleTapRecognizer: UITapGestureRecognizer?
    static let sinkMaxZoomScale: CGFloat = 4.0
    static let sinkDoubleTapZoomScale: CGFloat = 2.0
    // ADR-0009 cursor-driven viewport pan. The client mirrors the host
    // cursor position in source-display points so the scroll view can
    // follow it when zoomed past 1.0x. Updated locally on every
    // .cursorMove emitted by GestureTranslator; nil until the first
    // DesktopState lands with a valid active display rect.
    var cursorSourcePos: CGPoint?
    var activeDisplayRect: CGRect = .zero
    var activeDisplayIdMirror: String?
    // Local cursor overlay. Moves immediately from cursorSourcePos on
    // every gesture delta so the user sees instant cursor response
    // without waiting for the Mac → WebRTC → iOS video round-trip.
    var cursorDotView: CursorPointerView?
    // Cursor-image mirror state. The host pushes the real cursor glyph on
    // shape change; we cache it and stamp it at the predicted position.
    // Defaults describe the drawn-arrow fallback (tip hotspot, small size).
    let cursorImageStore = CursorImageStore()
    var cursorTask: Task<Void, Never>?
    var cursorHotspotFrac: CGPoint = .zero
    var cursorRenderSize: CGSize = CursorPointerView.pointerSize
    var cursorHidden = false
    var mediaStateTask: Task<Void, Never>?
    var iceGraceTask: Task<Void, Never>?
    // Transparent hit layer above the video sink. When enabled in
    // settings, it lets the live screen act as a relative trackpad
    // without removing the dedicated trackpad surface.
    let screenTrackpadOverlay = UIView()
    let screenScrollRailView = UIView()
    static let screenScrollRailWidth: CGFloat = 60
    static let screenScrollRailRestAlpha: CGFloat = 0.18
    static let screenScrollRailActiveAlpha: CGFloat = 0.34
    // R11: observes the input channel's desktopStateUpdates stream and
    // pushes each DesktopState into the strip. Lifecycle matches
    // sessionTask: cancelled on background, restarted on the next
    // attemptSession.
    var desktopStateTask: Task<Void, Never>?
    var agentSayTask: Task<Void, Never>?
    var agentSaySpeechTask: Task<Void, Never>?
    var agentSayHideTask: Task<Void, Never>?
    let agentSayBanner = UILabel()
    let agentSaySynthesizer = AVSpeechSynthesizer()
    var agentSayIncomingBuffer = ""
    var agentSaySpeechQueue: [String] = []
    var agentSayIsSpeaking = false
    var agentSayStreamEnded = false
    // R9.2: trackpad surface in the bottom region. The translator owns
    // the recognizers and emits NormalizedInput; we forward to the
    // input channel. Hit-area extended 12pt past its left edge so thumb
    // drags that start in the leading safe-area gutter still register
    // as cursor input. Visible width is unchanged.
    let trackpadView: HitOutsetView = {
        let v = HitOutsetView()
        v.hitOutsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 0)
        return v
    }()
    let trackpadHint = UILabel()
    // Hit-area extended 12pt past its right edge so swipes that land in
    // the trailing safe-area gutter still register as scroll.
    let scrollStripView: HitOutsetView = {
        let v = HitOutsetView()
        v.hitOutsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 12)
        return v
    }()
    let scrollStripHint = UIImageView()
    let settingsButton = UIButton(type: .system)
    // R24: top-right orientation toggle. Sits to the left of the
    // settings button and synthesises a UIWindowScene geometry update
    // when tapped.
    let orientationToggleButton = UIButton(type: .system)
    // MARK: - One-handed affordances
    //
    // Issue #6 originally called for two-finger right-click and
    // two-finger scroll. Both dropped: the v0 target user holds the
    // phone one-handed and cannot reach two fingers on the trackpad
    // with the thumb of the same hand. Substitutions all funnel back
    // into the existing wire shapes (NormalizedInput.click(.right),
    // NormalizedInput.scroll), so the Mac is unaware of the affordance
    // change. See GestureTranslator for the matching note on the
    // gesture side.
    //
    // bottom button row -> right-click (R10.1) and Show-keyboard (R12.3)
    // right-edge strip  -> scroll with momentum (attached via GestureTranslator)
    // press-and-hold    -> drag (UILongPressGestureRecognizer in GestureTranslator)
    // thumbnail strip   -> single-finger horizontal swipe on the
    //                      merged Spaces band (R25, ThumbnailStripView).
    let buttonRow = UIStackView()
    let rightClickButton = UIButton(type: .system)
    let showKeyboardButton = UIButton(type: .system)
    // R25: merged Spaces band. Replaces the old dots band.
    let thumbnailStripView = ThumbnailStripView()
    var thumbnailsTask: Task<Void, Never>?
    var topWindowsTask: Task<Void, Never>?
    // Most-recent DesktopState mirrored so the strip can re-render when
    // a thumbnails-push arrives without DesktopState changing, or when
    // the settings toggle flips after a state has already landed.
    var lastDesktopState: DesktopState?
    // R12.3: hidden first-responder that backs the iOS soft keyboard.
    let keyboardSurface = KeyboardSurface()
    var buttonRowBottomConstraint: NSLayoutConstraint?
    var dismissKeyboardTap: UITapGestureRecognizer?
    // R23: orientation-variant constraints built fresh on every session
    // (mountSinkView + showTrackpad both append) and one set is active
    // at a time. viewWillTransition swaps them inside the rotation
    // coordinator's animator block. The shared (orientation-invariant)
    // constraints stay active for the entire session and aren't
    // tracked here.
    var portraitConstraints: [NSLayoutConstraint] = []
    var landscapeConstraints: [NSLayoutConstraint] = []
    var currentIsLandscape: Bool?
    // CGEvent posts at the userspace layer don't actually trigger macOS
    // pointer accel (that lives in IOKit, below CGEvent), so we apply
    // our own approximation client-side. The .mac curve keeps the
    // standard UIPan slop intact for tremor filtering and uses a
    // steeper top end so flicks travel across the Mac display.
    let gestureTranslator = GestureTranslator(acceleration: .mac, scrollAcceleration: .scroll)

    override func viewDidLoad() {
        super.viewDidLoad()
        // Plain system palette so the cards and canvas live in the same
        // tonal family in both modes. The earlier grouped palette
        // inverted in light mode (grey canvas, white cards) which read
        // as "sheets of paper pasted on a grey wall". Card definition
        // in light mode comes from .separator hairlines, not luminance
        // jump.
        view.backgroundColor = .systemBackground
        configureViews()
        agentSaySynthesizer.delegate = self
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

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        triggerSessionIfPaired()
    }

    @objc func applicationWillEnterForeground() {
        triggerSessionIfPaired()
    }

    // R13.1: on background, tear down both transports explicitly. iOS
    // suspends the app and the WebRTC PC / input WS quietly die in
    // some network conditions; if we don't flip state here, foreground
    // sees state=.connected and triggerSessionIfPaired short-circuits,
    // leaving the user with a zombie session that produces no input
    // and no video. Closing here forces state to .pairedDisconnected
    // so the next foreground reliably re-attempts.
    @objc func applicationDidEnterBackground() {
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
        cursorTask?.cancel()
        cursorTask = nil
        stopAgentSayForegroundPresentation()
        teardownMediaTransport()
        // Closes activeSignaling + activeInputChannel and flips state
        // .connected -> .pairedDisconnected. Idempotent for other
        // states.
        pairingClient.handleMediaSessionFailed()
        render()
    }

    func triggerSessionIfPaired() {
        guard case .pairedDisconnected = pairingClient.state else { return }
        sessionTask?.cancel()
        sessionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await self.pairingClient.attemptSession()
            } catch {
                // PairingClient.attemptSession already set the state.
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
        cursorTask?.cancel()
        agentSayTask?.cancel()
        agentSaySpeechTask?.cancel()
        agentSayHideTask?.cancel()
        mediaTransport?.stop()
    }

    func startMediaTransportIfNeeded() {
        guard mediaTransport == nil,
              let signaling = pairingClient.activeSignaling else { return }
        let mode = pairingClient.activeMediaMode
        let activePlanes = pairingClient.activeMediaPlanes
        let sink = MediaStack.makeVideoSink(mode: mode, activePlanes: activePlanes)
        let mediaFactory = MediaStack.makeFactory(
            mode: mode,
            host: pairingClient.activeHost,
            port: pairingClient.activePort,
            active: activeSessionForMedia(),
            mediaCapability: pairingClient.activeMediaCapability,
            urlSession: pairingClient.mediaURLSession
        )
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
                videoSources: nil,
                videoSinks: VideoPlaneSinks([
                    .detail: sink,
                    .motion: sink
                ])
            )
        }
    }

    private func activeSessionForMedia() -> ActiveSession? {
        if case .connected(let active) = pairingClient.state {
            return active
        }
        return nil
    }

    func handleMediaConnectionState(_ state: MediaConnectionState) {
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

    func failMediaSession() {
        teardownMediaTransport()
        pairingClient.handleMediaSessionFailed()
        render()
    }

    func teardownMediaTransport() {
        mediaTransport?.stop()
        mediaTransport = nil
        videoSink?.view.removeFromSuperview()
        videoSink = nil
        sinkScrollView?.removeFromSuperview()
        sinkScrollView = nil
        cursorDotView?.removeFromSuperview()
        cursorDotView = nil
        cursorSourcePos = nil
        activeDisplayRect = .zero
        activeDisplayIdMirror = nil
        hideTrackpad()
    }

    // R23: orientation flip. The coordinator's animate block aligns
    // the constraint swap with the system-driven rotation animation so
    // the layout interpolates cleanly. Zoom is reset to 1.0 because
    // the aspect-fit padding of the video (and therefore the
    // contentOffset that makes any zoomed region land sensibly) is
    // fundamentally different after the aspect flip.
    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        let willBeLandscape = size.width > size.height
        coordinator.animate(alongsideTransition: { _ in
            self.applyOrientationConstraints(forLandscape: willBeLandscape)
            self.sinkScrollView?.setZoomScale(1.0, animated: false)
            self.sinkScrollView?.setContentOffset(.zero, animated: false)
            self.updateOrientationToggleIcon(forLandscape: willBeLandscape)
            self.view.layoutIfNeeded()
        })
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        guard traitCollection.userInterfaceStyle != previousTraitCollection?.userInterfaceStyle else { return }
        // CALayer.borderColor is a CGColor and does not auto-resolve
        // dynamic UIColors on appearance changes the way
        // UIView.backgroundColor does. Re-resolve each card border so
        // toggling Light/Dark updates them instantly instead of leaving
        // stale hairlines from the previous mode.
        let resolved = UIColor.separator.cgColor
        for layer in [trackpadView.layer, scrollStripView.layer, rightClickButton.layer, showKeyboardButton.layer, keyboardSurface.layer] {
            if layer.borderWidth > 0 {
                layer.borderColor = resolved
            }
        }
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

        agentSayBanner.translatesAutoresizingMaskIntoConstraints = false
        agentSayBanner.isHidden = true
        agentSayBanner.alpha = 0
        agentSayBanner.numberOfLines = 3
        agentSayBanner.font = .preferredFont(forTextStyle: .subheadline)
        agentSayBanner.textColor = .label
        agentSayBanner.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.92)
        agentSayBanner.layer.cornerRadius = 10
        agentSayBanner.layer.borderWidth = 0.5
        agentSayBanner.layer.borderColor = UIColor.separator.cgColor
        agentSayBanner.layer.masksToBounds = true
        agentSayBanner.textAlignment = .left
        agentSayBanner.accessibilityIdentifier = "agent-say-banner"

        view.addSubview(statusLabel)
        view.addSubview(actionButton)
        view.addSubview(forgetButton)
        view.addSubview(agentSayBanner)

        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -24),
            actionButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 18),
            actionButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            forgetButton.topAnchor.constraint(equalTo: actionButton.bottomAnchor, constant: 12),
            forgetButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            agentSayBanner.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            agentSayBanner.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            agentSayBanner.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16)
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

    func render() {
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
        // A fresh pair URL supersedes whatever state we're in.
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

    func stopCamera() {
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
