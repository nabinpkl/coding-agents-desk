import Foundation

// ADR-0004 protocol seam. Anything that wants to swap WebRTC stacks, codecs,
// renderers, or capturers does it behind this surface. The only files that
// import WebRTC are the LibWebRTC* impls; AppDelegate holds a
// MediaTransportFactory by protocol.

protocol MediaTransport: AnyObject, Sendable {
    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSources: VideoPlaneSources?,
        videoSinks: VideoPlaneSinks?
    ) async throws

    func stop()

    // Single-consumer stream. Impls construct one continuation per instance.
    var connectionState: AsyncStream<MediaConnectionState> { get }

    // Compatibility hook for client interaction hints. The dual-plane
    // renderer keeps both senders warm; the client compositor owns visible
    // plane switching.
    func setVideoInteractive(_ active: Bool)
}

protocol OwnedMediaChannelServing: AnyObject, Sendable {
    func send(_ envelope: OwnedMediaFrameEnvelope) async throws
    func close()
}

enum MediaTransportRole {
    case offerer
    case answerer
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

enum MediaPlane: String, CaseIterable, Equatable, Hashable, Codable {
    case detail
    case motion

    var trackId: String {
        switch self {
        case .detail: "detail-video"
        case .motion: "motion-video"
        }
    }

    var streamId: String {
        switch self {
        case .detail: "detail"
        case .motion: "motion"
        }
    }

    init?(trackId: String) {
        guard let plane = Self.allCases.first(where: { $0.trackId == trackId }) else {
            return nil
        }
        self = plane
    }
}

struct VideoPlaneSources: Sendable {
    private let sources: [MediaPlane: VideoFrameSource]

    init(_ sources: [MediaPlane: VideoFrameSource]) {
        self.sources = sources
    }

    subscript(_ plane: MediaPlane) -> VideoFrameSource? {
        sources[plane]
    }
}

struct VideoPlaneSinks: Sendable {
    private let sinks: [MediaPlane: VideoFrameSink]

    init(_ sinks: [MediaPlane: VideoFrameSink]) {
        self.sinks = sinks
    }

    subscript(_ plane: MediaPlane) -> VideoFrameSink? {
        sinks[plane]
    }
}

// Codec choice is data, not code. v0 configures codecs per media plane.
// Order is preference; the underlying impl negotiates the first supported
// case for each plane.
struct MediaCodecPreferences: Equatable {
    var preferred: [VideoCodec]

    enum VideoCodec: String, Equatable, Codable {
        case h264
        case h265
        case vp8
        case vp9
        case av1
    }

    static let h264Only = MediaCodecPreferences(preferred: [.h264])
    static let vp9Only = MediaCodecPreferences(preferred: [.vp9])
    static let vp9First = MediaCodecPreferences(preferred: [.vp9, .h264])
    static let av1First = MediaCodecPreferences(preferred: [.av1, .vp9, .h264])

    var preferredCodecNames: [String] {
        preferred.map { codec in
            switch codec {
            case .h264: return "H264"
            case .h265: return "H265"
            case .vp8: return "VP8"
            case .vp9: return "VP9"
            case .av1: return "AV1"
            }
        }
    }

    func allows(statsMimeType: String) -> Bool {
        guard let subtype = statsMimeType.split(separator: "/").last else { return false }
        return preferredCodecNames.contains(String(subtype).uppercased())
    }
}

struct CodecCapabilityDescriptor: Equatable {
    let index: Int
    let name: String
    let preferredPayloadType: String?
    let aptPayloadType: String?
}

enum CodecPreferencePolicy {
    private static let primaryNames: Set<String> = ["H264", "H265", "VP8", "VP9", "AV1"]
    private static let protectionNames: Set<String> = ["RED", "ULPFEC", "FLEXFEC-03"]

    static func orderedAllowedIndexes(
        capabilities: [CodecCapabilityDescriptor],
        preferences: MediaCodecPreferences
    ) -> [Int] {
        var selectedMedia: [CodecCapabilityDescriptor] = []
        for name in preferences.preferredCodecNames {
            selectedMedia.append(
                contentsOf: capabilities.filter {
                    normalize($0.name) == name && isPrimary($0)
                }
            )
        }

        let mediaAndRepairIndexes = selectedMedia.flatMap { media -> [Int] in
            let repairIndexes = media.preferredPayloadType.map { payloadType in
                capabilities
                    .filter { isRtx($0) && $0.aptPayloadType == payloadType }
                    .map(\.index)
            } ?? []
            return [media.index] + repairIndexes
        }
        let protectionIndexes = capabilities
            .filter(isProtection)
            .map(\.index)
        return unique(mediaAndRepairIndexes + protectionIndexes)
    }

