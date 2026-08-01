import AVFoundation
import CoreMedia
import Foundation
import AgentDeskWire

// Phase 3 of the mixed-mode renderer (ADR-0025). Decode-by-display: a reassembled
// motion frame is wrapped into a CMSampleBuffer (format description from the HEVC
// parameter sets carried on each keyframe) and enqueued on an
// AVSampleBufferDisplayLayer, which decodes and presents it itself. Frames superseded
// inside one presentation interval are marked DoNotDisplay so the layer still decodes
// their reference state without visibly replaying stale history. A delta that arrives
// before any keyframe has no format description, so it is dropped and the transport
// requests a keyframe to resync.

// The enqueue target, abstracted so the decode state machine can be tested without
// a real display layer. displayStatus / requiresFlushToResumeDecoding expose the
// layer health the recovery policy reads; flushAndRemoveImage clears a wedged
// (failed) layer, unlike flush which keeps the last image and the decode error.
protocol OwnedMediaVideoEnqueuing: AnyObject {
    func enqueue(_ sampleBuffer: CMSampleBuffer)
    func flush()
    func flushAndRemoveImage()
    var displayStatus: String { get }
    var requiresFlushToResumeDecoding: Bool { get }
    /// R230. Everything about the layer that could explain a black picture, sampled together.
    ///
    /// The recovery policy above reads exactly two properties, `displayStatus` and
    /// `requiresFlushToResumeDecoding`, and a layer that is black while reporting `rendering`
    /// with no flush required trips neither. Measured on a device: after a network handover the
    /// host delivered three full keyframes -- 69KB, 57KB and 25KB IDRs needing no prior state --
    /// the client acked every one, requested no keyframes, reported a steady 15fps, and showed
    /// nothing. Every counter we had was taken at enqueue, so a wedged layer and a working one
    /// printed identically and the failure was only ever found by someone looking at the phone.
    ///
    /// These are the properties that are NOT read anywhere else, each of which produces a black
    /// picture on its own: a zero or detached frame, a hidden or transparent layer, a stalled
    /// control timebase, and the layer's own `error`.
    var renderDiagnostics: [String: String] { get }
}

enum OwnedMediaVideoDecodeResult: Equatable {
    case enqueued
    case droppedPendingKeyframe
    case formatDescriptionUnavailable
    case sampleBufferBuildFailed
    // ADR-0027: a wedged layer (failed / requiresFlush) was reset, but this frame was
    // a delta so the stream cannot resync until a keyframe. The caller requests one.
    case recoveredRequestKeyframe
    // ADR-0033: resolution changes are accepted only at keyframes. A delta with a new
    // size cannot be decoded against the current format description.
    case droppedMismatchedDimensionsRequestKeyframe
}

enum OwnedMediaVideoPresentation {
    case display
    case decodeOnly
}

final class OwnedMediaVideoDecoder {
    private let layer: OwnedMediaVideoEnqueuing
    private let makeFormatDescription: (OwnedMediaParameterSets, OwnedMediaCodec) -> CMVideoFormatDescription?
    private var formatDescription: CMVideoFormatDescription?
    private var currentDimensions: (width: Int, height: Int)?

    init(
        layer: OwnedMediaVideoEnqueuing,
        makeFormatDescription: @escaping (OwnedMediaParameterSets, OwnedMediaCodec) -> CMVideoFormatDescription? = OwnedMediaVideoDecoder.formatDescription
    ) {
        self.layer = layer
        self.makeFormatDescription = makeFormatDescription
    }

    /// R230. Passthrough so the sink can report layer state alongside its enqueue counters
    /// without reaching past the decoder for the layer it owns.
    var renderDiagnostics: [String: String] { layer.renderDiagnostics }

