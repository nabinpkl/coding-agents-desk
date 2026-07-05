import CoreGraphics
import Foundation
import Testing
import AgentDeskWire

struct EdgeFollowTests {
    // The point-spaced "rough Retina MBP" display used throughout. 1.54
    // aspect, similar to the user's actual workstation.
    private static let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    // Sink view sized like the iPhone's video band: ~393 points wide
    // by ~219 points tall. Aspect 1.79 means the sink is wider than the
    // display, so the video is pillarboxed (padX > 0, padY = 0 when
    // height-constrained; let aspect-fit do its thing).
    private static let sink = CGSize(width: 393, height: 219)

    @Test func cursorInSafeBandLeavesOffsetUnchanged() {
        let currentOffset = CGPoint(x: 50, y: 30)
        // Display centre maps to roughly sink centre at zoom 2; well
        // inside the safe band relative to currentOffset.
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.midX, y: Self.display.midY),
            displayBounds: Self.display,
            sinkViewSize: Self.sink,
            zoomScale: 2.0,
            currentOffset: currentOffset
        )
        // Centre cursor at zoom 2 should leave the centred view alone.
        let centredOffset = CGPoint(
            x: Self.sink.width * 2 / 2 - Self.sink.width / 2,
            y: Self.sink.height * 2 / 2 - Self.sink.height / 2
        )
        let nextSafe = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.midX, y: Self.display.midY),
            displayBounds: Self.display,
            sinkViewSize: Self.sink,
            zoomScale: 2.0,
            currentOffset: centredOffset
        )
        #expect(nextSafe == centredOffset)
        _ = next
    }

    @Test func cursorAtRightEdgePullsOffsetForward() {
        // Cursor at the source display's right edge, zoom 2x, current
        // offset at left. The viewport must shift right so the cursor
        // lands at the right-margin boundary. The pillarbox padding to
        // the right of the video means the cursor at display.maxX does
        // not land at the absolute right of the content; it lands at
        // (padX + display.width * fitScale) * zoom.
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.maxX, y: Self.display.midY),
            displayBounds: Self.display,
            sinkViewSize: Self.sink,
            zoomScale: 2.0,
            currentOffset: .zero
        )
        let fitScale = min(Self.sink.width / Self.display.width, Self.sink.height / Self.display.height)
        let padX = (Self.sink.width - Self.display.width * fitScale) / 2
        let cursorContentX = (padX + Self.display.width * fitScale) * 2.0
        let marginX = Self.sink.width * 0.12
        let expected = cursorContentX - (Self.sink.width - marginX)
        #expect(abs(next.x - expected) < 0.5)
    }

    @Test func cursorAtLeftEdgePullsOffsetBack() {
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: 0, y: Self.display.midY),
            displayBounds: Self.display,
            sinkViewSize: Self.sink,
            zoomScale: 2.0,
            currentOffset: CGPoint(x: 200, y: 0)
        )
        let fitScale = min(Self.sink.width / Self.display.width, Self.sink.height / Self.display.height)
        let padX = (Self.sink.width - Self.display.width * fitScale) / 2
        let cursorContentX = padX * 2.0
        let marginX = Self.sink.width * 0.12
        let expected = cursorContentX - marginX
        // expected may be negative (pillarbox padding less than margin);
        // clamped to 0 by the helper.
        #expect(abs(next.x - max(0, expected)) < 0.5)
    }

    @Test func cursorBeyondTopPullsOffsetBackToZero() {
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.midX, y: 0),
            displayBounds: Self.display,
            sinkViewSize: Self.sink,
            zoomScale: 2.0,
            currentOffset: CGPoint(x: 100, y: 100)
        )
        #expect(next.y == 0)
    }

    @Test func cursorAtBottomEdgePullsOffsetForward() {
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.midX, y: Self.display.maxY),
            displayBounds: Self.display,
            sinkViewSize: Self.sink,
            zoomScale: 2.0,
            currentOffset: .zero
        )
        let maxOffsetY = Self.sink.height * 2 - Self.sink.height
        #expect(next.y == maxOffsetY)
    }

    @Test func zoomOneClampsOffsetToZero() {
        // At zoom 1 contentSize == sinkSize so no panning possible.
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.maxX, y: Self.display.maxY),
            displayBounds: Self.display,
            sinkViewSize: Self.sink,
            zoomScale: 1.0,
            currentOffset: .zero
        )
        #expect(next == .zero)
    }

    @Test func degenerateDisplayReturnsCurrentOffset() {
        let next = EdgeFollow.contentOffset(
            forCursor: .zero,
            displayBounds: .zero,
            sinkViewSize: Self.sink,
            zoomScale: 2.0,
            currentOffset: CGPoint(x: 50, y: 50)
        )
        #expect(next == CGPoint(x: 50, y: 50))
    }

    // MARK: - advanceCursor

    @Test func advanceCursorIntegratesDeltaAndClamps() {
        let next = EdgeFollow.advanceCursor(
            from: CGPoint(x: 100, y: 100),
            delta: CGPoint(x: 50, y: -30),
            displayBounds: Self.display
        )
        #expect(next == CGPoint(x: 150, y: 70))
    }

    @Test func advanceCursorClampsToDisplayRightEdge() {
        let next = EdgeFollow.advanceCursor(
            from: CGPoint(x: 1500, y: 500),
            delta: CGPoint(x: 100, y: 0),
            displayBounds: Self.display
        )
        #expect(next.x == Self.display.width - 1)
        #expect(next.y == 500)
    }

    @Test func advanceCursorClampsToDisplayTopLeft() {
        let next = EdgeFollow.advanceCursor(
            from: CGPoint(x: 10, y: 10),
            delta: CGPoint(x: -100, y: -100),
            displayBounds: Self.display
        )
        #expect(next == .zero)
    }

    @Test func viewportCenterRetargetProjectsThroughZoomAndPadding() {
        let state = DesktopState(
            displays: [
                DisplayMetadata(
                    id: "display-a",
                    originX: 100,
                    originY: 200,
                    widthPoints: 2000,
                    heightPoints: 1000
                )
            ],
            spaces: [],
            activeDisplayId: "display-a",
            selectedDisplayId: "display-a",
            activeSpaceId: nil,
            cursorX: nil,
            cursorY: nil
        )

        let retarget = PointerRetargeting.viewportCenterRetarget(
            state: state,
            displayId: "display-a",
            displayBounds: CGRect(x: 0, y: 0, width: 2000, height: 1000),
            sinkViewSize: CGSize(width: 500, height: 500),
            zoomScale: 2,
            contentOffset: CGPoint(x: 250, y: 250)
        )

        #expect(retarget?.displayId == "display-a")
        #expect(retarget?.sourcePoint == CGPoint(x: 1000, y: 500))
        #expect(retarget?.hostPoint == CGPoint(x: 1100, y: 700))
    }

    @Test func viewportCenterRetargetClampsOutsideVideoPadding() {
        let state = DesktopState(
            displays: [
                DisplayMetadata(
                    id: "display-a",
                    originX: 100,
                    originY: 200,
                    widthPoints: 2000,
                    heightPoints: 1000
                )
            ],
            spaces: [],
            activeDisplayId: "display-a",
            selectedDisplayId: "display-a",
            activeSpaceId: nil,
            cursorX: nil,
            cursorY: nil
        )

        let retarget = PointerRetargeting.viewportCenterRetarget(
            state: state,
            displayId: "display-a",
            displayBounds: CGRect(x: 0, y: 0, width: 2000, height: 1000),
            sinkViewSize: CGSize(width: 500, height: 500),
            zoomScale: 2,
            contentOffset: CGPoint(x: 0, y: 0)
        )

        #expect(retarget?.sourcePoint == CGPoint(x: 500, y: 0))
        #expect(retarget?.hostPoint == CGPoint(x: 600, y: 200))
    }

    // MARK: - hostPoint(forContentViewLocation:) — touch-scroll inverse map
    //
    // `loc` is the touch in the content view's own (pre-transform) coordinate
    // space, so the map needs no zoom/offset — those are already inverted by
    // UIKit hit-testing. Geometry: display 2000x1000 origin (100,200), content
    // view 500x500 -> fitScale 0.25, padX 0, padY 125.

    private static func touchScrollState() -> DesktopState {
        DesktopState(
            displays: [
                DisplayMetadata(
                    id: "display-a",
                    originX: 100,
                    originY: 200,
                    widthPoints: 2000,
                    heightPoints: 1000
                )
            ],
            spaces: [],
            activeDisplayId: "display-a",
            selectedDisplayId: "display-a",
            activeSpaceId: nil,
            cursorX: nil,
            cursorY: nil
        )
    }

    @Test func hostPointCenterTouchMapsToDisplayCenter() {
        let retarget = PointerRetargeting.hostPoint(
            forContentViewLocation: CGPoint(x: 250, y: 250),
            state: Self.touchScrollState(),
            displayId: "display-a",
            displayBounds: CGRect(x: 0, y: 0, width: 2000, height: 1000),
            contentViewSize: CGSize(width: 500, height: 500)
        )
        #expect(retarget?.sourcePoint == CGPoint(x: 1000, y: 500))
        #expect(retarget?.hostPoint == CGPoint(x: 1100, y: 700))
    }

    @Test func hostPointTopLeftOfVideoMapsToDisplayOrigin() {
        // The video's top-left corner sits at content (0, padY=125) and must
        // map to the display origin.
        let retarget = PointerRetargeting.hostPoint(
            forContentViewLocation: CGPoint(x: 0, y: 125),
            state: Self.touchScrollState(),
            displayId: "display-a",
            displayBounds: CGRect(x: 0, y: 0, width: 2000, height: 1000),
            contentViewSize: CGSize(width: 500, height: 500)
        )
        #expect(retarget?.sourcePoint == .zero)
        #expect(retarget?.hostPoint == CGPoint(x: 100, y: 200))
    }

    @Test func hostPointBeyondVideoClampsToDisplayBounds() {
        // A touch past the bottom-right of the video content clamps to the
        // display's far edge (width-1, height-1). This is the exact class of
        // input that, mis-transformed, produced the "jumps to the bottom" bug.
        let retarget = PointerRetargeting.hostPoint(
            forContentViewLocation: CGPoint(x: 500, y: 375),
            state: Self.touchScrollState(),
            displayId: "display-a",
            displayBounds: CGRect(x: 0, y: 0, width: 2000, height: 1000),
            contentViewSize: CGSize(width: 500, height: 500)
        )
        #expect(retarget?.sourcePoint == CGPoint(x: 1999, y: 999))
        #expect(retarget?.hostPoint == CGPoint(x: 2099, y: 1199))
    }

    @Test func hostPointReturnsNilWithoutStateOrBounds() {
        #expect(PointerRetargeting.hostPoint(
            forContentViewLocation: CGPoint(x: 10, y: 10),
            state: nil,
            displayId: "display-a",
            displayBounds: CGRect(x: 0, y: 0, width: 2000, height: 1000),
            contentViewSize: CGSize(width: 500, height: 500)
        ) == nil)

        #expect(PointerRetargeting.hostPoint(
            forContentViewLocation: CGPoint(x: 10, y: 10),
            state: Self.touchScrollState(),
            displayId: "display-a",
            displayBounds: .zero,
            contentViewSize: CGSize(width: 500, height: 500)
        ) == nil)
    }

    @Test func retargetInputConsumesOnlyPointerLocationDependentInputs() {
        var pending: CursorViewportRetarget? = CursorViewportRetarget(
            displayId: "display-a",
            sourcePoint: CGPoint(x: 100, y: 200),
            hostPoint: CGPoint(x: 300, y: 400)
        )

        #expect(PointerRetargeting.retargetInput(
            pending: &pending,
            before: .key(code: "ansi-A", modifiers: [])
        ) == nil)
        #expect(pending != nil)

        let retarget = PointerRetargeting.retargetInput(
            pending: &pending,
            before: .cursorMove(dx: 1, dy: 2)
        )

        #expect(retarget?.displayId == "display-a")
        #expect(pending == nil)
    }
}
