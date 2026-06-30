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

    // Maximum time (seconds) to wait for the sidecar to answer /api/config.
    private static let readyTimeoutSeconds: TimeInterval = 5
    // Maximum backoff between restart attempts (seconds).
    private static let maxBackoffSeconds: TimeInterval = 16

    init(binaryURL: URL, port: UInt16) {
        self.binaryURL = binaryURL
        self.port = port
        self.logger = Logger(subsystem: Config.launchAgentLabel, category: "agent-engine-sidecar")
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

    // MARK: - Private

    private func spawnAndSupervise() {
        guard !stopped else { return }

        let proc = Process()
        proc.executableURL = binaryURL
        proc.environment = [
            "ATC_PORT": String(port),
            "ATC_HOST": "127.0.0.1",
        ]
        proc.terminationHandler = { [weak self] finished in
            self?.handleTermination(status: finished.terminationStatus)
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
        logger.notice("sidecar exited unexpectedly status=\(status, privacy: .public); scheduling restart")
        baseURL = nil
        scheduleRestart()
    }

    private func scheduleRestart() {
        guard !stopped else { return }
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
