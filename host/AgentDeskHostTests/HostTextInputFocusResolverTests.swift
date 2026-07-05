import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct HostTextInputFocusResolverTests {
    @Test func classifierMarksEditableTextRoles() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"] {
            let push = HostTextInputFocusClassifier.classify(
                role: role,
                subrole: nil,
                source: .accessibility
            )
            #expect(push.editability == .editable, "expected \(role) to be editable")
            #expect(push.source == .accessibility)
        }
    }

    @Test func classifierTreatsSearchAndSecureSubrolesAsEditable() {
        let search = HostTextInputFocusClassifier.classify(
            role: "AXTextField",
            subrole: "AXSearchField",
            source: .accessibility
        )
        #expect(search.editability == .editable)
        #expect(!search.secure)

        let secure = HostTextInputFocusClassifier.classify(
            role: "AXTextField",
            subrole: "AXSecureTextField",
            source: .accessibility
        )
        #expect(secure.editability == .editable)
        #expect(secure.secure)
    }

    @Test func genericGroupIsAmbiguousWithoutTextRole() {
        let push = HostTextInputFocusClassifier.classify(
            role: "AXGroup",
            subrole: nil,
            source: .accessibility
        )
        #expect(push.editability == .ambiguous)
        #expect(!push.secure)
    }

    @Test func knownOrdinaryControlsAreNonEditable() {
        for role in ["AXButton", "AXCheckBox", "AXImage", "AXLink", "AXStaticText"] {
            let push = HostTextInputFocusClassifier.classify(
                role: role,
                subrole: nil,
                source: .accessibility
            )
            #expect(push.editability == .nonEditable, "expected \(role) to be non-editable")
            #expect(!push.secure)
        }
    }

    @Test func resolverDoesNotQueryUntilSampled() {
        var queryCount = 0
        let current = HostTextInputFocusPush(
            editability: .editable,
            secure: false,
            source: .accessibility,
            role: "AXTextArea"
        )
        let resolver = HostTextInputFocusResolver(query: {
            queryCount += 1
            return current
        })

        #expect(queryCount == 0)
        #expect(resolver.sampleCurrentFocus() == current)
        #expect(queryCount == 1)
    }

    @Test func sampleCurrentFocusCanAnnotateCursorKind() {
        let current = HostTextInputFocusPush(
            editability: .ambiguous,
            secure: false,
            source: .accessibility,
            role: "AXGroup"
        )
        let resolver = HostTextInputFocusResolver(query: { current })

        let sampled = resolver.sampleCurrentFocus(cursorKind: .ibeam)

        #expect(sampled == HostTextInputFocusPush(
            editability: .ambiguous,
            secure: false,
            source: .accessibility,
            role: "AXGroup",
            cursorKind: .ibeam
        ))
    }
}
