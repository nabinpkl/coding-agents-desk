import Foundation

struct VoicePassagePhoneObservation: Codable, Equatable, Sendable {
    static let maximumDurationSeconds: TimeInterval = 120

    let phones: [String]
    let sourceDurationSeconds: TimeInterval
    let analyzedChunkCount: Int
    let audioSHA256: String
    let modelWeightSHA256: String

    var displayText: String {
        phones.isEmpty
            ? "No phonemes were decoded from this recording."
            : phones.joined(separator: "  ")
    }
}
