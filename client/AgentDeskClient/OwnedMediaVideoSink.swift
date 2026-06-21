import AVFoundation
import Compression
import CoreMedia
import UIKit
import VideoToolbox
import os

protocol OwnedMediaFrameSink: VideoFrameSink {
    @MainActor func renderOwnedMediaFrame(_ envelope: OwnedMediaFrameEnvelope) -> OwnedMediaRenderStats?
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
    private let displayLayer = AVSampleBufferDisplayLayer()
    private let surfaceLayer = CALayer()
    private let debugLabel = UILabel()
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private var formatDescription: CMVideoFormatDescription?
    private var hevcDecoder: OwnedHEVCFrameDecoder?
    private var compositor = OwnedSurfaceCompositor()
    private var loggedFirstRenderedFrame = false
    private var renderCount = 0
    private var flushCount = 0
    private var lastRenderUptimeNs: UInt64?
    private var pendingGraphicsResetRequest: OwnedGraphicsResetRequest?

    init() {
        let container = LayerBackedVideoContainerView()
        container.backgroundColor = .black
        view = container
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = UIColor.black.cgColor
        container.layer.addSublayer(displayLayer)
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
            self.displayLayer.frame = bounds
            self.surfaceLayer.frame = bounds
        }
    }

    func renderOwnedMediaFrame(_ envelope: OwnedMediaFrameEnvelope) -> OwnedMediaRenderStats? {
        let renderStartNs = DispatchTime.now().uptimeNanoseconds
        let renderGapNs = lastRenderUptimeNs.map { renderStartNs &- $0 }
        let renderGapMs = renderGapNs.map { Double($0) / 1_000_000.0 }
        do {
            if let parameterSets = envelope.header.parameterSets {
                formatDescription = try Self.makeFormatDescription(
                    codec: envelope.header.codec,
                    parameterSets: parameterSets
                )
                hevcDecoder = nil
            }
            guard let formatDescription else {
                logger.error("owned media frame dropped without format description")
                ownedMediaStderrTrace("render-drop-no-format frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) codec=\(envelope.header.codec.rawValue) bytes=\(envelope.payload.count)")
                return nil
            }
            let preEnqueueStatus = Self.displayStatusCode(displayLayer)
            let readyBeforeEnqueue = displayLayer.isReadyForMoreMediaData
            let requiresFlushToResumeDecoding = displayLayer.requiresFlushToResumeDecoding
            let displayQueueAction = OwnedMediaDisplayQueuePolicy.action(
                displayStatus: preEnqueueStatus,
                requiresFlushToResumeDecoding: requiresFlushToResumeDecoding,
                isKeyframe: envelope.header.isKeyframe,
                renderGapMs: renderGapMs
            )
            if displayQueueAction == .flushAndRemoveImage {
                displayLayer.flushAndRemoveImage()
                flushCount += 1
            }
            let sampleBuildStartNs = DispatchTime.now().uptimeNanoseconds
            let sampleBuffer = try Self.makeSampleBuffer(
                envelope: envelope,
                formatDescription: formatDescription
            )
            let sampleBuildEndNs = DispatchTime.now().uptimeNanoseconds
            let enqueueStartNs = DispatchTime.now().uptimeNanoseconds
            displayLayer.enqueue(sampleBuffer)
            do {
                if hevcDecoder == nil {
                    hevcDecoder = try OwnedHEVCFrameDecoder(formatDescription: formatDescription)
                }
                if let pixelBuffer = try hevcDecoder?.decode(sampleBuffer) {
                    _ = try compositor.applyFullRefresh(
                        pixelBuffer: pixelBuffer,
                        updateId: envelope.header.updateId
                    )
                    surfaceLayer.contents = compositor.makeImage()
                    surfaceLayer.isHidden = false
                }
            } catch {
                hevcDecoder = nil
                surfaceLayer.isHidden = true
                pendingGraphicsResetRequest = currentGraphicsResetRequest(reason: "retained-hevc-\(String(describing: error))")
                ownedMediaStderrTrace("retained-hevc-failed frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) error=\(String(describing: error)) fallback=display-layer reset=queued")
            }
            let enqueueEndNs = DispatchTime.now().uptimeNanoseconds
            let postEnqueueStatus = Self.displayStatus(displayLayer)
            let readyAfterEnqueue = displayLayer.isReadyForMoreMediaData
            let requiresFlushAfterEnqueue = displayLayer.requiresFlushToResumeDecoding
            renderCount += 1
            let renderEndNs = DispatchTime.now().uptimeNanoseconds
            lastRenderUptimeNs = renderEndNs
            let sampleBuildMs = OwnedMediaRenderTiming.elapsedMs(
                from: sampleBuildStartNs,
                to: sampleBuildEndNs
            )
            let enqueueMs = OwnedMediaRenderTiming.elapsedMs(
                from: enqueueStartNs,
                to: enqueueEndNs
            )
            let renderWorkMs = OwnedMediaRenderTiming.elapsedMs(
                from: renderStartNs,
                to: renderEndNs
            )
            let status = preEnqueueStatus
            let backlog = OwnedMediaRenderBacklog.estimate(
                renderGapMs: renderGapMs,
                payloadBytes: envelope.payload.count
            )
            if renderCount == 1 ||
                renderCount.isMultiple(of: 30) ||
                envelope.header.isKeyframe ||
                displayQueueAction == .flushAndRemoveImage ||
                renderWorkMs > 8 {
                ownedMediaStderrTrace("render count=\(renderCount) flushed=\(flushCount) frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) renderGapMs=\(Self.formatOptionalMilliseconds(renderGapNs)) sampleMs=\(Self.formatDouble(sampleBuildMs)) enqueueMs=\(Self.formatDouble(enqueueMs)) workMs=\(Self.formatDouble(renderWorkMs)) ready=\(readyBeforeEnqueue) requiresFlush=\(requiresFlushToResumeDecoding) postReady=\(readyAfterEnqueue) postRequiresFlush=\(requiresFlushAfterEnqueue) action=\(displayQueueAction.rawValue) backlogFrames=\(backlog.frames) backlogBytes=\(backlog.bytes) bytes=\(envelope.payload.count) display=\(status) postDisplay=\(postEnqueueStatus) displayPresentation=estimated")
            }
            setOwnedMediaDebugStatus(
                "rendered=\(renderCount) flushed=\(flushCount) frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) bytes=\(envelope.payload.count)\ncodec=\(envelope.header.codec.rawValue) \(envelope.header.width)x\(envelope.header.height) display=\(postEnqueueStatus) action=\(displayQueueAction.rawValue)"
            )
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard let self else { return }
                self.setOwnedMediaDebugStatus(
                    "rendered=\(self.renderCount) flushed=\(self.flushCount) frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) bytes=\(envelope.payload.count)\ncodec=\(envelope.header.codec.rawValue) \(envelope.header.width)x\(envelope.header.height) display=\(Self.displayStatus(self.displayLayer))"
                )
            }
            if !loggedFirstRenderedFrame {
                loggedFirstRenderedFrame = true
                logger.notice("owned first rendered frame codec=\(envelope.header.codec.rawValue, privacy: .public) size=\(envelope.header.width, privacy: .public)x\(envelope.header.height, privacy: .public) view=\(Int(self.view.bounds.width), privacy: .public)x\(Int(self.view.bounds.height), privacy: .public) bytes=\(envelope.payload.count, privacy: .public)")
                ownedMediaStderrTrace("first-rendered codec=\(envelope.header.codec.rawValue) size=\(envelope.header.width)x\(envelope.header.height) view=\(Int(self.view.bounds.width))x\(Int(self.view.bounds.height)) bytes=\(envelope.payload.count)")
            }
            return OwnedMediaRenderStats(
                frameId: envelope.header.frameId,
                totalFramesDecoded: UInt64(renderCount),
                renderGapMs: renderGapMs,
                renderStartUptimeNs: renderStartNs,
                renderEndUptimeNs: renderEndNs,
                payloadBytes: envelope.payload.count,
                flushCount: flushCount,
                displayStatus: status,
                displayReadyBeforeEnqueue: readyBeforeEnqueue,
                requiresFlushToResumeDecoding: requiresFlushToResumeDecoding,
                displayStatusAfterEnqueue: postEnqueueStatus,
                displayReadyAfterEnqueue: readyAfterEnqueue,
                requiresFlushAfterEnqueue: requiresFlushAfterEnqueue,
                displayPresentation: "estimated",
                sampleBuildMs: sampleBuildMs,
                enqueueMs: enqueueMs,
                renderWorkMs: renderWorkMs,
                displayQueueAction: displayQueueAction,
                clientBacklogFrames: backlog.frames,
                clientBacklogBytes: backlog.bytes
            )
        } catch {
            setOwnedMediaDebugStatus("render failed frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) error=\(String(describing: error))\ndisplay=\(Self.displayStatus(displayLayer))")
            logger.error("owned media render failed: \(String(describing: error), privacy: .public)")
            ownedMediaStderrTrace("render-failed frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) error=\(String(describing: error)) display=\(Self.displayStatus(displayLayer))")
            return nil
        }
    }

    func renderOwnedGraphicsFrame(
        _ envelope: OwnedGraphicsFrameEnvelope,
        queueDepth: OwnedGraphicsQueueDepth = .empty
    ) -> OwnedGraphicsFrameAck {
        do {
            ownedMediaStderrTrace("graphics-frame-apply-start frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(compositor.totalGraphicsFramesApplied)")
            let stats = try compositor.applyGraphicsFrame(envelope)
            surfaceLayer.contents = compositor.makeImage()
            surfaceLayer.isHidden = false
            ownedMediaStderrTrace("graphics-frame frame=\(envelope.header.frameId) generation=\(envelope.header.surfaceGeneration) commands=\(envelope.commands.count) bytes=\(envelope.payload.count) action=\(stats.action) compositorMs=\(Self.formatDouble(stats.compositorMs)) stale=\(stats.staleDiscardCount) copyRects=\(stats.copyRectCount) tileBytes=\(stats.tileBytes) queuedFrames=\(queueDepth.queuedFrames) queueDepthBytes=\(queueDepth.queueDepthBytes) totalGraphicsApplied=\(stats.totalGraphicsFramesApplied)")
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

    private static func displayStatus(_ layer: AVSampleBufferDisplayLayer) -> String {
        let status = displayStatusCode(layer)
        if let error = layer.error {
            return "\(status) \(String(describing: error))"
        }
        return status
    }

    private static func displayStatusCode(_ layer: AVSampleBufferDisplayLayer) -> String {
        let status: String
        switch layer.status {
        case .unknown:
            status = "unknown"
        case .rendering:
            status = "rendering"
        case .failed:
            status = "failed"
        @unknown default:
            status = "other"
        }
        return status
    }

    private static func makeFormatDescription(
        codec: OwnedMediaCodec,
        parameterSets: OwnedMediaParameterSets
    ) throws -> CMVideoFormatDescription {
        var formatDescription: CMVideoFormatDescription?
        let status: OSStatus
        switch codec {
        case .h264:
            var sps = [UInt8](parameterSets.sps)
            var pps = [UInt8](parameterSets.pps)
            status = sps.withUnsafeMutableBufferPointer { spsBuffer in
                pps.withUnsafeMutableBufferPointer { ppsBuffer in
                    let pointers: [UnsafePointer<UInt8>] = [
                        UnsafePointer(spsBuffer.baseAddress!),
                        UnsafePointer(ppsBuffer.baseAddress!)
                    ]
                    let sizes = [spsBuffer.count, ppsBuffer.count]
                    return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                        allocator: kCFAllocatorDefault,
                        parameterSetCount: 2,
                        parameterSetPointers: pointers,
                        parameterSetSizes: sizes,
                        nalUnitHeaderLength: 4,
                        formatDescriptionOut: &formatDescription
                    )
                }
            }
        case .hevc:
            guard let vpsData = parameterSets.vps else {
                throw SessionRejected(reason: .malformed)
            }
            var vps = [UInt8](vpsData)
            var sps = [UInt8](parameterSets.sps)
            var pps = [UInt8](parameterSets.pps)
            status = vps.withUnsafeMutableBufferPointer { vpsBuffer in
                sps.withUnsafeMutableBufferPointer { spsBuffer in
                    pps.withUnsafeMutableBufferPointer { ppsBuffer in
                        let pointers: [UnsafePointer<UInt8>] = [
                            UnsafePointer(vpsBuffer.baseAddress!),
                            UnsafePointer(spsBuffer.baseAddress!),
                            UnsafePointer(ppsBuffer.baseAddress!)
                        ]
                        let sizes = [vpsBuffer.count, spsBuffer.count, ppsBuffer.count]
                        return CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: 3,
                            parameterSetPointers: pointers,
                            parameterSetSizes: sizes,
                            nalUnitHeaderLength: 4,
                            extensions: nil,
                            formatDescriptionOut: &formatDescription
                        )
                    }
                }
            }
        }
        guard status == noErr, let formatDescription else {
            throw SessionRejected(reason: .malformed)
        }
        return formatDescription
    }

    private static func makeSampleBuffer(
        envelope: OwnedMediaFrameEnvelope,
        formatDescription: CMVideoFormatDescription
    ) throws -> CMSampleBuffer {
        var blockBuffer: CMBlockBuffer?
        let payload = envelope.payload as NSData
        let blockStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: UnsafeMutableRawPointer(mutating: payload.bytes),
            blockLength: payload.length,
            blockAllocator: kCFAllocatorNull,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: payload.length,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard blockStatus == noErr, let blockBuffer else {
            throw SessionRejected(reason: .malformed)
        }

        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: .invalid,
            decodeTimeStamp: .invalid
        )
        var sampleSize = payload.length
        var sampleBuffer: CMSampleBuffer?
        let sampleStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: blockBuffer,
            formatDescription: formatDescription,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard sampleStatus == noErr, let sampleBuffer else {
            throw SessionRejected(reason: .malformed)
        }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true) {
            let attachment = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                attachment,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }
        return sampleBuffer
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
    static func formatOptionalMilliseconds(_ ns: UInt64?) -> String {
        guard let ns else { return "nil" }
        return formatDouble(Double(ns) / 1_000_000.0)
    }

    static func formatDouble(_ value: Double) -> String {
        String(format: "%.1f", value)
    }
}

