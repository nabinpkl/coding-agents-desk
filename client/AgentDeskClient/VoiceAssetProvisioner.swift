import Foundation
import OSLog
import AgentDeskWire

/// Keeps the phone's copy of the voice models in step with the Mac's.
///
/// The models are ~220MB and no longer ship inside the app, so a paired session
/// is where they arrive. This runs when a session comes up, does nothing when
/// the phone is already current, and never blocks anything the user is waiting
/// on: video, input, and every host-backed surface are unaffected while it runs.
///
/// It deliberately does not ask permission. The alternative was a prompt on a
/// surface most sessions never open, which trades a background transfer the user
/// already agreed to by pairing for a decision they have to make before Voice
/// works at all.
@available(iOS 26.0, *)
actor VoiceAssetProvisioner {
    enum Progress: Equatable, Sendable {
        case idle
        /// Asking the Mac what it has.
        case checking
        case downloading(received: UInt64, total: UInt64)
        case ready
        /// The Mac has no models, so there is nothing to fetch. Distinct from a
        /// failure: nothing is wrong with this phone or this session.
        case unavailableOnHost
        case failed(String)
    }

    static let shared = VoiceAssetProvisioner()

    private let cache: VoiceAssetCache
    private let logger = Logger(subsystem: Config.logSubsystem, category: "voice-assets")
    private var running: Task<Void, Never>?

    /// Where the transfer has got to. Only the log reads this today; the Voice
    /// surface will, once it shows the transfer instead of reporting the models
    /// as simply absent.
    private(set) var progress: Progress = .idle

    init(cache: VoiceAssetCache = .shared) {
        self.cache = cache
    }

    /// Idempotent per transfer: a second call while one is in flight joins the
    /// first rather than opening a second lane and racing it into the same
    /// staging files.
    func provision(using transport: QuicSessionClientTransport) {
        guard running == nil else { return }
        running = Task { [weak self] in
            await self?.run(using: transport)
            await self?.finish()
        }
    }

    private func finish() {
        running = nil
    }

    /// Stop provisioning against a session that is going away.
    ///
    /// This is a singleton holding a `Task` that captures the transport, so without this a
    /// download outlives its session and keeps a dead transport alive for as long as it runs.
    /// The transport now releases its QUIC connection at close either way, so this no longer
    /// blocks a reconnect (R230) -- but a global grinding through a transfer on a closed lane
    /// is work that can only fail, and the next session opens its own lane anyway.
    func cancel() async {
        guard let task = running else { return }
        task.cancel()
        // Wait for it to unwind before clearing, or `provision`'s guard goes false while the
        // old run is still going and the next session starts a second one -- two lanes racing
        // into the same staging files, which is the race that guard exists to prevent.
        // Suspending here is safe: the run's own completion path re-enters this actor to clear
        // `running`, and actor reentrancy lets it in while we wait.
        await task.value
        running = nil
        progress = .idle
    }

    private func run(using transport: QuicSessionClientTransport) async {
        progress = .checking
        do {
            let lane = try await transport.openVoiceAssetLane()
            let manifest = try await lane.manifest()
            guard !manifest.assets.isEmpty else {
                // A Mac that never ran `just voice-assets-install`. Saying so is
                // more useful than reporting a transfer failure the user cannot
                // act on from the phone.
                logger.notice("host publishes no voice assets")
                progress = .unavailableOnHost
                return
            }
            let missing = cache.missingAssets(from: manifest)
            guard !missing.isEmpty else {
                progress = .ready
                return
            }

            let total = missing.reduce(UInt64(0)) { $0 + $1.byteCount }
            var completed: UInt64 = 0
            logger.notice(
                "fetching \(missing.count) voice assets, \(total) bytes"
            )
            progress = .downloading(received: 0, total: total)
            for descriptor in missing {
                let base = completed
                try await lane.download(descriptor, into: cache) { received in
                    Task { [weak self] in
                        await self?.report(received: base + received, total: total)
                    }
                }
                completed += descriptor.byteCount
                await report(received: completed, total: total)
            }
            logger.notice("voice assets are current")
            progress = .ready
        } catch is CancellationError {
            progress = .idle
        } catch {
            // Partial transfers survive as staging files, so the next session
            // resumes rather than starting the 220MB again.
            logger.error("voice asset fetch failed: \(error.localizedDescription)")
            progress = .failed(error.localizedDescription)
        }
    }

    private func report(received: UInt64, total: UInt64) {
        // A late callback from an asset that already completed must not walk the
        // total backwards under a user watching a progress bar.
        guard case .downloading(let current, _) = progress, received > current else { return }
        progress = .downloading(received: received, total: total)
    }
}
