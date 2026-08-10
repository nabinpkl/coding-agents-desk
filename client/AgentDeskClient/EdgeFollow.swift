import CoreGraphics
import Foundation
import OSLog
import AgentDeskWire

// ADR-0009 edge-follow viewport math. The iPhone holds a model of the
// host cursor's position in source-display points; this helper turns
// "cursor is approaching the visible-region edge" into the contentOffset
// the host's UIScrollView should adopt so the cursor stays inside a
// safe band.
//
// The scrollable content is the video and nothing else: the sink view is sized to the
// aspect-fit picture rather than to the scroll view's frame, so there is no letterbox or
// pillarbox padding baked into the content for the cursor math to step over. What the
// picture does not cover is empty scroll-view frame, which the scroll view fills with a
// centring inset, and which zooming eats into as the picture grows.
//
// That makes the video rect and the window rect two different things, and every function
// here needs both: the video decides where a source point lands, the window decides how far
// it can be scrolled.
enum EdgeFollow {
    // Offset range a UIScrollView will hold for this content, honouring the symmetric
    // centring inset it gets while the content is smaller than the window. Below that size
    // the range collapses to the single centred offset.
    static func offsetRange(
        contentExtent: CGFloat,
        viewportExtent: CGFloat
    ) -> (min: CGFloat, max: CGFloat) {
        let inset = max(0, (viewportExtent - contentExtent) / 2)
        let lower = -inset
        return (lower, max(lower, contentExtent - viewportExtent + inset))
    }

    // edgeMargin is a fraction of the visible band. 0.12 = the cursor
    // can sit anywhere except the outer 12% on any side before the
    // viewport starts following.
    static func contentOffset(
        forCursor cursorSourcePos: CGPoint,
        displayBounds: CGRect,
        videoSize: CGSize,
        viewportSize: CGSize,
        zoomScale: CGFloat,
        currentOffset: CGPoint,
        edgeMargin: CGFloat = 0.12
    ) -> CGPoint {
        guard displayBounds.width > 0,
              displayBounds.height > 0,
              videoSize.width > 0,
              videoSize.height > 0,
              viewportSize.width > 0,
              viewportSize.height > 0,
              zoomScale > 0 else {
            return currentOffset
        }

        // Source display point -> content point. The sink is the picture, so this is the
        // whole mapping; there is no padding term.
        let scaleX = videoSize.width / displayBounds.width
        let scaleY = videoSize.height / displayBounds.height
        let cursorContentX = cursorSourcePos.x * scaleX * zoomScale
        let cursorContentY = cursorSourcePos.y * scaleY * zoomScale

        // Safe band inside the window: the cursor can sit anywhere inside
        // [margin, viewport - margin] in viewport coords without the viewport panning.
        let marginX = viewportSize.width * edgeMargin
        let marginY = viewportSize.height * edgeMargin

        var nextOffsetX = currentOffset.x
        var nextOffsetY = currentOffset.y

        let cursorViewportX = cursorContentX - currentOffset.x
        if cursorViewportX < marginX {
            nextOffsetX = cursorContentX - marginX
        } else if cursorViewportX > viewportSize.width - marginX {
            nextOffsetX = cursorContentX - (viewportSize.width - marginX)
        }

        let cursorViewportY = cursorContentY - currentOffset.y
        if cursorViewportY < marginY {
            nextOffsetY = cursorContentY - marginY
        } else if cursorViewportY > viewportSize.height - marginY {
            nextOffsetY = cursorContentY - (viewportSize.height - marginY)
        }

        let rangeX = offsetRange(
            contentExtent: videoSize.width * zoomScale, viewportExtent: viewportSize.width
        )
        let rangeY = offsetRange(
            contentExtent: videoSize.height * zoomScale, viewportExtent: viewportSize.height
        )
        nextOffsetX = min(max(rangeX.min, nextOffsetX), rangeX.max)
        nextOffsetY = min(max(rangeY.min, nextOffsetY), rangeY.max)

        return CGPoint(x: nextOffsetX, y: nextOffsetY)
    }

