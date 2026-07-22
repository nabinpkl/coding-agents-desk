import AppKit
import WorkspaceIDE

@MainActor
final class WorkspaceIDEWindowController: NSWindowController, NSWindowDelegate, WorkspaceIDEDelegate {
    private let laneBridge: WorkspaceIDELocalLaneBridge
    private let workspaceCoordinator: WorkspaceCoordinator
    private let desktopSwitcher: WorkspaceDesktopSwitcher
    private let ideController: WorkspaceIDEController
    private let terminalController: WorkspaceIDEMacTerminalController
    private let ideContentView: WorkspaceIDEWindowContentView
    private var isStopping = false
    private var hasBeenShown = false

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

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Workspace IDE"
        window.minSize = NSSize(width: 720, height: 480)
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenPrimary]
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

    func toggle() {
        guard let window else { return }
        if window.isVisible {
            hide()
        } else {
            showWindow(nil)
            if !hasBeenShown {
                window.center()
                hasBeenShown = true
            }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            terminalController.setWindowPresented(true)
        }
    }

    func stop() {
        guard !isStopping else { return }
        isStopping = true
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

    func workspaceIDEController(_ controller: WorkspaceIDEController, didSelectWorkspace id: String?) {
        terminalController.selectWorkspace(id: id, name: id.flatMap { controller.workspaceName(for: $0) })
        guard let id, let workspaceID = UUID(uuidString: id) else { return }
        Task { [weak self] in
            guard let self,
                  let workspace = try? await workspaceCoordinator.workspace(id: workspaceID),
                  controller.currentLocalState.selectedWorkspaceID == id,
                  let assignment = workspace.desktopAssignment,
                  !desktopSwitcher.isActive(assignment) else { return }
            _ = desktopSwitcher.switchToDesktop(assignment)
        }
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
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        terminalController.contentView.flushViewportResize()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        terminalController.claimViewportOwnership()
    }

    func windowDidMiniaturize(_ notification: Notification) {
        terminalController.setWindowPresented(false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        terminalController.setWindowPresented(true)
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
