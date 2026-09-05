import Foundation

enum CaptureControlCommand: Equatable {
    case keyframe
    case bitrate(Int)

    static func parse(_ line: String) -> CaptureControlCommand? {
        if line == "K" { return .keyframe }
        guard line.first == "B",
              !line.dropFirst().isEmpty,
              line.dropFirst().allSatisfy(\.isNumber),
              let bits = Int(line.dropFirst()),
              (100_000...40_000_000).contains(bits) else { return nil }
        return .bitrate(bits)
    }
}
