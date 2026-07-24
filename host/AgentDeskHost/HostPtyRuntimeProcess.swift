import Darwin
import CryptoKit
import Foundation
import os

struct HostPtyRuntimeSocketPeer: Equatable {
    let pid: pid_t
    let executablePath: String
}

struct HostPtyRuntimeIdentity: Codable, Equatable {
    let pid: pid_t
    let digest: String
}

enum HostPtyRuntimeSocketDecision: Equatable {
    case launch
    case preserve(HostPtyRuntimeSocketPeer)
    case handover(HostPtyRuntimeSocketPeer)
    case block(reason: String)
}

enum HostPtyRuntimeSocketVerifier {
    static func decide(
        peer: HostPtyRuntimeSocketPeer?,
        bundledExecutablePath: String,
        bundledDigest: String?,
        recordedIdentity: HostPtyRuntimeIdentity?
    ) -> HostPtyRuntimeSocketDecision {
        guard let bundledDigest else {
            return .block(reason: "bundled PTY runtime digest could not be read")
        }
        guard let peer else { return .launch }
        guard URL(fileURLWithPath: peer.executablePath).standardizedFileURL.path
            == URL(fileURLWithPath: bundledExecutablePath).standardizedFileURL.path
        else {
            return .block(reason: "live PTY runtime executable path differs from bundled runtime")
        }
        guard let recordedIdentity, recordedIdentity.pid == peer.pid else {
            return .block(
                reason: "live PTY runtime has no matching durable identity; use the explicit destructive reset"
            )
        }
        return recordedIdentity.digest == bundledDigest ? .preserve(peer) : .handover(peer)
    }
}

final class HostPtyRuntimeProcess: @unchecked Sendable {
    private static let executablePathBufferLength = 4 * 1_024

    private enum Component: String {
        case vault
        case manager
    }

