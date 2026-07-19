import Foundation
import PtyClientSwift
import PtyTerminalSession
@testable import PtyTerminalSwiftTerm
import SwiftTerm
import XCTest
#if canImport(AppKit)
import AppKit
#endif

@MainActor
final class PtyTerminalSwiftTermContentViewTests: XCTestCase {
    func testInputAndResizeForwardToBoundConnection() async throws {
        let connection = FakeContentConnection()
        let content = PtyTerminalSwiftTermContentView()
        content.bind(to: connection)

        content.send(source: content.terminalView, data: Array("echo hi\n".utf8)[...])
        content.sizeChanged(source: content.terminalView, newCols: 132, newRows: 43)

        try await waitUntil {
            connection.sentInputs == [Data("echo hi\n".utf8)]
                && connection.resizes == [.init(columns: 132, rows: 43)]
        }
        content.stop()
        try await waitUntil { connection.eventStreamTerminationCount == 1 }
    }

    func testOutputFeedsTerminal() async throws {
        let connection = FakeContentConnection()
        let content = PtyTerminalSwiftTermContentView()
        content.bind(to: connection)

        connection.yield(.output(Data("package output".utf8)))

        try await waitUntil {
            content.terminalView.getTerminal().getLine(row: 0)?.translateToString(trimRight: true) == "package output"
        }
        content.stop()
        try await waitUntil { connection.eventStreamTerminationCount == 1 }
    }

    func testPasteUsesTerminalBracketedPasteMode() async throws {
        let connection = FakeContentConnection()
        let content = PtyTerminalSwiftTermContentView()
        content.bind(to: connection)

        content.paste(text: "plain")
        try await waitUntil {
            connection.sentInputs.count == 1
        }
        XCTAssertEqual(connection.sentInputs[0], Data("plain".utf8))

        content.feedOutput(Data("\u{1B}[?2004h".utf8))
        content.paste(text: "wrapped")

        try await waitUntil {
            connection.sentInputs.count == 2
        }
        XCTAssertEqual(
            connection.sentInputs[1],
            Data(EscapeSequences.bracketedPasteStart + Array("wrapped".utf8) + EscapeSequences.bracketedPasteEnd)
        )
        content.stop()
        try await waitUntil { connection.eventStreamTerminationCount == 1 }
    }

    func testDetachStopsRenderingAndDetachesConnection() async throws {
        let connection = FakeContentConnection()
        let content = PtyTerminalSwiftTermContentView()
        content.bind(to: connection)

        content.detach()
        content.detach()

        try await waitUntil {
            connection.detachCount == 1
                && connection.eventStreamTerminationCount == 1
        }
        XCTAssertEqual(connection.detachCount, 1)
        connection.yield(.output(Data("after detach".utf8)))
        XCTAssertFalse(
            content.terminalView.getTerminal().getLine(row: 0)?.translateToString().contains("after detach") ?? false
        )
    }

    func testManagerDetachUnbindsAndNotifiesDelegate() async throws {
        let connection = FakeContentConnection()
        let delegate = FakeContentDelegate()
        let content = PtyTerminalSwiftTermContentView()
        content.delegate = delegate
        content.bind(to: connection)

        connection.yield(.detachedByManager(42))

        try await waitUntil {
            delegate.managerDetachCount == 1
                && connection.eventStreamTerminationCount == 1
        }
        XCTAssertFalse(content.isBound)
        XCTAssertTrue(delegate.terminations.isEmpty)
        XCTAssertEqual(connection.detachCount, 0)
    }

    func testNaturalExitNotifiesDelegateExactlyOnceWithStatus() async throws {
        let connection = FakeContentConnection()
        let delegate = FakeContentDelegate()
        let content = PtyTerminalSwiftTermContentView()
        content.delegate = delegate
        content.bind(to: connection)

        connection.yield(.exited(7))
        connection.yield(.exited(9))

        try await waitUntil {
            delegate.terminations == [.exited(status: 7)]
                && connection.eventStreamTerminationCount == 1
        }
        XCTAssertEqual(delegate.terminations, [.exited(status: 7)])
        XCTAssertFalse(content.isBound)
        XCTAssertEqual(connection.detachCount, 0)
    }

