import Accelerate
import Compression
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Snaps a damage rect list to a fixed grid in surface pixel space (H2). Each
// grid cell overlapped by any damage rect becomes one tile, clipped to the
// surface bounds. Fixed cells bound per-tile size and give each tile a stable
// identity for the content tile cache (see the content-tile-cache design and
// its ADR), instead of one variable-size tile over the damage union.
enum TileGrid {
    static func cells(
        covering damage: [PixelRect],
        surfaceWidth: Int,
        surfaceHeight: Int,
        gridPx: Int
    ) -> [PixelRect] {
        guard gridPx > 0, surfaceWidth > 0, surfaceHeight > 0 else { return [] }
        let columns = surfaceWidth / gridPx + 1
        var seen = Set<Int>()
        var out: [PixelRect] = []
        for rect in damage {
            let cx0 = (max(0, rect.x) / gridPx) * gridPx
            let cy0 = (max(0, rect.y) / gridPx) * gridPx
            let cx1 = min(surfaceWidth, rect.maxX)
            let cy1 = min(surfaceHeight, rect.maxY)
            var gy = cy0
            while gy < cy1 {
                var gx = cx0
                while gx < cx1 {
                    let key = (gy / gridPx) * columns + (gx / gridPx)
                    if seen.insert(key).inserted {
                        // Clip the cell to the overlapped damage extent (cx1/cy1),
                        // which is already bounded by the surface. A partial edge
                        // cell carries only the damaged pixels, not the whole
                        // grid square of unchanged content.
                        let w = min(gx + gridPx, cx1) - gx
                        let h = min(gy + gridPx, cy1) - gy
                        if w > 0 && h > 0 {
                            out.append(PixelRect(x: gx, y: gy, width: w, height: h))
                        }
                    }
                    gx += gridPx
                }
                gy += gridPx
            }
        }
        return out
    }
}

// Retained surface snapshot and scroll offset. These were defined alongside the
// deleted brute-force probe; the damage path and FrameComposer still use them, so
// they live here now.
struct ScrollDeltaSurface {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let pixels: Data
}

struct ScrollDeltaOffset {
    let dx: Int
    let dy: Int
}

enum ScrollDeltaKind: Equatable {
    case reset
    case accepted
    case rejected(String)
    case timeout
    // The damage classifier saw no change worth sending. Distinct from
    // .rejected: there is nothing to send and the pump drops the frame.
    case noChange
}

struct ScrollDeltaResult {
    let kind: ScrollDeltaKind
    let envelope: OwnedGraphicsFrameEnvelope?
    let envelopes: [OwnedGraphicsFrameEnvelope]
    let diagnostics: ScrollDeltaDiagnostics?

    init(
        kind: ScrollDeltaKind,
        envelope: OwnedGraphicsFrameEnvelope?,
        diagnostics: ScrollDeltaDiagnostics? = nil,
        envelopes: [OwnedGraphicsFrameEnvelope]? = nil
    ) {
        self.kind = kind
        self.envelope = envelope
        self.envelopes = envelopes ?? envelope.map { [$0] } ?? []
        self.diagnostics = diagnostics
    }
}

struct ScrollDeltaDiagnostics: Equatable {
    let probeMs: Double
    let payloadBuildMs: Double?
    let acceptedDx: Int?
    let acceptedDy: Int?
    let confidence: Double
    let timeoutReason: String?
    let sampledPixelCount: Int
    let bestDx: Int?
    let bestDy: Int?
    let secondBestConfidence: Double
    let candidateCount: Int
    let timeoutPhase: String?
    let probeScale: Int
    let hintActive: Bool
    let hintAxis: String?
    let hintPredictedOffset: Int?
    let hintCandidates: [Int]
    let hintSource: String?
    let acceptedBy: String?
    let tieBreak: String?
    let regionStable: Bool
    let regionSource: String?
    let regionX: Int?
    let regionY: Int?
    let regionWidth: Int?
    let regionHeight: Int?
    let fullSurfaceCopyRect: Bool
    let viewportStable: Bool
    let viewportSource: String?
    let viewportX: Int?
    let viewportY: Int?
    let viewportWidth: Int?
    let viewportHeight: Int?
    let outerRegionX: Int?
    let outerRegionY: Int?
    let outerRegionWidth: Int?
    let outerRegionHeight: Int?
    let wholeWindowCopyRect: Bool

