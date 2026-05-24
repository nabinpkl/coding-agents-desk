import UIKit

// ADR-0009 cursor-driven viewport pan. The client mirrors the host
// cursor position in source-display points so the scroll view can follow
// it when zoomed past 1.0x. Hosts the UIScrollViewDelegate
// viewForZooming and the double-tap zoom toggle as well; both are
// scroll-view concerns and travel naturally with the EdgeFollow math.

extension PairingViewController: UIScrollViewDelegate {
    @objc func handleSinkDoubleTap(_ gr: UITapGestureRecognizer) {
        guard let scroll = sinkScrollView else { return }
        let target: CGFloat = scroll.zoomScale > 1.0 ? 1.0 : Self.sinkDoubleTapZoomScale
        let point = gr.location(in: gr.view)
        // Convert the visible-frame tap point to a content-coords rect
        // so iOS zooms centered on the user's finger, not the origin.
        let scale = target
        let rectWidth = scroll.bounds.width / scale
        let rectHeight = scroll.bounds.height / scale
        let rect = CGRect(
            x: point.x - rectWidth / 2,
            y: point.y - rectHeight / 2,
            width: rectWidth,
            height: rectHeight
        )
        scroll.zoom(to: rect, animated: true)
    }

    // MARK: - UIScrollViewDelegate

    public func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        // Only one subview at content level: the sink view.
        guard scrollView === sinkScrollView else { return nil }
        return scrollView.subviews.first
    }

    // ADR-0009. The active display rect drives both the cursor-model
    // clamp and the aspect-fit math the EdgeFollow helper uses. Centre
    // the cursor on first arrival or when the active display changes;
    // preserve the cursor position on a same-display re-push so the
    // user doesn't lose their place every time a Space switches.
    func applyDesktopStateForCursorModel(_ state: DesktopState) {
        let active = state.displays.first(where: { $0.id == state.activeDisplayId })
            ?? state.displays.first
        guard let display = active,
              display.widthPoints > 0,
              display.heightPoints > 0 else {
            cursorSourcePos = nil
            activeDisplayRect = .zero
            activeDisplayIdMirror = nil
            return
        }
        let newRect = CGRect(
            x: 0, y: 0,
            width: CGFloat(display.widthPoints),
            height: CGFloat(display.heightPoints)
        )
        let isSameDisplay = display.id == activeDisplayIdMirror && newRect.size == activeDisplayRect.size
        activeDisplayRect = newRect
        activeDisplayIdMirror = display.id
        if !isSameDisplay || cursorSourcePos == nil {
            cursorSourcePos = CGPoint(x: newRect.midX, y: newRect.midY)
        }
    }

    // ADR-0009. The host's InputDispatcher already integrates these
    // deltas and clamps against CGDisplayBounds; mirror the same logic
    // locally so the client knows where the host cursor is without
    // needing a return push.
    func advanceCursorModel(dx: CGFloat, dy: CGFloat) {
        guard activeDisplayRect.width > 0, activeDisplayRect.height > 0 else { return }
        let from = cursorSourcePos ?? CGPoint(x: activeDisplayRect.midX, y: activeDisplayRect.midY)
        let next = EdgeFollow.advanceCursor(
            from: from,
            delta: CGPoint(x: dx, y: dy),
            displayBounds: activeDisplayRect
        )
        cursorSourcePos = next
        applyEdgeFollow()
    }

    func applyEdgeFollow() {
        guard let scroll = sinkScrollView, let pos = cursorSourcePos else { return }
        guard scroll.zoomScale > 1.0 else { return }
        let next = EdgeFollow.contentOffset(
            forCursor: pos,
            displayBounds: activeDisplayRect,
            sinkViewSize: scroll.bounds.size,
            zoomScale: scroll.zoomScale,
            currentOffset: scroll.contentOffset
        )
        if next != scroll.contentOffset {
            scroll.setContentOffset(next, animated: false)
        }
    }
}
