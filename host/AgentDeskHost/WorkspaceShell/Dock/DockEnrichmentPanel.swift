import AppKit

private enum DockEnrichmentMetrics {
    static let stripHeight: CGFloat = 82
    static let statusHeight: CGFloat = 36
    static let desktopPillWidth: CGFloat = 196
    static let desktopPillHeight: CGFloat = 64
    static let desktopPillCornerRadius: CGFloat = 12
    static let desktopPillRightBadgeInset: CGFloat = 48
    static let appIconSize: CGFloat = 34
    static let appIconHitSize: CGFloat = 44
    static let appIconHoveredSize: CGFloat = 38
    static let appIconSelectedSize: CGFloat = 36
    static let badgeWidth: CGFloat = 34
    static let badgeHeight: CGFloat = 28
    static let maxVisibleAppsPerDesktop = 3
}

private enum DockEnrichmentPalette {
    static let tileSurface = WorkspaceShellOverlay.adaptiveWhite(light: 0.91, dark: 0.16)
    static let tileHoverSurface = WorkspaceShellOverlay.adaptiveWhite(light: 0.84, dark: 0.22)
}

final class DockEnrichmentPanel: NSView, DockEnrichmentRendering {
    private let color = WorkspaceShellOverlay.adaptiveWhite(light: 0.96, dark: 0.12)
    private var isKeyboardFocused = false
    private let stripContainer = NSView()
    private let swapButton = DockActionButton(
        title: "Swap",
        systemSymbolName: "arrow.left.arrow.right",
        accessibilityLabel: "Swap desktop contents"
    )
    private let scrollView = NSScrollView()
    private let desktopStrip = NSStackView()
    private let emptyLabel = NSTextField(labelWithString: "No running apps")
    private let statusView = DockDesktopSwapStatusView()
    private let tooltip = DockAppTooltipView()
    private weak var tooltipAnchor: NSView?
    private var selectedButton: DockAppIconButton?
    private var appPopover: NSPopover?
    private var popoverDelegate: DockAppPopoverDelegate?
    private var swapState = DockDesktopSwapState.idle
    private var windowFocusFailure: String?
    private var escapeMonitor: Any?

    var onSwapToggle: (() -> Void)?
    var onDesktopSelection: ((DockDesktopSwapSelection) -> Void)?
    var onWindowFocus: ((DockWindowFocusRequest) -> Void)?
    var onUndo: (() -> Void)? {
        didSet { statusView.onUndo = onUndo }
    }
    var onCancel: (() -> Void)?

    /// Maps a group's Space id to the assigned workspace name (Q2). Set by the shell presenter; read on
    /// the main thread at render, where the workspace store lives. Nil result falls back to "Desktop N".
    var workspaceLabelProvider: ((UInt64?) -> String?)?

    init() {
        super.init(frame: .zero)
        configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        MainActor.assumeIsolated {
            if let escapeMonitor {
                NSEvent.removeMonitor(escapeMonitor)
            }
        }
    }

