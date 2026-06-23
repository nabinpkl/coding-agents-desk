import Compression
import UIKit
import os

protocol OwnedMediaFrameSink: VideoFrameSink {
    @MainActor func renderOwnedGraphicsFrame(
        _ envelope: OwnedGraphicsFrameEnvelope,
        queueDepth: OwnedGraphicsQueueDepth
    ) -> OwnedGraphicsFrameAck
    @MainActor func currentGraphicsResetRequest(reason: String) -> OwnedGraphicsResetRequest
    @MainActor func consumePendingGraphicsResetRequest() -> OwnedGraphicsResetRequest?
    @MainActor func setOwnedMediaDebugStatus(_ status: String)
}

@MainActor
final class OwnedMediaVideoSink: OwnedMediaFrameSink, @unchecked Sendable {
    let view: UIView
    private let surfaceLayer = CALayer()
    private let debugLabel = UILabel()
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private var compositor = OwnedSurfaceCompositor()
    private var lastRenderUptimeNs: UInt64?
    private var pendingGraphicsResetRequest: OwnedGraphicsResetRequest?

    init() {
        let container = LayerBackedVideoContainerView()
        container.backgroundColor = .black
        view = container
        surfaceLayer.contentsGravity = .resizeAspect
        surfaceLayer.backgroundColor = UIColor.black.cgColor
        surfaceLayer.isHidden = true
        container.layer.addSublayer(surfaceLayer)
        debugLabel.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        debugLabel.textColor = .white
        debugLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        debugLabel.numberOfLines = 0
        debugLabel.text = "owned media: waiting"
        debugLabel.layer.cornerRadius = 6
        debugLabel.layer.masksToBounds = true
        debugLabel.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(debugLabel)
        NSLayoutConstraint.activate([
            debugLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            debugLabel.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor, constant: 8),
            debugLabel.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -8)
        ])
        container.layoutHandler = { [weak self, weak container] in
            guard let self, let bounds = container?.bounds else { return }
            self.surfaceLayer.frame = bounds
        }
    }

    /// Test hook: the most recently composited surface image, used to assert a
    /// graphics envelope rendered to a non-nil surface without driving UIKit.
    func debugCurrentImage() -> CGImage? {
        compositor.makeImage()
    }

    func renderOwnedGraphicsFrame(
        _ envelope: OwnedGraphicsFrameEnvelope,
        queueDepth: OwnedGraphicsQueueDepth = .empty
    ) -> OwnedGraphicsFrameAck {
        do {
            ownedMediaStderrTrace("graphics-frame-apply-start frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(compositor.totalGraphicsFramesApplied)")
            let stats = try compositor.applyGraphicsFrame(envelope)
            let makeImageStartNs = DispatchTime.now().uptimeNanoseconds
            surfaceLayer.contents = compositor.makeImage()
            let makeImageMs = OwnedMediaRenderTiming.elapsedMs(
                from: makeImageStartNs,
                to: DispatchTime.now().uptimeNanoseconds
            )
            surfaceLayer.isHidden = false
            // A graphics (copyRect/tile) frame is the only thing that refreshes
            // surfaceLayer now, so every applied frame is a screen update. Stamp
            // the render clock here so renderGapMs reflects real frame spacing.
            lastRenderUptimeNs = DispatchTime.now().uptimeNanoseconds
            ownedMediaStderrTrace("graphics-frame frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) commands=\(envelope.commands.count) bytes=\(envelope.payload.count) action=\(stats.action) compositorMs=\(Self.formatDouble(stats.compositorMs)) copyRectMs=\(Self.formatDouble(stats.copyRectMs)) tileDecodeMs=\(Self.formatDouble(stats.tileDecodeMs)) tilePaintMs=\(Self.formatDouble(stats.tilePaintMs)) makeImageMs=\(Self.formatDouble(makeImageMs)) stale=\(stats.staleDiscardCount) copyRects=\(stats.copyRectCount) tileBytes=\(stats.tileBytes) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(stats.totalGraphicsFramesApplied)")
            return OwnedGraphicsFrameAck(
                surfaceGeneration: envelope.header.surfaceGeneration,
                frameId: envelope.header.frameId,
                queueDepthBytes: queueDepth.queueDepthBytes,
                queuedFrames: queueDepth.queuedFrames,
                totalGraphicsFramesApplied: stats.totalGraphicsFramesApplied,
                compositorMs: stats.compositorMs,
                staleDiscardCount: stats.staleDiscardCount
            )
        } catch {
            ownedMediaStderrTrace("graphics-frame-failed frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(compositor.totalGraphicsFramesApplied) error=\(String(describing: error))")
            pendingGraphicsResetRequest = currentGraphicsResetRequest(reason: "graphics-frame-\(String(describing: error))")
            return OwnedGraphicsFrameAck(
                surfaceGeneration: compositor.committedUpdateId.surfaceGeneration,
                frameId: compositor.committedUpdateId.frameId,
                queueDepthBytes: queueDepth.queueDepthBytes,
                queuedFrames: queueDepth.queuedFrames,
                totalGraphicsFramesApplied: compositor.totalGraphicsFramesApplied,
                compositorMs: 0,
                staleDiscardCount: compositor.staleDiscardCount
            )
        }
    }

    func currentGraphicsResetRequest(reason: String) -> OwnedGraphicsResetRequest {
        let committed = compositor.committedUpdateId
        return OwnedGraphicsResetRequest(
            reason: reason,
            lastCommittedSurfaceGeneration: committed.surfaceGeneration,
            lastCommittedFrameId: committed.frameId
        )
    }

    func consumePendingGraphicsResetRequest() -> OwnedGraphicsResetRequest? {
        let request = pendingGraphicsResetRequest
        pendingGraphicsResetRequest = nil
        return request
    }

    func setOwnedMediaDebugStatus(_ status: String) {
        debugLabel.text = "owned media\n\(status)"
    }
}