    func testExplicitStopAndDetachDoNotNotifyNaturalTermination() async throws {
        let stoppedConnection = FakeContentConnection()
        let detachedConnection = FakeContentConnection()
        let delegate = FakeContentDelegate()
        let content = PtyTerminalSwiftTermContentView()
        content.delegate = delegate

        content.bind(to: stoppedConnection)
        content.stop()
        stoppedConnection.yield(.exited(7))
        try await waitUntil { stoppedConnection.eventStreamTerminationCount == 1 }

        content.bind(to: detachedConnection)
        content.detach()
        detachedConnection.yield(.exited(9))

        try await waitUntil {
            detachedConnection.detachCount == 1
                && detachedConnection.eventStreamTerminationCount == 1
        }
        XCTAssertTrue(delegate.terminations.isEmpty)
    }

    func testRebindDuringOldExitStatusFencesOldTerminationCallback() async throws {
        let oldConnection = FakeContentConnection()
        let currentConnection = FakeContentConnection()
        let delegate = FakeContentDelegate()
        let content = PtyTerminalSwiftTermContentView()
        content.delegate = delegate

        delegate.onStatus = { _ in
            delegate.onStatus = nil
            content.stop()
            content.bind(to: currentConnection)
        }
        content.bind(to: oldConnection)
        oldConnection.yield(.exited(7))

        try await waitUntil {
            content.isBound && delegate.statuses == ["\r\n[session exited: 7]\r\n"]
        }

        currentConnection.yield(.exited(9))
        try await waitUntil {
            delegate.terminations == [.exited(status: 9)]
                && oldConnection.eventStreamTerminationCount == 1
                && currentConnection.eventStreamTerminationCount == 1
        }
        XCTAssertFalse(content.isBound)
    }

    func testStaleErrorAfterRebindCannotAffectCurrentBinding() async throws {
        let delivery = GatedContentEventDelivery(.error("stale error"))
        let inputFailure = GatedContentInputFailure()
        var oldConnection: GatedContentConnection? = GatedContentConnection(
            delivery: delivery,
            inputFailure: inputFailure
        )
        weak let releasedOldConnection = oldConnection
        let currentConnection = FakeContentConnection()
        let delegate = FakeContentDelegate()
        let content = PtyTerminalSwiftTermContentView()
        content.delegate = delegate
        defer { inputFailure.cleanup() }
        defer { delivery.cleanup() }

        content.bind(to: try XCTUnwrap(oldConnection))
        content.send(source: content.terminalView, data: Array("old input".utf8)[...])
        try await waitUntil { delivery.isBlocked && inputFailure.isBlocked }
        content.stop()
        content.bind(to: currentConnection)
        delivery.release()
        inputFailure.release()
        oldConnection = nil

        try await waitUntil {
            delivery.didTerminate
                && inputFailure.didComplete
                && releasedOldConnection == nil
        }

        currentConnection.yield(.output(Data("current after error".utf8)))
        try await waitUntil {
            content.terminalView.getTerminal().getLine(row: 0)?.translateToString(trimRight: true)
                == "current after error"
        }
        content.stop()
        try await waitUntil { currentConnection.eventStreamTerminationCount == 1 }

        XCTAssertEqual(delegate.failureCount, 0)
        XCTAssertEqual(delegate.managerDetachCount, 0)
        XCTAssertTrue(delegate.statuses.isEmpty)
        XCTAssertTrue(delegate.terminations.isEmpty)
    }