    func render(_ snapshot: DockAppSnapshot, swapState: DockDesktopSwapState) {
        self.swapState = swapState
        closeAppPopover()
        hideTooltip()
        desktopStrip.arrangedSubviews.forEach { view in
            desktopStrip.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        let provider = workspaceLabelProvider
        let groups = snapshot.desktopGroups
            .map { group -> DockDesktopGroupSummary in
                // Overlay the assigned workspace name; keep the base "Desktop N" when unassigned.
                guard let name = group.spaceID.flatMap({ provider?($0) }) else { return group }
                return group.withLabel(name)
            }
            .filter { group in
                if swapState.isSelecting {
                    return group.spaceID != nil && group.diagnostic == nil
                }
                return !group.apps.isEmpty || group.diagnostic != nil
            }
        emptyLabel.isHidden = !groups.isEmpty
        for group in groups {
            desktopStrip.addArrangedSubview(
                DockDesktopPillView(
                    group: group,
                    swapState: swapState,
                    onDesktopSelection: { [weak self] selection in
                        self?.onDesktopSelection?(selection)
                    },
                    onAppPrimaryAction: { [weak self] button, app in
                        self?.performPrimaryAction(for: app, in: group, anchoredTo: button)
                    },
                    onAppContextMenu: { [weak self] button, app in
                        self?.showAppPopover(for: app, in: group, anchoredTo: button)
                    },
                    onAppHover: { [weak self] button, app in
                        self?.showTooltip(for: app, anchoredTo: button)
                    },
                    onAppHoverEnd: { [weak self] in
                        self?.hideTooltip()
                    }
                )
            )
        }

        renderControls(swapState)

        needsLayout = true
        needsDisplay = true
    }

    func renderWindowFocusFailure(_ message: String?) {
        windowFocusFailure = message
        statusView.render(swapState, windowFocusFailure: message)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
    }

    override func layout() {
        super.layout()
        if let tooltipAnchor, !tooltip.isHidden {
            positionTooltip(anchoredTo: tooltipAnchor)
        }
    }

    func setKeyboardFocused(_ focused: Bool) {
        guard isKeyboardFocused != focused else { return }
        isKeyboardFocused = focused
        applyColor()
    }

    override func cancelOperation(_ sender: Any?) {
        guard swapState.holdsDock, !swapState.isBusy else {
            super.cancelOperation(sender)
            return
        }
        onCancel?()
    }

    private func configure() {
        configureRootAccessibility()
        wantsLayer = true
        layer?.masksToBounds = false
        applyColor()

        stripContainer.translatesAutoresizingMaskIntoConstraints = false
        stripContainer.wantsLayer = true
        stripContainer.layer?.zPosition = 1
        addSubview(stripContainer)

        swapButton.cornerRadius = DockEnrichmentMetrics.desktopPillCornerRadius
        swapButton.target = self
        swapButton.action = #selector(toggleSwap)
        swapButton.toolTip = "Swap desktop contents"
        swapButton.setAccessibilityIdentifier("dock-desktop-swap")
        stripContainer.addSubview(swapButton)

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = true
        scrollView.borderType = .noBorder
        scrollView.automaticallyAdjustsContentInsets = false
        stripContainer.addSubview(scrollView)

        desktopStrip.orientation = .horizontal
        desktopStrip.alignment = .top
        desktopStrip.spacing = 8
        desktopStrip.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)
        desktopStrip.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = desktopStrip

        emptyLabel.font = .systemFont(ofSize: 13, weight: .medium)
        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        stripContainer.addSubview(emptyLabel)

        addSubview(statusView)

        tooltip.translatesAutoresizingMaskIntoConstraints = true
        tooltip.autoresizingMask = []
        tooltip.isHidden = true
        tooltip.layer?.zPosition = 20
        addSubview(tooltip, positioned: .above, relativeTo: stripContainer)

        NSLayoutConstraint.activate([
            stripContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            stripContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            stripContainer.bottomAnchor.constraint(equalTo: bottomAnchor),
            stripContainer.heightAnchor.constraint(equalToConstant: DockEnrichmentMetrics.stripHeight),

            swapButton.leadingAnchor.constraint(equalTo: stripContainer.leadingAnchor, constant: 10),
            swapButton.topAnchor.constraint(equalTo: scrollView.topAnchor),
            swapButton.widthAnchor.constraint(equalToConstant: DockActionButton.tileSize.width),
            swapButton.heightAnchor.constraint(equalToConstant: DockActionButton.tileSize.height),

            scrollView.leadingAnchor.constraint(equalTo: swapButton.trailingAnchor, constant: 8),
            scrollView.trailingAnchor.constraint(equalTo: stripContainer.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: stripContainer.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: stripContainer.bottomAnchor),

            desktopStrip.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            desktopStrip.topAnchor.constraint(equalTo: scrollView.contentView.topAnchor),
            desktopStrip.bottomAnchor.constraint(equalTo: scrollView.contentView.bottomAnchor),
            desktopStrip.heightAnchor.constraint(equalTo: scrollView.contentView.heightAnchor),

            emptyLabel.centerXAnchor.constraint(equalTo: stripContainer.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: stripContainer.centerYAnchor),

            statusView.centerXAnchor.constraint(equalTo: centerXAnchor),
            statusView.bottomAnchor.constraint(equalTo: stripContainer.topAnchor, constant: -8),
            statusView.heightAnchor.constraint(equalToConstant: DockEnrichmentMetrics.statusHeight),
            statusView.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -24),
        ])
    }

    @objc private func toggleSwap() {
        onSwapToggle?()
    }

    private func renderControls(_ state: DockDesktopSwapState) {
        swapButton.isEnabled = !state.isBusy
        swapButton.state = state.holdsDock ? .on : .off
        applySwapButtonStyle(state)
        swapButton.setAccessibilityValue(state.holdsDock ? "active" : "inactive")

        statusView.render(state, windowFocusFailure: windowFocusFailure)
        updateEscapeMonitor(for: state)
    }

    private func applySwapButtonStyle(_ state: DockDesktopSwapState) {
        swapButton.restingColor = state.holdsDock ? AppTheme.accent : DockEnrichmentPalette.tileSurface
        swapButton.hoverColor = state.holdsDock ? AppTheme.activeHoverFill : DockEnrichmentPalette.tileHoverSurface
        swapButton.foregroundColor = state.holdsDock ? AppTheme.onAccent : AppTheme.accent
        effectiveAppearance.performAsCurrentDrawingAppearance {
            swapButton.layer?.borderColor = (state.holdsDock ? AppTheme.accent : NSColor.separatorColor).cgColor
            swapButton.layer?.borderWidth = state.holdsDock ? 2 : 1
        }
    }

    private func updateEscapeMonitor(for state: DockDesktopSwapState) {
        let shouldMonitor = state.holdsDock && !state.isBusy
        if shouldMonitor, escapeMonitor == nil {
            escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard event.keyCode == 53 else { return event }
                MainActor.assumeIsolated { self?.onCancel?() }
                return nil
            }
        } else if !shouldMonitor, let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
    }

    private func configureRootAccessibility() {
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(WorkspaceShellControlWindow.dockEnrichment)
        setAccessibilityIdentifier("workspace-dock-enrichment")
    }

    private func showTooltip(for app: DockAppInstanceSummary, anchoredTo button: DockAppIconButton) {
        tooltip.setText(appDisplayName(app))
        tooltipAnchor = button
        tooltip.isHidden = false
        positionTooltip(anchoredTo: button)
    }

    private func hideTooltip() {
        tooltip.isHidden = true
        tooltipAnchor = nil
    }

    private func positionTooltip(anchoredTo anchor: NSView) {
        tooltip.layoutSubtreeIfNeeded()
        let anchorFrame = anchor.convert(anchor.bounds, to: self)
        let size = tooltip.fittingSize
        let x = min(
            max(8, anchorFrame.midX - size.width / 2),
            max(8, bounds.width - size.width - 8)
        )
        let lowerBound = DockEnrichmentMetrics.stripHeight + 8
        let upperBound = max(lowerBound, bounds.height - size.height - 6)
        let y = min(max(lowerBound, anchorFrame.maxY + 12), upperBound)
        tooltip.frame = CGRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func showAppPopover(
        for app: DockAppInstanceSummary,
        in group: DockDesktopGroupSummary,
        anchoredTo button: DockAppIconButton
    ) {
        hideTooltip()
        selectedButton?.isSelectedForPopover = false
        selectedButton = button
        button.isSelectedForPopover = true

        appPopover?.close()
        let popover = NSPopover()
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 480, height: 320)
        popover.contentViewController = NSViewController()
        popover.contentViewController?.view = DockAppInstancesPopoverView(
            app: app,
            group: group,
            instances: instances(matching: app, in: group),
            onWindowFocus: { [weak self] request in
                self?.focusWindow(request)
            }
        )

        let delegate = DockAppPopoverDelegate { [weak self] in
            self?.clearSelectedButton()
        }
        popover.delegate = delegate
        popoverDelegate = delegate
        appPopover = popover
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
    }

    private func performPrimaryAction(
        for app: DockAppInstanceSummary,
        in group: DockDesktopGroupSummary,
        anchoredTo button: DockAppIconButton
    ) {
        let scopedInstances = instances(matching: app, in: group)
        guard let request = DockWindowFocusRequest.onlyWindow(
            in: scopedInstances,
            group: group
        ) else {
            showAppPopover(for: app, in: group, anchoredTo: button)
            return
        }
        focusWindow(request)
    }

    private func focusWindow(_ request: DockWindowFocusRequest) {
        closeAppPopover()
        hideTooltip()
        onWindowFocus?(request)
    }

    private func closeAppPopover() {
        appPopover?.close()
        appPopover = nil
        popoverDelegate = nil
        clearSelectedButton()
    }

    private func clearSelectedButton() {
        selectedButton?.isSelectedForPopover = false
        selectedButton = nil
    }

    private func instances(
        matching app: DockAppInstanceSummary,
        in group: DockDesktopGroupSummary
    ) -> [DockAppInstanceSummary] {
        group.apps.filter { candidate in
            if let bundle = app.bundleIdentifier, !bundle.isEmpty {
                return candidate.bundleIdentifier == bundle
            }
            return candidate.name == app.name
        }
    }

    private func applyColor() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.isOpaque = false
            layer?.backgroundColor = NSColor.clear.cgColor
            layer?.borderColor = NSColor.clear.cgColor
            layer?.borderWidth = 0
            layer?.cornerRadius = 13
            stripContainer.layer?.backgroundColor = color.cgColor
            stripContainer.layer?.borderColor = isKeyboardFocused ? AppTheme.accent.cgColor : NSColor.separatorColor.cgColor
            stripContainer.layer?.borderWidth = isKeyboardFocused ? 2 : 1
            stripContainer.layer?.cornerRadius = 13
        }
        applySwapButtonStyle(swapState)
    }
}

