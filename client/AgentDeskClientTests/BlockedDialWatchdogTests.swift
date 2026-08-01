import Foundation
import Testing

@testable import AgentDeskClient

@Suite struct BlockedDialWatchdogTests {
    // The reason this type exists. A blocked connection re-reports its block repeatedly, so an
    // arm that restarted the deadline each time would never let it elapse -- and a bound that
    // never fires is indistinguishable from having no bound at all.
    @Test func repeatedBlocksKeepTheFirstDeadline() {
        let watchdog = BlockedDialWatchdog()
        var deadlinesCreated = 0
        let make: () -> Task<Void, Never> = {
            deadlinesCreated += 1
            return Task {}
        }

        watchdog.arm(make)
        watchdog.arm(make)
        watchdog.arm(make)

        #expect(deadlinesCreated == 1)
        #expect(watchdog.isArmed)
    }

    // Leaving the block has to clear it, or a dial that stalls, recovers, and stalls again
    // inherits a deadline measured from the first stall.
    @Test func leavingTheBlockAllowsANewDeadline() {
        let watchdog = BlockedDialWatchdog()
        var deadlinesCreated = 0
        let make: () -> Task<Void, Never> = {
            deadlinesCreated += 1
            return Task {}
        }

        watchdog.arm(make)
        watchdog.disarm()
        #expect(!watchdog.isArmed)

        watchdog.arm(make)
        #expect(deadlinesCreated == 2)
    }

    // Every terminal state disarms whether or not the dial ever blocked, so the common call is
    // the one on a watchdog that was never armed.
    @Test func disarmingAnUnarmedWatchdogIsHarmless() {
        let watchdog = BlockedDialWatchdog()
        watchdog.disarm()
        watchdog.disarm()
        #expect(!watchdog.isArmed)
    }

    @Test func armedDeadlineIsCancelledOnDisarm() async {
        let watchdog = BlockedDialWatchdog()
        let started = AsyncGate()
        let deadline = Task {
            await started.open()
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
        watchdog.arm { deadline }
        await started.wait()

        watchdog.disarm()
        _ = await deadline.value

        #expect(deadline.isCancelled)
    }
}

/// One-shot signal so the test can wait for the deadline task to actually start before
/// cancelling it, rather than racing it with a sleep.
private actor AsyncGate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        guard !opened else { return }
        opened = true
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }

    func wait() async {
        guard !opened else { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}
