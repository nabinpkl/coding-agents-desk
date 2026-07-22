import Foundation
import PtyClientSwift
import PtyTerminalSession
import XCTest

@MainActor
final class PtyTerminalSessionDriverTests: XCTestCase {
    func testRejectsCheckpointOutsideOperationalBounds() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        var failures: [PtyTerminalSynchronizationError] = []
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: renderer,
            onError: { error in
                if let synchronization = error as? PtyTerminalSynchronizationError {
                    failures.append(synchronization)
                }
            }
        )
        driver.start()

        connection.yield(.checkpointBegan(.init(
            checkpointID: 1,
            revision: 1,
            columns: 513,
            rows: 24,
            totalBytes: 1,
            chunkCount: 1,
            historyTruncated: false
        )))

        try await waitUntil { failures.count == 1 && connection.checkpointRequests == [0] }
        XCTAssertEqual(failures, [.invalidCheckpoint("invalid checkpoint header")])
        driver.stop()
    }

    func testOutputAndExitEventsFeedRendererInOrder() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.start()
        connection.yieldCheckpoint(revision: 1)
        connection.yield(.output(data: Data("hello".utf8), revision: 2))
        connection.yield(.exited(7))
        connection.finishEvents()

        try await waitUntil {
            renderer.outputs == [Data("hello".utf8)]
                && renderer.statuses == ["\r\n[session exited: 7]\r\n"]
                && connection.eventStreamTerminationCount == 1
        }
    }

    func testNaturalExitReportsTerminationExactlyOnceWithStatus() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        var terminations: [PtyTerminalSessionTermination] = []
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: renderer,
            onTermination: { terminations.append($0) }
        )

        driver.start()
        connection.yield(.exited(7))
        connection.yield(.exited(9))
        connection.finishEvents()

        try await waitUntil {
            terminations == [.exited(status: 7)]
                && renderer.statuses == [
                    "\r\n[session exited: 7]\r\n",
                    "\r\n[session exited: 9]\r\n",
                ]
                && connection.eventStreamTerminationCount == 1
        }
        XCTAssertEqual(terminations, [.exited(status: 7)])
        XCTAssertEqual(connection.detachCount, 0)
    }

    func testInputClaimsBeforeForwardingAndViewerStateFollows() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.sendInput(
            Data("ls\n".utf8),
            viewerDimensions: .init(columns: 100, rows: 30)
        )
        driver.updateViewerState(
            active: true,
            claim: false,
            dimensions: .init(columns: 132, rows: 43)
        )

        try await waitUntil {
            connection.sentInputs == [Data("ls\n".utf8)]
                && connection.viewerStates == [
                    .init(sequence: 1, active: true, claim: true, columns: 100, rows: 30),
                    .init(sequence: 2, active: true, claim: false, columns: 132, rows: 43),
                ]
        }
    }

    func testViewportStatusReachesRenderer() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)
        let status = PtyTerminalViewportStatus(
            ownershipEpoch: 3,
            ownerClientID: 12,
            ownerTitle: "iPhone Terminal",
            isOwner: true,
            sourceDimensions: .init(columns: 62, rows: 28),
            sourceRevision: 9,
            viewDimensions: .init(columns: 62, rows: 28)
        )

        driver.start()
        connection.yield(.viewportStatus(status))

        try await waitUntil { renderer.viewportStatuses == [status] }
        driver.stop()
    }

    func testDetachCancelsAndDetachesConnection() async throws {
        let delivery = GatedPtyEventDelivery(.exited(7))
        let connection = GatedPtyTerminalConnection(delivery: delivery)
        let renderer = FakePtyTerminalRenderer()
        var terminations: [PtyTerminalSessionTermination] = []
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: renderer,
            onTermination: { terminations.append($0) }
        )
        defer {
            driver.stop()
            delivery.cleanup()
        }

        driver.start()
        try await waitUntil { delivery.isBlocked }
        driver.detach()
        delivery.release()

        try await waitUntil {
            connection.detachCount == 1 && delivery.didTerminate
        }
        XCTAssertTrue(terminations.isEmpty)
        XCTAssertTrue(renderer.statuses.isEmpty)
    }

    func testStopCancelsWithoutDetachingConnection() async throws {
        let delivery = GatedPtyEventDelivery(.exited(7))
        let connection = GatedPtyTerminalConnection(delivery: delivery)
        let renderer = FakePtyTerminalRenderer()
        var terminations: [PtyTerminalSessionTermination] = []
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: renderer,
            onTermination: { terminations.append($0) }
        )
        defer {
            driver.stop()
            delivery.cleanup()
        }

        driver.start()
        try await waitUntil { delivery.isBlocked }
        driver.stop()
        delivery.release()

        try await waitUntil { delivery.didTerminate }
        XCTAssertEqual(connection.detachCount, 0)
        XCTAssertTrue(terminations.isEmpty)
        XCTAssertTrue(renderer.statuses.isEmpty)
    }

    func testGatedEventCleanupBeforeRegistrationTerminatesWithoutDelivery() async throws {
        let delivery = GatedPtyEventDelivery(.exited(7))

        delivery.cleanup()
        var events: [PtySessionEvent] = []
        for try await event in delivery.stream() {
            events.append(event)
        }
        delivery.release()

        try await waitUntil { delivery.didTerminate }
        XCTAssertTrue(events.isEmpty)
        XCTAssertFalse(delivery.isBlocked)
    }

    func testManagerDetachClosesRenderer() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        var terminations: [PtyTerminalSessionTermination] = []
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: renderer,
            onTermination: { terminations.append($0) }
        )

        driver.start()
        connection.yield(.detachedByManager(42))
        connection.finishEvents()

        try await waitUntil {
            renderer.managerDetachCloseCount == 1
                && connection.eventStreamTerminationCount == 1
        }
        XCTAssertTrue(terminations.isEmpty)
    }

    func testRevisionGapStopsOutputAndRequestsOneReplacementCheckpoint() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.start()
        connection.yieldCheckpoint(revision: 4)
        connection.yield(.output(data: Data("skipped".utf8), revision: 6))
        connection.yield(.output(data: Data("also skipped".utf8), revision: 7))

        try await waitUntil { connection.checkpointRequests == [4] }
        XCTAssertTrue(renderer.outputs.isEmpty)
        XCTAssertEqual(renderer.statuses, ["\r\n[terminal synchronizing]\r\n"])
        driver.stop()
    }

    func testReplacementCheckpointRestoresConsecutiveOutput() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.start()
        connection.yieldCheckpoint(revision: 1)
        connection.yield(.output(data: Data("gap".utf8), revision: 3))
        try await waitUntil { connection.checkpointRequests == [1] }
        connection.yieldCheckpoint(revision: 3)
        connection.yield(.output(data: Data("live".utf8), revision: 4))

        try await waitUntil { renderer.outputs == [Data("live".utf8)] }
        XCTAssertEqual(renderer.checkpointEnds.map(\.revision), [1, 3])
        driver.stop()
    }

    func testCheckpointCannotMoveAppliedRevisionBackwards() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        var failures: [PtyTerminalSynchronizationError] = []
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: renderer,
            onError: { error in
                if let synchronization = error as? PtyTerminalSynchronizationError {
                    failures.append(synchronization)
                }
            }
        )

        driver.start()
        connection.yieldCheckpoint(revision: 5)
        connection.yieldCheckpoint(revision: 4)

        try await waitUntil { failures.count == 1 && connection.checkpointRequests == [5] }
        XCTAssertEqual(failures, [.invalidCheckpoint("invalid checkpoint header")])
        XCTAssertEqual(renderer.checkpointEnds.map(\.revision), [5])
        driver.stop()
    }

    private func waitUntil(
        timeoutNanoseconds: UInt64 = 1_000_000_000,
        condition: @MainActor @escaping () -> Bool
    ) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        while DispatchTime.now().uptimeNanoseconds < deadline {
            if condition() {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition())
    }
}

