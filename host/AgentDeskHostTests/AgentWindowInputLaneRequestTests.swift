import AgentDeskWire
import AgentPanel
import Foundation
import Testing

@testable import AgentDeskHost

/// The phone's composer-sync frames never pass through `AgentPanelRequest.decode`, so this mapping is
/// the only thing bounding them. What is under test is that it bounds the SAME fields the webview door
/// does -- a rule enforced on one surface and skipped on the other is worse than no rule, because the
/// surface it is skipped on is the remote one.
struct AgentWindowInputLaneRequestTests {
    private let session = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e"

    @Test func wellFormedFramesBecomePanelRequests() {
        #expect(
            AgentWindowInputLaneRequest.watch(
                AgentWindowInputWatch(subscriptionId: "window-input-1", sessionId: session)
            ) == .windowInputWatch(subscriptionId: "window-input-1", sessionId: session)
        )
        #expect(
            AgentWindowInputLaneRequest.unwatch(
                AgentWindowInputUnwatch(subscriptionId: "window-input-1")
            ) == .windowInputUnwatch(subscriptionId: "window-input-1")
        )
        #expect(
            AgentWindowInputLaneRequest.read(
                AgentWindowInputRead(requestId: "read-1", sessionId: session)
            ) == .windowInputRead(requestId: "read-1", sessionId: session)
        )
        #expect(
            AgentWindowInputLaneRequest.sync(
                AgentWindowInputSync(requestId: "sync-1", sessionId: session, text: "review the diff")
            ) == .windowInputSync(requestId: "sync-1", sessionId: session, text: "review the diff")
        )
        #expect(
            AgentWindowInputLaneRequest.submit(
                AgentWindowInputSubmit(requestId: "submit-1", sessionId: session, text: "run the tests")
            ) == .windowInputSubmit(requestId: "submit-1", sessionId: session, text: "run the tests")
        )
    }

    @Test func aSessionIdIsRejectedRatherThanScannedAgainstEveryProcess() {
        // The id is compared against the live process table on every re-resolve, so an unbounded or
        // shell-shaped value is work and reach the panel never asked for.
        for bad in ["", String(repeating: "a", count: 129), "9f2c1d54 --resume", "id;rm -rf /"] {
            #expect(
                AgentWindowInputLaneRequest.read(
                    AgentWindowInputRead(requestId: "read-1", sessionId: bad)
                ) == nil
            )
            #expect(
                AgentWindowInputLaneRequest.watch(
                    AgentWindowInputWatch(subscriptionId: "window-input-1", sessionId: bad)
                ) == nil
            )
        }
    }

    @Test func aSubscriptionIdIsBoundedBecauseItKeepsASessionInTheResolveLoop() {
        #expect(
            AgentWindowInputLaneRequest.unwatch(
                AgentWindowInputUnwatch(subscriptionId: String(repeating: "s", count: 129))
            ) == nil
        )
        #expect(
            AgentWindowInputLaneRequest.watch(
                AgentWindowInputWatch(subscriptionId: "", sessionId: session)
            ) == nil
        )
    }

    @Test func composerTextIsCappedButMayBeEmpty() {
        // Empty clears the composer, which is a real intent. The cap exists because this string is set
        // verbatim as another application's text-field value.
        #expect(
            AgentWindowInputLaneRequest.sync(
                AgentWindowInputSync(requestId: "sync-1", sessionId: session, text: "")
            ) == .windowInputSync(requestId: "sync-1", sessionId: session, text: "")
        )
        let atLimit = String(repeating: "x", count: AgentPanelWindowInputBounds.textLimit)
        #expect(
            AgentWindowInputLaneRequest.sync(
                AgentWindowInputSync(requestId: "sync-1", sessionId: session, text: atLimit)
            ) != nil
        )
        #expect(
            AgentWindowInputLaneRequest.sync(
                AgentWindowInputSync(requestId: "sync-1", sessionId: session, text: atLimit + "x")
            ) == nil
        )
        // A submit string is written verbatim too, so it shares the cap. An empty submit is allowed by
        // the bounds (the panel disables it), but it must still round-trip rather than be dropped.
        #expect(
            AgentWindowInputLaneRequest.submit(
                AgentWindowInputSubmit(requestId: "submit-1", sessionId: session, text: atLimit)
            ) != nil
        )
        #expect(
            AgentWindowInputLaneRequest.submit(
                AgentWindowInputSubmit(requestId: "submit-1", sessionId: session, text: atLimit + "x")
            ) == nil
        )
    }
}
