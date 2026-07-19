# TASKS: v14 shared responsive workspace IDE

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

This parallel arc adds a separate IDE entry on macOS and iPhone while the current native Workspace
surfaces remain live. ADR-0062 lands first because it changes ADR-0054's presentation boundary. The
existing viewer is then reorganized without behavior change so both new regions can reuse its renderers.
Host authority and protocol v11 land before web or platform consumers because every later slice depends
on one revisioned shared-state and observation contract. macOS and iPhone join only after the shared web
and native coordinator tests are green.

## Phase 0: decision gate

- D1. Accept `architecture-decisions/0062-shared-responsive-workspace-ide.md` and update `PRD.md`, `SPEC.md`, and `DECISIONS.md` with the embedded two-webview boundary, host-shared tab and folder state, local view state, and autosave policy.

## Phase 1: package seam with no behavior change

- D2. Replace `packages/WorkspaceEditorViewer` with `packages/WorkspaceIDE`, exposing `WorkspaceFileViewer` and `WorkspaceIDE`, and update both synchronized Xcode projects to link the renamed products.
- D3. Consolidate authored web code under `packages/WorkspaceIDE/Web`, extract mountable renderer modules, and replace `vendor-viewer` with `workspace-ide-web` that tests and builds legacy viewer and IDE resources from one dependency tree.
- D4. Add package and filesystem fitness tests proving the existing single-file macOS and iOS surfaces retain DOCX fit-width, zoom, viewport restoration, Markdown, notebook, and edit behavior, with no old package directory or stale generated resource tree.

## Phase 2: authoritative workspace lane

- D5. Add protocol-v11 workspace-lane request, response, and push types in `packages/AgentDeskWire`, retaining native binary file payloads and the 101 MiB Files frame bound.
- D6. Add revisioned `WorkspaceIDESharedState` persistence and idempotent open, close, reorder, expand, and collapse operations under one host coordinator.
- D7. Introduce `WorkspaceCoordinator` above `WorkspaceRepository` and migrate existing workspace mutations so reveal chrome, Files, terminal coordination, and IDE adapters consume one runtime snapshot.
- D8. Extract one reference-counted observation coordinator that fans one filesystem generation and one Git status read to the native shell and subscribed IDEs.
- D9. Refactor the existing iPhone Workspace transport through the new lane envelope and add v11 rejection, round-trip, idempotency, fan-out, and 100 MiB DOCX boundary tests.

## Phase 3: shared IDE regions

- D10. Add `WorkspaceIDEController`, its data-source, capabilities, delegate, local-state, and draft-store seams with strict script-message parsing, serialized projection, and stale-generation rejection.
- D11. Build the shared sidebar region with workspace selection, recursive Explorer, read-only Source Control, Git decoration, compact controls, container queries, and semantic accessibility.
- D12. Build the shared editor region with ordered tabs, breadcrumbs, modes, zoom, dirty and conflict state, empty state, and the existing renderer modules.
- D13. Add 700 ms autosave, draft restoration, revision-conflict Use Host and Keep Mine flows, protected remote close, and tests showing two webviews consume one coordinator snapshot without reconstruction.

## Phase 4: native entries

- D14. Add a retained macOS Workspace IDE window with a full-height sidebar webview, editor webview, native accessible dividers, native workspace SwiftTerm, local host adapter, and capability-gated Mac workspace actions.
- D15. Add a separate iPhone IDE control using the same retained webviews and workspace-terminal coordination, enforcing the iPhone capability set natively and preserving local pane state across reconnect.
- D16. Add host and iOS integration tests for local active-tab independence, shared tab/folder reconciliation, terminal confinement, Desktop selection behavior, external-change conflicts, and existing Workspace-surface continuity.

## Phase 5: verification and launch checkpoint

- D17. Run the web suite/build, both Swift packages, focused host/client suites, `just check`, and `just sim-test`; perform a full cross-file self-review and stop before launching either app.
- R18. After explicit approval, launch the dev stack, verify running SHAs, smoke both IDE entries and shared state/conflicts/external changes/Git/DOCX behavior, then capture macOS AX and iPhone screenshots.
- R19. After a separate explicit physical-device approval, repeat the iPhone layout, keyboard, pinch, reconnect, and terminal-reattach smoke on hardware.

## Deferred beyond v14

File creation, rename, delete, search, LSP, debugger, Jupyter execution, Git mutation, a browser client,
terminal tabs and splits, disconnected-output replay, and collaborative unsaved buffers remain outside
this iteration.

## Promotion log

```
D1       2026-07-19  committed   shared IDE decision and iteration gate
D2       2026-07-19  committed   package and Xcode product seam
D3-D4    2026-07-19  committed   shared renderer modules and fitness coverage
D5-D9    2026-07-19  committed   authoritative workspace lane and observation
D10-D13  2026-07-19  committed   shared web regions and native coordinator
D14-D16  2026-07-19  committed   macOS and iPhone IDE entries
D17      2026-07-19  committed   automated gates and integrated self-review
R18-R19  pending     pending     checkpointed simulator and physical-device smoke
```
