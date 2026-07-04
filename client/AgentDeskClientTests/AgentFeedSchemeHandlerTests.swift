import Foundation
import Testing
import WebKit

@testable import AgentDeskClient

// MARK: - AgentFeedAssetResolver unit tests
//
// AgentFeedAssetResolver is pure value logic: it maps a request path to a
// bundled file, infers a MIME type, and enforces a path-traversal fence.
// Tests exercise it against a real temporary directory so no WKURLSchemeTask
// is needed.

@MainActor
struct AgentFeedSchemeHandlerTests {

    // MARK: - Helpers

    // Creates a temporary directory with a minimal AgentFeedWebview-style layout:
    //   index.html
    //   assets/index-abc123.js
    //   assets/style-abc123.css
    // Returns the root URL and a cleanup closure.
    private static func makeRoot() throws -> (URL, () -> Void) {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("AgentFeedResolverTests-\(UUID().uuidString)", isDirectory: true)
        let assetsDir = tmp.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)

        let indexContent = Data("<html><body>Hello</body></html>".utf8)
        let jsContent = Data("console.log('hello')".utf8)
        let cssContent = Data("body { margin: 0; }".utf8)

        try indexContent.write(to: tmp.appendingPathComponent("index.html"))
        try jsContent.write(to: assetsDir.appendingPathComponent("index-abc.js"))
        try cssContent.write(to: assetsDir.appendingPathComponent("style-abc.css"))

