import AgentDeskWire
import Foundation
import OSLog
import WebKit
import WorkspaceFileViewer
import WorkspaceKit

@MainActor
public final class WorkspaceIDEController: NSObject {
    public let sidebarView: WKWebView
    public let editorView: WKWebView
    public weak var delegate: (any WorkspaceIDEDelegate)?
    public var currentLocalState: WorkspaceIDELocalState { localState }
    public func workspaceName(for id: String) -> String? {
        workspaces.first(where: { $0.id == id })?.name
    }

    let dataSource: any WorkspaceIDEDataSource
    let capabilities: WorkspaceIDEPlatformCapabilities
    let localStateStore: any WorkspaceIDELocalStateStoring
    let draftStore: any WorkspaceIDEDraftStore
    let documentStore: WorkspaceFileResourceStore
    let autosaveDelay: Duration
    let logger = Logger(subsystem: "com.example.agentdesk.AgentDesk.workspace-ide", category: "controller")

    var localState: WorkspaceIDELocalState
    var workspaces: [WorkspaceSummary] = []
    var sharedState: WorkspaceIDESharedState?
    var directoryEntries: [String: [WorkspaceDirectoryEntry]] = [:]
    var gitResult: WorkspaceGitStatusResult?
    var openFiles: [String: WorkspaceIDEOpenFile] = [:]
    var pendingClosePaths: Set<String> = []
    var readyRegions: Set<WorkspaceIDEWebRegion> = []
    var requestGeneration: UInt64 = 0
    var loadingPath: String?
    var errorMessage: String?
    var bootstrapTask: Task<Void, Never>?
    var eventTask: Task<Void, Never>?
    var autosaveTasks: [WorkspaceIDEFileKey: WorkspaceIDEAutosaveTask] = [:]
    var projectionTask: Task<Void, Never>?

    private let encoder = JSONEncoder()

    public init(
        dataSource: any WorkspaceIDEDataSource,
        capabilities: WorkspaceIDEPlatformCapabilities,
        localStateStore: any WorkspaceIDELocalStateStoring = WorkspaceIDEUserDefaultsStateStore(),
        draftStore: any WorkspaceIDEDraftStore,
        delegate: (any WorkspaceIDEDelegate)? = nil,
        resourceRoot: URL = WorkspaceIDE.resourceRootURL,
        autosaveDelay: Duration = WorkspaceIDE.autosaveDelay
    ) {
        self.dataSource = dataSource
        self.capabilities = capabilities
        self.localStateStore = localStateStore
        self.draftStore = draftStore
        self.delegate = delegate
        self.localState = localStateStore.load()
        self.documentStore = WorkspaceFileResourceStore()
        self.autosaveDelay = autosaveDelay

        let sidebarSink = ScriptMessageSink()
        let editorSink = ScriptMessageSink()
        sidebarView = Self.makeWebView(root: resourceRoot, store: WorkspaceFileResourceStore(), sink: sidebarSink)
        editorView = Self.makeWebView(root: resourceRoot, store: documentStore, sink: editorSink)
        super.init()

        applyWebZoom()
        sidebarSink.onMessage = { [weak self] body in self?.receiveWebMessage(body) }
        editorSink.onMessage = { [weak self] body in self?.receiveWebMessage(body) }
        sidebarView.load(Self.request(region: .sidebar))
        editorView.load(Self.request(region: .editor))
    }

    deinit {
        bootstrapTask?.cancel()
        eventTask?.cancel()
        projectionTask?.cancel()
        for entry in autosaveTasks.values { entry.task.cancel() }
    }

    public func start() {
        guard bootstrapTask == nil else { return }
        eventTask = Task { [weak self] in
            guard let self else { return }
            let events = await dataSource.events()
            for await event in events {
                guard !Task.isCancelled else { return }
                await self.receive(event)
            }
        }
        bootstrapTask = Task { [weak self] in await self?.bootstrap() }
    }

    public func stop() {
        requestGeneration &+= 1
        bootstrapTask?.cancel()
        bootstrapTask = nil
        eventTask?.cancel()
        eventTask = nil
        projectionTask?.cancel()
        projectionTask = nil
        for entry in autosaveTasks.values { entry.task.cancel() }
        autosaveTasks.removeAll()
        documentStore.removeAll()
        let workspaceID = localState.selectedWorkspaceID
        if let workspaceID {
            Task { [dataSource] in await dataSource.unsubscribe(workspaceID: workspaceID) }
        }
    }

    public func setPaneLayout(
        sidebarVisible: Bool,
        terminalVisible: Bool,
        sidebarFraction: Double,
        terminalFraction: Double
    ) {
        localState.sidebarVisible = sidebarVisible
        localState.terminalVisible = terminalVisible
        localState.setSidebarFraction(sidebarFraction)
        localState.setTerminalFraction(terminalFraction)
        persistLocalState()
    }

