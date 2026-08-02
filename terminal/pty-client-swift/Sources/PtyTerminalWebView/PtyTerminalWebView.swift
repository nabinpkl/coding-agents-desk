import Foundation
import PtyClientSwift
import PtyTerminalSession
import WebKit

#if canImport(AppKit)
import AppKit
public typealias PtyTerminalWebPlatformView = NSView
#elseif canImport(UIKit)
import UIKit
public typealias PtyTerminalWebPlatformView = UIView
#endif

@MainActor
public protocol PtyTerminalWebViewDelegate: AnyObject {
    func ptyTerminalContent(_ content: PtyTerminalWebView, didSetTitle title: String)
    func ptyTerminalContent(_ content: PtyTerminalWebView, didReceiveStatus text: String)
    func ptyTerminalContent(_ content: PtyTerminalWebView, didFail error: Error)
    func ptyTerminalContent(_ content: PtyTerminalWebView, didTerminate termination: PtyTerminalSessionTermination)
    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalWebView)
    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didTerminate termination: PtyTerminalSessionTermination,
        terminalID: String
    )
    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalWebView, terminalID: String)
    func ptyTerminalContent(_ content: PtyTerminalWebView, didUpdateWorkspace state: PtyTerminalWorkspaceState)
}

public extension PtyTerminalWebViewDelegate {
    func ptyTerminalContent(_ content: PtyTerminalWebView, didSetTitle title: String) {}
    func ptyTerminalContent(_ content: PtyTerminalWebView, didReceiveStatus text: String) {}
    func ptyTerminalContent(_ content: PtyTerminalWebView, didFail error: Error) {}
    func ptyTerminalContent(_ content: PtyTerminalWebView, didTerminate termination: PtyTerminalSessionTermination) {}
    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalWebView) {}
    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didTerminate termination: PtyTerminalSessionTermination,
        terminalID: String
    ) {
        ptyTerminalContent(content, didTerminate: termination)
    }
    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalWebView, terminalID: String) {
        ptyTerminalContentDidDetachByManager(content)
    }
    func ptyTerminalContent(_ content: PtyTerminalWebView, didUpdateWorkspace state: PtyTerminalWorkspaceState) {}
}

public enum PtyTerminalWebViewError: Error, Equatable {
    case invalidBridgeMessage
    case bridgeOverflow(String)
    case resourceUnavailable
    case javascriptEvaluationFailed
    case workspaceBackendUnavailable
}

@MainActor
public final class PtyTerminalWebView: PtyTerminalWebPlatformView {
    @MainActor
    final class Slot {
        let paneID: String
        let terminalID: String
        let renderer: Renderer
        var connection: PtyTerminalConnection?
        var concreteConnection: PtySessionConnection?
        var driver: PtyTerminalSessionDriver?
        var dimensions = PtyTerminalDimensions.bootstrap
        var hasSettledViewportDimensions = false
        var columns: UInt32 = 80
        var rows: UInt32 = 24
        var revision: UInt64 = 0
        var viewportStatus: PtyTerminalViewportStatus?
        var synchronizing = true

        init(paneID: String, terminalID: String, owner: PtyTerminalWebView) {
            self.paneID = paneID
            self.terminalID = terminalID
            renderer = Renderer(terminalID: terminalID, owner: owner)
        }
    }

    final class Renderer: PtyTerminalRenderer {
        let terminalID: String
        weak var owner: PtyTerminalWebView?

        init(terminalID: String, owner: PtyTerminalWebView) {
            self.terminalID = terminalID
            self.owner = owner
        }

        func beginCheckpoint(_ checkpoint: PtyTerminalCheckpoint) { owner?.beginCheckpoint(checkpoint, terminalID: terminalID) }
        func feedCheckpointChunk(_ data: Data) { owner?.deliverData(type: "checkpointChunk", data: data, terminalID: terminalID) }
        func endCheckpoint(_ checkpoint: PtyTerminalCheckpoint) { owner?.endCheckpoint(checkpoint, terminalID: terminalID) }
        func feedOutput(_ data: Data, revision: UInt64) { owner?.deliverData(type: "output", data: data, terminalID: terminalID, revision: revision, liveOutput: true) }
        func updateViewportStatus(_ status: PtyTerminalViewportStatus) { owner?.updateViewportStatus(status, terminalID: terminalID) }
        func feedStatus(_ text: String) { owner?.feedStatus(text, terminalID: terminalID) }
        func closeAfterManagerDetach() { owner?.closeAfterManagerDetach(terminalID: terminalID) }
    }

