import Darwin
import Foundation
import Network
import os
import AgentDeskWire

enum TerminalClientBridgeError: Error {
    case invalidSocketPath
    case socketConnectFailed(errno: Int32)
    case socketClosed
    case unexpectedRole(QuicSessionStreamRole)
}

@available(macOS 26.0, *)
final class TerminalClientBridge: @unchecked Sendable {
    private let stream: QUIC.Stream<QUICStream>
    private let socketURL: URL
    private let fingerprint: DeviceFingerprint
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal")
    private let stateLock = NSLock()
    private var relayTask: Task<Void, Never>?
    private var activeSocket: LengthPrefixedUnixSocket?
    private var stopped = false
    var onClose: (() -> Void)?

    init(
        stream: QUIC.Stream<QUICStream>,
        socketURL: URL = Config.ptyManagerSocketURL,
        fingerprint: DeviceFingerprint
    ) {
        self.stream = stream
        self.socketURL = socketURL
        self.fingerprint = fingerprint
    }

    func start() {
        stateLock.lock()
        guard relayTask == nil, !stopped else {
            stateLock.unlock()
            return
        }
        let task = Task {
            await self.run()
        }
        relayTask = task
        stateLock.unlock()
    }

    func stop() {
        stateLock.lock()
        stopped = true
        let task = relayTask
        let socket = activeSocket
        relayTask = nil
        activeSocket = nil
        stateLock.unlock()

        socket?.close()
        task?.cancel()
    }

    private func run() async {
        var socketForCleanup: LengthPrefixedUnixSocket?
        defer {
            finish(socket: socketForCleanup)
            onClose?()
        }
        do {
            let socket = try LengthPrefixedUnixSocket(path: socketURL.path)
            socketForCleanup = socket
            guard registerActiveSocket(socket) else {
                socket.close()
                return
            }
            logger.notice("terminal bridge attached fp=\(self.fingerprint.rawValue, privacy: .public)")
            try await withTaskCancellationHandler {
                try await relay(socket)
            } onCancel: {
                socket.close()
            }
        } catch {
            logger.notice("terminal bridge ended fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
        }
    }

    private func registerActiveSocket(_ socket: LengthPrefixedUnixSocket) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !stopped else { return false }
        activeSocket = socket
        return true
    }

    private func finish(socket: LengthPrefixedUnixSocket?) {
        stateLock.lock()
        if let socket, activeSocket === socket {
            activeSocket = nil
        }
        relayTask = nil
        stateLock.unlock()
        socket?.close()
    }

    private func relay(_ socket: LengthPrefixedUnixSocket) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await self.relayClientToManager(socket) }
            group.addTask { try await self.relayManagerToClient(socket) }

            do {
                _ = try await group.next()
                group.cancelAll()
                socket.close()
                while try await group.next() != nil {}
            } catch {
                group.cancelAll()
                socket.close()
                throw error
            }
        }
    }

    private func relayClientToManager(_ socket: LengthPrefixedUnixSocket) async throws {
        while !Task.isCancelled {
            let frame = try await QuicSessionStreamIO.receiveFrame(on: stream)
            guard frame.role == .terminal else {
                throw TerminalClientBridgeError.unexpectedRole(frame.role)
            }
            try socket.sendFrame(frame.payload)
        }
    }

    private func relayManagerToClient(_ socket: LengthPrefixedUnixSocket) async throws {
        while !Task.isCancelled {
            let payload = try socket.receiveFrame()
            try await QuicSessionStreamIO.sendPayload(payload, role: .terminal, on: stream)
        }
    }
}

final class LengthPrefixedUnixSocket: @unchecked Sendable {
    private static let maxFrameLength = QuicSessionStreamFrame.maxFrameLength

    private let fd: Int32
    private let writeLock = NSLock()
    private let closeLock = NSLock()
    private var closed = false

    init(path: String) throws {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw TerminalClientBridgeError.socketConnectFailed(errno: errno)
        }
        fd = descriptor

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < maxPathLength else {
            Darwin.close(descriptor)
            throw TerminalClientBridgeError.invalidSocketPath
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: pathBytes)
            buffer[pathBytes.count] = 0
        }

        let length = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(descriptor, sockaddrPointer, length)
            }
        }
        guard result == 0 else {
            let err = errno
            Darwin.close(descriptor)
            throw TerminalClientBridgeError.socketConnectFailed(errno: err)
        }
    }

    func sendFrame(_ payload: Data) throws {
        guard payload.count <= Self.maxFrameLength else {
            throw QuicSessionFrameError.frameTooLarge
        }
        var header = Data()
        header.appendUInt32BE(UInt32(payload.count))
        writeLock.lock()
        defer { writeLock.unlock() }
        try writeAll(header)
        try writeAll(payload)
    }

    func receiveFrame() throws -> Data {
        let header = try readExact(count: 4)
        let length = Int(try header.readUInt32BE(at: 0))
        guard length <= Self.maxFrameLength else {
            throw QuicSessionFrameError.frameTooLarge
        }
        return try readExact(count: length)
    }

    func close() {
        closeLock.lock()
        defer { closeLock.unlock() }
        guard !closed else { return }
        closed = true
        Darwin.shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }

    private func readExact(count: Int) throws -> Data {
        var data = Data(count: count)
        var offset = 0
        while offset < count {
            let readCount = data.withUnsafeMutableBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return -1 }
                return Darwin.read(fd, base.advanced(by: offset), count - offset)
            }
            if readCount == 0 { throw TerminalClientBridgeError.socketClosed }
            if readCount < 0 {
                if errno == EINTR { continue }
                throw TerminalClientBridgeError.socketConnectFailed(errno: errno)
            }
            offset += readCount
        }
        return data
    }

    private func writeAll(_ data: Data) throws {
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return -1 }
                return Darwin.write(fd, base.advanced(by: offset), data.count - offset)
            }
            if written == 0 { throw TerminalClientBridgeError.socketClosed }
            if written < 0 {
                if errno == EINTR { continue }
                throw TerminalClientBridgeError.socketConnectFailed(errno: errno)
            }
            offset += written
        }
    }
}
