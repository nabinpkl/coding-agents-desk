import Foundation
import os

/// A one-slot, sticky wake signal.
///
/// Sticky is the whole requirement. A signal raised while nobody is waiting is REMEMBERED, so
/// the next `wait()` returns at once instead of blocking until the following signal. A
/// non-sticky latch loses precisely the edge nobody happened to be listening for, which is the
/// entire bug class the supervisor exists to remove -- it would reproduce it one layer down.
@MainActor
final class SessionDialLatch {
    private var signalled = false
    private var waiter: CheckedContinuation<Void, Never>?
    /// Bumped every time a wait completes, so a timeout task that fires after its wait already
    /// returned by some other route is ignored instead of leaving a spurious signal behind.
    private var generation: UInt64 = 0

    func signal() {
        if let waiter {
            self.waiter = nil
            waiter.resume()
            return
        }
        signalled = true
    }

    func wait() async {
        if signalled {
            signalled = false
            generation &+= 1
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiter = continuation
        }
        generation &+= 1
    }

    /// Wait for a signal or for `ms` to elapse, whichever lands first.
    func wait(orAfterMs ms: Int) async {
        if signalled {
            signalled = false
            generation &+= 1
            return
        }
        let mine = generation
        let sleeper = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000)
            guard !Task.isCancelled, let self, self.generation == mine else { return }
            self.signal()
        }
        await wait()
        sleeper.cancel()
    }
}

/// The single owner of "should this client be dialing a session, and when".
///
/// It replaces a per-trigger task plus a generation counter plus a cancel helper plus a delayed
/// nudge, all of which existed because twelve call sites each had to remember to start the work.
/// Every one of the client's reconnect bugs was one of those sites forgetting. Here there is one
/// long-lived loop; callers change an input and signal, and the loop decides.
///
/// It is deliberately ignorant of pairing, transports, and views: `inputs` reads the world,
/// `dial` performs one attempt, `onFailure` classifies what went wrong. That keeps the loop and
/// its backoff testable against a fake dial, which is where the correctness actually lives.
@MainActor
final class SessionSupervisor {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "session")
    private let latch = SessionDialLatch()
    /// Reads the four environment fields. `lastOutcome` is deliberately not among them; see
    /// `currentInputs`.
    private let environment: @MainActor () -> SessionDialInputs
    private let dial: @MainActor () async throws -> Void
    private let onFailure: @MainActor (Error) -> SessionDialOutcome
    /// The two task handles, held outside the actor so `stop()` can be called from a
    /// `deinit`, which is nonisolated. `Task.cancel()` is itself safe to call from anywhere;
    /// only reading and writing the stored handles needs the lock.
    private let handles = SessionSupervisorTaskHandles()
    /// Read back into `inputs()` by the owner, so the policy sees it without the supervisor
    /// having to thread it through every call.
    private(set) var lastOutcome: SessionDialOutcome = .clean

    /// The environment as the owner sees it, with the rung the supervisor owns folded in.
    private func currentInputs() -> SessionDialInputs {
        var inputs = environment()
        inputs.lastOutcome = lastOutcome
        return inputs
    }

    init(
        environment: @escaping @MainActor () -> SessionDialInputs,
        dial: @escaping @MainActor () async throws -> Void,
        onFailure: @escaping @MainActor (Error) -> SessionDialOutcome
    ) {
        self.environment = environment
        self.dial = dial
        self.onFailure = onFailure
    }

    func start() {
        guard !handles.hasLoop else { return }
        handles.loop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                switch SessionDialPolicy.plan(for: self.currentInputs()) {
                case .idle:
                    await self.latch.wait()
                case .backoff(let ms):
                    await self.latch.wait(orAfterMs: ms)
                case .dial:
                    await self.runDial()
                }
            }
        }
    }

    /// Stops the loop for good. Only teardown calls this: BACKGROUNDING MUST NOT, because a
    /// supervisor that is cancelled when the app leaves the foreground is a supervisor that is
    /// not there to notice it coming back -- which is the original bug, rebuilt. Backgrounding
    /// closes the gate instead, and the loop parks on the latch.
    nonisolated func stop() {
        handles.cancelAll()
    }

    /// An input changed. Wakes the loop, and cancels a dial in flight if the change means the
    /// client is no longer allowed to hold a session at all.
    func signal() {
        if let inFlight = handles.inFlight, !SessionDialPolicy.isAllowed(currentInputs()) {
            inFlight.cancel()
        }
        latch.signal()
    }

    /// Dial now rather than serving out a backoff: an explicit human act (tapping Connect,
    /// retrying from the dictation handoff) should not wait behind a rung earned by a machine
    /// failure that the human may well have just fixed.
    func requestImmediateDial() {
        lastOutcome = .clean
        signal()
    }

    /// ADR-0104's verdict, reported from outside because the silence clock belongs to the
    /// session rather than to any one attempt.
    func noteUnreachable() {
        lastOutcome = .unreachable
    }

    private func runDial() async {
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.dial()
                // A success clears the rung, so the NEXT failure starts from the short delay
                // and a carrier loss on a healthy session re-dials immediately.
                self.lastOutcome = .clean
            } catch is CancellationError {
                // The gate closed under us. The loop re-reads live inputs and parks; the rung
                // is deliberately untouched, because nothing was learned about the host.
                self.logger.notice("session dial cancelled by a closed gate")
            } catch {
                self.lastOutcome = self.onFailure(error)
            }
        }
        handles.inFlight = task
        await task.value
        handles.inFlight = nil
    }
}

/// Task handles that outlive their actor's isolation, so teardown can reach them from a
/// nonisolated `deinit`.
private final class SessionSupervisorTaskHandles: @unchecked Sendable {
    private let lock = NSLock()
    private var storedLoop: Task<Void, Never>?
    private var storedInFlight: Task<Void, Never>?

    var hasLoop: Bool {
        lock.lock()
        defer { lock.unlock() }
        return storedLoop != nil
    }

    var loop: Task<Void, Never>? {
        get { lock.lock(); defer { lock.unlock() }; return storedLoop }
        set { lock.lock(); storedLoop = newValue; lock.unlock() }
    }

    var inFlight: Task<Void, Never>? {
        get { lock.lock(); defer { lock.unlock() }; return storedInFlight }
        set { lock.lock(); storedInFlight = newValue; lock.unlock() }
    }

    func cancelAll() {
        lock.lock()
        let loop = storedLoop
        let inFlight = storedInFlight
        storedLoop = nil
        storedInFlight = nil
        lock.unlock()
        inFlight?.cancel()
        loop?.cancel()
    }
}
