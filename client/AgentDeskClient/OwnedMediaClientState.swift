// Client-side owned-media receive/render state (transport errors, stream reads,
// reset-fallback, queue depth, render timing/backlog). Formerly part of
// SharedTypes.swift; the shared wire shapes moved to AgentDeskWire (ADR-0050).
import CryptoKit
import Foundation
import AgentDeskWire


// ADR-0003 and ADR-0030 session-establishment wire shapes. Sent on the control
// stream inside the authenticated session QUIC connection.


// Owned-media video wire types. Scrolling motion rides hardware HEVC over the
// session QUIC datagram lane. These are the carrier-agnostic frame shapes; the
// host encoder fills them and the client video layer decodes them.
// Length-prefixed NAL payload, parameter sets carried on keyframes only.


enum OwnedGraphicsTransportError: Error, Equatable, CustomStringConvertible {
    case streamEOF
    case frameMalformed
    case controlMalformed

    var description: String {
        switch self {
        case .streamEOF:
            return "graphics-stream-eof"
        case .frameMalformed:
            return "graphics-frame-malformed"
        case .controlMalformed:
            return "graphics-control-malformed"
        }
    }
}

enum OwnedGraphicsStreamRead {
    static func unwrap(data: Data?, error: Error?) throws -> Data {
        if let error {
            throw error
        }
        guard let data, !data.isEmpty else {
            throw OwnedGraphicsTransportError.streamEOF
        }
        return data
    }
}


enum OwnedGraphicsResetFallbackDecision: Equatable {
    case send
    case suppress(reason: String)
}

struct OwnedGraphicsResetFallbackGate {
    private var activeGeneration: UInt32?
    private var failedGenerations = Set<UInt32>()

    mutating func startConnection() {
        activeGeneration = nil
        failedGenerations.removeAll()
    }

    mutating func beginFallbackIfAllowed(
        for request: OwnedGraphicsResetRequest
    ) -> OwnedGraphicsResetFallbackDecision {
        let generation = request.lastCommittedSurfaceGeneration
        if activeGeneration != nil {
            return .suppress(reason: "reset-already-active")
        }
        if failedGenerations.contains(generation) {
            return .suppress(reason: "already-failed-generation")
        }
        activeGeneration = generation
        return .send
    }

    mutating func noteFallbackCompleted(for request: OwnedGraphicsResetRequest) {
        clearActiveGeneration(request.lastCommittedSurfaceGeneration)
    }

    mutating func noteFallbackFailed(for request: OwnedGraphicsResetRequest) {
        let generation = request.lastCommittedSurfaceGeneration
        failedGenerations.insert(generation)
        clearActiveGeneration(generation)
    }

    private mutating func clearActiveGeneration(_ generation: UInt32) {
        if activeGeneration == generation {
            activeGeneration = nil
        }
    }
}




struct OwnedGraphicsQueueDepth: Equatable {
    let queuedFrames: Int
    let queueDepthBytes: Int

    static let empty = OwnedGraphicsQueueDepth(queuedFrames: 0, queueDepthBytes: 0)
}


struct OwnedMediaRenderStats: Equatable {
    let frameId: UInt64
    let totalFramesDecoded: UInt64
    let renderGapMs: Double?
    let renderStartUptimeNs: UInt64
    let renderEndUptimeNs: UInt64
    let payloadBytes: Int
    let flushCount: Int
    let displayStatus: String
    let displayReadyBeforeEnqueue: Bool
    let requiresFlushToResumeDecoding: Bool
    let displayStatusAfterEnqueue: String
    let displayReadyAfterEnqueue: Bool
    let requiresFlushAfterEnqueue: Bool
    let displayPresentation: String
    let sampleBuildMs: Double
    let enqueueMs: Double
    let renderWorkMs: Double
    let displayQueueAction: OwnedMediaDisplayQueueAction
    let clientBacklogFrames: Int
    let clientBacklogBytes: Int
}

enum OwnedMediaDisplayQueueAction: String, Equatable {
    case none
    case flushAndRemoveImage
}

enum OwnedMediaDisplayQueuePolicy {
    static func action(
        displayStatus: String,
        requiresFlushToResumeDecoding: Bool,
        isKeyframe: Bool,
        renderGapMs: Double?
    ) -> OwnedMediaDisplayQueueAction {
        if displayStatus == "failed" || requiresFlushToResumeDecoding {
            return .flushAndRemoveImage
        }
        return .none
    }
}

enum OwnedMediaRenderTiming {
    static func elapsedMs(from startNs: UInt64, to endNs: UInt64) -> Double {
        Double(endNs &- startNs) / 1_000_000.0
    }
}

enum OwnedMediaRenderBacklog {
    static func estimate(renderGapMs: Double?, payloadBytes: Int) -> (frames: Int, bytes: Int) {
        guard let renderGapMs else {
            return (0, 0)
        }
        let frames = max(0, Int(floor(renderGapMs / 33.3)) - 1)
        return (frames, frames > 0 ? payloadBytes : 0)
    }
}
