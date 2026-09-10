import Foundation
import OSLog
import AgentDeskWire

private final class ClientRuntimeCheckpointEmitter: @unchecked Sendable {
    typealias Sender = @Sendable (ClientRuntimeCheckpoint) async throws -> Void

    private struct Emission: Sendable {
        let checkpoint: ClientRuntimeCheckpoint
        let sender: Sender?
    }

    private let continuation: AsyncStream<Emission>.Continuation
    private let task: Task<Void, Never>

    init(diagnostics: ClientDiagnosticsStore) {
        let (stream, continuation) = AsyncStream<Emission>.makeStream()
        self.continuation = continuation
        // One consumer preserves checkpoint sequence across suspended sends.
        // Independent Tasks can overtake each other on the same wire stream.
        task = Task {
            for await emission in stream {
                let checkpoint = emission.checkpoint
                diagnostics.record(
                    type: "clientRuntimeCheckpoint",
                    fields: [
                        "sequence": String(checkpoint.sequence),
                        "scenePhase": checkpoint.scenePhase.rawValue,
                        "pairingState": checkpoint.pairingState.rawValue,
                        "activeSurface": checkpoint.activeSurface.rawValue,
                        "railConfigured": String(checkpoint.railConfigured),
                        "railHidden": String(checkpoint.railHidden),
                        "railLayoutReady": String(checkpoint.railLayoutReady),
                        "hostSurfaceCount": String(checkpoint.hostSurfaceCount),
                        "mediaState": checkpoint.mediaState.rawValue,
                        "videoMilestone": checkpoint.videoMilestone.rawValue
                    ],
                    level: .info,
                    retention: .stream
                )
                guard let sender = emission.sender else { continue }
                do {
                    try await sender(checkpoint)
                } catch {
                    diagnostics.record(
                        type: "clientRuntimeCheckpointSendFailed",
                        fields: ["sequence": String(checkpoint.sequence)],
                        level: .error
                    )
                }
            }
        }
    }

    deinit {
        continuation.finish()
        task.cancel()
    }

    func enqueue(_ checkpoint: ClientRuntimeCheckpoint, sender: Sender?) {
        continuation.yield(Emission(checkpoint: checkpoint, sender: sender))
    }
}

/// One content-free runtime snapshot shared by UIKit and the media pipeline.
/// Every accepted transition is persisted before its best-effort wire send.
final class ClientRuntimeTelemetry: @unchecked Sendable {
    static let shared = ClientRuntimeTelemetry()

    typealias Sender = @Sendable (ClientRuntimeCheckpoint) async throws -> Void

    private struct Snapshot: Equatable {
        var scenePhase: ClientRuntimeScenePhase = .foreground
        var pairingState: ClientRuntimePairingState = .unpaired
        var activeSurface: ClientRuntimeSurface = .control
        var railConfigured = false
        var railHidden = false
        var railLayoutReady = false
        var hostSurfaceCount = 0
        var mediaState: ClientRuntimeMediaState = .idle
        var videoMilestone: ClientRuntimeVideoMilestone = .none
    }

    private struct State {
        var snapshot = Snapshot()
        var lastEmitted: Snapshot?
        var sequence: UInt64 = 0
        var sender: Sender?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let diagnostics: ClientDiagnosticsStore
    private let emitter: ClientRuntimeCheckpointEmitter
    private let now: @Sendable () -> Int
    private let buildIdentity: () -> (marketingVersion: String, buildNumber: String, gitSHA: String)

