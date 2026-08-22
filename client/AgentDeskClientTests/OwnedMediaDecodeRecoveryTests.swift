import Testing
import Foundation
@testable import AgentDeskClient

// What the client does when its decoder says it cannot decode.
//
// Measured on 2026-08-14, and the reason this exists: the client decoded 2,109 frames, then
// failed on every frame for the next twenty-two seconds. The host saw nothing wrong -- its
// long-term reference acknowledgements are frame RECEIPT acknowledgements, so it read the
// client as holding a reference it could no longer use and kept encoding deltas against it.
// The stream came back only because a rung change happened to alter the resolution, which is
// the one thing left that still forces a true keyframe. Everything needed to recover properly
// was already built and wired end to end; the decoder's own report was the one signal that
// went nowhere.
@MainActor
struct OwnedMediaDecodeRecoveryTests {
    private final class Requests: @unchecked Sendable {
        var hasReferences: [Bool] = []
        var reasons: [String] = []
    }

    private static func sinkAndRequests() -> (OwnedMediaVideoSink, Requests) {
        let sink = OwnedMediaVideoSink()
        let requests = Requests()
        sink.setVideoKeyframeRequestHandler { hasReferences, reason in
            requests.hasReferences.append(hasReferences)
            requests.reasons.append(reason)
            return true
        }
        return (sink, requests)
    }

    private static let windowNs = UInt64(Config.ownedMediaRenderStallMs) * 1_000_000

    @Test func aFailedDecodeAsksTheHostForAKeyframe() {
        let (sink, requests) = Self.sinkAndRequests()
        sink.noteDecodeFailure(detail: "Cannot Decode", now: Self.windowNs)
        #expect(requests.hasReferences.count == 1)
    }

    // The part that makes the request useful. Without it the host answers the resync with a
    // delta against a reference this decoder no longer holds, which fails identically and asks
    // again -- the resync loop the wire field's own documentation warns about.
    @Test func theRequestSaysEveryReferenceIsGone() {
        let (sink, requests) = Self.sinkAndRequests()
        sink.noteDecodeFailure(detail: "Cannot Decode", now: Self.windowNs)
        #expect(requests.hasReferences == [false])
    }

    // A broken reference chain fails every frame that follows it, so the failures arrive as a
    // burst at the frame rate. One keyframe fixes all of them; asking per failure would answer
    // a slow link by flooding it with the most expensive frame there is.
    @Test func aBurstOfFailuresCostsOneKeyframe() {
        let (sink, requests) = Self.sinkAndRequests()
        let start = Self.windowNs
        for step in 0..<20 {
            sink.noteDecodeFailure(detail: "Cannot Decode", now: start + UInt64(step) * 1_000_000)
        }
        #expect(requests.hasReferences.count == 1)
    }

    // But it must be able to ask again. If the first keyframe is lost in flight, a request
    // that never repeats leaves the picture frozen exactly as it was before this existed.
    @Test func aFailureAfterTheWindowAsksAgain() {
        let (sink, requests) = Self.sinkAndRequests()
        let start = Self.windowNs
        sink.noteDecodeFailure(detail: "Cannot Decode", now: start)
        sink.noteDecodeFailure(detail: "Cannot Decode", now: start + Self.windowNs + 1)
        #expect(requests.hasReferences == [false, false])
    }
}
