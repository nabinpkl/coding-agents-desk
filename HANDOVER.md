# Handover — 2026-07-11

Branch `main`, HEAD `d7e7c66`. Gate green: `just check` (host + wire + WorkspaceKit + WorkspaceEditorViewer, 414 tests), `just sim-test` (client). (Previous handovers are preserved in this file's git history.)

## What shipped this session: the ADR-0054 v4 delivery (shared data model + ported macOS shell + one file viewer)

The v2/v3 consolidation stopped at a stopgap macOS shell (a single titled panel) with two bespoke copies of the workspace/files logic. This session finished the merge per **ADR-0054**: the reusable shape shared between iOS and macOS is the **workspace data + files model only**; on top of it, macOS behaves as the `agent-workspace-ide` donor, and iOS keeps its own drill-down surface plus a new picker. Full ledger in `TASKS.md` (v4 Phases 0/A–G, R36–R52); rationale in `DECISIONS.md` (D11–D16).

- **Shared model** (`packages/WorkspaceKit`, macOS + iOS): the workspace/files domain types, reconciled with `AgentDeskWire`. Linked into both apps; `just check` runs its test leg.
- **Ported macOS reveal shell** (`host/AgentDeskHost/WorkspaceShell/`): the donor's real views were **moved**, not rewritten — recursive `FileTree`/`FilePane` with live folder expansion, the `FileViewer` editor window (opens a file in a centered NSWindow), the reveal-on-hover sidebar + top bar (`FocusableOverlayPanel` + a CGEvent session tap, gated behind Input Monitoring), and **workspace = desktop** (`WorkspaceDesktopSwitcher` drives AgentDesk's `SpacesProvider`, not the donor's private SkyLight/dock-swipe code). The stopgap panel is retired. Shell is default-on (`Config.workspaceShellEnabled`), env-overridable.
- **iOS workspace picker** (`WorkspaceFilesSurface`): the header is a picker (`workspace-files-picker`) over all workspaces; the auto-select-first bug is gone. This is what "existing workspaces didn't carry over" actually was — the store held all 9, the phone just auto-picked one with no way to see the rest.
- **One cross-platform file viewer** (`packages/WorkspaceEditorViewer`, Phase G): the WKWebView SPA (CodeMirror + markdown-it + mermaid) and its host `WorkspaceFileWebSurface` are now cross-platform. iOS Files renders through the **same** SPA as the macOS shell instead of a raw `UITextView`, so markdown/mermaid/code render identically on both. A Preview/Edit toggle (`workspace-files-preview-mode`, ported from the macOS `FileViewer` modeButton) keeps the phone editable: markdown/notebooks open rendered, everything else opens as editable source. Reverses D15's host-only linking (the 5MB bundle now ships in iOS too — one viewer, not two).

Verified on the sim (`client/maestro/files-md-render.yaml`): open a `.md` file → renders; tap the toggle → flips to an editable CodeMirror source view. Live host AX self-report (from Phase F) confirms the FilePane tree is reachable, 9 workspaces, reveal working, no FileViewer crash.

## Not yet done / next actions

1. **TestFlight the ADR-0054 client.** The picker + shared viewer + mode toggle have **not** been uploaded; the last TestFlight (`1.9.1` build 888) predates this work. Before uploading, bump `client_marketing_version` in the `Justfile` — this is a **feature**, so `1.9.1 → 1.10.0` (per AGENTS.md versioning). Then `just fresh-testflight`. Device install/launch is a checkpoint: prepare + state the command, wait for "run it".
2. **iOS has no HTML *page* preview (by design, recorded).** On iOS, `.html` opens as editable source, not a rendered page — the shared SPA renders HTML only as source, and iOS does not port macOS's separate `htmlPreviewSurface`. Documented in DECISIONS D16 / TASKS R52 so it isn't rediscovered as a bug. Building a real iOS HTML page surface is the follow-up if wanted.
3. **One-time donor import is still gated on an absent destination store** (`WorkspaceStore.loadOrImport`, host/AgentDeskHost/Workspace/WorkspaceStore.swift:263). A stale/partial destination store permanently blocks the real import. Latent, not currently biting (the store holds the 9 real workspaces), but the absent-file gate is brittle — decide a smarter first-run (merge donor workspaces not present) without breaking ADR-0052's "one authoritative store, no replay".

## Gotchas

- `just check` has an intermittent 1-test WebKit/RBS flake (WKWebView host tests). Retry — it's environmental; filter with `grep -ivE 'WebContent|ProcessSuspension|pboard|RBS'`. (Also in agent memory.)
- A freshly built Release host is a differently-signed binary; it needs its own Screen Recording + Accessibility grants and can't read a Debug-created Secure-Enclave key. If pairing fails with `unexpectedStatus(100002)`, check the host's on-disk bundle exists and is the identity that owns the keychain key.
- The reveal pointer source is a CGEvent **session tap** (Input Monitoring), not `NSEvent` monitors, which miss edge movement on non-owning Desktops. A fresh Release host needs the Input Monitoring grant; the shell degrades to a pinned sidebar/top bar if denied (R41).
- `pair-sim` / `pair-iphone` only relaunch the already-installed client — they do **not** pick up code changes. Rebuild+reinstall (`client-sim-reinstall`) and verify `AgentDeskGitSHA` vs HEAD before trusting a feel run. (Also in agent memory.)
- Device/host launches are a checkpoint (AGENTS.md): prepare + state the command, then wait for "run it".
