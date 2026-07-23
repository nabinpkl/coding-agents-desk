import AppKit
import Foundation
import TerminalEmulator
import os

/// Owns the workspace file experience for the macOS shell (ADR-0054): the active workspace's file
/// tree (the shared observation coordinator over the sidebar FilePane), its open-file tabs, and the free-floating editor
/// FileViewer window that a file opens into (centered in the slot, sized per Workspace.editorFrame).
/// Switching the active workspace switches the macOS Desktop to the workspace's assigned Space via
/// WorkspaceDesktopSwitcher (over SpacesProvider).
///
/// This is AgentDesk's leaner analogue of the donor's WorkspaceSession: it keeps the same mechanics
/// (file-opens-in-a-center-window, workspace=desktop) but drops the donor's terminal/browser/
/// chrome-borrow tenants, which are out of scope. Main-thread only.
@MainActor
final class WorkspaceShellSession {
    private(set) var store: WorkspaceStore
    private let filePane: FilePane
    private let viewer: FileViewer
    private let desktopSwitcher: WorkspaceDesktopSwitcher
    private let workspaceCoordinator: WorkspaceCoordinator
    private let observationCoordinator: WorkspaceObservationCoordinator
    private var observationSubscription: WorkspaceObservationSubscription?
    private let slotFrame: () -> CGRect
    private let terminalSpawn: TerminalEmulatorSpawn
    private let terminalWindowRegistry: TerminalWindowRegistry
    private let fileWriter = FileWriter()
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-shell")
    /// The latest status for the active workspace. `WorkspaceObservationCoordinator` is the sole producer; this cached
    /// snapshot lets the viewer breadcrumb and the presenter consume the same result as Explorer.
    private var gitStatus = GitStatus.empty
    /// Open file tabs per workspace (in-memory; the viewer mirrors the active workspace's set).
    private var tabs: [UUID: OpenTabs] = [:]
    /// Live terminal windows per workspace. They are normal titled windows on the workspace's Desktop,
    /// so macOS Spaces shows/hides them as the user switches workspaces (= Desktops); we track them only
    /// to cascade successive spawns and to label them. Successive terminals cascade down-right.
    private var terminals: [UUID: [TerminalEmulatorWindow]] = [:]
    private let terminalCascadeStep: CGFloat = 28
    /// Debounces editor-frame persistence: a live drag-resize fires onFrameChanged per frame.
    private var editorFramePersistTask: Task<Void, Never>?
    private var mutationTail: Task<Void, Never>?
    private var pendingTextZoom: WorkspaceTextZoom?

    /// Fired after the active workspace changes so the presenter refreshes the switcher selection.
    var onActiveChanged: (() -> Void)?
    /// Fired for the reset and each completed status read. A nil root means no active workspace.
    var onGitStatusChanged: ((GitStatus, URL?) -> Void)?

    init(
        store: WorkspaceStore,
        workspaceCoordinator: WorkspaceCoordinator,
        observationCoordinator: WorkspaceObservationCoordinator,
        filePane: FilePane,
        viewer: FileViewer,
        desktopSwitcher: WorkspaceDesktopSwitcher,
        terminalWindowRegistry: TerminalWindowRegistry,
        slotFrame: @escaping () -> CGRect,
        terminalSpawn: TerminalEmulatorSpawn = WebPtyManagerTerminalSpawn(client: PtyManagerSocketClient.makeClient())
    ) {
        self.store = store
        self.workspaceCoordinator = workspaceCoordinator
        self.observationCoordinator = observationCoordinator
        self.filePane = filePane
        self.viewer = viewer
        self.desktopSwitcher = desktopSwitcher
        self.terminalWindowRegistry = terminalWindowRegistry
        self.slotFrame = slotFrame
        self.terminalSpawn = terminalSpawn
        wireCallbacks()
    }

    private func wireCallbacks() {
        // A file tap opens it in the editor window; folder taps toggle expansion in FilePane itself.
        filePane.onActivate = { [weak self] node in
            guard !node.isDirectory else { return }
            self?.openFile(node.url)
        }
        viewer.onSave = { [weak self] url, text in try self?.fileWriter.write(text, to: url) }
        viewer.onActivateTab = { [weak self] identity in self?.activateTab(identity) }
        viewer.onCloseTab = { [weak self] identity in self?.closeTab(identity) }
        viewer.onFrameChanged = { [weak self] frame in self?.recordEditorFrame(frame) }
        viewer.onOpenFile = { [weak self] url in self?.openFile(url) }
        viewer.onListDirectory = { [weak self] directory in self?.listDirectory(directory) ?? [] }
    }

