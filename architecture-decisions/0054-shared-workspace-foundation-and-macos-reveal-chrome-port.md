---
status: accepted
date: 2026-07-10
---

# Share the workspace+files data model; port the agent-workspace-ide shell into the host

## Context and Problem Statement

The v2/v3 consolidation (ADR-0052, TASKS R14-R35) moved workspace ownership into AgentDesk and retired the `agent-workspace-ide` donor, but it stopped at a stopgap: the macOS shell is a single titled `NSPanel` (`host/AgentDeskHost/WorkspaceShell/WorkspaceShellPanelController.swift`), not the donor's reveal-on-hover sidebar + top bar with its recursive file tree and editor; and the workspace/file logic exists as **two bespoke copies** — the host's `WorkspaceShellController` + `WorkspaceShellFileTree`, and the iOS client's `WorkspaceFilesBrowser` + `WorkspaceFilesBrowserModel` — sharing only the `AgentDeskWire` wire DTOs. This ADR decides how to finish the merge. The reusable shape shared between iOS and macOS is **just the workspace data + files model**; on top of it, **macOS behaves as it did in `agent-workspace-ide`** (the donor's real shell ported into the host), and iOS keeps its own surface. It affects `host/AgentDeskHost/WorkspaceShell/*`, `client/AgentDeskClient/WorkspaceFiles*`, and a new `packages/WorkspaceKit`.

## Decision Drivers

- **Single source of truth for the data.** The host and iOS each carry parallel workspace/file **data** types; drift between them (a second `FileRevision`, a second entry shape) is a live bug source. One data+files model both platforms build on.
- **Clean platform boundary.** iOS reuses only the data+files model. AppKit/macOS-only types (overlay panels, CGEvent tap, the recursive tree, the reveal state machine) must not leak into the iOS surface.
- **macOS fidelity.** The macOS shell should behave as the proven donor IDE (recursive file tree, editor, reveal sidebar + top bar), not a reduced port. Reuse the donor's proven code rather than re-derive it.
- **Complete merge, one lifecycle.** Starting the AgentDesk host must start the whole shell. No separate IDE process (the companion-process arc was already rejected, TASKS v3). The donor stays retired; the only donor touch remains the one-time `workspace.json` import.
- **Protect the daily driver.** The reveal chrome is built incrementally behind the existing flag; a half-built overlay must not land on the running host. Gate until solid, then flip on.
- **Correct reveal mechanism.** Hidden all-Spaces panels miss `NSEvent` edge movement on non-owning Desktops; the donor uses a listen-only CGEvent session tap, which needs Input Monitoring.

## Considered Options

- **Option A**: Extract a shared, platform-agnostic `WorkspaceKit` package holding **only the workspace data + files model** (identity, directory-entry model, `FileRevision`, contents, `FilePreviewKind`, editor/save state), reconciled with `AgentDeskWire`, consumed by both host and iOS. Port the donor's macOS shell faithfully into the **host target** (recursive tree, editor/viewer, and the reveal chrome: `FocusableOverlayPanel`, a narrowed `ShellOverlay`, `EdgeRevealController` + `PointerEventTap`, the reveal state machine + `SlotLayout`), rendered over the shared data model, replacing the stopgap panel. iOS reuses only the shared data model, keeps its own drill-down surface, and gains the workspace picker; it never imports the tree, reveal, or overlay code.
- **Option B**: Keep the stopgap panel; only set `collectionBehavior`/`.floating` so it joins all Spaces. No shared model, no donor fidelity, two data-model copies remain.
- **Option C**: Keep `agent-workspace-ide` running as a companion process and IPC workspace/file state.
- **Option D**: Port the donor shell and re-implement the data model per platform, without a shared package.

## Decision Outcome

Chose **Option A**. It satisfies the single-source-of-truth (data) and clean-boundary drivers together while keeping macOS fidelity: the data+files model lives once in `WorkspaceKit` and both surfaces build on it, the donor's macOS shell is ported faithfully on top of it, and the AppKit/macOS-only code (tree, reveal, overlay) never reaches iOS. The two navigations stay independent by design — macOS presents the donor recursive tree, iOS presents its drill-down list — because the reusable shape is the data, not the presentation. Option B fails the macOS-fidelity and single-source drivers (leaves the stopgap and the data duplication). Option C fails the one-lifecycle driver (two lifecycle owners; iOS authority depends on a retired app) and was already rejected. Option D fails the single-source-of-data driver (the duplicated `FileRevision`/entry types it leaves are the exact drift surface this work removes). The reveal chrome uses the donor's CGEvent session tap, not `NSEvent` monitors, because the all-Spaces reveal requirement makes `NSEvent` monitoring structurally unreliable.

