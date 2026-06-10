import Darwin
import Foundation
import os
import Security

final class AgentSayLocalServer: @unchecked Sendable {
    typealias Broadcaster = @MainActor (AgentSayPush) -> Bool

    enum Constants {
        static let maxLineBytes = 8 * 1024
        static let maxChunkBytes = 4 * 1024
        static let maxTotalBytes = 64 * 1024
        static let maxChunks = 512
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "agent-say")
    private let socketURL: URL
    private let tokenURL: URL
    private let supportDirectory: URL
    private let broadcaster: Broadcaster
    private let queue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.agent-say")
    private var listenFD: Int32 = -1
    private var stopped = false

    init(
        socketURL: URL = Config.adSocketURL,
        tokenURL: URL = Config.adTokenURL,
        supportDirectory: URL = Config.applicationSupportDirectory,
        broadcaster: @escaping Broadcaster
    ) {
        self.socketURL = socketURL
        self.tokenURL = tokenURL
        self.supportDirectory = supportDirectory
        self.broadcaster = broadcaster
    }

    func start() {
        queue.async { [weak self] in
            self?.startOnQueue()
        }
    }

    func stop() {
        stopped = true
        if listenFD >= 0 {
            Darwin.close(listenFD)
            listenFD = -1
        }
        unlink(socketURL.path)
    }

    private func startOnQueue() {
        do {
            _ = try ensureToken()
            try bindSocket()
            acceptLoop()
        } catch {
            logger.error("agent-say server failed: \(String(describing: error), privacy: .public)")
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
            return try String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard result == errSecSuccess else {
            throw AgentSayLocalError.tokenGenerationFailed
        }
        let token = Data(bytes).base64EncodedString()
        try (token + "\n").write(to: tokenURL, atomically: true, encoding: .utf8)
        chmod(tokenURL.path, 0o600)
        return token
    }

    private func bindSocket() throws {
        unlink(socketURL.path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw AgentSayLocalError.socketFailed(errno) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        try socketURL.path.withCString { pathPointer in
            guard strlen(pathPointer) < maxPathLength else {
                throw AgentSayLocalError.socketPathTooLong
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
            throw AgentSayLocalError.bindFailed(err)
        }
        chmod(socketURL.path, 0o600)

        guard listen(fd, 8) == 0 else {
            let err = errno
            Darwin.close(fd)
            throw AgentSayLocalError.listenFailed(err)
        }
        listenFD = fd
        logger.notice("agent-say listening at \(self.socketURL.path, privacy: .public)")
    }

    private func acceptLoop() {
        while !stopped {
            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 {
                if stopped || errno == EBADF { return }
                logger.error("agent-say accept failed errno=\(errno, privacy: .public)")
                continue
            }
            handleConnection(clientFD)
        }
    }

    private func handleConnection(_ fd: Int32) {
        defer { Darwin.close(fd) }
        let token: String
        do {
            token = try ensureToken()
        } catch {
            writeResponse(.error("auth-unavailable"), to: fd)
            return
        }

        let reader = AgentSayLineReader(fd: fd, maxLineBytes: Constants.maxLineBytes)
        let session = AgentSayLocalSession(expectedToken: token)
        while true {
            let line: String?
            do {
                line = try reader.readLine()
            } catch {
                writeResponse(.error("malformed"), to: fd)
                return
            }
            guard let line else { return }

            let action = session.accept(line: line)
            switch action {
            case .ack:
                writeResponse(.ok, to: fd)
            case .broadcast(let push):
                if !broadcast(push) {
                    writeResponse(.error("no-client", id: push.id), to: fd)
                    return
                }
                if push.phase == "start" {
                    writeResponse(.ok, to: fd)
                }
            case .broadcastThenAccepted(let push):
                if !broadcast(push) {
                    writeResponse(.error("no-client", id: push.id), to: fd)
                    return
                }
                writeResponse(.accepted(push.id), to: fd)
            case .accepted(let id):
                writeResponse(.accepted(id), to: fd)
            case .reject(let code, let id):
                writeResponse(.error(code, id: id), to: fd)
                return
            }
        }
    }

    private func broadcast(_ push: AgentSayPush) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        final class Box: @unchecked Sendable { var value = false }
        let box = Box()
        Task { @MainActor [broadcaster] in
            box.value = broadcaster(push)
            semaphore.signal()
        }
        semaphore.wait()
        return box.value
    }

    private func writeResponse(_ response: AgentSayLocalResponse, to fd: Int32) {
        guard let data = try? JSONEncoder().encode(response) else { return }
        _ = data.withUnsafeBytes { buffer in
            Darwin.write(fd, buffer.baseAddress, data.count)
        }
        _ = "\n".withCString { pointer in
            Darwin.write(fd, pointer, 1)
        }
    }
}

enum AgentSayLocalError: Error {
    case tokenGenerationFailed
    case socketFailed(Int32)
    case bindFailed(Int32)
    case listenFailed(Int32)
    case socketPathTooLong
}

final class AgentSayLocalSession {
    enum Action: Equatable {
        case ack
        case broadcast(AgentSayPush)
        case broadcastThenAccepted(AgentSayPush)
        case accepted(String)
        case reject(String, id: String? = nil)
    }

    private let expectedToken: String
    private var authenticated = false
    private var activeID: String?
    private var nextSequence = 0
    private var totalBytes = 0
    private var chunkCount = 0

    init(expectedToken: String) {
        self.expectedToken = expectedToken
    }

    func accept(line: String) -> Action {
        guard let data = line.data(using: .utf8),
              let frame = try? JSONDecoder().decode(AgentSayLocalFrame.self, from: data)
        else {
            return .reject("malformed")
        }

        if !authenticated {
            guard frame.type == "auth", frame.version == 1, frame.token == expectedToken else {
                return .reject("bad-auth")
            }
            authenticated = true
            return .ack
        }

        switch frame.type {
        case "say-start":
            guard activeID == nil, let id = frame.id, !id.isEmpty else {
                return .reject("bad-sequence", id: frame.id)
            }
            activeID = id
            nextSequence = 0
            totalBytes = 0
            chunkCount = 0
            return .broadcast(AgentSayPush(id: id, phase: "start"))
        case "say-chunk":
            guard let id = frame.id, id == activeID else {
                return .reject("bad-sequence", id: frame.id)
            }
            guard frame.sequence == nextSequence, let text = frame.text else {
                return .reject("bad-sequence", id: id)
            }
            let bytes = text.utf8.count
            guard bytes <= AgentSayLocalServer.Constants.maxChunkBytes else {
                return .reject("too-large", id: id)
            }
            totalBytes += bytes
            chunkCount += 1
            guard totalBytes <= AgentSayLocalServer.Constants.maxTotalBytes,
                  chunkCount <= AgentSayLocalServer.Constants.maxChunks
            else {
                return .reject("too-large", id: id)
            }
            let sequence = nextSequence
            nextSequence += 1
            return .broadcast(AgentSayPush(id: id, phase: "chunk", sequence: sequence, text: text))
        case "say-end":
            guard let id = frame.id, id == activeID else {
                return .reject("bad-sequence", id: frame.id)
            }
            activeID = nil
            return .broadcastThenAccepted(AgentSayPush(id: id, phase: "end"))
        default:
            return .reject("unknown", id: frame.id)
        }
    }
}

private struct AgentSayLocalFrame: Decodable {
    let type: String
    let version: Int?
    let token: String?
    let id: String?
    let sequence: Int?
    let text: String?

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case version = "v"
        case token
        case id
        case sequence = "seq"
        case text
    }
}

struct AgentSayLocalResponse: Encodable, Equatable {
    let type: String
    let code: String?
    let id: String?

