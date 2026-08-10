import CoreGraphics
import Foundation
import Testing
import AgentDeskWire

struct EdgeFollowTests {
    // The point-spaced "rough Retina MBP" display used throughout. 1.54
    // aspect, similar to the user's actual workstation.
    private static let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
    // The scroll view's window, sized like the iPhone's video band: ~393 points wide by ~219
    // tall. Its 1.79 aspect is wider than the display's 1.54, so the picture cannot fill it
    // horizontally and the scroll view pillarboxes it with a centring inset.
    private static let viewport = CGSize(width: 393, height: 219)
    // The scrollable content, which is the picture and nothing else: the display fitted into
    // the window, exactly as the sink view's constraints size it.
    private static let video: CGSize = {
        let fit = min(viewport.width / display.width, viewport.height / display.height)
        return CGSize(width: display.width * fit, height: display.height * fit)
    }()
    private static let insetX = (viewport.width - video.width) / 2

    @Test func cursorInSafeBandLeavesOffsetUnchanged() {
        // Centre cursor at zoom 2 should leave the centred view alone.
        let centredOffset = CGPoint(
            x: Self.video.width * 2 / 2 - Self.viewport.width / 2,
            y: Self.video.height * 2 / 2 - Self.viewport.height / 2
        )
        let nextSafe = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.midX, y: Self.display.midY),
            displayBounds: Self.display,
            videoSize: Self.video,
            viewportSize: Self.viewport,
            zoomScale: 2.0,
            currentOffset: centredOffset
        )
        #expect(nextSafe == centredOffset)
    }

    @Test func cursorAtRightEdgePullsOffsetForward() {
        // Cursor at the source display's right edge, zoom 2x, current offset at left. The
        // window must shift right to bring the cursor back inside the margin; the display's
        // right edge is the content's right edge now that there is no padding beyond it, so
        // that pull runs out of content and lands at the scrollable maximum.
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.maxX, y: Self.display.midY),
            displayBounds: Self.display,
            videoSize: Self.video,
            viewportSize: Self.viewport,
            zoomScale: 2.0,
            currentOffset: .zero
        )
        let range = EdgeFollow.offsetRange(
            contentExtent: Self.video.width * 2, viewportExtent: Self.viewport.width
        )
        #expect(abs(next.x - range.max) < 0.5)
        #expect(range.max > 0)
    }

    @Test func cursorAtLeftEdgePullsOffsetBack() {
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: 0, y: Self.display.midY),
            displayBounds: Self.display,
            videoSize: Self.video,
            viewportSize: Self.viewport,
            zoomScale: 2.0,
            currentOffset: CGPoint(x: 200, y: 0)
        )
        // The display's left edge is the content's left edge, so pulling the margin past it
        // clamps to the start of the scrollable range.
        let range = EdgeFollow.offsetRange(
            contentExtent: Self.video.width * 2, viewportExtent: Self.viewport.width
        )
        #expect(abs(next.x - range.min) < 0.5)
    }

    @Test func cursorBeyondTopPullsOffsetBackToZero() {
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.midX, y: 0),
            displayBounds: Self.display,
            videoSize: Self.video,
            viewportSize: Self.viewport,
            zoomScale: 2.0,
            currentOffset: CGPoint(x: 100, y: 100)
        )
        #expect(next.y == 0)
    }

    @Test func cursorAtBottomEdgePullsOffsetForward() {
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.midX, y: Self.display.maxY),
            displayBounds: Self.display,
            videoSize: Self.video,
            viewportSize: Self.viewport,
            zoomScale: 2.0,
            currentOffset: .zero
        )
        #expect(next.y == Self.video.height * 2 - Self.viewport.height)
    }

    // The picture is narrower than the window here, so at zoom 1 it is centred rather than
    // parked at the origin, and the resting offset is the negative of that inset. Vertically
    // it already fills the window, so that axis rests at zero.
    @Test func zoomOneRestsAtTheCentringOffset() {
        let next = EdgeFollow.contentOffset(
            forCursor: CGPoint(x: Self.display.maxX, y: Self.display.maxY),
            displayBounds: Self.display,
            videoSize: Self.video,
            viewportSize: Self.viewport,
            zoomScale: 1.0,
            currentOffset: .zero
        )
        #expect(abs(next.x - -Self.insetX) < 0.001)
        #expect(next.y == 0)
    }

    // The whole point of the change: zooming has to consume the empty band rather than
    // magnify it, so the inset shrinks as the picture grows and is gone once it fills.
    @Test func zoomingConsumesTheCentringInsetInsteadOfScalingIt() {
        let atRest = EdgeFollow.offsetRange(
            contentExtent: Self.video.width, viewportExtent: Self.viewport.width
        )
        let zoomed = EdgeFollow.offsetRange(
            contentExtent: Self.video.width * 1.1, viewportExtent: Self.viewport.width
        )
        // Both ends move toward zero: less empty band to centre in.
        #expect(zoomed.min > atRest.min)
        #expect(atRest.min == atRest.max)

        let fillScale = Self.viewport.width / Self.video.width
        let filled = EdgeFollow.offsetRange(
            contentExtent: Self.video.width * fillScale, viewportExtent: Self.viewport.width
        )
        #expect(abs(filled.min) < 0.001)
        #expect(abs(filled.max) < 0.001)

        // Past that the picture is bigger than the window and the range opens up.
        let past = EdgeFollow.offsetRange(
            contentExtent: Self.video.width * fillScale * 2, viewportExtent: Self.viewport.width
        )
        #expect(past.min == 0)
        #expect(abs(past.max - Self.viewport.width) < 0.001)
    }

    @Test func degenerateDisplayReturnsCurrentOffset() {
        let next = EdgeFollow.contentOffset(
            forCursor: .zero,
            displayBounds: .zero,
            videoSize: Self.video,
            viewportSize: Self.viewport,
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

    // MARK: - panFollowRetarget / viewportPoint — continuous pan-follow (Option E)

    static func singleDisplayState(
        id: String, width: CGFloat, height: CGFloat, originX: Int, originY: Int
    ) -> DesktopState {
        DesktopState(
            displays: [DisplayMetadata(
                id: id, originX: Float(originX), originY: Float(originY),
                widthPoints: Float(width), heightPoints: Float(height))],
            spaces: [], activeDisplayId: id, selectedDisplayId: id,
            activeSpaceId: nil, cursorX: nil, cursorY: nil)
    }

    @Test func viewportPointRoundTripsThroughPanFollowInInterior() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)   // same aspect => no letterbox
        let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
        let source = CGPoint(x: 640, y: 300)
        let zoom: CGFloat = 2.0
        let offset = CGPoint(x: 150, y: 90)          // inside scrollable range

        let anchor = PointerRetargeting.viewportPoint(
            forSource: source, displayBounds: bounds, videoSize: sink,
            zoomScale: zoom, contentOffset: offset)
        #expect(anchor != nil)

        let back = PointerRetargeting.panFollowRetarget(
            anchorViewportPoint: anchor!, state: state, displayId: "d1",
            displayBounds: bounds, videoSize: sink, viewportSize: sink, zoomScale: zoom,
            contentOffset: offset)
        #expect(back != nil)
        #expect(abs(back!.sourcePoint.x - source.x) < 0.001)
        #expect(abs(back!.sourcePoint.y - source.y) < 0.001)
    }

    @Test func panFollowInteriorPinsAtMarginWithoutOverscroll() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
        let zoom: CGFloat = 2.0
        // Centre anchor, offset pinned at the right/bottom scrollable max.
        let anchor = CGPoint(x: sink.width / 2, y: sink.height / 2)
        let maxOffset = CGPoint(x: sink.width * zoom - sink.width,
                                y: sink.height * zoom - sink.height)
        let r = PointerRetargeting.panFollowRetarget(
            anchorViewportPoint: anchor, state: state, displayId: "d1",
            displayBounds: bounds, videoSize: sink, viewportSize: sink, zoomScale: zoom,
            contentOffset: maxOffset)!
        // Centre reaches W - W/2z = 1000 - 250 = 750, NOT the 999 edge.
        #expect(abs(r.sourcePoint.x - 750) < 0.5)
        #expect(r.sourcePoint.x < 999)
    }

    @Test func panFollowClampsPositiveOverscrollToReachableInterior() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
        let zoom: CGFloat = 2.0
        let anchor = CGPoint(x: sink.width / 2, y: sink.height / 2)
        let maxOffset = CGPoint(x: sink.width * zoom - sink.width,
                                y: sink.height * zoom - sink.height)
        let over = CGPoint(x: maxOffset.x + 44, y: maxOffset.y + 44)
        let r = PointerRetargeting.panFollowRetarget(
            anchorViewportPoint: anchor, state: state, displayId: "d1",
            displayBounds: bounds, videoSize: sink, viewportSize: sink, zoomScale: zoom,
            contentOffset: over)!
        #expect(abs(r.sourcePoint.x - 750) < 0.5)
        #expect(abs(r.sourcePoint.y - 450) < 0.5)
    }

    @Test func panFollowClampsNegativeOverscrollToReachableInterior() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
        let zoom: CGFloat = 2.0
        let anchor = CGPoint(x: sink.width / 2, y: sink.height / 2)
        let over = CGPoint(x: -44, y: -44)          // past the 0 boundary
        let r = PointerRetargeting.panFollowRetarget(
            anchorViewportPoint: anchor, state: state, displayId: "d1",
            displayBounds: bounds, videoSize: sink, viewportSize: sink, zoomScale: zoom,
            contentOffset: over)!
        #expect(abs(r.sourcePoint.x - 250) < 0.5)
        #expect(abs(r.sourcePoint.y - 150) < 0.5)
    }

    @Test func panFollowReturnsNilWhenNotZoomed() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
        #expect(PointerRetargeting.panFollowRetarget(
            anchorViewportPoint: .zero, state: state, displayId: "d1",
            displayBounds: bounds, videoSize: sink, viewportSize: sink, zoomScale: 1.0,
            contentOffset: .zero) == nil)
    }

    @Test func viewportSettleReconcilesCursorAtFinalOffset() throws {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(
            id: "d1",
            width: bounds.width,
            height: bounds.height,
            originX: 100,
            originY: 200
        )
        let settled = try #require(PointerRetargeting.panFollowSettle(
            anchorViewportPoint: CGPoint(x: sink.width / 2, y: sink.height / 2),
            state: state,
            displayId: "d1",
            displayBounds: bounds,
            videoSize: sink,
            viewportSize: sink,
            zoomScale: 2,
            contentOffset: CGPoint(x: 200, y: 120),
            lastSentHostPoint: CGPoint(x: 350, y: 350)
        ))

        #expect(abs(settled.cursorSourcePoint.x - 500) < 0.001)
        #expect(abs(settled.cursorSourcePoint.y - 300) < 0.001)
        #expect(settled.cursorRetarget?.hostPoint == CGPoint(x: 600, y: 500))
    }

    @Test func viewportSettleSuppressesAlreadySentCursorPoint() throws {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(
            id: "d1",
            width: bounds.width,
            height: bounds.height,
            originX: 100,
            originY: 200
        )
        let settled = try #require(PointerRetargeting.panFollowSettle(
            anchorViewportPoint: CGPoint(x: sink.width / 2, y: sink.height / 2),
            state: state,
            displayId: "d1",
            displayBounds: bounds,
            videoSize: sink,
            viewportSize: sink,
            zoomScale: 2,
            contentOffset: CGPoint(x: 200, y: 120),
            lastSentHostPoint: CGPoint(x: 600, y: 500)
        ))

        #expect(settled.cursorSourcePoint == CGPoint(x: 500, y: 300))
        #expect(settled.cursorRetarget == nil)
    }

    @Test func panFollowEdgeProjectionInvertsOverscrolledAxesOnly() {
        let projection = PointerRetargeting.panFollowEdgeProjection(
            contentOffset: CGPoint(x: 410, y: 30),
            contentSize: CGSize(width: 800, height: 480),
            viewportSize: CGSize(width: 400, height: 240),
            panTranslation: CGPoint(x: -18, y: -12),
            panVelocity: CGPoint(x: -900, y: -500)
        )
        #expect(projection.axes == [.x])
        #expect(projection.translation == CGPoint(x: 18, y: 0))
        #expect(projection.velocity == CGPoint(x: 900, y: 0))
    }

    @Test func panFollowEdgeProjectionReturnsEmptyInsideScrollableRange() {
        let projection = PointerRetargeting.panFollowEdgeProjection(
            contentOffset: CGPoint(x: 200, y: 120),
            contentSize: CGSize(width: 800, height: 480),
            viewportSize: CGSize(width: 400, height: 240),
            panTranslation: CGPoint(x: -18, y: -12),
            panVelocity: CGPoint(x: -900, y: -500)
        )
        #expect(projection.axes.isEmpty)
        #expect(projection.translation == .zero)
        #expect(projection.velocity == .zero)
    }

    @Test func panFollowStepDoesNotSendCursorSetWhileLeftEdgeIsOverscrolled() throws {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
        let step = try #require(PointerRetargeting.panFollowStep(
            state: PanFollowStepState(
                cursorSourcePoint: CGPoint(x: 250, y: 300),
                lastSentHostPoint: CGPoint(x: 250, y: 300),
                edgeAxes: [],
                edgeReturnAxes: [],
                lastGestureTranslation: .zero
            ),
            input: PanFollowStepInput(
                anchorViewportPoint: CGPoint(x: sink.width / 2, y: sink.height / 2),
                desktopState: state,
                displayId: "d1",
                displayBounds: bounds,
                videoSize: sink,
                zoomScale: 2.0,
                contentOffset: CGPoint(x: -40, y: 0),
                contentSize: CGSize(width: 800, height: 480),
                viewportSize: sink,
                panTranslation: CGPoint(x: 120, y: 0),
                panVelocity: CGPoint(x: 700, y: 0)
            )
        ))

        #expect(step.cursorRetarget == nil)
        #expect(step.state.lastSentHostPoint == nil)
        #expect(step.state.edgeAxes == [.x])
        #expect(step.state.edgeReturnAxes.isEmpty)
        #expect(step.edgeGestureFrames == [
            PanFollowEdgeGestureFrame(phase: .began, translation: .zero, velocity: .zero),
            PanFollowEdgeGestureFrame(
                phase: .changed,
                translation: CGPoint(x: -120, y: 0),
                velocity: CGPoint(x: -700, y: 0)
            )
        ])
    }

    @Test func panFollowStepKeepsRelativeCursorMoveAfterReturningFromLeftEdgeOverscroll() throws {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let sink = CGSize(width: 400, height: 240)
        let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
        var reducerState = PanFollowStepState(
            cursorSourcePoint: CGPoint(x: 250, y: 150),
            lastSentHostPoint: CGPoint(x: 250, y: 150),
            edgeAxes: [],
            edgeReturnAxes: [],
            lastGestureTranslation: .zero
        )
        let edgeStep = try #require(PointerRetargeting.panFollowStep(
            state: reducerState,
            input: PanFollowStepInput(
                anchorViewportPoint: CGPoint(x: sink.width / 2, y: sink.height / 2),
                desktopState: state,
                displayId: "d1",
                displayBounds: bounds,
                videoSize: sink,
                zoomScale: 2.0,
                contentOffset: CGPoint(x: -40, y: 0),
                contentSize: CGSize(width: 800, height: 480),
                viewportSize: sink,
                panTranslation: CGPoint(x: 120, y: 0),
                panVelocity: CGPoint(x: 700, y: 0)
            )
        ))
        reducerState = edgeStep.state
        // Mirror the delegate-side relative cursorMove that happened during
        // edge push: the host and client cursor models have moved left.
        reducerState.cursorSourcePoint = CGPoint(x: 80, y: 150)

        let clampReturnStep = try #require(PointerRetargeting.panFollowStep(
            state: reducerState,
            input: PanFollowStepInput(
                anchorViewportPoint: CGPoint(x: sink.width / 2, y: sink.height / 2),
                desktopState: state,
                displayId: "d1",
                displayBounds: bounds,
                videoSize: sink,
                zoomScale: 2.0,
                contentOffset: .zero,
                contentSize: CGSize(width: 800, height: 480),
                viewportSize: sink,
                panTranslation: CGPoint(x: 70, y: 0),
                panVelocity: CGPoint(x: -300, y: 0)
            )
        ))

        #expect(clampReturnStep.cursorRetarget == nil)
        #expect(clampReturnStep.state.cursorSourcePoint == CGPoint(x: 80, y: 150))
        #expect(clampReturnStep.state.lastSentHostPoint == nil)
        #expect(clampReturnStep.state.edgeReturnAxes == [.x])
        #expect(clampReturnStep.edgeGestureFrames == [
            PanFollowEdgeGestureFrame(
                phase: .changed,
                translation: CGPoint(x: -70, y: 0),
                velocity: CGPoint(x: 300, y: 0)
            )
        ])
        #expect(clampReturnStep.state.edgeAxes == [.x])

        let interiorStep = try #require(PointerRetargeting.panFollowStep(
            state: clampReturnStep.state,
            input: PanFollowStepInput(
                anchorViewportPoint: CGPoint(x: sink.width / 2, y: sink.height / 2),
                desktopState: state,
                displayId: "d1",
                displayBounds: bounds,
                videoSize: sink,
                zoomScale: 2.0,
                contentOffset: CGPoint(x: 10, y: 0),
                contentSize: CGSize(width: 800, height: 480),
                viewportSize: sink,
                panTranslation: CGPoint(x: 50, y: 0),
                panVelocity: CGPoint(x: -200, y: 0)
            )
        ))

        #expect(interiorStep.cursorRetarget == nil)
        #expect(interiorStep.state.cursorSourcePoint == CGPoint(x: 80, y: 150))
        #expect(interiorStep.state.edgeReturnAxes == [.x])
        #expect(interiorStep.state.edgeAxes == [.x])
        #expect(interiorStep.edgeGestureFrames == [
            PanFollowEdgeGestureFrame(
                phase: .changed,
                translation: CGPoint(x: -50, y: 0),
                velocity: CGPoint(x: 200, y: 0)
            )
        ])
    }

    // MARK: - hostPoint(forContentViewLocation:) — video touch inverse map
    //
    // `loc` is the touch in the content view's own (pre-transform) coordinate
    // space, so the map needs no zoom/offset — those are already inverted by
    // UIKit hit-testing. Geometry: display 2000x1000 origin (100,200), content
    // view 500x500 -> fitScale 0.25, padX 0, padY 125.

    private static func videoTouchState() -> DesktopState {
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
            state: Self.videoTouchState(),
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
            state: Self.videoTouchState(),
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
            state: Self.videoTouchState(),
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
            state: Self.videoTouchState(),
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