private final class OwnedHEVCFrameDecoder {
    private var session: VTDecompressionSession?
    private var lastDecodedPixelBuffer: CVPixelBuffer?

    init(formatDescription: CMVideoFormatDescription) throws {
        var callback = VTDecompressionOutputCallbackRecord(
            decompressionOutputCallback: { refcon, _, status, _, imageBuffer, _, _ in
                guard status == noErr,
                      let refcon,
                      let imageBuffer else { return }
                let decoder = Unmanaged<OwnedHEVCFrameDecoder>
                    .fromOpaque(refcon)
                    .takeUnretainedValue()
                decoder.lastDecodedPixelBuffer = imageBuffer
            },
            decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque()
        )
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey: [:]
        ]
        var session: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: formatDescription,
            decoderSpecification: nil,
            imageBufferAttributes: attributes as CFDictionary,
            outputCallback: &callback,
            decompressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw SessionRejected(reason: .malformed)
        }
        self.session = session
    }

    deinit {
        if let session {
            VTDecompressionSessionInvalidate(session)
        }
    }

    func decode(_ sampleBuffer: CMSampleBuffer) throws -> CVPixelBuffer? {
        guard let session else { return nil }
        lastDecodedPixelBuffer = nil
        var flagsOut = VTDecodeInfoFlags()
        let status = VTDecompressionSessionDecodeFrame(
            session,
            sampleBuffer: sampleBuffer,
            flags: [._EnableAsynchronousDecompression],
            frameRefcon: nil,
            infoFlagsOut: &flagsOut
        )
        guard status == noErr else {
            throw SessionRejected(reason: .malformed)
        }
        VTDecompressionSessionWaitForAsynchronousFrames(session)
        return lastDecodedPixelBuffer
    }
}