    func receiveWebMessage(_ body: Any) {
        do {
            handle(try WorkspaceIDEWebIntent.parse(body))
        } catch {
            logger.error("rejected malformed workspace IDE message: \(String(describing: error), privacy: .public)")
            showError("The IDE sent an invalid request.")
        }
    }

    func handle(_ intent: WorkspaceIDEWebIntent) {
        switch intent {
        case .ready(let region):
            readyRegions.insert(region)
            enqueueProjection()
        case .selectWorkspace(let id): selectWorkspace(id)
        case .selectSidebarSection(let section):
            localState.sidebarSection = section
            persistLocalState()
            enqueueProjection()
        case .open(let path): open(path: path)
        case .close(let path): close(path: path)
        case .reorderTabs(let paths): applySharedOperation(.reorder(orderedPaths: paths))
        case .setDirectoryExpanded(let path, let expanded):
            applySharedOperation(expanded ? .expand(path: path) : .collapse(path: path))
        case .selectTab(let path): activate(path: path)
        case .toggleMode(let path): toggleMode(path: path)
        case .edit(let path, let text): edit(path: path, text: text)
        case .useHost(let path): useHost(path: path)
        case .keepMine(let path): keepMine(path: path)
        case .zoomIn: adjustZoom(in: true)
        case .zoomOut: adjustZoom(in: false)
        case .setSidebarVisible(let visible):
            localState.sidebarVisible = visible
            persistLocalState()
            delegate?.workspaceIDEController(self, handle: .setSidebarVisible(visible))
        case .setTerminalVisible(let visible):
            localState.terminalVisible = visible
            persistLocalState()
            delegate?.workspaceIDEController(self, handle: .setTerminalVisible(visible))
        case .addWorkspace:
            forward(.addWorkspace, requiring: .addWorkspace)
        case .removeWorkspace(let id):
            forward(.removeWorkspace(id: id), requiring: .removeWorkspace)
        case .reorderWorkspaces(let ids):
            forward(.reorderWorkspaces(ids: ids), requiring: .reorderWorkspaces)
        case .assignDesktop(let id):
            forward(.assignDesktop(id: id), requiring: .assignDesktop)
        case .setAutoAssignDesktop(let id, let enabled):
            forward(.setAutoAssignDesktop(id: id, enabled: enabled), requiring: .autoAssignDesktop)
        }
    }

    func forward(_ intent: WorkspaceIDEPlatformIntent, requiring capability: WorkspaceIDEPlatformCapabilities) {
        guard capabilities.contains(capability) else {
            showError("That workspace action is not available on this device.")
            return
        }
        delegate?.workspaceIDEController(self, handle: intent)
    }

    func enqueueProjection() {
        let sidebar = sidebarProjection()
        let editor = editorProjection()
        let previous = projectionTask
        projectionTask = Task { [weak self] in
            guard let self else { return }
            await previous?.value
            guard !Task.isCancelled else { return }
            if readyRegions.contains(.sidebar) { await deliver(sidebar, to: sidebarView) }
            if readyRegions.contains(.editor) { await deliver(editor, to: editorView) }
        }
    }

    private func deliver<T: Encodable>(_ projection: T, to view: WKWebView) async {
        do {
            let data = try encoder.encode(projection)
            let object = try JSONSerialization.jsonObject(with: data)
            _ = try await view.callAsyncJavaScript(
                "window.workspaceIDE.receive(snapshot)",
                arguments: ["snapshot": object],
                in: nil,
                contentWorld: .page
            )
        } catch {
            logger.error("workspace IDE projection failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func adjustZoom(in zoomingIn: Bool) {
        if zoomingIn {
            localState.zoomIn()
        } else {
            localState.zoomOut()
        }
        applyWebZoom()
        persistLocalState()
        delegate?.workspaceIDEController(self, handle: .setZoomScale(localState.zoomScale))
    }

    private func applyWebZoom() {
        let scale = CGFloat(localState.zoomScale)
        sidebarView.pageZoom = scale
        editorView.pageZoom = scale
    }

    func persistLocalState() { localStateStore.save(localState) }

    func showError(_ message: String) {
        errorMessage = message
        enqueueProjection()
    }

    private static func makeWebView(
        root: URL,
        store: WorkspaceFileResourceStore,
        sink: ScriptMessageSink
    ) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            AppSchemeHandler(root: root, resourceStore: store),
            forURLScheme: AppSchemeHandler.scheme
        )
        configuration.userContentController.add(
            ScriptMessageProxy { body in sink.handle(body) },
            name: "workspaceIDE"
        )
        #if DEBUG
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #endif
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsBackForwardNavigationGestures = false
        #if os(macOS)
        view.setValue(false, forKey: "drawsBackground")
        #else
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        #endif
        return view
    }

    private static func request(region: WorkspaceIDEWebRegion) -> URLRequest {
        URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/index.html?region=\(region.rawValue)")!)
    }
}
