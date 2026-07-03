import Darwin
import Foundation
import os
import Security
import AgentDeskWire

// ADR-0039 host-side endpoint of the sacrificial native-messaging bridge. The `dom-bridge`
// shim (spawned and owned by Chrome) connects to this Unix domain socket and forwards, as
// newline-delimited JSON, the rrweb batches it receives from the extension over Chrome's
// 4-byte-framed stdio. This server decodes only the lightweight DomBatchEnvelope and hands the
// raw batch bytes to `onBatch` for opaque forwarding down the .dom QUIC lane (wired in Phase 3);
// it also writes input commands back to the connected shim via `sendToBridge` (used in Phase 5).
//
// The protocol/parse logic lives in the pure, socket-free `DomBridgeFrameReader` and
// `DomBridgeSession` so it is unit-testable without a live socket; `DomBridgeServer` is the thin
// I/O glue, mirroring AgentSayLocalServer.
final class DomBridgeServer: @unchecked Sendable {
    enum Constants {
        // Cap on a single newline-framed line from the shim. Chrome caps extension->host native
        // messages at 1 MB; the shim may coalesce, so allow headroom above that. Since ADR-0043 the
        // extension deflate-compresses each batch (and chunks a still-oversized one), so every line is
        // well under this -- it is a memory safety bound, not a working limit.
        static let maxLineBytes = 2 * 1024 * 1024
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "dom-bridge")
    private let socketURL: URL
    private let tokenURL: URL
    private let supportDirectory: URL
    private let probeLogURL: URL?
    private let queue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.dom-bridge")
    private let activeFDLock = OSAllocatedUnfairLock<Int32>(initialState: -1)
    // `stopped` and the listen FD are read on the accept queue and written by stop() on the
    // caller's thread; guard both behind one lock so there is no torn access. A tiny inherent
    // window remains where accept() may run on an FD that stop() just closed (and whose number
    // was reused) -- closing the listen FD to interrupt a blocking accept() is the standard
    // idiom, and the loop re-checks `stopped` immediately after accept() returns.
    private struct ListenState { var fd: Int32 = -1; var stopped = false }
    private let listenLock = OSAllocatedUnfairLock(initialState: ListenState())

    // Called for each authenticated DOM batch: the raw newline-free JSON line the shim sent
    // (forwarded verbatim down the .dom lane) plus the decoded envelope (tab, checkout marker).
    var onBatch: ((Data, DomBatchEnvelope) -> Void)?
    // Called when a shim connects / disconnects, so the DOM subsystem can track bridge liveness.
    var onBridgeConnected: (() -> Void)?
    var onBridgeDisconnected: (() -> Void)?

    init(
        socketURL: URL = Config.domBridgeSocketURL,
        tokenURL: URL = Config.domBridgeTokenURL,
        supportDirectory: URL = Config.applicationSupportDirectory,
        probeLogURL: URL? = Config.domMirrorProbeLogURL
    ) {
        self.socketURL = socketURL
        self.tokenURL = tokenURL
        self.supportDirectory = supportDirectory
        self.probeLogURL = probeLogURL
    }

    func start() {
        queue.async { [weak self] in self?.startOnQueue() }
    }

    func stop() {
        let fdToClose: Int32 = listenLock.withLock { state in
            state.stopped = true
            let fd = state.fd
            state.fd = -1
            return fd
        }
        if fdToClose >= 0 { Darwin.close(fdToClose) }
        unlink(socketURL.path)
    }

    // Write one newline-framed JSON line to the currently connected shim, if any. Returns false
    // when no shim is connected (the caller can drop the command). Used by the input round-trip.
    @discardableResult
    func sendToBridge(_ payload: Data) -> Bool {
        activeFDLock.withLock { fd in
            guard fd >= 0 else { return false }
            var line = payload
            line.append(0x0A)
            // Loop until the whole line is written: a single write() can return a short count or
            // -1/EINTR, and a truncated command would desync the newline framing.
            return line.withUnsafeBytes { buffer -> Bool in
                guard let base = buffer.baseAddress else { return false }
                var offset = 0
                while offset < buffer.count {
                    let n = Darwin.write(fd, base + offset, buffer.count - offset)
                    if n > 0 { offset += n; continue }
                    if n < 0 && errno == EINTR { continue }
                    return false
                }
                return true
            }
        }
    }