struct OwnedSurfaceCompositorStats: Equatable {
    let action: String
    let compositorMs: Double
    let staleDiscardCount: Int
    let totalGraphicsFramesApplied: UInt64
    let copyRectCount: Int
    let tileBytes: Int
}

struct OwnedSurfaceCompositor {
    private(set) var committedUpdateId = OwnedSurfaceUpdateId(surfaceGeneration: 0, frameId: 0)
    private(set) var staleDiscardCount = 0
    private(set) var totalGraphicsFramesApplied: UInt64 = 0
    private var width = 0
    private var height = 0
    private var bytesPerRow = 0
    private var pixels = Data()

    mutating func applyFullRefresh(
        pixelBuffer: CVPixelBuffer,
        updateId: OwnedSurfaceUpdateId
    ) throws -> OwnedSurfaceCompositorStats {
        let startNs = DispatchTime.now().uptimeNanoseconds
        guard updateId.isStrictlyNewer(than: committedUpdateId) else {
            staleDiscardCount += 1
            return stats(action: "stale-hevc", startNs: startNs, copyRects: 0, tileBytes: 0)
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA,
              let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw SessionRejected(reason: .malformed)
        }
        let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
        let sourceBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let targetBytesPerRow = sourceWidth * 4
        var nextPixels = Data(count: targetBytesPerRow * sourceHeight)
        nextPixels.withUnsafeMutableBytes { destination in
            guard let destinationBase = destination.baseAddress else { return }
            for y in 0..<sourceHeight {
                let source = baseAddress.advanced(by: y * sourceBytesPerRow)
                let target = destinationBase.advanced(by: y * targetBytesPerRow)
                target.copyMemory(from: source, byteCount: targetBytesPerRow)
            }
        }
        width = sourceWidth
        height = sourceHeight
        bytesPerRow = targetBytesPerRow
        pixels = nextPixels
        committedUpdateId = updateId
        return stats(action: "hevc-refresh", startNs: startNs, copyRects: 0, tileBytes: targetBytesPerRow * sourceHeight)
    }

