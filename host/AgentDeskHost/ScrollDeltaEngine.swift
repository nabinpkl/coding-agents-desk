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
        tieBreak: String? = nil
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
    }
}

struct ScrollDeltaEngine {
    private static let maxScrollOffset = 240
    private static let confidenceThreshold = 0.88
    private static let confidenceMargin = 0.06
    static let defaultMaxDecodedResetStripePayloadBytes = 2 * 1024 * 1024

    private typealias Surface = ScrollDeltaSurface
    private typealias ScrollOffset = ScrollDeltaOffset
    private typealias ProbeOutcome = ScrollDeltaProbeOutcome

    private var previous: Surface?
    private var pendingSurface: Surface?
    private var surfaceGeneration: UInt32 = 0
    private var graphicsFrameId: UInt64 = 0
    private let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
    private let detectionBudgetMs: Double
    private let maxDecodedResetStripePayloadBytes: Int

    init(
        detectionBudgetMs: Double = 4.0,
        maxDecodedResetStripePayloadBytes: Int = Self.defaultMaxDecodedResetStripePayloadBytes
    ) {
        self.detectionBudgetMs = detectionBudgetMs
        self.maxDecodedResetStripePayloadBytes = max(1, maxDecodedResetStripePayloadBytes)
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

    mutating func observeFallbackFrame(_ frame: CapturedVideoFrame) {
        previous = makeSurface(frame.pixelBuffer)
        pendingSurface = nil
    }

    mutating func invalidateRetainedSurface() {
        previous = nil
        pendingSurface = nil
    }

    mutating func evaluate(
        _ frame: CapturedVideoFrame,
        scrollHint: ScrollActivityHint? = nil,
        detectionBudgetMs overrideDetectionBudgetMs: Double? = nil,
        allowBlindScan: Bool = true
    ) -> ScrollDeltaResult {
        let detectionBudgetMs = overrideDetectionBudgetMs ?? self.detectionBudgetMs
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
        let probe: ProbeOutcome
        if activeHint == nil && !allowBlindScan {
            probe = ProbeOutcome(
                offset: nil,
                bestDx: nil,
                bestDy: nil,
                confidence: 0,
                secondBestConfidence: 0,
                sampledPixelCount: 0,
                candidateCount: 0,
                timedOut: true,
                timeoutReason: "owned-scroll-miss",
                timeoutPhase: "blind-scan-suppressed",
                probeScale: 1,
                hintCandidates: [],
                tieBreak: nil
            )
        } else {
            probe = bestScrollOffset(
                previous: previous,
                currentPixelBuffer: frame.pixelBuffer,
                startedAt: startedAt,
                detectionBudgetMs: detectionBudgetMs,
                scrollHint: activeHint
            )
        }
        let probeMs = elapsedMs(since: startedAt)
        let acceptedOffset = probe.offset
        guard let offset = acceptedOffset else {
            let ownedHintMiss = activeHint != nil && !allowBlindScan
            let usedBlindScan = activeHint == nil && allowBlindScan
            return ScrollDeltaResult(
                kind: probe.timedOut || ownedHintMiss ? .timeout : .rejected("no-scroll-match"),
                envelope: nil,
                diagnostics: makeDiagnostics(
                    probeMs: probeMs,
                    payloadBuildMs: nil,
                    acceptedOffset: nil,
                    probe: probe,
                    scrollHint: activeHint,
                    acceptedBy: nil,
                    usedBlindScan: usedBlindScan,
                    timeoutReasonOverride: ownedHintMiss ? "owned-scroll-miss" : nil
                )
            )
        }
        let payloadStartedAt = DispatchTime.now().uptimeNanoseconds
        guard let current = makeSurface(frame.pixelBuffer) else {
            pendingSurface = nil
            return ScrollDeltaResult(kind: .rejected("no-bgra-surface"), envelope: nil)
        }
        pendingSurface = current
        graphicsFrameId &+= 1
        let envelope = makeScrollEnvelope(
            current: current,
            offset: offset,
            capturedAtUptimeNs: frame.capturedAtUptimeNs
        )
        return ScrollDeltaResult(
            kind: .accepted,
            envelope: envelope,
            diagnostics: makeDiagnostics(
                probeMs: probeMs,
                payloadBuildMs: elapsedMs(since: payloadStartedAt),
                acceptedOffset: offset,
                probe: probe,
                scrollHint: activeHint,
                acceptedBy: activeHint == nil ? "blind" : "hint",
                usedBlindScan: activeHint == nil && allowBlindScan
            )
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

    private func bestScrollOffset(
        previous: Surface,
        currentPixelBuffer: CVPixelBuffer,
        startedAt: UInt64,
        detectionBudgetMs: Double,
        scrollHint: ScrollActivityHint?
    ) -> ProbeOutcome {
        CVPixelBufferLockBaseAddress(currentPixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(currentPixelBuffer, .readOnly) }
        guard let sampler = makeProbeSampler(for: currentPixelBuffer) else {
            return ProbeOutcome(
                offset: nil,
                bestDx: nil,
                bestDy: nil,
                confidence: 0,
                secondBestConfidence: 0,
                sampledPixelCount: 0,
                candidateCount: 0,
                timedOut: false,
                timeoutReason: "no-probe-sampler",
                timeoutPhase: nil,
                probeScale: 1,
                hintCandidates: [],
                tieBreak: nil
            )
        }
        return ScrollDeltaProbe(
            previous: previous,
            sampler: sampler,
            maxScrollOffset: Self.maxScrollOffset,
            confidenceThreshold: Self.confidenceThreshold,
            confidenceMargin: Self.confidenceMargin,
            startedAt: startedAt,
            detectionBudgetMs: detectionBudgetMs,
            elapsedMs: elapsedMs(since:)
        ).bestOffset(scrollHint: scrollHint)
    }

    private func makeDiagnostics(
        probeMs: Double,
        payloadBuildMs: Double?,
        acceptedOffset: ScrollOffset?,
        probe: ProbeOutcome,
        scrollHint: ScrollActivityHint?,
        acceptedBy: String?,
        usedBlindScan: Bool = false,
        timeoutReasonOverride: String? = nil
    ) -> ScrollDeltaDiagnostics {
        ScrollDeltaDiagnostics(
            probeMs: probeMs,
            payloadBuildMs: payloadBuildMs,
            acceptedDx: acceptedOffset?.dx,
            acceptedDy: acceptedOffset?.dy,
            confidence: probe.confidence,
            timeoutReason: timeoutReasonOverride ?? probe.timeoutReason,
            sampledPixelCount: probe.sampledPixelCount,
            bestDx: probe.bestDx,
            bestDy: probe.bestDy,
            secondBestConfidence: probe.secondBestConfidence,
            candidateCount: probe.candidateCount,
            timeoutPhase: probe.timeoutPhase,
            probeScale: probe.probeScale,
            hintActive: scrollHint != nil,
            hintAxis: scrollHint?.axis.rawValue,
            hintPredictedOffset: scrollHint?.predictedOffsetPx,
            hintCandidates: probe.hintCandidates,
            hintSource: scrollHint?.source.rawValue ?? (usedBlindScan ? "blind" : nil),
            acceptedBy: acceptedBy,
            tieBreak: probe.tieBreak
        )
    }

    private func makeProbeSampler(for pixelBuffer: CVPixelBuffer) -> ScrollDeltaProbeSampler? {
        let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
        if pixelFormat == kCVPixelFormatType_32BGRA {
            guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
            return .bgra(ScrollDeltaDirectBGRASampler(
                width: CVPixelBufferGetWidth(pixelBuffer),
                height: CVPixelBufferGetHeight(pixelBuffer),
                bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                baseAddress: baseAddress
            ))
        }
        if pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ||
            pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange {
            guard CVPixelBufferGetPlaneCount(pixelBuffer) > 0,
                  let baseAddress = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else {
                return nil
            }
            return .luma(ScrollDeltaDirectLumaSampler(
                width: CVPixelBufferGetWidthOfPlane(pixelBuffer, 0),
                height: CVPixelBufferGetHeightOfPlane(pixelBuffer, 0),
                bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0),
                baseAddress: baseAddress
            ))
        }
        guard let surface = makeSurface(pixelBuffer) else { return nil }
        return .surface(ScrollDeltaSurfaceSampler(surface: surface))
    }

    private func makeStripedResetEnvelopes(
        surface: Surface,
        startingFrameId: UInt64,
        capturedAtUptimeNs: UInt64
    ) -> [OwnedGraphicsFrameEnvelope]? {
        let rowBytes = surface.width * 4
        let stripeHeight = max(1, min(surface.height, maxDecodedResetStripePayloadBytes / rowBytes))
        var envelopes: [OwnedGraphicsFrameEnvelope] = []
        var y = 0
        var frameId = startingFrameId
        while y < surface.height {
            let height = min(stripeHeight, surface.height - y)
            guard let stripe = tileData(surface: surface, x: 0, y: y, width: surface.width, height: height),
                  let compressed = compressLZFSE(stripe) else {
                return nil
            }
            let commands: [OwnedGraphicsCommand]
            if y == 0 {
                commands = [
                    .resetSurface(
                        surfaceGeneration: surfaceGeneration,
                        width: surface.width,
                        height: surface.height,
                        pixelFormat: .bgra
                    ),
                    .bitmapTile(
                        x: 0,
                        y: y,
                        width: surface.width,
                        height: height,
                        compression: .lzfse,
                        byteRange: OwnedGraphicsByteRange(offset: 0, length: compressed.count)
                    )
                ]
            } else {
                commands = [
                    .bitmapTile(
                        x: 0,
                        y: y,
                        width: surface.width,
                        height: height,
                        compression: .lzfse,
                        byteRange: OwnedGraphicsByteRange(offset: 0, length: compressed.count)
                    )
                ]
            }
            envelopes.append(OwnedGraphicsFrameEnvelope(
                header: OwnedGraphicsFrameHeader(
                    surfaceGeneration: surfaceGeneration,
                    frameId: frameId,
                    capturedAtUptimeNs: capturedAtUptimeNs,
                    commandCount: commands.count,
                    payloadLength: compressed.count
                ),
                commands: commands,
                payload: compressed
            ))
            y += height
            frameId &+= 1
        }
        return envelopes
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