private final class DockDesktopPillView: NSView {
    private let group: DockDesktopGroupSummary
    private let onAppPrimaryAction: (DockAppIconButton, DockAppInstanceSummary) -> Void
    private let onAppContextMenu: (DockAppIconButton, DockAppInstanceSummary) -> Void
    private let onAppHover: (DockAppIconButton, DockAppInstanceSummary) -> Void
    private let onAppHoverEnd: () -> Void
    private let swapState: DockDesktopSwapState
    private let onDesktopSelection: (DockDesktopSwapSelection) -> Void

    init(
        group: DockDesktopGroupSummary,
        swapState: DockDesktopSwapState,
        onDesktopSelection: @escaping (DockDesktopSwapSelection) -> Void,
        onAppPrimaryAction: @escaping (DockAppIconButton, DockAppInstanceSummary) -> Void,
        onAppContextMenu: @escaping (DockAppIconButton, DockAppInstanceSummary) -> Void,
        onAppHover: @escaping (DockAppIconButton, DockAppInstanceSummary) -> Void,
        onAppHoverEnd: @escaping () -> Void
    ) {
        self.group = group
        self.swapState = swapState
        self.onDesktopSelection = onDesktopSelection
        self.onAppPrimaryAction = onAppPrimaryAction
        self.onAppContextMenu = onAppContextMenu
        self.onAppHover = onAppHover
        self.onAppHoverEnd = onAppHoverEnd
        super.init(frame: .zero)
        configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func rightMouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
    }

