import UIKit

// UIView that reports points up to `hitOutsets` outside its bounds as
// inside, so touches in the surrounding padding still hit-test to this
// view and reach its gesture recognizers. Visual layout is unchanged.
final class HitOutsetView: UIView {
    var hitOutsets: UIEdgeInsets = .zero

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let expanded = bounds.inset(by: UIEdgeInsets(
            top: -hitOutsets.top,
            left: -hitOutsets.left,
            bottom: -hitOutsets.bottom,
            right: -hitOutsets.right
        ))
        return expanded.contains(point)
    }
}
