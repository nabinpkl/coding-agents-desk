import AVFoundation
import CoreMedia
import Foundation

// Phase 3 of the mixed-mode renderer (ADR-0025). Decode-by-display: a reassembled
// motion frame is wrapped into a CMSampleBuffer (format description from the HEVC
// parameter sets carried on each keyframe) and enqueued on an
// AVSampleBufferDisplayLayer set to display immediately, which decodes and presents
// it itself. A delta that arrives before any keyframe has no format description, so
// it is dropped and the transport requests a keyframe to resync.

// The enqueue target, abstracted so the decode state machine can be tested without
// a real display layer.
protocol OwnedMediaVideoEnqueuing: AnyObject {
    func enqueue(_ sampleBuffer: CMSampleBuffer)
    func flush()
}

enum OwnedMediaVideoDecodeResult: Equatable {
    case enqueued
    case droppedPendingKeyframe
    case formatDescriptionUnavailable
    case sampleBufferBuildFailed
}

final class OwnedMediaVideoDecoder {
    private let layer: OwnedMediaVideoEnqueuing
    private let makeFormatDescription: (OwnedMediaParameterSets, OwnedMediaCodec) -> CMVideoFormatDescription?
    private var formatDescription: CMVideoFormatDescription?

    init(
        layer: OwnedMediaVideoEnqueuing,
        makeFormatDescription: @escaping (OwnedMediaParameterSets, OwnedMediaCodec) -> CMVideoFormatDescription? = OwnedMediaVideoDecoder.formatDescription
    ) {
        self.layer = layer
        self.makeFormatDescription = makeFormatDescription
    }

    @discardableResult
    func decodeAndEnqueue(_ envelope: OwnedMediaFrameEnvelope) -> OwnedMediaVideoDecodeResult {
        let header = envelope.header
        if header.isKeyframe {
            guard let parameterSets = header.parameterSets,
                  let description = makeFormatDescription(parameterSets, header.codec) else {
                return .formatDescriptionUnavailable
            }
            // A keyframe is a fresh sync point. Drop any pending (undisplayed) queue so
            // the keyframe shows next instead of a stale delta. flush() keeps the
            // current image up until the keyframe decodes, so there is no black frame.
            layer.flush()
            formatDescription = description
        }
        guard let description = formatDescription else {
            return .droppedPendingKeyframe
        }
        guard let sampleBuffer = Self.makeSampleBuffer(
            payload: envelope.payload,
            formatDescription: description,
            presentationTimeNs: header.presentationTimeNs
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
        layer.flush()
    }

    static func makeSampleBuffer(
        payload: Data,
        formatDescription: CMVideoFormatDescription,
        presentationTimeNs: UInt64
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
            CFDictionarySetValue(
                attachment,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
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
}
