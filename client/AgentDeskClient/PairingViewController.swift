import AVFoundation
import UIKit

final class PairingViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate, GestureTranslatorDelegate, KeyboardSurfaceDelegate {
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
    private var mediaStateTask: Task<Void, Never>?
    private var iceGraceTask: Task<Void, Never>?
    // R9.2: trackpad surface in the bottom region. The translator owns the
    // recognizers and emits NormalizedInput; we forward to mediaTransport.send.
    private let trackpadView = UIView()
    private let trackpadHint = UILabel()
    private let scrollStripView = UIView()
    private let scrollStripHint = UILabel()
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
    private let buttonRow = UIStackView()
    private let rightClickButton = UIButton(type: .system)
    private let showKeyboardButton = UIButton(type: .system)
    // R12.3: hidden first-responder that backs the iOS soft keyboard.
    // Lives as a permanent zero-size subview so becomeFirstResponder /
    // resignFirstResponder route correctly through the responder chain.
    private let keyboardSurface = KeyboardSurface()
    private var buttonRowBottomConstraint: NSLayoutConstraint?
    // CGEvent posts at the userspace layer don't actually trigger macOS
    // pointer accel (that lives in IOKit, below CGEvent), so we apply our
    // own approximation client-side. The .mac curve keeps the standard
    // UIPan slop intact for tremor filtering and uses a steeper top end
    // so flicks travel across the Mac display.
    private let gestureTranslator = GestureTranslator(acceleration: .mac, scrollAcceleration: .scroll)

    override func viewDidLoad() {
        super.viewDidLoad()
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
        keyboardSurface.delegate = self
        // Zero-size hidden subview is enough: the responder chain only
        // cares that the view is in the window hierarchy when
        // becomeFirstResponder is called. The visible UI is the system
        // soft keyboard plus our inputAccessoryView.
        keyboardSurface.translatesAutoresizingMaskIntoConstraints = false
        keyboardSurface.isHidden = true
        view.addSubview(keyboardSurface)
        NSLayoutConstraint.activate([
            keyboardSurface.widthAnchor.constraint(equalToConstant: 0),
            keyboardSurface.heightAnchor.constraint(equalToConstant: 0)
        ])
        // Any tap on the app's main view dismisses the keyboard. The
        // iOS soft keyboard and its inputAccessoryView render in a
        // separate UIWindow, so this recognizer doesn't see touches
        // on the keys themselves. cancelsTouchesInView=false so button
        // taps and trackpad gestures still reach their own handlers.
        // dismissKeyboardIfShown is idempotent when the keyboard isn't
        // first responder, so taps when the keyboard is already hidden
        // have no side effect.
        let dismissTap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboardIfShown))
        dismissTap.cancelsTouchesInView = false
        view.addGestureRecognizer(dismissTap)
    }

    private func configureSettingsButton() {
        let image = UIImage(systemName: "gearshape")
        settingsButton.setImage(image, for: .normal)
        settingsButton.tintColor = .label
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
    }

    private func applySettingsToTranslator() {
        gestureTranslator.tuning = SettingsStore.shared.tuning
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        triggerSessionIfPaired()
    }

    @objc private func applicationWillEnterForeground() {
        triggerSessionIfPaired()
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
        sinkView.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(sinkView, at: 0)
        NSLayoutConstraint.activate([
            sinkView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sinkView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sinkView.topAnchor.constraint(equalTo: view.topAnchor),
            sinkView.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.55)
        ])
    }

    @objc private func dismissKeyboardIfShown() {
        if keyboardSurface.isFirstResponder {
            keyboardSurface.setVisible(false)
        }
    }

    private func showTrackpad() {
        if trackpadView.superview != nil { return }
        trackpadView.translatesAutoresizingMaskIntoConstraints = false
        trackpadView.backgroundColor = UIColor.secondarySystemBackground
        trackpadView.layer.cornerRadius = 12
        trackpadView.isUserInteractionEnabled = true
        view.addSubview(trackpadView)

        trackpadHint.text = "Trackpad"
        trackpadHint.textColor = .tertiaryLabel
        trackpadHint.font = .preferredFont(forTextStyle: .footnote)
        trackpadHint.textAlignment = .center
        trackpadHint.translatesAutoresizingMaskIntoConstraints = false
        trackpadView.addSubview(trackpadHint)

        scrollStripView.translatesAutoresizingMaskIntoConstraints = false
        scrollStripView.backgroundColor = UIColor.tertiarySystemBackground
        scrollStripView.layer.cornerRadius = 12
        scrollStripView.isUserInteractionEnabled = true
        view.addSubview(scrollStripView)

        scrollStripHint.text = "↕"
        scrollStripHint.textColor = .tertiaryLabel
        scrollStripHint.font = .systemFont(ofSize: 20, weight: .medium)
        scrollStripHint.textAlignment = .center
        scrollStripHint.translatesAutoresizingMaskIntoConstraints = false
        scrollStripView.addSubview(scrollStripHint)

        buttonRow.axis = .horizontal
        buttonRow.spacing = 12
        buttonRow.distribution = .fillEqually
        buttonRow.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(buttonRow)

        rightClickButton.setTitle("Right-click", for: .normal)
        rightClickButton.backgroundColor = .tertiarySystemBackground
        rightClickButton.layer.cornerRadius = 10
        rightClickButton.titleLabel?.font = .preferredFont(forTextStyle: .body)
        rightClickButton.addTarget(self, action: #selector(rightClickTapped), for: .touchUpInside)
        buttonRow.addArrangedSubview(rightClickButton)

        showKeyboardButton.setTitle("Show keyboard", for: .normal)
        showKeyboardButton.backgroundColor = .tertiarySystemBackground
        showKeyboardButton.layer.cornerRadius = 10
        showKeyboardButton.titleLabel?.font = .preferredFont(forTextStyle: .body)
        showKeyboardButton.addTarget(self, action: #selector(toggleKeyboard), for: .touchUpInside)
        buttonRow.addArrangedSubview(showKeyboardButton)

        let bottomConstraint = buttonRow.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12)
        buttonRowBottomConstraint = bottomConstraint

        NSLayoutConstraint.activate([
            buttonRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bottomConstraint,
            buttonRow.heightAnchor.constraint(equalToConstant: 44),

            trackpadView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            trackpadView.topAnchor.constraint(equalTo: view.centerYAnchor, constant: 24),
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
    }

    private func hideTrackpad() {
        trackpadView.removeFromSuperview()
        scrollStripView.removeFromSuperview()
        buttonRow.removeFromSuperview()
        rightClickButton.removeFromSuperview()
        showKeyboardButton.removeFromSuperview()
        keyboardSurface.setVisible(false)
        buttonRowBottomConstraint = nil
    }

    @objc private func rightClickTapped() {
        sendInput(.click(button: .right))
    }

    @objc private func toggleKeyboard() {
        if keyboardSurface.isFirstResponder {
            keyboardSurface.setVisible(false)
        } else {
            keyboardSurface.setVisible(true)
        }
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

    private func sendInput(_ input: NormalizedInput) {
        guard let transport = mediaTransport else { return }
        do {
            try transport.send(input)
        } catch {
            // Channel not open yet during the brief window between WebRTC
            // connected and the data channel transitioning to .open. Drop
            // silently; the next event will succeed.
        }
    }

    private func teardownMediaTransport() {
        mediaTransport?.stop()
        mediaTransport = nil
        videoSink?.view.removeFromSuperview()
        videoSink = nil
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
