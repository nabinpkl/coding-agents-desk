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
// The visible region is constrained to the cropped slice of the
// aspect-fit video frame at the current zoom scale. Aspect-fit
// letterbox / pillarbox padding is part of the sink-view's content but
// not the source-display rect, so the math has to account for that
// offset before applying zoom.
enum EdgeFollow {
    // edgeMargin is a fraction of the visible band. 0.12 = the cursor
    // can sit anywhere except the outer 12% on any side before the
    // viewport starts following.
    static func contentOffset(
        forCursor cursorSourcePos: CGPoint,
        displayBounds: CGRect,
        sinkViewSize: CGSize,
        zoomScale: CGFloat,
        currentOffset: CGPoint,
        edgeMargin: CGFloat = 0.12
    ) -> CGPoint {
        guard displayBounds.width > 0,
              displayBounds.height > 0,
              sinkViewSize.width > 0,
              sinkViewSize.height > 0,
              zoomScale > 0 else {
            return currentOffset
        }

        // Aspect-fit scale of the source display into the sink view.
        let fitScale = min(
            sinkViewSize.width / displayBounds.width,
            sinkViewSize.height / displayBounds.height
        )
        let videoWidth = displayBounds.width * fitScale
        let videoHeight = displayBounds.height * fitScale
        // Pillarbox / letterbox padding inside the sink view at zoom 1.
        let padX = (sinkViewSize.width - videoWidth) / 2
        let padY = (sinkViewSize.height - videoHeight) / 2

        // Cursor position in content coords (after zoom).
        let cursorContentX = (padX + cursorSourcePos.x * fitScale) * zoomScale
        let cursorContentY = (padY + cursorSourcePos.y * fitScale) * zoomScale

        // Safe band inside the visible region: the cursor can sit
        // anywhere inside [marginX, sinkW - marginX] in viewport coords
        // without the viewport panning.
        let marginX = sinkViewSize.width * edgeMargin
        let marginY = sinkViewSize.height * edgeMargin

        var nextOffsetX = currentOffset.x
        var nextOffsetY = currentOffset.y

        // If cursor in viewport coords (cursorContent - currentOffset)
        // lies outside [marginX, sinkW - marginX], shift the offset to
        // pull the cursor back onto the margin boundary.
        let cursorViewportX = cursorContentX - currentOffset.x
        if cursorViewportX < marginX {
            nextOffsetX = cursorContentX - marginX
        } else if cursorViewportX > sinkViewSize.width - marginX {
            nextOffsetX = cursorContentX - (sinkViewSize.width - marginX)
        }

        let cursorViewportY = cursorContentY - currentOffset.y
        if cursorViewportY < marginY {
            nextOffsetY = cursorContentY - marginY
        } else if cursorViewportY > sinkViewSize.height - marginY {
            nextOffsetY = cursorContentY - (sinkViewSize.height - marginY)
        }

        // Clamp to scrollable range. At zoomScale = 1 contentSize equals
        // sinkViewSize so the max offset is 0; at zoom > 1 the difference
        // grows linearly.
        let contentW = sinkViewSize.width * zoomScale
        let contentH = sinkViewSize.height * zoomScale
        let maxOffsetX = max(0, contentW - sinkViewSize.width)
        let maxOffsetY = max(0, contentH - sinkViewSize.height)
        nextOffsetX = min(max(0, nextOffsetX), maxOffsetX)
        nextOffsetY = min(max(0, nextOffsetY), maxOffsetY)

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
    let sinkViewSize: CGSize
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
        sinkViewSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint
    ) -> CGPoint? {
        guard displayBounds.width > 0, displayBounds.height > 0,
              sinkViewSize.width > 0, sinkViewSize.height > 0,
              zoomScale > 0 else { return nil }
        let fitScale = min(sinkViewSize.width / displayBounds.width,
                           sinkViewSize.height / displayBounds.height)
        guard fitScale > 0 else { return nil }
        let padX = (sinkViewSize.width - displayBounds.width * fitScale) / 2
        let padY = (sinkViewSize.height - displayBounds.height * fitScale) / 2
        let contentX = (padX + source.x * fitScale) * zoomScale
        let contentY = (padY + source.y * fitScale) * zoomScale
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
        sinkViewSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint
    ) -> CursorViewportRetarget? {
        guard let state,
              let displayId,
              let display = state.displays.first(where: { $0.id == displayId }),
              displayBounds.width > 0,
              displayBounds.height > 0,
              sinkViewSize.width > 0,
              sinkViewSize.height > 0,
              zoomScale > 1.0 else {
            return nil
        }
        let fitScale = min(sinkViewSize.width / displayBounds.width,
                           sinkViewSize.height / displayBounds.height)
        guard fitScale > 0 else { return nil }
        let padX = (sinkViewSize.width - displayBounds.width * fitScale) / 2
        let padY = (sinkViewSize.height - displayBounds.height * fitScale) / 2
        let maxOffsetX = max(0, sinkViewSize.width * zoomScale - sinkViewSize.width)
        let maxOffsetY = max(0, sinkViewSize.height * zoomScale - sinkViewSize.height)

        // Per-axis: interior reconcile of the fixed anchor, clamped to the
        // scrollable range. Boundary cursor movement is relative input, not a
        // second absolute retarget.
        func axis(anchor: CGFloat, offset: CGFloat, maxOffset: CGFloat,
                  pad: CGFloat) -> CGFloat {
            let clamped = min(max(0, offset), maxOffset)
            let sink = (anchor + clamped) / zoomScale
            return (sink - pad) / fitScale
        }

        let source = CGPoint(
            x: axis(anchor: anchor.x, offset: contentOffset.x, maxOffset: maxOffsetX,
                    pad: padX),
            y: axis(anchor: anchor.y, offset: contentOffset.y, maxOffset: maxOffsetY,
                    pad: padY))
        let clamped = EdgeFollow.advanceCursor(
            from: source, delta: .zero, displayBounds: displayBounds)
        return CursorViewportRetarget(
            displayId: displayId,
            sourcePoint: clamped,
            hostPoint: CGPoint(
                x: CGFloat(display.originX) + clamped.x,
                y: CGFloat(display.originY) + clamped.y))
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
        let maxOffsetX = max(0, contentSize.width - viewportSize.width)
        let maxOffsetY = max(0, contentSize.height - viewportSize.height)
        var axes: PanFollowOverscrollAxes = []
        if contentOffset.x < 0 || contentOffset.x > maxOffsetX {
            axes.insert(.x)
        }
        if contentOffset.y < 0 || contentOffset.y > maxOffsetY {
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
            sinkViewSize: input.sinkViewSize,
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
        case .cursorSet, .dragEnd, .switchSpaceGesture, .switchSpaceStep, .key, .modifierArm:
            return false
        }
    }
}
