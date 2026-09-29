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

// VoiceEngineSidecar runs the host-owned voice server (`voice-server`) only while
// something is using it.
//
// The server keeps Whisper (MLX, on the GPU) and Kokoro resident: 2.26GB measured
// by `footprint` on 2026-09-28, on a host that had not used voice in three weeks.
// So `start()` spawns nothing. It binds the voice port through
// VoiceSidecarActivationProxy, and the first connection to send a real request
// spawns the server on the backend port and waits for its /health. When the last connection
// closes an idle timer starts; if it runs out the server is terminated, which is
// the only way to hand back all of its memory (clearing MLX's cache still leaves
// torch and the Python heap), and the next connection starts a fresh one.
//
// An unexpected exit is not restarted on its own: the next connection starts the
// server anyway, and restarting one nobody is using would undo the point. The
// backoff the old restart loop carried survives on that next start, because a
// server that dies seconds after answering /health would otherwise be spawned
// once per connection attempt.
//
// It is a deliberate sibling of AgentFeedSidecarProcess, not a shared abstraction:
// the agent sidecar spawns a single bundled binary, whereas the voice server is
// launched through `uv run voice-server` against a Python venv, so the spawn
// shape (executable + arguments + working directory) differs.
//
// Like the agent sidecar, this is host-internal and loopback-only; the phone
// never reaches it. Its only output is `baseURL`, the voice port the phone's
// lane dials; the Mac webviews are handed the same port in their config.
final class VoiceEngineSidecar: @unchecked Sendable {
    // The voice port's base URL (e.g. http://127.0.0.1:7692), published once the
    // activation listener is bound, as an event so a lane that opens during the
    // launch window waits for it rather than telling the phone voice is unavailable.
    private let readiness = SidecarReadinessSignal(
        label: "\(Config.dispatchQueuePrefix).voice-engine-sidecar-readiness"
    )
    // The Python server's own base URL on the backend port, published only while
    // the current generation answers /health. Connections wait on this one.
    private let backendReadiness = SidecarReadinessSignal(
        label: "\(Config.dispatchQueuePrefix).voice-engine-backend-readiness"
    )

    // Nil until the activation listener is bound.
    var baseURL: URL? { readiness.current }

