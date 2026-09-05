import CoreGraphics
import Foundation

/// Remembers where the viewer was looking, so rebuilding the app does not throw the zoom away.
///
/// Every rebuild kills the process, which destroys the virtual display and creates a new one, so without
/// this each iteration dumps you back at the whole canvas and you have to find your place again.
struct ViewportStore {
    private static let key = "viewport"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func save(_ viewport: Viewport) {
        defaults.set(Self.encode(viewport), forKey: Self.key)
    }

    /// The remembered visible rect, or nil when nothing was stored, it was written for a canvas of a
    /// different size, or it does not describe a rect that could be looked at.
    func load(canvas: CGSize) -> CGRect? {
        Self.decode(defaults.array(forKey: Self.key) as? [Double], canvas: canvas)
    }

    /// Canvas size travels with the rect: a stored view of a 7680-wide canvas means nothing once the app
    /// is started at another size, and restoring it would put the viewer somewhere the canvas does not go.
    static func encode(_ viewport: Viewport) -> [Double] {
        [
            viewport.canvas.width, viewport.canvas.height,
            viewport.visible.minX, viewport.visible.minY,
            viewport.visible.width, viewport.visible.height,
        ]
    }

    static func decode(_ values: [Double]?, canvas: CGSize) -> CGRect? {
        guard let values, values.count == 6,
              values[0] == canvas.width, values[1] == canvas.height
        else { return nil }
        let rect = CGRect(x: values[2], y: values[3], width: values[4], height: values[5])
        guard rect.width.isFinite, rect.height.isFinite,
              rect.width >= Viewport.minVisibleWidth, rect.width <= canvas.width,
              rect.minX >= 0, rect.minY >= 0,
              rect.maxX <= canvas.width + 0.5, rect.maxY <= canvas.height + 0.5
        else { return nil }
        return rect
    }
}
