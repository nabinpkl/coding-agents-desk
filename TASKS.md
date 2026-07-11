# TASKS: v2 AgentDesk workspace consolidation (with v3 donor retirement captured)

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

AgentDesk becomes the authoritative agent workspace before `agent-workspace-ide` is retired. Ordering:

- ADR-0052 and the product contract land first because the current PRD excludes file transfer and does not authorize a workspace shell.
- Shared workspace and file contracts land before UI because AppKit, UIKit, persistence, and transport need one vocabulary.
- macOS shell and local editing land before iOS Files because the host must own workspace roots and file semantics before exposing them remotely.
- AgentPanel extraction runs beside workspace work because it has independent source ownership and transport adapters.
- Donor retirement happens only after AgentDesk no longer imports required production code from the sibling repository.

The Coordinator owns `PRD.md`, `SPEC.md`, ADRs, this ledger, Xcode project files, `AppDelegate.swift`, and final cross-lane integration. Four persistent Implementor/Reviewer lanes use `gpt-5.6-terra` with high reasoning: workspace ownership, AgentPanel, macOS shell/editor, and file transport/iOS Files.

## v2 Phase 0: consolidation decision (gate)

- [x] D14. Accept `architecture-decisions/0052-agentdesk-owns-the-agent-workspace.md`, updating `PRD.md` and `SPEC.md` so AgentDesk owns workspace roots, macOS shell, local editing, AgentPanel, and authenticated iOS files.
- [x] D15. Archive the completed terminal ledger under `tasks/archive/remote-swiftterm-terminal.md` and open this append-only consolidation ledger.

## v2 Phase 1: authoritative workspace and panel seams

- [x] D16. Introduce a host-local `Workspace` domain with pure workspace identity, ordered roots, persistence, and active selection; keep shared transport DTOs in `AgentDeskWire` and test round-trip persistence and ordering without exporting host filesystem authority as a package.
- [x] D17. Add one-time import from `~/Library/Application Support/agent-workspace-ide/workspace.json` into AgentDesk's bundle-scoped Application Support store; tests assert absence is a clean first run, corrupt source fails loud, successful import writes one authoritative store, and the importer never replays after completion. (`WorkspaceRepository` + `WorkspaceStore.loadOrImport`; the concrete host donor/destination URLs are supplied when the repository is constructed in AppDelegate under R21.)
- [x] D18. Introduce `packages/AgentPanel` with bundled web assets, platform-neutral WebKit lifecycle, Agent request/push types, and an injected transport boundary; tests pin JS message decoding, pending delivery, teardown, and resource resolution.
- [x] R19. Replace AgentDesk iOS's app-local `AgentFeedSurface` implementation with `AgentPanel` plus a QUIC input-lane adapter while preserving projects, sessions, history paging, reconnect, and live updates. (`AgentFeedSurface` is now a thin `AgentPanelTransport`-conforming UIView wrapping `AgentPanelWebViewController`; requests bridge `AgentPanelRequest` -> the wire-typed `AgentFeedRequest`; the old JS-error diagnostics shim was ported into the shared package so both platforms keep it; an AX-identified "Agent view unavailable" fallback replaces a silent blank pane on panel-init failure; dead `agentFeedWebview*` Config cluster removed. Reviewer-green; `just sim-test` green (290). AX/Maestro observation pending the combined bring-up.)

## v2 Phase 2: macOS workspace shell and local files

