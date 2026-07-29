# AgentDesk xterm fork

- Upstream: `xtermjs/xterm.js`
- Package: `6.1.0-beta.292`
- Revision: `904ae935269eef5ec6a1415b64463c3d02eff1eb`
- Backport: PR `#6059`, commit `2ba600589bf3dfdcf544aad4f9a350d885132baf`
- License: MIT, retained in `package/LICENSE`

The beta revision is the maintained upstream line after the 6.0.0 release and
contains touch scrolling for normal scrollback, alternate buffers, and terminal
mouse protocols. The backport rejects non-finite coordinates from touch inertia
before they can become malformed mouse reports.

AgentDesk adds one public `onUserData` event. `CoreService` fires it only when the
existing `wasUserInput` provenance flag is true, `CoreTerminal` forwards it, and
the public `Terminal` exposes it. `onData` remains unchanged for upstream
compatibility and `onBinary` remains the separate path for binary mouse reports.

This fork prevents every renderer from forwarding parser-generated device,
focus, color, and cursor replies to the PTY. The Rust headless terminal remains
the only authority that answers those queries.

Audit the provenance source changes, touch-scroll backport, and generated-module rules in
`scripts/built-module-patch.mjs` whenever the upstream revision changes. After
updating an official prebuilt module, run `scripts/update-built-module.mjs`
explicitly to add the provenance event. Source-built modules already contain it.
Normal builds run `scripts/check-built-module.mjs` and never modify vendor files.
