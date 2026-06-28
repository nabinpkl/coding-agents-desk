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
        view.insertSubview(scroll, at: 0)

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
        // controller view) are orientation-variant. Captured here into
        // the portrait array; the matching landscape entries (which need
        // the thumbnailStripView reference for the scroll's bottom edge) are
        // appended in showTrackpad before applyOrientationConstraints
        // fires.
        portraitConstraints.append(contentsOf: [
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.heightAnchor.constraint(equalTo: view.heightAnchor, multiplier: 0.55)
        ])

        // Double-tap zoom toggle: 1.0 ↔ 2.0, animated, centered on the
        // tap point. See PairingViewController+EdgeFollow for the handler.
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleSinkDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)

        sinkScrollView = scroll

        let dot = CursorPointerView()
        dot.isHidden = true
        view.addSubview(dot)
        cursorDotView = dot
    }

    func showTrackpad() {
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

        // R25: the merged Spaces band is just the thumbnail strip.
        displayRailView.translatesAutoresizingMaskIntoConstraints = false
        displayRailView.delegate = self
        displayRailView.isHidden = true
        view.addSubview(displayRailView)

        thumbnailStripView.translatesAutoresizingMaskIntoConstraints = false
        thumbnailStripView.delegate = self
        thumbnailStripView.isHidden = true
        view.addSubview(thumbnailStripView)

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

        // Shared constraints, active for the entire session in both
        // orientations. Heights, fixed widths, intra-card hint
        // placement, and anchors that resolve to the same edge in
        // either orientation.
        NSLayoutConstraint.activate([
            bottomConstraint,
            buttonRow.heightAnchor.constraint(equalToConstant: 44),

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

        // Landscape layout. Video scroll occupies the left ~62% of the
        // safe area at full height; strip pins below it on the left
        // column. Trackpad + scroll strip + buttons live in the right
        // column.
        if let scroll = sinkScrollView {
            let safe = view.safeAreaLayoutGuide
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
        }

        applyOrientationConstraints(forLandscape: view.bounds.width > view.bounds.height)

        // R24: the chrome buttons (settings + orientation toggle) were
        // added to the view in configureSettingsButton (viewDidLoad)
        // before the session UI existed, so showTrackpad's addSubview
        // calls for scrollStripView et al land in front of them. Bring
        // the chrome back to the top so the pills are tappable in the
        // landscape right column where their 36pt box overlaps the
        // scroll strip's x range.
        view.bringSubviewToFront(orientationToggleButton)
        view.bringSubviewToFront(settingsButton)

        gestureTranslator.delegate = self
        trackpadView.gestureRecognizers?.forEach { trackpadView.removeGestureRecognizer($0) }
        scrollStripView.gestureRecognizers?.forEach { scrollStripView.removeGestureRecognizer($0) }
        gestureTranslator.attach(to: trackpadView)
        gestureTranslator.attachScrollStrip(to: scrollStripView)

        startDesktopStateObservation()
        startThumbnailsObservation()
        startAgentSayObservation()
        startCursorObservation()
        sendCurrentClientConfig()
    }

    func hideTrackpad() {
        trackpadView.removeFromSuperview()
        scrollStripView.removeFromSuperview()
        buttonRow.removeFromSuperview()
        rightClickButton.removeFromSuperview()
        showKeyboardButton.removeFromSuperview()
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
        cursorPositionTask?.cancel()
        cursorPositionTask = nil
        stopAgentSayForegroundPresentation()
        lastDesktopState = nil
        selectedDisplayIdForClientConfig = nil
        keyboardSurface.setVisible(false)
        buttonRowBottomConstraint = nil
        // R23: drop the orientation-variant constraints; the next
        // mountSinkView/showTrackpad will repopulate fresh arrays.
        NSLayoutConstraint.deactivate(portraitConstraints)
        NSLayoutConstraint.deactivate(landscapeConstraints)
        portraitConstraints.removeAll()
        landscapeConstraints.removeAll()
        currentIsLandscape = nil
    }

    // R23: swap the active orientation's constraint set. Safe to call
    // when both arrays are empty (initial state before the first
    // session): NSLayoutConstraint.deactivate/activate on an empty
    // array is a no-op.
    func applyOrientationConstraints(forLandscape isLandscape: Bool) {
        if currentIsLandscape == isLandscape && (!portraitConstraints.isEmpty || !landscapeConstraints.isEmpty) {
            return
        }
        if isLandscape {
            NSLayoutConstraint.deactivate(portraitConstraints)
            NSLayoutConstraint.activate(landscapeConstraints)
        } else {
            NSLayoutConstraint.deactivate(landscapeConstraints)
            NSLayoutConstraint.activate(portraitConstraints)
        }
        currentIsLandscape = isLandscape
    }

    func configureSettingsButton() {
        let image = UIImage(systemName: "gearshape")
        settingsButton.setImage(image, for: .normal)
        settingsButton.tintColor = .label
        // Sits on top of the live screen-share video. The translucent
        // pill keeps the icon legible against arbitrary video content.
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

        // R24: orientation toggle to the left of the settings button.
        orientationToggleButton.tintColor = .label
        orientationToggleButton.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.7)
        orientationToggleButton.layer.cornerRadius = 18
        orientationToggleButton.layer.masksToBounds = true
        orientationToggleButton.accessibilityIdentifier = "orientation-toggle"
        orientationToggleButton.addTarget(self, action: #selector(toggleOrientation), for: .touchUpInside)
        orientationToggleButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(orientationToggleButton)
        NSLayoutConstraint.activate([
            orientationToggleButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            orientationToggleButton.trailingAnchor.constraint(equalTo: settingsButton.leadingAnchor, constant: -8),
            orientationToggleButton.widthAnchor.constraint(equalToConstant: 36),
            orientationToggleButton.heightAnchor.constraint(equalToConstant: 36)
        ])
        updateOrientationToggleIcon(forLandscape: view.bounds.width > view.bounds.height)
    }

    func updateOrientationToggleIcon(forLandscape isLandscape: Bool) {
        let name = isLandscape ? "rectangle.portrait.rotate" : "rectangle.landscape.rotate"
        orientationToggleButton.setImage(UIImage(systemName: name), for: .normal)
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
        let nav = UINavigationController(rootViewController: settings)
        present(nav, animated: true)
    }

    @objc func rightClickTapped() {
        sendInput(.click(button: .right))
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
