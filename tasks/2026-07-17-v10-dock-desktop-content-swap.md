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

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D89 | 2026-07-17 | done | ADR-0059 and product, technical, and decision surfaces define transactional yabai content swaps over stable Space IDs. |
| D90 | 2026-07-17 | done | Typed yabai transaction, rollback, conservative Undo, command-runner limits, and pure interaction state are covered by focused host tests. |
| D91 | 2026-07-17 | done | Typed presenter effects, extracted AppKit controls, held reveal, empty targets, eight-second Undo, Escape/outside cancellation, keyboard buttons, and stable AX identifiers are covered by focused tests. |
| D92 | 2026-07-17 | done | Focused interaction/transaction suites, all 529 host tests, package checks, diff hygiene, and integrated self-review are green. |
| D93 | 2026-07-17 | done | Exact fresh-install verification separated lifecycle from rendering; the current Release host visibly presents the inactive Swap glyph and AX confirms inactive, active, then inactive state. |
| R94 | pending | pending | Live window-ID Swap and Undo verification with a window-only screenshot. |
