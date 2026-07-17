# TASKS: v7 build hygiene and Dock display roles

`R<N>` is remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger follows the v6 cursor-reconciliation ledger through R77; v7 starts at R78.

## Position

Standalone Bun compilation must never expose compiler intermediates in the workspace or its parent. The sidecar recipe owns one disposable working directory and removes it on every shell exit before the Dock presentation changes. Dock enrichment already owns authoritative main-display metadata, so its monitor glyph should present that role directly as `P` or `S` rather than reuse a zero-based Desktop ordinal.

## v7 Phase 0: Bun build hygiene

- [x] D78. Stage `build-agent-sidecar` in an OS temporary working directory, install the completed executable into the host resource path, and remove the entire staging directory on success, failure, or interruption. Verify with the real 519-module `bun build --compile` and confirm no `.bun` artifacts remain in `~/projects`, the repository root, or the temporary staging namespace.

## v7 Phase 1: Dock display-role badge

- [ ] R79. Give `DockDesktopGroupSummary` one display-role badge label derived from `isMainDisplay`, render `P` for the primary display and `S` for every secondary display, and replace the ordinal-owned badge view with a monitor-role badge view. Add model tests for both roles.

## v7 Phase 2: integration gate

- [ ] R80. Run focused Dock snapshot tests, `git diff --check`, and `just check`; self-review the build cleanup and Dock presentation as one system. Do not launch or relaunch the host without the required user checkpoint.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D78 | 2026-07-16 | done | Bun standalone compilation is isolated under OS temp storage and trap-cleaned. |
| R79 | pending | pending | Primary and secondary display-role monitor badges. |
| R80 | pending | pending | Focused and repository integration verification. |
