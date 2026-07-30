import Foundation
import os

struct VoiceSidecarOutputFramer {
    private var buffer = ""

    static func isTimingEvent(_ line: String) -> Bool {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let payload = object as? [String: Any]
        else {
            return false
        }
        return payload["event"] as? String == "voice-timing"
    }

    mutating func consume(_ data: Data) -> [String] {
        buffer.append(String(decoding: data, as: UTF8.self))
        let lines = buffer.split(
            separator: "\n",
            omittingEmptySubsequences: false
        )
        guard lines.count > 1 else { return [] }
        buffer = String(lines.last ?? "")
        return lines.dropLast().compactMap { line in
            line.isEmpty ? nil : String(line)
        }
    }

    mutating func reset() {
        buffer = ""
    }
}

// VoiceEngineSidecar spawns the host-owned voice server (`voice-server`), polls
// until it answers /health on loopback, supervises the child (restarting on
// unexpected exit with a small backoff), and tears down cleanly on stop.
//
// It is a deliberate sibling of AgentFeedSidecarProcess, not a shared abstraction:
// the agent sidecar spawns a single bundled binary, whereas the voice server is
// launched through `uv run voice-server` against a Python venv, so the spawn
// shape (executable + arguments + working directory) differs. Cloning keeps the
// shipping agent sidecar untouched; a shared LoopbackSidecar is a viable later
// extraction once both have stabilized.
//
// Like the agent sidecar, this is host-internal and loopback-only; the phone
// never reaches it. It talks to nothing itself — its only output is `baseURL`,
// which the voice webview mount reads to build the loopback WebSocket URL.
final class VoiceEngineSidecar: @unchecked Sendable {
    // Base URL on loopback once the sidecar is ready (e.g. http://127.0.0.1:7692).
    // Nil until the first successful ready-poll.
    private(set) var baseURL: URL?

