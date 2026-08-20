import Foundation
import Testing
import AgentDeskWire

/// The latch is small and it is the piece the whole design leans on: if a signal raised while
/// nobody is waiting can be lost, the supervisor reproduces the exact bug it replaced, one layer
/// down. These pin stickiness directly rather than through the loop.
@MainActor
struct SessionDialLatchTests {
    @Test func aSignalRaisedWithNoWaiterIsRemembered() async {
        let latch = SessionDialLatch()
        latch.signal()
        // Must return rather than block. A non-sticky latch hangs here forever.
        await latch.wait()
    }

    @Test func aSignalIsConsumedOnceNotReplayed() async {
        let latch = SessionDialLatch()
        latch.signal()
        await latch.wait()

        var returnedWithoutASignal = false
        let waiter = Task { @MainActor in
            await latch.wait()
            returnedWithoutASignal = true
        }
        // Give the waiter a chance to run and (correctly) block.
        await Task.yield()
        #expect(returnedWithoutASignal == false)
        latch.signal()
        await waiter.value
        #expect(returnedWithoutASignal)
    }

    @Test func aWaiterIsWokenBySignal() async {
        let latch = SessionDialLatch()
        let waiter = Task { @MainActor in await latch.wait() }
        await Task.yield()
        latch.signal()
        await waiter.value
    }

    @Test func aTimedWaitReturnsOnItsTimeout() async {
        let latch = SessionDialLatch()
        // No signal is ever sent; only the timeout can end this.
        await latch.wait(orAfterMs: 1)
    }

    @Test func aTimedWaitReturnsEarlyOnASignal() async {
        let latch = SessionDialLatch()
        latch.signal()
        // A ten-second rung with a signal already pending must not wait it out.
        await latch.wait(orAfterMs: 10_000)
    }
}

/// The loop, against a fake dial. What matters here is not that it dials, it is that it keeps
/// existing: parking on a closed gate and waking on the change that reopens it is the behaviour
/// twelve hand-written call sites used to approximate.
@MainActor
struct SessionSupervisorTests {
    /// Mutable world the test drives and the supervisor reads, standing in for the view
    /// controller's four properties.
    private final class World {
        var state: PairingClientState = .pairedDisconnected
        var disconnected = false
        var surface: ControlSurface = .control
        var foreground = true
        var dials = 0
        var failures = 0
        var shouldFail = false
    }

    private func makeSupervisor(
        _ world: World,
        onDial: (@MainActor () -> Void)? = nil
    ) -> SessionSupervisor {
        SessionSupervisor(
            environment: {
                SessionDialInputs(
                    state: world.state,
                    userRequestedDisconnect: world.disconnected,
                    surface: world.surface,
                    isForeground: world.foreground
                )
            },
            dial: {
                world.dials += 1
                onDial?()
                if world.shouldFail { throw PairingClientError.invalidState }
                world.state = .connected(ActiveSession(
                    sessionId: "s",
                    deviceFingerprint: DeviceFingerprint("d"),
                    establishedAt: 0
                ))
            },
            onFailure: { _ in
                world.failures += 1
                return .failed
            }
        )
    }

    /// Let the supervisor's loop run until it parks. Several yields because one dial is several
    /// suspension points (the latch, the dial task, the loop's next turn).
    private func settle(_ turns: Int = 12) async {
        for _ in 0..<turns { await Task.yield() }
    }

    @Test func itDialsWhenTheGateIsOpenAndTheStateIsDialable() async {
        let world = World()
        let supervisor = makeSupervisor(world)
        supervisor.start()
        defer { supervisor.stop() }
        await settle()
        #expect(world.dials == 1)
    }

    /// The bug this replaces, stated directly: a client that was backgrounded while it could
    /// have been dialing must dial when it comes back, with nobody having remembered to ask.
    @Test func aBackgroundedClientDialsWhenItReturns() async {
        let world = World()
        world.foreground = false
        let supervisor = makeSupervisor(world)
        supervisor.start()
        defer { supervisor.stop() }
        await settle()
        #expect(world.dials == 0, "a backgrounded client must not dial")

        world.foreground = true
        supervisor.signal()
        await settle()
        #expect(world.dials == 1, "returning to the foreground must dial with no explicit trigger")
    }

