import AVFoundation
import AgentDeskWire
import CryptoKit
import Foundation

enum ReferenceAudioDownloadError: LocalizedError, Equatable {
    case invalidSequence
    case hashMismatch
    case payloadTooLarge
    case requestFailed(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidSequence:
            "Reference audio arrived out of order."
        case .hashMismatch:
            "Reference audio did not match the host artifact."
        case .payloadTooLarge:
            "Reference audio is too large to play on this iPhone."
        case .requestFailed(let status, let message):
            "Reference audio failed (\(status)): \(message)"
        }
    }
}

struct ReferenceAudioDownload {
    static let maximumBytes = 100 * 1024 * 1024

    let artifactID: String
    let expectedAudioHash: String
    let requestID: String
    private(set) var nextSequence = 0
    private(set) var data = Data()

    mutating func append(_ response: VoiceRESTResponse) throws -> Data? {
        guard response.requestID == requestID,
              response.sequence == nextSequence
        else {
            throw ReferenceAudioDownloadError.invalidSequence
        }
        guard data.count + response.body.count <= Self.maximumBytes else {
            throw ReferenceAudioDownloadError.payloadTooLarge
        }
        nextSequence += 1
        data.append(response.body)
        guard response.isFinal else { return nil }
        guard (200 ..< 300).contains(response.status) else {
            let message = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw ReferenceAudioDownloadError.requestFailed(
                status: response.status,
                message: message
            )
        }
        let actualHash = SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
        guard actualHash == expectedAudioHash else {
            throw ReferenceAudioDownloadError.hashMismatch
        }
        return data
    }
}

struct ReferenceAudioPlaybackEvent: Encodable, Equatable {
    enum Status: String, Encodable {
        case preparing
        case playing
        case completed
        case stopped
        case failed
    }

    let artifactID: String?
    let status: Status
    let error: String?
}

@MainActor
final class ReferenceAudioPlayback: NSObject, AVAudioPlayerDelegate {
    typealias Delivery = (ReferenceAudioPlaybackEvent) -> Void

    private let delivery: Delivery
    private var player: AVAudioPlayer?
    private var temporaryURL: URL?
    private var artifactID: String?
    private var audioSessionActive = false

    init(delivery: @escaping Delivery) {
        self.delivery = delivery
    }

    func preparing(artifactID: String) {
        stop(deliverStopped: false)
        self.artifactID = artifactID
        delivery(ReferenceAudioPlaybackEvent(
            artifactID: artifactID,
            status: .preparing,
            error: nil
        ))
    }

    func play(data: Data, artifactID: String) throws {
        guard self.artifactID == artifactID else { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-reference-\(artifactID).wav")
        try data.write(to: url, options: .atomic)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            audioSessionActive = true
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self
            temporaryURL = url
            self.player = player
            guard player.prepareToPlay(), player.play() else {
                throw ReferenceAudioDownloadError.requestFailed(
                    status: 500,
                    message: "The generated WAV could not start playback."
                )
            }
            delivery(ReferenceAudioPlaybackEvent(
                artifactID: artifactID,
                status: .playing,
                error: nil
            ))
        } catch {
            fail(artifactID: artifactID, message: error.localizedDescription)
            throw error
        }
    }

    func fail(artifactID: String?, message: String) {
        guard artifactID == nil || self.artifactID == artifactID else { return }
        let failedArtifactID = artifactID ?? self.artifactID
        stop(deliverStopped: false)
        delivery(ReferenceAudioPlaybackEvent(
            artifactID: failedArtifactID,
            status: .failed,
            error: message
        ))
    }

    func stop(deliverStopped: Bool = true) {
        let stoppedArtifactID = artifactID
        player?.stop()
        player = nil
        cleanup()
        if deliverStopped, stoppedArtifactID != nil {
            delivery(ReferenceAudioPlaybackEvent(
                artifactID: stoppedArtifactID,
                status: .stopped,
                error: nil
            ))
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(
        _ player: AVAudioPlayer,
        successfully flag: Bool
    ) {
        let playerIdentifier = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self,
                  let currentPlayer = self.player,
                  ObjectIdentifier(currentPlayer) == playerIdentifier
            else { return }
            let completedArtifactID = self.artifactID
            self.player = nil
            self.cleanup()
            self.delivery(ReferenceAudioPlaybackEvent(
                artifactID: completedArtifactID,
                status: flag ? .completed : .failed,
                error: flag ? nil : "Reference audio playback ended unexpectedly."
            ))
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(
        _ player: AVAudioPlayer,
        error: (any Error)?
    ) {
        let playerIdentifier = ObjectIdentifier(player)
        let errorMessage = error?.localizedDescription
        Task { @MainActor [weak self] in
            guard let self,
                  let currentPlayer = self.player,
                  ObjectIdentifier(currentPlayer) == playerIdentifier
            else { return }
            self.fail(
                artifactID: self.artifactID,
                message: errorMessage
                    ?? "Reference audio could not be decoded."
            )
        }
    }

    private func cleanup() {
        if let temporaryURL {
            try? FileManager.default.removeItem(at: temporaryURL)
        }
        temporaryURL = nil
        artifactID = nil
        guard audioSessionActive else { return }
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: [.notifyOthersOnDeactivation]
        )
        audioSessionActive = false
    }
}
