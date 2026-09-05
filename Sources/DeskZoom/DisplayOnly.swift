import CoreGraphics
import Darwin
import Foundation

/// Holds a virtual display open and does nothing else.
///
/// The display lives as long as this process does, so this never returns. That is the whole
/// program: a session that wants a big desktop runs one of these, and whatever is going to look at
/// the desktop -- a capture stream, another machine, nothing at all -- is somebody else's concern.
///
/// Written to stdout rather than an alert, because the caller is a shell and there may be no
/// desktop here worth putting a window on.
func runDisplayOnly(config: DeskZoomConfig) -> Never {
    // Line buffered, because this reports progress and then blocks for as long as the display
    // lives. Left to the default, stdout redirected to a file holds every line until the buffer
    // fills, so a shell watching the log sees nothing at all from a process that is working.
    setvbuf(stdout, nil, _IOLBF, 0)
    let display: VirtualDisplay
    do {
        display = try VirtualDisplay(
            width: config.width, height: config.height,
            name: "DeskZoom \(config.width)x\(config.height)"
        )
    } catch {
        FileHandle.standardError.write("DeskZoom: \(error)\n".data(using: .utf8)!)
        exit(1)
    }

    // macOS may show a chooser before the display comes online, and the answer is not ours to give,
    // so this waits rather than timing out. Reported once so a shell can tell waiting from hung.
    print("display \(display.displayID) created, waiting for it to come online")
    var waited = 0
    while !isOnline(display.displayID) {
        usleep(200_000)
        waited += 1
        // Never gives up -- macOS may be waiting on a chooser only the user can answer -- but says
        // so, because a silent wait and a wedge look identical from outside.
        if waited % 25 == 0 {
            print("still waiting after \(waited / 5)s; \(activeDisplayCount()) display(s) active")
        }
    }

    do {
        try display.selectDeclaredMode()
    } catch {
        FileHandle.standardError.write("DeskZoom: \(error)\n".data(using: .utf8)!)
        exit(1)
    }

    let bounds = CGDisplayBounds(display.displayID)
    print("display \(display.displayID) online: \(Int(bounds.width))x\(Int(bounds.height)) pt, "
        + "\(CGDisplayPixelsWide(display.displayID))x\(CGDisplayPixelsHigh(display.displayID)) px")
    print("holding it open; end this process to remove it")
    fflush(stdout)

    // Nothing to service, so this parks rather than spinning a run loop.
    while true {
        sleep(3600)
    }
}

private func activeDisplayCount() -> Int {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return 0 }
    return Int(count)
}

private func isOnline(_ displayID: CGDirectDisplayID) -> Bool {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return false }
    return ids.prefix(Int(count)).contains(displayID)
}
