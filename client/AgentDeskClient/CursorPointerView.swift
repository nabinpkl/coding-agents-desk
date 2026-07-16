import UIKit

// Local cursor overlay. Two render modes:
//
//  - Drawn arrow (default, pre-first-push fallback): a macOS-style arrow
//    whose tip is the hotspot at the view's (0, 0).
//  - Mirrored image: the actual host cursor PNG, applied via apply(...).
//    The host sends the hotspot as image fractions; the owning view
//    controller positions the frame so the hotspot lands on the cursor
//    point, so this view just renders centred in its own bounds.
//
// In both modes a blue glow sits behind the glyph so the predicted cursor
// is easy to spot against busy desktop video.
final class CursorPointerView: UIView {
    enum Presentation: Equatable {
        case confirmed
        case ghost
    }

    // Drawn-arrow fallback size in points. Small so it does not dominate.
    static let pointerSize = CGSize(width: 8, height: 12)
    // Mirrored host cursors render at their host point size times this
    // factor; raw host points render too large on the phone.
    static let mirrorRenderScale: CGFloat = 0.7

    private let glowLayer = CAShapeLayer()
    private let arrowLayer = CAShapeLayer()
    private let imageLayer = CALayer()
    private let ghostImageLayer = CALayer()
    private let ghostImageMaskLayer = CALayer()
    private var hasMirroredImage = false
    private(set) var presentation: Presentation = .confirmed

    var ghostVisualIsActive: Bool {
        guard presentation == .ghost else { return false }
        return hasMirroredImage
            ? !ghostImageLayer.isHidden && imageLayer.isHidden
            : arrowLayer.fillColor == UIColor.systemGray2.cgColor
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear

        let path = Self.arrowPath(size: Self.pointerSize).cgPath

        // Glow sits behind: bright, blurred halo with no crisp edge.
        glowLayer.path = path
        glowLayer.fillColor = UIColor.white.cgColor
        glowLayer.shadowColor = UIColor.systemBlue.cgColor
        glowLayer.shadowRadius = 9
        glowLayer.shadowOpacity = 0.95
        glowLayer.shadowOffset = .zero
        layer.addSublayer(glowLayer)

        // Crisp white arrow with a dark outline for contrast on any video.
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

        // Mirrored-image layer. Hidden until the first cursor frame; its
        // own shadow forms a glow following the cursor's alpha silhouette.
        imageLayer.isHidden = true
        imageLayer.shadowColor = UIColor.systemBlue.cgColor
        imageLayer.shadowRadius = 7
        imageLayer.shadowOpacity = 0.9
        imageLayer.shadowOffset = .zero
        imageLayer.contentsGravity = .resize
        layer.addSublayer(imageLayer)

        // A host cursor can be a full-colour custom image, so tintColor cannot
        // reliably make it grey. Render the same alpha silhouette as a mask
        // over a system-grey layer when the prediction becomes unconfirmed.
        ghostImageLayer.isHidden = true
        ghostImageLayer.backgroundColor = UIColor.systemGray2.cgColor
        ghostImageLayer.shadowColor = UIColor.systemGray.cgColor
        ghostImageLayer.shadowRadius = 5
        ghostImageLayer.shadowOpacity = 0.65
        ghostImageLayer.shadowOffset = .zero
        ghostImageLayer.mask = ghostImageMaskLayer
        ghostImageMaskLayer.contentsGravity = .resize
        layer.addSublayer(ghostImageLayer)

        self.frame = CGRect(origin: .zero, size: Self.pointerSize)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // Switch to mirroring the host cursor image at the given on-screen
    // size. The owning controller sets the view frame (and hotspot offset)
    // separately; here we just fill the bounds and toggle the layers.
    func apply(image: UIImage, renderSize: CGSize) {
        hasMirroredImage = true
        imageLayer.contents = image.cgImage
        imageLayer.shadowPath = nil
        ghostImageMaskLayer.contents = image.cgImage
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = CGRect(origin: .zero, size: renderSize)
        ghostImageLayer.frame = CGRect(origin: .zero, size: renderSize)
        ghostImageMaskLayer.frame = CGRect(origin: .zero, size: renderSize)
        CATransaction.commit()
        updatePresentation()
    }

    func setPresentation(_ presentation: Presentation) {
        guard self.presentation != presentation else { return }
        self.presentation = presentation
        updatePresentation()
    }

    private func updatePresentation() {
        let isGhost = presentation == .ghost
        if hasMirroredImage {
            imageLayer.isHidden = isGhost
            ghostImageLayer.isHidden = !isGhost
            glowLayer.isHidden = true
            arrowLayer.isHidden = true
            return
        }

        imageLayer.isHidden = true
        ghostImageLayer.isHidden = true
        glowLayer.isHidden = false
        arrowLayer.isHidden = false
        glowLayer.fillColor = (isGhost ? UIColor.systemGray4 : UIColor.white).cgColor
        glowLayer.shadowColor = (isGhost ? UIColor.systemGray : UIColor.systemBlue).cgColor
        glowLayer.shadowOpacity = isGhost ? 0.55 : 0.95
        arrowLayer.fillColor = (isGhost ? UIColor.systemGray2 : UIColor.white).cgColor
        arrowLayer.strokeColor = (isGhost
            ? UIColor.systemGray5
            : UIColor.black.withAlphaComponent(0.85)).cgColor
    }

    // Classic macOS arrow outline on an 11x18 reference grid, tip at the
    // origin, scaled to `size`.
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
