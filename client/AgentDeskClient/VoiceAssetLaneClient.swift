import Foundation
import Network
import OSLog
import AgentDeskWire

/// Pulls the voice models down from the paired Mac.
///
/// Chunks are written straight to the cache's staging file as they arrive
/// rather than accumulated: the largest asset is 152MB, and holding that in
/// memory to hash at the end would be the one moment this feature spikes the
/// phone. It also means a transfer that dies partway resumes from what already
/// landed instead of starting over.
@available(iOS 26.0, *)
final class VoiceAssetLaneClient {
    enum LaneError: Error, Equatable {
        case hostRefused(String)
        /// The Mac answered about a different file than the one being fetched.
        case unexpectedAsset(expected: String, received: String)
        case closed
    }

    private let stream: QUIC.Stream<QUICStream>
    private let logger = Logger(subsystem: Config.logSubsystem, category: "voice-assets")
    private var opened = false

    init(stream: QUIC.Stream<QUICStream>) {
        self.stream = stream
    }

    /// The host consumes a first frame purely to route the lane, and a
    /// zero-length frame would stall its stream read, so the announce carries a
    /// byte that means nothing.
    func open() async throws {
        guard !opened else { return }
        opened = true
        try await QuicSessionStreamIO.sendPayload(Data([0]), role: .assets, on: stream)
    }

    func manifest() async throws -> VoiceAssetManifest {
        try await send(.manifest)
        switch try await receive() {
        case .manifest(let manifest):
            return manifest
        case .failure(_, let message):
            throw LaneError.hostRefused(message)
        case .chunk:
            throw LaneError.hostRefused("expected a manifest")
        }
    }

    /// Fetches one asset into the cache, resuming from whatever already staged.
    ///
    /// `onProgress` reports bytes landed for this asset, so a first-run download
    /// of a couple of hundred megabytes can show something other than a frozen
    /// screen.
    func download(
        _ descriptor: VoiceAssetDescriptor,
        into cache: VoiceAssetCache,
        onProgress: @Sendable (UInt64) -> Void = { _ in }
    ) async throws {
        var received = cache.stagedByteCount(for: descriptor)
        // Anything staged beyond the file's own size is from an older, larger
        // version of it; start clean rather than resuming into nonsense.
        if received > descriptor.byteCount {
            try cache.resetStaging(for: descriptor)
            received = 0
        }
        if received == descriptor.byteCount, received > 0 {
            try cache.promoteStaging(for: descriptor)
            return
        }

        try await send(.fetch(path: descriptor.path, offset: received))
        while true {
            switch try await receive() {
            case .chunk(let path, _, let bytes, let isLast):
                guard path == descriptor.path else {
                    throw LaneError.unexpectedAsset(expected: descriptor.path, received: path)
                }
                if !bytes.isEmpty {
                    try cache.appendToStaging(bytes, for: descriptor)
                    received += UInt64(bytes.count)
                    onProgress(received)
                }
                if isLast {
                    try cache.promoteStaging(for: descriptor)
                    return
                }
            case .failure(_, let message):
                throw LaneError.hostRefused(message)
            case .manifest:
                throw LaneError.hostRefused("expected a chunk")
            }
        }
    }

    private func send(_ request: VoiceAssetLaneRequest) async throws {
        try await QuicSessionStreamIO.send(request, role: .assets, on: stream)
    }

    private func receive() async throws -> VoiceAssetLaneResponse {
        let frame = try await QuicSessionStreamIO.receiveFrame(on: stream, expectedRole: .assets)
        return try JSONDecoder().decode(VoiceAssetLaneResponse.self, from: frame.payload)
    }
}