    private let launch: VoiceSidecarLaunch
    private let port: UInt16
    private let backendPort: UInt16
    private let idleSeconds: TimeInterval
    private let logger: Logger
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).voice-engine-sidecar")

    private var proxy: VoiceSidecarActivationProxy?
    private var process: Process?
    private var outputPipe: Pipe?
    private var importTimeTraceHandle: FileHandle?
    private var outputFramer = VoiceSidecarOutputFramer()
    private var stopped = false
    // Connections that have asked for the server and not yet closed.
    private var activeConnections = 0
    // The pending stop for a server nothing is connected to.
    private var idleStop: DispatchWorkItem?
    // A start deferred by backoff, so a second connection does not queue another.
    private var spawnScheduled = false
    // The earliest the next generation may start. Pushed out after a bad one.
    private var nextSpawnNotBefore = Date.distantPast
    private var restartBackoffSeconds: TimeInterval = 1
    // When the live generation answered /health, or nil if it has not. Used to tell a good start
    // from one that merely got far enough to answer once.
    private var readyAt: Date?
    // Generations spawned so far. Test-observable; read it through spawnCountForTesting.
    private var spawnCount = 0

    // Maximum time (seconds) to wait for the server to answer /health. Larger
    // than the agent sidecar's window because the first /health for a cold uv
    // environment can include interpreter startup.
    private static let readyTimeoutSeconds: TimeInterval = 20
    // Maximum backoff before the next start after a bad generation (seconds).
    private static let maxBackoffSeconds: TimeInterval = 16
    // How long a generation must stay up after answering /health before its start counts as good
    // and the backoff returns to its floor.
    private static let stabilitySeconds: TimeInterval = 30

    init(
        launch: VoiceSidecarLaunch,
        port: UInt16,
        backendPort: UInt16,
        idleSeconds: TimeInterval
    ) {
        self.launch = launch
        self.port = port
        self.backendPort = backendPort
        self.idleSeconds = idleSeconds
        self.logger = Logger(subsystem: Config.logSubsystem, category: "voice-engine-sidecar")
    }

    deinit {
        // Terminate the child if the object is dropped without an explicit
        // stop() (matches AgentFeedSidecarProcess). Run synchronously here: by deinit
        // the queue may no longer drain, so a queued async would never fire.
        // terminateCurrentProcess is safe to call directly because no other
        // queue work can race a deallocating self.
        stopped = true
        idleStop?.cancel()
        proxy?.stop()
        terminateCurrentProcess()
    }

    /// Binds the voice port. Spawns nothing: the server starts on the first connection.
    func start() {
        queue.async { [weak self] in
            guard let self, !self.stopped, self.proxy == nil else { return }
            let proxy = VoiceSidecarActivationProxy(
                port: self.port,
                acquire: { [weak self] in self?.acquireBackend() },
                backend: { [weak self] in await self?.backendURL() },
                release: { [weak self] in self?.releaseBackend() },
                onReady: { [weak self] url in self?.readiness.publish(url) }
            )
            self.proxy = proxy
            proxy.start()
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.idleStop?.cancel()
            self.idleStop = nil
            self.proxy?.stop()
            self.proxy = nil
            self.terminateCurrentProcess()
            self.backendReadiness.stop()
            self.readiness.stop()
        }
    }

    // Number of server generations spawned so far, read on the serial queue so the
    // value is consistent with the supervisor's own mutations. For tests only.
    var spawnCountForTesting: Int {
        queue.sync { spawnCount }
    }

    // Whether a server generation is running right now. For tests only.
    var isServerRunningForTesting: Bool {
        queue.sync { process?.isRunning ?? false }
    }

    /// The voice port's base URL, waiting up to `timeout` seconds for the listener.
    /// The voice lane uses this rather than reading `baseURL`, so a phone that opens
    /// a socket during launch waits briefly instead of being told voice is
    /// unavailable by a listener that was moments from binding.
    func baseURL(waitingUpTo timeout: TimeInterval) async -> URL? {
        await readiness.value(waitingUpTo: timeout)
    }

    // MARK: - Demand

    /// Counts a connection and starts the server if none is running. Balanced by
    /// exactly one `releaseBackend`. Enqueued in call order, so a connection that
    /// hangs up at once can never be released before it was counted.
    private func acquireBackend() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.activeConnections += 1
            self.idleStop?.cancel()
            self.idleStop = nil
            self.spawnIfNeeded()
        }
    }

    /// The server's base URL once it answers, or nil when it could not be started.
    private func backendURL() async -> URL? {
        // Let everything already queued run first: this connection's own count, and
        // an idle stop that fired just before it, whose server must not be handed out.
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume() }
        }
        // Covers the longest a start can take: a full backoff and then a full ready window.
        return await backendReadiness.value(
            waitingUpTo: Self.maxBackoffSeconds + Self.readyTimeoutSeconds
        )
    }

    private func releaseBackend() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.activeConnections = max(0, self.activeConnections - 1)
            self.scheduleIdleStopIfUnused()
        }
    }

    private func scheduleIdleStopIfUnused() {
        guard activeConnections == 0, process != nil, idleStop == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.idleStop = nil
            guard !self.stopped, self.activeConnections == 0, self.process != nil else { return }
            self.logger.notice("voice sidecar idle for \(self.idleSeconds, privacy: .public)s; stopping it to release its memory")
            self.backendReadiness.clear()
            self.terminateCurrentProcess()
            // A generation that served and then went quiet was a good one.
            self.readyAt = nil
            self.restartBackoffSeconds = 1
            self.nextSpawnNotBefore = .distantPast
        }
        idleStop = work
        queue.asyncAfter(deadline: .now() + idleSeconds, execute: work)
    }

    private func spawnIfNeeded() {
        guard !stopped, process == nil, !spawnScheduled, activeConnections > 0 else { return }
        let delay = nextSpawnNotBefore.timeIntervalSinceNow
        guard delay > 0 else {
            spawnAndSupervise()
            return
        }
        spawnScheduled = true
        logger.notice("voice sidecar start deferred \(delay, privacy: .public)s by backoff")
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.spawnScheduled = false
            self.spawnIfNeeded()
        }
    }

    // A generation that failed to start or died before it had stayed up long
    // enough pushes the next start out and doubles the wait; a good one resets it.
    private func recordGenerationEnded(stable: Bool) {
        if stable {
            restartBackoffSeconds = 1
            nextSpawnNotBefore = .distantPast
        } else {
            nextSpawnNotBefore = Date().addingTimeInterval(restartBackoffSeconds)
            restartBackoffSeconds = min(restartBackoffSeconds * 2, Self.maxBackoffSeconds)
        }
    }

    // MARK: - Private

    private func spawnAndSupervise() {
        guard !stopped else { return }
        spawnCount += 1

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
        // parent env and override only ours (force loopback + the backend port;
        // the voice port itself belongs to the activation listener).
        var overrides = launch.environment
        overrides["VOICE_PORT"] = String(backendPort)
        overrides["VOICE_HOST"] = "127.0.0.1"
        if importTraceEnabled {
            overrides["PYTHONPROFILEIMPORTTIME"] = "2"
        }
        proc.environment = ProcessInfo.processInfo.environment
            .merging(overrides) { _, new in new }
        // Dispatch onto our serial queue: Process invokes terminationHandler on
        // its own internal queue, but handleTermination reads+mutates state
        // owned by self.queue.
        proc.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            self?.queue.async { [weak self] in
                self?.handleTermination(status: status)
            }
        }

        do {
            try proc.run()
            self.process = proc
            logger.notice("voice sidecar started backendPort=\(self.backendPort, privacy: .public) connections=\(self.activeConnections, privacy: .public)")
        } catch {
            logger.error("voice sidecar launch failed: \(String(describing: error), privacy: .public)")
            closeOutputPipe()
            recordGenerationEnded(stable: false)
            return
        }

        waitUntilReady()
    }

    private func waitUntilReady() {
        let candidate = URL(string: "http://127.0.0.1:\(backendPort)/health")!
        let deadline = Date().addingTimeInterval(Self.readyTimeoutSeconds)
        var reached = false

        while Date() < deadline {
            if stopped { return }
            // A reply on this port is not evidence that OUR child is serving it. A server
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
            let url = URL(string: "http://127.0.0.1:\(backendPort)")!
            backendReadiness.publish(url)
            // Answering /health is not yet evidence of a good start, so the backoff is not reset
            // here. See handleTermination: only a generation that then stays up earns that.
            readyAt = Date()
            logger.notice("voice sidecar ready backend=\(url.absoluteString, privacy: .public)")
            // Every connection that asked for it may have left while it started.
            scheduleIdleStopIfUnused()
        } else {
            logger.error("voice sidecar did not become ready within \(Self.readyTimeoutSeconds, privacy: .public)s")
            terminateCurrentProcess()
            recordGenerationEnded(stable: false)
        }
    }

    private func handleTermination(status: Int32) {
        guard !stopped else { return }
        // The OS fired this for the live process; drop our reference to it so a
        // later teardown does not touch a dead Process.
        process = nil
        closeOutputPipe()
        backendReadiness.clear()
        idleStop?.cancel()
        idleStop = nil
        // Count the start as good only for a generation that actually stayed up.
        //
        // Counting /health instead pins the delay at its floor for the one failure mode
        // backoff exists to handle: a child that starts, answers health, and dies seconds later
        // resets the delay every cycle, so escalation never happens. Observed as 1404 consecutive
        // restarts at exactly 1.000000s, a python spawn every 1.4 seconds for over half an hour.
        let livedLongEnough = readyAt.map { Date().timeIntervalSince($0) >= Self.stabilitySeconds }
            ?? false
        readyAt = nil
        recordGenerationEnded(stable: livedLongEnough)
        logger.notice("voice sidecar exited unexpectedly status=\(status, privacy: .public) connections=\(self.activeConnections, privacy: .public)")
        // Connections still waiting for a server get the next one, after the backoff.
        spawnIfNeeded()
    }

    private func terminateCurrentProcess() {
        closeOutputPipe()
        guard let proc = process else { return }
        process = nil
        // Detach the termination handler so a deliberate teardown (stop(), the
        // idle stop, or the ready-timeout path) is not also read as a crash and
        // charged to the backoff. An unexpected exit keeps its handler intact
        // because the process was never run through here.
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
