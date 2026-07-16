import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

@MainActor
struct HostTextInputFocusProbeCoordinatorTests {
    @Test func postClickArrowSendsNonEditableWithoutQueryingAX() async throws {
        let server = RecordingInputChannelServer()
        var queryCount = 0
        let resolver = HostTextInputFocusResolver(query: {
            queryCount += 1
            return HostTextInputFocusPush(
                editability: .editable,
                secure: false,
                source: .accessibility,
                role: "AXTextArea"
            )
        })
        let coordinator = HostTextInputFocusProbeCoordinator(
            resolver: resolver,
            cursorKindSampler: { .arrow },
            initialDelayNs: 0,
            settleDelayNs: 0
        )

        coordinator.schedule(for: DeviceFingerprint("device-a"), server: server)
        await Task.yield()
        await Task.yield()

        #expect(queryCount == 0)
        #expect(server.textInputFocusPushes == [
            HostTextInputFocusPush(
                editability: .nonEditable,
                secure: false,
                source: .none,
                cursorKind: .arrow
            )
        ])
    }

    @Test func postClickIBeamRunsAXResolver() async throws {
        let server = RecordingInputChannelServer()
        var queryCount = 0
        let resolver = HostTextInputFocusResolver(query: {
            queryCount += 1
            return HostTextInputFocusPush(
                editability: .editable,
                secure: false,
                source: .accessibility,
                role: "AXTextArea"
            )
        })
        let coordinator = HostTextInputFocusProbeCoordinator(
            resolver: resolver,
            cursorKindSampler: { .ibeam },
            initialDelayNs: 0,
            settleDelayNs: 0
        )

        coordinator.schedule(for: DeviceFingerprint("device-a"), server: server)
        await Task.yield()
        await Task.yield()

        #expect(queryCount == 1)
        #expect(server.textInputFocusPushes == [
            HostTextInputFocusPush(
                editability: .editable,
                secure: false,
                source: .accessibility,
                role: "AXTextArea",
                cursorKind: .ibeam
            )
        ])
    }

    @Test func ambiguousIBeamResultUsesCursorTapHeuristicSource() async throws {
        let server = RecordingInputChannelServer()
        let resolver = HostTextInputFocusResolver(query: {
            HostTextInputFocusPush(
                editability: .ambiguous,
                secure: false,
                source: .accessibility,
                role: "AXGroup"
            )
        })
        let coordinator = HostTextInputFocusProbeCoordinator(
            resolver: resolver,
            cursorKindSampler: { .ibeam },
            initialDelayNs: 0,
            settleDelayNs: 0
        )

        coordinator.schedule(for: DeviceFingerprint("device-a"), server: server)
        await Task.yield()
        await Task.yield()

        #expect(server.textInputFocusPushes == [
            HostTextInputFocusPush(
                editability: .ambiguous,
                secure: false,
                source: .cursorTapHeuristic,
                role: "AXGroup",
                cursorKind: .ibeam
            )
        ])
    }

    @Test func repeatedClicksCoalesceToLatestProbe() async throws {
        let server = RecordingInputChannelServer()
        let cursorKinds = CursorKindSequence([.arrow])
        let resolver = HostTextInputFocusResolver(query: {
            HostTextInputFocusPush(
                editability: .editable,
                secure: false,
                source: .accessibility,
                role: "AXTextArea"
            )
        })
        let coordinator = HostTextInputFocusProbeCoordinator(
            resolver: resolver,
            cursorKindSampler: { cursorKinds.next() },
            initialDelayNs: 10_000_000,
            settleDelayNs: 0
        )
        let fingerprint = DeviceFingerprint("device-a")

        coordinator.schedule(for: fingerprint, server: server)
        coordinator.schedule(for: fingerprint, server: server)
        try await Task.sleep(nanoseconds: 25_000_000)

        #expect(server.textInputFocusPushes == [
            HostTextInputFocusPush(
                editability: .nonEditable,
                secure: false,
                source: .none,
                cursorKind: .arrow
            )
        ])
    }

    @Test func cancelledOlderProbeDoesNotClearNewerProbeSlot() async throws {
        let server = RecordingInputChannelServer()
        let resolver = HostTextInputFocusResolver(query: {
            HostTextInputFocusPush(
                editability: .editable,
                secure: false,
                source: .accessibility,
                role: "AXTextArea"
            )
        })
        let coordinator = HostTextInputFocusProbeCoordinator(
            resolver: resolver,
            cursorKindSampler: { .arrow },
            initialDelayNs: 100_000_000,
            settleDelayNs: 0
        )
        let fingerprint = DeviceFingerprint("device-a")

        coordinator.schedule(for: fingerprint, server: server)
        try await Task.sleep(nanoseconds: 5_000_000)
        coordinator.schedule(for: fingerprint, server: server)
        try await Task.sleep(nanoseconds: 20_000_000)
        coordinator.cancel(for: fingerprint)
        try await Task.sleep(nanoseconds: 120_000_000)

        #expect(server.textInputFocusPushes.isEmpty)
    }
}

private final class RecordingInputChannelServer: InputChannelServing, @unchecked Sendable {
    let events: AsyncStream<InputChannelEvent>
    let diagnosticsUpdates: AsyncStream<DiagnosticsChannelUpdate>
    var configHandler: ((ClientConfig) -> Void)?
    var agentRequestHandler: ((AgentFeedRequest) -> Void)?
    var onClosed: (() -> Void)?
    var receiveErrorPreservationHandler: (@Sendable (Error) async -> Bool)?
    var revokeHandler: (() -> Void)?
    private(set) var textInputFocusPushes: [HostTextInputFocusPush] = []

    init() {
        events = AsyncStream { continuation in
            continuation.finish()
        }
        diagnosticsUpdates = AsyncStream { continuation in
            continuation.finish()
        }
    }

    func close() {}
    func pushDesktopState(_ state: DesktopState) {}
    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow]) {}
    func pushAgentSay(_ push: AgentSayPush) {}
    func pushCursor(_ push: CursorImagePush) {}
    func pushCursorApplied(_ push: CursorAppliedPush) {}
    func pushHostCursorMoved(displayId: String?, cursorX: Float, cursorY: Float) {}
    func pushHostAvailability(_ push: HostAvailabilityPush) {}
    func pushTextInputFocus(_ push: HostTextInputFocusPush) {
        textInputFocusPushes.append(push)
    }
    func pushDiagnosticsRequest(_ request: DiagnosticsRequest) {}
    func pushAgentData(_ data: Data) {}
}

private final class CursorKindSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [CursorKind]

    init(_ values: [CursorKind]) {
        self.values = values
    }

    func next() -> CursorKind {
        lock.lock()
        defer { lock.unlock() }
        guard !values.isEmpty else { return .unknown }
        return values.removeFirst()
    }
}