    private let launch: VoiceSidecarLaunch
    private let port: UInt16
    private let logger: Logger
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).voice-engine-sidecar")

    private var process: Process?
    private var outputPipe: Pipe?
    private var importTimeTraceHandle: FileHandle?
    private var outputFramer = VoiceSidecarOutputFramer()
    private var stopped = false
    private var restartBackoffSeconds: TimeInterval = 1
    // Collapses concurrent restart requests into one. A single induced exit can
    // reach scheduleRestart from both handleTermination and a ready-timeout
    // path; this guard ensures exactly one restart is queued per dead process.
    private var restartScheduled = false
    // When the live generation answered /health, or nil if it has not. Used to tell a good start
    // from one that merely got far enough to answer once.
    private var readyAt: Date?
    // Count of restarts actually dispatched. Test-observable so a unit test can
    // assert exactly one restart per induced exit without inferring from child
    // process spawn counts (which are noisy under xctest supervision). Read it
    // on the serial queue via restartCountForTesting.
    private var restartCount = 0

    // Maximum time (seconds) to wait for the sidecar to answer /health. Larger
    // than the agent sidecar's window because the first /health for a cold uv
    // environment can include interpreter startup.
    private static let readyTimeoutSeconds: TimeInterval = 20
    // Maximum backoff between restart attempts (seconds).
    private static let maxBackoffSeconds: TimeInterval = 16
    // How long a generation must stay up after answering /health before its start counts as good
    // and the backoff returns to its floor.
    private static let stabilitySeconds: TimeInterval = 30

    init(launch: VoiceSidecarLaunch, port: UInt16) {
        self.launch = launch
        self.port = port
        self.logger = Logger(subsystem: Config.logSubsystem, category: "voice-engine-sidecar")
    }

    deinit {
        // Terminate the child if the object is dropped without an explicit
        // stop() (matches AgentFeedSidecarProcess). Run synchronously here: by deinit
        // the queue may no longer drain, so a queued async would never fire.
        // terminateCurrentProcess is safe to call directly because no other
        // queue work can race a deallocating self.
        stopped = true
        terminateCurrentProcess()
    }

    func start() {
        queue.async { [weak self] in
            self?.spawnAndSupervise()
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.terminateCurrentProcess()
        }
    }

    // Number of restarts dispatched so far. Read synchronously on the serial
    // queue so the value is consistent with the supervisor's own mutations.
    // For tests only; the live app does not read this.
    var restartCountForTesting: Int {
        queue.sync { restartCount }
    }

    // MARK: - Private

    private func spawnAndSupervise() {
        guard !stopped else { return }
        // A fresh spawn clears the pending-restart latch so the next dead
        // process can schedule its own restart.
        restartScheduled = false

        let proc = Process()
        proc.executableURL = launch.executableURL
        proc.arguments = launch.arguments
        if let workingDirectory = launch.workingDirectory {
            proc.currentDirectoryURL = workingDirectory
        }
        // Capture newline-framed output without inheriting the host process's
        // stdio descriptors. consumeOutput forwards only structured timing
        // events, keeping transcripts and arbitrary dependency output out of
        // the unified log.
        let pipe = Pipe()
        outputPipe = pipe
        outputFramer.reset()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            self?.queue.async { [weak self] in
                self?.consumeOutput(data)
            }
        }
        proc.standardOutput = pipe
        let importTraceEnabled: Bool
        if let traceURL = launch.importTimeTraceURL,
           let traceHandle = openImportTimeTrace(at: traceURL) {
            importTimeTraceHandle = traceHandle
            proc.standardError = traceHandle
            importTraceEnabled = true
        } else {
            proc.standardError = pipe
            importTraceEnabled = false
        }
        // Merge into the inherited env rather than replacing it. Setting
        // Process.environment replaces the whole child env, which would strip
        // PATH/HOME and break uv's own subprocess resolution. Inherit the
        // parent env and override only ours (force loopback + the host port).
        var overrides = launch.environment
        overrides["VOICE_PORT"] = String(port)
        overrides["VOICE_HOST"] = "127.0.0.1"
        if importTraceEnabled {
            overrides["PYTHONPROFILEIMPORTTIME"] = "2"
        }
        proc.environment = ProcessInfo.processInfo.environment
            .merging(overrides) { _, new in new }
        // Dispatch onto our serial queue: Process invokes terminationHandler on
        // its own internal queue, but handleTermination reads+mutates stopped
        // and restartBackoffSeconds, which are owned by self.queue. Without this
        // hop, an exit during waitUntilReady's sleep would race and double-restart.
        proc.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            self?.queue.async { [weak self] in
                self?.handleTermination(status: status)
            }
        }

        do {
            try proc.run()
            self.process = proc
            logger.notice("voice sidecar started port=\(self.port, privacy: .public)")
        } catch {
            logger.error("voice sidecar launch failed: \(String(describing: error), privacy: .public)")
            closeOutputPipe()
            scheduleRestart()
            return
        }

        waitUntilReady()
    }

    private func waitUntilReady() {
        let candidate = URL(string: "http://127.0.0.1:\(port)/health")!
        let deadline = Date().addingTimeInterval(Self.readyTimeoutSeconds)
        var reached = false

        while Date() < deadline {
            if stopped { return }
            // A reply on this port is not evidence that OUR child is serving it. A sidecar
            // orphaned by a host that died without running stop() keeps the port, so the child
            // that just failed to bind and exited would otherwise be reported ready by the very
            // process that displaced it. Require the child to still be alive before believing it.
            guard let live = process, live.isRunning else { break }
            if let data = try? Data(contentsOf: candidate), !data.isEmpty {
                reached = true
                break
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        if reached {
            let url = URL(string: "http://127.0.0.1:\(port)")!
            baseURL = url
            // Answering /health is not yet evidence of a good start, so the backoff is not reset
            // here. See handleTermination: only a generation that then stays up earns that.
            readyAt = Date()
            logger.notice("voice sidecar ready baseURL=\(url.absoluteString, privacy: .public)")
        } else {
            logger.error("voice sidecar did not become ready within \(Self.readyTimeoutSeconds, privacy: .public)s; will restart")
            terminateCurrentProcess()
            scheduleRestart()
        }
    }

    private func handleTermination(status: Int32) {
        guard !stopped else { return }
        // The OS fired this for the live process; drop our reference to it so a
        // later teardown does not touch a dead Process.
        process = nil
        closeOutputPipe()
        // Reset the backoff only for a generation that actually stayed up.
        //
        // Resetting it on /health instead pins the delay at its floor for the one failure mode
        // backoff exists to handle: a child that starts, answers health, and dies seconds later
        // resets the delay every cycle, so escalation never happens. Observed as 1404 consecutive
        // restarts at exactly 1.000000s, a python spawn every 1.4 seconds for over half an hour.
        let livedLongEnough = readyAt.map { Date().timeIntervalSince($0) >= Self.stabilitySeconds }
            ?? false
        if livedLongEnough { restartBackoffSeconds = 1 }
        readyAt = nil
        logger.notice("voice sidecar exited unexpectedly status=\(status, privacy: .public); scheduling restart")
        baseURL = nil
        scheduleRestart()
    }

    private func scheduleRestart() {
        guard !stopped else { return }
        // Collapse duplicate restart requests for the same dead process. Cleared
        // when the next spawn begins (spawnAndSupervise).
        guard !restartScheduled else { return }
        restartScheduled = true
        restartCount += 1
        let delay = restartBackoffSeconds
        restartBackoffSeconds = min(restartBackoffSeconds * 2, Self.maxBackoffSeconds)
        logger.notice("voice sidecar restart in \(delay, privacy: .public)s")
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.spawnAndSupervise()
        }
    }

    private func terminateCurrentProcess() {
        closeOutputPipe()
        guard let proc = process else { return }
        process = nil
        // Detach the termination handler so a deliberate teardown (stop() or the
        // ready-timeout path) does not also fire handleTermination and queue an
        // unwanted restart. Unexpected exits still restart: their handler is
        // intact because the process was never run through here.
        proc.terminationHandler = nil
        guard proc.isRunning else { return }
        proc.terminate()
        // Give SIGTERM a brief window; escalate to SIGKILL if still running.
        let deadline = Date().addingTimeInterval(2)
        while proc.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if proc.isRunning {
            kill(proc.processIdentifier, SIGKILL)
        }
    }

    private func consumeOutput(_ data: Data) {
        for line in outputFramer.consume(data)
        where VoiceSidecarOutputFramer.isTimingEvent(line) {
            logger.notice("voice sidecar \(line, privacy: .public)")
        }
    }

    private func openImportTimeTrace(at url: URL) -> FileHandle? {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if !FileManager.default.fileExists(atPath: url.path) {
                guard FileManager.default.createFile(
                    atPath: url.path,
                    contents: nil
                ) else {
                    throw CocoaError(.fileWriteUnknown)
                }
            }
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            logger.notice(
                "voice sidecar Python import trace enabled path=\(url.path, privacy: .public)"
            )
            return handle
        } catch {
            logger.error(
                "voice sidecar Python import trace unavailable path=\(url.path, privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
            return nil
        }
    }

    private func closeOutputPipe() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        try? importTimeTraceHandle?.close()
        importTimeTraceHandle = nil
        outputFramer.reset()
    }
}

/// How to launch the voice server process.
///
/// Until the Application-Support venv provisioning lands (Phase 3d), this is
/// resolved from the environment so a developer can point the host at a local
/// `uv` + the gesture-agent project. `Config.voiceSidecarLaunch` returns nil
/// when the environment is unset, and the host simply does not start the voice
/// sidecar — mirroring `Config.agentFeedSidecarURL` returning nil when the bundled
/// binary is absent (absent config is a no-op, never a crash).
struct VoiceSidecarLaunch {
    let executableURL: URL
    let arguments: [String]
    let workingDirectory: URL?
    /// Extra environment for the child (e.g. VOICE_DATA_ROOT / VOICE_MODEL_ROOT
    /// pointing at writable Application-Support paths). Merged over the inherited
    /// env; VOICE_PORT / VOICE_HOST are always forced by the supervisor.
    var environment: [String: String] = [:]
    /// When set, enable Python's import-time profiler and append the child's
    /// raw stderr to this file. Normal launches keep stderr on the filtered
    /// timing-event pipe.
    var importTimeTraceURL: URL? = nil
}
