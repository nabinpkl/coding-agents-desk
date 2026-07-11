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
- [x] R44c. iOS Maestro picker flow (`client/maestro/files-browse.yaml`) verified on the simulator:
  Files opens on the picker with "Select workspace" (no auto-select), tapping the picker and choosing
  `agent-desk` loads its root listing, and directory navigation works. `files-edit.yaml` also updated
  to select a workspace first. (The Debug host has no Screen Recording, so media is unavailable and the
  QUIC session idles out at ~30s; flows are kept short enough to finish inside that window. Not a code
  issue: the shell/picker code is unchanged by media.)

## v4 Phase F: faithful donor shell port (the reveal chrome's real views + workspace=desktop)

The Phase D reveal chrome was a lean rewrite (thin inline tree + inline editor, no workspace=desktop).
The user asked for a faithful **move** of the agent-workspace-ide views instead: same mechanics, only
the data model shared. This phase replaces the lean content with the donor's real view layer.

- [x] R45. Reconcile Workspace/WorkspaceStore to the donor's richer shape (lastMode, editorFrame,
  per-workspace pins, desktopAssignment, recentOrder, sidebarWidth, textZoom) + the donor's mutating
  ops, keeping AgentDesk's validated registration, WorkspaceStoreError, and one-time donor import so
  the iOS `.files` lane is unaffected. Existing WorkspaceStore tests stay green.
- [x] R46. Move the donor file tree/pane views (`FileTree`/`FileTreeLive`/`FolderWatch`/`FilePane` with
  real folder expansion, `FileIcon`/`GitStatus`, support views) into `WorkspaceShell/Editor/`. Swift 6
  concurrency adaptations only. Locked in by the donor's pure-logic tests (`FileTreeTests`, etc.).
- [x] R47. Move the donor `FileViewer` editor window + surfaces (opens a file in a centered NSWindow,
  per-workspace `editorFrame`); vendor the web viewer SPA in a macOS-only `WorkspaceEditorViewer`
  package (`.copy` resource preserves the `viewer/` dir; host-only so it never ships in iOS). Notebook
  runtime excised (`.ipynb` still renders read-only).
- [x] R48. `WorkspaceDesktopSwitcher`: switch the macOS Desktop to a workspace's assigned Space via
  AgentDesk's `SpacesProvider` (ordinal delta + verified direct-set), not the donor's private
  SkyLight/dock-swipe code. The editor window uses `.moveToActiveSpace` to follow the switch.
