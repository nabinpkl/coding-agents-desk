import Compression
import Foundation

// ADR-0034 crisp-repair: pure tile-pixel helpers used by RegionCrispController to turn
// a captured BGRA surface region into a lossless crisp tile. Lifted as a standalone
// codec so the crisp emitter reuses the proven extraction and LZFSE encode without
// dragging in the dormant ScrollDeltaEngine scroll routing.
enum OwnedTileCodec {
    // Copy a width*height BGRA tile out of a surface buffer. Returns nil if the rect
    // is out of bounds or degenerate, or the buffer is too small for the stated stride.
    // bytesPerRow is the surface stride in bytes.
    static func extractTile(
        from pixels: Data,
        surfaceWidth: Int,
        surfaceHeight: Int,
        bytesPerRow: Int,
        x: Int,
        y: Int,
        width: Int,
        height: Int
    ) -> Data? {
        guard x >= 0, y >= 0, width > 0, height > 0,
              x <= surfaceWidth - width,
              y <= surfaceHeight - height,
              bytesPerRow >= surfaceWidth * 4,
              pixels.count >= bytesPerRow * surfaceHeight else { return nil }
        let rowBytes = width * 4
        var data = Data(count: rowBytes * height)
        pixels.withUnsafeBytes { sourceBytes in
            data.withUnsafeMutableBytes { targetBytes in
                guard let sourceBase = sourceBytes.baseAddress,
                      let targetBase = targetBytes.baseAddress else { return }
                for row in 0..<height {
                    targetBase
                        .advanced(by: row * rowBytes)
                        .copyMemory(
                            from: sourceBase.advanced(by: (y + row) * bytesPerRow + x * 4),
                            byteCount: rowBytes
                        )
                }
            }
        }
        return data
    }

    // LZFSE-compress tile bytes for lossless crisp transport. Returns nil on failure.
    static func compressLZFSE(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        var output = Data(count: max(64, data.count + data.count / 16 + 64))
        let outputCapacity = output.count
        let encodedCount = output.withUnsafeMutableBytes { outputBytes in
            data.withUnsafeBytes { inputBytes in
                compression_encode_buffer(
                    outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    outputCapacity,
                    inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    data.count,
                    nil,
                    COMPRESSION_LZFSE
                )
            }
        }
        guard encodedCount > 0 else { return nil }
        output.removeSubrange(encodedCount..<output.count)
        return output
    }
}
