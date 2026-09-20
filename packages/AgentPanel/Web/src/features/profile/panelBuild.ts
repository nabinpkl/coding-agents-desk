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
//
// There is now a third fact, and it is the one a reader most needs: the dev server DELIBERATELY
// holds a change back when the file does not parse (`app/dev-server/panelPublish.ts`), so a
// connected page can be behind the tree on purpose. `held` is what it is sitting on and `blocked`
// is why. Without them the gate would be indistinguishable from the panel quietly not updating,
// which is the failure this module exists to prevent. `sidecars` is the same fact about the other
// processes, which gate their own restarts the same way.
//
// And a fourth, which is the reader's own doing rather than the parser's: `mode` says whether a
// change that parses reaches this page as it lands at all. That is a decision only the server can
// carry out -- Vite's HMR client has no pause -- so this hook does not keep a copy of it. It reads
// the server's answer and sends the reader's, which is why the only two functions here are commands
// rather than state.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PANEL_BUILD_ROUTE,
  PANEL_COMMAND_PARAM,
  PANEL_PUBLISH_EVENT,
  type PanelBuildCommand,
  type PanelBuildReport,
  type PanelUpdateMode,
  type SidecarSupervisorReport,
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
  on(event: string, listener: (data?: unknown) => void): void;
  off(event: string, listener: (data?: unknown) => void): void;
}

/**
 * The candidate, if it can actually be subscribed to and unsubscribed from.
 *
 * Checked by shape rather than trusted, because `import.meta.hot` is not only Vite's: Vitest
 * defines its own with `on` and no `off`, and calling the missing half threw inside a cleanup,
 * which React surfaces as an unmount crash in every test that renders the row. A half-implemented
 * hot context is not a dev server for this panel, so it reads as absent.
 */
export function devServerHooks(candidate: unknown): DevServerHooks | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const { on, off } = candidate as Partial<DevServerHooks>;
  return typeof on === "function" && typeof off === "function"
    ? (candidate as DevServerHooks)
    : undefined;
}

/** Everything the dev server says about the tree this tab is running. */
export interface PanelBuildState {
  /** What to show: the tree the dev server is serving, or the constant when there is no server. */
  id: string;
  /** Whether this page is still hearing from the dev server, and so whether `id` can be trusted. */
  connected: boolean;
  /** Whether a change that parses reaches this page as it lands, or waits to be asked for. */
  mode: PanelUpdateMode;
  /** File names the server is holding back from this page. Empty means the page is current. */
  held: string[];
  /** Which held file will not parse, and why. Null when nothing held is broken. */
  blocked: string | null;
  /** Every machine whose own supervisor is holding its tree back. */
  sidecars: SidecarSupervisorReport[];
}

export interface PanelBuild extends PanelBuildState {
  /**
   * Whether there is a dev server behind this page at all.
   *
   * What the mode control keys off: a bundled panel has no updates to hold in the first place, so
   * the question does not arise there rather than being unavailable there.
   */
  live: boolean;
  /** Choose whether a change that parses reaches this page as it lands. Server-wide. */
  setMode(mode: PanelUpdateMode): void;
  /** Take what is waiting now, without leaving manual. Reloads, since a withheld update is gone. */
  apply(): void;
}

/** What a page with no dev server behind it reports: a frozen bundle holds nothing back. */
const NOT_SERVED = {
  id: PANEL_BUILD_ID,
  connected: true,
  mode: "auto",
  held: [],
  blocked: null,
  sidecars: [],
} satisfies PanelBuildState;

/** A report is read off the wire, so each field is checked rather than cast. */
function readReport(report: PanelBuildReport): Omit<PanelBuildState, "connected"> {
  if (typeof report.build !== "string" || report.build === "") throw new Error("no build");
  return {
    id: report.build,
    // Anything that is not the one word meaning "wait" is the ordinary loop: a report that lost
    // this field should leave the panel updating, not silently stop showing the reader their edits.
    mode: report.mode === "manual" ? "manual" : "auto",
    held: Array.isArray(report.held) ? report.held.filter((name) => typeof name === "string") : [],
    blocked: typeof report.blocked === "string" ? report.blocked : null,
    sidecars: readSidecars(report.sidecars),
  };
}