private final class FakePtyTerminalRenderer: PtyTerminalRenderer {
    var outputs: [Data] = []
    var statuses: [String] = []
    var managerDetachCloseCount = 0

    var checkpointBegins: [PtyTerminalCheckpoint] = []
    var checkpointChunks: [Data] = []
    var checkpointEnds: [PtyTerminalCheckpoint] = []
    var viewportStatuses: [PtyTerminalViewportStatus] = []

    func beginCheckpoint(_ checkpoint: PtyTerminalCheckpoint) {
        checkpointBegins.append(checkpoint)
    }

    func feedCheckpointChunk(_ data: Data) {
        checkpointChunks.append(data)
    }

    func endCheckpoint(_ checkpoint: PtyTerminalCheckpoint) {
        checkpointEnds.append(checkpoint)
    }

    func feedOutput(_ data: Data, revision: UInt64) {
        outputs.append(data)
    }

    func updateViewportStatus(_ status: PtyTerminalViewportStatus) {
        viewportStatuses.append(status)
    }

    func feedStatus(_ text: String) {
        statuses.append(text)
    }

    func closeAfterManagerDetach() {
        managerDetachCloseCount += 1
    }
}

private final class FakePtyTerminalConnection: PtyTerminalConnection, @unchecked Sendable {
    struct ViewerState: Equatable {
        let sequence: UInt64
        let active: Bool
        let claim: Bool
        let columns: UInt32
        let rows: UInt32
    }

    private let lock = NSLock()
    private let stream: AsyncThrowingStream<PtySessionEvent, Error>
    private let continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation
    private var inputsStorage: [Data] = []
    private var viewerStatesStorage: [ViewerState] = []
    private var detachCountStorage = 0
    private var checkpointRequestsStorage: [UInt64] = []
    private var eventStreamTerminationCountStorage = 0

    init() {
        let pair = AsyncThrowingStream<PtySessionEvent, Error>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
        continuation.onTermination = { [weak self] _ in
            self?.lock.withLock {
                self?.eventStreamTerminationCountStorage += 1
            }
        }
    }

    var sentInputs: [Data] {
        lock.withLock { inputsStorage }
    }

    var viewerStates: [ViewerState] {
        lock.withLock { viewerStatesStorage }
    }

