import Foundation

/// ADR-0104: the session's own liveness round trip, carried on its own reliable QUIC stream.
///
/// The client asks and the host answers. What is being tested is not "is this QUIC connection
/// up" -- that question has a wrong answer available at exactly the wrong moment, when the radio
/// has moved and the old connection is dead but the session is perfectly alive on the next one.
/// What is being tested is whether the two ends can still complete an exchange, which is the
/// only property a remote-desktop session actually needs.
///
/// So the frame carries the session id rather than relying on the stream it arrived on. A ping
/// may leave over one connection and its pong come back over another; the id is what makes that
/// a completed round trip instead of a coincidence, and what makes a pong from a stale session
/// identifiable as one.
///
/// Frame: magic(4) | kind(1) | sequence(8) | idLength(1) | id bytes. Variable width, so the
/// reader takes the fixed head first and then exactly `idLength` more -- there is no scanning
/// and no resynchronisation, because on a reliable ordered stream there is no legitimate way to
/// land mid-frame.
public struct SessionLivenessFrame: Equatable, Sendable {
    /// 'A','D','L','V'. A mismatch is a protocol violation, not a network event.
    public static let magic: [UInt8] = [0x41, 0x44, 0x4C, 0x56]
    /// magic + kind + sequence + idLength. The id follows.
    public static let headByteCount = 14
    /// The session id is a base64url-encoded 32-byte value, so this bound is generous. It exists
    /// so a corrupt length byte cannot make the reader wait for bytes that will never come.
    public static let maxSessionIdByteCount = 64

    public enum Kind: UInt8, Sendable {
        case ping = 1
        case pong = 2
    }

    public let kind: Kind
    /// Monotonic within the SESSION, not the lane. A reconnect continues the sequence rather
    /// than restarting it, which is what lets an in-flight ping be answered after the connection
    /// carrying it has gone.
    public let sequence: UInt64
    public let sessionId: String

    public init(kind: Kind, sequence: UInt64, sessionId: String) {
        self.kind = kind
        self.sequence = sequence
        self.sessionId = sessionId
    }

    public func encode() -> Data {
        let id = Array(sessionId.utf8)
        var bytes = Self.magic
        bytes.reserveCapacity(Self.headByteCount + id.count)
        bytes.append(kind.rawValue)
        for shift in stride(from: 56, through: 0, by: -8) {
            bytes.append(UInt8((sequence >> UInt64(shift)) & 0xFF))
        }
        bytes.append(UInt8(min(id.count, Self.maxSessionIdByteCount)))
        bytes.append(contentsOf: id.prefix(Self.maxSessionIdByteCount))
        return Data(bytes)
    }

    /// How many id bytes follow this head, or nil when the head is not a liveness frame.
    ///
    /// Split from `decode` because the reader has to know the body length before it can ask for
    /// the body. A nil here means close the lane.
    public static func bodyLength(ofHead data: Data) -> Int? {
        guard data.count == headByteCount else { return nil }
        let bytes = [UInt8](data)
        guard Array(bytes[0..<4]) == magic else { return nil }
        guard Kind(rawValue: bytes[4]) != nil else { return nil }
        let length = Int(bytes[headByteCount - 1])
        guard length > 0, length <= maxSessionIdByteCount else { return nil }
        return length
    }

    /// Returns nil when the bytes are not a well-formed frame. The caller treats that as a
    /// protocol violation and closes rather than attempting to resynchronise.
    public static func decode(head: Data, body: Data) -> SessionLivenessFrame? {
        guard let expected = bodyLength(ofHead: head), body.count == expected else { return nil }
        let bytes = [UInt8](head)
        guard let kind = Kind(rawValue: bytes[4]) else { return nil }
        var sequence: UInt64 = 0
        for index in 5..<13 { sequence = (sequence << 8) | UInt64(bytes[index]) }
        guard let sessionId = String(data: body, encoding: .utf8) else { return nil }
        return SessionLivenessFrame(kind: kind, sequence: sequence, sessionId: sessionId)
    }

    /// Convenience for tests and for callers that hold the whole frame already.
    public static func decode(_ data: Data) -> SessionLivenessFrame? {
        guard data.count >= headByteCount else { return nil }
        let head = data.prefix(headByteCount)
        return decode(head: Data(head), body: Data(data.dropFirst(headByteCount)))
    }
}

/// When a session should be given up on, and how often to ask.
///
/// A pure function so the policy is testable without a connection, and so the one number that
/// tears down sessions is stated in one place.
///
/// The measurement that set these: the previous design inferred death from three *lost* datagram
/// replies, so its threshold had to stay short or it would sit on a truly dead session -- and
/// being short is what made it fire during ordinary 2-3s radio stalls. Over a reliable lane a
/// ping is not lost, it is only late, so the question is no longer "did a packet vanish" but
/// "how long a stall is worth riding out". That is a question a generous number answers better.
public enum SessionLivenessPolicy {
    /// How often the client asks while the answers are arriving.
    public static let pingIntervalMs: Double = 1_000

    /// Measured against device behaviour: cellular stalls of 2-3s that recover on their own,
    /// against a 9s freeze that did not. This sits above the former and below the latter, and
    /// leaves room for several unanswered pings before anything is declared.
    public static let defaultSilenceLimitMs: Double = 6_000

    /// The clock is time since the last COMPLETED round trip, not time since the last send. A
    /// session that is answering is alive no matter how many connections it took to answer on,
    /// and a session that is not answering is dead no matter how healthy its socket looks.
    public static func shouldDeclareSessionGone(
        msSinceLastRoundTrip: Double,
        silenceLimitMs: Double = defaultSilenceLimitMs
    ) -> Bool {
        msSinceLastRoundTrip >= silenceLimitMs
    }
}
