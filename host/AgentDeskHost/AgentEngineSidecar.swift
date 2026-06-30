import Foundation
import os

// AgentEngineSidecar spawns the bundled ATC engine binary, polls until it
// answers /api/config on loopback, supervises the child (restarting on
// unexpected exit with a small backoff), and tears down cleanly on stop.
//
// The sidecar is host-internal and loopback-only; it is never exposed to the
// phone. Wiring it into the live AppDelegate is the responsibility of the
// bridge task (2.3), not this file.
final class AgentEngineSidecar: @unchecked Sendable {
    // Base URL on loopback once the sidecar is ready (e.g. http://127.0.0.1:7682).
    // Nil until the first successful ready-poll.
    private(set) var baseURL: URL?

    private let binaryURL: URL
    private let port: UInt16
    private let logger: Logger
    private let queue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.agent-engine-sidecar")

    private var process: Process?
    private var stopped = false
    private var restartBackoffSeconds: TimeInterval = 1
    // Collapses concurrent restart requests into one. A single induced exit can
    // reach scheduleRestart from both handleTermination and a ready-timeout
    // path; this guard ensures exactly one restart is queued per dead process.
    private var restartScheduled = false
    // Count of restarts actually dispatched. Test-observable so a unit test can
    // assert exactly one restart per induced exit without inferring from child
    // process spawn counts (which are noisy under xctest supervision). Read it
    // on the serial queue via restartCountForTesting.
    private var restartCount = 0

    // Maximum time (seconds) to wait for the sidecar to answer /api/config.
    private static let readyTimeoutSeconds: TimeInterval = 5
    // Maximum backoff between restart attempts (seconds).
    private static let maxBackoffSeconds: TimeInterval = 16

    init(binaryURL: URL, port: UInt16) {
        self.binaryURL = binaryURL
        self.port = port
        self.logger = Logger(subsystem: Config.launchAgentLabel, category: "agent-engine-sidecar")
    }

    deinit {
        // Terminate the child if the object is dropped without an explicit
        // stop() (matches JsonlChildProcess / GestureChildController). Run
        // synchronously here: by deinit the queue may no longer drain, so a
        // queued async would never fire. terminateCurrentProcess is safe to
        // call directly because no other queue work can race a deallocating self.
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
        proc.executableURL = binaryURL
        // Merge into the inherited env rather than replacing it. Setting
        // Process.environment replaces the whole child env, which would strip
        // PATH/HOME and break the engine's tmux/git/open subprocesses. Inherit
        // the parent env (matching JsonlChildProcess) and override only ours.
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "ATC_PORT": String(port),
            "ATC_HOST": "127.0.0.1",
        ]) { _, new in new }
        // Detach the child's stdio from the host's. The sidecar logs to its own
        // stdout/stderr; inheriting the host's file handles would both pollute
        // the host console and couple the child's lifetime to those handles (a
        // closed/reset parent fd can fault the child). Send child stdio to
        // /dev/null. The bridge task can add a capture pipe later if it wants
        // the engine logs.
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
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
            logger.notice("sidecar started port=\(self.port, privacy: .public)")
        } catch {
            logger.error("sidecar launch failed: \(String(describing: error), privacy: .public)")
            scheduleRestart()
            return
        }

        waitUntilReady()
    }

    private func waitUntilReady() {
        let candidate = URL(string: "http://127.0.0.1:\(port)/api/config")!
        let deadline = Date().addingTimeInterval(Self.readyTimeoutSeconds)
        var reached = false

        while Date() < deadline {
            if stopped { return }
            if let data = try? Data(contentsOf: candidate), !data.isEmpty {
                reached = true
                break
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        if reached {
            let url = URL(string: "http://127.0.0.1:\(port)")!
            baseURL = url
            restartBackoffSeconds = 1
            logger.notice("sidecar ready baseURL=\(url.absoluteString, privacy: .public)")
        } else {
            logger.error("sidecar did not become ready within \(Self.readyTimeoutSeconds, privacy: .public)s; will restart")
            terminateCurrentProcess()
            scheduleRestart()
        }
    }

    private func handleTermination(status: Int32) {
        guard !stopped else { return }
        // The OS fired this for the live process; drop our reference to it so a
        // later teardown does not touch a dead Process.
        process = nil
        logger.notice("sidecar exited unexpectedly status=\(status, privacy: .public); scheduling restart")
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
        logger.notice("sidecar restart in \(delay, privacy: .public)s")
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.spawnAndSupervise()
        }
    }

    private func terminateCurrentProcess() {
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
}
