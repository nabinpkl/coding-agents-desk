import AgentDeskWire
import Foundation
import Network
import os

/// Answers the phone's requests for voice model files.
///
/// Deliberately thin: the provider owns what may be served and how it is read,
/// this owns the stream and the chunk loop. A fetch streams until the file ends
/// rather than making the phone ask per chunk, so a 152MB file costs one request
/// and not three hundred round trips.
@available(macOS 26.0, *)
final class VoiceAssetLaneServer: @unchecked Sendable {
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private let provider: VoiceAssetProvider
    private let logger = Logger(subsystem: Config.logSubsystem, category: "voice-assets")
    private var task: Task<Void, Never>?

    var onClose: (() -> Void)?

    init(
        stream: QUIC.Stream<QUICStream>,
        fingerprint: DeviceFingerprint,
        provider: VoiceAssetProvider
    ) {
        self.stream = stream
        self.fingerprint = fingerprint
        self.provider = provider
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            await self?.run()
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func run() async {
        defer { onClose?() }
        while !Task.isCancelled {
            do {
                let frame = try await QuicSessionStreamIO.receiveFrame(
                    on: stream,
                    expectedRole: .assets
                )
                let request = try JSONDecoder().decode(
                    VoiceAssetLaneRequest.self,
                    from: frame.payload
                )
                try await handle(request)
            } catch {
                // The phone closing the lane is the ordinary end of this loop,
                // not a fault: it fetches once and leaves.
                logger.debug(
                    "voice asset lane ended fp=\(self.fingerprint.rawValue, privacy: .public) reason=\(String(describing: error), privacy: .public)"
                )
                return
            }
        }
    }

    private func handle(_ request: VoiceAssetLaneRequest) async throws {
        switch request {
        case .manifest:
            let manifest = try provider.manifest()
            logger.notice(
                "voice asset manifest served fp=\(self.fingerprint.rawValue, privacy: .public) assets=\(manifest.assets.count, privacy: .public)"
            )
            try await send(.manifest(manifest))
        case .fetch(let path, let offset):
            try await streamAsset(path: path, from: offset)
        }
    }

    private func streamAsset(path: String, from offset: UInt64) async throws {
        var cursor = offset
        while !Task.isCancelled {
            let slice: (bytes: Data, isLast: Bool)
            do {
                slice = try provider.read(
                    path: path,
                    offset: cursor,
                    length: VoiceAssetCodec.chunkBytes
                )
            } catch {
                logger.error(
                    "voice asset fetch refused path=\(path, privacy: .public) reason=\(String(describing: error), privacy: .public)"
                )
                try await send(.failure(path: path, message: String(describing: error)))
                return
            }
            try await send(.chunk(
                path: path,
                offset: cursor,
                bytes: slice.bytes,
                isLast: slice.isLast
            ))
            if slice.isLast { return }
            cursor += UInt64(slice.bytes.count)
            // A zero-length read on a file that never reports last would spin.
            guard !slice.bytes.isEmpty else { return }
        }
    }

    private func send(_ response: VoiceAssetLaneResponse) async throws {
        try await QuicSessionStreamIO.send(response, role: .assets, on: stream)
    }
}
