import CoreGraphics

enum DesktopWindowScreenPlacement {
    static func constrained(_ frame: CGRect, within visibleFrames: [CGRect]) -> CGRect {
        guard !visibleFrames.isEmpty else { return frame }
        let target = visibleFrames.max { lhs, rhs in
            intersectionArea(lhs, frame) < intersectionArea(rhs, frame)
        } ?? visibleFrames[0]
        let width = min(frame.width, target.width)
        let height = min(frame.height, target.height)
        return CGRect(
            x: min(max(frame.minX, target.minX), target.maxX - width),
            y: min(max(frame.minY, target.minY), target.maxY - height),
            width: width,
            height: height
        )
    }

    private static func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        let intersection = lhs.intersection(rhs)
        guard !intersection.isNull else { return 0 }
        return intersection.width * intersection.height
    }
}
