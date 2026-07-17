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

- [ ] R90. Add `host/AgentDeskHost/WorkspaceShell/Dock/DockDesktopSwapExecutor.swift` with typed yabai JSON decoding, central executable and timeout configuration, visible-only eligibility, capture-before-move ordering, post-move verification, rollback, and conservative Undo; add focused host tests using an injected command runner.

## v10 Phase 2: Dock interaction state and presentation

- [ ] R91. Add a pure Dock swap state machine and wire `DockEnrichmentPresenter`, `DockEnrichmentPanel`, `WorkspaceShellPresenter`, and the existing pointer tap for two-step selection, empty Desktop targets, busy locking, held reveal, status, eight-second Undo, Escape/outside cancellation, keyboard operation, and stable accessibility identifiers; add state, reveal, pointer, and AppKit tests.

## v10 Phase 3: integration and live checkpoint

- [ ] R92. Run focused host tests, `git diff --check`, and `just check`; self-review the complete transaction, UI, lifecycle, accessibility, config, docs, and logs. After the required host relaunch checkpoint, capture source/destination window IDs, exercise Swap and Undo through AX, verify moved and excluded sets, and record a window-only screenshot.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D89 | 2026-07-17 | done | ADR-0059 and product, technical, and decision surfaces define transactional yabai content swaps over stable Space IDs. |
| R90 | pending | pending | Typed yabai transaction, rollback, and conservative Undo boundary. |
| R91 | pending | pending | Dock swap state machine, presentation, reveal hold, cancellation, and accessibility. |
| R92 | pending | pending | Repository gates and checkpointed live AX/window-ID verification. |