    private func configure() {
        wantsLayer = true
        applyColor()
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("dock-desktop-\(group.spaceID.map(String.init) ?? "unknown")")
        setAccessibilityLabel("\(group.desktopLabel) on \(group.monitorName)")

        let icons = NSStackView()
        icons.orientation = .horizontal
        icons.alignment = .centerY
        icons.spacing = 2
        icons.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icons)

        for app in group.apps.prefix(DockEnrichmentMetrics.maxVisibleAppsPerDesktop) {
            let button = DockAppIconButton(app: app)
            button.onPrimaryAction = { [weak self, weak button] in
                guard let self, let button else { return }
                self.onAppPrimaryAction(button, app)
            }
            button.onContextMenu = { [weak self, weak button] in
                guard let self, let button else { return }
                self.onAppContextMenu(button, app)
            }
            button.onHover = { [weak self, weak button] hovering in
                guard let self, let button else { return }
                if hovering {
                    self.onAppHover(button, app)
                } else {
                    self.onAppHoverEnd()
                }
            }
            icons.addArrangedSubview(button)
        }

        let badge = DockMonitorBadgeView(label: group.monitorBadgeLabel, isActive: group.isActive)
        badge.translatesAutoresizingMaskIntoConstraints = false
        addSubview(badge)

        // The workspace name (already resolved into `group.desktopLabel` by the panel's label provider;
        // falls back to "Desktop N"). The donor pill only exposed this via accessibility; AgentDesk shows
        // it along the pill's bottom so the workspace each Desktop hosts is visible at a glance.
        let name = label(
            group.desktopLabel,
            size: 11,
            weight: group.isActive ? .semibold : .medium,
            color: group.isActive ? .labelColor : .secondaryLabelColor
        )
        name.translatesAutoresizingMaskIntoConstraints = false
        name.setAccessibilityIdentifier("dock-desktop-name")
        addSubview(name)