    // Helper for the cursor-model update path. Adds the delta to the
    // current source position and clamps into the display rect. Mirrors
    // InputDispatcher.postCursorMove's current+delta+clamp pipeline so
    // client and host stay in lockstep without a return push.
    static func advanceCursor(
        from current: CGPoint,
        delta: CGPoint,
        displayBounds: CGRect
    ) -> CGPoint {
        let maxX = max(0, displayBounds.width - 1)
        let maxY = max(0, displayBounds.height - 1)
        let nextX = min(max(0, current.x + delta.x), maxX)
        let nextY = min(max(0, current.y + delta.y), maxY)
        return CGPoint(x: nextX, y: nextY)
    }
}

struct CursorViewportRetarget: Equatable {
    let displayId: String
    let sourcePoint: CGPoint
    let hostPoint: CGPoint
}

struct PanFollowOverscrollAxes: OptionSet, Equatable {
    let rawValue: Int

    static let x = PanFollowOverscrollAxes(rawValue: 1 << 0)
    static let y = PanFollowOverscrollAxes(rawValue: 1 << 1)
}

struct PanFollowEdgeProjection: Equatable {
    let axes: PanFollowOverscrollAxes
    let translation: CGPoint
    let velocity: CGPoint
}

enum PanFollowEdgeGesturePhase: Equatable {
    case began
    case changed
    case ended
}

struct PanFollowEdgeGestureFrame: Equatable {
    let phase: PanFollowEdgeGesturePhase
    let translation: CGPoint
    let velocity: CGPoint
}

struct PanFollowStepState: Equatable {
    var cursorSourcePoint: CGPoint?
    var lastSentHostPoint: CGPoint?
    var edgeAxes: PanFollowOverscrollAxes
    var edgeReturnAxes: PanFollowOverscrollAxes
    var lastGestureTranslation: CGPoint?
}

struct PanFollowStepInput: Equatable {
    let anchorViewportPoint: CGPoint
    let desktopState: DesktopState?
    let displayId: String?
    let displayBounds: CGRect
    // The picture's unzoomed size, which is the sink view's size. `contentSize` below is the
    // same rect after zoom, as the scroll view reports it.
    let videoSize: CGSize
    let zoomScale: CGFloat
    let contentOffset: CGPoint
    let contentSize: CGSize
    let viewportSize: CGSize
    let panTranslation: CGPoint
    let panVelocity: CGPoint
}

struct PanFollowStepResult: Equatable {
    let state: PanFollowStepState
    let cursorRetarget: CursorViewportRetarget?
    let edgeGestureFrames: [PanFollowEdgeGestureFrame]
}

struct PanFollowSettleResult: Equatable {
    let cursorSourcePoint: CGPoint
    let cursorRetarget: CursorViewportRetarget?
}

enum PanFollowDiagnostics {
    private static let logger = Logger(subsystem: Config.logSubsystem, category: "pan-follow")

    static func log(_ message: String) {
        let line = "[DEBUG-pan-follow] \(message)"
        logger.notice("\(line, privacy: .public)")
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}

enum PointerRetargeting {
    // The dot's viewport position for a source-display point, at the given
    // zoom/offset. Used to capture the fixed pan anchor at drag start.
    static func viewportPoint(
        forSource source: CGPoint,
        displayBounds: CGRect,
        videoSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint
    ) -> CGPoint? {
        guard displayBounds.width > 0, displayBounds.height > 0,
              videoSize.width > 0, videoSize.height > 0,
              zoomScale > 0 else { return nil }
        let contentX = source.x * (videoSize.width / displayBounds.width) * zoomScale
        let contentY = source.y * (videoSize.height / displayBounds.height) * zoomScale
        return CGPoint(x: contentX - contentOffset.x, y: contentY - contentOffset.y)
    }

