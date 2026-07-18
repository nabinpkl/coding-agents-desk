import WebKit

enum AgentWindowAccessibilityIdentifiers {
    static let terminalLauncher = "agent-terminal-launcher"
    static let terminalSplitter = "agent-terminal-splitter"
    static let terminalContent = "agent-terminal-content"
    static let terminalStatus = "agent-terminal-status"
    static let terminalClose = "agent-terminal-close"
}

@MainActor
enum AgentWindowPanelAccessibility {
    static let userScript = WKUserScript(
        source: source,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    private static let source = """
    (function () {
      function identifyTerminalControls() {
        var footer = document.querySelector('footer');
        if (!footer) return;

        var buttons = footer.querySelectorAll('button[aria-label]');
        buttons.forEach(function (button) {
          var label = button.getAttribute('aria-label') || '';
          if (label.startsWith('Open ') && label.endsWith(' terminal')) {
            button.id = '\(AgentWindowAccessibilityIdentifiers.terminalLauncher)';
          } else if (label.startsWith('Close ') && label.endsWith(' terminal')) {
            button.id = '\(AgentWindowAccessibilityIdentifiers.terminalClose)';
          }
        });

        var status = footer.querySelector('[role="status"]');
        if (status) status.id = '\(AgentWindowAccessibilityIdentifiers.terminalStatus)';
      }

      function install() {
        if (!document.documentElement) {
          document.addEventListener('DOMContentLoaded', install, { once: true });
          return;
        }
        if (window.__agentDeskTerminalAccessibilityObserver) {
          window.__agentDeskTerminalAccessibilityObserver.disconnect();
        }
        var observer = new MutationObserver(identifyTerminalControls);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-label', 'role']
        });
        window.__agentDeskTerminalAccessibilityObserver = observer;
        identifyTerminalControls();
      }

      install();
    })();
    """
}
