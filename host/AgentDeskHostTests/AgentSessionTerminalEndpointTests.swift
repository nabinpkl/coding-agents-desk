import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct AgentSessionTerminalEndpointTests {
    private let context = AgentResumeTerminalContext(
        projectPath: "/Users/dev/project",
        source: "claude",
        harnessSessionID: "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
    )

    @Test func remoteOpenRoutesThroughIOSCoordinatorAndPushesReady() async throws {
        let coordinator = RecordingTerminalCoordinator()
        let pushes = TerminalPushRecorder()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8,
            push: { message in await pushes.append(message) }
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)

        await endpoint.handle(.open(open))

        let requests = await coordinator.openRequests
        let request = try #require(requests.first)
        #expect(request.requestID == "ios-device-a:request-1")
        #expect(request.platform == .iOS)
        #expect(request.context == AgentSessionTerminalContext(
            projectPath: context.projectPath,
            source: context.source,
            harnessSessionID: context.harnessSessionID
        ))
        #expect(await pushes.messages == [
            .ready(AgentTerminalReady(
                requestID: open.requestID,
                context: context,
                ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
            )),
        ])
    }

    @Test func localOpenUsesMacOSAndReturnsWithoutPushTransport() async throws {
        let coordinator = RecordingTerminalCoordinator()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .macOS,
            requestNamespace: "macos-local",
            tombstoneLimit: 8
        )
        let open = AgentTerminalOpen(requestID: "local-1", context: context)

        let response = await endpoint.openLocal(open)

        #expect(await coordinator.openRequests.first?.platform == .macOS)
        #expect(response == .ready(AgentTerminalReady(
            requestID: open.requestID,
            context: context,
            ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
        )))
    }

    @Test func staleRequestIDWithDifferentContextReturnsTypedErrorWithoutSecondOpen() async throws {
        let coordinator = RecordingTerminalCoordinator()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8
        )
        let first = AgentTerminalOpen(requestID: "collision", context: context)
        _ = await endpoint.openLocal(first)
        let changed = AgentResumeTerminalContext(
            projectPath: context.projectPath,
            source: "codex",
            harnessSessionID: "5315800f-fab6-42ed-a80f-a622f563b57a"
        )

        let response = await endpoint.openLocal(AgentTerminalOpen(
            requestID: first.requestID,
            context: changed
        ))

        #expect(await coordinator.openRequests.count == 1)
        #expect(response == .error(AgentTerminalError(
            requestID: first.requestID,
            context: changed,
            ptySessionName: nil,
            code: .sessionEnded
        )))
    }

    @Test func duplicateCloseIsIdempotentAndStaleAckIsIgnored() async throws {
        let coordinator = RecordingTerminalCoordinator()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)
        guard case .ready(let ready) = await endpoint.openLocal(open) else {
            Issue.record("Expected ready response")
            return
        }
        let wrongContext = AgentResumeTerminalContext(
            projectPath: context.projectPath,
            source: "codex",
            harnessSessionID: context.harnessSessionID
        )
        await endpoint.handle(.attached(AgentTerminalAttachedAck(
            requestID: open.requestID,
            context: wrongContext,
            ptySessionName: ready.ptySessionName
        )))
        let close = AgentTerminalClose(
            requestID: open.requestID,
            context: context,
            ptySessionName: ready.ptySessionName,
            reason: "user-close"
        )

        await endpoint.handle(.close(close))
        await endpoint.handle(.close(close))

        #expect(await coordinator.acknowledgements.isEmpty)
        #expect(await coordinator.closeRequests.count == 1)
        #expect(await endpoint.stateSnapshot() == AgentSessionTerminalEndpointStateSnapshot(
            activeRequestCount: 0,
            tombstoneRequestIDs: [open.requestID]
        ))
    }

    @Test func closeDuringOpenSuppressesLateReady() async throws {
        let coordinator = RecordingTerminalCoordinator(suspendOpen: true)
        let pushes = TerminalPushRecorder()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8,
            push: { message in await pushes.append(message) }
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)
        let openTask = Task { await endpoint.handle(.open(open)) }
        try await waitUntil { await coordinator.openRequests.count == 1 }

        await endpoint.handle(.close(AgentTerminalClose(
            requestID: open.requestID,
            context: context,
            ptySessionName: nil,
            reason: "context-changed"
        )))
        await coordinator.resumeOpen()
        await openTask.value

        #expect(await pushes.messages.isEmpty)
        #expect(await coordinator.closeRequests.count == 1)
    }

    @Test func coordinatorErrorsMapToStableWireCodes() async {
        let coordinator = RecordingTerminalCoordinator(openError: .activeElsewhere)
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)

        let response = await endpoint.openLocal(open)

        #expect(response == .error(AgentTerminalError(
            requestID: open.requestID,
            context: context,
            ptySessionName: nil,
            code: .activeElsewhere
        )))
        #expect(await endpoint.stateSnapshot() == AgentSessionTerminalEndpointStateSnapshot(
            activeRequestCount: 0,
            tombstoneRequestIDs: [open.requestID]
        ))
    }

    @Test func handoffTimeoutPushesTypedErrorOnce() async throws {
        let coordinator = RecordingTerminalCoordinator()
        let pushes = TerminalPushRecorder()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8,
            push: { message in await pushes.append(message) }
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)
        guard case .ready(let wireReady) = await endpoint.openLocal(open),
              let coordinatorRequest = await coordinator.openRequests.first else {
            Issue.record("Expected ready response")
            return
        }
        let identity = try AgentResumeTerminalIdentity(
            source: coordinatorRequest.context.source,
            harnessSessionID: coordinatorRequest.context.harnessSessionID,
            projectDirectoryPath: coordinatorRequest.context.projectPath,
            homeDirectory: URL(fileURLWithPath: "/Users/dev", isDirectory: true),
            fileManager: PermissiveDirectoryFileManager()
        )
        let event = AgentSessionTerminalCoordinatorEvent.handoffTimedOut(
            requestID: coordinatorRequest.requestID,
            ready: AgentSessionTerminalReady(
                requestID: coordinatorRequest.requestID,
                identity: identity,
                pid: 7001
            )
        )

        await endpoint.handleCoordinatorEvent(event)
        await endpoint.handleCoordinatorEvent(event)

        #expect(await pushes.messages == [
            .error(AgentTerminalError(
                requestID: open.requestID,
                context: context,
                ptySessionName: wireReady.ptySessionName,
                code: .handoffTimedOut
            )),
        ])
        #expect(await endpoint.stateSnapshot().activeRequestCount == 0)
    }

    @Test func handoffTimeoutBeforeOpenReturnsSuppressesLateReady() async throws {
        let coordinator = RecordingTerminalCoordinator(suspendOpen: true)
        let pushes = TerminalPushRecorder()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8,
            push: { message in await pushes.append(message) }
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)
        let openTask = Task { await endpoint.handle(.open(open)) }
        try await waitUntil { await coordinator.openRequests.count == 1 }
        let identity = try AgentResumeTerminalIdentity(
            source: context.source,
            harnessSessionID: context.harnessSessionID,
            projectDirectoryPath: context.projectPath,
            homeDirectory: URL(fileURLWithPath: "/Users/dev", isDirectory: true),
            fileManager: PermissiveDirectoryFileManager()
        )

        await endpoint.handleCoordinatorEvent(.handoffTimedOut(
            requestID: "ios-device-a:\(open.requestID)",
            ready: AgentSessionTerminalReady(
                requestID: "ios-device-a:\(open.requestID)",
                identity: identity,
                pid: 7001
            )
        ))
        await coordinator.resumeOpen()
        await openTask.value

        #expect(await pushes.messages == [
            .error(AgentTerminalError(
                requestID: open.requestID,
                context: context,
                ptySessionName: identity.ptySessionName,
                code: .handoffTimedOut
            )),
        ])
    }

    @Test func naturalEndPushesEndedOnceForExactBinding() async {
        let coordinator = RecordingTerminalCoordinator()
        let pushes = TerminalPushRecorder()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8,
            push: { message in await pushes.append(message) }
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)
        guard case .ready(let ready) = await endpoint.openLocal(open) else {
            Issue.record("Expected ready response")
            return
        }

        await endpoint.terminalEnded(
            requestID: open.requestID,
            context: context,
            ptySessionName: ready.ptySessionName,
            exitStatus: 9
        )
        await endpoint.terminalEnded(
            requestID: open.requestID,
            context: context,
            ptySessionName: ready.ptySessionName,
            exitStatus: 9
        )

        #expect(await pushes.messages == [
            .ended(AgentTerminalEnded(
                requestID: open.requestID,
                context: context,
                ptySessionName: ready.ptySessionName,
                exitStatus: 9
            )),
        ])
        #expect(await endpoint.stateSnapshot().activeRequestCount == 0)
    }

    @Test func staleLaneUnbindCannotClearNewPushBinding() async {
        let coordinator = RecordingTerminalCoordinator()
        let oldPushes = TerminalPushRecorder()
        let newPushes = TerminalPushRecorder()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 8
        )
        await endpoint.bindPush(id: "old-lane") { message in
            await oldPushes.append(message)
        }
        await endpoint.bindPush(id: "new-lane") { message in
            await newPushes.append(message)
        }

        await endpoint.unbindPush(id: "old-lane")
        await endpoint.handle(.open(AgentTerminalOpen(
            requestID: "request-1",
            context: context
        )))

        #expect(await oldPushes.messages.isEmpty)
        #expect(await newPushes.messages.count == 1)
    }

    @Test func tombstonesAreBoundedFIFOAndRetainOnlyRequestIDs() async throws {
        let coordinator = RecordingTerminalCoordinator()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 2
        )

        for requestID in ["request-1", "request-2", "request-3"] {
            let open = AgentTerminalOpen(requestID: requestID, context: context)
            guard case .ready(let ready) = await endpoint.openLocal(open) else {
                Issue.record("Expected ready response for \(requestID)")
                return
            }
            await endpoint.handle(.close(AgentTerminalClose(
                requestID: requestID,
                context: context,
                ptySessionName: ready.ptySessionName,
                reason: "test-close"
            )))
        }

        #expect(await endpoint.stateSnapshot() == AgentSessionTerminalEndpointStateSnapshot(
            activeRequestCount: 0,
            tombstoneRequestIDs: ["request-2", "request-3"]
        ))

        let evictedOpen = AgentTerminalOpen(requestID: "request-1", context: context)
        #expect(await endpoint.openLocal(evictedOpen) != nil)
        #expect(await coordinator.openRequests.count == 4)
    }

    @Test func tombstonedRequestRejectsChangedContextWithoutRetainingProjectPath() async throws {
        let coordinator = RecordingTerminalCoordinator()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 2
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)
        guard case .ready(let ready) = await endpoint.openLocal(open) else {
            Issue.record("Expected ready response")
            return
        }
        await endpoint.handle(.close(AgentTerminalClose(
            requestID: open.requestID,
            context: context,
            ptySessionName: ready.ptySessionName,
            reason: "test-close"
        )))
        let changedContext = AgentResumeTerminalContext(
            projectPath: "/Users/dev/private-project-that-must-not-be-retained",
            source: "codex",
            harnessSessionID: "5315800f-fab6-42ed-a80f-a622f563b57a"
        )

        let response = await endpoint.openLocal(AgentTerminalOpen(
            requestID: open.requestID,
            context: changedContext
        ))

        #expect(response == .error(AgentTerminalError(
            requestID: open.requestID,
            context: changedContext,
            ptySessionName: nil,
            code: .sessionEnded
        )))
        #expect(await coordinator.openRequests.count == 1)
        #expect(await endpoint.stateSnapshot() == AgentSessionTerminalEndpointStateSnapshot(
            activeRequestCount: 0,
            tombstoneRequestIDs: [open.requestID]
        ))
    }

    @Test func shutdownClosesActiveRequestsAndClearsEndpointState() async {
        let coordinator = RecordingTerminalCoordinator()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .iOS,
            requestNamespace: "ios-device-a",
            tombstoneLimit: 2
        )
        let open = AgentTerminalOpen(requestID: "request-1", context: context)
        _ = await endpoint.openLocal(open)

        await endpoint.shutdown()

        #expect(await coordinator.closeRequests.count == 1)
        #expect(await endpoint.stateSnapshot() == AgentSessionTerminalEndpointStateSnapshot(
            activeRequestCount: 0,
            tombstoneRequestIDs: []
        ))
        #expect(await endpoint.openLocal(AgentTerminalOpen(
            requestID: "request-after-shutdown",
            context: context
        )) == .error(AgentTerminalError(
            requestID: "request-after-shutdown",
            context: context,
            ptySessionName: nil,
            code: .sessionEnded
        )))
        #expect(await coordinator.openRequests.count == 1)
    }

    private func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Timed out waiting for condition")
    }
}

