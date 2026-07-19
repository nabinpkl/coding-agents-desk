---
status: accepted
date: 2026-07-19
---

# Compose the iOS workspace as resizable panes with a host-resolved terminal

## Context and Problem Statement

The iOS Files surface currently replaces its directory list with a full-surface file preview, while
the global Terminal surface starts unscoped `agentdesk-N` shells. The desired workspace experience is
one stable workbench: a collapsible file sidebar, an editor/viewer, and one persistent terminal rooted
at the selected workspace. The client knows only an opaque workspace id, so terminal cwd and session
eligibility need a host authority.

## Decision Drivers

- Keep workspace roots and containment authoritative on the host.
- Preserve file viewer and terminal state while panes resize or collapse.
- Allow iOS to reattach a terminal opened by the macOS workspace shell.
- Keep the existing global Terminal surface for general PTY management.
- Start with one workspace shell and defer multipane terminal UI.

## Considered Options

- Add a terminal toggle inside the existing file preview overlay and send the workspace root to iOS.
- Replace Files and Terminal with mutually exclusive full-screen workspace surfaces.
- Compose a dedicated workbench and coordinate workspace PTYs on the host.

## Decision Outcome

Choose a dedicated UIKit workbench. Its left sidebar never overlays the right column. The right column
contains the shared file viewer/editor above a keyboard-safe terminal panel. Both dividers are
resizable and accessible; visibility and geometry persist per workspace. First use shows the sidebar,
an empty editor, and an open terminal.

The iOS client requests a workspace terminal using an opaque workspace id and an optional remembered
PTY name. The host resolves the workspace root, validates the remembered session, otherwise selects
the newest running persistent PTY in the workspace namespace, and creates a login shell at the root
only when none exists. macOS and iOS workspace terminals share
`workspace-<workspace-id>-<suffix>` identity. General `agentdesk-*` terminals and leased
`agent-resume-*` terminals remain separate.

Session creation time is added to PTY summaries so newest selection is deterministic, raising the
inner PTY protocol to v5. Workspace terminal coordination uses the authenticated input lane while PTY
bytes remain on the terminal lane, raising the AgentDesk session protocol to v10. The client never
receives a workspace root.

### Consequences

- Good, because workspace selection is the single authority for explorer, editor, and terminal.
- Good, because Mac and iPhone can attach to the same persistent workspace PTY.
- Good, because resizing cannot recreate the WKWebView or SwiftTerm content.
- Bad, because terminal attachment adds a host handoff state machine and a protocol bump.
- Neutral, because full terminal tabs, splits, session browsing, and disconnected output replay remain
  later work.

### Confirmation

Tests must prove preferred, newest, and create-new selection; reject wrong workspace, cwd, lifetime,
and stale responses; preserve pane state through resize and collapse; and show that no absolute host
path crosses the AgentDesk wire. Live verification uses the isolated dev host and simulator only after
the repository checkpoint.

## Pros and Cons of the Options

### Preview-overlay terminal

- Good, because it changes fewer UIKit files.
- Bad, because file navigation, editing, layout, and terminal lifecycle remain one coupled view.
- Bad, because sending cwd duplicates host authority on the client.

### Mutually exclusive Files and Terminal

- Good, because the existing top switcher already supports both surfaces.
- Bad, because the editor and terminal cannot be used together and workspace context remains implicit.

### Dedicated host-coordinated workbench

- Good, because region ownership and lifecycle are explicit and independently testable.
- Good, because the host validates every workspace-to-PTY mapping.
- Bad, because it requires coordinated PTY, wire, host, and UIKit changes.

## Links

- ADR-0052 AgentDesk owns the Agent workspace
- ADR-0053 AgentDesk owns the terminal PTY packages
- ADR-0054 Shared workspace foundation and platform presentation
- ADR-0056 Bottom Agent Panel terminal
- Apple `keyboardLayoutGuide` documentation, no publication date verifiable:
  https://developer.apple.com/documentation/uikit/uiview/keyboardlayoutguide
