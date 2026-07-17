# TASKS: v8 DOCX resource response

`R<N>` is remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger follows the v7 build-hygiene and Dock-display ledger through R80; v8 starts at R81.

## Position

The shared viewer must expose one successful `app://` response contract to JavaScript for every bundled
asset and opaque document resource. The native scheme handler owns response status, headers, and bytes;
the DOCX renderer keeps rejecting unsuccessful responses instead of weakening its error handling.

## v8 Phase 0: WebKit contract regression

- [x] D81. Add a real WKWebView integration test under
  `packages/WorkspaceEditorViewer/Tests/WorkspaceEditorViewerTests/` that loads the custom origin,
  fetches binary document bytes, and asserts JavaScript receives status 200, `ok == true`, the DOCX
  content type, and the complete byte body.

## v8 Phase 1: authoritative resource response

- [x] D82. Replace the two plain `URLResponse` paths in
  `packages/WorkspaceEditorViewer/Sources/WorkspaceEditorViewer/AppSchemeHandler.swift` with one shared
  HTTP-compatible success response function used by SPA assets and DOCX resources; keep missing,
  unreadable, oversized, and response-construction failures loud.

## v8 Phase 2: live macOS verification

- [ ] R83. After the required relaunch checkpoint, rebuild the current-SHA macOS host, reopen the
  known-good DOCX from the temporary workspace, and verify through Accessibility plus a window-only
  screenshot that the document renders instead of showing `DOCX content request failed (0)`.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D81 | 2026-07-17 | done | The WKWebView regression first reproduced status 0 with intact bytes, then passed with status 200, DOCX MIME, and byte identity. |
| D82 | 2026-07-17 | done | One native response path now serves successful `app://` assets and documents with explicit status and headers. |
| R83 | pending | pending | Current-SHA macOS AX and screenshot verification awaits the required host relaunch checkpoint. |
