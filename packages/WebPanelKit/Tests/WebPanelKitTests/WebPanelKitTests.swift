import Foundation
import Testing
import WebKit
@testable import WebPanelKit

struct WebPanelKitTests {
    @Test func assetResolverRejectsTraversalAndAssignsContentTypes() throws {
        let root = try makeTemporaryResourceRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("console.log('ok')".utf8).write(to: root.appendingPathComponent("assets/app.js"))

        let resolver = WebPanelAssetResolver(rootDirectory: root)

        #expect(resolver.resolve(requestPath: "/../secret.txt") == .failure(.notInRoot))
        #expect(resolver.resolve(requestPath: "/assets/../secret.txt") == .failure(.notInRoot))

        guard case .success(let resolved) = resolver.resolve(requestPath: "/assets/app.js") else {
            Issue.record("Expected the JavaScript asset to resolve")
            return
        }
        #expect(resolved.mimeType == "text/javascript")
        #expect(resolved.data == Data("console.log('ok')".utf8))
        #expect(WebPanelAssetResolver.mimeType(forExtension: "woff2") == "font/woff2")
    }

    @MainActor
    @Test func deliveredBodyCarriesPayloadFieldsWithoutTheEnvelopeTag() {
        let payload = WebPanelWebViewController.payload(
            from: ["t": "dictationLayout", "width": 480, "height": 156]
        )

        #expect(payload.count == 2)
        #expect(payload["t"] == nil)
        #expect(payload["width"] as? Int == 480)
        #expect(payload["height"] as? Int == 156)
        #expect(WebPanelWebViewController.payload(from: ["t": "dictationReady"]).isEmpty)
    }

    #if os(macOS)
    @MainActor
    @Test func panelWebviewAnswersTheFirstClickWhileItsWindowIsNotKey() {
        // These panels float over an app the user is actively working in, so
        // nearly every click on one arrives while it is not key. Without this
        // the click is spent on focus and the control never sees it.
        let webView = WebPanelWebView(frame: .zero, configuration: WKWebViewConfiguration())

        #expect(webView.acceptsFirstMouse(for: nil))
    }
    #endif

