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

/// What asking a socket whether anything is accepting on it answered.
enum HostPtyRuntimeSocketProbe: Equatable {
    case serving
    /// Nothing is bound to that path, so whoever the identity file names is a corpse.
    case refused
    /// The probe could not answer. Read as serving, because a probe's silence is not evidence.
    case inconclusive(code: Int32)
}

/// What to do when a daemon's own process exits.
enum HostPtyRuntimeRestartDecision: Equatable {
    /// Run the whole opening ladder again, vault first, then the manager that needs it.
    case relaunch
    case leave(reason: String)
}

/// The result of bringing one component up.
enum HostPtyRuntimeOutcome: Equatable {
    case ready
    /// Serving the bundled binary, but started clean rather than handed to. Its state was
    /// reconstructed, not transferred, which matters to whoever runs next.
    case recovered(reason: String)
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

    /// What a connect to a daemon's socket says about whether it is serving.
    ///
    /// Only two errno values mean the daemon is gone, and everything else is the probe failing
    /// rather than the daemon: out of descriptors, interrupted, a full accept backlog on a busy
    /// one. Reading those as death would cold start over a healthy runtime, so they answer
    /// `inconclusive` and the caller keeps what it has. The asymmetry is deliberate and it is this
    /// repo's absent-result rule in one expression: an absence is the cheapest thing a broken probe
    /// can produce, so only the two answers that positively mean "nothing is bound here" count.
    static func probe(connectErrno: Int32?) -> HostPtyRuntimeSocketProbe {
        guard let code = connectErrno else { return .serving }
        // ECONNREFUSED: the file is there and no process is listening on it. ENOENT: not even that.
        if code == ECONNREFUSED || code == ENOENT { return .refused }
        return .inconclusive(code: code)
    }

