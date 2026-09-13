export type AgentPanelEntry = "feed" | "desktop";

/**
 * Which surface this page is: the agent feed, or the desktop viewer.
 *
 * A native container names the entry before the page's first script runs -- the iOS shell injects
 * `window.__agentPanelEntry = 'desktop'` (DesktopWebSurface) -- and that stays the authority, so a
 * link can never move a surface the shell has already decided.
 *
 * A plain browser has no such hook, which left the desktop viewer reachable only from inside the
 * app. `?entry=desktop` on the same origin is the browser's spelling of the same choice, which is
 * what lets a phone or a Mac tab open the viewer over the tailnet origin the panel already serves.
 */
export function panelEntry(
  value: unknown = window.__agentPanelEntry,
  search: string = window.location.search,
): AgentPanelEntry {
  if (value === "desktop" || value === "feed") return value;
  return new URLSearchParams(search).get("entry") === "desktop" ? "desktop" : "feed";
}