    @discardableResult
    func decodeAndEnqueue(
        _ envelope: OwnedMediaFrameEnvelope,
        presentation: OwnedMediaVideoPresentation = .display
    ) -> OwnedMediaVideoDecodeResult {
        let header = envelope.header
        // ADR-0027: recover a wedged layer before anything else. A delta decoded
        // against a reference lost to packet drop can leave the layer .failed /
        // requiresFlushToResumeDecoding; flush() keeps that failed image and does not
        // clear the decode error, so blank the layer and force a keyframe resync. If
        // this very frame is the keyframe, fall through and let it resync now;
        // otherwise tell the caller to request one.
        var recovered = false
        if OwnedMediaDisplayQueuePolicy.action(
            displayStatus: layer.displayStatus,
            requiresFlushToResumeDecoding: layer.requiresFlushToResumeDecoding,
            isKeyframe: header.isKeyframe,
            renderGapMs: nil
        ) == .flushAndRemoveImage {
            layer.flushAndRemoveImage()
            formatDescription = nil
            recovered = true
            if !header.isKeyframe {
                return .recoveredRequestKeyframe
            }
        }
        if header.isKeyframe {
            guard let parameterSets = header.parameterSets,
                  let description = makeFormatDescription(parameterSets, header.codec) else {
                return .formatDescriptionUnavailable
            }
            // A keyframe is a fresh sync point. Drop any pending (undisplayed) queue so
            // the keyframe shows next instead of a stale delta. flush() keeps the
            // current image up until the keyframe decodes, so there is no black frame.
            // Skip it right after a recovery, which already blanked the layer.
            if !recovered { layer.flush() }
            formatDescription = description
            currentDimensions = (header.width, header.height)
        } else if let currentDimensions,
                  currentDimensions.width != header.width || currentDimensions.height != header.height {
            formatDescription = nil
            self.currentDimensions = nil
            layer.flush()
            return .droppedMismatchedDimensionsRequestKeyframe
        }
        guard let description = formatDescription else {
            return .droppedPendingKeyframe
        }
        guard let sampleBuffer = Self.makeSampleBuffer(
            payload: envelope.payload,
            formatDescription: description,
            presentationTimeNs: header.presentationTimeNs,
            presentation: presentation
        ) else {
            return .sampleBufferBuildFailed
        }
        layer.enqueue(sampleBuffer)
        return .enqueued
    }

    // Reset on surface reset: forget the format description so the next frame must be
    // a keyframe.
    func reset() {
        formatDescription = nil
        currentDimensions = nil
        layer.flush()
    }

    static func makeSampleBuffer(
        payload: Data,
        formatDescription: CMVideoFormatDescription,
        presentationTimeNs: UInt64,
        presentation: OwnedMediaVideoPresentation
    ) -> CMSampleBuffer? {
        let length = payload.count
        guard length > 0 else { return nil }
        var blockBuffer: CMBlockBuffer?
        let createStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: length,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: length,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard createStatus == kCMBlockBufferNoErr, let blockBuffer else { return nil }
        let copyStatus = payload.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return -1 }
            return CMBlockBufferReplaceDataBytes(
                with: base,
                blockBuffer: blockBuffer,
                offsetIntoDestination: 0,
                dataLength: length
            )
        }
        guard copyStatus == kCMBlockBufferNoErr else { return nil }
        var sampleBuffer: CMSampleBuffer?
        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: CMTime(value: CMTimeValue(presentationTimeNs), timescale: 1_000_000_000),
            decodeTimeStamp: .invalid
        )
        var sampleSize = length
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
        guard sampleStatus == noErr, let sampleBuffer else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let attachment = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            let presentationKey = switch presentation {
            case .display:
                kCMSampleAttachmentKey_DisplayImmediately
            case .decodeOnly:
                kCMSampleAttachmentKey_DoNotDisplay
            }
            CFDictionarySetValue(
                attachment,
                Unmanaged.passUnretained(presentationKey).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }
        return sampleBuffer
    }

    // The real path: a CMVideoFormatDescription from the keyframe's parameter sets.
    static func formatDescription(
        _ parameterSets: OwnedMediaParameterSets,
        codec: OwnedMediaCodec
    ) -> CMVideoFormatDescription? {
        switch codec {
        case .hevc:
            guard let vps = parameterSets.vps else { return nil }
            return fromParameterSets([vps, parameterSets.sps, parameterSets.pps], hevc: true)
        case .h264:
            return fromParameterSets([parameterSets.sps, parameterSets.pps], hevc: false)
        }
    }

    private static func fromParameterSets(_ sets: [Data], hevc: Bool) -> CMVideoFormatDescription? {
        let arrays = sets.map { [UInt8]($0) }
        let sizes = arrays.map { $0.count }
        var description: CMFormatDescription?
        let status = arrays.withPointers { pointers in
            sizes.withUnsafeBufferPointer { sizeBuffer in
                pointers.withUnsafeBufferPointer { pointerBuffer -> OSStatus in
                    if hevc {
                        return CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: arrays.count,
                            parameterSetPointers: pointerBuffer.baseAddress!,
                            parameterSetSizes: sizeBuffer.baseAddress!,
                            nalUnitHeaderLength: 4,
                            extensions: nil,
                            formatDescriptionOut: &description
                        )
                    } else {
                        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: arrays.count,
                            parameterSetPointers: pointerBuffer.baseAddress!,
                            parameterSetSizes: sizeBuffer.baseAddress!,
                            nalUnitHeaderLength: 4,
                            formatDescriptionOut: &description
                        )
                    }
                }
            }
        }
        return status == noErr ? description : nil
    }
}

