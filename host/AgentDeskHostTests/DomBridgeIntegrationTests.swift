import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

// Phase-3 integration gate (ADR-0039): the REAL Swift DomBridgeServer against the REAL node shim
// (dom-bridge/bridge.mjs) in one process, to catch wire drift between the two hand-written peers
// (Chrome 4-byte stdio framing <-> newline-JSON + token over the Unix socket). The Node
// dom-mirror-bridge-verify covers the shim against a fake host; this covers the shim against the
// real Swift host, closing the loop. If node cannot be resolved, the test fails loudly rather than
// silently skipping (a silent skip would hide drift).
struct DomBridgeIntegrationTests {
    private func resolveNode() -> String? {
        if let n = ProcessInfo.processInfo.environment["AGENTDESK_NODE"], !n.isEmpty,
           FileManager.default.isExecutableFile(atPath: n) { return n }
        // A login shell picks up nvm's node, which xcodebuild's minimal PATH lacks.
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/bin/zsh")
        probe.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        probe.standardOutput = out
        probe.standardError = Pipe()
        guard (try? probe.run()) != nil else { return nil }
        probe.waitUntilExit()
        let path = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let path, !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) { return path }
        return nil
    }

    // #filePath = <repo>/host/AgentDeskHostTests/DomBridgeIntegrationTests.swift
    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private func chromeFrame(_ obj: [String: Any]) throws -> Data {
        let json = try JSONSerialization.data(withJSONObject: obj)
        var header = Data(count: 4)
        var len = UInt32(json.count).littleEndian
        withUnsafeBytes(of: &len) { header.replaceSubrange(0..<4, with: $0) }
        return header + json
    }

    @Test func realShimForwardsChromeFramedBatchToRealServer() async throws {
        guard let node = resolveNode() else {
            Issue.record("node not resolvable (set AGENTDESK_NODE); cannot run the shim<->host integration gate")
            return
        }
        let bridgeJS = repoRoot().appendingPathComponent("dom-bridge/bridge.mjs").path
        #expect(FileManager.default.fileExists(atPath: bridgeJS))

        // Short /tmp paths: AF_UNIX sun_path is ~104 chars, and NSTemporaryDirectory is long.
        let id = String(UUID().uuidString.prefix(8))
        let sock = "/tmp/adbridge-\(id).sock"
        let tokenPath = "/tmp/adbridge-\(id).token"
        let probePath = "/tmp/adbridge-\(id).log"
        defer {
            try? FileManager.default.removeItem(atPath: sock)
            try? FileManager.default.removeItem(atPath: tokenPath)
            try? FileManager.default.removeItem(atPath: probePath)
        }

        final class Box: @unchecked Sendable { var batch: (Data, DomBatchEnvelope)? }
        let box = Box()
        let server = DomBridgeServer(
            socketURL: URL(fileURLWithPath: sock),
            tokenURL: URL(fileURLWithPath: tokenPath),
            supportDirectory: URL(fileURLWithPath: "/tmp"),
            probeLogURL: URL(fileURLWithPath: probePath)
        )
        server.onBatch = { raw, env in box.batch = (raw, env) }
        server.start()
        defer { server.stop() }

        // Wait for the server to bind the socket and write its token (which the shim reads).
        for _ in 0..<50 where !(FileManager.default.fileExists(atPath: sock)
            && FileManager.default.fileExists(atPath: tokenPath)) {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(FileManager.default.fileExists(atPath: sock))

        // Spawn the REAL shim, pointed at our socket/token via env.
        let shim = Process()
        shim.executableURL = URL(fileURLWithPath: node)
        shim.arguments = [bridgeJS]
        var env = ProcessInfo.processInfo.environment
        env["AGENTDESK_DOM_BRIDGE_SOCKET"] = sock
        env["AGENTDESK_DOM_BRIDGE_TOKEN"] = tokenPath
        shim.environment = env
        let stdin = Pipe()
        shim.standardInput = stdin
        shim.standardOutput = Pipe()
        shim.standardError = Pipe()
        try shim.run()
        defer { shim.terminate() }

        // Gate the batch write on the real "authenticated" signal (the probe log records it), not a
        // timer: a batch written before the shim authenticates would be rejected and the connection
        // closed, so onBatch would never fire.
        var authed = false
        for _ in 0..<60 {
            if let log = try? String(contentsOfFile: probePath, encoding: .utf8),
               log.contains("bridge authenticated") { authed = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(authed)

        let frame = try chromeFrame(["t": "dom-batch", "tb": 42, "co": true, "ev": [["type": 4], ["type": 2]]])
        stdin.fileHandleForWriting.write(frame)

        for _ in 0..<50 where box.batch == nil {
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        let received = box.batch
        #expect(received != nil)
        #expect(received?.1.tabId == 42)
        #expect(received?.1.checkout == true)
        // The raw line forwarded to the host still carries the rrweb events verbatim.
        if let raw = received?.0, let s = String(data: raw, encoding: .utf8) {
            #expect(s.contains("\"ev\""))
        }
    }
}
