import AppKit
import OSLog
import WorkspaceIDE

@MainActor
final class WorkspaceIDEWindowController: NSWindowController,
    NSWindowDelegate,
    WorkspaceIDEDelegate,
    WorkspaceIDEWindowControlling
{
    private let laneBridge: WorkspaceIDELocalLaneBridge
    private let workspaceCoordinator: WorkspaceCoordinator
    private let desktopSwitcher: WorkspaceDesktopSwitcher
    private let ideController: WorkspaceIDEController
    private let terminalController: WorkspaceIDEMacTerminalController
    private let terminalStore: WorkspaceIDETerminalWorkspaceStore
    private let ideContentView: WorkspaceIDEWindowContentView
    private let placementSession: DesktopWindowPlacementSession
    private let draftDirectory: URL
    private var onClosed: (@MainActor () -> Void)?
    private var isStopping = false

    init(
        windowID: UUID,
        files: WorkspaceFilesResponder,
        workspaces: WorkspaceCoordinator,
        ideState: WorkspaceIDEStateCoordinator,
        observation: WorkspaceObservationCoordinator,
        terminalEndpoint: WorkspaceTerminalEndpoint,
        terminalStore: WorkspaceIDETerminalWorkspaceStore,
        localStateStore: WorkspaceIDEWindowLocalStateStore,
        initialPlacement: WorkspaceWindowPlacement,
        placementCoordinator: DesktopWindowPlacementCoordinator,
        spacesProvider: SpacesProvider,
        onClosed: @escaping @MainActor () -> Void
    ) {
        laneBridge = WorkspaceIDELocalLaneBridge(
            files: files,
            workspaces: workspaces,
            ideState: ideState,
            observation: observation
        )
        workspaceCoordinator = workspaces
        desktopSwitcher = WorkspaceDesktopSwitcher(spaces: spacesProvider)
        draftDirectory = Config.workspaceIDEDraftsDirectory
            .appendingPathComponent(windowID.uuidString, isDirectory: true)
        ideController = WorkspaceIDEController(
            dataSource: laneBridge.dataSource,
            capabilities: .macOSWorkspaceManagement,
            localStateStore: localStateStore,
            draftStore: WorkspaceIDEFileDraftStore(directory: draftDirectory)
        )
        self.terminalStore = terminalStore
        terminalController = WorkspaceIDEMacTerminalController(
            endpoint: terminalEndpoint,
            store: terminalStore
        )
        ideContentView = WorkspaceIDEWindowContentView(
            controller: ideController,
            terminalController: terminalController
        )
        placementSession = DesktopWindowPlacementSession(
            placement: initialPlacement,
            coordinator: placementCoordinator,
            logger: Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window-placement")
        )
        self.onClosed = onClosed

        let window = NSWindow(
            contentRect: initialPlacement.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Workspace IDE"
        window.minSize = NSSize(width: 720, height: 480)
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        window.contentView = ideContentView
        super.init(window: window)
        window.delegate = self
        ideController.delegate = self
        terminalController.setZoomScale(ideController.currentLocalState.zoomScale)
        ideController.start()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("WorkspaceIDEWindowController is code-only") }

    func observePlacement(_ changed: @escaping (WorkspaceWindowPlacement) -> Void) {
        placementSession.onPlacementChanged = changed
    }

    func show(activating: Bool) {
        guard let window, !isStopping else { return }
        let presented = placementSession.present(window, focus: activating)
        terminalController.setWindowPresented(presented)
    }

    /// Raises this window and gives it key status, without re-running the placement restore `show`
    /// performs. A window that is already on screen has already been placed, and repeating the
    /// restore would hide it again on any Desktop-audit hiccup -- an unacceptable answer to a click
    /// that asked to SEE it.
    func focus() {
        guard let window, !isStopping else { return }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func stop() {
        guard !isStopping else { return }
        isStopping = true
        placementSession.stop()
        terminalController.stop()
        ideController.stop()
        ideController.delegate = nil
        laneBridge.stop()
        window?.delegate = nil
        window?.orderOut(nil)
        window?.close()
        onClosed = nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        beginUserClose()
        return false
    }

    /// The one user-initiated close, whether it came from the window's own close button or from the
    /// top bar's list of open windows. Reporting the close is what makes the registry forfeit the
    /// stored placement and local state, which is what closing a window means and quitting does not.
    func beginUserClose() {
        guard !isStopping else { return }
        let closed = onClosed
        stop()
        closed?()
    }

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

    func windowDidEndLiveResize(_ notification: Notification) {
        terminalController.contentView.flushViewportResize()
        reportPlacementChange()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        terminalController.claimViewportOwnership()
    }

    func windowDidMove(_ notification: Notification) {
        reportPlacementChange()
    }

    func windowDidResize(_ notification: Notification) {
        reportPlacementChange()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        reportPlacementChange()
    }

    func windowDidMiniaturize(_ notification: Notification) {
        terminalController.setWindowPresented(false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        terminalController.setWindowPresented(true)
    }

    private func reportPlacementChange() {
        guard let window, !isStopping else { return }
        placementSession.windowDidChange(window)
    }

    func discardLocalPersistence() {
        terminalStore.removeAll()
        guard FileManager.default.fileExists(atPath: draftDirectory.path) else { return }
        do {
            try FileManager.default.removeItem(at: draftDirectory)
        } catch {
            Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window").error(
                "Workspace IDE draft cleanup failed: \(String(describing: error), privacy: .public)"
            )
        }
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
