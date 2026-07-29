import Foundation
import Testing
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
        var delivered: [String] = []
        let serial = WebPanelSerialDelivery { rawJSON in
            await Task.yield()
            delivered.append(rawJSON)
        }

        serial.enqueue(rawJSON: "first")
        serial.enqueue(rawJSON: "second")
        serial.enqueue(rawJSON: "third")
        await serial.waitUntilIdle()

        #expect(delivered == ["first", "second", "third"])
    }

    @MainActor
    @Test func serialDeliveryCancellationDropsQueuedPushes() async {
        var delivered: [String] = []
        var startContinuation: AsyncStream<Void>.Continuation?
        let started = AsyncStream<Void> { startContinuation = $0 }
        var iterator = started.makeAsyncIterator()
        let serial = WebPanelSerialDelivery { rawJSON in
            if rawJSON == "first" {
                startContinuation?.yield()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else {
                    return
                }
            }
            delivered.append(rawJSON)
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
