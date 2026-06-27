import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollRegionTrackerTests {
    @Test func choosesFrontmostNormalVisibleWindowContainingFocusPoint() throws {
        var tracker = ScrollRegionTracker()
        let provider = StubScrollRegionWindowListProvider(windows: [
            ScrollRegionWindow(
                id: 1,
                ownerProcessID: 200,
                layer: 0,
                bounds: CGRect(x: 20, y: 20, width: 500, height: 400),
                isOnScreen: true,
                alpha: 1
            ),
            ScrollRegionWindow(
                id: 2,
                ownerProcessID: 201,
                layer: 0,
                bounds: CGRect(x: 0, y: 0, width: 900, height: 700),
                isOnScreen: true,
                alpha: 1
            )
        ])

        let candidate = tracker.region(
            focusPoint: CGPoint(x: 120, y: 140),
            surfaceSize: CGSize(width: 1_200, height: 900),
            axis: .vertical,
            windowListProvider: provider
        )
        let region = try #require(candidate)

        #expect(region == ScrollRegion(
            x: 20,
            y: 20,
            width: 500,
            height: 400,
            source: .window(id: 1),
            stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
        ))
    }

    @Test func ignoresSystemTinyHiddenAndOffscreenWindowsBeforeFallingBackToValidContainingWindow() throws {
        var tracker = ScrollRegionTracker()
        let provider = StubScrollRegionWindowListProvider(windows: [
            ScrollRegionWindow(id: 10, ownerProcessID: 12, layer: 1, bounds: CGRect(x: 0, y: 0, width: 900, height: 700), isOnScreen: true, alpha: 1),
            ScrollRegionWindow(id: 11, ownerProcessID: 13, layer: 0, bounds: CGRect(x: 50, y: 50, width: 12, height: 600), isOnScreen: true, alpha: 1),
            ScrollRegionWindow(id: 12, ownerProcessID: 14, layer: 0, bounds: CGRect(x: 0, y: 0, width: 900, height: 700), isOnScreen: false, alpha: 1),
            ScrollRegionWindow(id: 13, ownerProcessID: 15, layer: 0, bounds: CGRect(x: 0, y: 0, width: 900, height: 700), isOnScreen: true, alpha: 0),
            ScrollRegionWindow(id: 14, ownerProcessID: 0, layer: 0, bounds: CGRect(x: 0, y: 0, width: 900, height: 700), isOnScreen: true, alpha: 1),
            ScrollRegionWindow(id: 15, ownerProcessID: 16, layer: 0, bounds: CGRect(x: 40, y: 30, width: 700, height: 500), isOnScreen: true, alpha: 1)
        ])

        let candidate = tracker.region(
            focusPoint: CGPoint(x: 100, y: 100),
            surfaceSize: CGSize(width: 1_000, height: 800),
            axis: .vertical,
            windowListProvider: provider
        )
        let region = try #require(candidate)

        #expect(region.source == .window(id: 15))
        #expect(region.x == 40)
        #expect(region.y == 30)
        #expect(region.width == 700)
        #expect(region.height == 500)
    }

    @Test func clampsWindowRegionToSurfaceBounds() throws {
        var tracker = ScrollRegionTracker()
        let provider = StubScrollRegionWindowListProvider(windows: [
            ScrollRegionWindow(
                id: 20,
                ownerProcessID: 300,
                layer: 0,
                bounds: CGRect(x: -100, y: -50, width: 1_500, height: 1_000),
                isOnScreen: true,
                alpha: 1
            )
        ])

        let candidate = tracker.region(
            focusPoint: CGPoint(x: 20, y: 20),
            surfaceSize: CGSize(width: 1_200, height: 900),
            axis: .vertical,
            windowListProvider: provider
        )
        let region = try #require(candidate)

        #expect(region.x == 0)
        #expect(region.y == 0)
        #expect(region.width == 1_200)
        #expect(region.height == 900)
        #expect(region.source == .window(id: 20))
    }

    @Test func verticalFallbackUsesCursorCenteredMaxRectClampedToSurface() throws {
        var tracker = ScrollRegionTracker()
        let candidate = tracker.region(
            focusPoint: CGPoint(x: 1_900, y: 1_300),
            surfaceSize: CGSize(width: 2_000, height: 1_500),
            axis: .vertical,
            windowListProvider: StubScrollRegionWindowListProvider(windows: [])
        )
        let region = try #require(candidate)

        #expect(region.source == .cursorFallback)
        #expect(region.width == 1_440)
        #expect(region.height == 1_200)
        #expect(region.x == 560)
        #expect(region.y == 300)
    }

    @Test func horizontalFallbackUsesCursorCenteredMaxRectClampedToSurface() throws {
        var tracker = ScrollRegionTracker()
        let candidate = tracker.region(
            focusPoint: CGPoint(x: 120, y: 120),
            surfaceSize: CGSize(width: 2_000, height: 1_500),
            axis: .horizontal,
            windowListProvider: StubScrollRegionWindowListProvider(windows: [])
        )
        let region = try #require(candidate)

        #expect(region.source == .cursorFallback)
        #expect(region.width == 1_600)
        #expect(region.height == 900)
        #expect(region.x == 0)
        #expect(region.y == 0)
    }

    @Test func fallbackShrinksToSmallSurface() throws {
        var tracker = ScrollRegionTracker()
        let candidate = tracker.region(
            focusPoint: CGPoint(x: 200, y: 150),
            surfaceSize: CGSize(width: 800, height: 500),
            axis: .vertical,
            windowListProvider: StubScrollRegionWindowListProvider(windows: [])
        )
        let region = try #require(candidate)

        #expect(region == ScrollRegion(
            x: 0,
            y: 0,
            width: 800,
            height: 500,
            source: .cursorFallback,
            stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
        ))
    }

    @Test func stableWindowRegionIncrementsWhenOverlapStaysHigh() throws {
        var tracker = ScrollRegionTracker(stabilityOverlapThreshold: 0.80)
        let firstProvider = StubScrollRegionWindowListProvider(windows: [
            ScrollRegionWindow(id: 30, ownerProcessID: 400, layer: 0, bounds: CGRect(x: 100, y: 100, width: 600, height: 400), isOnScreen: true, alpha: 1)
        ])
        let secondProvider = StubScrollRegionWindowListProvider(windows: [
            ScrollRegionWindow(id: 30, ownerProcessID: 400, layer: 0, bounds: CGRect(x: 110, y: 100, width: 600, height: 400), isOnScreen: true, alpha: 1)
        ])

        let firstCandidate = tracker.region(
            focusPoint: CGPoint(x: 150, y: 150),
            surfaceSize: CGSize(width: 1_200, height: 900),
            axis: .vertical,
            windowListProvider: firstProvider
        )
        let first = try #require(firstCandidate)
        let secondCandidate = tracker.region(
            focusPoint: CGPoint(x: 150, y: 150),
            surfaceSize: CGSize(width: 1_200, height: 900),
            axis: .vertical,
            windowListProvider: secondProvider
        )
        let second = try #require(secondCandidate)

        #expect(first.stability.stableFrameCount == 1)
        #expect(second.stability.stableFrameCount == 2)
        #expect(abs(second.stability.overlapRatioWithPrevious - 0.9666) < 0.001)
    }

    @Test func stabilityResetsWhenRegionSourceChanges() throws {
        var tracker = ScrollRegionTracker(stabilityOverlapThreshold: 0.80)
        let windowProvider = StubScrollRegionWindowListProvider(windows: [
            ScrollRegionWindow(id: 40, ownerProcessID: 500, layer: 0, bounds: CGRect(x: 100, y: 100, width: 600, height: 400), isOnScreen: true, alpha: 1)
        ])
        let emptyProvider = StubScrollRegionWindowListProvider(windows: [])

        let windowCandidate = tracker.region(
            focusPoint: CGPoint(x: 150, y: 150),
            surfaceSize: CGSize(width: 1_200, height: 900),
            axis: .vertical,
            windowListProvider: windowProvider
        )
        _ = try #require(windowCandidate)
        let fallbackCandidate = tracker.region(
            focusPoint: CGPoint(x: 150, y: 150),
            surfaceSize: CGSize(width: 1_200, height: 900),
            axis: .vertical,
            windowListProvider: emptyProvider
        )
        let fallback = try #require(fallbackCandidate)

        #expect(fallback.source == .cursorFallback)
        #expect(fallback.stability.stableFrameCount == 1)
    }

    @Test func missingCandidateReleasesStableRegion() throws {
        var tracker = ScrollRegionTracker(stabilityOverlapThreshold: 0.80)
        let provider = StubScrollRegionWindowListProvider(windows: [
            ScrollRegionWindow(id: 50, ownerProcessID: 600, layer: 0, bounds: CGRect(x: 100, y: 100, width: 600, height: 400), isOnScreen: true, alpha: 1)
        ])
        let now = DispatchTime.now().uptimeNanoseconds
        tracker.record(
            .scroll(dx: 0, dy: -20, phase: .changed),
            focusPoint: CGPoint(x: 150, y: 150),
            displayBounds: CGRect(x: 0, y: 0, width: 1_200, height: 900),
            nowUptimeNs: now
        )
        let firstHint = try #require(tracker.hint(nowUptimeNs: now))
        let maybeFirstCandidate = tracker.candidate(
            from: firstHint,
            surfaceWidth: 1_200,
            surfaceHeight: 900,
            nowUptimeNs: now,
            windowListProvider: provider
        )
        let firstCandidate = try #require(maybeFirstCandidate)
        #expect(tracker.observeValidation(candidate: firstCandidate, accepted: true) == nil)
        let maybeSecondCandidate = tracker.candidate(
            from: firstHint,
            surfaceWidth: 1_200,
            surfaceHeight: 900,
            nowUptimeNs: now,
            windowListProvider: provider
        )
        let secondCandidate = try #require(maybeSecondCandidate)
        #expect(tracker.observeValidation(candidate: secondCandidate, accepted: true) != nil)
        #expect(tracker.stableRegion != nil)

        let didRelease = tracker.releaseIfMissingCandidate(nil)
        #expect(didRelease)
        #expect(tracker.stableRegion == nil)
        let didReleaseAgain = tracker.releaseIfMissingCandidate(nil)
        #expect(!didReleaseAgain)
    }

    @Test func stableRegionRequiresSameSourceBeforeEmissionAndValidation() throws {
        var tracker = ScrollRegionTracker(stabilityOverlapThreshold: 0.80)
        let windowRegion = ScrollRegion(
            x: 0,
            y: 0,
            width: 1_200,
            height: 900,
            source: .window(id: 60),
            stability: ScrollRegionStability(stableFrameCount: 2, overlapRatioWithPrevious: 1)
        )
        let fallbackRegion = ScrollRegion(
            x: 0,
            y: 0,
            width: 1_200,
            height: 900,
            source: .cursorFallback,
            stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
        )
        let windowCandidate = ScrollRegionCandidate(
            region: windowRegion,
            axis: .vertical,
            sign: -1,
            activeUntilUptimeNs: 1_000,
            eventCount: 1
        )
        let fallbackCandidate = ScrollRegionCandidate(
            region: fallbackRegion,
            axis: .vertical,
            sign: -1,
            activeUntilUptimeNs: 1_000,
            eventCount: 2
        )
        let reversedWindowCandidate = ScrollRegionCandidate(
            region: windowRegion,
            axis: .vertical,
            sign: 1,
            activeUntilUptimeNs: 1_000,
            eventCount: 3
        )
        let horizontalWindowCandidate = ScrollRegionCandidate(
            region: windowRegion,
            axis: .horizontal,
            sign: -1,
            activeUntilUptimeNs: 1_000,
            eventCount: 4
        )

        #expect(tracker.observeValidation(candidate: windowCandidate, accepted: true) == nil)
        #expect(tracker.observeValidation(candidate: windowCandidate, accepted: true) != nil)
        #expect(tracker.isStable(candidate: windowCandidate))
        #expect(!tracker.isStable(candidate: fallbackCandidate))
        #expect(!tracker.isStable(candidate: reversedWindowCandidate))
        #expect(!tracker.isStable(candidate: horizontalWindowCandidate))

        #expect(tracker.observeValidation(candidate: fallbackCandidate, accepted: true) == nil)
        #expect(!tracker.isStable(candidate: fallbackCandidate))
        #expect(tracker.observeValidation(candidate: fallbackCandidate, accepted: true) != nil)
        #expect(tracker.isStable(candidate: fallbackCandidate))
    }
}

private struct StubScrollRegionWindowListProvider: ScrollRegionWindowListProvider {
    let windows: [ScrollRegionWindow]

    func scrollRegionWindows() -> [ScrollRegionWindow] {
        windows
    }
}
