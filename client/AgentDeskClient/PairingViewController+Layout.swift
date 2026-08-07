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

        // The scroll's own position and extent are orientation-variant and belong to the
        // set `buildSessionLayoutConstraints` derives; nothing is captured here on purpose.
        // Producing them at mount time is what broke R230: mounting happens once per sink,
        // the surface-preserving teardown clears the set while keeping the sink, and the
        // constraints then had no producer left to bring them back.

        // Double-tap zoom toggle: 1.0 ↔ 2.0, animated, centered on the
        // tap point. See PairingViewController+EdgeFollow for the handler.
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleSinkDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        videoDoubleTapZoomRecognizer = doubleTap

        sinkScrollView = scroll
        if reconcileSessionLayout() {
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

        // Host status (message, spinner, and the manual escape hatch). Centered on the root
        // view's safe area rather than on the scroll: what it has to say matters most exactly
        // when the video is in a bad state, so it must not inherit the video's geometry. The
        // reason it exists at all is measured -- the host ended a session on a connection
        // timeout, the client never noticed and stayed `.connected`, so the pairing screen and
        // its Connect button never rendered and force-quitting was the only way out.
        //
        // Auto-recovery is the real fix and this is not a substitute for it. It is here
        // because a recovery path can always have a case it does not cover, and when that
        // happens the user should not be left holding a dead screen with nothing to tap.
        let status = HostStatusOverlay()
        status.reconnectButton.addTarget(self, action: #selector(reconnectTapped), for: .touchUpInside)
        hostContentView.addSubview(status)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: safe.centerYAnchor),
            status.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 24),
            status.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -24)
        ])
        hostContentView.bringSubviewToFront(status)
        hostStatusOverlay = status
    }

    func showTrackpad() {
        if trackpadView.superview != nil {
            _ = reconcileSessionLayout()
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

        // Directly under the Spaces strip, because the two are the same kind of thing: pick a
        // thing to look at. They need visibly distinct affordances though -- a Desktop tile
        // switches the Mac's Space, a window icon only retargets this phone's view and
        // changes nothing on the Mac.
        windowPickerStripView.translatesAutoresizingMaskIntoConstraints = false
        windowPickerStripView.delegate = self
        windowPickerStripView.isHidden = true
        hostContentView.addSubview(windowPickerStripView)

        let bottomConstraint = buttonRow.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12)
        buttonRowBottomConstraint = bottomConstraint
        let heightConstraint = buttonRow.heightAnchor.constraint(
            equalToConstant: KeyboardControlRowPresentation.visibleHeight
        )
        buttonRowHeightConstraint = heightConstraint

        // Shared constraints, active for the entire session in both
        // orientations. Heights, fixed widths, intra-card hint
        // placement, and anchors that resolve to the same edge in
        // either orientation.
        NSLayoutConstraint.activate([
            bottomConstraint,
            heightConstraint,

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
            windowPickerStripView.heightAnchor.constraint(
                equalToConstant: WindowPickerStripView.stripHeight
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

        _ = reconcileSessionLayout()

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

    /// Bring the installed orientation-variant constraints in line with what is mounted,
    /// and report whether a complete set is now installed.
    ///
    /// Every mount and unmount of either the control shell or the video sink goes through
    /// here, so the set on screen is always derived from the current composition rather than
    /// accumulated across whichever call sites happened to run.
    @discardableResult
    func reconcileSessionLayout() -> Bool {
        switch sessionLayoutConstraints.reconcile(
            shellMounted: trackpadView.superview != nil,
            sinkMounted: sinkScrollView != nil
        ) {
        case .upToDate:
            return sessionLayoutConstraints.hasInstalledConstraints
        case .clear:
            discardSessionLayoutConstraints()
            return false
        case .rebuild(let layout):
            discardSessionLayoutConstraints()
            switch layout {
            case .session: buildSessionLayoutConstraints()
            case .videoOnly: buildVideoOnlyLayoutConstraints()
            }
            applyOrientationConstraints(forLandscape: view.bounds.width > view.bounds.height)
            return true
        }
    }

    private func discardSessionLayoutConstraints() {
        NSLayoutConstraint.deactivate(portraitConstraints)
        NSLayoutConstraint.deactivate(landscapeConstraints)
        NSLayoutConstraint.deactivate(fullPortraitConstraints)
        NSLayoutConstraint.deactivate(fullLandscapeConstraints)
        portraitConstraints.removeAll()
        landscapeConstraints.removeAll()
        fullPortraitConstraints.removeAll()
        fullLandscapeConstraints.removeAll()
        // The active set is gone, so the orientation cache no longer describes anything on
        // screen; leaving it would let `applyOrientationConstraints` short-circuit against a
        // set that is not installed.
        currentIsLandscape = nil
        currentUsesFullLayout = nil
    }

    /// The sink's arrangement while the control shell is gone, which is the reconnect window.
    ///
    /// Only the scroll view is mounted then, so every constraint here resolves against the
    /// controller's own view: referring to the trackpad or button row would pin the video to
    /// views that are out of the hierarchy. Default portrait keeps the exact geometry the
    /// session layout gives it, so the frame held over the outage does not move; the other
    /// three take back the space the absent chrome would have occupied, since leaving a gap
    /// for controls that are not on screen only makes the outage more obvious.
    private func buildVideoOnlyLayoutConstraints() {
        guard let scroll = sinkScrollView else { return }
        let safe = view.safeAreaLayoutGuide

        portraitConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.55)
        ])
        fullPortraitConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor)
        ])
        landscapeConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.widthAnchor.constraint(equalTo: safe.widthAnchor, multiplier: 0.62),
            scroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor)
        ])
        fullLandscapeConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor)
        ])
    }

    /// The full arrangement, shell and sink together.
    ///
    /// Callers reach it through `reconcileSessionLayout`, which discards the previous set
    /// first, so this always writes into empty arrays and never has to reason about what a
    /// previous caller left behind.
    private func buildSessionLayoutConstraints() {
        guard trackpadView.superview != nil, let scroll = sinkScrollView else { return }
        let safe = view.safeAreaLayoutGuide

        // The band's top tracks the video's bottom edge in portrait, where the sink occupies
        // the top 0.55 of the view height. A multiplier on view.bottom expresses that without
        // referring to the sink, so the two stay aligned without an ordering dependency.
        // Each set needs its own instance: one constraint object cannot be installed twice.
        func bandTopAtVideoBottom() -> NSLayoutConstraint {
            NSLayoutConstraint(
                item: displayRailView,
                attribute: .top,
                relatedBy: .equal,
                toItem: view,
                attribute: .bottom,
                multiplier: 0.55,
                constant: 0
            )
        }

        // Portrait layout. Trackpad + scroll strip span the bottom row; strip sits at
        // view.bottom * 0.55 above the trackpad; the video scroll takes the top 0.55.
        portraitConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.55),

            buttonRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            displayRailView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            displayRailView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bandTopAtVideoBottom(),

            thumbnailStripView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            thumbnailStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            thumbnailStripView.topAnchor.constraint(equalTo: displayRailView.bottomAnchor, constant: 4),

            windowPickerStripView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            windowPickerStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            keyboardSurface.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            keyboardSurface.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            trackpadView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            windowPickerStripView.topAnchor.constraint(equalTo: thumbnailStripView.bottomAnchor, constant: 4),

            trackpadView.topAnchor.constraint(equalTo: windowPickerStripView.bottomAnchor, constant: 4),
            trackpadView.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            scrollStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12)
        ])

        // Full portrait. The sink runs from the safe-area top down to the button row rather
        // than stopping at a fixed fraction, so it gets its own top/bottom pair.
        fullPortraitConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: safe.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: buttonRow.topAnchor, constant: -8),

            buttonRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            buttonRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            displayRailView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            displayRailView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bandTopAtVideoBottom(),

            thumbnailStripView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            thumbnailStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            thumbnailStripView.topAnchor.constraint(equalTo: displayRailView.bottomAnchor, constant: 4),

            windowPickerStripView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            windowPickerStripView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            keyboardSurface.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            keyboardSurface.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),

            trackpadView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            trackpadView.trailingAnchor.constraint(equalTo: scrollStripView.leadingAnchor, constant: -8),
            windowPickerStripView.topAnchor.constraint(equalTo: thumbnailStripView.bottomAnchor, constant: 4),

            trackpadView.topAnchor.constraint(equalTo: windowPickerStripView.bottomAnchor, constant: 4),
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
            thumbnailStripView.bottomAnchor.constraint(equalTo: windowPickerStripView.topAnchor, constant: -4),

            windowPickerStripView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            windowPickerStripView.trailingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: -12),
            windowPickerStripView.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),

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
            thumbnailStripView.bottomAnchor.constraint(equalTo: windowPickerStripView.topAnchor, constant: -4),

            windowPickerStripView.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            windowPickerStripView.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),
            windowPickerStripView.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),

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
    }

    func restartSessionSurfaceObservations() {
        startDesktopStateObservation()
        startThumbnailsObservation()
        startWindowListObservation()
        startAgentSayObservation()
        startCursorObservation()
        startTextInputFocusObservation()
        startHostAvailabilityObservation()
        sendCurrentClientConfig()
    }

    func hideTrackpad() {
        // A dimension constraint is owned by the row itself and therefore
        // survives removeFromSuperview. Deactivate it before remounting can
        // create a replacement that needs to collapse independently.
        buttonRowHeightConstraint?.isActive = false
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
        windowPickerStripView.removeFromSuperview()
        windowPickerStripView.renderEmpty()
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
        // The host resets its own capture target when the session ends, so holding a window
        // id across a reconnect would leave the two disagreeing about what is on screen.
        selectedWindowIdForClientConfig = nil
        applyKeyboardPresentationIntent(.hide)
        buttonRowBottomConstraint = nil
        buttonRowHeightConstraint = nil
        // R23: the shell's views are out of the hierarchy, so the set that positions things
        // against them is meaningless. Going through the reconciler rather than clearing
        // directly is what makes the difference between the two ways to get here: a teardown
        // that also drops the sink has nothing left to lay out, while one that preserves the
        // sink re-derives the video-only arrangement and keeps the held frame on screen for
        // the length of the outage.
        reconcileSessionLayout()
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
        let railTop = surfaceControlRail.topAnchor.constraint(
            equalTo: view.safeAreaLayoutGuide.topAnchor,
            constant: 8
        )
        // Yields to the bottom limit below. A collapsed rail is pushed down by
        // most of a screen height, so rotating into a shorter safe area while it
        // is closed would otherwise make the two required constraints
        // unsatisfiable and let UIKit pick which one to break. At high rather
        // than required the rail simply slides up to fit.
        railTop.priority = .defaultHigh
        // Collapsing shortens the rail, and a rail hung from the top would take
        // the chevron up with it. The offset the rail reports is the height it
        // just gave up, so adding it here leaves the chevron where the finger
        // found it.
        surfaceControlRail.onTopOffsetChange = { [weak railTop] offset in
            railTop?.constant = 8 + offset
        }
        NSLayoutConstraint.activate([
            railTop,
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
