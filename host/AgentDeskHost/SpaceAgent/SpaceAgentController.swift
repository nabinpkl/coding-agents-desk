import AppKit

@MainActor
final class SpaceAgentController: NSObject {
    private enum DefaultsKey {
        static let originX = "SpaceAgent.origin.x"
        static let originY = "SpaceAgent.origin.y"
    }

    private let spacesProvider: SpacesProvider
    private let thumbnailProvider: SpaceThumbnailProvider
    private let commitStep: (Int) -> Void
    private let userDefaults: UserDefaults
    private let viewController = SpaceAgentViewController()
    private var panel: NSPanel?
    private var latestState: DesktopState?
    private var latestThumbnails: [UInt64: Data] = [:]
    private var thumbnailsTask: Task<Void, Never>?
    private var spaceChangeObserver: NSObjectProtocol?
    private var pendingHandleScreenOrigin: CGPoint?
    private var outsideClickMonitor: Any?

    init(
        spacesProvider: SpacesProvider,
        thumbnailProvider: SpaceThumbnailProvider,
        userDefaults: UserDefaults = .standard,
        commitStep: @escaping (Int) -> Void
    ) {
        self.spacesProvider = spacesProvider
        self.thumbnailProvider = thumbnailProvider
        self.userDefaults = userDefaults
        self.commitStep = commitStep
        super.init()
        viewController.delegate = self
    }

    func stop() {
        thumbnailsTask?.cancel()
        thumbnailsTask = nil
        if let spaceChangeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(spaceChangeObserver)
            self.spaceChangeObserver = nil
        }
        uninstallOutsideClickMonitor()
        thumbnailProvider.setDemand(owner: .spaceAgent, enabled: false)
        panel?.close()
        panel = nil
    }

    func start() {
        guard panel == nil else { return }
        let size = viewController.preferredPanelSize
        let origin = restoredOrigin(size: size) ?? SpaceAgentPanelPlacement.defaultOrigin(
            size: size,
            visibleFrames: visibleFrames()
        )
        let panel = NSPanel(
            contentRect: CGRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentViewController = viewController
        panel.delegate = self
        self.panel = panel

        installSpaceObserver()
        refreshState()
        resizePanel()
        panel.orderFrontRegardless()
    }

    private func installSpaceObserver() {
        guard spaceChangeObserver == nil else { return }
        spaceChangeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.refreshState()
            }
        }
    }

    private func refreshState() {
        latestState = spacesProvider.current()
        render()
    }

    private func render() {
        viewController.render(tiles: SpaceAgentModel.tiles(
            state: latestState,
            thumbnails: latestThumbnails,
            topWindows: thumbnailProvider.latestTopWindows
        ))
        resizePanel()
    }

    private func setExpanded(_ expanded: Bool) {
        guard viewController.isExpanded != expanded else { return }
        pendingHandleScreenOrigin = viewController.handleScreenOrigin()
        viewController.isExpanded = expanded
        if expanded {
            latestState = spacesProvider.current()
            thumbnailProvider.setDemand(owner: .spaceAgent, enabled: true)
            startThumbnailTask()
            installOutsideClickMonitor()
        } else {
            thumbnailsTask?.cancel()
            thumbnailsTask = nil
            thumbnailProvider.setDemand(owner: .spaceAgent, enabled: false)
            uninstallOutsideClickMonitor()
        }
        render()
    }

    // Global monitors only fire for events outside the receiving process,
    // so any click this picks up while the popover is expanded is by
    // definition outside our panel. That makes it the right hook for a
    // "tap-outside-to-dismiss" affordance without having to compute hit
    // rects against the panel's frame ourselves.
    private func installOutsideClickMonitor() {
        guard outsideClickMonitor == nil else { return }
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.viewController.isExpanded else { return }
                self.setExpanded(false)
            }
        }
    }

    private func uninstallOutsideClickMonitor() {
        guard let monitor = outsideClickMonitor else { return }
        NSEvent.removeMonitor(monitor)
        outsideClickMonitor = nil
    }

    private func startThumbnailTask() {
        thumbnailsTask?.cancel()
        let stream = thumbnailProvider.thumbnails
        thumbnailsTask = Task { @MainActor [weak self] in
            for await thumbnails in stream {
                guard let self else { return }
                self.latestThumbnails = thumbnails
                self.render()
            }
        }
    }

    private func resizePanel() {
        guard let panel else { return }
        let size = viewController.preferredPanelSize
        let origin = resizedPanelOrigin(
            panel: panel,
            size: size,
            pinnedHandleScreenOrigin: pendingHandleScreenOrigin
        )
        pendingHandleScreenOrigin = nil
        panel.setFrame(CGRect(origin: origin, size: size), display: true)
        save(origin: origin)
    }

    private func resizedPanelOrigin(
        panel: NSPanel,
        size: CGSize,
        pinnedHandleScreenOrigin: CGPoint?
    ) -> CGPoint {
        let visibleFrames = visibleFrames()
        guard let pinnedHandleScreenOrigin else {
            return SpaceAgentPanelPlacement.clampedOrigin(
                proposed: panel.frame.origin,
                size: size,
                visibleFrames: visibleFrames
            )
        }

        let originalOrigin = panel.frame.origin
        panel.setFrame(CGRect(origin: originalOrigin, size: size), display: false)
        viewController.view.layoutSubtreeIfNeeded()
        guard let resizedHandleScreenOrigin = viewController.handleScreenOrigin() else {
            return SpaceAgentPanelPlacement.clampedOrigin(
                proposed: originalOrigin,
                size: size,
                visibleFrames: visibleFrames
            )
        }
        let correctedOrigin = CGPoint(
            x: originalOrigin.x + pinnedHandleScreenOrigin.x - resizedHandleScreenOrigin.x,
            y: originalOrigin.y + pinnedHandleScreenOrigin.y - resizedHandleScreenOrigin.y
        )
        return SpaceAgentPanelPlacement.clampedOrigin(
            proposed: correctedOrigin,
            size: size,
            visibleFrames: visibleFrames
        )
    }

    private func restoredOrigin(size: CGSize) -> CGPoint? {
        guard userDefaults.object(forKey: DefaultsKey.originX) != nil,
              userDefaults.object(forKey: DefaultsKey.originY) != nil
        else { return nil }
        return SpaceAgentPanelPlacement.clampedOrigin(
            proposed: CGPoint(
                x: userDefaults.double(forKey: DefaultsKey.originX),
                y: userDefaults.double(forKey: DefaultsKey.originY)
            ),
            size: size,
            visibleFrames: visibleFrames()
        )
    }

    private func save(origin: CGPoint) {
        userDefaults.set(Double(origin.x), forKey: DefaultsKey.originX)
        userDefaults.set(Double(origin.y), forKey: DefaultsKey.originY)
    }

    private func visibleFrames() -> [CGRect] {
        NSScreen.screens.map(\.visibleFrame)
    }
}