    /// Root the tree + render the viewer for whatever workspace is active on launch, at the persisted
    /// text zoom (so a saved non-default zoom applies to the tree and the editor from the first render).
    func start() {
        filePane.setTextZoom(store.textZoom)
        viewer.setTextZoom(store.textZoom)
        renderActive()
    }

    // MARK: - Files

    func openFile(_ url: URL) {
        guard let id = store.activeID else { return }
        let frame = editorFrame(for: id)
        var workspaceTabs = tabs[id] ?? OpenTabs()
        workspaceTabs.open(url)
        tabs[id] = workspaceTabs
        renderViewer(for: id)
        // The editor window follows to the active Desktop (.moveToActiveSpace set on the window), so a
        // reveal after a Space switch lands it on the workspace's Desktop without the donor's private
        // window-move API.
        viewer.revealAfterAssignedDesktop(in: frame, focus: true)
        persistEditorFrameIfUnset(frame, for: id)
    }

    private func listDirectory(_ directory: URL) -> [DirectoryListingEntry] {
        guard let root = store.active?.root else { return [] }
        return directoryListing(directory: directory, workspaceRoot: root, gitStatus: gitStatus)
    }

    private func activateTab(_ identity: FileTabIdentity) {
        guard let id = store.activeID else { return }
        var workspaceTabs = tabs[id] ?? OpenTabs()
        workspaceTabs.activate(identity)
        tabs[id] = workspaceTabs
        renderViewer(for: id)
    }

    private func closeTab(_ identity: FileTabIdentity) {
        guard let id = store.activeID else { return }
        var workspaceTabs = tabs[id] ?? OpenTabs()
        workspaceTabs.close(identity)
        tabs[id] = workspaceTabs
        renderViewer(for: id)
    }

    // MARK: - Workspace switching (= Desktop switching)

    func switchTo(_ id: UUID) {
        guard id != store.activeID, store.workspace(id: id) != nil else { return }
        submit(.select(id)) { [weak self] next in
            guard let self else { return }
            if let assignment = next.workspace(id: id)?.desktopAssignment,
               !self.desktopSwitcher.isActive(assignment),
               !self.desktopSwitcher.switchToDesktop(assignment) {
                self.logger.error("workspace-shell: desktop switch failed for workspace \(id, privacy: .public); content switched but the macOS Desktop did not")
            }
            self.renderActive()
            self.onActiveChanged?()
        }
    }

    /// Adds a workspace through the validated store op so a duplicate root is rejected (the raw donor
    /// `add` does not validate). Throws `WorkspaceStoreError` for the presenter to surface.
    func addWorkspace(_ workspace: Workspace) async throws {
        store = try await workspaceCoordinator.apply(.add(workspace))
        renderActive()
        onActiveChanged?()
    }

    // MARK: - Terminals

