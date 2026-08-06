import Darwin
import Foundation

protocol YabaiCommandRunning: Sendable {
    func run(arguments: [String]) async throws -> Data
}

/// The same command, for callers that are already on a background thread and are synchronous by design.
///
/// Composer sync runs its whole latch/move/write/restore sequence on one serial queue so two writers
/// cannot fight over the same Claude window; bridging back into async there would mean blocking that
/// queue on a semaphore for no gain. Both protocols are served by `YabaiProcessCommandRunner`, so
/// there is one process implementation, not two.
protocol YabaiSyncCommandRunning: Sendable {
    func runNow(arguments: [String]) throws -> Data
}

enum YabaiCommandError: Error, LocalizedError, Sendable {
    case executableUnavailable(String)
    case launchFailed(String)
    case timedOut(TimeInterval)
    case outputTooLarge(Int)
    case nonZeroExit(status: Int32, stderr: String)

    var errorDescription: String? {
        switch self {
        case .executableUnavailable(let path):
            return "yabai is missing or not executable at \(path)"
        case .launchFailed(let message):
            return "yabai could not start: \(message)"
        case .timedOut(let timeout):
            return "yabai timed out after \(timeout.formatted()) seconds"
        case .outputTooLarge(let maximumBytes):
            return "yabai output exceeded \(maximumBytes) bytes"
        case .nonZeroExit(let status, let stderr):
            let detail = stderr.isEmpty ? "no error output" : stderr
            return "yabai exited with status \(status): \(detail)"
        }
    }
}

struct YabaiProcessCommandRunner: YabaiCommandRunning, YabaiSyncCommandRunning {
    private static let maximumOutputBytes = 16 * 1_024 * 1_024

    let executableURL: URL
    let timeout: TimeInterval

    func run(arguments: [String]) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: Result { try runNow(arguments: arguments) })
            }
        }
    }

    func runNow(arguments: [String]) throws -> Data {
        try Self.runSynchronously(
            executableURL: executableURL,
            arguments: arguments,
            timeout: timeout
        )
    }

    private static func runSynchronously(
        executableURL: URL,
        arguments: [String],
        timeout: TimeInterval
    ) throws -> Data {
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw YabaiCommandError.executableUnavailable(executableURL.path)
        }

        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        let stdoutBuffer = ProcessOutputBuffer(maximumBytes: maximumOutputBytes)
        let stderrBuffer = ProcessOutputBuffer(maximumBytes: maximumOutputBytes)
        let terminated = DispatchSemaphore(value: 0)

        process.executableURL = executableURL
        process.arguments = arguments
        process.standardOutput = stdout
        process.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { handle in
            stdoutBuffer.append(handle.availableData)
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            stderrBuffer.append(handle.availableData)
        }
        process.terminationHandler = { _ in terminated.signal() }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            throw YabaiCommandError.launchFailed(error.localizedDescription)
        }

        let deadline = DispatchTime.now() + max(0.001, timeout)
        guard terminated.wait(timeout: deadline) == .success else {
            process.terminate()
            if terminated.wait(timeout: .now() + 0.25) != .success {
                kill(process.processIdentifier, SIGKILL)
                _ = terminated.wait(timeout: .now() + 0.25)
            }
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            throw YabaiCommandError.timedOut(timeout)
        }

        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        stdoutBuffer.append(stdout.fileHandleForReading.readDataToEndOfFile())
        stderrBuffer.append(stderr.fileHandleForReading.readDataToEndOfFile())

        guard !stdoutBuffer.didOverflow, !stderrBuffer.didOverflow else {
            throw YabaiCommandError.outputTooLarge(maximumOutputBytes)
        }
        guard process.terminationStatus == 0 else {
            let errorText = String(decoding: stderrBuffer.data, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw YabaiCommandError.nonZeroExit(status: process.terminationStatus, stderr: errorText)
        }
        return stdoutBuffer.data
    }
}

private final class ProcessOutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private let maximumBytes: Int
    private var storage = Data()
    private var overflowed = false

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        guard !overflowed else { return }
        guard storage.count + data.count <= maximumBytes else {
            overflowed = true
            storage.removeAll(keepingCapacity: false)
            return
        }
        storage.append(data)
    }

    var data: Data {
        lock.withLock { storage }
    }

    var didOverflow: Bool {
        lock.withLock { overflowed }
    }
}