        if swapState.isSelecting, let spaceID = group.spaceID,
           let marker = swapState.marker(for: spaceID) {
            let selection = DockDesktopSwapSelection(
                spaceID: spaceID,
                desktopLabel: group.desktopLabel,
                monitorBadgeLabel: group.monitorBadgeLabel
            )
            let selectionButton = DockDesktopSelectionButton(
                marker: marker,
                isChosen: swapState.isSelected(spaceID: spaceID),
                selection: selection,
                onSelect: onDesktopSelection
            )
            selectionButton.translatesAutoresizingMaskIntoConstraints = false
            addSubview(selectionButton)
            NSLayoutConstraint.activate([
                selectionButton.leadingAnchor.constraint(equalTo: leadingAnchor),
                selectionButton.trailingAnchor.constraint(equalTo: trailingAnchor),
                selectionButton.topAnchor.constraint(equalTo: topAnchor),
                selectionButton.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: DockEnrichmentMetrics.desktopPillWidth),
            heightAnchor.constraint(equalToConstant: DockEnrichmentMetrics.desktopPillHeight),

            icons.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            icons.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -DockEnrichmentMetrics.desktopPillRightBadgeInset),
            icons.topAnchor.constraint(equalTo: topAnchor, constant: 3),

            badge.widthAnchor.constraint(equalToConstant: DockEnrichmentMetrics.badgeWidth),
            badge.heightAnchor.constraint(equalToConstant: DockEnrichmentMetrics.badgeHeight),
            badge.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),

            name.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            name.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),
            name.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])
    }

    private func applyColor() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = DockEnrichmentPalette.tileSurface.cgColor
            layer?.borderColor = (group.isActive ? AppTheme.accent : NSColor.separatorColor).cgColor
            layer?.borderWidth = group.isActive ? 2 : 1
            layer?.cornerRadius = DockEnrichmentMetrics.desktopPillCornerRadius
        }
    }
}

private final class DockMonitorBadgeView: NSView {
    private let label: String
    private let isActive: Bool

    init(label: String, isActive: Bool) {
        self.label = label
        self.isActive = isActive
        super.init(frame: .zero)
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let accent = isActive ? AppTheme.accent : NSColor.secondaryLabelColor
        let screen = NSRect(x: 4, y: 3, width: 26, height: 17)
        let path = NSBezierPath(roundedRect: screen, xRadius: 4, yRadius: 4)
        WorkspaceShellOverlay.adaptiveWhite(light: 0.88, dark: 0.18).withAlphaComponent(0.4).setFill()
        path.fill()
        accent.setStroke()
        path.lineWidth = 2
        path.stroke()

        let stand = NSBezierPath()
        stand.lineWidth = 2
        stand.lineCapStyle = .round
        stand.move(to: NSPoint(x: 17, y: 20))
        stand.line(to: NSPoint(x: 17, y: 24))
        stand.move(to: NSPoint(x: 14, y: 24))
        stand.line(to: NSPoint(x: 20, y: 24))
        stand.stroke()

        let text = label as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .heavy),
            .foregroundColor: accent,
        ]
        let textSize = text.size(withAttributes: attributes)
        text.draw(
            at: NSPoint(x: bounds.midX - textSize.width / 2, y: screen.midY - textSize.height / 2),
            withAttributes: attributes
        )
    }
}

private final class DockAppIconButton: NSView {
    var onPrimaryAction: (() -> Void)?
    var onContextMenu: (() -> Void)?
    var onHover: ((Bool) -> Void)?
    var isSelectedForPopover = false {
        didSet { applyLayerStyle() }
    }

