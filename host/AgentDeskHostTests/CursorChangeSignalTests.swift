import Foundation
import Testing

@testable import AgentDeskHost

struct CursorChangeSignalTests {
    // Smoke test / canary for the private CGSCurrentCursorSeed binding. If a future macOS
    // renames or drops the symbol, symbolResolved flips to false and this fails, the same
    // role SpacesProviderTests plays for its SkyLight binding. Seed-bumps-on-cursor-change
    // is inherently live/HITL (a headless test cannot own the system cursor) and is covered
    // by the Task 4 paired-session verification, so here we assert only resolution and that
    // an idle read is stable (not garbage that varies per call).
    @Test func systemSeedSymbolResolvesAndIdleReadIsStable() {
        guard SystemCursorChangeSignal.symbolResolved else {
            Issue.record("CGSCurrentCursorSeed did not resolve; cursor-seed binding likely broken")
            return
        }
        let signal = SystemCursorChangeSignal()
        let a = signal.currentSeed()
        let b = signal.currentSeed()
        // The cursor cannot change between two back-to-back reads, so the seed must match.
        #expect(a == b)
    }
}
