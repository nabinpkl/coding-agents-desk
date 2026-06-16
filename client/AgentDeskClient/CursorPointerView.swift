import UIKit

// ADR-0009 local cursor overlay. Renders a macOS-style arrow pointer
// instead of a plain dot so the predicted cursor reads as a cursor and
// stays easy to spot against busy desktop video. The arrow tip is the
// hotspot: it sits at the view's (0, 0), so the EdgeFollow projection
// positions the view origin at the cursor point rather than centring a
// circle on it.
final class CursorPointerView: UIView {
    // Logical pointer size in points. Larger than the old 12pt dot so it
    // reads clearly when the video is downscaled or busy.
    static let pointerSize = CGSize(width: 8, height: 12)

    private let glowLayer = CAShapeLayer()
    private let arrowLayer = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear

        let path = Self.arrowPath(size: Self.pointerSize).cgPath

        // Glow sits behind: bright, blurred halo with no crisp edge so the
        // pointer is findable at a glance even over light content.
        glowLayer.path = path
        glowLayer.fillColor = UIColor.white.cgColor
        glowLayer.shadowColor = UIColor.systemBlue.cgColor
        glowLayer.shadowRadius = 9
        glowLayer.shadowOpacity = 0.95
        glowLayer.shadowOffset = .zero
        layer.addSublayer(glowLayer)

        // Crisp white arrow with a dark outline so it holds contrast on any
        // background. A tight black drop shadow grounds it on the video.
        arrowLayer.path = path
        arrowLayer.fillColor = UIColor.white.cgColor
        arrowLayer.strokeColor = UIColor.black.withAlphaComponent(0.85).cgColor
        arrowLayer.lineWidth = 1.0
        arrowLayer.lineJoin = .round
        arrowLayer.shadowColor = UIColor.black.cgColor
        arrowLayer.shadowRadius = 1.5
        arrowLayer.shadowOpacity = 0.5
        arrowLayer.shadowOffset = .zero
        layer.addSublayer(arrowLayer)

        self.frame = CGRect(origin: .zero, size: Self.pointerSize)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // Classic macOS arrow outline on an 11x18 reference grid, tip at the
    // origin, scaled to `size`. The point order traces the tip, the left
    // edge, the notch, the tail barb and back up to the right shoulder.
    private static func arrowPath(size: CGSize) -> UIBezierPath {
        let sx = size.width / 11.0
        let sy = size.height / 18.0
        let pts: [(CGFloat, CGFloat)] = [
            (0, 0), (0, 16), (4, 12), (7, 18), (9, 17.2), (6, 11.2), (11, 11)
        ]
        let path = UIBezierPath()
        for (i, p) in pts.enumerated() {
            let cp = CGPoint(x: p.0 * sx, y: p.1 * sy)
            if i == 0 { path.move(to: cp) } else { path.addLine(to: cp) }
        }
        path.close()
        return path
    }
}
