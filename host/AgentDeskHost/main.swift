import AppKit
import Darwin
import Foundation

// Single-instance guard. On first install, `launchctl bootstrap` plus
// RunAtLoad=true causes launchd to start a second copy alongside the
// open-spawned one. BSD flock on a marker file inside Application Support
// makes the second copy exit cleanly. The fd is intentionally leaked so
// the lock persists for the process lifetime; the OS releases it on exit.

do {
    try FileManager.default.createDirectory(
        at: Config.applicationSupportDirectory,
        withIntermediateDirectories: true
    )
    let lockPath = Config.applicationSupportDirectory
        .appendingPathComponent(".instance.lock", isDirectory: false)
        .path
    let fd = open(lockPath, O_CREAT | O_WRONLY, 0o600)
    if fd >= 0, flock(fd, LOCK_EX | LOCK_NB) != 0 {
        exit(0)
    }
} catch {
    // Best-effort; if the support dir is unavailable, fall through and
    // accept the small risk of a duplicate process rather than refusing
    // to start the user's first instance.
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
_ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
