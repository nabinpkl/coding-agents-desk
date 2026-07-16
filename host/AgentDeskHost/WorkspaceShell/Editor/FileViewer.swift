import AppKit
import Foundation
import WorkspaceEditorViewer
import os

@MainActor
public final class FileViewer: NSObject, FileViewing {
    public var onFrameChanged: ((CGRect) -> Void)?
    public var onActivateTab: ((FileTabIdentity) -> Void)?
    public var onCloseTab: ((FileTabIdentity) -> Void)?
    public var onSave: ((URL, String) throws -> Void)?
    public var onDidReadFile: ((URL) -> Void)?
    public var onOpenFile: ((URL) -> Void)?
    public var onListDirectory: ((URL) -> [DirectoryListingEntry])?

    let window: NSWindow
    private let rootView = NSView()
    private let tabStrip = TabStripView()
    private let editorBar = NSView()
    private let breadcrumb = FileBreadcrumb()
    private let saveLabel = NSTextField(labelWithString: "")
    private let modeButton = NSButton(title: "Edit", target: nil, action: nil)
    private let conflictBar = ConflictBar()
    private let surfaceHost = NSView()
    private let unsupportedLabel = NSTextField(labelWithString: "")
    let viewerRoot: URL
    let notebookRunner: NotebookRunning?
    let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskHost", category: "viewer")

    /// Quiet window after the last keystroke before an edited buffer is autosaved to disk.
    private let saveDebounce: TimeInterval = 0.7

    var isApplyingProgrammaticFrame = false
    var workspace: Workspace?
    var tabsByID: [FileTabIdentity: FileTab] = [:]
    private var tabOrder: [FileTabIdentity] = []
    var activeID: FileTabIdentity?
    private var hostedSurfaceConstraints: [NSLayoutConstraint] = []
    var textZoom = WorkspaceTextZoom()
    // Notebook cell execution (FileViewerNotebookRuns + the Jupyter runtime) is out of scope for the
    // AgentDesk port; `.ipynb` files still render read-only through the SPA. `notebookRunner` stays as
    // the inert injection seam (always nil here).
    var reusableEditorSurface: WorkspaceFileWebSurface?
    var reusableHTMLSurface: HTMLPreviewSurface?

    public var assignedDesktopWindowID: UInt32? {
        guard window.windowNumber > 0 else { return nil }
        return UInt32(window.windowNumber)
    }

    public override convenience init() {
        self.init(notebookRunner: nil)
    }