    init(
        probeMs: Double,
        payloadBuildMs: Double?,
        acceptedDx: Int?,
        acceptedDy: Int?,
        confidence: Double,
        timeoutReason: String?,
        sampledPixelCount: Int,
        bestDx: Int? = nil,
        bestDy: Int? = nil,
        secondBestConfidence: Double = 0,
        candidateCount: Int = 0,
        timeoutPhase: String? = nil,
        probeScale: Int = 1,
        hintActive: Bool = false,
        hintAxis: String? = nil,
        hintPredictedOffset: Int? = nil,
        hintCandidates: [Int] = [],
        hintSource: String? = nil,
        acceptedBy: String? = nil,
        tieBreak: String? = nil,
        regionStable: Bool = false,
        regionSource: String? = nil,
        regionX: Int? = nil,
        regionY: Int? = nil,
        regionWidth: Int? = nil,
        regionHeight: Int? = nil,
        fullSurfaceCopyRect: Bool = false,
        viewportStable: Bool = false,
        viewportSource: String? = nil,
        viewportX: Int? = nil,
        viewportY: Int? = nil,
        viewportWidth: Int? = nil,
        viewportHeight: Int? = nil,
        outerRegionX: Int? = nil,
        outerRegionY: Int? = nil,
        outerRegionWidth: Int? = nil,
        outerRegionHeight: Int? = nil,
        wholeWindowCopyRect: Bool = false
    ) {
        self.probeMs = probeMs
        self.payloadBuildMs = payloadBuildMs
        self.acceptedDx = acceptedDx
        self.acceptedDy = acceptedDy
        self.confidence = confidence
        self.timeoutReason = timeoutReason
        self.sampledPixelCount = sampledPixelCount
        self.bestDx = bestDx
        self.bestDy = bestDy
        self.secondBestConfidence = secondBestConfidence
        self.candidateCount = candidateCount
        self.timeoutPhase = timeoutPhase
        self.probeScale = probeScale
        self.hintActive = hintActive
        self.hintAxis = hintAxis
        self.hintPredictedOffset = hintPredictedOffset
        self.hintCandidates = hintCandidates
        self.hintSource = hintSource
        self.acceptedBy = acceptedBy
        self.tieBreak = tieBreak
        self.regionStable = regionStable
        self.regionSource = regionSource
        self.regionX = regionX
        self.regionY = regionY
        self.regionWidth = regionWidth
        self.regionHeight = regionHeight
        self.fullSurfaceCopyRect = fullSurfaceCopyRect
        self.viewportStable = viewportStable
        self.viewportSource = viewportSource
        self.viewportX = viewportX
        self.viewportY = viewportY
        self.viewportWidth = viewportWidth
        self.viewportHeight = viewportHeight
        self.outerRegionX = outerRegionX
        self.outerRegionY = outerRegionY
        self.outerRegionWidth = outerRegionWidth
        self.outerRegionHeight = outerRegionHeight
        self.wholeWindowCopyRect = wholeWindowCopyRect
    }
}

struct ScrollDeltaEngine {
    static let defaultMaxDecodedResetStripePayloadBytes = 2 * 1024 * 1024
    static let defaultMaxWireResetStripeBytes = 196_608

    private typealias Surface = ScrollDeltaSurface
    private typealias ScrollOffset = ScrollDeltaOffset

    private var previous: Surface?
    private var pendingSurface: Surface?
    private var surfaceGeneration: UInt32 = 0
    private var graphicsFrameId: UInt64 = 0
    private var tileCache = TileContentCache(slotCount: Config.hybridTileCacheSlots)
    private let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
    private let maxDecodedResetStripePayloadBytes: Int
    private let maxWireResetStripeBytes: Int
    // ADR-0021 damage-driven detection is now the only path. evaluate()
    // classifies the OS damage region; there is no brute-force pixel-diff probe
    // and no viewport streak.
    private let frameComposer: FrameComposer
    // Fixed grid cell size in surface pixels for damage tile emission (H2).
    private let tileGridPx: Int
    // Hard wire-byte ceiling for a JPEG tile; quality steps down to fit it.
    private let fullframeMaxWireBytes: Int
    // Rung-3 busy threshold: LZFSE compressed bytes / raw pixel count. A cell that
    // compresses poorly (photo/gradient, above the threshold) is re-encoded as JPEG
    // to save wire bytes. Text and solid-fill cells compress well and stay LZFSE.
    private let hybridTileBusyBytesPerPixel: Double
    // Per-frame payload byte budget. Once cells in one envelope have appended this
    // many payload bytes, remaining rung-3 cells force JPEG regardless of the busy
    // test, bounding a brand-new busy fullframe to roughly one JPEG's cost.
    private let hybridFrameByteBudget: Int

