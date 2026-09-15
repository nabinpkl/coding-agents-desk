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

/**
 * Where an agent or a reader says "this tree is good, hand it over".
 *
 * A POST, because it changes what every open tab is running. Nothing in it is trusted as content:
 * the server publishes what it is already holding, and the caller only chooses the moment.
 */
export const PANEL_PUBLISH_ROUTE = "/@panel-build/publish";

/** The dev-server event carrying a new `PanelBuildReport` without waiting for the next poll. */
export const PANEL_PUBLISH_EVENT = "panel:publish-state";

export interface PanelBuildReport {
  /** Short commit, `+`-suffixed when the tree it was read from was not exactly that commit. */
  build: string;
  /**
   * File names changed on disk and NOT handed to this page yet, newest last.
   *
   * Empty is the ordinary state. Anything in it means the page is deliberately behind the tree,
   * which is the fact that had nowhere to live before: a reader could not tell a panel that was
   * current from one that had stopped being told.
   */
  held: string[];
  /** The first thing the typechecker objected to, or null when it has no objection. */
  blocked: string | null;
  /** True while the typechecker is still deciding, so `blocked` is last round's answer. */
  checking: boolean;
  /**
   * True when there is no typechecker behind the gate and updates are going straight through.
   *
   * Said out loud rather than failed on: a dev loop that stops delivering edits because its
   * gatekeeper died is worse than one that delivers them unfiltered, and a reader who cannot see
   * which of the two they are in gets the worst of both.
   */
  unfiltered: boolean;
}
