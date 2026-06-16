import Foundation

// ADR-0004 protocol seam. Mirror of host/AgentDeskHost/MediaTransport.swift.
// The only files that import WebRTC are the LibWebRTC* impls; PairingClient
// holds a MediaTransportFactory by protocol.

protocol MediaTransport: AnyObject, Sendable {
    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSource: VideoFrameSource?,
        videoSink: VideoFrameSink?
    ) async throws

    func stop()

    var connectionState: AsyncStream<MediaConnectionState> { get }
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

enum MediaTransportError: Error {
    case notYetImplemented
    case unsupportedCodecPreference(String)
}

// VideoFrameSource is the host-side capture seam. The client mirror exists
// so MediaTransport.start can carry one signature on both sides; the
// client never instantiates a source.
protocol VideoFrameSource: AnyObject, Sendable {
    func start() async throws
    func stop()
}

// VideoFrameSink is declared in its own file but the protocol surface
// here keeps MediaTransport.start's signature symmetric with the host.
// On the client, concrete impls (RTCMTLVideoSink) live alongside the
// concrete transport.
