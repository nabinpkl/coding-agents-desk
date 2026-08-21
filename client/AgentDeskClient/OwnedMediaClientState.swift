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

// R230. Frames in, nothing out.
//
// Every other detector in the client is measured at the ENQUEUE end. `fps` counts frames handed
// to the display layer, the stall watchdog watches the enqueue cadence, and the queue policy
// above reads two properties the layer sets on itself. Measured on a device: after a network
// handover the host delivered three full keyframes, the client acknowledged every one, requested
// nothing, reported a steady 15fps, and showed a black screen for minutes. Every counter we had
// printed the same thing it prints when the picture is fine, so a wedged layer and a working one
// were indistinguishable and the failure was only ever found by someone looking at the phone.
// Two transport rebuilds did not clear it. A force quit did.
//
// `displayedPixelBuffer()` is the one signal that measures pixels rather than intent, and until
// now it was sampled into a diagnostics field and read by nothing. This turns it into a trigger.
//
// Pure so it can be driven by a test clock, like the enqueue-side watchdog beside it.
struct OwnedMediaDisplayOutputWatchdog {
    /// How recently a frame must have been accepted for "nothing out" to mean anything. Without
    /// this, an idle host reads identically to a wedge, and asking for a keyframe because nobody
    /// is sending one is a keyframe storm on the link least able to carry it.
    let activeWindowNs: UInt64
    /// How long the display may show nothing while frames are landing before we call it wedged.
    /// This is what separates a real wedge from the ordinary moment before a session's first
    /// frame reaches the glass.
    let graceNs: UInt64
    /// How many times the grace may double while recovery keeps failing. A recovery costs a true
    /// keyframe, which is the most expensive frame in the system, so a wedge that our cheapest
    /// remedy cannot fix must not be re-fought every few seconds forever.
    let maximumBackoffDoublings: Int

    static func configured(
        stallNs: UInt64,
        maximumBackoffDoublings: Int = 4
    ) -> OwnedMediaDisplayOutputWatchdog {
        OwnedMediaDisplayOutputWatchdog(
            activeWindowNs: stallNs,
            graceNs: stallNs,
            maximumBackoffDoublings: maximumBackoffDoublings
        )
    }

    /// - Parameter lastOutputNs: when the display last had a frame on it, or, before it ever has,
    ///   when we started handing frames over. A wedge is measured from whichever came last, so a
    ///   stream that displays nothing from its very first frame is still caught.
    /// - Parameter consecutiveRecoveries: failed recovery attempts since the display last showed
    ///   anything. Drives the backoff, and is the number worth logging: a rising count is this
    ///   watchdog reporting that its own remedy is not working.
    func shouldRecover(
        hasDisplayedFrame: Bool,
        lastEnqueueNs: UInt64?,
        lastOutputNs: UInt64?,
        consecutiveRecoveries: Int,
        nowNs: UInt64
    ) -> Bool {
        // Something is on the glass. Whatever else may be wrong, it is not this.
        guard !hasDisplayedFrame else { return false }
        // The host must be sending AND we must be accepting. "Nothing out" with nothing in is
        // just a quiet desktop.
        guard let lastEnqueueNs, nowNs <= lastEnqueueNs &+ activeWindowNs else { return false }
        guard let lastOutputNs else { return false }
        let doublings = min(max(0, consecutiveRecoveries), maximumBackoffDoublings)
        let (waitNs, overflow) = graceNs.multipliedReportingOverflow(by: UInt64(1) << doublings)
        return nowNs >= lastOutputNs &+ (overflow ? UInt64.max : waitNs)
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
