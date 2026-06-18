import AVFoundation
import CoreMedia
import UIKit
import os

protocol OwnedMediaFrameSink: VideoFrameSink {
    @MainActor func renderOwnedMediaFrame(_ envelope: OwnedMediaFrameEnvelope)
    @MainActor func setMotionActive(_ active: Bool)
}

@MainActor
final class OwnedMediaVideoSink: OwnedMediaFrameSink, @unchecked Sendable {
    let view: UIView
    private let compositor: DualPlaneVideoCompositor
    private let activePlanes: Set<MediaPlane>
    private let detailLayer = AVSampleBufferDisplayLayer()
    private let motionLayer = AVSampleBufferDisplayLayer()
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private var formatDescriptions: [MediaPlane: CMVideoFormatDescription] = [:]
    private var loggedFirstRenderedFrame: Set<MediaPlane> = []

    init(activePlanes: Set<MediaPlane> = Set(MediaPlane.allCases), compositor: DualPlaneVideoCompositor = DualPlaneVideoCompositor()) {
        self.activePlanes = activePlanes.isEmpty ? [.detail] : activePlanes
        self.compositor = compositor
        if !self.activePlanes.contains(.detail), self.activePlanes.contains(.motion) {
            _ = self.compositor.setMotionActive(true)
        }
        let container = LayerBackedVideoContainerView()
        container.backgroundColor = .black
        view = container
        for layer in [detailLayer, motionLayer] {
            layer.videoGravity = .resizeAspect
            layer.backgroundColor = UIColor.black.cgColor
            container.layer.addSublayer(layer)
        }
        container.layoutHandler = { [weak self, weak container] in
            guard let self, let bounds = container?.bounds else { return }
            self.detailLayer.frame = bounds
            self.motionLayer.frame = bounds
        }
        applyVisiblePlane()
    }

    func renderOwnedMediaFrame(_ envelope: OwnedMediaFrameEnvelope) {
        guard activePlanes.contains(envelope.header.plane) else { return }
        do {
            if let parameterSets = envelope.header.parameterSets {
                formatDescriptions[envelope.header.plane] = try Self.makeFormatDescription(
                    codec: envelope.header.codec,
                    parameterSets: parameterSets
                )
            }
            guard let formatDescription = formatDescriptions[envelope.header.plane] else {
                logger.error("owned media frame dropped without format description plane=\(envelope.header.plane.rawValue, privacy: .public)")
                return
            }
            let sampleBuffer = try Self.makeSampleBuffer(
                envelope: envelope,
                formatDescription: formatDescription
            )
            displayLayer(for: envelope.header.plane).enqueue(sampleBuffer)
            if !loggedFirstRenderedFrame.contains(envelope.header.plane) {
                loggedFirstRenderedFrame.insert(envelope.header.plane)
                logger.notice("owned first rendered frame plane=\(envelope.header.plane.rawValue, privacy: .public) codec=\(envelope.header.codec.rawValue, privacy: .public) size=\(envelope.header.width, privacy: .public)x\(envelope.header.height, privacy: .public) view=\(Int(self.view.bounds.width), privacy: .public)x\(Int(self.view.bounds.height), privacy: .public) bytes=\(envelope.payload.count, privacy: .public)")
            }
            _ = compositor.noteFrameRendered(on: envelope.header.plane)
            applyVisiblePlane()
        } catch {
            logger.error("owned media render failed: \(String(describing: error), privacy: .public)")
        }
    }

    func setMotionActive(_ active: Bool) {
        guard activePlanes.contains(.motion) else {
            _ = compositor.setMotionActive(false)
            applyVisiblePlane()
            return
        }
        _ = compositor.setMotionActive(active)
        applyVisiblePlane()
    }

    private func displayLayer(for plane: MediaPlane) -> AVSampleBufferDisplayLayer {
        switch plane {
        case .detail: detailLayer
        case .motion: motionLayer
        }
    }

    private func applyVisiblePlane() {
        let visiblePlane = activePlanes.contains(compositor.visiblePlane) ? compositor.visiblePlane : .detail
        detailLayer.isHidden = visiblePlane != .detail || !activePlanes.contains(.detail)
        motionLayer.isHidden = visiblePlane != .motion || !activePlanes.contains(.motion)
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
            presentationTimeStamp: CMTime(value: Int64(envelope.header.presentationTimeNs), timescale: 1_000_000_000),
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
