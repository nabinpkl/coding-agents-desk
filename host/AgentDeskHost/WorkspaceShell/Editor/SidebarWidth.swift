import CoreGraphics

/// The shell-wide sidebar width preference. The value is stored as a plain number in
/// `WorkspaceStore`; this type owns the supported range and clamping rules.
public enum SidebarWidth {
    public static let defaultValue: CGFloat = 240
    public static let minimum: CGFloat = 220
    public static let maximum: CGFloat = 520
    public static let keyboardStep: CGFloat = 24

    public static func clamped(_ proposed: CGFloat, screenWidth: CGFloat? = nil) -> CGFloat {
        let upperBound = min(maximum, screenWidth ?? maximum)
        return min(max(proposed, min(minimum, upperBound)), upperBound)
    }
}
