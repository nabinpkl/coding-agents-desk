import Testing
import Foundation
@testable import AgentDeskClient

// R230. The detector for the failure every other counter in the client is structurally unable to
// see: frames accepted, nothing on the glass.
//
// Measured on a device and confirmed by the operator: after a network handover the phone showed
// black for minutes while the client reported 23-26fps with `renderStallCount=0`,
// `decodeDropCount=0` and `droppedFrames=0`. Every rendering signal we had is taken at the
// ENQUEUE end -- `fps` counts frames handed to the display layer, the stall watchdog watches the
// enqueue cadence -- so a wedged layer and a working one printed identically. Two transport
// rebuilds left it black. Only a force quit cleared it.
//
// The rule these tests pin is narrow on purpose. Nothing on the glass is only a fault while the
// host is sending and we are accepting; otherwise it is a quiet desktop, and answering that with
// the most expensive frame in the system would be a keyframe storm on the link least able to
// carry one.
struct OwnedMediaDisplayOutputWatchdogTests {
    private static let graceNs: UInt64 = 2_000_000_000
    private static let watchdog = OwnedMediaDisplayOutputWatchdog.configured(stallNs: graceNs)

    private static func shouldRecover(
        hasDisplayedFrame: Bool = false,
        enqueueAgoNs: UInt64? = 0,
        outputAgoNs: UInt64? = graceNs,
        consecutiveRecoveries: Int = 0
    ) -> Bool {
        // A large now, so "ago" offsets never underflow the way a zero clock would.
        let now = graceNs * 100
        return watchdog.shouldRecover(
            hasDisplayedFrame: hasDisplayedFrame,
            lastEnqueueNs: enqueueAgoNs.map { now - $0 },
            lastOutputNs: outputAgoNs.map { now - $0 },
            consecutiveRecoveries: consecutiveRecoveries,
            nowNs: now
        )
    }

    @Test func framesInAndNothingOutPastTheGraceIsAWedge() {
        #expect(Self.shouldRecover())
    }

    // The signal that ends the whole question. Whatever else may be wrong, a picture on screen
    // is not this failure, and this watchdog must not have an opinion about it.
    @Test func aDisplayedFrameIsNeverAWedge() {
        #expect(!Self.shouldRecover(hasDisplayedFrame: true, outputAgoNs: nil))
    }

    // A resting desktop displays nothing new for minutes at a time and is perfectly healthy.
    // Without this guard the client would answer an idle host by demanding keyframes from it.
    @Test func aQuietHostIsNotAWedge() {
        #expect(!Self.shouldRecover(enqueueAgoNs: Self.graceNs * 2))
    }

    @Test func aHostThatNeverSentAnythingIsNotAWedge() {
        #expect(!Self.shouldRecover(enqueueAgoNs: nil))
    }

    // The ordinary moment between accepting a session's first frame and that frame reaching the
    // glass. Declaring a wedge here would make every session start with a forced keyframe.
    @Test func theMomentBeforeTheFirstFrameLandsIsNotAWedge() {
        #expect(!Self.shouldRecover(outputAgoNs: Self.graceNs / 2))
    }

    // Before anything has been enqueued there is no origin to measure from, so there is nothing
    // to conclude. The sink seeds this from the first enqueue precisely so the window opens.
    @Test func withNoOriginThereIsNothingToMeasure() {
        #expect(!Self.shouldRecover(outputAgoNs: nil))
    }

    // Recovery costs a true keyframe. A wedge our cheapest remedy cannot fix must not be
    // re-fought every two seconds for the life of the session.
    @Test func eachFailedRecoveryBuysTheNextOneMoreTime() {
        #expect(Self.shouldRecover(outputAgoNs: Self.graceNs, consecutiveRecoveries: 0))
        #expect(!Self.shouldRecover(outputAgoNs: Self.graceNs, consecutiveRecoveries: 1))
        #expect(Self.shouldRecover(outputAgoNs: Self.graceNs * 2, consecutiveRecoveries: 1))
        #expect(!Self.shouldRecover(outputAgoNs: Self.graceNs * 2, consecutiveRecoveries: 2))
        #expect(Self.shouldRecover(outputAgoNs: Self.graceNs * 4, consecutiveRecoveries: 2))
    }

    // The backoff is bounded, so a long-wedged session keeps retrying at a fixed slow cadence
    // rather than walking out to an interval nothing could ever reach.
    @Test func theBackoffStopsDoubling() {
        let capped = Self.graceNs * 16
        #expect(Self.shouldRecover(outputAgoNs: capped, consecutiveRecoveries: 4))
        #expect(Self.shouldRecover(outputAgoNs: capped, consecutiveRecoveries: 40))
    }
}
