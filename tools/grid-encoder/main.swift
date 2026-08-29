// One window in, fragmented HEVC out.
//
// The bare-metal half of the live-tile path: capture a window with
// ScreenCaptureKit, encode it with VideoToolbox through AVAssetWriter, and write
// the resulting fMP4 fragments to stdout. It makes no policy decisions. It does
// not dedupe, does not adapt quality, does not pace, and does not know what a
// tile or a ladder is. The caller says which window and how big; everything else
// downstream is TypeScript's.
//
// The output is what Media Source Extensions eats directly, so the whole
// delivery path after this process is: sidecar copies bytes to an HTTP body,
// page appends them to a SourceBuffer, WebKit hardware-decodes and composites.
// No pacer, no jitter buffer, no packet repair, no keyframe negotiation.
//
// Backpressure is the pipe. If nobody reads stdout the write blocks, the capture
// handler stops draining, and frames are simply not produced. That is the entire
// flow-control design.

import AVFoundation
import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers
import VideoToolbox

// MARK: - stdout framing

/// `[1 byte kind][4 bytes big-endian length][payload]`. Kind 0 is a JSON header,
/// 1 is the fMP4 initialization segment, 2 is a media fragment. Kind 3 is one
/// raw H.264 access unit in Annex-B form (annexb mode only): 8 bytes of
/// big-endian presentation time in microseconds, 1 keyframe byte, then NALUs.
enum Frame: UInt8 { case meta = 0, initialization = 1, media = 2, accessUnit = 3 }

let stdoutLock = NSLock()
// A reader that goes away without closing the pipe is the dangerous case, not
// the broken pipe. The pipe fills, the write BLOCKS rather than erroring, and
// this process sits alive forever holding a capture nobody sees. Worse,
// measured: a Bun parent with unconsumed child pipes stops delivering stdout
// for every LATER spawn in that process, so one abandoned encoder wedges all
// future tiles until something reaps it. The watchdog turns a write stalled
// past `stalledWriteLimit` into an exit; a healthy write completes in
// microseconds, so ten seconds of stall only ever means the consumer is gone.
let stalledWriteLimit: TimeInterval = 10
let stdoutDeadlineLock = NSLock()
nonisolated(unsafe) var writeDeadline: Date?
let watchdog = Thread {
    while true {
        Thread.sleep(forTimeInterval: 1)
        stdoutDeadlineLock.lock()
        let deadline = writeDeadline
        stdoutDeadlineLock.unlock()
        if let deadline, Date() > deadline { exit(0) }
    }
}
watchdog.start()

func emit(_ kind: Frame, _ payload: Data) {
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    var header = Data([kind.rawValue])
    var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { header.append(contentsOf: $0) }
    do {
        // Reaping ourselves on a broken pipe is the only reliable way this
        // process dies. The parent kills us when it sees the reader go, but a
        // dev-server proxy in between does not always propagate the abort, and
        // a capture nobody is reading is pure cost.
        stdoutDeadlineLock.lock()
        writeDeadline = Date().addingTimeInterval(stalledWriteLimit)
        stdoutDeadlineLock.unlock()
        try FileHandle.standardOutput.write(contentsOf: header)
        try FileHandle.standardOutput.write(contentsOf: payload)
        stdoutDeadlineLock.lock()
        writeDeadline = nil
        stdoutDeadlineLock.unlock()
    } catch {
        exit(0)
    }
}
func emitMeta(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    emit(.meta, data)
}
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("grid-encoder: \(message)\n".utf8))
    emitMeta(["type": "error", "message": message])
    exit(1)
}

// MARK: - codec string

