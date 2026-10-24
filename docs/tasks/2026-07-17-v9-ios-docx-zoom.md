# TASKS: v9 iOS DOCX zoom

`R<N>` is remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger follows the v8 DOCX response ledger through R83; v9 starts at R84 while v8's independent
macOS live-verification checkpoint remains open.

## Position

The shared DOCX reader preserves Word's page geometry and opens with the complete first-page width
fitted to its viewport. A renderer-owned transform is the only zoom state on macOS and iOS. Pinch and
explicit controls operate the same 0.5x through 4x range relative to fit-width, same-file refreshes
retain zoom, and a different document starts at fit-width.

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

## v9 Phase 4: renderer-owned fit width

- [x] D88. Preserve docx-preview's Word page dimensions, fit the complete page width with one
  renderer-owned transform, route buttons and pinch through that state, and remove the outer
  WKWebView scroll-view zoom path that cannot scale the nested DOCX scroller.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D84 | 2026-07-17 | done | One bounded WKWebView zoom state now owns DOCX pinch, command zoom, refresh preservation, and file-change reset. |
| D85 | 2026-07-17 | done | The iOS DOCX header exposes accessible minus/plus controls backed by an end-to-end surface regression. |
| R86 | pending | pending | Fit-width and below-fit control zoom are verified; pinch, zoomed panning, and same-file refresh remain. |
| D87 | 2026-07-17 | done | DOCX can zoom out to a 0.5x overview without changing the 1x fit-width opening scale. |
| D88 | 2026-07-17 | done | Word page geometry now opens fit-width and buttons or pinch scale the nested DOCX reader itself. |

The viewer tests, `just check`, iOS application build, and focused iOS test build are green. The
current `e7af127` build was installed and the real Assurance report was visually verified at fit-width
and below-fit overview zoom on the iOS simulator. R86 remains open for pinch, zoomed panning, and
same-file refresh.
