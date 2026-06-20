import Compression
import CoreImage
import CoreVideo
import Foundation

enum ScrollDeltaKind: Equatable {
    case reset
    case accepted
    case rejected(String)
    case timeout
}

struct ScrollDeltaResult {
    let kind: ScrollDeltaKind
    let envelope: OwnedGraphicsFrameEnvelope?
}

struct ScrollDeltaEngine {
    private struct Surface {
        let width: Int
        let height: Int
        let bytesPerRow: Int
        let pixels: Data
    }

    private struct ScrollOffset {
        let dx: Int
        let dy: Int
    }

    private var previous: Surface?
    private var pendingSurface: Surface?
    private var surfaceGeneration: UInt32 = 0
    private var graphicsFrameId: UInt64 = 0
    private let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])

    mutating func reserveRefreshUpdateId() -> OwnedSurfaceUpdateId {
        if surfaceGeneration == 0 {
            surfaceGeneration = 1
        }
        graphicsFrameId &+= 1
        return OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: graphicsFrameId)
    }

    mutating func commitPendingSurface() {
        guard let pendingSurface else { return }
        previous = pendingSurface
        self.pendingSurface = nil
    }

    mutating func invalidateRetainedSurface() {
        previous = nil
        pendingSurface = nil
    }

    mutating func evaluate(_ frame: CapturedVideoFrame) -> ScrollDeltaResult {
        let startedAt = DispatchTime.now().uptimeNanoseconds
        guard let current = makeSurface(frame.pixelBuffer) else {
            pendingSurface = nil
            return ScrollDeltaResult(kind: .rejected("no-bgra-surface"), envelope: nil)
        }
        pendingSurface = current
        guard let previous else {
            surfaceGeneration &+= 1
            graphicsFrameId &+= 1
            return ScrollDeltaResult(
                kind: .reset,
                envelope: makeResetEnvelope(surface: current, capturedAtUptimeNs: frame.capturedAtUptimeNs)
            )
        }
        guard previous.width == current.width, previous.height == current.height else {
            surfaceGeneration &+= 1
            graphicsFrameId &+= 1
            return ScrollDeltaResult(
                kind: .reset,
                envelope: makeResetEnvelope(surface: current, capturedAtUptimeNs: frame.capturedAtUptimeNs)
            )
        }
        guard let offset = bestScrollOffset(previous: previous, current: current, startedAt: startedAt) else {
            let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds &- startedAt) / 1_000_000.0
            return ScrollDeltaResult(kind: elapsedMs > 4 ? .timeout : .rejected("no-scroll-match"), envelope: nil)
        }
        graphicsFrameId &+= 1
        return ScrollDeltaResult(
            kind: .accepted,
            envelope: makeScrollEnvelope(
                current: current,
                offset: offset,
                capturedAtUptimeNs: frame.capturedAtUptimeNs
            )
        )
    }

    private func makeSurface(_ pixelBuffer: CVPixelBuffer) -> Surface? {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = width * 4
        var pixels = Data(count: bytesPerRow * height)
        if CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA {
            CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
            guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
            let sourceBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
            pixels.withUnsafeMutableBytes { destination in
                guard let destinationBase = destination.baseAddress else { return }
                for row in 0..<height {
                    destinationBase
                        .advanced(by: row * bytesPerRow)
                        .copyMemory(
                            from: baseAddress.advanced(by: row * sourceBytesPerRow),
                            byteCount: bytesPerRow
                        )
                }
            }
            return Surface(width: width, height: height, bytesPerRow: bytesPerRow, pixels: pixels)
        }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        pixels.withUnsafeMutableBytes { destination in
            guard let destinationBase = destination.baseAddress else { return }
            ciContext.render(
                image,
                toBitmap: destinationBase,
                rowBytes: bytesPerRow,
                bounds: CGRect(x: 0, y: 0, width: width, height: height),
                format: .BGRA8,
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
            )
        }
        return Surface(width: width, height: height, bytesPerRow: bytesPerRow, pixels: pixels)
    }

    private func bestScrollOffset(previous: Surface, current: Surface, startedAt: UInt64) -> ScrollOffset? {
        var bestOffset: ScrollOffset?
        var bestScore = 0.0
        for offset in stride(from: -240, through: 240, by: 8) where offset != 0 {
            if Double(DispatchTime.now().uptimeNanoseconds &- startedAt) / 1_000_000.0 > 4 {
                return nil
            }
            let score = verticalMatchScore(previous: previous, current: current, offset: offset)
            if score > bestScore {
                bestScore = score
                bestOffset = ScrollOffset(dx: 0, dy: offset)
            }
        }
        for offset in stride(from: -240, through: 240, by: 8) where offset != 0 {
            if Double(DispatchTime.now().uptimeNanoseconds &- startedAt) / 1_000_000.0 > 4 {
                return nil
            }
            let score = horizontalMatchScore(previous: previous, current: current, offset: offset)
            if score > bestScore {
                bestScore = score
                bestOffset = ScrollOffset(dx: offset, dy: 0)
            }
        }
        guard bestScore >= 0.92 else { return nil }
        return bestOffset
    }

    private func verticalMatchScore(previous: Surface, current: Surface, offset: Int) -> Double {
        let overlapHeight = current.height - abs(offset)
        guard overlapHeight > 16 else { return 0 }
        let stepY = max(8, overlapHeight / 80)
        let stepX = max(16, current.width / 120)
        var matches = 0
        var samples = 0
        for y in stride(from: 0, to: overlapHeight, by: stepY) {
            let previousY = offset > 0 ? y : y - offset
            let currentY = offset > 0 ? y + offset : y
            for x in stride(from: 0, to: current.width, by: stepX) {
                let oldIndex = previousY * previous.bytesPerRow + x * 4
                let newIndex = currentY * current.bytesPerRow + x * 4
                if pixelDistance(previous.pixels, oldIndex, current.pixels, newIndex) <= 24 {
                    matches += 1
                }
                samples += 1
            }
        }
        guard samples > 0 else { return 0 }
        return Double(matches) / Double(samples)
    }

    private func horizontalMatchScore(previous: Surface, current: Surface, offset: Int) -> Double {
        let overlapWidth = current.width - abs(offset)
        guard overlapWidth > 16 else { return 0 }
        let stepY = max(8, current.height / 80)
        let stepX = max(16, overlapWidth / 120)
        var matches = 0
        var samples = 0
        for y in stride(from: 0, to: current.height, by: stepY) {
            for x in stride(from: 0, to: overlapWidth, by: stepX) {
                let previousX = offset > 0 ? x : x - offset
                let currentX = offset > 0 ? x + offset : x
                let oldIndex = y * previous.bytesPerRow + previousX * 4
                let newIndex = y * current.bytesPerRow + currentX * 4
                if pixelDistance(previous.pixels, oldIndex, current.pixels, newIndex) <= 24 {
                    matches += 1
                }
                samples += 1
            }
        }
        guard samples > 0 else { return 0 }
        return Double(matches) / Double(samples)
    }

    private func pixelDistance(_ lhs: Data, _ lhsIndex: Int, _ rhs: Data, _ rhsIndex: Int) -> Int {
        abs(Int(lhs[lhsIndex]) - Int(rhs[rhsIndex])) +
            abs(Int(lhs[lhsIndex + 1]) - Int(rhs[rhsIndex + 1])) +
            abs(Int(lhs[lhsIndex + 2]) - Int(rhs[rhsIndex + 2]))
    }

    private func makeResetEnvelope(surface: Surface, capturedAtUptimeNs: UInt64) -> OwnedGraphicsFrameEnvelope? {
        guard let compressed = compressLZFSE(surface.pixels) else { return nil }
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: 2,
                payloadLength: compressed.count
            ),
            commands: [
                .resetSurface(surfaceGeneration: surfaceGeneration, width: surface.width, height: surface.height, pixelFormat: .bgra),
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: surface.width,
                    height: surface.height,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: compressed.count)
                )
            ],
            payload: compressed
        )
    }

    private func makeScrollEnvelope(
        current: Surface,
        offset: ScrollOffset,
        capturedAtUptimeNs: UInt64
    ) -> OwnedGraphicsFrameEnvelope? {
        let copyCommand: OwnedGraphicsCommand
        let tileX: Int
        let tileY: Int
        let tileWidth: Int
        let tileHeight: Int
        if offset.dy != 0 {
            let exposedY = offset.dy > 0 ? 0 : current.height + offset.dy
            let exposedHeight = abs(offset.dy)
            let stableHeight = current.height - exposedHeight
            copyCommand = offset.dy > 0
                ? .copyRect(srcX: 0, srcY: 0, dstX: 0, dstY: offset.dy, width: current.width, height: stableHeight)
                : .copyRect(srcX: 0, srcY: exposedHeight, dstX: 0, dstY: 0, width: current.width, height: stableHeight)
            tileX = 0
            tileY = exposedY
            tileWidth = current.width
            tileHeight = exposedHeight
        } else {
            let exposedX = offset.dx > 0 ? 0 : current.width + offset.dx
            let exposedWidth = abs(offset.dx)
            let stableWidth = current.width - exposedWidth
            copyCommand = offset.dx > 0
                ? .copyRect(srcX: 0, srcY: 0, dstX: offset.dx, dstY: 0, width: stableWidth, height: current.height)
                : .copyRect(srcX: exposedWidth, srcY: 0, dstX: 0, dstY: 0, width: stableWidth, height: current.height)
            tileX = exposedX
            tileY = 0
            tileWidth = exposedWidth
            tileHeight = current.height
        }
        guard let exposed = tileData(surface: current, x: tileX, y: tileY, width: tileWidth, height: tileHeight),
              let compressed = compressLZFSE(exposed) else { return nil }
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: 2,
                payloadLength: compressed.count
            ),
            commands: [
                copyCommand,
                .bitmapTile(
                    x: tileX,
                    y: tileY,
                    width: tileWidth,
                    height: tileHeight,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: compressed.count)
                )
            ],
            payload: compressed
        )
    }

    private func tileData(surface: Surface, x: Int, y: Int, width: Int, height: Int) -> Data? {
        guard x >= 0, y >= 0, width > 0, height > 0,
              x <= surface.width - width,
              y <= surface.height - height else { return nil }
        let rowBytes = width * 4
        var data = Data(count: rowBytes * height)
        surface.pixels.withUnsafeBytes { sourceBytes in
            data.withUnsafeMutableBytes { targetBytes in
                guard let sourceBase = sourceBytes.baseAddress,
                      let targetBase = targetBytes.baseAddress else { return }
                for row in 0..<height {
                    targetBase
                        .advanced(by: row * rowBytes)
                        .copyMemory(
                            from: sourceBase.advanced(by: (y + row) * surface.bytesPerRow + x * 4),
                            byteCount: rowBytes
                        )
                }
            }
        }
        return data
    }

    private func compressLZFSE(_ data: Data) -> Data? {
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
