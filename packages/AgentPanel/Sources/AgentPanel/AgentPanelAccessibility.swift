import WebKit

public enum AgentPanelAccessibilityIdentifiers {
    public static let terminalLauncher = "agent-terminal-launcher"
    public static let terminalClose = "agent-terminal-close"
    public static let terminalStatus = "agent-terminal-status"
    public static let projectRowPrefix = "agent-project-row-"
    public static let sessionRowPrefix = "agent-session-row-"
}

@MainActor
public enum AgentPanelAccessibility {
    public static let userScript = WKUserScript(
        source: source,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    private static let source = """
    (function () {
      function slugify(value) {
        return String(value || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .replace(/-{2,}/g, '-');
      }

      function text(node) {
        return (node && node.textContent ? node.textContent : '').trim();
      }

      function uniqueId(base, usedIds, fallbackPrefix, index) {
        var candidate = base && base.length ? base : fallbackPrefix + '-' + index;
        var suffix = 2;
        while (usedIds.has(candidate)) {
          candidate = (base && base.length ? base : fallbackPrefix + '-' + index) + '-' + suffix;
          suffix += 1;
        }
        usedIds.add(candidate);
        return candidate;
      }

      function setID(node, value) {
        if (node && node.id !== value) {
          node.id = value;
        }
      }

      function setAriaLabel(node, value) {
        if (!node || !value) return;
        if (node.getAttribute('aria-label') !== value) {
          node.setAttribute('aria-label', value);
        }
      }

      function identifyProjects() {
        var list = document.querySelector('ul[aria-label="Projects"]');
        if (!list) return;
        var usedIds = new Set();
        Array.prototype.forEach.call(list.querySelectorAll(':scope > li > button'), function (button, index) {
          var name = text(button.querySelector('span'));
          var slug = slugify(name);
          var id = uniqueId(
            '\(AgentPanelAccessibilityIdentifiers.projectRowPrefix)' + slug,
            usedIds,
            '\(AgentPanelAccessibilityIdentifiers.projectRowPrefix)row',
            index
          );
          setID(button, id);
          if (name) {
            setAriaLabel(button, 'Open project ' + name);
          }
        });
      }

      function identifySessions() {
        var list = document.querySelector('ul[aria-label="Sessions"]');
        if (!list) return;
        var usedIds = new Set();
        Array.prototype.forEach.call(list.querySelectorAll(':scope > li > button'), function (button, index) {
          var sourceLabel = text(button.querySelector('[aria-label^="Source: "]'));
          var source = sourceLabel.replace(/^Source:\\s*/, '');
          var paragraphs = button.querySelectorAll('p');
          var title = paragraphs.length > 0 ? text(paragraphs[0]) : '';
          var sourceSlug = slugify(source);
          var titleSlug = slugify(title);
          var id = uniqueId(
            '\(AgentPanelAccessibilityIdentifiers.sessionRowPrefix)' + sourceSlug + '-' + titleSlug,
            usedIds,
            '\(AgentPanelAccessibilityIdentifiers.sessionRowPrefix)row',
            index
          );
          setID(button, id);
          if (source && title) {
            setAriaLabel(button, 'Open ' + source + ' session ' + title);
          }
        });
      }

      function identifyTerminalControls() {
        var footer = document.querySelector('footer');
        if (!footer) return;

        var buttons = footer.querySelectorAll('button[aria-label]');
        buttons.forEach(function (button) {
          var label = button.getAttribute('aria-label') || '';
          if (label.startsWith('Open ') && label.endsWith(' terminal')) {
            setID(button, '\(AgentPanelAccessibilityIdentifiers.terminalLauncher)');
          } else if (label.startsWith('Close ') && label.endsWith(' terminal')) {
            setID(button, '\(AgentPanelAccessibilityIdentifiers.terminalClose)');
          }
        });

        var status = footer.querySelector('[role="status"]');
        if (status) {
          setID(status, '\(AgentPanelAccessibilityIdentifiers.terminalStatus)');
        }
      }

      function identifyAll() {
        identifyProjects();
        identifySessions();
        identifyTerminalControls();
      }

      var identifyScheduled = false;

      function scheduleIdentifyAll() {
        if (identifyScheduled) return;
        identifyScheduled = true;
        window.setTimeout(function () {
          identifyScheduled = false;
          identifyAll();
        }, 0);
      }

      function install() {
        if (!document.documentElement) {
          document.addEventListener('DOMContentLoaded', install, { once: true });
          return;
        }
        if (window.__agentPanelAccessibilityObserver) {
          window.__agentPanelAccessibilityObserver.disconnect();
        }
        var observer = new MutationObserver(scheduleIdentifyAll);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-label', 'role']
        });
        window.__agentPanelAccessibilityObserver = observer;
        scheduleIdentifyAll();
      }

      install();
    })();
    """
}