/// The RFC 6381 codec string for the stream we actually produced, parsed out of
/// the `hvcC` box in the initialization segment.
///
/// Derived rather than hardcoded because the browser's `addSourceBuffer` string
/// has to describe the real profile, tier and level, and AVFoundation picks the
/// level from the resolution and bitrate we asked for. Guessing it produces a
/// `NotSupportedError` at append time, which is a confusing way to learn that a
/// constant was wrong.
func hevcCodecString(fromInitializationSegment data: Data) -> String? {
    let marker = Array("hvcC".utf8)
    let bytes = [UInt8](data)
    guard bytes.count > 8 else { return nil }
    var box = -1
    for i in 0...(bytes.count - marker.count) where Array(bytes[i..<(i + marker.count)]) == marker {
        box = i + marker.count
        break
    }
    guard box >= 0, bytes.count >= box + 13 else { return nil }
    let profileSpace = (bytes[box + 1] & 0xC0) >> 6
    let tierFlag = (bytes[box + 1] & 0x20) >> 5
    let profileIDC = bytes[box + 1] & 0x1F
    let compatibility = (UInt32(bytes[box + 2]) << 24) | (UInt32(bytes[box + 3]) << 16)
        | (UInt32(bytes[box + 4]) << 8) | UInt32(bytes[box + 5])
    let levelIDC = bytes[box + 12]
    let constraints = Array(bytes[(box + 6)...(box + 11)])

    // The compatibility field is written with the bit order reversed.
    var reversed: UInt32 = 0
    for i in 0..<32 where compatibility & (1 << i) != 0 { reversed |= 1 << (31 - i) }

    var parts = ["hvc1"]
    parts.append((["", "A", "B", "C"][Int(profileSpace)]) + String(profileIDC))
    parts.append(String(reversed, radix: 16))
    parts.append((tierFlag == 0 ? "L" : "H") + String(levelIDC))
    // Trailing zero constraint bytes are omitted.
    var tail = constraints
    while let last = tail.last, last == 0 { tail.removeLast() }
    for byte in tail { parts.append(String(format: "%02X", byte)) }
    return parts.joined(separator: ".")
}

// MARK: - encode and mux

/// Hardware HEVC through VideoToolbox, muxed to fragmented MP4 by AVAssetWriter.
///
/// The split is forced by the framework and happens to be the split we want.
/// AVAssetWriter will only flush a fragment per call when its input is
/// PASSTHROUGH -- ask it to encode for you and it insists on a fixed segment
/// interval, which buries a fixed buffer under MSE's own. So VideoToolbox
/// encodes, the writer only wraps, and one frame in is one fragment out.
final class EncodingMuxer: NSObject, AVAssetWriterDelegate {
    private var session: VTCompressionSession?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var firstPTS: CMTime?
    private var announcedCodec = false
    private let width: Int, height: Int, bitrate: Int, segmentSeconds: Double
    /// True once a sample has gone into the current segment, so the very first
    /// keyframe opens a segment rather than closing an empty one.
    private var segmentOpen = false
    private(set) var submitted = 0, encodedCount = 0, appended = 0, notReady = 0, encodeErrors = 0

    init(width: Int, height: Int, bitrate: Int, segmentSeconds: Double) {
        self.width = width; self.height = height; self.bitrate = bitrate
        self.segmentSeconds = segmentSeconds
        super.init()
    }

