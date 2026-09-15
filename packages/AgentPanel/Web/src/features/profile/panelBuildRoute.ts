// The one contract between the dev server and the row that reads it.
//
// Its own module because both sides need it and they cannot share much else: the importer on the
// server side is `vite.config.ts`, running under Node before any of the panel exists, so it must
// not reach anything that pulls in React. A literal written twice in two files that never see each
// other is how the two ends stop agreeing.
//
// The publisher plugin (`app/dev-server/panelPublish.ts`) takes these as arguments rather than
// importing them: it lives inside `src`, where relative imports are refused and the `@/` alias does
// not exist yet at config-load time. `vite.config.ts` is the one place that wires the two ends.

/** Where the dev server answers with the build id of the tree it is serving RIGHT NOW. */
export const PANEL_BUILD_ROUTE = "/@panel-build";

/** The dev-server event carrying a new `PanelBuildReport` without waiting for the next poll. */
export const PANEL_PUBLISH_EVENT = "panel:publish-state";

/**
 * What the sidecar's own supervisor is holding back.
 *
 * The other half of the same idea, in a different process: the sidecar runs the working tree, so it
 * is gated the same way the panel is (`agent-feed/sidecar/src/supervisorGate.ts`). A reader looking
 * at a feed with no new rows cannot tell a quiet session from a sidecar that has been refusing to
 * restart for ten minutes, and until this crossed over, only its log could.
 */
export interface SidecarSupervisorReport {
  /** True when a file it watches will not parse, so the running sidecar is older than the tree. */
  held: boolean;
  /** Which file, and what is wrong with it. */
  blocked: string | null;
}

export interface PanelBuildReport {
  /** Short commit, `+`-suffixed when the tree it was read from was not exactly that commit. */
  build: string;
  /**
   * File names changed on disk and NOT handed to this page yet, newest last.
   *
   * Empty is the ordinary state, and the usual one: a file that parses is handed over at once, so
   * anything in here is a file that is not yet a whole file. It is the fact that had nowhere to
   * live before: a reader could not tell a panel that was
   * current from one that had stopped being told.
   */
  held: string[];
  /** Which held file will not parse, and why. Null when nothing is held. */
  blocked: string | null;
  /**
   * The sidecar supervisor's own state, or null when there is not one behind this panel.
   *
   * Null covers both a bundled sidecar, which has no supervisor, and a supervisor that died: it is
   * read from a file it heartbeats, and a stale one reads as absent rather than as its last known
   * state. A frozen report of a dead process is the failure this whole row exists to remove.
   */
  sidecar: SidecarSupervisorReport | null;
}