private func ownedMediaStderrTrace(_ message: String) {
    guard ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_STDERR_TRACE"] == "1",
          let data = "[owned-media] \(message)\n".data(using: .utf8) else {
        return
    }
    FileHandle.standardError.write(data)
}

private extension OwnedMediaVideoSink {
    static func formatDouble(_ value: Double) -> String {
        String(format: "%.1f", value)
    }
}

struct OwnedSurfaceCompositorStats: Equatable {
    let action: String
    let compositorMs: Double
    let copyRectMs: Double
    let tileDecodeMs: Double
    let tilePaintMs: Double
    let staleDiscardCount: Int
    let totalGraphicsFramesApplied: UInt64
    let copyRectCount: Int
    let tileBytes: Int
}

private struct OwnedSurfaceCompositorTiming {
    var copyRectMs = 0.0
    var tileDecodeMs = 0.0
    var tilePaintMs = 0.0
}

private enum OwnedSurfaceValidatedCommand {
    case resetSurface(surfaceGeneration: UInt32, width: Int, height: Int, baseline: OwnedSurfaceUpdateId)
    case copyRect(srcX: Int, srcY: Int, dstX: Int, dstY: Int, width: Int, height: Int)
    case bitmapTile(x: Int, y: Int, width: Int, height: Int, decoded: Data)
}

private enum OwnedSurfaceCompositorValidationError: Error {
    case staleReset
}

struct OwnedSurfaceCompositor {
    private(set) var committedUpdateId = OwnedSurfaceUpdateId(surfaceGeneration: 0, frameId: 0)
    private(set) var staleDiscardCount = 0
    private(set) var totalGraphicsFramesApplied: UInt64 = 0
    private var width = 0
    private var height = 0
    private var bytesPerRow = 0
    private var pixels = Data()

