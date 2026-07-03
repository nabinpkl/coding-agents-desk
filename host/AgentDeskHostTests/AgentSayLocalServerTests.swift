import Foundation
import Testing
import AgentDeskWire

struct AgentSayLocalServerTests {
    @Test func rejectsMissingOrBadToken() {
        let session = AgentSayLocalSession(expectedToken: "secret")
        #expect(session.accept(line: #"{"t":"say-start","id":"u1"}"#) == .reject("bad-auth"))
        #expect(session.accept(line: #"{"t":"auth","v":1,"token":"wrong"}"#) == .reject("bad-auth"))
    }

    @Test func rejectsOversizedTextAndOutOfOrderChunks() {
        let session = AgentSayLocalSession(expectedToken: "secret")
        #expect(session.accept(line: #"{"t":"auth","v":1,"token":"secret"}"#) == .ack)
        #expect(session.accept(line: #"{"t":"say-start","id":"u1"}"#) == .broadcast(AgentSayPush(id: "u1", phase: "start")))
        #expect(session.accept(line: #"{"t":"say-chunk","id":"u1","seq":1,"text":"hello"}"#) == .reject("bad-sequence", id: "u1"))

        let oversized = String(repeating: "x", count: AgentSayLocalServer.Constants.maxChunkBytes + 1)
        let data = try! JSONSerialization.data(withJSONObject: [
            "t": "say-chunk",
            "id": "u1",
            "seq": 0,
            "text": oversized
        ])
        let line = String(data: data, encoding: .utf8)!
        #expect(session.accept(line: line) == .reject("too-large", id: "u1"))
    }

    @Test func validSaySequenceBroadcastsStartChunkEnd() {
        let session = AgentSayLocalSession(expectedToken: "secret")
        #expect(session.accept(line: #"{"t":"auth","v":1,"token":"secret"}"#) == .ack)
        #expect(session.accept(line: #"{"t":"say-start","id":"u1"}"#) == .broadcast(AgentSayPush(id: "u1", phase: "start")))
        #expect(
            session.accept(line: #"{"t":"say-chunk","id":"u1","seq":0,"text":"hello"}"#)
                == .broadcast(AgentSayPush(id: "u1", phase: "chunk", sequence: 0, text: "hello"))
        )
        #expect(session.accept(line: #"{"t":"say-end","id":"u1"}"#) == .broadcastThenAccepted(AgentSayPush(id: "u1", phase: "end")))
    }
}
