import AppKit
import WorkspaceIDE
import os

@MainActor
final class WorkspaceIDEWindowController: NSWindowController, NSWindowDelegate, WorkspaceIDEDelegate {
    private let laneBridge: WorkspaceIDELocalLaneBridge
    private let workspaceCoordinator: WorkspaceCoordinator
    private let desktopSwitcher: WorkspaceDesktopSwitcher
    private let ideController: WorkspaceIDEController
    private let terminalController: WorkspaceIDEMacTerminalController
    private let ideContentView: WorkspaceIDEWindowContentView
    private let windowPlacement: WorkspaceIDEWindowPlacementCoordinator
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window")
    private var placementCaptureTask: Task<Void, Never>?
    private var didAttemptPlacementRestore = false
    private var isPreparingWindowPlacement = false
    private var preserveUnresolvedPlacement = false
    private var isStopping = false

    init(
        files: WorkspaceFilesResponder,
        workspaces: WorkspaceCoordinator,
        ideState: WorkspaceIDEStateCoordinator,
        observation: WorkspaceObservationCoordinator,
        terminalEndpoint: WorkspaceTerminalEndpoint,
        spacesProvider: SpacesProvider
    ) {
        laneBridge = WorkspaceIDELocalLaneBridge(
            files: files,
            workspaces: workspaces,
            ideState: ideState,
            observation: observation
        )
        workspaceCoordinator = workspaces
        desktopSwitcher = WorkspaceDesktopSwitcher(spaces: spacesProvider)
        ideController = WorkspaceIDEController(
            dataSource: laneBridge.dataSource,
            capabilities: .macOSWorkspaceManagement,
            draftStore: WorkspaceIDEFileDraftStore(directory: Config.workspaceIDEDraftsDirectory)
        )
        terminalController = WorkspaceIDEMacTerminalController(endpoint: terminalEndpoint)
        ideContentView = WorkspaceIDEWindowContentView(
            controller: ideController,
            terminalController: terminalController
        )
        windowPlacement = WorkspaceIDEWindowPlacementCoordinator(
            store: WorkspaceIDEWindowPlacementFileStore(url: Config.workspaceIDEWindowPlacementURL),
            desktopAudit: HostWorkspaceDesktopAudit(),
            mover: HostWorkspaceWindowSpaceMover()
        )

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Workspace IDE"
        window.minSize = NSSize(width: 720, height: 480)
        // The IDE owns its saved Desktop. Opening it never follows the active Desktop or steals focus.
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        window.contentView = ideContentView
        // Desktop membership and frame are restored together from one placement record.
        window.center()
        super.init(window: window)
        window.delegate = self
        ideController.delegate = self
        terminalController.setZoomScale(ideController.currentLocalState.zoomScale)
        ideController.start()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("WorkspaceIDEWindowController is code-only") }

    func toggle() {
        guard let window else { return }
        if window.isVisible { hide() } else { show() }
    }

    func show() {
        guard let window else { return }
        restorePlacementAndOrderFront(window)
        terminalController.setWindowPresented(true)
        recordWindowVisible(true)
    }

    /// Whether the window was on screen when the host last quit. Read before the controller
    /// exists, because building one spins up the lane bridge and workspace subscriptions and that
    /// cost only makes sense if we are actually going to show it.
    static var wasVisibleAtLastQuit: Bool {
        UserDefaults.standard.bool(forKey: Config.workspaceIDEWindowVisibleKey)
    }

    func stop() {
        guard !isStopping else { return }
        isStopping = true
        placementCaptureTask?.cancel()
        placementCaptureTask = nil
        // Deliberately not recording visibility here: quitting closes the window, and treating
        // that as "the user closed it" would lose the very state this is meant to restore.
        terminalController.stop()
        ideController.stop()
        ideController.delegate = nil
        laneBridge.stop()
        window?.delegate = nil
        window?.close()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }

    /// Retargets the IDE — tree, editor, terminal — at another workspace. It deliberately does
    /// **not** follow the workspace's Desktop assignment: this window is a single surface you look
    /// at while the Mac stays where it is, so switching its subject must not yank the whole screen
    /// to another Space. Desktop following belongs to the shell (`WorkspaceShellSession`), which is
    /// the surface whose job is to move you between workspaces.
    func workspaceIDEController(_ controller: WorkspaceIDEController, didSelectWorkspace id: String?) {
        terminalController.selectWorkspace(id: id, name: id.flatMap { controller.workspaceName(for: $0) })
    }

