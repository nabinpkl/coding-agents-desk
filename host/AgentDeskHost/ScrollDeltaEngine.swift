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
    private static let maxScrollOffset = 240
    private static let confidenceThreshold = 0.88
    private static let confidenceMargin = 0.06
    static let defaultMaxDecodedResetStripePayloadBytes = 2 * 1024 * 1024
    static let defaultMaxWireResetStripeBytes = 196_608

    private typealias Surface = ScrollDeltaSurface
    private typealias ScrollOffset = ScrollDeltaOffset
    private typealias ProbeOutcome = ScrollDeltaProbeOutcome

    private var previous: Surface?
    private var pendingSurface: Surface?
    private var surfaceGeneration: UInt32 = 0
    private var graphicsFrameId: UInt64 = 0
    private var viewportTracker: ScrollViewportTracker
    private let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
    private let detectionBudgetMs: Double
    private let maxDecodedResetStripePayloadBytes: Int
    private let maxWireResetStripeBytes: Int
    // ADR-0021 damage-driven detection. When enabled, evaluate() classifies the
    // OS damage region instead of running the brute-force pixel-diff probe and
    // the 2-frame viewport streak. Off by default so the proven probe path stays
    // live until a device run validates this one.
    private let useDamageClassifier: Bool
    private let damageClassifier: DamageScrollClassifier

    init(
        detectionBudgetMs: Double = 4.0,
        maxDecodedResetStripePayloadBytes: Int = Self.defaultMaxDecodedResetStripePayloadBytes,
        maxWireResetStripeBytes: Int = Self.defaultMaxWireResetStripeBytes,
        viewportConfig: ScrollViewportConfig = .default,
        useDamageClassifier: Bool = false,
        damageClassifier: DamageScrollClassifier = DamageScrollClassifier()
    ) {
        self.detectionBudgetMs = detectionBudgetMs
        self.maxDecodedResetStripePayloadBytes = max(1, maxDecodedResetStripePayloadBytes)
        self.maxWireResetStripeBytes = max(1, maxWireResetStripeBytes)
        self.viewportTracker = ScrollViewportTracker(config: viewportConfig)
        self.useDamageClassifier = useDamageClassifier
        self.damageClassifier = damageClassifier
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
        viewportTracker.release()
    }

    mutating func invalidateRetainedSurface() {
        previous = nil
        pendingSurface = nil
        viewportTracker.release()
    }

    var hasStableViewport: Bool {
        viewportTracker.stableViewport != nil
    }

    mutating func evaluate(
        _ frame: CapturedVideoFrame,
        scrollHint: ScrollActivityHint? = nil,
        scrollRegion: ScrollRegion? = nil,
        scrollRegionIsStable: Bool = true,
        emitGraphicsBeforeRegionLock: Bool = true,
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
        if useDamageClassifier {
            return evaluateWithDamage(
                frame,
                previous: previous,
                scrollHint: activeHint,
                startedAt: startedAt,
                surfaceWidth: currentWidth,
                surfaceHeight: currentHeight
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
                scrollHint: activeHint,
                scrollRegion: scrollRegion
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
                    timeoutReasonOverride: ownedHintMiss ? "owned-scroll-miss" : nil,
                    scrollRegion: scrollRegion,
                    regionStable: scrollRegionIsStable && scrollRegion != nil,
                    surfaceWidth: currentWidth,
                    surfaceHeight: currentHeight
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
        let viewportCandidate = scrollRegion.flatMap {
            viewportTracker.candidate(
                previous: previous,
                current: current,
                outerRegion: $0,
                offset: offset
            )
        }
        let stableViewport = emitGraphicsBeforeRegionLock && scrollRegionIsStable
            ? viewportTracker.observeValidation(candidate: viewportCandidate, accepted: viewportCandidate != nil)
            : nil
        let shouldEmitGraphics = stableViewport != nil
        if !shouldEmitGraphics {
            return ScrollDeltaResult(
                kind: .accepted,
                envelope: nil,
                diagnostics: makeDiagnostics(
                    probeMs: probeMs,
                    payloadBuildMs: elapsedMs(since: payloadStartedAt),
                    acceptedOffset: offset,
                    probe: probe,
                    scrollHint: activeHint,
                    acceptedBy: activeHint == nil ? "blind" : "hint",
                    usedBlindScan: activeHint == nil && allowBlindScan,
                    scrollRegion: scrollRegion,
                    regionStable: scrollRegionIsStable && scrollRegion != nil,
                    scrollViewport: viewportCandidate?.viewport,
                    viewportStable: false,
                    surfaceWidth: currentWidth,
                    surfaceHeight: currentHeight
                )
            )
        }
        guard let viewport = stableViewport,
              let envelope = makeScrollEnvelope(
                current: current,
                offset: offset,
                region: PixelRect(x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height),
                capturedAtUptimeNs: frame.capturedAtUptimeNs
              ) else {
            return ScrollDeltaResult(
                kind: .rejected("scroll-envelope-build-failed"),
                envelope: nil,
                diagnostics: makeDiagnostics(
                    probeMs: probeMs,
                    payloadBuildMs: elapsedMs(since: payloadStartedAt),
                    acceptedOffset: offset,
                    probe: probe,
                    scrollHint: activeHint,
                    acceptedBy: activeHint == nil ? "blind" : "hint",
                    usedBlindScan: activeHint == nil && allowBlindScan,
                    scrollRegion: scrollRegion,
                    regionStable: true,
                    scrollViewport: stableViewport,
                    viewportStable: true,
                    surfaceWidth: currentWidth,
                    surfaceHeight: currentHeight
                )
            )
        }
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
                usedBlindScan: activeHint == nil && allowBlindScan,
                scrollRegion: scrollRegion,
                regionStable: true,
                scrollViewport: stableViewport,
                viewportStable: stableViewport != nil,
                surfaceWidth: currentWidth,
                surfaceHeight: currentHeight
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
        scrollHint: ScrollActivityHint?,
        scrollRegion: ScrollRegion?
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
            elapsedMs: elapsedMs(since:),
            region: scrollRegion
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
        timeoutReasonOverride: String? = nil,
        scrollRegion: ScrollRegion? = nil,
        regionStable: Bool = false,
        scrollViewport: ScrollViewport? = nil,
        viewportStable: Bool = false,
        surfaceWidth: Int,
        surfaceHeight: Int
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
            tieBreak: probe.tieBreak,
            regionStable: regionStable,
            regionSource: scrollRegion?.source.diagnosticName,
            regionX: scrollRegion?.x,
            regionY: scrollRegion?.y,
            regionWidth: scrollRegion?.width,
            regionHeight: scrollRegion?.height,
            fullSurfaceCopyRect: false,
            viewportStable: viewportStable,
            viewportSource: scrollViewport?.source,
            viewportX: scrollViewport?.x,
            viewportY: scrollViewport?.y,
            viewportWidth: scrollViewport?.width,
            viewportHeight: scrollViewport?.height,
            outerRegionX: scrollRegion?.x,
            outerRegionY: scrollRegion?.y,
            outerRegionWidth: scrollRegion?.width,
            outerRegionHeight: scrollRegion?.height,
            wholeWindowCopyRect: viewportStable && isWholeWindowCopyRect(viewport: scrollViewport, outerRegion: scrollRegion)
        )
    }

    private func isWholeWindowCopyRect(viewport: ScrollViewport?, outerRegion: ScrollRegion?) -> Bool {
        guard let viewport, let outerRegion else { return false }
        return viewport.x == outerRegion.x &&
            viewport.y == outerRegion.y &&
            viewport.width == outerRegion.width &&
            viewport.height == outerRegion.height
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
            pendingSurface = nil
            return ScrollDeltaResult(
                kind: .rejected("damage-fullframe-\(reason)"),
                envelope: nil,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: nil, offset: nil, region: nil, scrollHint: scrollHint, trace: trace, acceptedBy: nil, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        case .noChange:
            pendingSurface = nil
            return ScrollDeltaResult(
                kind: .rejected("damage-nochange"),
                envelope: nil,
                diagnostics: damageDiagnostics(probeMs: probeMs, payloadBuildMs: nil, offset: nil, region: nil, scrollHint: scrollHint, trace: trace, acceptedBy: nil, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
            )
        }
    }

    // Single bitmap tile covering the union of the damage rects. Sub-rect,
    // non-full-width tiles are already exercised by the scroll exposed-strip
    // path, so this stays within proven wire semantics. The union may include
    // unchanged pixels between scattered rects, but those equal the current
    // frame anyway, so the client surface is still correct.
    private func makeTileEnvelope(current: Surface, rects: [PixelRect], capturedAtUptimeNs: UInt64) -> OwnedGraphicsFrameEnvelope? {
        guard let union = PixelRect.union(of: rects)?.clamped(toWidth: current.width, height: current.height),
              union.area > 0,
              let tile = tileData(surface: current, x: union.x, y: union.y, width: union.width, height: union.height),
              let compressed = compressLZFSE(tile) else { return nil }
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: graphicsFrameId,
                capturedAtUptimeNs: capturedAtUptimeNs,
                commandCount: 1,
                payloadLength: compressed.count
            ),
            commands: [
                .bitmapTile(
                    x: union.x,
                    y: union.y,
                    width: union.width,
                    height: union.height,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: compressed.count)
                )
            ],
            payload: compressed
        )
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
