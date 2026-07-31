import Foundation
import os

private final class AgentFeedReadinessProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var live = false

    func finish(live: Bool) {
        lock.lock()
        self.live = live
        lock.unlock()
    }

    var isLive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return live
    }
}

/// Resumes a readiness waiter exactly once, whichever of ready-or-timeout wins.
private final class ReadyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URL?, Never>?

    init(_ continuation: CheckedContinuation<URL?, Never>) {
        self.continuation = continuation
    }

    func finish(_ url: URL?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: url)
    }
}

// AgentFeedSidecarProcess spawns the bundled transcript sidecar, polls until it
// answers /api/config on loopback, supervises the child (restarting on
// unexpected exit with a small backoff), and tears down cleanly on stop.
//
// The sidecar is host-internal and loopback-only; the authenticated bridge,
// rather than the phone, is its sole application consumer.
final class AgentFeedSidecarProcess: @unchecked Sendable {
    // Base URL on loopback once the sidecar is ready (e.g. http://127.0.0.1:7682).
    // Nil until the first successful ready-poll.
    private(set) var baseURL: URL?

    // Callers waiting for the sidecar to come up, drained the moment it does.
    //
    // Readiness used to be observable only by polling `baseURL` at the instant a
    // request was made, which made every consumer race the launch: on 2026-07-30
    // the restored Agents window subscribed at 16:04:24.200 and the sidecar
    // published its URL at 16:04:25.251, so the window took a hard "not ready",
    // dropped its subscription, and sat on that error for the whole session
    // because nothing told it the sidecar had arrived one second later.
    private var readyWaiters: [UUID: (URL?) -> Void] = [:]

    private let binaryURL: URL
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
    // Count of restarts actually dispatched. Test-observable so a unit test can
    // assert exactly one restart per induced exit without inferring from child
    // process spawn counts (which are noisy under xctest supervision). Read it
    // on the serial queue via restartCountForTesting.
    private var restartCount = 0

    // Maximum time (seconds) to wait for the sidecar to answer /api/config.
    private static let readyTimeoutSeconds: TimeInterval = 5
    // A stale listener can accept a connection without responding. Keep each
    // readiness attempt short so stop() can always reach the supervisor queue.
    private static let readinessProbeTimeoutSeconds: TimeInterval = 0.25
    // Maximum backoff between restart attempts (seconds).
    private static let maxBackoffSeconds: TimeInterval = 16

    init(binaryURL: URL, port: UInt16) {
        self.binaryURL = binaryURL
        self.port = port
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
            // Release anyone parked on readiness now rather than leaving them to
            // time out against a sidecar that is never coming back. An unexpected
            // exit deliberately does NOT do this: those waiters should still be
            // waiting when the restart lands.
            let waiters = self.readyWaiters
            self.readyWaiters.removeAll()
            for waiter in waiters.values { waiter(nil) }
        }
    }

    // Number of restarts dispatched so far. Read synchronously on the serial
    // queue so the value is consistent with the supervisor's own mutations.
    // For tests only; the live app does not read this.
    var restartCountForTesting: Int {
        queue.sync { restartCount }
    }

    /// The base URL, waiting up to `timeout` seconds for a sidecar still coming up.
    ///
    /// Returns immediately once ready, and nil if the wait elapses or the supervisor
    /// has been stopped. Callers use this instead of reading `baseURL` so that
    /// arriving during the launch window means waiting for the sidecar rather than
    /// failing against it -- the whole point being that a consumer which asks one
    /// second early should still get a working URL rather than a dead subscription.
    func baseURL(waitingUpTo timeout: TimeInterval) async -> URL? {
        await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            let gate = ReadyGate(continuation)
            queue.async { [weak self] in
                guard let self, !self.stopped else { return gate.finish(nil) }
                if let url = self.baseURL { return gate.finish(url) }
                let token = UUID()
                self.readyWaiters[token] = { gate.finish($0) }
                self.queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                    self?.readyWaiters.removeValue(forKey: token)
                    gate.finish(nil)
                }
            }
        }
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
        // PATH/HOME and break transcript discovery. Inherit
        // the parent env and override only ours.
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "AGENT_FEED_PORT": String(port),
            "AGENT_FEED_HOST": "127.0.0.1",
        ]) { _, new in new }
        // Keep catalog and snapshot timing observable in the host unified log
        // without inheriting the host process's stdio descriptors.
        let pipe = Pipe()
        outputPipe = pipe
        outputBuffer = ""
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
            if stopped || isStopRequested { return }
            if isReady(candidate) {
                reached = true
                break
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        if reached {
            let url = URL(string: "http://127.0.0.1:\(port)")!
            baseURL = url
            restartBackoffSeconds = 1
            let waiters = readyWaiters
            readyWaiters.removeAll()
            logger.notice(
                "sidecar ready baseURL=\(url.absoluteString, privacy: .public) waiters=\(waiters.count, privacy: .public)"
            )
            for waiter in waiters.values { waiter(url) }
        } else {
            logger.error("sidecar did not become ready within \(Self.readyTimeoutSeconds, privacy: .public)s; will restart")
            terminateCurrentProcess()
            scheduleRestart()
        }
    }

    private func isReady(_ url: URL) -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = Self.readinessProbeTimeoutSeconds
        let probe = AgentFeedReadinessProbe()
        let completion = DispatchSemaphore(value: 0)
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            let live: Bool
            if let http = response as? HTTPURLResponse,
               (200..<300).contains(http.statusCode),
               let data,
               let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                live = body["watcherState"] as? String == "live"
            } else {
                live = false
            }
            probe.finish(live: live)
            completion.signal()
        }
        task.resume()
        guard completion.wait(timeout: .now() + Self.readinessProbeTimeoutSeconds) == .success else {
            task.cancel()
            return false
        }
        return probe.isLive
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
        closeOutputPipe()
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
        }
        outputBuffer = String(lines.last ?? "")
    }

    private func closeOutputPipe() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        outputBuffer = ""
    }
}
