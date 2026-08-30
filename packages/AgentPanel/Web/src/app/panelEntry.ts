export type AgentPanelEntry = "feed" | "desktop";

/** Native containers choose a first-party entry before the page's first script runs. */
export function panelEntry(value: unknown = window.__agentPanelEntry): AgentPanelEntry {
  return value === "desktop" ? "desktop" : "feed";
}
