import Darwin
import Foundation
import Testing

@testable import AgentDeskHost

// Tests for AgentFeedSidecarProcess using a stub binary written to a temp path.
// The stub is a shell script that binds the port and answers /api/config with
// a minimal JSON body, so `just check` stays fast and hermetic. The real 64 MB
// compiled sidecar is exercised by `just agent-feed-sidecar-smoke`.
//
// Serialized: each test spawns and SIGKILLs real child processes. Swift Testing
// runs tests in parallel by default, and concurrent child-process churn under a
// single xctest parent makes the OS-level Process child-reaping racy (a
// restarted child can be disturbed by a sibling test's teardown), which
// destabilizes the restart-count assertion. Serializing keeps each test's
// process lifecycle isolated. They are fast (~1 s each) so the cost is small.
@Suite(.serialized)
struct AgentFeedSidecarProcessTests {

    /// A sidecar running a stub binary: the bundled shape, which is what these tests exercise.
    /// The source-tree shape has no process to spawn here and is covered by
    /// `AgentFeedSidecarLaunchTests`, which tests the selection rather than the supervision.
    private func makeSidecar(binaryURL: URL, port: UInt16) -> AgentFeedSidecarProcess {
        AgentFeedSidecarProcess(
            launch: Config.AgentFeedSidecarLaunch(
                executable: binaryURL,
                arguments: [],
                reloadsOnEdit: false
            ),
            port: port
        )
    }

