import Foundation
import os

enum GestureChildControllerError: Error, Equatable {
    case malformedJSON
    case oversizedLine
    case unsupportedType(String)
    case invalidDelta(Int?)
}

struct GestureChildMessage: Decodable, Equatable {
    let type: String
    let protocolVersion: Int?
    let name: String?
    let delta: Int?
    let confidence: Double?
    let createdAt: Double?
    let state: String?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case name
        case delta
        case confidence
        case createdAt
        case state
        case message
    }
}

final class GestureChildController: @unchecked Sendable {
    typealias CommitStep = (Int) -> Void

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "gesture-child")
    private let executableURL: URL
    private let arguments: [String]
    private let commitStep: CommitStep
    private let maxLineBytes: Int
    private let minimumStepInterval: TimeInterval
    private let now: () -> Date
    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var stdoutBuffer = Data()
    private var lastStepAt: Date?

    init(
        executableURL: URL,
        arguments: [String] = [],
        maxLineBytes: Int = 4096,
        minimumStepInterval: TimeInterval = 0.35,
        now: @escaping () -> Date = Date.init,
        commitStep: @escaping CommitStep
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.maxLineBytes = maxLineBytes
        self.minimumStepInterval = minimumStepInterval
        self.now = now
        self.commitStep = commitStep
    }

    deinit {
        stop()
    }

    func start() {
        guard process == nil else { return }

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = executableURL
        process.arguments = arguments
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
            self?.clearProcessHandles()
        }

        do {
            try process.run()
            self.process = process
            self.stdoutPipe = stdoutPipe
            self.stderrPipe = stderrPipe
            logger.notice("child started path=\(self.executableURL.path, privacy: .public)")
        } catch {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            logger.error("child start failed: \(String(describing: error), privacy: .public)")
        }
    }

    func stop() {
        guard let process else { return }
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        if process.isRunning {
            process.terminate()
        }
        clearProcessHandles()
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
            handleLine(line)
        }
    }

    func handleLine(_ line: String) {
        do {
            guard let delta = try Self.spaceStepDelta(from: line) else { return }
            let currentTime = now()
            if let lastStepAt, currentTime.timeIntervalSince(lastStepAt) < minimumStepInterval {
                logger.notice("dropping rate-limited spaceStep delta=\(delta, privacy: .public)")
                return
            }
            lastStepAt = currentTime
            commitStep(delta)
        } catch {
            logger.error("dropping child message: \(String(describing: error), privacy: .public)")
        }
    }

    static func spaceStepDelta(from line: String) throws -> Int? {
        guard let data = line.data(using: .utf8),
              let message = try? JSONDecoder().decode(GestureChildMessage.self, from: data)
        else {
            throw GestureChildControllerError.malformedJSON
        }

        switch message.type {
        case "hello", "ready", "status", "error":
            return nil
        case "spaceStep":
            guard message.delta == -1 || message.delta == 1 else {
                throw GestureChildControllerError.invalidDelta(message.delta)
            }
            return message.delta
        default:
            throw GestureChildControllerError.unsupportedType(message.type)
        }
    }

    private func clearProcessHandles() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        process = nil
        stdoutPipe = nil
        stderrPipe = nil
        stdoutBuffer.removeAll(keepingCapacity: true)
    }
}