    // Continuous pan-follow (Option E). During a manual viewport pan the dot is
    // held at a fixed viewport anchor while the content slides beneath it; this
    // reprojects that anchor through the reachable contentOffset to the source
    // point now under it, so the host cursor can be reconciled to follow the
    // pan. Rubber-band movement beyond the scrollable range is intentionally
    // excluded here; the live scroll delegate hands that movement to
    // GestureTranslator.processPan so it uses the same accelerated cursorMove
    // path as the trackpad.
    static func panFollowRetarget(
        anchorViewportPoint anchor: CGPoint,
        state: DesktopState?,
        displayId: String?,
        displayBounds: CGRect,
        videoSize: CGSize,
        viewportSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint
    ) -> CursorViewportRetarget? {
        guard let state,
              let displayId,
              let display = state.displays.first(where: { $0.id == displayId }),
              displayBounds.width > 0,
              displayBounds.height > 0,
              videoSize.width > 0,
              videoSize.height > 0,
              viewportSize.width > 0,
              viewportSize.height > 0,
              zoomScale > 1.0 else {
            return nil
        }
        let rangeX = EdgeFollow.offsetRange(
            contentExtent: videoSize.width * zoomScale, viewportExtent: viewportSize.width
        )
        let rangeY = EdgeFollow.offsetRange(
            contentExtent: videoSize.height * zoomScale, viewportExtent: viewportSize.height
        )

        // Per-axis: interior reconcile of the fixed anchor, clamped to the
        // scrollable range. Boundary cursor movement is relative input, not a
        // second absolute retarget.
        func axis(
            anchor: CGFloat,
            offset: CGFloat,
            range: (min: CGFloat, max: CGFloat),
            scale: CGFloat
        ) -> CGFloat {
            let clamped = min(max(range.min, offset), range.max)
            return (anchor + clamped) / zoomScale / scale
        }

        let source = CGPoint(
            x: axis(anchor: anchor.x, offset: contentOffset.x, range: rangeX,
                    scale: videoSize.width / displayBounds.width),
            y: axis(anchor: anchor.y, offset: contentOffset.y, range: rangeY,
                    scale: videoSize.height / displayBounds.height))
        let clamped = EdgeFollow.advanceCursor(
            from: source, delta: .zero, displayBounds: displayBounds)
        return CursorViewportRetarget(
            displayId: displayId,
            sourcePoint: clamped,
            hostPoint: CGPoint(
                x: CGFloat(display.originX) + clamped.x,
                y: CGFloat(display.originY) + clamped.y))
    }

    // Reconcile the fixed overlay anchor after UIScrollView momentum or
    // rubber-band settling has stopped. The local source point is always
    // refreshed for the final contentOffset; the host retarget is omitted
    // only when the active drag already sent that exact point.
    static func panFollowSettle(
        anchorViewportPoint anchor: CGPoint,
        state: DesktopState?,
        displayId: String?,
        displayBounds: CGRect,
        videoSize: CGSize,
        viewportSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint,
        lastSentHostPoint: CGPoint?
    ) -> PanFollowSettleResult? {
        guard let retarget = panFollowRetarget(
            anchorViewportPoint: anchor,
            state: state,
            displayId: displayId,
            displayBounds: displayBounds,
            videoSize: videoSize,
            viewportSize: viewportSize,
            zoomScale: zoomScale,
            contentOffset: contentOffset
        ) else { return nil }
        return PanFollowSettleResult(
            cursorSourcePoint: retarget.sourcePoint,
            cursorRetarget: retarget.hostPoint == lastSentHostPoint ? nil : retarget
        )
    }

    // Projects a UIScrollView rubber-band pan into the trackpad cursor domain.
    // UIScrollView contentOffset grows when the finger moves left/up, while a
    // cursorMove grows when the finger moves right/down, so overscrolled axes
    // invert the pan translation and velocity. Interior axes are zeroed here;
    // panFollowStep decides whether an absolute reconcile is safe for the
    // whole pointer.
    static func panFollowEdgeProjection(
        contentOffset: CGPoint,
        contentSize: CGSize,
        viewportSize: CGSize,
        panTranslation: CGPoint,
        panVelocity: CGPoint
    ) -> PanFollowEdgeProjection {
        // Against the range the scroll view will actually hold, not against zero: while the
        // picture is smaller than the window the resting offset is the negative centring
        // inset, and reading that as overscroll would put the axis into edge-push the moment
        // a drag began.
        let rangeX = EdgeFollow.offsetRange(
            contentExtent: contentSize.width, viewportExtent: viewportSize.width
        )
        let rangeY = EdgeFollow.offsetRange(
            contentExtent: contentSize.height, viewportExtent: viewportSize.height
        )
        var axes: PanFollowOverscrollAxes = []
        if contentOffset.x < rangeX.min || contentOffset.x > rangeX.max {
            axes.insert(.x)
        }
        if contentOffset.y < rangeY.min || contentOffset.y > rangeY.max {
            axes.insert(.y)
        }
        return panFollowEdgeProjection(
            axes: axes,
            panTranslation: panTranslation,
            panVelocity: panVelocity
        )
    }