    init(
        diagnostics: ClientDiagnosticsStore = ClientDiagnostics.shared,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
        buildIdentity: @escaping () -> (marketingVersion: String, buildNumber: String, gitSHA: String) = {
            let info = Bundle.main.infoDictionary
            return (
                info?["CFBundleShortVersionString"] as? String ?? "0",
                info?["CFBundleVersion"] as? String ?? "0",
                (info?["AgentDeskGitSHA"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
            )
        }
    ) {
        self.diagnostics = diagnostics
        emitter = ClientRuntimeCheckpointEmitter(diagnostics: diagnostics)
        self.now = now
        self.buildIdentity = buildIdentity
    }

    func setSender(_ sender: Sender?) {
        state.withLock {
            $0.sender = sender
            if sender != nil {
                $0.lastEmitted = nil
            }
        }
        emitIfChanged()
    }

    func updateUI(
        scenePhase: ClientRuntimeScenePhase,
        pairingState: ClientRuntimePairingState,
        activeSurface: ClientRuntimeSurface,
        railConfigured: Bool,
        railHidden: Bool,
        railLayoutReady: Bool,
        hostSurfaceCount: Int
    ) {
        state.withLock {
            $0.snapshot.scenePhase = scenePhase
            $0.snapshot.pairingState = pairingState
            $0.snapshot.activeSurface = activeSurface
            $0.snapshot.railConfigured = railConfigured
            $0.snapshot.railHidden = railHidden
            $0.snapshot.railLayoutReady = railLayoutReady
            $0.snapshot.hostSurfaceCount = max(0, hostSurfaceCount)
        }
        emitIfChanged()
    }

    func updateScenePhase(_ phase: ClientRuntimeScenePhase) {
        state.withLock { $0.snapshot.scenePhase = phase }
        emitIfChanged()
    }

    func updateMediaState(_ mediaState: ClientRuntimeMediaState) {
        state.withLock { $0.snapshot.mediaState = mediaState }
        emitIfChanged()
    }

    func resetVideoMilestone() {
        state.withLock { $0.snapshot.videoMilestone = .none }
        emitIfChanged()
    }

    func advanceVideoMilestone(_ milestone: ClientRuntimeVideoMilestone) {
        state.withLock {
            guard Self.rank(milestone) > Self.rank($0.snapshot.videoMilestone) else { return }
            $0.snapshot.videoMilestone = milestone
        }
        emitIfChanged()
    }

    private func emitIfChanged() {
        let build = buildIdentity()
        let timestamp = now()
        state.withLock { locked in
            guard locked.lastEmitted != locked.snapshot,
                  let runId = diagnostics.currentRunId() else {
                return
            }
            locked.sequence &+= 1
            locked.lastEmitted = locked.snapshot
            let snapshot = locked.snapshot
            let checkpoint = ClientRuntimeCheckpoint(
                clientRunId: runId,
                sequence: locked.sequence,
                timestamp: timestamp,
                marketingVersion: build.marketingVersion,
                buildNumber: build.buildNumber,
                gitSHA: build.gitSHA,
                scenePhase: snapshot.scenePhase,
                pairingState: snapshot.pairingState,
                activeSurface: snapshot.activeSurface,
                railConfigured: snapshot.railConfigured,
                railHidden: snapshot.railHidden,
                railLayoutReady: snapshot.railLayoutReady,
                hostSurfaceCount: snapshot.hostSurfaceCount,
                mediaState: snapshot.mediaState,
                videoMilestone: snapshot.videoMilestone
            )
            emitter.enqueue(checkpoint, sender: locked.sender)
        }
    }

    private static func rank(_ milestone: ClientRuntimeVideoMilestone) -> Int {
        switch milestone {
        case .none: 0
        case .frameCompleted: 1
        case .decoderEnqueued: 2
        case .presentationAttempted: 3
        }
    }
}

extension PairingClientState {
    var runtimeCheckpointState: ClientRuntimePairingState {
        switch self {
        case .unpaired, .scanning, .revoked:
            .unpaired
        case .pairing, .awaitingApproval, .approved, .sessionConnecting:
            .connecting
        case .pairedDisconnected:
            .pairedDisconnected
        case .connected:
            .connected
        case .rejected:
            .failed
        }
    }
}

extension ControlSurface {
    var runtimeCheckpointSurface: ClientRuntimeSurface {
        switch self {
        case .control: .control
        case .agent: .agent
        case .terminal: .terminal
        case .browser: .browser
        case .workspace: .workspace
        case .voice: .voice
        }
    }
}
