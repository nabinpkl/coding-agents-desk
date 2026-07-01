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

    // FNV-1a constants mirroring TileContentCache.hash(_:). Defined here so the
    // fused path can produce a bit-identical value without importing that type.
    private static let fnvOffsetBasis: UInt64 = 0xcbf29ce484222325
    private static let fnvPrime: UInt64       = 0x00000100000001B3

    // Fused variant: copies the tile in one pass and accumulates the FNV-1a
    // content hash as each row is written. The returned hash is bit-identical to
    // TileContentCache.hash(extractTile(...)) for the same inputs, so callers can
    // skip the second buffer walk the cache dedup would otherwise require.
    // Returns nil on the same conditions as extractTile(_:).
    static func extractTileWithHash(
        from pixels: Data,
        surfaceWidth: Int,
        surfaceHeight: Int,
        bytesPerRow: Int,
        x: Int,
        y: Int,
        width: Int,
        height: Int
    ) -> (tile: Data, hash: UInt64)? {
        guard x >= 0, y >= 0, width > 0, height > 0,
              x <= surfaceWidth - width,
              y <= surfaceHeight - height,
              bytesPerRow >= surfaceWidth * 4,
              pixels.count >= bytesPerRow * surfaceHeight else { return nil }
        let rowBytes = width * 4
        var data = Data(count: rowBytes * height)
        var h: UInt64 = fnvOffsetBasis
        pixels.withUnsafeBytes { sourceBytes in
            data.withUnsafeMutableBytes { targetBytes in
                guard let sourceBase = sourceBytes.baseAddress,
                      let targetBase = targetBytes.baseAddress else { return }
                let src = sourceBase.assumingMemoryBound(to: UInt8.self)
                let dst = targetBase.assumingMemoryBound(to: UInt8.self)
                for row in 0..<height {
                    let srcRow = src.advanced(by: (y + row) * bytesPerRow + x * 4)
                    let dstRow = dst.advanced(by: row * rowBytes)
                    // Copy the row and hash each byte in the same tight loop,
                    // eliminating the second buffer walk that the two-step
                    // extractTile + TileContentCache.hash path would require.
                    for col in 0..<rowBytes {
                        let byte = srcRow[col]
                        dstRow[col] = byte
                        h = (h ^ UInt64(byte)) &* fnvPrime
                    }
                }
            }
        }
        return (tile: data, hash: h)
    }

    // LZFSE-compress tile bytes for lossless crisp transport. Returns nil on failure.
    static func compressLZFSE(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        // Headroom for incompressible input, which LZFSE can expand slightly. The ~6.25%
        // (data.count / 16) plus a 64-byte fixed margin is well above LZFSE's worst-case
        // expansion, so compression_encode_buffer never runs out of room on real tiles. If
        // it ever does it returns 0 and the tile stays on the video floor (counted as a
        // dropped crisp tile by the caller); do not tighten this without re-checking that.
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
