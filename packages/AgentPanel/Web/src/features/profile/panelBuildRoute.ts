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
 * Whether a change that parses reaches this page the moment it lands.
 *
 * `auto` is the dev loop as it has always been. `manual` is for reading the panel while somebody is
 * editing it: a whole file is held back alongside the half-written ones and nothing on screen moves
 * until the reader asks for it. The parse gate is the same in both, so a broken file is never
 * handed over either way -- what the mode decides is only what happens to the GOOD ones.
 *
 * It lives on the dev server rather than in this page's storage, for the same reason the gate does:
 * Vite's HMR client has no pause, so the only place an update can be sat on is before it is sent.
 * One server then means one answer for every surface it serves, which is what a reader with the
 * panel open on a phone and a Mac wants from a control they set once. It is forgotten when the
 * server restarts, and the row says which mode is in force so that is visible rather than implied.
 */
export type PanelUpdateMode = "auto" | "manual";

/**
 * Setting the mode, reloading every surface onto what is waiting (`apply`), or restarting one
 * machine's held sidecar (`restart`, naming it in `PANEL_MACHINE_PARAM`).
 *
 * Two commands rather than one because they cost different things and a reader asks for them at
 * different moments: a reload keeps every sidecar stream on the other side alive, and a restart
 * drops all of them. One button used to do both, so taking a panel change restarted every
 * machine's sidecar under every surface.
 */
export type PanelBuildCommand = PanelUpdateMode | "apply" | "restart";

/**
 * How a command is sent: `POST <PANEL_BUILD_ROUTE>?action=manual`, answered with the new report.
 *
 * A query parameter rather than a body, because the dev server's middleware would otherwise have to
 * read and bound one for a single word, and this carries nothing that does not belong in a URL.
 */
export const PANEL_COMMAND_PARAM = "action";

/** Which machine a `restart` is for, by the label its row shows. */
export const PANEL_MACHINE_PARAM = "machine";

/**
 * What the sidecar's own supervisor is holding back.
 *
 * The other half of the same idea, in a different process: the sidecar runs the working tree, so it
 * is gated the same way the panel is (`agent-feed/sidecar/src/supervisorGate.ts`). A reader looking
 * at a feed with no new rows cannot tell a quiet session from a sidecar that has been refusing to
 * restart for ten minutes, and until this crossed over, only its log could.
 *
 * One per machine, because the panel reads more than one: a session on an ssh peer is served by
 * that peer's own sidecar and gated by that peer's own supervisor.
 */
export interface SidecarSupervisorReport {
  /** The label the reader knows the machine by, which is how the row names it. */
  machine: string;
  /** True when the tree it watches has moved on from the sidecar it is running. */
  held: boolean;
  /** Which file will not parse, and what is wrong with it. Null when nothing is broken. */
  blocked: string | null;
  /**
   * Whether that machine takes a tree that parses at once, or waits to be asked.
   *
   * Carried per machine rather than assumed from the panel's own, because a supervisor that
   * restarted comes back on auto. The row reads it to tell a machine that is stuck on half a file
   * from one that is simply waiting for the reader.
   */
  mode: PanelUpdateMode;
}

export interface PanelBuildReport {
  /** Short commit, `+`-suffixed when the tree it was read from was not exactly that commit. */
  build: string;
  /** Whether a change that parses is handed to this page at once, or waits to be asked for. */
  mode: PanelUpdateMode;
  /**
   * File names changed on disk and NOT handed to this page yet, newest last.
   *
   * Empty is the ordinary state, and the usual one under `auto`: a file that parses is handed over
   * at once, so anything in here is a file that is not yet a whole file. Under `manual` the whole
   * ones queue here too, and the reader is the one who empties it. Either way it is the fact that
   * had nowhere to live before: a reader could not tell a panel that was current from one that had
   * stopped being told.
   */
  held: string[];
  /**
   * Which held file will not parse, and why. Null when nothing held is broken.
   *
   * Not the same question as `held` being non-empty, since manual mode holds whole files too, and
   * it is what decides whether the reader can apply them: a reload onto a half-written file is
   * exactly the broken page this gate exists to prevent.
   */
  blocked: string | null;
  /**
   * Every machine whose sidecar supervisor is holding its tree back. Empty is the ordinary state.
   *
   * Absence covers a bundled sidecar, which has no supervisor, and a supervisor that stopped
   * heartbeating: a stale descriptor reads as no supervisor rather than as its last known state,
   * because a frozen report of a dead process is the failure this whole row exists to remove.
   */
  sidecars: SidecarSupervisorReport[];
}
