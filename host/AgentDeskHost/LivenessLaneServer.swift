import Foundation
import Network
import os
import AgentDeskWire

/// ADR-0103: host side of the liveness lane. The client opens a stream, tags it `.liveness`,
/// and then only listens; the host pushes a fixed 16-byte heartbeat at a steady interval.
///
/// One-way on purpose. The previous design was a client probe answered by a host echo, which
/// needed BOTH directions to survive for the session to be considered alive -- and the reply
/// leg shared a congestion window with video. Measured on device, the host answered 187 of 187
/// probes while only 108 of 175 replies arrived, and three consecutive drops were read as a
/// dead host. A one-way heartbeat on a reliable stream removes the leg that was failing and
/// makes loss impossible rather than merely unlikely.
///
/// The heartbeat is deliberately unconditional: it does not stop when video is flowing. Making
/// it conditional would reintroduce the thing that made the old probe fragile -- a signal that
/// is absent both when the host is dead and when the host is simply busy.
/// Unlike the other lanes this has no ready-handler and nothing retains it. Those exist so the
/// host can send on a lane from elsewhere in the app; nothing anywhere needs to talk to this
/// one, so wiring it through `AppDelegate` would add a hop that only forwards. The beat task
/// owns everything it needs and ends itself when the stream does.
@available(macOS 26.0, *)
enum LivenessLaneServer {
    static func start(
        stream: QUIC.Stream<QUICStream>,
        fingerprint: DeviceFingerprint,
        intervalMs: Int = Config.livenessHeartbeatIntervalMs
    ) {
        let logger = Logger(subsystem: Config.logSubsystem, category: "liveness-lane")
        let intervalMs = max(100, intervalMs)
        logger.notice("liveness lane attached fp=\(fingerprint.rawValue, privacy: .public) intervalMs=\(intervalMs, privacy: .public)")
        Task { [stream, logger, fingerprint, intervalMs] in
            let startedAt = DispatchTime.now().uptimeNanoseconds
            var sequence: UInt64 = 0
            while !Task.isCancelled {
                sequence &+= 1
                let elapsedMs = (DispatchTime.now().uptimeNanoseconds &- startedAt) / 1_000_000
                let beat = LivenessHeartbeat(
                    sequence: sequence,
                    hostUptimeMs: UInt32(truncatingIfNeeded: elapsedMs)
                )
                do {
                    try await stream.send(beat.encode())
                } catch {
                    // A failed send means the stream is gone. Stop rather than spin: the client
                    // reads this same stream, so it learns the session died from the read side
                    // without needing to be told.
                    logger.notice(
                        "liveness lane send failed fp=\(fingerprint.rawValue, privacy: .public) seq=\(sequence, privacy: .public) error=\(String(describing: error), privacy: .public)"
                    )
                    return
                }
                try? await Task.sleep(for: .milliseconds(intervalMs))
            }
        }
    }
}
