import AVFoundation
import CoreMedia
import UIKit
import os

protocol OwnedMediaFrameSink: VideoFrameSink {
    @MainActor func renderOwnedMediaFrame(_ envelope: OwnedMediaFrameEnvelope)
    @MainActor func setOwnedMediaDebugStatus(_ status: String)
    @MainActor func setMotionActive(_ active: Bool)
}

@MainActor
final class OwnedMediaVideoSink: OwnedMediaFrameSink, @unchecked Sendable {
    let view: UIView
    private let displayLayer = AVSampleBufferDisplayLayer()
    private let debugLabel = UILabel()
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private var formatDescription: CMVideoFormatDescription?
    private var loggedFirstRenderedFrame = false
    private var renderCount = 0
    private var flushCount = 0

    init() {
        let container = LayerBackedVideoContainerView()
        container.backgroundColor = .black
        view = container
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = UIColor.black.cgColor
        container.layer.addSublayer(displayLayer)
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
        }
    }

    func renderOwnedMediaFrame(_ envelope: OwnedMediaFrameEnvelope) {
        guard envelope.header.plane == .detail else { return }
        do {
            if let parameterSets = envelope.header.parameterSets {
                formatDescription = try Self.makeFormatDescription(
                    codec: envelope.header.codec,
                    parameterSets: parameterSets
                )
            }
            guard let formatDescription else {
                logger.error("owned media frame dropped without format description")
                ownedMediaStderrTrace("render-drop-no-format frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) codec=\(envelope.header.codec.rawValue) bytes=\(envelope.payload.count)")
                return
            }
            let sampleBuffer = try Self.makeSampleBuffer(
                envelope: envelope,
                formatDescription: formatDescription
            )
            if displayLayer.status == .failed {
                displayLayer.flushAndRemoveImage()
                flushCount += 1
            } else if envelope.header.isKeyframe {
                displayLayer.flush()
                flushCount += 1
            }
            displayLayer.enqueue(sampleBuffer)
            renderCount += 1
            let status = Self.displayStatus(displayLayer)
            if renderCount == 1 || renderCount.isMultiple(of: 30) || envelope.header.isKeyframe {
                ownedMediaStderrTrace("render count=\(renderCount) flushed=\(flushCount) frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) bytes=\(envelope.payload.count) display=\(status)")
            }
            setOwnedMediaDebugStatus(
                "rendered=\(renderCount) flushed=\(flushCount) frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) bytes=\(envelope.payload.count)\ncodec=\(envelope.header.codec.rawValue) \(envelope.header.width)x\(envelope.header.height) display=\(status)"
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
                logger.notice("owned first rendered frame plane=\(envelope.header.plane.rawValue, privacy: .public) codec=\(envelope.header.codec.rawValue, privacy: .public) size=\(envelope.header.width, privacy: .public)x\(envelope.header.height, privacy: .public) view=\(Int(self.view.bounds.width), privacy: .public)x\(Int(self.view.bounds.height), privacy: .public) bytes=\(envelope.payload.count, privacy: .public)")
                ownedMediaStderrTrace("first-rendered plane=\(envelope.header.plane.rawValue) codec=\(envelope.header.codec.rawValue) size=\(envelope.header.width)x\(envelope.header.height) view=\(Int(self.view.bounds.width))x\(Int(self.view.bounds.height)) bytes=\(envelope.payload.count)")
            }
        } catch {
            setOwnedMediaDebugStatus("render failed frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) error=\(String(describing: error))\ndisplay=\(Self.displayStatus(displayLayer))")
            logger.error("owned media render failed: \(String(describing: error), privacy: .public)")
            ownedMediaStderrTrace("render-failed frame=\(envelope.header.frameId) key=\(envelope.header.isKeyframe) error=\(String(describing: error)) display=\(Self.displayStatus(displayLayer))")
        }
    }

    func setOwnedMediaDebugStatus(_ status: String) {
        debugLabel.text = "owned media\n\(status)"
    }

    func setMotionActive(_ active: Bool) {}

    private static func displayStatus(_ layer: AVSampleBufferDisplayLayer) -> String {
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
        if let error = layer.error {
            return "\(status) \(String(describing: error))"
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
