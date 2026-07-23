# TASKS: v7 multi-window Chrome projection (with v8 terminal durability captured)

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger continues from the archived v6 ledger through D83.

## Position

This iteration makes the macOS Browser Projection model the whole local Chrome hierarchy while keeping
one recorder and one selected page. The extension session and generation contract land first because
the host cannot safely render nested metadata until delayed prior-page batches are distinguishable at
their source. The validated native session and shared renderer follow. Autonomous live verification is
last because it launches the dev host and visible test-owned Chrome and therefore remains behind the
repository launch checkpoint.

ADR-0064 supersedes the original local-only boundary: the authenticated QUIC DOM lane now seeds and
updates the same nested BrowserProjection shell on iOS, carries selection commands back to the host,
and requires protocol version 12. ADR-0065 adds viewer-owned responsive source sizing over protocol 13
without changing the one-recorder and extension-authoritative generation model.

## v7 Phase 0: local projection decision

- [x] D84. Accept ADR-0063 and update `PRD.md` and `SPEC.md` with the nested local browser hierarchy,
  focus versus projection semantics, one-recorder generation model, local-only metadata boundary, and
  explicit Chrome-management non-goals.

## v7 Phase 1: authoritative extension session

- [x] D85. Replace the focused-tab recorder state in `chrome-extension/worker.js` with a restorable
  multi-window session backed by `chrome-extension/browser-session.js`; enumerate normal windows,
  ordered tabs, groups, and bounded favicons; validate window/tab selection; pass generation into the
  isolated recorder; and test ordering, focus, navigation, restriction, restoration fields, and stale
  command or batch rejection.

## v7 Phase 2: validated local host projection

- [x] D86. Add bounded multi-window state types to `packages/BrowserProjection`, render nested ARIA
  window and tab strips with read-only toolbar/status states, and route validated state plus matching
  page batches through a host-only `BrowserProjectionSession`. Keep `browser-state` out of
  `DomMirrorRelay`; retain selected-page tap, scroll, and existing iOS page-only delivery. Tests pin
  decoding, metadata text safety, AX identifiers, atomic replacement, filtering, and command routing.

## v7 Phase 3: autonomous verification seam

- [x] D87. Add `just browser-projection-verify` and `just browser-projection-e2e`; preflight TCC without
  prompting, build the exact dev host without personal Chrome bridge installation, load the exact
  extension into a temporary visible Chrome-for-Testing profile, drive stable AX identifiers, capture
  window-only screenshots and machine-readable transitions, reuse tap/scroll gates, and clean every
  test-owned process and profile. Pure, renderer, real-extension, focused-host, and repository checks
  must pass before the launch checkpoint.

## v7 Phase 4: live acceptance checkpoint

- [x] D88. After explicit user approval, run `just browser-projection-e2e` and verify two normal Chrome
  windows, complete nested tabs and group metadata, projection-only outer switching, unfocused inner
  tab activation, direct Chrome focus/tab following, restricted-page clearing, strictly advancing
  generations, stale-batch rejection, matching host/extension SHAs, six screenshots, result JSON, and
  complete cleanup without touching the stable host or personal Chrome profile.
- [x] D88.1. Replace blanket rrweb/CDP redaction with readable ordinary page content while retaining
  source-side masking for static and incremental password values; verify the real compressed stream,
  closed-shadow CDP reconstruction, and payload-free diagnostic logging contract.
- [x] D88.2. Supersede the page-only iOS boundary with ADR-0064; seed the remote DOM lane with validated
  host and browser metadata, render the exact shared nested shell on iOS, return window/tab selection
  on the serialized DOM stream, and raise the host/client session protocol to 12.
- [x] D88.3. Disable rrweb's implicit `.rr-mask` text-class redaction so all ordinary text is visible
  by default while static and incremental password values remain source-masked; release extension 0.8.1.
- [x] D88.4. Supersede the fixed iOS emulation toggle with ADR-0065; add host-arbitrated last-activated
  viewer ownership, Desktop and Mobile presets, viewer-linked and custom source dimensions, shared
  projection-only fit/zoom/pan, generation-fenced CDP application and native restoration, protocol 13,
  extension 0.9.0, and local/remote ownership tests.
- [x] D88.5. Make workspace-shell top and left edge reveal monitor-aware: retain one authoritative
  interactive overlay, move it to the display under the pointer, derive reveal geometry for every
  connected display, and retain the bottom Dock surface's existing main-display ownership.
---

## v8 terminal workspace

- [x] D89. Promote terminal tabs, recursive splits, pane chrome, and the session drawer into one
  bounded `PtyTerminalWebView` workspace shared by macOS and iOS (ADR-0069).