    /// Spawns a native web terminal terminal window for the active workspace, rooted at its folder and attached
    /// to a fresh pty-manager session on our socket (`PtyManagerSocketClient`). Successive terminals in
    /// a workspace cascade down-right. The window is a normal titled NSWindow created on the workspace's
    /// Desktop, so macOS Spaces shows/hides it as the user switches workspaces (= Desktops) without any
    /// explicit park/unpark. This is the top-bar "＋ Terminal" action (R55).
    func openTerminal() {
        guard let id = store.activeID, let workspace = store.workspace(id: id) else { return }
        // Drop windows the user has already closed so the cascade counts only currently-open
        // terminals (otherwise successive spawns drift ever further off the slot) and closed window
        // objects aren't retained for the process lifetime.
        let open = (terminals[id] ?? []).filter(\.isOpen)
        terminals[id] = open
        let index = open.count
        let frame = terminalFrame().offsetBy(
            dx: CGFloat(index) * terminalCascadeStep,
            dy: CGFloat(-index) * terminalCascadeStep
        )
        let workspaceName = workspace.name
        let sessionName = WorkspaceTerminalIdentity(workspaceID: id).makeSessionName()
        terminalSpawn.spawn(sessionName: sessionName, cwd: workspace.root, into: frame) { [weak self] result in
            // The emulator calls back on the main actor (it hops via MainActor.run before completing).
            MainActor.assumeIsolated {
                guard let self else { return }
                switch result {
                case .success(let window):
                    window.setWorkspaceLabel(workspaceName)
                    self.terminals[id, default: []].append(window)
                    self.terminalWindowRegistry.register(
                        window,
                        sessionName: sessionName,
                        workspaceID: id,
                        workspaceLabel: workspaceName,
                        cascadeOrdinal: index
                    )
                    window.raise()
                case .failure(let error):
                    self.logger.error("workspace-shell: terminal spawn failed for workspace \(id, privacy: .public): \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    /// The base frame a workspace's first terminal opens at: terminal-sized, centered in the slot.
    private func terminalFrame() -> CGRect {
        let slot = slotFrame()
        let size = CGSize(width: 720, height: 460)
        let origin = CGPoint(x: slot.midX - size.width / 2, y: slot.midY - size.height / 2)
        return CGRect(origin: origin, size: size)
    }

    // MARK: - Sidebar switcher mutations (per-workspace, from WorkspaceSwitcher rows)

    /// Remove a workspace (the row's hover × ). The store repoints `active` to the next recent
    /// workspace, so re-render and refresh the switcher selection.
    func removeWorkspace(_ id: UUID) {
        guard store.workspace(id: id) != nil else { return }
        submit(.remove(id)) { [weak self] _ in
            self?.renderActive()
            self?.onActiveChanged?()
        }
    }

    /// Bind a workspace to the Desktop the user is on now (a row's assign ⌖). Assigns the row's
    /// workspace, which need not be the active one, then refreshes so its desktop badge updates.
    func assignToCurrentDesktop(_ id: UUID) {
        guard store.workspace(id: id) != nil, let assignment = desktopSwitcher.currentAssignment() else { return }
        submit(.setDesktopAssignment(assignment, workspaceID: id)) { [weak self] _ in
            self?.onActiveChanged?()
        }
    }

    /// Human-facing Desktop numbers for the current topology. Switching continues to use the
    /// persisted exact Space identity plus its display-local fallback coordinate.
    var missionControlNumbersBySpaceID: [UInt64: Int] {
        desktopSwitcher.missionControlNumbersBySpaceID()
    }

    var monitorPresentationsByDisplayID: [String: WorkspaceMonitorPresentation] {
        desktopSwitcher.monitorPresentationsByDisplayID()
    }

    /// Toggle a workspace's desktop auto-assign (a row's A toggle).
    func setDesktopAutoAssign(_ id: UUID, enabled: Bool) {
        guard store.workspace(id: id) != nil else { return }
        submit(.setDesktopAutoAssign(enabled, workspaceID: id)) { [weak self] _ in
            self?.onActiveChanged?()
        }
    }

    /// Persist a drag-reorder of the workspace rows (top-to-bottom order).
    func reorder(_ ids: [UUID]) {
        submit(.reorder(ids)) { [weak self] _ in self?.onActiveChanged?() }
    }

    // MARK: - Sidebar chrome (text zoom, width)

    /// Apply a text-zoom command (the sidebar +/− buttons), persist the new step, and re-render
    /// the file tree and the web-viewer editor at the new sizes. Returns the resolved zoom so the
    /// presenter can size the switcher rows and title label to match.
    @discardableResult
    func applyTextZoom(_ command: WorkspaceTextZoomCommand) -> WorkspaceTextZoom {
        let zoom = command.apply(to: pendingTextZoom ?? store.textZoom)
        pendingTextZoom = zoom
        filePane.setTextZoom(zoom)
        viewer.setTextZoom(zoom)
        submit(.setTextZoom(zoom)) { [weak self] _ in
            guard self?.pendingTextZoom == zoom else { return }
            self?.pendingTextZoom = nil
        }
        return zoom
    }

    /// The persisted text-zoom, so the presenter can size the switcher + title on first render.
    var textZoom: WorkspaceTextZoom { store.textZoom }

    /// Persist a drag-resized sidebar width (the resize handle's release).
    func setSidebarWidth(_ width: CGFloat, screenWidth: CGFloat?) {
        submit(.setSidebarWidth(width, screenWidth: screenWidth))
    }

    /// The persisted sidebar width, so the presenter lays out the sidebar panel on first render.
    var sidebarWidth: CGFloat { store.sidebarWidth }

    /// The user switched Spaces manually: select the workspace that owns the now-active Desktop
    /// (without re-switching the Space). Wired to NSWorkspace.activeSpaceDidChange by the presenter.
    func reconcileFromObservedDesktop() {
        guard let assignment = desktopSwitcher.currentAssignment(),
              let workspace = store.workspaceAssigned(to: assignment),
              workspace.id != store.activeID
        else { return }
        submit(.select(workspace.id)) { [weak self] _ in
            self?.renderActive()
            self?.onActiveChanged?()
        }
    }

    /// Mission Control can reorder Desktops without changing the active Space. Refresh every known
    /// assignment's presentation coordinates in one persisted mutation, retaining missing Space IDs
    /// as unresolved assignments rather than guessing by ordinal.
    func reconcileFromMissionControlTopology(
        _ topology: MissionControlTopology,
        completion: (() -> Void)? = nil
    ) {
        submit(.reconcileDesktopAssignments(topology.assignmentsBySpaceID)) { [weak self] _ in
            self?.reconcileFromObservedDesktop()
            self?.onActiveChanged?()
            completion?()
        }
    }

    // MARK: - Rendering

    private func renderActive() {
        if let observationSubscription {
            observationCoordinator.unobserve(observationSubscription)
            self.observationSubscription = nil
        }
        gitStatus = .empty
        guard let workspace = store.active else {
            filePane.clear()
            viewer.clear()
            onGitStatusChanged?(.empty, nil)
            return
        }
        // Clear the prior workspace's panel/breadcrumb status before the asynchronous read returns.
        onGitStatusChanged?(.empty, workspace.root)
        filePane.show(root: FileNode(url: workspace.root, isDirectory: true))
        observationSubscription = observationCoordinator.observe(workspace: workspace) { [weak self] update in
            guard let self, self.store.activeID == workspace.id else { return }
            self.filePane.refreshPreservingState()
            self.gitStatus = update.nativeGitStatus
            self.filePane.applyGitStatus(update.nativeGitStatus)
            self.onGitStatusChanged?(update.nativeGitStatus, workspace.root)
            self.viewer.reconcileFromDisk(
                changedPaths: update.change.changedPaths,
                workspaceRoot: workspace.root
            )
        }
        renderViewer(for: workspace.id)
    }

    private func renderViewer(for id: UUID) {
        let workspaceTabs = tabs[id] ?? OpenTabs()
        guard !workspaceTabs.isEmpty else { viewer.clear(); return }
        viewer.render(tabs: workspaceTabs.identities, active: workspaceTabs.active, in: store.workspace(id: id))
    }

    // MARK: - Editor frame persistence

    private func editorFrame(for id: UUID) -> CGRect {
        if let remembered = store.workspace(id: id)?.editorFrame, EditorWindowFrame.isUsable(remembered) {
            return remembered
        }
        return EditorWindowFrame.defaultFrame(in: slotFrame())
    }

    private func recordEditorFrame(_ frame: CGRect) {
        guard let id = store.activeID, EditorWindowFrame.isUsable(frame) else { return }
        // Debounce the authoritative mutation: a drag-resize fires this per frame and each
        // committed mutation is a full atomic JSON write.
        editorFramePersistTask?.cancel()
        editorFramePersistTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled, let self else { return }
            self.submit(.setEditorFrame(frame.integral, workspaceID: id))
        }
    }

    private func persistEditorFrameIfUnset(_ frame: CGRect, for id: UUID) {
        guard store.workspace(id: id)?.editorFrame == nil, EditorWindowFrame.isUsable(frame) else { return }
        submit(.setEditorFrame(frame.integral, workspaceID: id))
    }

    private func submit(
        _ mutation: WorkspaceMutation,
        completion: ((WorkspaceStore) -> Void)? = nil
    ) {
        let predecessor = mutationTail
        mutationTail = Task { [weak self, workspaceCoordinator] in
            await predecessor?.value
            guard !Task.isCancelled else { return }
            do {
                let next = try await workspaceCoordinator.apply(mutation)
                guard let self else { return }
                self.store = next
                completion?(next)
            } catch {
                self?.logger.error("workspace-shell mutation failed: \(String(describing: error), privacy: .public)")
            }
        }
    }
}
