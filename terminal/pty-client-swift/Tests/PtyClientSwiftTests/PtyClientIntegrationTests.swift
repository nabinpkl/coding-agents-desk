import Foundation
import XCTest
@testable import PtyClientSwift

final class PtyClientIntegrationTests: XCTestCase {
    func testSwiftClientReceivesRustManagerSessionSnapshot() async throws {
        let root = repoRoot()
        let manifest = root.appendingPathComponent("terminal/pty-manager/Cargo.toml").path
        try run("/usr/bin/env", ["cargo", "build", "--manifest-path", manifest, "--bin", "pty-manager"])

        let socket = URL(fileURLWithPath: "/tmp/pty-swift-\(UUID().uuidString).sock")
        try? FileManager.default.removeItem(at: socket)
        let manager = Process()
        manager.executableURL = root.appendingPathComponent("terminal/pty-manager/target/debug/pty-manager")
        manager.arguments = ["--socket", socket.path]
        manager.standardOutput = Pipe()
        let managerError = Pipe()
        manager.standardError = managerError
        try manager.run()
        defer {
            if manager.isRunning {
                manager.terminate()
                manager.waitUntilExit()
            }
        }
        try await waitForSocket(socket.path, manager: manager, errorPipe: managerError)

        let client = PtyClient(socketPath: socket.path)
        var snapshots = client.sessionSnapshots().makeAsyncIterator()
        let initial = try await nextSnapshot(&snapshots)
        XCTAssertEqual(initial, [])

        let attachTransport = try UnixSocketPtyTransport(socketPath: socket.path)
        defer { attachTransport.close() }
        try await attachTransport.sendFrame(try Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion
            $0.requestID = 7
            $0.sessionName = "main"
            $0.payload = .createOrAttach(.with {
                $0.launch = .shellLaunch(.with {
                    $0.cwd = root.path
                    $0.shell = "/bin/sh"
                })
                $0.lifetime = .persistent
                $0.columns = 80
                $0.rows = 24
                $0.createIfMissing = true
                $0.clientTitle = "integration"
            })
        }.serializedData())
        let attachedEnvelope = try Pty_V1_Envelope(serializedBytes: try await attachTransport.receiveFrame())
        let attachedClientID: UInt64
        switch attachedEnvelope.payload {
        case .attached(let attached):
            attachedClientID = attached.clientID
        default:
            XCTFail("expected attached response")
            attachedClientID = 0
        }

        let created = try await nextSnapshot(&snapshots)
        XCTAssertEqual(created.map(\.name), ["main"])
        XCTAssertEqual(created.first?.clientCount, 1)
        XCTAssertEqual(created.first?.clients.first?.title, "integration")
        XCTAssertEqual(created.first?.clients.first?.id, attachedClientID)
        XCTAssertEqual(created.first?.lifetime, .persistent)
        XCTAssertGreaterThan(created.first?.startedAtUnixMilliseconds ?? 0, 0)
    }

    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
    }

    private func waitForSocket(
        _ socketPath: String,
        manager: Process,
        errorPipe: Pipe
    ) async throws {
        for _ in 0..<100 {
            if let transport = try? UnixSocketPtyTransport(socketPath: socketPath) {
                transport.close()
                return
            }
            if !manager.isRunning {
                let error = String(
                    decoding: errorPipe.fileHandleForReading.readDataToEndOfFile(),
                    as: UTF8.self
                )
                throw NSError(
                    domain: "PtyClientIntegrationTests",
                    code: Int(manager.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: "pty manager exited: \(error)"]
                )
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(
            domain: "PtyClientIntegrationTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "pty manager did not create socket"]
        )
    }

    private func nextSnapshot(
        _ iterator: inout AsyncThrowingStream<[PtySessionSummary], Error>.Iterator
    ) async throws -> [PtySessionSummary] {
        guard let snapshot = try await iterator.next() else { throw PtyClientError.closed }
        return snapshot
    }
}