/** The other processes' gates, checked the same way: a shape that is not the contract is not one. */
function readSidecars(report: PanelBuildReport["sidecars"]): SidecarSupervisorReport[] {
  if (!Array.isArray(report)) return [];
  return report
    .filter((entry): entry is SidecarSupervisorReport => !!entry && typeof entry === "object")
    .map((entry) => ({
      machine: typeof entry.machine === "string" ? entry.machine : "sidecar",
      held: entry.held === true,
      blocked: typeof entry.blocked === "string" ? entry.blocked : null,
      mode: entry.mode === "manual" ? "manual" : "auto",
    }));
}

/**
 * Ask the dev server what it is doing, having first told it something when `command` is given.
 *
 * One function for both because they answer with the same report: a command that changed the mode
 * has already produced the state the row should show, so reading it again afterwards would be a
 * second round trip to learn what the first one just said.
 */
function askServer(
  command: PanelBuildCommand | null,
  signal?: AbortSignal,
): Promise<Omit<PanelBuildState, "connected">> {
  const route = command ? `${PANEL_BUILD_ROUTE}?${PANEL_COMMAND_PARAM}=${command}` : PANEL_BUILD_ROUTE;
  return fetch(route, { method: command ? "POST" : "GET", signal })
    .then((answer) => (answer.ok ? answer.json() : Promise.reject(new Error(String(answer.status)))))
    .then((report: PanelBuildReport) => readReport(report));
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
  const [build, setBuild] = useState<PanelBuildState>(NOT_SERVED);
  // Derived rather than stored: it is a fact about this page's own wiring, known before the first
  // fetch, and a state that starts false would flicker the control off on every mount.
  const live = devServerHooks(devServer) !== undefined;

  useEffect(() => {
    const hot = devServerHooks(devServer);
    if (!hot) return undefined;

    const aborter = new AbortController();
    const reread = () => {
      askServer(null, aborter.signal)
        .then((fresh) => {
          setBuild((current) => ({ ...current, ...fresh }));
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
    // Pushed the moment the server holds something or lets it go, so the row does not wait for an
    // update that is being deliberately withheld from it.
    const published = (data?: unknown) => {
      if (!data || typeof data !== "object") return;
      try {
        setBuild((current) => ({ ...current, ...readReport(data as PanelBuildReport) }));
      } catch {
        reread();
      }
    };

    hot.on("vite:ws:disconnect", lost);
    hot.on("vite:ws:connect", found);
    // Every applied update, which is the moment the tree this tab is running may have moved. A
    // change with no HMR boundary reloads the page instead, and the mount read below covers that.
    hot.on("vite:afterUpdate", reread);
    hot.on(PANEL_PUBLISH_EVENT, published);
    reread();

    return () => {
      aborter.abort();
      hot.off("vite:ws:disconnect", lost);
      hot.off("vite:ws:connect", found);
      hot.off("vite:afterUpdate", reread);
      hot.off(PANEL_PUBLISH_EVENT, published);
    };
  }, [devServer]);

  const command = useCallback(
    (action: PanelBuildCommand) => {
      if (!devServerHooks(devServer)) return;
      void askServer(action)
        .then((fresh) => setBuild((current) => ({ ...current, ...fresh })))
        // The server refused what the reader pressed. Read the state back rather than leave the row
        // showing a mode nobody is in: a toggle that reports itself and is not obeyed is worse than
        // no toggle, since it is the only thing on screen saying why the panel has stopped moving.
        .catch(() =>
          askServer(null)
            .then((fresh) => setBuild((current) => ({ ...current, ...fresh })))
            .catch(() => setBuild((current) => ({ ...current, id: "unknown" }))),
        );
    },
    [devServer],
  );

  const setMode = useCallback((mode: PanelUpdateMode) => command(mode), [command]);
  const apply = useCallback(() => command("apply"), [command]);

  return useMemo(
    () => ({ ...build, live, setMode, apply }),
    [build, live, setMode, apply],
  );
}
