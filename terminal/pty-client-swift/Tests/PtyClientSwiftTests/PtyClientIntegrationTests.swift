import Foundation
import XCTest
@testable import PtyClientSwift

final class PtyClientIntegrationTests: XCTestCase {
    func testSwiftClientReceivesRustManagerSessionSnapshot() async throws {
        let root = repoRoot()
        let manifest = root.appendingPathComponent("terminal/pty-manager/Cargo.toml").path
        try run("/usr/bin/env", [
            "cargo", "build", "--manifest-path", manifest,
            "--bin", "pty-manager", "--bin", "pty-vault",
        ])

        let runtimeID = UUID().uuidString.prefix(8)
        let runtimeDirectory = URL(
            fileURLWithPath: "/tmp/pty-swift-\(runtimeID)",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: runtimeDirectory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: runtimeDirectory) }
        let socket = runtimeDirectory.appendingPathComponent("pty-manager.sock", isDirectory: false)
        let vaultSocket = runtimeDirectory.appendingPathComponent("pty-vault.sock", isDirectory: false)
        let vault = Process()
        vault.executableURL = root.appendingPathComponent("terminal/pty-manager/target/debug/pty-vault")
        vault.arguments = ["--socket", vaultSocket.path]
        vault.standardOutput = Pipe()
        let vaultError = Pipe()
        vault.standardError = vaultError
        try vault.run()
        defer {
            if vault.isRunning {
                vault.terminate()
                vault.waitUntilExit()
            }
        }
        try await waitForSocket(
            vaultSocket.path,
            process: vault,
            component: "pty vault",
            errorPipe: vaultError
        )

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
        try await waitForSocket(
            socket.path,
            process: manager,
            component: "pty manager",
            errorPipe: managerError
        )

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
        process: Process,
        component: String,
        errorPipe: Pipe
    ) async throws {
        // Binding takes 30-50ms unloaded, but `just check` runs this leg beside a full xcodebuild
        // and the whole Rust suite, and a 1s budget was being missed under that load alone: the
        // leg passes in isolation and reports a bogus "did not create socket" when run whole. A
        // daemon that actually fails is caught by the exit check below, with its real stderr, so
        // the only case this budget governs is a genuine hang.
        for _ in 0..<1_000 {
            if let transport = try? UnixSocketPtyTransport(socketPath: socketPath) {
                transport.close()
                return
            }
            if !process.isRunning {
                let error = String(
                    decoding: errorPipe.fileHandleForReading.readDataToEndOfFile(),
                    as: UTF8.self
                )
                throw NSError(
                    domain: "PtyClientIntegrationTests",
                    code: Int(process.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: "\(component) exited: \(error)"]
                )
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(
            domain: "PtyClientIntegrationTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "\(component) did not create socket"]
        )
    }

    private func nextSnapshot(
        _ iterator: inout AsyncThrowingStream<[PtySessionSummary], Error>.Iterator
    ) async throws -> [PtySessionSummary] {
        guard let snapshot = try await iterator.next() else { throw PtyClientError.closed }
        return snapshot
    }
}