    func workspaceIDEController(_ controller: WorkspaceIDEController, handle intent: WorkspaceIDEPlatformIntent) {
        switch intent {
        case .setSidebarVisible, .setTerminalVisible:
            ideContentView.applyLayoutState()
        case .setZoomScale(let scale):
            terminalController.setZoomScale(scale)
        case .addWorkspace:
            addWorkspace()
        case .removeWorkspace(let id):
            mutate(id: id) { .remove($0) }
        case .reorderWorkspaces(let ids):
            guard ids.allSatisfy({ UUID(uuidString: $0) != nil }) else { return }
            Task { [weak self] in
                await self?.apply(.reorder(ids.compactMap(UUID.init(uuidString:))))
            }
        case .assignDesktop(let id):
            guard let workspaceID = UUID(uuidString: id),
                  let assignment = desktopSwitcher.currentAssignment() else { return }
            Task { [weak self] in
                await self?.apply(.setDesktopAssignment(assignment, workspaceID: workspaceID))
            }
        case .setAutoAssignDesktop(let id, let enabled):
            guard let workspaceID = UUID(uuidString: id) else { return }
            Task { [weak self] in
                await self?.apply(.setDesktopAutoAssign(enabled, workspaceID: workspaceID))
            }
        }
    }

    private func hide() {
        terminalController.setWindowPresented(false)
        window?.orderOut(nil)
        recordWindowVisible(false)
    }

    private func recordWindowVisible(_ visible: Bool) {
        UserDefaults.standard.set(visible, forKey: Config.workspaceIDEWindowVisibleKey)
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        terminalController.contentView.flushViewportResize()
        preserveUnresolvedPlacement = false
        schedulePlacementCapture()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        terminalController.claimViewportOwnership()
    }

    func windowDidMove(_ notification: Notification) {
        guard !isPreparingWindowPlacement else { return }
        preserveUnresolvedPlacement = false
        schedulePlacementCapture()
    }

    func windowDidMiniaturize(_ notification: Notification) {
        terminalController.setWindowPresented(false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        terminalController.setWindowPresented(true)
    }

    func windowDidChangeScreen(_ notification: Notification) {
        guard !isPreparingWindowPlacement else { return }
        preserveUnresolvedPlacement = false
        schedulePlacementCapture()
    }

    private func restorePlacementAndOrderFront(_ window: NSWindow) {
        guard !didAttemptPlacementRestore else {
            window.orderFront(nil)
            return
        }
        didAttemptPlacementRestore = true
        isPreparingWindowPlacement = true
        let priorAlpha = window.alphaValue
        window.alphaValue = 0
        window.orderBack(nil)
        window.displayIfNeeded()

        var restoredDesktop: WorkspaceDesktopAssignment?
        if let windowID = windowID(for: window) {
            do {
                if case .restored(let desktop) = try windowPlacement.restore(
                    windowID: windowID,
                    applyFrame: { window.setFrame($0, display: false) }
                ) {
                    restoredDesktop = desktop
                }
                preserveUnresolvedPlacement = false
            } catch {
                // Keep the saved destination intact. The window remains usable on the current
                // Desktop, and a deliberate move records a new destination later.
                preserveUnresolvedPlacement = true
                logger.error("Workspace IDE placement restore failed: \(String(describing: error), privacy: .public)")
            }
        } else {
            preserveUnresolvedPlacement = true
            logger.error("Workspace IDE placement restore skipped: AppKit returned no window number")
        }

        window.orderFrontRegardless()
        if let restoredDesktop, let windowID = windowID(for: window) {
            do {
                try windowPlacement.verify(windowID: windowID, targetSpaceID: restoredDesktop.spaceID)
            } catch {
                preserveUnresolvedPlacement = true
                logger.error(
                    "Workspace IDE placement changed during reveal: \(String(describing: error), privacy: .public)"
                )
            }
        }
        window.alphaValue = priorAlpha
        isPreparingWindowPlacement = false
    }

    private func schedulePlacementCapture() {
        guard !isStopping,
              !isPreparingWindowPlacement,
              !preserveUnresolvedPlacement,
              let window,
              window.isVisible,
              let windowID = windowID(for: window)
        else { return }
        placementCaptureTask?.cancel()
        placementCaptureTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self, !self.isStopping else { return }
            self.capturePlacement(windowID: windowID)
        }
    }

    private func capturePlacement(windowID: UInt32) {
        guard let window else { return }
        do {
            _ = try windowPlacement.record(windowID: windowID, frame: window.frame)
        } catch {
            logger.error("Workspace IDE placement capture failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func windowID(for window: NSWindow) -> UInt32? {
        guard window.windowNumber > 0 else { return nil }
        return UInt32(window.windowNumber)
    }

    private func addWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let workspace = try Workspace.registering(root: url, name: url.lastPathComponent)
            Task { [weak self] in await self?.apply(.add(workspace)) }
        } catch {
            presentFailure("Could not add workspace", error)
        }
    }

    private func mutate(id: String, mutation: (UUID) -> WorkspaceMutation) {
        guard let workspaceID = UUID(uuidString: id) else { return }
        let resolvedMutation = mutation(workspaceID)
        Task { [weak self] in await self?.apply(resolvedMutation) }
    }

    private func apply(_ mutation: WorkspaceMutation) async {
        do {
            _ = try await workspaceCoordinator.apply(mutation)
        } catch {
            presentFailure("Could not update workspace", error)
        }
    }

    private func presentFailure(_ title: String, _ error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(describing: error)
        alert.alertStyle = .warning
        alert.runModal()
    }
}