    // Probe for a free loopback TCP port: bind a socket to 127.0.0.1:0, let the
    // OS assign an ephemeral port, read it back, then close the socket. Each test
    // calls this for its own unique port instead of sharing a fixed one, so runs
    // cannot collide on the port across `just check` invocations or during the
    // stub's startup/teardown window. A small TOCTOU gap remains between close
    // and the stub's re-bind, but it is far narrower than a fixed shared port.
    private func freePort() throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SidecarTestError.socketFailed(errno) }
        defer { close(fd) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0 // ask the OS for any free port

        let bindResult = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { throw SidecarTestError.bindFailed(errno) }

        var assigned = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &assigned) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                getsockname(fd, sockaddrPointer, &len)
            }
        }
        guard nameResult == 0 else { throw SidecarTestError.getsocknameFailed(errno) }

        // sin_port is network byte order; convert to host order.
        return UInt16(bigEndian: assigned.sin_port)
    }

    // Write a tiny stub binary to a temp path. The stub is an executable Python
    // script (via a python3 shebang) that:
    //   - serves a static /api/config JSON on the given port for the ready-poll,
    //   - exits cleanly on SIGTERM.
    // extraLines are injected before the server starts (e.g. to record the PID
    // or the inherited PATH). Returns the stub URL.
    private func makeStubBinary(port: UInt16, extraLines: [String] = []) throws -> URL {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-feed-stub-\(port)-\(UUID().uuidString)")
        let script = """
        #!/usr/bin/env python3
        import http.server, socketserver, signal, sys, os, json

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, fmt, *args): pass
            def handle_one_request(self):
                # Swallow transient connection errors (reset/broken pipe) instead
                # of letting them bubble out of serve_forever and crash the stub.
                try:
                    super().handle_one_request()
                except Exception:
                    self.close_connection = True
            def do_GET(self):
                body = json.dumps({"watcherState": "live", "staleThresholdMs": 7200000, "readyThresholdMs": 300000}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        # ThreadingHTTPServer handles each request on its own thread so a slow or
        # reset connection cannot wedge the accept loop. allow_reuse_address lets
        # a restarted stub re-bind the port immediately after a SIGKILLed
        # predecessor (isolating the test to the supervisor's restart logic).
        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        \(extraLines.joined(separator: "\n"))
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        # Ignore SIGPIPE so a client that drops mid-write does not kill the stub.
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        httpd = Server(("127.0.0.1", \(port)), Handler)
        httpd.serve_forever()
        """
        try script.write(to: tmp, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: tmp.path
        )
        return tmp
    }

    private func makeUnresponsiveListenerBinary(port: UInt16, readyFile: URL) throws -> URL {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-feed-unresponsive-listener-\(port)-\(UUID().uuidString)")
        let script = """
        #!/usr/bin/env python3
        import os, signal, socket, sys, time

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", \(port)))
        listener.listen()
        open('\(readyFile.path)', 'w').write(str(os.getpid()))
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            connection, _ = listener.accept()
            connection.recv(4096)
            time.sleep(60)
        """
        try script.write(to: tmp, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: tmp.path
        )
        return tmp
    }

    // MARK: - Child inherits the parent environment (PATH not stripped)

    @Test func spawnedChildInheritsPath() async throws {
        let port = try freePort()
        // The stub writes its own PATH to a temp file on startup. If
        // AgentFeedSidecarProcess replaced (rather than merged) the child env,
        // PATH would be empty here and transcript discovery subprocesses
        // would fail. Asserting a non-empty PATH proves the merge.
        let pathFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-feed-stub-path-\(port)-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: pathFile) }

        let stubURL = try makeStubBinary(port: port, extraLines: [
            "open('\(pathFile.path)', 'w').write(os.environ.get('PATH', ''))"
        ])
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = makeSidecar(
            binaryURL: stubURL,
            port: port
        )
        // Defer teardown so the stub child is terminated before the test returns
        // even if an assertion below fails or a throw unwinds early.
        defer { sidecar.stop() }
        sidecar.start()

        // Wait for the stub to write its PATH file (up to 6 s).
        let deadline = Date().addingTimeInterval(6)
        var childPath: String?
        while Date() < deadline {
            childPath = try? String(contentsOf: pathFile, encoding: .utf8)
            if let childPath, !childPath.isEmpty { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        #expect(childPath != nil, "stub should have written its PATH")
        #expect(!(childPath ?? "").isEmpty, "child PATH must be non-empty (env merged, not replaced)")
    }

    // MARK: - Spawn reaches ready

    @Test func spawnReachesReady() async throws {
        let port = try freePort()
        let stubURL = try makeStubBinary(port: port)
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = makeSidecar(
            binaryURL: stubURL,
            port: port
        )
        defer { sidecar.stop() }
        sidecar.start()

        // Poll for up to 6 seconds; the stub should answer within the 5s ready window.
        let deadline = Date().addingTimeInterval(6)
        while sidecar.baseURL == nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        #expect(sidecar.baseURL == URL(string: "http://127.0.0.1:\(port)"))
    }

    // MARK: - Readiness is announced, not polled for

    @Test func aWaiterThatArrivesBeforeTheSidecarIsWokenWhenItComesUp() async throws {
        let port = try freePort()
        let stubURL = try makeStubBinary(port: port)
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = makeSidecar(binaryURL: stubURL, port: port)
        defer { sidecar.stop() }

        // Ask BEFORE starting, which is the launch ordering that broke the Agents
        // window: it subscribed a full second before the sidecar published its URL.
        async let awaited = sidecar.baseURL(waitingUpTo: 10)
        #expect(sidecar.baseURL == nil, "nothing is published yet")
        sidecar.start()

        #expect(await awaited == URL(string: "http://127.0.0.1:\(port)"))
    }

    @Test func stoppingReleasesWaitersImmediatelyRatherThanLeavingThemToTimeOut() async throws {
        let port = try freePort()
        let sidecar = makeSidecar(
            binaryURL: URL(fileURLWithPath: "/nonexistent/agent-feed-sidecar"),
            port: port
        )

        // A generous bound, so passing quickly can only mean stop() released it.
        async let awaited = sidecar.baseURL(waitingUpTo: 30)
        try await Task.sleep(for: .milliseconds(100))
        let started = Date()
        sidecar.stop()

        #expect(await awaited == nil)
        #expect(Date().timeIntervalSince(started) < 5)
    }

    @Test func aWaiterGivesUpRatherThanHangingWhenNothingEverStarts() async throws {
        let port = try freePort()
        // Never started, so it never becomes ready. The wait must end on its own:
        // an unbounded one would trade a visible error for a permanently blank window.
        let sidecar = makeSidecar(
            binaryURL: URL(fileURLWithPath: "/nonexistent/agent-feed-sidecar"),
            port: port
        )
        defer { sidecar.stop() }

        let started = Date()
        let resolved = await sidecar.baseURL(waitingUpTo: 0.5)
        #expect(resolved == nil)
        #expect(Date().timeIntervalSince(started) < 5, "the wait honored its own bound")
    }

    // MARK: - Teardown terminates the child

    @Test func teardownTerminatesChild() async throws {
        let port = try freePort()
        let stubURL = try makeStubBinary(port: port)
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = makeSidecar(
            binaryURL: stubURL,
            port: port
        )
        // The mid-test stop() below is the subject under test; this defer is a
        // safety net for early-exit paths (stop() is idempotent).
        defer { sidecar.stop() }
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

    @Test func stopReturnsPromptlyWhenExistingListenerNeverResponds() async throws {
        let port = try freePort()
        let readyFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-feed-unresponsive-listener-ready-\(port)-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: readyFile) }
        let listenerURL = try makeUnresponsiveListenerBinary(port: port, readyFile: readyFile)
        defer { try? FileManager.default.removeItem(at: listenerURL) }

        let listener = Process()
        listener.executableURL = listenerURL
        try listener.run()
        defer {
            if listener.isRunning { listener.terminate() }
        }

        let readyDeadline = Date().addingTimeInterval(2)
        while !FileManager.default.fileExists(atPath: readyFile.path), Date() < readyDeadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: readyFile.path), "listener must bind before the probe")

        let sidecarURL = try makeStubBinary(port: port)
        defer { try? FileManager.default.removeItem(at: sidecarURL) }
        let sidecar = makeSidecar(binaryURL: sidecarURL, port: port)
        defer { sidecar.stop() }
        sidecar.start()
        try await Task.sleep(nanoseconds: 100_000_000)

        let started = Date()
        sidecar.stop()
        #expect(Date().timeIntervalSince(started) < 1, "stop must not wait on an unresponsive listener")
    }

    // MARK: - Induced child exit triggers exactly one restart

    @Test func inducedExitTriggersExactlyOneRestart() async throws {
        let port = try freePort()
        // The stub writes its own PID to a temp file on startup so the test can
        // SIGKILL the live child. Restart counting is read from the supervisor's
        // own restartCountForTesting rather than inferred from child spawn counts:
        // under xctest's process supervision a restarted stub can re-die for
        // environmental reasons, which would pollute a spawn-count assertion. The
        // supervisor's restart counter is the precise signal that one induced
        // exit produced exactly one restart (the double-restart guard at work).
        let pidFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-feed-stub-pid-\(port)-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: pidFile) }

        let stubURL = try makeStubBinary(port: port, extraLines: [
            "open('\(pidFile.path)', 'w').write(str(os.getpid()))"
        ])
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = makeSidecar(
            binaryURL: stubURL,
            port: port
        )
        // Defer teardown so the (possibly restarted) stub child is terminated
        // before the test returns on any path, including the early return below.
        defer { sidecar.stop() }
        sidecar.start()

        // Wait until the sidecar is first ready.
        let firstReadyDeadline = Date().addingTimeInterval(6)
        while sidecar.baseURL == nil, Date() < firstReadyDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(sidecar.baseURL != nil, "sidecar must be ready before killing")
        #expect(sidecar.restartCountForTesting == 0, "no restart before the induced kill")

        // Read the live child's PID.
        let pidDeadline = Date().addingTimeInterval(3)
        var childPID: Int32?
        while Date() < pidDeadline {
            if let s = try? String(contentsOf: pidFile, encoding: .utf8),
               let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) {
                childPID = pid
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard let childPID else {
            Issue.record("stub did not write its PID in time")
            return
        }

        // Kill the child to simulate one unexpected exit.
        kill(childPID, SIGKILL)

        // The supervisor should detect the exit and restart once. Backoff starts
        // at 1 second, so allow up to 10 seconds for the restart + ready poll.
        // Wait for baseURL to clear (child dead) then return (restarted ready).
        let restartDeadline = Date().addingTimeInterval(10)
        while sidecar.baseURL != nil, Date() < restartDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        while sidecar.baseURL == nil, Date() < restartDeadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(sidecar.baseURL == URL(string: "http://127.0.0.1:\(port)"),
                "sidecar should have restarted and become ready again")

        // Exactly one restart for one induced exit. The double-restart guard
        // ensures handleTermination and any ready-timeout path collapse to a
        // single restart for the dead process.
        #expect(sidecar.restartCountForTesting == 1,
                "exactly one restart expected for one induced exit, saw \(sidecar.restartCountForTesting)")
    }
}

private enum SidecarTestError: Error {
    case socketFailed(Int32)
    case bindFailed(Int32)
    case getsocknameFailed(Int32)
}
