// The one contract between the dev server and the row that reads it.
//
// Its own module because both sides need it and they cannot share much else: the importer on the
// server side is `vite.config.ts`, running under Node before any of the panel exists, so it must
// not reach anything that pulls in React. A literal written twice in two files that never see each
// other is how the two ends stop agreeing.

/** Where the dev server answers with the build id of the tree it is serving RIGHT NOW. */
export const PANEL_BUILD_ROUTE = "/@panel-build";

export interface PanelBuildReport {
  /** Short commit, `+`-suffixed when the tree it was read from was not exactly that commit. */
  build: string;
}
