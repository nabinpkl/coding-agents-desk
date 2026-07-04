import UIKit
import AgentDeskWire

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

    // ADR-0009. The selected display rect drives both the cursor-model
    // clamp and the aspect-fit math the EdgeFollow helper uses. Centre
    // the cursor on first arrival or when the selected display changes;
    // preserve the cursor position on a same-display re-push so the
    // user doesn't lose their place every time a Space switches.
    func applyDesktopStateForCursorModel(_ state: DesktopState) {
        let selectedId = state.selectedDisplayId ?? state.activeDisplayId
        let active = state.displays.first(where: { $0.id == selectedId })
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
            pendingCursorRetarget = nil
            isManualViewportPanActive = false
            finishPanFollowEdgePush()
            if let cx = state.cursorX, let cy = state.cursorY {
                cursorSourcePos = EdgeFollow.advanceCursor(
                    from: CGPoint(
                        x: CGFloat(cx - display.originX),
                        y: CGFloat(cy - display.originY)
                    ),
                    delta: .zero,
                    displayBounds: newRect
                )
            } else {
                cursorSourcePos = CGPoint(x: newRect.midX, y: newRect.midY)
            }
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
        updateCursorDot()
    }

    // Applies a host cursor-image frame: resolve (cache) the PNG, record
    // the on-screen render size and hotspot, swap the overlay glyph, and
    // reposition. Position itself is locally predicted; only the glyph
    // identity comes from the host, so this lags a shape change by ~RTT.
    func applyCursorImage(_ push: CursorImagePush) {
        cursorHidden = push.hidden
        guard let dot = cursorDotView, let image = cursorImageStore.resolve(push) else {
            updateCursorDot()
            return
        }
        let scale = CursorPointerView.mirrorRenderScale
        cursorRenderSize = CGSize(
            width: CGFloat(push.widthPoints) * scale,
            height: CGFloat(push.heightPoints) * scale
        )
        cursorHotspotFrac = CGPoint(
            x: CGFloat(push.hotspotXFrac),
            y: CGFloat(push.hotspotYFrac)
        )
        dot.apply(image: image, renderSize: cursorRenderSize)
        updateCursorDot()
    }

    // Authoritative host-side correction for cursor moves that did not
    // originate on the iPhone, such as a physical mouse or trackpad move on
    // the Mac while remote input was idle.
    func applyCursorPosition(_ push: CursorPositionPush) {
        guard let state = lastDesktopState else { return }
        let displayId = push.displayId
            ?? activeDisplayIdMirror
            ?? state.selectedDisplayId
            ?? state.activeDisplayId
        guard let displayId,
              displayId == activeDisplayIdMirror,
              let display = state.displays.first(where: { $0.id == displayId }),
              activeDisplayRect.width > 0,
              activeDisplayRect.height > 0 else { return }
        let corrected = CGPoint(
            x: CGFloat(push.cursorX - display.originX),
            y: CGFloat(push.cursorY - display.originY)
        )
        cursorSourcePos = EdgeFollow.advanceCursor(
            from: corrected,
            delta: .zero,
            displayBounds: activeDisplayRect
        )
        applyEdgeFollow()
        updateCursorDot()
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

    // Projects cursorSourcePos into the view coordinate space and
    // positions cursorDotView there. Called on every cursor delta and
    // on zoom transitions so the dot tracks both finger movement and
    // pinch-zoom viewport shifts without waiting for a video round-trip.
    func updateCursorDot() {
        guard let dot = cursorDotView,
              let scroll = sinkScrollView,
              let pos = cursorSourcePos,
              activeDisplayRect.width > 0,
              activeDisplayRect.height > 0,
              scroll.bounds.width > 0 else {
            cursorDotView?.isHidden = true
            return
        }
        let fitScale = min(
            scroll.bounds.width / activeDisplayRect.width,
            scroll.bounds.height / activeDisplayRect.height
        )
        let padX = (scroll.bounds.width - activeDisplayRect.width * fitScale) / 2
        let padY = (scroll.bounds.height - activeDisplayRect.height * fitScale) / 2
        // Position in sinkView coords (unaffected by zoom).
        let sinkX = padX + pos.x * fitScale
        let sinkY = padY + pos.y * fitScale
        // Scale up by zoom and subtract the scroll offset to get viewport coords.
        let vpX = sinkX * scroll.zoomScale - scroll.contentOffset.x
        let vpY = sinkY * scroll.zoomScale - scroll.contentOffset.y
        // Mirror the Mac when it hides its cursor (e.g. fullscreen video).
        if cursorHidden {
            dot.isHidden = true
            return
        }
        // Anchor the cursor hotspot on the predicted point. The drawn-arrow
        // fallback has a tip hotspot at (0, 0); a mirrored image carries its
        // hotspot as fractions of the render size, so subtract that offset.
        let size = cursorRenderSize
        let hotX = cursorHotspotFrac.x * size.width
        let hotY = cursorHotspotFrac.y * size.height
        dot.frame = CGRect(
            x: scroll.frame.minX + vpX - hotX,
            y: scroll.frame.minY + vpY - hotY,
            width: size.width,
            height: size.height
        )
        dot.isHidden = false
    }

    public func scrollViewDidZoom(_ scrollView: UIScrollView) {
        guard scrollView === sinkScrollView else { return }
        updateCursorDot()
    }

    public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        guard scrollView === sinkScrollView, scrollView.zoomScale > 1.0 else { return }
        isManualViewportPanActive = true
        // Drop any stale retarget so a queued cursorSet can't fight the reconcile.
        pendingCursorRetarget = nil
        panFollowActive = false
        panFollowAnchor = nil
        lastSentPanFollowHostPoint = nil
        finishPanFollowEdgePush()
        lastPanFollowGestureTranslation = scrollView.panGestureRecognizer.translation(in: scrollView)
        // Hold the dot's current viewport position fixed for the gesture; the
        // content slides under it and we reproject to the source now beneath it.
        if let source = cursorSourcePos,
           let anchor = PointerRetargeting.viewportPoint(
               forSource: source,
               displayBounds: activeDisplayRect,
               sinkViewSize: scrollView.bounds.size,
               zoomScale: scrollView.zoomScale,
               contentOffset: scrollView.contentOffset) {
            panFollowAnchor = anchor
            panFollowActive = true
            PanFollowDiagnostics.log(
                "begin zoom=\(scrollView.zoomScale) offset=\(scrollView.contentOffset) contentSize=\(scrollView.contentSize) bounds=\(scrollView.bounds.size) source=\(source) anchor=\(anchor)"
            )
        } else {
            PanFollowDiagnostics.log(
                "begin-missing-anchor zoom=\(scrollView.zoomScale) offset=\(scrollView.contentOffset) source=\(String(describing: cursorSourcePos)) displayRect=\(activeDisplayRect)"
            )
        }
    }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === sinkScrollView, panFollowActive,
              let anchor = panFollowAnchor else { return }
        let pan = scrollView.panGestureRecognizer
        let rawTranslation = pan.translation(in: scrollView)
        let rawVelocity = pan.velocity(in: scrollView)
        let maxOffset = CGPoint(
            x: max(0, scrollView.contentSize.width - scrollView.bounds.width),
            y: max(0, scrollView.contentSize.height - scrollView.bounds.height)
        )
        PanFollowDiagnostics.log(
            "scroll offset=\(scrollView.contentOffset) max=\(maxOffset) translation=\(rawTranslation) velocity=\(rawVelocity) priorCursor=\(String(describing: cursorSourcePos)) priorAxes=\(panFollowEdgeAxes.rawValue) lastSent=\(String(describing: lastSentPanFollowHostPoint))"
        )
        let stepState = PanFollowStepState(
            cursorSourcePoint: cursorSourcePos,
            lastSentHostPoint: lastSentPanFollowHostPoint,
            edgeAxes: panFollowEdgeAxes,
            lastGestureTranslation: lastPanFollowGestureTranslation
        )
        let stepInput = PanFollowStepInput(
            anchorViewportPoint: anchor,
            desktopState: lastDesktopState,
            displayId: activeDisplayIdMirror,
            displayBounds: activeDisplayRect,
            sinkViewSize: scrollView.bounds.size,
            zoomScale: scrollView.zoomScale,
            contentOffset: scrollView.contentOffset,
            contentSize: scrollView.contentSize,
            viewportSize: scrollView.bounds.size,
            panTranslation: rawTranslation,
            panVelocity: rawVelocity
        )
        guard let step = PointerRetargeting.panFollowStep(
            state: stepState,
            input: stepInput
        ) else {
            PanFollowDiagnostics.log("step-nil activeDisplay=\(String(describing: activeDisplayIdMirror)) displayRect=\(activeDisplayRect) statePresent=\(lastDesktopState != nil)")
            return
        }

        cursorSourcePos = step.state.cursorSourcePoint
        lastSentPanFollowHostPoint = step.state.lastSentHostPoint
        panFollowEdgeAxes = step.state.edgeAxes
        lastPanFollowGestureTranslation = step.state.lastGestureTranslation
        PanFollowDiagnostics.log(
            "step cursor=\(String(describing: step.state.cursorSourcePoint)) axes=\(step.state.edgeAxes.rawValue) retarget=\(String(describing: step.cursorRetarget?.hostPoint)) edgeFrames=\(step.edgeGestureFrames.map { $0.phase })"
        )
        updateCursorDot()

        if let retarget = step.cursorRetarget {
            PanFollowDiagnostics.log(
                "send cursorSet display=\(retarget.displayId) host=\(retarget.hostPoint) source=\(retarget.sourcePoint)"
            )
            sendInput(.cursorSet(
                displayId: retarget.displayId,
                x: Float(retarget.hostPoint.x),
                y: Float(retarget.hostPoint.y)))
        }
        applyPanFollowEdgeFrames(step.edgeGestureFrames)
    }

    public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        guard scrollView === sinkScrollView else { return }
        // Freeze at finger-lift: ignore momentum/bounce frames so the cursor
        // holds where the user aimed it (this is a pointing gesture).
        panFollowActive = false
        finishPanFollowEdgePush()
        if !decelerate {
            finishManualViewportPan(scrollView)
        }
    }

    public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        guard scrollView === sinkScrollView else { return }
        finishManualViewportPan(scrollView)
    }

    func finishManualViewportPan(_ scrollView: UIScrollView) {
        guard isManualViewportPanActive else { return }
        isManualViewportPanActive = false
        // No viewport-center snap: the continuous reconcile has already kept the
        // host cursor under the dot, so a center cursorSet would jump it.
        panFollowActive = false
        panFollowAnchor = nil
        lastSentPanFollowHostPoint = nil
        finishPanFollowEdgePush()
        lastPanFollowGestureTranslation = nil
    }

    private func finishPanFollowEdgePush() {
        guard !panFollowEdgeAxes.isEmpty else { return }
        gestureTranslator.processPan(
            state: .ended,
            translation: .zero,
            velocity: .zero
        )
        panFollowEdgeAxes = []
    }

    private func applyPanFollowEdgeFrames(_ frames: [PanFollowEdgeGestureFrame]) {
        for frame in frames {
            let state: UIGestureRecognizer.State
            switch frame.phase {
            case .began:
                state = .began
            case .changed:
                state = .changed
            case .ended:
                state = .ended
            }
            PanFollowDiagnostics.log(
                "edge-frame phase=\(frame.phase) translation=\(frame.translation) velocity=\(frame.velocity) currentAxes=\(panFollowEdgeAxes.rawValue)"
            )
            gestureTranslator.processPan(
                state: state,
                translation: frame.translation,
                velocity: frame.velocity
            )
        }
    }
}
