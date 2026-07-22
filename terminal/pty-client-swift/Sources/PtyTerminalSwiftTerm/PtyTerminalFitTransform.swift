import CoreGraphics

/// A client-local mapping between the authoritative logical terminal canvas
/// and the physical view that displays it. It never changes PTY dimensions.
struct PtyTerminalFitTransform: Equatable {
    let canvasSize: CGSize
    let containerBounds: CGRect
    let scale: CGFloat
    let visualFrame: CGRect

    init?(canvasSize: CGSize, containerBounds: CGRect) {
        guard canvasSize.width > 0, canvasSize.height > 0,
              containerBounds.width > 0, containerBounds.height > 0 else {
            return nil
        }
        let scale = min(
            containerBounds.width / canvasSize.width,
            containerBounds.height / canvasSize.height
        )
        let visualSize = CGSize(width: canvasSize.width * scale, height: canvasSize.height * scale)
        self.canvasSize = canvasSize
        self.containerBounds = containerBounds
        self.scale = scale
        self.visualFrame = CGRect(
            x: containerBounds.midX - visualSize.width / 2,
            y: containerBounds.midY - visualSize.height / 2,
            width: visualSize.width,
            height: visualSize.height
        )
    }

    func canvasPoint(forContainerPoint point: CGPoint) -> CGPoint {
        CGPoint(
            x: (point.x - visualFrame.minX) / scale,
            y: (point.y - visualFrame.minY) / scale
        )
    }
}
