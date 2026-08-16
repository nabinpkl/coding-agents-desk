import Foundation
import Network
import os
import AgentDeskWire

/// ADR-0104: host side of the session liveness lane. The client opens a stream, tags it
/// `.liveness`, and then pings; the host answers each ping with a pong carrying the same
/// sequence.
///
/// A round trip rather than a one-way beat, because what the client needs to know is not whether
/// the host is running -- a host that is running behind a path that no longer carries anything
/// is no use to it -- but whether the two ends can still complete an exchange. Only an exchange
/// answers that, and only the end that is waiting for pixels is in a position to ask.
///
/// The host is deliberately a pure responder with no timer of its own. It never decides that a
/// client is gone from this lane, so there is no second opinion to reconcile: the client owns
/// that verdict, and the host owns only the obligation to answer. That asymmetry is the point of
/// the redesign -- the previous arrangement had a client watch and a host watch reaching
/// independent conclusions about the same silence.
///
/// The pong echoes the session id from the ping rather than the one the lane was opened with, so
/// a ping for a session this connection does not serve is answered as what it is and the client
/// can discard it. Unlike the other lanes this has no ready-handler and nothing retains it:
/// nothing anywhere needs to talk to this lane, so the task owns everything it needs and ends
/// itself when the stream does.
@available(macOS 26.0, *)
enum LivenessLaneServer {
    static func start(
        stream: QUIC.Stream<QUICStream>,
        fingerprint: DeviceFingerprint,
        sessionId: String
    ) {
        let logger = Logger(subsystem: Config.logSubsystem, category: "liveness-lane")
        logger.notice("liveness lane attached fp=\(fingerprint.rawValue, privacy: .public)")
        Task { [stream, logger, fingerprint, sessionId] in
            var answered: UInt64 = 0
            while !Task.isCancelled {
                let ping: SessionLivenessFrame
                do {
                    let head = try await stream.receive(exactly: SessionLivenessFrame.headByteCount).content
                    guard let bodyLength = SessionLivenessFrame.bodyLength(ofHead: Data(head)) else {
                        logger.error("liveness lane malformed ping head fp=\(fingerprint.rawValue, privacy: .public); closing")
                        return
                    }
                    let body = try await stream.receive(exactly: bodyLength).content
                    guard let frame = SessionLivenessFrame.decode(head: Data(head), body: Data(body)),
                          frame.kind == .ping else {
                        logger.error("liveness lane malformed ping fp=\(fingerprint.rawValue, privacy: .public); closing")
                        return
                    }
                    ping = frame
                } catch {
                    // The stream ended. Nothing to report to the client -- it reads this same
                    // stream and learns from its own side.
                    logger.notice(
                        "liveness lane ended fp=\(fingerprint.rawValue, privacy: .public) answered=\(answered, privacy: .public) error=\(String(describing: error), privacy: .public)"
                    )
                    return
                }
                if ping.sessionId != sessionId {
                    // Answered anyway, with the id that was asked for. The client is the one that
                    // knows which session it is waiting on; refusing here would turn a stale ping
                    // into silence, and silence is the one thing this lane must never manufacture.
                    logger.notice(
                        "liveness ping for another session fp=\(fingerprint.rawValue, privacy: .public) seq=\(ping.sequence, privacy: .public)"
                    )
                }
                let pong = SessionLivenessFrame(
                    kind: .pong,
                    sequence: ping.sequence,
                    sessionId: ping.sessionId
                )
                do {
                    try await stream.send(pong.encode())
                    answered &+= 1
                } catch {
                    logger.notice(
                        "liveness lane send failed fp=\(fingerprint.rawValue, privacy: .public) seq=\(ping.sequence, privacy: .public) error=\(String(describing: error), privacy: .public)"
                    )
                    return
                }
            }
        }
    }
}
