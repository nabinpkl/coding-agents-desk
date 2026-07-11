import Foundation
import WebKit
import os
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// The file content + classification handed to the web viewer. Stringly-typed `kind`/`mode` keep the
/// surface free of any host enum, so both the macOS shell and the iOS Files surface can build one.
public struct WorkspaceFilePayload: Equatable, Sendable {
    public let id: String
    public let name: String
    public let path: String
    public let workspace: String
    public let root: String
    public let text: String
    /// "markdown" | "html" | "notebook" | "text" — how the SPA renders the file.
    public let kind: String
    /// "preview" | "edit" — the SPA's initial mode.
    public let mode: String

    public init(id: String, name: String, path: String, workspace: String, root: String, text: String, kind: String, mode: String) {
        self.id = id
        self.name = name
        self.path = path
        self.workspace = workspace
        self.root = root
        self.text = text
        self.kind = kind
        self.mode = mode
    }

    var dictionary: [String: Any] {
        ["id": id, "name": name, "path": path, "workspace": workspace, "root": root, "text": text, "kind": kind, "mode": mode]
    }
}

/// Text-zoom the SPA applies to the editor + rendered markdown. Plain values so the surface needs no
/// host `WorkspaceTextZoom` type.
public struct WorkspaceFileTextZoom: Equatable, Sendable {
    public let editorCodePointSize: Double
    public let markdownPointSize: Double

    public init(editorCodePointSize: Double, markdownPointSize: Double) {
        self.editorCodePointSize = editorCodePointSize
        self.markdownPointSize = markdownPointSize
    }

    var dictionary: [String: Any] { ["editorCodePointSize": editorCodePointSize, "markdownPointSize": markdownPointSize] }
}

/// Ready-state machine: queues the latest payload/zoom until the SPA installs `window.fileSurface`,
/// then flushes. Pure; the surface applies the returned effects.
struct FileWebSurfaceState {
    enum Effect: Equatable {
        case render(WorkspaceFilePayload)
        case setTextZoom(WorkspaceFileTextZoom)
    }

    private enum Readiness { case loading, ready, failed }
    private var readiness: Readiness = .loading
    private var queuedPayload: WorkspaceFilePayload?
    private var zoom: WorkspaceFileTextZoom?

    mutating func render(_ payload: WorkspaceFilePayload) -> [Effect] {
        queuedPayload = payload
        return readiness == .ready ? [.render(payload)] : []
    }

    mutating func setTextZoom(_ zoom: WorkspaceFileTextZoom) -> [Effect] {
        self.zoom = zoom
        return readiness == .ready ? [.setTextZoom(zoom)] : []
    }

    mutating func navigationStarted() { readiness = .loading }
    mutating func markFailed() { readiness = .failed }

    mutating func markReady() -> [Effect] {
        guard readiness != .ready else { return [] }
        readiness = .ready
        var effects: [Effect] = []
        if let zoom { effects.append(.setTextZoom(zoom)) }
        if let queuedPayload { effects.append(.render(queuedPayload)) }
        return effects
    }
}

/// The shared file web viewer surface (ADR-0054 Phase G): a `WKWebView` hosting the bundled SPA
/// (CodeMirror + markdown-it + mermaid) over the `app://` scheme, driving its `window.fileSurface`
/// JS contract. Cross-platform — the only platform split is opening external http(s) links. macOS
/// wraps `view` in the FileViewer window; iOS embeds it in the Files surface. `view` is a `WKWebView`
/// (an `NSView` on macOS, a `UIView` on iOS), so callers add it as a subview either way.
@MainActor
public final class WorkspaceFileWebSurface: NSObject, WKNavigationDelegate {
    public let view: WKWebView

    /// Fired when the user edits in the SPA (path, new text) — the host persists it.
    public var onDirty: ((URL, String) -> Void)?
    /// Fired when the SPA requests edit mode for a file.
    public var onEditRequest: ((URL) -> Void)?

    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDesk.editor-viewer", category: "file-web-surface")
    private var state = FileWebSurfaceState()

    /// `viewerRoot` defaults to the bundled SPA; callers rarely override it.
    public init(viewerRoot: URL = WorkspaceEditorViewer.viewerRootURL) {
        let messageSink = ScriptMessageSink()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(root: viewerRoot), forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.add(ScriptMessageProxy { body in messageSink.handle(body) }, name: "shell")
        #if DEBUG
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #endif

        view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = false
        #if os(macOS)
        view.setValue(false, forKey: "drawsBackground")
        #else
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        #endif

        super.init()
        messageSink.onMessage = { [weak self] body in self?.handleMessage(body) }
        view.navigationDelegate = self
        view.load(URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/index.html")!))
    }

    public func render(_ payload: WorkspaceFilePayload) { apply(state.render(payload)) }
    public func setTextZoom(_ zoom: WorkspaceFileTextZoom) { apply(state.setTextZoom(zoom)) }

    private func apply(_ effects: [FileWebSurfaceState.Effect]) {
        for effect in effects {
            switch effect {
            case .render(let payload):
                callJS("await window.fileSurface.render(payload)", ["payload": payload.dictionary])
            case .setTextZoom(let zoom):
                callJS("await window.fileSurface.setTextZoom(zoom)", ["zoom": zoom.dictionary])
            }
        }
    }

    private func callJS(_ body: String, _ arguments: [String: Any]) {
        view.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { [weak self] result in
            if case .failure(let error) = result {
                self?.logger.error("file web surface JS failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private func handleMessage(_ body: Any) {
        let parsed: FileEditorSurfaceMessage
        do {
            parsed = try FileEditorSurfaceMessage.parse(body)
        } catch {
            logger.error("file web surface sent malformed message: \(String(describing: body), privacy: .public)")
            return
        }
        switch parsed {
        case .ready: markReady()
        case .dirty(let id, let text): onDirty?(URL(fileURLWithPath: id), text)
        case .edit(let id): onEditRequest?(URL(fileURLWithPath: id))
        case .runNotebookCell: break // notebook execution is out of scope in AgentDesk
        }
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        state.navigationStarted()
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        state.markFailed()
        logger.error("file web surface failed to load: \(String(describing: error), privacy: .public)")
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        view.callAsyncJavaScript(
            "Boolean(window.fileSurface && window.fileSurface.render)", arguments: [:], in: nil, in: .page
        ) { [weak self] result in
            switch result {
            case .success(let ready as Bool) where ready: self?.markReady()
            case .success:
                self?.state.markFailed()
                self?.logger.error("file web surface loaded before window.fileSurface was installed")
            case .failure(let error):
                self?.state.markFailed()
                self?.logger.error("file web surface readiness check failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == AppSchemeHandler.scheme {
            decisionHandler(.allow)
        } else {
            if url.scheme == "http" || url.scheme == "https" { openExternal(url) }
            decisionHandler(.cancel)
        }
    }

    private func openExternal(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #elseif os(iOS)
        UIApplication.shared.open(url)
        #endif
    }

    /// `viewer.mjs` sends `ready` once `window.fileSurface` is installed (ES modules may still be
    /// evaluating after `didFinish`); render the latest payload then.
    private func markReady() { apply(state.markReady()) }
}
