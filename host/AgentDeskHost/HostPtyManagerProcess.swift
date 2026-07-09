import Darwin
import Foundation
import os

final class HostPtyManagerProcess: @unchecked Sendable {
    private let binaryURL: URL
    private let socketURL: URL
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal")
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).pty-manager-process")
    private var process: Process?

    init(binaryURL: URL, socketURL: URL = Config.ptyManagerSocketURL) {
        self.binaryURL = binaryURL
        self.socketURL = socketURL
    }

    func start() {
        queue.async { [weak self] in
            self?.startOnQueue()
        }
    }

    private func startOnQueue() {
        guard process == nil else { return }
        do {
            try FileManager.default.createDirectory(
                at: socketURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if socketAcceptsConnection() {
                logger.notice("pty-manager already listening socket=\(self.socketURL.path, privacy: .public)")
                return
            }
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

    private func socketAcceptsConnection() -> Bool {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketURL.path.utf8)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < maxPathLength else { return false }

        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: pathBytes)
            buffer[pathBytes.count] = 0
        }

        let length = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count + 1)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(descriptor, sockaddrPointer, length)
            }
        }
        return result == 0
    }
}