    func testStaleManagerDetachAfterRebindCannotAffectCurrentBinding() async throws {
        let delivery = GatedContentEventDelivery(.detachedByManager(42))
        let oldConnection = GatedContentConnection(delivery: delivery)
        let currentConnection = FakeContentConnection()
        let delegate = FakeContentDelegate()
        let content = PtyTerminalSwiftTermContentView()
        content.delegate = delegate
        defer { delivery.cleanup() }

        content.bind(to: oldConnection)
        try await waitUntil { delivery.isBlocked }
        content.stop()
        content.bind(to: currentConnection)
        delivery.release()

        try await waitUntil { delivery.didTerminate }

        XCTAssertTrue(content.isBound)
        XCTAssertEqual(delegate.failureCount, 0)
        XCTAssertEqual(delegate.managerDetachCount, 0)
        XCTAssertTrue(delegate.statuses.isEmpty)
        XCTAssertTrue(delegate.terminations.isEmpty)

        currentConnection.yield(.output(Data("current after detach".utf8)))
        try await waitUntil {
            content.terminalView.getTerminal().getLine(row: 0)?.translateToString(trimRight: true)
                == "current after detach"
        }
        content.stop()
        try await waitUntil { currentConnection.eventStreamTerminationCount == 1 }
    }

    func testGatedHelpersCleanupBeforeRegistrationCompletesImmediately() async throws {
        let delivery = GatedContentEventDelivery(.error("unused"))
        let inputFailure = GatedContentInputFailure()

        delivery.cleanup()
        inputFailure.cleanup()

        var events: [PtySessionEvent] = []
        for try await event in delivery.stream() {
            events.append(event)
        }
        try await inputFailure.waitAndThrow()
        delivery.release()
        inputFailure.release()

        try await waitUntil { delivery.didTerminate }
        XCTAssertTrue(events.isEmpty)
        XCTAssertFalse(delivery.isBlocked)
        XCTAssertFalse(inputFailure.isBlocked)
        XCTAssertFalse(inputFailure.didComplete)
    }

    func testReleaseCancelsEventConsumptionAndDetachesConnection() async throws {
        let connection = FakeContentConnection()
        var content: PtyTerminalSwiftTermContentView? = PtyTerminalSwiftTermContentView()
        content?.bind(to: connection)

        content = nil

        try await waitUntil {
            connection.detachCount == 1
                && connection.eventStreamTerminationCount == 1
        }
    }

    func testReleaseAfterStopDoesNotDetachConnection() async throws {
        let connection = FakeContentConnection()
        var content: PtyTerminalSwiftTermContentView? = PtyTerminalSwiftTermContentView()
        content?.bind(to: connection)

        content?.stop()
        content = nil

        try await waitUntil {
            connection.eventStreamTerminationCount == 1
        }
        XCTAssertEqual(connection.detachCount, 0)
    }

    #if canImport(AppKit)
    func testAccessibilityPressFocusesNativeTerminal() {
        let content = PtyTerminalSwiftTermContentView()
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 320))
        container.addSubview(content)
        content.frame = container.bounds
        let probe = NSButton(title: "Probe", target: nil, action: nil)
        container.addSubview(probe)
        let window = NSWindow(
            contentRect: container.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = container
        window.makeFirstResponder(probe)

        XCTAssertTrue(content.accessibilityPerformPress())
        XCTAssertTrue(window.firstResponder === content.terminalView)
    }
    #endif

    private func waitUntil(
        timeoutNanoseconds: UInt64 = 1_000_000_000,
        condition: @MainActor @escaping () -> Bool
    ) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        while DispatchTime.now().uptimeNanoseconds < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition())
    }
}

@MainActor
private final class FakeContentDelegate: PtyTerminalSwiftTermContentViewDelegate {
    private(set) var managerDetachCount = 0
    private(set) var terminations: [PtyTerminalSessionTermination] = []
    private(set) var statuses: [String] = []
    private(set) var failureCount = 0
    var onStatus: ((String) -> Void)?

    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didReceiveStatus text: String) {
        statuses.append(text)
        onStatus?(text)
    }

    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didFail error: Error) {
        failureCount += 1
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didTerminate termination: PtyTerminalSessionTermination
    ) {
        terminations.append(termination)
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        managerDetachCount += 1
    }
}

