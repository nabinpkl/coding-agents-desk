import Darwin
import Foundation

public final class UnixSocketPtyTransport: PtyTransport, @unchecked Sendable {
    private let socketPath: String
    private var descriptor: Int32 = -1
    private let stateLock = NSLock()
    private let readLock = NSLock()
    private let writeLock = NSLock()

    public init(socketPath: String = "/tmp/pty-manager.sock") throws {
        self.socketPath = socketPath
        try connect()
    }

    init(connectedDescriptor: Int32, socketPath: String = "<connected>") throws {
        self.socketPath = socketPath
        try Self.disableSigpipe(on: connectedDescriptor)
        descriptor = connectedDescriptor
    }

    deinit {
        close()
    }

    public func sendFrame(_ data: Data) async throws {
        let frame = try PtyFraming.encodeFrame(data)
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result { try self.writeAll(frame) })
            }
        }
    }

    public func receiveFrame() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result {
                    let header = try self.readExact(byteCount: MemoryLayout<UInt32>.size)
                    let length = header.reduce(UInt32(0)) { value, byte in
                        (value << 8) | UInt32(byte)
                    }
                    guard length <= PtyFraming.maxFrameLength else {
                        throw PtyClientError.invalidFrameLength(Int(length))
                    }
                    return try self.readExact(byteCount: Int(length))
                })
            }
        }
    }

    public func close() {
        stateLock.lock()
        guard descriptor >= 0 else {
            stateLock.unlock()
            return
        }
        let closingDescriptor = descriptor
        descriptor = -1
        stateLock.unlock()

        Darwin.shutdown(closingDescriptor, SHUT_RDWR)
        readLock.lock()
        readLock.unlock()
        writeLock.lock()
        writeLock.unlock()
        Darwin.close(closingDescriptor)
    }

    private func connect() throws {
        guard socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw PtyClientError.socketPathUnavailable(socketPath)
        }

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        do {
            try Self.disableSigpipe(on: fd)
        } catch {
            Darwin.close(fd)
            throw error
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutableBytes(of: &address.sun_path) { pathBytes in
            socketPath.withCString { path in
                strncpy(pathBytes.baseAddress!.assumingMemoryBound(to: CChar.self), path, pathBytes.count - 1)
            }
        }

        let size = socklen_t(MemoryLayout<sa_family_t>.size + socketPath.utf8.count + 1)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(fd, sockaddrPointer, size)
            }
        }
        guard connected == 0 else {
            let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            Darwin.close(fd)
            throw error
        }

        descriptor = fd
    }

    private func writeAll(_ data: Data) throws {
        writeLock.lock()
        defer { writeLock.unlock() }
        try withOpenDescriptor { fd in
            try data.withUnsafeBytes { buffer in
                guard let base = buffer.baseAddress else { return }
                var offset = 0
                while offset < data.count {
                    let written = Darwin.write(fd, base.advanced(by: offset), data.count - offset)
                    if written < 0 {
                        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                    }
                    if written == 0 {
                        throw PtyClientError.closed
                    }
                    offset += written
                }
            }
        }
    }

    private func readExact(byteCount: Int) throws -> Data {
        readLock.lock()
        defer { readLock.unlock() }
        return try withOpenDescriptor { fd in
            var data = Data(count: byteCount)
            try data.withUnsafeMutableBytes { buffer in
                guard let base = buffer.baseAddress else { return }
                var offset = 0
                while offset < byteCount {
                    let read = Darwin.read(fd, base.advanced(by: offset), byteCount - offset)
                    if read < 0 {
                        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                    }
                    if read == 0 {
                        throw PtyClientError.closed
                    }
                    offset += read
                }
            }
            return data
        }
    }

    private func withOpenDescriptor<T>(_ body: (Int32) throws -> T) throws -> T {
        stateLock.lock()
        let fd = descriptor
        stateLock.unlock()
        guard fd >= 0 else { throw PtyClientError.closed }
        return try body(fd)
    }

    private static func disableSigpipe(on fd: Int32) throws {
        var enabled: Int32 = 1
        let result = withUnsafePointer(to: &enabled) { pointer in
            Darwin.setsockopt(
                fd,
                SOL_SOCKET,
                SO_NOSIGPIPE,
                pointer,
                socklen_t(MemoryLayout<Int32>.size)
            )
        }
        guard result == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

}
