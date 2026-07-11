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
- [ ] R19. Replace AgentDesk iOS's app-local `AgentFeedSurface` implementation with `AgentPanel` plus a QUIC input-lane adapter while preserving projects, sessions, history paging, reconnect, and live updates.

## v2 Phase 2: macOS workspace shell and local files

- [ ] R20. Port the AppKit shell primitives into AgentDeskHost: sidebar/top-bar panels, edge reveal, layout, workspace switcher, activity controls, and accessibility identifiers, excluding donor Desktop switching, Debug Browser, Jupyter, and Dock enrichment. (Landed and tested: root-scoped file tree, edge-reveal state machine, layout geometry, and accessibility identifiers. Remaining: the actual AppKit NSView sidebar/top-bar panels, workspace switcher, and activity controls.)
- [ ] R21. Wire the shell to AgentDesk `SpacesProvider`, `HostPtyManagerProcess`, terminal launcher, and ATC ownership through focused controllers rather than adding feature state to `AppDelegate.swift`.
- [ ] R22. Port the reusable WKWebView file viewer/editor, open-tab model, file watching, UTF-8/binary probe, conflict state, and atomic autosave; tests assert one reusable surface per type, explicit save failure, external-change conflict, and tab-state behavior.
- [ ] R23. Start the workspace shell with AgentDeskHost while preserving `LSUIElement`, menu-bar status behavior, variant identity, TCC grants, and normal key-window editing.
- [ ] R24. Add the macOS `Agents` top-bar command and one reusable Agent window backed directly by the host-owned ATC sidecar through `AgentPanel`.

## v2 Phase 3: authenticated iOS Files

- [x] D25. Extend `AgentDeskWire` to protocol version 6 with reliable `.files = 6` stream framing and workspace list, directory list, read, write, conflict, and error messages using workspace-relative paths.
- [x] D26. Add a host files stream endpoint that walks from registered-root descriptors with `openat`/`O_NOFOLLOW`, bounds payloads through central config, rejects traversal and symlinks, reads UTF-8 text, and performs content-digest revision-checked atomic writes through the verified parent descriptor. (`WorkspaceFilesLaneServer` decodes `.files` frames; `WorkspaceFilesResponder` serializes them against the store and closes the lost-update write race; `PairingSignalingServer` hands off the lane; `AppDelegate` owns the repository + responder; byte cap and store paths in `Config`. Host-unit green; live client-to-host serving is proven at the R33 device/sim checkpoint.)
- [x] D27. Add a client files transport that reconnects with the session, correlates responses, cancels pending requests on teardown, and cannot block input or media lanes. (`WorkspaceFilesTransport` actor over a `WorkspaceFilesFrameChannel`; correlation by request id, fail-loud on duplicate id / undecodable response, teardown fails all in-flight. Reviewer-green; `just sim-test` green. Reconnect is per-session re-construction, not in-instance reopen.)
- [ ] R28. Add an iOS Files surface for workspace and directory navigation plus read-only preview, with focused model and lifecycle tests.
- [ ] R29. Reuse the shared file editor surface on iOS and enable save through revision-checked writes, surfacing conflicts without overwriting host changes.
- [ ] R30. Replace the crowded text-only surface switcher with an accessible control that fits Control, Agents, Files, Terminal, and Browser across supported iPhone widths.

## v2 Phase 4: integration and proof

- [ ] R31. Run package, host, client, wire, webview, and full `just check` gates; fix cross-lane naming, lifecycle, actor, resource, and protocol inconsistencies found by self-review and the persistent Integration Reviewer.
- [ ] R32. Verify build artifacts contain the workspace and AgentPanel resources without importing build products or source paths from `agent-workspace-ide`.
- [ ] R33. Prepare the exact host and simulator/device validation commands, then stop for the required explicit launch approval before exercising and capturing the real macOS shell and iOS Files surfaces.

---

## v3 scope (captured, not started until v2 is verified)

- [ ] R34. Move the remaining PTY packages required by AgentDesk from `agent-workspace-ide` into AgentDesk-owned package paths, preserving the Rust manager as process owner and SwiftTerm as renderer.
- [ ] R35. Remove the final AgentDesk source/build dependency on `agent-workspace-ide`, archive the donor repository with a tombstone, and update ADR-0051 to point at the superseding package home through a new ADR if its ownership decision changes.

### Alternative arc (rejected for now, captured)

- Keep `agent-workspace-ide` running as a companion process and expose workspace/file IPC. Rejected because it preserves two lifecycle owners and makes iOS file authority depend on a retiring app. Revisit only if AgentDesk's `LSUIElement` lifecycle cannot support reliable key-window editing after real-surface verification.

---

## Promotion log

```
R14-R15  2026-07-10  verified   AgentDesk workspace ownership accepted and prior terminal ledger archived
R16-R18  2026-07-10  green      workspace domain, one-time donor import, AgentPanel package (just check green)
R19      pending     pending     iOS AgentFeedSurface -> AgentPanel swap
R20      partial     green      shell primitives (tree, edge reveal, layout, a11y); AppKit panels remain
R21-R24  pending     pending     shell host wiring, file viewer/editor, shell startup, Agents window
R25      2026-07-10  green      protocol 6 + .files framing and file messages (just check green)
R26      2026-07-10  green      files lane endpoint + serialized writes (just check green; live serving at R33)
R27      2026-07-10  green      client Files transport (reviewer-green; just sim-test green)
R28-R30  pending     pending     iOS Files surfaces and switcher
R31-R33  pending     pending     integration and real-surface proof
R34-R35  captured    pending     donor retirement
```
