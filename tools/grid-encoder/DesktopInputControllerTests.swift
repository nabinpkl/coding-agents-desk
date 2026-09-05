import AppKit
import CoreGraphics
import Foundation

@main
struct DesktopInputControllerTests {
    static func main() {
        testCaptureCommandsAreExact()
        testEveryTypeHasExactlyOneOwner()
        testFocusClassification()
        testInjectedFocusProbe()
        testIBeamFallback()
        testTrustRevocationDuringFocusProbe()
        testEveryAnsiKeyAndModifierFlags()
        testBatchPrevalidationIsAtomic()
        testAccessibilityDenial()
        testMalformedCommands()
        print("DesktopInputControllerTests: PASS")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { fatalError(message) }
    }

    private static func testCaptureCommandsAreExact() {
        func parse(_ object: [String: Any]) -> CaptureControlCommand? {
            guard case .success(let command)? = CaptureControlCommand.parse(object) else { return nil }
            return command
        }
        func rejection(_ object: [String: Any]) -> CaptureControlCommand.Rejection? {
            guard case .failure(let reason)? = CaptureControlCommand.parse(object) else { return nil }
            return reason
        }
        expect(parse(["type": "keyframe"]) == .keyframe, "keyframe was not parsed")
        expect(parse(["type": "bitrate", "bits": 1_200_000]) == .bitrate(1_200_000), "bitrate failed")
        expect(
            parse(["type": "resize", "width": 1_920, "height": 1_080]) == .resize(width: 1_920, height: 1_080),
            "resize failed"
        )

        // Every command is reachable: the previous encoding routed on a leading letter, and the
        // last command's validation doubled as the gate that rejected everything else, so a command
        // added after it parsed as nil forever without one line of evidence that it existed.
        for type in CaptureControlCommand.types {
            let object: [String: Any] = [
                "type": type, "bits": 1_200_000, "width": 1_920, "height": 1_080,
            ]
            expect(CaptureControlCommand.parse(object) != nil, "\(type) was not routed to this command set")
            expect(parse(object) != nil, "\(type) was owned but did not parse")
        }

        // A line this set does not own is not its business to reject; the router reports it.
        expect(CaptureControlCommand.parse(["type": "pointer-move"]) == nil, "a foreign type was claimed")
        expect(CaptureControlCommand.parse([:]) == nil, "a line with no type was claimed")

        // Owned but unusable is a rejection, never silence.
        expect(rejection(["type": "bitrate"]) == .malformed, "bitrate without bits was not rejected")
        expect(rejection(["type": "bitrate", "bits": 1]) == .outOfRange, "tiny bitrate was accepted")
        expect(rejection(["type": "resize", "width": 1_920]) == .malformed, "resize without height was not rejected")
        expect(rejection(["type": "resize", "width": 8, "height": 1_080]) == .outOfRange, "tiny width was accepted")
        expect(rejection(["type": "resize", "width": 99_999, "height": 1_080]) == .outOfRange, "huge width was accepted")
    }

    private static func testEveryTypeHasExactlyOneOwner() {
        let sets: [(String, Set<String>)] = [
            ("capture", CaptureControlCommand.types),
            ("navigation", DesktopSpacesController.types),
            ("input", DesktopInputController.types),
        ]
        for (name, types) in sets {
            for type in types {
                for (otherName, otherTypes) in sets where otherName != name {
                    expect(!otherTypes.contains(type), "\(type) is owned by both \(name) and \(otherName)")
                }
                expect(ControlRouter.owner(of: type) != .unknown, "\(type) routed nowhere")
            }
        }
        expect(ControlRouter.owner(of: "not-a-command") == .unknown, "an unknown type found an owner")
        expect(ControlRouter.type(of: "K") == nil, "a bare opcode was read as a typed line")
        expect(ControlRouter.type(of: #"{"type":"keyframe"}"#) == "keyframe", "a typed line did not decode")
    }

    private static func testFocusClassification() {
        expect(
            DesktopFocusClassifier.classify(role: "AXTextField", subrole: nil).editability
                == "editable",
            "text field was not editable"
        )
        let secure = DesktopFocusClassifier.classify(role: "AXSecureTextField", subrole: nil)
        expect(secure.editability == "editable" && secure.secure, "secure field failed")
        expect(
            DesktopFocusClassifier.classify(role: "AXButton", subrole: nil).editability
                == "non-editable",
            "button was not non-editable"
        )
        expect(
            DesktopFocusClassifier.classify(role: "AXGroup", subrole: nil).editability
                == "ambiguous",
            "unknown role was not ambiguous"
        )
    }

    private static func testEveryAnsiKeyAndModifierFlags() {
        var posted: [CGEvent] = []
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 1_000, height: 800),
            emit: { emitted.append(json($0)) },
            eventPoster: { posted.append($0.copy()!) },
            trustProvider: { true }
        )
        let keys = fixtureKeyCodes().map {
            ["code": $0, "modifiers": ["cmd", "ctrl", "option", "shift"]] as [String: Any]
        }
        expect(controller.handle(jsonLine([
            "type": "key-batch", "sequence": 7, "keys": keys,
        ])), "JSON command was not consumed")
        expect(posted.count == keys.count * 2, "not every key produced down and up")
        for pair in stride(from: 0, to: posted.count, by: 2) {
            expect(posted[pair].type == .keyDown, "first event was not key down")
            expect(posted[pair + 1].type == .keyUp, "second event was not key up")
            let expected: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
            expect(posted[pair].flags.contains(expected), "modifier flags were incomplete")
            expect(
                posted[pair].getIntegerValueField(.keyboardEventKeycode)
                    == posted[pair + 1].getIntegerValueField(.keyboardEventKeycode),
                "key down and up codes differed"
            )
        }
        expect(emitted.last?["type"] as? String == "input-applied", "batch was not acknowledged")
        expect(emitted.last?["sequence"] as? Int == 7, "ack sequence differed")
    }

