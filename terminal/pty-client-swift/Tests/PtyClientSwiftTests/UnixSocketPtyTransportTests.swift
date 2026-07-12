import Darwin
import Foundation
import XCTest
@testable import PtyClientSwift

final class UnixSocketPtyTransportTests: XCTestCase {
    func testCloseUnblocksPendingReceiveAndClosesTransport() async throws {
        var descriptors: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors), 0)
        let peer = descriptors[1]
        defer { Darwin.close(peer) }

        let transport = try UnixSocketPtyTransport(connectedDescriptor: descriptors[0])
        let receiveTask = Task {
            try await transport.receiveFrame()
        }

        try await Task.sleep(nanoseconds: 20_000_000)
        transport.close()

        do {
            _ = try await receiveTask.value
            XCTFail("expected pending receive to fail after close")
        } catch {
            XCTAssertTrue(error is POSIXError || error as? PtyClientError == .closed, "unexpected error: \(error)")
        }

        do {
            try await transport.sendFrame(Data("after-close".utf8))
            XCTFail("expected send after close to fail")
        } catch PtyClientError.closed {
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testWriteToClosedPeerThrowsInsteadOfTerminatingProcess() async throws {
        var descriptors: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors), 0)
        let peer = descriptors[1]

        let transport = try UnixSocketPtyTransport(connectedDescriptor: descriptors[0])
        Darwin.close(peer)

        do {
            try await transport.sendFrame(Data("closed-peer".utf8))
            XCTFail("expected send to closed peer to fail")
        } catch {
            XCTAssertTrue(error is POSIXError || error as? PtyClientError == .closed, "unexpected error: \(error)")
        }

        transport.close()
    }
}
