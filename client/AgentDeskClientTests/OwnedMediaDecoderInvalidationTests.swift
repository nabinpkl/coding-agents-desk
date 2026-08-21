import Testing
import Foundation
@testable import AgentDeskClient

// What the client does when the decoder is taken away from it rather than failing.
//
// R230, and the case the existing recovery paths were all blind to. Backgrounding the app makes
// iOS reclaim the hardware video decoder; `AVSampleBufferDisplayLayer` hands one back only
// through `flush()`, which empties the decoded-picture buffer, so the first frame afterwards
// must be a keyframe no matter how healthy everything else is. Nothing reports this as a
// failure: the enqueue succeeds, the fps counter climbs, the renderer says `rendering`, and the
// screen stays black until the app is force quit.
//
// The one thing the host cannot work out for itself is that its acknowledged long-term
// references are dead, because an acknowledgement is permanent once made. So the request has to
// carry `clientHasNoReferences`, or the resync comes back as a delta against a reference that no
// longer exists and the loop repeats.
@MainActor
struct OwnedMediaDecoderInvalidationTests {
    private final class Requests: @unchecked Sendable {
        var hasReferences: [Bool] = []
        var reasons: [String] = []
    }

    private static func install(on sink: OwnedMediaVideoSink) -> Requests {
        let requests = Requests()
        sink.setVideoKeyframeRequestHandler { hasReferences, reason in
            requests.hasReferences.append(hasReferences)
            requests.reasons.append(reason)
        }
        return requests
    }

    private static let windowNs = UInt64(Config.ownedMediaRenderStallMs) * 1_000_000

    @Test func aLostDecoderAsksTheHostForAKeyframe() {
        let sink = OwnedMediaVideoSink()
        let requests = Self.install(on: sink)
        sink.noteDecoderInvalidated(reason: "foreground-resume", now: Self.windowNs)
        #expect(requests.reasons == ["foreground-resume"])
    }

    // The half that makes the request useful. A plain resync is answered with a long-term
    // reference delta (ADR-0090), which is exactly what a flushed decoder cannot decode.
    @Test func theRequestSaysEveryReferenceIsGone() {
        let sink = OwnedMediaVideoSink()
        let requests = Self.install(on: sink)
        sink.noteDecoderInvalidated(reason: "foreground-resume", now: Self.windowNs)
        #expect(requests.hasReferences == [false])
    }

    // The ordering that actually happens on a phone: background tears the transport down, so
    // when the foreground discovers the decoder is gone there is no handler to send through.
    // The re-dial installs one seconds later. Firing and hoping would write the request to a
    // nil closure and the client would come back black with nothing on the wire to explain it.
    @Test func aResyncArmedWithNoTransportIsSentWhenOneAttaches() {
        let sink = OwnedMediaVideoSink()
        sink.noteDecoderInvalidated(reason: "foreground-resume", now: Self.windowNs)
        let requests = Self.install(on: sink)
        #expect(requests.hasReferences == [false])
        #expect(requests.reasons == ["foreground-resume"])
    }

    // An arm that outlived the transport it was sent on would re-ask at every later carrier
    // swap, and each one costs the most expensive frame the encoder can produce.
    @Test func theArmedResyncIsSentOnceNotAtEveryLaterAttach() {
        let sink = OwnedMediaVideoSink()
        sink.noteDecoderInvalidated(reason: "foreground-resume", now: Self.windowNs)
        _ = Self.install(on: sink)
        let second = Self.install(on: sink)
        #expect(second.hasReferences.isEmpty)
    }

    // Two reports for one event are normal: the renderer's own notification fires, and so does
    // the foreground. The second coalescing into the first is correct -- an identical flagged
    // request went out moments ago and the host already has it.
    @Test func twoReportsOfOneInvalidationCostOneKeyframe() {
        let sink = OwnedMediaVideoSink()
        let requests = Self.install(on: sink)
        sink.noteDecoderInvalidated(reason: "requires-flush", now: Self.windowNs)
        sink.noteDecoderInvalidated(reason: "foreground-resume", now: Self.windowNs + 1_000_000)
        #expect(requests.hasReferences.count == 1)
    }

    // A later, genuinely separate invalidation must still get through. The rate limiter is
    // meant to coalesce a burst, not to make the client silent for the rest of the session.
    @Test func aLaterInvalidationAsksAgain() {
        let sink = OwnedMediaVideoSink()
        let requests = Self.install(on: sink)
        sink.noteDecoderInvalidated(reason: "requires-flush", now: Self.windowNs)
        sink.noteDecoderInvalidated(reason: "foreground-resume", now: Self.windowNs * 4)
        #expect(requests.hasReferences == [false, false])
    }
}
