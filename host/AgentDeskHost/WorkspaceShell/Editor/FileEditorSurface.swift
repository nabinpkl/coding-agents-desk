import AppKit
import Foundation
import WebKit
import os

final class FileEditorSurface: NSObject, WKNavigationDelegate {
    struct Payload: Equatable {
        let id: String
        let name: String
        let path: String
        let workspace: String
        let root: String
        let text: String
        let kind: FilePreviewKind
        let mode: FileTabMode
    }

    let view: WKWebView

    var onDirty: ((URL, String) -> Void)?
    var onEditRequest: ((URL) -> Void)?
    var onRunNotebookCell: ((URL, Int, String) -> Void)?

    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskHost", category: "editor-surface")
    private var state = FileEditorSurfaceState()

    init(viewerRoot: URL) {
        let messageSink = ScriptMessageSink()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(root: viewerRoot), forURLScheme: AppSchemeHandler.scheme)
        config.userContentController.add(
            ScriptMessageProxy { body in messageSink.handle(body) },
            name: "shell"
        )
        #if DEBUG
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #endif

        view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = false
        view.setValue(false, forKey: "drawsBackground")

        super.init()
        messageSink.onMessage = { [weak self] body in self?.handleMessage(body) }
        view.navigationDelegate = self
        view.load(URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/index.html")!))
    }

    func render(_ payload: Payload) {
        apply(state.render(payload))
    }

    func setTextZoom(_ zoom: WorkspaceTextZoom) {
        apply(state.setTextZoom(zoom))
    }

    func applyNotebookRunEvent(_ event: NotebookRunEvent) {
        callJS(
            "await window.fileSurface.applyNotebookRunEvent(event)",
            ["event": event.webDictionary]
        )
    }

    private func apply(_ effects: [FileEditorSurfaceState.Effect]) {
        for effect in effects {
            switch effect {
            case .render(let payload):
                callJS("await window.fileSurface.render(payload)", ["payload": payload.dictionary])
            case .setTextZoom(let zoom):
                callJS("await window.fileSurface.setTextZoom(zoom)", ["zoom": zoom.webDictionary])
            }
        }
    }

    private func callJS(_ body: String, _ arguments: [String: Any]) {
        view.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { [weak self] result in
            if case .failure(let error) = result {
                self?.logger.error("editor surface JS failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    fileprivate func handleMessage(_ body: Any) {
        let parsed: FileEditorSurfaceMessage
        do {
            parsed = try FileEditorSurfaceMessage.parse(body)
        } catch {
            logger.error("editor surface sent malformed message: \(String(describing: body), privacy: .public)")
            return
        }

        switch parsed {
        case .ready:
            markReady()
        case .dirty(let id, let text):
            let url = URL(fileURLWithPath: id)
            onDirty?(url, text)
        case .edit(let id):
            let url = URL(fileURLWithPath: id)
            onEditRequest?(url)
        case .runNotebookCell(let id, let cellIndex, let source):
            let url = URL(fileURLWithPath: id)
            onRunNotebookCell?(url, cellIndex, source)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        state.navigationStarted()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        state.markFailed()
        logger.error("editor surface failed to load: \(String(describing: error), privacy: .public)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        view.callAsyncJavaScript(
            "Boolean(window.fileSurface && window.fileSurface.render)",
            arguments: [:],
            in: nil,
            in: .page
        ) { [weak self] result in
            switch result {
            case .success(let ready as Bool) where ready:
                self?.markReady()
            case .success:
                self?.state.markFailed()
                self?.logger.error("editor surface loaded before window.fileSurface was installed")
            case .failure(let error):
                self?.state.markFailed()
                self?.logger.error("editor surface readiness check failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == AppSchemeHandler.scheme {
            decisionHandler(.allow)
        } else {
            if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    /// `viewer.mjs` sends an explicit `ready` message once `window.fileSurface` is installed (ES
    /// modules may still be evaluating after `didFinish`), so we render the latest payload then.
    private func markReady() {
        apply(state.markReady())
    }
}

private extension WorkspaceTextZoom {
    var webDictionary: [String: Any] {
        [
            "editorCodePointSize": editorCodePointSize,
            "markdownPointSize": markdownPointSize,
        ]
    }
}

private extension FileEditorSurface.Payload {
    var dictionary: [String: Any] {
        [
            "id": id,
            "name": name,
            "path": path,
            "workspace": workspace,
            "root": root,
            "text": text,
            "kind": kind.webName,
            "mode": mode.rawValue,
        ]
    }
}

private extension FilePreviewKind {
    var webName: String {
        switch self {
        case .html: "html"
        case .markdown: "markdown"
        case .notebook: "notebook"
        case .text: "text"
        }
    }
}