    private static func testInjectedFocusProbe() {
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            emit: { emitted.append(json($0)) },
            eventPoster: { _ in },
            trustProvider: { true },
            cursorKindProvider: { "arrow" },
            focusSampler: {
                DesktopFocusSample(
                    editability: "editable",
                    secure: true,
                    source: "accessibility",
                    role: "AXSecureTextField"
                )
            }
        )
        _ = controller.handle(jsonLine([
            "type": "configure", "initialFocusDelayMs": 0, "settleFocusDelayMs": 0,
        ]))
        _ = controller.handle(jsonLine([
            "type": "focus-query",
            "focusRequestId": "5f03b272-2922-4ca1-93ee-82d902fdbe21",
        ]))
        let deadline = Date().addingTimeInterval(1)
        while emitted.isEmpty && Date() < deadline {
            _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        expect(emitted.last?["type"] as? String == "text-focus", "focus probe did not emit")
        expect(emitted.last?["editability"] as? String == "editable", "AX editability was lost")
        expect(emitted.last?["secure"] as? Bool == true, "secure focus was lost")
        expect(
            emitted.last?["cursorKind"] as? String == "arrow",
            "AX editable focus incorrectly required an I-beam"
        )
    }

    private static func testTrustRevocationDuringFocusProbe() {
        var trusted = true
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            emit: { emitted.append(json($0)) },
            eventPoster: { _ in },
            trustProvider: { trusted },
            cursorKindProvider: { "ibeam" },
            focusSampler: {
                trusted = false
                return DesktopFocusSample(editability: "ambiguous", secure: false, source: "none")
            }
        )
        _ = controller.handle(jsonLine([
            "type": "configure", "initialFocusDelayMs": 0, "settleFocusDelayMs": 10,
        ]))
        _ = controller.handle(jsonLine([
            "type": "focus-query",
            "focusRequestId": "5f03b272-2922-4ca1-93ee-82d902fdbe21",
        ]))
        let deadline = Date().addingTimeInterval(1)
        while emitted.isEmpty && Date() < deadline {
            _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        expect(
            emitted.last?["reason"] as? String == "accessibility-denied",
            "settled focus probe fell through after trust revocation"
        )
        expect(emitted.last?["type"] as? String != "text-focus", "untrusted I-beam was accepted")
    }

    private static func testIBeamFallback() {
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            emit: { emitted.append(json($0)) },
            eventPoster: { _ in },
            trustProvider: { true },
            cursorKindProvider: { "ibeam" },
            focusSampler: {
                DesktopFocusSample(editability: "ambiguous", secure: false, source: "none")
            }
        )
        _ = controller.handle(jsonLine([
            "type": "configure", "initialFocusDelayMs": 0, "settleFocusDelayMs": 0,
        ]))
        _ = controller.handle(jsonLine([
            "type": "focus-query",
            "focusRequestId": "5f03b272-2922-4ca1-93ee-82d902fdbe21",
        ]))
        let deadline = Date().addingTimeInterval(1)
        while emitted.isEmpty && Date() < deadline {
            _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        expect(emitted.last?["editability"] as? String == "ambiguous", "fallback changed editability")
        expect(
            emitted.last?["source"] as? String == "cursor-tap-heuristic",
            "I-beam fallback source was not explicit"
        )
    }

    private static func testBatchPrevalidationIsAtomic() {
        var posted = 0
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            emit: { emitted.append(json($0)) },
            eventPoster: { _ in posted += 1 },
            trustProvider: { true }
        )
        _ = controller.handle(jsonLine([
            "type": "key-batch", "sequence": 8,
            "keys": [
                ["code": "ansi-A", "modifiers": []],
                ["code": "future", "modifiers": []],
            ],
        ]))
        expect(posted == 0, "invalid atomic batch partially posted")
        expect(emitted.last?["reason"] as? String == "unknown-key", "unknown key was not rejected")
    }

    private static func testAccessibilityDenial() {
        var posted = 0
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            emit: { emitted.append(json($0)) },
            eventPoster: { _ in posted += 1 },
            trustProvider: { false }
        )
        _ = controller.handle(jsonLine([
            "type": "key-batch", "sequence": 9,
            "keys": [["code": "ansi-A", "modifiers": []]],
        ]))
        expect(posted == 0, "untrusted input posted an event")
        expect(
            emitted.last?["reason"] as? String == "accessibility-denied",
            "trust denial did not reject explicitly"
        )
    }

    private static func testMalformedCommands() {
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            emit: { emitted.append(json($0)) },
            eventPoster: { _ in },
            trustProvider: { true }
        )
        expect(controller.handle("{bad"), "malformed JSON escaped control parsing")
        expect(emitted.last?["reason"] as? String == "malformed", "malformed JSON was not rejected")
        _ = controller.handle(jsonLine([
            "type": "focus-query", "focusRequestId": "not-a-uuid",
        ]))
        expect(emitted.last?["reason"] as? String == "malformed", "bad focus ID was accepted")
    }

    private static func jsonLine(_ value: Any) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    private static func fixtureKeyCodes() -> [String] {
        let path = ProcessInfo.processInfo.environment["AGENTDESK_CONTROL_FIXTURES"]!
        let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path)))
            as! [String: Any]
        let control = root["desktopControlV2"] as! [String: Any]
        return control["keyCodes"] as! [String]
    }

    private static func json(_ data: Data) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
}