    mutating func applyGraphicsFrame(_ envelope: OwnedGraphicsFrameEnvelope) throws -> OwnedSurfaceCompositorStats {
        let startNs = DispatchTime.now().uptimeNanoseconds
        let updateId = envelope.header.updateId
        guard updateId.isStrictlyNewer(than: committedUpdateId) ||
            envelope.commands.contains(where: { command in
                if case .resetSurface = command { return true }
                return false
            }) else {
            staleDiscardCount += 1
            return stats(action: "stale-graphics", startNs: startNs, copyRects: 0, tileBytes: 0)
        }
        var next = self
        var copyRects = 0
        var tileBytes = 0
        for command in envelope.commands {
            switch command {
            case let .resetSurface(surfaceGeneration, width, height, pixelFormat):
                guard pixelFormat == .bgra,
                      let baseline = OwnedSurfaceUpdateId.acceptedResetBaseline(
                        surfaceGeneration: surfaceGeneration,
                        committedSurfaceGeneration: next.committedUpdateId.surfaceGeneration
                      ) else {
                    staleDiscardCount += 1
                    return stats(action: "stale-reset", startNs: startNs, copyRects: copyRects, tileBytes: tileBytes)
                }
                next.width = width
                next.height = height
                next.bytesPerRow = width * 4
                next.pixels = Data(count: next.bytesPerRow * height)
                next.committedUpdateId = baseline
            case let .copyRect(srcX, srcY, dstX, dstY, width, height):
                guard updateId.isStrictlyNewer(than: next.committedUpdateId) else {
                    staleDiscardCount += 1
                    return stats(action: "stale-graphics", startNs: startNs, copyRects: copyRects, tileBytes: tileBytes)
                }
                try next.copyRect(srcX: srcX, srcY: srcY, dstX: dstX, dstY: dstY, width: width, height: height)
                copyRects += 1
            case let .bitmapTile(x, y, width, height, compression, byteRange):
                guard updateId.isStrictlyNewer(than: next.committedUpdateId),
                      compression == .lzfse else {
                    staleDiscardCount += 1
                    return stats(action: "stale-tile", startNs: startNs, copyRects: copyRects, tileBytes: tileBytes)
                }
                let compressed = envelope.payload[byteRange.offset..<(byteRange.offset + byteRange.length)]
                let decoded = try next.decompressLZFSE(Data(compressed), expectedCount: width * height * 4)
                try next.paintTile(decoded, x: x, y: y, width: width, height: height)
                tileBytes += decoded.count
            case .codecTile:
                throw SessionRejected(reason: .malformed)
            }
        }
        if updateId.isStrictlyNewer(than: next.committedUpdateId) {
            next.committedUpdateId = updateId
        }
        next.totalGraphicsFramesApplied += 1
        self = next
        return stats(action: "graphics", startNs: startNs, copyRects: copyRects, tileBytes: tileBytes)
    }