    init(notebookRunner: NotebookRunning?) {
        self.notebookRunner = notebookRunner
        viewerRoot = WorkspaceEditorViewer.viewerRootURL
        // Deliberate packaging invariant: the viewer SPA is a .copy resource in the host-linked
        // WorkspaceEditorViewer package, so a missing index.html means a broken build/signing, not a
        // recoverable runtime state. Crashing loud here (only when the flag-gated shell constructs the
        // viewer) beats a silently blank editor. If the shell ever ships to end users, revisit this to
        // degrade the editor feature rather than the whole host.
        guard FileManager.default.fileExists(atPath: viewerRoot.appendingPathComponent("index.html").path) else {
            fatalError("AgentDesk: bundled viewer/index.html missing at \(viewerRoot.path)")
        }

        window = NSWindow(
            contentRect: .zero,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.level = .normal
        // The editor follows to the active Desktop when revealed, so after a workspace/Desktop switch
        // it lands on the workspace's Space without the donor's private window-move API (ADR-0054).
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.minSize = EditorWindowFrame.minimumSize
        window.contentView = rootView

        super.init()
        window.delegate = self
        buildChrome()
    }

    public func render(tabs: [FileTabIdentity], active: FileTabIdentity?, in workspace: Workspace?) {
        self.workspace = workspace
        let normalized = tabs
        let wanted = Set(normalized)
        for (identity, tab) in tabsByID where !wanted.contains(identity) {
            commitIfNeeded(tab)
            tabsByID[identity] = nil
        }
        tabOrder = normalized
        for identity in normalized where tabsByID[identity] == nil {
            tabsByID[identity] = FileTab(identity: identity)
        }
        activeID = active
        guard !normalized.isEmpty else {
            clearSurface()
            updateChrome()
            if workspace == nil {
                hide()
            } else {
                window.title = workspace?.name ?? ""
                show()
            }
            return
        }
        show()
        showActiveTab()
    }

    public func clear() {
        for tab in tabsByID.values { commitIfNeeded(tab) }
        tabsByID = [:]
        tabOrder = []
        activeID = nil
        workspace = nil
        hide()
        updateChrome()
        clearSurface()
    }

    public func setHidden(_ hidden: Bool) {
        hidden ? hide() : show()
    }

    public func prepareForAssignedDesktop(in frame: CGRect) {
        applyFrame(frame, display: false)
        window.alphaValue = 0
        window.orderBack(nil)
        window.displayIfNeeded()
    }

    public func revealAfterAssignedDesktop(in frame: CGRect, focus: Bool) {
        applyFrame(frame, display: true)
        window.alphaValue = 1
        show()
    }

    public func hideAfterAssignedDesktopFailure() {
        window.alphaValue = 1
        hide()
    }

    public func reloadFromDisk(_ url: URL) {
        let key = url.standardizedFileURL
        let matching = tabsByID.values.filter { $0.url == key }
        guard !matching.isEmpty else { return }
        let loaded = readFile(key)
        for tab in matching {
            if tab.dirty {
                tab.markChangedOnDisk(loaded.text)
            } else {
                apply(loaded, to: tab)
            }
        }
        updateChrome()
        if activeID?.url == key { showActiveTab() }
    }

    public func markDeletedOnDisk(_ url: URL) {
        let key = url.standardizedFileURL
        for tab in tabsByID.values where tab.url == key {
            tab.markDeletedOnDisk()
        }
        updateChrome()
    }

    public func setTextZoom(_ zoom: WorkspaceTextZoom) {
        textZoom = zoom
        reusableEditorSurface?.setTextZoom(zoom.webTextZoom)
    }

    public func focusForAccessibility() -> Bool {
        guard window.isVisible else { return false }
        window.makeKeyAndOrderFront(nil)
        if let activeID, let tab = tabsByID[activeID], tab.unsupportedReason == nil {
            switch (tab.identity, tab.kind, tab.mode) {
            case (.htmlPreview, .html, .preview):
                if let reusableHTMLSurface { return window.makeFirstResponder(reusableHTMLSurface.view) }
            default:
                if let reusableEditorSurface { return window.makeFirstResponder(reusableEditorSurface.view) }
            }
        }
        return window.makeFirstResponder(rootView)
    }

    private func buildChrome() {
        rootView.wantsLayer = true
        rootView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        tabStrip.translatesAutoresizingMaskIntoConstraints = false
        tabStrip.onActivate = { [weak self] identity in self?.onActivateTab?(identity) }
        tabStrip.onClose = { [weak self] identity in self?.close(identity) }

        editorBar.wantsLayer = true
        editorBar.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        editorBar.translatesAutoresizingMaskIntoConstraints = false
        breadcrumb.translatesAutoresizingMaskIntoConstraints = false
        breadcrumb.setContentHuggingPriority(.defaultLow, for: .horizontal)
        breadcrumb.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        breadcrumb.onOpenFile = { [weak self] url in self?.onOpenFile?(url) }
        breadcrumb.onListDirectory = { [weak self] url in self?.onListDirectory?(url) ?? [] }
        saveLabel.textColor = .secondaryLabelColor
        saveLabel.font = .systemFont(ofSize: 11)
        saveLabel.translatesAutoresizingMaskIntoConstraints = false
        modeButton.bezelStyle = .rounded
        modeButton.font = .systemFont(ofSize: 11)
        modeButton.translatesAutoresizingMaskIntoConstraints = false
        modeButton.target = self
        modeButton.action = #selector(toggleMode)

        conflictBar.onKeepMine = { [weak self] in self?.withActiveTab { self?.keepMine($0) } }
        conflictBar.onUseDisk = { [weak self] in self?.withActiveTab { self?.useDisk($0) } }
        conflictBar.onSaveToRecreate = { [weak self] in self?.withActiveTab { self?.saveToRecreate($0) } }
        conflictBar.onCloseTab = { [weak self] in self?.withActiveTab { self?.close($0.identity) } }

        surfaceHost.translatesAutoresizingMaskIntoConstraints = false
        unsupportedLabel.alignment = .center
        unsupportedLabel.textColor = .secondaryLabelColor
        unsupportedLabel.translatesAutoresizingMaskIntoConstraints = false

        for view in [tabStrip, editorBar, conflictBar, surfaceHost] { rootView.addSubview(view) }
        editorBar.addSubview(breadcrumb)
        editorBar.addSubview(saveLabel)
        editorBar.addSubview(modeButton)

        NSLayoutConstraint.activate([
            tabStrip.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            tabStrip.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            tabStrip.topAnchor.constraint(equalTo: rootView.topAnchor),
            tabStrip.heightAnchor.constraint(equalToConstant: 36),

            editorBar.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            editorBar.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            editorBar.topAnchor.constraint(equalTo: tabStrip.bottomAnchor),
            editorBar.heightAnchor.constraint(equalToConstant: 30),

            breadcrumb.leadingAnchor.constraint(equalTo: editorBar.leadingAnchor, constant: 10),
            breadcrumb.centerYAnchor.constraint(equalTo: editorBar.centerYAnchor),
            saveLabel.leadingAnchor.constraint(greaterThanOrEqualTo: breadcrumb.trailingAnchor, constant: 10),
            saveLabel.centerYAnchor.constraint(equalTo: editorBar.centerYAnchor),
            modeButton.leadingAnchor.constraint(equalTo: saveLabel.trailingAnchor, constant: 10),
            modeButton.trailingAnchor.constraint(equalTo: editorBar.trailingAnchor, constant: -10),
            modeButton.centerYAnchor.constraint(equalTo: editorBar.centerYAnchor),

            conflictBar.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            conflictBar.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            conflictBar.topAnchor.constraint(equalTo: editorBar.bottomAnchor),

            surfaceHost.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            surfaceHost.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            surfaceHost.topAnchor.constraint(equalTo: conflictBar.bottomAnchor),
            surfaceHost.bottomAnchor.constraint(equalTo: rootView.bottomAnchor),
        ])
    }

    private func showActiveTab() {
        guard let activeID, let tab = tabsByID[activeID] else {
            clearSurface()
            updateChrome()
            return
        }
        if !tab.loaded { apply(readFile(tab.url), to: tab) }
        window.title = [tab.url.lastPathComponent, workspace?.name].compactMap { $0 }.joined(separator: " — ")
        updateChrome()
        render(tab)
    }

    private func render(_ tab: FileTab) {
        clearSurface()
        if let reason = tab.unsupportedReason {
            unsupportedLabel.stringValue = reason
            install(unsupportedLabel)
            return
        }
        switch (tab.identity, tab.kind, tab.mode) {
        case (.htmlPreview, .html, .preview):
            let surface = htmlPreviewSurface()
            surface.load(file: tab.url, readAccessRoot: workspace?.root ?? tab.url.deletingLastPathComponent())
            install(surface.view)
        case (_, .markdown, .preview):
            let surface = editorSurface()
            surface.render(payload(for: tab))
            install(surface.view)
        case (_, .notebook, _):
            // Notebooks always render through the SPA's read-only notebook view,
            // regardless of mode — there is no raw-JSON edit surface in v0.
            let surface = editorSurface()
            surface.render(payload(for: tab))
            install(surface.view)
        case (_, .docx, _):
            let surface = editorSurface()
            surface.render(payload(for: tab))
            install(surface.view)
        default:
            let surface = editorSurface()
            surface.render(payload(for: tab))
            install(surface.view)
        }
    }

    private func install(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        surfaceHost.addSubview(view)
        let constraints = [
            view.leadingAnchor.constraint(equalTo: surfaceHost.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: surfaceHost.trailingAnchor),
            view.topAnchor.constraint(equalTo: surfaceHost.topAnchor),
            view.bottomAnchor.constraint(equalTo: surfaceHost.bottomAnchor),
        ]
        NSLayoutConstraint.activate(constraints)
        hostedSurfaceConstraints = constraints
    }

    private func clearSurface() {
        NSLayoutConstraint.deactivate(hostedSurfaceConstraints)
        hostedSurfaceConstraints = []
        surfaceHost.subviews.forEach { $0.removeFromSuperview() }
    }

    private func updateChrome() {
        tabStrip.render(order: tabOrder, active: activeID) { [unowned self] identity in
            self.tabsByID[identity]?.dirty ?? false
        }
        guard let activeID, let tab = tabsByID[activeID] else {
            if let workspace {
                editorBar.isHidden = false
                breadcrumb.render(workspaceRoot: workspace)
                saveLabel.stringValue = ""
                saveLabel.textColor = .secondaryLabelColor
                modeButton.isHidden = true
            } else {
                editorBar.isHidden = true
                breadcrumb.clear()
            }
            conflictBar.render(.hidden)
            return
        }
        editorBar.isHidden = false
        breadcrumb.render(file: tab.url, workspace: workspace)
        saveLabel.stringValue = saveText(for: tab)
        saveLabel.textColor = tab.saveError == nil ? .secondaryLabelColor : .systemRed
        modeButton.isHidden = tab.unsupportedReason != nil || (tab.kind?.isReadOnly ?? false)
        modeButton.title = tab.mode == .edit ? "Preview" : "Edit"
        conflictBar.render(conflictState(for: tab))
    }

    /// Deleted takes priority over a stale on-disk change: a vanished file has no disk text worth
    /// merging, so we offer recreate/close rather than keep-mine/use-disk.
    private func conflictState(for tab: FileTab) -> ConflictBar.State {
        if tab.deleted {
            return .deletedOnDisk(fileName: tab.url.lastPathComponent, canRecreate: tab.dirty)
        }
        if tab.conflictText != nil {
            return .changedOnDisk(fileName: tab.url.lastPathComponent)
        }
        return .hidden
    }

    private func withActiveTab(_ body: (FileTab) -> Void) {
        guard let activeID, let tab = tabsByID[activeID] else { return }
        body(tab)
    }

    private func close(_ identity: FileTabIdentity) {
        if let tab = tabsByID[identity], !commitIfNeeded(tab) { return }
        onCloseTab?(identity)
    }

    @objc private func toggleMode() {
        guard let activeID, let tab = tabsByID[activeID] else { return }
        setMode(tab.mode == .edit ? .preview : .edit, for: activeID)
    }

    private func setMode(_ mode: FileTabMode, for identity: FileTabIdentity) {
        guard let tab = tabsByID[identity],
              tab.unsupportedReason == nil,
              !(tab.kind?.isReadOnly ?? false)
        else { return }
        tab.mode = mode
        if identity == activeID { showActiveTab() }
    }

    func setMode(_ mode: FileTabMode, for url: URL) {
        guard let identity = activeIdentity(for: url) else { return }
        setMode(mode, for: identity)
    }

    func markDirty(_ url: URL, text: String) {
        guard let identity = activeIdentity(for: url), let tab = tabsByID[identity] else { return }
        tab.markDirty(text)
        updateChrome()
        tab.saveWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self, weak tab] in
            guard let self, let tab else { return }
            self.commitIfNeeded(tab)
        }
        tab.saveWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + saveDebounce, execute: work)
    }

    @discardableResult
    private func commitIfNeeded(_ tab: FileTab) -> Bool {
        guard tab.dirty else { return true }
        guard let onSave else {
            logger.error("save requested but no save handler is installed for \(tab.url.path, privacy: .public)")
            tab.markSaveFailed("save unavailable")
            updateChrome()
            return false
        }
        tab.beginSave()
        updateChrome()
        do {
            try onSave(tab.url, tab.text)
            tab.markSaved()
            updateChrome()
            return true
        } catch {
            logger.error("save failed for \(tab.url.path, privacy: .public): \(String(describing: error), privacy: .public)")
            tab.markSaveFailed("could not write \(tab.url.lastPathComponent)")
            updateChrome()
            return false
        }
    }

    private func keepMine(_ tab: FileTab) {
        tab.keepMine()
        commitIfNeeded(tab)
    }

    private func useDisk(_ tab: FileTab) {
        guard let incoming = tab.conflictText else { return }
        tab.useDisk(incoming)
        if tab.identity == activeID {
            reusableEditorSurface?.render(payload(for: tab))
        }
        if tab.identity == activeID { showActiveTab() }
    }

    private func saveToRecreate(_ tab: FileTab) {
        tab.saveToRecreate()
        commitIfNeeded(tab)
    }

    func displayPath(for url: URL) -> String {
        FileBreadcrumbSegment.displayPath(for: url, in: workspace)
    }

    private func activeIdentity(for url: URL) -> FileTabIdentity? {
        let key = url.standardizedFileURL
        if let activeID, activeID.url == key { return activeID }
        return tabOrder.first { $0.url == key }
    }

    private func saveText(for tab: FileTab) -> String {
        if let error = tab.saveError { return "Save failed: \(error)" }
        if tab.saving { return "Saving…" }
        if tab.dirty { return "Unsaved" }
        if tab.savedOnce { return "Saved" }
        return ""
    }

    private func show() {
        window.orderFrontRegardless()
    }

    private func hide() {
        window.alphaValue = 1
        window.orderOut(nil)
    }

    func applyFrame(_ frame: CGRect, display: Bool) {
        guard !frame.isEmpty, window.frame != frame else { return }
        isApplyingProgrammaticFrame = true
        window.setFrame(frame, display: display)
        isApplyingProgrammaticFrame = false
    }
}
