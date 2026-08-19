import Testing
@testable import AgentDeskWire

struct MediaResolutionLadderTests {
    @Test func theTopRungIsTheCaptureItselfOnEveryDisplay() {
        let retina = MediaResolutionLadder.stops(nativeWidth: 3600, nativeHeight: 2338)
        let external = MediaResolutionLadder.stops(nativeWidth: 1920, nativeHeight: 1080)

        #expect(retina.last?.width == 3600)
        #expect(retina.last?.height == 2338)
        #expect(retina.last?.resolutionScale == 1.0)
        #expect(retina.last?.isNative == true)

        #expect(external.last?.width == 1920)
        #expect(external.last?.height == 1080)
        #expect(external.last?.resolutionScale == 1.0)
    }

    @Test func rungsStopAtTheDisplaysOwnHeight() {
        let external = MediaResolutionLadder.stops(nativeWidth: 1920, nativeHeight: 1080)

        // 1080 is native here, so it arrives as the top rung rather than as a candidate, and
        // nothing above it is offered: the ladder never asks for pixels the display never drew.
        #expect(external.map(\.nominalHeight) == [360, 480, 540, 720, 900, 1080])
        #expect(external.filter(\.isNative).count == 1)
    }

    @Test func everyRungKeepsTheDisplaysAspectRatio() {
        for (w, h) in [(3600, 2338), (1920, 1080), (2560, 1600)] {
            let native = Double(w) / Double(h)
            for stop in MediaResolutionLadder.stops(nativeWidth: w, nativeHeight: h) {
                let ratio = Double(stop.width) / Double(stop.height)
                // Evening each axis can move the ratio by under a pixel's worth; anything
                // larger would mean the picture is being stretched or cropped.
                #expect(abs(ratio - native) < 0.01, "\(stop.width)x\(stop.height) drifted from \(native)")
            }
        }
    }

    @Test func aStoredHeightClampsToNativeRatherThanResetting() {
        // Chosen on the Retina panel, then carried to a 1080p external that cannot reach it.
        let stop = MediaResolutionLadder.stop(forStoredHeight: 1440, nativeWidth: 1920, nativeHeight: 1080)

        #expect(stop?.height == 1080)
        #expect(stop?.resolutionScale == 1.0)
        #expect(stop?.isNative == true)
    }

    @Test func aStoredHeightTheDisplayCanReachIsHonouredExactly() {
        let stop = MediaResolutionLadder.stop(forStoredHeight: 720, nativeWidth: 3600, nativeHeight: 2338)

        #expect(stop?.nominalHeight == 720)
        #expect(stop?.height == 720)
        #expect(stop?.width == 1108)
        #expect(stop?.resolutionScale == 720.0 / 2338.0)
    }

    @Test func noStoredHeightMeansTheFullCapture() {
        let stop = MediaResolutionLadder.stop(forStoredHeight: nil, nativeWidth: 3600, nativeHeight: 2338)

        #expect(stop?.resolutionScale == 1.0)
        #expect(stop?.isNative == true)
    }

    @Test func aDisplaySmallerThanTheFloorStillOffersItsOwnSize() {
        // Nothing on the candidate list fits under 320 lines, but "full" always exists, and a
        // slider with zero rungs could not express the one setting that is always available.
        let stops = MediaResolutionLadder.stops(nativeWidth: 480, nativeHeight: 320)

        #expect(stops.count == 1)
        #expect(stops.first?.isNative == true)
        #expect(stops.first?.height == 320)
    }

    @Test func aDisplayWithNoSizeHasNoLadder() {
        #expect(MediaResolutionLadder.stops(nativeWidth: 0, nativeHeight: 0).isEmpty)
        #expect(MediaResolutionLadder.stop(forStoredHeight: 720, nativeWidth: 0, nativeHeight: 0) == nil)
    }

    @Test func everyRungIsEvenSoTheEncoderNeverRoundsBehindTheLabel() {
        for stop in MediaResolutionLadder.stops(nativeWidth: 3600, nativeHeight: 2338) {
            #expect(stop.width.isMultiple(of: 2))
            #expect(stop.height.isMultiple(of: 2))
        }
    }
}
