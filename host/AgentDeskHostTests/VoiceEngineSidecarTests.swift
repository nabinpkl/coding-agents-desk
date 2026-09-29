import Darwin
import Foundation
import Testing

@testable import AgentDeskHost

// Tests for VoiceEngineSidecar's on-demand lifecycle, against a stub server
// written to a temp path in place of the real `voice-server`, which holds ~2GB of
// models. The stub answers every GET on VOICE_PORT with a fixed body and closes
// the connection (HTTP/1.0), so each request is one proxied connection that opens
// and ends, which is exactly what the idle stop counts.
//
// Serialized for the reason AgentFeedSidecarProcessTests gives: concurrent child
// process churn under one xctest parent makes reaping racy.
@Suite(.serialized)
struct VoiceEngineSidecarTests {

    @Test func startsNothingUntilAConnectionArrivesThenStopsWhenIdle() async throws {
        let port = try freePort()
        let backendPort = try freePort()
        let stubURL = try makeStubServer()
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = VoiceEngineSidecar(
            launch: VoiceSidecarLaunch(
                executableURL: stubURL,
                arguments: [],
                workingDirectory: nil
            ),
            port: port,
            backendPort: backendPort,
            idleSeconds: 0.5
        )
        sidecar.start()
        defer { sidecar.stop() }

        let base = try #require(await sidecar.baseURL(waitingUpTo: 5))
        #expect(base.absoluteString == "http://127.0.0.1:\(port)")
        #expect(sidecar.spawnCountForTesting == 0, "binding the voice port must not start the server")
        #expect(!sidecar.isServerRunningForTesting)

        #expect(try await fetch(base.appendingPathComponent("health")) == "voice-stub")
        #expect(sidecar.spawnCountForTesting == 1, "the first connection starts the server")

        #expect(
            await waitUntil(timeout: 5) { !sidecar.isServerRunningForTesting },
            "the server must stop once nothing has been connected for the idle period"
        )