private final class FakeContentConnection: PtyTerminalConnection, @unchecked Sendable {
    struct Resize: Equatable {
        let columns: UInt32
        let rows: UInt32
    }

    private let lock = NSLock()
    private let stream: AsyncThrowingStream<PtySessionEvent, Error>
    private let continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation
    private var sentInputsStorage: [Data] = []
    private var resizesStorage: [Resize] = []
    private var detachCountStorage = 0
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

    var sentInputs: [Data] { lock.withLock { sentInputsStorage } }
    var resizes: [Resize] { lock.withLock { resizesStorage } }
    var detachCount: Int { lock.withLock { detachCountStorage } }
    var eventStreamTerminationCount: Int { lock.withLock { eventStreamTerminationCountStorage } }

    func yield(_ event: PtySessionEvent) {
        continuation.yield(event)
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        stream
    }

    func sendInput(_ data: Data) async throws {
        lock.withLock { sentInputsStorage.append(data) }
    }

    func resize(columns: UInt32, rows: UInt32) async throws {
        lock.withLock { resizesStorage.append(.init(columns: columns, rows: rows)) }
    }

    func detach() async throws {
        lock.withLock { detachCountStorage += 1 }
    }
}

private final class GatedContentConnection: PtyTerminalConnection, @unchecked Sendable {
    private let delivery: GatedContentEventDelivery
    private let inputFailure: GatedContentInputFailure?

    init(
        delivery: GatedContentEventDelivery,
        inputFailure: GatedContentInputFailure? = nil
    ) {
        self.delivery = delivery
        self.inputFailure = inputFailure
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        delivery.stream()
    }

    func sendInput(_ data: Data) async throws {
        try await inputFailure?.waitAndThrow()
    }
    func resize(columns: UInt32, rows: UInt32) async throws {}
    func detach() async throws {}
}

private final class GatedContentInputFailure: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var didCompleteStorage = false
    private var isCleanedUpStorage = false

    var isBlocked: Bool {
        lock.withLock { continuation != nil }
    }

    var didComplete: Bool {
        lock.withLock { didCompleteStorage }
    }

    func waitAndThrow() async throws {
        let shouldThrow = await withCheckedContinuation { continuation in
            let completesImmediately = lock.withLock {
                guard !isCleanedUpStorage else { return true }
                self.continuation = continuation
                return false
            }
            if completesImmediately {
                continuation.resume(returning: false)
            }
        }
        guard shouldThrow else { return }
        markCompleted()
        throw TestInputError()
    }

    func release() {
        let result: (
            continuation: CheckedContinuation<Bool, Never>?,
            isCleanedUp: Bool
        ) = lock.withLock {
            guard !isCleanedUpStorage else { return (nil, true) }
            let continuation = self.continuation
            self.continuation = nil
            return (continuation, false)
        }
        guard !result.isCleanedUp else { return }
        precondition(result.continuation != nil, "input failure must be blocked before release")
        result.continuation?.resume(returning: true)
    }

    func cleanup() {
        let continuation: CheckedContinuation<Bool, Never>? = lock.withLock {
            guard !isCleanedUpStorage else { return nil }
            isCleanedUpStorage = true
            let continuation = self.continuation
            self.continuation = nil
            return continuation
        }
        continuation?.resume(returning: false)
    }

    private func markCompleted() {
        lock.withLock {
            didCompleteStorage = true
        }
    }
}

private final class GatedContentEventDelivery: @unchecked Sendable {
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
        let lifetime = GatedContentStreamLifetime { [weak self] in
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

private struct TestInputError: Error {}

private final class GatedContentStreamLifetime: @unchecked Sendable {
    private let onDeinit: @Sendable () -> Void

    init(onDeinit: @escaping @Sendable () -> Void) {
        self.onDeinit = onDeinit
    }

    deinit {
        onDeinit()
    }
}
