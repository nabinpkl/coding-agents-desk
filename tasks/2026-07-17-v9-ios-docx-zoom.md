# TASKS: v9 iOS DOCX zoom

`R<N>` is remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger follows the v8 DOCX response ledger through R83; v9 starts at R84 while v8's independent
macOS live-verification checkpoint remains open.

## Position

The iOS DOCX reader opens at fit-width 1x and uses WKWebView's native scroll view as the only zoom
state. Pinch and explicit controls operate that same 0.5x through 4x range, including a 0.5x overview.
Same-file refreshes retain zoom, changing files resets to 1x, and non-DOCX previews do not inherit
document magnification.

## v9 Phase 0: native zoom contract

- [x] D84. Extend
  `packages/WorkspaceEditorViewer/Sources/WorkspaceEditorViewer/WorkspaceFileWebSurface.swift` with an
  iOS-only 1x through 4x viewport zoom policy, multiplicative zoom commands, same-file preservation,
  and different-file reset; admit the matching pinch range in the authored and bundled viewport meta.

## v9 Phase 1: Files controls and regression

- [x] D85. Add DOCX-only zoom-out and zoom-in controls to
  `client/AgentDeskClient/WorkspaceFilesSurface.swift`, and extend the iOS Files suite to assert control
  visibility and wiring, pinch admission, command behavior, refresh preservation, and reset outside
  the active document.

## v9 Phase 2: live iOS verification

- [ ] R86. After the required simulator or device checkpoint, install the current-SHA client, open a
  real DOCX, and verify fit-width rendering, 0.5x overview, both controls, pinch zoom, zoomed panning,
  and same-file refresh behavior on the rendered surface.

## v9 Phase 3: overview zoom floor

- [x] D87. Separate the DOCX 0.5x overview minimum from its 1x fit-width default in the native scroll
  view and HTML viewport contracts, preserving the DOCX range across page readiness while keeping
  non-DOCX previews locked to 1x.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D84 | 2026-07-17 | done | One bounded WKWebView zoom state now owns DOCX pinch, command zoom, refresh preservation, and file-change reset. |
| D85 | 2026-07-17 | done | The iOS DOCX header exposes accessible minus/plus controls backed by an end-to-end surface regression. |
| R86 | pending | pending | Current-SHA iOS rendered-surface verification awaits the required run checkpoint. |
| D87 | 2026-07-17 | done | DOCX can zoom out to a 0.5x overview without changing the 1x fit-width opening scale. |

The viewer tests and focused iOS Files suite are green. The repository-wide client gate remains red in
the unrelated `AgentFeedTerminalTests` lifecycle suite, including under serial execution; this viewer
slice does not change the terminal surface or its contracts.