    init(
        maxDecodedResetStripePayloadBytes: Int = Self.defaultMaxDecodedResetStripePayloadBytes,
        maxWireResetStripeBytes: Int = Self.defaultMaxWireResetStripeBytes,
        frameComposer: FrameComposer = FrameComposer(),
        tileGridPx: Int = Config.hybridTileGridPx,
        fullframeMaxWireBytes: Int = Config.hybridFullframeMaxWireBytes,
        hybridTileBusyBytesPerPixel: Double = Config.hybridTileBusyBytesPerPixel,
        hybridFrameByteBudget: Int = Config.hybridFrameByteBudget
    ) {
        self.maxDecodedResetStripePayloadBytes = max(1, maxDecodedResetStripePayloadBytes)
        self.maxWireResetStripeBytes = max(1, maxWireResetStripeBytes)
        self.frameComposer = frameComposer
        self.tileGridPx = max(1, tileGridPx)
        self.fullframeMaxWireBytes = max(1, fullframeMaxWireBytes)
        self.hybridTileBusyBytesPerPixel = max(0, hybridTileBusyBytesPerPixel)
        self.hybridFrameByteBudget = max(1, hybridFrameByteBudget)
    }

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
        tileCache.commitPending()
    }

    mutating func invalidateRetainedSurface() {
        previous = nil
        pendingSurface = nil
        tileCache.reset()
    }

    mutating func evaluate(
        _ frame: CapturedVideoFrame,
        motion: MotionSignal? = nil,
        policy: MotionGovernor.Policy = MotionGovernor().policy(state: .rest, heldCount: 0)
    ) -> ScrollDeltaResult {
        let startedAt = DispatchTime.now().uptimeNanoseconds
        guard let previous else {
            guard let current = makeSurface(frame.pixelBuffer) else {
                pendingSurface = nil
                return ScrollDeltaResult(kind: .rejected("no-bgra-surface"), envelope: nil)
            }
            pendingSurface = current
            surfaceGeneration &+= 1
            tileCache.reset()
            graphicsFrameId &+= 1
            let resetFrameId = graphicsFrameId
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            guard let stripedEnvelopes = makeStripedResetEnvelopes(
                surface: current,
                startingFrameId: resetFrameId,
                capturedAtUptimeNs: frame.capturedAtUptimeNs
            ), let firstEnvelope = stripedEnvelopes.first else {
                pendingSurface = nil
                return ScrollDeltaResult(kind: .rejected("reset-stripe-build-failed"), envelope: nil)
            }
            if let lastFrameId = stripedEnvelopes.last?.header.frameId {
                graphicsFrameId = lastFrameId
            }
            return ScrollDeltaResult(
                kind: .reset,
                envelope: firstEnvelope,
                diagnostics: ScrollDeltaDiagnostics(
                    probeMs: elapsedMs(since: startedAt),
                    payloadBuildMs: elapsedMs(since: payloadStartedAt),
                    acceptedDx: nil,
                    acceptedDy: nil,
                    confidence: 1.0,
                    timeoutReason: nil,
                    sampledPixelCount: 0
                ),
                envelopes: stripedEnvelopes
            )
        }
        let currentWidth = CVPixelBufferGetWidth(frame.pixelBuffer)
        let currentHeight = CVPixelBufferGetHeight(frame.pixelBuffer)
        guard previous.width == currentWidth, previous.height == currentHeight else {
            guard let current = makeSurface(frame.pixelBuffer) else {
                pendingSurface = nil
                return ScrollDeltaResult(kind: .rejected("no-bgra-surface"), envelope: nil)
            }
            pendingSurface = current
            surfaceGeneration &+= 1
            tileCache.reset()
            graphicsFrameId &+= 1
            let resetFrameId = graphicsFrameId
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            guard let stripedEnvelopes = makeStripedResetEnvelopes(
                surface: current,
                startingFrameId: resetFrameId,
                capturedAtUptimeNs: frame.capturedAtUptimeNs
            ), let firstEnvelope = stripedEnvelopes.first else {
                pendingSurface = nil
                return ScrollDeltaResult(kind: .rejected("reset-stripe-build-failed"), envelope: nil)
            }
            if let lastFrameId = stripedEnvelopes.last?.header.frameId {
                graphicsFrameId = lastFrameId
            }
            return ScrollDeltaResult(
                kind: .reset,
                envelope: firstEnvelope,
                diagnostics: ScrollDeltaDiagnostics(
                    probeMs: elapsedMs(since: startedAt),
                    payloadBuildMs: elapsedMs(since: payloadStartedAt),
                    acceptedDx: nil,
                    acceptedDy: nil,
                    confidence: 1.0,
                    timeoutReason: nil,
                    sampledPixelCount: 0
                ),
                envelopes: stripedEnvelopes
            )
        }
        return evaluateWithDamage(
            frame,
            previous: previous,
            motion: motion,
            policy: policy,
            startedAt: startedAt,
            surfaceWidth: currentWidth,
            surfaceHeight: currentHeight
        )
    }

    private func elapsedMs(since startedAt: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds &- startedAt) / 1_000_000.0
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

    private func makeStripedResetEnvelopes(
        surface: Surface,
        startingFrameId: UInt64,
        capturedAtUptimeNs: UInt64
    ) -> [OwnedGraphicsFrameEnvelope]? {
        let rowBytes = surface.width * 4
        guard rowBytes <= maxDecodedResetStripePayloadBytes else { return nil }
        let maxDecodedStripeHeight = max(1, min(surface.height, maxDecodedResetStripePayloadBytes / rowBytes))
        var envelopes: [OwnedGraphicsFrameEnvelope] = []
        var y = 0
        var frameId = startingFrameId
        while y < surface.height {
            var height = min(maxDecodedStripeHeight, surface.height - y)
            var envelope: OwnedGraphicsFrameEnvelope?
            while height > 0 {
                guard let candidate = makeResetStripeEnvelope(
                    surface: surface,
                    y: y,
                    height: height,
                    frameId: frameId,
                    capturedAtUptimeNs: capturedAtUptimeNs,
                    includesResetSurface: y == 0
                ) else {
                    return nil
                }
                if candidate.wireByteCount <= maxWireResetStripeBytes {
                    envelope = candidate
                    break
                }
                height /= 2
            }
            guard let envelope else { return nil }
            envelopes.append(envelope)
            y += height
            frameId &+= 1
        }
        return envelopes
    }

    private func makeResetStripeEnvelope(
        surface: Surface,
        y: Int,
        height: Int,
        frameId: UInt64,
        capturedAtUptimeNs: UInt64,
        includesResetSurface: Bool
    ) -> OwnedGraphicsFrameEnvelope? {
        guard height > 0 else { return nil }
        guard let stripe = tileData(surface: surface, x: 0, y: y, width: surface.width, height: height),
              let compressed = compressLZFSE(stripe) else {
            return nil
        }
        let tileCommand = OwnedGraphicsCommand.bitmapTile(
            x: 0,
            y: y,
            width: surface.width,
            height: height,
            compression: .lzfse,
            byteRange: OwnedGraphicsByteRange(offset: 0, length: compressed.count)
        )
        let commands: [OwnedGraphicsCommand]
        if includesResetSurface {
            commands = [
                .resetSurface(
                    surfaceGeneration: surfaceGeneration,
                    width: surface.width,
                    height: surface.height,
                    pixelFormat: .bgra
                ),
                tileCommand
            ]
        } else {
            commands = [tileCommand]
        }
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: commands.count,
                payloadLength: compressed.count
            ),
            commands: commands,
            payload: compressed
        )
    }

    private func makeScrollEnvelope(
        current: Surface,
        offset: ScrollOffset,
        region rect: PixelRect,
        policy: MotionGovernor.Policy,
        capturedAtUptimeNs: UInt64
    ) -> OwnedGraphicsFrameEnvelope? {
        let copyCommand: OwnedGraphicsCommand
        let tileX: Int
        let tileY: Int
        let tileWidth: Int
        let tileHeight: Int
        if offset.dy != 0 {
            let exposedY = offset.dy > 0 ? rect.y : rect.maxY + offset.dy
            let exposedHeight = abs(offset.dy)
            let stableHeight = rect.height - exposedHeight
            guard stableHeight > 0 else { return nil }
            copyCommand = offset.dy > 0
                ? .copyRect(srcX: rect.x, srcY: rect.y, dstX: rect.x, dstY: rect.y + offset.dy, width: rect.width, height: stableHeight)
                : .copyRect(srcX: rect.x, srcY: rect.y + exposedHeight, dstX: rect.x, dstY: rect.y, width: rect.width, height: stableHeight)
            tileX = rect.x
            tileY = exposedY
            tileWidth = rect.width
            tileHeight = exposedHeight
        } else {
            let exposedX = offset.dx > 0 ? rect.x : rect.maxX + offset.dx
            let exposedWidth = abs(offset.dx)
            let stableWidth = rect.width - exposedWidth
            guard stableWidth > 0 else { return nil }
            copyCommand = offset.dx > 0
                ? .copyRect(srcX: rect.x, srcY: rect.y, dstX: rect.x + offset.dx, dstY: rect.y, width: stableWidth, height: rect.height)
                : .copyRect(srcX: rect.x + exposedWidth, srcY: rect.y, dstX: rect.x, dstY: rect.y, width: stableWidth, height: rect.height)
            tileX = exposedX
            tileY = rect.y
            tileWidth = exposedWidth
            tileHeight = rect.height
        }
        // The exposed strip is lossy JPEG when it is large (a fast flick reveals a tall
        // band that is a big lossless blob) or when the scroll is fast; otherwise
        // lossless LZFSE keeps a small, slow-scroll strip crisp. Workstream B: above
        // hybridScrollFastVelocityPx the strip is also DOWNSCALED. The strip height is
        // the per-frame offset, so a fast flick's strip is large and motion-blurred
        // (unreadable at speed), making the lower resolution perceptually free while it
        // bounds the per-frame cost at the source. Velocity-gated, not content-gated:
        // the strip may be text, but fast-moving text is unreadable, so it downscales
        // too. Slow scrolls stay native and crisp; the settle pass re-renders on stop.
        // Quality is the governor's readable floor while scrolling.
        let stripRect = PixelRect(x: tileX, y: tileY, width: tileWidth, height: tileHeight)
        let velocityPx = abs(offset.dy != 0 ? offset.dy : offset.dx)
        let isFast = velocityPx >= Config.hybridScrollFastVelocityPx
        let stripRawBytes = tileWidth * tileHeight * 4
        let useLossy = isFast || stripRawBytes >= Config.hybridScrollStripLossyThresholdBytes
        let stripScale = isFast ? Config.hybridScrollFastStripScale : 1.0
        let encoding: TileEncoding = useLossy
            ? .jpeg(quality: policy.exposedStripQuality, scale: stripScale)
            : .lzfse
        guard let strip = buildTile(surface: current, rect: stripRect, encoding: encoding, payloadOffset: 0) else { return nil }
        let stripCommand = strip.command
        let payload = strip.payload
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: 2,
                payloadLength: payload.count
            ),
            commands: [copyCommand, stripCommand],
            payload: payload
        )
    }

    // ADR-0021 damage-driven detection. Classify the OS damage region and map
    // the result onto the existing envelope builders and the pump contract:
    // .scroll/.tiles -> .accepted (pump sends, then commits the surface),
    // .fullFrame/.noChange -> .rejected (pump drops the frame, no HEVC path).
    // There is no probe, no viewport streak.
    private mutating func evaluateWithDamage(
        _ frame: CapturedVideoFrame,
        previous: Surface,
        motion: MotionSignal?,
        policy: MotionGovernor.Policy,
        startedAt: UInt64,
        surfaceWidth: Int,
        surfaceHeight: Int
    ) -> ScrollDeltaResult {
        tileCache.discardPending()
        guard let current = makeSurface(frame.pixelBuffer) else {
            pendingSurface = nil
            return ScrollDeltaResult(kind: .rejected("no-bgra-surface"), envelope: nil)
        }
        let (classification, trace) = frameComposer.composeTraced(
            damageRects: frame.damageRects,
            previous: previous,
            current: current,
            motion: motion
        )
        let probeMs = elapsedMs(since: startedAt)

        // Damage covers exactly what changed, so outside the damage rects the
        // current frame already equals the previous surface. Committing
        // pendingSurface = current after a scroll copy or a tile update
        // therefore keeps the host surface identical to the client's, even
        // though only the damaged rects were sent.
        switch classification {
        case .scroll(let region, let dx, let dy):
            let offset = ScrollOffset(dx: dx, dy: dy)
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            pendingSurface = current
            graphicsFrameId &+= 1
            guard let envelope = makeScrollEnvelope(
                current: current,
                offset: offset,
                region: region,
                policy: policy,
                capturedAtUptimeNs: frame.capturedAtUptimeNs
            ) else {
                pendingSurface = nil
                return ScrollDeltaResult(
                    kind: .rejected("damage-scroll-envelope-build-failed"),
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: offset, region: region, motion: motion, trace: trace, acceptedBy: "damage", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            }
            return ScrollDeltaResult(
                kind: .accepted,
                envelope: envelope,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: offset, region: region, motion: motion, trace: trace, acceptedBy: "damage", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        case .tiles(let rects):
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            pendingSurface = current
            switch makeTileEnvelope(current: current, previous: previous, rects: rects, policy: policy, capturedAtUptimeNs: frame.capturedAtUptimeNs) {
            case .built(let envelope):
                return ScrollDeltaResult(
                    kind: .accepted,
                    envelope: envelope,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), motion: motion, trace: trace, acceptedBy: "damage-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            case .allUnchanged:
                // pendingSurface = current is already set above; current equals previous
                // on the unchanged cells and outside the damage, matching .noChange semantics.
                return ScrollDeltaResult(
                    kind: .noChange,
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), motion: motion, trace: trace, acceptedBy: nil, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            case .failed:
                pendingSurface = nil
                return ScrollDeltaResult(
                    kind: .rejected("damage-tile-envelope-build-failed"),
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), motion: motion, trace: trace, acceptedBy: "damage-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            }
        case .fullFrame(let reason):
            // A large or unstructured change tiles the WHOLE surface through the
            // same rung 1/2/3 cache ladder as .tiles, instead of shipping one
            // whole-frame JPEG that never consulted the cache. The freeze-relevant
            // win: a fullframe whose cells are all byte-identical to the retained
            // baseline now returns .noChange and ships zero bytes, where the old
            // whole-frame JPEG re-sent ~338KB every frame and saturated the reliable
            // channel (the device-run freeze). Cached cells reference slots
            // (drawCachedTile, zero payload); only genuinely-new cells carry pixels,
            // and per-cell encoding (Task 1) picks LZFSE for text and JPEG for busy
            // photo content. The dirty region is the whole surface; the tiler grids
            // it into cells. The reason string is carried into diagnostics so the
            // device log still shows why the classifier chose fullframe.
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            pendingSurface = current
            let region = PixelRect(x: 0, y: 0, width: current.width, height: current.height)
            switch makeTileEnvelope(current: current, previous: previous, rects: [region], policy: policy, capturedAtUptimeNs: frame.capturedAtUptimeNs) {
            case .built(let envelope):
                return ScrollDeltaResult(
                    kind: .accepted,
                    envelope: envelope,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: region, motion: motion, trace: trace, acceptedBy: "damage-fullframe-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            case .allUnchanged:
                // pendingSurface = current is already set above; current equals previous
                // on the unchanged cells and outside the damage, matching .noChange semantics.
                // This is the freeze fix: an all-cached fullframe ships nothing.
                return ScrollDeltaResult(
                    kind: .noChange,
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: region, motion: motion, trace: trace, acceptedBy: nil, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            case .failed:
                pendingSurface = nil
                return ScrollDeltaResult(
                    kind: .rejected("damage-fullframe-tile-envelope-build-failed-\(reason)"),
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: region, motion: motion, trace: trace, acceptedBy: "damage-fullframe-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            }
        case .noChange:
            // Nothing changed worth sending. Hold the surface (current equals
            // previous outside the empty damage) and send nothing. No fallback.
            pendingSurface = current
            return ScrollDeltaResult(
                kind: .noChange,
                envelope: nil,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: nil, offset: nil, region: nil, motion: motion, trace: trace, acceptedBy: nil, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        }
    }

    // Outcome of a tile envelope build attempt.
    private enum TileBuild {
        // At least one cell changed; the envelope is ready to send.
        case built(OwnedGraphicsFrameEnvelope)
        // Every dirty cell compared equal to the retained baseline; nothing to send.
        case allUnchanged
        // A cell extraction or compression step failed; the frame is undeliverable.
        case failed
    }

    // One bitmap tile per fixed grid cell overlapped by the damage rects (H2).
    // Snapping to a fixed grid bounds per-tile size and gives each tile a stable
    // identity for the content tile cache (see the content-tile-cache design and
    // its ADR), instead of one variable-size tile over the damage union. Each
    // cell's BGRA is LZFSE-compressed and appended to a single envelope payload
    // with its own byteRange. Sub-rect, non-full-width tiles are already
    // exercised by the scroll exposed-strip path, so this stays within proven
    // wire semantics.
    //
    // Rung 1 (Task 5): before encoding, compare each cell to the retained
    // baseline (previous). macOS dirtyRects often report a redraw that produced
    // identical pixels; an exact byte compare absorbs those redraws for free.
    // If every dirty cell is unchanged the whole frame becomes .allUnchanged
    // (zero bytes on the wire). graphicsFrameId increments only when a frame is
    // actually built, so the client sequence counter stays tight.
    private mutating func makeTileEnvelope(current: Surface, previous: Surface, rects: [PixelRect], policy: MotionGovernor.Policy, capturedAtUptimeNs: UInt64) -> TileBuild {
        let cells = TileGrid.cells(
            covering: rects,
            surfaceWidth: current.width,
            surfaceHeight: current.height,
            gridPx: tileGridPx
        )
        guard !cells.isEmpty else { return .allUnchanged }
        var commands: [OwnedGraphicsCommand] = []
        var payload = Data()
        for cell in cells {
            guard cell.area > 0,
                  let tile = tileData(surface: current, x: cell.x, y: cell.y, width: cell.width, height: cell.height) else { return .failed }
            // Rung 1: the client already shows these exact pixels here (the retained
            // baseline mirrors previous), so omit the tile. macOS dirtyRects often
            // report a redraw that produced identical pixels; this absorbs them.
            if let prior = tileData(surface: previous, x: cell.x, y: cell.y, width: cell.width, height: cell.height), prior == tile {
                continue
            }
            if Config.hybridTileCacheEnabled {
                let h = TileContentCache.hash(tile)
                // Rung 2: client already holds this content in a slot; reference it.
                // Touch the slot so its recency refreshes on commit and the hot
                // content the cache exists to keep resident is not evicted first.
                if let slot = tileCache.lookup(hash: h, bytes: tile) {
                    tileCache.touch(slot: slot)
                    commands.append(.drawCachedTile(slot: slot, x: cell.x, y: cell.y, width: cell.width, height: cell.height))
                    continue
                }
                // Rung 3: send the pixels and stage the slot (committed on send success).
                // The cache slot is always keyed on source (unencoded) bytes, so
                // TileContentCache.assign(hash:bytes:) always receives the raw BGRA tile
                // regardless of the encoding chosen below. This is the coherence
                // guarantee: same source -> same hash -> same slot on every peer.
                guard let lzfseCompressed = compressLZFSE(tile) else { return .failed }
                let slot = tileCache.assign(hash: h, bytes: tile)
                // Decide encoding: if the LZFSE output is "busy" (bytes-per-pixel
                // above the threshold), re-encode as JPEG at the current congestion
                // quality and scale. Poorly-compressible content (photo, gradient) is
                // where JPEG quality is already acceptable; text and solid-fill stay
                // lossless. The threshold is ~2.0 bpp by default, which cleanly
                // separates text (well under 0.5 bpp LZFSE) from near-raw photo content
                // (LZFSE approaches 3-4 bpp on random per-pixel noise).
                let pixelCount = cell.width * cell.height
                let lzfseBytesPerPixel = pixelCount > 0 ? Double(lzfseCompressed.count) / Double(pixelCount) : 0
                let isBusy = lzfseBytesPerPixel > hybridTileBusyBytesPerPixel
                // payload.count is the running total of bytes appended by earlier
                // rung-3 cells in this envelope. Rung-1 (omitted) and rung-2
                // (drawCachedTile) cells appended nothing, so they never inflate it
                // and never consume the budget. Once the budget is crossed, force
                // JPEG on every remaining new cell regardless of the busy test, so a
                // genuinely-new busy fullframe cannot sum past roughly one JPEG.
                let budgetExceeded = payload.count >= hybridFrameByteBudget
                if isBusy || budgetExceeded, let jpegBuilt = buildTile(
                    surface: current,
                    rect: cell,
                    encoding: .jpeg(
                        quality: policy.exposedStripQuality,
                        // Content-gated resolution: only busy (photo) cells downscale
                        // under backpressure; text cells stay native (downscaling blurs
                        // glyphs worse than a quality drop).
                        scale: isBusy ? policy.busyResolutionScale : 1.0
                    ),
                    payloadOffset: payload.count
                ) {
                    // buildTile emits a bitmapTile command; rewrap as cacheTile with slot.
                    commands.append(.cacheTile(
                        slot: slot, x: cell.x, y: cell.y, width: cell.width, height: cell.height,
                        compression: .jpeg, byteRange: OwnedGraphicsByteRange(offset: payload.count, length: jpegBuilt.payload.count)
                    ))
                    payload.append(jpegBuilt.payload)
                } else {
                    commands.append(.cacheTile(
                        slot: slot, x: cell.x, y: cell.y, width: cell.width, height: cell.height,
                        compression: .lzfse, byteRange: OwnedGraphicsByteRange(offset: payload.count, length: lzfseCompressed.count)
                    ))
                    payload.append(lzfseCompressed)
                }
            } else {
                guard let built = buildTile(surface: current, rect: cell, encoding: .lzfse, payloadOffset: payload.count) else { return .failed }
                commands.append(built.command)
                payload.append(built.payload)
            }
        }
        guard !commands.isEmpty else { return .allUnchanged }
        graphicsFrameId &+= 1
        return .built(OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: commands.count,
                payloadLength: payload.count
            ),
            commands: commands,
            payload: payload
        ))
    }

    // Encoding choice for buildTile. LZFSE keeps text crisp; JPEG carries the
    // governor's readable quality and the content-gated downscale for busy cells
    // and the large exposed scroll strip.
    private enum TileEncoding {
        case lzfse
        case jpeg(quality: Double, scale: Double)
    }

    // One tile builder for every path. Extracts the cell BGRA once, compresses per
    // the requested encoding, and returns the command plus payload. The lossless
    // LZFSE path keeps text crisp; the JPEG path carries the governor's readable
    // quality and content-gated downscale.
    private func buildTile(surface: Surface, rect: PixelRect, encoding: TileEncoding, payloadOffset: Int) -> (command: OwnedGraphicsCommand, payload: Data)? {
        switch encoding {
        case .lzfse:
            guard let bgra = tileData(surface: surface, x: rect.x, y: rect.y, width: rect.width, height: rect.height),
                  let compressed = compressLZFSE(bgra) else { return nil }
            let command = OwnedGraphicsCommand.bitmapTile(
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                compression: .lzfse,
                byteRange: OwnedGraphicsByteRange(offset: payloadOffset, length: compressed.count)
            )
            return (command, compressed)
        case let .jpeg(quality, scale):
            guard let tile = makeJpegTile(current: surface, rect: rect, quality: quality, scale: scale) else { return nil }
            // makeJpegTile emits byteRange offset 0; re-stamp the real offset.
            guard case let .bitmapTile(x, y, w, h, comp, range) = tile.command else { return nil }
            let command = OwnedGraphicsCommand.bitmapTile(
                x: x, y: y, width: w, height: h, compression: comp,
                byteRange: OwnedGraphicsByteRange(offset: payloadOffset, length: range.length)
            )
            return (command, tile.payload)
        }
    }

    // One lossy JPEG bitmap tile over a rect. The tile command carries the full
    // destination size; the JPEG may be encoded smaller (congestion downscale) and
    // the client upscales it. Scale on the raw BGRA with vImage (row-order
    // preserving) so the smaller buffer feeds the identical CGImage path and the
    // round trip stays orientation-correct. Shared by the fullframe fallback and the
    // lossy exposed scroll strip.
    private func makeJpegTile(current: Surface, rect: PixelRect, quality: Double, scale: Double) -> (command: OwnedGraphicsCommand, payload: Data)? {
        let clamped = rect.clamped(toWidth: current.width, height: current.height)
        guard clamped.width > 0, clamped.height > 0,
              let bgra = tileData(surface: current, x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height) else { return nil }
        let scaledWidth = max(1, Int((Double(clamped.width) * scale).rounded()))
        let scaledHeight = max(1, Int((Double(clamped.height) * scale).rounded()))
        let encodeBytes: Data
        let encodeWidth: Int
        let encodeHeight: Int
        if scale < 1.0, scaledWidth < clamped.width, scaledHeight < clamped.height,
           let downscaled = downscaleBGRA(bgra, width: clamped.width, height: clamped.height, toWidth: scaledWidth, toHeight: scaledHeight) {
            encodeBytes = downscaled
            encodeWidth = scaledWidth
            encodeHeight = scaledHeight
        } else {
            encodeBytes = bgra
            encodeWidth = clamped.width
            encodeHeight = clamped.height
        }
        guard let jpeg = compressJPEGWithinBudget(encodeBytes, width: encodeWidth, height: encodeHeight, startQuality: quality) else { return nil }
        let command = OwnedGraphicsCommand.bitmapTile(
            x: clamped.x,
            y: clamped.y,
            width: clamped.width,
            height: clamped.height,
            compression: .jpeg,
            byteRange: OwnedGraphicsByteRange(offset: 0, length: jpeg.count)
        )
        return (command, jpeg)
    }

    // Encode at startQuality, then step quality down a short ladder until the JPEG
    // fits the wire-byte ceiling. Bounds every fullframe to a drainable size so no
    // single frame can clog the channel and trigger the reset-stripe ackTimeout
    // cascade. At most a few re-encodes; motion frames already start small and fit
    // on the first try. Returns the smallest encoding if even the floor overshoots.
    private func compressJPEGWithinBudget(_ bgra: Data, width: Int, height: Int, startQuality: Double) -> Data? {
        let ladder = [startQuality, 0.45, 0.3, 0.18].filter { $0 <= startQuality } + [0.1]
        var smallest: Data?
        for quality in ladder {
            guard let jpeg = compressJPEG(bgra, width: width, height: height, quality: quality) else { continue }
            if smallest == nil || jpeg.count < (smallest?.count ?? .max) {
                smallest = jpeg
            }
            if jpeg.count <= fullframeMaxWireBytes {
                return jpeg
            }
        }
        return smallest
    }

    // Scale a top-down BGRA buffer to a smaller top-down BGRA buffer with vImage.
    // vImage scales each of the 4 channels independently and preserves row order, so
    // the result feeds the same top-down CGImage path as a native-size buffer and the
    // JPEG round trip stays orientation-correct (no CoreGraphics coordinate flip to
    // reason about). High-quality resampling keeps scrolled text legible after the
    // client upscales it back.
    private func downscaleBGRA(_ bgra: Data, width: Int, height: Int, toWidth: Int, toHeight: Int) -> Data? {
        let srcRowBytes = width * 4
        let dstRowBytes = toWidth * 4
        guard width > 0, height > 0, toWidth > 0, toHeight > 0,
              bgra.count >= srcRowBytes * height else { return nil }
        var source = bgra
        var destination = Data(count: dstRowBytes * toHeight)
        let ok = source.withUnsafeMutableBytes { srcRaw -> Bool in
            destination.withUnsafeMutableBytes { dstRaw -> Bool in
                guard let srcBase = srcRaw.baseAddress, let dstBase = dstRaw.baseAddress else { return false }
                var srcBuffer = vImage_Buffer(
                    data: srcBase,
                    height: vImagePixelCount(height),
                    width: vImagePixelCount(width),
                    rowBytes: srcRowBytes
                )
                var dstBuffer = vImage_Buffer(
                    data: dstBase,
                    height: vImagePixelCount(toHeight),
                    width: vImagePixelCount(toWidth),
                    rowBytes: dstRowBytes
                )
                return vImageScale_ARGB8888(&srcBuffer, &dstBuffer, nil, vImage_Flags(kvImageHighQualityResampling)) == kvImageNoError
            }
        }
        return ok ? destination : nil
    }

    // BGRA (32-bit little-endian, alpha ignored) -> JPEG via CoreGraphics. Kept
    // symmetric with the client's CGImage decoder (both top-down, row 0 is top) so
    // the round trip never introduces a vertical flip.
    private func compressJPEG(_ bgra: Data, width: Int, height: Int, quality: Double) -> Data? {
        let bytesPerRow = width * 4
        guard bgra.count >= bytesPerRow * height,
              let provider = CGDataProvider(data: bgra as CFData),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let bitmapInfo = CGBitmapInfo(
            rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        )
        guard let image = CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else { return nil }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    private func damageDiagnostics(
        probeMs: Double,
        payloadBuildMs: Double?,
        offset: ScrollOffset?,
        region: PixelRect?,
        motion: MotionSignal?,
        trace: DamageScrollTrace,
        acceptedBy: String?,
        surfaceWidth: Int,
        surfaceHeight: Int
    ) -> ScrollDeltaDiagnostics {
        // Honest values from the composer trace: the measured offset (the copyRect
        // the estimator confirmed, or nil), the decision string (why the frame
        // composed the way it did), and the band geometry. acceptedBy carries the
        // decision so the device log shows exactly how each frame was built.
        let axisVertical = motion?.axis != .horizontal
        return ScrollDeltaDiagnostics(
            probeMs: probeMs,
            payloadBuildMs: payloadBuildMs,
            acceptedDx: offset?.dx,
            acceptedDy: offset?.dy,
            confidence: trace.measuredOffset != nil ? 1.0 : 0.0,
            timeoutReason: trace.decision,
            sampledPixelCount: 0,
            bestDx: axisVertical ? nil : trace.measuredOffset,
            bestDy: axisVertical ? trace.measuredOffset : nil,
            secondBestConfidence: 0,
            hintActive: motion != nil,
            hintAxis: motion?.axis.rawValue,
            hintPredictedOffset: nil,
            hintCandidates: [],
            hintSource: motion != nil ? "input" : "damage",
            acceptedBy: acceptedBy ?? trace.decision,
            regionStable: region != nil,
            regionSource: "damage",
            regionX: region?.x,
            regionY: region?.y,
            regionWidth: region?.width ?? trace.bandWidth,
            regionHeight: region?.height ?? trace.bandHeight,
            viewportStable: offset != nil,
            viewportSource: offset != nil ? "damage" : nil,
            viewportX: region?.x,
            viewportY: region?.y,
            viewportWidth: region?.width ?? trace.bandWidth,
            viewportHeight: region?.height ?? trace.bandHeight,
            outerRegionX: region?.x,
            outerRegionY: region?.y,
            outerRegionWidth: region?.width ?? trace.bandWidth,
            outerRegionHeight: region?.height ?? trace.bandHeight
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
