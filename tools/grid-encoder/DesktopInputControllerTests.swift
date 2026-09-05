import AppKit
import CoreGraphics
import Foundation

@main
struct DesktopInputControllerTests {
    static func main() {
        testCaptureCommandsAreExact()
        testFocusClassification()
        testInjectedFocusProbe()
        testIBeamFallback()
        testTrustRevocationDuringFocusProbe()
        testEveryAnsiKeyAndModifierFlags()
        testBatchPrevalidationIsAtomic()
        testTextTypesItsOwnCharacters()
        testOversizedTextIsRejected()
        testAccessibilityDenial()
        testMalformedCommands()
        print("DesktopInputControllerTests: PASS")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { fatalError(message) }
    }

    private static func testCaptureCommandsAreExact() {
        expect(CaptureControlCommand.parse("K") == .keyframe, "exact K was not parsed")
        expect(CaptureControlCommand.parse("KEY") == nil, "K prefix was accepted")
        expect(CaptureControlCommand.parse(" K ") == nil, "spaced K was accepted")
        expect(CaptureControlCommand.parse("B1200000") == .bitrate(1_200_000), "bitrate failed")
        expect(CaptureControlCommand.parse("B-1") == nil, "negative bitrate was accepted")
        expect(CaptureControlCommand.parse("B1200000x") == nil, "bitrate suffix was accepted")
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

    /// A pasted string arrives as characters, including ones no US key can produce, and its
    /// newlines arrive as Return.
    private static func testTextTypesItsOwnCharacters() {
        var posted: [CGEvent] = []
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 1_000, height: 800),
            emit: { emitted.append(json($0)) },
            eventPoster: { posted.append($0.copy()!) },
            trustProvider: { true }
        )
        expect(controller.handle(jsonLine([
            "type": "text", "sequence": 9, "text": "h\u{e9}llo \u{2014} \u{1f44b}\nsecond",
        ])), "JSON command was not consumed")
        let typed = posted.filter { $0.type == .keyDown }.map(unicodeText).joined()
        expect(typed.contains("h\u{e9}llo"), "an accented character did not survive: \(typed)")
        expect(typed.contains("\u{2014}"), "an em dash did not survive: \(typed)")
        expect(typed.contains("\u{1f44b}"), "an emoji did not survive: \(typed)")
        expect(typed.contains("second"), "text after the newline was not typed: \(typed)")
        // A Return key event reads back as a carriage return, which is how the newline shows up
        // here. Asserting its payload rather than its key code keeps the test off the file-private
        // key table, and proves it landed between the two lines rather than merely existing.
        expect(typed.contains("\u{d}second"), "the newline did not become a Return press: \(typed.debugDescription)")
        expect(emitted.last?["type"] as? String == "input-applied", "text was not acknowledged")
        expect(emitted.last?["sequence"] as? Int == 9, "ack sequence differed")
    }

    private static func testOversizedTextIsRejected() {
        var posted: [CGEvent] = []
        var emitted: [[String: Any]] = []
        let controller = DesktopInputController(
            bounds: CGRect(x: 0, y: 0, width: 1_000, height: 800),
            emit: { emitted.append(json($0)) },
            eventPoster: { posted.append($0.copy()!) },
            trustProvider: { true }
        )
        expect(controller.handle(jsonLine([
            "type": "text", "sequence": 11, "text": String(repeating: "a", count: 5_000),
        ])), "JSON command was not consumed")
        expect(posted.isEmpty, "an oversized paste typed something anyway")
        expect(emitted.last?["type"] as? String == "input-rejected", "oversized text was accepted")
        expect(emitted.last?["reason"] as? String == "oversized", "rejection reason differed")
    }

    private static func unicodeText(_ event: CGEvent) -> String {
        var length = 0
        var buffer = [UniChar](repeating: 0, count: 64)
        event.keyboardGetUnicodeString(maxStringLength: 64, actualStringLength: &length, unicodeString: &buffer)
        return String(utf16CodeUnits: buffer, count: length)
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
