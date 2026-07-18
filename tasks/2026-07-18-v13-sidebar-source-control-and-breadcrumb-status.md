# TASKS: v13 sidebar source control and breadcrumb Git status

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

Restore the macOS-only donor Git experience required by ADR-0054 without adding another status reader. Tests pin the pure listing and AppKit interaction contracts first. The existing `FileTreeLive` status snapshot then fans through `WorkspaceShellSession` to the Explorer decorations, Source Control panel, count badge, and viewer breadcrumb.

## Phase 1: behavior contracts

- D1. Add `host/AgentDeskHostTests/DirectoryListingTests.swift`, `ActivityBarTests.swift`, and `SourceControlPanelTests.swift` asserting root confinement, sorted decorated breadcrumb entries, tab selection/count accessibility, keyboard changed-file activation, ignored exclusion, and sidebar zoom.

## Phase 2: donor sidebar parity

- D2. Adapt the donor `ActivityBar.swift` and `SourceControlPanel.swift` under `host/AgentDeskHost/WorkspaceShell/Editor/` with Swift 6 main-actor isolation and native accessibility names, roles, values, and keyboard actions.
- D3. Extend `WorkspaceShellPresenter.swift` with one replaceable sidebar-panel area, Explorer/Source Control switching, count updates, changed-file opening, zoom propagation, and AX self-report identifiers.

## Phase 3: one status snapshot

- D4. Extend `WorkspaceShellSession.swift` and `DirectoryListing.swift` so the existing `FileTreeLive.onGitStatus` snapshot is cached once, reset on workspace changes, emitted to the presenter, and used to produce root-confined decorated breadcrumb listings.

## Phase 4: verification

- D5. Run the focused host tests, `git diff --check`, and `just check`; self-review the complete sidebar/session/viewer lifecycle and stop at the host-launch checkpoint before AX smoke.
- D6. After explicit approval, launch the landed host and verify Explorer/Source Control switching, exact count accessibility, changed-file opening, and decorated breadcrumb menus through live AX and screenshots.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D1-D4 | 2026-07-18 | done | Donor Git navigation is restored around one root-confined live status snapshot. |
| D5 | 2026-07-18 | done | Six focused tests, all 537 host tests, diff hygiene, and final cross-file self-review are green. |
| D6 | 2026-07-18 | done | Release build `7c0ea0f` passed live AX and window-scoped screenshot verification: one changed file, Source Control and Explorer selection, changed-file opening, and breadcrumb `.gitkeep  M` decoration. |