    static func panFollowEdgeProjection(
        axes: PanFollowOverscrollAxes,
        panTranslation: CGPoint,
        panVelocity: CGPoint
    ) -> PanFollowEdgeProjection {
        return PanFollowEdgeProjection(
            axes: axes,
            translation: CGPoint(
                x: axes.contains(.x) ? -panTranslation.x : 0,
                y: axes.contains(.y) ? -panTranslation.y : 0
            ),
            velocity: CGPoint(
                x: axes.contains(.x) ? -panVelocity.x : 0,
                y: axes.contains(.y) ? -panVelocity.y : 0
            )
        )
    }

    static func panFollowStep(
        state: PanFollowStepState,
        input: PanFollowStepInput
    ) -> PanFollowStepResult? {
        guard let retarget = panFollowRetarget(
            anchorViewportPoint: input.anchorViewportPoint,
            state: input.desktopState,
            displayId: input.displayId,
            displayBounds: input.displayBounds,
            videoSize: input.videoSize,
            viewportSize: input.viewportSize,
            zoomScale: input.zoomScale,
            contentOffset: input.contentOffset
        ) else { return nil }

        let edgeProjection = panFollowEdgeProjection(
            contentOffset: input.contentOffset,
            contentSize: input.contentSize,
            viewportSize: input.viewportSize,
            panTranslation: input.panTranslation,
            panVelocity: input.panVelocity
        )
        let priorSource = state.cursorSourcePoint ?? retarget.sourcePoint
        // Once a finger pan hits an edge, keep that axis on the same relative
        // cursorMove path as the trackpad until the drag ends. Switching back
        // to absolute cursorSet reconciliation mid-gesture makes the cursor
        // fight the user's return movement.
        let edgeReturnAxes = panFollowEdgeReturnAxes(
            previousReturnAxes: state.edgeReturnAxes,
            previousEdgeAxes: state.edgeAxes,
            currentEdgeAxes: edgeProjection.axes
        )
        let relativeAxes = edgeProjection.axes.union(edgeReturnAxes)
        let relativeProjection = panFollowEdgeProjection(
            axes: relativeAxes,
            panTranslation: input.panTranslation,
            panVelocity: input.panVelocity
        )
        let sourcePoint = CGPoint(
            x: relativeAxes.contains(.x)
                ? priorSource.x
                : retarget.sourcePoint.x,
            y: relativeAxes.contains(.y)
                ? priorSource.y
                : retarget.sourcePoint.y
        )

        var nextState = state
        nextState.cursorSourcePoint = sourcePoint
        nextState.edgeReturnAxes = edgeReturnAxes

        var cursorRetarget: CursorViewportRetarget?
        if relativeAxes.isEmpty {
            let hostPoint = CGPoint(
                x: retarget.hostPoint.x + sourcePoint.x - retarget.sourcePoint.x,
                y: retarget.hostPoint.y + sourcePoint.y - retarget.sourcePoint.y
            )
            if hostPoint != state.lastSentHostPoint {
                nextState.lastSentHostPoint = hostPoint
                cursorRetarget = CursorViewportRetarget(
                    displayId: retarget.displayId,
                    sourcePoint: sourcePoint,
                    hostPoint: hostPoint
                )
            }
        } else {
            nextState.lastSentHostPoint = nil
        }

        let edgeFrames = panFollowEdgeGestureFrames(
            previousAxes: state.edgeAxes,
            previousRawTranslation: state.lastGestureTranslation,
            projection: relativeProjection,
            rawTranslation: input.panTranslation
        )
        nextState.edgeAxes = relativeAxes
        nextState.lastGestureTranslation = input.panTranslation

        return PanFollowStepResult(
            state: nextState,
            cursorRetarget: cursorRetarget,
            edgeGestureFrames: edgeFrames
        )
    }

    private static func panFollowEdgeReturnAxes(
        previousReturnAxes: PanFollowOverscrollAxes,
        previousEdgeAxes: PanFollowOverscrollAxes,
        currentEdgeAxes: PanFollowOverscrollAxes
    ) -> PanFollowOverscrollAxes {
        guard currentEdgeAxes.isEmpty else { return [] }
        var axes = previousReturnAxes
        if previousEdgeAxes.contains(.x) {
            axes.insert(.x)
        }
        if previousEdgeAxes.contains(.y) {
            axes.insert(.y)
        }
        return axes
    }

