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

    static func parse(_ line: String) -> ControlCommand? {
        let fields = line.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let verb = fields.first?.lowercased() else { return nil }
        let numbers = fields.dropFirst().compactMap(Double.init)
        switch (verb, numbers.count) {
        case ("move", 2): return .move(CGPoint(x: numbers[0], y: numbers[1]))
        case ("move-fraction", 2): return .moveFraction(CGPoint(x: numbers[0], y: numbers[1]))
        case ("describe", 0): return .describe
        case ("press", 0): return .press
        case ("hide", 0): return .hide
        case ("status", 0): return .status
        default: return nil
        }
    }

    static let usage = "commands: move <x> <y> | move-fraction <fx> <fy> | describe | press | hide | status"
}
