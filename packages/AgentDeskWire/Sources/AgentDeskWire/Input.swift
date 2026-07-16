// Input wire types (ADR-0050). Single source of truth for host and client.

import Foundation

public enum NormalizedInput: Codable, Equatable, Sendable {
    case cursorSet(displayId: String, x: Float, y: Float)
    case cursorMove(dx: Float, dy: Float)
    case click(button: MouseButton)
    case scroll(dx: Float, dy: Float, phase: ScrollPhase)
    case dragStart
    case dragEnd
    case switchSpaceGesture(phase: SwipePhase, progress: Float, velocityX: Float)
    // Tap-to-jump: one wire frame covers an N-Space jump. The host runs
    // |delta| Began/Changed/Ended dock-swipe cycles back-to-back on a
    // dedicated serial queue, much tighter than the WSS round-trip the
    // client could afford between cycles. Sign convention matches
    // switchSpaceGesture's progress sign for the equivalent direction:
    // positive delta = same direction a positive-progress swipe would
    // commit. Client applies its direction toggle when computing the
    // sign so tap-to-jump and swipe-to-jump stay in agreement.
    case switchSpaceStep(delta: Int)
    case systemCommand(SystemCommand)
    case key(code: String, modifiers: [Modifier])
    case modifierArm(mod: Modifier)

    public enum MouseButton: String, Codable, Sendable {
        case left
        case right
        case double
    }

    // SwipePhase mirrors the CGSGesturePhase values the Dock listens
    // for on dock-swipe events. Began opens a swipe (no commit), Changed
    // streams progress while the finger moves, Ended commits (or
    // snaps back if progress + velocity are below the Dock's
    // commit threshold), Cancelled abandons.
    public enum SwipePhase: String, Codable, Sendable {
        case began
        case changed
        case ended
        case cancelled
    }

    public enum Modifier: String, Codable, Sendable {
        case cmd
        case ctrl
        case option
        case shift
    }

    public enum SystemCommand: String, Codable, Sendable {
        case missionControl
    }

    // Mirrors the two-axis macOS scroll phase model so the host can post
    // CGEvents with the right kCGScrollWheelEventScrollPhase /
    // kCGScrollWheelEventMomentumPhase combination. Without these, macOS
    // treats every event as a discrete mouse-wheel notch rather than a
    // continuous trackpad-style scroll.
    public enum ScrollPhase: String, Codable, Sendable {
        case began            // first event of a touch drag
        case changed          // subsequent events during drag
        case ended            // finger lift signal (often zero delta)
        case momentumBegan    // first inertia event after lift
        case momentumChanged  // subsequent inertia events
        case momentumEnded    // inertia decayed below cutoff
    }
}
public struct InputChannelEvent: Codable, Equatable, Sendable {
    public let type: String
    public let event: NormalizedInput
    public let cursorRevision: UInt64?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case event = "ev"
        case cursorRevision = "cr"
    }

    public init(event: NormalizedInput, cursorRevision: UInt64? = nil) {
        self.type = "input-event"
        self.event = event
        self.cursorRevision = cursorRevision
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        event = try container.decode(NormalizedInput.self, forKey: .event)
        cursorRevision = try container.decodeIfPresent(UInt64.self, forKey: .cursorRevision)

        let isCursorInput: Bool
        switch event {
        case .cursorSet, .cursorMove:
            isCursorInput = true
        default:
            isCursorInput = false
        }
        guard isCursorInput == (cursorRevision != nil) else {
            throw DecodingError.dataCorruptedError(
                forKey: .cursorRevision,
                in: container,
                debugDescription: isCursorInput
                    ? "cursor input requires a revision"
                    : "non-cursor input must not carry a cursor revision"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        let isCursorInput: Bool
        switch event {
        case .cursorSet, .cursorMove:
            isCursorInput = true
        default:
            isCursorInput = false
        }
        guard isCursorInput == (cursorRevision != nil) else {
            throw EncodingError.invalidValue(
                cursorRevision as Any,
                EncodingError.Context(
                    codingPath: encoder.codingPath,
                    debugDescription: isCursorInput
                        ? "cursor input requires a revision"
                        : "non-cursor input must not carry a cursor revision"
                )
            )
        }
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(event, forKey: .event)
        try container.encodeIfPresent(cursorRevision, forKey: .cursorRevision)
    }
}
public struct InputChannelClose: Codable, Equatable, Sendable {
    public let type: String
    public let reason: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case reason = "r"
    }

    public init(reason: String) {
        self.type = "input-close"
        self.reason = reason
    }
}
