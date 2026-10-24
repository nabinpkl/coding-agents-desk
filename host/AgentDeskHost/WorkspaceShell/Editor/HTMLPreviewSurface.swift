import AppKit
import Foundation
import WebKit
import os

final class HTMLPreviewSurface: NSObject, WKNavigationDelegate {
    let view: WKWebView

    var onOpenFile: ((URL) -> Void)?

    private let logger = Logger(subsystem: Config.logSubsystem, category: "html-preview")
    private var currentFile: URL?
    private var readRoot: URL?

    override init() {
        let config = WKWebViewConfiguration()
        #if DEBUG
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #endif

        view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = false

        super.init()
        view.navigationDelegate = self
    }

    func load(file: URL, readAccessRoot: URL) {
        currentFile = file.standardizedFileURL
        readRoot = readAccessRoot.standardizedFileURL
        view.loadFileURL(file, allowingReadAccessTo: readAccessRoot)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        guard url.isFileURL else { decisionHandler(.cancel); return }
        let file = url.standardizedFileURL
        guard isUnderReadRoot(file) else { decisionHandler(.cancel); return }
        if navigationAction.navigationType == .linkActivated,
           file.path != currentFile?.path {
            onOpenFile?(file)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        logger.error("html preview failed to load: \(String(describing: error), privacy: .public)")
    }

    private func isUnderReadRoot(_ file: URL) -> Bool {
        guard let readRoot else { return false }
        let root = readRoot.path.hasSuffix("/") ? readRoot.path : readRoot.path + "/"
        return file.path == readRoot.path || file.path.hasPrefix(root)
    }
}
