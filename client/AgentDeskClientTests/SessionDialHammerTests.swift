import Foundation
import Testing

@testable import AgentDeskClient

@Suite @MainActor struct SessionDialHammerTests {
    private struct OtherFailure: Error, Equatable {}

    /// All mutable state the scripted dials touch, in one reference type.
    ///
    /// A class rather than captured `var`s because the closures cross into `SessionDialer`'s
    /// isolation, and a captured mutable local can never be sendable however the suite is
    /// annotated. Unchecked is honest here: every test drives its dials sequentially on one
    /// task, so there is no concurrency for a lock to protect against.
    private final class Probe: @unchecked Sendable {
        var ms = 0
        var attempts = 0
        var abandonments: [(afterMs: Int, attempt: Int)] = []

        /// One swing that consumes `ms` on the clock and reports the path still asleep.
        func sleepingSwing(costMs: Int = 1_500) throws -> String {
            attempts += 1
            ms += costMs
            throw SessionConnectionSlow(afterMs: costMs)
        }
    }

    // The measurement this exists for: the path is ASLEEP at cold start, not broken, and once
    // it wakes a dial connects in 292ms. Waiting only notices the wake-up when the wait
    // expires; hammering notices within one bound of it happening.
    @Test func itKeepsSwingingUntilTheSleepingPathWakes() async throws {
        let probe = Probe()

        let result: String = try await SessionDialer.hammeringUntilReady(
            budgetMs: 12_000,
            nowMs: { probe.ms },
            dial: {
                guard probe.attempts >= 3 else { return try probe.sleepingSwing() }
                probe.attempts += 1
                return "awake"
            },
            onAbandon: { probe.abandonments.append(($0.afterMs, $1)) }
        )

        #expect(result == "awake")
        #expect(probe.attempts == 4)
        #expect(probe.abandonments.map(\.attempt) == [1, 2, 3])
    }

    @Test func aDialThatComesUpFirstTimeIsTheOnlyOneRun() async throws {
        let probe = Probe()

        let result: String = try await SessionDialer.hammeringUntilReady(
            budgetMs: 12_000,
            nowMs: { probe.ms },
            dial: {
                probe.attempts += 1
                return "up"
            },
            onAbandon: { probe.abandonments.append(($0.afterMs, $1)) }
        )

        #expect(result == "up")
        #expect(probe.attempts == 1)
        #expect(probe.abandonments.isEmpty)
    }

    // The budget is what stops an endless hammer: past it the abandonment escapes to the
    // reconnect loop, which re-checks the path before trying again.
    @Test func itStopsSwingingOnceTheBudgetIsSpent() async {
        let probe = Probe()
        var thrown: Error?

        do {
            let _: String = try await SessionDialer.hammeringUntilReady(
                budgetMs: 5_000,
                nowMs: { probe.ms },
                dial: { try probe.sleepingSwing() },
                onAbandon: { probe.abandonments.append(($0.afterMs, $1)) }
            )
        } catch {
            thrown = error
        }

        #expect(thrown is SessionConnectionSlow)
        // Four swings reach 6000ms, the first to land past a 5000ms budget.
        #expect(probe.attempts == 4)
        #expect(probe.abandonments.map(\.attempt) == [1, 2, 3, 4])
    }

    // Backoff belongs to the reconnect loop above this. Hammering through a real failure would
    // machine-gun a host that is genuinely down.
    @Test func anyOtherFailureIsAnAnswerAndStopsTheHammer() async {
        let probe = Probe()
        var thrown: Error?

        do {
            let _: String = try await SessionDialer.hammeringUntilReady(
                budgetMs: 12_000,
                nowMs: { probe.ms },
                dial: {
                    probe.attempts += 1
                    throw OtherFailure()
                },
                onAbandon: { probe.abandonments.append(($0.afterMs, $1)) }
            )
        } catch {
            thrown = error
        }

        #expect(thrown is OtherFailure)
        #expect(probe.attempts == 1)
        #expect(probe.abandonments.isEmpty)
    }

    @Test func theAbandonmentSaysWhichBoundFiredAndAfterHowLong() {
        #expect(
            SessionConnectionSlow(afterMs: 1_500).description
                == "session connection was still not ready after 1500ms; redialing"
        )
    }
}