    /// Whether a daemon that exited on its own should be brought back.
    ///
    /// Only the manager is, and the asymmetry is ADR-0080's again, read the other way round. The
    /// vault holds the only master descriptor for every live session, so one that exits has already
    /// taken them with it and a fresh one comes up empty; whether a new one may be started is the
    /// manager's custody reseed to settle, not a termination handler's. The manager holds duplicate
    /// leases and re-adopts the vault's sessions when it cold starts, so bringing it back costs
    /// bounded replay state.
    ///
    /// This exists because nothing else was watching. Measured on 2026-09-15: the manager cold
    /// started at 14:20:18, could not reach a vault the host had judged alive by pid alone, and
    /// exited two seconds later. Every PTY-backed terminal in the panel answered 503 for the next
    /// twelve hours, and the only record of it anywhere was one line in a per-launch log file.
    static func restart(
        component: HostPtyRuntimeProcess.Component,
        deliberate: Bool,
        openingLadderSettled: Bool,
        somethingServing: Bool,
        consecutiveRestarts: Int,
        limit: Int
    ) -> HostPtyRuntimeRestartDecision {
        guard component == .manager else {
            return .leave(reason: "a vault that exited holds nothing and a fresh one comes up empty")
        }
        if deliberate {
            return .leave(reason: "this host ended that process itself")
        }
        // The opening pass reports its own failure and settles readiness; re-entering it from
        // inside itself would race that report with a second ladder.
        guard openingLadderSettled else {
            return .leave(reason: "the opening launch has not finished deciding")
        }
        // A handover ends with the outgoing generation exiting, which is this same callback on a
        // socket that is healthier than it was a moment ago.
        if somethingServing {
            return .leave(reason: "another generation is already serving the socket")
        }
        guard consecutiveRestarts < limit else {
            return .leave(reason: "restarted \(limit) times without staying up")
        }
        return .relaunch
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

    enum Component: String {
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
    private var diagnosticsURLs: [Component: URL] = [:]
    private let readinessLock = NSLock()
    private var readiness: Bool?
    private var readinessWaiters: [CheckedContinuation<Bool, Never>] = []
    /// Exits this host caused, so its own termination handler does not read one as a crash.
    private var deliberateExits: Set<Component> = []
    /// When the manager generation this host launched started, and how many times it has been
    /// restarted since the last one that stayed up.
    private var managerLaunchedAt: Date?
    private var managerRestarts = 0
    /// A manager with no vault to reach exits about two seconds in (`wait_for_vault` polls for
    /// two), so waiting that long is what keeps a restart from being a second helping of the same
    /// failure, and the cap bounds a genuine crash loop to roughly ten seconds of it.
    private static let managerRestartDelay: TimeInterval = 2
    private static let managerRestartLimit = 5
    /// Up this long is a generation that served rather than a crash loop, so the count starts over
    /// and a host that has been running for days still gets its five attempts.
    private static let managerSettledSeconds: TimeInterval = 60

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

    /// Whether the opening ladder has reached a verdict. `readiness` is written under its lock
    /// because `waitUntilReady` reads it from wherever the caller is; this reads it the same way.
    private var readinessSettled: Bool {
        readinessLock.lock()
        defer { readinessLock.unlock() }
        return readiness != nil
    }

    private func socketURL(for component: Component) -> URL {
        component == .vault ? vaultSocketURL : managerSocketURL
    }

    /// A daemon exiting is not an event this host can afford to only log.
    ///
    /// The whole ladder runs again rather than just the component that went, because the manager
    /// is the one that exits and the vault is usually why: a manager restarted against the same
    /// absent vault would repeat the exit exactly. Re-running `launchComponents` cold starts the
    /// vault first when nothing is serving it, and preserves it when something is, so the common
    /// case costs a digest, a `proc_pidpath` and a connect to a socket on this machine.
    private func handleExit(of component: Component) {
        let deliberate = deliberateExits.remove(component) != nil
        if component == .manager,
           let launchedAt = managerLaunchedAt,
           Date().timeIntervalSince(launchedAt) >= Self.managerSettledSeconds {
            managerRestarts = 0
        }
        switch HostPtyRuntimeSocketVerifier.restart(
            component: component,
            deliberate: deliberate,
            openingLadderSettled: readinessSettled,
            somethingServing: servingPeer(socketURL: socketURL(for: component)) != nil,
            consecutiveRestarts: managerRestarts,
            limit: Self.managerRestartLimit
        ) {
        case .leave(let reason):
            logger.notice("PTY \(component.rawValue, privacy: .public) was not restarted reason=\(reason, privacy: .public)")
        case .relaunch:
            managerRestarts += 1
            logger.error("PTY manager exited on its own; re-running the launch ladder attempt=\(self.managerRestarts, privacy: .public)")
            queue.asyncAfter(deadline: .now() + Self.managerRestartDelay) { [weak self] in
                guard let self else { return }
                if self.launchComponents() {
                    self.logger.notice("PTY runtime restored after an unattended manager exit")
                }
            }
        }
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
            // A cold-started vault comes up empty. Until it reseeds custody from the running
            // manager's leases, that manager holds the only descriptors keeping these children
            // alive, so replacing it in the same pass would close the last master for every
            // session. Downgrade to keeping it; the next launch updates it once the vault is
            // holding the sessions again.
            var managerRecovery = HostPtyRuntimeRecovery.replacePredecessor
            if case .recovered(let reason) = vault {
                logger.error("PTY vault was rebuilt rather than handed to, so the manager will not be replaced this pass; it holds the only live descriptors until custody is reseeded reason=\(reason, privacy: .public)")
                managerRecovery = .keepPredecessor
            }
            let manager = try ensure(
                component: .manager,
                binaryURL: managerBinaryURL,
                socketURL: managerSocketURL,
                recovery: managerRecovery,
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
            switch vault {
            case .degraded(let reason):
                logger.error("PTY runtime ready with a lagging vault binary; live sessions are intact and the bundled vault is not in use reason=\(reason, privacy: .public)")
            case .recovered(let reason):
                logger.error("PTY runtime ready with a rebuilt vault; sessions are held by the manager's leases until custody is reseeded reason=\(reason, privacy: .public)")
            case .ready, .failed:
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
        let peer = servingPeer(socketURL: socketURL)
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
            // `.recovered` rather than `.ready`: a component started from nothing holds nothing.
            // On a clean boot that is the same thing, but when only the vault died, a live manager
            // is still holding the descriptors and must not be replaced until custody is reseeded.
            return launched
                ? .recovered(reason: "started fresh; no previous generation was serving")
                : .failed(reason: "cold start did not activate")
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
        let alive = servingPeer(socketURL: socketURL) != nil
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
                ? .recovered(reason: reason)
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
        // Judged by published identity, not by the socket's peer pid, for the reason in `launch`.
        // Asking the socket who owns it named the predecessor even after a completed handover, so
        // this terminated candidates that had already taken custody of every session descriptor.
        // Sessions survived that only because the outgoing manager's leases reseeded the vault.
        guard runtimeIdentity(socketURL: socketURL)?.pid != process.processIdentifier else { return }
        logger.notice("PTY \(component.rawValue, privacy: .public) discarding candidate pid=\(process.processIdentifier, privacy: .public) that never published an identity")
        deliberateExits.insert(component)
        process.terminate()
        processes[component] = nil
    }

    /// Ends a predecessor that is safe to replace. Only ever reached for `.replacePredecessor`.
    private func terminatePredecessor(
        component: Component,
        socketURL: URL,
        timeout: TimeInterval = Config.ptyRuntimePeerTimeoutSeconds
    ) {
        guard let peer = servingPeer(socketURL: socketURL) else { return }
        logger.notice("PTY \(component.rawValue, privacy: .public) replacing predecessor pid=\(peer.pid, privacy: .public); vault-held sessions survive and are re-adopted")
        Darwin.kill(peer.pid, SIGTERM)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if servingPeer(socketURL: socketURL)?.pid != peer.pid { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
        logger.error("PTY \(component.rawValue, privacy: .public) predecessor pid=\(peer.pid, privacy: .public) ignored SIGTERM; escalating")
        Darwin.kill(peer.pid, SIGKILL)
        let killDeadline = Date().addingTimeInterval(timeout)
        while Date() < killDeadline {
            if servingPeer(socketURL: socketURL)?.pid != peer.pid { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    /// The candidate's own account of why it stopped. Without this the Rust protocol error that
    /// explains a failed handover goes to the null device and the host reports only "did not
    /// activate".
    private func candidateDiagnostics(component: Component, socketURL: URL) -> String {
        guard let url = diagnosticsURLs[component],
              let contents = try? String(contentsOf: url, encoding: .utf8)
        else { return "no candidate output" }
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
        // Sanitized rather than inherited whole: terminal shells descend from here, and an agent's
        // bash tool runs in one, so the agent-feed capability must not travel down this branch.
        process.environment = ProcessInfo.processInfo.environment
        // One file per launch, not per component. Sharing a name meant the outgoing generation, the
        // candidate, and its replacement all held descriptors to the same path: truncating at launch
        // did nothing to the older processes' offsets, so the file interleaved three generations and
        // the candidate's own error was gone by the time it was read back.
        let diagnostics = Self.diagnosticsURL(component: component, socketURL: socketURL)
        pruneDiagnostics(component: component, socketURL: socketURL)
        diagnosticsURLs[component] = diagnostics
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
                // Only if this is still the generation that entry names. The handler runs long
                // after the exit it reports, and a restart has already stored its replacement.
                if runtime.processes[component] === finished { runtime.processes[component] = nil }
                runtime.logger.notice("PTY \(component.rawValue, privacy: .public) exited status=\(status, privacy: .public)")
                runtime.handleExit(of: component)
            }
        }
        try process.run()
        // A new generation starts unmarked. `discardCandidateIfIdle` marks a component just before
        // terminating it, and the one case where that mark is never consumed is a process that died
        // on its own between the liveness check and the terminate; left behind, it would swallow
        // the next genuine crash.
        deliberateExits.remove(component)
        processes[component] = process
        if component == .manager { managerLaunchedAt = Date() }
        // Activation is the identity the daemon publishes for itself, never the socket's peer pid.
        //
        // A handover candidate inherits the listening socket through SCM_RIGHTS instead of binding
        // it, and Darwin attributes LOCAL_PEERPID to the process that created the socket. So a
        // candidate that has taken over completely still reports its predecessor's pid forever, and
        // waiting for the peer pid to change could never succeed for a handover. Every vault
        // handover since ADR-0072 was declared failed this way while the candidate sat there
        // healthy, serving, and holding every session descriptor.
        let activated = waitForIdentity(
            socketURL: socketURL,
            process: process,
            expected: HostPtyRuntimeIdentity(pid: process.processIdentifier, digest: digest)
        )
        if !activated {
            logger.error("PTY \(component.rawValue, privacy: .public) candidate failed to activate pid=\(process.processIdentifier, privacy: .public)")
        }
        return activated
    }

    /// The generation actually serving this socket.
    ///
    /// Identified by the identity a daemon publishes for itself, not by who created the socket.
    /// After a handover the creator is the *previous* generation, usually already exited, so asking
    /// the socket who owns it would report a dead pid and make the host cold start over a healthy
    /// runtime. `executablePath(pid:)` fails for a dead process, which is the liveness half.
    ///
    /// Both halves are required, and for a while only the first was. A pid that resolves says a
    /// process exists; it does not say that process is still accepting connections, and the two
    /// come apart exactly when it matters most -- during the seconds an outgoing generation takes
    /// to exit. Measured 2026-09-15: this host preserved a vault whose pid was alive and whose
    /// socket was already refusing, then cold started a manager that needed it, and the manager
    /// exited two seconds later with `Connection refused`. Every PTY-backed terminal was down for
    /// twelve hours. A daemon is serving when its socket says so.
    ///
    /// Answering nil for something that is alive but unreachable is a cold start over a process
    /// that may still hold descriptors, and that is the right trade: those sessions are already
    /// unreachable through a socket nothing answers, and a cold start that turns out to be wrong
    /// loses the race harmlessly, because the daemon binding the socket refuses to start when
    /// something is already listening on it.
    private func servingPeer(socketURL: URL) -> HostPtyRuntimeSocketPeer? {
        guard let identity = runtimeIdentity(socketURL: socketURL),
              let path = Self.executablePath(pid: identity.pid),
              Self.socketProbe(socketURL) != .refused
        else { return nil }
        return HostPtyRuntimeSocketPeer(pid: identity.pid, executablePath: path)
    }

    /// Asks the socket the only way there is to ask: by connecting to it.
    ///
    /// A connect on an `AF_UNIX` stream socket is decided in the kernel against the listener's
    /// backlog, with no round trip and nothing for the daemon to do, so this does not depend on a
    /// daemon being responsive enough to answer a protocol request -- which is what makes it safe
    /// to call from the launch ladder and from `terminatePredecessor`'s poll. The connection is
    /// closed immediately; both daemons take short-lived clients as a matter of course, since the
    /// sidecar opens one per call.
    static func socketProbe(_ socketURL: URL) -> HostPtyRuntimeSocketProbe {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let name = Array(socketURL.path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        // `sun_path` is 104 bytes here and the name needs its terminator inside that.
        guard name.count < capacity else {
            return .inconclusive(code: ENAMETOOLONG)
        }
        withUnsafeMutablePointer(to: &address.sun_path) { field in
            field.withMemoryRebound(to: CChar.self, capacity: capacity) { path in
                for (index, byte) in name.enumerated() { path[index] = CChar(bitPattern: byte) }
                path[name.count] = 0
            }
        }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return HostPtyRuntimeSocketVerifier.probe(connectErrno: errno) }
        defer { close(descriptor) }
        let outcome = withUnsafePointer(to: &address) { stored in
            stored.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                Darwin.connect(descriptor, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        return HostPtyRuntimeSocketVerifier.probe(connectErrno: outcome == 0 ? nil : errno)
    }

    private func runtimeIdentity(socketURL: URL) -> HostPtyRuntimeIdentity? {
        guard let data = try? Data(contentsOf: Self.identityURL(socketURL: socketURL)) else {
            return nil
        }
        return try? JSONDecoder().decode(HostPtyRuntimeIdentity.self, from: data)
    }

    private func waitForIdentity(
        socketURL: URL,
        process: Process,
        expected: HostPtyRuntimeIdentity,
        timeout: TimeInterval = Config.ptyRuntimePeerTimeoutSeconds
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if runtimeIdentity(socketURL: socketURL) == expected { return true }
            // A candidate that died is a failure now, not at the deadline.
            if !process.isRunning {
                return runtimeIdentity(socketURL: socketURL) == expected
            }
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
            .appendingPathComponent(
                "\(component.rawValue)-\(UUID().uuidString.prefix(8)).log",
                isDirectory: false
            )
    }

    /// Drops this component's logs from generations that are no longer running, so unique
    /// per-launch names do not accumulate a file per host restart.
    private func pruneDiagnostics(component: Component, socketURL: URL) {
        let directory = socketURL.deletingLastPathComponent()
        let current = diagnosticsURLs[component]
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ) else { return }
        for entry in entries
        where entry.lastPathComponent.hasPrefix("\(component.rawValue)-")
            && entry.pathExtension == "log"
            && entry != current
        {
            try? FileManager.default.removeItem(at: entry)
        }
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
