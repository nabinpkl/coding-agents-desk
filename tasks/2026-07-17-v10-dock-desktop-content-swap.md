# TASKS: v10 Dock desktop-content swap

`R<N>` is remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger follows the v9 DOCX zoom ledger through R88; v10 starts at R89 while independent live
verification checkpoints in earlier ledgers remain open.

## Position

The Dock swaps ordinary window contents between two existing Desktops without changing Space identity,
order, or workspace assignment. The architecture decision lands first because it adds a new external
window-placement backend. The transaction seam lands before UI state so rollback and Undo semantics are
proven without AppKit. The state machine and controls then consume only the typed seam. Live AX and
window-ID verification waits for the required host relaunch checkpoint.

## v10 Phase 0: architecture gate

- [x] D89. Accept ADR-0059, correct the stale Dock deferral in `PRD.md`, add the host transaction boundary to `SPEC.md`, and record the stable-ID, rollback, and conservative-Undo decisions in `DECISIONS.md`.

## v10 Phase 1: transactional yabai boundary

- [x] D90. Add `host/AgentDeskHost/WorkspaceShell/Dock/DockDesktopSwapExecutor.swift` with typed yabai JSON decoding, central executable and timeout configuration, ordinary-window eligibility without `is-visible` filtering, capture-before-move ordering, post-move verification, rollback, and conservative Undo; add focused host tests using an injected command runner.

## v10 Phase 2: Dock interaction state and presentation

- [x] D91. Add a pure Dock swap state machine and wire `DockEnrichmentPresenter`, `DockEnrichmentPanel`, `WorkspaceShellPresenter`, and the existing pointer tap for two-step selection, empty Desktop targets, busy locking, held reveal, status, eight-second Undo, Escape/outside cancellation, keyboard operation, and stable accessibility identifiers; add state, reveal, pointer, and AppKit tests.

## v10 Phase 3: integration and live checkpoint

- [x] D92. Run focused host tests, `git diff --check`, and `just check`; self-review the complete transaction, UI, lifecycle, accessibility, config, docs, and logs.
- [x] D93. Run the exact `fresh-install` composite before editing, prove the host binary was replaced, diagnose the missing Swap control as an inactive-state rendering defect, adopt the shared `HoverButton` presentation with a persistent accent glyph, and verify the corrected Release host through AX plus a live screenshot. The composite's client reinstall completed; its final launch retry remains blocked only while the physical phone is locked.
- [ ] R94. Capture source/destination window IDs, exercise an actual Swap and Undo through AX, verify moved and excluded sets, and record a window-only screenshot.
- [x] D95. Replace the wallpaper-dependent icon wash with a labeled 72-by-64-point opaque action tile sharing the desktop-card surface, add distinct resting, hover, focus, and active styling, and cover its size, opacity, label, and state contrast in AppKit tests; focused tests and all 530 host tests pass.
- [x] D96. Relaunch the landed Release host, match its loaded executable and embedded SHA to commit `9708287`, verify labeled idle and active AX states, and capture window-only screenshots confirming the opaque resting tile and solid-teal active tile.
- [x] D97. Replace `NSButtonCell` image-above layout with a fixed `DockActionButton` that renders a 72-by-64-point tile, explicitly centers a 22-point icon and label with balanced vertical padding, preserves the single keyboard and accessibility target, and cover the rendered frame, padding, state colors, and AX semantics in AppKit tests.
- [ ] R98. Relaunch the landed Release host, verify the Swap tile's AX title and description, and capture an idle window-only screenshot confirming the corrected padding against adjacent Desktop cards.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D89 | 2026-07-17 | done | ADR-0059 and product, technical, and decision surfaces define transactional yabai content swaps over stable Space IDs. |
| D90 | 2026-07-17 | done | Typed yabai transaction, rollback, conservative Undo, command-runner limits, and pure interaction state are covered by focused host tests. |
| D91 | 2026-07-17 | done | Typed presenter effects, extracted AppKit controls, held reveal, empty targets, eight-second Undo, Escape/outside cancellation, keyboard buttons, and stable AX identifiers are covered by focused tests. |
| D92 | 2026-07-17 | done | Focused interaction/transaction suites, all 529 host tests, package checks, diff hygiene, and integrated self-review are green. |
| D93 | 2026-07-17 | done | Exact fresh-install verification separated lifecycle from rendering; the current Release host visibly presents the inactive Swap glyph and AX confirms inactive, active, then inactive state. |
| R94 | pending | pending | Live window-ID Swap and Undo verification with a window-only screenshot. |
| D95 | 2026-07-17 | done | The Swap affordance is now an opaque, labeled action tile with shared Dock surface tokens and explicit inactive and active visual contracts. |
| D96 | 2026-07-17 | done | Release host `9708287` passed build-identity, AX idle/active, and window-only visual verification for the redesigned tile. |
| D97 | 2026-07-17 | done | A dedicated Dock action control removes AppKit cell alignment insets and owns measured icon, label, and vertical-padding layout; focused tests and all 530 host tests pass. |
| R98 | pending | pending | Live Release AX and screenshot verification for the corrected Swap tile padding. |
