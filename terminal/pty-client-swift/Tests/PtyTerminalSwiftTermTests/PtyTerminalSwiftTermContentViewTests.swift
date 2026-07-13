import Foundation
import PtyClientSwift
import PtyTerminalSession
@testable import PtyTerminalSwiftTerm
import SwiftTerm
import XCTest

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
    }

    func testOutputFeedsTerminal() async throws {
        let connection = FakeContentConnection()
        let content = PtyTerminalSwiftTermContentView()
        content.bind(to: connection)

        connection.yield(.output(Data("package output".utf8)))

        try await waitUntil {
            content.terminalView.getTerminal().getLine(row: 0)?.translateToString(trimRight: true) == "package output"
        }
    }

    func testPasteUsesTerminalBracketedPasteMode() async throws {
        let connection = FakeContentConnection()
        let content = PtyTerminalSwiftTermContentView()
        content.bind(to: connection)

        content.paste(text: "plain")
        content.feedOutput(Data("\u{1B}[?2004h".utf8))
        content.paste(text: "wrapped")

        try await waitUntil {
            connection.sentInputs.count == 2
        }
        XCTAssertEqual(connection.sentInputs[0], Data("plain".utf8))
        XCTAssertEqual(
            connection.sentInputs[1],
            Data(EscapeSequences.bracketedPasteStart + Array("wrapped".utf8) + EscapeSequences.bracketedPasteEnd)
        )
    }

    func testDetachStopsRenderingAndDetachesConnection() async throws {
        let connection = FakeContentConnection()
        let content = PtyTerminalSwiftTermContentView()
        content.bind(to: connection)

        content.detach()
        content.detach()

        try await waitUntil {
            connection.detachCount == 1
        }
        XCTAssertEqual(connection.detachCount, 1)
        connection.yield(.output(Data("after detach".utf8)))
        try await Task.sleep(nanoseconds: 20_000_000)
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
        }
        XCTAssertFalse(content.isBound)
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
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(connection.detachCount, 0)
    }

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
