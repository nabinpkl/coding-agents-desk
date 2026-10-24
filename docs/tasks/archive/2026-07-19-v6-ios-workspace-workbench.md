# TASKS: v6 iOS workspace workbench

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger continues from the archived v5 ledger through D73.

## Position

This iteration turns the existing iOS Files surface into one workspace workbench: a collapsible,
resizable file sidebar on the left, the shared file viewer/editor in the upper-right, and one
resizable persistent workspace terminal in the lower-right. The existing global Terminal surface
remains available for general PTY management.

The host terminal contract lands before UIKit consumes it because the iPhone must never derive or
receive an authoritative workspace root. The Files surface is then split into explorer and editor
regions before the terminal joins, so layout state and terminal lifecycle do not accumulate inside
the existing preview overlay.

## v6 Phase 0: decision and compatibility gate

- [x] D74. Accept ADR-0061 and update `SPEC.md` with the workspace workbench, host-resolved persistent
  terminal selection, shared macOS/iOS workspace-terminal identity, PTY protocol v5 recency metadata,
  and AgentDesk session protocol v10 requirement.

## v6 Phase 1: terminal identity and wire contract

- [x] D75. Extend the in-tree PTY protocol and both generated clients with immutable session creation
  time, bump the inner protocol to v5, and test that reattach preserves it while recreation replaces it.
- [x] D76. Add workspace-terminal open, ready, attached, cancel, and typed-error messages to
  `AgentDeskWire`; route them on the authenticated input lane and bump the session protocol to v10.
  Tests pin compact encoding, stale request fencing, and v9 rejection.

## v6 Phase 2: host-owned workspace terminal

- [x] D77. Add a host `WorkspaceTerminalCoordinator` that resolves an opaque workspace id through
  `WorkspaceRepository`, validates a remembered PTY, otherwise selects the newest running persistent
  workspace PTY, and creates a login shell at the workspace root only when none exists. Hold a
  bootstrap attachment until iOS acknowledges and clean failed handoffs without killing preexisting
  sessions.
- [x] D78. Give macOS and iOS-created workspace terminals the same host-generated
  `workspace-<workspace-id>-<suffix>` identity so either platform may attach. General and leased Agent
  Panel terminals remain outside this namespace. Tests reject wrong-workspace names, cwd mismatches,
  incompatible lifetime, and invalid store ids.

## v6 Phase 3: iOS workbench

- [x] D79. Replace the Files preview overlay with a `WorkspaceWorkbenchSurface` composed from explorer
  and editor children. Add pure per-workspace layout state and persistence. First-use state is sidebar
  visible, editor empty, and terminal visible; the sidebar never overlays the editor. Tests cover
  divider clamping, collapse, workspace restoration, and no viewer reload during resize.
- [x] D80. Add one shared SwiftTerm content view per visited workspace. Reattach the remembered PTY
  after reconnect or relaunch, fall back to the host-selected latest PTY, and create only when none is
  available. Terminal collapse preserves the attachment; session loss is visible and retryable.
  Tests cover workspace switching, generation fencing, keyboard-safe layout, and explicit teardown.

## v6 Phase 4: integration and live checkpoint

- [x] D81. Run PTY Rust and Swift package tests, wire tests, host/client focused tests, `just check`,
  and `just sim-test`; self-review the complete cross-file contract and confirm no full host path is
  exposed on the iOS wire.
- [x] D82. After the repository launch checkpoint and explicit user approval, install the isolated dev
  host and simulator client, verify both build SHAs, and smoke sidebar resize/collapse, empty editor,
  file viewing, terminal resize/input, workspace cwd, relaunch reattachment, and Mac-created terminal
  attachment using accessibility identifiers and app-only screenshots.

## v6 Phase 5: workspace naming and viewer zoom

- [x] D83. Rename the iOS switcher surface and automation contract from Files to Workspace, replace
  the folder symbol with an IDE-layout symbol, and expose shared content-aware zoom controls for every
  open file. Viewer tests pin bounded text scaling and DOCX viewport delegation; iOS tests pin the
  symbol, label, picker, and controls for text and DOCX.

---

## v7 scope (captured, not started)

- Workspace terminal tabs, splits, and a workspace-filtered session drawer.
- Bounded PTY output replay so a fully disconnected client reconstructs prior terminal display state.

## Promotion log

```
D74      2026-07-19  landed      workspace workbench and terminal authority decision
D75      2026-07-19  landed      immutable PTY session creation time and inner protocol v5
D76      2026-07-19  landed      authenticated workspace-terminal wire contract and protocol v10
D77-D78  2026-07-19  landed      host workspace resolution, safe handoff, and shared PTY identity
D79      2026-07-19  landed      resizable UIKit explorer, empty editor, and persistent pane state
D80      2026-07-19  landed      one persistent shared workspace shell
D81      2026-07-19  landed      PTY, wire, host, client, and simulator gates green
D82      2026-07-19  landed      dev SHA, workbench, persistent reattach, and Mac-created PTY smoke green
D83      2026-07-19  landed      Workspace naming, IDE symbol, and content-aware viewer zoom
```
