import Foundation

/// ADR-0103: the host's "I am here" heartbeat, carried on its own reliable QUIC stream.
///
/// Deliberately fixed-width and tiny. The client reads exactly `byteCount` at a time, so there
/// is no length prefix to desynchronise and no parser to get wrong: a short read is the stream
/// ending, which is itself the signal we care about most.
///
/// The sequence number exists so a gap is visible. It should never gap -- the lane is reliable
/// and ordered -- so a gap means something is wrong in a way worth logging loudly rather than
/// silently tolerating.
public struct LivenessHeartbeat: Equatable, Sendable {
    /// 'A','D','L','V'. Guards against reading a heartbeat out of a misrouted stream; a
    /// mismatch is a protocol violation, not a network event.
    public static let magic: [UInt8] = [0x41, 0x44, 0x4C, 0x56]
    public static let byteCount = 16

    /// Monotonic per lane, starting at 1.
    public let sequence: UInt64
    /// Host uptime milliseconds, truncated to 32 bits. Diagnostic only: it lets a client log
    /// say how far apart two heartbeats were at the SENDER, which distinguishes a host that
    /// stopped sending from a path that stopped delivering.
    public let hostUptimeMs: UInt32

    public init(sequence: UInt64, hostUptimeMs: UInt32) {
        self.sequence = sequence
        self.hostUptimeMs = hostUptimeMs
    }

    public func encode() -> Data {
        var bytes = Self.magic
        bytes.reserveCapacity(Self.byteCount)
        for shift in stride(from: 56, through: 0, by: -8) {
            bytes.append(UInt8((sequence >> UInt64(shift)) & 0xFF))
        }
        for shift in stride(from: 24, through: 0, by: -8) {
            bytes.append(UInt8((hostUptimeMs >> UInt32(shift)) & 0xFF))
        }
        return Data(bytes)
    }

    /// Returns nil when the bytes are not a heartbeat. The caller treats that as a protocol
    /// violation and closes, rather than resynchronising: on a reliable ordered stream there is
    /// no legitimate way to land mid-frame.
    public static func decode(_ data: Data) -> LivenessHeartbeat? {
        guard data.count == byteCount else { return nil }
        let bytes = [UInt8](data)
        guard Array(bytes[0..<4]) == magic else { return nil }
        var sequence: UInt64 = 0
        for index in 4..<12 { sequence = (sequence << 8) | UInt64(bytes[index]) }
        var uptime: UInt32 = 0
        for index in 12..<16 { uptime = (uptime << 8) | UInt32(bytes[index]) }
        return LivenessHeartbeat(sequence: sequence, hostUptimeMs: uptime)
    }
}

/// Whether a client should declare the host gone, given how long it has been since the last
/// heartbeat arrived on the liveness lane.
///
/// A pure function so the policy is testable without a connection, and so the one number that
/// tears down sessions is stated in one place.
///
/// The threshold can afford to be generous in a way the old datagram probe could not. That one
/// inferred death from three *lost* replies, so it had to stay short or it would sit on a truly
/// dead session; being short is what made it fire during ordinary 2-3s radio stalls. Here loss
/// is impossible -- the lane retransmits -- so silence means the path is genuinely not moving,
/// and the only question left is how long a stall to ride out rather than whether one happened.
public enum LivenessLanePolicy {
    /// Sized against measured device behaviour: cellular stalls of 2-3s that recover on their
    /// own, against a 9s freeze that did not. This sits above the former and below the latter.
    public static let defaultSilenceLimitMs: Double = 6_000

    public static func shouldDeclareHostGone(
        msSinceLastHeartbeat: Double,
        silenceLimitMs: Double = defaultSilenceLimitMs
    ) -> Bool {
        msSinceLastHeartbeat >= silenceLimitMs
    }
}