    private let app: DockAppInstanceSummary
    private let imageView = NSImageView()
    private let selectionDot = NSView()
    private var imageWidthConstraint: NSLayoutConstraint?
    private var imageHeightConstraint: NSLayoutConstraint?
    private var imageCenterYConstraint: NSLayoutConstraint?
    private var trackingAreaToken: NSTrackingArea?
    private var isMouseDownInside = false

    init(app: DockAppInstanceSummary) {
        self.app = app
        super.init(frame: .zero)
        configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaToken {
            removeTrackingArea(trackingAreaToken)
        }
        let tracking = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(tracking)
        trackingAreaToken = tracking
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        isHovered = true
        onHover?(true)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        guard !isMouseDownInside else { return }
        isHovered = false
        onHover?(false)
    }

    override func mouseDown(with event: NSEvent) {
        isMouseDownInside = true
        isHovered = true
        onHover?(true)
    }

    override func mouseUp(with event: NSEvent) {
        isMouseDownInside = false
        let point = convert(event.locationInWindow, from: nil)
        if bounds.insetBy(dx: -2, dy: -2).contains(point) {
            isHovered = true
            onHover?(true)
            onPrimaryAction?()
        } else {
            isHovered = false
            onHover?(false)
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        isMouseDownInside = true
        isHovered = true
        onHover?(true)
        onContextMenu?()
        isMouseDownInside = false
    }

    override func accessibilityPerformPress() -> Bool {
        guard let onPrimaryAction else { return false }
        onPrimaryAction()
        return true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyLayerStyle()
    }

    private var isHovered = false {
        didSet { applyLayerStyle() }
    }

    private func configure() {
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.masksToBounds = false

        imageView.image = appIcon(app)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.wantsLayer = true
        imageView.layer?.masksToBounds = false
        addSubview(imageView)

        selectionDot.translatesAutoresizingMaskIntoConstraints = false
        selectionDot.wantsLayer = true
        selectionDot.layer?.cornerRadius = 2.5
        selectionDot.layer?.backgroundColor = AppTheme.accent.cgColor
        selectionDot.isHidden = true
        addSubview(selectionDot)

        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityIdentifier("dock-app-\(app.pid)")
        setAccessibilityLabel(appDisplayName(app))
        applyLayerStyle()

        let imageWidth = imageView.widthAnchor.constraint(equalToConstant: DockEnrichmentMetrics.appIconSize)
        let imageHeight = imageView.heightAnchor.constraint(equalToConstant: DockEnrichmentMetrics.appIconSize)
        let imageCenterY = imageView.centerYAnchor.constraint(equalTo: centerYAnchor)
        imageWidthConstraint = imageWidth
        imageHeightConstraint = imageHeight
        imageCenterYConstraint = imageCenterY

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: DockEnrichmentMetrics.appIconHitSize),
            heightAnchor.constraint(equalToConstant: DockEnrichmentMetrics.appIconHitSize),
            imageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            imageCenterY,
            imageWidth,
            imageHeight,
            selectionDot.widthAnchor.constraint(equalToConstant: 5),
            selectionDot.heightAnchor.constraint(equalToConstant: 5),
            selectionDot.centerXAnchor.constraint(equalTo: centerXAnchor),
            selectionDot.bottomAnchor.constraint(equalTo: bottomAnchor, constant: 1),
        ])
    }

    private func applyLayerStyle() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let size = isHovered ? DockEnrichmentMetrics.appIconHoveredSize : (isSelectedForPopover ? DockEnrichmentMetrics.appIconSelectedSize : DockEnrichmentMetrics.appIconSize)
            imageWidthConstraint?.constant = size
            imageHeightConstraint?.constant = size
            imageCenterYConstraint?.constant = isHovered ? 4 : (isSelectedForPopover ? 3 : 0)
            imageView.layer?.cornerRadius = 9
            imageView.layer?.borderWidth = isSelectedForPopover ? 2 : 1
            imageView.layer?.borderColor = (isSelectedForPopover ? NSColor.white.withAlphaComponent(0.78) : NSColor.white.withAlphaComponent(0.22)).cgColor
            imageView.layer?.shadowColor = NSColor.black.cgColor
            imageView.layer?.shadowOpacity = isHovered || isSelectedForPopover ? 0.34 : 0.22
            imageView.layer?.shadowRadius = isHovered || isSelectedForPopover ? 12 : 8
            imageView.layer?.shadowOffset = CGSize(width: 0, height: isHovered || isSelectedForPopover ? -2 : -1)
            selectionDot.isHidden = !isSelectedForPopover
            selectionDot.layer?.backgroundColor = AppTheme.accent.cgColor
        }
    }

    private func appIcon(_ app: DockAppInstanceSummary) -> NSImage {
        let image: NSImage
        if let bundleURL = app.bundleURL {
            image = NSWorkspace.shared.icon(forFile: bundleURL.path)
        } else {
            image = NSImage(named: NSImage.applicationIconName) ?? NSImage(size: NSSize(width: 34, height: 34))
        }
        image.size = NSSize(width: DockEnrichmentMetrics.appIconSize, height: DockEnrichmentMetrics.appIconSize)
        return image
    }
}