extension SpaceAgentController: SpaceAgentViewControllerDelegate {
    func spaceAgentViewControllerDidToggle(_ controller: SpaceAgentViewController) {
        setExpanded(!controller.isExpanded)
    }

    func spaceAgentViewController(_ controller: SpaceAgentViewController, didSelectStepDelta delta: Int) {
        guard delta != 0 else { return }
        commitStep(delta)
        controller.isExpanded = true
    }
}

extension SpaceAgentController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        guard let panel else { return }
        save(origin: panel.frame.origin)
    }
}

enum SpaceAgentPanelPlacement {
    static func defaultOrigin(size: CGSize, visibleFrames: [CGRect]) -> CGPoint {
        let frame = visibleFrames.first ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGPoint(
            x: frame.maxX - size.width - 24,
            y: frame.minY + 96
        )
    }

    static func clampedOrigin(
        proposed: CGPoint,
        size: CGSize,
        visibleFrames: [CGRect]
    ) -> CGPoint {
        let candidate = CGRect(origin: proposed, size: size)
        let frame = bestFrame(for: candidate, visibleFrames: visibleFrames)
            ?? CGRect(x: 0, y: 0, width: max(size.width, 1), height: max(size.height, 1))
        let maxX = max(frame.minX, frame.maxX - size.width)
        let maxY = max(frame.minY, frame.maxY - size.height)
        return CGPoint(
            x: min(max(proposed.x, frame.minX), maxX),
            y: min(max(proposed.y, frame.minY), maxY)
        )
    }

    private static func bestFrame(for candidate: CGRect, visibleFrames: [CGRect]) -> CGRect? {
        visibleFrames.max { lhs, rhs in
            lhs.intersection(candidate).area < rhs.intersection(candidate).area
        }
    }
}

private extension CGRect {
    var area: CGFloat {
        guard !isNull, !isEmpty else { return 0 }
        return width * height
    }
}