    public weak var delegate: PtyTerminalWebViewDelegate?
    public let profile: PtyTerminalWebViewProfile
    public let webView: WKWebView
    public var isInputEnabled = true
    public internal(set) var isBound = false
    public internal(set) var rendererSetupError: Error?
    public internal(set) var workspaceState: PtyTerminalWorkspaceState
    public internal(set) var isSynchronizing = true
    public internal(set) var appliedRevision: UInt64 = 0
    public internal(set) var viewportStatus: PtyTerminalViewportStatus?
    public internal(set) var fitScale: CGFloat = 1
    public internal(set) var isViewportCropped = false
    public var columns: Int { Int(selectedSlot?.columns ?? 80) }
    public var rows: Int { Int(selectedSlot?.rows ?? 24) }
    public var attachmentDimensions: PtyTerminalDimensions { selectedSlot?.dimensions ?? .bootstrap }

    let schemeHandler: PtyTerminalResourceSchemeHandler
    var scriptProxy: PtyTerminalScriptMessageProxy!
    var slots: [String: Slot] = [:]
    weak var backend: PtyTerminalWorkspaceBackend?
    var latestSessions: [PtySessionSummary] = []
    var sessionsTask: Task<Void, Never>?
    var deliveryQueue = PtyTerminalWebDeliveryQueue()
    var deliveryInFlight = false
    var runtimeReady = false
    var isTornDown = false
    var reloadScheduled = false
    var viewportPresented = false
    var pendingViewportClaimPaneID: String?

