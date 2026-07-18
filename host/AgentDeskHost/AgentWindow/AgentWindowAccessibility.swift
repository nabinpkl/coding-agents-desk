import AgentPanel
import WebKit

enum AgentWindowAccessibilityIdentifiers {
    static let terminalLauncher = AgentPanelAccessibilityIdentifiers.terminalLauncher
    static let terminalSplitter = "agent-terminal-splitter"
    static let terminalContent = "agent-terminal-content"
    static let terminalStatus = AgentPanelAccessibilityIdentifiers.terminalStatus
    static let terminalClose = AgentPanelAccessibilityIdentifiers.terminalClose
}

@MainActor
enum AgentWindowPanelAccessibility {
    static let userScript = AgentPanelAccessibility.userScript
}