private final class DockAppTooltipView: NSView {
    private let label = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func setText(_ text: String) {
        guard label.stringValue != text else { return }
        label.stringValue = text
        invalidateIntrinsicContentSize()
    }

    override var fittingSize: NSSize {
        let labelSize = label.intrinsicContentSize
        return NSSize(width: min(220, labelSize.width + 20), height: labelSize.height + 14)
    }

    private func configure() {
        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        layer?.backgroundColor = WorkspaceShellOverlay.adaptiveWhite(light: 0.94, dark: 0.18).cgColor
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.42
        layer?.shadowRadius = 16
        layer?.shadowOffset = CGSize(width: 0, height: -6)

        label.font = .systemFont(ofSize: 12, weight: .bold)
        label.textColor = .labelColor
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)

        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
}

private final class DockAppInstancesPopoverView: NSView {
    private let app: DockAppInstanceSummary
    private let group: DockDesktopGroupSummary
    private let instances: [DockAppInstanceSummary]
    private let onWindowFocus: (DockWindowFocusRequest) -> Void

    init(
        app: DockAppInstanceSummary,
        group: DockDesktopGroupSummary,
        instances: [DockAppInstanceSummary],
        onWindowFocus: @escaping (DockWindowFocusRequest) -> Void
    ) {
        self.app = app
        self.group = group
        self.instances = instances
        self.onWindowFocus = onWindowFocus
        super.init(frame: .zero)
        configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func configure() {
        wantsLayer = true
        layer?.backgroundColor = WorkspaceShellOverlay.adaptiveWhite(light: 0.96, dark: 0.13).cgColor

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        stack.addArrangedSubview(label(appDisplayName(app), size: 15, weight: .bold, color: .labelColor))
        stack.addArrangedSubview(label("\(group.desktopLabel) · \(group.monitorDetailLabel)", size: 11, weight: .medium, color: .secondaryLabelColor))

        let windowCount = instances.reduce(0) { $0 + $1.windows.count }
        stack.addArrangedSubview(label("\(instances.count) \(instances.count == 1 ? "instance" : "instances") · \(windowCount) \(windowCount == 1 ? "window" : "windows")", size: 11, weight: .regular, color: .tertiaryLabelColor))

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.borderType = .noBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let document = FlippedDockPopoverDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document

        let rows = NSStackView()
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 8
        rows.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(rows)
        for instance in instances {
            rows.addArrangedSubview(
                DockAppInstanceRowView(
                    app: instance,
                    group: group,
                    onWindowFocus: onWindowFocus
                )
            )
        }

        stack.addArrangedSubview(scroll)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),

            scroll.widthAnchor.constraint(equalToConstant: 452),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 190),

            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            document.heightAnchor.constraint(greaterThanOrEqualTo: scroll.contentView.heightAnchor),

            rows.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            rows.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            rows.topAnchor.constraint(equalTo: document.topAnchor),
            document.bottomAnchor.constraint(greaterThanOrEqualTo: rows.bottomAnchor),
        ])
    }
}

private final class FlippedDockPopoverDocumentView: NSView {
    override var isFlipped: Bool { true }
}

private final class DockAppInstanceRowView: NSView {
    private let app: DockAppInstanceSummary
    private let group: DockDesktopGroupSummary
    private let onWindowFocus: (DockWindowFocusRequest) -> Void