    func makeImage() -> CGImage? {
        guard width > 0, height > 0, pixels.count == bytesPerRow * height else { return nil }
        let data = pixels as CFData
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
        copyRects: Int,
        tileBytes: Int
    ) -> OwnedSurfaceCompositorStats {
        OwnedSurfaceCompositorStats(
            action: action,
            compositorMs: Double(DispatchTime.now().uptimeNanoseconds &- startNs) / 1_000_000.0,
            staleDiscardCount: staleDiscardCount,
            totalGraphicsFramesApplied: totalGraphicsFramesApplied,
            copyRectCount: copyRects,
            tileBytes: tileBytes
        )
    }

    private mutating func copyRect(srcX: Int, srcY: Int, dstX: Int, dstY: Int, width: Int, height: Int) throws {
        try validateRect(x: srcX, y: srcY, width: width, height: height)
        try validateRect(x: dstX, y: dstY, width: width, height: height)
        let copyBytesPerRow = width * 4
        var temp = Data(count: copyBytesPerRow * height)
        pixels.withUnsafeBytes { sourceBytes in
            temp.withUnsafeMutableBytes { targetBytes in
                guard let sourceBase = sourceBytes.baseAddress,
                      let targetBase = targetBytes.baseAddress else { return }
                for row in 0..<height {
                    let source = sourceBase.advanced(by: (srcY + row) * bytesPerRow + srcX * 4)
                    let target = targetBase.advanced(by: row * copyBytesPerRow)
                    target.copyMemory(from: source, byteCount: copyBytesPerRow)
                }
            }
        }
        pixels.withUnsafeMutableBytes { targetBytes in
            temp.withUnsafeBytes { sourceBytes in
                guard let targetBase = targetBytes.baseAddress,
                      let sourceBase = sourceBytes.baseAddress else { return }
                for row in 0..<height {
                    let source = sourceBase.advanced(by: row * copyBytesPerRow)
                    let target = targetBase.advanced(by: (dstY + row) * bytesPerRow + dstX * 4)
                    target.copyMemory(from: source, byteCount: copyBytesPerRow)
                }
            }
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

    private func validateRect(x: Int, y: Int, width: Int, height: Int) throws {
        guard x >= 0, y >= 0, width > 0, height > 0,
              x <= self.width - width,
              y <= self.height - height,
              pixels.count == bytesPerRow * self.height else {
            throw SessionRejected(reason: .malformed)
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
