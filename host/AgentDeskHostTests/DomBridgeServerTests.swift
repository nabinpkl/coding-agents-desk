import Foundation
import Testing

@testable import AgentDeskHost

// Pure, socket-free coverage of the bridge protocol: the newline frame reader (splitting, buffering,
// byte cap) and the session state machine (token auth, batch forwarding, rejection, reconnect
// isolation). The live socket accept/reconnect path is exercised end-to-end by the autonomous
// `just dom-mirror-bridge-verify` harness (shim stdio <-> host socket), not here.
struct DomBridgeServerTests {
    private func line(_ json: String) -> Data { Data(json.utf8) }

    @Test func frameReaderSplitsMultipleNewlineDelimitedLines() throws {
        var reader = DomBridgeFrameReader(maxLineBytes: 1024)
        let lines = try reader.consume(Data("{\"a\":1}\n{\"b\":2}\n".utf8))
        #expect(lines.count == 2)
        #expect(String(data: lines[0], encoding: .utf8) == "{\"a\":1}")
        #expect(String(data: lines[1], encoding: .utf8) == "{\"b\":2}")
    }

    @Test func frameReaderBuffersPartialLineAcrossReads() throws {
        var reader = DomBridgeFrameReader(maxLineBytes: 1024)
        #expect(try reader.consume(Data("{\"a\":".utf8)).isEmpty)
        let lines = try reader.consume(Data("1}\n".utf8))
        #expect(lines.count == 1)
        #expect(String(data: lines[0], encoding: .utf8) == "{\"a\":1}")
    }

    @Test func frameReaderThrowsOnUnterminatedOversizeLine() {
        var reader = DomBridgeFrameReader(maxLineBytes: 8)
        #expect(throws: DomBridgeError.frameTooLarge) {
            _ = try reader.consume(Data(String(repeating: "x", count: 9).utf8))
        }
    }

    @Test func sessionRequiresAuthFirst() {
        var session = DomBridgeSession(expectedToken: "secret")
        // A dom-batch before auth is rejected.
        let action = session.accept(line: line(#"{"t":"dom-batch","tb":1,"co":true,"ev":[]}"#))
        #expect(action == .reject("bad-auth"))
    }

    @Test func sessionRejectsBadToken() {
        var session = DomBridgeSession(expectedToken: "secret")
        let action = session.accept(line: line(#"{"t":"auth","v":1,"token":"wrong"}"#))
        #expect(action == .reject("bad-auth"))
    }

    @Test func sessionAuthenticatesThenForwardsBatch() {
        var session = DomBridgeSession(expectedToken: "secret")
        #expect(session.accept(line: line(#"{"t":"auth","v":1,"token":"secret"}"#)) == .ack)

        let raw = line(#"{"t":"dom-batch","tb":9,"co":true,"ev":[{"type":4}]}"#)
        let action = session.accept(line: raw)
        guard case .forwardBatch(let forwarded, let envelope) = action else {
            Issue.record("expected forwardBatch, got \(action)")
            return
        }
        // The raw line is forwarded verbatim (opaque passthrough of the rrweb events).
        #expect(forwarded == raw)
        #expect(envelope.tabId == 9)
        #expect(envelope.checkout == true)
        #expect(envelope.type == "dom-batch")
    }

    @Test func sessionRejectsMalformedAndUnknownAfterAuth() {
        var session = DomBridgeSession(expectedToken: "secret")
        _ = session.accept(line: line(#"{"t":"auth","v":1,"token":"secret"}"#))
        #expect(session.accept(line: line("not json")) == .reject("malformed"))
        #expect(session.accept(line: line(#"{"t":"who-knows"}"#)) == .reject("unknown"))
    }

    @Test func sessionIgnoresEmptyLines() {
        var session = DomBridgeSession(expectedToken: "secret")
        #expect(session.accept(line: Data()) == .ignore)
    }

    @Test func freshSessionReAuthenticatesModelingReconnect() {
        // A reconnecting shim gets a brand-new session; auth state never leaks across connections.
        var first = DomBridgeSession(expectedToken: "secret")
        #expect(first.accept(line: line(#"{"t":"auth","v":1,"token":"secret"}"#)) == .ack)

        var second = DomBridgeSession(expectedToken: "secret")
        // Without re-auth, the second connection cannot forward a batch.
        #expect(second.accept(line: line(#"{"t":"dom-batch","tb":1,"co":false,"ev":[]}"#)) == .reject("bad-auth"))
    }
}

// ADR-0045: the .dom lane receive guard forwards only recognized client->host control commands to
// the bridge (tap + capture pause/resume); everything else is dropped so the bridge never relays a
// malformed or echoed frame to the extension.
struct DomLaneControlForwardingTests {
    private func data(_ json: String) -> Data { Data(json.utf8) }

    @Test func forwardsTapAndCaptureControlFrames() {
        #expect(isForwardableDomControl(data(#"{"t":"dom-input","k":"mouse","x":1,"y":2}"#)))
        #expect(isForwardableDomControl(data(#"{"t":"dom-capture","on":false}"#)))
        #expect(isForwardableDomControl(data(#"{"t":"dom-capture","on":true}"#)))
    }

    // ADR-0047: the scroll-drive-back command is forwarded verbatim like the tap and capture frames.
    @Test func forwardsScrollControlFrames() {
        #expect(isForwardableDomControl(data(#"{"t":"dom-scroll","x":10,"y":20,"dx":0,"dy":-120}"#)))
        #expect(isForwardableDomControl(data(#"{"t":"dom-scroll","x":0,"y":0,"dx":5,"dy":5}"#)))
    }

    // ADR-0048: the device-emulation toggle is forwarded verbatim too.
    @Test func forwardsEmulateControlFrames() {
        #expect(isForwardableDomControl(data(#"{"t":"dom-emulate","mobile":true}"#)))
        #expect(isForwardableDomControl(data(#"{"t":"dom-emulate","mobile":false}"#)))
    }

    @Test func dropsBatchesUnknownTypesAndGarbage() {
        // A host->client batch echoed back must never be relayed to the extension.
        #expect(!isForwardableDomControl(data(#"{"t":"dom-batch","tb":1,"co":true,"ev":[]}"#)))
        #expect(!isForwardableDomControl(data(#"{"t":"something-else"}"#)))
        #expect(!isForwardableDomControl(data(#"{"no-type":1}"#)))
        #expect(!isForwardableDomControl(data("not json")))
    }
}
