import Foundation
import Testing

@testable import AgentDeskClient

@MainActor
struct WorkspaceWorkbenchStateTests {
    @Test func firstUseShowsBothPanesAtClampedDefaultFractions() {
        let state = WorkspaceWorkbenchState()

        #expect(state.sidebarVisible)
        #expect(state.terminalVisible)
        #expect(state.sidebarFraction == WorkspaceWorkbenchState.defaultSidebarFraction)
        #expect(state.terminalFraction == WorkspaceWorkbenchState.defaultTerminalFraction)
    }

    @Test func dividerFractionsClampAtBothEnds() {
        var state = WorkspaceWorkbenchState(sidebarFraction: -1, terminalFraction: 2)

        #expect(state.sidebarFraction == WorkspaceWorkbenchState.sidebarFractionRange.lowerBound)
        #expect(state.terminalFraction == WorkspaceWorkbenchState.terminalFractionRange.upperBound)

        state.setSidebarFraction(2)
        state.setTerminalFraction(-1)

        #expect(state.sidebarFraction == WorkspaceWorkbenchState.sidebarFractionRange.upperBound)
        #expect(state.terminalFraction == WorkspaceWorkbenchState.terminalFractionRange.lowerBound)
    }

    @Test func layoutAndPreferredTerminalPersistIndependentlyPerWorkspace() throws {
        let suiteName = "WorkspaceWorkbenchStateTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = WorkspaceWorkbenchStateStore(defaults: defaults)
        let alpha = WorkspaceWorkbenchState(
            sidebarVisible: false,
            terminalVisible: true,
            sidebarFraction: 0.51,
            terminalFraction: 0.29,
            preferredTerminalSessionName: "workspace-alpha-aabbccddeeff"
        )

        store.setState(alpha, for: "alpha")

        #expect(WorkspaceWorkbenchStateStore(defaults: defaults).state(for: "alpha") == alpha)
        #expect(WorkspaceWorkbenchStateStore(defaults: defaults).state(for: "beta") == WorkspaceWorkbenchState())
    }

    @Test func olderStoredStateReceivesCurrentDefaultsForNewFields() throws {
        let data = try #require("""
        {"sidebarVisible":false,"sidebarFraction":0.4}
        """.data(using: .utf8))

        let decoded = try JSONDecoder().decode(WorkspaceWorkbenchState.self, from: data)

        #expect(!decoded.sidebarVisible)
        #expect(decoded.terminalVisible)
        #expect(decoded.sidebarFraction == 0.4)
        #expect(decoded.terminalFraction == WorkspaceWorkbenchState.defaultTerminalFraction)
        #expect(decoded.preferredTerminalSessionName == nil)
    }
}
