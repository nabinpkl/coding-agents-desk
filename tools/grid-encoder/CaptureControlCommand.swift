import Foundation

/// What the transport can ask of a running capture.
///
/// These used to be terse opcodes -- `K`, `B1200000` -- parsed by a chain in which the last
/// command's validation doubled as the reject-everything gate. Anything added after that gate was
/// unreachable by construction, and an unknown command was indistinguishable from a malformed one:
/// both returned nil and vanished without a trace. A resize command was added there once and never
/// executed a single time, silently, for a whole release.
///
/// So they are JSON now, like every other line on this pipe, decoded by type into a closed set. The
/// switch that consumes this enum is exhaustive, which means a command that is added but not
/// handled fails the build -- the exact inverse of the old shape, where it merely never ran.
enum CaptureControlCommand: Equatable {
    case keyframe
    case bitrate(Int)
    case resize(width: Int, height: Int)

    /// The line types this command set owns, for the router that decides where a line goes.
    static let types: Set<String> = ["keyframe", "bitrate", "resize"]

    /// Why a line this command set owns could not be obeyed. Reported, never swallowed.
    enum Rejection: String, Error {
        case malformed
        case outOfRange = "out-of-range"
    }

    static let bitrateRange = 100_000...200_000_000
    static let widthRange = 16...7_680
    static let heightRange = 16...4_320

    static func parse(_ object: [String: Any]) -> Result<CaptureControlCommand, Rejection>? {
        guard let type = object["type"] as? String, types.contains(type) else { return nil }
        switch type {
        case "keyframe":
            return .success(.keyframe)
        case "bitrate":
            guard let bits = object["bits"] as? Int else { return .failure(.malformed) }
            guard bitrateRange.contains(bits) else { return .failure(.outOfRange) }
            return .success(.bitrate(bits))
        case "resize":
            guard let width = object["width"] as? Int, let height = object["height"] as? Int
            else { return .failure(.malformed) }
            guard widthRange.contains(width), heightRange.contains(height)
            else { return .failure(.outOfRange) }
            return .success(.resize(width: width, height: height))
        default:
            // Unreachable while `types` and this switch agree; kept so a mismatch is a rejection
            // rather than a silent drop.
            return .failure(.malformed)
        }
    }
}