    /// The supervisor is never torn down by backgrounding, so a second cycle behaves like the
    /// first. A design that stopped the loop would pass the test above and fail this one.
    @Test func itSurvivesRepeatedBackgroundForegroundCycles() async {
        let world = World()
        let supervisor = makeSupervisor(world)
        supervisor.start()
        defer { supervisor.stop() }
        await settle()

        for cycle in 1...3 {
            world.foreground = false
            supervisor.signal()
            await settle()
            world.state = .pairedDisconnected
            world.foreground = true
            supervisor.signal()
            await settle()
            #expect(world.dials == cycle + 1, "cycle \(cycle) did not dial")
        }
    }

    @Test func aDeliberateDisconnectParksTheLoop() async {
        let world = World()
        world.disconnected = true
        let supervisor = makeSupervisor(world)
        supervisor.start()
        defer { supervisor.stop() }
        await settle()
        #expect(world.dials == 0)

        world.disconnected = false
        supervisor.signal()
        await settle()
        #expect(world.dials == 1)
    }

    /// Voice is fully on-device and must not wait on a host.
    @Test func theVoiceSurfaceParksTheLoop() async {
        let world = World()
        world.surface = .voice
        let supervisor = makeSupervisor(world)
        supervisor.start()
        defer { supervisor.stop() }
        await settle()
        #expect(world.dials == 0)

        world.surface = .control
        supervisor.signal()
        await settle()
        #expect(world.dials == 1)
    }

    /// A failure must not become a spin. Asserted as the RUNG rather than as a dial count,
    /// because a count raced against a one-second backoff is a test that fails on a busy
    /// machine rather than on a bug. `SessionDialPolicyTests` proves `.failed` does not dial.
    @Test func aFailureEarnsABackoffRung() async {
        let world = World()
        world.shouldFail = true
        let supervisor = makeSupervisor(world)
        supervisor.start()
        defer { supervisor.stop() }
        await settle()
        #expect(world.failures >= 1)
        #expect(supervisor.lastOutcome == .failed)
    }

    /// Tapping Connect should not sit behind a rung a machine failure earned.
    @Test func anImmediateDialRequestClearsTheRung() async {
        let world = World()
        world.shouldFail = true
        let supervisor = makeSupervisor(world)
        supervisor.start()
        defer { supervisor.stop() }
        await settle()
        #expect(supervisor.lastOutcome == .failed)

        world.shouldFail = false
        supervisor.requestImmediateDial()
        await settle()
        #expect(supervisor.lastOutcome == .clean)
        #expect(world.dials >= 2, "the request must produce another attempt, not wait out the rung")
    }

    /// A gate that closes mid-dial cancels it. Before the supervisor this was an explicit
    /// `cancelSessionAttempt()` that three call sites had to remember.
    @Test func aClosingGateCancelsTheDialInFlight() async {
        let world = World()
        var cancelled = false
        let supervisor = SessionSupervisor(
            environment: {
                SessionDialInputs(
                    state: world.state,
                    userRequestedDisconnect: world.disconnected,
                    surface: world.surface,
                    isForeground: world.foreground
                )
            },
            dial: {
                world.dials += 1
                do {
                    // Long enough that no scheduling delay can complete it: the only realistic
                    // way out is the cancellation this test is here to prove.
                    try await Task.sleep(nanoseconds: 600_000_000_000)
                } catch {
                    cancelled = true
                    throw error
                }
            },
            onFailure: { _ in .failed }
        )
        supervisor.start()
        defer { supervisor.stop() }
        await settle()
        #expect(world.dials == 1)

        world.foreground = false
        supervisor.signal()
        await settle()
        #expect(cancelled, "closing the gate must cancel the dial in flight")
    }
}