- [x] R49. `WorkspaceShellSession` (AgentDesk's leaner analogue of the donor WorkspaceSession): owns
  the tree/viewer/tabs + workspace=desktop, minus the donor's terminal/browser/chrome-borrow tenants.
  Wired into the reveal presenter: FilePane in the sidebar, file opens in the center window, switcher
  switches Desktops, assign-desktop control, manual-Space-switch reconciliation.
- [x] R50. Retire the stopgap `WorkspaceShellController`/`WorkspaceShellFileTree`/`WorkspaceShellAccessibility`
  (+ tests). `just check` (408 host + wire + WorkspaceKit) and `just sim-test` (295 client) green; live
  AX self-report on the running host shows the FilePane tree reachable, 9 workspaces, no FileViewer
  crash (viewer bundle resolves), reveal working.

## v4 Phase G: one cross-platform file viewer (iOS renders through the shared SPA)

iOS Files rendered file text in a raw `UITextView` while macOS rendered through the vendored SPA, so
markdown/mermaid/code looked like plain source on the phone. This phase makes the viewer one shared
surface (reversing D15's host-only linking), so both platforms render identically; chrome still differs.

- [x] R51. Make `WorkspaceEditorViewer` cross-platform (macOS 26 + iOS 26, one target) and extract the
  WKWebView host into a shared `WorkspaceFileWebSurface` (the `window.fileSurface` `render(payload)`
  contract + ready-queue state machine; iOS/macOS split only on background/opacity + `openExternal`).
  Host `FileViewer`/`FileViewerSurfaceReuse` drive it via a stringly-typed `WorkspaceFilePayload`
  (kind/mode strings, no host-enum coupling). The 5MB bundle now ships in iOS too — one viewer, not two.
- [x] R52. Point the iOS Files preview at `WorkspaceFileWebSurface` instead of `UITextView`, and port
  the macOS `FileViewer` modeButton to the iOS preview header: a Preview/Edit toggle
  (`workspace-files-preview-mode`) that flips the file's mode and re-renders through the SPA, carrying
  in-progress edits across the flip. Markdown/notebooks open rendered; everything else (incl. HTML)
  opens as editable source, so the editability the `UITextView` had is preserved and HTML is never a
  read-only dead end. `just check` + `just sim-test` green; sim Maestro (`files-md-render.yaml`)
  confirms markdown renders and the toggle flips to an editable CodeMirror source view.

## v4 Phase H: port the donor top-bar terminal UI (PTY Manager + "+ Terminal") onto our pty socket

The donor top bar had two terminal controls the port skipped: "＋ Terminal" (spawns an in-app SwiftTerm
terminal window attached to a `pty-manager` session) and "PTY Manager" (a session/client list). AgentDesk
already runs the Rust `pty-manager` daemon on its own socket (`Config.ptyManagerSocketURL`, hash-verified)
and ships `terminal/pty-client-swift` (incl. the `PtyTerminalSwiftTerm` SwiftTerm bridge, so SwiftTerm is
already an in-tree dependency) — but that package is not linked into the host, and the only terminal UX is
a floating pill that opens external Ghostty. This phase ports the donor controls onto our socket. Decisions
(HITL): in-app SwiftTerm terminal (faithful), embedded in-host PTY Manager window (not the donor sidecar
process), and the Ghostty pill is retired.

- [x] R53. Link `terminal/pty-client-swift` into the host target; add a `PtyManagerSocketClient` seam bound
  to `Config.ptyManagerSocketURL`. Wiring locked by tests (live round-trip is manual, needs the daemon).
- [x] R54. Add `＋ Terminal` (`open-terminal`) + `PTY Manager` (`open-pty-manager`) chips to the shell top
  bar (`WorkspaceShellPresenter`), as NSButtons matching the existing Agents/pin style, with
  `onOpenTerminal`/`onOpenPtyManager` presenter callbacks (AppDelegate wires them in R55/R56). Both ids added
  to the AX self-report set.
- [ ] R55. In-app terminal: bring the donor `terminal/emulator` window layer in-tree (4 files, on the
  existing `PtyTerminalSwiftTerm`); `WorkspaceShellSession.openTerminal()` spawns a SwiftTerm terminal
  `NSWindow` on our socket, cascaded per workspace, following workspace=desktop (park/unpark, text zoom).
- [ ] R56. Embedded PTY Manager: a host-owned `NSOutlineView` window driven by `subscribeSessions`
  (sessions→clients, Open Client / Close Session / Close Client / Reconnect), replacing the donor sidecar.
- [ ] R57. Retire the Ghostty pill: remove `TerminalLauncher` + `Config.terminalAppURL`/`terminalBundleID`
  + `startTerminalLauncher()` and reconcile its space-negotiation (SpaceAgent/dictation avoid) wiring.

## Promotion log

```
R36pre   2026-07-11  accepted    ADR-0054 boundary (share data model; port donor shell faithfully)
R36      2026-07-11  green       WorkspaceKit skeleton linked into host + client; just check leg added
R37      2026-07-11  green       data model already shared via AgentDeskWire; no standalone refactor
R38      2026-07-11  green       iOS workspace picker; auto-select-first removed; sim-test green (295)
R39-R43  2026-07-11  verified    donor reveal shell ported into the host; live AX self-report positive
R43rev   2026-07-11  green       pointer-tap restartability + coalescing; review NOT GREEN items fixed
R44a-b   2026-07-11  verified    shell default-on; host AX self-report confirms the reveal chrome
R44c     2026-07-11  verified    iOS Maestro picker flow passes on the sim (files-browse.yaml)
R45-R50  2026-07-11  verified    faithful donor shell port: real FilePane tree + FileViewer center
                                 window + workspace=desktop; lean rewrite replaced. check+sim-test green
R51-R52  2026-07-11  verified    one cross-platform file viewer; iOS Files renders through the shared
                                 SPA + Preview/Edit toggle. sim Maestro shows md render + editable source
R53      2026-07-11  green       pty-client-swift linked into the host; PtyManagerSocketClient dials our
                                 daemon socket; wiring test green (SwiftTerm resolves, not yet compiled)
```