### Consequences

- Good, because each workspace/file **data** type (`FileRevision`, directory entry, preview kind, editor/save state) has one home both platforms import; a data-shape change lands once.
- Good, because macOS gets the donor's proven shell behavior (recursive tree, editor, floating all-Spaces reveal-on-hover sidebar + top bar) instead of the Space-pinned stopgap.
- Good, because iOS finally gets the multi-workspace picker (the HANDOVER "workspaces didn't carry over" symptom) from the shared workspace list.
- Bad, because the reveal tap introduces an **Input Monitoring** TCC dependency on the host. We accept it, add an explicit `CGRequestListenEventAccess()` prompt, and degrade to pinned/always-visible bars when the grant is absent (the donor silently no-ops; we fail visible instead).
- Bad, because the donor port surface is large (tree, editor/viewer, overlay, helper views). Bounded by porting faithfully (proven code) and phasing navigation/editor before the reveal chrome so each lands green.
- Neutral, because the two navigations remain separate (macOS tree, iOS list). This is intentional: the reusable shape is the data model, not the presentation, so each platform keeps the UX its users expect.
- Neutral, because the AppKit shell stays in the host target rather than a macOS-only package. Single consumer today; extract a package only if a second macOS consumer appears.

### Scope boundary (ported vs left behind)

Ported from the donor into the host (macOS-only), over the shared data model + the host's `WorkspaceRepository`/`WorkspaceFilesResponder`: the recursive file tree (`FileTree`/`FileNode` + a live reader), the file pane and editor/viewer, and the reveal chrome (`FocusableOverlayPanel`, the sidebar + top-bar halves of `ShellOverlay`, `EdgeRevealController` + `PointerEventTap`, driven by the host's already-copied reveal state machine + `WorkspaceShellLayout`). Filled with AgentDesk's own content (workspace switcher, tree, editor, Agents command). The host's thinner `WorkspaceShellFileTree` is replaced by the donor's proven tree; the stopgap `WorkspaceShellPanelController` is deleted.

Left behind: ShellBook, dock enrichment (the third overlay), tenants/slot-tenant/chrome-borrow window placement, notebooks/Jupyter, desktop/Space auditing. `RevealSurfaceID` narrows to `{ sidebar, topBar }`.

### Confirmation

- `just check` (host + wire, including a new `WorkspaceKit` `swift test` leg) and `just sim-test` (client) green at each slice.
- Grep fitness function: after the data-model slice, each shared data/files type (`FileRevision`, directory entry, preview kind) resolves to one `WorkspaceKit`/`AgentDeskWire` home imported by both targets; no second copy.
- Reveal chrome live-verified via the host's in-host AX self-report (sidebar + topBar controls reachable, active-workspace tree entry count) plus a manual all-Spaces reveal-on-hover check on a different desktop than the launch Space (the case the CGEventTap exists to cover).
- Input Monitoring absent path verified: bars fall back to pinned/visible, and the missing grant is surfaced.

## Pros and Cons of the Options

### Option A (chosen)

- Good, because one data+files model both platforms build on, with a clean AppKit/iOS boundary.
- Good, because macOS reuses the donor's proven shell rather than re-deriving it.
- Bad, because the donor port is large and adds an Input Monitoring dependency.

### Option B

- Good, because trivial (one-line `collectionBehavior`).
- Bad, because delivers neither the donor shell nor a shared data model; entrenches the stopgap and the duplication.

### Option C

- Bad, because two lifecycle owners and iOS file authority depends on a retired app. Already rejected in TASKS v3.

### Option D

- Good, because the shell ships without a shared-package step.
- Bad, because it re-creates the parallel data-type drift this work exists to remove.

## Links

- ADR-0050 shared wire package (`AgentDeskWire`), the existing both-platforms seam this builds on
- ADR-0052 AgentDesk owns the agent workspace
- ADR-0053 AgentDesk owns the terminal PTY packages; donor tombstoned
- `tasks/archive/v2-v3-workspace-consolidation.md` promotion log (R14-R35); this iteration (TASKS.md v4) continues at R36
- Donor reference: `agent-workspace-ide/ide/Sources/WorkspaceShell/{FileTree,FileTreeLive,FileRevision,FilePreviewKind,ShellOverlay,FocusableOverlayPanel,EdgeRevealController,EdgeReveal,SlotLayout}.swift`