private extension Array where Element == [UInt8] {
    // Build a contiguous array of pointers into each element's bytes, valid only for
    // the duration of `body`.
    func withPointers<R>(_ body: ([UnsafePointer<UInt8>]) -> R) -> R {
        func recurse(_ index: Int, _ collected: [UnsafePointer<UInt8>]) -> R {
            if index == count {
                return body(collected)
            }
            return self[index].withUnsafeBufferPointer { buffer in
                recurse(index + 1, collected + [buffer.baseAddress!])
            }
        }
        return recurse(0, [])
    }
}

// The on-device enqueue target: wraps an AVSampleBufferDisplayLayer.
final class OwnedMediaVideoLayerEnqueuer: OwnedMediaVideoEnqueuing {
    let displayLayer: AVSampleBufferDisplayLayer

    init(displayLayer: AVSampleBufferDisplayLayer) {
        self.displayLayer = displayLayer
    }

    func enqueue(_ sampleBuffer: CMSampleBuffer) {
        displayLayer.enqueue(sampleBuffer)
    }

    func flush() {
        // Drop pending (undisplayed) sample buffers but KEEP the current image.
        // flushAndRemoveImage() blanks the layer, and because the decoder flushes on
        // every keyframe, that produced a black frame at each keyframe interval (the
        // periodic flash). flush() keeps the last frame visible until the keyframe
        // decodes, so the keyframe is a sharpen, not a black blink.
        displayLayer.flush()
    }

    func flushAndRemoveImage() {
        // Clears the failed/wedged decode state, unlike flush(). Reserved for the
        // recovery path (ADR-0027), where the layer is already failed so there is no
        // good image to keep.
        displayLayer.flushAndRemoveImage()
    }

    // R230. Read the RENDERER, not the layer. `AVSampleBufferDisplayLayer`'s own `status`,
    // `error`, `timebase` and `enqueueSampleBuffer:` are all deprecated as of iOS 18, each
    // pointing at `sampleBufferRenderer` instead. On a device showing a black screen the
    // deprecated surface reported `rendering`, no error and no flush required, indefinitely --
    // so the legacy properties are, at best, not the live state.
    private var renderer: AVSampleBufferVideoRenderer { displayLayer.sampleBufferRenderer }

    private func describe(_ status: AVQueuedSampleBufferRenderingStatus) -> String {
        switch status {
        case .unknown: return "unknown"
        case .rendering: return "rendering"
        case .failed: return "failed"
        @unknown default: return "unknown"
        }
    }

    var displayStatus: String { describe(renderer.status) }

    var requiresFlushToResumeDecoding: Bool {
        renderer.requiresFlushToResumeDecoding
    }

    var renderDiagnostics: [String: String] {
        let bounds = displayLayer.bounds
        let frame = displayLayer.frame
        var fields: [String: String] = [
            "status": displayStatus,
            "requiresFlush": String(renderer.requiresFlushToResumeDecoding),
            "readyForMore": String(displayLayer.isReadyForMoreMediaData),
            // The legacy surface reported alongside the renderer's, deliberately. If these ever
            // disagree, the disagreement IS the finding: it would mean the properties this code
            // has been trusting are not describing the thing actually on screen.
            "legacyStatus": describe(displayLayer.status),
            // The only signal that measures pixels rather than intent: what is displayed right
            // now, as opposed to what has been handed over. nil here while frames are being
            // enqueued is the black screen, stated directly for the first time.
            "displayedFrame": renderer.displayedPixelBuffer() != nil ? "present" : "none",
            // Geometry: any of these alone renders a correctly-decoding layer invisible, and
            // none of them was being read.
            "hidden": String(displayLayer.isHidden),
            "opacity": String(format: "%.2f", displayLayer.opacity),
            "boundsW": String(format: "%.0f", bounds.width),
            "boundsH": String(format: "%.0f", bounds.height),
            "frameW": String(format: "%.0f", frame.width),
            "frameH": String(format: "%.0f", frame.height),
            "attached": String(displayLayer.superlayer != nil),
            "gravity": displayLayer.videoGravity.rawValue
        ]
        // A timebase whose rate is 0 queues samples that never present, which looks exactly
        // like a wedge from every counter we take at enqueue.
        if let timebase = displayLayer.controlTimebase {
            fields["timebaseRate"] = String(format: "%.2f", CMTimebaseGetRate(timebase))
            fields["timebaseSec"] = String(format: "%.2f", CMTimeGetSeconds(CMTimebaseGetTime(timebase)))
        } else {
            fields["timebaseRate"] = "none"
        }
        if let error = renderer.error {
            fields["error"] = String(describing: error)
        }
        if let legacyError = displayLayer.error {
            fields["legacyError"] = String(describing: legacyError)
        }
        return fields
    }
}