    func start() {
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_HEVC,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
            ] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { refcon, _, status, _, sample in
                guard status == noErr, let sample, let refcon else { return }
                Unmanaged<EncodingMuxer>.fromOpaque(refcon).takeUnretainedValue().encoded(sample)
            },
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &created,
        )
        guard status == noErr, let created else { fail("VTCompressionSessionCreate failed: \(status)") }
        session = created
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel,
                             value: kVTProfileLevel_HEVC_Main_AutoLevel)
        // Keyed by DURATION rather than frame count, because the segment length
        // is what the viewer feels and the capture rate varies with how much the
        // window is doing. A sparse window would otherwise stretch its GOP, and
        // its segment, to minutes.
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                             value: NSNumber(value: segmentSeconds))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                             value: NSNumber(value: 600))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AverageBitRate,
                             value: NSNumber(value: bitrate))
        VTCompressionSessionPrepareToEncodeFrames(created)
    }

    /// A raw captured frame on its way into the encoder.
    func submit(_ sample: CMSampleBuffer) {
        guard let session, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        if firstPTS == nil { firstPTS = pts }
        submitted += 1
        let encodeStatus = VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixels,
            presentationTimeStamp: CMTimeSubtract(pts, firstPTS!),
            duration: CMSampleBufferGetDuration(sample),
            frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: nil,
        )
        if encodeStatus != noErr { encodeErrors += 1 }
    }

    /// An encoded frame on its way into the muxer.
    private func encoded(_ sample: CMSampleBuffer) {
        encodedCount += 1
        if writer == nil {
            // Built on the first encoded frame, because the passthrough input
            // needs the real format description and only the encoder has it.
            guard let format = CMSampleBufferGetFormatDescription(sample) else { return }
            let assetWriter = AVAssetWriter(contentType: UTType.mpeg4Movie)
            assetWriter.outputFileTypeProfile = .mpeg4CMAFCompliant
            assetWriter.preferredOutputSegmentInterval = .indefinite
            assetWriter.initialSegmentStartTime = .zero
            assetWriter.delegate = self
            let writerInput = AVAssetWriterInput(
                mediaType: .video, outputSettings: nil, sourceFormatHint: format,
            )
            writerInput.expectsMediaDataInRealTime = true
            guard assetWriter.canAdd(writerInput) else { fail("writer refused the passthrough input") }
            assetWriter.add(writerInput)
            guard assetWriter.startWriting() else {
                let error = assetWriter.error as NSError?
                fail("startWriting failed: \(error?.userInfo ?? [:])")
            }
            assetWriter.startSession(atSourceTime: .zero)
            writer = assetWriter
            input = writerInput
        }
        guard let writer, let input else { return }
        guard input.isReadyForMoreMediaData else { notReady += 1; return }

        // A segment has to START with a sync sample: AVAssetWriter rejects
        // anything else with "segment is not allowed to start with a non-sync
        // sample", under the HLS profile and the CMAF one alike. So a segment is
        // a GOP. Flush BEFORE appending a keyframe, which closes the segment the
        // previous frames filled and lets this keyframe open the next one.
        if isSyncSample(sample) && segmentOpen {
            writer.flushSegment()
            segmentOpen = false
        }
        appended += 1
        guard input.append(sample) else {
            fail("append failed: \(String(describing: writer.error))")
        }
        segmentOpen = true
    }

    /// A frame other decoders can start from. Absent attachments means sync.
    private func isSyncSample(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
            as? [[CFString: Any]], let first = attachments.first else { return true }
        return !((first[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
    }

    func assetWriter(
        _ writer: AVAssetWriter,
        didOutputSegmentData segmentData: Data,
        segmentType: AVAssetSegmentType,
        segmentReport: AVAssetSegmentReport?
    ) {
        switch segmentType {
        case .initialization:
            if !announcedCodec {
                announcedCodec = true
                let codec = hevcCodecString(fromInitializationSegment: segmentData)
                emitMeta([
                    "type": "codec",
                    "codec": codec ?? "hvc1.1.6.L93.B0",
                    "derived": codec != nil,
                ])
            }
            emit(.initialization, segmentData)
        case .separable:
            emit(.media, segmentData)
        @unknown default:
            break
        }
    }
}

// MARK: - raw H.264 for a transport that packetizes

/// Hardware H.264 through VideoToolbox, emitted as bare Annex-B access units.
///
/// No muxer at all: this mode exists for a WebRTC-style transport that wants
/// encoded frames to packetize itself. Constrained Baseline because that is the
/// profile every browser's RTP answer advertises (42e01f), so the bytes match
/// what the SDP promised. SPS and PPS ride in front of every keyframe, which is
/// what lets a receiver join or recover mid-stream.
final class RawH264Encoder: NSObject {
    private var session: VTCompressionSession?
    private var firstPTS: CMTime?
    private let width: Int, height: Int, bitrate: Int, keyframeSeconds: Double
    private let profile: CFString
    private let forceKeyLock = NSLock()
    private var forceKeyframe = false
    private(set) var submitted = 0, encodedCount = 0, appended = 0, notReady = 0, encodeErrors = 0

    init(width: Int, height: Int, bitrate: Int, keyframeSeconds: Double, profile: CFString) {
        self.width = width; self.height = height; self.bitrate = bitrate
        self.keyframeSeconds = keyframeSeconds
        self.profile = profile
        super.init()
    }

    /// The transport asks for a keyframe (a PLI arrived); the next frame is one.
    func requestKeyframe() {
        forceKeyLock.lock()
        forceKeyframe = true
        forceKeyLock.unlock()
    }

    func start() {
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
            ] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { refcon, _, status, _, sample in
                guard status == noErr, let sample, let refcon else { return }
                Unmanaged<RawH264Encoder>.fromOpaque(refcon).takeUnretainedValue().encoded(sample)
            },
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &created,
        )
        guard status == noErr, let created else { fail("VTCompressionSessionCreate failed: \(status)") }
        session = created
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel, value: profile)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                             value: NSNumber(value: keyframeSeconds))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                             value: NSNumber(value: 600))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AverageBitRate,
                             value: NSNumber(value: bitrate))
        VTCompressionSessionPrepareToEncodeFrames(created)
        emitMeta(["type": "codec", "codec": "h264", "derived": false])
    }

    func submit(_ sample: CMSampleBuffer) {
        guard let session, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        if firstPTS == nil { firstPTS = pts }
        submitted += 1
        forceKeyLock.lock()
        let key = forceKeyframe
        forceKeyframe = false
        forceKeyLock.unlock()
        let properties: CFDictionary? = key
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary
            : nil
        let encodeStatus = VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixels,
            presentationTimeStamp: CMTimeSubtract(pts, firstPTS!),
            duration: CMSampleBufferGetDuration(sample),
            frameProperties: properties, sourceFrameRefcon: nil, infoFlagsOut: nil,
        )
        if encodeStatus != noErr { encodeErrors += 1 }
    }

    private func encoded(_ sample: CMSampleBuffer) {
        encodedCount += 1
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sample),
              let format = CMSampleBufferGetFormatDescription(sample) else { return }

        let keyframe: Bool = {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[CFString: Any]], let first = attachments.first else { return true }
            return !((first[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
        }()

        var lengthPrefixSize: Int32 = 4
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: nil,
            parameterSetSizeOut: nil, parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: &lengthPrefixSize,
        )

        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            dataBuffer, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &pointer,
        ) == kCMBlockBufferNoErr, let pointer else { return }

        let startCode: [UInt8] = [0, 0, 0, 1]
        var annexB = Data()
        // Parameter sets ahead of every keyframe: a receiver can start here.
        if keyframe {
            var parameterSetCount = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                parameterSetSizeOut: nil, parameterSetCountOut: &parameterSetCount,
                nalUnitHeaderLengthOut: nil,
            )
            for index in 0..<parameterSetCount {
                var setPointer: UnsafePointer<UInt8>?
                var setSize = 0
                guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: index, parameterSetPointerOut: &setPointer,
                    parameterSetSizeOut: &setSize, parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil,
                ) == noErr, let setPointer else { continue }
                annexB.append(contentsOf: startCode)
                annexB.append(setPointer, count: setSize)
            }
        }
        // AVCC to Annex-B: each length prefix becomes a start code.
        var offset = 0
        let bytes = UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self)
        let prefix = Int(lengthPrefixSize)
        while offset + prefix <= totalLength {
            var naluLength = 0
            for i in 0..<prefix { naluLength = (naluLength << 8) | Int(bytes[offset + i]) }
            guard naluLength > 0, offset + prefix + naluLength <= totalLength else { break }
            annexB.append(contentsOf: startCode)
            annexB.append(bytes + offset + prefix, count: naluLength)
            offset += prefix + naluLength
        }
        guard !annexB.isEmpty else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let microseconds = UInt64(max(0, pts.seconds) * 1_000_000)
        var payload = Data()
        var big = microseconds.bigEndian
        withUnsafeBytes(of: &big) { payload.append(contentsOf: $0) }
        payload.append(keyframe ? 1 : 0)
        payload.append(annexB)
        appended += 1
        emit(.accessUnit, payload)
    }
}