        let cleanup: () -> Void = {
            try? FileManager.default.removeItem(at: tmp)
        }
        return (tmp, cleanup)
    }

    // MARK: - index.html

    @Test func indexHtmlReturnsTextHtmlMime() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        let result = resolver.resolve(requestPath: "/index.html")
        guard case .success(let resolved) = result else {
            Issue.record("expected success for index.html, got \(result)")
            return
        }
        #expect(resolved.mimeType == "text/html")
        #expect(!resolved.data.isEmpty)
    }

    @Test func emptyPathServesIndexHtml() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        let result = resolver.resolve(requestPath: "")
        guard case .success(let resolved) = result else {
            Issue.record("expected success for empty path, got \(result)")
            return
        }
        #expect(resolved.mimeType == "text/html")
    }

    @Test func slashOnlyServesIndexHtml() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        let result = resolver.resolve(requestPath: "/")
        guard case .success(let resolved) = result else {
            Issue.record("expected success for '/', got \(result)")
            return
        }
        #expect(resolved.mimeType == "text/html")
    }

    // MARK: - Asset MIME types

    @Test func jsAssetReturnsTextJavascriptMime() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        let result = resolver.resolve(requestPath: "/assets/index-abc.js")
        guard case .success(let resolved) = result else {
            Issue.record("expected success for JS asset, got \(result)")
            return
        }
        #expect(resolved.mimeType == "text/javascript")
    }

    @Test func cssAssetReturnsTextCssMime() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        let result = resolver.resolve(requestPath: "/assets/style-abc.css")
        guard case .success(let resolved) = result else {
            Issue.record("expected success for CSS asset, got \(result)")
            return
        }
        #expect(resolved.mimeType == "text/css")
    }

    @Test func mimeTypeForWoff2() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "woff2") == "font/woff2")
    }

    @Test func mimeTypeForWoff() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "woff") == "font/woff")
    }

    @Test func mimeTypeForTtf() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "ttf") == "font/ttf")
    }

    @Test func mimeTypeForJson() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "json") == "application/json")
    }

    @Test func mimeTypeForMap() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "map") == "application/json")
    }

    @Test func mimeTypeForPng() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "png") == "image/png")
    }

    @Test func mimeTypeForSvg() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "svg") == "image/svg+xml")
    }

    @Test func mimeTypeForUnknownExtensionIsOctetStream() {
        #expect(AgentFeedAssetResolver.mimeType(forExtension: "xyz") == "application/octet-stream")
    }

    // MARK: - Path traversal denial

    @Test func dotDotSegmentInPathIsDenied() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        // A classic path traversal: ../../etc/passwd
        let result = resolver.resolve(requestPath: "/../../etc/passwd")
        guard case .failure(let error) = result else {
            Issue.record("expected failure for path traversal, got \(result)")
            return
        }
        #expect(error == .notInRoot)
    }

    @Test func encodedTraversalWithLiteralDotDotIsDenied() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        let result = resolver.resolve(requestPath: "/../../../etc/passwd")
        guard case .failure(let error) = result else {
            Issue.record("expected failure for traversal, got \(result)")
            return
        }
        #expect(error == .notInRoot)
    }

    @Test func missingFileReturnsNotFound() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let resolver = AgentFeedAssetResolver(rootDirectory: root)
        let result = resolver.resolve(requestPath: "/assets/does-not-exist.js")
        guard case .failure(let error) = result else {
            Issue.record("expected failure for missing file, got \(result)")
            return
        }
        #expect(error == .notFound)
    }

    // MARK: - WKURLSchemeTask integration via fake task

    // Verifies that the handler drives the task lifecycle correctly:
    // didReceive(response) then didReceive(data) then didFinish for a hit,
    // or didFailWithError for a miss. Uses a protocol-conforming stub so no
    // WKWebView is needed.

    @Test func handlerCompletesTaskForIndexHtml() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let handler = AgentFeedSchemeHandler(rootDirectory: root)
        let url = URL(string: "agentfeed://app/index.html")!
        let task = FakeURLSchemeTask(url: url)

        handler.webView(WKWebView(), start: task)

        #expect(task.receivedResponseStatusCode == 200)
        #expect(task.receivedData != nil && !task.receivedData!.isEmpty)
        #expect(task.didFinishCalled)
        #expect(task.didFailError == nil)
    }

    @Test func handlerReturns404ForMissingFile() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let handler = AgentFeedSchemeHandler(rootDirectory: root)
        let url = URL(string: "agentfeed://app/assets/no-such-file.js")!
        let task = FakeURLSchemeTask(url: url)

        handler.webView(WKWebView(), start: task)

        // A missing file should result in an error call (no success response).
        #expect(task.receivedResponseStatusCode == nil)
        #expect(task.didFailError != nil)
        #expect(!task.didFinishCalled)
    }

    @Test func handlerStopAfterCompletionIsNoOp() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let handler = AgentFeedSchemeHandler(rootDirectory: root)
        let url = URL(string: "agentfeed://app/index.html")!
        let task = FakeURLSchemeTask(url: url)

        // Start completes the task synchronously (the handler is not async).
        handler.webView(WKWebView(), start: task)
        #expect(task.didFinishCalled)
        #expect(task.receivedResponseStatusCode == 200)

        // Calling stop after completion is a no-op: the key was already removed
        // from activeTasks by the completion path so stop finds nothing to remove.
        // This must not crash or double-call any task method.
        handler.webView(WKWebView(), stop: task)
        #expect(task.didFinishCalled) // still true, not toggled back
    }

    @Test func handlerDeniesPathTraversalViaSchemeTask() throws {
        let (root, cleanup) = try Self.makeRoot()
        defer { cleanup() }

        let handler = AgentFeedSchemeHandler(rootDirectory: root)
        // The URL path is /../../../etc/passwd — two dot-dot segments.
        let url = URL(string: "agentfeed://app/../../etc/passwd")!
        let task = FakeURLSchemeTask(url: url)

        handler.webView(WKWebView(), start: task)

        // Traversal should produce an error, never a success.
        #expect(task.didFailError != nil)
        #expect(!task.didFinishCalled)
    }
}

// MARK: - Fake WKURLSchemeTask stub

// A minimal protocol-conforming stub that captures what the handler calls.
// WKURLSchemeTask is an Objective-C protocol; we subclass NSObject and
// implement it via @objc so the Swift compiler is satisfied.
private final class FakeURLSchemeTask: NSObject, WKURLSchemeTask, @unchecked Sendable {
    private let _request: URLRequest

    var receivedResponseStatusCode: Int?
    var receivedData: Data?
    var didFinishCalled = false
    var didFailError: Error?

    init(url: URL) {
        _request = URLRequest(url: url)
        super.init()
    }

    var request: URLRequest { _request }

    func didReceive(_ response: URLResponse) {
        if let http = response as? HTTPURLResponse {
            receivedResponseStatusCode = http.statusCode
        } else {
            // Non-HTTP URLResponse: treat as 200 for test purposes.
            receivedResponseStatusCode = 200
        }
    }

    func didReceive(_ data: Data) {
        if receivedData == nil {
            receivedData = data
        } else {
            receivedData?.append(data)
        }
    }

    func didFinish() {
        didFinishCalled = true
    }

    func didFailWithError(_ error: Error) {
        didFailError = error
    }
}
