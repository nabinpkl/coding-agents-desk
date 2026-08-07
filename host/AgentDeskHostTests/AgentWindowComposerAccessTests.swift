import Foundation
import Testing

@testable import AgentDeskHost

/// The placeholder-recognition rule, fed the exact shapes captured from Claude Desktop 1.26832.0
/// (see `AgentWindowComposerAccess.isPlaceholderOnly`). The composer is a ProseMirror contenteditable:
/// AX reports NO placeholder flag, and folds the placeholder into `AXValue` only while the field is
/// empty. `descendantTexts` is the list of every `AXStaticText` value under the composer.
struct AgentWindowComposerAccessTests {
    private static let placeholderText = "Type / for commands"

    @Test func anEmptyValueIsAlwaysEmpty() {
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: "", descendantTexts: [], placeholderAttribute: nil
        ) == true)
    }

    @Test func thePlaceholderSerializationIsRecognized() {
        // Observed empty state: AXValue = "Type / for commands\n", subtree
        // TextArea > Group > Group > StaticText("Type / for commands").
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: Self.placeholderText + "\n",
            descendantTexts: [Self.placeholderText],
            placeholderAttribute: nil
        ) == true)
    }

    @Test func aFilledSingleLineIsNotTreatedAsPlaceholder() {
        // Observed: AXValue = "hello world" (no trailing newline).
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: "hello world",
            descendantTexts: ["hello world"],
            placeholderAttribute: nil
        ) == false)
    }

    @Test func aFilledMultiLineIsNotTreatedAsPlaceholder() {
        // Observed: AXValue = "line one\nline two", subtree has one StaticText per line, no nesting.
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: "line one\nline two",
            descendantTexts: ["line one", "line two"],
            placeholderAttribute: nil
        ) == false)
    }

    @Test func aValueNestingALineBreakInsideIsNotPlaceholder() {
        // The whole typed text can legitimately contain a newline, but no descendant equals the whole
        // value minus its final newline, so it must not be read as the empty placeholder.
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: "first\nsecond",
            descendantTexts: ["first", "second", "first\nsecond"],
            placeholderAttribute: nil
        ) == false)
    }

    @Test func aRealTrailingBlankParagraphIsNotPlaceholder() {
        // ProseMirror pairs a second blank paragraph as "\n\n", not the placeholder's single "\n".
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: "abc\n\n",
            descendantTexts: ["abc"],
            placeholderAttribute: nil
        ) == false)
    }

    @Test func aProperPlaceholderAttributeMatchingTheValueIsEmpty() {
        // Future-proof: a composer that does expose AXPlaceholderValue and folds it into the value is
        // recognized without needing to know the string.
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: "Your message here",
            descendantTexts: [],
            placeholderAttribute: "Your message here"
        ) == true)
    }

    @Test func anEmptyPlaceholderAttributeNeverClearsRealText() {
        #expect(AgentWindowComposerAccess.isPlaceholderOnly(
            value: "Type / for commands",
            descendantTexts: [Self.placeholderText],
            placeholderAttribute: ""
        ) == false)
    }
}