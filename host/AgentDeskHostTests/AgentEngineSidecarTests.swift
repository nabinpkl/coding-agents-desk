import Foundation
import Testing

@testable import AgentDeskHost

// Tests for AgentEngineSidecar using a stub binary written to a temp path.
// The stub is a shell script that binds the port and answers /api/config with
// a minimal JSON body, so `just check` stays fast and hermetic. The real 64 MB
// engine binary is exercised only by `just sidecar-smoke`.
struct AgentEngineSidecarTests {

    // Write a tiny stub binary to a temp path. The stub is a shell script that:
    //   - launches Python's built-in HTTP server on the given port,
    //   - serves a static /api/config JSON for the ready-poll,
    //   - exits cleanly on SIGTERM.
    // Returns the stub URL.
    private func makeStubBinary(port: UInt16, extraLines: [String] = []) throws -> URL {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("atc-stub-\(port)-\(UUID().uuidString)")
        let script = """
        #!/usr/bin/env python3
        import http.server, signal, sys, os, json

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, fmt, *args): pass
            def do_GET(self):
                body = json.dumps({"atcRoot": "/tmp", "staleThresholdMs": 7200000, "readyThresholdMs": 300000}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        \(extraLines.joined(separator: "\n"))
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        httpd = http.server.HTTPServer(("127.0.0.1", \(port)), Handler)
        httpd.serve_forever()
        """
        try script.write(to: tmp, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: tmp.path
        )
        return tmp
    }

    // MARK: - Spawn reaches ready

    @Test func spawnReachesReady() async throws {
        let port: UInt16 = 47982
        let stubURL = try makeStubBinary(port: port)
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = AgentEngineSidecar(binaryURL: stubURL, port: port)
        sidecar.start()

        // Poll for up to 6 seconds; the stub should answer within the 5s ready window.
        let deadline = Date().addingTimeInterval(6)
        while sidecar.baseURL == nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        #expect(sidecar.baseURL == URL(string: "http://127.0.0.1:\(port)"))
        sidecar.stop()
    }

    // MARK: - Teardown terminates the child

    @Test func teardownTerminatesChild() async throws {
        let port: UInt16 = 47983
        let stubURL = try makeStubBinary(port: port)
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = AgentEngineSidecar(binaryURL: stubURL, port: port)
        sidecar.start()

        // Wait for ready so we know the process is actually up.
        let readyDeadline = Date().addingTimeInterval(6)
        while sidecar.baseURL == nil, Date() < readyDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(sidecar.baseURL != nil, "sidecar must be ready before testing teardown")

        sidecar.stop()

        // After stop, the port should stop answering. Give it 2 seconds.
        let stopDeadline = Date().addingTimeInterval(2)
        var portStillOpen = true
        while Date() < stopDeadline {
            try await Task.sleep(nanoseconds: 200_000_000)
            let url = URL(string: "http://127.0.0.1:\(port)/api/config")!
            let data = try? Data(contentsOf: url)
            if data == nil {
                portStillOpen = false
                break
            }
        }
        #expect(!portStillOpen, "port should stop answering after stop()")
    }

    // MARK: - Induced child exit triggers a restart

    @Test func inducedExitTriggersRestart() async throws {
        let port: UInt16 = 47984
        // Use a stub that reads its PID from the HTTP server's PID and writes it
        // to a well-known temp file so the test can SIGKILL the child directly.
        let pidFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("atc-stub-\(port).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }

        let stubURL = try makeStubBinary(port: port, extraLines: [
            "open('\(pidFile.path)', 'w').write(str(os.getpid()))"
        ])
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = AgentEngineSidecar(binaryURL: stubURL, port: port)
        sidecar.start()

        // Wait until the sidecar is first ready.
        let firstReadyDeadline = Date().addingTimeInterval(6)
        while sidecar.baseURL == nil, Date() < firstReadyDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(sidecar.baseURL != nil, "sidecar must be ready before killing")

        // Wait for the stub to write its PID.
        let pidDeadline = Date().addingTimeInterval(3)
        var pidStr: String?
        while Date() < pidDeadline {
            pidStr = try? String(contentsOf: pidFile, encoding: .utf8)
            if pidStr != nil { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard let pidStr, let childPID = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            Issue.record("stub did not write PID file in time")
            sidecar.stop()
            return
        }

        // Kill the child to simulate an unexpected exit.
        kill(childPID, SIGKILL)

        // The sidecar should detect the exit and restart. The backoff starts at
        // 1 second, so allow up to 10 seconds for the restart + ready poll.
        let restartDeadline = Date().addingTimeInterval(10)
        // First wait for baseURL to clear (child is dead).
        while sidecar.baseURL != nil, Date() < restartDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        // Then wait for it to become non-nil again (restarted).
        while sidecar.baseURL == nil, Date() < restartDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        #expect(sidecar.baseURL == URL(string: "http://127.0.0.1:\(port)"),
                "sidecar should have restarted and become ready again")
        sidecar.stop()
    }
}
