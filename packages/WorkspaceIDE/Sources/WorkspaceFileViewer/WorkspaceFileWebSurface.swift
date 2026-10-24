import Foundation
import WebKit
import WorkspaceKit
import os
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

public enum WorkspaceFileMode: String, Equatable, Sendable {
    case preview
    case edit
}

public enum WorkspaceFileContent: Equatable, Sendable {
    case text(String)
    case documentData(Data)
    case documentFile(URL, maximumBytes: Int)
}

/// The file content + classification handed to the shared web viewer.
public struct WorkspaceFilePayload: Equatable, Sendable {
    public let id: String
    public let name: String
    public let path: String
    public let workspace: String
    public let root: String
    public let content: WorkspaceFileContent
    public let kind: WorkspaceFileKind
    public let mode: WorkspaceFileMode

    public init(
        id: String,
        name: String,
        path: String,
        workspace: String,
        root: String,
        content: WorkspaceFileContent,
        kind: WorkspaceFileKind,
        mode: WorkspaceFileMode
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.workspace = workspace
        self.root = root
        self.content = content
        self.kind = kind
        self.mode = mode
    }

    func dictionary(resourceURL: URL?) -> [String: Any] {
        var value: [String: Any] = [
            "id": id,
            "name": name,
            "path": path,
            "workspace": workspace,
            "root": root,
            "kind": kind.rawValue,
            "mode": mode.rawValue,
        ]
        switch content {
        case .text(let text):
            value["text"] = text
        case .documentData, .documentFile:
            precondition(kind == .docx, "binary document content requires DOCX kind")
            guard let resourceURL else {
                preconditionFailure("DOCX resource URL was not published")
            }
            value["resourceURL"] = resourceURL.absoluteString
        }
        return value
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
/// wraps `view` in the FileViewer window; iOS embeds it in the Workspace surface. `view` is a `WKWebView`
/// (an `NSView` on macOS, a `UIView` on iOS), so callers add it as a subview either way.
@MainActor
public final class WorkspaceFileWebSurface: NSObject, WKNavigationDelegate {
    public let view: WKWebView

    /// Fired when the user edits in the SPA (path, new text) — the host persists it.
    public var onDirty: ((URL, String) -> Void)?
    /// Fired when the SPA requests edit mode for a file.
    public var onEditRequest: ((URL) -> Void)?

    private let logger = Logger(subsystem: "agentdesk.editor-viewer", category: "file-web-surface")
    private let resourceStore: WorkspaceFileResourceStore
    private var state = FileWebSurfaceState()

    /// `viewerRoot` defaults to the bundled SPA; callers rarely override it.
    public init(viewerRoot: URL = WorkspaceFileViewer.viewerRootURL) {
        let messageSink = ScriptMessageSink()
        let resourceStore = WorkspaceFileResourceStore()
        self.resourceStore = resourceStore
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(
            AppSchemeHandler(root: viewerRoot, resourceStore: resourceStore),
            forURLScheme: AppSchemeHandler.scheme
        )
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

    public func render(_ payload: WorkspaceFilePayload) {
        apply(state.render(payload))
    }
    public func setTextZoom(_ zoom: WorkspaceFileTextZoom) { apply(state.setTextZoom(zoom)) }

    public func zoomIn() {
        callJS("window.fileSurface.zoomIn()", [:])
    }

    public func zoomOut() {
        callJS("window.fileSurface.zoomOut()", [:])
    }

    private func apply(_ effects: [FileWebSurfaceState.Effect]) {
        for effect in effects {
            switch effect {
            case .render(let payload):
                let resourceURL = resourceStore.publish(payload.content)
                callJS(
                    "await window.fileSurface.render(payload)",
                    ["payload": payload.dictionary(resourceURL: resourceURL)]
                )
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
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
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
    private func markReady() {
        apply(state.markReady())
    }
}