    private static func isPrimary(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        primaryNames.contains(normalize(descriptor.name))
    }

    private static func isRtx(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        normalize(descriptor.name) == "RTX"
    }

    private static func isProtection(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        protectionNames.contains(normalize(descriptor.name))
    }

    private static func normalize(_ name: String) -> String {
        name.uppercased()
    }

    private static func unique(_ indexes: [Int]) -> [Int] {
        indexes.reduce([]) { ordered, index in
            ordered.contains(index) ? ordered : ordered + [index]
        }
    }
}

struct MediaPlaneConfiguration: Equatable {
    let plane: MediaPlane
    let codecs: MediaCodecPreferences
    let tuning: SenderTuning
    let captureScaleDownBy: Double

    static var defaultPlanes: [MediaPlane: MediaPlaneConfiguration] {
        defaultPlanes(environment: ProcessInfo.processInfo.environment)
    }

    static func defaultPlanes(environment: [String: String]) -> [MediaPlane: MediaPlaneConfiguration] {
        let base = SenderTuning.fromEnvironment(environment)
        let detail = MediaPlaneConfiguration(
            plane: .detail,
            codecs: .vp9Only,
            tuning: base,
            captureScaleDownBy: 1.0
        )
        let motionCodecs = motionCodecPreferences(environment: environment)
        let motionTuning = base.applyingMotionPlaneGuardrails(for: motionCodecs)
        let motion = MediaPlaneConfiguration(
            plane: .motion,
            codecs: motionCodecs,
            tuning: motionTuning,
            captureScaleDownBy: motionCaptureScaleDownBy(environment: environment)
        )
        return [
            .detail: detail,
            .motion: motion
        ]
    }

    private static func motionCodecPreferences(environment: [String: String]) -> MediaCodecPreferences {
        switch environment["AGENTDESK_TUNING_MOTION_CODEC"]?.lowercased() {
        case "vp9":
            return .vp9Only
        default:
            return .h264Only
        }
    }

    private static func motionCaptureScaleDownBy(environment: [String: String]) -> Double {
        guard let raw = environment["AGENTDESK_TUNING_MOTION_CAPTURE_SCALE_DOWN"],
              let value = Double(raw),
              value > 0
        else {
            return SenderTuning.h264HardwareEncoderScaleDownBy
        }
        return value
    }
}

// Sender-side tuning knobs. All previously hardcoded inside
// LibWebRTCMediaTransport; lifted here so MediaStack can rebuild them
// from env vars at startup and you can A/B without recompiling.
struct SenderTuning: Equatable {
    var screencast: Bool
    var degradationPreference: DegradationPreference
    var maxBitrateKbps: Int
    var minBitrateKbps: Int
    var maxFramerate: Int
    var baseScaleDownBy: Double
    var bweMinKbps: Int
    var bweStartKbps: Int
    var bweMaxKbps: Int
    // Scroll/interactive profile: while the client is scrolling, downscale
    // resolution and cap bitrate hard so the full-frame motion encodes into
    // small frames that clear the encoder + pacer + network fast (this is
    // the latency lever, not just smoothness), raise the framerate ceiling,
    // and use a maintainFramerate degradation preference. Restored to the
    // crisp values after scrollSettleMs of no interaction.
    var scrollScaleDownBy: Double
    var scrollMaxFramerate: Int
    var scrollMaxBitrateKbps: Int
    var scrollMinBitrateKbps: Int
    var scrollSettleMs: Int
    // Detail plane suppression while the motion plane is visible. The detail
    // track stays alive so post-scroll restoration has a warm track, but it
    // stops competing with the motion plane for encoder and pacer budget.
    var detailScrollScaleDownBy: Double
    var detailScrollMaxFramerate: Int
    var detailScrollMaxBitrateKbps: Int
    var detailScrollMinBitrateKbps: Int
    var detailScrollActive: Bool
    // VP9 temporal SVC. With layers > 1 the stream carries a base layer
    // plus enhancement layers; squeezing bitrate (the scroll profile) makes
    // the encoder shed the top layers instantly, dropping framerate with no
    // resolution reconfig and no keyframe. Kept constant across profiles so
    // the layer structure never changes (changing it would force a reinit).
    var temporalLayers: Int