private actor TerminalPushRecorder {
    private(set) var messages: [AgentTerminalHostMessage] = []

    func append(_ message: AgentTerminalHostMessage) {
        messages.append(message)
    }
}

private actor RecordingTerminalCoordinator: AgentSessionTerminalCoordinating {
    private let suspendOpen: Bool
    private let openError: AgentSessionTerminalCoordinatorError?
    private var openContinuation: CheckedContinuation<Void, Never>?
    private(set) var openRequests: [AgentSessionTerminalOpenRequest] = []
    private(set) var acknowledgements: [(String, String)] = []
    private(set) var closeRequests: [(String, String?)] = []

    init(
        suspendOpen: Bool = false,
        openError: AgentSessionTerminalCoordinatorError? = nil
    ) {
        self.suspendOpen = suspendOpen
        self.openError = openError
    }

    func open(_ request: AgentSessionTerminalOpenRequest) async throws -> AgentSessionTerminalReady {
        openRequests.append(request)
        if suspendOpen {
            await withCheckedContinuation { continuation in
                openContinuation = continuation
            }
        }
        if let openError { throw openError }
        let identity = try AgentResumeTerminalIdentity(
            source: request.context.source,
            harnessSessionID: request.context.harnessSessionID,
            projectDirectoryPath: request.context.projectPath,
            homeDirectory: URL(fileURLWithPath: "/Users/dev", isDirectory: true),
            fileManager: PermissiveDirectoryFileManager()
        )
        return AgentSessionTerminalReady(requestID: request.requestID, identity: identity, pid: 7001)
    }

    func acknowledgeAttachment(requestID: String, ptySessionName: String) async {
        acknowledgements.append((requestID, ptySessionName))
    }

    func close(requestID: String, ptySessionName: String?) async {
        closeRequests.append((requestID, ptySessionName))
    }

    func resumeOpen() {
        openContinuation?.resume()
        openContinuation = nil
    }
}

private final class PermissiveDirectoryFileManager: FileManager, @unchecked Sendable {
    override func fileExists(atPath path: String, isDirectory: UnsafeMutablePointer<ObjCBool>?) -> Bool {
        isDirectory?.pointee = true
        return true
    }
}
