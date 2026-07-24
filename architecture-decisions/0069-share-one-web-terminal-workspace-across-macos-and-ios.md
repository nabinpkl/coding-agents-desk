---
status: accepted
date: 2026-07-22
supersedes: ADR-0051 (renderer and platform presentation only)
---

# Share one web terminal workspace across macOS and iOS

## Context and Problem Statement

The Rust PTY manager already owns bounded replay, one authoritative grid, revision ordering, and
active-viewer sizing under ADR-0066 through ADR-0068. Terminal presentation still used SwiftTerm plus
separate AppKit and UIKit tab, split, drawer, and pane implementations. A terminal feature therefore
required two UI implementations and could drift between Mac and iPhone.

## Decision Drivers

- Terminal behavior and workspace presentation must be implemented once for both platforms.
- The Rust manager must remain the only terminal-state and parser-reply authority.
- Web content must not gain command, cwd, lifetime, PTY-name, clipboard-read, or arbitrary-link authority.
- Checkpoints and live output must remain bounded across the native-to-web bridge and recover after a
  WebKit process failure without reconnecting the PTY.
- Standalone macOS restoration may persist bounded presentation metadata, never terminal payloads.

## Considered Options

- **Option A**: Continue using SwiftTerm with separate native workspace chrome.
- **Option B**: Use one bundled WKWebView workspace with xterm.js and thin native platform adapters.
- **Option C**: Keep both renderers behind a runtime switch during migration.

## Decision Outcome

Chose **Option B**. `PtyTerminalWebView` owns one WKWebView, protocol-validated renderer delivery, and
the authoritative native `PtyTerminalWorkspaceState`. The bundled JavaScript renders tabs, recursive
splits, pane chrome, the session drawer, terminal status, and one xterm instance per visible pane.
AppKit and UIKit retain lifecycle, transport construction, clipboard writes, external links, safe
areas, keyboard dismissal, and accessibility activation. Workspace mode is used by full Terminal
surfaces; embedded Agent and Workspace terminals use the same runtime in single-session mode.

The maintained xterm.js 6.0.0 release is pinned at upstream revision
`f447274f430fd22513f6adbf9862d19524471c04`. AgentDesk carries one narrow fork that exposes
`onUserData` only when xterm's existing user-input provenance flag is true. Keyboard, IME, paste, and
user mouse data reach the PTY. Parser-generated replies do not, so one Rust headless terminal answers
each terminal query regardless of viewer count. The fork retains the upstream MIT license and a
source/build audit.

Native-to-web delivery is serialized and bounded to 1 MiB of live output per terminal and 32 MiB per
WKWebView. A renderer failure discards affected deltas, reloads the private nonpersistent runtime, and
requests replacement checkpoints. The resource scheme rejects traversal, unknown MIME types, and
oversized resources. CSP denies network access. Web intents are versioned and validated before they
can reach a PTY or platform service.

### Consequences

- Good, because terminal workspace behavior, responsive chrome, input semantics, and accessibility
  identifiers now have one implementation on macOS and iOS.
- Good, because active-viewer ownership and bounded Rust replay remain unchanged at PTY protocol 7.
- Good, because standalone windows restore bounded tabs, split trees, labels, frames, and session names
  while terminal bytes remain memory-only.
- Bad, because WebKit and a small xterm fork become terminal runtime dependencies, and renderer startup
  now includes bundled JavaScript and font loading.
- Neutral, because AppKit and UIKit adapters remain necessary for OS lifecycle and integration.

### Confirmation

`just terminal-web-check` runs JavaScript and fork tests, validates the audited xterm build, publishes
only changed deterministic resources, and checks the generated bundle. Swift package tests cover
workspace state, bridge validation, queue bounds, and
resynchronization. Host and client compile against `PtyTerminalWebView`; a repository scan finds no
SwiftTerm imports or linked products. `just terminal-replay-e2e` is the visible Mac acceptance path;
the iOS visible pass remains behind the repository launch checkpoint.

## Links

- SPEC PTY session lifecycle and terminal module boundaries
- ADR-0066 bounded Rust-owned replay
- ADR-0067 readable follower fit and crop
- ADR-0068 active-viewer source sizing
- xterm.js 6.0.0 release, 2025-12-22: https://github.com/xtermjs/xterm.js/releases/tag/6.0.0
- xterm.js revision `f447274`, 2025-12-22: https://github.com/xtermjs/xterm.js/commit/f447274f430fd22513f6adbf9862d19524471c04
