// Windows grouped by the Desktop they are on now, which is the order the park panel
// lists them in.

import type { ParkStateResponse, ParkWindow } from "@agentdesk/agent-feed-wire";

export interface DesktopGroup {
  space: number;
  active: boolean;
  windows: ParkWindow[];
}

/** Windows grouped by the Desktop they are on now, active Desktop first. */
export function groupByDesktop(state: ParkStateResponse | undefined): DesktopGroup[] {
  if (!state) return [];
  const bySpace = new Map<number, ParkWindow[]>();
  for (const w of state.windows) {
    const list = bySpace.get(w.space);
    if (list) list.push(w);
    else bySpace.set(w.space, [w]);
  }
  return [...bySpace.entries()]
    .map(([space, windows]) => ({
      space,
      active: space === state.activeSpace.index,
      windows,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.space - b.space);
}