/// Adapts either encoder behind the capture callback.
protocol FrameSink: AnyObject {
    func submit(_ sample: CMSampleBuffer)
}
extension EncodingMuxer: FrameSink {}
extension RawH264Encoder: FrameSink {}

// MARK: - capture

final class Capturer: NSObject, SCStreamOutput, SCStreamDelegate {
    let muxer: FrameSink
    init(muxer: FrameSink) { self.muxer = muxer }
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete,
              CMSampleBufferGetImageBuffer(sb) != nil
        else { return }
        muxer.submit(sb)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("capture stopped: \(error.localizedDescription)")
    }
}

// MARK: - main

let arguments = CommandLine.arguments
func argument(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: "--\(name)"), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}
guard let windowArgument = argument("window"), let windowID = UInt32(windowArgument) else {
    fail("usage: grid-encoder --window <id> [--width N] [--height N] [--fps N] "
        + "[--bitrate BPS] [--segment SECONDS] [--verbose]")
}
let requestedWidth = argument("width").flatMap(Int.init)
let requestedHeight = argument("height").flatMap(Int.init)
let fps = argument("fps").flatMap(Int32.init) ?? 30
let bitrate = argument("bitrate").flatMap(Int.init) ?? 4_000_000
// One segment per GOP, so this is the latency floor the muxer imposes. MSE adds
// its own buffer on top; there is no point going far below it.
let segmentSeconds = argument("segment").flatMap(Double.init) ?? 0.4
/// `hevc-fmp4` feeds MSE; `h264-annexb` feeds a transport that packetizes.
let codecMode = argument("codec") ?? "hevc-fmp4"
guard codecMode == "hevc-fmp4" || codecMode == "h264-annexb" else {
    fail("unknown --codec \(codecMode); expected hevc-fmp4 or h264-annexb")
}
/// H.264 profile for annexb mode. High is the text-quality profile (CABAC,
/// 8x8 transform); receivers configure their decoder from the SPS in-band, so
/// this does not need to match anything in an SDP. `cb` remains for a receiver
/// that truly cannot take High.
let profileArgument = argument("profile") ?? "high"
let h264Profile: CFString
switch profileArgument {
case "high": h264Profile = kVTProfileLevel_H264_High_AutoLevel
case "main": h264Profile = kVTProfileLevel_H264_Main_AutoLevel
case "cb": h264Profile = kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel
default: fail("unknown --profile \(profileArgument); expected high, main, or cb")
}