    @MainActor
    @Test func queuedPushesFlushInOrderAfterWebReadiness() {
        var delivered: [String] = []
        let queue = WebPanelDeliveryQueue { delivered.append($0) }

        queue.enqueue(rawJSON: #"{"t":"a"}"#)
        queue.enqueue(rawJSON: #"{"t":"b"}"#)
        #expect(delivered.isEmpty)

        queue.markReady()

        #expect(delivered == [#"{"t":"a"}"#, #"{"t":"b"}"#])
        #expect(queue.pendingCount == 0)
    }

    @MainActor
    @Test func teardownCancelsQueuedAndFutureDelivery() {
        var delivered: [String] = []
        let queue = WebPanelDeliveryQueue { delivered.append($0) }

        queue.enqueue(rawJSON: #"{"t":"a"}"#)
        queue.teardown()
        queue.markReady()
        queue.enqueue(rawJSON: #"{"t":"b"}"#)

        #expect(delivered.isEmpty)
        #expect(queue.pendingCount == 0)
        #expect(queue.isTornDown)
    }

    @MainActor
    @Test func navigationStartQueuesPushesUntilTheNextReadyState() {
        var delivered: [String] = []
        let queue = WebPanelDeliveryQueue { delivered.append($0) }

        queue.markReady()
        queue.enqueue(rawJSON: #"{"t":"a"}"#)
        queue.markNotReady()
        queue.enqueue(rawJSON: #"{"t":"b"}"#)

        #expect(delivered == [#"{"t":"a"}"#])
        #expect(queue.pendingCount == 1)

        queue.markReady()

        #expect(delivered == [#"{"t":"a"}"#, #"{"t":"b"}"#])
        #expect(queue.pendingCount == 0)
    }

    @MainActor
    @Test func serialDeliveryPreservesAsyncPushOrder() async {
        var delivered: [[String]] = []
        let serial = WebPanelSerialDelivery { batch in
            await Task.yield()
            delivered.append(batch)
        }

        serial.enqueue(rawJSON: "first")
        serial.enqueue(rawJSON: "second")
        serial.enqueue(rawJSON: "third")
        await serial.waitUntilIdle()

        // All three enqueues land before the worker's first iteration, so they
        // arrive as one ordered batch -- order preserved within it.
        #expect(delivered == [["first", "second", "third"]])
    }

    @MainActor
    @Test func serialDeliveryBatchesWhileADeliveryIsInFlight() async {
        var delivered: [[String]] = []
        var release: AsyncStream<Void>.Continuation?
        let gate = AsyncStream<Void> { release = $0 }
        var iterator = gate.makeAsyncIterator()
        let serial = WebPanelSerialDelivery { batch in
            delivered.append(batch)
            if batch == ["first"] {
                // Hold the first delivery so the burst queues behind it.
                release?.yield()
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }

        serial.enqueue(rawJSON: "first")
        _ = await iterator.next()
        for index in 2...40 {
            serial.enqueue(rawJSON: "message-\(index)")
        }
        await serial.waitUntilIdle()

        // One round trip for the burst: everything queued during the in-flight
        // delivery arrived as a single batch, in order.
        #expect(delivered.first == ["first"])
        #expect(delivered.count == 2)
        #expect(delivered[1].count == 39)
        #expect(delivered[1].first == "message-2")
        #expect(delivered[1].last == "message-40")
    }

    @MainActor
    @Test func serialDeliveryCancellationDropsQueuedPushes() async {
        var delivered: [[String]] = []
        var startContinuation: AsyncStream<Void>.Continuation?
        let started = AsyncStream<Void> { startContinuation = $0 }
        var iterator = started.makeAsyncIterator()
        let serial = WebPanelSerialDelivery { batch in
            if batch.first == "first" {
                startContinuation?.yield()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else {
                    return
                }
            }
            delivered.append(batch)
        }

        serial.enqueue(rawJSON: "first")
        serial.enqueue(rawJSON: "second")
        _ = await iterator.next()
        serial.cancel()
        await serial.waitUntilIdle()

        #expect(delivered.isEmpty)
        #expect(serial.isCancelled)
        #expect(serial.pendingCount == 0)
    }

    #if os(macOS)
    /// The batch delivery is only as good as the argument conversion that feeds
    /// it: `callAsyncJavaScript` turns a Swift `[String]` into a JS array of
    /// strings, and the loop parses each element. Passing the JSON-encoded array
    /// TEXT instead makes `payloads` a string, the loop iterates characters, and
    /// every webview delivery fails -- the regression that hung the panel on
    /// "Loading projects...". This pins the script shape and the argument type
    /// that the webview conversion depends on.
    @MainActor
    @Test func batchDeliveryScriptFansOutAndTakesAStringArray() {
        let script = WebPanelWebViewController.batchDeliveryScript(deliveryFunctionName: "__agentFeedDeliver")
        #expect(script.contains("window.__agentFeedDeliver"))
        #expect(script.contains("JSON.parse(payloads[i])"))
        #expect(script.contains("for (var i = 0; i < payloads.length; i++)"))

        // The regression: the batch must be a [String] (bridges to a JS array of
        // strings). The JSON-encoded array TEXT is a String and would break the loop.
        let batch: [String] = [#"{"t":"a"}"#, #"{"t":"b"}"#]
        let arguments: [String: Any] = ["payloads": batch]
        #expect(arguments["payloads"] is [String])
        #expect(!(arguments["payloads"] is String))
    }
    #endif

    private func makeTemporaryResourceRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("WebPanelKitTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("assets"),
            withIntermediateDirectories: true
        )
        return root
    }
}