    public init(profile: PtyTerminalWebViewProfile = .singleSession) {
        self.profile = profile
        workspaceState = PtyTerminalWorkspaceState(profile: profile)
        schemeHandler = PtyTerminalResourceSchemeHandler(root: PtyTerminalResourceSchemeHandler.bundledRoot)
        let content = WKUserContentController()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: PtyTerminalResourceSchemeHandler.scheme)
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(frame: .zero)
        scriptProxy = PtyTerminalScriptMessageProxy(target: self)
        content.add(scriptProxy, name: "ptyTerminal")
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor), webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor), webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        #if canImport(AppKit)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Terminal workspace")
        setAccessibilityIdentifier("terminal-workspace-root")
        #elseif canImport(UIKit)
        isAccessibilityElement = false
        accessibilityIdentifier = "terminal-workspace-root"
        backgroundColor = PtyTerminalSurfaceAppearance.surface
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        loadRuntime()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("PtyTerminalWebView does not support Interface Builder") }

    deinit {
        sessionsTask?.cancel()
        MainActor.assumeIsolated {
            for slot in slots.values { slot.driver?.detach() }
        }
    }

    public func configureWorkspaceBackend(_ backend: PtyTerminalWorkspaceBackend) {
        precondition(profile == .workspace)
        self.backend = backend
        startSessionSnapshots()
        for pane in workspaceState.panes where slots[pane.terminalID] == nil { open(pane: pane) }
        sendWorkspaceSnapshot()
    }

    public func bind(to connection: PtyTerminalConnection) {
        precondition(profile == .singleSession)
        precondition(slots.isEmpty, "detach the current connection before rebinding")
        let pane = workspaceState.bindSingleSession(name: "terminal", title: "Terminal")
        bind(connection: connection, concreteConnection: connection as? PtySessionConnection, to: pane)
        sendWorkspaceSnapshot()
    }

    public func bindWorkspaceInitialSession(
        _ connection: PtySessionConnection,
        sessionName: String,
        title: String
    ) {
        precondition(profile == .workspace)
        guard let paneID = workspaceState.selectedPane?.paneID,
              let pane = workspaceState.assignSessionName(sessionName, to: paneID) else { return }
        bind(connection: connection, concreteConnection: connection, to: pane)
        if !title.isEmpty { delegate?.ptyTerminalContent(self, didSetTitle: title) }
        sendWorkspaceSnapshot()
        delegate?.ptyTerminalContent(self, didUpdateWorkspace: workspaceState)
    }

    public func restoreWorkspaceState(_ state: PtyTerminalWorkspaceState) {
        precondition(profile == .workspace)
        precondition(slots.isEmpty, "restore workspace before binding sessions")
        guard state.profile == .workspace else { return }
        workspaceState = state
        sendWorkspaceSnapshot()
    }

    public func bindWorkspaceSession(_ connection: PtySessionConnection, paneID: String) {
        precondition(profile == .workspace)
        guard let pane = workspaceState.panes.first(where: { $0.paneID == paneID }),
              slots[pane.terminalID] == nil else { return }
        bind(connection: connection, concreteConnection: connection, to: pane)
        sendWorkspaceSnapshot()
    }

    public func removeEndedWorkspaceTerminal(terminalID: String) {
        guard profile == .workspace,
              let pane = workspaceState.panes.first(where: { $0.terminalID == terminalID }) else { return }
        slots[terminalID]?.driver?.stop()
        slots.removeValue(forKey: terminalID)
        _ = workspaceState.closePane(pane.paneID)
        if let replacement = workspaceState.panes.first(where: { slots[$0.terminalID] == nil }) {
            open(pane: replacement)
        }
        isBound = !slots.isEmpty
        updateSlotParticipation(claimSelected: false)
        sendWorkspaceSnapshot()
        delegate?.ptyTerminalContent(self, didUpdateWorkspace: workspaceState)
    }

    public func detach() {
        sessionsTask?.cancel(); sessionsTask = nil
        for slot in slots.values { slot.driver?.detach() }
        slots.removeAll()
        isBound = false
    }

    public func stop() {
        sessionsTask?.cancel(); sessionsTask = nil
        for slot in slots.values { slot.driver?.stop() }
        slots.removeAll()
        isBound = false
    }

    public func focus() {
        claimViewportOwnership()
        webView.evaluateJavaScript("document.querySelector('.terminal-pane[data-focused=\\\"true\\\"] .xterm-helper-textarea')?.focus()")
    }

    public func resignFocus() {
        #if canImport(AppKit)
        if window?.firstResponder === webView { window?.makeFirstResponder(nil) }
        #elseif canImport(UIKit)
        webView.endEditing(true)
        #endif
    }

    public func setFontSize(_ pointSize: CGFloat) {
        deliver(["type": "fontSize", "pointSize": min(48, max(8, pointSize))])
    }

    public func paste(text: String) {
        guard text.utf8.count <= PtyTerminalWebBridgeLimits.maximumInputBytes else { return }
        deliver(["type": "paste", "terminalId": selectedSlot?.terminalID ?? "", "text": text])
    }

    public func sendInput(_ data: Data) {
        guard isInputEnabled, data.count <= PtyTerminalWebBridgeLimits.maximumInputBytes, let slot = selectedSlot else { return }
        slot.driver?.sendInput(data, viewerDimensions: viewportAuthorityDimensions(for: slot))
    }

    public func feedLocalStatus(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8), let terminalID = selectedSlot?.terminalID else { return }
        feedStatus(text, terminalID: terminalID)
    }

    public func closeAfterManagerDetach() {
        guard let terminalID = selectedSlot?.terminalID else { return }
        closeAfterManagerDetach(terminalID: terminalID)
    }

    public func setViewportActive(_ active: Bool, claim: Bool = false) {
        viewportPresented = active
        if !active {
            pendingViewportClaimPaneID = nil
        } else if claim {
            pendingViewportClaimPaneID = workspaceState.selectedPane?.paneID
        }
        updateSlotParticipation(claimSelected: active && claim)
    }

    public func claimViewportOwnership() { setViewportActive(true, claim: true) }

    public func flushViewportResize() {
        webView.evaluateJavaScript("window.agentDeskTerminal?.flushViewport?.()")
    }

    public func teardown() {
        guard !isTornDown else { return }
        isTornDown = true
        detach()
        deliveryQueue.removeAll()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "ptyTerminal")
        webView.stopLoading()
    }

    var selectedSlot: Slot? {
        guard let terminalID = workspaceState.selectedPane?.terminalID else { return nil }
        return slots[terminalID]
    }

    func viewportAuthorityDimensions(for slot: Slot) -> PtyTerminalDimensions {
        if slot.hasSettledViewportDimensions {
            return slot.dimensions
        }
        if let source = slot.viewportStatus?.sourceDimensions,
           source.columns >= 2, source.rows >= 2 {
            return source
        }
        return .bootstrap
    }

    func loadRuntime() {
        runtimeReady = false
        guard let url = URL(string: "\(PtyTerminalResourceSchemeHandler.scheme)://bundle/index.html") else {
            rendererSetupError = PtyTerminalWebViewError.resourceUnavailable
            return
        }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

}
