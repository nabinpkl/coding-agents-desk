import Foundation
import os
import Security

// AgentFeedSidecarProcess spawns the bundled transcript sidecar, polls until it
// answers /api/config on loopback, supervises the child (restarting on
// unexpected exit with a small backoff), and tears down cleanly on stop.
//
// The sidecar is host-internal and loopback-only; the authenticated bridge,
// rather than the phone, is its sole application consumer.
final class AgentFeedSidecarProcess: @unchecked Sendable {
    // Base URL on loopback once the sidecar is ready (e.g. http://127.0.0.1:7682),
    // published as an event so a consumer that arrives during the launch window
    // waits for it rather than failing against it.
    private let readiness = SidecarReadinessSignal(
        label: "\(Config.dispatchQueuePrefix).agent-feed-sidecar-readiness"
    )

    // Nil until the first successful ready-poll.
    var baseURL: URL? { readiness.current }

    private let launch: Config.AgentFeedSidecarLaunch
    private let port: UInt16
    private let logger: Logger
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).agent-feed-sidecar")

    private var process: Process?
    private var outputPipe: Pipe?
    private var outputBuffer = ""
    private var stopped = false
    private let stopLock = NSLock()
    private var stopRequested = false
    private var restartBackoffSeconds: TimeInterval = 1
    // Collapses concurrent restart requests into one. A single induced exit can
    // reach scheduleRestart from both handleTermination and a ready-timeout
    // path; this guard ensures exactly one restart is queued per dead process.
    private var restartScheduled = false
    // The starts that failed in a row and where each one stopped, so a loop is named in the log
    // and the next attempt is given longer instead of the same.
    private var startFailures = SidecarStartFailures()
    // Count of restarts actually dispatched. Test-observable so a unit test can
    // assert exactly one restart per induced exit without inferring from child
    // process spawn counts (which are noisy under xctest supervision). Read it
    // on the serial queue via restartCountForTesting.
    private var restartCount = 0
    // Appends the child's stdout and stderr to a file as well as the unified log. Nil when the
    // file could not be opened, which is never fatal: losing the transcript must not cost the
    // sidecar.
    //
    // A raw descriptor rather than a `FileHandle`: a handle guards its descriptor and traps the
    // process when it is closed with the wrong guard, which is what closing a number that someone
    // else has since closed and reused does. That killed a whole test run once, over a diagnostics
    // file. Negative when there is no file.
    private var outputFD: Int32 = -1
    private var outputFileBytes: UInt64 = 0
    // Invalidates a health monitor belonging to an earlier spawn. Each spawn takes the next
    // generation, so a tick scheduled before a restart finds its generation stale and stops
    // rather than probing on behalf of a process that no longer exists.
    private var healthGeneration = 0
    private var healthFailures = 0
    private let healthInterval: TimeInterval
    private let healthLimit: Int
    // Per-instance rather than static: a formatter is not Sendable, and every use of this one is
    // on the supervisor's serial queue, so an instance is both correct and simpler to prove.
    private let timestamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    // A starting sidecar is judged on progress, not on a fixed deadline (`SidecarStartWatch`). It is
    // given up on after this long with no stage it had not reached before: the port still unbound,
    // or still answering the same `watcherState`. Each start that failed in a row doubles it, up to
    // the ceiling, because a retry given the same allowance as the attempt that just failed has
    // no reason to do better.
    private static let startStallSeconds: TimeInterval = 10
    // The backstop on one whole start, for a sidecar that keeps advancing and never arrives.
    private static let startCeilingSeconds: TimeInterval = 90
    // A stale listener can accept a connection without responding. Keep each
    // readiness attempt short so stop() can always reach the supervisor queue.
    private static let readinessProbeTimeoutSeconds: TimeInterval = 0.25
    // Maximum backoff between restart attempts (seconds).
    private static let maxBackoffSeconds: TimeInterval = 16
    // How often a running sidecar is asked whether it is still answering.
    private static let healthIntervalSeconds: TimeInterval = 15
    // Consecutive failures before the supervisor stops believing the process. Four at fifteen
    // seconds is a minute, comfortably past a `bun --watch` reload, which was measured at about
    // four seconds. The cost of being too eager here is restarting a sidecar that was only busy;
    // the cost of being too patient is what this exists to fix.
    private static let healthFailuresBeforeRestart = 4
    // Cap on the on-disk transcript. Its neighbour, the WebRTC diagnostics log, reached 42MB in
    // this repository, and a post-mortem file that fills a disk is a worse bug than the one it
    // was added to diagnose.
    private static let outputFileMaxBytes: UInt64 = 16 * 1024 * 1024

    /// The two health-monitor numbers are injectable ONLY so a test can exercise the monitor in a
    /// second rather than in a minute. Production always takes the defaults; a caller passing its
    /// own is a test saying so out loud.
    init(
        launch: Config.AgentFeedSidecarLaunch,
        port: UInt16,
        healthIntervalSeconds: TimeInterval = AgentFeedSidecarProcess.healthIntervalSeconds,
        healthFailuresBeforeRestart: Int = AgentFeedSidecarProcess.healthFailuresBeforeRestart
    ) {
        self.launch = launch
        self.port = port
        self.healthInterval = healthIntervalSeconds
        self.healthLimit = healthFailuresBeforeRestart
        self.logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-sidecar")
    }

    deinit {
        // Terminate the child if the object is dropped without an explicit
        // stop(). Run synchronously here: by deinit the queue may no longer
        // drain, so a
        // queued async would never fire. terminateCurrentProcess is safe to
        // call directly because no other queue work can race a deallocating self.
        requestStop()
        stopped = true
        terminateCurrentProcess()
    }

    func start() {
        queue.async { [weak self] in
            self?.spawnAndSupervise()
        }
    }

    func stop() {
        requestStop()
        queue.sync {
            self.stopped = true
            self.terminateCurrentProcess()
            self.readiness.stop()
        }
    }

    // Number of restarts dispatched so far. Read synchronously on the serial
    // queue so the value is consistent with the supervisor's own mutations.
    // For tests only; the live app does not read this.
    var restartCountForTesting: Int {
        queue.sync { restartCount }
    }

    /// The base URL, waiting up to `timeout` seconds for a sidecar still coming up.
    /// Callers use this rather than reading `baseURL`, so that asking a second early
    /// costs latency instead of a dead subscription.
    func baseURL(waitingUpTo timeout: TimeInterval) async -> URL? {
        await readiness.value(waitingUpTo: timeout)
    }

    func endpoint(waitingUpTo timeout: TimeInterval) async -> AgentFeedSidecarEndpoint? {
        guard let baseURL = await readiness.value(waitingUpTo: timeout) else { return nil }
        return AgentFeedSidecarEndpoint(baseURL: baseURL)
    }

    // MARK: - Private

    private func spawnAndSupervise() {
        guard !stopped else { return }
        // A fresh spawn clears the pending-restart latch so the next dead
        // process can schedule its own restart.
        restartScheduled = false

        let proc = Process()
        proc.executableURL = launch.executable
        proc.arguments = launch.arguments
        // Bun (under `--watch`, and standalone `--compile`) drops dot-prefixed
        // compiler intermediates (`*.bun-build`) beside its working directory. With
        // no cwd set here, Process inherits the host's own -- the repo checkout --
        // so a live dev sidecar was littering the git root and agent-feed/sidecar/
        // with these on every reload. Give it a disposable directory instead, the
        // same fix `build-agent-feed-sidecar` already applies to the one-shot
        // compile in the Justfile.
        let sidecarWorkingDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-agent-feed-sidecar-cwd", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: sidecarWorkingDirectory, withIntermediateDirectories: true)
        proc.currentDirectoryURL = sidecarWorkingDirectory
        // Merge into the inherited env rather than replacing it. Setting
        // Process.environment replaces the whole child env, which would strip
        // PATH/HOME and break transcript discovery. Inherit
        // the parent env and override only ours.
        //
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "AGENT_FEED_PORT": String(port),
            "AGENT_FEED_HOST": "127.0.0.1",
        ]) { _, new in new }
        // Keep catalog and snapshot timing observable in the host unified log
        // without inheriting the host process's stdio descriptors.
        let pipe = Pipe()
        outputPipe = pipe
        outputBuffer = ""
        openOutputFile()
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
        proc.standardError = pipe
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
            // The reload mode is logged on every spawn, not once at launch. A supervised restart
            // is the moment someone is most likely to be asking "is this even running my edits",
            // and the answer has to be in the same log line they are already reading.
            logger.notice(
                """
                sidecar started port=\(self.port, privacy: .public) \
                reloadsOnEdit=\(self.launch.reloadsOnEdit, privacy: .public)
                """
            )
        } catch {
            logger.error("sidecar launch failed: \(String(describing: error), privacy: .public)")
            scheduleRestart()
            return
        }

        waitUntilReady()
    }

    private func waitUntilReady() {
        let candidate = URL(string: "http://127.0.0.1:\(port)/api/config")!
        let allowance = startFailures.allowance(base: Self.startStallSeconds, ceiling: Self.startCeilingSeconds)
        var watch = SidecarStartWatch(startedAt: ProcessInfo.processInfo.systemUptime)
        note("start: waiting for the sidecar, giving up after \(Int(allowance))s with no new stage")

        while true {
            if stopped || isStopRequested { return }
            let now = ProcessInfo.processInfo.systemUptime
            // An exit is the termination handler's business, queued behind this loop on the same
            // queue, so it restarts the sidecar once this returns. What this adds is the stage the
            // start had reached, which the handler cannot know.
            if let proc = process, !proc.isRunning {
                startFailures.record(stage: watch.stage)
                note(
                    "start: the sidecar exited at stage \(watch.stage) after "
                        + "\(String(format: "%.1f", watch.elapsed(at: now)))s; stages \(watch.timelineDescription)"
                        + loopSuffix())
                return
            }
            let before = watch.stage
            if watch.observe(
                SidecarStageProbe.stage(of: candidate, timeout: Self.readinessProbeTimeoutSeconds), at: now)
            {
                note(
                    "start: stage \(before) -> \(watch.stage) at "
                        + "\(String(format: "%.1f", watch.elapsed(at: now)))s")
            }
            if watch.stage == .live { break }

            let verdict = watch.verdict(
                at: ProcessInfo.processInfo.systemUptime, stallAllowance: allowance, ceiling: Self.startCeilingSeconds)
            guard verdict != .waiting else {
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }
            let why: String
            switch verdict {
            case .stalled(let seconds): why = "no new stage for \(Int(seconds))s (allowance \(Int(allowance))s)"
            case .overCeiling(let seconds): why = "still not live after \(Int(seconds))s (ceiling)"
            case .waiting: why = ""
            }
            startFailures.record(stage: watch.stage)
            logger.error("sidecar did not become ready; will restart")
            note(
                "start: giving up at stage \(watch.stage): \(why); stages \(watch.timelineDescription)"
                    + loopSuffix())
            terminateCurrentProcess()
            scheduleRestart()
            return
        }

        let url = URL(string: "http://127.0.0.1:\(port)")!
        restartBackoffSeconds = 1
        startFailures.reset()
        note(
            "start: ready after \(String(format: "%.1f", watch.elapsed(at: ProcessInfo.processInfo.systemUptime)))s; "
                + "stages \(watch.timelineDescription)")
        logger.notice("sidecar ready baseURL=\(url.absoluteString, privacy: .public)")
        readiness.publish(url)
        startHealthMonitor()
    }

    /// Names a loop once there is one: the starts failed in a row, and how many stopped at the same
    /// stage. Empty for a first failure, which is not yet a pattern.
    private func loopSuffix() -> String {
        guard startFailures.consecutive >= 2, let stage = startFailures.lastStage else { return "" }
        return "; LOOP: \(startFailures.consecutive) starts failed in a row, \(startFailures.atLastStage) at stage "
            + "\(stage); the next start is given \(Int(startFailures.allowance(base: Self.startStallSeconds, ceiling: Self.startCeilingSeconds)))s"
    }

    /// A line from the host about the sidecar's start, in the unified log and in the sidecar's own
    /// output file. The file is the one that survives: the unified log is gone by the time a
    /// restart loop is looked at, and the child's lines are lost when the host kills it.
    private func note(_ message: String) {
        logger.notice("sidecar \(message, privacy: .public)")
        appendToOutputFile("[host] \(message)")
    }

    private func isReady(_ url: URL) -> Bool {
        SidecarStageProbe.stage(of: url, timeout: Self.readinessProbeTimeoutSeconds) == .live
    }

    private var isStopRequested: Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        return stopRequested
    }

    private func requestStop() {
        stopLock.lock()
        stopRequested = true
        stopLock.unlock()
    }

    private func handleTermination(status: Int32) {
        guard !stopped else { return }
        // The OS fired this for the live process; drop our reference to it so a
        // later teardown does not touch a dead Process.
        process = nil
        healthGeneration += 1
        closeOutputPipe()
        logger.notice("sidecar exited unexpectedly status=\(status, privacy: .public); scheduling restart")
        readiness.clear()
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
        logger.notice("sidecar restart in \(delay, privacy: .public)s")
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.spawnAndSupervise()
        }
    }

    private func terminateCurrentProcess() {
        // Anything scheduled by the outgoing process's monitor is now about to be wrong.
        healthGeneration += 1
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
        outputBuffer.append(String(decoding: data, as: UTF8.self))
        let lines = outputBuffer.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > 1 else { return }
        for line in lines.dropLast() where !line.isEmpty {
            logger.notice("sidecar \(String(line), privacy: .public)")
            appendToOutputFile(String(line))
        }
        outputBuffer = String(lines.last ?? "")
    }

    /// Asks a RUNNING sidecar whether it is still answering, and restarts it when it is not.
    ///
    /// The gap this closes: every restart path here is driven by the child EXITING, and a `bun
    /// --watch` sidecar does not exit. It re-reads in process and rebinds the port, so when a
    /// reload throws before reaching `Bun.serve` the process stays alive, healthy by every signal
    /// the supervisor had, and serving nothing. Measured 2026-09-09: one sat like that with its
    /// port free and 0% CPU until somebody happened to save a file in the tree, because `--watch`
    /// only reloads on a change and the change that broke it was already over.
    ///
    /// So liveness is asked of the PORT rather than of the process, using the same probe the
    /// initial wait uses -- which reads `watcherState` rather than accepting any 200, so a stale
    /// listener that accepts a connection and answers nothing useful still counts as down.
    private func startHealthMonitor() {
        healthGeneration += 1
        healthFailures = 0
        scheduleHealthCheck(generation: healthGeneration)
    }

    private func scheduleHealthCheck(generation: Int) {
        queue.asyncAfter(deadline: .now() + healthInterval) { [weak self] in
            self?.checkHealth(generation: generation)
        }
    }

    private func checkHealth(generation: Int) {
        guard !stopped, !isStopRequested, generation == healthGeneration else { return }
        // An exit is the termination handler's business, not this one's. Two restart paths for one
        // dead process is the duplicate `restartScheduled` already exists to collapse, and leaving
        // it to the handler keeps the reason in the log accurate.
        guard let proc = process, proc.isRunning else { return }

        if isReady(URL(string: "http://127.0.0.1:\(port)/api/config")!) {
            healthFailures = 0
            scheduleHealthCheck(generation: generation)
            return
        }

        healthFailures += 1
        guard healthFailures >= healthLimit else {
            logger.notice(
                """
                sidecar not answering \(self.healthFailures, privacy: .public)/\
                \(self.healthLimit, privacy: .public)
                """
            )
            scheduleHealthCheck(generation: generation)
            return
        }
        logger.error(
            """
            sidecar is running but has not answered for \
            \(self.healthInterval * Double(self.healthLimit), privacy: .public)s; \
            restarting it
            """
        )
        readiness.clear()
        terminateCurrentProcess()
        scheduleRestart()
    }

    private func closeOutputPipe() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        outputBuffer = ""
        closeOutputFile()
    }

    /// Where the child's output is kept so it can be read AFTER the fact.
    ///
    /// The unified log already has every line, at `.notice`, and that is not enough: os_log is not
    /// reliably readable retrospectively from every session on this machine -- `log show` returns
    /// nothing here at all, while `log stream` works, so a line you can prove was written still
    /// cannot be got back once the moment has passed. A crash you are investigating is always in
    /// the past. So the same lines go to a file as well.
    ///
    /// Beside the WebRTC diagnostics log and named the same way, for the reason `runtime-paths.mjs`
    /// gives there: `/Users/Shared` is the one place every login session can write, `~/Library` is
    /// 0700, and a single fixed name belongs to whichever session created it first while every
    /// later session's appends fail on permissions -- silently, which is the session running blind
    /// while its numbers are read off somebody else's file.
    /// Overridable for the same reason its neighbours in `runtime-paths.mjs` are: so a test can
    /// point it at a scratch file rather than appending to the one a live host is writing.
    private func outputFilePath() -> String {
        if let override = ProcessInfo.processInfo.environment["AGENTDESK_AGENT_FEED_SIDECAR_LOG"],
           override.hasPrefix("/") {
            return override
        }
        return "/Users/Shared/agentdesk/logs/\(NSUserName())-agent-feed-sidecar.log"
    }

    /// Opens the diagnostics file for appending, or nil when it is not a plain file this user made.
    ///
    /// The directory it lives in is writable by every login session, so anyone could leave a symlink
    /// or a hard link at this name, and an append would then land in whatever it points at. Hence no
    /// following of a final symlink, creation that must be new, and a check on the descriptor itself
    /// that it is a regular file, ours, with one name. Append-only, so a truncate never leaves a
    /// stale offset; close-on-exec, so the sidecar it spawns does not inherit the descriptor.
    private static func openOwnedAppendFile(_ path: String) -> Int32? {
        let flags = O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW
        var fd = Darwin.open(path, flags)
        if fd < 0, errno == ENOENT {
            fd = Darwin.open(path, flags | O_CREAT | O_EXCL, 0o644)
        }
        guard fd >= 0 else { return nil }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
            info.st_nlink == 1
        else {
            // A descriptor this call just opened, so closing it is not the stale-number hazard.
            Darwin.close(fd)
            errno = EPERM
            return nil
        }
        return fd
    }

    private func closeOutputFile() {
        if outputFD >= 0 { Darwin.close(outputFD) }
        outputFD = -1
    }

    private func openOutputFile() {
        closeOutputFile()
        outputFileBytes = 0
        let path = outputFilePath()
        let directory = (path as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(
                atPath: directory, withIntermediateDirectories: true
            )
            guard let fd = Self.openOwnedAppendFile(path) else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EPERM)
            }
            outputFD = fd
            outputFileBytes = UInt64(max(0, lseek(fd, 0, SEEK_END)))
            // Every spawn is a boundary somebody reading this file backwards needs to see: it is
            // the line that says the sidecar they are reading is not the one that failed.
            appendToOutputFile("=== host spawned sidecar port=\(port) reloadsOnEdit=\(launch.reloadsOnEdit)")
        } catch {
            // Deliberately quiet beyond one line. A diagnostics file that cannot be opened must
            // never be the reason the sidecar does not run.
            logger.error("sidecar output file unavailable at \(path, privacy: .public)")
        }
    }

    private func appendToOutputFile(_ line: String) {
        guard outputFD >= 0 else { return }
        // Truncate rather than rotate. Its neighbour reached 42MB; keeping one bounded file beats
        // a rotation scheme nobody asked for, and losing old lines matters less than the file
        // still being there for the failure being investigated now.
        if outputFileBytes > Self.outputFileMaxBytes {
            _ = ftruncate(outputFD, 0)
            outputFileBytes = 0
        }
        let stamped = "\(timestamp.string(from: Date())) \(line)\n"
        guard let data = stamped.data(using: .utf8) else { return }
        let written = data.withUnsafeBytes { Darwin.write(outputFD, $0.baseAddress, $0.count) }
        if written == data.count {
            outputFileBytes += UInt64(written)
        } else {
            // One failed write is not worth a log line per line of output. Forget the descriptor so
            // the next spawn opens a fresh one rather than retrying a broken one forever. It is NOT
            // closed: a write fails like this when the descriptor is no longer ours, and closing a
            // number that may now belong to someone else is the crash this replaced. One leaked
            // descriptor on a rare failure costs less than that.
            outputFD = -1
        }
    }



}
