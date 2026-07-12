import Foundation
import PtyClientSwift
import PtyTerminalSession
import XCTest

@MainActor
final class PtyTerminalSessionDriverTests: XCTestCase {
    func testOutputAndExitEventsFeedRendererInOrder() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.start()
        connection.yield(.output(Data("hello".utf8)))
        connection.yield(.exited(7))

        try await waitUntil {
            renderer.outputs == [Data("hello".utf8)]
                && renderer.statuses == ["\r\n[session exited: 7]\r\n"]
        }
    }

    func testInputAndResizeForwardToConnection() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.sendInput(Data("ls\n".utf8))
        driver.resize(columns: 132, rows: 43)

        try await waitUntil {
            connection.sentInputs == [Data("ls\n".utf8)]
                && connection.resizes == [FakePtyTerminalConnection.Resize(columns: 132, rows: 43)]
        }
    }

    func testDetachCancelsAndDetachesConnection() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.start()
        driver.detach()

        try await waitUntil {
            connection.detachCount == 1
        }
    }

    func testStopCancelsWithoutDetachingConnection() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.start()
        driver.stop()

        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(connection.detachCount, 0)
    }

    func testManagerDetachClosesRenderer() async throws {
        let connection = FakePtyTerminalConnection()
        let renderer = FakePtyTerminalRenderer()
        let driver = PtyTerminalSessionDriver(connection: connection, renderer: renderer)

        driver.start()
        connection.yield(.detachedByManager(42))

        try await waitUntil {
            renderer.managerDetachCloseCount == 1
        }
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

    func feedOutput(_ data: Data) {
        outputs.append(data)
    }

    func feedStatus(_ text: String) {
        statuses.append(text)
    }

    func closeAfterManagerDetach() {
        managerDetachCloseCount += 1
    }
}

private final class FakePtyTerminalConnection: PtyTerminalConnection, @unchecked Sendable {
    struct Resize: Equatable {
        let columns: UInt32
        let rows: UInt32
    }

    private let lock = NSLock()
    private let stream: AsyncThrowingStream<PtySessionEvent, Error>
    private let continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation
    private var inputsStorage: [Data] = []
    private var resizesStorage: [Resize] = []
    private var detachCountStorage = 0

    init() {
        let pair = AsyncThrowingStream<PtySessionEvent, Error>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    var sentInputs: [Data] {
        lock.withLock { inputsStorage }
    }

    var resizes: [Resize] {
        lock.withLock { resizesStorage }
    }

    var detachCount: Int {
        lock.withLock { detachCountStorage }
    }

    func yield(_ event: PtySessionEvent) {
        continuation.yield(event)
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        stream
    }

    func sendInput(_ data: Data) async throws {
        lock.withLock {
            inputsStorage.append(data)
        }
    }

    func resize(columns: UInt32, rows: UInt32) async throws {
        lock.withLock {
            resizesStorage.append(Resize(columns: columns, rows: rows))
        }
    }

    func detach() async throws {
        lock.withLock {
            detachCountStorage += 1
        }
    }
}
