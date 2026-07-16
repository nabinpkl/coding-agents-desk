# TASKS: v6 causality-safe cursor reconciliation

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger continues from the closed v5 ledger in `TASKS.md`, through R73; v6 starts at R74.

## Position

The iPhone keeps immediate cursor prediction, but delayed feedback from iPhone-originated movement must not be mistaken for independent Mac movement. The shared wire contract comes first because the client cannot infer causality from position and time alone. The host then produces explicit applied and host-local events, after which one pure client state machine owns pending revisions, reconciliation, and cursor confidence. UIKit renders that confidence without owning protocol state.

## v6 Phase 0: cursor causality contract

- [x] D74. Accept ADR-0058, update `SPEC.md`, and bump the shared AgentDesk session protocol to v9 so cursor input revisions, applied acknowledgements, and independently observed host movement have one explicit contract.

## v6 Phase 1: sequenced host application

- [x] D75. Extend `packages/AgentDeskWire/Sources/AgentDeskWire/Input.swift` and `UIFrames.swift`, preserve the cursor revision through `host/AgentDeskHost/InputChannelServer.swift`, and have `InputDispatcher` return the applied position to the originating channel only after posting the cursor event; wire tests reject an unrevisioned cursor input and host tests pin scoped acknowledgements and host-local provenance.

## v6 Phase 2: client prediction confidence and reconciliation

- [x] D76. Add a pure `CursorReconciliationStateMachine` under `client/AgentDeskClient`, route local cursor operations and both host feedback messages through it, replace silent cursor-send failure with an explicit ghost transition, and give `CursorPointerView` confirmed and grey-ghost presentation modes; tests pin stale-ack no-rewind, latest-ack confirmation, oldest-pending timeout, host-local rebase plus replay, reconnect reset, and mirrored/fallback ghost styling.

## v6 Phase 3: integration gate

- [ ] R77. Run AgentDeskWire tests, focused host and client cursor tests, `git diff --check`, `just check`, and `just sim-test`; self-review the complete wire/host/client lifecycle and record any remaining live-device feel risk without launching or reinstalling either app.

  Verification on 2026-07-16: AgentDeskWire's 24 tests, the cursor reducer and pointer-view suites, `git diff --check`, and the second full `just check` run are green. `just sim-test` compiled the client and passed every cursor test, but repeated full runs remained red in pre-existing `AgentFeedTerminalTests` timing races (`teardownDuringAttachedAckDetachesAndDoesNotRetainSurfaceOrConnection`, `staleReconnectAttachCannotBindOrReportReadyAfterNewerSession`, and, on one run, `everyExplicitAbandonmentSendsOneExactCloseAndPreventsResurrection`). R77 stays open until the repository-wide simulator gate is green. No app was launched or installed; grey-mask feel and real host/client interleaving remain the live-run risks.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D74 | 2026-07-16 | done | Accepted ADR-0058 and pinned protocol v9 cursor causality semantics. |
| D75 | 2026-07-16 | done | Revisioned input, post-dispatch acknowledgement, explicit host movement, and ordered channel sends. |
| D76 | 2026-07-16 | done | Pure reconciliation reducer, lifecycle wiring, bounded pending state, and grey ghost presentation. |
| R77 | 2026-07-16 | partial | Cursor gates and `just check` are green; unrelated Agent Panel terminal races keep `just sim-test` red. |
