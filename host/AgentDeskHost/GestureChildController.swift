import Foundation
import os

enum GestureChildControllerError: Error, Equatable {
    case malformedJSON
    case oversizedLine
    case unsupportedType(String)
    case invalidDelta(Int?)
}

struct GesturePortalPoint: Decodable, Equatable, Sendable {
    let x: Double
    let y: Double

    init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        let x = try container.decode(Double.self)
        let y = try container.decode(Double.self)
        self.init(x: x, y: y)
    }
}

struct GesturePortalCounts: Decodable, Equatable, Sendable {
    let left: Int
    let right: Int
}

struct GesturePortalAnchor: Decodable, Equatable, Sendable {
    let center: GesturePortalPoint
    let radius: GesturePortalPoint
    let near: Bool
}

struct GesturePortalHand: Decodable, Equatable, Sendable {
    let center: GesturePortalPoint
    let landmarks: [GesturePortalPoint]
}

struct GesturePortalState: Equatable, Sendable {
    let phase: String
    let counts: GesturePortalCounts
    let anchor: GesturePortalAnchor?
    let hand: GesturePortalHand?
    let createdAt: Double?
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
    let phase: String?
    let counts: GesturePortalCounts?
    let anchor: GesturePortalAnchor?
    let hand: GesturePortalHand?

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case name
        case delta
        case confidence
        case createdAt
        case state
        case message
        case phase
        case counts
        case anchor
        case hand
    }
}

final class GestureChildController: @unchecked Sendable {
    typealias CommitStep = (Int) -> Void
    typealias GestureStateHandler = @MainActor @Sendable (GesturePortalState) -> Void

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "gesture-child")
    private let executableURL: URL
    private let arguments: [String]
    private let commitStep: CommitStep
    private let onGestureState: GestureStateHandler?
    private let maxLineBytes: Int
    private let minimumStepInterval: TimeInterval
    private let now: () -> Date
    private var childProcess: JsonlChildProcess?
    private var lastStepAt: Date?

    init(
        executableURL: URL,
        arguments: [String] = [],
        maxLineBytes: Int = 4096,
        minimumStepInterval: TimeInterval = 0.35,
        now: @escaping () -> Date = Date.init,
        onGestureState: GestureStateHandler? = nil,
        commitStep: @escaping CommitStep
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.maxLineBytes = maxLineBytes
        self.minimumStepInterval = minimumStepInterval
        self.now = now
        self.onGestureState = onGestureState
        self.commitStep = commitStep
    }

    deinit {
        stop()
    }

    func start() {
        guard childProcess == nil else { return }

        let childProcess = JsonlChildProcess(
            executableURL: executableURL,
            arguments: arguments,
            category: "gesture-child",
            maxLineBytes: maxLineBytes,
            onLine: { [weak self] line in
                self?.handleLine(line)
            },
            onTermination: { [weak self] _ in
                self?.childProcess = nil
            }
        )
        self.childProcess = childProcess
        childProcess.start()
    }

    func stop() {
        childProcess?.stop()
        childProcess = nil
    }

    func receiveStdout(_ data: Data) {
        if childProcess == nil {
            childProcess = JsonlChildProcess(
                executableURL: executableURL,
                arguments: arguments,
                category: "gesture-child",
                maxLineBytes: maxLineBytes,
                onLine: { [weak self] line in
                    self?.handleLine(line)
                }
            )
        }
        childProcess?.receiveStdout(data)
    }

    func handleLine(_ line: String) {
        do {
            let message = try Self.decodeMessage(from: line)
            if message.type == "gestureState" {
                let state = try Self.gestureState(from: message)
                if let onGestureState {
                    Task { @MainActor in onGestureState(state) }
                }
                return
            }

            guard let delta = try Self.spaceStepDelta(from: message) else { return }
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

    static func decodeMessage(from line: String) throws -> GestureChildMessage {
        guard let data = line.data(using: .utf8),
              let message = try? JSONDecoder().decode(GestureChildMessage.self, from: data)
        else {
            throw GestureChildControllerError.malformedJSON
        }
        return message
    }

    static func spaceStepDelta(from line: String) throws -> Int? {
        try spaceStepDelta(from: decodeMessage(from: line))
    }

    static func spaceStepDelta(from message: GestureChildMessage) throws -> Int? {
        switch message.type {
        case "hello", "ready", "status", "error", "gestureState":
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

    static func gestureState(from line: String) throws -> GesturePortalState? {
        let message = try decodeMessage(from: line)
        guard message.type == "gestureState" else { return nil }
        return try gestureState(from: message)
    }

    static func gestureState(from message: GestureChildMessage) throws -> GesturePortalState {
        guard message.type == "gestureState",
              let phase = message.phase,
              let counts = message.counts
        else {
            throw GestureChildControllerError.malformedJSON
        }

        return GesturePortalState(
            phase: phase,
            counts: counts,
            anchor: message.anchor,
            hand: message.hand,
            createdAt: message.createdAt
        )
    }

}
