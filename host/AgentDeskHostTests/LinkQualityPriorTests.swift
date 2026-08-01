import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

/// The client has always reported `linkQuality`, and the host has always thrown it away.
///
/// So the ladder opened at `.native` on every link and learned a weak one by failing on it.
/// Measured on a `linkQuality=minimal` cellular path, that cost several seconds of full-rate
/// video the link could not carry before the ladder caught up.
///
/// What is pinned here is that the prior stays a prior: it only opens the session, it never
/// outranks a measurement or a resume, and it gets exactly one chance.
struct LinkQualityPriorTests {

    // MARK: - The mapping

    @Test func aMinimalLinkOpensBelowAModerateOne() {
        let minimal = MediaQualityController.startingRung(forLinkQuality: "minimal")
        let moderate = MediaQualityController.startingRung(forLinkQuality: "moderate")
        #expect(minimal == .capacity2)
        #expect(moderate == .capacity1)
        // The ordering is the point. If these ever collapse to the same rung the label has
        // stopped carrying information.
        #expect(minimal! > moderate!)
    }

    // An absent or optimistic reading is not evidence of a weak link, and the ceiling is
    // already the right guess without evidence.
    @Test func anUnknownOrGoodLinkGetsNoOpinion() {
        #expect(MediaQualityController.startingRung(forLinkQuality: "good") == nil)
        #expect(MediaQualityController.startingRung(forLinkQuality: "unknown") == nil)
        #expect(MediaQualityController.startingRung(forLinkQuality: nil) == nil)
        // A label the client starts sending that this host has never heard of must read as
        // "no opinion" rather than crashing or silently mapping to a floor.
        #expect(MediaQualityController.startingRung(forLinkQuality: "excellent") == nil)
    }

    // MARK: - Adoption

    @Test func aMinimalLinkOpensTheLadderBelowTheCeiling() {
        var controller = MediaQualityController(config: .fromConfig())
        #expect(controller.target.rung == .native)

        let displaced = controller.adoptLinkQualityPrior("minimal")

        #expect(controller.target.rung == .capacity2)
        #expect(controller.target.fps < displaced!.fps)
        #expect(controller.target.bitrateKbps < displaced!.bitrateKbps)
        #expect(controller.target.resolutionScale < displaced!.resolutionScale)
    }

    // The displaced target is what makes the drop visible. The prior moves the rung before the
    // window is judged, so without it that window compares the new rung against itself, reports
    // no change, and the encoder is never told -- the ladder would claim to have dropped while
    // full-rate frames kept going out.
    @Test func adoptionReportsWhatItDisplaced() {
        var controller = MediaQualityController(config: .fromConfig())
        let ceiling = controller.target

        let displaced = controller.adoptLinkQualityPrior("minimal")

        #expect(displaced == ceiling)
        #expect(displaced != controller.target)
    }

    @Test func aGoodLinkLeavesTheLadderAtTheCeiling() {
        var controller = MediaQualityController(config: .fromConfig())
        let ceiling = controller.target

        #expect(controller.adoptLinkQualityPrior("good") == nil)
        #expect(controller.target == ceiling)
    }

    // MARK: - Staying a prior

    // One chance, whether or not it acted. Otherwise a client reporting `good` first and
    // `minimal` later would reset a ladder that measurement is by then driving.
    @Test func aLaterReportCannotResetTheLadder() {
        var controller = MediaQualityController(config: .fromConfig())
        #expect(controller.adoptLinkQualityPrior("good") == nil)

        #expect(controller.adoptLinkQualityPrior("minimal") == nil)
        #expect(controller.target.rung == .native)
    }

    @Test func adoptionIsIdempotent() {
        var controller = MediaQualityController(config: .fromConfig())
        #expect(controller.adoptLinkQualityPrior("minimal") != nil)
        let afterFirst = controller.target

        #expect(controller.adoptLinkQualityPrior("minimal") == nil)
        #expect(controller.target == afterFirst)
    }

    // ADR-0090 hands back the rung the previous connection ended on. That is a rung this link
    // actually sustained seconds ago, which beats an inference from a coarse label.
    @Test func aResumedRungOutranksTheLabel() {
        var controller = MediaQualityController(config: .fromConfig())
        let resumed = MediaQualityTarget(
            bitrateKbps: 900,
            fps: 24,
            resolutionScale: 0.75,
            rung: .capacity1,
            reason: "resume"
        )
        controller.pin(to: resumed)

        #expect(controller.adoptLinkQualityPrior("minimal") == nil)
        #expect(controller.target == resumed)
    }
}
