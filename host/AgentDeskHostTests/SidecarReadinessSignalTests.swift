import Foundation
import Testing
@testable import AgentDeskHost

/// The readiness contract both sidecars depend on.
///
/// The bug this replaces: readiness was a plain `URL?` that callers sampled at the
/// instant of a request, so a consumer arriving during the launch window failed
/// against a sidecar that was about to answer. Every case here is a way that can
/// go wrong.
@Suite struct SidecarReadinessSignalTests {
    private func signal() -> SidecarReadinessSignal {
        SidecarReadinessSignal(label: "test.sidecar-readiness")
    }

    private let ready = URL(string: "http://127.0.0.1:7682")!

    @Test func aWaiterThatArrivesFirstIsWokenWhenTheSidecarPublishes() async {
        let readiness = signal()
        async let awaited = readiness.value(waitingUpTo: 10)
        #expect(readiness.current == nil, "nothing is published yet")
        readiness.publish(ready)
        #expect(await awaited == ready)
    }

    @Test func askingAfterTheSidecarIsUpDoesNotWait() async {
        let readiness = signal()
        readiness.publish(ready)
        let started = Date()
        #expect(await readiness.value(waitingUpTo: 30) == ready)
        #expect(Date().timeIntervalSince(started) < 1)
    }

    @Test func aWaiterSurvivesTheSidecarDyingAndIsWokenByTheRestart() async {
        // A crash-and-restart must NOT fail the waiters: the restart is precisely
        // what they are waiting for. Failing them here would recreate the original
        // bug one supervisor layer down.
        let readiness = signal()
        readiness.publish(ready)
        readiness.clear()
        #expect(readiness.current == nil)

        async let awaited = readiness.value(waitingUpTo: 10)
        try? await Task.sleep(for: .milliseconds(50))
        readiness.publish(ready)
        #expect(await awaited == ready)
    }

    @Test func stoppingReleasesEveryWaiterAtOnce() async {
        let readiness = signal()
        // A deliberately long bound, so returning quickly can only mean stop() did it.
        async let first = readiness.value(waitingUpTo: 60)
        async let second = readiness.value(waitingUpTo: 60)
        try? await Task.sleep(for: .milliseconds(50))

        let started = Date()
        readiness.stop()
        #expect(await first == nil)
        #expect(await second == nil)
        #expect(Date().timeIntervalSince(started) < 5)
    }

    @Test func askingAfterAStopDoesNotWaitAtAll() async {
        let readiness = signal()
        readiness.stop()
        let started = Date()
        #expect(await readiness.value(waitingUpTo: 60) == nil)
        #expect(Date().timeIntervalSince(started) < 1)
    }

    @Test func theWaitIsBoundedSoADeadSidecarSurfacesAsAnError() async {
        // Never publishing must not hang the caller: a visible, retryable error is
        // the whole reason the wait has a bound.
        let readiness = signal()
        let started = Date()
        #expect(await readiness.value(waitingUpTo: 0.3) == nil)
        let elapsed = Date().timeIntervalSince(started)
        #expect(elapsed >= 0.3)
        #expect(elapsed < 5)
    }

    @Test func manyWaitersAreAllWokenByOnePublish() async {
        let readiness = signal()
        async let all = withTaskGroup(of: URL?.self) { group in
            for _ in 0..<8 {
                group.addTask { await readiness.value(waitingUpTo: 10) }
            }
            return await group.reduce(into: [URL?]()) { $0.append($1) }
        }
        try? await Task.sleep(for: .milliseconds(50))
        readiness.publish(ready)
        #expect(await all.allSatisfy { $0 == ready })
    }
}