- [x] D90. Add bounded Rust-owned PTY replay: protocol-6 chunked checkpoints and revisions, one
  Alacritty-backed logical grid per session, bounded fan-out/resynchronization, shared renderer fit
  and explicit sizing, metadata-only standalone macOS window restoration, and automated tests
  (ADR-0066).

## Terminal stability hotfix

- [x] D91. Prevent pre-layout terminal attachments from creating unusable 1x2 PTYs: centralize the
  80x24 bootstrap dimensions, measure laid-out terminal surfaces atomically, and send an authoritative
  resize immediately after every renderer bind so existing sessions recover on reattachment.
  ADR-0066 supersedes bind-time resizing; 80x24 remains the creation fallback.
- [x] D92. Remove the standalone terminal window minimum and make shared macOS/iOS terminal views
  full-fit down to 75 percent, then clip and follow the parser cursor without focus or PTY resize
  (ADR-0067).
- [x] D93. Replace explicit shared terminal sizing with protocol-7 last-activated viewer ownership:
  sequence-fenced viewer reports, targeted ownership status, owner-only debounced capacity changes,
  input-before-write claims, shared AppKit/UIKit participation, focus-free restoration, and visible
  two-client ownership verification (ADR-0068).
- [x] D94. Replace every SwiftTerm consumer with the production WKWebView and xterm runtime, add the
  user-input provenance fork, bounded bridge recovery, shared workspace coordinator, one-session
  adapters, metadata-schema migration, deterministic web build, and compile-only host/iOS gates
  (ADR-0069).

## Client visual diagnostics

- [x] D95. Add explicit-opt-in, foreground-only paired-client screenshot capture over protocol 14;
  authenticate the session and signed offer-port paths, bound and verify manifests plus JPEG chunks,
  keep client pixels memory-only, write private host temporary artifacts, disclose successful sharing
  in the client UI, and add screenshot-only and combined debug-bundle recipes (ADR-0070).

## Mission Control topology reconciliation

- [x] D96. Add process-lifetime yabai-style Mission Control entry sources (Dock accessibility on
  current macOS and SkyLight event `1204` for the legacy path) with 100 ms exit checks only while
  Mission Control is open; reconcile surviving workspace assignments atomically by exact Space ID,
  retain missing assignments as unresolved, remove ordinal identity fallback, and refresh workspace
  and Dock presentation after topology edits (ADR-0071).

## Workspace/Desktop selection reconciliation

- [x] D97. Clear the active workspace when the user enters an unassigned Desktop instead of retaining
  the workspace selected on the previous Desktop; persist the empty selection and cover the
  coordinator path with a regression test.

## Exact Workspace/Desktop activation

- [ ] R98. Replace active-display-relative workspace switching with a target-display Dock gesture:
  read that display's `Current Space`, compute its exact assignment delta, and locate the synthesized
  swipe on that display; verification is pending the user-run host relaunch.

## Promotion log

```text
D84      2026-07-20  landed      local multi-window browser projection decision
D85      2026-07-20  landed      restorable extension session and document-scoped generation
D86      2026-07-20  landed      validated nested AppKit projection and local bridge routing
D87      2026-07-20  landed      autonomous AX and temporary-Chrome verification seam
D88      2026-07-20  landed      live dev-host and visible Chrome-for-Testing acceptance
D88.1    2026-07-21  landed      readable projection content with source-masked passwords
D88.2    2026-07-21  landed      full shared Chrome hierarchy and selection on iOS, protocol 12
D88.3    2026-07-21  landed      ordinary text unredacted regardless of rrweb page classes, extension 0.8.1
D88.4    2026-07-21  landed      viewer-owned responsive Chrome viewport, protocol 13, extension 0.9.0
D88.5    2026-07-21  landed      workspace-shell top and left edge reveal across every display
D91      2026-07-21  landed      safe terminal bootstrap dimensions and bind-time resize recovery
D90      2026-07-22  landed      bounded headless PTY replay and metadata-only window restoration
D92      2026-07-22  landed      readable cursor-following terminal viewports without minimum sizes
D93      2026-07-22  landed      protocol-7 active-viewer terminal sizing and focus-free restoration
D89      2026-07-22  landed      shared terminal tabs, recursive splits, and session drawer
D94      2026-07-22  landed      one bounded WKWebView and xterm terminal runtime across macOS and iOS
D95      2026-07-22  landed      opt-in bounded paired-client screenshots and protocol 14
D96      2026-07-23  landed      event-driven Mission Control topology reconciliation by Space ID
D97      2026-07-23  landed      unassigned Desktops clear the active workspace selection
R98      2026-07-23  pending     target-display Dock gesture switching awaiting user verification
```
