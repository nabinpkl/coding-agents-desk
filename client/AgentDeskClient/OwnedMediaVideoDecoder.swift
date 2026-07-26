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

    var displayStatus: String {
        switch displayLayer.status {
        case .unknown: return "unknown"
        case .rendering: return "rendering"
        case .failed: return "failed"
        @unknown default: return "unknown"
        }
    }

    var requiresFlushToResumeDecoding: Bool {
        displayLayer.requiresFlushToResumeDecoding
    }
}
