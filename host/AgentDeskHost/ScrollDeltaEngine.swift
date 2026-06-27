import Compression
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Snaps a damage rect list to a fixed grid in surface pixel space (H2). Each
// grid cell overlapped by any damage rect becomes one tile, clipped to the
// surface bounds. Fixed cells bound per-tile size and give a stable tile
// identity for a future content-hash cache, instead of one variable-size tile
// over the damage union.
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
// deleted brute-force probe; the damage path and DamageScrollClassifier still
// use them, so they live here now.
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
    // .rejected: there is nothing to send and no HEVC fallback to take.
    case noChange
}

struct ScrollDeltaResult {
    let kind: ScrollDeltaKind
    let envelope: OwnedGraphicsFrameEnvelope?
    let envelopes: [OwnedGraphicsFrameEnvelope]
    let diagnostics: ScrollDeltaDiagnostics?

    // True only when the result is a genuine HEVC fallback signal. The damage
    // path's tile envelopes (.accepted) and its "nothing to send" outcome
    // (.noChange) never fall back; only .rejected and .timeout do. H5 deletes
    // the HEVC plumbing this still names.
    var fellBackToHEVC: Bool {
        switch kind {
        case .rejected, .timeout:
            return true
        case .reset, .accepted, .noChange:
            return false
        }
    }

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
    private let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
    private let maxDecodedResetStripePayloadBytes: Int
    private let maxWireResetStripeBytes: Int
    // ADR-0021 damage-driven detection is now the only path. evaluate()
    // classifies the OS damage region; there is no brute-force pixel-diff probe
    // and no viewport streak.
    private let damageClassifier: DamageScrollClassifier
    // Fixed grid cell size in surface pixels for damage tile emission (H2).
    private let tileGridPx: Int
    // Lossy quality for the fullframe JPEG fallback (0...1). Rest is crisp; motion
    // is low so a mid-scroll fullframe stays small and holds cadence.
    private let fullframeJpegQualityRest: Double
    private let fullframeJpegQualityMotion: Double
    // Hard wire-byte ceiling for a fullframe JPEG; quality steps down to fit it.
    private let fullframeMaxWireBytes: Int

    init(
        maxDecodedResetStripePayloadBytes: Int = Self.defaultMaxDecodedResetStripePayloadBytes,
        maxWireResetStripeBytes: Int = Self.defaultMaxWireResetStripeBytes,
        damageClassifier: DamageScrollClassifier = DamageScrollClassifier(),
        tileGridPx: Int = Config.hybridTileGridPx,
        fullframeJpegQuality: Double = Config.hybridFullframeJpegQuality,
        fullframeJpegQualityMotion: Double = Config.hybridFullframeJpegQualityMotion,
        fullframeMaxWireBytes: Int = Config.hybridFullframeMaxWireBytes
    ) {
        self.maxDecodedResetStripePayloadBytes = max(1, maxDecodedResetStripePayloadBytes)
        self.maxWireResetStripeBytes = max(1, maxWireResetStripeBytes)
        self.damageClassifier = damageClassifier
        self.tileGridPx = max(1, tileGridPx)
        self.fullframeJpegQualityRest = min(1, max(0.1, fullframeJpegQuality))
        self.fullframeJpegQualityMotion = min(1, max(0.1, fullframeJpegQualityMotion))
        self.fullframeMaxWireBytes = max(1, fullframeMaxWireBytes)
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
    }

    mutating func invalidateRetainedSurface() {
        previous = nil
        pendingSurface = nil
    }

