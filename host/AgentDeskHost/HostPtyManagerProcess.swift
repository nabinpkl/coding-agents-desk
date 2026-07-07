import Darwin
import Foundation
import os

final class HostPtyManagerProcess: @unchecked Sendable {
    private let binaryURL: URL
    private let socketURL: URL
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal")
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).pty-manager-process")
    private var process: Process?
    private var stopped = false

    init(binaryURL: URL, socketURL: URL = Config.ptyManagerSocketURL) {
        self.binaryURL = binaryURL
        self.socketURL = socketURL
    }

    func start() {
        queue.async { [weak self] in
            self?.startOnQueue()
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.terminateProcess(waitUntilExit: false)
        }
    }

    func stopAndWait() {
        queue.sync {
            self.stopped = true
            self.terminateProcess(waitUntilExit: true)
        }
    }

    private func startOnQueue() {
        guard !stopped, process == nil else { return }
        do {
            try FileManager.default.createDirectory(
                at: socketURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
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

    private func terminateProcess(waitUntilExit: Bool) {
        guard let process else { return }
        self.process = nil
        guard process.isRunning else {
            cleanupSocket()
            return
        }
        process.terminate()
        guard waitUntilExit else { return }

        let deadline = Date().addingTimeInterval(2)
        while process.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            logger.error("pty-manager did not exit after SIGTERM; sending SIGKILL pid=\(process.processIdentifier, privacy: .public)")
            Darwin.kill(process.processIdentifier, SIGKILL)
        }
        process.waitUntilExit()
        cleanupSocket()
    }

    private func cleanupSocket() {
        try? FileManager.default.removeItem(at: socketURL)
    }
}
