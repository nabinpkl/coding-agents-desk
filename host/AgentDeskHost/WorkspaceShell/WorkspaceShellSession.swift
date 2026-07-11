import AppKit
import Foundation

/// Owns the workspace file experience for the macOS shell (ADR-0054): the active workspace's file
/// tree (FileTreeLive over the sidebar FilePane), its open-file tabs, and the free-floating editor
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
    private let fileTreeLive: FileTreeLive
    private let viewer: FileViewer
    private let desktopSwitcher: WorkspaceDesktopSwitcher
    private let persist: (WorkspaceStore) -> Void
    private let slotFrame: () -> CGRect
    private let fileWriter = FileWriter()
    /// Open file tabs per workspace (in-memory; the viewer mirrors the active workspace's set).
    private var tabs: [UUID: OpenTabs] = [:]

    /// Fired after the active workspace changes so the presenter refreshes the switcher selection.
    var onActiveChanged: (() -> Void)?

    init(
        store: WorkspaceStore,
        filePane: FilePane,
        viewer: FileViewer,
        desktopSwitcher: WorkspaceDesktopSwitcher,
        persist: @escaping (WorkspaceStore) -> Void,
        slotFrame: @escaping () -> CGRect
    ) {
        self.store = store
        self.filePane = filePane
        self.viewer = viewer
        self.desktopSwitcher = desktopSwitcher
        self.persist = persist
        self.slotFrame = slotFrame
        self.fileTreeLive = FileTreeLive(filePane: filePane)
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
    }

    /// Root the tree + render the viewer for whatever workspace is active on launch.
    func start() { renderActive() }

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
        store.setActive(id)
        persist(store)
        if let assignment = store.workspace(id: id)?.desktopAssignment, !desktopSwitcher.isActive(assignment) {
            desktopSwitcher.switchToDesktop(assignment)
        }
        renderActive()
        onActiveChanged?()
    }

    func addWorkspace(_ workspace: Workspace) {
        store.add(workspace)
        persist(store)
        renderActive()
        onActiveChanged?()
    }

    /// Bind the active workspace to the Desktop the user is on now (the sidebar's assign action).
    func assignActiveToCurrentDesktop() {
        guard let id = store.activeID, let assignment = desktopSwitcher.currentAssignment() else { return }
        store.setDesktopAssignment(assignment, for: id)
        persist(store)
    }

    /// The user switched Spaces manually: select the workspace that owns the now-active Desktop
    /// (without re-switching the Space). Wired to NSWorkspace.activeSpaceDidChange by the presenter.
    func reconcileFromObservedDesktop() {
        guard let assignment = desktopSwitcher.currentAssignment(),
              let workspace = store.workspaceAssigned(to: assignment),
              workspace.id != store.activeID
        else { return }
        store.setActive(workspace.id)
        persist(store)
        renderActive()
        onActiveChanged?()
    }

    // MARK: - Rendering

    private func renderActive() {
        guard let workspace = store.active else {
            fileTreeLive.clear()
            viewer.clear()
            return
        }
        fileTreeLive.show(root: workspace.root)
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
        store.setEditorFrame(frame.integral, for: id)
        persist(store)
    }

    private func persistEditorFrameIfUnset(_ frame: CGRect, for id: UUID) {
        guard store.workspace(id: id)?.editorFrame == nil, EditorWindowFrame.isUsable(frame) else { return }
        store.setEditorFrame(frame.integral, for: id)
        persist(store)
    }
}
