import AppKit

/// The app's colour theme — one source of truth so accent surfaces (the active-tab
/// underline, row selection, the active workspace row, the SCM badge) all read as the same
/// colour instead of mixing the system blue with one-off tints. We use our own teal accent
/// rather than `controlAccentColor` (which follows the user's system blue) so the look is
/// deliberately ours.
public enum AppTheme {
    /// The accent: a deep teal, dark enough for white text to stay legible on top of it.
    public static let accent = NSColor(srgbRed: 0.0, green: 0.42, blue: 0.46, alpha: 1)

    /// Standing fill for an active workspace row.
    public static let activeFill = accent.withAlphaComponent(0.85)

    /// A hovered active row reads a touch stronger.
    public static let activeHoverFill = accent

    /// Text colour that stays legible on top of an accent fill.
    public static let onAccent = NSColor.white
}