    private static func panFollowEdgeGestureFrames(
        previousAxes: PanFollowOverscrollAxes,
        previousRawTranslation: CGPoint?,
        projection: PanFollowEdgeProjection,
        rawTranslation: CGPoint
    ) -> [PanFollowEdgeGestureFrame] {
        guard !projection.axes.isEmpty else {
            if previousAxes.isEmpty { return [] }
            return [
                PanFollowEdgeGestureFrame(
                    phase: .ended,
                    translation: .zero,
                    velocity: .zero
                )
            ]
        }

        var frames: [PanFollowEdgeGestureFrame] = []
        if previousAxes != projection.axes {
            if !previousAxes.isEmpty {
                frames.append(PanFollowEdgeGestureFrame(
                    phase: .ended,
                    translation: .zero,
                    velocity: .zero
                ))
            }
            let previousRaw = previousRawTranslation ?? rawTranslation
            frames.append(PanFollowEdgeGestureFrame(
                phase: .began,
                translation: panFollowEdgeProjection(
                    axes: projection.axes,
                    panTranslation: previousRaw,
                    panVelocity: .zero
                ).translation,
                velocity: .zero
            ))
        }

        frames.append(PanFollowEdgeGestureFrame(
            phase: .changed,
            translation: projection.translation,
            velocity: projection.velocity
        ))
        return frames
    }

    // Map a touch on the video sink to a host point (global CG points), used by
    // video touch mode to prime the host cursor at the touched spot.
    //
    // `loc` is the touch location in the *content view's own* coordinate system
    // (`location(in: videoSink.view)`), which UIKit reports pre-transform: it is
    // already independent of the scroll view's zoomScale and contentOffset,
    // because hit-testing inverts the zoom transform and scroll offset. So this
    // needs only the content-view bounds (the aspect-fit letterbox reference)
    // and the display metadata; passing the scroll-space location plus
    // zoom/offset instead double-counts the offset and lands at the far edge.
    // Returns nil when geometry is unavailable so the caller can swallow the
    // touch.
    static func hostPoint(
        forContentViewLocation loc: CGPoint,
        state: DesktopState?,
        displayId: String?,
        displayBounds: CGRect,
        contentViewSize: CGSize
    ) -> CursorViewportRetarget? {
        guard let state,
              let displayId,
              let display = state.displays.first(where: { $0.id == displayId }),
              displayBounds.width > 0,
              displayBounds.height > 0,
              contentViewSize.width > 0,
              contentViewSize.height > 0 else {
            return nil
        }

        let fitScale = min(
            contentViewSize.width / displayBounds.width,
            contentViewSize.height / displayBounds.height
        )
        guard fitScale > 0 else { return nil }

        let videoWidth = displayBounds.width * fitScale
        let videoHeight = displayBounds.height * fitScale
        let padX = (contentViewSize.width - videoWidth) / 2
        let padY = (contentViewSize.height - videoHeight) / 2

        let source = CGPoint(
            x: (loc.x - padX) / fitScale,
            y: (loc.y - padY) / fitScale
        )
        let clamped = EdgeFollow.advanceCursor(
            from: source,
            delta: .zero,
            displayBounds: displayBounds
        )
        return CursorViewportRetarget(
            displayId: displayId,
            sourcePoint: clamped,
            hostPoint: CGPoint(
                x: CGFloat(display.originX) + clamped.x,
                y: CGFloat(display.originY) + clamped.y
            )
        )
    }

    static func retargetInput(
        pending: inout CursorViewportRetarget?,
        before input: NormalizedInput
    ) -> CursorViewportRetarget? {
        guard input.consumesPendingCursorRetarget, let retarget = pending else { return nil }
        pending = nil
        return retarget
    }
}

extension NormalizedInput {
    var consumesPendingCursorRetarget: Bool {
        switch self {
        case .cursorMove, .click, .dragStart, .scroll:
            return true
        case .cursorSet, .dragEnd, .switchSpaceGesture, .switchSpaceStep, .systemCommand, .key, .modifierArm:
            return false
        }
    }
}
