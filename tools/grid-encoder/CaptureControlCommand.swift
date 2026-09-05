import Foundation

enum CaptureControlCommand: Equatable {
    case keyframe
    case bitrate(Int)
    /// A new encoded size for the running capture, as `R<width>x<height>`. Width and height are
    /// fixed at spawn for the stream and the compression session alike, so changing them used to
    /// mean a new child and a reconnect; this lets both be rebuilt in place instead.
    case resize(width: Int, height: Int)

    static func parse(_ line: String) -> CaptureControlCommand? {
        if line == "K" { return .keyframe }
        guard line.first == "B",
              !line.dropFirst().isEmpty,
              line.dropFirst().allSatisfy(\.isNumber),
              let bits = Int(line.dropFirst()),
              (100_000...40_000_000).contains(bits) else { return nil }
        if line.first == "R" {
            let parts = line.dropFirst().split(separator: "x", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2,
                  let width = Int(parts[0]), let height = Int(parts[1]),
                  (16...7_680).contains(width), (16...4_320).contains(height) else { return nil }
            return .resize(width: width, height: height)
        }
        return .bitrate(bits)
    }
}