    init(
        app: DockAppInstanceSummary,
        group: DockDesktopGroupSummary,
        onWindowFocus: @escaping (DockWindowFocusRequest) -> Void
    ) {
        self.app = app
        self.group = group
        self.onWindowFocus = onWindowFocus
        super.init(frame: .zero)
        configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func configure() {
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.backgroundColor = WorkspaceShellOverlay.adaptiveWhite(light: 0.9, dark: 0.19).cgColor
        translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 10
        row.edgeInsets = NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        let icon = NSImageView(image: iconImage(app))
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        row.addArrangedSubview(icon)

        let text = NSStackView()
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 4
        text.translatesAutoresizingMaskIntoConstraints = false
        row.addArrangedSubview(text)

        text.addArrangedSubview(label(appDisplayName(app), size: 13, weight: .semibold, color: .labelColor))
        text.addArrangedSubview(label("pid \(app.pid)", size: 10, weight: .regular, color: .secondaryLabelColor))
        text.addArrangedSubview(label(app.bundleIdentifier ?? "no bundle id", size: 10, weight: .regular, color: .tertiaryLabelColor))
        if let axErrorCode = app.axErrorCode {
            text.addArrangedSubview(label("AX error \(axErrorCode)", size: 10, weight: .regular, color: .systemOrange))
        }
        if app.windows.isEmpty {
            text.addArrangedSubview(label("No windows", size: 10, weight: .regular, color: .tertiaryLabelColor))
        } else {
            for window in app.windows.prefix(6) {
                text.addArrangedSubview(
                    DockWindowFocusButton(
                        request: DockWindowFocusRequest(app: app, window: window, group: group),
                        onFocus: onWindowFocus
                    )
                )
            }
        }

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 452),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            icon.widthAnchor.constraint(equalToConstant: 36),
            icon.heightAnchor.constraint(equalToConstant: 36),
        ])
    }
}

final class DockWindowFocusButton: NSButton {
    private let request: DockWindowFocusRequest
    private let onFocus: (DockWindowFocusRequest) -> Void

    init(
        request: DockWindowFocusRequest,
        onFocus: @escaping (DockWindowFocusRequest) -> Void
    ) {
        self.request = request
        self.onFocus = onFocus
        super.init(frame: .zero)
        let prefix = request.isFocused ? "* " : ""
        let suffix = request.isMinimized ? " minimized" : ""
        title = "\(prefix)\(request.title)\(suffix)"
        font = .systemFont(ofSize: 10, weight: .regular)
        alignment = .left
        lineBreakMode = .byTruncatingTail
        isBordered = false
        bezelStyle = .inline
        target = self
        action = #selector(focusWindow)
        toolTip = "Focus \(request.title)"
        setAccessibilityIdentifier(
            "dock-window-focus-\(request.pid)-\(request.windowID.map(String.init) ?? "unknown")"
        )
        setAccessibilityLabel("Focus \(request.title)")
        translatesAutoresizingMaskIntoConstraints = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func accessibilityPerformPress() -> Bool {
        guard isEnabled else { return false }
        focusWindow()
        return true
    }

    @objc private func focusWindow() {
        onFocus(request)
    }
}

private final class DockAppPopoverDelegate: NSObject, NSPopoverDelegate {
    private let didClose: () -> Void

    init(didClose: @escaping () -> Void) {
        self.didClose = didClose
    }

    func popoverDidClose(_ notification: Notification) {
        didClose()
    }
}

private func appDisplayName(_ app: DockAppInstanceSummary) -> String {
    if let duplicateIndex = app.duplicateIndex {
        return "\(app.name) #\(duplicateIndex)"
    }
    return app.name
}

private func iconImage(_ app: DockAppInstanceSummary) -> NSImage {
    let image: NSImage
    if let bundleURL = app.bundleURL {
        image = NSWorkspace.shared.icon(forFile: bundleURL.path)
    } else {
        image = NSImage(named: NSImage.applicationIconName) ?? NSImage(size: NSSize(width: 36, height: 36))
    }
    image.size = NSSize(width: 36, height: 36)
    return image
}

@MainActor
private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    field.maximumNumberOfLines = 1
    field.translatesAutoresizingMaskIntoConstraints = false
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return field
}
