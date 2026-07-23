import AVFoundation
import OSLog
import UIKit
import AgentDeskWire

// Pairing + session lifecycle owner. The view controller threads three
// concerns: the pairing screen (status label, action button, QR camera),
// the state-machine render, and the owned media session start/teardown.
// Layout / orientation, keyboard, edge-follow, and gesture forwarding
// live in companion extensions under PairingViewController+*.swift. All
// stored properties stay here; extensions reach them as same-module
// internal access.

final class PairingViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    private let sessionLogger = Logger(subsystem: Config.logSubsystem, category: "session-quic")
    let pairingClient = PairingClient()
    // ADR-0019: listens for a Mac-pushed pairing offer while unpaired and
    // foregrounded. Started/stopped from render() and the background hook.
    var pairingOfferListener: PairingOfferListener?
    private let statusLabel = UILabel()
    private let actionButton = UIButton(type: .system)
    private let forgetButton = UIButton(type: .system)
    // Set when the user taps Disconnect in settings: end the session but stay paired,
    // and suppress the foreground auto-reconnect until they tap Connect (or relaunch,
    // which resets this in-memory flag). Distinguishes a deliberate disconnect from a
    // transient drop, which should still auto-reconnect.
    private var userRequestedDisconnect = false
    var captureSession: AVCaptureSession?
    var previewLayer: AVCaptureVideoPreviewLayer?
    var handshakeTask: Task<Void, Never>?
    var sessionTask: Task<Void, Never>?
    var sessionAttemptGeneration: UInt64 = 0
    var mediaTransport: MediaTransport?
    var videoSink: VideoFrameSink?
    var preservesSuspendedSessionSurfaces = false
    var activeControlSurface: ControlSurface = .control
    // R21: pinch-zoom container around the owned media sink. Local-only zoom
    // via UIScrollView transform; ADR-0008 dropped the host-side
    // sourceRect crop path in favour of native-pixel encoder density.
    var sinkScrollView: UIScrollView?
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
    var pendingCursorRetarget: CursorViewportRetarget?
    var isManualViewportPanActive = false
    // Continuous pan-follow (Option E). Active only during a manual zoomed pan.
    var panFollowActive = false
    var panFollowAnchor: CGPoint?
    var lastSentPanFollowHostPoint: CGPoint?
    var panFollowEdgeAxes: PanFollowOverscrollAxes = []
    var panFollowEdgeReturnAxes: PanFollowOverscrollAxes = []
    var lastPanFollowGestureTranslation: CGPoint?
    // Local cursor overlay. Moves immediately from cursorSourcePos on
    // every gesture delta so the user sees instant cursor response
    // without waiting for the Mac -> owned media -> iOS video round-trip.
    var cursorDotView: CursorPointerView?
    // Live media diagnostics readout (fps/kbps/gap). Fixed chrome pinned to the root view,
    // like settingsButton and cursorDotView, so it never rides the sink's pinch-zoom/pan.
    // The sink publishes status into it via onOwnedMediaStatusChange.
    var mediaDiagnosticsLabel: UILabel?
    var hostAvailabilityLabel: UILabel?
    // Cursor-image mirror state. The host pushes the real cursor glyph on
    // shape change; we cache it and stamp it at the predicted position.
    // Defaults describe the drawn-arrow fallback (tip hotspot, small size).
    let cursorImageStore = CursorImageStore()
    var cursorTask: Task<Void, Never>?
    var cursorReconciliationTask: Task<Void, Never>?
    var cursorConfirmationTask: Task<Void, Never>?
    // Main-actor-created task chain. Each event waits for the prior send, so
    // cursor revision order is also the order presented to the QUIC stream.
    var inputSendTailTask: Task<Void, Never>?
    var cursorReconciliation = CursorReconciliationStateMachine(
        confirmationTimeout: Double(Config.cursorConfirmationTimeoutMs) / 1_000
    )
    var hostAvailabilityTask: Task<Void, Never>?
    var textInputFocusTask: Task<Void, Never>?
    var keyboardPendingTimeoutTask: Task<Void, Never>?
    var diagnosticsTask: Task<Void, Never>?
    var cursorHotspotFrac: CGPoint = .zero
    var cursorRenderSize: CGSize = CursorPointerView.pointerSize
    var cursorHidden = false
    var lastCursorKind: CursorKind = .unknown
    var lastHostTextInputFocus = HostTextInputFocusPush(
        editability: .ambiguous,
        secure: false,
        source: .none
    )
    var mediaStateTask: Task<Void, Never>?
    var iceGraceTask: Task<Void, Never>?
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
    // Toggles the half-screen gesture panel (camera + swipe tracker for desktop
    // switching) below the video. Sits left of the orientation toggle.
    let gestureToggleButton = UIButton(type: .system)
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
    // Touch mode control (bottom row) and the recognizers installed
    // on the video surface while video touch input is active. See
    // PairingViewController+VideoTouch.swift.
    let remoteInputModeControl = RemoteInputModeControl()
    var videoTouchScrollRecognizer: UIPanGestureRecognizer?
    var videoTouchTapRecognizer: UITapGestureRecognizer?
    var videoDoubleTapZoomRecognizer: UITapGestureRecognizer?
    // R25: merged Spaces band. Replaces the old dots band.
    let displayRailView = DisplayRailView()
    let thumbnailStripView = ThumbnailStripView()
    var thumbnailsTask: Task<Void, Never>?
    var topWindowsTask: Task<Void, Never>?
    // Most-recent DesktopState mirrored so the strip can re-render when
    // a thumbnails-push arrives without DesktopState changing, or when
    // the settings toggle flips after a state has already landed.
    var lastDesktopState: DesktopState?
    var selectedDisplayIdForClientConfig: String?
    // R12.3: hidden first-responder that backs the iOS soft keyboard.
    let keyboardSurface = KeyboardSurface()
    var keyboardPresentationState: KeyboardPresentationState = .hidden
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
    var fullPortraitConstraints: [NSLayoutConstraint] = []
    var fullLandscapeConstraints: [NSLayoutConstraint] = []
    var currentUsesFullLayout: Bool?
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
        ClientDiagnostics.shared.record(type: "applicationWillEnterForeground", fields: [:], level: .info)
        triggerSessionIfPaired()
    }

    // R13.1: on background, suspend transport explicitly while retaining the
    // mounted surfaces. iOS suspends the app and the media / input connections
    // quietly die in some network conditions; if we don't flip state here,
    // foreground sees state=.connected and triggerSessionIfPaired
    // short-circuits, leaving the user with a zombie session that produces no
    // input and no video. Closing here forces state to .pairedDisconnected so
    // the next foreground reliably re-attempts.
    @objc func applicationDidEnterBackground() {
        ClientDiagnostics.shared.record(type: "applicationDidEnterBackground", fields: [:], level: .info)
        if case .connected = pairingClient.state {
            preservesSuspendedSessionSurfaces = true
        }
        cancelSessionAttempt()
        handshakeTask?.cancel()
        handshakeTask = nil
        iceGraceTask?.cancel()
        iceGraceTask = nil
        mediaStateTask?.cancel()
        mediaStateTask = nil
        desktopStateTask?.cancel()
        desktopStateTask = nil
        thumbnailsTask?.cancel()
        thumbnailsTask = nil
        topWindowsTask?.cancel()
        topWindowsTask = nil
        cursorTask?.cancel()
        cursorTask = nil
        cursorReconciliationTask?.cancel()
        cursorReconciliationTask = nil
        cursorConfirmationTask?.cancel()
        cursorConfirmationTask = nil
        inputSendTailTask?.cancel()
        inputSendTailTask = nil
        hostAvailabilityTask?.cancel()
        hostAvailabilityTask = nil
        textInputFocusTask?.cancel()
        textInputFocusTask = nil
        keyboardPendingTimeoutTask?.cancel()
        keyboardPendingTimeoutTask = nil
        diagnosticsTask?.cancel()
        diagnosticsTask = nil
        agentSayTask?.cancel()
        agentSayTask = nil
        stopAgentSayForegroundPresentation()
        suspendMediaTransportForBackground()
        // The offer listener only makes sense in the foreground; iOS would tear
        // the NWListener down on suspend anyway, so stop it explicitly.
        stopOfferListener()
        // Closes the active QUIC session transport and flips state
        // .connected -> .pairedDisconnected. Idempotent for other
        // states.
        pairingClient.handleMediaSessionFailed()
        render()
    }

    func triggerSessionIfPaired() {
        guard sessionTask == nil else { return }
        // A user-requested disconnect stays down until they explicitly reconnect.
        guard !userRequestedDisconnect else { return }
        guard case .pairedDisconnected = pairingClient.state else { return }
        sessionAttemptGeneration &+= 1
        let generation = sessionAttemptGeneration
        sessionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.sessionAttemptGeneration == generation {
                    self.sessionTask = nil
                }
            }
            var shouldDelay = false
            while !Task.isCancelled, self.sessionAttemptGeneration == generation {
                guard case .pairedDisconnected = self.pairingClient.state else { return }
                if shouldDelay {
                    try? await Task.sleep(
                        nanoseconds: UInt64(Config.sessionReconnectRetryDelayMs) * 1_000_000
                    )
                    guard !Task.isCancelled, self.sessionAttemptGeneration == generation else { return }
                    guard case .pairedDisconnected = self.pairingClient.state else { return }
                }
                do {
                    _ = try await self.pairingClient.attemptSession()
                    guard self.sessionAttemptGeneration == generation else { return }
                    if let channel = self.pairingClient.activeInputChannel {
                        self.startDiagnosticsHandlingIfNeeded(channel: channel)
                        self.sendReconnectDiagnosticsAnnouncementIfNeeded(channel: channel)
                        self.sendCurrentClientConfig()
                    }
                    self.render()
                    return
                } catch is CancellationError {
                    return
                } catch {
                    guard self.sessionAttemptGeneration == generation else { return }
                    // PairingClient.attemptSession already reset the state for
                    // transient failures. Keep retrying while foregrounded so a
                    // launch-time duplicate lifecycle callback cannot strand the
                    // app at "Paired (reconnecting)" after one pre-handshake drop.
                    self.sessionLogger.notice(
                        "session reconnect attempt failed: \(String(describing: error), privacy: .public)"
                    )
                    self.render()
                    shouldDelay = true
                }
            }
        }
    }

    func cancelSessionAttempt() {
        sessionAttemptGeneration &+= 1
        sessionTask?.cancel()
        sessionTask = nil
    }

    deinit {
        handshakeTask?.cancel()
        sessionTask?.cancel()
        mediaStateTask?.cancel()
        iceGraceTask?.cancel()
        desktopStateTask?.cancel()
        cursorTask?.cancel()
        cursorReconciliationTask?.cancel()
        cursorConfirmationTask?.cancel()
        inputSendTailTask?.cancel()
        hostAvailabilityTask?.cancel()
        diagnosticsTask?.cancel()
        agentSayTask?.cancel()
        agentSaySpeechTask?.cancel()
        agentSayHideTask?.cancel()
        mediaTransport?.stop()
        pairingOfferListener?.stop()
    }

    func startMediaTransportIfNeeded() {
        guard mediaTransport == nil,
              let transport = pairingClient.activeSessionTransport else { return }
        preservesSuspendedSessionSurfaces = false
        let sink: VideoFrameSink
        if let existing = videoSink {
            sink = existing
        } else {
            sink = MediaStack.makeVideoSink()
            videoSink = sink
            mountSinkView(sink.view)
        }
        videoSink = sink
        mediaTransport = transport
        if let owned = sink as? any OwnedMediaFrameSink {
            owned.onOwnedMediaStatusChange = { [weak self] status in
                self?.mediaDiagnosticsLabel?.text = status.labelText
            }
            owned.setOwnedMediaStatus(.connecting)
        }
        showTrackpad()

        mediaStateTask?.cancel()
        mediaStateTask = Task { [weak self, transport] in
            for await state in transport.connectionState {
                await MainActor.run {
                    self?.handleMediaConnectionState(state)
                }
            }
        }

        Task { [transport, sink] in
            try? await transport.start(
                videoSource: nil,
                videoSink: sink
            )
        }
        ClientDiagnostics.shared.record(type: "mediaTransportStarted", fields: [:], level: .default)
    }

    private func activeSessionForMedia() -> ActiveSession? {
        if case .connected(let active) = pairingClient.state {
            return active
        }
        return nil
    }

    func handleMediaConnectionState(_ state: MediaConnectionState) {
        ClientDiagnostics.shared.record(
            type: "mediaConnectionState",
            fields: ["state": String(describing: state)],
            level: .info
        )
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
        case .failed(let rejection):
            iceGraceTask?.cancel()
            iceGraceTask = nil
            if let rejection {
                failMediaSession(rejection: rejection)
            } else {
                failMediaSession()
            }
        case .closed:
            iceGraceTask?.cancel()
            iceGraceTask = nil
            applyHostAvailability(HostAvailabilityPush(
                availability: .captureUnavailable,
                reason: "media-closed"
            ))
        }
    }

    func failMediaSession(rejection: SessionRejected? = nil) {
        if let rejection {
            let closeTask = agentTerminalLifecycleRouter.route(
                .rejection(rejection.reason),
                to: agentSurface
            )
            Task { @MainActor [weak self] in
                await closeTask?.value
                guard let self else { return }
                self.teardownMediaTransport()
                self.pairingClient.handleMediaSessionFailed(rejection: rejection)
                self.render()
            }
            return
        }

        preservesSuspendedSessionSurfaces = true
        teardownMediaTransport(preservingSessionSurfaces: true)
        pairingClient.handleMediaSessionFailed()
        render()
    }

    func suspendMediaTransportForBackground() {
        agentTerminalLifecycleRouter.route(.background, to: agentSurface)
        mediaTransport?.stop()
        mediaTransport = nil
        mediaDiagnosticsLabel?.text = "media suspended"
        if #available(iOS 26.0, *) {
            terminalSurface?.detach()
        }
    }

    func teardownMediaTransport(preservingSessionSurfaces: Bool = false) {
        preservesSuspendedSessionSurfaces = preservingSessionSurfaces
        if preservingSessionSurfaces {
            agentTerminalLifecycleRouter.route(.transportFailure, to: agentSurface)
        } else {
            teardownAgentSurface()
        }
        mediaTransport?.stop()
        mediaTransport = nil
        videoSink?.view.removeFromSuperview()
        videoSink = nil
        sinkScrollView?.removeFromSuperview()
        sinkScrollView = nil
        mediaDiagnosticsLabel?.removeFromSuperview()
        mediaDiagnosticsLabel = nil
        hostAvailabilityLabel?.removeFromSuperview()
        hostAvailabilityLabel = nil
        cursorDotView?.removeFromSuperview()
        cursorDotView = nil
        cursorSourcePos = nil
        pendingCursorRetarget = nil
        isManualViewportPanActive = false
        panFollowActive = false
        panFollowAnchor = nil
        lastSentPanFollowHostPoint = nil
        panFollowEdgeAxes = []
        panFollowEdgeReturnAxes = []
        lastPanFollowGestureTranslation = nil
        activeDisplayRect = .zero
        activeDisplayIdMirror = nil
        selectedDisplayIdForClientConfig = nil
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
            self.pendingCursorRetarget = nil
            self.isManualViewportPanActive = false
            self.panFollowActive = false
            self.panFollowAnchor = nil
            self.lastSentPanFollowHostPoint = nil
            self.panFollowEdgeAxes = []
            self.panFollowEdgeReturnAxes = []
            self.lastPanFollowGestureTranslation = nil
            self.sinkScrollView?.setZoomScale(1.0, animated: false)
            self.sinkScrollView?.setContentOffset(.zero, animated: false)
            self.updateOrientationToggleIcon(forLandscape: willBeLandscape)
            self.view.layoutIfNeeded()
        }, completion: { _ in
            self.domMirrorSurface?.flushViewerLayout()
            self.agentSurface?.flushViewportResize()
            if #available(iOS 26.0, *) {
                self.terminalSurface?.flushViewportResize()
            }
            self.workspaceSurface?.flushViewportResize()
            self.ideSurface?.flushViewportResize()
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
        actionButton.addTarget(self, action: #selector(actionButtonTapped), for: .touchUpInside)
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

    @objc func forgetHost() {
        // Best-effort: tell the host to drop its pairing record before we tear the
        // input lane down, so both sides forget each other. Await the send so it
        // flushes before clearStoredCredentials() closes the channel; if there is no
        // live channel (already disconnected) the host relies on its own liveness.
        let channel = pairingClient.activeInputChannel
        let terminalCloseTask = agentTerminalLifecycleRouter.route(.forget, to: agentSurface)
        Task { @MainActor [weak self] in
            await terminalCloseTask?.value
            if let channel {
                try? await channel.sendRevoke()
            }
            guard let self else { return }
            self.userRequestedDisconnect = false
            self.cancelSessionAttempt()
            self.handshakeTask?.cancel()
            self.stopCamera()
            self.teardownMediaTransport()
            self.pairingClient.clearStoredCredentials()
            self.render()
        }
    }

    // Settings "Disconnect": end the live session but keep the pairing. Suppress
    // auto-reconnect so it stays down until the user taps Connect. handleMediaSessionFailed
    // closes the session lanes and flips .connected -> .pairedDisconnected without
    // touching stored credentials.
    func disconnectFromHost() {
        guard !userRequestedDisconnect else { return }
        userRequestedDisconnect = true
        preservesSuspendedSessionSurfaces = false
        cancelSessionAttempt()
        handshakeTask?.cancel()
        let terminalCloseTask = agentTerminalLifecycleRouter.route(.disconnect, to: agentSurface)
        Task { @MainActor [weak self] in
            await terminalCloseTask?.value
            guard let self else { return }
            self.teardownMediaTransport()
            self.pairingClient.handleMediaSessionFailed()
            self.render()
        }
    }

    // Pairing-screen "Connect": clear the suppress flag and re-attempt the session.
    @objc func reconnect() {
        userRequestedDisconnect = false
        render()
        triggerSessionIfPaired()
    }

    func render() {
        forgetButton.isHidden = true
        statusLabel.isHidden = false
        // Default label; the .pairedDisconnected user-disconnect case overrides it to
        // "Connect". actionButtonTapped dispatches on the same state it renders.
        actionButton.setTitle("Scan QR", for: .normal)
        switch pairingClient.state {
        case .unpaired:
            statusLabel.text = unpairedStatusText()
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
            if userRequestedDisconnect {
                statusLabel.text = "Disconnected\n\nTap Connect to reconnect."
                actionButton.setTitle("Connect", for: .normal)
                actionButton.isHidden = false
            } else {
                statusLabel.text = "Paired (reconnecting)"
                actionButton.isHidden = true
            }
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

        // The agent-surface toggle is state-driven, not gated on a one-shot
        // channel check: render() runs on every state change so it cannot race
        // the session/channel timing. Background suspend keeps the mounted
        // surfaces visible; explicit non-connected states tear them down.
        if case .connected = pairingClient.state {
            // The switcher exposes Browser as a third segment only when this
            // session opened a .dom lane; the DOM-mirror surface is created and
            // its lane started lazily on first Browser select. If Browser was
            // already active before a background suspend, reconnect rebinds it
            // here to the fresh .dom lane.
            showSurfaceToggleIfNeeded()
            rebindActiveSurfaceAfterReconnect()
            applySurface(activeControlSurface)
            if #available(iOS 26.0, *) {
                terminalSurface?.connect(using: pairingClient.activeSessionTransport)
            }
        } else if preservesSuspendedSessionSurfaces {
            statusLabel.isHidden = true
            actionButton.isHidden = true
            forgetButton.isHidden = true
            showSurfaceToggleIfNeeded()
            applySurface(activeControlSurface)
        } else {
            // teardownAgentSurface owns the switcher and tears down all
            // non-control surfaces (agent + browser).
            teardownAgentSurface()
        }

        startOfferListenerIfNeeded()
        configureOfferListener()
    }

    private func unpairedStatusText() -> String {
        var lines = [
            "AgentDesk",
            "",
            "Open AgentDesk on your Mac and pick this iPhone to pair."
        ]
        if let ip = PairingOfferListener.ownTailnetIPv4() {
            lines.append("")
            lines.append("This device: \(ip)")
        }
        lines.append("")
        lines.append(Self.appVersionLine())
        return lines.joined(separator: "\n")
    }

    // Human-readable build identity so it is obvious which TestFlight build is
    // installed: marketing version, numeric build number, and the embedded short
    // git sha (the actual commit, since the build number must stay numeric).
    static func appVersionLine() -> String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        let sha = (info?["AgentDeskGitSHA"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
        return "v\(short) (\(build)) \(sha)"
    }

    // ADR-0019: receive a Mac-pushed offer and run it through the same path as a
    // scanned QR code. The offer carries a PairingPayload; synthesizing its
    // pairing URL lets handleIncomingPairingURL drive the unchanged handshake,
    // which the host auto-approves because it pre-approved this nonce.
    func startOfferListenerIfNeeded() {
        guard pairingOfferListener == nil else { return }
        let listener = PairingOfferListener()
        pairingOfferListener = listener
        configureOfferListener()
        listener.start()
    }

    func stopOfferListener() {
        pairingOfferListener?.stop()
        pairingOfferListener = nil
    }

    private func configureOfferListener() {
        guard let listener = pairingOfferListener else { return }
        switch pairingClient.state {
        case .unpaired, .rejected, .scanning, .pairing, .awaitingApproval:
            listener.localIdentity = DeviceIdentity(displayName: pairingClient.deviceDisplayName())
            listener.onOffer = { [weak self] payload in
                Task { @MainActor in
                    guard let self else { return }
                    do {
                        self.handleIncomingPairingURL(try payload.pairingURL())
                    } catch {
                        ClientDiagnostics.shared.record(
                            type: "pairingOfferMalformed",
                            fields: ["error": String(describing: error)],
                            level: .error
                        )
                    }
                }
            }
        default:
            listener.localIdentity = nil
            listener.onOffer = nil
        }
        listener.storedPairingRecordProvider = { [weak self] in
            self?.pairingClient.storedPairingMaterial
        }
        listener.diagnosticsResponseProvider = { request in
            ClientDiagnostics.shared.prepareResponse(for: request)
        }
    }

    private func startDiagnosticsHandlingIfNeeded(channel: InputChannel) {
        diagnosticsTask?.cancel()
        diagnosticsTask = Task { [weak self, channel] in
            for await update in channel.diagnosticsUpdates {
                guard let self else { return }
                switch update {
                case .request(let request):
                    await self.respondToDiagnosticsRequest(request, on: channel)
                }
            }
        }
    }

    private func sendReconnectDiagnosticsAnnouncementIfNeeded(channel: InputChannel) {
        guard let summary = ClientDiagnostics.shared.reconnectAnnouncementSummary() else { return }
        Task {
            try? await channel.sendDiagnosticsSummary(summary)
        }
    }

    private func respondToDiagnosticsRequest(_ request: DiagnosticsRequest, on channel: InputChannel) async {
        switch ClientDiagnostics.shared.prepareResponse(for: request) {
        case .failure(let error):
            try? await channel.sendDiagnosticsError(error)
        case .success(let prepared):
            switch await sendPreparedDiagnosticsResponse(prepared, on: channel) {
            case .delivered(let delivered):
                ClientDiagnostics.shared.completeResponse(delivered)
            case .failed:
                ClientDiagnostics.shared.record(
                    type: "diagnosticsResponseSendFailed",
                    fields: ["requestId": request.requestId],
                    level: .error
                )
            }
        }
    }

    private func sendPreparedDiagnosticsResponse(
        _ prepared: ClientDiagnosticsPreparedResponse,
        on channel: InputChannel
    ) async -> ClientDiagnosticsSendResult {
        do {
            try await channel.sendDiagnosticsSummary(prepared.summary)
            for chunk in prepared.chunks {
                try await channel.sendDiagnosticsChunk(chunk)
            }
            return .delivered(prepared)
        } catch {
            return .failed
        }
    }

    func handleIncomingPairingURL(_ url: URL) {
        // A fresh pair URL supersedes whatever state we're in.
        cancelSessionAttempt()
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

    // The action button is dual-purpose: "Scan QR" when unpaired/revoked/rejected,
    // "Connect" when the user disconnected. Dispatch on the same state render() drew.
    @objc private func actionButtonTapped() {
        if case .pairedDisconnected = pairingClient.state, userRequestedDisconnect {
            reconnect()
        } else {
            startScanning()
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
