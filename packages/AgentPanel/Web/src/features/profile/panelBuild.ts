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
//   - The BUILD ID names the tree. In a bundled build the compile-time constant IS the tree,
//     because the bundle is frozen. Under a dev server it is not: `define` is substituted once,
//     when Vite loads its config, so the constant names the last SERVER RESTART and nothing else.
//     Measured 2026-09-14, and it is why the id is re-read from the server rather than trusted:
//     the chip read `f2dffa6+` while HEAD was `7373cec` and the tree was clean, two commits later.
//   - CONNECTEDNESS is what carries freshness. A tab still attached to the dev server is current
//     by construction -- Vite pushes each change, and a module with no HMR boundary
//     (`activityFeedLayout.ts`, say) makes it send a full reload. A tab that lost the socket is
//     precisely the stale case, and it is silent today: the page keeps working, it just stops
//     hearing about the tree.
//
// So the row shows the id, re-read on every update, and lets the TONE say whether the page is
// still in a position to know.

import { useEffect, useState } from "react";
import {
  PANEL_BUILD_ROUTE,
  type PanelBuildReport,
} from "@/features/profile/panelBuildRoute";

/**
 * The build id baked in at compile time, `+`-suffixed when that tree was not exactly a commit.
 *
 * Exact for a bundled build and only a starting point under a dev server, which is what the hook
 * below re-reads. `unknown` when the bundler substituted nothing: under Vitest, where there is no
 * `define`, and in any build where `git` could not answer. Shown rather than hidden, because a
 * build that cannot name itself is a thing worth seeing on the row.
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

export interface PanelBuild {
  /** What to show: the tree the dev server is serving, or the constant when there is no server. */
  id: string;
  /** Whether this page is still hearing from the dev server, and so whether `id` can be trusted. */
  connected: boolean;
}

/**
 * The build this tab is running, kept current for as long as the page can hear the dev server.
 *
 * `connected` is true with no dev server at all: a bundled build cannot go stale against a server
 * it does not have, so reporting it as disconnected would be a warning about nothing, and its
 * compile-time id is already exact.
 *
 * The argument is the seam. Production calls this with no arguments; `import.meta.hot` is absent
 * under Vitest and cannot be stood up there, and the disconnected branch is the whole reason this
 * exists, so it is the one that most needs a test.
 */
export function usePanelBuild(devServer: unknown = import.meta.hot): PanelBuild {
  const [build, setBuild] = useState<PanelBuild>({ id: PANEL_BUILD_ID, connected: true });

  useEffect(() => {
    const hot = devServerHooks(devServer);
    if (!hot) return undefined;

    const aborter = new AbortController();
    const reread = () => {
      fetch(PANEL_BUILD_ROUTE, { signal: aborter.signal })
        .then((answer) => (answer.ok ? answer.json() : Promise.reject(new Error(String(answer.status)))))
        .then((report: PanelBuildReport) => {
          if (typeof report.build !== "string" || report.build === "") throw new Error("no build");
          setBuild((current) => ({ ...current, id: report.build }));
        })
        .catch(() => {
          // A dev server that cannot say what the tree is gets `unknown`, not the constant this
          // bundle was born with. A frozen id that reads as a live one is the thing being removed
          // here, so falling back to it would reinstate exactly the failure.
          if (!aborter.signal.aborted) setBuild((current) => ({ ...current, id: "unknown" }));
        });
    };

    const lost = () => setBuild((current) => ({ ...current, connected: false }));
    const found = () => {
      setBuild((current) => ({ ...current, connected: true }));
      reread();
    };

    hot.on("vite:ws:disconnect", lost);
    hot.on("vite:ws:connect", found);
    // Every applied update, which is the moment the tree this tab is running may have moved. A
    // change with no HMR boundary reloads the page instead, and the mount read below covers that.
    hot.on("vite:afterUpdate", reread);
    reread();

    return () => {
      aborter.abort();
      hot.off("vite:ws:disconnect", lost);
      hot.off("vite:ws:connect", found);
      hot.off("vite:afterUpdate", reread);
    };
  }, [devServer]);

  return build;
}
