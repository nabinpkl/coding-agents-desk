import Foundation
import OSLog
import AgentDeskWire

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
        let emission: (ClientRuntimeCheckpoint, Sender?)? = state.withLock { locked in
            guard locked.lastEmitted != locked.snapshot,
                  let runId = diagnostics.currentRunId() else {
                return nil
            }
            locked.sequence &+= 1
            locked.lastEmitted = locked.snapshot
            let snapshot = locked.snapshot
            return (
                ClientRuntimeCheckpoint(
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
                ),
                locked.sender
            )
        }
        guard let (checkpoint, sender) = emission else { return }
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
            level: .info
        )
        guard let sender else { return }
        Task {
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
        case .ide: .ide
        case .voice: .voice
        }
    }
}