        #expect(try await fetch(base.appendingPathComponent("health")) == "voice-stub")
        #expect(sidecar.spawnCountForTesting == 2, "a connection after an idle stop starts a fresh server")
    }

    @Test func anOpenConnectionHoldsTheServerPastTheIdlePeriod() async throws {
        let port = try freePort()
        let backendPort = try freePort()
        let stubURL = try makeStubServer()
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = VoiceEngineSidecar(
            launch: VoiceSidecarLaunch(
                executableURL: stubURL,
                arguments: [],
                workingDirectory: nil
            ),
            port: port,
            backendPort: backendPort,
            idleSeconds: 0.5
        )
        sidecar.start()
        defer { sidecar.stop() }
        _ = try #require(await sidecar.baseURL(waitingUpTo: 5))

        // A raw socket that sends a request line and then holds stands in for a live
        // voice websocket.
        let held = try connectLoopback(port: port)
        defer { close(held) }
        let requestLine = Array("GET /ws/voice HTTP/1.1\r\n".utf8)
        #expect(Darwin.write(held, requestLine, requestLine.count) == requestLine.count)
        #expect(await waitUntil(timeout: 10) { sidecar.isServerRunningForTesting })
        try await Task.sleep(for: .seconds(1.5))
        #expect(sidecar.isServerRunningForTesting, "an open connection must keep the server up")

        close(held)
        #expect(await waitUntil(timeout: 5) { !sidecar.isServerRunningForTesting })
    }

    // The real server is HTTP/1.1 and keeps a connection open after replying, so
    // the client is the one that closes. Driven with curl, as the check on a live
    // host was.
    @Test func aClientThatClosesFirstStillLetsTheServerIdleOut() async throws {
        let port = try freePort()
        let backendPort = try freePort()
        let stubURL = try makeStubServer(keepAlive: true)
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = VoiceEngineSidecar(
            launch: VoiceSidecarLaunch(
                executableURL: stubURL,
                arguments: [],
                workingDirectory: nil
            ),
            port: port,
            backendPort: backendPort,
            idleSeconds: 0.5
        )
        sidecar.start()
        defer { sidecar.stop() }
        _ = try #require(await sidecar.baseURL(waitingUpTo: 5))

        let curl = Process()
        curl.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        curl.arguments = ["-sS", "-m", "30", "-o", "/dev/null", "http://127.0.0.1:\(port)/health"]
        try curl.run()
        curl.waitUntilExit()
        #expect(curl.terminationStatus == 0)
        #expect(sidecar.spawnCountForTesting == 1)

        #expect(
            await waitUntil(timeout: 5) { !sidecar.isServerRunningForTesting },
            "the server must stop once the client has closed and the idle period passed"
        )
    }

    // A port scanner asks every listening port for its page and icon. Answering
    // that must not load 2GB of models, and must not keep them loaded.
    @Test func aPortProbeIsAnsweredWithoutStartingTheServer() async throws {
        let port = try freePort()
        let backendPort = try freePort()
        let stubURL = try makeStubServer()
        defer { try? FileManager.default.removeItem(at: stubURL) }

        let sidecar = VoiceEngineSidecar(
            launch: VoiceSidecarLaunch(
                executableURL: stubURL,
                arguments: [],
                workingDirectory: nil
            ),
            port: port,
            backendPort: backendPort,
            idleSeconds: 0.5
        )
        sidecar.start()
        defer { sidecar.stop() }
        let base = try #require(await sidecar.baseURL(waitingUpTo: 5))

        for path in ["/", "/favicon.ico", "/?x=1"] {
            let url = try #require(URL(string: path, relativeTo: base)?.absoluteURL)
            let session = URLSession(configuration: .ephemeral)
            let (_, response) = try await session.data(from: url)
            session.invalidateAndCancel()
            #expect((response as? HTTPURLResponse)?.statusCode == 404, "\(path) is answered here")
        }
        // A connection that opens and says nothing does not start it either.
        let silent = try connectLoopback(port: port)
        try await Task.sleep(for: .milliseconds(300))
        close(silent)
        try await Task.sleep(for: .milliseconds(300))
        #expect(sidecar.spawnCountForTesting == 0, "probes and silent connections must not start the server")
    }

    @Test func probeRequestsAreRecognizedByTheirRequestLine() {
        func probe(_ line: String) -> Bool { VoiceProbeRequest.isProbe(Data(line.utf8)) }
        #expect(probe("GET / HTTP/1.1\r\nHost: x\r\n"))
        #expect(probe("GET /favicon.ico HTTP/1.1\r\n"))
        #expect(probe("HEAD /?refresh=1 HTTP/1.1\r\n"))
        #expect(!probe("GET /health HTTP/1.1\r\n"))
        #expect(!probe("GET /ws/voice?source=macos HTTP/1.1\r\n"))
        #expect(!probe("POST / HTTP/1.1\r\n"))
        #expect(!probe("GET / HTTP/1.1"), "an unfinished line is not judged")
    }

    // MARK: - Helpers

    private func makeStubServer(keepAlive: Bool = false) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-stub-\(UUID().uuidString)")
        let script = """
        #!/usr/bin/env python3
        import http.server, os, signal, socketserver, sys

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "\(keepAlive ? "HTTP/1.1" : "HTTP/1.0")"
            def log_message(self, fmt, *args): pass
            def do_GET(self):
                body = b"voice-stub"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        Server((os.environ["VOICE_HOST"], int(os.environ["VOICE_PORT"])), Handler).serve_forever()
        """
        try script.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    private func fetch(_ url: URL) async throws -> String {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let (data, _) = try await session.data(for: request)
        return String(decoding: data, as: UTF8.self)
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }

    private func connectLoopback(port: UInt16) throws -> Int32 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw VoiceSidecarTestError.socketFailed(errno) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = port.bigEndian
        let result = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard result == 0 else {
            close(fd)
            throw VoiceSidecarTestError.connectFailed(errno)
        }
        return fd
    }

    // Bind 127.0.0.1:0, read back the port the OS picked, release it.
    private func freePort() throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw VoiceSidecarTestError.socketFailed(errno) }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bound = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw VoiceSidecarTestError.bindFailed(errno) }
        var assigned = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &assigned) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &len)
            }
        }
        guard named == 0 else { throw VoiceSidecarTestError.bindFailed(errno) }
        return UInt16(bigEndian: assigned.sin_port)
    }
}

private enum VoiceSidecarTestError: Error {
    case socketFailed(Int32)
    case bindFailed(Int32)
    case connectFailed(Int32)
}
