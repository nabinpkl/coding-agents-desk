import Foundation
import Testing
import WebKit
@testable import WorkspaceFileViewer

@MainActor
struct AppSchemeHandlerIntegrationTests {
    @Test func documentFetchReceivesSuccessfulResponseAndCompleteBody() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("<!doctype html><title>viewer test</title>".utf8)
            .write(to: root.appendingPathComponent("index.html"))

        let expectedBody = Data([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
        let resourceStore = WorkspaceFileResourceStore()
        let resourceURL = try #require(
            resourceStore.publish(.documentData(expectedBody))
        )
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            AppSchemeHandler(root: root, resourceStore: resourceStore),
            forURLScheme: AppSchemeHandler.scheme
        )
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let navigation = NavigationAwaiter()
        webView.navigationDelegate = navigation

        try await navigation.load(
            URLRequest(url: URL(string: "\(AppSchemeHandler.scheme)://app/index.html")!),
            in: webView
        )
        let result = try await fetch(
            """
            const response = await fetch(resourceURL)
            return {
              status: response.status,
              ok: response.ok,
              contentType: response.headers.get('Content-Type'),
              bodyHex: Array.from(
                new Uint8Array(await response.arrayBuffer()),
                byte => byte.toString(16).padStart(2, '0')
              ).join('')
            }
            """,
            arguments: ["resourceURL": resourceURL.absoluteString],
            in: webView
        )

        #expect(result.status == 200)
        #expect(result.ok)
        #expect(result.contentType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        #expect(result.bodyHex == expectedBody.map { String(format: "%02x", $0) }.joined())
    }

    private func fetch(
        _ body: String,
        arguments: [String: Any],
        in webView: WKWebView
    ) async throws -> FetchResult {
        try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(
                body,
                arguments: arguments,
                in: nil,
                in: .page
            ) { result in
                switch result {
                case .success(let rawResult):
                    guard let dictionary = rawResult as? [String: Any],
                          let status = dictionary["status"] as? Int,
                          let ok = dictionary["ok"] as? Bool,
                          let contentType = dictionary["contentType"] as? String,
                          let bodyHex = dictionary["bodyHex"] as? String else {
                        continuation.resume(throwing: JavaScriptResultFailure())
                        return
                    }
                    continuation.resume(returning: FetchResult(
                        status: status,
                        ok: ok,
                        contentType: contentType,
                        bodyHex: bodyHex
                    ))
                case .failure(let error):
                    continuation.resume(throwing: JavaScriptFailure(message: error.localizedDescription))
                }
            }
        }
    }
}

private struct FetchResult: Sendable {
    let status: Int
    let ok: Bool
    let contentType: String
    let bodyHex: String
}

private struct JavaScriptResultFailure: Error {}

private struct JavaScriptFailure: Error {
    let message: String
}

@MainActor
private final class NavigationAwaiter: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, any Error>?

    func load(_ request: URLRequest, in webView: WKWebView) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            webView.load(request)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            self?.finish()
        }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: any Error
    ) {
        fail(with: error.localizedDescription)
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error
    ) {
        fail(with: error.localizedDescription)
    }

    private nonisolated func fail(with message: String) {
        Task { @MainActor [weak self] in
            self?.finish(throwing: NavigationFailure(message: message))
        }
    }

    private func finish(throwing error: (any Error)? = nil) {
        guard let continuation else { return }
        self.continuation = nil
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume()
        }
    }
}

private struct NavigationFailure: Error {
    let message: String
}
