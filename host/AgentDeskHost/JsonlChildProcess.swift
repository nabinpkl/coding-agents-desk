import Foundation
import os

enum JsonlChildProcessError: Error, Equatable {
    case notRunning
    case stringEncodingFailed
}

final class JsonlChildProcess: @unchecked Sendable {
    typealias LineHandler = (String) -> Void
    typealias TerminationHandler = (Int32) -> Void

    private let logger: Logger
    private let executableURL: URL
    private let arguments: [String]
    private let maxLineBytes: Int
    private let onLine: LineHandler
    private let onTermination: TerminationHandler?
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var stdoutBuffer = Data()

    init(
        executableURL: URL,
        arguments: [String] = [],
        category: String,
        maxLineBytes: Int = 4096,
        onLine: @escaping LineHandler,
        onTermination: TerminationHandler? = nil
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.logger = Logger(subsystem: Config.logSubsystem, category: category)
        self.maxLineBytes = maxLineBytes
        self.onLine = onLine
        self.onTermination = onTermination
    }

    deinit {
        stop()
    }

    func start() {
        guard process == nil else { return }

        let process = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = executableURL
        process.arguments = arguments
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self?.receiveStdout(data)
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            self?.logger.notice("stderr: \(text, privacy: .public)")
        }
        process.terminationHandler = { [weak self] process in
            self?.logger.notice("child exited status=\(process.terminationStatus, privacy: .public)")
            self?.onTermination?(process.terminationStatus)
            self?.clearProcessHandles()
        }

        do {
            try process.run()
            self.process = process
            self.stdinPipe = stdinPipe
            self.stdoutPipe = stdoutPipe
            self.stderrPipe = stderrPipe
            logger.notice("child started path=\(self.executableURL.path, privacy: .public)")
        } catch {
            stdinPipe.fileHandleForWriting.closeFile()
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            logger.error("child start failed: \(String(describing: error), privacy: .public)")
        }
    }

    func stop() {
        guard let process else { return }
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdinPipe?.fileHandleForWriting.closeFile()
        if process.isRunning {
            process.terminate()
        }
        clearProcessHandles()
    }

    func sendLine(_ line: String) throws {
        guard let stdinPipe, process?.isRunning == true else {
            throw JsonlChildProcessError.notRunning
        }
        guard let data = "\(line)\n".data(using: .utf8) else {
            throw JsonlChildProcessError.stringEncodingFailed
        }
        stdinPipe.fileHandleForWriting.write(data)
    }

    func sendJSONObject(_ payload: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        guard let line = String(data: data, encoding: .utf8) else {
            throw JsonlChildProcessError.stringEncodingFailed
        }
        try sendLine(line)
    }

    func receiveStdout(_ data: Data) {
        stdoutBuffer.append(data)
        guard stdoutBuffer.count <= maxLineBytes else {
            logger.error("dropping oversized stdout line")
            stdoutBuffer.removeAll(keepingCapacity: true)
            return
        }

        while let newlineRange = stdoutBuffer.firstRange(of: Data([0x0A])) {
            let lineData = stdoutBuffer[..<newlineRange.lowerBound]
            stdoutBuffer.removeSubrange(...newlineRange.lowerBound)
            guard let line = String(data: lineData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !line.isEmpty
            else {
                continue
            }
            onLine(line)
        }
    }

    private func clearProcessHandles() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        process = nil
        stdinPipe = nil
        stdoutPipe = nil
        stderrPipe = nil
        stdoutBuffer.removeAll(keepingCapacity: true)
    }
}