    mutating func applyGraphicsFrame(_ envelope: OwnedGraphicsFrameEnvelope) throws -> OwnedSurfaceCompositorStats {
        let startNs = DispatchTime.now().uptimeNanoseconds
        let updateId = envelope.header.updateId
        guard updateId.isStrictlyNewer(than: committedUpdateId) ||
            envelope.commands.contains(where: { command in
                if case .resetSurface = command { return true }
                return false
        }) else {
            staleDiscardCount += 1
            return stats(action: "stale-graphics", startNs: startNs, timing: .init(), copyRects: 0, tileBytes: 0)
        }
        var timing = OwnedSurfaceCompositorTiming()
        let validatedCommands: [OwnedSurfaceValidatedCommand]
        do {
            validatedCommands = try validateGraphicsFrame(envelope, updateId: updateId, timing: &timing)
        } catch OwnedSurfaceCompositorValidationError.staleReset {
            staleDiscardCount += 1
            return stats(action: "stale-reset", startNs: startNs, timing: timing, copyRects: 0, tileBytes: 0)
        }
        var copyRects = 0
        var tileBytes = 0
        for command in validatedCommands {
            switch command {
            case let .resetSurface(_, width, height, baseline):
                self.width = width
                self.height = height
                bytesPerRow = width * 4
                pixels = Data(count: bytesPerRow * height)
                committedUpdateId = baseline
            case let .copyRect(srcX, srcY, dstX, dstY, width, height):
                let copyStartNs = DispatchTime.now().uptimeNanoseconds
                try copyRect(srcX: srcX, srcY: srcY, dstX: dstX, dstY: dstY, width: width, height: height)
                timing.copyRectMs += OwnedMediaRenderTiming.elapsedMs(
                    from: copyStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                copyRects += 1
            case let .bitmapTile(x, y, width, height, decoded):
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(decoded, x: x, y: y, width: width, height: height)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                tileBytes += decoded.count
            }
        }
        if updateId.isStrictlyNewer(than: committedUpdateId) {
            committedUpdateId = updateId
        }
        totalGraphicsFramesApplied += 1
        return stats(action: "graphics", startNs: startNs, timing: timing, copyRects: copyRects, tileBytes: tileBytes)
    }

    func makeImage() -> CGImage? {
        guard width > 0, height > 0, pixels.count == bytesPerRow * height else { return nil }
        let presentationPixels = pixels.withUnsafeBytes { bytes in
            Data(bytes)
        }
        let data = presentationPixels as CFData
        guard let provider = CGDataProvider(data: data),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue)
                .union(.byteOrder32Little),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    private func stats(
        action: String,
        startNs: UInt64,
        timing: OwnedSurfaceCompositorTiming,
        copyRects: Int,
        tileBytes: Int
    ) -> OwnedSurfaceCompositorStats {
        OwnedSurfaceCompositorStats(
            action: action,
            compositorMs: Double(DispatchTime.now().uptimeNanoseconds &- startNs) / 1_000_000.0,
            copyRectMs: timing.copyRectMs,
            tileDecodeMs: timing.tileDecodeMs,
            tilePaintMs: timing.tilePaintMs,
            staleDiscardCount: staleDiscardCount,
            totalGraphicsFramesApplied: totalGraphicsFramesApplied,
            copyRectCount: copyRects,
            tileBytes: tileBytes
        )
    }

    func pixelBytesForDiagnostics() -> Data {
        pixels
    }

    private func validateGraphicsFrame(
        _ envelope: OwnedGraphicsFrameEnvelope,
        updateId: OwnedSurfaceUpdateId,
        timing: inout OwnedSurfaceCompositorTiming
    ) throws -> [OwnedSurfaceValidatedCommand] {
        var candidateCommittedUpdateId = committedUpdateId
        var candidateWidth = width
        var candidateHeight = height
        var candidateBytesPerRow = bytesPerRow
        var candidatePixelCount = pixels.count
        var validated: [OwnedSurfaceValidatedCommand] = []
        validated.reserveCapacity(envelope.commands.count)

        for command in envelope.commands {
            switch command {
            case let .resetSurface(surfaceGeneration, width, height, pixelFormat):
                guard pixelFormat == .bgra else {
                    throw SessionRejected(reason: .malformed)
                }
                guard let baseline = OwnedSurfaceUpdateId.acceptedResetBaseline(
                        surfaceGeneration: surfaceGeneration,
                        committedSurfaceGeneration: candidateCommittedUpdateId.surfaceGeneration
                ) else {
                    throw OwnedSurfaceCompositorValidationError.staleReset
                }
                candidateWidth = width
                candidateHeight = height
                candidateBytesPerRow = width * 4
                candidatePixelCount = candidateBytesPerRow * height
                candidateCommittedUpdateId = baseline
                validated.append(.resetSurface(
                    surfaceGeneration: surfaceGeneration,
                    width: width,
                    height: height,
                    baseline: baseline
                ))
            case let .copyRect(srcX, srcY, dstX, dstY, width, height):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId) else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(
                    x: srcX,
                    y: srcY,
                    width: width,
                    height: height,
                    surfaceWidth: candidateWidth,
                    surfaceHeight: candidateHeight,
                    bytesPerRow: candidateBytesPerRow,
                    pixelCount: candidatePixelCount
                )
                try Self.validateRect(
                    x: dstX,
                    y: dstY,
                    width: width,
                    height: height,
                    surfaceWidth: candidateWidth,
                    surfaceHeight: candidateHeight,
                    bytesPerRow: candidateBytesPerRow,
                    pixelCount: candidatePixelCount
                )
                validated.append(.copyRect(srcX: srcX, srcY: srcY, dstX: dstX, dstY: dstY, width: width, height: height))
            case let .bitmapTile(x, y, width, height, compression, byteRange):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId),
                      compression == .lzfse else {
                    throw SessionRejected(reason: .malformed)
                }
                try Self.validateRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    surfaceWidth: candidateWidth,
                    surfaceHeight: candidateHeight,
                    bytesPerRow: candidateBytesPerRow,
                    pixelCount: candidatePixelCount
                )
                let end = byteRange.offset + byteRange.length
                guard byteRange.offset >= 0,
                      byteRange.length > 0,
                      end <= envelope.payload.count else {
                    throw SessionRejected(reason: .malformed)
                }
                let decodeStartNs = DispatchTime.now().uptimeNanoseconds
                let compressed = envelope.payload[byteRange.offset..<end]
                let decoded = try decompressLZFSE(Data(compressed), expectedCount: width * height * 4)
                timing.tileDecodeMs += OwnedMediaRenderTiming.elapsedMs(
                    from: decodeStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                validated.append(.bitmapTile(x: x, y: y, width: width, height: height, decoded: decoded))
            case .codecTile:
                throw SessionRejected(reason: .malformed)
            }
        }
        return validated
    }

    private mutating func copyRect(srcX: Int, srcY: Int, dstX: Int, dstY: Int, width: Int, height: Int) throws {
        try validateRect(x: srcX, y: srcY, width: width, height: height)
        try validateRect(x: dstX, y: dstY, width: width, height: height)
        let copyBytesPerRow = width * 4
        pixels.withUnsafeMutableBytes { targetBytes in
            guard let base = targetBytes.baseAddress else { return }
            if srcX == 0, dstX == 0, width == self.width {
                let source = base.advanced(by: srcY * bytesPerRow)
                let target = base.advanced(by: dstY * bytesPerRow)
                memmove(target, source, copyBytesPerRow * height)
                return
            }

            let rows: AnySequence<Int>
            if dstY > srcY {
                rows = AnySequence(stride(from: height - 1, through: 0, by: -1))
            } else {
                rows = AnySequence(0..<height)
            }
            for row in rows {
                let source = base.advanced(by: (srcY + row) * bytesPerRow + srcX * 4)
                let target = base.advanced(by: (dstY + row) * bytesPerRow + dstX * 4)
                memmove(target, source, copyBytesPerRow)
            }
        }
    }

    private func validateRect(x: Int, y: Int, width: Int, height: Int) throws {
        try Self.validateRect(
            x: x,
            y: y,
            width: width,
            height: height,
            surfaceWidth: self.width,
            surfaceHeight: self.height,
            bytesPerRow: bytesPerRow,
            pixelCount: pixels.count
        )
    }

    private static func validateRect(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        surfaceWidth: Int,
        surfaceHeight: Int,
        bytesPerRow: Int,
        pixelCount: Int
    ) throws {
        guard x >= 0, y >= 0, width > 0, height > 0,
              x <= surfaceWidth - width,
              y <= surfaceHeight - height,
              pixelCount == bytesPerRow * surfaceHeight else {
            throw SessionRejected(reason: .malformed)
        }
    }

    private mutating func paintTile(_ tile: Data, x: Int, y: Int, width: Int, height: Int) throws {
        try validateRect(x: x, y: y, width: width, height: height)
        guard tile.count == width * height * 4 else {
            throw SessionRejected(reason: .malformed)
        }
        let tileBytesPerRow = width * 4
        pixels.withUnsafeMutableBytes { targetBytes in
            tile.withUnsafeBytes { sourceBytes in
                guard let targetBase = targetBytes.baseAddress,
                      let sourceBase = sourceBytes.baseAddress else { return }
                for row in 0..<height {
                    let source = sourceBase.advanced(by: row * tileBytesPerRow)
                    let target = targetBase.advanced(by: (y + row) * bytesPerRow + x * 4)
                    target.copyMemory(from: source, byteCount: tileBytesPerRow)
                }
            }
        }
    }

    private func decompressLZFSE(_ data: Data, expectedCount: Int) throws -> Data {
        guard !data.isEmpty, expectedCount > 0 else {
            throw SessionRejected(reason: .malformed)
        }
        var output = Data(count: expectedCount)
        let decodedCount = output.withUnsafeMutableBytes { outputBytes in
            data.withUnsafeBytes { inputBytes in
                compression_decode_buffer(
                    outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    expectedCount,
                    inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    data.count,
                    nil,
                    COMPRESSION_LZFSE
                )
            }
        }
        guard decodedCount == expectedCount else {
            throw SessionRejected(reason: .malformed)
        }
        return output
    }
}

private final class LayerBackedVideoContainerView: UIView {
    var layoutHandler: (() -> Void)?

    override class var layerClass: AnyClass {
        CALayer.self
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutHandler?()
    }
}
