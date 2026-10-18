/**
 * The React plugin, as the dev server, the build and the tests all run it: with React Compiler.
 *
 * One home so the tests exercise the compiled code the panel ships, not a plainer build beside it.
 *
 * The compiler is oxc's Rust port (`oxc-transform-react`, pinned to the range plugin-react accepts),
 * which plugin-react still calls experimental. It memoizes each component and hook it can prove
 * safe, so a parent re-rendering for an unrelated reason no longer drags unchanged children along.
 * Measured on the Canvas on 2026-10-18, against the same build without it: 31 to 59 percent of the
 * component renders and 43 to 70 percent of the render time, idle and while typing.
 *
 * What it cannot prove safe it leaves as written, and says why with `compiler: { logDiagnostics:
 * true }`. The commonest reasons are lint errors in `.oxlintrc.json` (`react/refs`, ...). The one
 * lint does not catch is most of what it skips today: a `useCallback` whose list leaves out a setter
 * from one of our own hooks, which it cannot know is stable.
 */

import react from "@vitejs/plugin-react";

export function panelReact() {
  return react({ compiler: true });
}
