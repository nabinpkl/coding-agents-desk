import Foundation

public enum PtyFraming {
    public static let maxFrameLength = 16 * 1024 * 1024

    public static func encodeFrame(_ payload: Data) throws -> Data {
        guard payload.count <= maxFrameLength else {
            throw PtyClientError.invalidFrameLength(payload.count)
        }
        var length = UInt32(payload.count).bigEndian
        var frame = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        frame.append(payload)
        return frame
    }

    public static func decodeFrame(_ frame: Data) throws -> Data {
        guard frame.count >= MemoryLayout<UInt32>.size else {
            throw PtyClientError.invalidFrameLength(frame.count)
        }
        let length = frame.prefix(MemoryLayout<UInt32>.size).reduce(UInt32(0)) { value, byte in
            (value << 8) | UInt32(byte)
        }
        guard length <= maxFrameLength else {
            throw PtyClientError.invalidFrameLength(Int(length))
        }
        guard frame.count == MemoryLayout<UInt32>.size + Int(length) else {
            throw PtyClientError.invalidFrameLength(frame.count)
        }
        return frame.dropFirst(MemoryLayout<UInt32>.size)
    }
}
