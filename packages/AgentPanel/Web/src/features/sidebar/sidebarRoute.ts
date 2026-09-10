import type { AgentSidebarMode } from "@/features/sidebar/AgentSidebar";

/**
 * Which sidebar view the address bar is asking for.
 *
 * A query parameter rather than a path segment, and that is a constraint rather than a preference:
 * the panel ships to a native container through a custom scheme whose asset resolver maps a request
 * path straight onto a bundled file, with no fall back to `index.html`, and the build references its
 * assets relatively (`base: "./"`). `/feed/canvas` therefore resolves against the wrong directory
 * there and 404s, even though the dev server answers it happily. One spelling has to work in both
 * places, so it is the one that leaves the path alone.
 *
 * It sits beside `entry`, which names the surface, so the whole address reads as what is on screen:
 * `?entry=feed&view=canvas`.
 */
const PARAMETER = "view";

const MODES: readonly AgentSidebarMode[] = ["sessions", "bots", "canvas"];

/** The view named in a search string, or null when it names none this panel has. */
export function sidebarModeFromSearch(search: string): AgentSidebarMode | null {
  const asked = new URLSearchParams(search).get(PARAMETER) ?? "";
  return MODES.includes(asked as AgentSidebarMode) ? (asked as AgentSidebarMode) : null;
}

/** The same address with the view named, for a caller that has one to write. */
export function searchWithSidebarMode(search: string, mode: AgentSidebarMode): string {
  const parameters = new URLSearchParams(search);
  parameters.set(PARAMETER, mode);
  return `?${parameters.toString()}`;
}