    private let vaultBinaryURL: URL
    private let managerBinaryURL: URL
    private let vaultSocketURL: URL
    private let managerSocketURL: URL
    private let leasedSessionGraceSeconds: Int
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal")
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).pty-runtime-process")
    private var processes: [Component: Process] = [:]

    init(
        vaultBinaryURL: URL,
        managerBinaryURL: URL,
        vaultSocketURL: URL = Config.ptyVaultSocketURL,
        managerSocketURL: URL = Config.ptyManagerSocketURL,
        leasedSessionGraceSeconds: Int = Config.ptyLeasedSessionGraceSeconds
    ) {
        self.vaultBinaryURL = vaultBinaryURL
        self.managerBinaryURL = managerBinaryURL
        self.vaultSocketURL = vaultSocketURL
        self.managerSocketURL = managerSocketURL
        self.leasedSessionGraceSeconds = leasedSessionGraceSeconds
    }

    static func managerLaunchArguments(
        socketURL: URL,
        leasedSessionGraceSeconds: Int,
        handover: Bool = false,
        runtimeDigest: String? = nil
    ) -> [String] {
        var arguments = [
            "--socket", socketURL.path,
            "--leased-session-grace-seconds", String(leasedSessionGraceSeconds),
        ]
        if handover { arguments.append("--handover") }
        if let runtimeDigest {
            arguments.append(contentsOf: ["--runtime-digest", runtimeDigest])
        }
        return arguments
    }

    static func vaultLaunchArguments(
        socketURL: URL,
        handover: Bool = false,
        runtimeDigest: String? = nil
    ) -> [String] {
        var arguments = ["--socket", socketURL.path]
        if handover { arguments.append("--handover") }
        if let runtimeDigest {
            arguments.append(contentsOf: ["--runtime-digest", runtimeDigest])
        }
        return arguments
    }

    func start() {
        queue.async { [weak self] in
            self?.startOnQueue()
        }
    }

    private func startOnQueue() {
        do {
            try FileManager.default.createDirectory(
                at: managerSocketURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            guard try ensure(
                component: .vault,
                binaryURL: vaultBinaryURL,
                socketURL: vaultSocketURL,
                arguments: {
                    Self.vaultLaunchArguments(
                        socketURL: $0,
                        handover: $1,
                        runtimeDigest: $2
                    )
                }
            ) else { return }
            guard try ensure(
                component: .manager,
                binaryURL: managerBinaryURL,
                socketURL: managerSocketURL,
                arguments: {
                    Self.managerLaunchArguments(
                        socketURL: $0,
                        leasedSessionGraceSeconds: self.leasedSessionGraceSeconds,
                        handover: $1,
                        runtimeDigest: $2
                    )
                }
            ) else { return }
            logger.notice("PTY runtime ready manager=\(self.managerSocketURL.path, privacy: .public) vault=\(self.vaultSocketURL.path, privacy: .public)")
        } catch {
            logger.error("PTY runtime launch failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func ensure(
        component: Component,
        binaryURL: URL,
        socketURL: URL,
        arguments: (URL, Bool, String) -> [String]
    ) throws -> Bool {
        let bundledDigest = Self.sha256Hex(binaryURL)
        let peer = socketPeer(socketURL: socketURL)
        let decision = HostPtyRuntimeSocketVerifier.decide(
            peer: peer,
            bundledExecutablePath: binaryURL.path,
            bundledDigest: bundledDigest,
            recordedIdentity: runtimeIdentity(socketURL: socketURL)
        )
        switch decision {
        case .launch:
            return try launch(
                component: component,
                binaryURL: binaryURL,
                socketURL: socketURL,
                digest: bundledDigest,
                arguments: arguments(socketURL, false, bundledDigest ?? "")
            )
        case .preserve(let peer):
            logger.notice("PTY \(component.rawValue, privacy: .public) unchanged pid=\(peer.pid, privacy: .public)")
            return true
        case .handover(let peer):
            logger.notice("PTY \(component.rawValue, privacy: .public) update handover oldPid=\(peer.pid, privacy: .public)")
            return try launch(
                component: component,
                binaryURL: binaryURL,
                socketURL: socketURL,
                digest: bundledDigest,
                arguments: arguments(socketURL, true, bundledDigest ?? "")
            )
        case .block(let reason):
            logger.error("PTY \(component.rawValue, privacy: .public) blocked reason=\(reason, privacy: .public)")
            return false
        }
    }

    private func launch(
        component: Component,
        binaryURL: URL,
        socketURL: URL,
        digest: String?,
        arguments: [String]
    ) throws -> Bool {
        guard let digest else { return false }
        let process = Process()
        process.executableURL = binaryURL
        process.arguments = arguments
        process.environment = ProcessInfo.processInfo.environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [runtime = self] finished in
            let status = finished.terminationStatus
            runtime.queue.async {
                runtime.processes[component] = nil
                runtime.logger.notice("PTY \(component.rawValue, privacy: .public) exited status=\(status, privacy: .public)")
            }
        }
        try process.run()
        processes[component] = process
        guard waitForPeer(socketURL: socketURL, pid: process.processIdentifier) else {
            logger.error("PTY \(component.rawValue, privacy: .public) candidate failed to activate pid=\(process.processIdentifier, privacy: .public)")
            return false
        }
        return waitForIdentity(
            socketURL: socketURL,
            expected: HostPtyRuntimeIdentity(pid: process.processIdentifier, digest: digest)
        )
    }

    private func waitForPeer(
        socketURL: URL,
        pid: pid_t,
        timeout: TimeInterval = Config.ptyRuntimePeerTimeoutSeconds
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if socketPeer(socketURL: socketURL)?.pid == pid { return true }
            if processes.values.contains(where: { $0.processIdentifier == pid && !$0.isRunning }) {
                return false
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return socketPeer(socketURL: socketURL)?.pid == pid
    }

    private func socketPeer(socketURL: URL) -> HostPtyRuntimeSocketPeer? {
        guard let descriptor = connectSocket(socketURL: socketURL) else { return nil }
        defer { Darwin.close(descriptor) }
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout.size(ofValue: pid))
        let result = withUnsafeMutablePointer(to: &pid) { pointer in
            Darwin.getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, pointer, &length)
        }
        guard result == 0, pid > 0, let path = Self.executablePath(pid: pid) else {
            return nil
        }
        return HostPtyRuntimeSocketPeer(pid: pid, executablePath: path)
    }

    private func connectSocket(socketURL: URL) -> Int32? {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketURL.path.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            Darwin.close(descriptor)
            return nil
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: pathBytes)
            buffer[pathBytes.count] = 0
        }
        let length = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, length)
            }
        }
        guard result == 0 else {
            Darwin.close(descriptor)
            return nil
        }
        return descriptor
    }

    private func runtimeIdentity(socketURL: URL) -> HostPtyRuntimeIdentity? {
        guard let data = try? Data(contentsOf: Self.identityURL(socketURL: socketURL)) else {
            return nil
        }
        return try? JSONDecoder().decode(HostPtyRuntimeIdentity.self, from: data)
    }

    private func waitForIdentity(
        socketURL: URL,
        expected: HostPtyRuntimeIdentity,
        timeout: TimeInterval = Config.ptyRuntimeIdentityTimeoutSeconds
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if runtimeIdentity(socketURL: socketURL) == expected { return true }
            Thread.sleep(forTimeInterval: 0.025)
        }
        logger.error("PTY runtime identity was not published socket=\(socketURL.path, privacy: .public)")
        return runtimeIdentity(socketURL: socketURL) == expected
    }

    private static func identityURL(socketURL: URL) -> URL {
        socketURL.deletingLastPathComponent()
            .appendingPathComponent("\(socketURL.lastPathComponent).identity", isDirectory: false)
    }

    private static func executablePath(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: executablePathBufferLength)
        let length = buffer.withUnsafeMutableBufferPointer {
            proc_pidpath(pid, $0.baseAddress, UInt32($0.count))
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
