import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct HostTextInputFocusMonitorTests {
    @Test func classifierMarksEditableTextRoles() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"] {
            let push = HostTextInputFocusClassifier.classify(
                role: role,
                subrole: nil,
                source: .accessibility
            )
            #expect(push.editable, "expected \(role) to be editable")
            #expect(push.source == .accessibility)
        }
    }

    @Test func classifierTreatsSearchAndSecureSubrolesAsEditable() {
        let search = HostTextInputFocusClassifier.classify(
            role: "AXTextField",
            subrole: "AXSearchField",
            source: .accessibility
        )
        #expect(search.editable)
        #expect(!search.secure)

        let secure = HostTextInputFocusClassifier.classify(
            role: "AXTextField",
            subrole: "AXSecureTextField",
            source: .accessibility
        )
        #expect(secure.editable)
        #expect(secure.secure)
    }

    @Test func genericGroupIsNotEditableWithoutTextRole() {
        let push = HostTextInputFocusClassifier.classify(
            role: "AXGroup",
            subrole: nil,
            source: .accessibility
        )
        #expect(!push.editable)
        #expect(!push.secure)
    }

    @Test func monitorEmitsOnlyWhenClassificationChanges() {
        var current = HostTextInputFocusPush(
            editable: false,
            secure: false,
            source: .none
        )
        let monitor = HostTextInputFocusMonitor(query: { current })
        var emitted: [HostTextInputFocusPush] = []
        monitor.onChange = { emitted.append($0) }

        #expect(monitor.tick() == current)
        #expect(monitor.tick() == nil)

        current = HostTextInputFocusPush(
            editable: true,
            secure: false,
            source: .accessibility,
            role: "AXTextArea"
        )
        #expect(monitor.tick() == current)
        #expect(emitted == [
            HostTextInputFocusPush(editable: false, secure: false, source: .none),
            HostTextInputFocusPush(editable: true, secure: false, source: .accessibility, role: "AXTextArea")
        ])
    }

    @Test func sampleCurrentFocusReturnsUnchangedFocusWithoutEmitting() {
        let current = HostTextInputFocusPush(
            editable: true,
            secure: false,
            source: .accessibility,
            role: "AXTextArea"
        )
        let monitor = HostTextInputFocusMonitor(query: { current })
        var emitted: [HostTextInputFocusPush] = []
        monitor.onChange = { emitted.append($0) }

        #expect(monitor.tick() == current)
        emitted.removeAll()

        #expect(monitor.sampleCurrentFocus() == current)
        #expect(emitted.isEmpty)
    }

    @Test func sampleCurrentFocusCanAnnotateCursorKindWithoutEmitting() {
        let current = HostTextInputFocusPush(
            editable: false,
            secure: false,
            source: .accessibility,
            role: "AXGroup"
        )
        let monitor = HostTextInputFocusMonitor(query: { current })
        var emitted: [HostTextInputFocusPush] = []
        monitor.onChange = { emitted.append($0) }

        let sampled = monitor.sampleCurrentFocus(cursorKind: .ibeam)

        #expect(sampled == HostTextInputFocusPush(
            editable: false,
            secure: false,
            source: .accessibility,
            role: "AXGroup",
            cursorKind: .ibeam
        ))
        #expect(emitted.isEmpty)
    }
}
