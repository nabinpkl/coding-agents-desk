import CoreGraphics
import Foundation

/// Prints every active display and exits.
///
/// Exists so a login session can be asked what it sees. A session created by Screen Sharing is given
/// synthesised displays rather than the physical ones, and nothing else on the system will say what
/// they are: System Settings is a GUI, `system_profiler` lists hardware, and the only honest answer
/// is whatever CoreGraphics tells a process running in that session.
func runListDisplays() -> Never {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    guard CGGetActiveDisplayList(16, &ids, &count) == .success else {
        FileHandle.standardError.write("DeskZoom: could not read the display list\n".data(using: .utf8)!)
        exit(1)
    }
    for id in ids.prefix(Int(count)) {
        let bounds = CGDisplayBounds(id)
        // Duplicates included, so the count reflects every mode a switch could reach, the same list
        // VirtualDisplay chooses from.
        let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
        let modes = (CGDisplayCopyAllDisplayModes(id, options) as? [CGDisplayMode])?.count ?? 0
        // The backing store, not `CGDisplayPixelsWide`, which answers in points on a Retina mode.
        let current = CGDisplayCopyDisplayMode(id)
        let pixels = "\(current?.pixelWidth ?? 0)x\(current?.pixelHeight ?? 0)"
        var tags: [String] = []
        if CGDisplayIsMain(id) != 0 { tags.append("main") }
        if CGDisplayIsBuiltin(id) != 0 { tags.append("built-in") }
        print("display \(id): \(Int(bounds.width))x\(Int(bounds.height)) pt at "
            + "\(Int(bounds.origin.x)),\(Int(bounds.origin.y)), "
            + "\(pixels) px, \(modes) mode(s)"
            + (tags.isEmpty ? "" : " [\(tags.joined(separator: ", "))]"))
    }
    print("\(count) display(s)")
    exit(0)
}