    mutating func evaluate(
        _ frame: CapturedVideoFrame,
        scrollHint: ScrollActivityHint? = nil
    ) -> ScrollDeltaResult {
        let startedAt = DispatchTime.now().uptimeNanoseconds
        let activeHint = scrollHint?.isActive(nowUptimeNs: startedAt) == true ? scrollHint : nil
        guard let previous else {
            guard let current = makeSurface(frame.pixelBuffer) else {
                pendingSurface = nil
                return ScrollDeltaResult(kind: .rejected("no-bgra-surface"), envelope: nil)
            }
            pendingSurface = current
            surfaceGeneration &+= 1
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
            scrollHint: activeHint,
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

    // ADR-0021 damage-driven detection. Classify the OS damage region and map
    // the result onto the existing envelope builders and the unchanged pump
    // contract: .scroll/.tiles -> .accepted (pump sends, then commits the
    // surface), .fullFrame/.noChange -> .rejected (pump falls back to HEVC and
    // realigns the retained baseline). There is no probe, no viewport streak.
    private mutating func evaluateWithDamage(
        _ frame: CapturedVideoFrame,
        previous: Surface,
        scrollHint: ScrollActivityHint?,
        startedAt: UInt64,
        surfaceWidth: Int,
        surfaceHeight: Int
    ) -> ScrollDeltaResult {
        guard let current = makeSurface(frame.pixelBuffer) else {
            pendingSurface = nil
            return ScrollDeltaResult(kind: .rejected("no-bgra-surface"), envelope: nil)
        }
        let content = frame.contentRectPixels
            ?? PixelRect(x: 0, y: 0, width: current.width, height: current.height)
        let (classification, trace) = damageClassifier.classifyTraced(
            damageRects: frame.damageRects,
            contentRect: content,
            previous: previous,
            current: current,
            hint: scrollHint
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
                capturedAtUptimeNs: frame.capturedAtUptimeNs
            ) else {
                pendingSurface = nil
                return ScrollDeltaResult(
                    kind: .rejected("damage-scroll-envelope-build-failed"),
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: offset, region: region, scrollHint: scrollHint, trace: trace, acceptedBy: "damage", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            }
            return ScrollDeltaResult(
                kind: .accepted,
                envelope: envelope,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: offset, region: region, scrollHint: scrollHint, trace: trace, acceptedBy: "damage", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        case .tiles(let rects):
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            pendingSurface = current
            graphicsFrameId &+= 1
            guard let envelope = makeTileEnvelope(current: current, rects: rects, capturedAtUptimeNs: frame.capturedAtUptimeNs) else {
                pendingSurface = nil
                return ScrollDeltaResult(
                    kind: .rejected("damage-tile-envelope-build-failed"),
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), scrollHint: scrollHint, trace: trace, acceptedBy: "damage-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            }
            return ScrollDeltaResult(
                kind: .accepted,
                envelope: envelope,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: PixelRect.union(of: rects), scrollHint: scrollHint, trace: trace, acceptedBy: "damage-tiles", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        case .fullFrame(let reason):
            // A large or unstructured change ships as ONE lossy JPEG over the
            // damage bounding region, not N raw LZFSE cells. Per-cell LZFSE of a
            // whole-screen change was multi-MB and saturated the reliable channel
            // (the device-run freeze: a single 2.88MB frame stalled everything
            // behind it). JPEG cuts that ~10x. The region is the OS damage union
            // when known, else the full content region (no damage geometry, so we
            // do not know what changed). Lossless LZFSE still serves the small
            // .tiles path, so lossy only ever covers large motion.
            let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
            pendingSurface = current
            graphicsFrameId &+= 1
            let contentRegion = content.clamped(toWidth: current.width, height: current.height)
            let region = frame.damageRects.isEmpty
                ? contentRegion
                : (PixelRect.union(of: frame.damageRects)?.clamped(toWidth: current.width, height: current.height) ?? contentRegion)
            // Motion-adaptive quality: an active scroll hint means this fullframe is
            // mid-flick, so encode it small (motion quality). With no hint the screen
            // is settling or a discrete change at rest, so encode it crisp.
            let quality = scrollHint != nil ? fullframeJpegQualityMotion : fullframeJpegQualityRest
            guard let envelope = makeJPEGFrameEnvelope(current: current, region: region, quality: quality, capturedAtUptimeNs: frame.capturedAtUptimeNs) else {
                pendingSurface = nil
                return ScrollDeltaResult(
                    kind: .rejected("damage-fullframe-jpeg-build-failed-\(reason)"),
                    envelope: nil,
                    diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: region, scrollHint: scrollHint, trace: trace, acceptedBy: "damage-fullframe-jpeg", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
                )
            }
            return ScrollDeltaResult(
                kind: .accepted,
                envelope: envelope,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: elapsedMs(since: payloadStartedAt), offset: nil, region: region, scrollHint: scrollHint, trace: trace, acceptedBy: "damage-fullframe-jpeg", surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        case .noChange:
            // Nothing changed worth sending. Hold the surface (current equals
            // previous outside the empty damage) and send nothing. No fallback.
            pendingSurface = current
            return ScrollDeltaResult(
                kind: .noChange,
                envelope: nil,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: nil, offset: nil, region: nil, scrollHint: scrollHint, trace: trace, acceptedBy: nil, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        }
    }

    // One bitmap tile per fixed grid cell overlapped by the damage rects (H2).
    // Snapping to a fixed grid bounds per-tile size and gives each tile a stable
    // identity for a future content-hash cache, instead of one variable-size
    // tile over the damage union. Each cell's BGRA is LZFSE-compressed and
    // appended to a single envelope payload with its own byteRange. Sub-rect,
    // non-full-width tiles are already exercised by the scroll exposed-strip
    // path, so this stays within proven wire semantics.
    private func makeTileEnvelope(current: Surface, rects: [PixelRect], capturedAtUptimeNs: UInt64) -> OwnedGraphicsFrameEnvelope? {
        let cells = TileGrid.cells(
            covering: rects,
            surfaceWidth: current.width,
            surfaceHeight: current.height,
            gridPx: tileGridPx
        )
        guard !cells.isEmpty else { return nil }
        var commands: [OwnedGraphicsCommand] = []
        var payload = Data()
        for cell in cells {
            guard cell.area > 0,
                  let tile = tileData(surface: current, x: cell.x, y: cell.y, width: cell.width, height: cell.height),
                  let compressed = compressLZFSE(tile) else { return nil }
            commands.append(
                .bitmapTile(
                    x: cell.x,
                    y: cell.y,
                    width: cell.width,
                    height: cell.height,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: payload.count, length: compressed.count)
                )
            )
            payload.append(compressed)
        }
        guard !commands.isEmpty else { return nil }
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: commands.count,
                payloadLength: payload.count
            ),
            commands: commands,
            payload: payload
        )
    }

    // The fullframe fallback as ONE lossy JPEG tile over the damage region,
    // instead of N raw LZFSE cells. A whole-screen change is contiguous and large,
    // so a single JPEG both compresses far better than per-cell LZFSE (cross-tile
    // redundancy, no per-cell header) and is the only thing small enough not to
    // saturate the reliable channel and freeze the screen. The region is clamped
    // to the surface; the client decodes the JPEG back to BGRA and paints it like
    // any other bitmap tile.
    private func makeJPEGFrameEnvelope(current: Surface, region: PixelRect, quality: Double, capturedAtUptimeNs: UInt64) -> OwnedGraphicsFrameEnvelope? {
        let clamped = region.clamped(toWidth: current.width, height: current.height)
        guard clamped.width > 0, clamped.height > 0,
              let bgra = tileData(surface: current, x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height),
              let jpeg = compressJPEGWithinBudget(bgra, width: clamped.width, height: clamped.height, startQuality: quality) else { return nil }
        let command = OwnedGraphicsCommand.bitmapTile(
            x: clamped.x,
            y: clamped.y,
            width: clamped.width,
            height: clamped.height,
            compression: .jpeg,
            byteRange: OwnedGraphicsByteRange(offset: 0, length: jpeg.count)
        )
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: 1,
                payloadLength: jpeg.count
            ),
            commands: [command],
            payload: jpeg
        )
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
        scrollHint: ScrollActivityHint?,
        trace: DamageScrollTrace,
        acceptedBy: String?,
        surfaceWidth: Int,
        surfaceHeight: Int
    ) -> ScrollDeltaDiagnostics {
        // Honest values from the classifier trace: confidence is the real best
        // shifted match, secondBestConfidence carries the no-shift (static)
        // match, and bestDx/bestDy carry the best offset the search found even
        // when it was rejected. acceptedBy carries the decision string so the
        // device log shows exactly why a scroll was or was not taken.
        let axisVertical = scrollHint?.axis != .horizontal
        return ScrollDeltaDiagnostics(
            probeMs: probeMs,
            payloadBuildMs: payloadBuildMs,
            acceptedDx: offset?.dx,
            acceptedDy: offset?.dy,
            confidence: trace.bestConfidence,
            timeoutReason: trace.decision,
            sampledPixelCount: 0,
            bestDx: axisVertical ? nil : trace.bestOffset,
            bestDy: axisVertical ? trace.bestOffset : nil,
            secondBestConfidence: trace.staticConfidence,
            hintActive: scrollHint != nil,
            hintAxis: scrollHint?.axis.rawValue,
            hintPredictedOffset: scrollHint?.predictedOffsetPx,
            hintCandidates: scrollHint?.candidateOffsets ?? [],
            hintSource: scrollHint?.source.rawValue ?? "damage",
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
