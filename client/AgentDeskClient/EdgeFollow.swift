import CoreGraphics
import Foundation

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

enum PointerRetargeting {
    static func viewportCenterRetarget(
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

        let fitScale = min(
            sinkViewSize.width / displayBounds.width,
            sinkViewSize.height / displayBounds.height
        )
        guard fitScale > 0 else { return nil }

        let videoWidth = displayBounds.width * fitScale
        let videoHeight = displayBounds.height * fitScale
        let padX = (sinkViewSize.width - videoWidth) / 2
        let padY = (sinkViewSize.height - videoHeight) / 2

        let centerContentX = contentOffset.x + sinkViewSize.width / 2
        let centerContentY = contentOffset.y + sinkViewSize.height / 2
        let sinkX = centerContentX / zoomScale
        let sinkY = centerContentY / zoomScale
        let source = CGPoint(
            x: (sinkX - padX) / fitScale,
            y: (sinkY - padY) / fitScale
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
