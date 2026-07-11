import CoreGraphics

/// Geometry policy for the free-sized app-owned editor window.
public enum EditorWindowFrame {
    public static let minimumSize = CGSize(width: 480, height: 320)

    /// First editor frame for a workspace with no remembered frame. The editor is free-sized after
    /// creation, but the initial position still respects any pinned shell bars represented by
    /// `slot`.
    public static func defaultFrame(in slot: CGRect) -> CGRect {
        guard !slot.isEmpty else { return .zero }
        let width = min(slot.width, max(720, slot.width * 0.78))
        let height = min(slot.height, max(480, slot.height * 0.78))
        return centeredRect(in: slot, size: CGSize(width: width, height: height)).integral
    }

    public static func isUsable(_ frame: CGRect) -> Bool {
        frame.origin.x.isFinite && frame.origin.y.isFinite
            && frame.width.isFinite && frame.height.isFinite
            && frame.width >= minimumSize.width
            && frame.height >= minimumSize.height
    }
}
