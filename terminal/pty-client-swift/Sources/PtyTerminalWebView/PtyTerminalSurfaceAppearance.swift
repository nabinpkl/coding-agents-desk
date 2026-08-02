#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// The terminal's own colours, for the native views that frame the web surface.
///
/// The web runtime follows the system appearance through `prefers-color-scheme` in
/// `Web/src/terminal.css`; these are the same `--surface` and `--chrome` tokens carried into AppKit
/// and UIKit so the frame around it flips with it. A fixed colour here reads as a black band around
/// a light-mode terminal, which is exactly what the web side stopped doing.
public enum PtyTerminalSurfaceAppearance {
    private static let lightSurface = (red: 1.0, green: 1.0, blue: 1.0)
    private static let darkSurface = (red: 11.0 / 255, green: 14.0 / 255, blue: 20.0 / 255)
    private static let lightChrome = (red: 242.0 / 255, green: 243.0 / 255, blue: 245.0 / 255)
    private static let darkChrome = (red: 23.0 / 255, green: 27.0 / 255, blue: 36.0 / 255)

    #if canImport(AppKit)
    /// The terminal viewport background.
    public static let surface = dynamicColor(named: "PtyTerminalSurface", light: lightSurface, dark: darkSurface)
    /// The tab strip, pane header and footer background.
    public static let chrome = dynamicColor(named: "PtyTerminalChrome", light: lightChrome, dark: darkChrome)

    private static func dynamicColor(
        named name: String,
        light: (red: Double, green: Double, blue: Double),
        dark: (red: Double, green: Double, blue: Double)
    ) -> NSColor {
        NSColor(name: NSColor.Name(name)) { appearance in
            let components = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: components.red, green: components.green, blue: components.blue, alpha: 1)
        }
    }

    /// A `CALayer` background colour does not re-resolve itself when the appearance changes, so
    /// layer-backed callers have to resolve against the view's current appearance and reapply.
    public static func resolved(_ color: NSColor, for appearance: NSAppearance) -> CGColor {
        var resolved = color.cgColor
        appearance.performAsCurrentDrawingAppearance { resolved = color.cgColor }
        return resolved
    }
    #elseif canImport(UIKit)
    /// The terminal viewport background.
    public static let surface = dynamicColor(light: lightSurface, dark: darkSurface)
    /// The tab strip, pane header and footer background.
    public static let chrome = dynamicColor(light: lightChrome, dark: darkChrome)

    private static func dynamicColor(
        light: (red: Double, green: Double, blue: Double),
        dark: (red: Double, green: Double, blue: Double)
    ) -> UIColor {
        UIColor { traits in
            let components = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: components.red, green: components.green, blue: components.blue, alpha: 1)
        }
    }
    #endif
}
