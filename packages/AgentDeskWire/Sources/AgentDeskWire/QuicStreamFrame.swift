import Foundation

public enum QuicSessionStreamRole: UInt8, Codable, Equatable, Sendable {
    case control = 1
    case input = 2
    case graphics = 3
    case dom = 4
    case terminal = 5
    case files = 6
    case voice = 7
    /// Bulk one-way asset transfer (the voice models). Separate from `voice`,
    /// which carries live dictation audio: a 152MB model moving down the same
    /// lane as speech would stall it.
    case assets = 8
    /// The Agent panel protocol (feed, composer sync, raw-event fragments,
    /// terminal lifecycle, speech). A dedicated role so the client forwards the
    /// panel protocol verbatim to its webview instead of multiplexing it onto
    /// the shared `input` lane and demuxing by a hand-maintained tag allowlist.
    case agent = 9
}

public enum QuicSessionFrameError: Error, Equatable {
    case frameTooLarge
    /// The peer sent bytes that are not a valid frame: an unknown role, or a role other than
    /// the one this read expected. A genuine protocol violation, and worth investigating as one.
    case malformed
    /// The stream ended part-way through a frame, so the read came back short. Not a protocol
    /// violation at all -- the connection went away mid-frame, which is the ordinary shape of a
    /// network handover or a peer that closed.
    ///
    /// Split out from `malformed` because collapsing the two made a reset connection
    /// indistinguishable from a bad frame. A handover reliably logged `error=malformed` on both
    /// peers, which reads as a wire bug and is not one; the real cause was a stale connection
    /// colliding with the redial (R230).
    case streamEnded(expected: Int, received: Int)
}

public struct QuicSessionStreamFrame: Equatable, Sendable {
    public static let maxFrameLength = 4 * 1024 * 1024

    public let role: QuicSessionStreamRole
    public let payload: Data

    public init(role: QuicSessionStreamRole, payload: Data) {
        self.role = role
        self.payload = payload
    }

    public static func encode(role: QuicSessionStreamRole, payload: Data) throws -> Data {
        guard payload.count <= maxFrameLength(for: role) else { throw QuicSessionFrameError.frameTooLarge }
        var data = Data()
        data.append(role.rawValue)
        data.appendUInt32BE(UInt32(payload.count))
        data.append(payload)
        return data
    }

    public static func decode(_ data: Data) throws -> QuicSessionStreamFrame {
        guard data.count >= 5,
              let role = QuicSessionStreamRole(rawValue: data[data.startIndex])
        else {
            throw QuicSessionFrameError.malformed
        }
        let length = Int(try data.readUInt32BE(at: 1))
        guard length <= maxFrameLength(for: role),
              data.count == 5 + length
        else {
            throw QuicSessionFrameError.malformed
        }
        return QuicSessionStreamFrame(
            role: role,
            payload: data.subdata(in: (data.startIndex + 5)..<data.endIndex)
        )
    }

    public static func maxFrameLength(for role: QuicSessionStreamRole) -> Int {
        switch role {
        case .files:
            WorkspaceLaneCodec.maximumFrameBytes
        case .voice:
            VoiceLaneCodec.maximumFrameBytes
        case .assets:
            VoiceAssetCodec.maximumFrameBytes
        default:
            maxFrameLength
        }
    }
}

public extension Data {
    mutating func appendUInt32BE(_ value: UInt32) {
        append(UInt8((value >> 24) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    func readUInt32BE(at offset: Int) throws -> UInt32 {
        guard count >= offset + 4 else { throw QuicSessionFrameError.malformed }
        let base = startIndex + offset
        return (UInt32(self[base]) << 24)
            | (UInt32(self[base + 1]) << 16)
            | (UInt32(self[base + 2]) << 8)
            | UInt32(self[base + 3])
    }
}