    private func startOnQueue() {
        do {
            _ = try ensureToken()
            try bindSocket()
            acceptLoop()
        } catch {
            logger.error("dom-bridge server failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func ensureToken() throws -> String {
        try FileManager.default.createDirectory(
            at: supportDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        chmod(supportDirectory.path, 0o700)

        if FileManager.default.fileExists(atPath: tokenURL.path) {
            chmod(tokenURL.path, 0o600)
            return try String(contentsOf: tokenURL, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw DomBridgeError.tokenGenerationFailed
        }
        let token = Data(bytes).base64EncodedString()
        try (token + "\n").write(to: tokenURL, atomically: true, encoding: .utf8)
        chmod(tokenURL.path, 0o600)
        return token
    }

    private func bindSocket() throws {
        unlink(socketURL.path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DomBridgeError.socketFailed(errno) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        try socketURL.path.withCString { pathPointer in
            guard strlen(pathPointer) < maxPathLength else {
                throw DomBridgeError.socketPathTooLong
            }
            _ = withUnsafeMutablePointer(to: &address.sun_path) { tuplePointer in
                tuplePointer.withMemoryRebound(to: CChar.self, capacity: maxPathLength) { destination in
                    strncpy(destination, pathPointer, maxPathLength - 1)
                }
            }
        }

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(
                    fd,
                    sockaddrPointer,
                    socklen_t(MemoryLayout<sa_family_t>.size + socketURL.path.utf8.count + 1)
                )
            }
        }
        guard bindResult == 0 else {
            let err = errno
            Darwin.close(fd)
            throw DomBridgeError.bindFailed(err)
        }
        chmod(socketURL.path, 0o600)

        guard listen(fd, 4) == 0 else {
            let err = errno
            Darwin.close(fd)
            throw DomBridgeError.listenFailed(err)
        }
        listenLock.withLock { $0.fd = fd }
        logger.notice("dom-bridge listening at \(self.socketURL.path, privacy: .public)")
    }

    private func acceptLoop() {
        while true {
            let (fd, isStopped) = listenLock.withLock { ($0.fd, $0.stopped) }
            if isStopped || fd < 0 { return }
            let clientFD = accept(fd, nil, nil)
            if clientFD < 0 {
                if listenLock.withLock({ $0.stopped }) || errno == EBADF { return }
                logger.error("dom-bridge accept failed errno=\(errno, privacy: .public)")
                continue
            }
            handleConnection(clientFD)
        }
    }

    private func handleConnection(_ fd: Int32) {
        activeFDLock.withLock { $0 = fd }
        onBridgeConnected?()
        appendProbe("bridge connected")
        defer {
            activeFDLock.withLock { current in
                if current == fd { current = -1 }
            }
            Darwin.close(fd)
            onBridgeDisconnected?()
            appendProbe("bridge disconnected")
        }

        let token: String
        do {
            token = try ensureToken()
        } catch {
            return
        }

        var reader = DomBridgeFrameReader(maxLineBytes: Constants.maxLineBytes)
        var session = DomBridgeSession(expectedToken: token)
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while !(listenLock.withLock { $0.stopped }) {
            let count = Darwin.read(fd, &chunk, chunk.count)
            if count == 0 { return }
            guard count > 0 else { return }
            let lines: [Data]
            do {
                lines = try reader.consume(Data(chunk[..<count]))
            } catch {
                appendProbe("bridge framing error")
                return
            }
            for line in lines {
                switch session.accept(line: line) {
                case .ack:
                    appendProbe("bridge authenticated")
                case .forwardBatch(let raw, let envelope):
                    onBatch?(raw, envelope)
                    appendProbe("dom-batch tab=\(envelope.tabId) checkout=\(envelope.checkout) bytes=\(raw.count)")
                case .reject(let code):
                    appendProbe("bridge rejected code=\(code)")
                    return
                case .ignore:
                    break
                }
            }
        }
    }

    // Append-only probe log. Called only from the bridge queue (the accept thread), so no
    // cross-thread coordination is needed today; a future caller from another thread must add it.
    // Always create-if-missing then append so a sequence of probe lines is never truncated -- the
    // autonomous harness greps for the full sequence, so a truncating write would lose evidence.
    private func appendProbe(_ message: String) {
        guard let probeLogURL else { return }
        guard let data = "[dom-bridge] \(message)\n".data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: probeLogURL.path) {
            FileManager.default.createFile(atPath: probeLogURL.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: probeLogURL) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}

enum DomBridgeError: Error, Equatable {
    case tokenGenerationFailed
    case socketFailed(Int32)
    case bindFailed(Int32)
    case listenFailed(Int32)
    case socketPathTooLong
    case frameTooLarge
}

// Pure, socket-free incremental splitter of newline-delimited frames with a byte cap. The server
// feeds raw socket reads in; complete lines come out. A pending (un-terminated) line past the cap
// throws, bounding memory against a hostile/broken peer. Unit-tested without any FD.
struct DomBridgeFrameReader {
    private let maxLineBytes: Int
    private var buffer = Data()

    init(maxLineBytes: Int) {
        self.maxLineBytes = maxLineBytes
    }

    mutating func consume(_ data: Data) throws -> [Data] {
        buffer.append(data)
        var lines: [Data] = []
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newlineIndex]
            lines.append(Data(line))
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
        }
        if buffer.count > maxLineBytes {
            throw DomBridgeError.frameTooLarge
        }
        return lines
    }
}

// Pure protocol logic for one bridge connection. The shim must authenticate first with the shared
// token, then may send dom-batch frames. State does not leak across connections: each new
// connection constructs a fresh session, so a reconnecting shim re-authenticates.
struct DomBridgeSession {
    enum Action: Equatable {
        case ack
        case forwardBatch(raw: Data, envelope: DomBatchEnvelope)
        case reject(String)
        case ignore
    }

    private let expectedToken: String
    private var authenticated = false

    init(expectedToken: String) {
        self.expectedToken = expectedToken
    }

    mutating func accept(line: Data) -> Action {
        if line.isEmpty { return .ignore }
        guard let header = try? JSONDecoder().decode(DomBridgeFrameType.self, from: line) else {
            return .reject("malformed")
        }

        if !authenticated {
            guard header.type == "auth",
                  let auth = try? JSONDecoder().decode(DomBridgeAuthFrame.self, from: line),
                  auth.version == 1,
                  auth.token == expectedToken
            else {
                return .reject("bad-auth")
            }
            authenticated = true
            return .ack
        }

        switch header.type {
        case "dom-batch":
            guard let envelope = try? JSONDecoder().decode(DomBatchEnvelope.self, from: line) else {
                return .reject("malformed")
            }
            return .forwardBatch(raw: line, envelope: envelope)
        default:
            return .reject("unknown")
        }
    }
}

// Minimal decode of just the discriminator, so the session can branch before decoding the full body.
private struct DomBridgeFrameType: Decodable {
    let type: String
    enum CodingKeys: String, CodingKey { case type = "t" }
}

private struct DomBridgeAuthFrame: Decodable {
    let type: String
    let version: Int?
    let token: String?
    enum CodingKeys: String, CodingKey {
        case type = "t"
        case version = "v"
        case token
    }
}
