export type AgentPanelEntry = "feed" | "desktop" | "ide";

/**
 * Which surface this page is: the agent feed, the desktop viewer, or the workspace IDE.
 *
 * A native container names the entry before the page's first script runs -- the iOS shell injects
 * `window.__agentPanelEntry = 'desktop'` (DesktopWebSurface) -- and that stays the authority, so a
 * link can never move a surface the shell has already decided.
 *
 * A plain browser has no such hook, which left the desktop viewer reachable only from inside the
 * app. `?entry=desktop` on the same origin is the browser's spelling of the same choice, which is
 * what lets a phone or a Mac tab open the viewer over the tailnet origin the panel already serves.
 *
 * `ide` joined them when the workspace IDE stopped being its own pair of webviews on `app://`
 * (ADR-0115), and it is deliberately container-only: the `＋ IDE` window declares it here so it
 * gets the whole window with no tab bar over it, while a browser tab reaches the same surface as
 * a tab among the others. `?entry=ide` therefore falls through to `BrowserSurfaces`, which reads
 * the same parameter for the tab it selects.
 *
 * That split is the reason this function and `initialSurface` both read `entry` and know different
 * values. Two readers of one parameter is a thing to be careful with; what keeps it honest is that
 * this one answers "which page is this", and that one answers "which tab", and only a container
 * can ask the first question.
 */
export function panelEntry(
  value: unknown = window.__agentPanelEntry,
  search: string = window.location.search,
): AgentPanelEntry {
  if (value === "desktop" || value === "feed" || value === "ide") return value;
  return new URLSearchParams(search).get("entry") === "desktop" ? "desktop" : "feed";
}