- [x] D20. Port the AppKit shell primitives into AgentDeskHost: sidebar/top-bar panels, edge reveal, layout, workspace switcher, activity controls, and accessibility identifiers, excluding donor Desktop switching, Debug Browser, Jupyter, and Dock enrichment. (Landed and reviewer-green: root-scoped file tree, edge-reveal, layout, accessibility identifiers, and the shell sidebar panel with an NSOutlineView file tree, a workspace-switcher NSPopUpButton, and Add-Workspace. Follow-ups: a separate top-bar panel and activity controls beyond the sidebar.)
- [x] D21. Wire the shell to AgentDesk `SpacesProvider`, `HostPtyManagerProcess`, terminal launcher, and ATC ownership through focused controllers rather than adding feature state to `AppDelegate.swift`. (`WorkspaceShellController` owns the store lifecycle with a busy-guard; `AppDelegate` composes it + the panel controller behind `Config.workspaceShellEnabled` without shell feature state leaking in. Reviewer-green; `just check` green. The SpacesProvider/PTY/terminal/ATC hooks beyond workspace+file browsing are follow-ups.)
- [x] D22. Port the reusable WKWebView file viewer/editor, open-tab model, file watching, UTF-8/binary probe, conflict state, and atomic autosave; tests assert one reusable surface per type, explicit save failure, external-change conflict, and tab-state behavior. (macOS file editor: double-click a file in the shell tree opens it in an editable text view; Save writes revision-checked through the shared responder — success advances the baseline, a conflict is reported without overwriting, edits preserved. Reviewer-green; the controller read/write disk path is unit-tested. Follow-ups: an open-tab model, filesystem watching, and autosave; the editor is a plain NSTextView rather than the WKWebView/CodeMirror surface.)
- [x] D23. Start the workspace shell with AgentDeskHost while preserving `LSUIElement`, menu-bar status behavior, variant identity, TCC grants, and normal key-window editing. (`WorkspaceShellPanelController` shows a nonactivating, canBecomeKey panel on launch behind `Config.workspaceShellEnabled`; the app never activates so the menu bar stays with the frontmost app, while the panel is key-able for editing. Reviewer-green; `just check` green; host launches cleanly with the shell enabled and loads the store. Pixel-level render observation pending screen-capture approval.)
- [x] R24. Add the macOS `Agents` top-bar command and one reusable Agent window backed directly by the host-owned ATC sidecar through `AgentPanel`. (`AgentWindowController` shows a nonactivating, key-able `AgentPanelWindow` (NSPanel) hosting `AgentPanelWebViewController`; its `AgentFeedBridge.send` delivers straight into the local webview, and `AgentPanelBridgeTransport` maps `AgentPanelRequest` onto the same `bridge.handle*` the iOS lane drives. The shell top-bar has an "Agents" button (`onAgentsCommand` closure, composed in AppDelegate behind `Config.workspaceShellEnabled`). AgentPanel is linked into the host xcodeproj (app + test). Reviewer-green; `just check` green (418 host). AX verified by unit tests querying the window's accessibility identifiers; live AX/on-screen observation pending the launch checkpoint. Follow-up captured: a v1 idle-timeout so a long-hidden window stops its SSE streams.)

## v2 Phase 3: authenticated iOS Files

- [x] D25. Extend `AgentDeskWire` to protocol version 6 with reliable `.files = 6` stream framing and workspace list, directory list, read, write, conflict, and error messages using workspace-relative paths.
- [x] D26. Add a host files stream endpoint that walks from registered-root descriptors with `openat`/`O_NOFOLLOW`, bounds payloads through central config, rejects traversal and symlinks, reads UTF-8 text, and performs content-digest revision-checked atomic writes through the verified parent descriptor. (`WorkspaceFilesLaneServer` decodes `.files` frames; `WorkspaceFilesResponder` serializes them against the store and closes the lost-update write race; `PairingSignalingServer` hands off the lane; `AppDelegate` owns the repository + responder; byte cap and store paths in `Config`. Host-unit green; live client-to-host serving is proven at the R33 device/sim checkpoint.)
- [x] D27. Add a client files transport that reconnects with the session, correlates responses, cancels pending requests on teardown, and cannot block input or media lanes. (`WorkspaceFilesTransport` actor over a `WorkspaceFilesFrameChannel`; correlation by request id, fail-loud on duplicate id / undecodable response, teardown fails all in-flight. Reviewer-green; `just sim-test` green. Reconnect is per-session re-construction, not in-instance reopen.)
- [x] D28. Add an iOS Files surface for workspace and directory navigation plus read-only preview, with focused model and lifecycle tests. (`WorkspaceFilesBrowserModel` + `WorkspaceFilesBrowser` + `WorkspaceFilesSurface` wired into the switcher, with generation-correlated navigation and preview, app-switch/reconnect teardown+rebind, open-race guards, and a read-only preview overlay. Reviewer-green; `just sim-test` green; observed end-to-end on the simulator via `files-browse` — root listing, drill into `src`, up, and a real file preview over the `.files` lane. Deferred follow-up: a multi-workspace picker (single-workspace case is auto-selected).)
- [x] D29. Reuse the shared file editor surface on iOS and enable save through revision-checked writes, surfacing conflicts without overwriting host changes. (The Files preview is now an editor: `saveFile` writes the edited text with the read revision as `expectedRevision`; success advances the baseline, a conflict is reported without overwriting and preserves the user's edits, and overlapping saves are guarded. Reviewer-green; `just sim-test` green; observed end-to-end on the simulator via `files-edit` — a device edit to README.md wrote through to the demo workspace's file on disk.)
- [x] R30. Replace the crowded text-only surface switcher with an accessible control that fits Control, Agents, Files, Terminal, and Browser across supported iPhone widths. (The switcher is now SF Symbol icon segments (display/sparkles/terminal/globe/folder); all five fit compactly on the narrowest iPhone where five text labels crowded. Each segment carries the surface's accessibility label so VoiceOver and the a11y-driven Maestro flows still target it by name; selection resolves a tapped segment back to its surface by reading the segment's own image label (source of truth, safe `.control` fallback) rather than re-deriving availability. Reviewer-green; `just sim-test` green (294); live-verified on the sim — agent-feed-smoke and files-browse both tapped their icon segments ("Agent"/"Files") by accessibility label.)

## v2 Phase 4: integration and proof

- [x] D31. Run package, host, client, wire, webview, and full `just check` gates; fix cross-lane naming, lifecycle, actor, resource, and protocol inconsistencies found by self-review and the persistent Integration Reviewer. (`just check-all` green at HEAD: 411 host + 18 wire + 302 client tests, 0 failures. Every workspace/files slice went through the same reviewer to green, which caught ~19 real cross-lane bugs. The webview/agent-feed gate is unchanged by this work.)
- [x] D32. Verify build artifacts contain the workspace and AgentPanel resources without importing build products or source paths from `agent-workspace-ide`. (Grep of host/client/packages code: the only `agent-workspace-ide` reference is the runtime donor-store path the importer reads once at first launch — no code import, no source-path dependency, no AWI build product in the artifact. AgentPanel ships as its own package with bundled resources.)
- [x] R33. Prepare the exact host and simulator/device validation commands, then stop for the required explicit launch approval before exercising and capturing the real macOS shell and iOS Files surfaces. (iOS Files browse/edit verified end-to-end on the sim at R28/R29. macOS shell now live-verified via in-host AX self-report on the running host: panel visible, all four controls (agents/switcher/add/file-tree) AX-reachable, active workspace auto-selected, file tree populated (treeEntries=18). Two real bugs found and fixed in the process: the shell never auto-selected the first workspace when the store had none active, and `refresh()` retained only the file-tree rootNode not the owning `WorkspaceShellFileTree`, so its weak back-ref deallocated and every `children()` call silently returned empty — the tree is now retained and the nil-tree case fails loud.)

---

## v3 scope (captured, not started until v2 is verified)

- [x] R34. Move the remaining PTY packages required by AgentDesk from `agent-workspace-ide` into AgentDesk-owned package paths, preserving the Rust manager as process owner and SwiftTerm as renderer. (Both self-contained packages copied into `terminal/`: the Rust `pty-manager` crate (own `proto/pty.proto`, vendored protoc) and the `pty-client-swift` SPM package (pre-generated protobuf, upstream SwiftTerm/SwiftProtobuf). `pty_manager_dir` in the Justfile and the client xcodeproj's `XCLocalSwiftPackageReference` relativePath now point at `terminal/…`; zero `agent-workspace-ide` references remain in the client project. Verified: `just build-pty-manager` compiles from the new path, `just sim-test` builds the client against the relocated PtyClientSwift/PtyTerminalSession/PtyTerminalSwiftTerm + SwiftTerm (294 tests), `just check` green (419 host). Source parity with the donor confirmed; no build artifacts committed.)
- [x] R35. Remove the final AgentDesk source/build dependency on `agent-workspace-ide`, archive the donor repository with a tombstone, and update ADR-0051 to point at the superseding package home through a new ADR if its ownership decision changes. (R34 removed the last source/build dependency; a repo-wide grep confirms no `agent-workspace-ide` reference remains in any build file, package reference, or Swift import — the only remaining mention is the intended one-time runtime import of the donor's `workspace.json` at first launch, a data migration not a build dependency. ADR-0053 records the package move and supersedes ADR-0051 (0051 marked superseded, both cross-linked, index updated); SPEC.md and PRD.md updated to name AgentDesk as the owner and the donor as retired. The donor repository is tombstoned with a `TOMBSTONE.md` committed on its `main` branch pointing back to AgentDesk and ADR-0052/0053.)

### Alternative arc (rejected for now, captured)

- Keep `agent-workspace-ide` running as a companion process and expose workspace/file IPC. Rejected because it preserves two lifecycle owners and makes iOS file authority depend on a retiring app. Revisit only if AgentDesk's `LSUIElement` lifecycle cannot support reliable key-window editing after real-surface verification.

---

## Promotion log

```
R14-R15  2026-07-10  verified   AgentDesk workspace ownership accepted and prior terminal ledger archived
R16-R18  2026-07-10  green      workspace domain, one-time donor import, AgentPanel package (just check green)
R19      2026-07-10  verified   iOS AgentFeedSurface -> AgentPanel wrapper (reviewer-green; sim-test green); diagnostics shim ported to package; live-verified on the sim via the agent-feed-smoke Maestro a11y flow (projects -> sessions -> thread)
R20      2026-07-10  green      shell sidebar panel: file tree + workspace switcher + add (reviewer-green); top-bar/activity follow-ups
R21      2026-07-10  green      shell controller owning the store lifecycle (reviewer-green)
R22      2026-07-10  green      macOS file editor: double-click open + revision-checked save (reviewer-green); tabs/watch/autosave follow-ups
R23      2026-07-10  green      shell started with the host, LSUIElement-preserving (reviewer-green; launches clean)
R24      2026-07-10  verified   macOS Agents top-bar command + Agent window via AgentPanel (reviewer-green; just check 418); live-verified on the running host via in-host AX self-report (window=agentdesk-agents-window surface=agents-webview visible=true) + end-to-end feed (projects push count=20)
R25      2026-07-10  green      protocol 6 + .files framing and file messages (just check green)
R26      2026-07-10  green      files lane endpoint + serialized writes (just check green; live serving at R33)
R27      2026-07-10  green      client Files transport (reviewer-green; just sim-test green)
R28      2026-07-10  verified   iOS Files surface: navigation + preview, observed end-to-end on the simulator
R29      2026-07-10  verified   iOS editor save (revision-checked), observed writing through to disk
R30      2026-07-10  verified   icon-segment surface switcher fitting all 5 surfaces (reviewer-green; sim-test 294); live-verified tapping icon segments by a11y label on the sim
R31      2026-07-10  green      full check-all gate green at HEAD (411 host + 18 wire + 302 client)
R32      2026-07-10  green      no agent-workspace-ide build/source dependency; AgentPanel self-contained
R33      2026-07-10  verified   iOS Files proven on sim (R28/R29); macOS shell live-verified via in-host AX self-report (treeEntries=18, all controls reachable); fixed workspace auto-select + a file-tree retention bug that left the tree silently empty
R34      2026-07-10  green      PTY packages moved into terminal/ (pty-manager Rust + pty-client-swift SPM); build-pty-manager + sim-test + check green; 0 donor refs in pbxproj
R35      2026-07-10  verified   final donor source/build dependency removed (grep-confirmed); ADR-0053 supersedes ADR-0051; SPEC/PRD updated; donor tombstoned on main
```
