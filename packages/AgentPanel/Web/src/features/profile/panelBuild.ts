"use client";

// Which code this tab is running, and whether it can still be told when that changes.
//
// This exists because a panel tab can sit on a bundle older than the tree with nothing on screen
// saying so, and the surface then answers questions about code that has already been replaced. It
// cost a full round of "the fix is not working" / "it is, your tab is not running it" on
// 2026-09-14, with no way for either side to settle it by looking.
//
// Two facts, and they are not the same fact:
//
//   - The BUILD ID names the commit the Vite config was loaded at. In a bundled build that is the
//     whole truth, because the bundle is frozen. Under the dev server it is only the starting
//     point: every edit since reaches a connected tab over HMR without moving this string.
//   - CONNECTEDNESS is what carries freshness in dev. A tab still attached to the dev server is
//     current by construction -- Vite pushes each change, and a module with no HMR boundary
//     (`activityFeedLayout.ts`, say) makes it send a full reload. A tab that lost the socket is
//     precisely the stale case, and it is silent today: the page keeps working, it just stops
//     hearing about the tree.
//
// So the row shows the id and lets the TONE say whether it can still be trusted.

import { useEffect, useState } from "react";

/**
 * The commit this panel was built from, `+`-suffixed when that tree was already dirty.
 *
 * `unknown` when the bundler substituted nothing: under Vitest, where there is no `define`, and in
 * any build where `git` could not answer. Shown rather than hidden, because a build that cannot
 * name itself is a thing worth seeing on the row.
 */
export const PANEL_BUILD_ID: string =
  typeof __PANEL_BUILD__ === "string" && __PANEL_BUILD__ !== "" ? __PANEL_BUILD__ : "unknown";

/** The part of Vite's HMR client this reads. Named so a test can stand in for it. */
export interface DevServerHooks {
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
}

/**
 * The candidate, if it can actually be subscribed to and unsubscribed from.
 *
 * Checked by shape rather than trusted, because `import.meta.hot` is not only Vite's: Vitest
 * defines its own with `on` and no `off`, and calling the missing half threw inside a cleanup,
 * which React surfaces as an unmount crash in every test that renders the row. A half-implemented
 * hot context is not a dev server for this panel, so it reads as absent.
 */
function devServerHooks(candidate: unknown): DevServerHooks | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const { on, off } = candidate as Partial<DevServerHooks>;
  return typeof on === "function" && typeof off === "function"
    ? (candidate as DevServerHooks)
    : undefined;
}

/**
 * Whether this page is still hearing from the dev server.
 *
 * True with no dev server at all: a bundled build cannot go stale against a server it does not
 * have, so reporting it as disconnected would be a warning about nothing.
 *
 * The argument is the seam. Production calls this with no arguments; `import.meta.hot` is absent
 * under Vitest and cannot be stood up there, and the disconnected branch is the whole reason this
 * exists, so it is the one that most needs a test.
 */
export function usePanelConnected(devServer: unknown = import.meta.hot): boolean {
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const hot = devServerHooks(devServer);
    if (!hot) return undefined;
    const lost = () => setConnected(false);
    const found = () => setConnected(true);
    hot.on("vite:ws:disconnect", lost);
    hot.on("vite:ws:connect", found);
    return () => {
      hot.off("vite:ws:disconnect", lost);
      hot.off("vite:ws:connect", found);
    };
  }, [devServer]);

  return connected;
}