    enum DegradationPreference: String, Equatable {
        case disabled
        case maintainFramerate
        case maintainResolution
        case balanced
    }

    // Encoding values applied to the sender for a given mode. Pure data so
    // the derivation is testable without a live WebRTC sender.
    struct EncodingProfile: Equatable {
        var scaleResolutionDownBy: Double
        var maxFramerate: Int
        var maxBitrateKbps: Int
        var minBitrateKbps: Int
        var temporalLayers: Int
        var degradation: DegradationPreference
        var active: Bool
    }

    var crispProfile: EncodingProfile {
        EncodingProfile(
            scaleResolutionDownBy: baseScaleDownBy,
            maxFramerate: maxFramerate,
            maxBitrateKbps: maxBitrateKbps,
            minBitrateKbps: minBitrateKbps,
            temporalLayers: temporalLayers,
            degradation: degradationPreference,
            active: true
        )
    }

    var scrollProfile: EncodingProfile {
        EncodingProfile(
            scaleResolutionDownBy: scrollScaleDownBy,
            maxFramerate: scrollMaxFramerate,
            maxBitrateKbps: scrollMaxBitrateKbps,
            minBitrateKbps: scrollMinBitrateKbps,
            temporalLayers: temporalLayers,
            degradation: .maintainFramerate,
            active: true
        )
    }

    var detailScrollSuppressedProfile: EncodingProfile {
        EncodingProfile(
            scaleResolutionDownBy: detailScrollScaleDownBy,
            maxFramerate: detailScrollMaxFramerate,
            maxBitrateKbps: detailScrollMaxBitrateKbps,
            minBitrateKbps: detailScrollMinBitrateKbps,
            temporalLayers: temporalLayers,
            degradation: .maintainFramerate,
            active: detailScrollActive
        )
    }

    static let h264HardwareEncoderScaleDownBy = 3.5

    // The current shipping defaults (commit history shows how we arrived
    // here). Paired with codecs=.vp9First in MediaStack: VP9's screen-content
    // mode handles block-skip on static text, so maintainResolution can drop
    // fps under pressure without losing visual quality. With H.264 this
    // combination caused text flicker; with VP9 it's the right tradeoff.
    // Any env-var override in fromEnvironment() replaces individual fields.
    static let `default` = SenderTuning(
        screencast: true,
        degradationPreference: .maintainResolution,
        maxBitrateKbps: 8_000,
        minBitrateKbps: 2_000,
        maxFramerate: 30,
        baseScaleDownBy: 1.0,
        bweMinKbps: 2_000,
        bweStartKbps: 6_000,
        bweMaxKbps: 8_000,
        scrollScaleDownBy: 3.0,
        scrollMaxFramerate: 60,
        scrollMaxBitrateKbps: 3_500,
        scrollMinBitrateKbps: 1_000,
        scrollSettleMs: 300,
        detailScrollScaleDownBy: 4.0,
        detailScrollMaxFramerate: 1,
        detailScrollMaxBitrateKbps: 150,
        detailScrollMinBitrateKbps: 50,
        detailScrollActive: true,
        temporalLayers: 3
    )

