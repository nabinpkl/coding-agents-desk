import Compression
import ImageIO
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
    private let logger = Logger(subsystem: Config.logSubsystem, category: "owned-media")
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
            // Graphics frames are the only render path now, so reflect liveness
            // in the debug overlay here. The old datagram/HEVC path used to drive
            // setOwnedMediaDebugStatus; without this the label stayed on its
            // initial "waiting" text forever even while frames flowed. Only
            // assign on change to avoid per-frame label layout churn.
            let liveStatus = "owned media: live gen \(envelope.header.surfaceGeneration)"
            if debugLabel.text != liveStatus { debugLabel.text = liveStatus }
            // A graphics (tile) frame is the only thing that refreshes
            // surfaceLayer now, so every applied frame is a screen update. Stamp
            // the render clock here so renderGapMs reflects real frame spacing.
            lastRenderUptimeNs = DispatchTime.now().uptimeNanoseconds
            ownedMediaStderrTrace("graphics-frame frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) commands=\(envelope.commands.count) bytes=\(envelope.payload.count) action=\(stats.action) compositorMs=\(Self.formatDouble(stats.compositorMs)) tileDecodeMs=\(Self.formatDouble(stats.tileDecodeMs)) tilePaintMs=\(Self.formatDouble(stats.tilePaintMs)) makeImageMs=\(Self.formatDouble(makeImageMs)) stale=\(stats.staleDiscardCount) tileBytes=\(stats.tileBytes) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(stats.totalGraphicsFramesApplied)")
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
    let tileDecodeMs: Double
    let tilePaintMs: Double
    let staleDiscardCount: Int
    let totalGraphicsFramesApplied: UInt64
    let tileBytes: Int
}

private struct OwnedSurfaceCompositorTiming {
    var tileDecodeMs = 0.0
    var tilePaintMs = 0.0
}

