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

/// What a component may do to a live predecessor that a handover could not replace.
///
/// This asymmetry is the whole reason a code update can no longer end a session. `pty-vault` holds
/// the only durable master descriptor for every session, so terminating it closes the last master
/// and SIGHUPs every child on the machine. `pty-manager` holds duplicate leases and re-adopts the
/// vault's sessions when it cold starts (`recover_vault_sessions`), so replacing it costs bounded
/// replay state and nothing else. See ADR-0080.
enum HostPtyRuntimeRecovery: Equatable {
    /// Never terminate a live predecessor. A failed update leaves the older binary serving.
    case keepPredecessor
    /// Terminate a live predecessor and cold start. Sessions live in the vault and are re-adopted.
    case replacePredecessor
}

/// What to do after an intended action could not be carried out.
enum HostPtyRuntimeRecoveryDecision: Equatable {
    /// Leave the older binary serving. Sessions are intact; the bundled binary is not in use.
    case keepPredecessor(reason: String)
    /// Terminate any live predecessor, then launch the bundled binary fresh.
    case coldStart
    /// Nothing can serve this component.
    case fail(reason: String)
}

/// The result of bringing one component up.
enum HostPtyRuntimeOutcome: Equatable {
    case ready
    /// Serving, but not from the bundled binary. Terminals work; the binary lags until its
    /// sessions end naturally.
    case degraded(reason: String)
    case failed(reason: String)
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
                reason: "live PTY runtime has no matching durable identity"
            )
        }
        return recordedIdentity.digest == bundledDigest ? .preserve(peer) : .handover(peer)
    }

    /// Chooses what happens after a handover attempt failed or a decision blocked.
    ///
    /// A live vault is always kept, which is what makes "sessions never end" structural rather than
    /// a promise: the only branch that terminates anything requires `.replacePredecessor`, and the
    /// only component that carries it is the disposable one.
    static func recover(
        recovery: HostPtyRuntimeRecovery,
        predecessorAlive: Bool,
        reason: String
    ) -> HostPtyRuntimeRecoveryDecision {
        switch recovery {
        case .keepPredecessor:
            return predecessorAlive ? .keepPredecessor(reason: reason) : .coldStart
        case .replacePredecessor:
            return .coldStart
        }
    }
}

final class HostPtyRuntimeProcess: @unchecked Sendable {
    private static let executablePathBufferLength = 4 * 1_024
    private static let diagnosticsTailLength = 2 * 1_024

    private enum Component: String {
        case vault
        case manager
    }

