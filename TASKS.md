# TASKS: v4 shared workspace+files data model and the ported macOS reveal shell

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green. Continues the numbering from the
archived v2/v3 ledger (`tasks/archive/v2-v3-workspace-consolidation.md`, R14-R35); v4 starts at R36.

## Position

Per ADR-0054, the reusable shape shared between iOS and macOS is the workspace **data + files model**
only. On top of it, macOS behaves as `agent-workspace-ide` (the donor's recursive tree, editor, and
reveal-on-hover sidebar + top bar ported into the host), while iOS keeps its own drill-down surface
plus a new workspace picker. Ordering and reasons:

- The shared home (`WorkspaceKit`) exists before anything imports it (A first).
- The data model is already shared via `AgentDeskWire`, so no standalone data-model refactor was
  needed; the iOS picker (a known bug fix) validates the seam cheaply before the large host port (C
  before D).
- macOS keeps the donor tree, not the iOS list: the reusable shape is the data, not the presentation.
- The shell stayed flag-gated during the port and flipped on last, so a half-built overlay never
  landed on the running host (D before E).
- The reveal pointer source is a CGEvent session tap, not `NSEvent` monitors, because hidden
  all-Spaces panels miss `NSEvent` edge movement on non-owning Desktops (see ADR-0054, DECISIONS D11).

## v4 Phase 0: ADR gate

- [x] R36pre. ADR-0054 records the boundary: shared = workspace data + files model; macOS ports the
  donor shell faithfully; iOS reuses only the data model. Accepted.

## v4 Phase A: WorkspaceKit skeleton

- [x] R36. `packages/WorkspaceKit` (library + tests, dep on `AgentDeskWire`, macOS 26 / iOS 26),
  linked into both the host and client app+test targets, added as a `swift test` leg to `just check`.
  A smoke test asserts the module imports and a shared wire type is reachable.

## v4 Phase B: share the workspace+files data model

- [x] R37. FINDING: the shared files data model already exists as `AgentDeskWire` (the iOS model uses
  `WorkspaceSummary`/`WorkspaceDirectoryEntry`/`WorkspaceFileRevision`). No standalone data-model
  refactor: the host adopts shared types when the donor tree lands (Phase D), and non-wire domain
  types (e.g. `FilePreviewKind`) move into `WorkspaceKit` when a consumer needs them, to avoid dead
  code. `WorkspaceKit` is a skeleton pending its first non-wire tenant.

## v4 Phase C: iOS workspace picker

- [x] R38. Replaced the Files surface's static title with a workspace picker
  (`WorkspaceFilesSurface.workspacePickerButton`, a11y id `workspace-files-picker`) that lists every
  workspace and switches via `browser.selectWorkspace`, and dropped the auto-select-first in
  `PairingViewController+AgentSurface.ensureFilesSurface`. Test: `loadWorkspaces` selects nothing and
  lists no directory; only an explicit pick issues the picked workspace's root listing. `just sim-test`
  green (295 client).

## v4 Phase D: port the donor macOS reveal shell into the host

- [x] R39. Kept `WorkspaceShellController` + `WorkspaceShellFileTree` (already the donor's
  recursive-lazy tree behavior) and the shared `WorkspaceFilesResponder` write path; no churn-swap to
  the donor tree, which is behavior-identical.
- [x] R40. Ported `FocusableOverlayPanel` + a narrowed `WorkspaceShellOverlay` (sidebar + top bar; the
  donor's third dock panel dropped) + `WorkspaceShellPointerTap`, wired to the existing
  `WorkspaceShellEdgeRevealController` + `WorkspaceShellRevealStateMachine` over `WorkspaceShellLayout`.
  `WorkspaceShellPresenter` hosts the switcher/tree/editor in the sidebar and Agents/pin in the top
  bar, and carries the AX self-report forward.
- [x] R41. Input Monitoring: `CGPreflightListenEventAccess` gate; the tap creates in `start()`
  (returns false when absent) so the presenter degrades to pinned/visible bars and prompts, rather
  than the donor's silent no-op. Test: `pinnedSurfaceRemainsVisibleWithoutPointerMovement`
  (EdgeRevealStateTests) covers the pinned-config behavior the degrade relies on.
- [x] R42. SpaceAgent re-parks below the top bar (origin key v2 -> v3, ~52pt clearance when the shell
  is on) so the two floating panels do not overlap. Test:
  `defaultOriginParksClearOfTheWorkspaceTopBar` (SpaceAgentModelTests).
- [x] R43. Deleted the stopgap `WorkspaceShellPanelController`; `startWorkspaceShellIfEnabled` builds
  the ported reveal shell under the same flag. Reveal hysteresis + tree + revision-checked save
  covered by existing EdgeRevealState / WorkspaceShellController / FileTree / WorkspaceFileService
  suites. `just check` green (420 host).
- [x] R43rev. Review follow-ups: made `WorkspaceShellPointerTap` genuinely restartable (tap built in
  `start()`, torn down in `stop()`, run() clears only its own slots by identity), coalesced pointer
  events to one main-actor drain per burst, removed a dead key-state hook.

## v4 Phase E: flag flip and end-to-end verification

- [x] R44a. Flipped `Config.workspaceShellEnabled` default to on (env override still disables). Host
  start = all start.
- [x] R44b. Live-verified via the host's `workspace-shell` AX self-report: sidebar + top bar built,
  all five controls reachable, pointer tap started (Input Monitoring granted), active workspace tree
  populated (18 entries).
- [ ] R44c. iOS Maestro picker flow on the simulator: Files opens with no workspace auto-selected, tap
  `workspace-files-picker`, select a workspace, assert its root entries list.

## Promotion log

```
R36pre   2026-07-11  accepted    ADR-0054 boundary (share data model; port donor shell faithfully)
R36      2026-07-11  green       WorkspaceKit skeleton linked into host + client; just check leg added
R37      2026-07-11  green       data model already shared via AgentDeskWire; no standalone refactor
R38      2026-07-11  green       iOS workspace picker; auto-select-first removed; sim-test green (295)
R39-R43  2026-07-11  verified    donor reveal shell ported into the host; live AX self-report positive
R43rev   2026-07-11  green       pointer-tap restartability + coalescing; review NOT GREEN items fixed
R44a-b   2026-07-11  verified    shell default-on; host AX self-report confirms the reveal chrome
R44c     pending     pending     iOS Maestro picker flow on the simulator
```
