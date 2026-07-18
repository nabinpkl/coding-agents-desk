import Foundation
import Testing
@testable import AgentPanel

struct AgentPanelTests {
    @Test func packageFixtureResolvesForCleanBuilds() throws {
        let locator = AgentPanelResourceLocator()

        let root = try #require(locator.rootDirectory())
        let index = try #require(locator.indexURL())
        let requestURL = try #require(locator.requestURL())

        #expect(root.lastPathComponent == "AgentPanelFixture")
        #expect(index.lastPathComponent == "index.html")
        #expect(String(decoding: try Data(contentsOf: index), as: UTF8.self).contains("AgentPanel fixture"))
        #expect(requestURL.absoluteString == "agentfeed://app/index.html")
    }

    @Test func customContractControlsTheRequestURL() throws {
        let contract = AgentPanelJavaScriptContract(scheme: "agentpanel", host: "local")
        let locator = AgentPanelResourceLocator(contract: contract)

        #expect(locator.requestURL()?.absoluteString == "agentpanel://local/index.html")
        #expect(try #require(locator.rootDirectory(indexPath: contract.indexPath)).lastPathComponent == "AgentPanelFixture")
    }

    @Test func assetResolverRejectsTraversalAndAssignsContentTypes() throws {
        let root = try makeTemporaryResourceRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("console.log('ok')".utf8).write(to: root.appendingPathComponent("assets/app.js"))

        let resolver = AgentPanelAssetResolver(rootDirectory: root)

        #expect(resolver.resolve(requestPath: "/../secret.txt") == .failure(.notInRoot))
        #expect(resolver.resolve(requestPath: "/assets/../secret.txt") == .failure(.notInRoot))

        guard case .success(let resolved) = resolver.resolve(requestPath: "/assets/app.js") else {
            Issue.record("Expected the JavaScript asset to resolve")
            return
        }
        #expect(resolved.mimeType == "text/javascript")
        #expect(resolved.data == Data("console.log('ok')".utf8))
        #expect(AgentPanelAssetResolver.mimeType(forExtension: "woff2") == "font/woff2")
    }

    @Test func requestDecoderPreservesCurrentAgentFeedContract() {
        #expect(
            AgentPanelRequest.decode(tag: "agent-projects-sub", body: [:]) == .projectsSubscribe
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-thread-sub",
                body: ["sid": "session-1", "src": "codex"]
            ) == .threadSubscribe(projectPath: nil, source: "codex", sessionId: "session-1")
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-thread-older",
                body: ["sid": "session-1", "bi": 100, "lim": 25]
            ) == .threadLoadOlder(sessionId: "session-1", beforeIndex: 100, limit: 25)
        )
        #expect(AgentPanelRequest.decode(tag: "agent-thread-sub", body: [:]) == nil)
        #expect(AgentPanelRequest.decode(tag: "future-message", body: [:]) == nil)
    }

    @Test func requestDecoderPreservesRawEventIdentity() {
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "r1", "sid": "s1", "ei": 9]
        ) == .rawEvent(requestId: "r1", sessionId: "s1", eventIndex: 9))
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "", "sid": "s1", "ei": 9]
        ) == nil)
    }

    @Test func requestDecoderPreservesTerminalIntentContext() {
        let context = AgentPanelTerminalContext(
            projectPath: "/Users/dev/projects/alpha",
            source: .claude,
            sessionID: "3A58D7B8-4E2D-4E06-93C2-49BB6F6CB21A"
        )

        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: [
                    "rid": "request-1",
                    "ctx": [
                        "pp": context.projectPath,
                        "src": context.source.rawValue,
                        "sid": context.sessionID,
                    ],
                ]
            ) == .terminal(.open(requestID: "request-1", context: context))
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-close",
                body: [
                    "rid": "request-1",
                    "ctx": [
                        "pp": context.projectPath,
                        "src": context.source.rawValue,
                        "sid": context.sessionID,
                    ],
                ]
            ) == .terminal(.close(requestID: "request-1", context: context))
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-context-ended",
                body: [
                    "rid": "request-1",
                    "ctx": [
                        "pp": context.projectPath,
                        "src": context.source.rawValue,
                        "sid": context.sessionID,
                    ],
                ]
            ) == .terminal(.contextEnded(requestID: "request-1", context: context))
        )
    }

    @Test func requestDecoderRejectsIncompleteOrUnknownTerminalContext() {
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: [
                    "rid": "request-1",
                    "ctx": ["pp": "/project", "src": "other", "sid": "session-1"],
                ]
            ) == nil
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: [
                    "rid": "",
                    "ctx": ["pp": "/project", "src": "codex", "sid": "session-1"],
                ]
            ) == nil
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: ["rid": "request-1", "ctx": ["src": "codex", "sid": "session-1"]]
            ) == nil
        )
    }

    @MainActor
    @Test func queuedPushesFlushInOrderAfterWebReadiness() {
        var delivered: [String] = []
        let queue = AgentPanelDeliveryQueue { delivered.append($0) }

        queue.enqueue(rawJSON: #"{"t":"agent-projects"}"#)
        queue.enqueue(rawJSON: #"{"t":"agent-thread-chunk"}"#)
        #expect(delivered.isEmpty)

        queue.markReady()

        #expect(delivered == [#"{"t":"agent-projects"}"#, #"{"t":"agent-thread-chunk"}"#])
        #expect(queue.pendingCount == 0)
    }

    @MainActor
    @Test func teardownCancelsQueuedAndFutureDelivery() {
        var delivered: [String] = []
        let queue = AgentPanelDeliveryQueue { delivered.append($0) }

        queue.enqueue(rawJSON: #"{"t":"agent-projects"}"#)
        queue.teardown()
        queue.markReady()
        queue.enqueue(rawJSON: #"{"t":"agent-thread-chunk"}"#)

        #expect(delivered.isEmpty)
        #expect(queue.pendingCount == 0)
        #expect(queue.isTornDown)
    }

    @MainActor
    @Test func navigationStartQueuesPushesUntilTheNextReadyState() {
        var delivered: [String] = []
        let queue = AgentPanelDeliveryQueue { delivered.append($0) }

        queue.markReady()
        queue.enqueue(rawJSON: #"{"t":"agent-projects"}"#)
        queue.markNotReady()
        queue.enqueue(rawJSON: #"{"t":"agent-thread-chunk"}"#)

        #expect(delivered == [#"{"t":"agent-projects"}"#])
        #expect(queue.pendingCount == 1)

        queue.markReady()

        #expect(delivered == [#"{"t":"agent-projects"}"#, #"{"t":"agent-thread-chunk"}"#])
        #expect(queue.pendingCount == 0)
    }

    @MainActor
    @Test func serialDeliveryPreservesAsyncPushOrder() async {
        var delivered: [String] = []
        let serial = AgentPanelSerialDelivery { rawJSON in
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
        let serial = AgentPanelSerialDelivery { rawJSON in
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
            .appendingPathComponent("AgentPanelTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("assets"),
            withIntermediateDirectories: true
        )
        return root
    }
}