private enum OwnedSurfaceValidatedCommand {
    case resetSurface(surfaceGeneration: UInt32, width: Int, height: Int, baseline: OwnedSurfaceUpdateId)
    case bitmapTile(x: Int, y: Int, width: Int, height: Int, decoded: Data)
    case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, decoded: Data)
    case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)
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
    private var slotBitmaps: [UInt16: (width: Int, height: Int, pixels: Data)] = [:]

    mutating func applyGraphicsFrame(_ envelope: OwnedGraphicsFrameEnvelope) throws -> OwnedSurfaceCompositorStats {
        let startNs = DispatchTime.now().uptimeNanoseconds
        let updateId = envelope.header.updateId
        guard updateId.isStrictlyNewer(than: committedUpdateId) ||
            envelope.commands.contains(where: { command in
                if case .resetSurface = command { return true }
                return false
        }) else {
            staleDiscardCount += 1
            return stats(action: "stale-graphics", startNs: startNs, timing: .init(), tileBytes: 0)
        }
        var timing = OwnedSurfaceCompositorTiming()
        let validatedCommands: [OwnedSurfaceValidatedCommand]
        do {
            validatedCommands = try validateGraphicsFrame(envelope, updateId: updateId, timing: &timing)
        } catch OwnedSurfaceCompositorValidationError.staleReset {
            staleDiscardCount += 1
            return stats(action: "stale-reset", startNs: startNs, timing: timing, tileBytes: 0)
        }
        var tileBytes = 0
        for command in validatedCommands {
            switch command {
            case let .resetSurface(_, width, height, baseline):
                self.width = width
                self.height = height
                bytesPerRow = width * 4
                pixels = Data(count: bytesPerRow * height)
                slotBitmaps.removeAll()
                committedUpdateId = baseline
            case let .bitmapTile(x, y, width, height, decoded):
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(decoded, x: x, y: y, width: width, height: height)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                tileBytes += decoded.count
            case let .cacheTile(slot, x, y, width, height, decoded):
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(decoded, x: x, y: y, width: width, height: height)
                slotBitmaps[slot] = (width, height, decoded)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                tileBytes += decoded.count
            case let .drawCachedTile(slot, x, y, width, height):
                guard let cached = slotBitmaps[slot], cached.width == width, cached.height == height else {
                    throw SessionRejected(reason: .malformed)
                }
                let paintStartNs = DispatchTime.now().uptimeNanoseconds
                try paintTile(cached.pixels, x: x, y: y, width: width, height: height)
                timing.tilePaintMs += OwnedMediaRenderTiming.elapsedMs(
                    from: paintStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
            }
        }
        if updateId.isStrictlyNewer(than: committedUpdateId) {
            committedUpdateId = updateId
        }
        totalGraphicsFramesApplied += 1
        return stats(action: "graphics", startNs: startNs, timing: timing, tileBytes: tileBytes)
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
        tileBytes: Int
    ) -> OwnedSurfaceCompositorStats {
        OwnedSurfaceCompositorStats(
            action: action,
            compositorMs: Double(DispatchTime.now().uptimeNanoseconds &- startNs) / 1_000_000.0,
            tileDecodeMs: timing.tileDecodeMs,
            tilePaintMs: timing.tilePaintMs,
            staleDiscardCount: staleDiscardCount,
            totalGraphicsFramesApplied: totalGraphicsFramesApplied,
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
            case let .bitmapTile(x, y, width, height, compression, byteRange):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId),
                      compression == .lzfse || compression == .jpeg else {
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
                // The fullframe fallback arrives as one lossy JPEG; small tiles
                // stay lossless LZFSE. Both decode to width*height*4 BGRA so the
                // compositor paints them identically.
                let decoded: Data
                switch compression {
                case .lzfse:
                    decoded = try decompressLZFSE(Data(compressed), expectedCount: width * height * 4)
                case .jpeg:
                    decoded = try Self.decodeJPEG(Data(compressed), width: width, height: height)
                }
                timing.tileDecodeMs += OwnedMediaRenderTiming.elapsedMs(
                    from: decodeStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                validated.append(.bitmapTile(x: x, y: y, width: width, height: height, decoded: decoded))
            case let .cacheTile(slot, x, y, width, height, compression, byteRange):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId),
                      compression == .lzfse || compression == .jpeg else {
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
                let cacheEnd = byteRange.offset + byteRange.length
                guard byteRange.offset >= 0,
                      byteRange.length > 0,
                      cacheEnd <= envelope.payload.count else {
                    throw SessionRejected(reason: .malformed)
                }
                let cacheDecodeStartNs = DispatchTime.now().uptimeNanoseconds
                let cacheCompressed = Data(envelope.payload[byteRange.offset..<cacheEnd])
                let cacheDecoded: Data
                switch compression {
                case .lzfse:
                    cacheDecoded = try decompressLZFSE(cacheCompressed, expectedCount: width * height * 4)
                case .jpeg:
                    cacheDecoded = try Self.decodeJPEG(cacheCompressed, width: width, height: height)
                }
                timing.tileDecodeMs += OwnedMediaRenderTiming.elapsedMs(
                    from: cacheDecodeStartNs,
                    to: DispatchTime.now().uptimeNanoseconds
                )
                validated.append(.cacheTile(slot: slot, x: x, y: y, width: width, height: height, decoded: cacheDecoded))
            case let .drawCachedTile(slot, x, y, width, height):
                guard updateId.isStrictlyNewer(than: candidateCommittedUpdateId) else {
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
                validated.append(.drawCachedTile(slot: slot, x: x, y: y, width: width, height: height))
            }
        }
        return validated
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

    // Decode the fullframe JPEG fallback back to width*height*4 BGRA so the
    // compositor paints it like an LZFSE tile. CoreGraphics is symmetric with the
    // host CGImage encoder: both use the top-down row-0-is-top convention, so the
    // decoded buffer aligns with the surface without a vertical flip.
    private static func decodeJPEG(_ data: Data, width: Int, height: Int) throws -> Data {
        // The host may encode the fullframe JPEG smaller than the destination tile
        // (congestion downscale), so accept any source no larger than the tile and
        // let the context scale it up to fill. A larger-than-destination image is
        // malformed (the host never upsizes). LZFSE tiles still decode at exact dims.
        guard width > 0, height > 0,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width > 0, image.height > 0,
              image.width <= width, image.height <= height else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = width * 4
        var pixels = Data(count: bytesPerRow * height)
        let bitmapInfo = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        let drew = pixels.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress,
                  let context = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: bitmapInfo
                  ) else { return false }
            // Smooth the upscale of a downscaled fullframe; a no-op when dims match.
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drew else { throw SessionRejected(reason: .malformed) }
        return pixels
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
