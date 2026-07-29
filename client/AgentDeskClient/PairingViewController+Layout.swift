import AgentDeskWire
import UIKit

// R23/R24 layout + orientation. Owns mountSinkView (UIScrollView + sink
// wiring), showTrackpad (the rest of the session UI), hideTrackpad,
// settings + orientation pills, and the portrait/landscape constraint
// swap that fires from viewWillTransition. Stored properties for the
// constraint arrays live on the main class declaration.

extension PairingViewController {
    func mountSinkView(_ sinkView: UIView) {
        // Top portion shows the Mac display, bottom is the trackpad zone.
        // 55/45 leaves plenty of trackpad real estate without making the
        // video unreadable; the Mac display is landscape so it aspect-fits
        // comfortably in the top half.
        //
        // R21: the sink is wrapped in a UIScrollView so pinch and pan
        // zoom the visible slice of the Mac display. UIScrollView is
        // the canonical iOS path for zoom-and-pan around a plain video view.
        // Local-only zoom
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
        hostContentView.insertSubview(scroll, at: 0)

        // Inner constraints (sink view inside the scroll) are
        // orientation-invariant; activate immediately.
        NSLayoutConstraint.activate([
            sinkView.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            sinkView.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            sinkView.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            sinkView.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            sinkView.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            sinkView.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
        ])

        // R23: outer scroll constraints (position + extent in the
        // controller view) are orientation-variant. Capture the independent
        // portrait edges here; the shell-and-sink constraints are installed
        // once both sides exist, regardless of which mounts first. Full
        // layout gets its own portrait constraints because the normal
        // portrait height is fixed at 55%.
        portraitConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.55)
        ])
        let safe = view.safeAreaLayoutGuide
        fullPortraitConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: safe.topAnchor)
        ])

        // Double-tap zoom toggle: 1.0 ↔ 2.0, animated, centered on the
        // tap point. See PairingViewController+EdgeFollow for the handler.
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleSinkDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        videoDoubleTapZoomRecognizer = doubleTap

        sinkScrollView = scroll
        if trackpadView.superview != nil {
            installSinkDependentSessionConstraintsIfNeeded()
            applyOrientationConstraints(forLandscape: view.bounds.width > view.bounds.height)
            attachVideoTouchRecognizers()
        }

        let dot = CursorPointerView()
        dot.isHidden = true
        hostContentView.addSubview(dot)
        cursorDotView = dot

        // Diagnostics readout as fixed chrome in the host root (not the zoomable sink), so
        // pinch-zoom/pan leave it pinned top-left. Styling matches the old in-sink label;
        // text is seeded to the connecting state and driven by onOwnedMediaStatusChange.
        let diag = UILabel()
        diag.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        diag.textColor = .white
        diag.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        diag.numberOfLines = 1
        diag.text = OwnedMediaStatus.connecting.labelText
        diag.layer.cornerRadius = 6
        diag.layer.masksToBounds = true
        diag.translatesAutoresizingMaskIntoConstraints = false
        hostContentView.addSubview(diag)
        NSLayoutConstraint.activate([
            diag.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            diag.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            diag.trailingAnchor.constraint(
                lessThanOrEqualTo: surfaceControlRail.leadingAnchor,
                constant: -8
            )
        ])
        hostContentView.bringSubviewToFront(diag)
        mediaDiagnosticsLabel = diag

        let availability = UILabel()
        availability.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        availability.textColor = .white
        availability.font = .preferredFont(forTextStyle: .headline)
        availability.numberOfLines = 2
        availability.textAlignment = .center
        availability.layer.cornerRadius = 10
        availability.layer.masksToBounds = true
        availability.isHidden = true
        availability.translatesAutoresizingMaskIntoConstraints = false
        hostContentView.addSubview(availability)
        NSLayoutConstraint.activate([
            availability.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            availability.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            availability.leadingAnchor.constraint(greaterThanOrEqualTo: scroll.leadingAnchor, constant: 24),
            availability.trailingAnchor.constraint(lessThanOrEqualTo: scroll.trailingAnchor, constant: -24)
        ])
        hostContentView.bringSubviewToFront(availability)
        hostAvailabilityLabel = availability
    }

    func showTrackpad() {
        if trackpadView.superview != nil {
            installSinkDependentSessionConstraintsIfNeeded()
            applyOrientationConstraints(forLandscape: view.bounds.width > view.bounds.height)
            attachVideoTouchRecognizers()
            restartSessionSurfaceObservations()
            return
        }
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
        hostContentView.addSubview(trackpadView)

        trackpadHint.text = "Trackpad"
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
        hostContentView.addSubview(scrollStripView)

        scrollStripHint.image = UIImage(systemName: "arrow.up.arrow.down")
        scrollStripHint.tintColor = .secondaryLabel
        scrollStripHint.contentMode = .scaleAspectFit
        scrollStripHint.translatesAutoresizingMaskIntoConstraints = false
        scrollStripView.addSubview(scrollStripHint)

        buttonRow.axis = .horizontal
        buttonRow.spacing = 12
        buttonRow.distribution = .fillEqually
        buttonRow.translatesAutoresizingMaskIntoConstraints = false
        hostContentView.addSubview(buttonRow)

        styleActionButton(rightClickButton, title: "Right-click")
        rightClickButton.addTarget(self, action: #selector(rightClickTapped), for: .touchUpInside)
        buttonRow.addArrangedSubview(rightClickButton)

        // Layout, video touch input, and automatic keyboard opening are independent.
        remoteInputModeControl.addTarget(self, action: #selector(remoteInputModeControlChanged(_:)), for: .valueChanged)
        buttonRow.addArrangedSubview(remoteInputModeControl)

        keyboardDictationGroup.axis = .horizontal
        keyboardDictationGroup.spacing = 8
        keyboardDictationGroup.distribution = .fill
        keyboardDictationGroup.alignment = .fill

        styleActionButton(showKeyboardButton, title: "Show keyboard")
        showKeyboardButton.addTarget(self, action: #selector(toggleKeyboard), for: .touchUpInside)
        keyboardDictationGroup.addArrangedSubview(showKeyboardButton)

        styleActionButton(dictationButton, title: "")
        dictationButton.setImage(UIImage(systemName: "mic.fill"), for: .normal)
        dictationButton.tintColor = .label
        dictationButton.accessibilityLabel = "Dictate to Mac"
        dictationButton.accessibilityHint = "Records, transcribes, and lets you edit text before sending it to the Mac."
        dictationButton.accessibilityIdentifier = "open-client-dictation"
        dictationButton.addTarget(self, action: #selector(openDictation), for: .touchUpInside)
        keyboardDictationGroup.addArrangedSubview(dictationButton)
        NSLayoutConstraint.activate([
            showKeyboardButton.widthAnchor.constraint(equalTo: dictationButton.widthAnchor, multiplier: 1.5),
            dictationButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        buttonRow.addArrangedSubview(keyboardDictationGroup)

        // R25: the merged Spaces band is just the thumbnail strip.
        displayRailView.translatesAutoresizingMaskIntoConstraints = false
        displayRailView.delegate = self
        displayRailView.isHidden = true
        hostContentView.addSubview(displayRailView)

        thumbnailStripView.translatesAutoresizingMaskIntoConstraints = false
        thumbnailStripView.delegate = self
        thumbnailStripView.isHidden = true
        hostContentView.addSubview(thumbnailStripView)

        let bottomConstraint = buttonRow.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12)
        buttonRowBottomConstraint = bottomConstraint

        // Strip's top aligns with the video sink's bottom edge in
        // portrait (sink occupies the top 0.55 of the view height; see
        // mountSinkView). Multiplier on view.bottom keeps the band's
        // position independent of when the sink mounts.
        let bandTopAtVideoBottom = NSLayoutConstraint(
            item: displayRailView,
            attribute: .top,
            relatedBy: .equal,
            toItem: view,
            attribute: .bottom,
            multiplier: 0.55,
            constant: 0
        )
        let fullBandTopAtVideoBottom = NSLayoutConstraint(
            item: displayRailView,
            attribute: .top,
            relatedBy: .equal,
            toItem: view,
            attribute: .bottom,
            multiplier: 0.55,
            constant: 0
        )

        // Shared constraints, active for the entire session in both
        // orientations. Heights, fixed widths, intra-card hint
        // placement, and anchors that resolve to the same edge in
        // either orientation.
        NSLayoutConstraint.activate([
            bottomConstraint,
            buttonRow.heightAnchor.constraint(equalToConstant: 52),

            // Strip must fit the full cell: tile thumbnail (tileHeight) +
            // two-row caption (tileCaptionHeight). The old 56pt value was
            // the original image-only tile height; with the Spotify-style
            // two-row caption added, the strip needs the full cell height
            // or the secondary label is clipped and the active-tile
            // selection overlay (sized to cell, not strip) looks oversized
            // relative to the visible tile content.
            displayRailView.heightAnchor.constraint(equalToConstant: 32),
            thumbnailStripView.heightAnchor.constraint(
                equalToConstant: ThumbnailStripView.tileHeight + ThumbnailStripView.tileCaptionHeight
            ),

            keyboardSurface.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            trackpadHint.centerXAnchor.constraint(equalTo: trackpadView.centerXAnchor),
            trackpadHint.bottomAnchor.constraint(equalTo: trackpadView.bottomAnchor, constant: -10),

            scrollStripView.widthAnchor.constraint(equalToConstant: 60),
            scrollStripView.topAnchor.constraint(equalTo: trackpadView.topAnchor),
            scrollStripView.bottomAnchor.constraint(equalTo: trackpadView.bottomAnchor),
            scrollStripHint.centerXAnchor.constraint(equalTo: scrollStripView.centerXAnchor),
            scrollStripHint.centerYAnchor.constraint(equalTo: scrollStripView.centerYAnchor)
        ])

        // Portrait layout. Trackpad + scroll strip span the bottom row;
        // strip sits at view.bottom * 0.55 above the trackpad; video
        // scroll (constrained in mountSinkView) takes the top 0.55.
        portraitConstraints.append(contentsOf: [
            buttonRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            displayRailView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            displayRailView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bandTopAtVideoBottom,

            thumbnailStripView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            thumbnailStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            thumbnailStripView.topAnchor.constraint(equalTo: displayRailView.bottomAnchor, constant: 4),

            keyboardSurface.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            keyboardSurface.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            trackpadView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            trackpadView.topAnchor.constraint(equalTo: thumbnailStripView.bottomAnchor, constant: 4),
            trackpadView.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            scrollStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12)
        ])
        installSinkDependentSessionConstraintsIfNeeded(
            fullBandTopAtVideoBottom: fullBandTopAtVideoBottom
        )

        applyOrientationConstraints(forLandscape: view.bounds.width > view.bounds.height)

        // The rail is added before session UI. Keep it above later surfaces so its controls
        // remain tappable without letting each button become an independent overlay.
        view.bringSubviewToFront(surfaceControlRail)

        gestureTranslator.delegate = self
        trackpadView.gestureRecognizers?.forEach { trackpadView.removeGestureRecognizer($0) }
        scrollStripView.gestureRecognizers?.forEach { scrollStripView.removeGestureRecognizer($0) }
        gestureTranslator.attach(to: trackpadView)
        gestureTranslator.attachScrollStrip(to: scrollStripView)
        // Touch mode: recognizers on the video surface + apply current mode.
        attachVideoTouchRecognizers()

        restartSessionSurfaceObservations()
    }

    private func installSinkDependentSessionConstraintsIfNeeded(
        fullBandTopAtVideoBottom: NSLayoutConstraint? = nil
    ) {
        guard deferredMediaLayoutInstallation.beginIfReady(
            shellMounted: trackpadView.superview != nil,
            sinkMounted: sinkScrollView != nil
        ),
              let scroll = sinkScrollView
        else { return }

        let safe = view.safeAreaLayoutGuide
        let fullBandTop = fullBandTopAtVideoBottom ?? NSLayoutConstraint(
            item: displayRailView,
            attribute: .top,
            relatedBy: .equal,
            toItem: view,
            attribute: .bottom,
            multiplier: 0.55,
            constant: 0
        )
        fullPortraitConstraints.append(contentsOf: [
            scroll.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            buttonRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            displayRailView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            displayRailView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            fullBandTop,

            thumbnailStripView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            thumbnailStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            thumbnailStripView.topAnchor.constraint(equalTo: displayRailView.bottomAnchor, constant: 4),

            keyboardSurface.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            keyboardSurface.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),

            trackpadView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            trackpadView.topAnchor.constraint(equalTo: thumbnailStripView.bottomAnchor, constant: 4),
            trackpadView.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            scrollStripView.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12)
        ])

        // Landscape layout. Video scroll occupies the left ~62% of the
        // safe area at full height; strip pins below it on the left
        // column. Trackpad + scroll strip + buttons live in the right
        // column.
        landscapeConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.widthAnchor.constraint(equalTo: safe.widthAnchor, multiplier: 0.62),
            scroll.bottomAnchor.constraint(equalTo: displayRailView.topAnchor, constant: -8),

            displayRailView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            displayRailView.trailingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: -12),
            displayRailView.bottomAnchor.constraint(equalTo: thumbnailStripView.topAnchor, constant: -4),

            thumbnailStripView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            thumbnailStripView.trailingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: -12),
            thumbnailStripView.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),

            trackpadView.leadingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            trackpadView.topAnchor.constraint(equalTo: safe.topAnchor),
            trackpadView.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            scrollStripView.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),

            buttonRow.leadingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),

            keyboardSurface.leadingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: 12),
            keyboardSurface.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8)
        ])
        fullLandscapeConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            displayRailView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            displayRailView.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),
            displayRailView.bottomAnchor.constraint(equalTo: thumbnailStripView.topAnchor, constant: -4),

            thumbnailStripView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            thumbnailStripView.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),
            thumbnailStripView.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),

            trackpadView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            trackpadView.topAnchor.constraint(equalTo: safe.topAnchor),
            trackpadView.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            scrollStripView.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),

            buttonRow.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),

            keyboardSurface.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            keyboardSurface.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12)
        ])
        currentIsLandscape = nil
        currentUsesFullLayout = nil
    }

    func restartSessionSurfaceObservations() {
        startDesktopStateObservation()
        startThumbnailsObservation()
        startAgentSayObservation()
        startCursorObservation()
        startTextInputFocusObservation()
        startHostAvailabilityObservation()
        sendCurrentClientConfig()
    }

    func hideTrackpad() {
        trackpadView.removeFromSuperview()
        scrollStripView.removeFromSuperview()
        buttonRow.removeFromSuperview()
        rightClickButton.removeFromSuperview()
        remoteInputModeControl.removeFromSuperview()
        keyboardDictationGroup.removeFromSuperview()
        showKeyboardButton.removeFromSuperview()
        dictationButton.removeFromSuperview()
        displayRailView.removeFromSuperview()
        displayRailView.renderEmpty()
        thumbnailStripView.removeFromSuperview()
        thumbnailStripView.renderEmpty()
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
        cursorReconciliation.reset()
        hostAvailabilityTask?.cancel()
        hostAvailabilityTask = nil
        textInputFocusTask?.cancel()
        textInputFocusTask = nil
        keyboardPendingTimeoutTask?.cancel()
        keyboardPendingTimeoutTask = nil
        lastCursorKind = .unknown
        lastHostTextInputFocus = HostTextInputFocusPush(editability: .ambiguous, secure: false, source: .none)
        pendingCursorRetarget = nil
        isManualViewportPanActive = false
        panFollowActive = false
        panFollowAnchor = nil
        lastSentPanFollowHostPoint = nil
        panFollowEdgeAxes = []
        panFollowEdgeReturnAxes = []
        lastPanFollowGestureTranslation = nil
        stopAgentSayForegroundPresentation()
        lastDesktopState = nil
        selectedDisplayIdForClientConfig = nil
        applyKeyboardPresentationIntent(.hide)
        buttonRowBottomConstraint = nil
        // R23: drop the orientation-variant constraints; the next
        // mountSinkView/showTrackpad will repopulate fresh arrays.
        NSLayoutConstraint.deactivate(portraitConstraints)
        NSLayoutConstraint.deactivate(landscapeConstraints)
        NSLayoutConstraint.deactivate(fullPortraitConstraints)
        NSLayoutConstraint.deactivate(fullLandscapeConstraints)
        portraitConstraints.removeAll()
        landscapeConstraints.removeAll()
        fullPortraitConstraints.removeAll()
        fullLandscapeConstraints.removeAll()
        deferredMediaLayoutInstallation.reset()
        currentIsLandscape = nil
        currentUsesFullLayout = nil
    }

    // R23: swap the active orientation's constraint set. Safe to call
    // when both arrays are empty (initial state before the first
    // session): NSLayoutConstraint.deactivate/activate on an empty
    // array is a no-op.
    func applyOrientationConstraints(forLandscape isLandscape: Bool) {
        let useFull = SettingsStore.shared.videoLayoutMode == .full
        if currentIsLandscape == isLandscape,
           currentUsesFullLayout == useFull,
           (!portraitConstraints.isEmpty || !landscapeConstraints.isEmpty || !fullPortraitConstraints.isEmpty || !fullLandscapeConstraints.isEmpty) {
            return
        }
        NSLayoutConstraint.deactivate(portraitConstraints)
        NSLayoutConstraint.deactivate(landscapeConstraints)
        NSLayoutConstraint.deactivate(fullPortraitConstraints)
        NSLayoutConstraint.deactivate(fullLandscapeConstraints)
        if isLandscape {
            NSLayoutConstraint.activate(useFull ? fullLandscapeConstraints : landscapeConstraints)
        } else {
            NSLayoutConstraint.activate(useFull ? fullPortraitConstraints : portraitConstraints)
        }
        currentIsLandscape = isLandscape
        currentUsesFullLayout = useFull
    }

    func configureSettingsButton() {
        settingsButton.setImage(UIImage(systemName: "gearshape"), for: .normal)
        settingsButton.accessibilityLabel = "Settings"
        settingsButton.accessibilityIdentifier = "settings-button"
        settingsButton.addTarget(self, action: #selector(openSettings), for: .touchUpInside)

        // Voice is local and therefore belongs with the always-present utility
        // actions, not with host-backed session surfaces.
        voiceToggleButton.setImage(UIImage(systemName: "waveform"), for: .normal)
        voiceToggleButton.accessibilityLabel = "Voice"
        voiceToggleButton.accessibilityIdentifier = "voice-toggle"
        voiceToggleButton.addTarget(
            self,
            action: #selector(toggleVoiceSurface),
            for: .touchUpInside
        )

        keyboardDictationServiceButton.setImage(
            UIImage(systemName: "mic.badge.plus"),
            for: .normal
        )
        keyboardDictationServiceButton.accessibilityLabel =
            "Activate Keyboard Dictation"
        keyboardDictationServiceButton.accessibilityIdentifier =
            "keyboard-dictation-service"
        keyboardDictationServiceButton.addTarget(
            self,
            action: #selector(openKeyboardDictationService),
            for: .touchUpInside
        )

        // R24: orientation remains a global action in the same rail as surface selection.
        orientationToggleButton.accessibilityIdentifier = "orientation-toggle"
        orientationToggleButton.addTarget(self, action: #selector(toggleOrientation), for: .touchUpInside)
        updateOrientationToggleIcon(forLandscape: view.bounds.width > view.bounds.height)

        // Gesture panel toggle reveals the camera + swipe tracker below the video.
        gestureToggleButton.setImage(UIImage(systemName: "hand.wave"), for: .normal)
        gestureToggleButton.accessibilityLabel = "Gesture"
        gestureToggleButton.accessibilityIdentifier = "gesture-toggle"
        gestureToggleButton.addTarget(self, action: #selector(toggleGesturePanel), for: .touchUpInside)

        surfaceControlRail.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(surfaceControlRail)
        // Hung from the top, not centered. The scroll strip owns the same right
        // edge for the whole height of the trackpad, and a centered rail lands on
        // top of it. Anchored to the top the rail sits above where the trackpad
        // starts, so the strip keeps its full length to be dragged along.
        NSLayoutConstraint.activate([
            surfaceControlRail.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor,
                constant: 8
            ),
            surfaceControlRail.trailingAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.trailingAnchor,
                constant: -8
            ),
            surfaceControlRail.bottomAnchor.constraint(
                lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor,
                constant: -8
            )
        ])
        renderKeyboardDictationStatus(.inactive)
    }

    func updateOrientationToggleIcon(forLandscape isLandscape: Bool) {
        let name = isLandscape ? "rectangle.portrait.rotate" : "rectangle.landscape.rotate"
        let image = UIImage(systemName: name)
        orientationToggleButton.setImage(image, for: .normal)
        if var configuration = orientationToggleButton.configuration {
            configuration.image = image
            orientationToggleButton.configuration = configuration
        }
        orientationToggleButton.accessibilityLabel = isLandscape ? "Rotate to portrait" : "Rotate to landscape"
    }

    @objc func toggleOrientation() {
        guard let scene = view.window?.windowScene else { return }
        let isCurrentlyLandscape = view.bounds.width > view.bounds.height
        // .landscape (not .landscapeRight) lets iOS pick whichever
        // landscape orientation is closer to the device's current
        // physical pose.
        let target: UIInterfaceOrientationMask = isCurrentlyLandscape ? .portrait : .landscape
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: target)) { _ in
            // Info.plist permits all three; unreachable in practice.
        }
    }

    @objc func openSettings() {
        let settings = SettingsViewController()
        settings.onDisconnect = { [weak self] in
            self?.disconnectFromHost()
        }
        settings.onUnpair = { [weak self] in
            self?.forgetHost()
        }
        settings.onKeyboardDictation = { [weak self] in
            self?.showKeyboardDictationService()
        }
        let nav = UINavigationController(rootViewController: settings)
        present(nav, animated: true)
    }

    @objc func rightClickTapped() {
        sendPointerAwareInput(.click(button: .right))
    }

    // Match the trackpad / scroll-strip card treatment so the button
    // row reads as part of the same surface family rather than floating
    // tinted pills on a grey ground.
    func styleActionButton(_ button: UIButton, title: String) {
        button.setTitle(title, for: .normal)
        button.backgroundColor = .secondarySystemBackground
        button.layer.cornerRadius = 12
        button.layer.borderColor = UIColor.separator.cgColor
        button.layer.borderWidth = 0.5
        button.titleLabel?.font = .preferredFont(forTextStyle: .body)
    }
}
