import Darwin
import CryptoKit
import Foundation
import os

struct HostPtyManagerSocketPeer: Equatable {
    let pid: pid_t
    let executablePath: String
}

enum HostPtyManagerSocketDecision: Equatable {
    case preserve(HostPtyManagerSocketPeer)
    case terminate(peer: HostPtyManagerSocketPeer, reason: String)
    case block(reason: String)
}

enum HostPtyManagerSocketVerifier {
    static func decide(
        peer: HostPtyManagerSocketPeer?,
        bundledDigest: String?,
        peerDigest: String?
    ) -> HostPtyManagerSocketDecision {
        guard let peer else {
            return .block(reason: "socket accepted a connection but peer process could not be resolved")
        }
        guard let bundledDigest else {
            return .block(reason: "bundled pty-manager digest could not be read")
        }
        guard let peerDigest else {
            return .block(reason: "live pty-manager digest could not be read")
        }
        guard peerDigest == bundledDigest else {
            return .terminate(peer: peer, reason: "live pty-manager binary hash differs from bundled binary")
        }
        return .preserve(peer)
    }
}

final class HostPtyManagerProcess: @unchecked Sendable {
    private static let executablePathBufferLength = 4 * 1_024

    private let binaryURL: URL
    private let socketURL: URL
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal")
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).pty-manager-process")
    private var process: Process?

    init(binaryURL: URL, socketURL: URL = Config.ptyManagerSocketURL) {
        self.binaryURL = binaryURL
        self.socketURL = socketURL
    }

    func start() {
        queue.async { [weak self] in
            self?.startOnQueue()
        }
    }

    private func startOnQueue() {
        guard process == nil else { return }
        do {
            try FileManager.default.createDirectory(
                at: socketURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if let descriptor = connectSocket() {
                let decision = existingSocketDecision(descriptor: descriptor)
                Darwin.close(descriptor)
                switch decision {
                case .preserve(let peer):
                    logger.notice("pty-manager already listening socket=\(self.socketURL.path, privacy: .public) pid=\(peer.pid, privacy: .public)")
                    return
                case .terminate(let peer, let reason):
                    logger.notice("pty-manager restart required reason=\(reason, privacy: .public) pid=\(peer.pid, privacy: .public)")
                    terminateSocketPeer(peer)
                    guard waitForSocketToStopAccepting() else {
                        logger.error("pty-manager incompatible peer still listening socket=\(self.socketURL.path, privacy: .public) pid=\(peer.pid, privacy: .public)")
                        return
                    }
                case .block(let reason):
                    logger.error("pty-manager live socket rejected reason=\(reason, privacy: .public) socket=\(self.socketURL.path, privacy: .public)")
                    return
                }
            }
            let proc = Process()
            proc.executableURL = binaryURL
            proc.arguments = ["--socket", socketURL.path]
            proc.environment = ProcessInfo.processInfo.environment
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            proc.terminationHandler = { [weak self] finished in
                let status = finished.terminationStatus
                self?.queue.async { [weak self] in
                    guard let self else { return }
                    self.process = nil
                    self.logger.notice("pty-manager exited status=\(status, privacy: .public)")
                }
            }
            try proc.run()
            process = proc
            logger.notice("pty-manager started socket=\(self.socketURL.path, privacy: .public)")
        } catch {
            logger.error("pty-manager launch failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func existingSocketDecision(descriptor: Int32) -> HostPtyManagerSocketDecision {
        let peer = socketPeer(descriptor: descriptor)
        return HostPtyManagerSocketVerifier.decide(
            peer: peer,
            bundledDigest: Self.sha256Hex(binaryURL),
            peerDigest: peer.flatMap { Self.sha256Hex(URL(fileURLWithPath: $0.executablePath)) }
        )
    }

    private func socketAcceptsConnection() -> Bool {
        guard let descriptor = connectSocket() else { return false }
        Darwin.close(descriptor)
        return true
    }

    private func connectSocket() -> Int32? {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketURL.path.utf8)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < maxPathLength else {
            Darwin.close(descriptor)
            return nil
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
            Darwin.close(descriptor)
            return nil
        }
        return descriptor
    }

    private func socketPeer(descriptor: Int32) -> HostPtyManagerSocketPeer? {
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout.size(ofValue: pid))
        let result = withUnsafeMutablePointer(to: &pid) { pointer in
            Darwin.getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, pointer, &length)
        }
        guard result == 0, pid > 0, let executablePath = Self.executablePath(pid: pid) else {
            return nil
        }
        return HostPtyManagerSocketPeer(pid: pid, executablePath: executablePath)
    }

    private func terminateSocketPeer(_ peer: HostPtyManagerSocketPeer) {
        if Darwin.kill(peer.pid, SIGTERM) == 0 {
            if waitForSocketToStopAccepting() { return }
        }
        _ = Darwin.kill(peer.pid, SIGKILL)
    }

    private func waitForSocketToStopAccepting(timeout: TimeInterval = 2.0) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !socketAcceptsConnection() { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return !socketAcceptsConnection()
    }

    private static func executablePath(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: executablePathBufferLength)
        let length = buffer.withUnsafeMutableBufferPointer { pointer in
            proc_pidpath(pid, pointer.baseAddress, UInt32(pointer.count))
        }
        guard length > 0 else { return nil }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func sha256Hex(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
