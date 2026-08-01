import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

@MainActor
struct ClientDiagnosticsBrokerTests {
    @Test func routesOverlappingRequestsAndKeepsAnnouncementsSeparate() async throws {
        let server = BrokerInputChannelServer()
        var announcements: [DiagnosticsSummary] = []
        let broker = ClientDiagnosticsBroker(server: server, timeoutSeconds: 2) {
            announcements.append($0)
        }
        broker.start()

        let first = DiagnosticsRequest(
            requestId: "manual-one",
            sinceRunId: nil,
            includePreviousRuns: true,
            maxBytes: 1_024
        )
        let second = DiagnosticsRequest(
            requestId: "auto-two",
            sinceRunId: nil,
            includePreviousRuns: true,
            maxBytes: 1_024
        )
        async let firstResult = broker.collect(first)
        async let secondResult = broker.collect(second)
        guard await waitForRequests(
            [first.requestId, second.requestId],
            from: server
        ) else {
            Issue.record("collectors did not register before replies were sent")
            broker.cancel()
            return
        }

        server.yield(.summary(summary(requestId: "announce-current", runId: "current")))
        server.yield(.summary(summary(requestId: second.requestId, runId: "run-two")))
        server.yield(.summary(summary(requestId: first.requestId, runId: "run-one")))
        server.yield(.chunk(chunk(
            requestId: first.requestId,
            sequence: 0,
            final: true,
            runId: "run-one",
            bytes: Data("one".utf8)
        )))
        server.yield(.chunk(chunk(
            requestId: second.requestId,
            sequence: 0,
            final: true,
            runId: "run-two",
            bytes: Data("two".utf8)
        )))

        let (collectedFirst, collectedSecond) = try await (firstResult, secondResult)
        #expect(server.requests.map(\.requestId).sorted() == ["auto-two", "manual-one"])
        #expect(announcements.map(\.requestId) == ["announce-current"])
        #expect(collectedFirst.runPayloads["run-one"] == Data("one".utf8))
        #expect(collectedSecond.runPayloads["run-two"] == Data("two".utf8))
        broker.cancel()
    }

    @Test func laneCloseFailsPendingCollector() async {
        let server = BrokerInputChannelServer()
        let broker = ClientDiagnosticsBroker(server: server, timeoutSeconds: 2) { _ in }
        broker.start()

        let request = DiagnosticsRequest(
            requestId: "closing",
            sinceRunId: nil,
            includePreviousRuns: true,
            maxBytes: 1_024
        )
        let collection = Task {
            try await broker.collect(request)
        }
        await Task.yield()
        server.finishDiagnostics()

        do {
            _ = try await collection.value
            Issue.record("collector unexpectedly completed")
        } catch let error as ClientDiagnosticsRequesterError {
            guard case .unavailable = error else {
                Issue.record("unexpected error \(error)")
                return
            }
        } catch {
            Issue.record("unexpected error \(error)")
        }
        broker.cancel()
    }

    private func summary(requestId: String, runId: String) -> DiagnosticsSummary {
        DiagnosticsSummary(
            requestId: requestId,
            runs: [
                DiagnosticsRunSummary(
                    runId: runId,
                    startedAt: 1,
                    cleanShutdown: false,
                    byteCount: 3,
                    eventCount: 1
                )
            ],
            droppedEvents: 0,
            droppedBytes: 0,
            latestMetricKitPayloadAt: nil
        )
    }

    private func chunk(
        requestId: String,
        sequence: Int,
        final: Bool,
        runId: String,
        bytes: Data
    ) -> DiagnosticsChunk {
        DiagnosticsChunk(
            requestId: requestId,
            sequence: sequence,
            isFinal: final,
            runId: runId,
            uncompressedBytes: bytes.count,
            payloadBase64: bytes.base64EncodedString()
        )
    }

    private func waitForRequests(
        _ expectedRequestIds: Set<String>,
        from server: BrokerInputChannelServer
    ) async -> Bool {
        for _ in 0..<100 {
            if Set(server.requests.map(\.requestId)) == expectedRequestIds {
                return true
            }
            await Task.yield()
        }
        return false
    }
}

private final class BrokerInputChannelServer: InputChannelServing, @unchecked Sendable {
    let events: AsyncStream<InputChannelEvent>
    let diagnosticsUpdates: AsyncStream<DiagnosticsChannelUpdate>
    let screenshotUpdates: AsyncStream<ClientScreenshotChannelUpdate>
    private let eventContinuation: AsyncStream<InputChannelEvent>.Continuation
    private let diagnosticsContinuation: AsyncStream<DiagnosticsChannelUpdate>.Continuation
    private let lock = NSLock()
    private var storedRequests: [DiagnosticsRequest] = []

    var requests: [DiagnosticsRequest] {
        lock.withLock { storedRequests }
    }

    var configHandler: ((ClientConfig) -> Void)?
    var mediaViewerHandler: ((MediaViewerState) -> Void)?
    var runtimeCheckpointHandler: ((ClientRuntimeCheckpoint) -> Void)?
    var agentRequestHandler: ((AgentFeedRequest) -> Void)?
    var workspaceTerminalRequestHandler: ((WorkspaceTerminalClientMessage) -> Void)?
    var onClosed: (() -> Void)?
    var receiveErrorPreservationHandler: (@Sendable (Error) async -> Bool)?
    var revokeHandler: (() -> Void)?

    init() {
        var eventContinuation: AsyncStream<InputChannelEvent>.Continuation!
        var diagnosticsContinuation: AsyncStream<DiagnosticsChannelUpdate>.Continuation!
        events = AsyncStream { eventContinuation = $0 }
        diagnosticsUpdates = AsyncStream { diagnosticsContinuation = $0 }
        screenshotUpdates = AsyncStream { _ in }
        self.eventContinuation = eventContinuation
        self.diagnosticsContinuation = diagnosticsContinuation
    }

    func yield(_ update: DiagnosticsChannelUpdate) {
        diagnosticsContinuation.yield(update)
    }

    func finishDiagnostics() {
        diagnosticsContinuation.finish()
    }

    func close() {
        eventContinuation.finish()
        diagnosticsContinuation.finish()
    }

    func pushDesktopState(_ state: DesktopState) {}
    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow]) {}
    func pushAgentSay(_ push: AgentSayPush) {}
    func pushCursor(_ push: CursorImagePush) {}
    func pushCursorApplied(_ push: CursorAppliedPush) {}
    func pushHostCursorMoved(displayId: String?, cursorX: Float, cursorY: Float) {}
    func pushHostAvailability(_ push: HostAvailabilityPush) {}
    func pushTextInputFocus(_ push: HostTextInputFocusPush) {}
    func pushDiagnosticsRequest(_ request: DiagnosticsRequest) {
        lock.withLock {
            storedRequests.append(request)
        }
    }
    func pushScreenshotRequest(_ request: ClientScreenshotRequest) {}
    func pushAgentData(_ data: Data) {}
}