    var detachCount: Int {
        lock.withLock { detachCountStorage }
    }

    var checkpointRequests: [UInt64] {
        lock.withLock { checkpointRequestsStorage }
    }

    var eventStreamTerminationCount: Int {
        lock.withLock { eventStreamTerminationCountStorage }
    }

    func yield(_ event: PtySessionEvent) {
        continuation.yield(event)
    }

    func yieldCheckpoint(revision: UInt64, data: Data = Data([0x1b, 0x63])) {
        let checkpoint = PtyTerminalCheckpoint(
            checkpointID: revision,
            revision: revision,
            columns: 80,
            rows: 24,
            totalBytes: UInt64(data.count),
            chunkCount: 1,
            historyTruncated: false
        )
        yield(.checkpointBegan(checkpoint))
        yield(.checkpointChunk(checkpointID: checkpoint.checkpointID, index: 0, data: data))
        yield(.checkpointEnded(checkpointID: checkpoint.checkpointID, revision: revision))
    }

    func finishEvents() {
        continuation.finish()
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        stream
    }

    func sendInput(_ data: Data) async throws {
        lock.withLock {
            inputsStorage.append(data)
        }
    }

    func updateViewerState(
        sequence: UInt64,
        active: Bool,
        claim: Bool,
        columns: UInt32,
        rows: UInt32
    ) async throws {
        lock.withLock {
            viewerStatesStorage.append(.init(
                sequence: sequence,
                active: active,
                claim: claim,
                columns: columns,
                rows: rows
            ))
        }
    }

    func requestCheckpoint(lastAppliedRevision: UInt64) async throws {
        lock.withLock { checkpointRequestsStorage.append(lastAppliedRevision) }
    }

    func detach() async throws {
        lock.withLock {
            detachCountStorage += 1
        }
    }
}

private final class GatedPtyTerminalConnection: PtyTerminalConnection, @unchecked Sendable {
    private let lock = NSLock()
    private let delivery: GatedPtyEventDelivery
    private var detachCountStorage = 0

    init(delivery: GatedPtyEventDelivery) {
        self.delivery = delivery
    }

    var detachCount: Int {
        lock.withLock { detachCountStorage }
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        delivery.stream()
    }

    func sendInput(_ data: Data) async throws {}

    func updateViewerState(
        sequence: UInt64,
        active: Bool,
        claim: Bool,
        columns: UInt32,
        rows: UInt32
    ) async throws {}

    func detach() async throws {
        lock.withLock {
            detachCountStorage += 1
        }
    }
}

private final class GatedPtyEventDelivery: @unchecked Sendable {
    private let lock = NSLock()
    private let event: PtySessionEvent
    private var continuation: CheckedContinuation<PtySessionEvent?, Never>?
    private var didRequestStorage = false
    private var didDeliverStorage = false
    private var didTerminateStorage = false
    private var isCleanedUpStorage = false

    init(_ event: PtySessionEvent) {
        self.event = event
    }

    var isBlocked: Bool {
        lock.withLock { didRequestStorage && continuation != nil }
    }

    var didTerminate: Bool {
        lock.withLock { didTerminateStorage }
    }

    func stream() -> AsyncThrowingStream<PtySessionEvent, Error> {
        let lifetime = GatedPtyStreamLifetime { [weak self] in
            self?.markTerminated()
        }
        return AsyncThrowingStream(unfolding: { [weak self, lifetime] in
            _ = lifetime
            guard let self else { return nil }
            return await self.nextEvent()
        })
    }

    func release() {
        let result: (
            continuation: CheckedContinuation<PtySessionEvent?, Never>?,
            isCleanedUp: Bool
        ) = lock.withLock {
            guard !isCleanedUpStorage else { return (nil, true) }
            let continuation = self.continuation
            self.continuation = nil
            return (continuation, false)
        }
        guard !result.isCleanedUp else { return }
        precondition(result.continuation != nil, "delivery must be blocked before release")
        result.continuation?.resume(returning: event)
    }

    func cleanup() {
        let continuation: CheckedContinuation<PtySessionEvent?, Never>? = lock.withLock {
            guard !isCleanedUpStorage else { return nil }
            isCleanedUpStorage = true
            let continuation = self.continuation
            self.continuation = nil
            return continuation
        }
        continuation?.resume(returning: nil)
    }

    private func nextEvent() async -> PtySessionEvent? {
        return await withCheckedContinuation { continuation in
            let completesImmediately = lock.withLock {
                guard !isCleanedUpStorage, !didDeliverStorage else { return true }
                didRequestStorage = true
                didDeliverStorage = true
                self.continuation = continuation
                return false
            }
            if completesImmediately {
                continuation.resume(returning: nil)
            }
        }
    }

    private func markTerminated() {
        lock.withLock {
            didTerminateStorage = true
        }
    }
}

private final class GatedPtyStreamLifetime: @unchecked Sendable {
    private let onDeinit: @Sendable () -> Void

    init(onDeinit: @escaping @Sendable () -> Void) {
        self.onDeinit = onDeinit
    }

    deinit {
        onDeinit()
    }
}
