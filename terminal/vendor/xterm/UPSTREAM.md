# AgentDesk xterm fork

- Upstream: `xtermjs/xterm.js`
- Release: `6.0.0`
- Revision: `f447274f430fd22513f6adbf9862d19524471c04`
- License: MIT, retained in `package/LICENSE`

AgentDesk adds one public `onUserData` event. `CoreService` fires it only when
the existing `wasUserInput` provenance flag is true, and the public `Terminal`
forwards that event. `onData` remains unchanged for upstream compatibility and
`onBinary` remains the separate path for binary mouse reports.

This fork prevents every renderer from forwarding parser-generated device,
focus, color, and cursor replies to the PTY. The Rust headless terminal remains
the only authority that answers those queries.

Audit the three source changes and the generated module patch in
`scripts/patch-built-module.mjs` whenever the upstream revision changes.
The vendored tree also removes one trailing blank line from
`src/browser/TimeBasedDebouncer.ts` to satisfy the repository whitespace gate.
