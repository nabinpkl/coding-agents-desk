import Foundation
import os

// A cheap "did the cursor change?" signal, used to gate the expensive cursor-image
// fingerprint (TIFF/PNG encode + hash) in CursorMonitor. Detecting cursor changes by
// re-encoding + hashing the image every tick is what made CursorMonitor a steady CPU
// eater; the window server already maintains a monotonic seed that bumps on any cursor
// change, so reading that (a single int) and only fingerprinting when it moves is the
// TeamViewer/AnyDesk pattern.
//
// The seed source is a private window-server symbol, isolated here behind a protocol
// with an injectable fake (see CursorMonitor DI) and a live smoke test (the canary for
// private-API drift, mirroring SpacesProvider). Verified on macOS 26: CGSCurrentCursorSeed
// resolves from both SkyLight and CoreGraphics as a no-arg `() -> Int32`, and its value
// tracks real system-cursor changes.
protocol CursorChangeSignal: Sendable {
    // A value that changes whenever the system cursor changes. Callers compare it to the
    // previous read; equal means "no change, skip the expensive fingerprint". The absolute
    // value is meaningless, only equality across reads matters.
    func currentSeed() -> UInt64
}

// Same private-framework isolation shape as SpacesProvider's SkyLight struct: dlopen once,
// resolve the SLS-prefixed name first then the CGS alias, keep a typed function pointer.
private let cursorSeedFrameworkPath =
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"

private struct CursorSeedBinding {
    typealias CurrentCursorSeedFn = @convention(c) () -> Int32
    let currentCursorSeed: CurrentCursorSeedFn

    static let shared: CursorSeedBinding? = {
        guard let handle = dlopen(cursorSeedFrameworkPath, RTLD_NOW) else { return nil }
        guard let sym = dlsym(handle, "SLSCurrentCursorSeed")
            ?? dlsym(handle, "CGSCurrentCursorSeed")
        else { return nil }
        return CursorSeedBinding(
            currentCursorSeed: unsafeBitCast(sym, to: CurrentCursorSeedFn.self)
        )
    }()
}

// Production signal. If the private symbol cannot be resolved (a future macOS drops or
// renames it), currentSeed() returns a fixed sentinel so the gate reads "never changes"
// and CursorMonitor falls back entirely to its periodic heartbeat re-fingerprint -- cheap
// but less responsive, never crashing. The smoke test is the loud canary for that drift.
struct SystemCursorChangeSignal: CursorChangeSignal {
    private static let logger = Logger(subsystem: Config.launchAgentLabel, category: "cursor")
    // Resolved once; the log fires once at first use if the symbol is missing.
    private static let binding: CursorSeedBinding? = {
        let b = CursorSeedBinding.shared
        if b == nil {
            logger.error("CGSCurrentCursorSeed unresolved; cursor mirror falls back to heartbeat only")
        }
        return b
    }()

    func currentSeed() -> UInt64 {
        guard let binding = Self.binding else { return 0 }
        return UInt64(UInt32(bitPattern: binding.currentCursorSeed()))
    }

    // Test canary: did the private seed symbol resolve on this OS? A drift (Apple renames
    // or drops CGSCurrentCursorSeed) flips this to false and the smoke test fails loudly,
    // the same role SpacesProvider's live smoke test plays for its SkyLight binding.
    static var symbolResolved: Bool { binding != nil }
}