_ = NSApplication.shared
let semaphore = DispatchSemaphore(value: 0)
// Retained at file scope, not inside the Task that creates them. An SCStream
// held only by a local stops delivering the moment that scope returns, which
// looks exactly like a capture that produced one frame and then hung.
nonisolated(unsafe) var liveStream: SCStream?
nonisolated(unsafe) var liveCapturer: Capturer?
nonisolated(unsafe) var liveMuxer: EncodingMuxer?
nonisolated(unsafe) var liveRawEncoder: RawH264Encoder?
// A plain thread rather than a Timer: the main thread blocks on the semaphore
// below, so there is no run loop for a scheduled timer to fire on.
let countersLock = NSLock()
nonisolated(unsafe) var counters: (() -> String)?
let verbose = CommandLine.arguments.contains("--verbose")
Thread.detachNewThread {
    guard verbose else { return }
    while true {
        Thread.sleep(forTimeInterval: 1.0)
        countersLock.lock(); let snapshot = counters?(); countersLock.unlock()
        if let snapshot { FileHandle.standardError.write(Data((snapshot + "\n").utf8)) }
    }
}
Task {
    guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
          let window = content.windows.first(where: { $0.windowID == windowID })
    else { fail("window \(windowID) is not shareable") }

    // Even dimensions: the encoder rejects odd ones for 4:2:0 chroma.
    let width = (requestedWidth ?? Int(window.frame.width)) & ~1
    let height = (requestedHeight ?? Int(window.frame.height)) & ~1
    emitMeta([
        "type": "open", "window": Int(windowID), "width": width, "height": height,
        "segmentSeconds": segmentSeconds,
        "app": window.owningApplication?.applicationName ?? "",
        "title": window.title ?? "",
    ])

    let sink: FrameSink
    if codecMode == "h264-annexb" {
        let encoder = RawH264Encoder(
            width: width, height: height, bitrate: bitrate, keyframeSeconds: segmentSeconds,
            profile: h264Profile,
        )
        encoder.start()
        sink = encoder
        liveRawEncoder = encoder
        // The transport's picture-loss signal arrives as a byte on stdin; any
        // byte means "next frame must be a keyframe".
        Thread.detachNewThread {
            while true {
                guard let data = try? FileHandle.standardInput.read(upToCount: 1), !data.isEmpty else {
                    return
                }
                encoder.requestKeyframe()
            }
        }
        countersLock.lock()
        counters = {
            "submitted=\(encoder.submitted) encoded=\(encoder.encodedCount) appended=\(encoder.appended) "
                + "encodeErrors=\(encoder.encodeErrors)"
        }
        countersLock.unlock()
    } else {
        let muxer = EncodingMuxer(
            width: width, height: height, bitrate: bitrate, segmentSeconds: segmentSeconds,
        )
        muxer.start()
        sink = muxer
        liveMuxer = muxer
        countersLock.lock()
        counters = {
            "submitted=\(muxer.submitted) encoded=\(muxer.encodedCount) appended=\(muxer.appended) "
                + "notReady=\(muxer.notReady) encodeErrors=\(muxer.encodeErrors)"
        }
        countersLock.unlock()
    }
    let capturer = Capturer(muxer: sink)
    liveCapturer = capturer
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: fps)
    configuration.queueDepth = 5
    configuration.showsCursor = false
    configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    let stream = SCStream(
        filter: SCContentFilter(desktopIndependentWindow: window),
        configuration: configuration,
        delegate: capturer,
    )
    liveStream = stream
    do {
        try stream.addStreamOutput(capturer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "grid-encoder"))
        try await stream.startCapture()
    } catch {
        fail("startCapture failed: \(error.localizedDescription)")
    }
}
semaphore.wait()