    static let ok = AgentSayLocalResponse(type: "ok", code: nil, id: nil)
    static func accepted(_ id: String) -> AgentSayLocalResponse {
        AgentSayLocalResponse(type: "accepted", code: nil, id: id)
    }
    static func error(_ code: String, id: String? = nil) -> AgentSayLocalResponse {
        AgentSayLocalResponse(type: "error", code: code, id: id)
    }

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case code
        case id
    }
}

private final class AgentSayLineReader {
    private let fd: Int32
    private let maxLineBytes: Int
    private var buffer = Data()

    init(fd: Int32, maxLineBytes: Int) {
        self.fd = fd
        self.maxLineBytes = maxLineBytes
    }

    func readLine() throws -> String? {
        while true {
            if let newline = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[..<newline]
                buffer.removeSubrange(...newline)
                return String(data: Data(lineData), encoding: .utf8)
            }
            guard buffer.count <= maxLineBytes else {
                throw AgentSayLineError.tooLong
            }
            var chunk = [UInt8](repeating: 0, count: 1024)
            let count = Darwin.read(fd, &chunk, chunk.count)
            if count == 0 {
                if buffer.isEmpty { return nil }
                let lineData = buffer
                buffer.removeAll()
                return String(data: Data(lineData), encoding: .utf8)
            }
            guard count > 0 else {
                throw AgentSayLineError.readFailed(errno)
            }
            buffer.append(contentsOf: chunk[..<count])
        }
    }
}

private enum AgentSayLineError: Error {
    case tooLong
    case readFailed(Int32)
}
