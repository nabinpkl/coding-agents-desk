# TASKS: v6 shared responsive DOCX preview

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This standalone arc continues after the closed v5 ledger in `TASKS.md`.

## Position

macOS and iOS render DOCX through one responsive `WorkspaceEditorViewer` SPA. The host owns filesystem
access, the Files QUIC role carries native document bytes without base64 or application chunking, and
DOCX remains read-only. ADR-0057 records the protocol v8 and 100 MiB admission tradeoffs.

## Tasks

- [x] D74. Vendor the authored viewer project into `WorkspaceEditorViewer/Viewer`, keep only built
  runtime assets in SwiftPM Resources, and pin `docx-preview` plus its lockfile.
- [x] D75. Add responsive read-only DOCX rendering, opaque `app://` document resources, and keyed
  scroll restoration across same-file refreshes.
- [x] D76. Move extension classification into `WorkspaceKit`; make macOS and iOS consume the same
  typed payload and suppress edit/save chrome for DOCX.
- [x] D77. Change the Files body codec to binary property lists, admit native DOCX bytes up to the
  configured 100 MiB ceiling, keep other stream roles at 4 MiB, and bump the session protocol to v8.
- [x] D78. Run viewer tests and `just check`, inspect the integrated diff, and record ADR-0057 plus
  current SPEC and environment configuration.

## Promotion log

| ID | Date | Status | Summary |
| --- | --- | --- | --- |
| D74 | 2026-07-16 | landed | AgentDesk now owns the viewer source, locked dependencies, tests, and reproducible resource build. |
| D75 | 2026-07-16 | landed | One responsive read-only DOCX renderer serves both platforms and restores same-file scroll state. |
| D76 | 2026-07-16 | landed | Shared file-kind and typed payload contracts remove host/client classification drift. |
| D77 | 2026-07-16 | landed | Protocol v8 carries bounded native DOCX bytes over the Files stream without application chunking. |
| D78 | 2026-07-16 | landed | Viewer tests, host checks, iOS build, self-review, ADR, and SPEC gates are complete. |