    private let vaultBinaryURL: URL
    private let managerBinaryURL: URL
    private let vaultSocketURL: URL
    private let managerSocketURL: URL
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal")
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).pty-runtime-process")
    private var processes: [Component: Process] = [:]
    private let readinessLock = NSLock()
    private var readiness: Bool?
    private var readinessWaiters: [CheckedContinuation<Bool, Never>] = []

    init(
        vaultBinaryURL: URL,
        managerBinaryURL: URL,
        vaultSocketURL: URL = Config.ptyVaultSocketURL,
        managerSocketURL: URL = Config.ptyManagerSocketURL
    ) {
        self.vaultBinaryURL = vaultBinaryURL
        self.managerBinaryURL = managerBinaryURL
        self.vaultSocketURL = vaultSocketURL
        self.managerSocketURL = managerSocketURL
    }

    static func managerLaunchArguments(
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

    /// Resolves true once both components are verified up, false if the launch was blocked or threw.
    /// `start()` returns immediately and does its work on a background queue, so anything that needs
    /// to talk to the manager - every window restore - awaits this instead of racing the socket.
    func waitUntilReady() async -> Bool {
        await withCheckedContinuation { continuation in
            readinessLock.lock()
            if let readiness {
                readinessLock.unlock()
                continuation.resume(returning: readiness)
                return
            }
            readinessWaiters.append(continuation)
            readinessLock.unlock()
        }
    }

    private func settleReadiness(_ ready: Bool) {
        readinessLock.lock()
        guard readiness == nil else {
            readinessLock.unlock()
            return
        }
        readiness = ready
        let waiters = readinessWaiters
        readinessWaiters.removeAll()
        readinessLock.unlock()
        for waiter in waiters { waiter.resume(returning: ready) }
    }

    private func startOnQueue() {
        settleReadiness(launchComponents())
    }

    private func launchComponents() -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: managerSocketURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            // The vault step never aborts the manager step. A vault that could not be replaced is
            // still serving every live session, and the manager it serves must still be brought up
            // to date, or the host ends up with intact sessions it cannot reach.
            let vault = try ensure(
                component: .vault,
                binaryURL: vaultBinaryURL,
                socketURL: vaultSocketURL,
                recovery: .keepPredecessor,
                arguments: {
                    Self.vaultLaunchArguments(
                        socketURL: $0,
                        handover: $1,
                        runtimeDigest: $2
                    )
                }
            )
            if case .failed(let reason) = vault {
                logger.error("PTY vault unavailable reason=\(reason, privacy: .public)")
                return false
            }
            let manager = try ensure(
                component: .manager,
                binaryURL: managerBinaryURL,
                socketURL: managerSocketURL,
                recovery: .replacePredecessor,
                arguments: {
                    Self.managerLaunchArguments(
                        socketURL: $0,
                        handover: $1,
                        runtimeDigest: $2
                    )
                }
            )
            if case .failed(let reason) = manager {
                logger.error("PTY manager unavailable reason=\(reason, privacy: .public)")
                return false
            }
            if case .degraded(let reason) = vault {
                logger.error("PTY runtime ready with a lagging vault binary; live sessions are intact and the bundled vault is not in use reason=\(reason, privacy: .public)")
            } else {
                logger.notice("PTY runtime ready manager=\(self.managerSocketURL.path, privacy: .public) vault=\(self.vaultSocketURL.path, privacy: .public)")
            }
            return true
        } catch {
            logger.error("PTY runtime launch failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    private func ensure(
        component: Component,
        binaryURL: URL,
        socketURL: URL,
        recovery: HostPtyRuntimeRecovery,
        arguments: (URL, Bool, String) -> [String]
    ) throws -> HostPtyRuntimeOutcome {
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
            let launched = try launch(
                component: component,
                binaryURL: binaryURL,
                socketURL: socketURL,
                digest: bundledDigest,
                arguments: arguments(socketURL, false, bundledDigest ?? "")
            )
            return launched ? .ready : .failed(reason: "cold start did not activate")
        case .preserve(let peer):
            logger.notice("PTY \(component.rawValue, privacy: .public) unchanged pid=\(peer.pid, privacy: .public)")
            return .ready
        case .handover(let peer):
            logger.notice("PTY \(component.rawValue, privacy: .public) update handover oldPid=\(peer.pid, privacy: .public)")
            if try launch(
                component: component,
                binaryURL: binaryURL,
                socketURL: socketURL,
                digest: bundledDigest,
                arguments: arguments(socketURL, true, bundledDigest ?? "")
            ) {
                return .ready
            }
            return try recover(
                component: component,
                binaryURL: binaryURL,
                socketURL: socketURL,
                digest: bundledDigest,
                recovery: recovery,
                reason: "handover candidate did not activate: \(candidateDiagnostics(component: component, socketURL: socketURL))",
                arguments: arguments
            )
        case .block(let reason):
            logger.error("PTY \(component.rawValue, privacy: .public) blocked reason=\(reason, privacy: .public)")
            // Without a readable bundled binary there is nothing to fall back to.
            guard bundledDigest != nil else { return .failed(reason: reason) }
            return try recover(
                component: component,
                binaryURL: binaryURL,
                socketURL: socketURL,
                digest: bundledDigest,
                recovery: recovery,
                reason: reason,
                arguments: arguments
            )
        }
    }

    /// The ladder that keeps a code update from ever ending a session.
    ///
    /// Reached only when the intended action failed. A live vault is kept and the host carries on
    /// with a lagging binary; a manager is replaced, because the vault still holds every master
    /// descriptor and a cold-started manager re-adopts them.
    private func recover(
        component: Component,
        binaryURL: URL,
        socketURL: URL,
        digest: String?,
        recovery: HostPtyRuntimeRecovery,
        reason: String,
        arguments: (URL, Bool, String) -> [String]
    ) throws -> HostPtyRuntimeOutcome {
        discardCandidateIfIdle(component: component, socketURL: socketURL)
        let alive = socketPeer(socketURL: socketURL) != nil
        switch HostPtyRuntimeSocketVerifier.recover(
            recovery: recovery,
            predecessorAlive: alive,
            reason: reason
        ) {
        case .keepPredecessor(let reason):
            logger.error("PTY \(component.rawValue, privacy: .public) kept the previous generation; its sessions are intact and the bundled binary is not in use reason=\(reason, privacy: .public)")
            return .degraded(reason: reason)
        case .coldStart:
            if alive {
                terminatePredecessor(component: component, socketURL: socketURL)
            }
            logger.notice("PTY \(component.rawValue, privacy: .public) cold starting after a failed update reason=\(reason, privacy: .public)")
            let launched = try launch(
                component: component,
                binaryURL: binaryURL,
                socketURL: socketURL,
                digest: digest,
                arguments: arguments(socketURL, false, digest ?? "")
            )
            return launched
                ? .ready
                : .failed(reason: "cold start after a failed update did not activate: \(candidateDiagnostics(component: component, socketURL: socketURL))")
        case .fail(let reason):
            return .failed(reason: reason)
        }
    }

    /// Cleans up a candidate that failed without taking over, so it does not linger beside the
    /// generation that is actually serving.
    ///
    /// A candidate that *did* take the socket is deliberately left alone: reaching that point means
    /// the previous generation already handed its descriptors across and exited, so this process is
    /// now the only holder of every master and killing it would end every session.
    private func discardCandidateIfIdle(component: Component, socketURL: URL) {
        guard let process = processes[component], process.isRunning else { return }
        guard socketPeer(socketURL: socketURL)?.pid != process.processIdentifier else { return }
        logger.notice("PTY \(component.rawValue, privacy: .public) discarding candidate pid=\(process.processIdentifier, privacy: .public) that never took the socket")
        process.terminate()
        processes[component] = nil
    }

    /// Ends a predecessor that is safe to replace. Only ever reached for `.replacePredecessor`.
    private func terminatePredecessor(
        component: Component,
        socketURL: URL,
        timeout: TimeInterval = Config.ptyRuntimePeerTimeoutSeconds
    ) {
        guard let peer = socketPeer(socketURL: socketURL) else { return }
        logger.notice("PTY \(component.rawValue, privacy: .public) replacing predecessor pid=\(peer.pid, privacy: .public); vault-held sessions survive and are re-adopted")
        Darwin.kill(peer.pid, SIGTERM)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if socketPeer(socketURL: socketURL)?.pid != peer.pid { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
        logger.error("PTY \(component.rawValue, privacy: .public) predecessor pid=\(peer.pid, privacy: .public) ignored SIGTERM; escalating")
        Darwin.kill(peer.pid, SIGKILL)
        let killDeadline = Date().addingTimeInterval(timeout)
        while Date() < killDeadline {
            if socketPeer(socketURL: socketURL)?.pid != peer.pid { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    /// The candidate's own account of why it stopped. Without this the Rust protocol error that
    /// explains a failed handover goes to the null device and the host reports only "did not
    /// activate".
    private func candidateDiagnostics(component: Component, socketURL: URL) -> String {
        guard let contents = try? String(
            contentsOf: Self.diagnosticsURL(component: component, socketURL: socketURL),
            encoding: .utf8
        ) else { return "no candidate output" }
        let trimmed = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "no candidate output" }
        return String(trimmed.suffix(Self.diagnosticsTailLength))
            .replacingOccurrences(of: "\n", with: " | ")
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
        // Truncated per launch, so it holds this generation's output only. The daemons log a
        // handful of lines over a process lifetime, so this cannot grow without bound.
        let diagnostics = Self.diagnosticsURL(component: component, socketURL: socketURL)
        FileManager.default.createFile(atPath: diagnostics.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: diagnostics) {
            process.standardOutput = handle
            process.standardError = handle
        } else {
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
        }
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

    private static func diagnosticsURL(component: Component, socketURL: URL) -> URL {
        socketURL.deletingLastPathComponent()
            .appendingPathComponent("\(component.rawValue).log", isDirectory: false)
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
