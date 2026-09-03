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
    var keyboardDictationCoordinator: KeyboardDictationCoordinator?
    var keyboardDictationSnapshotObservationID: UUID?
    weak var keyboardDictationServiceViewController:
        KeyboardDictationHandoffViewController?
    // One replaceable root for the pairing flow and every host-backed
    // descendant. Voice is its sibling, so selecting Voice removes this
    // complete tree from rendering, accessibility, and hit testing
    // without tearing down the live host transport.
    let hostContentView = UIView()
    // The z-order bands inside that root, back to front. Reached through
    // `stage(_:)` rather than by name at the mount sites, so the decision
    // recorded there is which band a view belongs to. See HostContentStage.
    let backdropStage = PassthroughView()
    let chromeStage = PassthroughView()
    let surfaceStage = PassthroughView()
    let overlayStage = PassthroughView()
    // ADR-0019: listens for a Mac-pushed pairing offer while unpaired and
    // foregrounded. Started/stopped from render() and the background hook.
    var pairingOfferListener: PairingOfferListener?
    /// The three policy inputs that are not `pairingClient.state` all carry an observer, for the
    /// same reason the state does: if each mutation site had to remember to signal, the
    /// supervisor would just be the old forgetfulness moved one level up.
    var isClientForeground = true {
        didSet { if oldValue != isClientForeground { sessionSupervisor?.signal() } }
    }
    private let statusLabel = UILabel()
    private let actionButton = UIButton(type: .system)
    private let forgetButton = UIButton(type: .system)
    // Set when the user taps Disconnect in settings: end the session but stay paired,
    // and suppress the foreground auto-reconnect until they tap Connect (or relaunch,
    // which resets this in-memory flag). Distinguishes a deliberate disconnect from a
    // transient drop, which should still auto-reconnect.
    /// Internal rather than private: the Reconnect button lives in the gestures extension and
    /// must clear this, or an explicit disconnect would leave the button visibly inert.
    var userRequestedDisconnect = false {
        didSet { if oldValue != userRequestedDisconnect { sessionSupervisor?.signal() } }
    }
    var captureSession: AVCaptureSession?
    var previewLayer: AVCaptureVideoPreviewLayer?
    var handshakeTask: Task<Void, Never>?
    /// The single owner of the dial. Built in `setUp` and never rebuilt; backgrounding closes
    /// its gate rather than stopping it.
    var sessionSupervisor: SessionSupervisor?
    /// Re-entrancy guard for `render()`. It is not a pure view function -- it starts the offer
    /// listener, mounts and tears down surfaces, and forces layout -- and now that a state
    /// change calls it, a callee that reaches a state mutation would recurse. Coalesce instead.
    private var isRendering = false
    private var needsRerender = false
    // Why the last dial failed, and how many in a row have failed the same way. The reconnect
    // loop never gives up, so without these the screen says "Paired (reconnecting)" identically
    // for a two-second blip and for a Mac whose host process died and is not coming back.
    var lastSessionFailureCause: SessionFailureCause?
    var consecutiveSessionFailures = 0
    var mediaTransport: MediaTransport?
    var videoSink: VideoFrameSink?
    var preservesSuspendedSessionSurfaces = false
    var activeControlSurface: ControlSurface = .control {
        didSet { if oldValue != activeControlSurface { sessionSupervisor?.signal() } }
    }
    // Restored from settings at construction rather than defaulted open: the bar lies on the
    // Mac's own menu bar, so a run that starts with it closed has to stay closed.
    let desktopViewerTabBar = DesktopViewerTabBar(
        isExpanded: SettingsStore.shared.desktopViewerTabsExpanded
    )
    // The bar collapses to a pull tab and expands on demand, so its height is driven by
    // `preferredHeight` rather than being a fixed row -- the same shape as the two strips.
    var desktopViewerTabBarHeightConstraint: NSLayoutConstraint?
    var desktopViewerMode: DesktopViewerMode = .native
    var desktopWebSurface: DesktopWebSurface?
    // R21: pinch-zoom container around the owned media sink. Local-only zoom
    // via UIScrollView transform; ADR-0008 dropped the host-side
    // sourceRect crop path in favour of native-pixel encoder density.
    var sinkScrollView: UIScrollView?
    // The zoomed view inside that scroll view, sized to the picture rather than to the
    // scroll's frame. Held explicitly because the difference between the two is now
    // load-bearing for every cursor projection, and `subviews.first` also matches the
    // scroll indicators.
    var sinkContentView: UIView?
    // Swapped for `sinkAspectConstraint` once a display arrives; see applySinkAspectRatio.
    var sinkFillHeightConstraint: NSLayoutConstraint?
    var sinkAspectConstraint: NSLayoutConstraint?
    // Zero while the rail has nothing to draw; see updateDisplayRailHeight.
    var displayRailHeightConstraint: NSLayoutConstraint?
    static let sinkMaxZoomScale: CGFloat = 4.0
    // Where a double tap lands, whether it came from the picture or from pointer mode's puck.
    // 2x was barely worth the tap on a phone showing a whole Mac display: the point of zooming
    // is to read something, and half the ceiling did not get there. Still short of the 4x
    // ceiling so a pinch has somewhere left to go.
    static let sinkDoubleTapZoomScale: CGFloat = 2.5
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
    // The sink publishes status into it via onOwnedMediaStatusChange, whether or not the
    // user has collapsed it -- the readout is current the moment it is reopened.
    var mediaDiagnosticsPill: MediaDiagnosticsPill?
    /// Host status: what the session is doing when it is not simply showing the Mac. Owns the
    /// spinner, the message, and the last-resort escape from a session the client thinks is
    /// live and the host has ended (see `reconnectTapped`). Centered on the root view's safe
    /// area, deliberately not on the video, so what it says stays readable no matter what the
    /// video is doing.
    var hostStatusOverlay: HostStatusOverlay?
    /// What the client is doing with the session. Outranks the host's availability while a
    /// recovery is in flight, because there is no host connection for an availability value to
    /// have come from then. See `HostStatusPresentation.resolve`.
    var hostSessionActivity: HostSessionActivity = .live
    // Carries the connect message across the gap between session connect and the
    // first drawable frame; see VideoStartupBanner.
    var videoStartupBanner = VideoStartupBanner()
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
    // Unlike ordinary pointer and keyboard input, reviewed dictation must not
    // report success until its whole key batch has written to the input lane.
    // Keep the throwing task so teardown and an abandoned sheet can cancel it.
    var dictationInputSendTask: Task<Void, Error>?
    var cursorReconciliation = CursorReconciliationStateMachine(
        confirmationTimeout: Double(Config.cursorConfirmationTimeoutMs) / 1_000
    )
    var hostAvailabilityTask: Task<Void, Never>?
    var textInputFocusTask: Task<Void, Never>?
    var keyboardPendingTimeoutTask: Task<Void, Never>?
    var diagnosticsTask: Task<Void, Never>?
    var screenshotTask: Task<Void, Never>?
    let screenshotCapturer = ClientScreenshotCapturer()
    var screenshotToastTask: Task<Void, Never>?
    weak var screenshotToastLabel: UILabel?
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
    /// ADR-0104: delays the "Reconnecting…" overlay so a fast carrier swap is invisible.
    var reattachOverlayTask: Task<Void, Never>?
    // R11: observes the input channel's desktopStateUpdates stream and pushes each
    // DesktopState into the strip. Cancelled on background, restarted by the next successful
    // dial.
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
    let voiceToggleButton = UIButton(type: .system)
    let keyboardDictationServiceButton = UIButton(type: .system)
    // R24: orientation toggle. Synthesises a UIWindowScene geometry update when tapped.
    let orientationToggleButton = UIButton(type: .system)
    // Toggles the half-screen gesture panel (camera + swipe tracker for desktop
    // switching) below the video.
    let gestureToggleButton = UIButton(type: .system)
    lazy var surfaceControlRail = SurfaceControlRail(
        gestureButton: gestureToggleButton,
        orientationButton: orientationToggleButton,
        voiceButton: voiceToggleButton,
        keyboardDictationButton: keyboardDictationServiceButton,
        settingsButton: settingsButton
    )
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
    let keyboardDictationGroup = UIStackView()
    let showKeyboardButton = UIButton(type: .system)
    let dictationButton = UIButton(type: .system)
    // Touch mode control (bottom row) and the recognizers installed
    // on the video surface while video touch input is active. See
    // PairingViewController+VideoTouch.swift.
    let remoteInputModeControl = RemoteInputModeControl()
    // On the picture: Touch mode's absolute tap and drag, which mean "the host point under
    // this finger" and so have nothing to say about the letterbox.
    var videoTouchScrollRecognizer: UIPanGestureRecognizer?
    var videoTouchTapRecognizer: UITapGestureRecognizer?
    // On the scroll view: pointer mode's relative drag, its tap, and its two-finger scroll.
    // None of the three asks what is under the finger, so all three work on the black bands
    // the picture does not cover.
    var videoPointerPanRecognizer: UIPanGestureRecognizer?
    var videoPointerTapRecognizer: UITapGestureRecognizer?
    var videoTwoFingerScrollRecognizer: UIPanGestureRecognizer?
    var videoDoubleTapZoomRecognizer: UITapGestureRecognizer?
    // The resolved gesture routing for the current mode. Written by applyVideoTouchState and
    // read by the per-frame handlers, so a 120Hz drag is not re-deciding what it means.
    var videoGestureConfig: VideoTouchGestureConfig?
    // Pointer mode's floating scroll clutch, and the offsets a drag of it has accumulated.
    // Offsets rather than a frame, so the puck keeps its place through a rotation instead of
    // landing wherever its absolute coordinates now point.
    var pointerScrollPuck: PointerScrollPuck?
    var pointerScrollPuckOffsetX: NSLayoutConstraint?
    var pointerScrollPuckOffsetY: NSLayoutConstraint?
    // R25: merged Spaces band. Replaces the old dots band.
    let displayRailView = DisplayRailView()
    let thumbnailStripView = ThumbnailStripView()
    let windowPickerStripView = WindowPickerStripView()
    var thumbnailsTask: Task<Void, Never>?
    var topWindowsTask: Task<Void, Never>?
    var windowListTask: Task<Void, Never>?
    var agentPanelOriginTask: Task<Void, Never>?
    // nil = watching the whole selected display. Non-nil rides ClientConfig and makes the
    // host stream that window alone, view-only.
    var selectedWindowIdForClientConfig: UInt32?
    // Most-recent DesktopState mirrored so the strip can re-render when
    // a thumbnails-push arrives without DesktopState changing, or when
    // the settings toggle flips after a state has already landed.
    var lastDesktopState: DesktopState?
    var selectedDisplayIdForClientConfig: String?
    // R12.3: hidden first-responder that backs the iOS soft keyboard.
    let keyboardSurface = KeyboardSurface()
    var keyboardPresentationState: KeyboardPresentationState = .hidden
    var buttonRowBottomConstraint: NSLayoutConstraint?
    var buttonRowHeightConstraint: NSLayoutConstraint?
    // Both strips collapse to a bar and expand on demand, so their heights are driven by each
    // strip's `preferredHeight` rather than being fixed rows.
    var thumbnailStripHeightConstraint: NSLayoutConstraint?
    var windowPickerStripHeightConstraint: NSLayoutConstraint?
    var dismissKeyboardTap: UITapGestureRecognizer?
    // R23: orientation-variant constraints, one set active at a time.
    // viewWillTransition swaps them inside the rotation coordinator's animator
    // block. `buildSessionLayoutConstraints` is their only producer, and it
    // derives all four from scratch, so no caller ever appends to them; see
    // `reconcileSessionLayout`. The shared (orientation-invariant) constraints
    // stay active for the entire session and aren't tracked here.
    var portraitConstraints: [NSLayoutConstraint] = []
    var landscapeConstraints: [NSLayoutConstraint] = []
    var currentIsLandscape: Bool?
    var fullPortraitConstraints: [NSLayoutConstraint] = []
    var fullLandscapeConstraints: [NSLayoutConstraint] = []
    var currentUsesFullLayout: Bool?
    var sessionLayoutConstraints = SessionLayoutConstraints()
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
        // ADR-0104: a carrier death PairingClient notices on its own (the input stream
        // closing) runs the same keep-surfaces-and-redial path as one the media transport
        // reports. Before this, the input-close path parked at `.pairedDisconnected` until
        // the next foreground -- the one carrier loss with no recovery trigger.
        pairingClient.onCarrierLost = { [weak self] in
            guard let self else { return }
            self.hostSessionActivity = .reattaching
            self.preservesSuspendedSessionSurfaces = true
            self.teardownMediaTransport(preservingSessionSurfaces: true)
            // Render, but do not dial. The caller sets `.pairedDisconnected` BEFORE firing this,
            // so the observer has already signalled the supervisor, which sees `.clean` (a
            // healthy session cleared the rung) and dials at once -- ADR-0089's "re-dial NOW"
            // survives as a property of the policy rather than as a call nobody must delete.
            // MainActor serialisation puts this teardown ahead of that dial.
            //
            // The render IS needed: the observer fired before the three lines above ran, so it
            // drew the pre-teardown UI.
            self.render()
        }
        pairingClient.onStateChanged = { [weak self] in
            guard let self else { return }
            self.render()
            self.sessionSupervisor?.signal()
        }
        startSessionSupervisor()
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
        sessionSupervisor?.signal()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        recordRuntimeUICheckpoint(
            layoutReady: surfaceControlRail.bounds.width > 0
                && surfaceControlRail.bounds.height > 0
        )
        // The picture is sized from the scroll frame, so a rotation or a strip that just
        // resized the video box changes how much empty frame is left to centre it in.
        alignSinkContent()
    }

    @objc func applicationWillEnterForeground() {
        isClientForeground = true
        ClientRuntimeTelemetry.shared.updateScenePhase(.foreground)
        ClientDiagnostics.shared.record(type: "applicationWillEnterForeground", fields: [:], level: .info)
        // Unconditionally, and not because the state changed -- it did not. Background stopped
        // the offer listener and left "media suspended" on the pill, and
        // `startOfferListenerIfNeeded` is reachable only from `render()`, so without this the
        // listener stayed down until something else happened to render, which on a foreground
        // that fails to dial is never. That is the state where the host-initiated path is the
        // last way back in, and it is also the state where `just client-diagnostics` needs the
        // listener for its offer-port fallback: the one moment worth inspecting was the one
        // moment the client could not be reached. The dial itself needs nothing here; setting
        // `isClientForeground` above reopened the supervisor's gate.
        //
        // Unconditional, and before the dial. iOS reclaims the hardware decoder from a
        // backgrounded app, so the sink we are about to hand to the next transport cannot
        // decode until it flushes, and a flush empties the picture buffer that every delta on
        // the wire is predicted from. The host cannot infer this: an acknowledged long-term
        // reference stays acknowledged forever, so unless we say the references are gone it
        // answers the resync with a delta we cannot decode, we ask again, and it answers the
        // same way. That loop is what left the picture black until a force quit (R230).
        //
        // Safe with no session up: the sink flushes now and the request waits, armed, for a
        // transport to carry it.
        (videoSink as? any OwnedMediaFrameSink)?.noteDecoderInvalidated(reason: "foreground-resume")
        render()
    }

    // R13.1: on background, suspend transport explicitly while retaining the mounted surfaces.
    // iOS suspends the app and the media / input connections quietly die in some network
    // conditions, so the session state has to be forced down here or the client comes back
    // believing it still holds one. `isClientForeground = false` closes the supervisor's gate,
    // which cancels any dial in flight and parks the loop; it is NOT stopped, because a
    // supervisor that is torn down on background is not there to notice the foreground.
    @objc func applicationDidEnterBackground() {
        isClientForeground = false
        ClientRuntimeTelemetry.shared.updateScenePhase(.background)
        ClientDiagnostics.shared.record(type: "applicationDidEnterBackground", fields: [:], level: .info)
        // Recording is fire-and-forget now, and iOS kills suspended apps without warning, so
        // backgrounding is where the store has to settle. The drain goes with it, under its own
        // background-task assertion: its cadence may never get another tick, and anything
        // logged since the last one lives only in a unified log the next launch cannot read.
        OSLogDrain.shared.drainBeforeSuspension()
        ClientDiagnostics.shared.flush()
        if case .connected = pairingClient.state {
            preservesSuspendedSessionSurfaces = true
        }
        handshakeTask?.cancel()
        handshakeTask = nil
        reattachOverlayTask?.cancel()
        reattachOverlayTask = nil
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
        dictationInputSendTask?.cancel()
        dictationInputSendTask = nil
        hostAvailabilityTask?.cancel()
        hostAvailabilityTask = nil
        textInputFocusTask?.cancel()
        textInputFocusTask = nil
        keyboardPendingTimeoutTask?.cancel()
        keyboardPendingTimeoutTask = nil
        diagnosticsTask?.cancel()
        diagnosticsTask = nil
        screenshotTask?.cancel()
        screenshotTask = nil
        screenshotToastTask?.cancel()
        screenshotToastTask = nil
        screenshotToastLabel?.removeFromSuperview()
        agentSayTask?.cancel()
        agentSayTask = nil
        stopAgentSayForegroundPresentation()
        suspendVoiceSurfaceIfNeeded()
        suspendMediaTransportForBackground()
        // The offer listener only makes sense in the foreground; iOS would tear
        // the NWListener down on suspend anyway, so stop it explicitly.
        stopOfferListener()
        ClientRuntimeTelemetry.shared.setSender(nil)
        ClientDiagnostics.shared.setLiveAnnouncementSender(nil)
        if keyboardDictationCoordinator?.isArmed == true {
            return
        }
        // Closes the active QUIC session transport and flips state
        // .connected -> .pairedDisconnected. Idempotent for other
        // states.
        pairingClient.handleMediaSessionFailed()
        render()
    }

    /// Builds the one supervisor that owns dialing, and starts it. The three closures are the
    /// only things it knows about this client: how to read the world, how to make one attempt,
    /// and how to classify a failure. Everything else -- when to try, how long to wait, whether
    /// to try at all -- is the supervisor's, and is decided by `SessionDialPolicy`.
    func startSessionSupervisor() {
        guard sessionSupervisor == nil else { return }
        let supervisor = SessionSupervisor(
            environment: { [weak self] in
                guard let self else {
                    // Deallocated: describe a world where dialing is not allowed, so the loop
                    // parks rather than acting on a client that is gone.
                    return SessionDialInputs(
                        state: .unpaired,
                        userRequestedDisconnect: true,
                        surface: .control,
                        isForeground: false
                    )
                }
                return SessionDialInputs(
                    state: self.pairingClient.state,
                    userRequestedDisconnect: self.userRequestedDisconnect,
                    surface: self.activeControlSurface,
                    isForeground: self.isClientForeground
                )
            },
            dial: { [weak self] in
                try await self?.performSessionDial()
            },
            onFailure: { [weak self] error in
                self?.classifySessionDialFailure(error) ?? .failed
            }
        )
        sessionSupervisor = supervisor
        supervisor.start()
    }

    /// One dial attempt. Throws on failure; the supervisor owns what happens next.
    private func performSessionDial() async throws {
        // ADR-0104: EVERY dial waits for the path to hold still, not just reattaches. The gate
        // is history-based, so a long-stable path settles instantly and a calm foreground resume
        // pays nothing. The case that made this universal: a foreground wake dialed into a radio
        // still associating, won the race, and minted a carrier that connected in 350ms and then
        // never delivered a byte. Inside the attempt rather than before the loop, so every
        // retry gets the same gate the first try did.
        await SessionPathReadiness.shared.waitUntilSettled()
        try Task.checkCancellation()
        // Re-check after the settle: the plan was computed before it, and a state that moved in
        // between would otherwise earn a backoff rung for a failure that says nothing about the
        // host. Cancellation rather than an error, so the rung is left alone and the loop simply
        // re-reads the world.
        guard pairingClient.state.isDialable else { throw CancellationError() }
        _ = try await pairingClient.attemptSession()
        lastSessionFailureCause = nil
        consecutiveSessionFailures = 0
        if let channel = pairingClient.activeInputChannel {
            ClientRuntimeTelemetry.shared.setSender { checkpoint in
                try await channel.sendRuntimeCheckpoint(checkpoint)
            }
            ClientDiagnostics.shared.setLiveAnnouncementSender { summary in
                try await channel.sendDiagnosticsSummary(summary)
            }
            startDiagnosticsHandlingIfNeeded(channel: channel)
            startScreenshotHandlingIfNeeded(channel: channel)
            sendReconnectDiagnosticsAnnouncementIfNeeded(channel: channel)
            sendCurrentClientConfig()
        }
        // The state change to `.connected` renders on its own. This renders the things that are
        // NOT state: the failure counters the status text reads.
        render()
    }

    /// Which backoff rung a failed attempt earns, and the reporting that goes with it.
    private func classifySessionDialFailure(_ error: Error) -> SessionDialOutcome {
        let cause = SessionFailureCause.classify(error)
        if cause == lastSessionFailureCause {
            consecutiveSessionFailures += 1
        } else {
            lastSessionFailureCause = cause
            consecutiveSessionFailures = 1
        }
        sessionLogger.notice(
            "session reconnect attempt failed cause=\(String(describing: cause), privacy: .public) consecutive=\(self.consecutiveSessionFailures, privacy: .public) error=\(String(describing: error), privacy: .public)"
        )
        // ADR-0104: with no carrier there is no report loop, so this loop is what carries the
        // session's silence clock to its verdict. Without it a dead host would leave the session
        // reattaching forever.
        if let silentMs = pairingClient.sessionSilenceVerdict() {
            ClientDiagnostics.shared.record(
                type: "sessionUnreachable",
                fields: ["silentMs": String(silentMs), "driver": "redial-loop"],
                level: .error
            )
            failMediaSession(loss: .unreachable(silentMs: silentMs))
            return .unreachable
        }
        // Same as the success path: the counters this just moved are not session state, so the
        // status text they feed needs an explicit render.
        render()
        return .failed
    }

    deinit {
        ClientDiagnostics.shared.setLiveAnnouncementSender(nil)
        handshakeTask?.cancel()
        sessionSupervisor?.stop()
        mediaStateTask?.cancel()
        reattachOverlayTask?.cancel()
        desktopStateTask?.cancel()
        cursorTask?.cancel()
        cursorReconciliationTask?.cancel()
        cursorConfirmationTask?.cancel()
        inputSendTailTask?.cancel()
        dictationInputSendTask?.cancel()
        dictationInputSendTask = nil
        hostAvailabilityTask?.cancel()
        diagnosticsTask?.cancel()
        screenshotTask?.cancel()
        screenshotToastTask?.cancel()
        screenshotToastLabel?.removeFromSuperview()
        agentSayTask?.cancel()
        agentSaySpeechTask?.cancel()
        agentSayHideTask?.cancel()
        desktopWebSurface?.teardown()
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
        // Clear the handover overlay here rather than waiting for the host's availability push.
        // The push does arrive on connect and would hide it, but if one is ever missed the
        // overlay would sit permanently over a working session -- and a stuck "Reconnecting…"
        // over live video is a worse failure than a briefly absent one over a frozen frame.
        hostSessionActivity = .live
        reattachOverlayTask?.cancel()
        reattachOverlayTask = nil
        hostStatusOverlay?.apply(.hidden)
        if let owned = sink as? any OwnedMediaFrameSink {
            owned.onOwnedMediaStatusChange = { [weak self] status in
                self?.mediaDiagnosticsPill?.text = status.labelText
                self?.noteOwnedMediaStatus(status)
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
        ClientRuntimeTelemetry.shared.updateMediaState(.started)
        ClientDiagnostics.shared.record(type: "mediaTransportStarted", fields: [:], level: .default)

        // The voice models live on the Mac and reach the phone over this
        // session. Kicked off here rather than from the Voice surface because
        // Voice is otherwise session-free, and making it dial a host just to
        // download would break the one surface that works with no Mac at all.
        if #available(iOS 26.0, *) {
            Task { await VoiceAssetProvisioner.shared.provision(using: transport) }
        }
    }

    /// Let the connected control shell finish its first layout pass before
    /// constructing the media sink. The rail remains usable while video starts.
    func scheduleMediaTransportStartIfNeeded() {
        guard mediaTransport == nil else { return }
        ClientRuntimeTelemetry.shared.resetVideoMilestone()
        ClientRuntimeTelemetry.shared.updateMediaState(.scheduled)
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  self.activeControlSurface != .voice,
                  case .connected = self.pairingClient.state
            else { return }
            self.startMediaTransportIfNeeded()
        }
    }

    /// Applies the active surface's video demand to BOTH of its consumers.
    ///
    /// The only place either one is set. Splitting them is what let the host stop
    /// encoding while a frozen frame stayed on screen, so they move together or
    /// not at all -- see `VideoDemand`.
    ///
    /// Idempotent, and called on every surface change and again whenever a
    /// session comes up: a fresh session's host assumes it is being watched and
    /// would otherwise encode into a covered surface until the next switch.
    func applyVideoDemand(_ demand: VideoDemand) {
        // The picture and the pointer drawn over it are one thing to show or
        // hide. They are separate views only because the dot must not ride the
        // sink's pinch-zoom.
        let hidden = demand == .none
        sinkScrollView?.isHidden = hidden
        if hidden {
            cursorDotView?.isHidden = true
        } else {
            // Not unhidden directly: the dot owns its own visibility (no cursor
            // yet, or a window target that bakes the pointer into the capture),
            // so it is asked to re-derive rather than told an answer.
            updateCursorDot()
        }
        pushMediaViewerState(demand)
    }

    /// Tells the host whether this client is looking at the video. Best-effort:
    /// the host defaults to sending, so a dropped message costs bandwidth, never
    /// a black screen.
    private func pushMediaViewerState(_ demand: VideoDemand) {
        guard let channel = pairingClient.activeInputChannel else { return }
        let state = MediaViewerState(isWatchingVideo: demand == .live)
        if !state.isWatchingVideo {
            // The host stops encoding, so coming back is another wait for a
            // keyframe on a black surface. Same explanation as a fresh connect.
            videoStartupBanner.awaitFirstFrame(detail: "video paused")
        }
        Task {
            do {
                try await channel.sendMediaViewerState(state)
            } catch {
                self.sessionLogger.error(
                    "media viewer state send failed: \(String(describing: error), privacy: .public)"
                )
            }
        }
    }

    /// A decoded frame reaching the display, or a live tile surface, is the
    /// moment the app has a picture. Every other status is progress to report.
    func noteOwnedMediaStatus(_ status: OwnedMediaStatus) {
        let hasPicture: Bool
        switch status {
        case .video, .tilesLive:
            hasPicture = true
        case .connecting, .connected, .videoRepairing, .videoWaitingKeyframe, .videoDropped:
            hasPicture = false
        }
        videoStartupBanner.note(hasPicture: hasPicture, detail: status.labelText)
        renderVideoStartupBanner()
    }

    func renderVideoStartupBanner() {
        guard case .connected(let active) = pairingClient.state else { return }
        let text = videoStartupBanner.text(deviceFingerprint: "\(active.deviceFingerprint)")
        statusLabel.text = text
        statusLabel.isHidden = text == nil
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
            reattachOverlayTask?.cancel()
            reattachOverlayTask = nil
        case .disconnected:
            // ADR-0104: a quiet spell is not a verdict, and the 5s grace that lived here was
            // one of five independent paths that could end a session. If the quiet is real
            // silence, the session clock accumulates it and delivers the one verdict; if the
            // carrier actually dies, `.failed` arrives on its own.
            break
        case .failed(let loss):
            ClientRuntimeTelemetry.shared.updateMediaState(.failed)
            failMediaSession(loss: loss)
        case .closed:
            // A closed carrier says nothing about the Mac. The old availability push here
            // ("Mac display unavailable") blamed the host for every deliberate teardown and
            // carrier swap; the reattach overlay and the session verdict now cover the cases
            // that deserve words.
            break
        }
    }

    func failMediaSession(loss: MediaSessionLoss) {
        if case .rejected(let rejection) = loss {
            let closeTask = agentTerminalLifecycleRouter.route(
                .rejection(rejection.reason),
                to: agentSurface
            )
            Task { @MainActor [weak self] in
                await closeTask?.value
                guard let self else { return }
                self.teardownMediaTransport()
                self.pairingClient.handleMediaSessionFailed(rejection: rejection)
            }
            return
        }

        if case .unreachable(let silentMs) = loss {
            // ADR-0104: the one death verdict. The session is over; say so honestly with the
            // full teardown, rather than spinning a hot retry loop against a host that has
            // not answered in 15 seconds.
            hostSessionActivity = .live
            // The verdict is a BACKOFF RUNG, not a stop. "Ended but still retrying" used to need
            // its own delayed nudge here, because the foreground and viewWillAppear triggers
            // could not fire during a handover the app never left the foreground for -- measured
            // on device as a 46s-old session dying and the client then sitting at "Paired
            // (reconnecting)" with nothing ever dialing again. The supervisor is always there,
            // so the nudge is just the long rung.
            sessionSupervisor?.noteUnreachable()
            teardownMediaTransport()
            pairingClient.handleMediaSessionFailed()
            ClientDiagnostics.shared.record(
                type: "sessionEndedUnreachable",
                fields: ["silentMs": String(silentMs)],
                level: .error
            )
            render()
            return
        }

        // Carrier lost, session alive: keep the surfaces and the last frame, replace the
        // carrier underneath. ADR-0089's insight survives its detectors: re-dial NOW, because
        // during a network handover the app never leaves the foreground, so the
        // foreground-triggered paths cannot fire. It survives the supervisor too, and without a
        // call: the teardown moves the state, the observer signals, and a session that was
        // healthy until this moment left the rung on `.clean`, so the plan is `.dial`.
        hostSessionActivity = .reattaching
        preservesSuspendedSessionSurfaces = true
        teardownMediaTransport(preservingSessionSurfaces: true)
        pairingClient.handleMediaSessionFailed()
        render()
    }

    func suspendMediaTransportForBackground() {
        agentTerminalLifecycleRouter.route(.background, to: agentSurface)
        mediaTransport?.stop()
        mediaTransport = nil
        ClientRuntimeTelemetry.shared.updateMediaState(.stopped)
        // Frames stop here, so the next foreground starts black again and owes
        // the user the same explanation the first connect did.
        videoStartupBanner.awaitFirstFrame(detail: "media suspended")
        mediaDiagnosticsPill?.text = "media suspended"
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
        // The provisioner is a singleton holding a task that captures this transport; the next
        // session opens its own lane, so letting the old transfer run only burns work on a
        // closed one.
        if #available(iOS 26.0, *) {
            Task { await VoiceAssetProvisioner.shared.cancel() }
        }
        ClientRuntimeTelemetry.shared.updateMediaState(.stopped)
        videoStartupBanner.awaitFirstFrame()
        // Keep the picture when the session is being recovered rather than ended.
        //
        // Removing the sink here is what made a network switch go black. The outage itself is
        // mostly unavoidable -- 9.5s of an 11s cellular switch was the radio, not us -- so what
        // matters is what is on screen during it. A frozen last frame beats black, and holding
        // the sink also holds its decoder, which is the precondition for ever recovering with a
        // small delta instead of a 250KB keyframe (ADR-0090).
        //
        // `attachMediaTransport` already adopts an existing sink rather than building one, so
        // the reattach path needs nothing new; it was simply unreachable while this nil'd it.
        if preservingSessionSurfaces {
            (videoSink as? any OwnedMediaFrameSink)?.prepareForStreamHandover()
            // A frozen picture with nothing over it is indistinguishable from a hung app --
            // but a "Reconnecting" flash over every sub-second carrier swap teaches the user
            // to distrust a session that is actually fine. So the overlay waits out a grace:
            // a swap that completes inside it (most of them, now that a resume costs a delta
            // resync rather than an IDR) is invisible, and one that does not gets the honest
            // spinner plus the escape hatch, because a redial that never lands would
            // otherwise strand the user waiting.
            reattachOverlayTask?.cancel()
            reattachOverlayTask = Task { [weak self] in
                try? await Task.sleep(
                    nanoseconds: UInt64(Config.sessionReattachOverlayGraceMs) * 1_000_000
                )
                guard !Task.isCancelled, let self else { return }
                guard case .reattaching = self.hostSessionActivity else { return }
                self.hostStatusOverlay?.apply(HostStatusPresentation.resolve(
                    activity: self.hostSessionActivity,
                    availability: .captureUnavailable
                ))
            }
        } else {
            videoSink?.view.removeFromSuperview()
            videoSink = nil
            sinkScrollView?.removeFromSuperview()
            sinkScrollView = nil
            sinkContentView = nil
            sinkFillHeightConstraint = nil
            sinkAspectConstraint = nil
            mediaDiagnosticsPill?.removeFromSuperview()
            mediaDiagnosticsPill = nil
            pointerScrollPuck?.removeFromSuperview()
            pointerScrollPuck = nil
            // The constraints die with the view, but the references would outlive it and let a
            // later drag write into a layout nothing is watching.
            pointerScrollPuckOffsetX = nil
            pointerScrollPuckOffsetY = nil
            hostStatusOverlay?.removeFromSuperview()
            hostStatusOverlay = nil
            cursorDotView?.removeFromSuperview()
            cursorDotView = nil
        }
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
        // The host resets its own capture target when the session ends, so holding a window
        // id across a reconnect would leave the two disagreeing about what is on screen.
        selectedWindowIdForClientConfig = nil
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
        hostContentView.translatesAutoresizingMaskIntoConstraints = false
        hostContentView.accessibilityIdentifier = "host-content-root"
        view.addSubview(hostContentView)
        NSLayoutConstraint.activate([
            hostContentView.topAnchor.constraint(equalTo: view.topAnchor),
            hostContentView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostContentView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hostContentView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        installHostContentStages()
        installDesktopViewerSurfaces()

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

        // The pre-session screen shares the backdrop band with the video: they
        // never coexist, they fill the same space, and both belong under
        // anything a session puts on top.
        stage(.backdrop).addSubview(statusLabel)
        stage(.backdrop).addSubview(actionButton)
        stage(.backdrop).addSubview(forgetButton)
        // The banner is the Mac's agent speaking, which has to be readable over
        // whichever surface is up.
        stage(.overlay).addSubview(agentSayBanner)

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
        turnOffKeyboardDictation()
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
            self.handshakeTask?.cancel()
            self.stopCamera()
            self.teardownMediaTransport()
            // clearStoredCredentials moves the state, which renders.
            self.pairingClient.clearStoredCredentials()
        }
    }

    // Settings "Disconnect": end the live session but keep the pairing. Suppress
    // auto-reconnect so it stays down until the user taps Connect. handleMediaSessionFailed
    // closes the session lanes and flips .connected -> .pairedDisconnected without
    // touching stored credentials.
    func disconnectFromHost() {
        guard !userRequestedDisconnect else { return }
        turnOffKeyboardDictation()
        // Closes the supervisor's gate, which cancels a dial in flight and parks the loop.
        userRequestedDisconnect = true
        preservesSuspendedSessionSurfaces = false
        handshakeTask?.cancel()
        let terminalCloseTask = agentTerminalLifecycleRouter.route(.disconnect, to: agentSurface)
        Task { @MainActor [weak self] in
            await terminalCloseTask?.value
            guard let self else { return }
            self.teardownMediaTransport()
            self.pairingClient.handleMediaSessionFailed()
        }
    }

    // Pairing-screen "Connect": clear the suppress flag and re-attempt the session.
    @objc func reconnect() {
        userRequestedDisconnect = false
        render()
        // Not merely a signal: the user tapping Connect should not wait out a rung earned by a
        // machine failure they may well have just fixed.
        sessionSupervisor?.requestImmediateDial()
    }

    private func reconnectingStatusText() -> String {
        SessionFailureCause.reconnectingStatusText(
            cause: lastSessionFailureCause,
            consecutiveFailures: consecutiveSessionFailures
        )
    }

    /// Draws the client from `pairingClient.state` plus the view-controller state the status
    /// text reads. A state change calls this on its own now; call it directly only for the
    /// things that are NOT session state (failure counters, surface toggles, toasts).
    ///
    /// Re-entrancy is coalesced rather than allowed. This is not a pure view function -- it
    /// mounts and tears down surfaces, starts the offer listener, and forces layout -- so a
    /// callee that reaches a state mutation would re-enter through the observer. Rather than
    /// audit every callee forever, the second pass is folded into the first.
    func render() {
        guard !isRendering else {
            needsRerender = true
            return
        }
        isRendering = true
        defer { isRendering = false }
        repeat {
            needsRerender = false
            renderOnce()
        } while needsRerender
    }

    private func renderOnce() {
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
                statusLabel.text = reconnectingStatusText()
                actionButton.isHidden = true
            }
            forgetButton.isHidden = false
            stopCamera()
        case .sessionConnecting:
            statusLabel.text = "Connecting"
            actionButton.isHidden = true
            stopCamera()
        case .connected(let active):
            let waiting = videoStartupBanner.text(deviceFingerprint: "\(active.deviceFingerprint)")
            statusLabel.text = waiting
            statusLabel.isHidden = waiting == nil
            actionButton.isHidden = true
            stopCamera()
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

        // Host-backed surface buttons are state-driven, not gated on a
        // one-shot channel check: render() runs on every state change so it
        // cannot race the session/channel timing. Background suspend keeps
        // mounted surfaces visible; explicit non-connected states tear them
        // down.
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
            scheduleMediaTransportStartIfNeeded()
        } else if preservesSuspendedSessionSurfaces {
            ClientDiagnostics.shared.setLiveAnnouncementSender(nil)
            statusLabel.isHidden = true
            actionButton.isHidden = true
            forgetButton.isHidden = true
            showSurfaceToggleIfNeeded()
            applySurface(activeControlSurface)
        } else {
            ClientDiagnostics.shared.setLiveAnnouncementSender(nil)
            // Host-backed surfaces follow the session lifecycle. The local
            // Voice surface is deliberately preserved across this teardown.
            teardownAgentSurface()
        }

        applyVoiceRootPresentation()
        view.setNeedsLayout()
        view.layoutIfNeeded()
        recordRuntimeUICheckpoint(
            layoutReady: surfaceControlRail.bounds.width > 0
                && surfaceControlRail.bounds.height > 0
        )
        if isClientForeground {
            startOfferListenerIfNeeded()
        }
        configureOfferListener()
    }

    private func recordRuntimeUICheckpoint(layoutReady: Bool) {
        ClientRuntimeTelemetry.shared.updateUI(
            scenePhase: isClientForeground ? .foreground : .background,
            pairingState: pairingClient.state.runtimeCheckpointState,
            activeSurface: activeControlSurface.runtimeCheckpointSurface,
            railConfigured: surfaceControlRail.superview != nil,
            railHidden: surfaceControlRail.isHidden,
            railLayoutReady: layoutReady,
            hostSurfaceCount: surfaceControlRail.surfaceButtons.count
        )
    }

    /// Voice replaces the pairing or connected UI rather than sitting on top
    /// of it. The host root and control rail are hidden as units, leaving the
    /// local surface as the sole visible root until its Back action exits.
    func applyVoiceRootPresentation() {
        let voiceIsActive = activeControlSurface == .voice
        let visibility = visibility(for: activeControlSurface)
        hostContentView.isHidden = visibility.hostContentHidden
        surfaceControlRail.isHidden = visibility.controlRailHidden
        surfaceControlRail.setUtilityButton(
            voiceToggleButton,
            selected: voiceIsActive
        )
        guard voiceIsActive else {
            voiceSurface?.isHidden = true
            return
        }

        ensureVoiceSurface()
        applySurface(.voice)
        statusLabel.isHidden = true
        actionButton.isHidden = true
        forgetButton.isHidden = true
        if let voiceSurface {
            view.bringSubviewToFront(voiceSurface)
        }
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
        guard isClientForeground, pairingOfferListener == nil else { return }
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
            await OSLogDrain.shared.drain()
            return ClientDiagnostics.shared.prepareResponse(for: request)
        }
        listener.screenshotResponseProvider = { [weak self] request in
            guard let self else {
                return .failure(ClientScreenshotError(requestId: request.requestId, reason: "capture-unavailable"))
            }
            return await self.prepareScreenshotResponse(request)
        }
        listener.screenshotDeliveryHandler = { [weak self] in
            self?.showScreenshotSharedStatus()
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
        // The live lane and the tailnet fallback are two ways to ask the same question, so
        // both take everything logged up to the ask, not up to the last cadence tick. Awaited
        // rather than blocking: this runs on the main actor.
        await OSLogDrain.shared.drain()
        switch ClientDiagnostics.shared.prepareResponse(for: request) {
        case .failure(let error):
            try? await channel.sendDiagnosticsError(error)
        case .success(let prepared):
            switch await sendPreparedDiagnosticsResponse(prepared, on: channel) {
            case .delivered:
                // The input lane has no durable-receipt frame yet. Keep archives
                // pending so reconnect announcements continue until the host can
                // prove it has atomically cached their payloads.
                break
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

    private func startScreenshotHandlingIfNeeded(channel: InputChannel) {
        screenshotTask?.cancel()
        screenshotTask = Task { [weak self, channel] in
            for await update in channel.screenshotUpdates {
                guard let self else { return }
                switch update {
                case .request(let request):
                    await self.respondToScreenshotRequest(request, on: channel)
                }
            }
        }
    }

    private func respondToScreenshotRequest(_ request: ClientScreenshotRequest, on channel: InputChannel) async {
        switch await prepareScreenshotResponse(request) {
        case .failure(let error):
            try? await channel.sendScreenshotError(error)
        case .success(let prepared):
            do {
                try await channel.sendScreenshotManifest(prepared.manifest)
                for chunk in ClientScreenshotCapturer.makeChunks(
                    data: prepared.jpegData,
                    requestId: request.requestId,
                    chunkBytes: Config.screenshotChunkBytes
                ) {
                    try await channel.sendScreenshotChunk(chunk)
                }
                showScreenshotSharedStatus()
            } catch {
                ClientDiagnostics.shared.record(
                    type: "clientScreenshotSendFailed",
                    fields: ["requestId": request.requestId],
                    level: .error
                )
            }
        }
    }

    private func prepareScreenshotResponse(
        _ request: ClientScreenshotRequest
    ) async -> Result<PreparedClientScreenshot, ClientScreenshotError> {
        do {
            let prepared = try await screenshotCapturer.capture(
                request: request,
                window: view.window,
                surfaceName: activeControlSurface.switcherAccessibilityLabel.lowercased(),
                authorized: SettingsStore.shared.diagnosticScreenshotsEnabled
            )
            ClientDiagnostics.shared.record(
                type: "clientScreenshotCaptured",
                fields: [
                    "requestId": request.requestId,
                    "surface": prepared.manifest.surfaceName,
                    "pixelWidth": String(prepared.manifest.pixelWidth),
                    "pixelHeight": String(prepared.manifest.pixelHeight),
                    "bytes": String(prepared.manifest.totalBytes)
                ],
                level: .info
            )
            return .success(prepared)
        } catch let failure as ClientScreenshotCaptureFailure {
            ClientDiagnostics.shared.record(
                type: "clientScreenshotRejected",
                fields: ["requestId": request.requestId, "reason": failure.wireReason],
                level: .info
            )
            return .failure(ClientScreenshotError(requestId: request.requestId, reason: failure.wireReason))
        } catch {
            return .failure(ClientScreenshotError(requestId: request.requestId, reason: "capture-failed"))
        }
    }

    private func showScreenshotSharedStatus() {
        screenshotToastTask?.cancel()
        screenshotToastLabel?.removeFromSuperview()
        let label = UILabel()
        label.text = "Screenshot shared with paired Mac"
        label.font = .preferredFont(forTextStyle: .footnote)
        label.textColor = .white
        label.backgroundColor = UIColor.systemIndigo.withAlphaComponent(0.94)
        label.layer.cornerRadius = 10
        label.layer.masksToBounds = true
        label.textAlignment = .center
        label.numberOfLines = 2
        label.accessibilityIdentifier = "client-screenshot-shared-status"
        label.accessibilityLabel = "Screenshot shared with paired Mac"
        label.translatesAutoresizingMaskIntoConstraints = false
        stage(.overlay).addSubview(label)
        screenshotToastLabel = label
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.82),
            label.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        UIAccessibility.post(notification: .announcement, argument: label.accessibilityLabel)
        screenshotToastTask = Task { @MainActor [weak self, weak label] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            label?.removeFromSuperview()
            if self?.screenshotToastLabel === label {
                self?.screenshotToastLabel = nil
            }
        }
    }

    func handleIncomingPairingURL(_ url: URL) {
        // A fresh pair URL supersedes whatever state we're in. Scanning is not a dialable
        // state, so the gate stands the supervisor down without being told.
        handshakeTask?.cancel()
        stopCamera()
        pairingClient.clearStoredCredentials()
        do {
            try pairingClient.startScanning()
        } catch {
            pairingClient.reject("\(error)")
            return
        }
        do {
            let payload = try pairingClient.acceptScannedCode(url.absoluteString)
            handshakeTask?.cancel()
            handshakeTask = Task { @MainActor [weak self] in
                do {
                    try await self?.pairingClient.performHandshake(for: payload)
                } catch {
                    self?.pairingClient.reject("\(error)")
                }
            }
        } catch {
            pairingClient.reject("\(error)")
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
        } catch {
            pairingClient.reject("\(error)")
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
        // Behind the pairing status and its buttons, which share this band.
        preview.frame = stage(.backdrop).bounds
        stage(.backdrop).layer.insertSublayer(preview, at: 0)
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
            handshakeTask?.cancel()
            handshakeTask = Task { @MainActor [weak self] in
                do {
                    try await self?.pairingClient.performHandshake(for: payload)
                } catch {
                    self?.pairingClient.reject("\(error)")
                }
            }
        } catch {
            pairingClient.reject("\(error)")
        }
    }
}
