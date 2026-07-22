import CoreGraphics

/// A client-local mapping between the authoritative logical terminal canvas
/// and the physical view that displays it. It never changes PTY dimensions.
struct PtyTerminalFitTransform: Equatable {
    static let minimumReadableScale: CGFloat = 0.75

    let canvasSize: CGSize
    let containerBounds: CGRect
    let scale: CGFloat
    let viewportOrigin: CGPoint
    let isCropped: Bool
    let visualFrame: CGRect

    init?(
        canvasSize: CGSize,
        containerBounds: CGRect,
        cursorPoint: CGPoint? = nil,
        previousViewportOrigin: CGPoint? = nil,
        initialViewportOrigin: CGPoint = .zero,
        cursorMargin: CGSize = .zero
    ) {
        guard canvasSize.width > 0, canvasSize.height > 0,
              containerBounds.width > 0, containerBounds.height > 0 else {
            return nil
        }
        let fitScale = min(
            containerBounds.width / canvasSize.width,
            containerBounds.height / canvasSize.height
        )
        let scale = max(fitScale, Self.minimumReadableScale)
        let visualSize = CGSize(width: canvasSize.width * scale, height: canvasSize.height * scale)
        let visibleCanvasSize = CGSize(
            width: min(canvasSize.width, containerBounds.width / scale),
            height: min(canvasSize.height, containerBounds.height / scale)
        )
        let maximumOrigin = CGPoint(
            x: max(0, canvasSize.width - visibleCanvasSize.width),
            y: max(0, canvasSize.height - visibleCanvasSize.height)
        )
        var viewportOrigin = previousViewportOrigin ?? initialViewportOrigin
        viewportOrigin.x = Self.clamp(viewportOrigin.x, upperBound: maximumOrigin.x)
        viewportOrigin.y = Self.clamp(viewportOrigin.y, upperBound: maximumOrigin.y)
        if let cursorPoint {
            viewportOrigin.x = Self.followedOrigin(
                current: viewportOrigin.x,
                cursor: cursorPoint.x,
                visibleExtent: visibleCanvasSize.width,
                canvasExtent: canvasSize.width,
                margin: cursorMargin.width
            )
            viewportOrigin.y = Self.followedOrigin(
                current: viewportOrigin.y,
                cursor: cursorPoint.y,
                visibleExtent: visibleCanvasSize.height,
                canvasExtent: canvasSize.height,
                margin: cursorMargin.height
            )
        }
        let isCropped = visualSize.width > containerBounds.width
            || visualSize.height > containerBounds.height
        self.canvasSize = canvasSize
        self.containerBounds = containerBounds
        self.scale = scale
        self.viewportOrigin = viewportOrigin
        self.isCropped = isCropped
        self.visualFrame = CGRect(
            x: visualSize.width <= containerBounds.width
                ? containerBounds.midX - visualSize.width / 2
                : containerBounds.minX - viewportOrigin.x * scale,
            y: visualSize.height <= containerBounds.height
                ? containerBounds.midY - visualSize.height / 2
                : containerBounds.minY - viewportOrigin.y * scale,
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

    private static func followedOrigin(
        current: CGFloat,
        cursor: CGFloat,
        visibleExtent: CGFloat,
        canvasExtent: CGFloat,
        margin: CGFloat
    ) -> CGFloat {
        guard visibleExtent < canvasExtent else { return 0 }
        let safeMargin = min(max(0, margin), visibleExtent / 2)
        var result = current
        if cursor < result + safeMargin {
            result = cursor - safeMargin
        } else if cursor > result + visibleExtent - safeMargin {
            result = cursor - visibleExtent + safeMargin
        }
        return clamp(result, upperBound: canvasExtent - visibleExtent)
    }

    private static func clamp(_ value: CGFloat, upperBound: CGFloat) -> CGFloat {
        min(max(0, value), upperBound)
    }
}
