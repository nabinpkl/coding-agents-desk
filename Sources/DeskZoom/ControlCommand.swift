import CoreGraphics
import Foundation

/// One line of the control channel. The channel exists so the fake cursor can be driven from a shell:
/// there is no pointer device behind it, so something has to say where it is.
enum ControlCommand: Equatable {
    /// Put the fake cursor at a canvas point, in points from the canvas's top-left.
    case move(CGPoint)
    /// Put it at a fraction of the canvas, which is what a script that does not know the size can aim with.
    case moveFraction(CGPoint)
    /// Report what is under it, without touching anything.
    case describe
    /// Perform the accessibility action of whatever is under it. The real pointer does not move.
    case press
    case hide
    case status
    /// The ordinary windows on the canvas, numbered, so a script can aim without knowing coordinates.
    case windows
    /// Put the fake cursor in the middle of one of those windows.
    case moveWindow(Int)
    /// Scroll what is under the fake cursor to a fraction of its length along one axis.
    case scroll(CanvasFocus.ScrollAxis, CGFloat)
    /// Scroll it by a fraction of its length, positive downwards or rightwards.
    case scrollBy(CanvasFocus.ScrollAxis, CGFloat)
    /// Type text into the application under the fake cursor.
    case type(String)
    /// Press one key, with modifiers, in the application under the fake cursor.
    case key(KeyChord)
    case help

    static func parse(_ line: String) -> ControlCommand? {
        let fields = line.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let verb = fields.first?.lowercased() else { return nil }
        if verb == "type" {
            // The text is the rest of the line as written, inner spaces included; only the verb is a field.
            let text = line.drop(while: \.isWhitespace).dropFirst(fields[0].count).drop(while: \.isWhitespace)
            return text.isEmpty ? nil : .type(String(text))
        }
        if verb == "key" {
            guard fields.count == 2, let chord = KeyChord.parse(fields[1]) else { return nil }
            return .key(chord)
        }
        let numbers = fields.dropFirst().compactMap(Double.init)
        switch (verb, numbers.count) {
        case ("move", 2): return .move(CGPoint(x: numbers[0], y: numbers[1]))
        case ("move-fraction", 2): return .moveFraction(CGPoint(x: numbers[0], y: numbers[1]))
        case ("describe", 0): return .describe
        case ("press", 0): return .press
        case ("hide", 0): return .hide
        case ("status", 0): return .status
        case ("windows", 0): return .windows
        case ("move-window", 1): return .moveWindow(Int(numbers[0]))
        case ("scroll", 1): return .scroll(.vertical, CGFloat(numbers[0]))
        case ("scroll-by", 1): return .scrollBy(.vertical, CGFloat(numbers[0]))
        case ("scroll-x", 1): return .scroll(.horizontal, CGFloat(numbers[0]))
        case ("scroll-x-by", 1): return .scrollBy(.horizontal, CGFloat(numbers[0]))
        case ("help", 0): return .help
        default: return nil
        }
    }

    static let usage = """
        commands: move <x> <y> | move-fraction <fx> <fy> | move-window <n> | windows | describe | press \
        | scroll <fraction> | scroll-by <delta> | scroll-x <fraction> | scroll-x-by <delta> \
        | type <text> | key <chord> | hide | status | help
        keys: a-z 0-9 return tab space delete forward-delete escape up down left right home end \
        page-up page-down f1-f12 period comma minus equal slash backslash semicolon quote grave \
        left-bracket right-bracket, with modifiers cmd shift alt ctrl joined by +, as in cmd+shift+z
        """
}