    // Reads AGENTDESK_TUNING_<FIELD> env vars over the default. Examples:
    //   AGENTDESK_TUNING_DEGRADATION=maintainResolution
    //   AGENTDESK_TUNING_MAX_BITRATE_KBPS=12000
    //   AGENTDESK_TUNING_SCREENCAST=0
    // Leaves fields untouched when the env var is absent.
    static func fromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> SenderTuning {
        let defaults = SenderTuning.default
        return SenderTuning(
            screencast: env["AGENTDESK_TUNING_SCREENCAST"].map { $0 == "1" } ?? defaults.screencast,
            degradationPreference: env["AGENTDESK_TUNING_DEGRADATION"].flatMap(DegradationPreference.init(rawValue:)) ?? defaults.degradationPreference,
            maxBitrateKbps: env["AGENTDESK_TUNING_MAX_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.maxBitrateKbps,
            minBitrateKbps: env["AGENTDESK_TUNING_MIN_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.minBitrateKbps,
            maxFramerate: env["AGENTDESK_TUNING_MAX_FPS"].flatMap(Int.init) ?? defaults.maxFramerate,
            baseScaleDownBy: env["AGENTDESK_TUNING_SCALE_DOWN"].flatMap(Double.init) ?? defaults.baseScaleDownBy,
            bweMinKbps: env["AGENTDESK_TUNING_BWE_MIN_KBPS"].flatMap(Int.init) ?? defaults.bweMinKbps,
            bweStartKbps: env["AGENTDESK_TUNING_BWE_START_KBPS"].flatMap(Int.init) ?? defaults.bweStartKbps,
            bweMaxKbps: env["AGENTDESK_TUNING_BWE_MAX_KBPS"].flatMap(Int.init) ?? defaults.bweMaxKbps,
            scrollScaleDownBy: env["AGENTDESK_TUNING_SCROLL_SCALE_DOWN"].flatMap(Double.init) ?? defaults.scrollScaleDownBy,
            scrollMaxFramerate: env["AGENTDESK_TUNING_SCROLL_MAX_FPS"].flatMap(Int.init) ?? defaults.scrollMaxFramerate,
            scrollMaxBitrateKbps: env["AGENTDESK_TUNING_SCROLL_MAX_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.scrollMaxBitrateKbps,
            scrollMinBitrateKbps: env["AGENTDESK_TUNING_SCROLL_MIN_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.scrollMinBitrateKbps,
            scrollSettleMs: env["AGENTDESK_TUNING_SCROLL_SETTLE_MS"].flatMap(Int.init) ?? defaults.scrollSettleMs,
            detailScrollScaleDownBy: env["AGENTDESK_TUNING_DETAIL_SCROLL_SCALE_DOWN"].flatMap(Double.init) ?? defaults.detailScrollScaleDownBy,
            detailScrollMaxFramerate: env["AGENTDESK_TUNING_DETAIL_SCROLL_MAX_FPS"].flatMap(Int.init) ?? defaults.detailScrollMaxFramerate,
            detailScrollMaxBitrateKbps: env["AGENTDESK_TUNING_DETAIL_SCROLL_MAX_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.detailScrollMaxBitrateKbps,
            detailScrollMinBitrateKbps: env["AGENTDESK_TUNING_DETAIL_SCROLL_MIN_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.detailScrollMinBitrateKbps,
            detailScrollActive: env["AGENTDESK_TUNING_DETAIL_SCROLL_ACTIVE"].map { $0 != "0" } ?? defaults.detailScrollActive,
            temporalLayers: env["AGENTDESK_TUNING_TEMPORAL_LAYERS"].flatMap(Int.init) ?? defaults.temporalLayers
        )
    }

    func applyingCodecGuardrails(for codecs: MediaCodecPreferences) -> SenderTuning {
        guard codecs.preferred == [.h264] else { return self }
        return SenderTuning(
            screencast: screencast,
            degradationPreference: .maintainFramerate,
            maxBitrateKbps: maxBitrateKbps,
            minBitrateKbps: minBitrateKbps,
            maxFramerate: maxFramerate,
            baseScaleDownBy: baseScaleDownBy,
            bweMinKbps: bweMinKbps,
            bweStartKbps: bweStartKbps,
            bweMaxKbps: bweMaxKbps,
            scrollScaleDownBy: max(scrollScaleDownBy, Self.h264HardwareEncoderScaleDownBy),
            scrollMaxFramerate: scrollMaxFramerate,
            scrollMaxBitrateKbps: scrollMaxBitrateKbps,
            scrollMinBitrateKbps: scrollMinBitrateKbps,
            scrollSettleMs: scrollSettleMs,
            detailScrollScaleDownBy: detailScrollScaleDownBy,
            detailScrollMaxFramerate: detailScrollMaxFramerate,
            detailScrollMaxBitrateKbps: detailScrollMaxBitrateKbps,
            detailScrollMinBitrateKbps: detailScrollMinBitrateKbps,
            detailScrollActive: detailScrollActive,
            temporalLayers: 1
        )
    }

    func applyingMotionPlaneGuardrails(for codecs: MediaCodecPreferences) -> SenderTuning {
        guard codecs == .h264Only else {
            return SenderTuning(
                screencast: screencast,
                degradationPreference: degradationPreference,
                maxBitrateKbps: maxBitrateKbps,
                minBitrateKbps: minBitrateKbps,
                maxFramerate: maxFramerate,
                baseScaleDownBy: baseScaleDownBy,
                bweMinKbps: bweMinKbps,
                bweStartKbps: bweStartKbps,
                bweMaxKbps: bweMaxKbps,
                scrollScaleDownBy: 1.0,
                scrollMaxFramerate: scrollMaxFramerate,
                scrollMaxBitrateKbps: scrollMaxBitrateKbps,
                scrollMinBitrateKbps: scrollMinBitrateKbps,
                scrollSettleMs: scrollSettleMs,
                detailScrollScaleDownBy: detailScrollScaleDownBy,
                detailScrollMaxFramerate: detailScrollMaxFramerate,
                detailScrollMaxBitrateKbps: detailScrollMaxBitrateKbps,
                detailScrollMinBitrateKbps: detailScrollMinBitrateKbps,
                detailScrollActive: detailScrollActive,
                temporalLayers: temporalLayers
            )
        }
        let h264 = applyingCodecGuardrails(for: .h264Only)
        return SenderTuning(
            screencast: h264.screencast,
            degradationPreference: h264.degradationPreference,
            maxBitrateKbps: h264.maxBitrateKbps,
            minBitrateKbps: h264.minBitrateKbps,
            maxFramerate: h264.maxFramerate,
            baseScaleDownBy: h264.baseScaleDownBy,
            bweMinKbps: h264.bweMinKbps,
            bweStartKbps: h264.bweStartKbps,
            bweMaxKbps: h264.bweMaxKbps,
            scrollScaleDownBy: 1.0,
            scrollMaxFramerate: h264.scrollMaxFramerate,
            scrollMaxBitrateKbps: h264.scrollMaxBitrateKbps,
            scrollMinBitrateKbps: h264.scrollMinBitrateKbps,
            scrollSettleMs: h264.scrollSettleMs,
            detailScrollScaleDownBy: h264.detailScrollScaleDownBy,
            detailScrollMaxFramerate: h264.detailScrollMaxFramerate,
            detailScrollMaxBitrateKbps: h264.detailScrollMaxBitrateKbps,
            detailScrollMinBitrateKbps: h264.detailScrollMinBitrateKbps,
            detailScrollActive: h264.detailScrollActive,
            temporalLayers: h264.temporalLayers
        )
    }
}

enum OutboundRtpPlaneResolver {
    static func planeName(
        trackIdentifier: String?,
        mid: String?,
        midPlanes: [String: MediaPlane]
    ) -> String {
        if let trackIdentifier, let plane = MediaPlane(trackId: trackIdentifier) {
            return plane.rawValue
        }
        if let mid, let plane = midPlanes[mid] {
            return plane.rawValue
        }
        return "unknown"
    }
}

enum MediaTransportError: Error {
    case notYetImplemented
    case unsupportedCodecPreference(String)
}

struct OwnedMediaResendRing {
    private let capacityFrames: Int
    private var frames: [UInt64: [UInt16: Data]] = [:]
    private var order: [UInt64] = []

    init(capacityFrames: Int) {
        self.capacityFrames = max(1, capacityFrames)
    }

    mutating func remember(frameId: UInt64, packets: [Data]) {
        var packetMap: [UInt16: Data] = [:]
        packetMap.reserveCapacity(packets.count)
        for (index, packet) in packets.enumerated() where index <= Int(UInt16.max) {
            packetMap[UInt16(index)] = packet
        }
        if frames[frameId] == nil {
            order.append(frameId)
        }
        frames[frameId] = packetMap
        while order.count > capacityFrames {
            let evicted = order.removeFirst()
            frames.removeValue(forKey: evicted)
        }
    }

    func packets(frameId: UInt64, indexes: [UInt16], maxCount: Int) -> (packets: [(UInt16, Data)], misses: [UInt16]) {
        guard maxCount > 0 else {
            return ([], indexes)
        }
        let uniqueIndexes = Array(Set(indexes)).sorted()
        guard let stored = frames[frameId] else {
            return ([], Array(uniqueIndexes.prefix(maxCount)))
        }
        var packets: [(UInt16, Data)] = []
        var misses: [UInt16] = []
        packets.reserveCapacity(min(uniqueIndexes.count, maxCount))
        for index in uniqueIndexes.prefix(maxCount) {
            if let packet = stored[index] {
                packets.append((index, packet))
            } else {
                misses.append(index)
            }
        }
        return (packets, misses)
    }
}

// Marker protocol so MediaTransport.start carries one signature on both
// sides. The concrete view type is platform-specific and accessed via the
// impl, not the protocol; the host never instantiates a sink.
protocol VideoFrameSink: AnyObject, Sendable {}
