---
status: accepted
date: 2026-07-16
---

# Shared responsive DOCX preview over the Files stream

## Context and Problem Statement

The macOS file window and iOS Files surface already host one `WorkspaceEditorViewer` SPA, but every file-read contract is text-only and the generic QUIC frame ceiling is 4 MiB. DOCX is a ZIP container, must remain read-only, and must render responsively on both platforms without duplicating a native and web implementation.

## Decision Drivers

- One renderer and payload contract must serve macOS and iOS.
- DOCX bytes must not be expanded through JSON base64 or application-defined chunks.
- Input and media bounds must not grow with document support.
- A macOS external-file refresh must preserve the open document's scroll position.
- The design must admit documents up to 100 MiB while stating the renderer's real limits.

## Considered Options

- **Option A**: Use `docx-preview` in the shared SPA, carry native `Data` in a Files-only binary property-list frame, and restore SPA scroll state by file identity.
- **Option B**: Use platform Quick Look views and separate platform lifecycle adapters.
- **Option C**: Put base64 document bytes in the existing JSON response and split large documents into application chunks.

## Decision Outcome

Chose **Option A**. `docx-preview` 0.4.0 renders once inside `WorkspaceEditorViewer`; `ignoreWidth` and `ignoreHeight` let the shared CSS fit pages to either viewport while retaining page breaks. The authored web project lives in `packages/WorkspaceEditorViewer/Viewer`, and only built runtime assets enter the Swift package. `WorkspaceFileKind` lives in `WorkspaceKit`, so both platforms classify DOCX identically and suppress editing and saving. The macOS host gives the surface an opaque local resource URL, while iOS gives it the exact bytes received from the host.

The `.files` role uses binary property-list bodies under AgentDesk protocol v8. Its frame ceiling is 101 MiB and its document admission ceiling is 100 MiB; every other stream retains the 4 MiB ceiling. QUIC already segments, retransmits, and orders the reliable stream below this framing layer, so AgentDesk does not add chunk ids or reassembly. The larger frame is an application message bound, not a transport packet.

`docx-preview` does not provide virtual scrolling or a page-count render limit. CSS `content-visibility` is a best-effort paint optimization, not a memory guarantee. Therefore 100 MiB is an admission and transfer ceiling, not a promise that an unusually complex or highly compressed document will render within every iOS memory budget.

### Consequences

- Good, because macOS and iOS share the renderer, responsive layout, security settings, and error behavior.
- Good, because DOCX bytes stay binary and QUIC owns transport segmentation without a second chunk protocol.
- Good, because a same-file rerender captures and restores the SPA scroll offset, including host file-watcher refreshes.
- Bad, because a large response is buffered for binary property-list decoding and DOCX rendering can expand well beyond its ZIP size.
- Bad, because `docx-preview` has no true virtualization; large-document reliability must be measured and may require a future paged renderer.
- Neutral, because the breaking Files codec raises both current and minimum session protocol versions to `8`.

### Confirmation

Wire tests pin protocol v8, Files-only frame growth, and byte-exact binary round trips. Viewer tests pin responsive DOCX options and same-file scroll restoration. Host service tests pin DOCX-only binary admission, read-only enforcement, and the independent 100 MiB ceiling. `just check` builds and tests the host plus shared packages, and a compile-only iOS Simulator build validates the client against the same package resource bundle.

## Links

- ADR-0020
- ADR-0030
- ADR-0050
- ADR-0054
- SPEC `WorkspaceFilesRequest` / `WorkspaceFilesResponse`
